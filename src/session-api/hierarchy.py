"""
Helpers for user profile connection_hierarchy updates.
Shared logic for Session API to keep hierarchy in sync with connection pool.
"""

from typing import Any

DEFAULT_HIERARCHY = {
    "My Drones": {"sessions": [], "subfolders": {}},
    "Shared": {"sessions": [], "subfolders": {}},
}


def add_session_to_folder(
    hierarchy: dict, folder_path: list[str], session_id: str, name: str, status: str
) -> dict:
    """Add session to folder. folder_path e.g. ['My Drones'] or ['My Drones', 'Fleet A']."""
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
    folder.setdefault("sessions", []).append({
        "session_id": session_id,
        "name": name,
        "status": status,
    })
    return h


def update_session_status(hierarchy: dict, session_id: str, status: str) -> dict:
    """Update status of session_id anywhere in hierarchy."""
    h = _ensure_hierarchy(hierarchy)

    def _update(folder: dict) -> None:
        for s in folder.get("sessions", []):
            if s.get("session_id") == session_id:
                s["status"] = status
                return
        for sub in folder.get("subfolders", {}).values():
            _update(sub)

    for folder in h.values():
        _update(folder)
    return h


def remove_session(hierarchy: dict, session_id: str) -> dict:
    """Remove session_id from hierarchy. Top-level keys are folder names (e.g. My Drones, Shared)."""
    h = _ensure_hierarchy(hierarchy)

    def _remove(folder: dict) -> None:
        folder["sessions"] = [s for s in folder.get("sessions", []) if s.get("session_id") != session_id]
        for sub in folder.get("subfolders", {}).values():
            _remove(sub)

    for folder in h.values():
        _remove(folder)
    return h


def _ensure_hierarchy(h: dict | None) -> dict:
    """Return hierarchy with default folders if missing."""
    if not h:
        return dict(DEFAULT_HIERARCHY)
    for name, default in DEFAULT_HIERARCHY.items():
        if name not in h:
            h[name] = dict(default)
        elif "sessions" not in h[name]:
            h[name]["sessions"] = []
        if "subfolders" not in h[name]:
            h[name]["subfolders"] = {}
    return h
