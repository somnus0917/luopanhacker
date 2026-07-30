use std::{env, fs, io::Write, net::SocketAddr, sync::Arc, time::Instant};

use anyhow::{Context, Result};
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Multipart, Path as AxumPath, Query, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    middleware::{Next, from_fn, from_fn_with_state},
    response::{IntoResponse, Response},
    routing::{delete, get, get_service, post},
};
use chrono::{Datelike, Local, NaiveDate};
use fs2::FileExt;
use luopan_channels::load_channel_dashboard;
use luopan_inventory::load_inventory_dashboard;
use luopan_jobs::{clear_progress_log, progress_log_tail, status_payload, write_task_status};
use luopan_operations::load_operations_records;
use luopan_orders::{
    UploadedWorkbook, commit_preview, delete_batch, preview_upload, public_imports,
};
use luopan_runtime::{RuntimePaths, read_json_file};
use luopan_settlement::{
    load_settlement_dashboard_filtered, load_settlement_dashboard_for_shop, save_settlement_upload,
};
use luopan_storage::{
    StoragePool, kv_value_with_updated_at, load_operations_records_from_db, public_imports_from_db,
    summary,
};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
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
    security: Arc<SecurityConfig>,
}

const SESSION_COOKIE_NAME: &str = "compass_session";
const SESSION_LIFETIME_SECONDS: i64 = 24 * 60 * 60;
const SESSION_IDLE_TIMEOUT_SECONDS: i64 = 30 * 60;
const LOGIN_FAILURE_LIMIT: i64 = 5;
const LOGIN_FAILURE_WINDOW_SECONDS: i64 = 15 * 60;
const LOGIN_LOCKOUT_SECONDS: i64 = 15 * 60;
const ADMIN_UPLOAD_LIMIT_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug)]
struct SecurityConfig {
    production: bool,
    session_cookie_secure: bool,
    trusted_origins: Vec<String>,
}

impl SecurityConfig {
    fn from_env() -> Self {
        let production = !matches!(
            env::var("LUOPAN_ENV").ok().as_deref(),
            Some("development" | "dev" | "test")
        );
        let configured_secure = env_bool("SESSION_COOKIE_SECURE", production);
        if production && !configured_secure {
            tracing::warn!("SESSION_COOKIE_SECURE=false is ignored in production");
        }
        Self {
            production,
            session_cookie_secure: production || configured_secure,
            trusted_origins: env::var("LUOPAN_TRUSTED_ORIGINS")
                .unwrap_or_default()
                .split(',')
                .map(str::trim)
                .filter(|origin| !origin.is_empty())
                .map(ToOwned::to_owned)
                .chain((!production).then(|| "http://127.0.0.1:5173".to_string()))
                .collect(),
        }
    }
}

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

#[derive(Debug, Deserialize)]
struct ChangePasswordPayload {
    current_password: String,
    new_password: String,
}

#[derive(Debug, Deserialize)]
struct CreateUserPayload {
    username: String,
    password: String,
    role: String,
}

fn default_role() -> String {
    "viewer".to_string()
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
    request_id: String,
}

impl ApiError {
    fn internal(error: anyhow::Error) -> Self {
        let request_id = error_request_id();
        tracing::error!(%request_id, error = %error, "internal API error");
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "INTERNAL_ERROR",
            message: "服务器内部错误".to_string(),
            request_id,
        }
    }

    fn bad_request(error: anyhow::Error) -> Self {
        Self::client(
            StatusCode::BAD_REQUEST,
            "INVALID_REQUEST",
            error.to_string(),
        )
    }

    fn client(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            request_id: error_request_id(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let request_id = self.request_id;
        let mut response = (
            self.status,
            Json(json!({
                "data": Value::Null,
                "error": { "code": self.code, "message": self.message },
                "meta": { "request_id": request_id },
            })),
        )
            .into_response();
        response.headers_mut().insert(
            "x-request-id",
            HeaderValue::from_str(&request_id).expect("generated request ID is a valid header"),
        );
        response
    }
}

