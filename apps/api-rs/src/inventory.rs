use axum::{Json, extract::State, http::StatusCode};
use luopan_inventory::load_inventory_dashboard;
use luopan_runtime::read_json_file;
use luopan_storage::kv_value_with_updated_at;
use serde_json::Value;

use crate::{ApiError, AppState, api_with_meta, now_string, payload_updated_at};

pub(crate) async fn inventory_dashboard(
    State(state): State<AppState>,
) -> Result<Json<Value>, ApiError> {
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
        Some(value) => {
            let updated_at = payload_updated_at(&value, &state.paths.inventory_snapshot_path());
            Ok(api_with_meta(
                value,
                "json",
                state.storage_pool.is_some(),
                updated_at,
            ))
        }
        None => Err(ApiError::client(
            StatusCode::NOT_FOUND,
            "INVENTORY_NOT_FOUND",
            "暂无库存快照",
        )),
    }
}

pub(crate) async fn inventory_raw(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
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
