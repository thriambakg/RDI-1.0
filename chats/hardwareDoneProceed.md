# Raspberry Pi CM4 to Desktop HITL Simulation: RFD900x Hardware & Software Guide

This document covers the complete hardware wiring, jumper layout, and asynchronous Python daemon bridge architecture required to stream WebRTC commands from a web platform over a 900MHz radio telemetry link to a desktop Hardware-in-the-Loop (HITL) drone simulation.

---

## 1. Hardware Architecture & Wiring Map

### Ground Side (Desktop Receiver)

* **Antennas:** Attach two **Long-Range Half-Wave Dipole Antennas** (3 dBi) to maximize reception. Never power on the modem without antennas connected.

* **Jumper Configuration:** Leave the plastic jumper block bridging **Pins 4 and 6** on the even row. This safely routes power from the USB port.

* **Cable Connection:** Plug the 6-pin female FTDI/USB cable directly onto the single row of **Odd-numbered pins (1, 3, 5, 7, 9, 11)**. Align the **Black wire (GND)** with **Pin 1** (marked with a white dot/triangle on the PCB).

* **PC Connection:** Plug the USB connector into a high-powered **USB 3.0 port** on your desktop PC to support peak transmit draws (~1A).

### Air Side (Holybro Baseboard / Pixhawk TELEM1 Radio)

* **Antennas:** Attach two **Stubby Monopole Antennas** (2.1 dBi) to minimize weight and aerodynamic drag on the airframe.

* **Jumper Configuration:** For the supplied Pixhawk telemetry cable, leave the plastic jumper block bridging **Pins 4 and 6** unless RFDesign's cable documentation says otherwise. The cable/jumper combination supplies the modem from TELEM1. Do not attach a second power source at the same time.

* **Cable Connection:** Plug the **White JST-GH connector** into the **TELEM 1** port on the Holybro Baseboard. Plug the **Black female 6-pin connector** directly onto the single row of **Odd-numbered pins (1, 3, 5, 7, 9, 11)** on the radio modem.

* **Alignment:** Align the **Black wire** of the telemetry cable with **Pin 1** of the modem's odd row. Verify the connector orientation against the modem's pin-1 marking before applying power.

> **Critical architecture fact:** The external **TELEM1 connector belongs to the Pixhawk flight-controller module**, not directly to Linux on the CM4. On Pixhawk 6X it is FMU UART7 (`/dev/ttyS6` inside PX4/NuttX). It does **not** appear as `/dev/ttyAMA0` or another Linux device on the Raspberry Pi.

```text

                  RFD900x PIN LAYOUT (LABEL FACING UP)

                           (ANTENNA END)

         2   [4]--[6]   8  10  12  14  16  <-- Even Row (Jumper on 4 & 6)

        (1)  (3)  (5)  (7) (9)(11) 13  15  <-- Odd Row (6-Pin Cable Plugs Here)

           ^

     (PIN 1 MARKER / BLACK WIRE)

```

---

## 2. What Is Already Running

The current relay software is intentionally independent of the radio:

```text
Browser ── WebRTC data channel ──► kvs_master_worker.py ── PONG ──► Browser
```

- `rdi-relay-daemon.py` handles device/session polling and worker lifecycle.
- `kvs_master_worker.py` handles KVS signaling, WebRTC, and the current `PING` → `PONG`.
- Neither process opens TELEM1 or another serial device today.
- Keep `rdi-relay-daemon` running while testing the radio. A standalone serial test must not modify or restart it.

The `scripts/proxy-agent` directory contains older local proxy simulations. It is not the active Pi WebRTC path and should not be used to enable this radio.

---

## 3. Correct Port Topology

```text
CM4 Linux                         Pixhawk FMU                        RFD900x
─────────                         ───────────                        ───────
/dev/serial0 (typical) ◄──────► TELEM2 (internal)
                                      │
                                      │ PX4 MAVLink routing
                                      ▼
                                 TELEM1 UART7 ◄──────────────────► Radio
```

