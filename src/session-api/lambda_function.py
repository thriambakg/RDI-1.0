"""
Session API - Connection pool management for RDI drone control.
Assigns proxy endpoints to users, manages session lifecycle.
Updates user profile connection_hierarchy on create, release, delete.
Notifies proxy (EC2) on session status change so it only allows active connections
and clears idle sessions from memory.
"""

import json
import os
import shlex
import uuid
import time
import urllib.request
import urllib.error
from typing import Any

import boto3
from botocore.exceptions import ClientError

from hierarchy import add_session_to_folder, update_session_status, remove_session

TABLE_NAME = os.environ["CONNECTION_POOL_TABLE"]
REGION = os.environ["AWS_REGION"]
PROXY_ENDPOINT = os.environ["PROXY_ENDPOINT"]
USER_PROFILES_TABLE = os.environ.get("USER_PROFILES_TABLE", "")
RELAY_REGISTRY_TABLE = os.environ.get("RELAY_REGISTRY_TABLE", "")
PROXY_STATUS_URL = os.environ.get("PROXY_STATUS_URL", "")
PROXY_STATUS_SECRET_ARN = os.environ.get("PROXY_STATUS_SECRET_ARN", "")
PROXY_STATUS_SECRET_ENV = os.environ.get("PROXY_STATUS_SECRET", "")  # Fallback when no ARN
WAVELENGTH_INSTANCE_ID = os.environ.get("WAVELENGTH_INSTANCE_ID", "")
WAVELENGTH_ZONE_ID = os.environ.get("WAVELENGTH_ZONE_ID", "")
WAVELENGTH_CARRIER_IP = os.environ.get("WAVELENGTH_CARRIER_IP", "")
MAVLINK_PORT = os.environ.get("MAVLINK_PORT", "18570")


AGENT_API_PORT = "8080"  # RDI_AGENT_API_PORT on Wavelength (agent daemon - stays running; Lambda adds/removes sessions only)

_PROXY_STATUS_SECRET_CACHE: str | None = None


def _get_proxy_status_secret() -> str:
    """Get proxy status secret: from Secrets Manager when ARN set, else from env. Cached per cold start."""
    global _PROXY_STATUS_SECRET_CACHE
    if _PROXY_STATUS_SECRET_CACHE is not None:
        return _PROXY_STATUS_SECRET_CACHE
    if PROXY_STATUS_SECRET_ARN:
        try:
            sm = boto3.client("secretsmanager", region_name=REGION)
            resp = sm.get_secret_value(SecretId=PROXY_STATUS_SECRET_ARN)
            data = json.loads(resp.get("SecretString", "{}"))
            val = data.get("value", "")
            if isinstance(val, str):
                _PROXY_STATUS_SECRET_CACHE = val
            else:
                _PROXY_STATUS_SECRET_CACHE = str(val) if val is not None else ""
            print(f"[RDI Session] proxy secret fetched from Secrets Manager len={len(_PROXY_STATUS_SECRET_CACHE)}")
        except Exception as e:
            print(f"[RDI Session] failed to fetch proxy secret from Secrets Manager: {e}")
            _PROXY_STATUS_SECRET_CACHE = PROXY_STATUS_SECRET_ENV
    else:
        _PROXY_STATUS_SECRET_CACHE = PROXY_STATUS_SECRET_ENV
    return _PROXY_STATUS_SECRET_CACHE or ""


# Logged once per cold start (no secret values)
print(
    f"[RDI Session] init endpoint={PROXY_ENDPOINT} has_proxy_status_url={bool(PROXY_STATUS_URL)} "
    f"has_proxy_secret_arn={bool(PROXY_STATUS_SECRET_ARN)} wavelength_instance_id={bool(WAVELENGTH_INSTANCE_ID)}"
)


