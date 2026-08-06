use axum::{
    Json,
    extract::{Multipart, State},
    http::StatusCode,
};
use luopan_inventory::{
    load_business_outbound_dashboard, load_inventory_dashboard, save_business_outbound_upload,
};
use luopan_runtime::read_json_file;
use luopan_storage::kv_value_with_updated_at;
use serde_json::{Value, json};

use crate::{ApiError, AppState, api_with_meta, payload_updated_at};

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
        Some(value) => {
            let updated_at = payload_updated_at(&value, &path);
            Ok(api_with_meta(value, "json", false, updated_at))
        }
        None => Err(ApiError::client(
            StatusCode::NOT_FOUND,
            "INVENTORY_NOT_FOUND",
            "暂无库存快照",
        )),
    }
}

pub(crate) async fn business_outbound_dashboard(
    State(state): State<AppState>,
) -> Result<Json<Value>, ApiError> {
    Ok(crate::api(
        load_business_outbound_dashboard(&state.paths).map_err(ApiError::internal)?,
    ))
}

pub(crate) async fn upload_business_outbound(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let mut file_name = String::new();
    let mut content = Vec::new();
    while let Some(field) = multipart.next_field().await.map_err(|_| {
        ApiError::client(
            StatusCode::BAD_REQUEST,
            "INVALID_UPLOAD",
            "读取上传文件失败",
        )
    })? {
        if field.name() != Some("file") {
            continue;
        }
        file_name = field.file_name().unwrap_or_default().to_string();
        content = field
            .bytes()
            .await
            .map_err(|_| {
                ApiError::client(
                    StatusCode::BAD_REQUEST,
                    "INVALID_UPLOAD",
                    "读取上传文件失败",
                )
            })?
            .to_vec();
        break;
    }
    if file_name.is_empty() || content.is_empty() {
        return Err(ApiError::client(
            StatusCode::BAD_REQUEST,
            "MISSING_UPLOAD",
            "请选择商智出库 Excel 文件",
        ));
    }
    let dashboard = save_business_outbound_upload(&state.paths, &file_name, &content)
        .map_err(ApiError::bad_request)?;
    Ok((
        StatusCode::CREATED,
        crate::api(json!({ "dashboard": dashboard })),
    ))
}
