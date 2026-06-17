"""Helpers for relay-registry active_sessions JSON (multi-drone per relay)."""

from __future__ import annotations

import json
from typing import Any


def parse_active_sessions(relay_item: dict) -> list[dict[str, Any]]:
    """Read active_sessions list from relay item, with legacy single-session fallback."""
    raw = (relay_item.get("active_sessions") or {}).get("S", "")
    if raw:
        try:
            data = json.loads(raw)
            if isinstance(data, list):
                return [e for e in data if isinstance(e, dict) and e.get("session_id")]
        except (json.JSONDecodeError, TypeError):
            pass
    sid = (relay_item.get("active_session_id") or {}).get("S", "")
    arn = (relay_item.get("signaling_channel_arn") or {}).get("S", "")
    if sid and arn:
        return [
            {
                "session_id": sid,
                "signaling_channel_arn": arn,
                "drone_id": (relay_item.get("active_drone_id") or {}).get("S", ""),
                "mavlink_port": int((relay_item.get("active_mavlink_port") or {}).get("N", "0") or 0) or None,
                "mavlink_host": (relay_item.get("active_mavlink_host") or {}).get("S", ""),
            }
        ]
    return []


def make_session_entry(
    session_id: str,
    signaling_channel_arn: str,
    *,
    drone_id: str = "",
    mavlink_port: int | None = None,
    mavlink_host: str = "",
) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "session_id": session_id,
        "signaling_channel_arn": signaling_channel_arn,
    }
    if drone_id:
        entry["drone_id"] = drone_id
    if mavlink_port is not None:
        entry["mavlink_port"] = mavlink_port
    if mavlink_host:
        entry["mavlink_host"] = mavlink_host
    return entry


def upsert_session_entry(sessions: list[dict[str, Any]], entry: dict[str, Any]) -> list[dict[str, Any]]:
    sid = entry.get("session_id")
    if not sid:
        return sessions
    out = [e for e in sessions if e.get("session_id") != sid]
    out.append(entry)
    return out


def remove_session_entry(sessions: list[dict[str, Any]], session_id: str) -> list[dict[str, Any]]:
    return [e for e in sessions if e.get("session_id") != session_id]
