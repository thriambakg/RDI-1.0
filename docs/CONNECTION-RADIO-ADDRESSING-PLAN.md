# Plan: Per-drone connections with radio addressing

**Status:** Phase A/B in progress (shared radio router + connection addressing fields)  
**Date:** 2026-07-30  
**Goal:** When creating a **connection** (one drone), capture enough identity that the mothership relay can route WebRTC / commands to **that** radio endpoint among N aircraft.

---

## 1. Context and product intent

### Mission topology

```text
Operator (web)
    │  Starlink / cellular (clear sky)
    ▼
Mothership fixed-wing (loiter)
    ├── Pixhawk FC          — flies mothership
    ├── Pi CM4 (relay)      — WebRTC + command router
    └── RFD900 (air)        — shared / multipoint RF downlink
            │
            ├──► Drone 1 (FC + RFD900)
            ├──► Drone 2
            └──► Drone N
```

A **connection** in the UI is one logical drone the operator can open, ping, and later command. It must map to a **specific RF / MAVLink identity**, not only to “whatever radio the Pi env var points at.”

### Current state (gap)

| Layer | Today |
|-------|--------|
| Create connection UX | Relay, name, TTL, MAVLink **UDP port** (18570 / 14540) |
| Session model | `relay_id` + `drone_id` (display label) + `metadata.mavlink_host/port` |
| Pi radio path | **Process-global** env: `RDI_RADIO_PORT` / `RDI_RADIO_MODE` / baud |
| Multi-session | Different `mavlink_port` on one Pi, **not** different radios / sysids |

`drone_id` is `{name}-{uuid}` — not a hardware or MAVLink address. Radio hop ping cannot select “drone 3 of N.”

---

## 2. Design principles

1. **Connection = one remote aircraft** (or one HITL endpoint), bound to one mothership **relay**.
2. **Addressing is data**, not Pi env alone — create/store fields that the worker reads from `active_sessions`.
3. **Phase the RF model:** start with fields that work for lab (sysid + net id) and extend to multipoint / multi-radio without breaking the API.
4. **Keep WebRTC 1:1 with session** — one KVS channel per connection; radio multiplexing happens **on the Pi after** the data channel.
5. **Do not require Perfect RF on day one** — allow “radio optional / unknown” for relay-only ping while hardware catches up.

---

## 3. Addressing model (what “enough information” means)

### 3.1 Identifiers (recommended minimum)

| Field | Purpose | Example |
|-------|---------|---------|
| `mavlink_sysid` | MAVLink system id of the **target drone** FC | `1` … `255` (unique on the RF network) |
| `mavlink_compid` | Usually autopilot | `1` (default) |
| `radio_net_id` | SiK / RFD network ID (same air channel group) | `25` |
| `radio_node_id` | Optional modem node id if multipoint firmware exposes it | vendor-specific |
| `radio_air_rate` / `radio_baud` | Link params for docs + Pi validation | `64`, `57600` |
| `link_mode` | How Pi reaches that drone | see below |

### 3.2 Link modes (evolution)

| `link_mode` | Meaning | When |
|-------------|---------|------|
| `none` | No RF; WebRTC / local UDP only | Today’s relay ping |
| `shared_serial` | One mothership radio UART; address by **MAVLink sysid** | First multipoint / single TELEM1 radio |
| `dedicated_serial` | This connection owns a Pi serial device (e.g. `/dev/ttyUSB0`) | Lab FTDI or multi-radio mothership |
| `udp_mavlink` | Existing local SITL / HITL via `mavlink_host:port` | Desktop sim / no RF |

**Mothership production default:** `shared_serial` + unique `mavlink_sysid` per drone on one RFD multipoint net.

### 3.3 What we deliberately defer

- Full RFD modem AT-command provisioning from the cloud  
- Automatic discovery / pairing UI  
- Per-drone encryption keys  
- Video over 900 MHz  

Those can hang off the same connection metadata later.

---

## 4. UX plan — Create connection

### 4.1 Keep

- Relay (mothership)  
- Connection / drone **display name**  
- Session TTL  
- Folder placement  

### 4.2 Add (grouped “Radio / aircraft” section)

**Required for radio path (when link mode ≠ `none`):**

- **MAVLink system ID** (number, 1–255) — primary selector among N drones  
- **Link mode** — `none` | `shared_serial` | `dedicated_serial` | `udp_mavlink`

**Shown when relevant:**

