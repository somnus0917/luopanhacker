use std::{fs, path::Path};

use anyhow::{Context, Result, bail};
use chrono::Local;
use luopan_runtime::{RuntimePaths, read_json_file, read_text_tail};
use serde_json::{Map, Value, json};

pub const STATUS_LOG_MAX_BYTES: u64 = 24 * 1024;
pub const STATUS_LOG_MAX_LINES: usize = 160;

pub fn read_task_status(paths: &RuntimePaths) -> Result<Map<String, Value>> {
    let Some(value) = read_json_file(&paths.task_status_path())? else {
        return Ok(Map::new());
    };
    Ok(value.as_object().cloned().unwrap_or_default())
}

pub fn write_task_status(
    paths: &RuntimePaths,
    patch: Map<String, Value>,
) -> Result<Map<String, Value>> {
    fs::create_dir_all(&paths.output_dir)
        .with_context(|| format!("create {}", paths.output_dir.display()))?;

    let mut current = read_task_status(paths)?;
    for (key, value) in patch {
        current.insert(key, value);
    }
    current.insert(
        "updated_at".to_string(),
        Value::String(Local::now().format("%Y-%m-%dT%H:%M:%S").to_string()),
    );

    write_status_file(&paths.task_status_path(), &Value::Object(current.clone()))?;
    Ok(current)
}

pub fn status_payload(
    paths: &RuntimePaths,
    novnc_url: &str,
    include_terminal_output: bool,
) -> Result<Value> {
    let mut payload = read_task_status(paths)?;
    payload.insert(
        "job_running".to_string(),
        Value::Bool(paths.daily_lock_path().exists()),
    );
    payload.insert(
        "novnc_url".to_string(),
        Value::String(novnc_url.to_string()),
    );
    if include_terminal_output {
        payload.insert(
            "terminal_output".to_string(),
            Value::String(progress_log_tail(paths)?.unwrap_or_default()),
        );
    }
    Ok(Value::Object(payload))
}

pub fn progress_log_tail(paths: &RuntimePaths) -> Result<Option<String>> {
    let Some(text) = read_text_tail(&paths.progress_log_path(), STATUS_LOG_MAX_BYTES)? else {
        return Ok(None);
    };
    let lines: Vec<&str> = text.lines().collect();
    let tail_start = lines.len().saturating_sub(STATUS_LOG_MAX_LINES);
    Ok(Some(lines[tail_start..].join("\n")))
}

fn write_status_file(path: &Path, value: &Value) -> Result<()> {
    let text = serde_json::to_string_pretty(value)?;
    let temporary_path = path.with_extension("json.tmp");
    fs::write(&temporary_path, format!("{text}\n"))
        .with_context(|| format!("write {}", temporary_path.display()))?;
    fs::rename(&temporary_path, path)
        .with_context(|| format!("rename {} to {}", temporary_path.display(), path.display()))?;
    Ok(())
}

pub fn try_status_patch(
    state: Option<String>,
    message: Option<String>,
    last_error: Option<String>,
    fields: Vec<String>,
) -> Result<Map<String, Value>> {
    let mut patch = Map::new();
    if let Some(state) = state {
        patch.insert("state".to_string(), json!(state));
    }
    if let Some(message) = message {
        patch.insert("message".to_string(), json!(message));
    }
    if let Some(last_error) = last_error {
        patch.insert("last_error".to_string(), json!(last_error));
    }
    for field in fields {
        let (key, raw_value) = parse_field_assignment(&field)?;
        patch.insert(key.to_string(), parse_field_value(raw_value));
    }
    Ok(patch)
}

fn parse_field_assignment(field: &str) -> Result<(&str, &str)> {
    let Some((key, value)) = field.split_once('=') else {
        bail!("expected key=value");
    };
    if key.trim().is_empty() {
        bail!("field key cannot be empty");
    }
    Ok((key, value))
}

fn parse_field_value(raw_value: &str) -> Value {
    serde_json::from_str(raw_value).unwrap_or_else(|_| Value::String(raw_value.to_string()))
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::*;

    fn temp_paths() -> RuntimePaths {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("luopan-jobs-test-{nonce}"));
        RuntimePaths {
            app_dir: root.clone(),
            output_dir: root.join("output"),
            state_dir: root.join("state"),
            config_dir: root.join("config"),
            logs_dir: root.join("logs"),
            session_dir: root.join("session"),
        }
    }

    fn cleanup(paths: &RuntimePaths) {
        let _ = fs::remove_dir_all(root_dir(paths));
    }

    fn root_dir(paths: &RuntimePaths) -> PathBuf {
        paths.app_dir.clone()
    }

    #[test]
    fn writes_status_with_timestamp_and_preserves_existing_fields() {
        let paths = temp_paths();
        let mut first = Map::new();
        first.insert("state".to_string(), json!("running"));
        first.insert("message".to_string(), json!("start"));
        write_task_status(&paths, first).unwrap();

        let mut second = Map::new();
        second.insert("message".to_string(), json!("done"));
        let status = write_task_status(&paths, second).unwrap();

        assert_eq!(status.get("state"), Some(&json!("running")));
        assert_eq!(status.get("message"), Some(&json!("done")));
        assert!(status.get("updated_at").and_then(Value::as_str).is_some());
        cleanup(&paths);
    }

    #[test]
    fn status_payload_adds_runtime_fields() {
        let paths = temp_paths();
        fs::create_dir_all(&paths.output_dir).unwrap();
        fs::write(paths.progress_log_path(), "line1\nline2\n").unwrap();

        let payload = status_payload(&paths, "http://127.0.0.1:6080", true).unwrap();
        assert_eq!(payload["job_running"], json!(false));
        assert_eq!(payload["novnc_url"], json!("http://127.0.0.1:6080"));
        assert_eq!(payload["terminal_output"], json!("line1\nline2"));
        cleanup(&paths);
    }
}
