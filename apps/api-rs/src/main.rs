use std::{env, net::SocketAddr, sync::Arc};

use anyhow::Result;
use axum::{
    Json, Router,
    extract::{Path as AxumPath, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use luopan_inventory::load_inventory_dashboard;
use luopan_jobs::{progress_log_tail, status_payload};
use luopan_operations::load_operations_records;
use luopan_orders::{commit_preview, delete_batch, public_imports};
use luopan_runtime::{RuntimePaths, read_json_file};
use luopan_settlement::load_settlement_dashboard;
use luopan_storage::{
    StoragePool, kv_value, load_operations_records_from_db, public_imports_from_db, summary,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[derive(Clone)]
struct AppState {
    paths: Arc<RuntimePaths>,
    novnc_url: Arc<String>,
    storage_pool: Option<Arc<StoragePool>>,
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
    let storage_pool = if env_bool("LUOPAN_API_RS_STORAGE_READS", false) {
        match luopan_storage::connect(&paths).await {
            Ok(pool) => {
                if let Err(error) = luopan_storage::migrate(&pool).await {
                    tracing::warn!(%error, "disabling SQLite-backed reads after migration failure");
                    None
                } else {
                    Some(Arc::new(pool))
                }
            }
            Err(error) => {
                tracing::warn!(%error, "disabling SQLite-backed reads after connection failure");
                None
            }
        }
    } else {
        None
    };
    let state = AppState {
        paths,
        novnc_url,
        storage_pool,
    };
    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/api/runtime/paths", get(runtime_paths))
        .route("/api/compass", get(compass_dashboard))
        .route("/api/inventory", get(inventory_dashboard))
        .route("/api/inventory/raw", get(inventory_raw))
        .route("/api/settlement", get(settlement_dashboard))
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

async fn settlement_dashboard(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        load_settlement_dashboard(&state.paths).map_err(ApiError::internal)?,
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
