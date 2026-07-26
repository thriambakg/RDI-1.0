#!/usr/bin/env python3
"""Diagnose CM4 ↔ Pixhawk TELEM2 link on /dev/serial0 (or override)."""
from __future__ import annotations

import argparse
import os
import sys
import time

os.environ["MAVLINK20"] = "1"


def raw_sniff(port: str, baud: int, seconds: float = 2.0) -> int:
    import serial

    ser = serial.Serial(port, baud, timeout=0.1)
    try:
        deadline = time.time() + seconds
        n = 0
        while time.time() < deadline:
            chunk = ser.read(256)
            if chunk:
                n += len(chunk)
                print(f"  raw @{baud}: +{len(chunk)} bytes (total {n}) sample={chunk[:16]!r}")
        return n
    finally:
        ser.close()


def try_heartbeat(port: str, baud: int, timeout: float = 3.0) -> bool:
    from pymavlink import mavutil

    m = mavutil.mavlink_connection(port, baud=baud)
    try:
        hb = m.recv_match(type="HEARTBEAT", blocking=True, timeout=timeout)
        if hb is None:
            print(f"  mavlink @{baud}: no HEARTBEAT in {timeout}s")
            return False
        print(
            f"  mavlink @{baud}: HEARTBEAT type={getattr(hb, 'type', '?')} "
            f"autopilot={getattr(hb, 'autopilot', '?')} sys={m.target_system}"
        )
        return True
    finally:
        try:
            m.close()
        except Exception:
            pass


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", default="/dev/serial0")
    ap.add_argument(
        "--bauds",
        default="921600,57600,115200,230400,460800",
        help="Comma-separated baud rates to try",
    )
    args = ap.parse_args()
    bauds = [int(x) for x in args.bauds.split(",") if x.strip()]

    print(f"port={args.port}")
    if os.path.islink(args.port):
        print(f"link -> {os.readlink(args.port)}")
    if not os.path.exists(args.port):
        print("ERROR: port does not exist", file=sys.stderr)
        sys.exit(1)

    print("\n== raw byte sniff ==")
    for baud in bauds:
        n = raw_sniff(args.port, baud, seconds=1.5)
        if n == 0:
            print(f"  raw @{baud}: silence")

    print("\n== MAVLink HEARTBEAT ==")
    ok = False
    for baud in bauds:
        if try_heartbeat(args.port, baud, timeout=3.0):
            ok = True
            print(f"\nSUCCESS: use RDI_RADIO_BAUD={baud}")
            break
    if not ok:
        print("\nFAIL: no HEARTBEAT at any tried baud.")
        print("Check: FC powered, QGC sees vehicle on FC USB,")
        print("  MAV_1_CONFIG=TELEM2, SER_TEL2_BAUD, Pi UART enabled (raspi-config).")
        sys.exit(2)


if __name__ == "__main__":
    main()
