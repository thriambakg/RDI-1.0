#!/usr/bin/env python3
"""
Standalone RFD900 / TELEM smoke test — does NOT touch rdi-relay-daemon.

Ping / WebRTC stay on kvs_master_worker. This process only opens a serial port
and sends/receives bytes so you can verify the radio path to the desktop.

Important (Holybro Pixhawk CM4 baseboard):
  TELEM1 is wired to the Pixhawk FMU (UART7), NOT to the CM4 Linux UARTs.
  The CM4 only has TELEM2 internally (typically /dev/ttyAMA1 or /dev/serial0).

  So "activate TELEM1 on the Pi" usually means one of:
    A) Open a USB-serial (/dev/ttyUSB0) if the air modem uses FTDI into CM4 Host USB
    B) Talk MAVLink to the FC on the companion UART (TELEM2) and let PX4 forward
       to TELEM1 (radio) — not a raw byte pipe
    C) Use this script against whichever /dev/tty* actually maps to your radio

Usage on Pi (daemon can keep running):
  sudo /opt/rdi/venv/bin/pip install pyserial   # once
  python3 radio_telem_smoke_test.py --list
  python3 radio_telem_smoke_test.py --port /dev/ttyUSB0 --baud 57600
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path


def list_ports() -> None:
    try:
        from serial.tools import list_ports
    except ImportError:
        print("pyserial not installed. Run: pip install pyserial", file=sys.stderr)
        sys.exit(1)

    ports = list(list_ports.comports())
    print("Detected serial ports:")
    if not ports:
        print("  (none)")
    for p in ports:
        print(f"  {p.device:20s}  {p.description}  [{p.hwid}]")

    print("\nCommon device nodes on CM4:")
    for cand in (
        "/dev/ttyAMA0",
        "/dev/ttyAMA1",
        "/dev/ttyAMA2",
        "/dev/ttyAMA3",
        "/dev/serial0",
        "/dev/serial1",
        "/dev/ttyUSB0",
        "/dev/ttyUSB1",
        "/dev/ttyACM0",
    ):
        path = Path(cand)
        mark = "exists" if path.exists() else "missing"
        print(f"  {cand:20s}  {mark}")


def run_loop(port: str, baud: int, interval: float) -> None:
    try:
        import serial
    except ImportError:
        print("pyserial not installed. Run: pip install pyserial", file=sys.stderr)
        sys.exit(1)

    print(f"Opening {port} @ {baud} 8N1 (Ctrl+C to stop)")
    print("Daemon / WebRTC ping is unrelated — leave rdi-relay-daemon running.")
    ser = serial.Serial(
        port=port,
        baudrate=baud,
        bytesize=serial.EIGHTBITS,
        parity=serial.PARITY_NONE,
        stopbits=serial.STOPBITS_ONE,
        timeout=0.2,
    )
    n = 0
    try:
        while True:
            n += 1
            line = f"RDI_RADIO_SMOKE n={n} t={time.time():.3f}\n"
            ser.write(line.encode("utf-8"))
            ser.flush()
            print(f"TX  {line.strip()}")

            deadline = time.monotonic() + interval
            while time.monotonic() < deadline:
                raw = ser.read(256)
                if raw:
                    try:
                        text = raw.decode("utf-8", errors="replace").rstrip()
                    except Exception:
                        text = repr(raw)
                    print(f"RX  {text}")
                time.sleep(0.05)
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        ser.close()


def main() -> None:
    ap = argparse.ArgumentParser(description="RDI radio / TELEM serial smoke test (daemon-safe)")
    ap.add_argument("--list", action="store_true", help="List serial ports and exit")
    ap.add_argument(
        "--port",
        default="/dev/ttyUSB0",
        help="Serial device (default /dev/ttyUSB0 — TELEM1 is NOT a CM4 tty)",
    )
    ap.add_argument("--baud", type=int, default=57600, help="Baud rate (RFD900 default 57600)")
    ap.add_argument("--interval", type=float, default=1.0, help="Seconds between TX lines")
    args = ap.parse_args()

    if args.list:
        list_ports()
        return

    run_loop(args.port, args.baud, args.interval)


if __name__ == "__main__":
    main()
