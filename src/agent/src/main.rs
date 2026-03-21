//! RDI Agent daemon - long-lived process on Wavelength EC2.
//! Exposes HTTP API (localhost) to add/remove sessions. Each session maintains a WebSocket
//! connection to the proxy and bridges to local MAVLink UDP.
//! Lambda uses SSM to call POST /sessions (add) and DELETE /sessions/:id (remove).

use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{delete, get, post},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use std::collections::HashMap;
use std::env;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;
use tracing::{error, info, warn};

const DEFAULT_MAVLINK_PORT: u16 = 14540;
const DEFAULT_AGENT_API_PORT: u16 = 8080;
const PING_BYTES: &[u8] = b"PING";
const PONG_BYTES: &[u8] = b"PONG";
const RECONNECT_DELAY_SECS: u64 = 5;

/// Session state: session_id -> task handle (abort on drop / DELETE).
type SessionsState = Arc<RwLock<HashMap<String, JoinHandle<()>>>>;

#[derive(Deserialize)]
struct AddSessionBody {
    session_id: String,
    proxy_url: String,
    #[serde(default)]
    mavlink_host: Option<String>,
    #[serde(default)]
    mavlink_port: Option<u16>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let api_port: u16 = env::var("RDI_AGENT_API_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_AGENT_API_PORT);
    let mavlink_port: u16 = env::var("RDI_MAVLINK_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_MAVLINK_PORT);

    let sessions: SessionsState = Arc::new(RwLock::new(HashMap::new()));

    let app = Router::new()
        .route("/", get(health))
        .route("/health", get(health))
        .route("/sessions", post(add_session))
        .route("/sessions/:session_id", delete(remove_session))
        .with_state(sessions.clone());

    let addr = SocketAddr::from(([127, 0, 0, 1], api_port));
    info!("RDI agent daemon listening on http://{} (mavlink_port={})", addr, mavlink_port);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health() -> &'static str {
    "OK"
}

async fn add_session(
    State(sessions): State<SessionsState>,
    Json(body): Json<AddSessionBody>,
) -> (StatusCode, String) {
    let session_id = body.session_id.trim().to_string();
    let proxy_url = body.proxy_url.trim().to_string();
    if session_id.is_empty() || proxy_url.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            "session_id and proxy_url required".to_string(),
        );
    }

    let mavlink_host: String = body
        .mavlink_host
        .filter(|s| !s.is_empty())
        .or_else(|| env::var("RDI_MAVLINK_HOST").ok())
        .unwrap_or_else(|| "127.0.0.1".to_string());
    let mavlink_port: u16 = body
        .mavlink_port
        .or_else(|| env::var("RDI_MAVLINK_PORT").ok().and_then(|s| s.parse().ok()))
        .unwrap_or(DEFAULT_MAVLINK_PORT);
    let mavlink_addr = format!("{}:{}", mavlink_host, mavlink_port);

    let mut guard = sessions.write().await;
    if guard.contains_key(&session_id) {
        return (
            StatusCode::CONFLICT,
            format!("session {} already exists", session_id),
        );
    }

    let proxy_url_clone = proxy_url.clone();
    let session_id_clone = session_id.clone();
    let handle = tokio::spawn(async move {
        run_session_loop(&proxy_url_clone, &session_id_clone, &mavlink_addr).await;
    });
    guard.insert(session_id.clone(), handle);
    drop(guard);

    info!(
        "Added session session_id={} proxy_url={} (Wavelength EC2); WebSocket connection task started",
        session_id, proxy_url
    );
    (StatusCode::CREATED, format!("session {} added", session_id))
}

async fn remove_session(
    State(sessions): State<SessionsState>,
    Path(session_id): Path<String>,
) -> (StatusCode, String) {
    let session_id = session_id.trim().to_string();
    if session_id.is_empty() {
        return (StatusCode::BAD_REQUEST, "session_id required".to_string());
    }

    let mut guard = sessions.write().await;
    if let Some(handle) = guard.remove(&session_id) {
        handle.abort();
        drop(guard);
        info!("Removed session session_id={} (Wavelength EC2); WebSocket to proxy will close", session_id);
        (StatusCode::OK, format!("session {} removed", session_id))
    } else {
        drop(guard);
        (
            StatusCode::NOT_FOUND,
            format!("session {} not found", session_id),
        )
    }
}

