use std::{env, fs, net::SocketAddr, sync::Arc};

use anyhow::{Context, Result};
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use axum::{
    Json, Router,
    extract::{Path as AxumPath, Query, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware::{Next, from_fn_with_state},
    response::{IntoResponse, Response},
    routing::{delete, get, get_service, post},
};
use luopan_inventory::load_inventory_dashboard;
use luopan_jobs::{progress_log_tail, status_payload};
use luopan_operations::load_operations_records;
use luopan_orders::{commit_preview, delete_batch, public_imports};
use luopan_runtime::{RuntimePaths, read_json_file};
use luopan_settlement::{load_settlement_dashboard_for_shop, save_settlement_upload};
use luopan_storage::{
    StoragePool, kv_value, load_operations_records_from_db, public_imports_from_db, summary,
};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::Row;
use subtle::ConstantTimeEq;
use tower_http::{
    cors::CorsLayer,
    services::{ServeDir, ServeFile},
    set_header::SetResponseHeaderLayer,
    trace::TraceLayer,
};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[derive(Clone)]
struct AppState {
    paths: Arc<RuntimePaths>,
    novnc_url: Arc<String>,
    auth_pool: Arc<StoragePool>,
    storage_pool: Option<Arc<StoragePool>>,
}

const SESSION_COOKIE_NAME: &str = "compass_session";
const SESSION_LIFETIME_SECONDS: i64 = 24 * 60 * 60;

#[derive(Debug, Deserialize)]
struct LoginPayload {
    username: String,
    password: String,
}

#[derive(Debug, Deserialize)]
struct LegacyUser {
    password_hash: String,
    #[serde(default = "default_role")]
    role: String,
    #[serde(default)]
    created_at: Option<String>,
}

#[derive(Debug, Serialize)]
struct LoginResponse {
    username: String,
    role: String,
}

#[derive(Debug, Serialize)]
struct MeResponse {
    authenticated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    role: Option<String>,
}

fn default_role() -> String {
    "viewer".to_string()
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn internal(error: anyhow::Error) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: error.to_string(),
        }
    }

    fn bad_request(error: anyhow::Error) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: error.to_string(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": self.message }))).into_response()
    }
}

#[derive(Serialize)]
struct HealthPayload {
    service: &'static str,
    ok: bool,
}

#[derive(Debug, Deserialize)]
struct StatusQuery {
    #[serde(default = "default_terminal_output")]
    terminal_output: bool,
}

