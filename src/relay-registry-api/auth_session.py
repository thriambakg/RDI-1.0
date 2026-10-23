"""
Single-login enforcement: reject Cognito access/id tokens whose auth_time
is older than the user's auth_session_epoch (stamped on PostAuthentication).
"""

from __future__ import annotations

import os
from typing import Callable

import boto3

USER_PROFILES_TABLE = os.environ.get("USER_PROFILES_TABLE", "")
# PostAuth stamp can land a second after JWT auth_time; allow small skew.
_AUTH_SESSION_SKEW_SECONDS = 10

_dynamodb = boto3.client("dynamodb")


def claims_from_event(event: dict) -> dict:
    return event.get("requestContext", {}).get("authorizer", {}).get("claims", {}) or {}


def reject_if_session_superseded(
    event: dict,
    headers: dict,
    response_fn: Callable[[int, dict, dict], dict],
) -> dict | None:
    """
    Return a 401 API response if this token was superseded by a newer login.
    Return None if the request may proceed (including when no epoch is set yet).
    """
    if not USER_PROFILES_TABLE:
        return None

    claims = claims_from_event(event)
    user_id = claims.get("sub") or ""
    if not user_id:
        return None

    auth_time_raw = claims.get("auth_time")
    try:
        auth_time = int(auth_time_raw) if auth_time_raw is not None else None
    except (TypeError, ValueError):
        auth_time = None
    if auth_time is None:
        # Missing claim — do not lock out; Cognito JWT authorizer already validated the token.
        return None

    try:
        resp = _dynamodb.get_item(
            TableName=USER_PROFILES_TABLE,
            Key={"user_id": {"S": user_id}},
            ProjectionExpression="auth_session_epoch",
            ConsistentRead=True,
        )
    except Exception as e:
        print(f"[auth_session] dynamo get failed user_id={user_id!r}: {e}")
        return None

    item = resp.get("Item") or {}
    epoch_attr = item.get("auth_session_epoch") or {}
    epoch_raw = epoch_attr.get("N")
    if epoch_raw is None:
        return None
    try:
        epoch = int(epoch_raw)
    except (TypeError, ValueError):
        return None

    if auth_time + _AUTH_SESSION_SKEW_SECONDS < epoch:
        print(
            f"[auth_session] superseded user_id={user_id!r} "
            f"auth_time={auth_time} epoch={epoch}"
        )
        return response_fn(
            401,
            {
                "error": "Signed in elsewhere. Please sign in again.",
                "code": "SESSION_SUPERSEDED",
            },
            headers,
        )
    return None