| Mode | Extra fields |
|------|----------------|
| `udp_mavlink` | Host (default 127.0.0.1), port (18570 / 14540) — current behavior |
| `shared_serial` | Radio net ID; optional air rate; note “uses mothership TELEM1 / primary radio” |
| `dedicated_serial` | Serial device path on Pi (`/dev/ttyUSB0`), baud |

**Optional advanced (collapsed):**

- Component ID (default 1)  
- Radio node id  
- Notes / callsign  

### 4.3 Validation rules

- On one relay, **`mavlink_sysid` unique** among active/idle connections that use RF (`shared_serial` / `dedicated_serial`).  
- `dedicated_serial`: warn if two connections claim the same device path.  
- `link_mode = none`: allow create without radio fields (relay-only testing).  
- Clear helper text: “Sysid must match the PX4 `MAV_SYS_ID` on that aircraft.”

### 4.4 Detail dialog

- Show radio addressing summary (sysid, net id, link mode).  
- **Ping relay** vs **Ping radio** (already in progress): radio ping should use this connection’s addressing, not global env only.

---

## 5. API and data model changes

### 5.1 `POST /sessions` metadata (extend, don’t break)

```json
{
  "drone_name": "wingman-1",
  "relay_id": "<uuid>",
  "ttl_seconds": 14400,
  "wavelength_zone_id": "us-east-1",
  "folder_path": ["My Drones"],
  "metadata": {
    "link_mode": "shared_serial",
    "mavlink_sysid": 2,
    "mavlink_compid": 1,
    "radio_net_id": 25,
    "radio_baud": 57600,
    "radio_air_rate": 64,
    "radio_device": null,
    "mavlink_host": "127.0.0.1",
    "mavlink_port": 18570,
    "px4_version": "v1.14+"
  }
}
```

Backward compatible: missing `link_mode` ⇒ treat as `udp_mavlink` or `none` based on presence of port-only metadata (document migration default as `udp_mavlink` for existing rows).

### 5.2 Persistence

- Store under connection-pool `metadata` (JSON string today) **or** promote hot fields to top-level attributes if query/filter by sysid is needed.  
- **Recommendation (phase 1):** keep in `metadata`; add top-level `mavlink_sysid` + `link_mode` later if ops need it.

### 5.3 Relay `active_sessions` payload (Pi)

Extend each active session entry so the daemon/worker does not need DynamoDB:

```json
{
  "session_id": "...",
  "signaling_channel_arn": "...",
  "drone_id": "...",
  "link_mode": "shared_serial",
  "mavlink_sysid": 2,
  "mavlink_compid": 1,
  "radio_net_id": 25,
  "radio_baud": 57600,
  "radio_device": null,
  "mavlink_host": "127.0.0.1",
  "mavlink_port": 18570
}
```

Files to touch: `src/session-api/relay_active_sessions.py`, session create/activate paths in `lambda_function.py`.

### 5.4 Profile hierarchy

No change required for folder refs beyond optional display badge (sysid). Full addressing stays on connection-pool + GET session.

---

## 6. Pi / worker behavior

### 6.1 Today

- One radio bridge from env for **all** workers.  
- Ping radio = that global bridge.

### 6.2 Target

| `link_mode` | Worker behavior |
|-------------|-----------------|
| `none` | Local WebRTC PONG only; radio ping returns clear “not configured” |
| `udp_mavlink` | Existing UDP MAVLink target (SITL/HITL) |
| `shared_serial` | Shared mothership radio bridge; **filter/send by `mavlink_sysid`** (TUNNEL or MAVLink routed to that system) |
| `dedicated_serial` | Open/use `radio_device` at `radio_baud` for this session only |

### 6.3 Shared radio concurrency

- Prefer **one** serial owner process (daemon or single bridge) with demux by sysid, rather than N workers fighting `/dev/serial0`.  
- Phase 1 acceptable shortcut: one shared bridge; radio ping/commands stamp target sysid.  
- Phase 2: daemon-owned radio router service; workers speak to it over localhost.

### 6.4 Env vars role after this

- Env becomes **defaults** for mothership primary radio (`RDI_RADIO_PORT`, baud, mode).  
- Per-connection metadata **overrides** target addressing.  
- Document: multipoint net id must match radios; sysids unique.

---

## 7. Implementation phases

### Phase A — Schema + UI fields (no RF demux yet)

1. Extend Create Connection form with link mode + sysid (+ conditional fields).  
2. Persist in session `metadata`; return on GET session / detail dialog.  
3. Pass through `active_sessions`.  
4. Frontend shows addressing; **Ping radio** still uses global bridge but logs intended sysid.  
5. Docs: operator must set PX4 `MAV_SYS_ID` on each drone to match.

