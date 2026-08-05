"""Helpers for relay-registry active_sessions JSON (multi-drone per relay)."""

from __future__ import annotations

import json
from typing import Any


def parse_active_sessions(relay_item: dict) -> list[dict[str, Any]]:
    """Read active_sessions list from relay item, with legacy single-session fallback."""
    if "active_sessions" in relay_item:
        raw = relay_item["active_sessions"].get("S", "")
        if raw:
            try:
                data = json.loads(raw)
                if isinstance(data, list):
                    return [e for e in data if isinstance(e, dict) and e.get("session_id")]
            except (json.JSONDecodeError, TypeError):
                pass
        return []
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
    link_mode: str = "",
    vehicle_stack: str = "",
    mavlink_sysid: int | None = None,
    mavlink_compid: int | None = None,
    radio_net_id: int | None = None,
    radio_device: str = "",
    radio_baud: int | None = None,
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
    if link_mode:
        entry["link_mode"] = str(link_mode)
    if vehicle_stack:
        entry["vehicle_stack"] = str(vehicle_stack)
    if mavlink_sysid is not None:
        entry["mavlink_sysid"] = int(mavlink_sysid)
    if mavlink_compid is not None:
        entry["mavlink_compid"] = int(mavlink_compid)
    if radio_net_id is not None:
        entry["radio_net_id"] = int(radio_net_id)
    if radio_device:
        entry["radio_device"] = str(radio_device)
    if radio_baud is not None:
        entry["radio_baud"] = int(radio_baud)
    return entry


def radio_fields_from_metadata(metadata: dict | None) -> dict[str, Any]:
    """Extract optional radio-addressing + stack fields from session metadata dict."""
    out: dict[str, Any] = {}
    if not isinstance(metadata, dict):
        return out
    link_mode = metadata.get("link_mode")
    if isinstance(link_mode, str) and link_mode.strip():
        out["link_mode"] = link_mode.strip().lower()
    vehicle_stack = metadata.get("vehicle_stack")
    if isinstance(vehicle_stack, str) and vehicle_stack.strip():
        out["vehicle_stack"] = vehicle_stack.strip().lower()
    for key in ("mavlink_sysid", "mavlink_compid", "radio_net_id", "radio_baud"):
        if metadata.get(key) is None:
            continue
        try:
            out[key] = int(metadata[key])
        except (TypeError, ValueError):
            pass
    radio_device = metadata.get("radio_device")
    if isinstance(radio_device, str) and radio_device.strip():
        out["radio_device"] = radio_device.strip()
    return out


def upsert_session_entry(sessions: list[dict[str, Any]], entry: dict[str, Any]) -> list[dict[str, Any]]:
    sid = entry.get("session_id")
    if not sid:
        return sessions
    out = [e for e in sessions if e.get("session_id") != sid]
    out.append(entry)
    return out


def remove_session_entry(sessions: list[dict[str, Any]], session_id: str) -> list[dict[str, Any]]:
    return [e for e in sessions if e.get("session_id") != session_id]
