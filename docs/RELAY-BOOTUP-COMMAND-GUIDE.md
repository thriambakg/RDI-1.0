# RDI relay bootup & command guide

**Audience:** human operator or AI assistant bringing the staging relay stack online.  
**Date:** 2026-07-26  
**Hostnames used here:** Pi `relay@RDIRelay.local` · Desktop Windows · Staging web app  

Related docs:
- Radio path detail: `scripts/relay-device/RADIO-TELEM.md`
- Per-drone addressing plan: `docs/CONNECTION-RADIO-ADDRESSING-PLAN.md`
- Relays architecture: `docs/architechure-master/ARCHITECTURE-RELAYS.md`

---

## 0. What “running” means

```text
Browser (staging) ──WebRTC──► Pi rdi-relay-daemon + kvs_master_worker
                                    │
                    optional radio ──┤
                                    ▼
                         air RFD900 ~~~ ground RFD900 ──► desktop agent (COM port)
```

| Piece | Must be up for… |
|-------|------------------|
| Pi + `rdi-relay-daemon` | Any WebRTC connection / **Ping relay** |
| Staging website session open | Browser ↔ Pi data channel |
| Desktop agent + radios | **Ping radio** (full RF path) |
| Pixhawk FC on CM4 baseboard | MAVLink tunnel via TELEM1 (`RDI_RADIO_MODE=mavlink`) |
| 2nd FTDI air radio → Pi USB | Lab RF without FC (`RDI_RADIO_MODE=raw`) |

**Pi-only board (no Pixhawk):** TELEM1 cannot talk to Linux. Use **Ping relay** only, or lab **raw** USB FTDI for radio tests.

---

## Step 1 — Boot the Raspberry Pi

1. Power the Holybro CM4 baseboard (and FC module if installed).  
2. Wait ~30–60s for network (Wi‑Fi / Ethernet).  
3. Antennas on any powered RFD900 before TX.  
4. From the PC, confirm the Pi is reachable:

```powershell
ping RDIRelay.local
```

| Command | What it does |
|---------|----------------|
| `ping RDIRelay.local` | Checks mDNS/network reachability to the Pi |

If ping fails: check power, Wi‑Fi, try `ping` to the Pi’s IP from your router, or connect a monitor/HDMI.

---

## Step 2 — SSH into the Pi

```powershell
ssh relay@RDIRelay.local
```

| Command | What it does |
|---------|----------------|
| `ssh relay@RDIRelay.local` | Opens a shell on the relay as user `relay` |

You should see a prompt like `relay@RDIRelay:~ $`.

Optional one-liner health check after login:

```bash
hostname; date; uptime
```

| Command | What it does |
|---------|----------------|
| `hostname` | Confirms you are on the right machine |
| `date` | Local Pi clock |
| `uptime` | How long since last boot |

---

## Step 3 — Confirm / start the relay daemon

The daemon polls AWS for active sessions and spawns a WebRTC **master** worker per session.

```bash
sudo systemctl status rdi-relay-daemon --no-pager
```

| Command | What it does |
|---------|----------------|
| `systemctl status rdi-relay-daemon` | Shows active/failed, main PID, recent log lines |

**Expected:** `Active: active (running)`.

If inactive or stuck:

```bash
sudo systemctl start rdi-relay-daemon
sudo systemctl restart rdi-relay-daemon
sudo systemctl enable rdi-relay-daemon
```

| Command | What it does |
|---------|----------------|
| `start` | Start if stopped |
| `restart` | Reload process (needed after code or `radio.env` changes) |
| `enable` | Start automatically on boot |

Follow live logs:

```bash
sudo journalctl -u rdi-relay-daemon -f -l
```

| Command | What it does |
|---------|----------------|
| `journalctl -u … -f` | Streams daemon + worker logs (`-l` = full lines) |
| Ctrl+C | Stop following (does not stop the daemon) |

Useful filters:

```bash
sudo journalctl -u rdi-relay-daemon --since "10 min ago" -l --no-pager | grep -E 'worker start|radio|mavlink|data channel open|FAILED|error'
```

| Pattern | Meaning |
|---------|---------|
| `worker start … radio=… mode=…` | Worker saw radio env |
| `mavlink bridge open` / `radio bridge open` | Serial/MAVLink path opened |
| `data channel open` | Browser WebRTC data channel up — safe to ping |
| `State.FAILED` / ICE | WebRTC path failed; reconnect session |
| `tunnel ping tx` | Radio ping left the Pi |
| `ping pong (local)` | Relay-only ping |

---

## Step 4 — Radio environment (optional)

