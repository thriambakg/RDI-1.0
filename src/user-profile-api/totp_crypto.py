"""
App TOTP secret storage helpers.

Prototyping: store plaintext in DynamoDB and rely on DynamoDB default at-rest
encryption (AWS-owned keys — no extra CMK cost). Field-level KMS Encrypt/Decrypt
requires a customer-managed CMK; AWS managed keys like aws/dynamodb cannot be used
for arbitrary Lambda Encrypt of attribute values.

Optional later: set TOTP_KMS_KEY_ARN to a customer-managed CMK to store
enc:v1:<base64> ciphertext. Until then encrypt_secret is a no-op.
"""

from __future__ import annotations

import base64
import os

import boto3
from botocore.exceptions import ClientError

_PREFIX = "enc:v1:"
_KMS_KEY_ARN = os.environ.get("TOTP_KMS_KEY_ARN", "").strip()

_kms = boto3.client("kms") if _KMS_KEY_ARN else None


def kms_configured() -> bool:
    return bool(_KMS_KEY_ARN)


def encrypt_secret(plaintext: str) -> str:
    """Return plaintext unless TOTP_KMS_KEY_ARN is set (future hardening)."""
    if not plaintext or not _KMS_KEY_ARN or _kms is None:
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
        return stored
    if not _KMS_KEY_ARN or _kms is None:
        raise RuntimeError(
            "Encrypted TOTP present but TOTP_KMS_KEY_ARN unset — re-enroll MFA"
        )
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
