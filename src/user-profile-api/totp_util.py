"""Minimal TOTP (RFC 6238) helpers — no external deps."""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import struct
import time
import urllib.parse


def generate_secret(nbytes: int = 20) -> str:
    return base64.b32encode(os.urandom(nbytes)).decode("ascii").rstrip("=")


def _hotp(secret_b32: str, counter: int, digits: int = 6) -> str:
    key = base64.b32decode(secret_b32.upper() + "=" * ((8 - len(secret_b32) % 8) % 8))
    msg = struct.pack(">Q", counter)
    digest = hmac.new(key, msg, hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    code = (struct.unpack(">I", digest[offset : offset + 4])[0] & 0x7FFFFFFF) % (10**digits)
    return str(code).zfill(digits)


def verify_totp(secret_b32: str, code: str, window: int = 1, step: int = 30) -> bool:
    if not secret_b32 or not code or not code.isdigit():
        return False
    counter = int(time.time()) // step
    for delta in range(-window, window + 1):
        if hmac.compare_digest(_hotp(secret_b32, counter + delta), code):
            return True
    return False


def otpauth_uri(secret_b32: str, account_name: str, issuer: str = "RDI") -> str:
    label = urllib.parse.quote(f"{issuer}:{account_name}")
    params = urllib.parse.urlencode(
        {
            "secret": secret_b32,
            "issuer": issuer,
            "algorithm": "SHA1",
            "digits": "6",
            "period": "30",
        }
    )
    return f"otpauth://totp/{label}?{params}"