Config file (loaded by systemd drop-in):

```bash
cat /etc/rdi/radio.env
systemctl show rdi-relay-daemon -p EnvironmentFiles -p ActiveState
```

| Command | What it does |
|---------|----------------|
| `cat /etc/rdi/radio.env` | Shows radio mode/port/baud |
| `systemctl show … EnvironmentFiles` | Confirms systemd loads that file |

### Mode A — Lab raw RF (air radio on Pi USB FTDI)

Requires `/dev/ttyUSB0` (second FTDI on air modem → CM4 **Host** USB):

```bash
sudo tee /etc/rdi/radio.env >/dev/null <<'EOF'
RDI_RADIO_MODE=raw
RDI_RADIO_PORT=/dev/ttyUSB0
RDI_RADIO_BAUD=57600
RDI_RADIO_TIMEOUT_SEC=5
EOF
sudo systemctl restart rdi-relay-daemon
```

Desktop agent: `--mode raw`.

### Mode B — Production MAVLink tunnel (needs Pixhawk)

Air radio on **TELEM1**; Pi uses companion UART:

```bash
sudo tee /etc/rdi/radio.env >/dev/null <<'EOF'
RDI_RADIO_MODE=mavlink
RDI_RADIO_PORT=/dev/serial0
RDI_RADIO_BAUD=921600
RDI_RADIO_TIMEOUT_SEC=8
EOF
sudo systemctl restart rdi-relay-daemon
```

Also requires PX4 `MAV_0/1_FORWARD` and bauds (see `RADIO-TELEM.md`). Desktop agent: `--mode mavlink`.

### Disable radio (relay-only)

```bash
sudo rm -f /etc/rdi/radio.env
# or empty the file / comment vars
sudo systemctl restart rdi-relay-daemon
```

Workers then log `radio=(local ping only)`.

Check serial devices:

```bash
ls -l /dev/serial0 /dev/ttyUSB0 2>/dev/null
```

| Path | Typical meaning |
|------|-----------------|
| `/dev/serial0` → `ttyS0` / `ttyAMA0` | CM4 ↔ FC TELEM2 (needs Pixhawk) |
| `/dev/ttyUSB0` | USB FTDI (lab air radio) |

---

## Step 5 — Desktop ground radio agent (Windows)

Only needed for **Ping radio**.

1. Plug ground RFD900 FTDI into the PC.  
2. Note COM port (Device Manager → Ports). Example: **COM5**.  
3. Close any other program using that COM port.

```powershell
cd C:\Users\thria\Documents\RDI\RDI-1.0\scripts\relay-device
py -3.12 -m pip install pyserial pymavlink
py -3.12 -u radio_ping_desktop_agent.py --port COM5 --baud 57600 --mode mavlink
```

For lab raw path:

```powershell
py -3.12 -u radio_ping_desktop_agent.py --port COM5 --baud 57600 --mode raw
```

| Command / flag | What it does |
|----------------|----------------|
| `py -3.12` | Use Python 3.12 (recommended on this machine) |
| `-u` | Unbuffered stdout (see echoes immediately) |
| `--port COM5` | Ground modem serial port |
| `--baud 57600` | Match RFD900 air rate / SiK baud |
| `--mode mavlink` | Expect MAVLink TUNNEL frames (FC path) |
| `--mode raw` | Expect newline JSON (USB↔USB lab path) |

**Success line:** `Opening COM5 … MAVLink TUNNEL` or `raw JSON`.  
Leave this window open. On a good radio ping you see `echoed … ping` with hop lines.

If `Access is denied`: another process holds COM5 — close it or kill the old `radio_ping_desktop_agent`.

---

## Step 6 — Website / session

1. Open the **staging** RDI web app; sign in.  
2. Ensure this Pi is a **claimed relay** in your region.  
3. **Create** or **open** a connection that uses that relay.  
4. Wait until WebRTC shows connected (Pi log: `data channel open`).  
5. Test connection:
   - **Ping relay** — browser ↔ Pi only (always works if WebRTC is up).  
   - **Ping radio** — full RF path (needs Steps 4–5 + hardware).

| Symptom | Likely cause |
|---------|----------------|
| Connect timeout / ICE FAILED | Network/NAT; reconnect; check Pi online |
| Ping relay OK, Ping radio ~8s fail | Radio/FC/USB path; desktop agent; FORWARD params |
| `tunnel_send` attribute error | Old Pi scripts; redeploy `radio_mavlink_bridge.py` with `MAVLINK20=1` |
| No desktop activity | Frames never reached ground radio |

---

## Step 7 — Update Pi software from the PC