/// Connect to proxy WebSocket. When RDI_INSECURE_TLS=1 and url is wss://, skips TLS cert verification (for staging self-signed).
async fn connect_to_proxy(
    proxy_url: &str,
) -> Result<
    tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    Box<dyn std::error::Error + Send + Sync>,
> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    let insecure_tls = std::env::var("RDI_INSECURE_TLS")
        .ok()
        .map(|s| {
            let s = s.to_lowercase();
            s == "1" || s == "true" || s == "yes"
        })
        .unwrap_or(false);

    let (stream, _) = if proxy_url.starts_with("wss://") && insecure_tls {
        info!("RDI_INSECURE_TLS=1: skipping TLS certificate verification (staging)");
        let tls = native_tls::TlsConnector::builder()
            .danger_accept_invalid_certs(true)
            .build()?;
        let connector = tokio_tungstenite::Connector::NativeTls(tls);
        let request = proxy_url
            .into_client_request()
            .map_err(|e| format!("Invalid URL: {}", e))?;
        tokio_tungstenite::connect_async_tls_with_config(
            request,
            None,
            true,  // disable_nagle: reduce PING/PONG and MAVLink latency variance
            Some(connector),
        )
        .await
        .map_err(|e| format!("WebSocket TLS connect failed: {}", e))?
    } else {
        tokio_tungstenite::connect_async(proxy_url)
            .await
            .map_err(|e| format!("WebSocket connect failed: {}", e))?
    };

    Ok(stream)
}

/// Run one session: connect to proxy, bridge WebSocket <-> UDP. Reconnects on disconnect until task is aborted.
async fn run_session_loop(
    proxy_url: &str,
    session_id: &str,
    mavlink_addr: &str,
) {
    loop {
        match run_session(proxy_url, session_id, mavlink_addr).await {
            Ok(()) => {}
            Err(e) => {
                error!("Session {} error: {}", session_id, e);
            }
        }
        warn!(
            "Disconnected session={}; reconnecting in {}s",
            session_id, RECONNECT_DELAY_SECS
        );
        tokio::time::sleep(Duration::from_secs(RECONNECT_DELAY_SECS)).await;
    }
}

async fn run_session(
    proxy_url: &str,
    session_id: &str,
    mavlink_addr: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    info!(
        "WebSocket opening url={} session_id={} (Wavelength EC2) -> mavlink {}",
        proxy_url, session_id, mavlink_addr
    );

    let ws_stream = connect_to_proxy(proxy_url).await?;
    let (mut ws_tx, mut ws_rx) = futures_util::StreamExt::split(ws_stream);
    info!(
        "WebSocket connected to proxy session_id={} (Wavelength EC2); sending handshake agent:{}",
        session_id, session_id
    );

    ws_tx
        .send(Message::Text(format!("agent:{}", session_id)))
        .await?;

    let udp = Arc::new(tokio::net::UdpSocket::bind("0.0.0.0:0").await?);
    let mavlink: std::net::SocketAddr = mavlink_addr.parse()?;

    let udp_recv = Arc::clone(&udp);
    let udp_send = Arc::clone(&udp);

    let (pong_tx, mut pong_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();

    let to_ws = tokio::spawn(async move {
        let mut buf = [0u8; 2048];
        loop {
            tokio::select! {
                result = udp_recv.recv_from(&mut buf) => {
                    match result {
                        Ok((len, _)) => {
                            if ws_tx.send(Message::Binary(buf[..len].to_vec())).await.is_err() {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
                pong = pong_rx.recv() => {
                    if let Some(data) = pong {
                        if ws_tx.send(Message::Binary(data)).await.is_err() {
                            break;
                        }
                    } else {
                        break;
                    }
                }
            }
        }
    });

    let to_udp = tokio::spawn(async move {
        while let Some(msg) = ws_rx.next().await {
            if let Ok(Message::Binary(data)) = msg {
                if data == PING_BYTES {
                    let _ = pong_tx.send(PONG_BYTES.to_vec());
                } else {
                    let _ = udp_send.send_to(&data, mavlink).await;
                }
            }
        }
    });

    tokio::select! { _ = to_ws => {} _ = to_udp => {} }
    Ok(())
}