def _fetch_relay_config(dynamodb, user_id: str, relay_id: str, wavelength_zone_id: str) -> dict | None:
    """Fetch relay from registry; return config (mavlink_host, mavlink_port) if user owns it and has MAVLink config."""
    if not RELAY_REGISTRY_TABLE or not relay_id:
        return None
    try:
        resp = dynamodb.get_item(
            TableName=RELAY_REGISTRY_TABLE,
            Key={
                "wavelength_zone_id": {"S": wavelength_zone_id},
                "relay_id": {"S": relay_id},
            },
        )
    except ClientError:
        return None
    item = resp.get("Item")
    if not item:
        return None
    if item.get("user_id", {}).get("S") != user_id:
        return None
    config_raw = item.get("config", {}).get("S")
    if not config_raw:
        return None
    try:
        config = json.loads(config_raw)
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(config, dict):
        return None
    out = {}
    if config.get("mavlink_host"):
        out["mavlink_host"] = str(config["mavlink_host"])
    if config.get("mavlink_port") is not None:
        out["mavlink_port"] = int(config["mavlink_port"])
    return out if out else None


def _add_session_to_agent(
    instance_id: str, proxy_url: str, session_id: str, relay_config: dict | None = None
) -> None:
    """Add session to the running agent daemon. Daemon stays up; this opens a WebSocket bridge for this session."""
    if not instance_id or not proxy_url or not session_id:
        _log("add_session skipped", session_id=session_id, has_instance=bool(instance_id), has_proxy_url=bool(proxy_url))
        return
    _log("add_session to agent daemon", session_id=session_id, proxy_url=proxy_url, instance_id=instance_id)
    body = {"session_id": session_id, "proxy_url": proxy_url}
    if relay_config:
        if relay_config.get("mavlink_host"):
            body["mavlink_host"] = relay_config["mavlink_host"]
        if relay_config.get("mavlink_port") is not None:
            body["mavlink_port"] = relay_config["mavlink_port"]
    body = json.dumps(body)
    cmd = f"curl -s -X POST http://127.0.0.1:{AGENT_API_PORT}/sessions -H 'Content-Type: application/json' -d {shlex.quote(body)}"
    try:
        ssm = boto3.client("ssm", region_name=REGION)
        result = ssm.send_command(
            InstanceIds=[instance_id],
            DocumentName="AWS-RunShellScript",
            Parameters={"commands": [cmd]},
        )
        cmd_id = result.get("Command", {}).get("CommandId", "")
        _log("SSM add_session sent", session_id=session_id, instance_id=instance_id, command_id=cmd_id)
    except Exception as e:
        _log("SSM add_session failed", session_id=session_id, instance_id=instance_id, error=str(e))


def _remove_session_from_agent(instance_id: str, session_id: str) -> None:
    """Remove session from the running agent daemon. Daemon stays up; this closes the WebSocket bridge for this session."""
    if not instance_id or not session_id:
        _log("remove_session skipped", session_id=session_id, has_instance=bool(instance_id))
        return
    _log("remove_session from agent", session_id=session_id, instance_id=instance_id)
    url = f"http://127.0.0.1:{AGENT_API_PORT}/sessions/{session_id}"
    cmd = f"curl -s -X DELETE {shlex.quote(url)}"
    try:
        ssm = boto3.client("ssm", region_name=REGION)
        ssm.send_command(
            InstanceIds=[instance_id],
            DocumentName="AWS-RunShellScript",
            Parameters={"commands": [cmd]},
        )
        _log("SSM remove_session sent", session_id=session_id, instance_id=instance_id)
    except Exception as e:
        _log("SSM remove_session failed", session_id=session_id, instance_id=instance_id, error=str(e))


