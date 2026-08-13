"""Newline-delimited JSON hop protocol for radio round-trip ping."""

from __future__ import annotations

import json
import time
import uuid
from typing import Any


PROTOCOL_VERSION = 1
LINE_END = b"\n"

# Short action codes for MAVLink TUNNEL's 128-byte payload limit.
ACTION_TO_SHORT: dict[str, str] = {
    "move_forward": "mf",
    "move_back": "mb",
    "move_left": "ml",
    "move_right": "mr",
    "move_up": "mu",
    "move_down": "md",
    "yaw_left": "yl",
    "yaw_right": "yr",
    "brake": "br",
    "rtl": "rt",
}
SHORT_TO_ACTION: dict[str, str] = {v: k for k, v in ACTION_TO_SHORT.items()}


def new_ping_id() -> str:
    return uuid.uuid4().hex[:12]


def abbreviate_actions(actions: list[str]) -> list[str]:
    return [ACTION_TO_SHORT.get(str(a), str(a)[:8]) for a in actions]


def expand_actions(actions: list[str]) -> list[str]:
    return [SHORT_TO_ACTION.get(str(a), str(a)) for a in actions]


def make_ping(
    hop: str,
    ping_id: str | None = None,
    hops: list[dict[str, Any]] | None = None,
    *,
    target_sysid: int | None = None,
) -> dict[str, Any]:
    now = time.time()
    out_hops = list(hops or [])
    out_hops.append({"hop": hop, "ts": now})
    msg: dict[str, Any] = {
        "v": PROTOCOL_VERSION,
        "type": "ping",
        "id": ping_id or new_ping_id(),
        "hops": out_hops,
    }
    if target_sysid is not None:
        msg["target_sysid"] = int(target_sysid)
    return msg


def make_pong(
    ping_msg: dict[str, Any],
    hop: str,
    *,
    turnaround_ms: int | None = None,
) -> dict[str, Any]:
    hops = list(ping_msg.get("hops") or [])
    hops.append({"hop": hop, "ts": time.time()})
    msg: dict[str, Any] = {
        "v": PROTOCOL_VERSION,
        "type": "pong",
        "id": str(ping_msg.get("id") or new_ping_id()),
        "hops": hops,
    }
    # Intentional half-duplex wait — Pi/UI subtract this for true air RTT.
    if turnaround_ms is not None and turnaround_ms > 0:
        msg["turnaround_ms"] = int(turnaround_ms)
    return msg


def _hop_ts_ms(ts: Any) -> int:
    try:
        tsf = float(ts or 0)
    except (TypeError, ValueError):
        return 0
    if tsf > 1e11:  # already milliseconds
        return int(round(tsf))
    return int(round(tsf * 1000.0))


def compact_hop_msg_for_tunnel(msg: dict[str, Any]) -> dict[str, Any]:
    """Minimal ping/pong wire format for MAVLink TUNNEL (128 bytes)."""
    hops_out: list[dict[str, Any]] = []
    for h in msg.get("hops") or []:
        if not isinstance(h, dict):
            continue
        name = str(h.get("hop") or h.get("h") or "?")[:10]
        ts = h.get("ts") if h.get("ts") is not None else h.get("t")
        hops_out.append({"h": name, "t": _hop_ts_ms(ts)})

    out: dict[str, Any] = {
        "v": int(msg.get("v") or PROTOCOL_VERSION),
        "type": str(msg.get("type") or "ping"),
        "id": str(msg.get("id") or new_ping_id())[:12],
        "hops": hops_out,
    }
    # sid only on ping (desktop filter); omit on pong.
    if out["type"] == "ping":
        sid = msg.get("target_sysid", msg.get("sid"))
        if sid is not None:
            try:
                out["sid"] = int(sid)
            except (TypeError, ValueError):
                pass
    if out["type"] == "pong":
        ta = msg.get("turnaround_ms", msg.get("ta"))
        if ta is not None:
            try:
                out["ta"] = int(ta)
            except (TypeError, ValueError):
                pass
    return out


def expand_hop_msg(msg: dict[str, Any]) -> dict[str, Any]:
    """Expand compact hop fields (`h`/`t`/`sid`/`ta`) to full names."""
    if msg.get("type") not in ("ping", "pong"):
        return msg
    out = dict(msg)
    if "target_sysid" not in out and out.get("sid") is not None:
        try:
            out["target_sysid"] = int(out["sid"])
        except (TypeError, ValueError):
            pass
    if "turnaround_ms" not in out and out.get("ta") is not None:
        try:
            out["turnaround_ms"] = int(out["ta"])
        except (TypeError, ValueError):
            pass
    hops: list[dict[str, Any]] = []
    for h in out.get("hops") or []:
        if not isinstance(h, dict):
            continue
        name = str(h.get("hop") or h.get("h") or "?")
        ts = h.get("ts") if h.get("ts") is not None else h.get("t")
        t_ms = _hop_ts_ms(ts)
        hops.append({"hop": name, "ts": t_ms / 1000.0})
    out["hops"] = hops
    return out


