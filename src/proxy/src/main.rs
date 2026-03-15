//! RDI Proxy - Low-latency MAVLink relay for drone control.
//! Bridges WebSocket: frontend <-> agent (tunnel to local PX4/Gazebo).

use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::AsyncWriteExt;
use tokio::sync::{mpsc, RwLock};
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::Message;
use tracing::{error, info, warn};

const DEFAULT_WS_PORT: u16 = 8765;
const DEFAULT_HEALTH_PORT: u16 = 8766;

#[derive(Clone)]
struct Peer {
    tx: mpsc::UnboundedSender<Vec<u8>>,
}

#[derive(Default)]
struct Sessions {
    agents: HashMap<String, Peer>,
    frontends: HashMap<String, Peer>,
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

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", ws_port)).await?;
    let health_listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", health_port)).await?;
    info!("Health check on port {}", health_port);

    let sessions: Arc<RwLock<Sessions>> = Arc::new(RwLock::new(Sessions::default()));

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
        tokio::spawn(async move {
            if let Err(e) = handle_ws(stream, addr, sessions).await {
                warn!("Handler error {}: {}", addr, e);
            }
        });
    }
}

async fn serve_health(mut stream: tokio::net::TcpStream) -> std::io::Result<()> {
    let response = "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
    stream.write_all(response.as_bytes()).await
}

/// Message to send to the client: either binary from agent or control (e.g. ping hop).
enum ToClient {
    Binary(Vec<u8>),
    Text(String),
}

const PING_BYTES: &[u8] = b"PING";

async fn handle_ws(
    stream: tokio::net::TcpStream,
    addr: std::net::SocketAddr,
    sessions: Arc<RwLock<Sessions>>,
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

    let (peer_tx, mut peer_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let peer = Peer { tx: peer_tx.clone() };

    let (client_tx, mut client_rx) = mpsc::unbounded_channel::<ToClient>();

    let client_tx_peer = client_tx.clone();
    let client_tx_pong = client_tx.clone();

    let peer_send = {
        let mut s = sessions.write().await;
        let target = if role == "agent" {
            s.agents.insert(session_id.clone(), peer);
            s.frontends.get(&session_id).map(|p| p.tx.clone())
        } else {
            s.frontends.insert(session_id.clone(), peer);
            let _ = client_tx.send(ToClient::Text(
                r#"{"hop":"proxy_ec2","message":"handshake accepted"}"#.to_string(),
            ));
            s.agents.get(&session_id).map(|p| p.tx.clone())
        };
        target
    };

    let to_ws = tokio::spawn(async move {
        while let Some(to_client) = client_rx.recv().await {
            let msg = match to_client {
                ToClient::Binary(data) => Message::Binary(data),
                ToClient::Text(s) => Message::Text(s),
            };
            if ws_tx.send(msg).await.is_err() {
                break;
            }
        }
    });

    let to_peer = tokio::spawn(async move {
        while let Some(msg) = ws_rx.next().await {
            match msg {
                Ok(Message::Binary(data)) => {
                    if data == PING_BYTES {
                        if let Some(tx) = &peer_send {
                            let _ = tx.send(data.to_vec());
                        } else {
                            let _ = client_tx_peer.send(ToClient::Text(
                                r#"{"hop":"wavelength","message":"no agent connected"}"#.to_string(),
                            ));
                        }
                    } else if let Some(tx) = &peer_send {
                        let _ = tx.send(data);
                    }
                }
                Ok(Message::Text(_)) => {}
                Ok(Message::Close(_)) => break,
                Err(e) => {
                    error!("recv: {}", e);
                    break;
                }
                _ => {}
            }
        }
    });

    let to_pong = tokio::spawn(async move {
        let mut sent_wavelength = false;
        while let Some(data) = peer_rx.recv().await {
            if !sent_wavelength {
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
    }

    let mut s = sessions.write().await;
    if role == "agent" {
        s.agents.remove(&session_id);
    } else {
        s.frontends.remove(&session_id);
    }
    info!("Disconnected {} {}", addr, session_id);
    Ok(())
}
