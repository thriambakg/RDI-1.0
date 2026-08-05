# Plan: On-device setup GUI, relay reset, and blank-baseboard bring-up

**Status:** Pinned — pick up later (not in active implementation)  
**Date:** 2026-08-04  
**Related:** [CONNECTION-RADIO-ADDRESSING-PLAN.md](./CONNECTION-RADIO-ADDRESSING-PLAN.md), `scripts/relay-device/RADIO-TELEM.md`

---

## 1. Goal

Ship a **single on-device GUI** (Pi local web or HDMI kiosk) that handles field/factory hardware setup for the Holybro CM4 + Pixhawk + RFD900 mothership stack:

- Show **relay pairing code** and claim status  
- **Reset** a relay (clear connection state, rotate credentials, new pairing code)  
- **Register N drones** on one shared radio via a pairing-code flow (same spirit as device claim)  
- Guide **blank** baseboard bring-up without reimplementing QGroundControl  

Cloud console remains the place users **enter** pairing codes (relay claim, drone/connection claim).

---

## 2. Product topology (reminder)

```text
Operator (web console)          Mothership (baseboard)
  claim codes  ◄──────────────►  Pi setup GUI + relay daemon
                                      │
                                      ├── Pixhawk (TELEM2 ↔ Pi, TELEM1 ↔ air radio)
                                      └── RFD900 air ~~~ ground radios / drones
```

One relay, **N drones**, addressed on RF by **`mavlink_sysid`** (+ shared `radio_net_id`). See connection addressing plan for schema/`shared_serial`.

---

## 3. On-device Setup GUI (screens)

Suggested local service: `http://RDIRelay.local:8080` or a kiosk on HDMI.

| Screen | Purpose |
|--------|---------|
| **Welcome / image version** | Confirm RDI image build; block if services missing |
| **Network** | Wi‑Fi / Ethernet until API reachable |
| **Relay status** | Serial, claim state, pairing code, “Reset & re-pair” |
| **Flight controller** | QGC + param-pack checklist; **Verify TELEM2** (HEARTBEAT / router up) |
| **Air radio** | TELEM1 power/LED / antenna checklist; net ID notes |
| **Radio / drones** | List drones, Add drone → pairing code + allocated sysid |
| **Link health** | Shared radio router status, optional Ping radio |
| **Advanced** | Download param packs, docs links |

### Ordered first-boot wizard (gates)

1. Welcome / image healthy  
2. **Network** — must reach `RDI_API_BASE_URL` before pairing  
3. **Relay identity** — announce → show pairing code → wait until `claimed`  
4. **Pixhawk** — QGC + `rdi-mothership` params; GUI verify companion UART  
5. **Air radio** — physical checklist  
6. **Add drones** — sysid + pairing codes for console  

**Do not** require PX4/radios configured before relay claim. Claim only needs: **RDI Pi image + network**.

---

## 4. Relay reset (“reset relay module”)

Destructive, explicit button + confirm (not on every boot).

Intended behavior:

1. Cloud: release/idle all sessions for this `relay_id`; clear `active_sessions`  
2. Local: stop workers; flush any local setup/drone-pending cache (optional checkbox: wipe drone registry)  
3. Re-announce with force (`RDI_FORCE_REANNOUNCE`) → new `claim_code` + rotated `device_secret`  
4. GUI shows new code until console claim succeeds  
5. Restart relay daemon / radio router as needed  

Existing claim tooling: `scripts/relay-device/rdi-relay-claim.py` (`RDI_API_BASE_URL`, `RDI_FORCE_REANNOUNCE=1`).

---

## 5. Radio / N-drone pairing (recommended model)

Mirror **device registration**, but identity is RF/MAVLink — not a Pi COM port per drone.

```text
Pi Setup GUI                         Cloud console
  Add drone → allocate                 user enters drone_pairing_code
    mavlink_sysid (unique on relay) →  creates connection with
    radio_net_id (shared)                link_mode=shared_serial
    drone_pairing_code                   mavlink_sysid, radio_net_id
```

| Field | Role |
|-------|------|
| `mavlink_sysid` | Primary address on shared RF (1–255, unique per relay) |
| `radio_net_id` | Same SiK/RFD network for mothership air modem + drones |
| `drone_pairing_code` | Short-lived claim binding console connection → that identity |
| Optional `radio_node_id` | Later (RFD multipoint firmware) |

**Do not** treat “code burned into RFD900” as primary identity. SiK Net ID is shared; **sysid + net id + cloud claim** is the addressing model.

Physical drone after claim: set FC `MAV_SYS_ID` to allocated sysid; match radio Net ID / UART baud (checklist or small drone param snippet).

Aligns with phases in `CONNECTION-RADIO-ADDRESSING-PLAN.md` and the daemon-owned shared radio router (`127.0.0.1:18771`).

