# Radio round-trip ping (MAVLink tunnel via TELEM1)

## Goal

```text
Browser ──WebRTC──► Pi worker ──MAVLink TUNNEL──► /dev/serial0 (TELEM2 internal)
                                                         │
                                                         ▼
                                                      Pixhawk
                                                         │ forward
                                                         ▼
                                              TELEM1 ──► air RFD900 ~~~ ground RFD900 ──► Desktop agent
```

Hop log example:

```text
1. browser: T+0ms
2. relay: T+12ms
3. desktop: T+48ms
4. relay: T+91ms
Round-trip 105ms.
Path: browser → relay → desktop → relay
```

## Why not `/dev/ttyAMA0`?

TELEM1 is owned by the **flight controller**, not the CM4. Linux cannot open TELEM1.
The only Pi↔FC serial path is **internal TELEM2** → `/dev/serial0` (usually 921600).
Our hop JSON rides inside MAVLink `TUNNEL` messages so PX4 can forward TELEM2 ↔ TELEM1.

## Files

| File | Role |
|------|------|
| `radio_hop_protocol.py` | Shared JSON hop frames |
| `radio_mavlink_bridge.py` | Pi MAVLink TUNNEL bridge |
| `radio_serial_bridge.py` | Optional raw JSON serial (lab / 2nd FTDI) |
| `radio_ping_desktop_agent.py` | Windows COM echo agent (`--mode mavlink`) |
| `kvs_master_worker.py` | WebRTC PING → radio round-trip when env set |

## 1. QGroundControl / PX4 parameters

Connect QGC to the baseboard **FC** USB-C port (not the CM4 USB). Set:

| Parameter | Value | Meaning |
|-----------|-------|---------|
| `MAV_0_CONFIG` | TELEM 1 | Radio port = MAVLink instance 0 |
| `MAV_0_MODE` | Normal | GCS/radio stream |
| `MAV_0_FORWARD` | Enabled | Forward messages to other instances |
| `SER_TEL1_BAUD` | 57600 | Match RFD900x |
| `MAV_1_CONFIG` | TELEM 2 | Companion (CM4) |
| `MAV_1_MODE` | Onboard | Companion stream |
| `MAV_1_FORWARD` | Enabled | Forward companion ↔ radio |
| `SER_TEL2_BAUD` | 921600 | Match CM4 `/dev/serial0` |

Reboot the flight controller after changing these.

On the Pi, confirm companion UART:

```bash
ls -l /dev/serial0
# usually → ttyAMA0 or ttyS0; Holybro docs: TELEM2 ↔ CM4 UART
```

## 2. Desktop agent (ground radio on COM5)

```powershell
cd C:\Users\thria\Documents\RDI\RDI-1.0\scripts\relay-device
py -3.12 -m pip install pyserial pymavlink
py -3.12 -u radio_ping_desktop_agent.py --port COM5 --baud 57600 --mode mavlink
```

## 3. Pi env + deploy

```bash
sudo mkdir -p /etc/rdi
sudo tee /etc/rdi/radio.env >/dev/null <<'EOF'
RDI_RADIO_MODE=mavlink
RDI_RADIO_PORT=/dev/serial0
RDI_RADIO_BAUD=921600
RDI_RADIO_TIMEOUT_SEC=8
EOF
```

Ensure systemd has `EnvironmentFile=-/etc/rdi/radio.env`, then:

```bash
# after copying scripts / running deploy-to-pi.sh
sudo /opt/rdi/venv/bin/pip install -r /opt/rdi/requirements-worker.txt
sudo systemctl restart rdi-relay-daemon
sudo journalctl -u rdi-relay-daemon -f
```

Worker log should show `radio=/dev/serial0 mode=mavlink baud=921600`.

## 4. Test

1. Antennas on both radios; desktop agent running (`mavlink` mode).
2. Air radio on **TELEM1**; Pi daemon restarted with env above.
3. Website: open session → Ping.
4. Expect hop lines in the UI and matching echoes in the desktop agent.

If the tunnel times out, ping falls back to **local** WebRTC PONG so sessions still work.

## Lab alternative: raw serial (2nd FTDI)

```text
RDI_RADIO_MODE=raw
RDI_RADIO_PORT=/dev/ttyUSB0
RDI_RADIO_BAUD=57600
```

Desktop: `--mode raw`.
