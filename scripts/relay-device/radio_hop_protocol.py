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


def make_pong(ping_msg: dict[str, Any], hop: str) -> dict[str, Any]:
    hops = list(ping_msg.get("hops") or [])
    hops.append({"hop": hop, "ts": time.time()})
    msg: dict[str, Any] = {
        "v": PROTOCOL_VERSION,
        "type": "pong",
        "id": str(ping_msg.get("id") or new_ping_id()),
        "hops": hops,
    }
    if ping_msg.get("target_sysid") is not None:
        msg["target_sysid"] = ping_msg.get("target_sysid")
    return msg


def make_ctrl(
    hop: str,
    actions: list[str],
    stream: str = "",
    *,
    target_sysid: int | None = None,
    ctrl_id: str | None = None,
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
        # Keep physical keys if they still fit; packer may drop later.
        out["s"] = stream[:48]
    if msg.get("target_sysid") is not None:
        out["target_sysid"] = int(msg["target_sysid"])
    return out


def normalize_ctrl_msg(msg: dict[str, Any]) -> dict[str, Any]:
    """Expand compact CTRL fields (`a`/`s`) to `actions`/`stream`."""
    if msg.get("type") != "ctrl":
        return msg
    out = dict(msg)
    if "actions" not in out and "a" in out:
        raw = out.get("a") or []
        out["actions"] = expand_actions([str(x) for x in raw] if isinstance(raw, list) else [])
    elif "actions" in out and isinstance(out["actions"], list):
        # May already be abbreviated on the wire.
        out["actions"] = expand_actions([str(x) for x in out["actions"]])
    if "stream" not in out and "s" in out:
        out["stream"] = str(out.get("s") or "")
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
    return msg


def format_hops(hops: list[dict[str, Any]]) -> list[str]:
    """Human-readable hop lines with delta ms from first hop."""
    if not hops:
        return []
    t0 = float(hops[0].get("ts") or 0)
    lines: list[str] = []
    for i, h in enumerate(hops):
        name = str(h.get("hop") or f"hop{i}")
        ts = float(h.get("ts") or t0)
        lines.append(f"{i + 1}. {name}: T+{int(round((ts - t0) * 1000))}ms")
    return lines