---

## 6. PX4 / blank Pixhawk — QGC vs in-app

**Decision: do not rebuild QGroundControl in the setup GUI.**

| Approach | Verdict |
|----------|---------|
| Full in-app PX4 config | Too costly / fragile across firmware |
| **QGC + downloadable RDI `.params` / checklist** | Ship this |
| Pi GUI verifies link (TELEM2 HEARTBEAT, router status) | Complement |
| Optional later: pymavlink `PARAM_SET` over TELEM2 | Phase 2 after param pack proven |

### Ship to users

1. Short hardware checklist (dual USB power, dip switches, FC seated, air radio on TELEM1)  
2. **`rdi-mothership-telem.params`** (or equivalent) for roughly:  
   - `MAV_0_*` → TELEM1, FORWARD on, baud match radios (e.g. 57600)  
   - `MAV_1_*` → TELEM2, Onboard, 921600, FORWARD on, flow control off  
3. Pi GUI: “Download param pack” + “Verify companion link”  
4. Optional later: “Apply mothership defaults” via TELEM2 once FC is talking  

Drone-side: small snippet for `MAV_SYS_ID` (+ telem baud), sysid from pairing step.

---

## 7. Blank baseboard bring-up (factory vs field)

### What “blank” means

| Device | Out of box | Who prepares it |
|--------|------------|-----------------|
| CM4 / eMMC | Empty or stock OS | **Factory: flash RDI image** before customer pairing UI |
| Pixhawk | Stock PX4 / no RDI params | QGC + param pack (GUI verifies after) |
| RFD900x | Default SiK | Checklist / modem tools / later GUI assist |
| Relay claim | No `/etc/rdi/device.json` | Setup GUI after image + network |

A raw unflashed CM4 will **not** show a pairing screen. The product assumes a **pre-flashed RDI Pi image**.

### Factory → field pipeline

```text
FACTORY
  flash RDI CM4 image (OS + /opt/rdi + systemd + setup GUI)
  unclaimed state (no customer secrets)
        ↓
FIELD first power
  boot → setup GUI
  network → announce → pairing code  ← relay pairing screen
  user claims in cloud console
        ↓
  Pixhawk: QGC + params; GUI verify TELEM2
  Radios / drones: checklist + Add drone pairing codes
```

### “Validated before pairing” gate

Pairing screen is allowed only when:

1. RDI image / services healthy (`rdi-setup-ui`, relay stack present)  
2. Network up (API reachable)  
3. Device serial readable  

Then: announce → pairing code.  
**Not** required first: Pixhawk params, radios linked, drones registered.

### Kit SKUs (support)

1. **Dev kit:** flashed Pi (+ optional pre-param FC); GUI for claim + drones  
2. **Production:** factory flashes Pi only; FC/radios virgin + wizard + QGC pack  

---

## 8. Suggested implementation order (when unpinned)

1. **Pi Setup GUI v1** — claim code, claim status, network gate, reset/re-pair  
2. **Cloud** — reset endpoint (clear sessions + allow re-announce); drone pending-pair API  
3. **Add drone** in GUI + console claim → connections with `mavlink_sysid`  
4. **Param pack + Verify TELEM2** in GUI  
5. Optional auto-`PARAM_SET` for mothership defaults  

---

## 9. Decisions already made (for pickup)

- On-device GUI for relay code + reset: **yes**  
- Multi-drone radios: pairing codes like devices, bind to **`mavlink_sysid` + `radio_net_id`**, shared serial on mothership  
- PX4: **QGC + downloadable param/script pack**; GUI verifies; don’t clone QGC  
- Blank boards: **require factory RDI Pi image + network** before pairing UI; do **not** require PX4/radios done first  

---

## 10. Open questions / follow-ups

- Setup GUI stack: Flask/FastAPI + static UI vs Electron vs fullscreen Chromium kiosk  
- Exact cloud APIs for relay reset and drone pending-pair (TTL, who can claim)  
- Whether reset always wipes drone registry or offers a checkbox  
- Param pack format: QGC `.params` vs airframe file vs mavlink script  
- Factory image pipeline: `pi-gen` / golden image + `rpiboot` notes  

---

## 11. Context at pin time (hardware/software already working)

- Pi↔Pixhawk TELEM2 on `/dev/serial0` → `ttyAMA0` with `enable_uart=1` + `dtoverlay=disable-bt`  
- Daemon-owned **shared radio router** on `127.0.0.1:18771` (multi-session safe)  
- Ground RFD900 via FTDI; air on TELEM1; dual USB power common in lab  
- Claim files: `/etc/rdi/relay.conf`, `/etc/rdi/device.json` (strip nulls from Pi serial)  
- Deploy Pi software: `scripts/relay-device/deploy-to-pi.sh`  
