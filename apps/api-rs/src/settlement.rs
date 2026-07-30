use anyhow::{Context, Result};
use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use chrono::NaiveDate;
use luopan_settlement::{
    load_settlement_dashboard_filtered, load_settlement_dashboard_for_shop, save_settlement_upload,
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{ApiError, AppState, api};

#[derive(Debug, Deserialize)]
pub(crate) struct SettlementQuery {
    shop: Option<String>,
    start_date: Option<String>,
    end_date: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct SettlementUploadPayload {
    shop_name: String,
    file_name: String,
    content: String,
}

pub(crate) async fn settlement_dashboard(
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

pub(crate) fn validate_settlement_date_range(
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

pub(crate) async fn upload_settlement(
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
