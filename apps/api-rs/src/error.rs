use axum::{
    Json,
    http::{HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use rand_core::{OsRng, RngCore};
use serde::Serialize;
use serde_json::{Value, json};

#[derive(Debug)]
pub(crate) struct ApiError {
    pub(crate) status: StatusCode,
    code: &'static str,
    pub(crate) message: String,
    request_id: String,
}

impl ApiError {
    pub(crate) fn internal(error: anyhow::Error) -> Self {
        let request_id = request_id();
        tracing::error!(%request_id, error = %error, "internal API error");
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "INTERNAL_ERROR",
            message: "服务器内部错误".to_string(),
            request_id,
        }
    }

    pub(crate) fn bad_request(error: anyhow::Error) -> Self {
        Self::client(
            StatusCode::BAD_REQUEST,
            "INVALID_REQUEST",
            error.to_string(),
        )
    }

    pub(crate) fn client(
        status: StatusCode,
        code: &'static str,
        message: impl Into<String>,
    ) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            request_id: request_id(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let request_id = self.request_id;
        let mut response = (
            self.status,
            Json(json!({
                "data": Value::Null,
                "error": { "code": self.code, "message": self.message },
                "meta": { "request_id": request_id },
            })),
        )
            .into_response();
        response.headers_mut().insert(
            "x-request-id",
            HeaderValue::from_str(&request_id).expect("generated request ID is a valid header"),
        );
        response
    }
}

pub(crate) fn request_id() -> String {
    let mut bytes = [0_u8; 12];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(crate) fn api(data: impl Serialize) -> Json<Value> {
    api_with_meta(data, "api", false, now_string())
}

pub(crate) fn api_with_meta(
    data: impl Serialize,
    source: &str,
    fallback: bool,
    updated_at: String,
) -> Json<Value> {
    Json(json!({
        "data": data,
        "error": Value::Null,
        "meta": { "request_id": request_id(), "source": source, "fallback": fallback, "updated_at": updated_at },
    }))
}

fn now_string() -> String {
    chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string()
}
