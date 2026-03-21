//! Local sim of RDI proxy. Same behavior as src/proxy: WS 8765, health 8766, status API 8767.
//! Lambda sim POSTs to 8767; agent sim connects WS to 8765 with handshake "agent:session_id".

use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, RwLock};
use tokio_tungstenite::{accept_async, connect_async};
use tokio_tungstenite::tungstenite::Message;
use tracing::{error, info, trace, warn};

const DEFAULT_WS_PORT: u16 = 8765;
const DEFAULT_HEALTH_PORT: u16 = 8766;
const DEFAULT_STATUS_PORT: u16 = 8767;

#[derive(Clone)]
struct Peer {
    tx: mpsc::UnboundedSender<Vec<u8>>,
}

type CloseTx = mpsc::Sender<()>;

#[derive(Default)]
struct Sessions {
    agents: HashMap<String, (Peer, CloseTx)>,
    frontends: HashMap<String, (Peer, CloseTx)>,
}

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
    let health_port: u16 = std::env::var("RDI_PROXY_HEALTH_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_HEALTH_PORT);
    let status_port: u16 = std::env::var("RDI_PROXY_STATUS_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_STATUS_PORT);
    let status_secret = std::env::var("RDI_PROXY_STATUS_SECRET").unwrap_or_else(|_| "sim-secret".to_string());

    info!("[sim_proxy] WS port {} health {} status {}", ws_port, health_port, status_port);

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", ws_port)).await?;
    let health_listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", health_port)).await?;

    let sessions: Arc<RwLock<Sessions>> = Arc::new(RwLock::new(Sessions::default()));
    let status_map: Arc<RwLock<SessionStatusMap>> = Arc::new(RwLock::new(SessionStatusMap::default()));

    let status_listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", status_port)).await?;
    let sessions_for_status = sessions.clone();
    let status_map_for_status = status_map.clone();
    let secret = status_secret.clone();
    tokio::spawn(async move {
        loop {
            if let Ok((stream, _)) = status_listener.accept().await {
                let s = sessions_for_status.clone();
                let m = status_map_for_status.clone();
                let sec = secret.clone();
                tokio::spawn(async move { let _ = serve_status(stream, s, m, &sec).await; });
            }
        }
    });

    tokio::spawn(async move {
        loop {
            if let Ok((stream, _)) = health_listener.accept().await {
                tokio::spawn(async move { let _ = serve_health(stream).await; });
            }
        }
    });

    loop {
        let (stream, addr) = listener.accept().await?;
        let sessions = sessions.clone();
        let status_map = status_map.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_ws(stream, addr, sessions, status_map).await {
                warn!("[sim_proxy] handler error {}: {}", addr, e);
            }
        });
    }
}

