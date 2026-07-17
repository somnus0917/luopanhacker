use std::{
    env, fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimePaths {
    pub app_dir: PathBuf,
    pub output_dir: PathBuf,
    pub state_dir: PathBuf,
    pub config_dir: PathBuf,
    pub logs_dir: PathBuf,
    pub session_dir: PathBuf,
}

impl RuntimePaths {
    pub fn from_env() -> Result<Self> {
        let app_dir = env::var_os("LUOPAN_APP_DIR")
            .map(PathBuf::from)
            .unwrap_or(env::current_dir().context("read current working directory")?);
        let data_dir = env::var_os("LUOPAN_DATA_DIR").map(PathBuf::from);

        Ok(Self {
            output_dir: env_or_data_path(
                "LUOPAN_OUTPUT_DIR",
                data_dir.as_deref(),
                &app_dir,
                "output",
            ),
            state_dir: env_or_data_path("LUOPAN_STATE_DIR", data_dir.as_deref(), &app_dir, "state"),
            config_dir: env_or_data_path(
                "LUOPAN_CONFIG_DIR",
                data_dir.as_deref(),
                &app_dir,
                "config",
            ),
            logs_dir: env_or_data_path("LUOPAN_LOGS_DIR", data_dir.as_deref(), &app_dir, "logs"),
            session_dir: env_or_data_path(
                "LUOPAN_SESSION_DIR",
                data_dir.as_deref(),
                &app_dir,
                "session",
            ),
            app_dir,
        })
    }

    pub fn inventory_snapshot_path(&self) -> PathBuf {
        self.output_dir
            .join("inventory")
            .join("inventory_snapshot.json")
    }

    pub fn task_status_path(&self) -> PathBuf {
        self.output_dir.join("task_status.json")
    }

    pub fn daily_lock_path(&self) -> PathBuf {
        self.output_dir.join("daily_job.lock")
    }

    pub fn progress_log_path(&self) -> PathBuf {
        self.output_dir.join("progress.log")
    }

    pub fn storage_db_path(&self) -> PathBuf {
        env::var_os("LUOPAN_STORAGE_DB")
            .map(PathBuf::from)
            .unwrap_or_else(|| self.state_dir.join("luopan.db"))
    }
}

fn env_or_data_path(name: &str, data_dir: Option<&Path>, app_dir: &Path, child: &str) -> PathBuf {
    env::var_os(name)
        .map(PathBuf::from)
        .unwrap_or_else(|| data_dir.unwrap_or(app_dir).join(child))
}

pub fn read_json_file(path: &Path) -> Result<Option<Value>> {
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    let value = serde_json::from_str(&text).with_context(|| format!("parse {}", path.display()))?;
    Ok(Some(value))
}

pub fn read_text_tail(path: &Path, max_bytes: u64) -> Result<Option<String>> {
    if !path.exists() {
        return Ok(None);
    }

    let metadata = fs::metadata(path).with_context(|| format!("stat {}", path.display()))?;
    let start = metadata.len().saturating_sub(max_bytes);
    let mut file = fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    use std::io::{Read, Seek, SeekFrom};
    file.seek(SeekFrom::Start(start))
        .with_context(|| format!("seek {}", path.display()))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .with_context(|| format!("read {}", path.display()))?;

    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    if start > 0 {
        if let Some((_, rest)) = text.split_once('\n') {
            text = format!("... truncated earlier output ...\n{rest}");
        }
    }
    Ok(Some(text))
}