From Windows (`scripts\relay-device`):

```powershell
cd C:\Users\thria\Documents\RDI\RDI-1.0\scripts\relay-device
scp kvs_master_worker.py radio_mavlink_bridge.py radio_hop_protocol.py radio_serial_bridge.py radio_telem_smoke_test.py radio_telem2_probe.py relay@RDIRelay.local:~/rdi-radio-deploy/
```

On the Pi:

```bash
sudo cp ~/rdi-radio-deploy/*.py /opt/rdi/
sudo /opt/rdi/venv/bin/pip install -r /opt/rdi/requirements-worker.txt
sudo systemctl restart rdi-relay-daemon
```

| Command | What it does |
|---------|----------------|
| `scp … relay@…:~/rdi-radio-deploy/` | Copies files to your home staging dir on the Pi |
| `sudo cp … /opt/rdi/` | Installs into the live app directory |
| `pip install -r requirements-worker.txt` | Ensures `pyserial`, `pymavlink`, etc. |
| `systemctl restart rdi-relay-daemon` | Loads new code into workers |

Full package install (from repo): `scripts/relay-device/deploy-to-pi.sh` (bash; needs SSH keys or interactive password).

---

## Step 8 — Frontend deploy (AWS)

From `RDI-1.0` repo root on Windows (PowerShell function):

```powershell
cd C:\Users\thria\Documents\RDI\RDI-1.0
tfpush "your commit message"
```

| Command | What it does |
|---------|----------------|
| `tfpush "…"` | `terraform fmt` → `git add` → `commit` → `push` → GitHub Actions deploys |

Do **not** run local `terraform apply` for normal app deploys.

---

## Quick reference — Pi

| Goal | Command |
|------|---------|
| SSH | `ssh relay@RDIRelay.local` |
| Daemon status | `sudo systemctl status rdi-relay-daemon --no-pager` |
| Restart daemon | `sudo systemctl restart rdi-relay-daemon` |
| Live logs | `sudo journalctl -u rdi-relay-daemon -f -l` |
| Recent errors | `sudo journalctl -u rdi-relay-daemon -n 80 -l --no-pager` |
| Radio env | `cat /etc/rdi/radio.env` |
| Serial devices | `ls -l /dev/serial0 /dev/ttyUSB* 2>/dev/null` |
| Stop daemon (free serial for probes) | `sudo systemctl stop rdi-relay-daemon` |
| TELEM2 probe (no FC → expect fail) | `sudo /opt/rdi/venv/bin/python3 ~/rdi-radio-deploy/radio_telem2_probe.py` |

## Quick reference — Windows

| Goal | Command |
|------|---------|
| Desktop agent (mavlink) | `py -3.12 -u radio_ping_desktop_agent.py --port COM5 --baud 57600 --mode mavlink` |
| Desktop agent (raw) | `… --mode raw` |
| List COM ports | Agent prints them on start; or Device Manager |
| Deploy scripts to Pi | `scp <files> relay@RDIRelay.local:~/rdi-radio-deploy/` |
| Push frontend/infra | `tfpush "message"` from `RDI-1.0` |

---

## Minimal “get online” checklist

1. Power Pi (+ FC/radios if testing RF).  
2. `ssh relay@RDIRelay.local`  
3. `sudo systemctl status rdi-relay-daemon` → **active**  
4. Open staging site → connection on this relay → wait for WebRTC.  
5. **Ping relay** → expect ~10–50 ms, path `browser → relay`.  
6. (Optional RF) Configure `radio.env`, restart daemon, start desktop agent, **Ping radio**.

---

## Hardware notes (short)

- **CM4 Host USB:** FTDI for lab air radio → `/dev/ttyUSB0`.  
- **TELEM1:** Pixhawk only; install FC module for production radio path.  
- **FC USB-C:** QGroundControl for PX4 params (not the CM4 USB).  
- **Ground radio:** Windows COM port + desktop agent.  
- Never power RFD900 without antennas.

---

## AI / automation hints

- Prefer **Ping relay** to verify cloud↔Pi before debugging RF.  
- Empty radio ping error + ~8000 ms RTT ⇒ timeout waiting for RF pong.  
- `got: None` on HEARTBEAT `/dev/serial0` with no Pixhawk is **expected**.  
- Do not set `RDI_RADIO_PORT=/dev/ttyAMA0` assuming it is TELEM1 — it is not.  
- After any `/opt/rdi/*.py` or `/etc/rdi/radio.env` change: **`systemctl restart rdi-relay-daemon`**.  
- Staging app deploys via **`tfpush`**, not local Terraform apply.
