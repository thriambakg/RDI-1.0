#!/usr/bin/env python3
"""
Desktop radio ping echo agent — run on the PC with the ground RFD900 (FTDI COM port).

Modes:
  raw      — newline JSON on the serial port (USB↔USB / second-FTDI lab path)
  mavlink  — MAVLink TUNNEL wrapping (TELEM1 radio path through PX4)

Usage (Windows PowerShell):
  py -3.12 -m pip install pyserial pymavlink
  py -3.12 -u radio_ping_desktop_agent.py --port COM5 --baud 57600 --mode mavlink

Find COM port in Device Manager → Ports (COM & LPT).
"""

from __future__ import annotations

import argparse
import sys
import time

from radio_hop_protocol import decode_line, encode_line, format_hops, make_pong
from radio_mavlink_bridge import RDI_TUNNEL_PAYLOAD_TYPE, TUNNEL_PAYLOAD_MAX, _pack_payload, _unpack_payload


def _serial_device(port: str) -> str:
    """pymavlink treats bare 'COM5' as a log file on Windows — use \\\\.\\COM5."""
    p = port.strip()
    if sys.platform == "win32" and p.upper().startswith("COM") and not p.startswith("\\\\.\\"):
        return f"\\\\.\\{p.upper()}"
    return p


def _run_raw(port: str, baud: int) -> None:
    import serial

    print(f"\nOpening {port} @ {baud} raw JSON (Ctrl+C to stop)")
    ser = serial.Serial(port, baud, timeout=0.2)
    buf = bytearray()
    n = 0
    try:
        while True:
            chunk = ser.read(256)
            if chunk:
                buf.extend(chunk)
                while True:
                    nl = buf.find(b"\n")
                    if nl < 0:
                        break
                    line = bytes(buf[: nl + 1])
                    del buf[: nl + 1]
                    msg = decode_line(line)
                    if not msg:
                        print(f"RX (ignored): {line!r}")
                        continue
                    if msg.get("type") != "ping":
                        print(f"RX non-ping: {msg}")
                        continue
                    n += 1
                    pong = make_pong(msg, "desktop")
                    ser.write(encode_line(pong))
                    ser.flush()
                    hops = format_hops(list(pong.get("hops") or []))
                    print(f"\n[{n}] echoed ping id={pong.get('id')}")
                    for h in hops:
                        print(f"    {h}")
            else:
                time.sleep(0.02)
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        ser.close()


def _run_mavlink(port: str, baud: int) -> None:
    from pymavlink import mavutil

    device = _serial_device(port)
    print(f"\nOpening {port} ({device}) @ {baud} MAVLink TUNNEL (Ctrl+C to stop)")
    conn = mavutil.mavlink_connection(
        device,
        baud=baud,
        source_system=254,
        source_component=191,
        autoreconnect=True,
    )
    n = 0
    last_hb = 0.0
    try:
        while True:
            now = time.time()
            if now - last_hb >= 1.0:
                conn.mav.heartbeat_send(
                    mavutil.mavlink.MAV_TYPE_GCS,
                    mavutil.mavlink.MAV_AUTOPILOT_INVALID,
                    0,
                    0,
                    0,
                )
                last_hb = now

            msg = conn.recv_match(type="TUNNEL", blocking=True, timeout=0.2)
            if msg is None:
                continue
            if int(getattr(msg, "payload_type", -1)) != RDI_TUNNEL_PAYLOAD_TYPE:
                continue
            decoded = _unpack_payload(bytes(msg.payload), int(msg.payload_length))
            if not decoded:
                print(f"RX TUNNEL (ignored) len={msg.payload_length}")
                continue
            if decoded.get("type") != "ping":
                print(f"RX TUNNEL non-ping: {decoded.get('type')}")
                continue

            n += 1
            pong = make_pong(decoded, "desktop")
            raw = _pack_payload(pong)
            payload = raw + b"\x00" * (TUNNEL_PAYLOAD_MAX - len(raw))
            conn.mav.tunnel_send(0, 0, RDI_TUNNEL_PAYLOAD_TYPE, len(raw), payload)
            hops = format_hops(list(pong.get("hops") or []))
            print(f"\n[{n}] echoed TUNNEL ping id={pong.get('id')}")
            for h in hops:
                print(f"    {h}")
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        try:
            conn.close()
        except Exception:
            pass


def main() -> None:
    ap = argparse.ArgumentParser(description="RDI desktop radio ping echo agent")
    ap.add_argument("--port", required=True, help="Serial port, e.g. COM5")
    ap.add_argument("--baud", type=int, default=57600)
    ap.add_argument(
        "--mode",
        choices=("mavlink", "raw"),
        default="mavlink",
        help="mavlink = TELEM1/PX4 path (default); raw = newline JSON",
    )
    args = ap.parse_args()

    try:
        import serial  # noqa: F401
        from serial.tools import list_ports
    except ImportError:
        print("Install pyserial: pip install pyserial", file=sys.stderr)
        sys.exit(1)

    if args.mode == "mavlink":
        try:
            import pymavlink  # noqa: F401
        except ImportError:
            print("Install pymavlink: pip install pymavlink", file=sys.stderr)
            sys.exit(1)

    print("Available ports:")
    for p in list_ports.comports():
        print(f"  {p.device:12s}  {p.description}")

    if args.mode == "mavlink":
        _run_mavlink(args.port, args.baud)
    else:
        _run_raw(args.port, args.baud)


if __name__ == "__main__":
    main()