async fn serve_health(mut stream: tokio::net::TcpStream) -> std::io::Result<()> {
    let response = "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
    stream.write_all(response.as_bytes()).await
}

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
        let resp = format!("HTTP/1.1 404 Not Found\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
        stream.write_all(resp.as_bytes()).await?;
        stream.write_all(body).await?;
        return Ok(());
    }
    if secret != expected_secret {
        let body = b"{\"error\":\"unauthorized\"}";
        let resp = format!("HTTP/1.1 401 Unauthorized\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
        stream.write_all(resp.as_bytes()).await?;
        stream.write_all(body).await?;
        return Ok(());
    }

    let body_start = req.find("\r\n\r\n").map(|i| i + 4).unwrap_or(n);
    let body_str = String::from_utf8_lossy(&buf[body_start..n.min(body_start + content_length)]);
    let json = match serde_json::from_str::<serde_json::Value>(body_str.trim()) {
        Ok(j) => j,
        Err(_) => {
            let body = b"{\"error\":\"invalid JSON\"}";
            stream.write_all(format!("HTTP/1.1 400 Bad Request\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes()).await?;
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
            stream.write_all(format!("HTTP/1.1 400 Bad Request\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes()).await?;
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
        info!("[sim_proxy] Session {} set to idle; connections cleared", session_id);
    } else if status == "active" {
        let agent_ws_url = std::env::var("AGENT_WS_URL").unwrap_or_else(|_| "ws://127.0.0.1:8769".to_string());
        let sessions_conn = sessions.clone();
        let session_id_conn = session_id.clone();
        tokio::spawn(async move {
            if let Err(e) = connect_to_agent(&session_id_conn, &agent_ws_url, sessions_conn).await {
                warn!("[sim_proxy] connect_to_agent session_id={} error={}", session_id_conn, e);
            }
        });
    }

    let body = b"{\"ok\":true}";
    stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes()).await?;
    stream.write_all(body).await?;
    Ok(())
}

enum ToClient {
    Binary(Vec<u8>),
    Text(String),
}

const PING_BYTES: &[u8] = b"PING";
const PONG_BYTES: &[u8] = b"PONG";
const HEARTBEAT_BYTES: &[u8] = b"HEARTBEAT";
/// Interval for proxy→frontend heartbeat (text JSON) when session is connected.
const PROXY_HEARTBEAT_INTERVAL_SECS: u64 = 5;

/// Proxy initiates WebSocket connection to the agent (same session model as frontend->proxy).
async fn connect_to_agent(
    session_id: &str,
    agent_ws_url: &str,
    sessions: Arc<RwLock<Sessions>>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    info!("[sim_proxy] Connecting to agent session_id={} url={}", session_id, agent_ws_url);
    let (ws_stream, _) = connect_async(agent_ws_url).await?;
    let (mut ws_tx, ws_rx) = ws_stream.split();
    ws_tx
        .send(Message::Text(format!("proxy:{}", session_id)))
        .await?;
    let _ = ws_tx.flush().await;
    info!("[sim_proxy] Connected to agent session_id={}; handshake sent", session_id);
    run_agent_connection(ws_tx, ws_rx, session_id.to_string(), sessions).await;
    Ok(())
}

/// Run the agent-side session (proxy initiated the connection to agent).
async fn run_agent_connection(
    mut ws_tx: futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
        Message,
    >,
    mut ws_rx: futures_util::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    >,
    session_id: String,
    sessions: Arc<RwLock<Sessions>>,
) {
    let (close_tx, mut close_rx) = mpsc::channel::<()>(1);
    let (peer_tx, mut peer_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let peer = Peer { tx: peer_tx.clone() };

    let (client_tx, mut client_rx) = mpsc::unbounded_channel::<ToClient>();
    let client_tx_peer = client_tx.clone();
    let client_tx_pong = client_tx.clone();

    {
        let mut s = sessions.write().await;
        let had_frontend = s.frontends.contains_key(&session_id);
        info!(
            "[sim_proxy] Agent connection (proxy->agent) session_id={} frontend_already={}",
            session_id, had_frontend
        );
        s.agents.insert(session_id.clone(), (peer, close_tx));
        if had_frontend {
            info!("[sim_proxy] Session {} pairing complete", session_id);
        }
    }

    // Look up frontend peer at send time so PONG reaches frontend even when frontend connects after agent.
    let sessions_for_peer = sessions.clone();
    let session_id_for_peer = session_id.clone();
    let to_ws_and_peer = tokio::spawn(async move {
        loop {
            tokio::select! {
                biased; // prefer first branch when both ready — drain PONG before sending more
                msg_opt = ws_rx.next() => {
                    let msg = match msg_opt {
                        Some(m) => m,
                        None => break,
                    };
                    match msg {
                        Ok(Message::Binary(data)) => {
                            let is_pong = data.as_slice() == PONG_BYTES;
                            if is_pong {
                                info!("[sim_proxy] Agent connection received PONG from agent, forwarding to frontend session_id={}", session_id_for_peer);
                            } else {
                                trace!("[sim_proxy] Agent connection received binary {} bytes session_id={}", data.len(), session_id_for_peer);
                            }
                            if data.as_slice() == PING_BYTES {
                                let peer_tx = sessions_for_peer.read().await.frontends.get(&session_id_for_peer).map(|(p, _)| p.tx.clone());
                                if let Some(tx) = peer_tx {
                                    if let Err(e) = tx.send(data.to_vec()) {
                                        error!("[sim_proxy] send to frontend peer_tx failed session_id={} err={}", session_id_for_peer, e);
                                    }
                                } else {
                                    let _ = client_tx_peer.send(ToClient::Text(r#"{"hop":"wavelength","message":"no agent connected"}"#.to_string()));
                                }
                            } else {
                                let peer_tx = sessions_for_peer.read().await.frontends.get(&session_id_for_peer).map(|(p, _)| p.tx.clone());
                                if let Some(tx) = peer_tx {
                                    let _ = tx.send(data);
                                }
                            }
                        }
                        Ok(Message::Text(_)) => {}
                        Ok(Message::Close(_)) => break,
                        Err(e) => {
                            error!("[sim_proxy] recv: {}", e);
                            break;
                        }
                        _ => {}
                    }
                }
                to_client = client_rx.recv() => {
                    match to_client {
                        Some(tc) => {
                            let msg = match tc {
                                ToClient::Binary(data) => Message::Binary(data),
                                ToClient::Text(s) => Message::Text(s),
                            };
                            if ws_tx.send(msg).await.is_err() {
                                break;
                            }
                            let _ = ws_tx.flush().await;
                        }
                        None => break,
                    }
                }
            }
        }
    });

    let session_id_pong = session_id.clone();
    let to_pong = tokio::spawn(async move {
        while let Some(data) = peer_rx.recv().await {
            if data == PING_BYTES {
                info!("[sim_proxy] Agent connection forwarding PING to agent WebSocket session_id={}", session_id_pong);
            }
            let _ = client_tx_pong.send(ToClient::Binary(data));
        }
    });

    tokio::select! {
        _ = to_ws_and_peer => {}
        _ = to_pong => {}
        _ = close_rx.recv() => { info!("[sim_proxy] Session {} closed (idle)", session_id); }
    }

    let mut s = sessions.write().await;
    s.agents.remove(&session_id);
    info!("[sim_proxy] Agent disconnected session_id={}", session_id);
}

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
    info!("[sim_proxy] WebSocket handshake session_id={} role={} addr={}", session_id, role, addr);

    {
        let m = status_map.read().await;
        if m.map.get(&session_id).map(|s| s.as_str()) == Some("idle") {
            let _ = ws_tx.send(Message::Text(r#"{"error":"session idle","message":"Reactivate in console to connect"}"#.to_string())).await;
            let _ = ws_tx.send(Message::Close(None)).await;
            info!("[sim_proxy] Rejected {} {} (session idle)", addr, session_id);
            return Ok(());
        }
    }

    let (close_tx, mut close_rx) = mpsc::channel::<()>(1);
    let (peer_tx, mut peer_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let peer = Peer { tx: peer_tx.clone() };

    let (client_tx, mut client_rx) = mpsc::unbounded_channel::<ToClient>();
    let client_tx_peer = client_tx.clone();
    let client_tx_pong = client_tx.clone();
    let client_tx_heartbeat = client_tx.clone();

    let peer_send = {
        let mut s = sessions.write().await;
        let target = if role == "agent" {
            let had_frontend = s.frontends.contains_key(&session_id);
            info!("[sim_proxy] Agent connected session_id={} addr={} frontend_already={}", session_id, addr, had_frontend);
            s.agents.insert(session_id.clone(), (peer, close_tx));
            if had_frontend {
                info!("[sim_proxy] Session {} pairing complete", session_id);
            }
            s.frontends.get(&session_id).map(|(p, _)| p.tx.clone())
        } else {
            let had_agent = s.agents.contains_key(&session_id);
            info!("[sim_proxy] Frontend connected session_id={} addr={} agent_already={}", session_id, addr, had_agent);
            s.frontends.insert(session_id.clone(), (peer, close_tx));
            let _ = client_tx.send(ToClient::Text(r#"{"hop":"proxy_ec2","message":"handshake accepted"}"#.to_string()));
            if had_agent {
                info!("[sim_proxy] Session {} pairing complete", session_id);
            }
            s.agents.get(&session_id).map(|(p, _)| p.tx.clone())
        };
        target
    };

    // Dedicated task that only reads from WebSocket so the stream is always polled (fixes agent PONG not being read).
    let (ws_msg_tx, mut ws_msg_rx) = mpsc::unbounded_channel();
    let _ws_reader = tokio::spawn(async move {
        while let Some(msg) = ws_rx.next().await {
            if ws_msg_tx.send(Some(msg)).is_err() {
                break;
            }
        }
        let _ = ws_msg_tx.send(None);
    });

    // When frontend is connected, prefer sending to client (client_rx) so agent responses and heartbeats are not starved.
    let session_id_for_peer = session_id.clone();
    let role_for_peer = role.clone();
    let to_ws_and_peer = tokio::spawn(async move {
        loop {
            tokio::select! {
                biased;
                to_client = client_rx.recv() => {
                    match to_client {
                        Some(tc) => {
                            if role_for_peer == "frontend" {
                                if let ToClient::Text(ref s) = &tc {
                                    if s.contains("instance responded") {
                                        info!("[sim_proxy] Frontend connection sending instance responded to client session_id={}", session_id_for_peer);
                                    }
                                }
                            }
                            let msg = match tc {
                                ToClient::Binary(data) => Message::Binary(data),
                                ToClient::Text(s) => Message::Text(s),
                            };
                            if ws_tx.send(msg).await.is_err() {
                                break;
                            }
                            let _ = ws_tx.flush().await;
                        }
                        None => break,
                    }
                }
                msg_opt = ws_msg_rx.recv() => {
                    let msg = match msg_opt {
                        Some(Some(m)) => m,
                        Some(None) | None => break,
                    };
                    match msg {
                        Ok(Message::Binary(data)) => {
                            if data == PING_BYTES {
                                if let Some(tx) = &peer_send {
                                    info!("[sim_proxy] PING session_id={} -> agent", session_id_for_peer);
                                    if let Err(e) = tx.send(data.to_vec()) {
                                        error!("[sim_proxy] send to agent peer_tx failed (receiver dropped?) session_id={} err={}", session_id_for_peer, e);
                                    }
                                } else {
                                    let _ = client_tx_peer.send(ToClient::Text(r#"{"hop":"wavelength","message":"no agent connected"}"#.to_string()));
                                }
                            } else if let Some(tx) = &peer_send {
                                if role_for_peer == "agent" {
                                    if data == PONG_BYTES {
                                        info!("[sim_proxy] Agent connection received PONG from agent, forwarding to frontend session_id={}", session_id_for_peer);
                                    } else if data == HEARTBEAT_BYTES {
                                        info!("[sim_proxy] Agent HEARTBEAT received session_id={}", session_id_for_peer);
                                    }
                                }
                                let _ = tx.send(data);
                            }
                        }
                        Ok(Message::Text(_)) => {}
                        Ok(Message::Close(_)) => break,
                        Err(e) => {
                            error!("[sim_proxy] recv: {}", e);
                            break;
                        }
                        _ => {}
                    }
                }
            }
        }
    });

    // Proxy→frontend heartbeat: when a frontend is connected, send periodic heartbeat so the frontend can show connection is alive.
    if role == "frontend" {
        let session_id_hb = session_id.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(PROXY_HEARTBEAT_INTERVAL_SECS));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                let ts = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0);
                let payload = format!(r#"{{"hop":"proxy_ec2","message":"heartbeat","ts":{}}}"#, ts);
                if client_tx_heartbeat.send(ToClient::Text(payload)).is_err() {
                    break;
                }
                trace!("[sim_proxy] Heartbeat sent to frontend session_id={}", session_id_hb);
            }
        });
    }

    // Only the frontend connection should send "instance responded" when it receives PONG from the agent.
    // The agent connection's to_pong receives PING (from frontend) and must only forward Binary(PING) to the agent.
    let role_pong = role.clone();
    let session_id_pong = session_id.clone();
    if role == "agent" {
        info!("[sim_proxy] Agent connection spawning to_pong for session_id={}", session_id_pong);
    }
    let to_pong = tokio::spawn(async move {
        let mut sent = false;
        while let Some(data) = peer_rx.recv().await {
            if role_pong == "agent" {
                info!("[sim_proxy] Agent connection to_pong received {} bytes session_id={}", data.len(), session_id_pong);
                if data == PING_BYTES {
                    info!("[sim_proxy] Agent connection forwarding PING to agent WebSocket session_id={}", session_id_pong);
                }
            }
            if role_pong == "frontend" {
                if !sent {
                    info!("[sim_proxy] PING round-trip session_id={} (frontend to_pong sending instance responded)", session_id_pong);
                    let _ = client_tx_pong.send(ToClient::Text(r#"{"hop":"wavelength","message":"instance responded"}"#.to_string()));
                    sent = true;
                }
                if data == PONG_BYTES {
                    info!("[sim_proxy] Frontend to_pong received PONG, forwarding to frontend WebSocket session_id={}", session_id_pong);
                }
            }
            let _ = client_tx_pong.send(ToClient::Binary(data));
        }
    });

    tokio::select! {
        _ = to_ws_and_peer => {}
        _ = to_pong => {}
        _ = close_rx.recv() => { info!("[sim_proxy] Session {} closed (idle)", session_id); }
    }

    let mut s = sessions.write().await;
    if role == "agent" {
        s.agents.remove(&session_id);
        info!("[sim_proxy] Agent disconnected session_id={} addr={}", session_id, addr);
    } else {
        s.frontends.remove(&session_id);
        info!("[sim_proxy] Frontend disconnected session_id={} addr={}", session_id, addr);
    }
    Ok(())
}
