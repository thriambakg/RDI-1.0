//! RDI Agent - Bridges proxy WebSocket to local PX4 (localhost:14540).
//! Run on your machine with PX4 + Gazebo. Connects outbound to proxy.

use futures_util::{SinkExt, StreamExt};
use std::env;
use tokio_tungstenite::tungstenite::Message;
use tracing::info;

const DEFAULT_MAVLINK_PORT: u16 = 14540;
/// Proxy sends this; we reply with PONG so round-trip works without PX4.
const PING_BYTES: &[u8] = b"PING";
const PONG_BYTES: &[u8] = b"PONG";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let proxy_url = env::var("RDI_PROXY_URL").expect("RDI_PROXY_URL required (e.g. ws://proxy-ip:8765)");
    let session_id = env::var("RDI_SESSION_ID").unwrap_or_else(|_| "default".to_string());
    let mavlink_port: u16 = env::var("RDI_MAVLINK_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_MAVLINK_PORT);

    let mavlink_addr = format!("127.0.0.1:{}", mavlink_port);
    info!("Connecting to {} session={} -> {}", proxy_url, session_id, mavlink_addr);

    let (ws_stream, _) = tokio_tungstenite::connect_async(&proxy_url).await?;
    let (mut ws_tx, mut ws_rx) = ws_stream.split();

    ws_tx
        .send(tokio_tungstenite::tungstenite::Message::Text(format!("agent:{}", session_id)))
        .await?;

    let udp = tokio::net::UdpSocket::bind("0.0.0.0:0").await?;
    let mavlink: std::net::SocketAddr = mavlink_addr.parse()?;

    let udp_recv = udp.clone();
    let udp_send = udp.clone();

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
</think>
Reconsidering: keeping the original structure and adding a channel so the UDP→WS task can send PONG.
<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>
Read
    Ok(())
}
