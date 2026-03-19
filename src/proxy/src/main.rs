//! RDI Proxy - Low-latency MAVLink relay for drone control.
//! Bridges WebSocket: frontend <-> agent (tunnel to local PX4/Gazebo).
//! Respects session status from Lambda: only active sessions are allowed;
//! idle sessions are disconnected and cleared from memory.

use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, RwLock};
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::Message;
use tracing::{error, info, warn};

const DEFAULT_WS_PORT: u16 = 8765;
const DEFAULT_HEALTH_PORT: u16 = 8766;
const DEFAULT_STATUS_PORT: u16 = 8767;

#[derive(Clone)]
struct Peer {
    tx: mpsc::UnboundedSender<Vec<u8>>,
}

/// Per-connection close signal: when sent, the WS handler exits and removes from Sessions.
type CloseTx = mpsc::Sender<()>;

#[derive(Default)]
struct Sessions {
    agents: HashMap<String, (Peer, CloseTx)>,
    frontends: HashMap<String, (Peer, CloseTx)>,
}

/// Session status from Lambda: active = allow traffic, idle = reject new and disconnect existing.
#[derive(Default)]
struct SessionStatusMap {
    map: HashMap<String, String>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let ws_port: u16 = std::env::var("RDI_PROXY_WS_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_WS_PORT);

    info!("Starting RDI proxy on port {}", ws_port);

    let health_port: u16 = std::env::var("RDI_PROXY_HEALTH_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_HEALTH_PORT);

    let status_port: u16 = std::env::var("RDI_PROXY_STATUS_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_STATUS_PORT);

    let status_secret = std::env::var("RDI_PROXY_STATUS_SECRET").unwrap_or_else(|_| String::new());

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", ws_port)).await?;
    let health_listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", health_port)).await?;
    info!("Health check on port {}", health_port);

    let sessions: Arc<RwLock<Sessions>> = Arc::new(RwLock::new(Sessions::default()));
    let status_map: Arc<RwLock<SessionStatusMap>> = Arc::new(RwLock::new(SessionStatusMap::default()));

    if !status_secret.is_empty() {
        let status_listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", status_port)).await?;
        info!("Session status API on port {} (Lambda instructions)", status_port);
        let sessions_for_status = sessions.clone();
        let status_map_for_status = status_map.clone();
        tokio::spawn(async move {
            loop {
                if let Ok((stream, _)) = status_listener.accept().await {
                    let sessions = sessions_for_status.clone();
                    let status_map = status_map_for_status.clone();
                    let secret = status_secret.clone();
                    tokio::spawn(async move {
                        let _ = serve_status(stream, sessions, status_map, &secret).await;
                    });
                }
            }
        });
    } else {
        warn!("RDI_PROXY_STATUS_SECRET not set; proxy will not accept Lambda status instructions");
    }

    tokio::spawn(async move {
        loop {
            if let Ok((stream, _)) = health_listener.accept().await {
                tokio::spawn(async move {
                    let _ = serve_health(stream).await;
                });
            }
        }
    });

    loop {
        let (stream, addr) = listener.accept().await?;
        let sessions = sessions.clone();
        let status_map = status_map.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_ws(stream, addr, sessions, status_map).await {
                warn!("Handler error {}: {}", addr, e);
            }
        });
    }
}

async fn serve_health(mut stream: tokio::net::TcpStream) -> std::io::Result<()> {
    let mut buf = [0u8; 1024];
    let _ = stream.read(&mut buf).await; // Read and discard request (ALB health check)
    let response = "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
    stream.write_all(response.as_bytes()).await
}

/// Handle POST /session-status from Lambda: { "session_id": "...", "status": "active"|"idle" }.
/// Header X-Proxy-Secret must match RDI_PROXY_STATUS_SECRET.
/// On idle: update status map, disconnect and remove that session from memory.
async fn serve_status(
    mut stream: tokio::net::TcpStream,
    sessions: Arc<RwLock<Sessions>>,
    status_map: Arc<RwLock<SessionStatusMap>>,
    expected_secret: &str,
) -> std::io::Result<()> {
    let mut buf = [0u8; 8192];
    let n = stream.read(&mut buf).await?;
    let req = String::from_utf8_lossy(&buf[..n]);
    let (first_line, rest) = req.split_once("\r\n").unwrap_or((&req, ""));
    let (method, path, _) = {
        let parts: Vec<&str> = first_line.splitn(3, ' ').collect();
        (
            parts.get(0).copied().unwrap_or(""),
            parts.get(1).copied().unwrap_or(""),
            parts.get(2).copied().unwrap_or(""),
        )
    };
    let header_lower = rest.to_lowercase();
    let content_length = header_lower
        .lines()
        .find(|l| l.starts_with("content-length:"))
        .and_then(|l| l.strip_prefix("content-length:").map(|s| s.trim().parse::<usize>().ok()))
        .flatten()
        .unwrap_or(0);
    let secret = header_lower
        .lines()
        .find(|l| l.starts_with("x-proxy-secret:"))
        .and_then(|l| l.strip_prefix("x-proxy-secret:").map(|s| s.trim()))
        .unwrap_or("");

    if method != "POST" || path != "/session-status" {
        let body = b"{\"error\":\"not found\"}";
        let resp = format!(
            "HTTP/1.1 404 Not Found\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        stream.write_all(resp.as_bytes()).await?;
        stream.write_all(body).await?;
        return Ok(());
    }
    if secret != expected_secret {
        let body = b"{\"error\":\"unauthorized\"}";
        let resp = format!(
            "HTTP/1.1 401 Unauthorized\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        stream.write_all(resp.as_bytes()).await?;
        stream.write_all(body).await?;
        return Ok(());
    }

    let body_start = req.find("\r\n\r\n").map(|i| i + 4).unwrap_or(n);
    let body_str = String::from_utf8_lossy(&buf[body_start..n.min(body_start + content_length)]);
    let body_trim = body_str.trim();
    let json = match serde_json::from_str::<serde_json::Value>(body_trim) {
        Ok(j) => j,
        Err(_) => {
            let body = b"{\"error\":\"invalid JSON\"}";
            let resp = format!(
                "HTTP/1.1 400 Bad Request\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(resp.as_bytes()).await?;
            stream.write_all(body).await?;
            return Ok(());
        }
    };
    let session_id = json.get("session_id").and_then(|v| v.as_str()).map(String::from);
    let status = json.get("status").and_then(|v| v.as_str()).map(String::from);

    let (session_id, status) = match (session_id, status) {
        (Some(sid), Some(st)) if st == "active" || st == "idle" => (sid, st),
        _ => {
            let body = b"{\"error\":\"bad request: session_id and status (active|idle) required\"}";
            let resp = format!(
                "HTTP/1.1 400 Bad Request\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(resp.as_bytes()).await?;
            stream.write_all(body).await?;
            return Ok(());
        }
    };

    {
        let mut m = status_map.write().await;
        m.map.insert(session_id.clone(), status.clone());
    }

    if status == "idle" {
        let (agent_tx, frontend_tx) = {
            let mut s = sessions.write().await;
            let at = s.agents.remove(&session_id).map(|(_, tx)| tx);
            let ft = s.frontends.remove(&session_id).map(|(_, tx)| tx);
            (at, ft)
        };
        let _ = agent_tx.map(|tx| tx.try_send(()));
        let _ = frontend_tx.map(|tx| tx.try_send(()));
        info!("Session {} set to idle; connections cleared", session_id);
    }

    let body = b"{\"ok\":true}";
    let resp = format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(resp.as_bytes()).await?;
    stream.write_all(body).await?;
    Ok(())
}

/// Message to send to the client: binary, text, or WebSocket Pong (for ALB keepalive).
enum ToClient {
    Binary(Vec<u8>),
    Text(String),
    Pong(Vec<u8>),
}

const PING_BYTES: &[u8] = b"PING";

async fn handle_ws(
    stream: tokio::net::TcpStream,
    addr: std::net::SocketAddr,
    sessions: Arc<RwLock<Sessions>>,
    status_map: Arc<RwLock<SessionStatusMap>>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let ws = accept_async(stream).await?;
    let (mut ws_tx, mut ws_rx) = ws.split();

    let first = ws_rx.next().await;
    let (session_id, role) = match first {
        Some(Ok(Message::Text(t))) => {
            let p: Vec<&str> = t.splitn(2, ':').collect();
            (p.get(1).unwrap_or(&"default").to_string(), p.get(0).unwrap_or(&"frontend").to_string())
        }
        _ => ("default".to_string(), "frontend".to_string()),
    };
    info!(
        "WebSocket handshake session_id={} role={} addr={} (proxy_ec2)",
        session_id, role, addr
    );

    // Reject connections for sessions Lambda has marked idle (only active allowed).
    {
        let m = status_map.read().await;
        if m.map.get(&session_id).map(|s| s.as_str()) == Some("idle") {
            let _ = ws_tx
                .send(Message::Text(
                    r#"{"error":"session idle","message":"Reactivate in console to connect"}"#.to_string(),
                ))
                .await;
            let _ = ws_tx.send(Message::Close(None)).await;
            info!("Rejected {} {} (session idle)", addr, session_id);
            return Ok(());
        }
    }

    let (close_tx, mut close_rx) = mpsc::channel::<()>(1);
    let (peer_tx, mut peer_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let peer = Peer { tx: peer_tx.clone() };

    let (client_tx, mut client_rx) = mpsc::unbounded_channel::<ToClient>();

    let client_tx_peer = client_tx.clone();
    let client_tx_pong = client_tx.clone();

    {
        let mut s = sessions.write().await;
        if role == "agent" {
            let had_frontend = s.frontends.contains_key(&session_id);
            info!(
                "Agent WebSocket connected session_id={} addr={} (Wavelength EC2) frontend_already_connected={}",
                session_id, addr, had_frontend
            );
            s.agents.insert(session_id.clone(), (peer, close_tx));
            if had_frontend {
                info!("Session {} pairing complete: frontend + agent both connected (proxy_ec2)", session_id);
            }
        } else {
            let had_agent = s.agents.contains_key(&session_id);
            info!(
                "Frontend WebSocket connected session_id={} addr={} (browser) agent_already_connected={}",
                session_id, addr, had_agent
            );
            s.frontends.insert(session_id.clone(), (peer, close_tx));
            let _ = client_tx.send(ToClient::Text(
                r#"{"hop":"proxy_ec2","message":"handshake accepted"}"#.to_string(),
            ));
            if had_agent {
                info!("Session {} pairing complete: frontend + agent both connected (proxy_ec2)", session_id);
            }
        }
    }

    let to_ws = tokio::spawn(async move {
        while let Some(to_client) = client_rx.recv().await {
            let msg = match to_client {
                ToClient::Binary(data) => Message::Binary(data),
                ToClient::Text(s) => Message::Text(s),
                ToClient::Pong(data) => Message::Pong(data),
            };
            if ws_tx.send(msg).await.is_err() {
                break;
            }
        }
    });

    // Look up peer at send time so PONG from agent reaches frontend even when frontend connects after agent.
    let sessions_for_peer = sessions.clone();
    let session_id_for_peer = session_id.clone();
    let role_for_peer = role.clone();
    let to_peer = tokio::spawn(async move {
        while let Some(msg) = ws_rx.next().await {
            match msg {
                Ok(Message::Binary(data)) => {
                    if data == PING_BYTES {
                        // Frontend sent PING: forward to agent (or reply no agent).
                        let peer_tx = sessions_for_peer.read().await.agents.get(&session_id_for_peer).map(|(p, _)| p.tx.clone());
                        if let Some(tx) = peer_tx {
                            info!("PING received session_id={} forwarding to agent", session_id_for_peer);
                            let _ = tx.send(data.to_vec());
                        } else {
                            let ts_ms = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|d| d.as_millis())
                                .unwrap_or(0);
                            info!("PING received session_id={} no agent; replying proxy ping_ack", session_id_for_peer);
                            let _ = client_tx_peer.send(ToClient::Text(format!(
                                r#"{{"hop":"proxy","type":"ping_ack","server_ts_ms":{},"message":"Proxy responded (no agent)"}}"#,
                                ts_ms
                            )));
                        }
                    } else if role_for_peer == "agent" {
                        // Agent sent binary (e.g. PONG): forward to frontend.
                        let peer_tx = sessions_for_peer.read().await.frontends.get(&session_id_for_peer).map(|(p, _)| p.tx.clone());
                        if let Some(tx) = peer_tx {
                            let _ = tx.send(data);
                        }
                    } else {
                        // Frontend sent other binary (e.g. MAVLink): forward to agent.
                        let peer_tx = sessions_for_peer.read().await.agents.get(&session_id_for_peer).map(|(p, _)| p.tx.clone());
                        if let Some(tx) = peer_tx {
                            let _ = tx.send(data);
                        }
                    }
                }
                Ok(Message::Text(_)) => {}
                Ok(Message::Ping(data)) => {
                    let _ = client_tx_peer.send(ToClient::Pong(data.to_vec()));
                }
                Ok(Message::Close(_)) => break,
                Err(e) => {
                    error!("recv: {}", e);
                    break;
                }
                _ => {}
            }
        }
    });

    // Only the frontend connection should send "instance responded" when it receives PONG from the agent.
    // The agent connection's to_pong receives PING (from frontend) and must only forward Binary(PING) to the agent.
    let role_pong = role.clone();
    let session_id_pong = session_id.clone();
    let to_pong = tokio::spawn(async move {
        let mut sent_wavelength = false;
        while let Some(data) = peer_rx.recv().await {
            if role_pong == "frontend" && !sent_wavelength {
                info!("PING round-trip complete session_id={} agent responded", session_id_pong);
                let _ = client_tx_pong.send(ToClient::Text(
                    r#"{"hop":"wavelength","message":"instance responded"}"#.to_string(),
                ));
                sent_wavelength = true;
            }
            let _ = client_tx_pong.send(ToClient::Binary(data));
        }
    });

    tokio::select! {
        _ = to_ws => {}
        _ = to_peer => {}
        _ = to_pong => {}
        _ = close_rx.recv() => {
            info!("Session {} closed by Lambda (idle)", session_id);
        }
    }

    let mut s = sessions.write().await;
    if role == "agent" {
        s.agents.remove(&session_id);
        info!("Agent WebSocket disconnected session_id={} addr={} (Wavelength EC2)", session_id, addr);
    } else {
        s.frontends.remove(&session_id);
        info!("Frontend WebSocket disconnected session_id={} addr={} (browser)", session_id, addr);
    }
    Ok(())
}
