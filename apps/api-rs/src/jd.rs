use crate::{ApiError, AppState, api, sync_storage_best_effort};
use axum::{
    Json,
    extract::{Multipart, State},
    http::StatusCode,
};
use luopan_jd::{UploadedWorkbook, commit_preview, preview_upload};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
pub(crate) struct CommitPayload {
    pub(crate) preview_token: String,
}
pub(crate) async fn preview_jd_import(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<Value>, ApiError> {
    let mut files = Vec::new();
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|_| ApiError::bad_request(anyhow::anyhow!("读取上传文件失败")))?
    {
        if field.name() != Some("files") {
            continue;
        };
        files.push(UploadedWorkbook {
            filename: field.file_name().unwrap_or_default().to_string(),
            content: field
                .bytes()
                .await
                .map_err(|_| ApiError::bad_request(anyhow::anyhow!("读取上传文件失败")))?
                .to_vec(),
        });
    }
    Ok(api(
        preview_upload(&state.paths, files).map_err(ApiError::bad_request)?
    ))
}
pub(crate) async fn commit_jd_import(
    State(state): State<AppState>,
    Json(payload): Json<CommitPayload>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    if payload.preview_token.trim().is_empty() {
        return Err(ApiError::bad_request(anyhow::anyhow!("缺少预览凭据")));
    };
    let result =
        commit_preview(&state.paths, &payload.preview_token).map_err(ApiError::bad_request)?;
    sync_storage_best_effort(&state).await;
    Ok((StatusCode::CREATED, api(result)))
}
