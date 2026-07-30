use std::{
    fs,
    time::{SystemTime, UNIX_EPOCH},
};

use super::*;
use axum::{body::Body, http::Request};
use sqlx::sqlite::SqlitePoolOptions;
use tower::ServiceExt;

async fn test_pool() -> StoragePool {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    luopan_storage::migrate(&pool).await.unwrap();
    pool
}

fn test_security() -> Arc<SecurityConfig> {
    Arc::new(SecurityConfig {
        production: false,
        session_cookie_secure: false,
        trusted_origins: vec!["http://127.0.0.1:5173".to_string()],
    })
}

async fn integration_state() -> AppState {
    let root = std::env::temp_dir().join(format!(
        "luopan-request-id-router-test-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    AppState {
        paths: Arc::new(RuntimePaths {
            app_dir: root.clone(),
            output_dir: root.join("output"),
            state_dir: root.join("state"),
            config_dir: root.join("config"),
            logs_dir: root.join("logs"),
            session_dir: root.join("session"),
        }),
        novnc_url: Arc::new("http://127.0.0.1:6080".to_string()),
        auth_pool: Arc::new(test_pool().await),
        storage_pool: None,
        security: test_security(),
    }
}

async fn assert_router_request_id(
    app: Router,
    request: Request<Body>,
    expected_status: StatusCode,
) {
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), expected_status);
    let header_id = response
        .headers()
        .get("x-request-id")
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let payload: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(payload["meta"]["request_id"], header_id);
}