#[derive(Debug, Deserialize)]
struct SettlementQuery {
    shop: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SettlementUploadPayload {
    shop_name: String,
    file_name: String,
    content: String,
}

fn default_terminal_output() -> bool {
    true
}

#[tokio::main]
async fn main() -> Result<()> {
    if let Some(argument) = env::args().nth(1) {
        if argument == "-h" || argument == "--help" {
            println!(
                "Rust API sidecar for the Luopan data center migration\n\nUsage: luopan-api-rs\n\nEnvironment:\n  LUOPAN_API_RS_HOST           Bind host, default 127.0.0.1\n  LUOPAN_API_RS_PORT           Bind port, default 8601\n  LUOPAN_API_RS_STORAGE_READS  Read supported payloads from SQLite when true"
            );
            return Ok(());
        }
        anyhow::bail!("unknown argument: {argument}");
    }

    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "luopan_api_rs=info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let paths = Arc::new(RuntimePaths::from_env()?);
    let novnc_url =
        Arc::new(env::var("NOVNC_URL").unwrap_or_else(|_| "http://127.0.0.1:6080".to_string()));
    let auth_pool = Arc::new(luopan_storage::connect(&paths).await?);
    luopan_storage::migrate(&auth_pool).await?;
    import_legacy_users(&auth_pool, &paths).await?;
    let storage_pool = env_bool("LUOPAN_API_RS_STORAGE_READS", false).then_some(auth_pool.clone());
    let state = AppState {
        paths: paths.clone(),
        novnc_url,
        auth_pool,
        storage_pool,
    };
    let protected = Router::new()
        .route("/api/runtime/paths", get(runtime_paths))
        .route("/api/compass", get(compass_dashboard))
        .route("/api/inventory", get(inventory_dashboard))
        .route("/api/inventory/raw", get(inventory_raw))
        .route("/api/settlement", get(settlement_dashboard))
        .route("/api/settlement/uploads", post(upload_settlement))
        .route("/api/orders/imports", get(order_imports))
        .route("/api/orders/imports", post(commit_order_import))
        .route(
            "/api/orders/imports/{batch_id}",
            delete(remove_order_import),
        )
        .route("/api/diagnostics", get(diagnostics))
        .route("/api/storage/summary", get(storage_summary))
        .route("/api/status", get(status))
        .route("/api/status/raw", get(status_raw))
        .route("/api/status/log-tail", get(status_log_tail))
        .route_layer(from_fn_with_state(state.clone(), require_auth));
    let static_dir = paths.app_dir.join("web").join("static");
    let static_files = Router::new()
        .route_service(
            "/",
            get_service(ServeFile::new(static_dir.join("index.html"))),
        )
        .nest_service("/assets", ServeDir::new(static_dir))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=3600"),
        ));
    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/api/login", post(login))
        .route("/api/logout", post(logout))
        .route("/api/me", get(me))
        .merge(protected)
        .merge(static_files)
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let host = env::var("LUOPAN_API_RS_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = env::var("LUOPAN_API_RS_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(8601);
    let address: SocketAddr = format!("{host}:{port}").parse()?;
    tracing::info!(%address, "starting luopan-api-rs");
    let listener = tokio::net::TcpListener::bind(address).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn healthz() -> Json<HealthPayload> {
    Json(HealthPayload {
        service: "luopan-api-rs",
        ok: true,
    })
}

async fn login(
    State(state): State<AppState>,
    Json(payload): Json<LoginPayload>,
) -> Result<Response, ApiError> {
    let username = payload.username.trim();
    let user = sqlx::query("SELECT password_hash, role FROM users WHERE username = ?")
        .bind(username)
        .fetch_optional(&*state.auth_pool)
        .await
        .map_err(|error| ApiError::internal(error.into()))?;
    let Some(user) = user else {
        return Err(invalid_credentials());
    };
    let password_hash: String = user.get("password_hash");
    if !verify_password(&payload.password, &password_hash) {
        return Err(invalid_credentials());
    }
    if is_legacy_password_hash(&password_hash) {
        let upgraded = hash_password(&payload.password).map_err(ApiError::internal)?;
        sqlx::query(
            "UPDATE users SET password_hash = ?, password_changed_at = ? WHERE username = ?",
        )
        .bind(upgraded)
        .bind(now_string())
        .bind(username)
        .execute(&*state.auth_pool)
        .await
        .map_err(|error| ApiError::internal(error.into()))?;
    }

    let token = create_session(&state.auth_pool, username)
        .await
        .map_err(ApiError::internal)?;
    let role: String = user.get("role");
    let mut response = Json(LoginResponse {
        username: username.to_string(),
        role,
    })
    .into_response();
    response
        .headers_mut()
        .insert(header::SET_COOKIE, session_cookie(&token));
    Ok(response)
}

async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Some(token) = session_token(&headers) {
        if let Err(error) = sqlx::query("DELETE FROM sessions WHERE token_hash = ?")
            .bind(token_hash(&token))
            .execute(&*state.auth_pool)
            .await
        {
            tracing::warn!(%error, "could not remove session during logout");
        }
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    response
        .headers_mut()
        .insert(header::SET_COOKIE, expired_session_cookie());
    response
}

async fn me(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<MeResponse>, ApiError> {
    match authenticated_user(&state.auth_pool, &headers)
        .await
        .map_err(ApiError::internal)?
    {
        Some((username, role)) => Ok(Json(MeResponse {
            authenticated: true,
            username: Some(username),
            role: Some(role),
        })),
        None => Ok(Json(MeResponse {
            authenticated: false,
            username: None,
            role: None,
        })),
    }
}

async fn require_auth(State(state): State<AppState>, request: Request, next: Next) -> Response {
    match authenticated_user(&state.auth_pool, request.headers()).await {
        Ok(Some(_)) => next.run(request).await,
        Ok(None) => (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "请先登录" })),
        )
            .into_response(),
        Err(error) => {
            tracing::error!(%error, "session validation failed");
            ApiError::internal(error).into_response()
        }
    }
}

