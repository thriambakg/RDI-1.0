# RDI Architecture

High-level architecture for Remote Drone Infrastructure. Use this doc to orient before making changes.

---

## System overview

**Control plane:** User → **REST Session API** (allocate `session_id`, proxy URL) → DynamoDB.

**Data plane (MAVLink):** User browser ↔ **WSS** → **ALB** → **ECS Fargate (proxy)** ↔ **agent** ↔ **MAVLink UDP** ↔ PX4. The agent runs **on the relay or dev machine** (outbound `wss://` to the proxy), not inside the Fargate task.

**Legacy name:** DynamoDB and REST bodies still use the field name `wavelength_zone_id`; values are **AWS region ids** (e.g. `us-east-1`) for partitioning sessions and relays—not carrier Wavelength zones.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  OPERATOR (browser)                                                          │
│  React app · Cognito · REST for sessions · WSS for MAVLink binary tunnel     │
└───────────────────────────────┬─────────────────────────────────────────────┘
                                │
        ┌───────────────────────┴───────────────────────┐
        │  REST · API Gateway + Lambda (Session API)   │
        │  POST/GET/PATCH/DELETE sessions, profile      │
        │  → DynamoDB (connection pool, relay registry)│
        └───────────────────────┬───────────────────────┘
                                │
        ┌───────────────────────┴───────────────────────┐
        │  WSS · ALB (TLS) → ECS Fargate · rdi-proxy     │
        │  Pairs frontend:{session_id} + agent:{session_id} │
        └───────────────────────┬───────────────────────┘
                                │
        ┌───────────────────────┴───────────────────────┐
        │  RELAY / GCS (internet: Starlink, LTE, etc.)   │
        │  rdi-agent · WebSocket ↔ MAVLink UDP ↔ PX4   │
        └───────────────────────────────────────────────┘
```

---

## Key points

### Proxy does not talk to PX4

The **proxy** (Rust in **ECS**) only bridges two WebSocket clients that share the same `session_id`:

- **Frontend** (browser)
- **Agent** (runs with PX4)

It does not parse MAVLink and does not open UDP to the autopilot.

### Agent runs beside PX4

The **agent** connects **outbound** to the same `wss://` endpoint returned by the Session API. It forwards bytes between the proxy WebSocket and **MAVLink UDP** (e.g. `127.0.0.1:18570`). Typical deployment: **relay hardware** on the field; local dev: laptop.

### Lambda is not in the MAVLink path

Session API Lambda creates rows and notifies the proxy of **active/idle** via `POST /session-status` (control plane only). After the REST response, the browser and agent open WebSockets **directly** to the ALB.

---

## APIs

### REST — Session lifecycle & profile

| Purpose | Notes |
|---------|--------|
| Create session | `POST /sessions` — body may include `wavelength_zone_id` (region id), `relay_id`, `metadata` (e.g. MAVLink port) |
| Session list / get | `GET /sessions` — optional `?wavelength_zone_id=` filter |
| Release / delete | `DELETE /sessions` |
| User profile | `GET` / `PATCH /user-profile` — folders, hierarchy |

Auth: Cognito. **No real-time MAVLink** on this API.

### WebSocket — Drone control

| Item | Detail |
|------|--------|
| Endpoint | `wss://` host from session response (often custom domain, e.g. `wss.example.com`) |
| Handshake | First message: `frontend:{session_id}` or `agent:{session_id}` |
| Payload | Binary MAVLink frames |

Backend: **ALB + ECS Fargate** (`rdi-proxy` container). No Lambda in the tunnel.

### Session status (control plane)

Lambda → `https://<alb>/session-status` with shared secret — tells proxy which `session_id` may connect (active vs idle).

---

## Connection creation flow

1. Frontend `POST /sessions` (auth).
2. Lambda writes **connection pool** DynamoDB item; returns `{ session_id, drone_id, endpoint, … }`.
3. Frontend opens WebSocket to `endpoint`, sends `frontend:{session_id}`.
4. Agent (same `session_id`) opens WebSocket to `endpoint`, sends `agent:{session_id}`.
5. Proxy pairs the two and forwards bytes both ways.

**DynamoDB (connection pool):** PK `user_id`, SK `session_id`. Attributes include `wavelength_zone_id` (region key), `status`, `endpoint`, `metadata`, etc. See [CONNECTION-POOL-SCHEMA.md](./CONNECTION-POOL-SCHEMA.md).

---

## Console (UI)

Users pick a **Region** (AWS region id) in the console; relays and sessions are filtered by that key (same Dynamo field name as above). Operations: folders, new connection, register relay — backed by Session API and Relay Registry API.

---

## Relay registration vs real-time tunnel (important)

**Registration (REST)** — already implemented: operators use **Register relay** in the console (or call **Relay Registry** `POST /relays` with Cognito). That creates a `relay_id`, stores metadata in DynamoDB, and ties the relay to a deployment region (`wavelength_zone_id` field = region id). No physical hardware is required to exercise the API; you can register a placeholder relay for testing.

**When you have hardware**, the same registration flow applies: the device (or a provisioning script) must obtain a **Cognito ID token** and call the same APIs. The relay then runs **rdi-agent** with `RDI_PROXY_URL`, `RDI_SESSION_ID`, and MAVLink env — that is separate from registration.

**Why we keep the `agent:` WebSocket in `rdi-proxy`:** the proxy’s job is to pair **two** WebSocket legs per `session_id`: `frontend:` (browser) and **`agent:`** (binary peer). That second leg is **rdi-agent on the relay** talking outbound to `wss://`. It is *not* a cloud “edge agent” and it is not optional if you want browser → MAVLink → PX4 through this stack. Removing “agent logic” from the proxy would remove the MAVLink tunnel until a different transport (e.g. relay polling, MQTT) is designed and implemented end-to-end.

---

## Flight logs (S3)

Planned: logs under `{user_id}/{wavelength_zone_id}/{drone_id}-{session_id}.log` in the flight-logs bucket (see Base Infra). Buffering and upload on session close are implementation follow-ups.

---

## Terraform (application root)

| Module / resource | Role |
|-------------------|------|
| `proxy-ecs` | VPC, ALB, ECR, ECS Fargate — **rdi-proxy** container |
| `session_api` (API Gateway + Lambda) | REST sessions |
| `user_profile_api`, `relay_registry_api` | Profile and relays |
| `secrets-manager` | Shared secret for session-status |
| `lambda-layer` | Python deps for Lambdas |
| **Not in root:** `modules/wavelength-ec2` is kept in-repo for a possible future carrier-edge stack; it is **not** instantiated from root `main.tf`. |

**Variables:** `use_proxy_ecs` (default `true`), `skip_agent_build` (skip S3 upload of `rdi-agent` when agents are built only on relays), `mavlink_port`, custom domain for WSS, etc.

**Per environment:** `terraform/environments/<env>.auto.tfvars` and region-specific `-var-file` as needed.

---

## Cost (order of magnitude, per region)

Rough monthly (single region, light traffic): ALB + Fargate task + Lambda + API Gateway + DynamoDB + ECR + KMS — on the order of **tens of USD/month**, excluding data transfer. No Wavelength EC2 or carrier charges in the default stack.

---

## References

- [src/README.md](../../src/README.md) — MAVLink ports, components
- [CONNECTION-POOL-SCHEMA.md](./CONNECTION-POOL-SCHEMA.md), [USER-PROFILES-SCHEMA.md](./USER-PROFILES-SCHEMA.md) — Dynamo shapes (field names may still say `wavelength_zone_id`)
