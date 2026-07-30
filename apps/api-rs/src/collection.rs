use std::{fs, io::Write};

use anyhow::{Context, Result};
use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use chrono::{Datelike, Local, NaiveDate};
use fs2::FileExt;
use luopan_jobs::{clear_progress_log, progress_log_tail, status_payload, write_task_status};
use luopan_runtime::{RuntimePaths, read_json_file};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::{ApiError, AppState, StatusQuery, api, api_with_meta, now_string};

#[derive(Debug, Deserialize, Default)]
pub(crate) struct CollectionRunPayload {
    #[serde(default)]
    pub(crate) modules: Vec<String>,
    pub(crate) date: Option<String>,
    #[serde(default)]
    pub(crate) shops: Vec<String>,
}

pub(crate) async fn status_raw(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let path = state.paths.task_status_path();
    match read_json_file(&path).map_err(ApiError::internal)? {
        Some(value) => Ok(api_with_meta(value, "json", false, now_string())),
        None => Ok(api(
            json!({ "state": "unknown", "message": "no task status file" }),
        )),
    }
}

pub(crate) async fn status(
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

pub(crate) async fn collection_shops(
    State(state): State<AppState>,
) -> Result<Json<Value>, ApiError> {
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

pub(crate) async fn scrape(
    State(state): State<AppState>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    enqueue_collection(
        &state,
        vec!["operations".to_string(), "channel".to_string()],
        None,
        Vec::new(),
    )
    .await
}

pub(crate) async fn run_collection(
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

pub(crate) fn validate_collection_modules(modules: Vec<String>) -> Result<Vec<String>> {
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

pub(crate) fn validate_collection_date_at(
    date: Option<String>,
    today: NaiveDate,
) -> Result<Option<String>> {
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

pub(crate) fn validate_collection_shops(shops: Vec<String>) -> Result<Vec<String>> {
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

pub(crate) async fn status_log_tail(
    State(state): State<AppState>,
) -> Result<Json<Value>, ApiError> {
    let tail = progress_log_tail(&state.paths)
        .map_err(ApiError::internal)?
        .unwrap_or_default();
    Ok(api(json!({ "terminal_output": tail })))
}

pub(crate) async fn clear_collection_terminal(
    State(state): State<AppState>,
) -> Result<Json<Value>, ApiError> {
    clear_progress_log(&state.paths).map_err(ApiError::internal)?;
    let status =
        status_payload(&state.paths, &state.novnc_url, true).map_err(ApiError::internal)?;
    Ok(api(json!({
        "cleared": true,
        "message": "采集终端数据已清除",
        "status": status,
    })))
}
