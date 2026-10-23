"""
Field-level encryption for app TOTP secrets using the stack customer-managed KMS CMK.

DynamoDB AWS-managed / AWS-owned table encryption only protects disks; any principal
with dynamodb:GetItem still sees plaintext attributes. Secrets are Encrypt'd before
write and Decrypt'd on read.

Ciphertext stored as: enc:v1:<base64(ciphertext_blob)>
Legacy plaintext secrets (no prefix) are still accepted and re-encrypted on next verify.
"""

from __future__ import annotations

import base64
import os

import boto3
from botocore.exceptions import ClientError

_PREFIX = "enc:v1:"
_KMS_KEY_ARN = os.environ.get("TOTP_KMS_KEY_ARN", "").strip()

_kms = boto3.client("kms")


def kms_configured() -> bool:
    return bool(_KMS_KEY_ARN)


def encrypt_secret(plaintext: str) -> str:
    if not plaintext:
        return plaintext
    if not _KMS_KEY_ARN:
        print("[totp_crypto] TOTP_KMS_KEY_ARN unset — storing plaintext (dev only)")
        return plaintext
    try:
        resp = _kms.encrypt(
            KeyId=_KMS_KEY_ARN,
            Plaintext=plaintext.encode("utf-8"),
            EncryptionContext={"purpose": "app_totp"},
        )
        blob = base64.b64encode(resp["CiphertextBlob"]).decode("ascii")
        return f"{_PREFIX}{blob}"
    except ClientError as e:
        print(f"[totp_crypto] encrypt failed: {e}")
        raise


def decrypt_secret(stored: str) -> str:
    if not stored:
        return ""
    if not stored.startswith(_PREFIX):
        # Legacy plaintext row
        return stored
    if not _KMS_KEY_ARN:
        raise RuntimeError("Encrypted TOTP present but TOTP_KMS_KEY_ARN unset")
    raw = base64.b64decode(stored[len(_PREFIX) :])
    try:
        resp = _kms.decrypt(
            CiphertextBlob=raw,
            EncryptionContext={"purpose": "app_totp"},
        )
        return resp["Plaintext"].decode("utf-8")
    except ClientError as e:
        print(f"[totp_crypto] decrypt failed: {e}")
        raise
