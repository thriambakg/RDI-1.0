"""Newline-delimited JSON hop protocol for radio round-trip ping."""

from __future__ import annotations

import json
import time
import uuid
from typing import Any


PROTOCOL_VERSION = 1
LINE_END = b"\n"


def new_ping_id() -> str:
    return uuid.uuid4().hex[:12]


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