fn invalid_credentials() -> ApiError {
    ApiError {
        status: StatusCode::UNAUTHORIZED,
        message: "用户名或密码错误".to_string(),
    }
}

async fn import_legacy_users(pool: &StoragePool, paths: &RuntimePaths) -> Result<()> {
    let users_path = paths.config_dir.join("users.json");
    if !users_path.exists() {
        return Ok(());
    }
    let contents = fs::read_to_string(&users_path)
        .with_context(|| format!("read legacy users file {}", users_path.display()))?;
    let users: std::collections::HashMap<String, LegacyUser> = serde_json::from_str(&contents)
        .with_context(|| format!("parse legacy users file {}", users_path.display()))?;
    for (username, user) in users {
        if username.trim().is_empty() || user.password_hash.trim().is_empty() {
            tracing::warn!(%username, "skipping malformed legacy user");
            continue;
        }
        sqlx::query(
            "INSERT OR IGNORE INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)",
        )
        .bind(username)
        .bind(user.password_hash)
        .bind(if user.role.trim().is_empty() { default_role() } else { user.role })
        .bind(user.created_at.unwrap_or_else(now_string))
        .execute(pool)
        .await?;
    }
    Ok(())
}

fn verify_password(password: &str, stored_hash: &str) -> bool {
    if is_legacy_password_hash(stored_hash) {
        let Some((salt, expected)) = stored_hash.split_once('$') else {
            return false;
        };
        let calculated = format!(
            "{:x}",
            Sha256::digest(format!("{salt}{password}").as_bytes())
        );
        return calculated.as_bytes().ct_eq(expected.as_bytes()).into();
    }
    let Ok(parsed) = PasswordHash::new(stored_hash) else {
        return false;
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}

fn is_legacy_password_hash(value: &str) -> bool {
    value.split_once('$').is_some_and(|(salt, digest)| {
        !salt.is_empty() && digest.len() == 64 && !value.starts_with('$')
    })
}

fn hash_password(password: &str) -> Result<String> {
    let salt = SaltString::generate(&mut OsRng);
    Ok(Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map_err(|error| anyhow::anyhow!("hash password: {error}"))?
        .to_string())
}

async fn create_session(pool: &StoragePool, username: &str) -> Result<String> {
    sqlx::query("DELETE FROM sessions WHERE expires_at <= ?")
        .bind(chrono::Utc::now().timestamp())
        .execute(pool)
        .await?;
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let token = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let now = chrono::Utc::now().timestamp();
    sqlx::query(
        "INSERT INTO sessions (token_hash, username, created_at, expires_at) VALUES (?, ?, ?, ?)",
    )
    .bind(token_hash(&token))
    .bind(username)
    .bind(now)
    .bind(now + SESSION_LIFETIME_SECONDS)
    .execute(pool)
    .await?;
    Ok(token)
}

async fn authenticated_user(
    pool: &StoragePool,
    headers: &HeaderMap,
) -> Result<Option<(String, String)>> {
    let Some(token) = session_token(headers) else {
        return Ok(None);
    };
    let row = sqlx::query(
        "SELECT users.username, users.role FROM sessions JOIN users ON users.username = sessions.username WHERE sessions.token_hash = ? AND sessions.expires_at > ?",
    )
    .bind(token_hash(&token))
    .bind(chrono::Utc::now().timestamp())
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|row| (row.get("username"), row.get("role"))))
}

fn session_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::COOKIE)
        .and_then(|value| value.to_str().ok())
        .and_then(|cookies| {
            cookies.split(';').find_map(|cookie| {
                let (name, value) = cookie.trim().split_once('=')?;
                (name == SESSION_COOKIE_NAME && !value.is_empty()).then(|| value.to_string())
            })
        })
}

