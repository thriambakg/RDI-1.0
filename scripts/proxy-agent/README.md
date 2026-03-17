# Proxy–Agent End-to-End Sim (Local)

Simulates the full connection flow between **Lambda**, **proxy** (EC2), and **Wavelength agent** using the same logic as production. All interaction is via the terminal.

## Resources (mirrors)

| Sim        | Real resource        | Language | Ports / behavior |
|-----------|----------------------|----------|-------------------|
| `sim_proxy`  | `src/proxy` (RDI proxy EC2) | Rust     | 8765 WS, 8766 health, 8767 status API |
| `sim_agent`  | `src/agent` (Wavelength agent) | Rust     | 8080 HTTP API, WebSocket to proxy |
| `sim_lambda.py` | Session API Lambda (notify + agent add) | Python   | HTTP to proxy 8767 and agent 8080 |
| `sim_frontend.py` | Browser WebSocket client | Python   | Connects to 8765, keeps session open, **ping** (round-trip like main app) |

## Prerequisites

- **Rust** (for proxy and agent sims): `cargo build --release` in `sim_proxy` and `sim_agent`
- **Python 3** (for Lambda and frontend sims): no extra deps for `sim_lambda.py`; `pip install websockets` for `sim_frontend.py`

## Terminal workflow

Use **three terminals** (or run proxy and agent in the background).

### 1. Start the proxy (sim EC2 proxy)

```bash
cd scripts/proxy-agent/sim_proxy
cargo run
# Or: RDI_PROXY_STATUS_SECRET=sim-secret cargo run
```

Leave this running. It listens on:

- **8765** – WebSocket (frontend + agent)
- **8766** – Health
- **8767** – Status API (Lambda POST `session-status`)

### 2. Start the agent (sim Wavelength agent)

```bash
cd scripts/proxy-agent/sim_agent
cargo run
```

Leave this running. It listens on **8080** (POST/DELETE `/sessions`) and will open a WebSocket to the proxy when a session is added.

### 3. Run the Lambda sim (register session)

In a **third** terminal:

```bash
cd scripts/proxy-agent
python sim_lambda.py --proxy-status-secret sim-secret
# Or with explicit URLs (defaults are localhost):
# python sim_lambda.py --proxy-status-url http://127.0.0.1:8767/session-status \
#   --proxy-status-secret sim-secret --agent-url http://127.0.0.1:8080 \
#   --proxy-ws-url ws://127.0.0.1:8765
```

This will:

1. POST to `http://127.0.0.1:8767/session-status` with `session_id` and `status=active` (and `X-Proxy-Secret`).
2. POST to `http://127.0.0.1:8080/sessions` with `session_id` and `proxy_url=ws://127.0.0.1:8765`.

It prints a **session_id** (e.g. `session_id=ba427b51-...`). Use that for the frontend sim.

### 4. Run the frontend sim (with ping)

```bash
pip install websockets   # if needed
python sim_frontend.py <SESSION_ID>
# Example: python sim_frontend.py ba427b51-6430-4d9d-910b-b856a5c3e958
```

This opens a WebSocket, sends `frontend:<SESSION_ID>`, keeps the session open, and prompts **Press Enter to ping (q=quit)**. Each ping:

- Sends binary `PING` (same as main project).
- Prints **1. Proxy EC2: …** and **2. Wavelength: instance responded** (or **no agent connected**) with T+ms.
- On success: **Success — full round-trip (client → proxy → Wavelength instance → proxy → client) (T+…ms).**

One-shot ping then exit (e.g. for scripts):

```bash
python sim_frontend.py <SESSION_ID> --ping-once
# Exit 0 = instance responded, exit 1 = no agent / timeout
```

## Env vars (optional)

- **sim_proxy**: `RDI_PROXY_WS_PORT`, `RDI_PROXY_HEALTH_PORT`, `RDI_PROXY_STATUS_PORT`, `RDI_PROXY_STATUS_SECRET` (default `sim-secret`).
- **sim_agent**: `RDI_AGENT_API_PORT` (default 8080), `RDI_MAVLINK_PORT` (default 14540).
- **sim_lambda.py**: `PROXY_STATUS_URL`, `PROXY_STATUS_SECRET`, `AGENT_URL`, `PROXY_WS_URL` (or pass via CLI).

## Quick build (all Rust sims)

From repo root:

```bash
cd scripts/proxy-agent/sim_proxy && cargo build --release
cd ../sim_agent && cargo build --release
```

Then run the release binaries from their dirs:

```bash
# Terminal 1
./target/release/sim-proxy

# Terminal 2
./target/release/sim-agent

# Terminal 3
python3 sim_lambda.py --proxy-status-secret sim-secret
python3 sim_frontend.py <SESSION_ID>
```

## What this proves

- Lambda sim sets the proxy session to **active** and adds the session on the agent.
- The agent opens a WebSocket to the proxy with handshake **agent:session_id**.
- The proxy accepts frontend and agent only for that **session_id** and only when status is **active**.
- Frontend sim can connect with **frontend:session_id** and receive “handshake accepted” and PING/PONG when the agent is connected.

This matches the AWS flow (Lambda → proxy status API + SSM → agent; agent → proxy WS; frontend → ALB → proxy WS) for local debugging.
