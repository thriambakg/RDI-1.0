"""
Active-session lock for single console login (pilot protection).

- Cognito PreAuth denies NEW sign-in while auth_session_last_seen is fresh.
- APIs reject tokens older than auth_session_epoch (issued before a later
  legitimate login after idle/logout).
- Each API call refreshes last_seen so an open console keeps the lock.
- Logout clears last_seen so another device can sign in immediately.
"""

from __future__ import annotations

import os
import time
from typing import Callable

import boto3
from botocore.exceptions import ClientError

USER_PROFILES_TABLE = os.environ.get("USER_PROFILES_TABLE", "")
_AUTH_SESSION_SKEW_SECONDS = 2
# Throttle last_seen writes (seconds).
_LAST_SEEN_TOUCH_MIN_INTERVAL = 20

_dynamodb = boto3.client("dynamodb")


def claims_from_event(event: dict) -> dict:
    return event.get("requestContext", {}).get("authorizer", {}).get("claims", {}) or {}


def reject_if_session_superseded(
    event: dict,
    headers: dict,
    response_fn: Callable[[int, dict, dict], dict],
) -> dict | None:
    """
    Return a 401 if this token predates the active session epoch.
    Otherwise refresh last_seen and allow.
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
            ProjectionExpression="auth_session_epoch, auth_session_last_seen",
            ConsistentRead=True,
        )
    except Exception as e:
        print(f"[auth_session] dynamo get failed user_id={user_id!r}: {e}")
        return None

    item = resp.get("Item") or {}
    epoch = _as_int((item.get("auth_session_epoch") or {}).get("N"))
    last_seen = _as_int((item.get("auth_session_last_seen") or {}).get("N"))

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

    now = int(time.time())

    # First API after login (or missing epoch): bind epoch to this token's auth_time.
    if epoch is None:
        try:
            _dynamodb.update_item(
                TableName=USER_PROFILES_TABLE,
                Key={"user_id": {"S": user_id}},
                UpdateExpression=(
                    "SET auth_session_epoch = :t, auth_session_last_seen = :n"
                ),
                ConditionExpression="attribute_not_exists(auth_session_epoch)",
                ExpressionAttributeValues={
                    ":t": {"N": str(auth_time)},
                    ":n": {"N": str(now)},
                },
            )
            print(f"[auth_session] bound epoch={auth_time} user_id={user_id!r}")
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                # Another writer bound first — re-check on next request.
                print(f"[auth_session] bind race user_id={user_id!r}")
            else:
                print(f"[auth_session] bind failed user_id={user_id!r}: {e}")
        return None

    # Newer login after idle (PreAuth allowed): adopt newer auth_time as epoch.
    if auth_time > epoch + _AUTH_SESSION_SKEW_SECONDS:
        try:
            _dynamodb.update_item(
                TableName=USER_PROFILES_TABLE,
                Key={"user_id": {"S": user_id}},
                UpdateExpression=(
                    "SET auth_session_epoch = :t, auth_session_last_seen = :n"
                ),
                ConditionExpression=(
                    "attribute_not_exists(auth_session_epoch) OR auth_session_epoch < :t"
                ),
                ExpressionAttributeValues={
                    ":t": {"N": str(auth_time)},
                    ":n": {"N": str(now)},
                },
            )
            print(
                f"[auth_session] adopted newer epoch={auth_time} "
                f"user_id={user_id!r} (was {epoch})"
            )
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                return response_fn(
                    401,
                    {
                        "error": "Signed in elsewhere. Please sign in again.",
                        "code": "SESSION_SUPERSEDED",
                    },
                    headers,
                )
            print(f"[auth_session] adopt failed user_id={user_id!r}: {e}")
        return None

    # Heartbeat: keep PreAuth lock alive while this console is using the API.
    if last_seen is None or now - last_seen >= _LAST_SEEN_TOUCH_MIN_INTERVAL:
        try:
            _dynamodb.update_item(
                TableName=USER_PROFILES_TABLE,
                Key={"user_id": {"S": user_id}},
                UpdateExpression="SET auth_session_last_seen = :n",
                ExpressionAttributeValues={":n": {"N": str(now)}},
            )
        except Exception as e:
            print(f"[auth_session] last_seen touch failed user_id={user_id!r}: {e}")

    return None


def release_auth_session(user_id: str) -> None:
    """Clear the active-session lock so another device may sign in."""
    if not USER_PROFILES_TABLE or not user_id:
        return
    try:
        _dynamodb.update_item(
            TableName=USER_PROFILES_TABLE,
            Key={"user_id": {"S": user_id}},
            UpdateExpression="REMOVE auth_session_last_seen",
        )
        print(f"[auth_session] released lock user_id={user_id!r}")
    except Exception as e:
        print(f"[auth_session] release failed user_id={user_id!r}: {e}")


def _as_int(raw: str | None) -> int | None:
    if raw is None:
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None
