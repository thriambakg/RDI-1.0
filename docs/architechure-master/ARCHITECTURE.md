# RDI Architecture

High-level architecture for **Remote Drone Infrastructure**. Use this doc to orient before making changes.

**Last updated:** WebRTC / KVS data plane (ECS `rdi-proxy` removed).

---

## System overview

RDI has two layers:

| Layer | Technology | Purpose |
|-------|------------|---------|
| **Control plane** | API Gateway (EDGE) + Lambda + DynamoDB + Cognito | Register relays, create connections, user profile, session lifecycle |
| **Data plane** | **WebRTC** + **Kinesis Video Streams signaling** | Live commands, telemetry, and video between pilot browser and field relay |

**Legacy field name:** DynamoDB and REST bodies use `wavelength_zone_id`; values are **AWS region ids** (e.g. `us-east-1`) for partitioning—not carrier Wavelength zones.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  OPERATOR (browser)                                                           │
│  React app · Cognito · REST (sessions, relays, profile)                      │
│  WebRTC Viewer per connection (data channel + video)                          │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │
        ┌───────────────────────┴────────────────────────┐
        │  CONTROL PLANE · API Gateway EDGE + Lambda        │
        │  /sessions  /relays  /user-profile                │
        │  → DynamoDB (connection-pool, relay-registry,     │
        │              user-profiles)                       │
        │  → KVS CreateSignalingChannel (per session)       │
        └───────────────────────┬────────────────────────┘
                                │ signaling WSS only (handshake)
        ┌───────────────────────┴────────────────────────┐
        │  AWS Kinesis Video Streams · WebRTC signaling     │
        │  One signaling channel per session_id             │
        └───────────────────────┬────────────────────────┘
                                │
        ┌───────────────────────┴────────────────────────┐
        │  WebRTC peer connection (UDP-like, direct)      │
        │  Browser (Viewer) ◄────────────────► Pi (Master) │
        └───────────────────────┬────────────────────────┘
                                │
        ┌───────────────────────┴────────────────────────┐
        │  RELAY · Raspberry Pi CM4 (Holybro baseboard)   │
        │  rdi-relay-daemon + rdi-agent                   │
        │  serial / MAVLink / radio ↔ drone               │
        └─────────────────────────────────────────────────┘
```

---

## What Kinesis is (and is not)

**Amazon Kinesis Video Streams (KVS)** is used for **WebRTC signaling only**—not as a pipe for drone bytes.

| Traffic | Path | Through KVS? |
|---------|------|--------------|
| Signaling (SDP, ICE, connect) | KVS WSS endpoints | **Yes** (small control messages) |
| Commands (arm, takeoff, stick) | WebRTC **data channel** | **No** |
| Telemetry (GPS, battery, mode) | WebRTC **data channel** | **No** |
| Video / audio | WebRTC **media track** (H.264) | **No** |

After the WebRTC session is established, **all real-time payload** flows browser ↔ Pi. KVS is the matchmaker, not the phone call.

We do **not** use Kinesis Data Streams or Firehose for teleoperation.

---

## Console model: relays parent connections (drones)

```
Region (wavelength_zone_id = AWS region id)
 └── Relay (relay_id)              ← one physical Pi / ground station
      ├── Connection A (session_id) ← one WebRTC session → drone A
      └── Connection B (session_id) ← one WebRTC session → drone B
```

| Entity | ID | Meaning |
|--------|-----|---------|
| **Relay** | `relay_id` | Registered ground node (CM4). Parent in UI hierarchy. |
| **Connection** | `session_id` | One live pilot link. Child of relay in practice. |
| **Drone** | `drone_id` | User-facing name + UUID in session row. |
| **Local target** | `metadata` (e.g. `mavlink_port`, serial device) | Which radio/serial endpoint on the Pi serves this drone. |

**Multiple drones on one relay:** each new connection creates a **new** KVS signaling channel and **new** WebRTC peer connection. The Pi runs **one async task per active `session_id`**, each mapped to its own local port or serial device via session metadata.

**Target (multi-session Pi):** daemon polls `GET /relays/active-sessions`, spawns/stops WebRTC Master tasks concurrently. Relay-registry stores `active_sessions` JSON (one entry per `session_id`). `GET /relays/webrtc-master` remains for backward compatibility (first session only).

---

## WebRTC session structure

Each connection uses **one WebRTC peer connection** with two lanes:

| Lane | WebRTC piece | Direction | Content |
|------|----------------|-----------|---------|
| **Control + telemetry** | Data channel (`ordered: false`, `maxRetransmits: 0`) | Bidirectional | MAVLink frames, stick/CTRL bytes |
| **Video (and optional audio)** | Media track (H.264 via Pi HW encoder when ready) | Pi → browser | FPV from radio/camera |

Commands and feedback share the **data channel**. Video is a **separate track** on the **same** peer connection—not a second AWS service.

---

## Relay hardware role

The Pi is the **translator** between internet and air side:

```
Browser  ──WebRTC──►  Pi relay  ──serial / radio──►  Drone
              ▲              │
              └── telemetry, video back ──┘
