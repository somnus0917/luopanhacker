use std::fs;

use anyhow::{Context, Result};
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use luopan_runtime::RuntimePaths;
use luopan_storage::StoragePool;
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::Row;
use subtle::ConstantTimeEq;

use crate::{ApiError, AppState, SecurityConfig, api, now_string};

pub(crate) const SESSION_COOKIE_NAME: &str = "compass_session";
pub(crate) const SESSION_LIFETIME_SECONDS: i64 = 24 * 60 * 60;
pub(crate) const SESSION_IDLE_TIMEOUT_SECONDS: i64 = 30 * 60;
pub(crate) const SESSION_LAST_SEEN_WRITE_INTERVAL_SECONDS: i64 = 5 * 60;
pub(crate) const LOGIN_FAILURE_LIMIT: i64 = 5;
pub(crate) const LOGIN_FAILURE_WINDOW_SECONDS: i64 = 15 * 60;
pub(crate) const LOGIN_LOCKOUT_SECONDS: i64 = 15 * 60;

#[derive(Debug, Deserialize)]
pub(crate) struct LoginPayload {
    pub(crate) username: String,
    pub(crate) password: String,
}

#[derive(Debug, Deserialize)]
struct LegacyUser {
    password_hash: String,
    #[serde(default = "default_role")]
    role: String,
    #[serde(default)]
    created_at: Option<String>,
}

#[derive(Debug, Serialize)]
struct LoginResponse {
    username: String,
    role: String,
}

#[derive(Debug, Serialize)]
struct MeResponse {
    authenticated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    role: Option<String>,
}

fn default_role() -> String {
    "viewer".to_string()
}

pub(crate) async fn login(
    State(state): State<AppState>,
    Json(payload): Json<LoginPayload>,
) -> Result<Response, ApiError> {
    let username = payload.username.trim();
    if validate_username(username).is_err() {
        return Err(invalid_credentials());
    }
    if login_is_rate_limited(&state.auth_pool, username)
        .await
        .map_err(ApiError::internal)?
    {
        return Err(ApiError::client(
            StatusCode::TOO_MANY_REQUESTS,
            "LOGIN_RATE_LIMITED",
            "登录失败次数过多，请 15 分钟后再试",
        ));
    }
    let user = sqlx::query("SELECT password_hash, role FROM users WHERE username = ?")
        .bind(username)
        .fetch_optional(&*state.auth_pool)
        .await
        .map_err(|error| ApiError::internal(error.into()))?;
    let Some(user) = user else {
        record_failed_login(&state.auth_pool, username)
            .await
            .map_err(ApiError::internal)?;
        return Err(invalid_credentials());
    };
    let password_hash: String = user.get("password_hash");
    if !verify_password(&payload.password, &password_hash) {
        record_failed_login(&state.auth_pool, username)
            .await
            .map_err(ApiError::internal)?;
        return Err(invalid_credentials());
    }
    clear_login_attempts(&state.auth_pool, username)
        .await
        .map_err(ApiError::internal)?;
    if is_legacy_password_hash(&password_hash) {
        let upgraded = hash_password(&payload.password).map_err(ApiError::internal)?;
        sqlx::query(
            "UPDATE users SET password_hash = ?, password_changed_at = ? WHERE username = ?",
        )
        .bind(upgraded)
        .bind(now_string())
        .bind(username)
        .execute(&*state.auth_pool)
        .await
        .map_err(|error| ApiError::internal(error.into()))?;
    }

    let token = create_session(&state.auth_pool, username)
        .await
        .map_err(ApiError::internal)?;
    let role: String = user.get("role");
    let mut response = api(LoginResponse {
        username: username.to_string(),
        role,
    })
    .into_response();
    response
        .headers_mut()
        .insert(header::SET_COOKIE, session_cookie(&token, &state.security));
    Ok(response)
}

