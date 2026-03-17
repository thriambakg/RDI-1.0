//! Local sim of RDI agent. Same behavior as src/agent: HTTP API 8080 (POST/DELETE /sessions),
//! WebSocket to proxy with handshake "agent:session_id", PING/PONG bridge.
//! Lambda sim POSTs to http://127.0.0.1:8080/sessions with session_id + proxy_url.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{delete, get, post},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::WebSocketStream;
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
const DEFAULT_AGENT_WS_PORT: u16 = 8769;
const PING_BYTES: &[u8] = b"PING";
const PONG_BYTES: &[u8] = b"PONG";
const HEARTBEAT_BYTES: &[u8] = b"HEARTBEAT";
const HEARTBEAT_INTERVAL_SECS: u64 = 2;
#[allow(dead_code)]
const RECONNECT_DELAY_SECS: u64 = 5;

/// Pending session (waiting for proxy to connect) or connected with a handle.
#[derive(Default)]
struct AgentSessions {
    /// session_id -> mavlink_addr (waiting for proxy WebSocket)
    pending: HashMap<String, String>,
    /// session_id -> task handle (proxy connected)
    handles: HashMap<String, JoinHandle<()>>,
}

type AgentSessionsState = Arc<RwLock<AgentSessions>>;

#[derive(Deserialize)]
struct AddSessionBody {
    session_id: String,
    proxy_url: String,
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

    let sessions: AgentSessionsState = Arc::new(RwLock::new(AgentSessions::default()));