fn token_hash(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

fn session_cookie(token: &str) -> HeaderValue {
    let secure = env_bool("SESSION_COOKIE_SECURE", false)
        .then_some("; Secure")
        .unwrap_or("");
    HeaderValue::from_str(&format!(
        "{SESSION_COOKIE_NAME}={token}; Path=/; Max-Age={SESSION_LIFETIME_SECONDS}; HttpOnly; SameSite=Lax{secure}"
    ))
    .expect("session cookie is valid")
}

fn expired_session_cookie() -> HeaderValue {
    HeaderValue::from_static("compass_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax")
}

fn now_string() -> String {
    chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string()
}

async fn runtime_paths(State(state): State<AppState>) -> Json<RuntimePaths> {
    Json((*state.paths).clone())
}

async fn inventory_dashboard(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    if let Some(pool) = &state.storage_pool {
        match kv_value(pool, "inventory_dashboard").await {
            Ok(Some(value)) => return Ok(Json(value)),
            Ok(None) => tracing::warn!("SQLite inventory payload is missing; falling back to JSON"),
            Err(error) => {
                tracing::warn!(%error, "SQLite inventory read failed; falling back to JSON")
            }
        }
    }

    match load_inventory_dashboard(&state.paths).map_err(ApiError::internal)? {
        Some(value) => Ok(Json(value)),
        None => Err(ApiError {
            status: StatusCode::NOT_FOUND,
            message: format!(
                "missing inventory snapshot: {}",
                state.paths.inventory_snapshot_path().display()
            ),
        }),
    }
}

async fn compass_dashboard(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let records = if let Some(pool) = &state.storage_pool {
        match load_operations_records_from_db(pool).await {
            Ok(records) if !records.is_empty() => records,
            Ok(_) => {
                tracing::warn!("SQLite operations payload is empty; falling back to JSON");
                load_operations_records(&state.paths).map_err(ApiError::internal)?
            }
            Err(error) => {
                tracing::warn!(%error, "SQLite operations read failed; falling back to JSON");
                load_operations_records(&state.paths).map_err(ApiError::internal)?
            }
        }
    } else {
        load_operations_records(&state.paths).map_err(ApiError::internal)?
    };
    let status =
        status_payload(&state.paths, &state.novnc_url, false).map_err(ApiError::internal)?;
    Ok(Json(json!({
        "records": records,
        "status": status,
        "generated_at": chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string(),
    })))
}

async fn settlement_dashboard(
    State(state): State<AppState>,
    Query(query): Query<SettlementQuery>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        load_settlement_dashboard_for_shop(&state.paths, query.shop.as_deref())
            .map_err(ApiError::internal)?,
    ))
}

async fn upload_settlement(
    State(state): State<AppState>,
    Json(payload): Json<SettlementUploadPayload>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let upload = save_settlement_upload(
        &state.paths,
        &payload.file_name,
        &payload.shop_name,
        payload.content.as_bytes(),
    )
    .map_err(ApiError::bad_request)?;
    let dashboard = load_settlement_dashboard_for_shop(&state.paths, Some(&payload.shop_name))
        .map_err(ApiError::internal)?;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "upload": upload,
            "dashboard": dashboard,
        })),
    ))
}

async fn order_imports(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    if let Some(pool) = &state.storage_pool {
        match public_imports_from_db(pool).await {
            Ok(Some(value)) => return Ok(Json(value)),
            Ok(None) => {
                tracing::warn!("SQLite order imports payload is missing; falling back to JSON")
            }
            Err(error) => {
                tracing::warn!(%error, "SQLite order imports read failed; falling back to JSON")
            }
        }
    }

    Ok(Json(
        public_imports(&state.paths).map_err(ApiError::internal)?,
    ))
}

#[derive(Debug, Deserialize)]
struct CommitOrderImportPayload {
    preview_token: String,
}

async fn commit_order_import(
    State(state): State<AppState>,
    Json(payload): Json<CommitOrderImportPayload>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    if payload.preview_token.trim().is_empty() {
        return Err(ApiError {
            status: StatusCode::BAD_REQUEST,
            message: "缺少导入预览凭据，请重新选择文件".to_string(),
        });
    }
    let value =
        commit_preview(&state.paths, &payload.preview_token).map_err(ApiError::bad_request)?;
    sync_storage_best_effort(&state).await;
    Ok((StatusCode::CREATED, Json(value)))
}

