# Local vs Sim Connection Routing – Implementation Plan

This plan covers differentiating local relay connections (Path 1: user-run agent) from sim/Wavelength relay connections, and routing traffic accordingly.

---

## 1. Summary of Paths

| Path | Relay Type | Agent Location | Agent Connects | Wavelength Session? |
|------|------------|----------------|----------------|--------------------|
| **Path 1 (Local)** | `local` | User's PC | **Out** → Proxy | **No** |
| **Path 2 (Sim)** | `sim_relay` | Wavelength EC2 | **Out** → Proxy | **Yes** |
| **Path 3 (ngrok, future)** | `local` | User's PC | **In** ← Proxy | No |

- **Path 1**: User runs agent standalone with env vars; agent connects out to proxy. No Wavelength.
- **Path 2**: Session API adds session to Wavelength agent via SSM; agent connects out to proxy.
- **Path 3** (optional): Agent listens; ngrok exposes it; proxy connects out. Deferred.

---

## 2. Relay Registry – No Changes

- Relays already store `relay_type` (`local` | `sim_relay`).
- Connection-level details (e.g. `mavlink_port`) stay in session metadata.
- No schema or API changes.

---

## 3. Session API Lambda – Changes

### 3.1 Fetch Relay Type

**Current**: `_fetch_relay_config` returns only `mavlink_host` from relay `config` JSON.

**Change**: Return `relay_type` as well. Read it from the relay item:

- Relay item: `relay_type` (S)
- Extend `_fetch_relay_config` to include `relay_type` in the returned dict.

```python
# In _fetch_relay_config, add:
out["relay_type"] = item.get("relay_type", {}).get("S") or "local"
```

### 3.2 Create Session – Skip Wavelength for Local

**Current**: After creating session in DynamoDB, always calls `_add_session_to_agent` (unless proxy_only_mode or zone_mismatch).

**Change**: If `relay_config` and `relay_config.get("relay_type") == "local"`, skip `_add_session_to_agent`.

```python
# Around line 454, replace the else block:
else:
    relay_type = (relay_config or {}).get("relay_type") or "local"
    if relay_type == "local":
        _log("add_session skipped", reason="local_relay", session_id=session_id)
    else:
        _add_session_to_agent(...)
```

### 3.3 Patch Session (Activate) – Skip Wavelength for Local

**Current**: On `status=active`, unconditionally calls `_add_session_to_agent`.

**Change**: Fetch relay config (including `relay_type`) for the session’s `relay_id`; if `relay_type == "local"`, skip.

- Load `relay_id` from session (already done).
- Call `_fetch_relay_config(dynamodb, user_id, relay_id, wavelength_zone_id)`.
- If `relay_type == "local"`, skip `_add_session_to_agent`.
- If no `relay_id` (legacy session), treat as sim and add to agent (backward compat).

### 3.4 Create Session Response – Include Relay Type

- Add `relay_type` to the create response (from `relay_config`) so the frontend/CLI can show “run agent standalone” instructions for local relays.

---

## 4. Proxy – Changes

### 4.1 Connection Routing Helper

Add a module (e.g. `src/connection_routing.rs`) that centralizes routing logic:

**Purpose**:

- Decide how to forward messages based on connection type.
- Abstract “resolve agent for session” so we can later add outbound (ngrok) connections.
- Keep main.rs simpler and easier to extend.

**Initial implementation**:

- `resolve_agent(sessions: &Sessions, session_id: &str) -> Option<&Peer>` – looks up `sessions.agents.get(session_id)`.
- Use this wherever we currently look up the agent peer (CTRL handling, PING forwarding, binary forwarding).
- No behavior change for Path 1 or Path 2; both agents connect in.

**Future (Path 3)**:

- Track outbound connections per session (when connection metadata includes `agent_url`).
- `resolve_agent` would check both inbound agents map and outbound connections.
- Requires a way for the proxy to receive connection metadata (e.g. from Lambda status or a new API). Defer for now.

### 4.2 Optional: Session Metadata in Status API

If we want the proxy to know relay type (e.g. for logging or future routing):

- Extend `POST /session-status` to accept optional `relay_type` or `connection_type`.
- Store in `SessionStatusMap` or a parallel structure.
- Use only when needed for routing; not required for Path 1/2.

**Recommendation**: Omit for now; proxy does not need relay type for Path 1 or Path 2. Implement only if we add Path 3.

### 4.3 Message Forwarding

- Keep current behavior: all forwarding goes through `sessions.agents` and `sessions.frontends`.
- Replace direct map lookups with calls to the routing helper.
- CTRL, PING, and binary forwarding logic stays the same; only the lookup is abstracted.

---

## 5. Agent – Standalone Mode (Path 1)

**Goal**: User can run the agent without Lambda/SSM by providing session info via env vars.

**New env vars**:

- `RDI_SESSION_ID` – session ID
- `RDI_PROXY_URL` – proxy WebSocket URL (e.g. `wss://proxy.example.com`)
- `RDI_MAVLINK_PORT` (optional) – default 14540
- `RDI_MAVLINK_HOST` (optional) – default 127.0.0.1

**Behavior**:

- If `RDI_SESSION_ID` and `RDI_PROXY_URL` are set on startup:
  - Run a single session in standalone mode (no HTTP API needed).
  - Connect to `RDI_PROXY_URL` with role `agent:{RDI_SESSION_ID}`.
  - Bridge to `RDI_MAVLINK_HOST:RDI_MAVLINK_PORT`.
- If not set: run daemon mode (HTTP API + SSM-driven sessions) as today.

**Usage**:

```bash
RDI_SESSION_ID=<session_id> RDI_PROXY_URL=wss://<proxy-endpoint> RDI_MAVLINK_PORT=14540 ./rdi-agent
```

---

## 6. Frontend – Optional UX

- For local relay connections: show “Run agent” instructions (session_id, proxy URL, env vars).
- Could be in ConnectionDetailDialog or CreateConnectionDialog after create.
- Session API create response already includes `endpoint` (proxy URL) and `session_id`; add `relay_type` so the UI can conditionally show instructions.

---

## 7. Implementation Order

| Phase | Component | Task |
|-------|-----------|------|
| 1 | Session API | Extend `_fetch_relay_config` to return `relay_type` |
| 1 | Session API | In create_session: skip `_add_session_to_agent` when relay_type is local |
| 1 | Session API | In patch_session (activate): fetch relay, skip `_add_session_to_agent` when local |
| 1 | Session API | Add `relay_type` to create response |
| 2 | Agent | Add standalone mode (env-driven) |
| 3 | Proxy | Add `connection_routing` helper and refactor lookups |
| 4 | Frontend | (Optional) Show “run agent” instructions for local relays |

---

## 8. Files to Modify

| File | Changes |
|------|---------|
| `session-api/lambda_function.py` | `_fetch_relay_config`, create_session, patch_session, create response |
| `agent/src/main.rs` | Standalone mode when env vars set |
| `proxy/src/main.rs` | Use routing helper for agent lookups |
| `proxy/src/connection_routing.rs` | New module (optional abstraction) |

---

## 9. Testing

- **Local relay create**: Create session with local relay → no SSM call, session created.
- **Sim relay create**: Create session with sim relay → SSM add_session called.
- **Local relay activate**: Patch session to active with local relay → no SSM add_session.
- **Sim relay activate**: Patch session to active with sim relay → SSM add_session.
- **Path 1 E2E**: Create local connection → run agent standalone → frontend connects → MAVLink flows.
- **Path 2 E2E**: Create sim connection → Wavelength agent connects → frontend connects → MAVLink flows.
