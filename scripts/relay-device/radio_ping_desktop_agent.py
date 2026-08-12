#!/usr/bin/env python3
"""
Desktop radio ping echo agent — run on the PC with the ground RFD900 (FTDI COM port).

Modes:
  mavlink  — MAVLink TUNNEL wrapping (TELEM1 radio path through PX4)
  raw      — newline JSON on the serial port (USB↔USB / second-FTDI lab path)

Usage (Windows PowerShell):
  py -3.12 -m pip install pyserial pymavlink
  py -3.12 -u radio_ping_desktop_agent.py --port COM5 --baud 57600 --mode mavlink --sysid 1

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


class _Diag:
    """Rolling counters for dual-sysid / half-duplex diagnosis."""

    def __init__(self, filter_sysid: int | None, quiet: bool) -> None:
        self.filter_sysid = filter_sysid
        self.quiet = quiet
        self.t0 = time.time()
        self.last_report = self.t0
        self.rx_ping = 0
        self.echo_ping = 0
        self.skip_ping = 0
        self.rx_ctrl = 0
        self.skip_ctrl = 0
        self.rx_pong = 0
        self.rx_other = 0
        self.rx_bad = 0

    def note(self, kind: str) -> None:
        if kind == "rx_ping":
            self.rx_ping += 1
        elif kind == "echo_ping":
            self.echo_ping += 1
        elif kind == "skip_ping":
            self.skip_ping += 1
        elif kind == "rx_ctrl":
            self.rx_ctrl += 1
        elif kind == "skip_ctrl":
            self.skip_ctrl += 1
        elif kind == "rx_pong":
            self.rx_pong += 1
        elif kind == "rx_other":
            self.rx_other += 1
        elif kind == "rx_bad":
            self.rx_bad += 1

    def maybe_report(self, force: bool = False) -> None:
        now = time.time()
        if not force and now - self.last_report < 5.0:
            return
        self.last_report = now
        filt = self.filter_sysid if self.filter_sysid is not None else "any"
        print(
            f"[diag filter={filt}] "
            f"ping rx={self.rx_ping} echo={self.echo_ping} skip={self.skip_ping} | "
            f"ctrl rx={self.rx_ctrl} skip={self.skip_ctrl} | "
            f"pong overheard={self.rx_pong} other={self.rx_other} bad={self.rx_bad} "
            f"(uptime {int(now - self.t0)}s)"
        )


def _skip_foreign(
    kind: str,
    msg: dict,
    filter_sysid: int | None,
    *,
    verbose: bool,
    quiet: bool,
    diag: _Diag,
) -> bool:
    """Return True if frame should be ignored."""
    if not _sysid_mismatch(msg, filter_sysid):
        return False
    tgt = _target_sysid(msg)
    if kind.endswith("ping"):
        diag.note("skip_ping")
        # Pings are rare — always log skips unless --quiet (dual-sysid diagnosis).
        if not quiet:
            print(f"RX {kind} id={msg.get('id')} sid={tgt} (skip filter={filter_sysid})")
    else:
        diag.note("skip_ctrl")
        if verbose and not quiet:
            print(f"RX {kind} for sysid={tgt} (skip filter={filter_sysid})")
    return True


def _serial_device(port: str) -> str:
    """pymavlink treats bare 'COM5' as a log file on Windows — use \\\\.\\COM5."""
    p = port.strip()
    if sys.platform == "win32" and p.upper().startswith("COM") and not p.startswith("\\\\.\\"):
        return f"\\\\.\\{p.upper()}"
    return p


def _run_raw(port: str, baud: int, sysid: int | None, verbose: bool = False, quiet: bool = False) -> None:
    import serial

    print(f"\nOpening {port} @ {baud} raw JSON (Ctrl+C to stop)")
    print(f"Desktop agent pipe: {_pipe_banner('raw')}")
    if sysid is not None:
        print(f"Filtering target_sysid={sysid} (ping skips always logged; CTRL skips need --verbose)")
    print("Diag stats every 5s")
    diag = _Diag(sysid, quiet)
    ser = serial.Serial(port, baud, timeout=0.2)
    buf = bytearray()
    n = 0
    try:
        while True:
            diag.maybe_report()
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
                        diag.note("rx_bad")
                        print(f"RX (ignored): {line!r}")
                        continue
                    if msg.get("type") == "ctrl":
                        diag.note("rx_ctrl")
                        if _skip_foreign("ctrl", msg, sysid, verbose=verbose, quiet=quiet, diag=diag):
                            continue
                        n += 1
                        print(_format_ctrl_line(n, msg))
                        continue
                    if msg.get("type") == "pong":
                        diag.note("rx_pong")
                        if not quiet:
                            print(f"RX pong id={msg.get('id')} (overheard)")
                        continue
                    if msg.get("type") != "ping":
                        diag.note("rx_other")
                        print(f"RX non-ping: {msg.get('type')}")
                        continue
                    diag.note("rx_ping")
                    if _skip_foreign("ping", msg, sysid, verbose=verbose, quiet=quiet, diag=diag):
                        continue
                    n += 1
                    diag.note("echo_ping")
                    pong = make_pong(msg, "desktop")
                    ser.write(encode_line(pong))
                    hops = format_hops(list(pong.get("hops") or []))
                    print(f"\n[{n}] echoed ping id={pong.get('id')} sysid={_target_sysid(msg)}")
                    for h in hops:
                        print(f"    {h}")
            else:
                time.sleep(0.01)
    except KeyboardInterrupt:
        print("\nStopped.")
        diag.maybe_report(force=True)
    finally:
        ser.close()


def _echo_pong_mavlink(conn, decoded: dict, *, turnaround_ms: int, n: int, diag: _Diag) -> None:
    """Wait for half-duplex turnaround, then TX pong (optionally twice)."""
    tgt = _target_sysid(decoded)
    # Mothership is still finishing the ping TX on shared RF — echo immediately
    # and the return is lost (pong overheard stays 0; Pi times out).
    if turnaround_ms > 0:
        time.sleep(turnaround_ms / 1000.0)
    pong = make_pong(decoded, "desktop")
    # Stamp desktop hop with local clock for display (ignore Pi clock skew).
    hops = list(pong.get("hops") or [])
    if hops:
        t_relay = float(hops[0].get("ts") or time.time())
        # Prefer relative display: relay=0, desktop=turnaround
        pong = {
            **pong,
            "hops": [
                {"hop": "relay", "ts": t_relay},
                {"hop": "desktop", "ts": t_relay + (turnaround_ms / 1000.0)},
            ],
        }
    try:
        raw = _pack_payload(pong)
    except ValueError as e:
        print(f"[{n}] pong pack failed: {e} — skipping echo")
        return
    payload = raw + b"\x00" * (TUNNEL_PAYLOAD_MAX - len(raw))
    conn.mav.tunnel_send(0, 0, RDI_TUNNEL_PAYLOAD_TYPE, len(raw), payload)
    # Second copy improves return odds on half-duplex SiK/RFD.
    time.sleep(0.03)
    conn.mav.tunnel_send(0, 0, RDI_TUNNEL_PAYLOAD_TYPE, len(raw), payload)
    diag.note("echo_ping")
    print(
        f"\n[{n}] echoed TUNNEL ping id={pong.get('id')} sysid={tgt} "
        f"({len(raw)}B, turnaround={turnaround_ms}ms, x2)"
    )
    print(f"    1. relay: T+0ms")
    print(f"    2. desktop: T+{turnaround_ms}ms (local turnaround; Pi clock ignored)")


def _run_mavlink(
    port: str,
    baud: int,
    sysid: int | None,
    verbose: bool = False,
    quiet: bool = False,
    turnaround_ms: int = 120,
) -> None:
    import os

    os.environ["MAVLINK20"] = "1"
    from pymavlink import mavutil

    device = _serial_device(port)
    print(f"\nOpening {port} ({device}) @ {baud} MAVLink TUNNEL (Ctrl+C to stop)")
    print(f"Desktop agent pipe: {_pipe_banner('mavlink')}")
    if sysid is not None:
        print(f"Filtering target_sysid={sysid} (ping skips always logged; CTRL skips need --verbose)")
    print(f"Half-duplex turnaround before pong echo: {turnaround_ms}ms")
    print("Diag stats every 5s — watch ping rx vs echo vs skip; pong overheard should rise")
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
    diag = _Diag(sysid, quiet)
    n = 0
    last_hb = 0.0
    try:
        while True:
            diag.maybe_report()
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
                diag.note("rx_bad")
                print(f"RX TUNNEL (ignored) len={msg.payload_length}")
                continue
            if decoded.get("type") == "ctrl":
                diag.note("rx_ctrl")
                if _skip_foreign("TUNNEL ctrl", decoded, sysid, verbose=verbose, quiet=quiet, diag=diag):
                    continue
                n += 1
                print(_format_ctrl_line(n, decoded))
                continue
            if decoded.get("type") == "pong":
                diag.note("rx_pong")
                if not quiet:
                    print(f"RX TUNNEL pong id={decoded.get('id')} (overheard — return path on air)")
                continue
            if decoded.get("type") != "ping":
                diag.note("rx_other")
                print(f"RX TUNNEL non-ping: {decoded.get('type')}")
                continue
            diag.note("rx_ping")
            if _skip_foreign("TUNNEL ping", decoded, sysid, verbose=verbose, quiet=quiet, diag=diag):
                continue
            if not quiet:
                print(
                    f"RX TUNNEL ping id={decoded.get('id')} sid={_target_sysid(decoded)} "
                    f"(mine — echoing after {turnaround_ms}ms)"
                )

            n += 1
            _echo_pong_mavlink(conn, decoded, turnaround_ms=turnaround_ms, n=n, diag=diag)
    except KeyboardInterrupt:
        print("\nStopped.")
        diag.maybe_report(force=True)
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
        help="Also log skipped CTRL frames for other sysids",
    )
    ap.add_argument(
        "--quiet",
        action="store_true",
        help="Suppress ping-skip / overheard-pong lines (stats still print)",
    )
    ap.add_argument(
        "--turnaround-ms",
        type=int,
        default=120,
        help="Wait this many ms after RX ping before TX pong (half-duplex SiK/RFD, default 120)",
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

    if args.mode == "raw":
        _run_raw(args.port, args.baud, args.sysid, verbose=args.verbose, quiet=args.quiet)
    else:
        _run_mavlink(
            args.port,
            args.baud,
            args.sysid,
            verbose=args.verbose,
            quiet=args.quiet,
            turnaround_ms=max(0, int(args.turnaround_ms)),
        )


if __name__ == "__main__":
    main()