pub(crate) async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Some(token) = session_token(&headers)
        && let Err(error) = sqlx::query("DELETE FROM sessions WHERE token_hash = ?")
            .bind(token_hash(&token))
            .execute(&*state.auth_pool)
            .await
    {
        tracing::warn!(%error, "could not remove session during logout");
    }
    let mut response = (StatusCode::OK, api(json!({ "logged_out": true }))).into_response();
    response
        .headers_mut()
        .insert(header::SET_COOKIE, expired_session_cookie(&state.security));
    response
}

pub(crate) async fn me(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    match authenticated_user(&state.auth_pool, &headers)
        .await
        .map_err(ApiError::internal)?
    {
        Some((username, role)) => Ok(api(MeResponse {
            authenticated: true,
            username: Some(username),
            role: Some(role),
        })),
        None => Ok(api(MeResponse {
            authenticated: false,
            username: None,
            role: None,
        })),
    }
}

pub(crate) async fn require_auth(
    State(state): State<AppState>,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    match authorized_user(&state.auth_pool, request.headers(), None).await {
        Ok(_) => next.run(request).await,
        Err(error) => error.into_response(),
    }
}

pub(crate) async fn require_admin(
    State(state): State<AppState>,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    match authorized_user(&state.auth_pool, request.headers(), Some("admin")).await {
        Ok(_) => next.run(request).await,
        Err(error) => error.into_response(),
    }
}

pub(crate) async fn csrf_protection(
    State(state): State<AppState>,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    if matches!(
        request.method(),
        &Method::GET | &Method::HEAD | &Method::OPTIONS
    ) {
        return next.run(request).await;
    }
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok());
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok());
    let is_same_origin = origin.is_some_and(|origin| {
        state
            .security
            .trusted_origins
            .iter()
            .any(|allowed| allowed == origin)
            || host.is_some_and(|host| {
                origin == format!("https://{host}") || origin == format!("http://{host}")
            })
    });
    if !is_same_origin {
        return ApiError::client(StatusCode::FORBIDDEN, "CSRF_REJECTED", "请求来源校验失败")
            .into_response();
    }
    next.run(request).await
}

pub(crate) async fn authorized_user(
    pool: &StoragePool,
    headers: &HeaderMap,
    required_role: Option<&str>,
) -> Result<(String, String), ApiError> {
    let user = authenticated_user(pool, headers)
        .await
        .map_err(|error| {
            tracing::error!(%error, "session validation failed");
            ApiError::internal(error)
        })?
        .ok_or_else(|| ApiError::client(StatusCode::UNAUTHORIZED, "UNAUTHENTICATED", "请先登录"))?;
    if required_role.is_some_and(|role| user.1 != role) {
        return Err(ApiError::client(
            StatusCode::FORBIDDEN,
            "FORBIDDEN",
            "当前账户没有执行此操作的权限",
        ));
    }
    Ok(user)
}

fn invalid_credentials() -> ApiError {
    ApiError::client(
        StatusCode::UNAUTHORIZED,
        "INVALID_CREDENTIALS",
        "用户名或密码错误",
    )
}