#[tokio::test]
async fn router_middleware_keeps_request_ids_consistent_for_all_api_outcomes() {
    let state = integration_state().await;
    sqlx::query(
        "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind("request-id-viewer")
    .bind(hash_password("viewer-password-123").unwrap())
    .bind("viewer")
    .bind(now_string())
    .execute(&*state.auth_pool)
    .await
    .unwrap();
    let viewer_token = create_session(&state.auth_pool, "request-id-viewer")
        .await
        .unwrap();
    let protected = Router::new()
        .route(
            "/unauthorized",
            axum::routing::get(|| async { api(json!({ "ok": true })) }),
        )
        .route_layer(from_fn_with_state(state.clone(), require_auth));
    let admin_only = Router::new()
        .route(
            "/forbidden",
            axum::routing::get(|| async { api(json!({ "ok": true })) }),
        )
        .route_layer(from_fn_with_state(state.clone(), require_admin));
    let app = Router::new()
        .route(
            "/ok",
            axum::routing::get(|| async { api(json!({ "ok": true })) }),
        )
        .route(
            "/error",
            axum::routing::get(|| async { ApiError::internal(anyhow::anyhow!("test failure")) }),
        )
        .route(
            "/mutate",
            axum::routing::post(|| async { api(json!({ "ok": true })) }),
        )
        .merge(protected)
        .merge(admin_only)
        .layer(from_fn_with_state(state.clone(), csrf_protection))
        .layer(from_fn(request_logging))
        .with_state(state);

    assert_router_request_id(
        app.clone(),
        Request::builder().uri("/ok").body(Body::empty()).unwrap(),
        StatusCode::OK,
    )
    .await;
    assert_router_request_id(
        app.clone(),
        Request::builder()
            .uri("/unauthorized")
            .body(Body::empty())
            .unwrap(),
        StatusCode::UNAUTHORIZED,
    )
    .await;
    assert_router_request_id(
        app.clone(),
        Request::builder()
            .uri("/forbidden")
            .header(
                header::COOKIE,
                format!("{SESSION_COOKIE_NAME}={viewer_token}"),
            )
            .body(Body::empty())
            .unwrap(),
        StatusCode::FORBIDDEN,
    )
    .await;
    assert_router_request_id(
        app.clone(),
        Request::builder()
            .uri("/error")
            .body(Body::empty())
            .unwrap(),
        StatusCode::INTERNAL_SERVER_ERROR,
    )
    .await;
    assert_router_request_id(
        app.clone(),
        Request::builder()
            .method("POST")
            .uri("/mutate")
            .body(Body::empty())
            .unwrap(),
        StatusCode::FORBIDDEN,
    )
    .await;

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/ok")
                .header("x-request-id", "client-request-id")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.headers()["x-request-id"], "client-request-id");
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let payload: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(payload["meta"]["request_id"], "client-request-id");

    let response = app
        .oneshot(
            Request::builder()
                .uri("/ok")
                .header("x-request-id", "invalid request id")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let generated_id = response.headers()["x-request-id"]
        .to_str()
        .unwrap()
        .to_string();
    assert_ne!(generated_id, "invalid request id");
    assert!(is_valid_request_id(&generated_id));
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let payload: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(payload["meta"]["request_id"], generated_id);
}

#[test]
fn accepts_only_safe_client_request_ids() {
    assert!(is_valid_request_id("request-123_A.B"));
    assert!(!is_valid_request_id(""));
    assert!(!is_valid_request_id("contains space"));
    assert!(!is_valid_request_id(&"a".repeat(65)));
}

#[test]
fn verifies_legacy_salt_sha256_passwords() {
    let hash = format!(
        "legacy-salt${:x}",
        Sha256::digest(b"legacy-saltcorrect horse")
    );
    assert!(verify_password("correct horse", &hash));
    assert!(!verify_password("wrong", &hash));
    assert!(is_legacy_password_hash(&hash));
}

#[test]
fn verifies_argon2_passwords() {
    let hash = hash_password("correct horse").unwrap();
    assert!(verify_password("correct horse", &hash));
    assert!(!verify_password("wrong", &hash));
    assert!(!is_legacy_password_hash(&hash));
}

#[tokio::test]
async fn login_upgrades_a_legacy_password_hash_to_argon2() {
    let pool = Arc::new(test_pool().await);
    let legacy_hash = format!("salt${:x}", Sha256::digest(b"saltdashboard-password"));
    sqlx::query(
        "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind("alice")
    .bind(&legacy_hash)
    .bind("admin")
    .bind(now_string())
    .execute(&*pool)
    .await
    .unwrap();
    let root = std::env::temp_dir().join("luopan-auth-login-test");
    let state = AppState {
        paths: Arc::new(RuntimePaths {
            app_dir: root.clone(),
            output_dir: root.join("output"),
            state_dir: root.join("state"),
            config_dir: root.join("config"),
            logs_dir: root.join("logs"),
            session_dir: root.join("session"),
        }),
        novnc_url: Arc::new("http://127.0.0.1:6080".to_string()),
        auth_pool: pool.clone(),
        storage_pool: None,
        security: test_security(),
    };
    let response = login(
        State(state),
        Json(LoginPayload {
            username: "alice".to_string(),
            password: "dashboard-password".to_string(),
        }),
    )
    .await
    .unwrap();
    assert!(response.headers().contains_key(header::SET_COOKIE));
    let upgraded: String = sqlx::query("SELECT password_hash FROM users WHERE username = 'alice'")
        .fetch_one(&*pool)
        .await
        .unwrap()
        .get(0);
    assert!(upgraded.starts_with("$argon2"));
    assert!(verify_password("dashboard-password", &upgraded));
}

#[tokio::test]
async fn initializes_configured_admin_only_when_users_are_absent() {
    let pool = test_pool().await;
    ensure_initial_admin(&pool, Some("strong-password"))
        .await
        .unwrap();
    let user: (String, String) =
        sqlx::query_as("SELECT username, password_hash FROM users WHERE username = 'admin'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(user.0, "admin");
    assert!(verify_password("strong-password", &user.1));

    ensure_initial_admin(&pool, None).await.unwrap();
    let user_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(user_count, 1);
}

#[tokio::test]
async fn sessions_are_backed_by_sqlite_and_expire() {
    let pool = test_pool().await;
    sqlx::query(
        "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind("alice")
    .bind(hash_password("password").unwrap())
    .bind("admin")
    .bind(now_string())
    .execute(&pool)
    .await
    .unwrap();
    let token = create_session(&pool, "alice").await.unwrap();
    let mut headers = HeaderMap::new();
    headers.insert(
        header::COOKIE,
        HeaderValue::from_str(&format!("{SESSION_COOKIE_NAME}={token}")).unwrap(),
    );
    assert_eq!(
        authenticated_user(&pool, &headers).await.unwrap(),
        Some(("alice".to_string(), "admin".to_string()))
    );
    sqlx::query("UPDATE sessions SET expires_at = 0")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(authenticated_user(&pool, &headers).await.unwrap(), None);
}

#[tokio::test]
async fn idle_sessions_are_rejected() {
    let pool = test_pool().await;
    sqlx::query(
        "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind("idle-user")
    .bind(hash_password("password").unwrap())
    .bind("viewer")
    .bind(now_string())
    .execute(&pool)
    .await
    .unwrap();
    let token = create_session(&pool, "idle-user").await.unwrap();
    sqlx::query("UPDATE sessions SET last_seen_at = 0 WHERE token_hash = ?")
        .bind(token_hash(&token))
        .execute(&pool)
        .await
        .unwrap();
    let mut headers = HeaderMap::new();
    headers.insert(
        header::COOKIE,
        HeaderValue::from_str(&format!("{SESSION_COOKIE_NAME}={token}")).unwrap(),
    );
    assert!(authenticated_user(&pool, &headers).await.unwrap().is_none());
}

#[tokio::test]
async fn repeated_login_failures_are_rate_limited() {
    let pool = test_pool().await;
    let expired_window = chrono::Utc::now().timestamp() - LOGIN_FAILURE_WINDOW_SECONDS - 1;
    sqlx::query(
            "INSERT INTO login_attempts (username, failed_count, window_started_at, locked_until) VALUES (?, ?, ?, ?)",
        )
        .bind("expired-user")
        .bind(1_i64)
        .bind(expired_window)
        .bind(0_i64)
        .execute(&pool)
        .await
        .unwrap();
    for _ in 0..LOGIN_FAILURE_LIMIT {
        record_failed_login(&pool, "unknown-user").await.unwrap();
    }
    let expired_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM login_attempts WHERE username = 'expired-user'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(expired_count, 0);
    assert!(login_is_rate_limited(&pool, "unknown-user").await.unwrap());
    clear_login_attempts(&pool, "unknown-user").await.unwrap();
    assert!(!login_is_rate_limited(&pool, "unknown-user").await.unwrap());
}

#[test]
fn production_cookie_is_secure() {
    let security = SecurityConfig {
        production: true,
        session_cookie_secure: true,
        trusted_origins: Vec::new(),
    };
    assert!(
        session_cookie("token", &security)
            .to_str()
            .unwrap()
            .contains("; Secure")
    );
}

#[tokio::test]
async fn internal_errors_hide_details_and_include_request_id() {
    let response =
        ApiError::internal(anyhow::anyhow!("failed to open /private/secret.db")).into_response();
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert!(response.headers().contains_key("x-request-id"));
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let payload: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(payload["error"]["message"], "服务器内部错误");
    assert!(!payload["error"].to_string().contains("secret"));
    assert!(payload["meta"]["request_id"].as_str().is_some());
}

#[tokio::test]
async fn api_envelopes_and_errors_share_the_request_context_id() {
    REQUEST_ID
        .scope("request-id-under-test".to_string(), async {
            let success = api(json!({ "ok": true }));
            assert_eq!(success.0["meta"]["request_id"], "request-id-under-test");

            let response = ApiError::client(StatusCode::BAD_REQUEST, "INVALID_REQUEST", "请求无效")
                .into_response();
            assert_eq!(
                response.headers().get("x-request-id").unwrap(),
                "request-id-under-test"
            );
            let body = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            let payload: Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(payload["meta"]["request_id"], "request-id-under-test");
        })
        .await;
}

#[tokio::test]
async fn viewer_sessions_cannot_pass_admin_authorization() {
    let pool = test_pool().await;
    sqlx::query(
        "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind("viewer-user")
    .bind(hash_password("viewer-password-123").unwrap())
    .bind("viewer")
    .bind(now_string())
    .execute(&pool)
    .await
    .unwrap();
    let token = create_session(&pool, "viewer-user").await.unwrap();
    let mut headers = HeaderMap::new();
    headers.insert(
        header::COOKIE,
        HeaderValue::from_str(&format!("{SESSION_COOKIE_NAME}={token}")).unwrap(),
    );

    assert!(authorized_user(&pool, &headers, None).await.is_ok());
    let error = authorized_user(&pool, &headers, Some("admin"))
        .await
        .unwrap_err();
    assert_eq!(error.status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn manages_users_and_changes_current_password() {
    let pool = Arc::new(test_pool().await);
    sqlx::query(
        "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind("admin")
    .bind(hash_password("initial-admin-password").unwrap())
    .bind("admin")
    .bind(now_string())
    .execute(&*pool)
    .await
    .unwrap();
    let token = create_session(&pool, "admin").await.unwrap();
    let mut headers = HeaderMap::new();
    headers.insert(
        header::COOKIE,
        HeaderValue::from_str(&format!("{SESSION_COOKIE_NAME}={token}")).unwrap(),
    );
    let root = std::env::temp_dir().join("luopan-account-management-test");
    let state = AppState {
        paths: Arc::new(RuntimePaths {
            app_dir: root.clone(),
            output_dir: root.join("output"),
            state_dir: root.join("state"),
            config_dir: root.join("config"),
            logs_dir: root.join("logs"),
            session_dir: root.join("session"),
        }),
        novnc_url: Arc::new("http://127.0.0.1:6080".to_string()),
        auth_pool: pool.clone(),
        storage_pool: None,
        security: test_security(),
    };

    let (status, _) = create_user(
        State(state.clone()),
        Json(CreateUserPayload {
            username: "reader".to_string(),
            password: "reader-password-123".to_string(),
            role: "viewer".to_string(),
        }),
    )
    .await
    .unwrap();
    assert_eq!(status, StatusCode::CREATED);
    let users = list_users(State(state.clone())).await.unwrap().0;
    assert_eq!(users["data"]["users"].as_array().unwrap().len(), 2);

    let _ = change_password(
        State(state.clone()),
        headers.clone(),
        Json(ChangePasswordPayload {
            current_password: "initial-admin-password".to_string(),
            new_password: "updated-admin-password".to_string(),
        }),
    )
    .await
    .unwrap();
    let updated_hash: String =
        sqlx::query_scalar("SELECT password_hash FROM users WHERE username = 'admin'")
            .fetch_one(&*pool)
            .await
            .unwrap();
    assert!(verify_password("updated-admin-password", &updated_hash));

    let _ = remove_user(State(state), headers, AxumPath("reader".to_string()))
        .await
        .unwrap();
    let reader_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE username = 'reader'")
            .fetch_one(&*pool)
            .await
            .unwrap();
    assert_eq!(reader_count, 0);
}

#[test]
fn validates_account_inputs() {
    assert!(validate_password("long-enough-password").is_ok());
    assert!(validate_password("short").is_err());
    assert!(validate_password("admin123").is_err());
    assert_eq!(validate_username(" alice ").unwrap(), "alice");
    assert!(validate_username("").is_err());
    assert!(validate_username("bad\nname").is_err());
    assert!(validate_username(&"a".repeat(65)).is_err());
    assert_eq!(normalize_role("admin"), "admin");
    assert_eq!(normalize_role("unexpected"), "viewer");
}

#[test]
fn validates_collection_modules() {
    assert_eq!(
        validate_collection_modules(vec!["channel".into(), "channel".into()]).unwrap(),
        ["channel"]
    );
    assert_eq!(
        validate_collection_modules(Vec::new()).unwrap(),
        ["operations", "channel"]
    );
    assert!(validate_collection_modules(vec!["unknown".into()]).is_err());
    let today = NaiveDate::from_ymd_opt(2026, 7, 27).unwrap();
    assert_eq!(
        validate_collection_date_at(Some("2026-07-25".into()), today).unwrap(),
        Some("2026-07-25".into())
    );
    assert!(validate_collection_date_at(Some("2026-06-30".into()), today).is_err());
    assert!(validate_collection_date_at(Some("9999-12-31".into()), today).is_err());
    assert_eq!(
        validate_collection_shops(vec![" 店铺 A ".into(), "店铺 A".into()]).unwrap(),
        ["店铺 A"]
    );
}

#[test]
fn validates_settlement_date_filters() {
    assert_eq!(
        validate_settlement_date_range(Some("2026-07-01".into()), Some("2026-07-31".into()))
            .unwrap(),
        (Some("2026-07-01".into()), Some("2026-07-31".into()))
    );
    assert_eq!(
        validate_settlement_date_range(Some(" ".into()), None).unwrap(),
        (None, None)
    );
    assert!(
        validate_settlement_date_range(Some("2026-08-01".into()), Some("2026-07-31".into()))
            .is_err()
    );
    assert!(validate_settlement_date_range(Some("2026/07/01".into()), None).is_err());
}

#[tokio::test]
async fn scrape_rejects_requests_while_a_job_is_running() {
    let root = std::env::temp_dir().join(format!(
        "luopan-api-scrape-busy-test-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let paths = RuntimePaths {
        app_dir: root.clone(),
        output_dir: root.join("output"),
        state_dir: root.join("state"),
        config_dir: root.join("config"),
        logs_dir: root.join("logs"),
        session_dir: root.join("session"),
    };
    fs::create_dir_all(paths.collection_dir()).unwrap();
    fs::write(paths.daily_lock_path(), "busy").unwrap();
    let state = AppState {
        paths: Arc::new(paths),
        novnc_url: Arc::new("http://127.0.0.1:6080".to_string()),
        auth_pool: Arc::new(test_pool().await),
        storage_pool: None,
        security: test_security(),
    };

    let error = scrape(State(state)).await.unwrap_err();
    assert_eq!(error.status, StatusCode::CONFLICT);
    assert_eq!(error.message, "已有采集任务或待处理请求");
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn collection_request_is_atomically_queued_for_online_service() {
    let root = std::env::temp_dir().join(format!(
        "luopan-api-collection-queue-test-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let paths = RuntimePaths {
        app_dir: root.clone(),
        output_dir: root.join("output"),
        state_dir: root.join("state"),
        config_dir: root.join("config"),
        logs_dir: root.join("logs"),
        session_dir: root.join("session"),
    };
    fs::create_dir_all(paths.collection_dir()).unwrap();
    fs::write(paths.collection_heartbeat_path(), "{}").unwrap();
    let state = AppState {
        paths: Arc::new(paths.clone()),
        novnc_url: Arc::new("http://127.0.0.1:6080".to_string()),
        auth_pool: Arc::new(test_pool().await),
        storage_pool: None,
        security: test_security(),
    };

    let (status, payload) = run_collection(
        State(state),
        Json(CollectionRunPayload {
            modules: vec!["channel".to_string()],
            date: None,
            shops: Vec::new(),
        }),
    )
    .await
    .unwrap();

    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(payload.0["data"]["modules"], json!(["channel"]));
    let request = read_json_file(&paths.collection_request_path())
        .unwrap()
        .unwrap();
    assert_eq!(request["modules"], json!(["channel"]));
    assert!(!paths.collection_dir().join("request.json.tmp").exists());
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn historical_collection_request_includes_date_and_shops() {
    let root = std::env::temp_dir().join(format!(
        "luopan-api-collection-backfill-test-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let paths = RuntimePaths {
        app_dir: root.clone(),
        output_dir: root.join("output"),
        state_dir: root.join("state"),
        config_dir: root.join("config"),
        logs_dir: root.join("logs"),
        session_dir: root.join("session"),
    };
    fs::create_dir_all(paths.collection_dir()).unwrap();
    fs::write(paths.collection_heartbeat_path(), "{}").unwrap();
    let state = AppState {
        paths: Arc::new(paths.clone()),
        novnc_url: Arc::new("http://127.0.0.1:6080".to_string()),
        auth_pool: Arc::new(test_pool().await),
        storage_pool: None,
        security: test_security(),
    };

    let (status, payload) = run_collection(
        State(state),
        Json(CollectionRunPayload {
            modules: vec!["operations".to_string()],
            date: Some("2026-07-25".to_string()),
            shops: vec!["店铺 A".to_string()],
        }),
    )
    .await
    .unwrap();

    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(payload.0["data"]["date"], json!("2026-07-25"));
    let request = read_json_file(&paths.collection_request_path())
        .unwrap()
        .unwrap();
    assert_eq!(request["date"], json!("2026-07-25"));
    assert_eq!(request["shops"], json!(["店铺 A"]));
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn imports_legacy_users_without_overwriting_migrated_accounts() {
    let root = std::env::temp_dir().join(format!(
        "luopan-auth-test-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let paths = RuntimePaths {
        app_dir: root.clone(),
        output_dir: root.join("output"),
        state_dir: root.join("state"),
        config_dir: root.join("config"),
        logs_dir: root.join("logs"),
        session_dir: root.join("session"),
    };
    fs::create_dir_all(&paths.config_dir).unwrap();
    fs::write(
            paths.config_dir.join("users.json"),
            r#"{"alice":{"password_hash":"salt$fcf730b6d95236ec5b4c6f4e6e2fba6c1d6c5c4f9cc377da8471c3a876b2c25e","role":"admin","created_at":"2025-01-01T00:00:00"}}"#,
        )
        .unwrap();
    let pool = test_pool().await;
    import_legacy_users(&pool, &paths).await.unwrap();
    let stored: String = sqlx::query("SELECT password_hash FROM users WHERE username = 'alice'")
        .fetch_one(&pool)
        .await
        .unwrap()
        .get(0);
    assert_eq!(
        stored,
        "salt$fcf730b6d95236ec5b4c6f4e6e2fba6c1d6c5c4f9cc377da8471c3a876b2c25e"
    );
    let _ = fs::remove_dir_all(root);
}