async fn remove_order_import(
    State(state): State<AppState>,
    AxumPath(batch_id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let deleted = delete_batch(&state.paths, &batch_id).map_err(ApiError::bad_request)?;
    sync_storage_best_effort(&state).await;
    Ok(Json(json!({ "deleted": deleted })))
}

async fn inventory_raw(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let path = state.paths.inventory_snapshot_path();
    match read_json_file(&path).map_err(ApiError::internal)? {
        Some(value) => Ok(Json(value)),
        None => Err(ApiError {
            status: StatusCode::NOT_FOUND,
            message: format!("missing inventory snapshot: {}", path.display()),
        }),
    }
}

async fn status_raw(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let path = state.paths.task_status_path();
    match read_json_file(&path).map_err(ApiError::internal)? {
        Some(value) => Ok(Json(value)),
        None => Ok(Json(
            json!({ "state": "unknown", "message": "no task status file" }),
        )),
    }
}

async fn status(
    State(state): State<AppState>,
    Query(query): Query<StatusQuery>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        status_payload(&state.paths, &state.novnc_url, query.terminal_output)
            .map_err(ApiError::internal)?,
    ))
}

async fn status_log_tail(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let path = state.paths.progress_log_path();
    let tail = progress_log_tail(&state.paths)
        .map_err(ApiError::internal)?
        .unwrap_or_default();
    Ok(Json(json!({ "path": path, "terminal_output": tail })))
}

async fn storage_summary(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let Some(pool) = &state.storage_pool else {
        return Err(ApiError {
            status: StatusCode::SERVICE_UNAVAILABLE,
            message: "SQLite-backed reads are disabled; set LUOPAN_API_RS_STORAGE_READS=true"
                .to_string(),
        });
    };
    let payload = summary(pool)
        .await
        .map_err(ApiError::internal)?
        .as_json(&state.paths);
    Ok(Json(payload))
}

async fn diagnostics(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let operations_count = load_operations_records(&state.paths)
        .map_err(ApiError::internal)?
        .len();
    let order_imports = public_imports(&state.paths).map_err(ApiError::internal)?;
    let storage = if let Some(pool) = &state.storage_pool {
        match summary(pool).await {
            Ok(summary) => json!({"ok": true, "summary": summary.as_json(&state.paths)}),
            Err(error) => json!({"ok": false, "error": error.to_string()}),
        }
    } else {
        json!({"ok": false, "error": "SQLite-backed reads are disabled"})
    };
    let status =
        status_payload(&state.paths, &state.novnc_url, false).map_err(ApiError::internal)?;
    let inventory_snapshot = state.paths.inventory_snapshot_path().exists();
    let task_status = state.paths.task_status_path().exists();
    let ok = operations_count > 0
        && inventory_snapshot
        && task_status
        && storage.get("ok").and_then(Value::as_bool).unwrap_or(false);
    Ok(Json(json!({
        "ok": ok,
        "paths": state.paths,
        "checks": {
            "inventory_snapshot": inventory_snapshot,
            "task_status": task_status,
            "progress_log": state.paths.progress_log_path().exists(),
            "operations_records": operations_count,
            "order_imports": order_imports.get("summary").cloned().unwrap_or_default(),
            "storage": storage,
            "status": status,
        }
    })))
}

async fn sync_storage_best_effort(state: &AppState) {
    if let Some(pool) = &state.storage_pool {
        if let Err(error) = luopan_storage::sync_all(&state.paths, pool).await {
            tracing::warn!(%error, "SQLite storage sync failed after order write");
        }
    }
}