def make_ctrl(
    hop: str,
    actions: list[str],
    stream: str = "",
    *,
    target_sysid: int | None = None,
    ctrl_id: str | None = None,
    stack: str = "",
    pipe: str = "",
) -> dict[str, Any]:
    """Fire-and-forget control frame for radio path (preliminary / simulation)."""
    msg: dict[str, Any] = {
        "v": PROTOCOL_VERSION,
        "type": "ctrl",
        "id": ctrl_id or new_ping_id(),
        "hop": hop,
        "ts": time.time(),
        "actions": list(actions or []),
        "stream": stream or "",
    }
    if target_sysid is not None:
        msg["target_sysid"] = int(target_sysid)
    if stack:
        msg["stack"] = str(stack)
    if pipe:
        msg["pipe"] = str(pipe)
    return msg


def compact_ctrl_for_tunnel(msg: dict[str, Any]) -> dict[str, Any]:
    """Minimal CTRL wire format that fits MAVLink TUNNEL (128 bytes)."""
    actions = msg.get("actions") or msg.get("a") or []
    if not isinstance(actions, list):
        actions = []
    out: dict[str, Any] = {
        "v": PROTOCOL_VERSION,
        "type": "ctrl",
        "id": str(msg.get("id") or new_ping_id())[:12],
        "a": abbreviate_actions([str(x) for x in actions]),
    }
    stream = str(msg.get("stream") or msg.get("s") or "")
    if stream:
        out["s"] = stream[:40]
    stack = str(msg.get("stack") or msg.get("st") or "")
    if stack:
        out["st"] = stack[:16]
    pipe = str(msg.get("pipe") or msg.get("pp") or "")
    if pipe:
        out["pp"] = pipe[:16]
    if msg.get("target_sysid") is not None:
        out["target_sysid"] = int(msg["target_sysid"])
    return out


def normalize_ctrl_msg(msg: dict[str, Any]) -> dict[str, Any]:
    """Expand compact CTRL fields (`a`/`s`/`st`/`pp`) to full names."""
    if msg.get("type") != "ctrl":
        return msg
    out = dict(msg)
    if "actions" not in out and "a" in out:
        raw = out.get("a") or []
        out["actions"] = expand_actions([str(x) for x in raw] if isinstance(raw, list) else [])
    elif "actions" in out and isinstance(out["actions"], list):
        out["actions"] = expand_actions([str(x) for x in out["actions"]])
    if "stream" not in out and "s" in out:
        out["stream"] = str(out.get("s") or "")
    if "stack" not in out and "st" in out:
        out["stack"] = str(out.get("st") or "")
    if "pipe" not in out and "pp" in out:
        out["pipe"] = str(out.get("pp") or "")
    return out


def encode_line(msg: dict[str, Any]) -> bytes:
    return (json.dumps(msg, separators=(",", ":")) + "\n").encode("utf-8")


def decode_line(line: bytes | str) -> dict[str, Any] | None:
    if isinstance(line, bytes):
        text = line.decode("utf-8", errors="replace").strip()
    else:
        text = line.strip()
    if not text:
        return None
    try:
        msg = json.loads(text)
    except json.JSONDecodeError:
        return None
    if not isinstance(msg, dict) or msg.get("v") != PROTOCOL_VERSION:
        return None
    if msg.get("type") not in ("ping", "pong", "ctrl"):
        return None
    if msg.get("type") == "ctrl":
        return normalize_ctrl_msg(msg)
    return expand_hop_msg(msg)


def format_hops(hops: list[dict[str, Any]]) -> list[str]:
    """Human-readable hop lines with delta ms from first hop.

    Hop timestamps may be epoch seconds or milliseconds (and Pi vs desktop
    clocks can disagree). Normalize each ts to seconds, then report deltas so
    we never show nonsense like T+-1100ms from unit mismatch.
    """
    if not hops:
        return []

    def _as_seconds(ts: Any) -> float:
        try:
            t = float(ts or 0)
        except (TypeError, ValueError):
            return 0.0
        # Epoch ms are ~1e12; epoch seconds ~1e9.
        if t > 1e11:
            return t / 1000.0
        return t

    t0 = _as_seconds(hops[0].get("ts"))
    lines: list[str] = []
    for i, h in enumerate(hops):
        name = str(h.get("hop") or f"hop{i}")
        ts = _as_seconds(h.get("ts"))
        delta_ms = int(round((ts - t0) * 1000))
        # Clamp absurd deltas from residual clock skew for display only.
        if abs(delta_ms) > 60_000:
            lines.append(f"{i + 1}. {name}: T+? (clock skew)")
        else:
            lines.append(f"{i + 1}. {name}: T+{delta_ms}ms")
    return lines
