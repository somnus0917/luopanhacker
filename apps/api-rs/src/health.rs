use axum::{Json, extract::State, http::StatusCode};
use serde::Serialize;
use serde_json::{Value, json};

use crate::{ApiError, AppState, api};

#[derive(Serialize)]
struct HealthPayload {
    service: &'static str,
    ok: bool,
}

pub(crate) async fn healthz() -> Json<Value> {
    api(HealthPayload {
        service: "luopan-api-rs",
        ok: true,
    })
}

pub(crate) async fn readyz(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
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