    let ws_port: u16 = env::var("RDI_AGENT_WS_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_AGENT_WS_PORT);

    let sessions_ws = sessions.clone();
    tokio::spawn(async move {
        let listener = match tokio::net::TcpListener::bind(format!("0.0.0.0:{}", ws_port)).await {
            Ok(l) => l,
            Err(e) => {
                error!("[sim_agent] WebSocket server bind port {} failed: {}", ws_port, e);
                return;
            }
        };
        info!("[sim_agent] WebSocket server listening on port {} (proxy connects here)", ws_port);
        loop {
            match listener.accept().await {
                Ok((stream, addr)) => {
                    let sessions = sessions_ws.clone();
                    tokio::spawn(async move {
                        if let Err(e) = accept_proxy_connection(stream, addr, sessions).await {
                            warn!("[sim_agent] proxy connection error: {}", e);
                        }
                    });
                }
                Err(e) => {
                    error!("[sim_agent] accept error: {}", e);
                }
            }
        }
    });

    let app = Router::new()
        .route("/", get(health))
        .route("/health", get(health))
        .route("/sessions", post(add_session))
        .route("/sessions/:session_id", delete(remove_session))
        .with_state(sessions.clone());

    let addr = SocketAddr::from(([127, 0, 0, 1], api_port));
    info!("[sim_agent] listening on http://{} (mavlink_port={}, ws_port={})", addr, mavlink_port, ws_port);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health() -> &'static str {
    "OK"
}

async fn add_session(
    State(sessions): State<AgentSessionsState>,
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

    let mavlink_port: u16 = env::var("RDI_MAVLINK_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_MAVLINK_PORT);
    let mavlink_addr = format!("127.0.0.1:{}", mavlink_port);

    let mut guard = sessions.write().await;
    if guard.pending.contains_key(&session_id) || guard.handles.contains_key(&session_id) {
        return (
            StatusCode::CONFLICT,
            format!("session {} already exists", session_id),
        );
    }
    guard.pending.insert(session_id.clone(), mavlink_addr);
    drop(guard);

    info!(
        "[sim_agent] Added session session_id={} (waiting for proxy to connect on WS port)",
        session_id
    );
    (StatusCode::CREATED, format!("session {} added", session_id))
}

async fn remove_session(
    State(sessions): State<AgentSessionsState>,
    Path(session_id): Path<String>,
) -> (StatusCode, String) {
    let session_id = session_id.trim().to_string();
    if session_id.is_empty() {
        return (StatusCode::BAD_REQUEST, "session_id required".to_string());
    }

    let mut guard = sessions.write().await;
    let had = guard.pending.remove(&session_id).is_some()
        || guard.handles.remove(&session_id).map(|h| {
            h.abort();
            true
        }).unwrap_or(false);
    drop(guard);
    if had {
        info!("[sim_agent] Removed session session_id={}", session_id);
        (StatusCode::OK, format!("session {} removed", session_id))
    } else {
        (
            StatusCode::NOT_FOUND,
            format!("session {} not found", session_id),
        )
    }
}

/// Accept an incoming WebSocket from the proxy; expect first message "proxy:session_id", then run session.
async fn accept_proxy_connection(
    stream: tokio::net::TcpStream,
    addr: std::net::SocketAddr,
    sessions: AgentSessionsState,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use tokio_tungstenite::accept_async;

    let ws_stream = accept_async(stream).await?;
    let (ws_tx, mut ws_rx) = ws_stream.split();

    let first = ws_rx.next().await;
    let session_id = match first {
        Some(Ok(Message::Text(t))) => {
            let p: Vec<&str> = t.splitn(2, ':').collect();
            let sid = p.get(1).unwrap_or(&"").to_string();
            if sid.is_empty() || p.get(0).map(|r| *r) != Some("proxy") {
                return Err("expected first message proxy:session_id".into());
            }
            sid
        }
        _ => return Err("expected text handshake proxy:session_id".into()),
    };

    let mavlink_addr = {
        let mut guard = sessions.write().await;
        guard.pending.remove(&session_id).ok_or("session not found or already connected")?
    };

    info!(
        "[sim_agent] Proxy connected session_id={} addr={}; running session (mavlink {})",
        session_id, addr, mavlink_addr
    );

    let session_id_owned = session_id.clone();
    let handle = tokio::spawn(async move {
        run_session_with_stream(ws_tx, ws_rx, session_id_owned, mavlink_addr).await;
    });

    {
        let mut guard = sessions.write().await;
        guard.handles.insert(session_id, handle);
    }

    Ok(())
}

type AgentWsStream = WebSocketStream<tokio::net::TcpStream>;

/// Run session over an already-connected WebSocket (proxy is the other side).
async fn run_session_with_stream(
    mut ws_tx: futures_util::stream::SplitSink<AgentWsStream, Message>,
    mut ws_rx: futures_util::stream::SplitStream<AgentWsStream>,
    session_id: String,
    mavlink_addr: String,
) {
    let mavlink: std::net::SocketAddr = match mavlink_addr.parse() {
        Ok(a) => a,
        Err(e) => {
            error!("[sim_agent] invalid mavlink_addr {}: {}", mavlink_addr, e);
            return;
        }
    };

    let udp = match tokio::net::UdpSocket::bind("0.0.0.0:0").await {
        Ok(s) => Arc::new(s),
        Err(e) => {
            error!("[sim_agent] UDP bind failed: {}", e);
            return;
        }
    };
    let udp_recv = Arc::clone(&udp);
    let udp_send = Arc::clone(&udp);

    let (pong_tx, mut pong_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();

    // Heartbeat disabled; PING/PONG uses the same proxy->agent connection.
    let session_id_ws = session_id.clone();
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
                        let _ = ws_tx.flush().await;
                        info!("[sim_agent] PONG sent on WebSocket session_id={}", session_id_ws);
                    } else {
                        break;
                    }
                }
            }
        }
    });

    let session_id_udp = session_id.clone();
    let to_udp = tokio::spawn(async move {
        while let Some(msg) = ws_rx.next().await {
            if let Ok(Message::Binary(data)) = msg {
                if data == PING_BYTES {
                    info!("[sim_agent] PING received, sending PONG session_id={}", session_id_udp);
                    let _ = pong_tx.send(PONG_BYTES.to_vec());
                } else if data != HEARTBEAT_BYTES {
                    let _ = udp_send.send_to(&data, mavlink).await;
                }
            }
        }
    });

    tokio::select! { _ = to_ws => {} _ = to_udp => {} }
}
