#!/usr/bin/env python3
"""
RDI relay device — hardware-first claim flow (Path B).

On first boot:
  1. Derives a stable device_serial from Pi MAC / CPU serial
  2. POST /relays/announce -> pairing claim_code (displayed on stdout)
  3. Polls GET /relays/claim-status until user claims in RDI console
  4. Writes /etc/rdi/relay.conf with relay_id

Usage:
  export RDI_API_BASE_URL=https://your-api.execute-api.region.amazonaws.com/production
  sudo python3 rdi-relay-claim.py

Or install as systemd service (see rdi-relay-claim.service.example).
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

CONFIG_PATH = Path(os.environ.get("RDI_RELAY_CONFIG", "/etc/rdi/relay.conf"))
DEVICE_STATE_PATH = Path(os.environ.get("RDI_DEVICE_STATE", "/etc/rdi/device.json"))
POLL_INTERVAL_SEC = int(os.environ.get("RDI_CLAIM_POLL_SEC", "5"))


def _clean_credential(value: str) -> str:
    return value.replace("\x00", "").strip()


def _api_base() -> str:
    base = (os.environ.get("RDI_API_BASE_URL") or "").strip().rstrip("/")
    if not base:
        print("Set RDI_API_BASE_URL to your API Gateway base URL", file=sys.stderr)
        sys.exit(1)
    return base


def _device_serial() -> str:
    for path in (
        Path("/sys/firmware/devicetree/base/serial-number"),
        Path("/proc/cpuinfo"),
    ):
        if path.name == "serial-number" and path.exists():
            raw = path.read_bytes().decode("utf-8", errors="ignore")
            return _clean_credential(raw).lower()[:32]
        if path.name == "cpuinfo":
            for line in path.read_text().splitlines():
                if line.lower().startswith("serial"):
                    return _clean_credential(line.split(":", 1)[1]).lower()[:32]
    for iface in ("wlan0", "eth0"):
        addr = Path(f"/sys/class/net/{iface}/address")
        if addr.exists():
            return _clean_credential(addr.read_text()).replace(":", "").lower()
    import uuid
    return uuid.getnode().to_bytes(6, "big").hex()


def _load_state() -> dict:
    if DEVICE_STATE_PATH.exists():
        return json.loads(DEVICE_STATE_PATH.read_text())
    return {}


def _save_state(state: dict) -> None:
    DEVICE_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    if "device_serial" in state and isinstance(state["device_serial"], str):
        state["device_serial"] = _clean_credential(state["device_serial"]).lower()
    if "device_secret" in state and isinstance(state["device_secret"], str):
        state["device_secret"] = _clean_credential(state["device_secret"])
    DEVICE_STATE_PATH.write_text(json.dumps(state, indent=2))
    try:
        os.chmod(DEVICE_STATE_PATH, 0o600)
    except OSError:
        pass


def _http_json(method: str, url: str, body: dict | None = None) -> tuple[int, dict]:
    data = None
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        payload = {}
        try:
            payload = json.loads(e.read().decode("utf-8"))
        except Exception:
            payload = {"error": str(e), "hint": "API Gateway 403 often means route not deployed yet"}
        return e.code, payload


def announce(api_base: str, device_serial: str, device_secret: str | None) -> dict:
    body: dict = {"device_serial": device_serial}
    if device_secret:
        body["device_secret"] = device_secret
    status, data = _http_json("POST", f"{api_base}/relays/announce", body)
    if status not in (200, 201):
        raise RuntimeError(f"announce failed ({status}): {data}")
    return data


def claim_status(api_base: str, device_serial: str, device_secret: str) -> dict:
    qs = urllib.parse.urlencode({"device_serial": device_serial, "device_secret": device_secret})
    status, data = _http_json("GET", f"{api_base}/relays/claim-status?{qs}")
    if status == 404:
        return {"status": "unknown"}
    if status not in (200,):
        raise RuntimeError(data.get("error") or f"claim-status failed ({status})")
    return data


def write_relay_conf(relay_id: str, wavelength_zone_id: str, name: str) -> None:
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        f"relay_id={relay_id}",
        f"wavelength_zone_id={wavelength_zone_id}",
        f"name={name}",
        f"api_base_url={_api_base()}",
    ]
    CONFIG_PATH.write_text("\n".join(lines) + "\n")
    try:
        os.chmod(CONFIG_PATH, 0o644)
    except OSError:
        pass
    print(f"Wrote {CONFIG_PATH}")


def main() -> None:
    api_base = _api_base()
    device_serial = _device_serial()
    state = _load_state()
    device_secret = state.get("device_secret")

    print(f"Device serial: {device_serial}")

    if CONFIG_PATH.exists() and not os.environ.get("RDI_FORCE_REANNOUNCE"):
        print(f"Already provisioned ({CONFIG_PATH}). Set RDI_FORCE_REANNOUNCE=1 to re-announce.")
        return

    resp = announce(api_base, device_serial, device_secret)
    if resp.get("device_secret") and not device_secret:
        device_secret = resp["device_secret"]
        state["device_secret"] = device_secret
        state["device_serial"] = device_serial
        _save_state(state)
        print(f"Saved device credentials to {DEVICE_STATE_PATH}")

    claim_code = resp.get("claim_code", "")
    print("")
    print("=" * 40)
    print(f"  PAIRING CODE: {claim_code}")
    print("=" * 40)
    print("Enter this code in the RDI console: Add Relay -> Claim device")
    print("")

    if not device_secret:
        print("Missing device_secret; cannot poll claim status", file=sys.stderr)
        sys.exit(1)

    while True:
        st = claim_status(api_base, device_serial, device_secret)
        if st.get("status") == "claimed":
            relay_id = st["relay_id"]
            zone = st["wavelength_zone_id"]
            name = st.get("name", "relay")
            write_relay_conf(relay_id, zone, name)
            print(f"Claimed! relay_id={relay_id} name={name}")
            return
        if st.get("status") == "pending":
            print(f"Waiting for claim... code={st.get('claim_code', claim_code)}", flush=True)
        else:
            print("Not announced; re-running announce", flush=True)
            resp = announce(api_base, device_serial, device_secret)
            claim_code = resp.get("claim_code", claim_code)
        time.sleep(POLL_INTERVAL_SEC)


if __name__ == "__main__":
    main()
