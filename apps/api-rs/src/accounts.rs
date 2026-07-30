use axum::{
    Json,
    extract::{Path as AxumPath, State},
    http::{HeaderMap, StatusCode},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row;

use crate::{
    ApiError, AppState, api, authorized_user, hash_password, now_string, session_token, token_hash,
    validate_password, validate_username, verify_password,
};

#[derive(Debug, Deserialize)]
pub(crate) struct ChangePasswordPayload {
    pub(crate) current_password: String,
    pub(crate) new_password: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CreateUserPayload {
    pub(crate) username: String,
    pub(crate) password: String,
    pub(crate) role: String,
}

pub(crate) async fn change_password(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<ChangePasswordPayload>,
) -> Result<Json<Value>, ApiError> {
    let (username, _) = authorized_user(&state.auth_pool, &headers, None).await?;
    validate_password(&payload.new_password).map_err(ApiError::bad_request)?;
    let stored_hash: String =
        sqlx::query_scalar("SELECT password_hash FROM users WHERE username = ?")
            .bind(&username)
            .fetch_one(&*state.auth_pool)
            .await
            .map_err(|error| ApiError::internal(error.into()))?;
    if !verify_password(&payload.current_password, &stored_hash) {
        return Err(ApiError::client(
            StatusCode::BAD_REQUEST,
            "INVALID_PASSWORD",
            "当前密码错误",
        ));
    }
    let new_hash = hash_password(&payload.new_password).map_err(ApiError::internal)?;
    sqlx::query("UPDATE users SET password_hash = ?, password_changed_at = ? WHERE username = ?")
        .bind(new_hash)
        .bind(now_string())
        .bind(&username)
        .execute(&*state.auth_pool)
        .await
        .map_err(|error| ApiError::internal(error.into()))?;

    if let Some(token) = session_token(&headers) {
        sqlx::query("DELETE FROM sessions WHERE username = ? AND token_hash != ?")
            .bind(&username)
            .bind(token_hash(&token))
            .execute(&*state.auth_pool)
            .await
            .map_err(|error| ApiError::internal(error.into()))?;
    }
    Ok(api(json!({ "message": "密码已更新" })))
}

pub(crate) async fn list_users(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let rows = sqlx::query(
        "SELECT username, role, created_at, password_changed_at FROM users ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, username",
    )
    .fetch_all(&*state.auth_pool)
    .await
    .map_err(|error| ApiError::internal(error.into()))?;
    let users = rows
        .into_iter()
        .map(|row| {
            json!({
                "username": row.get::<String, _>("username"),
                "role": row.get::<String, _>("role"),
                "created_at": row.get::<String, _>("created_at"),
                "password_changed_at": row.get::<Option<String>, _>("password_changed_at"),
            })
        })
        .collect::<Vec<_>>();
    Ok(api(json!({ "users": users })))
}

pub(crate) async fn create_user(
    State(state): State<AppState>,
    Json(payload): Json<CreateUserPayload>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let username = validate_username(&payload.username)
        .map_err(ApiError::bad_request)?
        .to_string();
    validate_password(&payload.password).map_err(ApiError::bad_request)?;
    let role = payload.role.trim();
    if !matches!(role, "admin" | "viewer") {
        return Err(ApiError::client(
            StatusCode::BAD_REQUEST,
            "INVALID_ROLE",
            "角色必须为 admin 或 viewer",
        ));
    }
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE username = ?)")
        .bind(&username)
        .fetch_one(&*state.auth_pool)
        .await
        .map_err(|error| ApiError::internal(error.into()))?;
    if exists {
        return Err(ApiError::client(
            StatusCode::CONFLICT,
            "USER_EXISTS",
            "用户名已存在",
        ));
    }
    let created_at = now_string();
    sqlx::query(
        "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(&username)
    .bind(hash_password(&payload.password).map_err(ApiError::internal)?)
    .bind(role)
    .bind(&created_at)
    .execute(&*state.auth_pool)
    .await
    .map_err(|error| ApiError::internal(error.into()))?;
    Ok((
        StatusCode::CREATED,
        api(json!({ "user": { "username": username, "role": role, "created_at": created_at } })),
    ))
}

pub(crate) async fn remove_user(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(username): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let (current_username, _) = authorized_user(&state.auth_pool, &headers, Some("admin")).await?;
    let username = validate_username(&username)
        .map_err(ApiError::bad_request)?
        .to_string();
    if username == current_username {
        return Err(ApiError::client(
            StatusCode::BAD_REQUEST,
            "CANNOT_DELETE_CURRENT_USER",
            "不能删除当前登录账户",
        ));
    }
    let role: Option<String> = sqlx::query_scalar("SELECT role FROM users WHERE username = ?")
        .bind(&username)
        .fetch_optional(&*state.auth_pool)
        .await
        .map_err(|error| ApiError::internal(error.into()))?;
    let Some(role) = role else {
        return Err(ApiError::client(
            StatusCode::NOT_FOUND,
            "USER_NOT_FOUND",
            "用户不存在",
        ));
    };
    if role == "admin" {
        let admin_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE role = 'admin'")
                .fetch_one(&*state.auth_pool)
                .await
                .map_err(|error| ApiError::internal(error.into()))?;
        if admin_count <= 1 {
            return Err(ApiError::client(
                StatusCode::BAD_REQUEST,
                "LAST_ADMIN",
                "必须至少保留一个管理员账户",
            ));
        }
    }
    sqlx::query("DELETE FROM users WHERE username = ?")
        .bind(&username)
        .execute(&*state.auth_pool)
        .await
        .map_err(|error| ApiError::internal(error.into()))?;
    Ok(api(json!({ "deleted": username })))
}