def _notify_proxy_session_status(session_id: str, status: str) -> None:
    """Tell the proxy to set session status (active/idle). Idle => disconnect and clear from memory."""
    secret = _get_proxy_status_secret()
    if not PROXY_STATUS_URL or not secret:
        _log(
            "proxy_status skipped",
            session_id=session_id,
            status=status,
            has_url=bool(PROXY_STATUS_URL),
            has_secret=bool(secret),
        )
        return
    # Log host only (no path) to avoid leaking full URL
    url_host = PROXY_STATUS_URL.split("/")[2] if "//" in PROXY_STATUS_URL else "?"
    _log(
        "proxy_status notifying",
        session_id=session_id,
        status=status,
        url_host=url_host,
        action="accept" if status == "active" else "disconnect",
    )
    body = json.dumps({"session_id": session_id, "status": status}).encode("utf-8")
    req = urllib.request.Request(
        PROXY_STATUS_URL,
        data=body,
        headers={
            "Content-Type": "application/json",
            "X-Proxy-Secret": secret,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            if resp.status != 200:
                _log("proxy_status non-200", session_id=session_id, status=status, http_status=resp.status)
            else:
                _log("proxy_status ack", session_id=session_id, status=status)
    except urllib.error.HTTPError as e:
        try:
            body_preview = (e.read().decode("utf-8", errors="replace")[:200] if getattr(e, "fp", None) else "") or ""
        except Exception:
            body_preview = ""
        _log(
            "proxy_status failed",
            session_id=session_id,
            status=status,
            error=str(e),
            http_status=e.code,
            response_preview=(body_preview[:100] if body_preview else ""),
        )
    except urllib.error.URLError as e:
        _log("proxy_status failed", session_id=session_id, status=status, error=str(e))
    except Exception as e:
        _log("proxy_status error", session_id=session_id, status=status, error=str(e))


def _log(msg: str, **kwargs: Any) -> None:
    """Structured log for CloudWatch; kwargs are appended as key=value."""
    extra = " ".join(f"{k}={v}" for k, v in kwargs.items())
    print(f"[RDI Session] {msg}" + (f" {extra}" if extra else ""))


def lambda_handler(event: dict, context: Any) -> dict:
    """Handle API Gateway requests or scheduled idle-expiry (EventBridge)."""
    req_id = getattr(context, "aws_request_id", None) if context else None
    _log("request", method=event.get("httpMethod", "?"), path=event.get("path", ""), request_id=req_id or "n/a")

    if event.get("source") == "schedule" and event.get("action") == "idle_expired_sessions":
        _log("scheduled job: idle_expired_sessions started")
        _idle_expired_sessions()
        _log("scheduled job: idle_expired_sessions done")
        return {"statusCode": 200, "body": "idle_expired_sessions done"}

    http_method = event.get("httpMethod", "GET")
    path = event.get("path", "")

    headers = {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Credentials": "true",
    }

    try:
        user_id = _get_user_id(event)
        if not user_id:
            _log("auth failed", reason="no user_id from claims")
            return _response(401, {"error": "Unauthorized"}, headers)
        _log("auth ok", user_id=user_id[:8] + ".." if len(user_id) > 8 else user_id)

        if http_method == "POST" and "sessions" in path:
            body = json.loads(event.get("body") or "{}")
            _log("route", action="create_session")
            return _create_session(user_id, body, headers)
        if http_method == "PATCH" and "sessions" in path:
            body = json.loads(event.get("body") or "{}")
            _log("route", action="patch_session", session_id=body.get("session_id"))
            return _patch_session(user_id, body, headers)
        if http_method == "DELETE" and "sessions" in path:
            body = json.loads(event.get("body") or "{}")
            session_id = body.get("session_id")
            permanent = body.get("permanent", False)
            _log("route", action="release_session", session_id=session_id, permanent=permanent)
            return _release_session(user_id, session_id, headers, permanent=permanent)
        if http_method == "GET" and "sessions" in path:
            _log("route", action="get_session")
            return _get_session(user_id, event.get("queryStringParameters"), headers)

        _log("route", action="not_found", method=http_method, path=path)
        return _response(404, {"error": "Not found"}, headers)

    except Exception as e:
        _log("handler error", error=str(e))
        return _response(500, {"error": str(e)}, headers)


def _get_user_id(event: dict) -> str | None:
    """Extract user ID from Cognito JWT claims."""
    claims = event.get("requestContext", {}).get("authorizer", {}).get("claims", {})
    return claims.get("sub")


# TTL and connection lifetime (shared with idle logic):
# - ttl_seconds=0: no idle_after; session stays "active" until user clicks Release. WebSocket can stay connected indefinitely (ALB idle_timeout is 3600s).
# - ttl_seconds>0: idle_after = now + ttl_seconds; scheduled Lambda marks session idle when idle_after passes, then proxy disconnects and agent closes.
# We do NOT use DynamoDB TTL for deletion: TTL would remove the row and leave the user's list out of sync.
# Deletion only happens on explicit user DELETE.
DEFAULT_TTL_SECONDS = 14400  # 4 hours
MAX_TTL_SECONDS = 604800  # 7 days
INDEFINITE_EXPIRES_AT = 4102444800  # Year 2100 - no TTL (indefinite)


def _create_session(user_id: str, body: dict, headers: dict) -> dict:
    """Create or get existing session, return proxy endpoint."""
    folder_path = body.get("folder_path")
    if not isinstance(folder_path, list):
        folder_path = ["My Drones"]
    if folder_path and folder_path[0] == "Shared":
        _log("create_session rejected", reason="Shared folder")
        return _response(400, {"error": "Cannot create connections in Shared or its subfolders"}, headers)

    session_id = str(uuid.uuid4())
    _log("create_session start", session_id=session_id, folder_path=folder_path)
    now = int(time.time())
    ttl_seconds = body.get("ttl_seconds")
    if ttl_seconds is None:
        ttl_seconds = DEFAULT_TTL_SECONDS
    ttl_val = int(ttl_seconds) if ttl_seconds is not None else DEFAULT_TTL_SECONDS
    if ttl_val <= 0:
        # No auto-idle; deletion only on explicit user delete
        idle_after_ts = None
        display_expires_at = INDEFINITE_EXPIRES_AT
    else:
        ttl_seconds = max(60, min(ttl_val, MAX_TTL_SECONDS))
        idle_after_ts = now + ttl_seconds  # When scheduled Lambda will mark idle
        display_expires_at = idle_after_ts
    # Never let DynamoDB TTL delete the row (would desync from user list); only explicit DELETE removes.
    expires_at = INDEFINITE_EXPIRES_AT

    # Drone ID: {user-set name}-{uuid} for easy identification
    drone_name = (body.get("drone_name") or "").strip() or "drone"
    drone_id = f"{drone_name}-{uuid.uuid4()}"
    wavelength_zone_id = body.get("wavelength_zone_id") or REGION
    user_zone_sk = f"{wavelength_zone_id}#{session_id}"
    relay_id = (body.get("relay_id") or "").strip() or None

    item = {
        "user_id": {"S": user_id},
        "session_id": {"S": session_id},
        "region": {"S": REGION},
        "wavelength_zone_id": {"S": wavelength_zone_id},
        "user_zone_sk": {"S": user_zone_sk},
        "status": {"S": "active"},
        "drone_id": {"S": drone_id},
        "endpoint": {"S": PROXY_ENDPOINT},
        "created_at": {"N": str(now)},
        "updated_at": {"N": str(now)},
        "expires_at": {"N": str(expires_at)},
    }
    if idle_after_ts is not None:
        item["idle_after"] = {"N": str(idle_after_ts)}
    if relay_id:
        item["relay_id"] = {"S": relay_id}
    if body.get("metadata") and isinstance(body["metadata"], dict):
        item["metadata"] = {"S": json.dumps(body["metadata"])}

    dynamodb = boto3.client("dynamodb")
    relay_config = _fetch_relay_config(dynamodb, user_id, relay_id, wavelength_zone_id) if relay_id else None
    try:
        dynamodb.put_item(
            TableName=TABLE_NAME,
            Item=item,
            ConditionExpression="attribute_not_exists(session_id)",
        )
        _log("create_session DynamoDB put ok", session_id=session_id)
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            _log("create_session DynamoDB conflict, retrying", session_id=session_id)
            return _create_session(user_id, body, headers)
        _log("create_session DynamoDB put failed", session_id=session_id, error=str(e))
        raise

    if USER_PROFILES_TABLE:
        _upsert_profile_add_session(
            dynamodb, user_id,
            session_id=session_id,
            name=drone_name,
            status="active",
            folder_path=folder_path,
            relay_id=relay_id,
        )

    # Mark session active on the proxy so it accepts UI and agent WebSocket connections for this session.
    idle_desc = f"idle_after_ts={idle_after_ts}" if idle_after_ts else "indefinite"
    _log(
        "session created",
        session_id=session_id,
        endpoint=PROXY_ENDPOINT,
        drone_id=drone_id,
        idle_desc=idle_desc,
        wavelength_zone_id=wavelength_zone_id,
    )
    _notify_proxy_session_status(session_id, "active")

    if not WAVELENGTH_INSTANCE_ID:
        _log("add_session skipped", reason="proxy_only_mode", session_id=session_id)
    elif WAVELENGTH_ZONE_ID and wavelength_zone_id != WAVELENGTH_ZONE_ID:
        _log(
            "add_session skipped",
            reason="zone_mismatch",
            session_id=session_id,
            request_zone=wavelength_zone_id,
            deployed_zone=WAVELENGTH_ZONE_ID,
        )
    else:
        _add_session_to_agent(WAVELENGTH_INSTANCE_ID, PROXY_ENDPOINT, session_id, relay_config)

    payload = {
        "session_id": session_id,
        "drone_id": drone_id,
        "endpoint": PROXY_ENDPOINT,
        "expires_at": display_expires_at,
    }
    if relay_id:
        payload["relay_id"] = relay_id
    if relay_config:
        payload["relay_config"] = relay_config
    if WAVELENGTH_CARRIER_IP and (not WAVELENGTH_ZONE_ID or wavelength_zone_id == WAVELENGTH_ZONE_ID):
        payload["carrier_ip"] = WAVELENGTH_CARRIER_IP
        payload["mavlink_port"] = MAVLINK_PORT
    _log("create_session success", session_id=session_id, drone_id=drone_id)
    return _response(200, payload, headers)


def _release_session(user_id: str, session_id: str | None, headers: dict, *, permanent: bool = False) -> dict:
    """Release session (mark idle) or permanently delete."""
    if not session_id:
        _log("release_session rejected", reason="no session_id")
        return _response(400, {"error": "session_id required"}, headers)

    _log("release_session start", session_id=session_id, permanent=permanent)
    dynamodb = boto3.client("dynamodb")

    if permanent:
        session_existed = True
        try:
            dynamodb.delete_item(
                TableName=TABLE_NAME,
                Key={
                    "user_id": {"S": user_id},
                    "session_id": {"S": session_id},
                },
                ConditionExpression="attribute_exists(session_id)",
            )
        except ClientError as e:
            if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
                session_existed = False  # Session already gone (e.g. TTL or other); still clean hierarchy
            else:
                raise
        if USER_PROFILES_TABLE:
            _upsert_profile_remove_session(dynamodb, user_id, session_id)
        _log("release_session permanent done", session_id=session_id, existed=session_existed)
        return _response(
            200,
            {"message": "Session deleted" if session_existed else "Session removed from list"},
            headers,
        )

    now = int(time.time())
    try:
        dynamodb.update_item(
            TableName=TABLE_NAME,
            Key={
                "user_id": {"S": user_id},
                "session_id": {"S": session_id},
            },
            UpdateExpression="SET #status = :idle, updated_at = :now, released_at = :now",
            ConditionExpression="attribute_exists(session_id)",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={
                ":idle": {"S": "idle"},
                ":now": {"N": str(now)},
            },
        )
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            _log("release_session not found", session_id=session_id)
            return _response(404, {"error": "Session not found"}, headers)
        raise

    _log("release_session -> idle", session_id=session_id)
    if USER_PROFILES_TABLE:
        _upsert_profile_update_status(dynamodb, user_id, session_id, "idle")
    _notify_proxy_session_status(session_id, "idle")
    if WAVELENGTH_INSTANCE_ID:
        _remove_session_from_agent(WAVELENGTH_INSTANCE_ID, session_id)

    _log("release_session done", session_id=session_id)
    return _response(200, {"message": "Session released"}, headers)


def _idle_expired_sessions() -> None:
    """Scheduled job: mark active sessions as idle when idle_after has passed. Does not delete.
    TTL is shared with connection lifetime: only sessions with idle_after set will transition to idle;
    sessions with ttl_seconds=0 have no idle_after and stay active until explicit release."""
    _log("idle_expired_sessions start")
    dynamodb = boto3.client("dynamodb")
    now = int(time.time())
    paginator = dynamodb.get_paginator("scan")
    page_iterator = paginator.paginate(
        TableName=TABLE_NAME,
        FilterExpression="(#status = :active) AND attribute_exists(idle_after) AND (idle_after < :now)",
        ExpressionAttributeNames={"#status": "status"},
        ExpressionAttributeValues={":active": {"S": "active"}, ":now": {"N": str(now)}},
    )
    for page in page_iterator:
        for item in page.get("Items", []):
            user_id = (item.get("user_id") or {}).get("S")
            session_id = (item.get("session_id") or {}).get("S")
            if not user_id or not session_id:
                continue
            try:
                _log("idle_expired marking idle", session_id=session_id)
                dynamodb.update_item(
                    TableName=TABLE_NAME,
                    Key={"user_id": {"S": user_id}, "session_id": {"S": session_id}},
                    UpdateExpression="SET #status = :idle, updated_at = :now, released_at = :now",
                    ConditionExpression="(#status = :active) AND idle_after < :now",
                    ExpressionAttributeNames={"#status": "status"},
                    ExpressionAttributeValues={
                        ":idle": {"S": "idle"},
                        ":active": {"S": "active"},
                        ":now": {"N": str(now)},
                    },
                )
            except ClientError as e:
                if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
                    continue  # Already idle or race
                raise
            if USER_PROFILES_TABLE:
                _upsert_profile_update_status(dynamodb, user_id, session_id, "idle")
            _notify_proxy_session_status(session_id, "idle")
            if WAVELENGTH_INSTANCE_ID:
                _remove_session_from_agent(WAVELENGTH_INSTANCE_ID, session_id)
    _log("idle_expired_sessions done")


def _patch_session(user_id: str, body: dict, headers: dict) -> dict:
    """Set session status (e.g. active). Body: session_id, status."""
    session_id = body.get("session_id")
    status = (body.get("status") or "").strip().lower()
    if not session_id:
        _log("patch_session rejected", reason="no session_id")
        return _response(400, {"error": "session_id required"}, headers)
    if status not in ("active", "idle"):
        _log("patch_session rejected", session_id=session_id, reason="invalid status", status=status)
        return _response(400, {"error": "status must be 'active' or 'idle'"}, headers)

    _log("patch_session start", session_id=session_id, status=status)
    dynamodb = boto3.client("dynamodb")
    now = int(time.time())

    # When reactivating, we need wavelength_zone_id to start the agent
    wavelength_zone_id = None
    if status == "active" and WAVELENGTH_INSTANCE_ID:
        try:
            resp = dynamodb.get_item(
                TableName=TABLE_NAME,
                Key={"user_id": {"S": user_id}, "session_id": {"S": session_id}},
                ProjectionExpression="wavelength_zone_id",
            )
            wavelength_zone_id = (resp.get("Item") or {}).get("wavelength_zone_id", {}).get("S")
        except ClientError:
            pass

    try:
        dynamodb.update_item(
            TableName=TABLE_NAME,
            Key={
                "user_id": {"S": user_id},
                "session_id": {"S": session_id},
            },
            UpdateExpression="SET #status = :status, updated_at = :now",
            ConditionExpression="attribute_exists(session_id)",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={
                ":status": {"S": status},
                ":now": {"N": str(now)},
            },
        )
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            _log("patch_session not found", session_id=session_id)
            return _response(404, {"error": "Session not found"}, headers)
        raise

    if USER_PROFILES_TABLE:
        _upsert_profile_update_status(dynamodb, user_id, session_id, status)
    _notify_proxy_session_status(session_id, status)
    if status == "idle" and WAVELENGTH_INSTANCE_ID:
        _remove_session_from_agent(WAVELENGTH_INSTANCE_ID, session_id)
    elif status == "active" and WAVELENGTH_INSTANCE_ID and (
        not WAVELENGTH_ZONE_ID or wavelength_zone_id == WAVELENGTH_ZONE_ID
    ):
        _add_session_to_agent(WAVELENGTH_INSTANCE_ID, PROXY_ENDPOINT, session_id)

    _log("patch_session done", session_id=session_id, status=status)
    return _response(200, {"message": f"Session set to {status}"}, headers)


def _get_session(
    user_id: str, query_params: dict | None, headers: dict
) -> dict:
    """Get session(s): single by session_id, or list all for user (optionally by zone)."""
    params = query_params or {}
    session_id = params.get("session_id")
    wavelength_zone_id = params.get("wavelength_zone_id")

    dynamodb = boto3.client("dynamodb")

    if session_id:
        # Single session lookup
        try:
            resp = dynamodb.get_item(
                TableName=TABLE_NAME,
                Key={
                    "user_id": {"S": user_id},
                    "session_id": {"S": session_id},
                },
            )
        except ClientError:
            raise

        item = resp.get("Item")
        if not item:
            _log("get_session not found", session_id=session_id)
            return _response(404, {"error": "Session not found"}, headers)

        out = {
            "session_id": session_id,
            "drone_id": item.get("drone_id", {}).get("S"),
            "endpoint": item.get("endpoint", {}).get("S"),
            "status": item.get("status", {}).get("S"),
        }
        if item.get("relay_id", {}).get("S"):
            out["relay_id"] = item["relay_id"]["S"]
        if WAVELENGTH_CARRIER_IP:
            wl_zone = item.get("wavelength_zone_id", {}).get("S")
            if not WAVELENGTH_ZONE_ID or wl_zone == WAVELENGTH_ZONE_ID:
                out["carrier_ip"] = WAVELENGTH_CARRIER_IP
                out["mavlink_port"] = MAVLINK_PORT
        return _response(200, out, headers)

    # List sessions for user
    try:
        if wavelength_zone_id:
            # Use UserZoneIndex GSI
            resp = dynamodb.query(
                TableName=TABLE_NAME,
                IndexName="UserZoneIndex",
                KeyConditionExpression="user_id = :uid AND begins_with(user_zone_sk, :prefix)",
                ExpressionAttributeValues={
                    ":uid": {"S": user_id},
                    ":prefix": {"S": f"{wavelength_zone_id}#"},
                },
            )
        else:
            resp = dynamodb.query(
                TableName=TABLE_NAME,
                KeyConditionExpression="user_id = :uid",
                ExpressionAttributeValues={":uid": {"S": user_id}},
            )
    except ClientError:
        raise

    items = resp.get("Items", [])
    sessions = []
    for item in items:
        sid = item.get("session_id", {}).get("S")
        if not sid:
            continue
        # Extract display name from drone_id (format: name-uuid)
        drone_id = item.get("drone_id", {}).get("S") or "drone"
        name = drone_id.rsplit("-", 1)[0] if "-" in drone_id else drone_id
        # Prefer idle_after for "when session goes idle"; else expires_at (both N)
        exp_n = (item.get("idle_after") or item.get("expires_at")) or {}
        expires_at_val = int(exp_n.get("N", "0") or "0")
        sess = {
            "session_id": sid,
            "drone_id": drone_id,
            "name": name,
            "status": item.get("status", {}).get("S") or "idle",
            "wavelength_zone_id": item.get("wavelength_zone_id", {}).get("S"),
            "endpoint": item.get("endpoint", {}).get("S"),
            "expires_at": expires_at_val,
        }
        if item.get("relay_id", {}).get("S"):
            sess["relay_id"] = item["relay_id"]["S"]
        if WAVELENGTH_CARRIER_IP:
            wl_zone = item.get("wavelength_zone_id", {}).get("S")
            if not WAVELENGTH_ZONE_ID or wl_zone == WAVELENGTH_ZONE_ID:
                sess["carrier_ip"] = WAVELENGTH_CARRIER_IP
                sess["mavlink_port"] = MAVLINK_PORT
        sessions.append(sess)

    return _response(200, {"sessions": sessions}, headers)


def _to_dynamo(obj: Any) -> dict:
    """Convert Python obj to DynamoDB format."""
    from boto3.dynamodb.types import TypeSerializer
    return TypeSerializer().serialize(obj)


def _from_dynamo(val: dict | None) -> Any:
    """Convert DynamoDB format to Python."""
    if not val:
        return None
    from boto3.dynamodb.types import TypeDeserializer
    return TypeDeserializer().deserialize(val)


def _upsert_profile_add_session(
    dynamodb, user_id: str, *, session_id: str, name: str, status: str, folder_path: list, relay_id: str | None = None
) -> None:
    """Get or create profile, add session to folder, save."""
    try:
        resp = dynamodb.get_item(
            TableName=USER_PROFILES_TABLE,
            Key={"user_id": {"S": user_id}},
        )
    except ClientError:
        return
    item = resp.get("Item")
    hierarchy = {}
    if item and "connection_hierarchy" in item:
        hierarchy = _from_dynamo(item["connection_hierarchy"]) or {}
    hierarchy = add_session_to_folder(hierarchy, folder_path, session_id, name, status, relay_id=relay_id)
    dynamodb.update_item(
        TableName=USER_PROFILES_TABLE,
        Key={"user_id": {"S": user_id}},
        UpdateExpression="SET connection_hierarchy = :h",
        ExpressionAttributeValues={":h": _to_dynamo(hierarchy)},
    )


def _upsert_profile_update_status(dynamodb, user_id: str, session_id: str, status: str) -> None:
    """Update session status in hierarchy."""
    try:
        resp = dynamodb.get_item(
            TableName=USER_PROFILES_TABLE,
            Key={"user_id": {"S": user_id}},
        )
    except ClientError:
        return
    item = resp.get("Item")
    if not item or "connection_hierarchy" not in item:
        return
    hierarchy = _from_dynamo(item["connection_hierarchy"]) or {}
    hierarchy = update_session_status(hierarchy, session_id, status)
    dynamodb.update_item(
        TableName=USER_PROFILES_TABLE,
        Key={"user_id": {"S": user_id}},
        UpdateExpression="SET connection_hierarchy = :h",
        ExpressionAttributeValues={":h": _to_dynamo(hierarchy)},
    )


def _upsert_profile_remove_session(dynamodb, user_id: str, session_id: str) -> None:
    """Remove session from hierarchy."""
    try:
        resp = dynamodb.get_item(
            TableName=USER_PROFILES_TABLE,
            Key={"user_id": {"S": user_id}},
        )
    except ClientError:
        return
    item = resp.get("Item")
    if not item or "connection_hierarchy" not in item:
        return
    hierarchy = _from_dynamo(item["connection_hierarchy"]) or {}
    hierarchy = remove_session(hierarchy, session_id)
    dynamodb.update_item(
        TableName=USER_PROFILES_TABLE,
        Key={"user_id": {"S": user_id}},
        UpdateExpression="SET connection_hierarchy = :h",
        ExpressionAttributeValues={":h": _to_dynamo(hierarchy)},
    )


def _response(status_code: int, body: dict, headers: dict) -> dict:
    return {
        "statusCode": status_code,
        "headers": headers,
        "body": json.dumps(body),
    }
