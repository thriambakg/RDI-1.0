//! Connection routing helper: resolve agent or frontend peer for a session.
//! Abstracts peer lookup so we can extend to outbound connections (e.g. ngrok Path 3) later.
//! For Path 1 (local) and Path 2 (sim): both agents connect in; lookup is from sessions map.

use tokio::sync::mpsc;

use crate::Sessions;

/// Resolve the agent's send channel for a session. Returns None if no agent connected.
pub fn resolve_agent_tx(
    sessions: &Sessions,
    session_id: &str,
) -> Option<mpsc::UnboundedSender<Vec<u8>>> {
    sessions
        .agents
        .get(session_id)
        .map(|(p, _)| p.tx.clone())
}

/// Resolve the frontend's send channel for a session. Returns None if no frontend connected.
pub fn resolve_frontend_tx(
    sessions: &Sessions,
    session_id: &str,
) -> Option<mpsc::UnboundedSender<Vec<u8>>> {
    sessions
        .frontends
        .get(session_id)
        .map(|(p, _)| p.tx.clone())
}