fn env_bool(key: &str, default: bool) -> bool {
    env::var(key)
        .ok()
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(default)
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn test_pool() -> StoragePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        luopan_storage::migrate(&pool).await.unwrap();
        pool
    }

    #[test]
    fn verifies_legacy_salt_sha256_passwords() {
        let hash = format!(
            "legacy-salt${:x}",
            Sha256::digest(b"legacy-saltcorrect horse")
        );
        assert!(verify_password("correct horse", &hash));
        assert!(!verify_password("wrong", &hash));
        assert!(is_legacy_password_hash(&hash));
    }

    #[test]
    fn verifies_argon2_passwords() {
        let hash = hash_password("correct horse").unwrap();
        assert!(verify_password("correct horse", &hash));
        assert!(!verify_password("wrong", &hash));
        assert!(!is_legacy_password_hash(&hash));
    }

    #[tokio::test]
    async fn login_upgrades_a_legacy_password_hash_to_argon2() {
        let pool = Arc::new(test_pool().await);
        let legacy_hash = format!("salt${:x}", Sha256::digest(b"saltdashboard-password"));
        sqlx::query(
            "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)",
        )
        .bind("alice")
        .bind(&legacy_hash)
        .bind("admin")
        .bind(now_string())
        .execute(&*pool)
        .await
        .unwrap();
        let root = std::env::temp_dir().join("luopan-auth-login-test");
        let state = AppState {
            paths: Arc::new(RuntimePaths {
                app_dir: root.clone(),
                output_dir: root.join("output"),
                state_dir: root.join("state"),
                config_dir: root.join("config"),
                logs_dir: root.join("logs"),
                session_dir: root.join("session"),
            }),
            novnc_url: Arc::new("http://127.0.0.1:6080".to_string()),
            auth_pool: pool.clone(),
            storage_pool: None,
        };
        let response = login(
            State(state),
            Json(LoginPayload {
                username: "alice".to_string(),
                password: "dashboard-password".to_string(),
            }),
        )
        .await
        .unwrap();
        assert!(response.headers().contains_key(header::SET_COOKIE));
        let upgraded: String =
            sqlx::query("SELECT password_hash FROM users WHERE username = 'alice'")
                .fetch_one(&*pool)
                .await
                .unwrap()
                .get(0);
        assert!(upgraded.starts_with("$argon2"));
        assert!(verify_password("dashboard-password", &upgraded));
    }

    #[tokio::test]
    async fn sessions_are_backed_by_sqlite_and_expire() {
        let pool = test_pool().await;
        sqlx::query(
            "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)",
        )
        .bind("alice")
        .bind(hash_password("password").unwrap())
        .bind("admin")
        .bind(now_string())
        .execute(&pool)
        .await
        .unwrap();
        let token = create_session(&pool, "alice").await.unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_str(&format!("{SESSION_COOKIE_NAME}={token}")).unwrap(),
        );
        assert_eq!(
            authenticated_user(&pool, &headers).await.unwrap(),
            Some(("alice".to_string(), "admin".to_string()))
        );
        sqlx::query("UPDATE sessions SET expires_at = 0")
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(authenticated_user(&pool, &headers).await.unwrap(), None);
    }

    #[tokio::test]
    async fn imports_legacy_users_without_overwriting_migrated_accounts() {
        let root = std::env::temp_dir().join(format!(
            "luopan-auth-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let paths = RuntimePaths {
            app_dir: root.clone(),
            output_dir: root.join("output"),
            state_dir: root.join("state"),
            config_dir: root.join("config"),
            logs_dir: root.join("logs"),
            session_dir: root.join("session"),
        };
        fs::create_dir_all(&paths.config_dir).unwrap();
        fs::write(
            paths.config_dir.join("users.json"),
            r#"{"alice":{"password_hash":"salt$fcf730b6d95236ec5b4c6f4e6e2fba6c1d6c5c4f9cc377da8471c3a876b2c25e","role":"admin","created_at":"2025-01-01T00:00:00"}}"#,
        )
        .unwrap();
        let pool = test_pool().await;
        import_legacy_users(&pool, &paths).await.unwrap();
        let stored: String =
            sqlx::query("SELECT password_hash FROM users WHERE username = 'alice'")
                .fetch_one(&pool)
                .await
                .unwrap()
                .get(0);
        assert_eq!(
            stored,
            "salt$fcf730b6d95236ec5b4c6f4e6e2fba6c1d6c5c4f9cc377da8471c3a876b2c25e"
        );
        let _ = fs::remove_dir_all(root);
    }
}
