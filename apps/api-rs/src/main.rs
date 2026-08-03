use std::{
    env, fs,
    net::SocketAddr,
    path::Path,
    sync::Arc,
    time::{Instant, SystemTime},
};

use anyhow::Result;
#[cfg(test)]
use axum::extract::Path as AxumPath;
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Request, State},
    http::{HeaderValue, Method, StatusCode, header},
    middleware::{Next, from_fn, from_fn_with_state},
    response::Response,
    routing::{delete, get, get_service, post},
};
#[cfg(test)]
use chrono::NaiveDate;
use luopan_jobs::status_payload;
use luopan_operations::load_operations_records;
use luopan_orders::public_imports;
use luopan_runtime::RuntimePaths;
#[cfg(test)]
use luopan_runtime::read_json_file;
use luopan_storage::summary;
use serde::Deserialize;
use serde_json::{Value, json};
#[cfg(test)]
use sha2::{Digest, Sha256};
use tower_http::{
    cors::CorsLayer,
    services::{ServeDir, ServeFile},
    set_header::SetResponseHeaderLayer,
    trace::TraceLayer,
};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[cfg(test)]
use axum::http::HeaderMap;
#[cfg(test)]
use axum::response::IntoResponse;
#[cfg(test)]
use luopan_storage::StoragePool;
#[cfg(test)]
use sqlx::Row;

mod accounts;
mod auth;
mod collection;
mod error;
mod health;
mod inventory;
mod jd;
mod operations;
mod orders;
mod settlement;
mod state;

#[cfg(test)]
use accounts::{
    ChangePasswordPayload, CreateUserPayload, change_password, create_user, list_users, remove_user,
};
#[cfg(not(test))]
use accounts::{change_password, create_user, list_users, remove_user};
use auth::*;
#[cfg(test)]
use collection::{
    CollectionRunPayload, validate_collection_date_at, validate_collection_modules,
    validate_collection_shops,
};
use collection::{
    clear_collection_terminal, collection_shops, run_collection, scrape, status, status_log_tail,
    status_raw,
};
use error::{ApiError, api, api_with_meta, generate_request_id};
use health::{healthz, readyz};
use inventory::{inventory_dashboard, inventory_raw};
use jd::{commit_jd_import, jd_dashboard, preview_jd_import};
use operations::{channel_dashboard, compass_dashboard};
use orders::{commit_order_import, order_imports, preview_order_import, remove_order_import};
#[cfg(test)]
use settlement::validate_settlement_date_range;
use settlement::{settlement_dashboard, upload_settlement};
use state::{AppState, SecurityConfig};

const ADMIN_UPLOAD_LIMIT_BYTES: usize = 32 * 1024 * 1024;

tokio::task_local! {
    static REQUEST_ID: String;
}

fn current_request_id() -> String {
    REQUEST_ID
        .try_with(Clone::clone)
        .unwrap_or_else(|_| generate_request_id())
}

#[derive(Debug, Deserialize)]
pub(crate) struct StatusQuery {
    #[serde(default = "default_terminal_output")]
    pub(crate) terminal_output: bool,
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
        .route("/api/jd", get(jd_dashboard))
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
        .route("/api/jd/imports/preview", post(preview_jd_import))
        .route("/api/jd/imports", post(commit_jd_import))
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
        .layer(from_fn_with_state(state.clone(), csrf_protection))
        .layer(from_fn(request_logging))
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

async fn request_logging(request: Request, next: Next) -> Response {
    let request_id = request
        .headers()
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .filter(|value| is_valid_request_id(value))
        .map(ToOwned::to_owned)
        .unwrap_or_else(generate_request_id);
    let route = request.uri().path().to_string();
    let method = request.method().clone();
    let started = Instant::now();
    let mut response = REQUEST_ID
        .scope(request_id.clone(), next.run(request))
        .await;
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

fn is_valid_request_id(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

pub(crate) fn now_string() -> String {
    chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string()
}

fn format_system_time(time: SystemTime) -> String {
    chrono::DateTime::<chrono::Local>::from(time)
        .format("%Y-%m-%dT%H:%M:%S")
        .to_string()
}

pub(crate) fn latest_json_modified_at(path: &Path) -> Option<String> {
    let metadata = fs::metadata(path).ok();
    if metadata.as_ref().is_some_and(|metadata| metadata.is_file()) {
        return path
            .extension()
            .is_some_and(|extension| extension == "json")
            .then(|| metadata?.modified().ok().map(format_system_time))
            .flatten();
    }
    fs::read_dir(path)
        .ok()?
        .flatten()
        .filter_map(|entry| latest_json_modified_at(&entry.path()))
        .max()
}

pub(crate) fn payload_updated_at(value: &Value, fallback_path: &Path) -> String {
    let record_timestamp = value
        .get("records")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|record| record.get("captured_at").and_then(Value::as_str))
        .max()
        .map(ToOwned::to_owned);
    record_timestamp
        .or_else(|| {
            ["captured_at", "updated_at", "generated_at"]
                .into_iter()
                .filter_map(|key| value.get(key).and_then(Value::as_str))
                .next()
                .map(ToOwned::to_owned)
        })
        .or_else(|| latest_json_modified_at(fallback_path))
        .unwrap_or_else(now_string)
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

pub(crate) async fn sync_storage_best_effort(state: &AppState) {
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
mod tests;
