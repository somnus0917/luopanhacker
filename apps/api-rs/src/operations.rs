use axum::{Json, extract::State};
use luopan_channels::{load_channel_dashboard, load_douyin_dashboard};
use luopan_operations::{apply_shop_aliases, load_operations_records, load_shop_aliases};
use luopan_runtime::RuntimePaths;
use luopan_storage::{kv_value_with_updated_at, load_operations_records_from_db};
use serde_json::{Value, json};

use crate::{
    ApiError, AppState, api_with_meta, latest_json_modified_at, now_string, payload_updated_at,
};

pub(crate) struct LoadedPayload {
    value: Value,
    source: &'static str,
    fallback: bool,
    updated_at: String,
}

fn operations_updated_at(
    records: &[luopan_operations::OperationRecord],
    paths: &RuntimePaths,
) -> String {
    records
        .iter()
        .map(|record| record.captured_at.as_str())
        .max()
        .map(ToOwned::to_owned)
        .or_else(|| latest_json_modified_at(&paths.output_dir.join("daily")))
        .or_else(|| latest_json_modified_at(&paths.output_dir.join("external_orders")))
        .unwrap_or_else(now_string)
}

pub(crate) async fn load_channel_payload(state: &AppState) -> Result<LoadedPayload, ApiError> {
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
    let value = load_channel_dashboard(&state.paths).map_err(ApiError::internal)?;
    let updated_at = payload_updated_at(&value, &state.paths.output_dir.join("channel"));
    Ok(LoadedPayload {
        value,
        source: "json",
        fallback: state.storage_pool.is_some(),
        updated_at,
    })
}

pub(crate) async fn channel_dashboard(
    State(state): State<AppState>,
) -> Result<Json<Value>, ApiError> {
    let payload = load_channel_payload(&state).await?;
    Ok(api_with_meta(
        payload.value,
        payload.source,
        payload.fallback,
        payload.updated_at,
    ))
}

pub(crate) async fn douyin_dashboard(
    State(state): State<AppState>,
) -> Result<Json<Value>, ApiError> {
    let payload = load_douyin_payload(&state).await?;
    Ok(api_with_meta(
        payload.value,
        payload.source,
        payload.fallback,
        payload.updated_at,
    ))
}

async fn load_douyin_payload(state: &AppState) -> Result<LoadedPayload, ApiError> {
    if let Some(pool) = &state.storage_pool {
        match kv_value_with_updated_at(pool, "douyin_dashboard").await {
            Ok(Some(payload)) => {
                return Ok(LoadedPayload {
                    value: payload.value,
                    source: "sqlite",
                    fallback: false,
                    updated_at: payload.updated_at,
                });
            }
            Ok(None) => tracing::warn!("SQLite Douyin payload is missing; falling back to JSON"),
            Err(error) => tracing::warn!(%error, "SQLite Douyin read failed; falling back to JSON"),
        }
    }
    let value = load_douyin_dashboard(&state.paths).map_err(ApiError::internal)?;
    let updated_at = payload_updated_at(&value, &state.paths.output_dir.join("douyin"));
    Ok(LoadedPayload {
        value,
        source: "json",
        fallback: state.storage_pool.is_some(),
        updated_at,
    })
}

pub(crate) async fn compass_dashboard(
    State(state): State<AppState>,
) -> Result<Json<Value>, ApiError> {
    let (records, records_source, records_fallback) = if let Some(pool) = &state.storage_pool {
        match load_operations_records_from_db(pool).await {
            Ok(mut records) if !records.is_empty() => {
                let aliases = load_shop_aliases(&state.paths).map_err(ApiError::internal)?;
                apply_shop_aliases(&mut records, &aliases);
                (records, "sqlite", false)
            }
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
    let records_updated_at = operations_updated_at(&records, &state.paths);
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
        if source == "mixed" {
            json!({ "operations": records_updated_at, "channel": channel.updated_at })
        } else {
            json!(records_updated_at.max(channel.updated_at))
        },
    ))
}