pub(crate) async fn ensure_initial_admin(pool: &StoragePool, password: Option<&str>) -> Result<()> {
    let user_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(pool)
        .await?;
    if user_count > 0 {
        return Ok(());
    }
    let password = password
        .filter(|value| !value.trim().is_empty())
        .context("ADMIN_PASSWORD must be set when initializing the first dashboard account")?;
    validate_password(password)?;
    sqlx::query(
        "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind("admin")
    .bind(hash_password(password)?)
    .bind("admin")
    .bind(now_string())
    .execute(pool)
    .await?;
    Ok(())
}

pub(crate) async fn import_legacy_users(pool: &StoragePool, paths: &RuntimePaths) -> Result<()> {
    let users_path = paths.config_dir.join("users.json");
    if !users_path.exists() {
        return Ok(());
    }
    let contents = fs::read_to_string(&users_path)
        .with_context(|| format!("read legacy users file {}", users_path.display()))?;
    let users: std::collections::HashMap<String, LegacyUser> = serde_json::from_str(&contents)
        .with_context(|| format!("parse legacy users file {}", users_path.display()))?;
    for (username, user) in users {
        if username.trim().is_empty() || user.password_hash.trim().is_empty() {
            tracing::warn!(%username, "skipping malformed legacy user");
            continue;
        }
        sqlx::query(
            "INSERT OR IGNORE INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)",
        )
        .bind(username)
        .bind(user.password_hash)
        .bind(normalize_role(&user.role))
        .bind(user.created_at.unwrap_or_else(now_string))
        .execute(pool)
        .await?;
    }
    Ok(())
}

pub(crate) fn verify_password(password: &str, stored_hash: &str) -> bool {
    if is_legacy_password_hash(stored_hash) {
        let Some((salt, expected)) = stored_hash.split_once('$') else {
            return false;
        };
        let calculated = format!(
            "{:x}",
            Sha256::digest(format!("{salt}{password}").as_bytes())
        );
        return calculated.as_bytes().ct_eq(expected.as_bytes()).into();
    }
    let Ok(parsed) = PasswordHash::new(stored_hash) else {
        return false;
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}

pub(crate) fn is_legacy_password_hash(value: &str) -> bool {
    value.split_once('$').is_some_and(|(salt, digest)| {
        !salt.is_empty() && digest.len() == 64 && !value.starts_with('$')
    })
}

pub(crate) fn hash_password(password: &str) -> Result<String> {
    let salt = SaltString::generate(&mut OsRng);
    Ok(Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map_err(|error| anyhow::anyhow!("hash password: {error}"))?
        .to_string())
}

pub(crate) fn normalize_role(role: &str) -> &'static str {
    if role.trim() == "admin" {
        "admin"
    } else {
        "viewer"
    }
}

pub(crate) fn validate_password(password: &str) -> Result<()> {
    if password.chars().count() < 12 {
        anyhow::bail!("密码至少需要 12 个字符");
    }
    if password == "admin123" {
        anyhow::bail!("不能使用默认密码 admin123");
    }
    Ok(())
}

pub(crate) fn validate_username(username: &str) -> Result<&str> {
    let username = username.trim();
    if username.is_empty() || username.chars().count() > 64 {
        anyhow::bail!("用户名长度必须为 1 到 64 个字符");
    }
    if username.chars().any(char::is_control) {
        anyhow::bail!("用户名不能包含控制字符");
    }
    Ok(username)
}

pub(crate) async fn create_session(pool: &StoragePool, username: &str) -> Result<String> {
    sqlx::query("DELETE FROM sessions WHERE expires_at <= ?")
        .bind(chrono::Utc::now().timestamp())
        .execute(pool)
        .await?;
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let token = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let now = chrono::Utc::now().timestamp();
    sqlx::query(
        "INSERT INTO sessions (token_hash, username, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(token_hash(&token))
    .bind(username)
    .bind(now)
    .bind(now + SESSION_LIFETIME_SECONDS)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(token)
}

pub(crate) async fn authenticated_user(
    pool: &StoragePool,
    headers: &HeaderMap,
) -> Result<Option<(String, String)>> {
    let Some(token) = session_token(headers) else {
        return Ok(None);
    };
    let now = chrono::Utc::now().timestamp();
    let row = sqlx::query(
        "SELECT users.username, users.role FROM sessions JOIN users ON users.username = sessions.username WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND sessions.last_seen_at > ?",
    )
    .bind(token_hash(&token))
    .bind(now)
    .bind(now - SESSION_IDLE_TIMEOUT_SECONDS)
    .fetch_optional(pool)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    sqlx::query("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ? AND last_seen_at < ?")
        .bind(now)
        .bind(token_hash(&token))
        .bind(now - SESSION_LAST_SEEN_WRITE_INTERVAL_SECONDS)
        .execute(pool)
        .await?;
    Ok(Some((row.get("username"), row.get("role"))))
}

pub(crate) fn session_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::COOKIE)
        .and_then(|value| value.to_str().ok())
        .and_then(|cookies| {
            cookies.split(';').find_map(|cookie| {
                let (name, value) = cookie.trim().split_once('=')?;
                (name == SESSION_COOKIE_NAME && !value.is_empty()).then(|| value.to_string())
            })
        })
}

