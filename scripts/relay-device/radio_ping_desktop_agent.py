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

from radio_hop_protocol import (
    decode_line,
    encode_line,
    format_hops,
    make_pong,
    normalize_ctrl_msg,
)
from radio_mavlink_bridge import RDI_TUNNEL_PAYLOAD_TYPE, TUNNEL_PAYLOAD_MAX, _pack_payload, _unpack_payload


def _pipe_banner(mode: str) -> str:
    """Human-readable pipe identity for this agent process."""
    if mode == "raw":
        return "radio_raw (newline JSON on serial)"
    return "radio_mavlink (MAVLink TUNNEL over TELEM/FTDI)"


def _format_ctrl_line(n: int, msg: dict) -> str:
    ctrl = normalize_ctrl_msg(msg)
    acts = [str(a) for a in (ctrl.get("actions") or [])]
    stream = ctrl.get("stream") or "—"
    stack = ctrl.get("stack") or "—"
    pipe = ctrl.get("pipe") or "—"
    sysid = ctrl.get("target_sysid")
    if not acts:
        return f"[{n}] CTRL release  pipe={pipe}  stack={stack}  sysid={sysid}"
    return (
        f"\n[{n}] CTRL hold  pipe={pipe}  stack={stack}  "
        f"actions={'+'.join(acts)}  keys={stream}  sysid={sysid}"
    )


def _target_sysid(msg: dict) -> int | None:
    """Resolve target_sysid from full or compact (`sid`) fields."""
    ctrl = normalize_ctrl_msg(msg) if msg.get("type") == "ctrl" else msg
    raw = ctrl.get("target_sysid", ctrl.get("sid"))
    if raw is None:
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def _sysid_mismatch(msg: dict, filter_sysid: int | None) -> bool:
    """True when this agent should ignore the frame (wrong aircraft)."""
    if filter_sysid is None:
        return False
    tgt = _target_sysid(msg)
    return tgt is not None and tgt != filter_sysid


def _skip_foreign(kind: str, msg: dict, filter_sysid: int | None, verbose: bool) -> bool:
    """Return True if frame should be ignored. Only print when --verbose."""
    if not _sysid_mismatch(msg, filter_sysid):
        return False
    if verbose:
        print(f"RX {kind} for sysid={_target_sysid(msg)} (skip)")
    return True


def _serial_device(port: str) -> str:
    """pymavlink treats bare 'COM5' as a log file on Windows — use \\\\.\\COM5."""
    p = port.strip()
    if sys.platform == "win32" and p.upper().startswith("COM") and not p.startswith("\\\\.\\"):
        return f"\\\\.\\{p.upper()}"
    return p


def _run_raw(port: str, baud: int, sysid: int | None, verbose: bool = False) -> None:
    import serial

    print(f"\nOpening {port} @ {baud} raw JSON (Ctrl+C to stop)")
    print(f"Desktop agent pipe: {_pipe_banner('raw')}")
    if sysid is not None:
        print(f"Filtering target_sysid={sysid} (foreign frames silent unless --verbose)")
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
                    if msg.get("type") == "ctrl":
                        if _skip_foreign("ctrl", msg, sysid, verbose):
                            continue
                        n += 1
                        print(_format_ctrl_line(n, msg))
                        continue
                    if msg.get("type") != "ping":
                        print(f"RX non-ping: {msg}")
                        continue
                    if _skip_foreign("ping", msg, sysid, verbose):
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


def _run_mavlink(port: str, baud: int, sysid: int | None, verbose: bool = False) -> None:
    import os

    os.environ["MAVLINK20"] = "1"
    from pymavlink import mavutil

    device = _serial_device(port)
    print(f"\nOpening {port} ({device}) @ {baud} MAVLink TUNNEL (Ctrl+C to stop)")
    print(f"Desktop agent pipe: {_pipe_banner('mavlink')}")
    if sysid is not None:
        print(f"Filtering target_sysid={sysid} (foreign frames silent unless --verbose)")
    conn = mavutil.mavlink_connection(
        device,
        baud=baud,
        source_system=254,
        source_component=191,
        autoreconnect=True,
    )
    if not hasattr(conn.mav, "tunnel_send"):
        raise RuntimeError(
            "pymavlink lacks tunnel_send — set MAVLINK20=1 before import "
            f"(dialect={getattr(conn.mav, '__module__', '?')})"
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
            if decoded.get("type") == "ctrl":
                if _skip_foreign("TUNNEL ctrl", decoded, sysid, verbose):
                    continue
                n += 1
                print(_format_ctrl_line(n, decoded))
                continue
            if decoded.get("type") != "ping":
                print(f"RX TUNNEL non-ping: {decoded.get('type')}")
                continue
            if _skip_foreign("TUNNEL ping", decoded, sysid, verbose):
                continue

            n += 1
            tgt = _target_sysid(decoded)
            pong = make_pong(decoded, "desktop")
            try:
                raw = _pack_payload(pong)
            except ValueError as e:
                print(f"[{n}] CTRL/pong pack failed: {e} — skipping echo")
                continue
            payload = raw + b"\x00" * (TUNNEL_PAYLOAD_MAX - len(raw))
            conn.mav.tunnel_send(0, 0, RDI_TUNNEL_PAYLOAD_TYPE, len(raw), payload)
            hops = format_hops(list(pong.get("hops") or []))
            print(f"\n[{n}] echoed TUNNEL ping id={pong.get('id')} sysid={tgt} ({len(raw)}B)")
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
    ap.add_argument(
        "--sysid",
        type=int,
        default=None,
        help="Only handle ping/CTRL for this target_sysid (omit to answer all)",
    )
    ap.add_argument(
        "--verbose",
        action="store_true",
        help="Log skipped frames for other sysids",
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
        _run_mavlink(args.port, args.baud, args.sysid, args.verbose)
    else:
        _run_raw(args.port, args.baud, args.sysid, args.verbose)


if __name__ == "__main__":
    main()
