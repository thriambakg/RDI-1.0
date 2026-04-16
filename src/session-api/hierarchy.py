"""
Helpers for user profile connection_hierarchy updates.
Shared logic for Session API to keep hierarchy in sync with connection pool.
"""

import copy
from typing import Any

# Shared folder has nested "Shared with me" and "Shared with others"
SHARED_DEFAULT = {
    "sessions": [],
    "subfolders": {
        "Shared with me": {"sessions": [], "subfolders": {}},
        "Shared with others": {"sessions": [], "subfolders": {}},
    },
}

DEFAULT_HIERARCHY = {
    "My Drones": {"sessions": [], "subfolders": {}},
    "Shared": copy.deepcopy(SHARED_DEFAULT),
}


def add_session_to_folder(
    hierarchy: dict,
    folder_path: list[str],
    session_id: str,
    name: str,
    status: str,
    relay_id: str | None = None,
) -> dict:
    """Add session to folder. folder_path e.g. ['My Drones'] or ['My Drones', 'Fleet A'].
    relay_id optional: which relay this session routes through."""
    h = _ensure_hierarchy(hierarchy)
    target = h
    for part in folder_path[:-1]:
        if part not in target:
            target[part] = {"sessions": [], "subfolders": {}}
        target = target[part].setdefault("subfolders", {})
    last = folder_path[-1] if folder_path else "My Drones"
    if last not in target:
        target[last] = {"sessions": [], "subfolders": {}}
    folder = target[last]
    sess = {"session_id": session_id, "name": name, "status": status}
    if relay_id:
        sess["relay_id"] = relay_id
    folder.setdefault("sessions", []).append(sess)
    return h


def _is_folder_node(node: Any) -> bool:
    """True if node looks like a folder dict (has sessions/subfolders or is a dict we can treat as folder)."""
    return isinstance(node, dict)


def _sessions_list(folder: dict) -> list:
    """Sessions array; tolerates DynamoDB format where it might be missing or not a list."""
    v = folder.get("sessions") if isinstance(folder, dict) else None
    return v if isinstance(v, list) else []


def _subfolders_map(folder: dict) -> dict:
    """Subfolders map; tolerates DynamoDB format where it might be missing or not a dict."""
    v = folder.get("subfolders") if isinstance(folder, dict) else None
    return v if isinstance(v, dict) else {}


def update_session_status(hierarchy: dict, session_id: str, status: str) -> dict:
    """Update status of session_id anywhere in hierarchy."""
    h = _ensure_hierarchy(hierarchy)

    def _update(folder: Any) -> None:
        if not _is_folder_node(folder):
            return
        for s in _sessions_list(folder):
            if isinstance(s, dict) and s.get("session_id") == session_id:
                s["status"] = status
                return
        for sub in _subfolders_map(folder).values():
            _update(sub)

    for folder in h.values():
        _update(folder)
    return h


def remove_session(hierarchy: dict, session_id: str) -> dict:
    """Remove session_id from hierarchy. Top-level keys are folder names (e.g. My Drones, Shared)."""
    h = _ensure_hierarchy(hierarchy)

    def _remove(folder: Any) -> None:
        if not _is_folder_node(folder):
            return
        folder["sessions"] = [
            s for s in _sessions_list(folder)
            if isinstance(s, dict) and s.get("session_id") != session_id
        ]
        for sub in _subfolders_map(folder).values():
            _remove(sub)

    for folder in h.values():
        _remove(folder)
    return h


def _ensure_shared_folder(h: dict) -> None:
    """Ensure 'Shared' exists at root with nested 'Shared with me' and 'Shared with others'. Idempotent."""
    if "Shared" not in h or not isinstance(h["Shared"], dict):
        h["Shared"] = copy.deepcopy(SHARED_DEFAULT)
        return
    node = h["Shared"]
    node.setdefault("sessions", [])
    if not isinstance(node.get("subfolders"), dict):
        node["subfolders"] = {}
    sub = node["subfolders"]
    for key in ("Shared with me", "Shared with others"):
        if key not in sub or not isinstance(sub.get(key), dict):
            sub[key] = {"sessions": [], "subfolders": {}}
        else:
            sub[key].setdefault("sessions", [])
            sub[key].setdefault("subfolders", {})


def _ensure_hierarchy(h: dict | None) -> dict:
    """Return hierarchy with default folders if missing. Normalizes nodes that are not dicts (e.g. list from DynamoDB)."""
    if not h or not isinstance(h, dict):
        out = {k: copy.deepcopy(v) for k, v in DEFAULT_HIERARCHY.items()}
        return out
    for name, default in DEFAULT_HIERARCHY.items():
        if name not in h:
            h[name] = copy.deepcopy(default)
        else:
            node = h[name]
            if not isinstance(node, dict):
                h[name] = copy.deepcopy(default)
            else:
                if "sessions" not in node or not isinstance(node.get("sessions"), list):
                    node["sessions"] = []
                if "subfolders" not in node or not isinstance(node.get("subfolders"), dict):
                    node["subfolders"] = {}
    _ensure_shared_folder(h)
    return h


# --- Relay helpers (user profile relays array) ---

def add_relay_to_profile(relays: list, relay: dict) -> list:
    """Add relay ref to user profile relays list. relay: {relay_id, wavelength_zone_id (AWS region id), name, relay_type, status}."""
    rl = list(relays) if isinstance(relays, list) else []
    # Avoid duplicate (same relay_id + zone)
    rid = relay.get("relay_id")
    zid = relay.get("wavelength_zone_id")
    rl = [r for r in rl if not (isinstance(r, dict) and r.get("relay_id") == rid and r.get("wavelength_zone_id") == zid)]
    rl.append({
        "relay_id": rid,
        "wavelength_zone_id": zid,
        "name": relay.get("name", "relay"),
        "relay_type": relay.get("relay_type", "local"),
        "status": relay.get("status", "offline"),
    })
    return rl


def remove_relay_from_profile(relays: list, relay_id: str, wavelength_zone_id: str) -> list:
    """Remove relay from user profile relays list."""
    rl = list(relays) if isinstance(relays, list) else []
    return [
        r for r in rl
        if not (isinstance(r, dict) and r.get("relay_id") == relay_id and r.get("wavelength_zone_id") == wavelength_zone_id)
    ]


def update_relay_in_profile(relays: list, relay_id: str, wavelength_zone_id: str, updates: dict) -> list:
    """Update relay in profile (name, status)."""
    rl = list(relays) if isinstance(relays, list) else []
    out = []
    for r in rl:
        if isinstance(r, dict) and r.get("relay_id") == relay_id and r.get("wavelength_zone_id") == wavelength_zone_id:
            r = {**r, **updates}
        out.append(r)
    return out
