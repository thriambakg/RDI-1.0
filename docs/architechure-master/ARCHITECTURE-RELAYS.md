# RDI Relay Architecture

## Overview

Proxy ↔ Wavelength instances form a **permanent backbone**. All relays (local tunnel, SIM relays), drones, and agents connect **to the Wavelength instance**, not to the proxy. Fixed-wing SIM relays extend the Wavelength ground station; they do not connect to the proxy.

---

## Topology

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         CLOUD (Proxy ECS)                                        │
└─────────────────────────────────────────────────────────────────────────────────┘
                                        │
                          permanent WebSocket (one per zone/instance)
                                        │
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    WAVELENGTH INSTANCE (e.g., Chicago)                            │
│                         Field hub / single attachment point                       │
└─────────────────────────────────────────────────────────────────────────────────┘
           │                    │                    │                    │
           ▼                    ▼                    ▼                    ▼
    ┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
    │   Local     │     │ SIM Relay   │     │ SIM Relay   │     │   Drones    │
    │   (agent)   │     │  (fixed)    │     │  (fixed)    │     │   (radio)   │
    │  dev laptop │     │  Alpha      │     │  Bravo      │     │   direct    │
    └─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
```

- **Proxy** talks only to Wavelength instances.
- **Wavelength** accepts connections from local agents, SIM relays, and drones.
- **Fixed-wing SIM relays** connect to Wavelength (cellular); Wavelength → relay → drones (radio).

---

## UI Flow

1. **Select zone** — User picks Wavelength zone (e.g., Chicago).
2. **Register relay** (optional) — User adds relay devices (local agent, fixed-wing SIM relay).
3. **Create connection** — User sets:
   - **TTL** (session duration)
   - **MAVLink type** (heartbeat, full, minimal)
   - **Relay** (Local, Relay Alpha, Relay Bravo, …)

"Local" = direct to Wavelength or via local tunnel agent attached to that zone.

---

## DynamoDB Tables (RDI-Base-Infra)

### connection-pool (existing)

| Setting | Value |
|---------|-------|
| Table | `rdi-connection-pool-{env}` |
| PK | `user_id` |
| SK | `session_id` |
| Replicas | `dynamodb_replica_regions` (prod: eu-west-2, eu-west-3) |
| Purpose | Session/slot management; user-centric; region/wavelength_zone as attributes |

Global table so regional Session API Lambdas read from the nearest replica. Same pattern for any table that must serve multiple regions.

### relay-registry (new)

| Setting | Value |
|---------|-------|
| Table | `rdi-relay-registry-{env}` |
| PK | `wavelength_zone_id` |
| SK | `relay_id` |
| Replicas | `dynamodb_replica_regions` (same as connection-pool) |
| Purpose | Relays attached to a Wavelength zone; queryable by zone when creating connections |

**Why span regions?** Relays are zone-scoped, but zones can be in any region. Users in any region may create sessions for any zone. Session API (regional) must read relay data with low latency — global table replicas provide local reads. Registration writes can come from any region.

---

## Relay Registry Data Model

```
PK: wavelength_zone_id (S)   — e.g. "chicago", "eu-central-1-wl1"
SK: relay_id (S)             — uuid or device-specific id

Attributes:
  relay_type       — "local" | "sim_relay"
  name             — user-facing label
  user_id          — owner (Cognito sub)
  status           — "online" | "offline"
  last_seen        — N (Unix timestamp)
  auth_key_hash    — for local/sim auth (optional)
  config           — M: type-specific (mavlink_host, radio_port, iccid, etc.)
  created_at       — N
  updated_at       — N
```

**GSI:** `UserRelayIndex` — PK `user_id`, SK `user_relay_sk` — for "my relays" views.

---

## Relay Registry API (POST/GET/PATCH/DELETE /relays)

**POST /relays** — Register a new relay
```json
{
  "wavelength_zone_id": "chicago",
  "name": "My laptop",
  "relay_type": "local",
  "config": { "mavlink_host": "127.0.0.1", "mavlink_port": 5760 },
  "auth_key_hash": "optional-hash-for-device-auth"
}
```
Response: `{ "relay_id", "wavelength_zone_id", "name", "relay_type", "status" }`

**GET /relays** — List relays for current user  
Query: `?wavelength_zone_id=chicago` (optional, filter by zone)  
Response: `{ "relays": [{ "relay_id", "wavelength_zone_id", "name", "relay_type", "status", "last_seen", "config" }] }`

**PATCH /relays** — Update relay name or config  
Body: `{ "relay_id", "wavelength_zone_id", "name?", "config?" }`

**DELETE /relays** — Unregister relay  
Body: `{ "relay_id", "wavelength_zone_id" }`

---

## connection-pool Multi-Region Setup (Reference)

From `RDI-Base-Infra/terraform`:

```hcl
# main.tf — connection-pool
module "connection_pool" {
  source = "./modules/dynamodb-table"
  ...
  replica_regions  = var.dynamodb_replica_regions
}
```

```hcl
# modules/dynamodb-table/main.tf
dynamic "replica" {
  for_each = var.replica_regions
  content {
    region_name = replica.value
  }
}
```

```hcl
# environments/production.auto.tfvars
dynamodb_replica_regions = ["eu-west-2", "eu-west-3"]
```

Primary region: `eu-central-1`. Replicas: `eu-west-2`, `eu-west-3`. Streams enabled automatically when replicas exist.

---

## Relay Registry Terraform (RDI-Base-Infra)

Add to `RDI-Base-Infra/terraform/main.tf`:

```hcl
# -----------------------------------------------------------------------------
# DynamoDB - Relay registry (relays per Wavelength zone)
# PK: wavelength_zone_id, SK: relay_id — zone-centric; same replica pattern as connection-pool
# -----------------------------------------------------------------------------
module "relay_registry" {
  source = "./modules/dynamodb-table"

  project_name     = local.project_name
  environment      = var.environment
  table_name       = "relay-registry"
  hash_key         = "wavelength_zone_id"
  range_key        = "relay_id"
  billing_mode     = "PAY_PER_REQUEST"
  kms_key_arn      = null
  table_type       = "RelayRegistry"
  table_purpose    = "RelaysPerWavelengthZone"
  stream_enabled   = true
  stream_view_type = "NEW_AND_OLD_IMAGES"
  replica_regions  = var.dynamodb_replica_regions

  attributes = [
    { name = "wavelength_zone_id", type = "S" },
    { name = "relay_id", type = "S" },
    { name = "user_id", type = "S" },
    { name = "user_relay_sk", type = "S" }
  ]

  global_secondary_indexes = [
    {
      name            = "UserRelayIndex"
      hash_key        = "user_id"
      range_key       = "user_relay_sk"
      projection_type = "ALL"
    }
  ]

  tags = {}
}
```

Output in `outputs.tf`:

```hcl
output "relay_registry_table_name" {
  value = module.relay_registry.table_name
}
```

---

## Session API & connection-pool Changes

- **Create session** body: add `relay_id` (optional). If set, Wavelength routes session through that relay.
- **connection-pool** item: add `relay_id` attribute for sessions bound to a relay.
- Session API passes `relay_id` to Wavelength/agent when adding session.

---

## Summary

| Item | Location | Multi-region |
|------|----------|--------------|
| connection-pool | RDI-Base-Infra | Yes (replica_regions) |
| relay-registry | RDI-Base-Infra (new) | Yes (same replica_regions) |
| user-profiles | RDI-Base-Infra | No (single region) |

Relay registry follows the same global-table pattern as connection-pool so it can serve multi-region Session APIs and UI from local DynamoDB replicas.
