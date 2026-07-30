use axum::{
    Json,
    extract::{Multipart, Path as AxumPath, State},
    http::StatusCode,
};
use luopan_orders::{
    UploadedWorkbook, commit_preview, delete_batch, preview_upload, public_imports,
};
use luopan_storage::public_imports_from_db;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{ApiError, AppState, api, api_with_meta, now_string, sync_storage_best_effort};

#[derive(Debug, Deserialize)]
pub(crate) struct CommitOrderImportPayload {
    pub(crate) preview_token: String,
}

pub(crate) async fn order_imports(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
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

pub(crate) async fn preview_order_import(
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

pub(crate) async fn commit_order_import(
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

pub(crate) async fn remove_order_import(
    State(state): State<AppState>,
    AxumPath(batch_id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let deleted = delete_batch(&state.paths, &batch_id).map_err(ApiError::bad_request)?;
    sync_storage_best_effort(&state).await;
    Ok(api(json!({ "deleted": deleted })))
}