fn error_request_id() -> String {
    let mut bytes = [0_u8; 12];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[derive(Serialize)]
struct HealthPayload {
    service: &'static str,
    ok: bool,
}

fn api(data: impl Serialize) -> Json<Value> {
    api_with_meta(data, "api", false, now_string())
}

fn api_with_meta(
    data: impl Serialize,
    source: &str,
    fallback: bool,
    updated_at: String,
) -> Json<Value> {
    Json(json!({
        "data": data,
        "error": Value::Null,
        "meta": {
            "request_id": error_request_id(),
            "source": source,
            "fallback": fallback,
            "updated_at": updated_at,
        },
    }))
}

#[derive(Debug, Deserialize)]
struct StatusQuery {
    #[serde(default = "default_terminal_output")]
    terminal_output: bool,
}

#[derive(Debug, Deserialize)]
struct SettlementQuery {
    shop: Option<String>,
    start_date: Option<String>,
    end_date: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SettlementUploadPayload {
    shop_name: String,
    file_name: String,
    content: String,
}

#[derive(Debug, Deserialize, Default)]
struct CollectionRunPayload {
    #[serde(default)]
    modules: Vec<String>,
    date: Option<String>,
    #[serde(default)]
    shops: Vec<String>,
}

fn default_terminal_output() -> bool {
    true
}

#[tokio::main]
async fn main() -> Result<()> {
    if let Some(argument) = env::args().nth(1) {
        if argument == "-h" || argument == "--help" {
            println!(
                "Rust dashboard API for Luopan\n\nUsage: luopan-api-rs\n\nEnvironment:\n  LUOPAN_API_RS_HOST           Bind host, default 127.0.0.1\n  LUOPAN_API_RS_PORT           Bind port, default 8501\n  LUOPAN_API_RS_STORAGE_READS  Read supported payloads from SQLite when true"
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
    ensure_initial_admin(&auth_pool, env::var("ADMIN_PASSWORD").ok().as_deref()).await?;
    let storage_pool = env_bool("LUOPAN_API_RS_STORAGE_READS", false).then_some(auth_pool.clone());
    let security = Arc::new(SecurityConfig::from_env());
    let state = AppState {
        paths: paths.clone(),
        novnc_url,
        auth_pool,
        storage_pool,
        security: security.clone(),
    };
    let protected = Router::new()
        .route("/api/compass", get(compass_dashboard))
        .route("/api/inventory", get(inventory_dashboard))
        .route("/api/channel", get(channel_dashboard))
        .route("/api/inventory/raw", get(inventory_raw))
        .route("/api/settlement", get(settlement_dashboard))
        .route("/api/orders/imports", get(order_imports))
        .route("/api/storage/summary", get(storage_summary))
        .route("/api/status", get(status))
        .route("/api/status/raw", get(status_raw))
        .route("/api/status/log-tail", get(status_log_tail))
        .route("/api/collection/status", get(status))
        .route("/api/collection/shops", get(collection_shops))
        .route("/api/collection/status/raw", get(status_raw))
        .route("/api/collection/status/log-tail", get(status_log_tail))
        .route_layer(from_fn_with_state(state.clone(), require_auth));
    let account = Router::new()
        .route("/api/account/password", post(change_password))
        .route_layer(from_fn_with_state(state.clone(), require_auth));
    let admin_only = Router::new()
        .route("/api/settlement/uploads", post(upload_settlement))
        .route("/api/orders/preview", post(preview_order_import))
        .route("/api/orders/imports", post(commit_order_import))
        .route(
            "/api/orders/imports/{batch_id}",
            delete(remove_order_import),
        )
        .route("/api/scrape", post(scrape))
        .route("/api/collection/run", post(run_collection))
        .route(
            "/api/collection/terminal",
            delete(clear_collection_terminal),
        )
        .route("/api/users", get(list_users).post(create_user))
        .route("/api/users/{username}", delete(remove_user))
        .route("/api/diagnostics", get(diagnostics))
        .layer(DefaultBodyLimit::max(ADMIN_UPLOAD_LIMIT_BYTES))
        .route_layer(from_fn_with_state(state.clone(), require_admin));
    let static_dir = paths.app_dir.join("web").join("static");
    let index_file = Router::new()
        .route_service(
            "/",
            get_service(ServeFile::new(static_dir.join("index.html"))),
        )
        .layer(SetResponseHeaderLayer::if_not_present(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-cache, no-store, must-revalidate"),
        ));
    let static_assets = Router::new()
        .nest_service("/assets", ServeDir::new(static_dir))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=3600"),
        ));
    let static_files = index_file.merge(static_assets);
    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .route("/api/login", post(login))
        .route("/api/logout", post(logout))
        .route("/api/me", get(me))
        .merge(protected)
        .merge(account)
        .merge(admin_only)
        .merge(static_files)
        .layer(from_fn(request_logging))
        .layer(from_fn_with_state(state.clone(), csrf_protection))
        .layer(TraceLayer::new_for_http())
        .with_state(state);
    let app = if security.production {
        app
    } else {
        tracing::info!("development CORS enabled only for Vite");
        app.layer(
            CorsLayer::new()
                .allow_origin(HeaderValue::from_static("http://127.0.0.1:5173"))
                .allow_methods([Method::GET, Method::POST, Method::DELETE])
                .allow_headers([header::CONTENT_TYPE]),
        )
    };

    let host = env::var("LUOPAN_API_RS_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = env::var("LUOPAN_API_RS_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(8501);
    let address: SocketAddr = format!("{host}:{port}").parse()?;
    tracing::info!(%address, "starting luopan-api-rs");
    let listener = tokio::net::TcpListener::bind(address).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn healthz() -> Json<Value> {
    api(HealthPayload {
        service: "luopan-api-rs",
        ok: true,
    })
}

async fn readyz(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let sqlite_available = sqlx::query("SELECT 1")
        .fetch_one(&*state.auth_pool)
        .await
        .is_ok();
    let static_files_available = state.paths.app_dir.join("web/static/index.html").is_file();
    let runtime_dir_available = state.paths.state_dir.is_dir();
    if !(sqlite_available && static_files_available && runtime_dir_available) {
        tracing::warn!(
            sqlite_available,
            static_files_available,
            runtime_dir_available,
            "readiness check failed"
        );
        return Err(ApiError::client(
            StatusCode::SERVICE_UNAVAILABLE,
            "NOT_READY",
            "服务尚未就绪",
        ));
    }
    Ok(api(json!({
        "service": "luopan-api-rs",
        "ready": true,
        "checks": { "sqlite": true, "static_files": true, "runtime_dir": true },
    })))
}

async fn request_logging(request: Request, next: Next) -> Response {
    let request_id = request
        .headers()
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(error_request_id);
    let route = request.uri().path().to_string();
    let method = request.method().clone();
    let started = Instant::now();
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .entry("x-request-id")
        .or_insert_with(|| {
            HeaderValue::from_str(&request_id).expect("generated request ID is a valid header")
        });
    tracing::info!(
        %request_id,
        %route,
        method = %method,
        status = %response.status(),
        elapsed_ms = started.elapsed().as_millis(),
        "request completed"
    );
    response
}

async fn login(
    State(state): State<AppState>,
    Json(payload): Json<LoginPayload>,
) -> Result<Response, ApiError> {
    let username = payload.username.trim();
    if login_is_rate_limited(&state.auth_pool, username)
        .await
        .map_err(ApiError::internal)?
    {
        return Err(ApiError::client(
            StatusCode::TOO_MANY_REQUESTS,
            "LOGIN_RATE_LIMITED",
            "登录失败次数过多，请 15 分钟后再试",
        ));
    }
    let user = sqlx::query("SELECT password_hash, role FROM users WHERE username = ?")
        .bind(username)
        .fetch_optional(&*state.auth_pool)
        .await
        .map_err(|error| ApiError::internal(error.into()))?;
    let Some(user) = user else {
        record_failed_login(&state.auth_pool, username)
            .await
            .map_err(ApiError::internal)?;
        return Err(invalid_credentials());
    };
    let password_hash: String = user.get("password_hash");
    if !verify_password(&payload.password, &password_hash) {
        record_failed_login(&state.auth_pool, username)
            .await
            .map_err(ApiError::internal)?;
        return Err(invalid_credentials());
    }
    clear_login_attempts(&state.auth_pool, username)
        .await
        .map_err(ApiError::internal)?;
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
    let mut response = api(LoginResponse {
        username: username.to_string(),
        role,
    })
    .into_response();
    response
        .headers_mut()
        .insert(header::SET_COOKIE, session_cookie(&token, &state.security));
    Ok(response)
}

async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Some(token) = session_token(&headers)
        && let Err(error) = sqlx::query("DELETE FROM sessions WHERE token_hash = ?")
            .bind(token_hash(&token))
            .execute(&*state.auth_pool)
            .await
    {
        tracing::warn!(%error, "could not remove session during logout");
    }
    let mut response = (StatusCode::OK, api(json!({ "logged_out": true }))).into_response();
    response
        .headers_mut()
        .insert(header::SET_COOKIE, expired_session_cookie(&state.security));
    response
}

async fn me(State(state): State<AppState>, headers: HeaderMap) -> Result<Json<Value>, ApiError> {
    match authenticated_user(&state.auth_pool, &headers)
        .await
        .map_err(ApiError::internal)?
    {
        Some((username, role)) => Ok(api(MeResponse {
            authenticated: true,
            username: Some(username),
            role: Some(role),
        })),
        None => Ok(api(MeResponse {
            authenticated: false,
            username: None,
            role: None,
        })),
    }
}

async fn change_password(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<ChangePasswordPayload>,
) -> Result<Json<Value>, ApiError> {
    let (username, _) = authorized_user(&state.auth_pool, &headers, None).await?;
    validate_password(&payload.new_password).map_err(ApiError::bad_request)?;
    let stored_hash: String =
        sqlx::query_scalar("SELECT password_hash FROM users WHERE username = ?")
            .bind(&username)
            .fetch_one(&*state.auth_pool)
            .await
            .map_err(|error| ApiError::internal(error.into()))?;
    if !verify_password(&payload.current_password, &stored_hash) {
        return Err(ApiError::client(
            StatusCode::BAD_REQUEST,
            "INVALID_PASSWORD",
            "当前密码错误",
        ));
    }
    let new_hash = hash_password(&payload.new_password).map_err(ApiError::internal)?;
    sqlx::query("UPDATE users SET password_hash = ?, password_changed_at = ? WHERE username = ?")
        .bind(new_hash)
        .bind(now_string())
        .bind(&username)
        .execute(&*state.auth_pool)
        .await
        .map_err(|error| ApiError::internal(error.into()))?;

    if let Some(token) = session_token(&headers) {
        sqlx::query("DELETE FROM sessions WHERE username = ? AND token_hash != ?")
            .bind(&username)
            .bind(token_hash(&token))
            .execute(&*state.auth_pool)
            .await
            .map_err(|error| ApiError::internal(error.into()))?;
    }
    Ok(api(json!({ "message": "密码已更新" })))
}

async fn list_users(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let rows = sqlx::query(
        "SELECT username, role, created_at, password_changed_at FROM users ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, username",
    )
    .fetch_all(&*state.auth_pool)
    .await
    .map_err(|error| ApiError::internal(error.into()))?;
    let users = rows
        .into_iter()
        .map(|row| {
            json!({
                "username": row.get::<String, _>("username"),
                "role": row.get::<String, _>("role"),
                "created_at": row.get::<String, _>("created_at"),
                "password_changed_at": row.get::<Option<String>, _>("password_changed_at"),
            })
        })
        .collect::<Vec<_>>();
    Ok(api(json!({ "users": users })))
}

async fn create_user(
    State(state): State<AppState>,
    Json(payload): Json<CreateUserPayload>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let username = validate_username(&payload.username)
        .map_err(ApiError::bad_request)?
        .to_string();
    validate_password(&payload.password).map_err(ApiError::bad_request)?;
    let role = payload.role.trim();
    if !matches!(role, "admin" | "viewer") {
        return Err(ApiError::client(
            StatusCode::BAD_REQUEST,
            "INVALID_ROLE",
            "角色必须为 admin 或 viewer",
        ));
    }
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE username = ?)")
        .bind(&username)
        .fetch_one(&*state.auth_pool)
        .await
        .map_err(|error| ApiError::internal(error.into()))?;
    if exists {
        return Err(ApiError::client(
            StatusCode::CONFLICT,
            "USER_EXISTS",
            "用户名已存在",
        ));
    }
    let created_at = now_string();
    sqlx::query(
        "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(&username)
    .bind(hash_password(&payload.password).map_err(ApiError::internal)?)
    .bind(role)
    .bind(&created_at)
    .execute(&*state.auth_pool)
    .await
    .map_err(|error| ApiError::internal(error.into()))?;
    Ok((
        StatusCode::CREATED,
        api(json!({ "user": { "username": username, "role": role, "created_at": created_at } })),
    ))
}

async fn remove_user(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(username): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let (current_username, _) = authorized_user(&state.auth_pool, &headers, Some("admin")).await?;
    let username = validate_username(&username)
        .map_err(ApiError::bad_request)?
        .to_string();
    if username == current_username {
        return Err(ApiError::client(
            StatusCode::BAD_REQUEST,
            "CANNOT_DELETE_CURRENT_USER",
            "不能删除当前登录账户",
        ));
    }
    let role: Option<String> = sqlx::query_scalar("SELECT role FROM users WHERE username = ?")
        .bind(&username)
        .fetch_optional(&*state.auth_pool)
        .await
        .map_err(|error| ApiError::internal(error.into()))?;
    let Some(role) = role else {
        return Err(ApiError::client(
            StatusCode::NOT_FOUND,
            "USER_NOT_FOUND",
            "用户不存在",
        ));
    };
    if role == "admin" {
        let admin_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE role = 'admin'")
                .fetch_one(&*state.auth_pool)
                .await
                .map_err(|error| ApiError::internal(error.into()))?;
        if admin_count <= 1 {
            return Err(ApiError::client(
                StatusCode::BAD_REQUEST,
                "LAST_ADMIN",
                "必须至少保留一个管理员账户",
            ));
        }
    }
    sqlx::query("DELETE FROM users WHERE username = ?")
        .bind(&username)
        .execute(&*state.auth_pool)
        .await
        .map_err(|error| ApiError::internal(error.into()))?;
    Ok(api(json!({ "deleted": username })))
}

async fn require_auth(State(state): State<AppState>, request: Request, next: Next) -> Response {
    match authorized_user(&state.auth_pool, request.headers(), None).await {
        Ok(_) => next.run(request).await,
        Err(error) => error.into_response(),
    }
}

async fn require_admin(State(state): State<AppState>, request: Request, next: Next) -> Response {
    match authorized_user(&state.auth_pool, request.headers(), Some("admin")).await {
        Ok(_) => next.run(request).await,
        Err(error) => error.into_response(),
    }
}

async fn csrf_protection(State(state): State<AppState>, request: Request, next: Next) -> Response {
    if matches!(
        request.method(),
        &Method::GET | &Method::HEAD | &Method::OPTIONS
    ) {
        return next.run(request).await;
    }
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok());
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok());
    let is_same_origin = origin.is_some_and(|origin| {
        state
            .security
            .trusted_origins
            .iter()
            .any(|allowed| allowed == origin)
            || host.is_some_and(|host| {
                origin == format!("https://{host}") || origin == format!("http://{host}")
            })
    });
    if !is_same_origin {
        return ApiError::client(StatusCode::FORBIDDEN, "CSRF_REJECTED", "请求来源校验失败")
            .into_response();
    }
    next.run(request).await
}

async fn authorized_user(
    pool: &StoragePool,
    headers: &HeaderMap,
    required_role: Option<&str>,
) -> Result<(String, String), ApiError> {
    let user = authenticated_user(pool, headers)
        .await
        .map_err(|error| {
            tracing::error!(%error, "session validation failed");
            ApiError::internal(error)
        })?
        .ok_or_else(|| ApiError::client(StatusCode::UNAUTHORIZED, "UNAUTHENTICATED", "请先登录"))?;
    if required_role.is_some_and(|role| user.1 != role) {
        return Err(ApiError::client(
            StatusCode::FORBIDDEN,
            "FORBIDDEN",
            "当前账户没有执行此操作的权限",
        ));
    }
    Ok(user)
}

fn invalid_credentials() -> ApiError {
    ApiError::client(
        StatusCode::UNAUTHORIZED,
        "INVALID_CREDENTIALS",
        "用户名或密码错误",
    )
}

async fn ensure_initial_admin(pool: &StoragePool, password: Option<&str>) -> Result<()> {
    let user_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(pool)
        .await?;
    if user_count > 0 {
        return Ok(());
    }

    let password = password
        .filter(|value| !value.trim().is_empty())
        .context("ADMIN_PASSWORD must be set when initializing the first dashboard account")?;
    validate_password(password)?;
    sqlx::query(
        "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind("admin")
    .bind(hash_password(password)?)
    .bind("admin")
    .bind(now_string())
    .execute(pool)
    .await?;
    Ok(())
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
        .bind(normalize_role(&user.role))
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

fn normalize_role(role: &str) -> &'static str {
    if role.trim() == "admin" {
        "admin"
    } else {
        "viewer"
    }
}

fn validate_password(password: &str) -> Result<()> {
    if password.chars().count() < 12 {
        anyhow::bail!("密码至少需要 12 个字符");
    }
    if password == "admin123" {
        anyhow::bail!("不能使用默认密码 admin123");
    }
    Ok(())
}

fn validate_username(username: &str) -> Result<&str> {
    let username = username.trim();
    if username.is_empty() || username.chars().count() > 64 {
        anyhow::bail!("用户名长度必须为 1 到 64 个字符");
    }
    if username.chars().any(char::is_control) {
        anyhow::bail!("用户名不能包含控制字符");
    }
    Ok(username)
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
        "INSERT INTO sessions (token_hash, username, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(token_hash(&token))
    .bind(username)
    .bind(now)
    .bind(now + SESSION_LIFETIME_SECONDS)
    .bind(now)
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
    let now = chrono::Utc::now().timestamp();
    let row = sqlx::query(
        "SELECT users.username, users.role FROM sessions JOIN users ON users.username = sessions.username WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND sessions.last_seen_at > ?",
    )
    .bind(token_hash(&token))
    .bind(now)
    .bind(now - SESSION_IDLE_TIMEOUT_SECONDS)
    .fetch_optional(pool)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    sqlx::query("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?")
        .bind(now)
        .bind(token_hash(&token))
        .execute(pool)
        .await?;
    Ok(Some((row.get("username"), row.get("role"))))
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

fn session_cookie(token: &str, security: &SecurityConfig) -> HeaderValue {
    let secure = if security.session_cookie_secure {
        "; Secure"
    } else {
        ""
    };
    HeaderValue::from_str(&format!(
        "{SESSION_COOKIE_NAME}={token}; Path=/; Max-Age={SESSION_LIFETIME_SECONDS}; HttpOnly; SameSite=Lax{secure}"
    ))
    .expect("session cookie is valid")
}

async fn login_is_rate_limited(pool: &StoragePool, username: &str) -> Result<bool> {
    let now = chrono::Utc::now().timestamp();
    let row = sqlx::query("SELECT failed_count, window_started_at, locked_until FROM login_attempts WHERE username = ?")
        .bind(username)
        .fetch_optional(pool)
        .await?;
    let Some(row) = row else {
        return Ok(false);
    };
    let locked_until: i64 = row.get("locked_until");
    if locked_until > now {
        return Ok(true);
    }
    let window_started_at: i64 = row.get("window_started_at");
    if window_started_at + LOGIN_FAILURE_WINDOW_SECONDS <= now {
        sqlx::query("DELETE FROM login_attempts WHERE username = ?")
            .bind(username)
            .execute(pool)
            .await?;
    }
    Ok(false)
}

async fn record_failed_login(pool: &StoragePool, username: &str) -> Result<()> {
    let now = chrono::Utc::now().timestamp();
    let row = sqlx::query(
        "SELECT failed_count, window_started_at FROM login_attempts WHERE username = ?",
    )
    .bind(username)
    .fetch_optional(pool)
    .await?;
    let (failed_count, window_started_at) = match row {
        Some(row)
            if row.get::<i64, _>("window_started_at") + LOGIN_FAILURE_WINDOW_SECONDS > now =>
        {
            (
                row.get::<i64, _>("failed_count") + 1,
                row.get::<i64, _>("window_started_at"),
            )
        }
        _ => (1, now),
    };
    let locked_until = if failed_count >= LOGIN_FAILURE_LIMIT {
        now + LOGIN_LOCKOUT_SECONDS
    } else {
        0
    };
    sqlx::query(
        "INSERT INTO login_attempts (username, failed_count, window_started_at, locked_until) VALUES (?, ?, ?, ?) ON CONFLICT(username) DO UPDATE SET failed_count = excluded.failed_count, window_started_at = excluded.window_started_at, locked_until = excluded.locked_until",
    )
    .bind(username)
    .bind(failed_count)
    .bind(window_started_at)
    .bind(locked_until)
    .execute(pool)
    .await?;
    Ok(())
}

async fn clear_login_attempts(pool: &StoragePool, username: &str) -> Result<()> {
    sqlx::query("DELETE FROM login_attempts WHERE username = ?")
        .bind(username)
        .execute(pool)
        .await?;
    Ok(())
}

fn expired_session_cookie(security: &SecurityConfig) -> HeaderValue {
    let secure = if security.session_cookie_secure {
        "; Secure"
    } else {
        ""
    };
    HeaderValue::from_str(&format!(
        "compass_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax{secure}"
    ))
    .expect("session cookie is valid")
}

fn now_string() -> String {
    chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string()
}

async fn inventory_dashboard(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    if let Some(pool) = &state.storage_pool {
        match kv_value_with_updated_at(pool, "inventory_dashboard").await {
            Ok(Some(payload)) => {
                return Ok(api_with_meta(
                    payload.value,
                    "sqlite",
                    false,
                    payload.updated_at,
                ));
            }
            Ok(None) => tracing::warn!("SQLite inventory payload is missing; falling back to JSON"),
            Err(error) => {
                tracing::warn!(%error, "SQLite inventory read failed; falling back to JSON")
            }
        }
    }

    match load_inventory_dashboard(&state.paths).map_err(ApiError::internal)? {
        Some(value) => Ok(api_with_meta(
            value,
            "json",
            state.storage_pool.is_some(),
            now_string(),
        )),
        None => Err(ApiError::client(
            StatusCode::NOT_FOUND,
            "INVENTORY_NOT_FOUND",
            "暂无库存快照",
        )),
    }
}

struct LoadedPayload {
    value: Value,
    source: &'static str,
    fallback: bool,
    updated_at: String,
}

async fn load_channel_payload(state: &AppState) -> Result<LoadedPayload, ApiError> {
    if let Some(pool) = &state.storage_pool {
        match kv_value_with_updated_at(pool, "channel_dashboard").await {
            Ok(Some(payload)) => {
                return Ok(LoadedPayload {
                    value: payload.value,
                    source: "sqlite",
                    fallback: false,
                    updated_at: payload.updated_at,
                });
            }
            Ok(None) => tracing::warn!("SQLite channel payload is missing; falling back to JSON"),
            Err(error) => {
                tracing::warn!(%error, "SQLite channel read failed; falling back to JSON")
            }
        }
    }
    Ok(LoadedPayload {
        value: load_channel_dashboard(&state.paths).map_err(ApiError::internal)?,
        source: "json",
        fallback: state.storage_pool.is_some(),
        updated_at: now_string(),
    })
}

async fn channel_dashboard(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let payload = load_channel_payload(&state).await?;
    Ok(api_with_meta(
        payload.value,
        payload.source,
        payload.fallback,
        payload.updated_at,
    ))
}

async fn compass_dashboard(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let (records, records_source, records_fallback) = if let Some(pool) = &state.storage_pool {
        match load_operations_records_from_db(pool).await {
            Ok(records) if !records.is_empty() => (records, "sqlite", false),
            Ok(_) => {
                tracing::warn!("SQLite operations payload is empty; falling back to JSON");
                (
                    load_operations_records(&state.paths).map_err(ApiError::internal)?,
                    "json",
                    true,
                )
            }
            Err(error) => {
                tracing::warn!(%error, "SQLite operations read failed; falling back to JSON");
                (
                    load_operations_records(&state.paths).map_err(ApiError::internal)?,
                    "json",
                    true,
                )
            }
        }
    } else {
        (
            load_operations_records(&state.paths).map_err(ApiError::internal)?,
            "json",
            false,
        )
    };
    let channel = load_channel_payload(&state).await?;
    let source = if records_source == channel.source {
        records_source
    } else {
        "mixed"
    };
    Ok(api_with_meta(
        json!({
            "records": records,
            "channel": channel.value,
            "generated_at": chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string(),
        }),
        source,
        records_fallback || channel.fallback,
        channel.updated_at,
    ))
}

async fn settlement_dashboard(
    State(state): State<AppState>,
    Query(query): Query<SettlementQuery>,
) -> Result<Json<Value>, ApiError> {
    let (start_date, end_date) = validate_settlement_date_range(query.start_date, query.end_date)
        .map_err(ApiError::bad_request)?;
    Ok(api(load_settlement_dashboard_filtered(
        &state.paths,
        query.shop.as_deref(),
        start_date.as_deref(),
        end_date.as_deref(),
    )
    .map_err(ApiError::internal)?))
}

fn validate_settlement_date_range(
    start_date: Option<String>,
    end_date: Option<String>,
) -> Result<(Option<String>, Option<String>)> {
    let parse = |value: Option<String>, label: &str| -> Result<Option<String>> {
        let Some(value) = value else {
            return Ok(None);
        };
        let value = value.trim();
        if value.is_empty() {
            return Ok(None);
        }
        NaiveDate::parse_from_str(value, "%Y-%m-%d")
            .with_context(|| format!("{label}必须是 YYYY-MM-DD 格式"))?;
        Ok(Some(value.to_string()))
    };
    let start_date = parse(start_date, "开始日期")?;
    let end_date = parse(end_date, "结束日期")?;
    if start_date
        .as_ref()
        .zip(end_date.as_ref())
        .is_some_and(|(start, end)| start > end)
    {
        anyhow::bail!("开始日期不能晚于结束日期");
    }
    Ok((start_date, end_date))
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
        api(json!({
            "upload": upload,
            "dashboard": dashboard,
        })),
    ))
}

async fn order_imports(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    if let Some(pool) = &state.storage_pool {
        match public_imports_from_db(pool).await {
            Ok(Some(value)) => return Ok(api_with_meta(value, "sqlite", false, now_string())),
            Ok(None) => {
                tracing::warn!("SQLite order imports payload is missing; falling back to JSON")
            }
            Err(error) => {
                tracing::warn!(%error, "SQLite order imports read failed; falling back to JSON")
            }
        }
    }

    Ok(api_with_meta(
        public_imports(&state.paths).map_err(ApiError::internal)?,
        "json",
        state.storage_pool.is_some(),
        now_string(),
    ))
}

async fn preview_order_import(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<Value>, ApiError> {
    let mut files = Vec::new();
    while let Some(field) = multipart.next_field().await.map_err(|error| {
        tracing::warn!(%error, "failed to read upload field");
        ApiError::client(
            StatusCode::BAD_REQUEST,
            "INVALID_UPLOAD",
            "读取上传文件失败",
        )
    })? {
        if field.name() != Some("files") {
            continue;
        }
        let filename = field.file_name().unwrap_or_default().to_string();
        let content = field
            .bytes()
            .await
            .map_err(|error| {
                tracing::warn!(%error, "failed to read upload bytes");
                ApiError::client(
                    StatusCode::BAD_REQUEST,
                    "INVALID_UPLOAD",
                    "读取上传文件失败",
                )
            })?
            .to_vec();
        files.push(UploadedWorkbook { filename, content });
    }
    Ok(api(
        preview_upload(&state.paths, files).map_err(ApiError::bad_request)?
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
        return Err(ApiError::client(
            StatusCode::BAD_REQUEST,
            "MISSING_PREVIEW_TOKEN",
            "缺少导入预览凭据，请重新选择文件",
        ));
    }
    let value =
        commit_preview(&state.paths, &payload.preview_token).map_err(ApiError::bad_request)?;
    sync_storage_best_effort(&state).await;
    Ok((StatusCode::CREATED, api(value)))
}

async fn remove_order_import(
    State(state): State<AppState>,
    AxumPath(batch_id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let deleted = delete_batch(&state.paths, &batch_id).map_err(ApiError::bad_request)?;
    sync_storage_best_effort(&state).await;
    Ok(api(json!({ "deleted": deleted })))
}

async fn inventory_raw(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let path = state.paths.inventory_snapshot_path();
    match read_json_file(&path).map_err(ApiError::internal)? {
        Some(value) => Ok(api_with_meta(value, "json", false, now_string())),
        None => Err(ApiError::client(
            StatusCode::NOT_FOUND,
            "INVENTORY_NOT_FOUND",
            "暂无库存快照",
        )),
    }
}

async fn status_raw(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let path = state.paths.task_status_path();
    match read_json_file(&path).map_err(ApiError::internal)? {
        Some(value) => Ok(api_with_meta(value, "json", false, now_string())),
        None => Ok(api(
            json!({ "state": "unknown", "message": "no task status file" }),
        )),
    }
}

async fn status(
    State(state): State<AppState>,
    Query(query): Query<StatusQuery>,
) -> Result<Json<Value>, ApiError> {
    Ok(api(status_payload(
        &state.paths,
        &state.novnc_url,
        query.terminal_output,
    )
    .map_err(ApiError::internal)?))
}

async fn collection_shops(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let config_path = state.paths.config_dir.join("shops.local.json");
    let shops = match read_json_file(&config_path).map_err(ApiError::internal)? {
        Some(config) => config
            .get("shops")
            .and_then(Value::as_array)
            .map(|shops| {
                shops
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|shop| !shop.is_empty())
                    .map(ToOwned::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default(),
        None => Vec::new(),
    };
    Ok(api(json!({ "shops": shops })))
}

async fn scrape(State(state): State<AppState>) -> Result<(StatusCode, Json<Value>), ApiError> {
    enqueue_collection(
        &state,
        vec!["operations".to_string(), "channel".to_string()],
        None,
        Vec::new(),
    )
    .await
}

async fn run_collection(
    State(state): State<AppState>,
    Json(payload): Json<CollectionRunPayload>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    enqueue_collection(&state, payload.modules, payload.date, payload.shops).await
}

async fn enqueue_collection(
    state: &AppState,
    modules: Vec<String>,
    date: Option<String>,
    shops: Vec<String>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let modules = validate_collection_modules(modules).map_err(ApiError::bad_request)?;
    let date = validate_collection_date(date).map_err(ApiError::bad_request)?;
    let shops = validate_collection_shops(shops).map_err(ApiError::bad_request)?;
    if date.is_some() && modules != ["operations"] {
        return Err(ApiError::bad_request(anyhow::anyhow!(
            "指定日期补采目前只支持经营数据"
        )));
    }
    let current =
        status_payload(&state.paths, &state.novnc_url, false).map_err(ApiError::internal)?;
    let busy = current
        .get("job_running")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || current
            .get("request_pending")
            .and_then(Value::as_bool)
            .unwrap_or(false);
    if busy {
        return Err(ApiError::client(
            StatusCode::CONFLICT,
            "COLLECTION_BUSY",
            "已有采集任务或待处理请求",
        ));
    }
    if !current
        .get("collector_online")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err(ApiError::client(
            StatusCode::SERVICE_UNAVAILABLE,
            "COLLECTOR_UNAVAILABLE",
            "独立采集服务当前不在线",
        ));
    }
    let paths = state.paths.clone();
    let request_modules = modules.clone();
    let request_date = date.clone();
    let request_shops = shops.clone();
    tokio::task::spawn_blocking(move || {
        write_collection_request(&paths, &request_modules, &request_date, &request_shops)
    })
    .await
    .map_err(|error| ApiError::internal(error.into()))?
    .map_err(ApiError::internal)?;
    let status =
        status_payload(&state.paths, &state.novnc_url, false).map_err(ApiError::internal)?;
    let message = if let Some(data_day) = &date {
        format!("{data_day} 历史补采请求已提交给独立采集服务")
    } else {
        "采集请求已提交给独立采集服务".to_string()
    };
    Ok((
        StatusCode::ACCEPTED,
        api(json!({
            "message": message,
            "modules": modules,
            "date": date,
            "shops": shops,
            "status": status,
        })),
    ))
}

fn validate_collection_modules(modules: Vec<String>) -> Result<Vec<String>> {
    let requested = if modules.is_empty() {
        vec!["operations".to_string(), "channel".to_string()]
    } else {
        modules
    };
    let mut result = Vec::new();
    for module in requested {
        if !matches!(module.as_str(), "operations" | "channel") {
            anyhow::bail!("不支持的采集模块: {module}");
        }
        if !result.contains(&module) {
            result.push(module);
        }
    }
    Ok(result)
}

fn validate_collection_date(date: Option<String>) -> Result<Option<String>> {
    validate_collection_date_at(date, Local::now().date_naive())
}

fn validate_collection_date_at(date: Option<String>, today: NaiveDate) -> Result<Option<String>> {
    let Some(value) = date else {
        return Ok(None);
    };
    let value = value.trim();
    let parsed = NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .with_context(|| format!("补采日期格式无效: {value}，应为 YYYY-MM-DD"))?;
    if parsed >= today {
        anyhow::bail!("补采日期必须早于今天");
    }
    if parsed.year() != today.year() || parsed.month() != today.month() {
        anyhow::bail!("补采日期目前仅支持本月");
    }
    Ok(Some(parsed.format("%Y-%m-%d").to_string()))
}

fn validate_collection_shops(shops: Vec<String>) -> Result<Vec<String>> {
    if shops.len() > 20 {
        anyhow::bail!("单次最多指定 20 家店铺");
    }
    let mut result = Vec::new();
    for shop in shops {
        let shop = shop.trim();
        if shop.is_empty() || shop.len() > 120 || shop.chars().any(char::is_control) {
            anyhow::bail!("店铺名称无效");
        }
        let shop = shop.to_string();
        if !result.contains(&shop) {
            result.push(shop);
        }
    }
    Ok(result)
}

fn write_collection_request(
    paths: &RuntimePaths,
    modules: &[String],
    date: &Option<String>,
    shops: &[String],
) -> Result<()> {
    fs::create_dir_all(paths.collection_dir())
        .with_context(|| format!("create {}", paths.collection_dir().display()))?;
    let guard_path = paths.collection_dir().join("request.enqueue.lock");
    let mut guard = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(&guard_path)
        .context("open collection request queue lock")?;
    guard
        .try_lock_exclusive()
        .context("another collection request is being enqueued")?;
    writeln!(guard, "{}", std::process::id()).ok();
    let temporary = paths.collection_dir().join("request.json.tmp");
    let result = (|| {
        if paths.collection_request_path().exists()
            || paths.collection_running_request_path().exists()
            || paths.daily_lock_path().exists()
        {
            anyhow::bail!("已有采集任务或待处理请求");
        }
        let request = json!({
            "created_at": Local::now().format("%Y-%m-%dT%H:%M:%S").to_string(),
            "source": "dashboard",
            "modules": modules,
            "date": date,
            "shops": shops,
        });
        fs::write(
            &temporary,
            format!("{}\n", serde_json::to_string_pretty(&request)?),
        )
        .with_context(|| format!("write {}", temporary.display()))?;
        fs::rename(&temporary, paths.collection_request_path())
            .with_context(|| format!("publish {}", paths.collection_request_path().display()))?;
        let mut patch = Map::new();
        patch.insert("state".to_string(), json!("manual_requested"));
        patch.insert(
            "message".to_string(),
            json!("采集请求已进入独立采集服务队列"),
        );
        patch.insert("requested_modules".to_string(), json!(modules));
        patch.insert("requested_date".to_string(), json!(date));
        patch.insert("requested_shops".to_string(), json!(shops));
        patch.insert("last_error".to_string(), json!(""));
        write_task_status(paths, patch)?;
        Ok(())
    })();
    drop(guard);
    if result.is_err() {
        fs::remove_file(&temporary).ok();
    }
    result
}

async fn status_log_tail(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let tail = progress_log_tail(&state.paths)
        .map_err(ApiError::internal)?
        .unwrap_or_default();
    Ok(api(json!({ "terminal_output": tail })))
}

async fn clear_collection_terminal(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    clear_progress_log(&state.paths).map_err(ApiError::internal)?;
    let status =
        status_payload(&state.paths, &state.novnc_url, true).map_err(ApiError::internal)?;
    Ok(api(json!({
        "cleared": true,
        "message": "采集终端数据已清除",
        "status": status,
    })))
}

async fn storage_summary(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let Some(pool) = &state.storage_pool else {
        return Err(ApiError::client(
            StatusCode::SERVICE_UNAVAILABLE,
            "STORAGE_DISABLED",
            "SQLite 读取未启用",
        ));
    };
    let payload = summary(pool)
        .await
        .map_err(ApiError::internal)?
        .as_json(&state.paths);
    Ok(api(payload))
}

async fn diagnostics(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let operations_count = load_operations_records(&state.paths)
        .map_err(ApiError::internal)?
        .len();
    let order_imports = public_imports(&state.paths).map_err(ApiError::internal)?;
    let storage = if let Some(pool) = &state.storage_pool {
        match summary(pool).await {
            Ok(summary) => json!({"ok": true, "summary": summary.as_json(&state.paths)}),
            Err(error) => {
                tracing::error!(%error, "SQLite diagnostics check failed");
                json!({"ok": false, "error": "SQLite 检查失败"})
            }
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
    Ok(api(json!({
        "ok": ok,
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
    if let Some(pool) = &state.storage_pool
        && let Err(error) = luopan_storage::sync_all(&state.paths, pool).await
    {
        tracing::warn!(%error, "SQLite storage sync failed after order write");
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

    fn test_security() -> Arc<SecurityConfig> {
        Arc::new(SecurityConfig {
            production: false,
            session_cookie_secure: false,
            trusted_origins: vec!["http://127.0.0.1:5173".to_string()],
        })
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
            security: test_security(),
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
    async fn initializes_configured_admin_only_when_users_are_absent() {
        let pool = test_pool().await;
        ensure_initial_admin(&pool, Some("strong-password"))
            .await
            .unwrap();
        let user: (String, String) =
            sqlx::query_as("SELECT username, password_hash FROM users WHERE username = 'admin'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(user.0, "admin");
        assert!(verify_password("strong-password", &user.1));

        ensure_initial_admin(&pool, None).await.unwrap();
        let user_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(user_count, 1);
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
    async fn idle_sessions_are_rejected() {
        let pool = test_pool().await;
        sqlx::query(
            "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)",
        )
        .bind("idle-user")
        .bind(hash_password("password").unwrap())
        .bind("viewer")
        .bind(now_string())
        .execute(&pool)
        .await
        .unwrap();
        let token = create_session(&pool, "idle-user").await.unwrap();
        sqlx::query("UPDATE sessions SET last_seen_at = 0 WHERE token_hash = ?")
            .bind(token_hash(&token))
            .execute(&pool)
            .await
            .unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_str(&format!("{SESSION_COOKIE_NAME}={token}")).unwrap(),
        );
        assert!(authenticated_user(&pool, &headers).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn repeated_login_failures_are_rate_limited() {
        let pool = test_pool().await;
        for _ in 0..LOGIN_FAILURE_LIMIT {
            record_failed_login(&pool, "unknown-user").await.unwrap();
        }
        assert!(login_is_rate_limited(&pool, "unknown-user").await.unwrap());
        clear_login_attempts(&pool, "unknown-user").await.unwrap();
        assert!(!login_is_rate_limited(&pool, "unknown-user").await.unwrap());
    }

    #[test]
    fn production_cookie_is_secure() {
        let security = SecurityConfig {
            production: true,
            session_cookie_secure: true,
            trusted_origins: Vec::new(),
        };
        assert!(
            session_cookie("token", &security)
                .to_str()
                .unwrap()
                .contains("; Secure")
        );
    }

    #[tokio::test]
    async fn internal_errors_hide_details_and_include_request_id() {
        let response = ApiError::internal(anyhow::anyhow!("failed to open /private/secret.db"))
            .into_response();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert!(response.headers().contains_key("x-request-id"));
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["error"]["message"], "服务器内部错误");
        assert!(!payload["error"].to_string().contains("secret"));
        assert!(payload["meta"]["request_id"].as_str().is_some());
    }

    #[tokio::test]
    async fn viewer_sessions_cannot_pass_admin_authorization() {
        let pool = test_pool().await;
        sqlx::query(
            "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)",
        )
        .bind("viewer-user")
        .bind(hash_password("viewer-password-123").unwrap())
        .bind("viewer")
        .bind(now_string())
        .execute(&pool)
        .await
        .unwrap();
        let token = create_session(&pool, "viewer-user").await.unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_str(&format!("{SESSION_COOKIE_NAME}={token}")).unwrap(),
        );

        assert!(authorized_user(&pool, &headers, None).await.is_ok());
        let error = authorized_user(&pool, &headers, Some("admin"))
            .await
            .unwrap_err();
        assert_eq!(error.status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn manages_users_and_changes_current_password() {
        let pool = Arc::new(test_pool().await);
        sqlx::query(
            "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)",
        )
        .bind("admin")
        .bind(hash_password("initial-admin-password").unwrap())
        .bind("admin")
        .bind(now_string())
        .execute(&*pool)
        .await
        .unwrap();
        let token = create_session(&pool, "admin").await.unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_str(&format!("{SESSION_COOKIE_NAME}={token}")).unwrap(),
        );
        let root = std::env::temp_dir().join("luopan-account-management-test");
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
            security: test_security(),
        };

        let (status, _) = create_user(
            State(state.clone()),
            Json(CreateUserPayload {
                username: "reader".to_string(),
                password: "reader-password-123".to_string(),
                role: "viewer".to_string(),
            }),
        )
        .await
        .unwrap();
        assert_eq!(status, StatusCode::CREATED);
        let users = list_users(State(state.clone())).await.unwrap().0;
        assert_eq!(users["data"]["users"].as_array().unwrap().len(), 2);

        let _ = change_password(
            State(state.clone()),
            headers.clone(),
            Json(ChangePasswordPayload {
                current_password: "initial-admin-password".to_string(),
                new_password: "updated-admin-password".to_string(),
            }),
        )
        .await
        .unwrap();
        let updated_hash: String =
            sqlx::query_scalar("SELECT password_hash FROM users WHERE username = 'admin'")
                .fetch_one(&*pool)
                .await
                .unwrap();
        assert!(verify_password("updated-admin-password", &updated_hash));

        let _ = remove_user(State(state), headers, AxumPath("reader".to_string()))
            .await
            .unwrap();
        let reader_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE username = 'reader'")
                .fetch_one(&*pool)
                .await
                .unwrap();
        assert_eq!(reader_count, 0);
    }

    #[test]
    fn validates_account_inputs() {
        assert!(validate_password("long-enough-password").is_ok());
        assert!(validate_password("short").is_err());
        assert!(validate_password("admin123").is_err());
        assert_eq!(validate_username(" alice ").unwrap(), "alice");
        assert!(validate_username("").is_err());
        assert!(validate_username("bad\nname").is_err());
        assert_eq!(normalize_role("admin"), "admin");
        assert_eq!(normalize_role("unexpected"), "viewer");
    }

    #[test]
    fn validates_collection_modules() {
        assert_eq!(
            validate_collection_modules(vec!["channel".into(), "channel".into()]).unwrap(),
            ["channel"]
        );
        assert_eq!(
            validate_collection_modules(Vec::new()).unwrap(),
            ["operations", "channel"]
        );
        assert!(validate_collection_modules(vec!["unknown".into()]).is_err());
        let today = NaiveDate::from_ymd_opt(2026, 7, 27).unwrap();
        assert_eq!(
            validate_collection_date_at(Some("2026-07-25".into()), today).unwrap(),
            Some("2026-07-25".into())
        );
        assert!(validate_collection_date_at(Some("2026-06-30".into()), today).is_err());
        assert!(validate_collection_date_at(Some("9999-12-31".into()), today).is_err());
        assert_eq!(
            validate_collection_shops(vec![" 店铺 A ".into(), "店铺 A".into()]).unwrap(),
            ["店铺 A"]
        );
    }

    #[test]
    fn validates_settlement_date_filters() {
        assert_eq!(
            validate_settlement_date_range(Some("2026-07-01".into()), Some("2026-07-31".into()))
                .unwrap(),
            (Some("2026-07-01".into()), Some("2026-07-31".into()))
        );
        assert_eq!(
            validate_settlement_date_range(Some(" ".into()), None).unwrap(),
            (None, None)
        );
        assert!(
            validate_settlement_date_range(Some("2026-08-01".into()), Some("2026-07-31".into()))
                .is_err()
        );
        assert!(validate_settlement_date_range(Some("2026/07/01".into()), None).is_err());
    }

    #[tokio::test]
    async fn scrape_rejects_requests_while_a_job_is_running() {
        let root = std::env::temp_dir().join(format!(
            "luopan-api-scrape-busy-test-{}",
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
        fs::create_dir_all(paths.collection_dir()).unwrap();
        fs::write(paths.daily_lock_path(), "busy").unwrap();
        let state = AppState {
            paths: Arc::new(paths),
            novnc_url: Arc::new("http://127.0.0.1:6080".to_string()),
            auth_pool: Arc::new(test_pool().await),
            storage_pool: None,
            security: test_security(),
        };

        let error = scrape(State(state)).await.unwrap_err();
        assert_eq!(error.status, StatusCode::CONFLICT);
        assert_eq!(error.message, "已有采集任务或待处理请求");
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn collection_request_is_atomically_queued_for_online_service() {
        let root = std::env::temp_dir().join(format!(
            "luopan-api-collection-queue-test-{}",
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
        fs::create_dir_all(paths.collection_dir()).unwrap();
        fs::write(paths.collection_heartbeat_path(), "{}").unwrap();
        let state = AppState {
            paths: Arc::new(paths.clone()),
            novnc_url: Arc::new("http://127.0.0.1:6080".to_string()),
            auth_pool: Arc::new(test_pool().await),
            storage_pool: None,
            security: test_security(),
        };

        let (status, payload) = run_collection(
            State(state),
            Json(CollectionRunPayload {
                modules: vec!["channel".to_string()],
                date: None,
                shops: Vec::new(),
            }),
        )
        .await
        .unwrap();

        assert_eq!(status, StatusCode::ACCEPTED);
        assert_eq!(payload.0["data"]["modules"], json!(["channel"]));
        let request = read_json_file(&paths.collection_request_path())
            .unwrap()
            .unwrap();
        assert_eq!(request["modules"], json!(["channel"]));
        assert!(!paths.collection_dir().join("request.json.tmp").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn historical_collection_request_includes_date_and_shops() {
        let root = std::env::temp_dir().join(format!(
            "luopan-api-collection-backfill-test-{}",
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
        fs::create_dir_all(paths.collection_dir()).unwrap();
        fs::write(paths.collection_heartbeat_path(), "{}").unwrap();
        let state = AppState {
            paths: Arc::new(paths.clone()),
            novnc_url: Arc::new("http://127.0.0.1:6080".to_string()),
            auth_pool: Arc::new(test_pool().await),
            storage_pool: None,
            security: test_security(),
        };

        let (status, payload) = run_collection(
            State(state),
            Json(CollectionRunPayload {
                modules: vec!["operations".to_string()],
                date: Some("2026-07-25".to_string()),
                shops: vec!["店铺 A".to_string()],
            }),
        )
        .await
        .unwrap();

        assert_eq!(status, StatusCode::ACCEPTED);
        assert_eq!(payload.0["data"]["date"], json!("2026-07-25"));
        let request = read_json_file(&paths.collection_request_path())
            .unwrap()
            .unwrap();
        assert_eq!(request["date"], json!("2026-07-25"));
        assert_eq!(request["shops"], json!(["店铺 A"]));
        let _ = fs::remove_dir_all(root);
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
