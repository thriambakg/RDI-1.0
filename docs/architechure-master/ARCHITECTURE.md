# RDI Architecture

High-level architecture for Remote Drone Infrastructure. Use this doc to orient before making changes.

---

## System Overview

**Flow:** User → REST API (session lifecycle) → WebSocket API (drone control) → Proxy → Wavelength → PX4

RDI exposes two distinct APIs:

| API | Protocol | Purpose |
|-----|----------|---------|
| **Session API** | REST (HTTPS) | Create/destroy sessions; allocate `session_id` and proxy endpoint |
| **Drone Control** | WebSocket (WSS) | Real-time MAVLink binary tunnel; connects frontend ↔ agent once paired |

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│  OPERATOR (Browser)                                                                                                          │
│  ┌─────────────────┐                                                                                                        │
│  │  Frontend       │  React app, Cognito auth; calls REST for sessions, WSS for control                                    │
│  └────────┬────────┘                                                                                                        │
└───────────┼───────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
            │
            ├─────────────────────────────────── REST API (session lifecycle) ───────────────────────────────────┐
            │ ① POST   /sessions   → create session                                                             │
            │    GET   /sessions   → get session info                                                            │
            │    DELETE /sessions  → release session                                                             │
            │                                                                                                    ▼
            │    ┌─────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
            │    │  REST API  ·  API Gateway + Lambda (Cognito auth)                                                            │
            │    │  ┌─────────────────────┐         ┌─────────────────────────────────────────────────────────────────────┐    │
            │    │  │ Session API Lambda  │────────►│  DynamoDB · Connection Pool Table                                    │    │
            │    │  │ Returns:            │  put    │  PK: user_id | SK: session_id                                        │    │
            │    │  │ {session_id,        │         │  Attributes: region, wavelength_zone_id, drone_id, status, endpoint,  │    │
            │    │  │  drone_id, endpoint}│         │  expires_at, created_at, updated_at, released_at, metadata           │    │
            │    │  │                     │         └─────────────────────────────────────────────────────────────────────┘    │
            │    │  └─────────────────────┘                                                                                    │
            │    └─────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
            │
            └────────────────────────────────── WebSocket API (drone control) · WSS ─────────────────────────────┐
             ② wss://<alb-dns>:443  ·  ALB terminates TLS; first msg: "frontend:{session_id}" or "agent:{session_id}"          │
                                                                                                                               ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│  AWS CLOUD  ·  WebSocket API (ALB + ECS Fargate proxy)                                                                        │
│                                                                                                                              │
│  ┌─────────────────────┐     ┌─────────────────────────────────────┐          ┌──────────────────────────────────────┐     │
│  │  ALB                │     │  ECS Fargate · Proxy container      │          │  Wavelength EC2                      │     │
│  │  TLS (wss) on 443   │────►│  WebSocket 8765; health 8766;       │─────────►│  Agent + PX4 at carrier edge         │     │
│  │  /session-status →  │     │  session-status 8767 (Lambda→proxy) │  outbound│  Agent connects out to proxy         │     │
│  └─────────────────────┘     └─────────────────────────────────────┘          └──────────────────┬───────────────────┘     │
│                                                                       │                                                      │
└───────────────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────┘
                                                                        │
                                                                        ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│  DRONE SITE (on Wavelength or beyond)                                                                                          │
│                                                                                                                              │
│  ┌─────────────────────────────┐     ┌──────────────────────────────────────────────────────────────────────────────────┐   │
│  │  Agent (Rust)               │     │  PX4 (+ Gazebo SITL or real hardware)                                            │   │
│  │  Bridges WebSocket ↔ UDP    │────►│  MAVLink UDP localhost:18570 (v1.13+) / 14540                                     │   │
│  └─────────────────────────────┘     └──────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                                                              │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Key Points

### Proxy does NOT connect to PX4

The **Proxy** (Rust service on **ECS Fargate** behind an ALB) is a dumb relay. It forwards binary between two WebSocket peers:
- **Frontend** (browser) – sends MAVLink bytes
- **Agent** (runs with PX4) – receives from proxy, sends to PX4 via UDP

The **Agent** runs where PX4 is: your laptop, a Pi, or Wavelength EC2. It connects **outbound** to the proxy.

### EC2 ↔ local PX4

| Scenario | Flow |
|----------|------|
| **Local dev** (drone-test) | Script talks directly to PX4 via UDP. No proxy. |
| **Via proxy** | Frontend → Proxy → Agent → PX4. Agent runs on same machine as PX4. |

The proxy never talks to PX4. Only the agent does.

### Proxy → Wavelength (always chained)

