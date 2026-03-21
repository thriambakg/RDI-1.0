//! RDI Session API - Async Rust implementation for low latency.
//!
//! Runs on EC2 alongside the proxy. Same endpoints as the Lambda:
//! - POST /sessions -> create session, return { session_id, endpoint, expires_at }
//! - GET /sessions?session_id=X -> get session
//! - DELETE /sessions (JSON body: { session_id }) -> release session
//!
//! Env: CONNECTION_POOL_TABLE, AWS_REGION, PROXY_ENDPOINT
//! Auth: Production needs Cognito JWT. Dev: set X-User-Id header (e.g. Cognito sub).

#[allow(unused_imports)]
use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{delete, get, post},
    Json, Router,
};
use aws_sdk_dynamodb::types::AttributeValue;
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::net::TcpListener;
use tracing::info;
use uuid::Uuid;

const DEFAULT_PORT: u16 = 8080;

#[derive(Clone)]
struct AppState {
    client: aws_sdk_dynamodb::Client,
    table_name: String,
    proxy_endpoint: String,
    region: String,
}

#[derive(Serialize)]
struct CreateSessionResponse {
    session_id: String,
    endpoint: String,
    expires_at: u64,
}

#[derive(Deserialize)]
struct GetSessionQuery {
    session_id: String,
}

#[derive(Deserialize)]
struct ReleaseSessionBody {
    session_id: String,
}

#[derive(Serialize)]
struct SessionResponse {
    session_id: String,
    endpoint: Option<String>,
    status: Option<String>,
}

#[derive(Serialize)]
struct ErrorResponse {
    error: String,
}

fn user_id_from_headers(headers: &HeaderMap) -> Option<String> {
    headers
        .get("x-user-id")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
}

async fn create_session(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let user_id = match user_id_from_headers(&headers) {
        Some(id) => id,
        None => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(ErrorResponse {
                    error: "X-User-Id header required (Cognito sub). Add Cognito JWT validation for production.".into(),
                }),
            )
                .into_response()
        }
    };

    loop {
        let session_id = Uuid::new_v4().to_string();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let expires_at = now + 3600;

        let item = [
            ("region", AttributeValue::S(state.region.clone())),
            ("session_id", AttributeValue::S(session_id.clone())),
            ("status", AttributeValue::S("active".into())),
            ("user_id", AttributeValue::S(user_id.clone())),
            ("created_at", AttributeValue::N(now.to_string())),
            ("expires_at", AttributeValue::N(expires_at.to_string())),
            ("endpoint", AttributeValue::S(state.proxy_endpoint.clone())),
        ];

        let mut put = state.client.put_item();
        put = put.table_name(&state.table_name);
        for (k, v) in item {
            put = put.item(k, v);
        }
        put = put.condition_expression("attribute_not_exists(session_id)");

        match put.send().await {
            Ok(_) => {
                return (
                    StatusCode::OK,
                    Json(CreateSessionResponse {
                        session_id,
                        endpoint: state.proxy_endpoint.clone(),
                        expires_at,
                    }),
                )
                    .into_response()
            }
            Err(e) => {
                if e.to_string().contains("ConditionalCheckFailed") {
                    continue;
                } else {
                    return (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(ErrorResponse {
                            error: e.to_string(),
                        }),
                    )
                        .into_response()
                }
            }
        }
    }
}

async fn get_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<GetSessionQuery>,
) -> impl IntoResponse {
    let user_id = match user_id_from_headers(&headers) {
        Some(id) => id,
        None => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(ErrorResponse {
                    error: "X-User-Id header required".into(),
                }),
            )
                .into_response()
        }
    };

    if q.session_id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "session_id required".into(),
            }),
        )
            .into_response();
    }

    let resp = state
        .client
        .get_item()
        .table_name(&state.table_name)
        .key("region", AttributeValue::S(state.region.clone()))
        .key("session_id", AttributeValue::S(q.session_id.clone()))
        .send()
        .await;

    match resp {
        Ok(out) => {
            let item = match out.item {
                Some(i) => i,
                None => {
                    return (
                        StatusCode::NOT_FOUND,
                        Json(ErrorResponse {
                            error: "Session not found".into(),
                        }),
                    )
                        .into_response()
                }
            };

            let item_user_id = item
                .get("user_id")
                .and_then(|v| v.as_s().ok())
                .map(|s| s.to_string());
            if item_user_id.as_deref() != Some(&user_id) {
                return (
                    StatusCode::NOT_FOUND,
                    Json(ErrorResponse {
                        error: "Session not found".into(),
                    }),
                )
                    .into_response();
            }

            let endpoint = item
                .get("endpoint")
                .and_then(|v| v.as_s().ok())
                .map(|s| s.to_string());
            let status = item
                .get("status")
                .and_then(|v| v.as_s().ok())
                .map(|s| s.to_string());

            (
                StatusCode::OK,
                Json(SessionResponse {
                    session_id: q.session_id,
                    endpoint,
                    status,
                }),
            )
                .into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
            .into_response(),
    }
}

async fn release_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ReleaseSessionBody>,
) -> impl IntoResponse {
    let user_id = match user_id_from_headers(&headers) {
        Some(id) => id,
        None => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(ErrorResponse {
                    error: "X-User-Id header required".into(),
                }),
            )
                .into_response()
        }
    };

    if body.session_id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "session_id required".into(),
            }),
        )
            .into_response();
    }

    let update = state
        .client
        .update_item()
        .table_name(&state.table_name)
        .key("region", AttributeValue::S(state.region.clone()))
        .key("session_id", AttributeValue::S(body.session_id.clone()))
        .update_expression("SET #status = :idle")
        .expression_attribute_names("#status", "status")
        .expression_attribute_values(":idle", AttributeValue::S("idle".into()))
        .expression_attribute_values(":uid", AttributeValue::S(user_id))
        .condition_expression("user_id = :uid")
        .send()
        .await;

    match update {
        Ok(_) => (
            StatusCode::OK,
            Json(serde_json::json!({ "message": "Session released" })),
        )
            .into_response(),
        Err(e) => {
            if e.to_string().contains("ConditionalCheckFailed") {
                (
                    StatusCode::NOT_FOUND,
                    Json(ErrorResponse {
                        error: "Session not found".into(),
                    }),
                )
            } else {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: e.to_string(),
                    }),
                )
            }
            .into_response()
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let table_name =
        std::env::var("CONNECTION_POOL_TABLE").expect("CONNECTION_POOL_TABLE required");
    let region = std::env::var("AWS_REGION").unwrap_or_else(|_| "us-east-1".into());
    let proxy_endpoint =
        std::env::var("PROXY_ENDPOINT").expect("PROXY_ENDPOINT required (e.g. ws://ip:8765)");

    let config = aws_config::defaults(aws_config::BehaviorVersion::latest())
        .region(aws_config::Region::new(region.clone()))
        .load()
        .await;

    let client = aws_sdk_dynamodb::Client::new(&config);

    let state = AppState {
        client,
        table_name: table_name.clone(),
        proxy_endpoint: proxy_endpoint.clone(),
        region: region.clone(),
    };

    let app = Router::new()
        .route("/sessions", get(get_session).post(create_session).delete(release_session))
        .with_state(state);

    let port: u16 = std::env::var("RDI_SESSION_API_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_PORT);

    let addr = format!("0.0.0.0:{}", port);
    info!("Session API listening on {}", addr);

    let listener = TcpListener::bind(&addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