pub(crate) fn token_hash(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

pub(crate) fn session_cookie(token: &str, security: &SecurityConfig) -> HeaderValue {
    let secure = if security.session_cookie_secure {
        "; Secure"
    } else {
        ""
    };
    HeaderValue::from_str(&format!(
        "{SESSION_COOKIE_NAME}={token}; Path=/; Max-Age={SESSION_LIFETIME_SECONDS}; HttpOnly; SameSite=Lax{secure}"
    ))
    .expect("session cookie is valid")
}

pub(crate) async fn login_is_rate_limited(pool: &StoragePool, username: &str) -> Result<bool> {
    let now = chrono::Utc::now().timestamp();
    let row = sqlx::query("SELECT failed_count, window_started_at, locked_until FROM login_attempts WHERE username = ?")
        .bind(username)
        .fetch_optional(pool)
        .await?;
    let Some(row) = row else {
        return Ok(false);
    };
    let locked_until: i64 = row.get("locked_until");
    if locked_until > now {
        return Ok(true);
    }
    let window_started_at: i64 = row.get("window_started_at");
    if window_started_at + LOGIN_FAILURE_WINDOW_SECONDS <= now {
        sqlx::query("DELETE FROM login_attempts WHERE username = ?")
            .bind(username)
            .execute(pool)
            .await?;
    }
    Ok(false)
}

pub(crate) async fn record_failed_login(pool: &StoragePool, username: &str) -> Result<()> {
    let now = chrono::Utc::now().timestamp();
    sqlx::query(
        "DELETE FROM login_attempts WHERE locked_until <= ? AND window_started_at + ? <= ?",
    )
    .bind(now)
    .bind(LOGIN_FAILURE_WINDOW_SECONDS)
    .bind(now)
    .execute(pool)
    .await?;
    let row = sqlx::query(
        "SELECT failed_count, window_started_at FROM login_attempts WHERE username = ?",
    )
    .bind(username)
    .fetch_optional(pool)
    .await?;
    let (failed_count, window_started_at) = match row {
        Some(row)
            if row.get::<i64, _>("window_started_at") + LOGIN_FAILURE_WINDOW_SECONDS > now =>
        {
            (
                row.get::<i64, _>("failed_count") + 1,
                row.get::<i64, _>("window_started_at"),
            )
        }
        _ => (1, now),
    };
    let locked_until = if failed_count >= LOGIN_FAILURE_LIMIT {
        now + LOGIN_LOCKOUT_SECONDS
    } else {
        0
    };
    sqlx::query(
        "INSERT INTO login_attempts (username, failed_count, window_started_at, locked_until) VALUES (?, ?, ?, ?) ON CONFLICT(username) DO UPDATE SET failed_count = excluded.failed_count, window_started_at = excluded.window_started_at, locked_until = excluded.locked_until",
    )
    .bind(username)
    .bind(failed_count)
    .bind(window_started_at)
    .bind(locked_until)
    .execute(pool)
    .await?;
    Ok(())
}

pub(crate) async fn clear_login_attempts(pool: &StoragePool, username: &str) -> Result<()> {
    sqlx::query("DELETE FROM login_attempts WHERE username = ?")
        .bind(username)
        .execute(pool)
        .await?;
    Ok(())
}

fn expired_session_cookie(security: &SecurityConfig) -> HeaderValue {
    let secure = if security.session_cookie_secure {
        "; Secure"
    } else {
        ""
    };
    HeaderValue::from_str(&format!(
        "compass_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax{secure}"
    ))
    .expect("session cookie is valid")
}
