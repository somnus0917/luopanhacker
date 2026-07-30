use std::{env, sync::Arc};

use luopan_runtime::RuntimePaths;
use luopan_storage::StoragePool;

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) paths: Arc<RuntimePaths>,
    pub(crate) novnc_url: Arc<String>,
    pub(crate) auth_pool: Arc<StoragePool>,
    pub(crate) storage_pool: Option<Arc<StoragePool>>,
    pub(crate) security: Arc<SecurityConfig>,
}

#[derive(Debug)]
pub(crate) struct SecurityConfig {
    pub(crate) production: bool,
    pub(crate) session_cookie_secure: bool,
    pub(crate) trusted_origins: Vec<String>,
}

impl SecurityConfig {
    pub(crate) fn from_env() -> Self {
        let production = !matches!(
            env::var("LUOPAN_ENV").ok().as_deref(),
            Some("development" | "dev" | "test")
        );
        let configured_secure = env_bool("SESSION_COOKIE_SECURE", production);
        if production && !configured_secure {
            tracing::warn!("SESSION_COOKIE_SECURE=false is ignored in production");
        }
        Self {
            production,
            session_cookie_secure: production || configured_secure,
            trusted_origins: env::var("LUOPAN_TRUSTED_ORIGINS")
                .unwrap_or_default()
                .split(',')
                .map(str::trim)
                .filter(|origin| !origin.is_empty())
                .map(ToOwned::to_owned)
                .chain((!production).then(|| "http://127.0.0.1:5173".to_string()))
                .collect(),
        }
    }
}

fn env_bool(key: &str, default: bool) -> bool {
    env::var(key)
        .ok()
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(default)
}
