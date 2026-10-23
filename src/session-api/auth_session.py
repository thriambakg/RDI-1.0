"""
Single-login enforcement via JWT auth_time vs DynamoDB auth_session_epoch.

A newer successful Cognito authentication (higher auth_time) claims the session.
Older tokens are rejected with SESSION_SUPERSEDED. Refresh tokens keep the same
auth_time, so they neither steal nor lose the session until a fresh sign-in.
"""

from __future__ import annotations

import os
from typing import Callable

import boto3
from botocore.exceptions import ClientError

USER_PROFILES_TABLE = os.environ.get("USER_PROFILES_TABLE", "")
# PostAuth may stamp wall-clock a second after JWT auth_time; keep skew tight so
# two logins a few seconds apart still invalidate the older one.
_AUTH_SESSION_SKEW_SECONDS = 2

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
    Return None if the request may proceed.
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
        print(f"[auth_session] missing auth_time claim user_id={user_id!r}")
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
    epoch: int | None
    try:
        epoch = int(epoch_raw) if epoch_raw is not None else None
    except (TypeError, ValueError):
        epoch = None

    if epoch is not None and auth_time + _AUTH_SESSION_SKEW_SECONDS < epoch:
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

    # Claim / refresh epoch when this token is as new or newer (covers missing PostAuth).
    if epoch is None or auth_time > epoch:
        try:
            _dynamodb.update_item(
                TableName=USER_PROFILES_TABLE,
                Key={"user_id": {"S": user_id}},
                UpdateExpression="SET auth_session_epoch = :t",
                ConditionExpression=(
                    "attribute_not_exists(auth_session_epoch) OR auth_session_epoch <= :t"
                ),
                ExpressionAttributeValues={":t": {"N": str(auth_time)}},
            )
            print(
                f"[auth_session] claimed epoch={auth_time} user_id={user_id!r} "
                f"(was {epoch})"
            )
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                print(
                    f"[auth_session] lost claim race user_id={user_id!r} "
                    f"auth_time={auth_time}"
                )
                return response_fn(
                    401,
                    {
                        "error": "Signed in elsewhere. Please sign in again.",
                        "code": "SESSION_SUPERSEDED",
                    },
                    headers,
                )
            print(f"[auth_session] dynamo update failed user_id={user_id!r}: {e}")

    return None