The flow is **always** sequential:
- **Proxy (ECS Fargate)** in a dedicated VPC: Internet-facing ALB terminates TLS (`wss://`); Fargate tasks run the WebSocket relay (ports 8765 WebSocket, 8766 health, 8767 session-status API for Lambda).
- **Wavelength EC2**: Agent connects **outbound** from the carrier edge to the same `wss://` endpoint; runs agent + PX4.

There is no "proxy OR wavelength" — it is always **Proxy → Wavelength** for production traffic from the internet.

---

## APIs

RDI uses two APIs with different protocols and responsibilities:

### REST API – Session lifecycle

| Purpose | Endpoints | Auth |
|---------|-----------|------|
| Create session, get proxy endpoint | `POST /sessions` (body: `{ ttl_seconds?, drone_name?, wavelength_zone_id?, folder_path?, metadata? }`) | Cognito |
| Get session info | `GET /sessions?session_id=...` | Cognito |
| List sessions for user | `GET /sessions` or `GET /sessions?wavelength_zone_id=...` | Cognito |
| Release session (mark idle) | `DELETE /sessions` (body: `{ session_id }`) | Cognito |
| Delete session permanently | `DELETE /sessions` (body: `{ session_id, permanent: true }`) | Cognito |
| Get user profile (folders) | `GET /user-profile` | Cognito |
| Update profile (e.g. delete folder) | `PATCH /user-profile` (body: `{ action, folder_path? }`) | Cognito |

- **Backend:** API Gateway (REST) → Lambda → DynamoDB
- **Not in real-time path.** Used only for allocation and teardown. Does **not** hold or create WebSocket connections.

### WebSocket API – Drone control

| Purpose | Endpoint | Auth |
|---------|----------|------|
| Real-time MAVLink tunnel | `wss://<alb-dns>` (ALB terminates TLS) | session_id handshake |

- **Backend:** ECS Fargate (proxy container) + ALB (no Lambda in the MAVLink data path)
- **Protocol:** Binary MAVLink frames. First message from each client: `frontend:{session_id}` or `agent:{session_id}`. Proxy pairs by session_id and bridges bytes.
- **Clients:** Frontend (browser) and Agent (with PX4). Both must have obtained the same `session_id` from the REST API.

### Summary

| API | Protocol | Use case |
|-----|----------|----------|
| REST (Session) | HTTPS | Create session, get endpoint, release session |
| WebSocket (Proxy) | WSS | Stream MAVLink to/from drone (TLS via ALB) |

---

## Connection Creation Flow

**The Lambda does not create WebSocket connections.** It allocates a session ID and records it in the connection pool table. Clients create the WebSocket.

```
1. Frontend calls POST /sessions (Cognito auth; body: { drone_name?, wavelength_zone_id?, ttl_seconds? })
       ↓
2. Lambda: generate session_id (UUID), drone_id = "{drone_name}-{uuid}", put in DynamoDB (user_id, session_id, …)
       ↓
3. Lambda returns { session_id, drone_id, endpoint, expires_at }
       ↓
4. Frontend opens WebSocket to endpoint, sends first message: "frontend:{session_id}"
       ↓
5. Agent (with same session_id) opens WebSocket to endpoint, sends "agent:{session_id}"
       ↓
6. Proxy pairs frontend and agent by session_id, bridges bytes between them
```

**Implementation verification (Lambda not in WebSocket path):**
- Frontend gets `endpoint` from Session API response (e.g. `wss://wss.rdistaging.com`). It then calls `openSession(sessionId, endpoint)`, which does `new WebSocket(endpoint)` and sends `frontend:${sessionId}` on open. So the WebSocket is **directly** to the ALB/proxy; no traffic goes through API Gateway or Lambda after the REST response. See `frontend/.../SessionWebSocketContext.tsx` (`openSession` → `new WebSocket(wsUrl)`) and `sessionApi.ts` (REST returns `endpoint`). "No agent connected" means the **agent on Wavelength EC2** has not connected to the proxy with the same session_id — it is an EC2/agent/proxy concern, not Lambda holding the connection.

**Connection pool (DynamoDB):**
- **Key:** user_id (PK) + session_id (SK) — user-centric access
- **Attributes:** region, wavelength_zone_id, user_zone_sk, status, drone_id, endpoint, expires_at, created_at, updated_at, released_at, metadata
- **GSIs:** UserZoneIndex (user_id + user_zone_sk), SessionIdIndex (session_id)
- **Drone ID:** `{drone_name}-{uuid}` — user sets friendly name (e.g. `survey-alpha`); unique suffix for deduplication
- **Role:** Track sessions, who owns them, status (active/idle). Does not create WebSocket connections.

---

## Flight Logs (S3)

**Flow:** (Planned) Log activity/telemetry during active sessions in parallel (no latency impact) → on session close, write log file to S3.