```

- **Outbound-only** from Pi to cloud (signaling WSS, then WebRTC). No inbound firewall holes on the relay.
- Cloud never speaks to the radio directly.
- **Safety (planned):** watchdog on Pi—if data channel drops, send MAVLink RTL/Loiter over serial.

---

## Control plane APIs

Auth: **Cognito** Bearer token on user routes. Device routes use `device_serial` + `device_secret`.

### Session API (`/sessions`)

| Method | Purpose |
|--------|---------|
| `POST /sessions` | Create connection; creates KVS signaling channel; returns `transport: "webrtc"` + viewer creds |
| `GET /sessions` | List/get sessions |
| `PATCH /sessions` | Reactivate idle session (new signaling setup TBD on reactivate) |
| `DELETE /sessions` | Release (idle) or permanent delete; deletes KVS channel |

**Create body (typical):** `relay_id`, `wavelength_zone_id`, `folder_path`, `metadata.mavlink_port`, `drone_name`, `ttl_seconds`.

**Response (WebRTC):** `session_id`, `drone_id`, `relay_id`, `transport`, `webrtc` (viewer signaling endpoint + STS credentials), `mavlink_port`, `mavlink_host`.

### Relay Registry API (`/relays`)

| Method | Auth | Purpose |
|--------|------|---------|
| `POST /relays` | Cognito | Manual relay registration |
| `POST /relays/claim` | Cognito | Claim device by pairing code |
| `POST /relays/announce` | Device | Pi announces; gets `claim_code` |
| `GET /relays/claim-status` | Device | Pi polls until claimed |
| `GET /relays/webrtc-master` | Device | Pi fetches MASTER WebRTC creds for active session |
| `GET/PATCH/DELETE /relays` | Cognito | List, update, delete relays |

### User profile (`/user-profile`)

Folders, `connection_hierarchy`, relay list—unchanged. See [USER-PROFILES-SCHEMA.md](./USER-PROFILES-SCHEMA.md).

**No real-time drone bytes on REST.** Session API is provisioning only.

---

## End-to-end: create connection

1. User selects **relay** and clicks **New connection** in console.
2. Frontend `POST /sessions` with `relay_id` and metadata.
3. Session API Lambda:
   - Writes **connection-pool** row (`user_id`, `session_id`, `relay_id`, `drone_id`, `status: active`).
   - Calls `CreateSignalingChannel` (KVS), stores `signaling_channel_arn`.
   - Binds session to relay (`active_sessions` list on relay-registry item).
   - Returns **viewer** WebRTC bundle (signaling WSS + scoped STS creds).
4. Frontend opens **WebRTC Viewer** for that `session_id` (implementation in progress).
5. Pi **relay daemon** polls `GET /relays/active-sessions` (legacy: `webrtc-master` for one session).
6. Pi **rdi-agent** connects as KVS **Master**, bridges data channel ↔ MAVLink/serial/radio.
7. Browser and Pi complete WebRTC handshake via KVS signaling; telemetry and commands flow on data channel.

**Pause / delete:** Session API marks idle or deletes row, calls `DeleteSignalingChannel`, clears relay binding. Pi daemon stops the matching task.

---

## Hardware claim flow (Path B)

Separate from the live tunnel—provisions identity only.

1. Pi `POST /relays/announce` → `claim_code` on stdout.
2. User **Add Relay → Claim device** in console with code.
3. Pi polls `GET /relays/claim-status` until `claimed`.
4. Pi writes `/etc/rdi/relay.conf` (`relay_id`, zone, `api_base_url`).

See [ARCHITECTURE-RELAYS.md](./ARCHITECTURE-RELAYS.md) for registry schema and claim details.

---

## Pi software stack

| Component | Role |
|-----------|------|
| `rdi-relay-claim.py` | One-time (or re-) provisioning; pairing code |
| `rdi-relay-daemon` | Polls API for active sessions; spawn/stop agent tasks (**Python on Pi — manual install**) |
| `rdi-agent` | Per-session WebRTC Master + local MAVLink/serial bridge (**rewrite in progress**) |

### Concurrency on CM4

Use **async tasks (Tokio)**, not one OS thread per drone:

```text
rdi-relay-daemon (one process)
  ├─ task: poll /relays/active-sessions
  ├─ task: session_id=A → WebRTC Master → mavlink :18570 → drone A
  └─ task: session_id=B → WebRTC Master → mavlink :18571 → drone B
