"""
App TOTP secret storage via SSM Parameter Store SecureString.

Uses the AWS managed key alias/aws/ssm (no customer-managed CMK).
DynamoDB only tracks app_totp_enabled; secrets never sit as plaintext attributes.
"""

from __future__ import annotations

import os

import boto3
from botocore.exceptions import ClientError

_ssm = boto3.client("ssm")

# e.g. /rdi/staging/app-totp
_PREFIX = (os.environ.get("TOTP_SSM_PREFIX") or "/rdi/app-totp").rstrip("/")


def _name(user_id: str, *, pending: bool = False) -> str:
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in user_id)[:128]
    if pending:
        return f"{_PREFIX}/pending/{safe}"
    return f"{_PREFIX}/{safe}"


def put_secret(user_id: str, secret: str, *, pending: bool = False) -> None:
    _ssm.put_parameter(
        Name=_name(user_id, pending=pending),
        Value=secret,
        Type="SecureString",
        # Default KMS key = AWS managed alias/aws/ssm
        Overwrite=True,
    )


def get_secret(user_id: str, *, pending: bool = False) -> str | None:
    try:
        resp = _ssm.get_parameter(Name=_name(user_id, pending=pending), WithDecryption=True)
        return (resp.get("Parameter") or {}).get("Value") or None
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") == "ParameterNotFound":
            return None
        raise


def delete_secret(user_id: str, *, pending: bool = False) -> None:
    try:
        _ssm.delete_parameter(Name=_name(user_id, pending=pending))
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") == "ParameterNotFound":
            return
        raise