| Aspect | Detail |
|--------|--------|
| **Bucket** | `rdi-flight-logs-{env}-{account}` (Base Infra) |
| **Replication** | Prod: primary + replica (e.g. eu-central-1 → eu-west-2); Staging: single region |
| **Path** | `{user_id}/{wavelength_zone_id}/{drone_id}-{session_id}.log` |
| **Write** | (To be implemented) Proxy or agent on session close — flush buffer, upload to S3 |
| **Access** | Users browse logs by user_id; frontend can list by prefix |

**Drone ID format:** `{user-set-name}-{uuid}` — e.g. `survey-alpha-a1b2c3d4-...` for easy identification in logs.

**Implementation status:** Bucket and path structure are in place. Flight-log buffering, session-close detection, and S3 upload are to be implemented once initial flight controls are tested and validated.

**Session deletion logging (to be implemented):** When a session is deleted (via `DELETE /sessions` with `permanent: true`), the system should append an entry to the logfile recording the deletion event (session_id, user_id, drone_id, timestamp, reason). This ensures audit trails remain complete even when sessions are manually removed. Not yet implemented.

---

## WebSocket Path (no Lambda in MAVLink path)

The **Drone Control** WebSocket API is **ALB → ECS Fargate (proxy)** with no Lambda in the MAVLink data path.

| Option | How | Lambda? |
|--------|-----|---------|
| **ALB + ECS (current)** | Frontend → ALB (`wss://`) → Fargate proxy task | No in MAVLink path; TLS at ALB |
| **Session status (control plane)** | Session API Lambda → `POST https://<alb>/session-status` → proxy port 8767 | Yes (REST only; sets active/idle per session) |
| **API Gateway WebSocket** | Requires Lambda for connect/message/disconnect | Yes (not used for drone control) |

`websocket-api` module exists for API Gateway WebSocket (Lambda-based). The preferred path for latency is **ALB + ECS proxy**: ALB terminates TLS (`wss`), Fargate runs the Rust proxy; no Lambda in the MAVLink tunnel.

**Terraform:** `use_proxy_ecs = true` (default) provisions module `proxy-ecs` (VPC, ALB, ECR, ECS cluster, Fargate task). Image: `rdi-proxy` container from ECR. Secrets Manager supplies `RDI_PROXY_STATUS_SECRET` to the task so Lambda and proxy agree on the session-status API secret.

---

## Confirmation Without PX4

When no agent is connected, the proxy has no peer to forward to. It can:
- Drop the message, or
- Echo/ack back to the frontend (e.g. `{"ack": true}`) to confirm receipt.

---

## Console Operations (UI)

The frontend console supports:

| Operation | Description |
|-----------|-------------|
| **New connection** | Create session, get proxy endpoint, connect WebSocket to a drone |
| **Add drone** | Register a new drone (agent + PX4) into the pool; appears in console |
| **Remove drone** | Deregister drone; release session; remove from pool |
| **Drone groups** | Organize drones into folders/groups (e.g. "Fleet A", "Survey team") — see Connection hierarchy |
| **Modify zones** | Add, remove, or reconfigure Wavelength zones where drones can run |

These are backed by Session API, connection pool (DynamoDB), user profiles (connection hierarchy), and (future) a control-plane API for drone/zone CRUD.

### Connection hierarchy (folders)

Connections are stored in folders per user. The hierarchy lives in the **user profiles** table (`connection_hierarchy` attribute):

- **Structure:** `{ "My Drones": { sessions: [{session_id, name, status}], subfolders: {...} }, "Shared": {...} }` — supports nesting
- **Default folders:** "My Drones", "Shared" (created for new users)
- **Session Lambda** updates hierarchy on create (add to folder), release (update status), delete (remove)
- **User Profile API** (`GET /user-profile`, `PATCH /user-profile`) — separate Lambda
- **Schema:** See [USER-PROFILES-SCHEMA.md](./USER-PROFILES-SCHEMA.md)

---

## Wavelength Zone vs AWS Region (UI Selection)

**Use Wavelength zone (not AWS region) in the UI for drone/connection selection.**

| Dimension | AWS Region | Wavelength Zone |
|-----------|------------|-----------------|
| **What it is** | us-east-1, eu-west-2, etc. | e.g. use1-wl1-atl-wlz1 (Verizon Atlanta) |
| **Relevant to** | Where proxy, APIs, data live | Where the drone/agent is at carrier edge |
| **User intent** | "Where is my app deployed?" | "Which drone/edge am I connecting to?" |

**Why Wavelength zone is better for this app:**
- Drones live at the edge; the zone defines their physical/carrier location
- Latency to the drone depends on zone (carrier + city)
- Users think "connect to drone in Atlanta" not "connect to us-east-1"
- One region can have many Wavelength zones; zone is the right granularity

**UI flow:** User selects **Wavelength zone** (or "Drone location") → Console shows drones in that zone → User connects. Region stays fixed for the deployment; zone is the user-facing selector.