```

The legacy WebSocket agent already used `HashMap<session_id, JoinHandle>` for multi-session daemon mode; the WebRTC agent follows the same pattern.

**Bench:** one Pixhawk on USB serial. **Field:** one RF link per drone unless multiple UARTs/radios on the baseboard.

---

## DynamoDB (RDI-Base-Infra)

| Table | PK / SK | Purpose |
|-------|---------|---------|
| `connection-pool` | `user_id` / `session_id` | Sessions; adds `signaling_channel_arn`, `transport` in WebRTC mode |
| `relay-registry` | `wavelength_zone_id` / `relay_id` | Relays; claim flow; `active_session_id` (→ multi-session list planned) |
| `user-profiles` | `user_id` | Hierarchy, relay refs |

See [CONNECTION-POOL-SCHEMA.md](./CONNECTION-POOL-SCHEMA.md).

---

## Terraform (RDI-1.0 application root)

| Module | Role |
|--------|------|
| `session_api` | API Gateway + Session API Lambda |
| `relay_registry_api` | Relay Registry Lambda (in same gateway module) |
| `user_profile_api` | Profile Lambda |
| **`kvs-webrtc`** | IAM role + policies for KVS signaling and STS creds |
| `lambda-layer` | Python deps for Lambdas |
| `lambda` | Function packaging |

**Key variables** (`terraform/environments/*.auto.tfvars`):

```hcl
use_proxy_ecs = false   # deprecated — do not enable
data_plane    = "webrtc"
```

**Removed / deprecated:** `module.proxy_ecs`, ECR proxy image, ALB WSS for data plane, `rdi-proxy` byte forwarding, `PROXY_ENDPOINT` as session tunnel URL.

**KVS signaling channels** are **not** in Terraform—they are created at runtime per `POST /sessions`.

**Base Infra** (separate repo): Cognito, DynamoDB tables, frontend S3/CloudFront—unchanged.

---

## Frontend

| Area | Status |
|------|--------|
| Console, folders, relay register/claim | Implemented |
| Create connection → `POST /sessions` | Implemented |
| WebRTC Viewer per session | **In progress** (replaces `SessionWebSocketContext`) |
| Video `<video>` + link-loss HUD | Planned |

Hosted on **S3 + CloudFront** (RDI-Base-Infra).

---

## Implementation status

| Piece | Status |
|-------|--------|
| Claim flow (Pi + console) | Done |
| `module.kvs-webrtc` IAM | Done |
| Session API: create/delete KVS channel | Done |
| `GET /relays/webrtc-master` | Done (legacy: first session only) |
| `GET /relays/active-sessions` | Done |
| ECS / proxy deprecation in tfvars | Done |
| Multi-session relay row (`active_sessions`) | Done |
| `rdi-relay-daemon` | Done (Python; `scripts/relay-device/`, manual SSH install) |
| `rdi-agent` WebRTC rewrite | Planned |
| Frontend WebRTC viewer | Planned |
| Video pipeline (`h264_v4l2m2m`) | Planned |
| 500ms safety watchdog | Planned |

**Local dev spike (no AWS):** `scripts/webrtc-spike/` — Pi ↔ laptop data channel on LAN.

---

## Flight logs (S3)

Planned: `{user_id}/{wavelength_zone_id}/{drone_id}-{session_id}.log` in flight-logs bucket (Base Infra). Upload on session close—not implemented.

---

## Cost (order of magnitude)

Without always-on Fargate/ALB: API Gateway + Lambda + DynamoDB + KVS signaling minutes + CloudFront—typically **lower** than the old proxy stack at dev scale. No per-byte AWS charge for WebRTC payload (media goes peer-to-peer or via STUN/TURN).

---

## References

- [ARCHITECTURE-RELAYS.md](./ARCHITECTURE-RELAYS.md) — relay registry, claim flow, relay types
- [CONNECTION-POOL-SCHEMA.md](./CONNECTION-POOL-SCHEMA.md) — session table shape
- [USER-PROFILES-SCHEMA.md](./USER-PROFILES-SCHEMA.md) — profile and hierarchy
- [LOCAL-VS-SIM-CONNECTION-PLAN.md](./LOCAL-VS-SIM-CONNECTION-PLAN.md) — `local` vs `sim_relay` (sim path legacy)
- [src/README.md](../../src/README.md) — component map, MAVLink ports
- `terraform/modules/kvs-webrtc/README.md` — IAM module for signaling

---

## Removed architecture (historical)

The following is **no longer deployed** (`use_proxy_ecs = false`):

- Browser + Pi → **ECS Fargate `rdi-proxy`** via `wss://` ALB
- WebSocket pairing: `frontend:{session_id}` + `agent:{session_id}`
- Lambda → proxy `POST /session-status` for active/idle gating
- CTRL→MAVLink conversion in proxy (moves to Pi or browser)

Do not extend the proxy path for new features.