Exact Linux device aliases can vary. Check them instead of assuming:

```bash
readlink -f /dev/serial0
readlink -f /dev/serial1
ls -l /dev/ttyAMA* /dev/ttyUSB* /dev/ttyACM* 2>/dev/null
```

Do **not** run a Python serial bridge against `/dev/ttyAMA0` under the assumption that it is TELEM1. On this baseboard TELEM1 is not exposed directly to CM4 Linux.

---

## 4. Two Valid Integration Paths

### Path A — Keep the Current TELEM1 Wiring

This is the installed hardware path. PX4 must participate:

1. CM4 communicates with the flight controller over the internal TELEM2 connection.
2. PX4 runs MAVLink on TELEM1 at the same baud rate as the RFD900x (start with `57600`, 8N1).
3. PX4 routes MAVLink between the companion link and the radio link.
4. The desktop RFD900x appears as a Windows COM port and connects to QGroundControl, Mission Planner, or the simulator.

This path carries **raw MAVLink frames**, not newline-delimited JSON. The earlier JSON bridge example was incompatible with PX4/HITL and has been removed.

Configure TELEM1 from QGroundControl/PX4 parameters for the exact flight-controller firmware. Typical settings are:

- TELEM1 protocol: MAVLink
- TELEM1 baud: `57600`
- MAVLink mode: Normal/Onboard as appropriate
- Hardware flow control: off unless both radio configuration and cable use RTS/CTS

Parameter names differ by PX4 release. Confirm the serial-port assignment shown by QGroundControl rather than blindly applying parameter numbers.

### Path B — Direct CM4 USB (Best Isolated Radio Smoke Test)

For a radio-only proof that bypasses PX4, connect the air RFD900x through a second 3.3 V-logic FTDI adapter into a CM4 Host USB port. It should appear as `/dev/ttyUSB0`.

This is the only path where the Pi can directly run a serial smoke test against the radio. It requires a second FTDI adapter because the bundle's included FTDI cable is already used on the desktop side.

---

## 5. Daemon-Safe Serial Smoke Test

A standalone test is available at:

```text
scripts/relay-device/radio_telem_smoke_test.py
```

It does not import, stop, or alter the relay daemon.

Install `pyserial` in the existing Pi virtual environment:

```bash
sudo /opt/rdi/venv/bin/pip install pyserial
```

Copy and inspect ports:

```powershell
scp "C:\Users\thria\Documents\RDI\RDI-1.0\scripts\relay-device\radio_telem_smoke_test.py" relay@RDIRelay.local:/tmp/
```

```bash
sudo cp /tmp/radio_telem_smoke_test.py /opt/rdi/
/opt/rdi/venv/bin/python3 /opt/rdi/radio_telem_smoke_test.py --list
```

If using **Path B** and `/dev/ttyUSB0` is confirmed:

```bash
/opt/rdi/venv/bin/python3 /opt/rdi/radio_telem_smoke_test.py \
  --port /dev/ttyUSB0 \
  --baud 57600
```

On Windows, open the desktop modem's COM port at `57600` and look for `RDI_RADIO_SMOKE` lines.

Do not run this smoke test on the CM4's internal TELEM2 UART while PX4 or another service is using it.

---

## 6. Next Software Step

After the physical radio path is verified, add an optional radio bridge to the active WebRTC worker:

```text
Browser WebRTC bytes
        │
        ├── PING → local PONG (existing behavior remains unchanged)
        │
        └── MAVLink bytes → radio/FC transport
```

The bridge should be:

- Disabled by default (for example, no `RDI_RADIO_PORT` means ping-only).
- Non-blocking so serial stalls cannot freeze WebRTC or daemon polling.
- Raw-byte/MAVLink aware; do not JSON-encode MAVLink.
- Bidirectional so desktop/drone telemetry returns over the WebRTC data channel.
- Isolated per physical radio endpoint; two workers must not open the same UART simultaneously.

Until this is implemented, successful browser ping proves WebRTC-to-Pi only. It does not prove WebRTC-to-radio-to-desktop.