---

## Components

| Component | Location | Role |
|-----------|----------|------|
| Frontend | S3 + CloudFront | React app, Cognito auth; calls REST + WebSocket APIs |
| REST API (Session) | API Gateway + Lambda | POST/GET/DELETE /sessions; returns proxy endpoint |
| WebSocket API (Drone) | ALB + ECS Fargate | `wss://` via ALB; proxy pairs frontend↔agent, bridges MAVLink |
| ALB | Regional (proxy VPC) | TLS termination for WSS; listener rules: default → WebSocket TG; `/session-status` → status TG |
| Proxy | ECS Fargate (Rust container) | WebSocket relay on 8765; health 8766; Lambda session-status on 8767 |
| ECR | Regional | Container image for proxy |
| Wavelength EC2 | Wavelength zone | Agent connects outbound to proxy; runs agent + PX4 |
| Agent | On Wavelength (or beyond) | WS ↔ PX4 UDP bridge |
| PX4 | With agent | Autopilot, MAVLink |

---

## Terraform Modules

| Module | Purpose |
|--------|---------|
| `proxy-ecs` | **Default proxy:** Dedicated VPC, internet ALB, ECR, ECS cluster, Fargate task (Rust proxy). Replaces legacy proxy-on-EC2 for new deployments. |
| `rdi-edge` / proxy EC2 | Legacy: regional proxy EC2 + ALB; use when `use_proxy_ecs = false` |
| `wavelength-ec2` | Optional EC2 in Wavelength zone (agent binary from S3) |
| `api-gateway` | REST API for Session API (POST/GET/DELETE /sessions) |
| `secrets-manager` | `proxy_status` secret shared by Lambda and ECS task execution role |
| `websocket-api` | (Optional) API Gateway WebSocket, Lambda-based; not used for production drone path |

**Variable:** `use_proxy_ecs` (default `true`) — when true, `proxy-ecs` is applied and proxy binary upload to S3 for EC2 proxy is skipped where applicable.

---

## Terraform Deployment

| Environment | wavelength_zone_id | Apply command |
|-------------|--------------------|---------------|
| **Staging** | In `staging.auto.tfvars` (Chicago) | `terraform apply` with staging backend |
| **Production** | Per-region in `production/eu-*.tfvars` | Pass region var file: `-var-file=environments/production/eu-central-1.tfvars` or `eu-west-2.tfvars` |

**Production Wavelength:** `wavelength_zone_id` is not in `production.auto.tfvars`. It is set in each region file. Without the region var file, `wavelength_zone_id` defaults to `""` and no Wavelength EC2 is created.

| Region | Var file | Wavelength zone |
|--------|----------|-----------------|
| eu-central-1 (Frankfurt) | `production/eu-central-1.tfvars` | euc1-wl1-ber-wlz1 (Berlin, Vodafone) |
| eu-west-2 (London) | `production/eu-west-2.tfvars` | euw2-wl1-lon-wlz1 (London, Vodafone) |

---

## Cost Estimate (per region, monthly)

Approximate AWS costs for a single region (e.g. us-east-1 or eu-central-1). Assumes 730 hours/month, low–moderate traffic.

| Component | Config | Est. monthly (USD) |
|-----------|--------|--------------------|
| **ALB** | 1 ALB, ~1 LCU avg, light WebSocket traffic | $18–25 |
| **ECS Fargate (proxy)** | 0.25 vCPU / 512 MB, 1 task, 730 h | ~$15–20 |
| **ECR** | Proxy container image | <$1 |
| **Wavelength EC2** | t3.small (when deployed), carrier data charges | $18–25 + data |
| **Session API Lambda** | ~1K–10K invocations | <$1 |
| **API Gateway** | REST, ~1K–10K requests | $0.50–2 |
| **DynamoDB** | On-demand, connection pool table | $1–5 |
| **S3** | Lambda layers, agent binary artifacts, flight logs | <$1–5 |
| **KMS** | 1 key, low usage | $1 |
| **EIP** | Not needed with ALB (Proxy is target); $0 | $0 |
| **Data transfer** | Internet egress, inter-AZ | varies |

**Total per region (staging):** ~\$55–80/month (ECS proxy + Wavelength + ALB + base services).

**Endpoints:** Session API returns `wss://<alb-dns-name>` (or custom domain when enabled); frontend and agent connect via WSS. Lambda calls `https://<alb-dns-name>/session-status` (or custom domain) for active/idle. No EIP needed for the proxy entry point when ALB is public.

**Production (multi-region):** Multiply by number of regions. Wavelength data transfer and carrier charges vary by provider and usage.

---

## References

- [src/README.md](../../src/README.md) – MAVLink compatibility, ports
- [test-scripts/README.md](../../test-scripts/README.md) – drone-test, local control
