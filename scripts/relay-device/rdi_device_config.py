"""Load relay device credentials and API config from /etc/rdi (see rdi-relay-claim.py)."""

from __future__ import annotations

import json
import os
from pathlib import Path

CONFIG_PATH = Path(os.environ.get("RDI_RELAY_CONFIG", "/etc/rdi/relay.conf"))
DEVICE_STATE_PATH = Path(os.environ.get("RDI_DEVICE_STATE", "/etc/rdi/device.json"))


def _clean_credential(value: str) -> str:
    """Strip null bytes (common in Pi devicetree serial-number files)."""
    return value.replace("\x00", "").strip()


def _parse_conf(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        out[key.strip()] = value.strip()
    return out


def load_device_config() -> dict[str, str]:
    """Return api_base_url, device_serial, device_secret, relay_id, etc."""
    conf = _parse_conf(CONFIG_PATH)
    state: dict = {}
    if DEVICE_STATE_PATH.exists():
        state = json.loads(DEVICE_STATE_PATH.read_text(encoding="utf-8"))

    api_base = (os.environ.get("RDI_API_BASE_URL") or conf.get("api_base_url") or "").rstrip("/")
    device_serial = _clean_credential(
        os.environ.get("RDI_DEVICE_SERIAL") or state.get("device_serial") or ""
    ).lower()
    device_secret = _clean_credential(
        os.environ.get("RDI_DEVICE_SECRET") or state.get("device_secret") or ""
    )

    if not api_base:
        raise RuntimeError("Missing api_base_url — run rdi-relay-claim.py or set RDI_API_BASE_URL")
    if not device_serial or not device_secret:
        raise RuntimeError(
            f"Missing device credentials — run rdi-relay-claim.py (expected {DEVICE_STATE_PATH})"
        )

    return {
        "api_base_url": api_base,
        "device_serial": device_serial,
        "device_secret": device_secret,
        "relay_id": conf.get("relay_id", ""),
        "wavelength_zone_id": conf.get("wavelength_zone_id", ""),
        "name": conf.get("name", ""),
    }