**Exit criteria:** Create/open connection shows sysid; Pi log includes `mavlink_sysid` from active session.

### Phase B — Address-aware radio ping / commands

1. Shared serial bridge tags TUNNEL or MAVLink with target sysid.  
2. Desktop HITL / drone agents filter on sysid (or reply with their id).  
3. **Ping radio** fails clearly if sysid mismatch / no reply from that id.  
4. Worker refuses radio ping when `link_mode` is `none`.

**Exit criteria:** Two connections (sysid 1 and 2) on one relay; ping radio for each only completes for the matching endpoint (lab: two agents or one agent filtering ids).

**Lab note (2026-08-11):** Dual-sysid **ping** demux works: COM7 `--sysid 2` skips sysid=1 pings and echoes sysid=2; both stacks (`px4` / `ardupilot`) stamp correctly. Remaining:
1. Desktop agent must also filter **CTRL** by `--sysid` (was printing foreign CTRL) — fixed in `radio_ping_desktop_agent.py`.
2. Lab agents should each pass `--sysid` (COM5 `--sysid 1`, COM7 `--sysid 2`); unfiltered agents answer every aircraft.
3. Create UI later auto-allocates sysids so operators don’t leave both drones on `1`.
4. Hop timestamps showing `T+-29xxms` are a separate display bug (ms vs seconds).

### Phase C — Mothership production path

1. Pixhawk on CM4 baseboard; TELEM1 radio; `shared_serial` default.  
2. Optional relay-level “primary radio” config in relay registry.  
3. Multipoint RFD settings guide; uniqueness checks on create.  
4. Command fan-out API later (mission/RC) using same addressing.

**Exit criteria:** Web → mothership Pi → TELEM1 → N drones by sysid in flight test.

### Phase D — Multi-radio mothership (optional)

- `dedicated_serial` or relay `radios[]` inventory; connection picks `radio_id`.  
- Needed when one multipoint channel is insufficient.

---

## 8. Files likely involved

| Area | Paths |
|------|--------|
| Create UX | `frontend/react-app/src/components/dialogues/CreateConnectionDialog.tsx` |
| Detail UX | `frontend/react-app/src/components/dialogues/ConnectionDetailDialog.tsx` |
| Session client | `frontend/react-app/src/services/sessionApi.ts` |
| Session API | `src/session-api/lambda_function.py`, `relay_active_sessions.py` |
| Schemas | `docs/architechure-master/CONNECTION-POOL-SCHEMA.md` |
| Pi worker | `scripts/relay-device/kvs_master_worker.py`, `radio_mavlink_bridge.py`, `radio_serial_bridge.py` |
| Relay docs | `scripts/relay-device/RADIO-TELEM.md`, `docs/architechure-master/ARCHITECTURE-RELAYS.md` |

---

## 9. Testing plan

1. **Regression:** existing connections without new fields still open WebRTC; Ping relay works.  
2. **Create:** `shared_serial` + sysid 2 → metadata and active_sessions contain fields.  
3. **Duplicate sysid** on same relay → API or UI validation error.  
4. **Ping radio** with `link_mode=none` → immediate structured error (no 8s timeout).  
5. **Lab dual-sysid:** two listeners or filters; only matching sysid pongs.  
6. **UDP mode:** unchanged SITL path via host/port.

---

## 10. Open decisions

1. **Default `link_mode` for new connections** once Pixhawk mothership is standard: `shared_serial` vs `none`?  
2. **Enforce unique sysid** in API (hard fail) vs warning only?  
3. **Sysid ownership:** user-entered vs auto-allocated from relay pool (1..N)?  
4. **HITL desktop agent:** single process multi-sysid vs one process per connection?  
5. **Relay registry:** publish available radios / net id as read-only config for the create form?

**Recommendation:** hard-fail duplicate sysid on same relay; default new RF connections to `shared_serial` after mothership hardware lands; auto-allocate sysid optional Phase C nicety.

---

## 11. Out of scope (this plan)

- Purchasing / flashing RFD multipoint firmware details (separate hardware doc)  
- EW-hardening RF tactics beyond architecture  
- Replacing WebRTC with radio for the cloud hop (cloud remains Starlink → Pi)

---

## 12. Summary

To add connections that map to **particular radio devices / drones**, extend create-connection with **`link_mode` + `mavlink_sysid` (+ net id / optional device)**, persist them on the session, push them to the Pi via `active_sessions`, and teach the radio path to **demux by sysid** on a shared mothership radio. That matches the fixed-wing mothership architecture; a second FTDI remains lab-only, while Pixhawk + TELEM1 is the production shared-serial path.
