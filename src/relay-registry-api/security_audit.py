"""Structured security audit lines for CloudWatch (no secrets)."""

from __future__ import annotations

import json
import time
from typing import Any


def audit(event: str, *, user_id: str = "", **fields: Any) -> None:
    payload = {
        "audit": True,
        "event": event,
        "ts": int(time.time()),
    }
    if user_id:
        payload["user_id"] = user_id[:12] + ".." if len(user_id) > 12 else user_id
    for k, v in fields.items():
        if v is None:
            continue
        if k.lower() in ("code", "secret", "token", "password", "authorization"):
            continue
        payload[k] = v
    print(json.dumps(payload, default=str))
