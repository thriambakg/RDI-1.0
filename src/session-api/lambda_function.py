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

from hierarchy import add_session_to_folder, update_session_name, update_session_status, remove_session
from kvs_signaling import (
    build_webrtc_viewer_bundle,
    create_signaling_channel,
    delete_signaling_channel,
    webrtc_enabled,
)
from relay_active_sessions import (
    make_session_entry,
    parse_active_sessions,
    radio_fields_from_metadata,
    remove_session_entry,
    upsert_session_entry,
)

TABLE_NAME = os.environ["CONNECTION_POOL_TABLE"]
REGION = os.environ["AWS_REGION"]
PROXY_ENDPOINT = os.environ.get("PROXY_ENDPOINT", "")
USER_PROFILES_TABLE = os.environ.get("USER_PROFILES_TABLE", "")
RELAY_REGISTRY_TABLE = os.environ.get("RELAY_REGISTRY_TABLE", "")
PROXY_STATUS_URL = os.environ.get("PROXY_STATUS_URL", "")
PROXY_STATUS_SECRET_ARN = os.environ.get("PROXY_STATUS_SECRET_ARN", "")
PROXY_STATUS_SECRET_ENV = os.environ.get("PROXY_STATUS_SECRET", "")  # Fallback when no ARN
WAVELENGTH_INSTANCE_ID = os.environ.get("WAVELENGTH_INSTANCE_ID", "")
WAVELENGTH_ZONE_ID = os.environ.get("WAVELENGTH_ZONE_ID", "")
WAVELENGTH_CARRIER_IP = os.environ.get("WAVELENGTH_CARRIER_IP", "")
MAVLINK_PORT = os.environ.get("MAVLINK_PORT", "18570")


AGENT_API_PORT = "8080"  # RDI_AGENT_API_PORT on edge agent host when SSM-managed (daemon; Lambda adds/removes sessions)

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
    f"has_proxy_secret_arn={bool(PROXY_STATUS_SECRET_ARN)} edge_agent_instance={bool(WAVELENGTH_INSTANCE_ID)}"
)


def _get_relay_registry_item(
    dynamodb, user_id: str, relay_id: str, wavelength_zone_id: str | None = None
) -> dict | None:
    """Load relay-registry item by relay_id (direct key, then UserRelayIndex fallback)."""
    if not RELAY_REGISTRY_TABLE or not relay_id:
        return None
    if wavelength_zone_id:
        try:
            resp = dynamodb.get_item(
                TableName=RELAY_REGISTRY_TABLE,
                Key={
                    "wavelength_zone_id": {"S": wavelength_zone_id},
                    "relay_id": {"S": relay_id},
                },
            )
            item = resp.get("Item")
            if item and item.get("user_id", {}).get("S") == user_id:
                return item
        except ClientError:
            pass
    try:
        resp = dynamodb.query(
            TableName=RELAY_REGISTRY_TABLE,
            IndexName="UserRelayIndex",
            KeyConditionExpression="user_id = :uid",
            ExpressionAttributeValues={":uid": {"S": user_id}},
        )
        for item in resp.get("Items", []):
            if item.get("relay_id", {}).get("S") == relay_id:
                if item.get("user_id", {}).get("S") == user_id:
                    return item
    except ClientError:
        return None
    return None


def _fetch_relay_config(dynamodb, user_id: str, relay_id: str, wavelength_zone_id: str) -> dict | None:
    """Fetch relay from registry; return config (relay_type, mavlink_host) if user owns it."""
    if not RELAY_REGISTRY_TABLE or not relay_id:
        return None
    item = _get_relay_registry_item(dynamodb, user_id, relay_id, wavelength_zone_id)
    if not item:
        return None
    out: dict = {
        "relay_type": (item.get("relay_type", {}).get("S") or "local").strip().lower(),
    }
    config_raw = item.get("config", {}).get("S")
    if config_raw:
        try:
            config = json.loads(config_raw)
            if isinstance(config, dict) and config.get("mavlink_host"):
                out["mavlink_host"] = str(config["mavlink_host"])
        except (json.JSONDecodeError, TypeError):
            pass
    return out


def _add_relay_active_session(
    dynamodb,
    user_id: str,
    relay_id: str,
    wavelength_zone_id: str,
    session_id: str,
    channel_arn: str,
    *,
    drone_id: str = "",
    mavlink_port: int | None = None,
    mavlink_host: str = "",
    link_mode: str = "",
    mavlink_sysid: int | None = None,
    mavlink_compid: int | None = None,
    radio_net_id: int | None = None,
    radio_device: str = "",
    radio_baud: int | None = None,
) -> bool:
    """Append or update one active WebRTC session on the relay (multi-drone). Returns True on success."""
    if not RELAY_REGISTRY_TABLE or not relay_id or not channel_arn:
        _log(
            "add_relay_active_session skipped",
            relay_id=relay_id or "(none)",
            session_id=session_id,
            reason="missing table, relay_id, or channel_arn",
        )
        return False
    try:
        item = _get_relay_registry_item(dynamodb, user_id, relay_id, wavelength_zone_id)
        if not item:
            _log("add_relay_active_session skipped", relay_id=relay_id, reason="relay not found")
            return False
        relay_zone = (item.get("wavelength_zone_id") or {}).get("S") or wavelength_zone_id
        sessions = parse_active_sessions(item)
        entry = make_session_entry(
            session_id,
            channel_arn,
            drone_id=drone_id,
            mavlink_port=mavlink_port,
            mavlink_host=mavlink_host,
            link_mode=link_mode,
            mavlink_sysid=mavlink_sysid,
            mavlink_compid=mavlink_compid,
            radio_net_id=radio_net_id,
            radio_device=radio_device,
            radio_baud=radio_baud,
        )
        sessions = upsert_session_entry(sessions, entry)
        dynamodb.update_item(
            TableName=RELAY_REGISTRY_TABLE,
            Key={
                "wavelength_zone_id": {"S": relay_zone},
                "relay_id": {"S": relay_id},
            },
            UpdateExpression=(
                "SET active_sessions = :sessions, webrtc_status = :ws, last_seen = :now "
                "REMOVE active_session_id, signaling_channel_arn"
            ),
            ConditionExpression="user_id = :uid",
            ExpressionAttributeValues={
                ":sessions": {"S": json.dumps(sessions)},
                ":ws": {"S": "awaiting_master"},
                ":now": {"N": str(int(time.time()))},
                ":uid": {"S": user_id},
            },
        )
        _log(
            "relay active_sessions updated",
            relay_id=relay_id,
            session_id=session_id,
            channel=channel_arn[-36:],
            count=len(sessions),
            link_mode=link_mode or None,
            mavlink_sysid=mavlink_sysid,
        )
        return True
    except ClientError as e:
        code = e.response["Error"]["Code"]
        _log(
            "add_relay_active_session failed",
            relay_id=relay_id,
            session_id=session_id,
            channel=channel_arn[-36:],
            error_code=code,
            error=str(e),
        )
        return False


_LEGACY_SESSION_FIELDS = (
    "active_session_id",
    "signaling_channel_arn",
    "active_drone_id",
    "active_mavlink_port",
    "active_mavlink_host",
)


def _remove_relay_active_session(
    dynamodb, user_id: str, relay_id: str, wavelength_zone_id: str, session_id: str
) -> None:
    """Remove one session from relay active_sessions list."""
    if not RELAY_REGISTRY_TABLE or not relay_id or not session_id:
        return
    try:
        item = _get_relay_registry_item(dynamodb, user_id, relay_id, wavelength_zone_id)
        if not item:
            _log("relay active_sessions remove skipped", relay_id=relay_id, session_id=session_id, reason="relay not found")
            return
        relay_zone = (item.get("wavelength_zone_id") or {}).get("S") or wavelength_zone_id
        sessions = remove_session_entry(parse_active_sessions(item), session_id)
        legacy_remove = ", ".join(_LEGACY_SESSION_FIELDS)
        if sessions:
            dynamodb.update_item(
                TableName=RELAY_REGISTRY_TABLE,
                Key={
                    "wavelength_zone_id": {"S": relay_zone},
                    "relay_id": {"S": relay_id},
                },
                UpdateExpression=(
                    f"SET active_sessions = :sessions, last_seen = :now REMOVE {legacy_remove}"
                ),
                ConditionExpression="user_id = :uid",
                ExpressionAttributeValues={
                    ":sessions": {"S": json.dumps(sessions)},
                    ":now": {"N": str(int(time.time()))},
                    ":uid": {"S": user_id},
                },
            )
        else:
            dynamodb.update_item(
                TableName=RELAY_REGISTRY_TABLE,
                Key={
                    "wavelength_zone_id": {"S": relay_zone},
                    "relay_id": {"S": relay_id},
                },
                UpdateExpression=(
                    "REMOVE active_sessions, webrtc_status, "
                    + ", ".join(_LEGACY_SESSION_FIELDS)
                ),
                ConditionExpression="user_id = :uid",
                ExpressionAttributeValues={":uid": {"S": user_id}},
            )
            _update_relay_status(dynamodb, user_id, relay_id, relay_zone, "offline")
        _log("relay active_sessions removed", relay_id=relay_id, session_id=session_id, remaining=len(sessions))
    except ClientError as e:
        code = e.response["Error"]["Code"]
        if code == "ConditionalCheckFailedException":
            _log(
                "relay active_sessions remove denied",
                relay_id=relay_id,
                session_id=session_id,
                reason="user_id mismatch",
            )
        else:
            _log(
                "relay active_sessions remove failed",
                relay_id=relay_id,
                session_id=session_id,
                error=str(e),
            )


def _update_relay_status(
    dynamodb, user_id: str, relay_id: str, wavelength_zone_id: str, status: str
) -> None:
    """Set relay status in registry and user profile. Status: online, idle, or offline."""
    if not RELAY_REGISTRY_TABLE or not relay_id or status not in ("online", "idle", "offline"):
        return
    try:
        dynamodb.update_item(
            TableName=RELAY_REGISTRY_TABLE,
            Key={
                "wavelength_zone_id": {"S": wavelength_zone_id},
                "relay_id": {"S": relay_id},
            },
            UpdateExpression="SET #status = :s, last_seen = :now",
            ConditionExpression="user_id = :uid",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={
                ":s": {"S": status},
                ":now": {"N": str(int(time.time()))},
                ":uid": {"S": user_id},
            },
        )
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            _log("update_relay_status skipped", relay_id=relay_id, reason="not found or wrong user")
        return
    if USER_PROFILES_TABLE:
        try:
            resp = dynamodb.get_item(
                TableName=USER_PROFILES_TABLE,
                Key={"user_id": {"S": user_id}},
                ProjectionExpression="relays",
            )
            relays = _from_dynamo((resp.get("Item") or {}).get("relays")) or []
            if not isinstance(relays, list):
                relays = []
            out = []
            for r in relays:
                if isinstance(r, dict) and r.get("relay_id") == relay_id and r.get("wavelength_zone_id") == wavelength_zone_id:
                    r = {**r, "status": status}
                out.append(r)
            dynamodb.update_item(
                TableName=USER_PROFILES_TABLE,
                Key={"user_id": {"S": user_id}},
                UpdateExpression="SET relays = :r",
                ExpressionAttributeValues={":r": _to_dynamo(out)},
            )
        except ClientError:
            pass
    _log("relay status updated", relay_id=relay_id, status=status)


def _add_session_to_agent(
    instance_id: str,
    proxy_url: str,
    session_id: str,
    relay_config: dict | None = None,
    session_metadata: dict | None = None,
) -> None:
    """Add session to the running agent daemon. Daemon stays up; this opens a WebSocket bridge for this session.
    mavlink_host from relay; mavlink_port from session metadata (per-connection).
    """
    if not instance_id or not proxy_url or not session_id:
        _log("add_session skipped", session_id=session_id, has_instance=bool(instance_id), has_proxy_url=bool(proxy_url))
        return
    _log("add_session to agent daemon", session_id=session_id, proxy_url=proxy_url, instance_id=instance_id)
    body = {"session_id": session_id, "proxy_url": proxy_url}
    if relay_config and relay_config.get("mavlink_host"):
        body["mavlink_host"] = relay_config["mavlink_host"]
    elif session_metadata and session_metadata.get("mavlink_host"):
        body["mavlink_host"] = str(session_metadata["mavlink_host"])
    port = None
    if session_metadata and session_metadata.get("mavlink_port") is not None:
        try:
            port = int(session_metadata["mavlink_port"])
        except (TypeError, ValueError):
            pass
    if port is not None:
        body["mavlink_port"] = port
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
    item["ttl_seconds"] = {"N": str(ttl_seconds if ttl_val > 0 else 0)}
    if relay_id:
        item["relay_id"] = {"S": relay_id}
    if body.get("metadata") and isinstance(body["metadata"], dict):
        item["metadata"] = {"S": json.dumps(body["metadata"])}

    dynamodb = boto3.client("dynamodb")
    relay_config = _fetch_relay_config(dynamodb, user_id, relay_id, wavelength_zone_id) if relay_id else None

    signaling_channel_arn = ""
    webrtc_viewer = None
    if webrtc_enabled():
        try:
            ch = create_signaling_channel(session_id)
            signaling_channel_arn = ch["channel_arn"]
            item["signaling_channel_arn"] = {"S": signaling_channel_arn}
            item["transport"] = {"S": "webrtc"}
            webrtc_viewer = build_webrtc_viewer_bundle(session_id, signaling_channel_arn)
            _log("kvs channel created", session_id=session_id, channel_arn=signaling_channel_arn)
        except Exception as e:
            _log("kvs channel create failed", session_id=session_id, error=str(e))
            return _response(500, {"error": f"WebRTC signaling setup failed: {e}"}, headers)

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
    # Legacy proxy path (deprecated when DATA_PLANE=webrtc)
    if not webrtc_enabled():
        _notify_proxy_session_status(session_id, "active")

    if webrtc_enabled() and relay_id and signaling_channel_arn:
        eff_port = None
        metadata = body.get("metadata")
        if isinstance(metadata, dict) and metadata.get("mavlink_port") is not None:
            try:
                eff_port = int(metadata["mavlink_port"])
            except (TypeError, ValueError):
                pass
        if eff_port is None:
            eff_port = int(MAVLINK_PORT) if MAVLINK_PORT else 18570
        eff_host = (relay_config or {}).get("mavlink_host") or "127.0.0.1"
        radio = radio_fields_from_metadata(metadata if isinstance(metadata, dict) else None)
        _add_relay_active_session(
            dynamodb,
            user_id,
            relay_id,
            wavelength_zone_id,
            session_id,
            signaling_channel_arn,
            drone_id=drone_id,
            mavlink_port=eff_port,
            mavlink_host=eff_host,
            link_mode=radio.get("link_mode") or "shared_serial",
            mavlink_sysid=radio.get("mavlink_sysid"),
            mavlink_compid=radio.get("mavlink_compid"),
            radio_net_id=radio.get("radio_net_id"),
            radio_device=radio.get("radio_device") or "",
            radio_baud=radio.get("radio_baud"),
        )

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
    elif (relay_config or {}).get("relay_type") == "local":
        _log("add_session skipped", reason="local_relay", session_id=session_id)
    else:
        _add_session_to_agent(
            WAVELENGTH_INSTANCE_ID,
            PROXY_ENDPOINT,
            session_id,
            relay_config,
            session_metadata=body.get("metadata") if isinstance(body.get("metadata"), dict) else None,
        )
    if relay_id and wavelength_zone_id:
        _update_relay_status(dynamodb, user_id, relay_id, wavelength_zone_id, "online")

    payload = {
        "session_id": session_id,
        "drone_id": drone_id,
        "endpoint": PROXY_ENDPOINT,
        "expires_at": display_expires_at,
        "transport": "webrtc" if webrtc_enabled() else "websocket",
    }
    if webrtc_viewer:
        payload["webrtc"] = webrtc_viewer
    if relay_id:
        payload["relay_id"] = relay_id
    if relay_config:
        payload["relay_config"] = relay_config
    if relay_config and relay_config.get("relay_type"):
        payload["relay_type"] = relay_config["relay_type"]
    # Effective mavlink target: host from relay, port from session metadata (per-connection)
    metadata = body.get("metadata")
    eff_port = None
    if isinstance(metadata, dict) and metadata.get("mavlink_port") is not None:
        try:
            eff_port = int(metadata["mavlink_port"])
        except (TypeError, ValueError):
            pass
    if eff_port is None:
        eff_port = int(MAVLINK_PORT) if MAVLINK_PORT else 18570
    payload["mavlink_port"] = eff_port
    payload["mavlink_host"] = (
        (relay_config or {}).get("mavlink_host") or "127.0.0.1"
    )
    if WAVELENGTH_CARRIER_IP and (not WAVELENGTH_ZONE_ID or wavelength_zone_id == WAVELENGTH_ZONE_ID):
        payload["carrier_ip"] = WAVELENGTH_CARRIER_IP
    _log("create_session success", session_id=session_id, drone_id=drone_id)
    return _response(200, payload, headers)


def _teardown_webrtc_session(dynamodb, user_id: str, session_id: str) -> None:
    """Delete KVS signaling channel and clear relay WebRTC binding for a session."""
    if not webrtc_enabled():
        return
    try:
        resp = dynamodb.get_item(
            TableName=TABLE_NAME,
            Key={"user_id": {"S": user_id}, "session_id": {"S": session_id}},
        )
        item = resp.get("Item") or {}
        channel_arn = (item.get("signaling_channel_arn") or {}).get("S", "")
        relay_id = (item.get("relay_id") or {}).get("S", "")
        zone = (item.get("wavelength_zone_id") or {}).get("S", REGION)
        if channel_arn:
            try:
                delete_signaling_channel(channel_arn)
                _log("kvs channel deleted", session_id=session_id, channel_arn=channel_arn)
            except Exception as e:
                _log("kvs channel delete failed", session_id=session_id, error=str(e))
        if relay_id:
            _remove_relay_active_session(dynamodb, user_id, relay_id, zone, session_id)
    except ClientError:
        pass


def _session_ttl_seconds(item: dict) -> int:
    """Read stored ttl_seconds from session item; default 4h."""
    raw = (item.get("ttl_seconds") or {}).get("N")
    if raw is not None:
        try:
            return int(raw)
        except (TypeError, ValueError):
            pass
    idle_after = (item.get("idle_after") or {}).get("N")
    created = (item.get("created_at") or {}).get("N")
    if idle_after and created:
        try:
            return max(60, int(idle_after) - int(created))
        except (TypeError, ValueError):
            pass
    return DEFAULT_TTL_SECONDS


def _session_mavlink_target(
    dynamodb, user_id: str, item: dict
) -> tuple[int, str, str | None]:
    """Effective mavlink port/host and relay_id for a session."""
    relay_id = (item.get("relay_id") or {}).get("S", "") or None
    wl_zone = (item.get("wavelength_zone_id") or {}).get("S", REGION)
    relay_config = (
        _fetch_relay_config(dynamodb, user_id, relay_id, wl_zone or "")
        if relay_id and RELAY_REGISTRY_TABLE
        else None
    )
    metadata_raw = item.get("metadata", {}).get("S")
    metadata = {}
    if metadata_raw:
        try:
            metadata = json.loads(metadata_raw)
        except (json.JSONDecodeError, TypeError):
            pass
    eff_port = None
    if isinstance(metadata, dict) and metadata.get("mavlink_port") is not None:
        try:
            eff_port = int(metadata["mavlink_port"])
        except (TypeError, ValueError):
            pass
    if eff_port is None:
        eff_port = int(MAVLINK_PORT) if MAVLINK_PORT else 18570
    eff_host = (relay_config or {}).get("mavlink_host") or "127.0.0.1"
    return eff_port, eff_host, relay_id


def _reactivate_webrtc_session(
    dynamodb, user_id: str, session_id: str, item: dict
) -> str:
    """Recreate KVS channel (idle teardown deletes it) and re-register on relay."""
    if not webrtc_enabled():
        return (item.get("signaling_channel_arn") or {}).get("S", "")
    ch = create_signaling_channel(session_id)
    channel_arn = ch["channel_arn"]
    eff_port, eff_host, relay_id = _session_mavlink_target(dynamodb, user_id, item)
    wl_zone = (item.get("wavelength_zone_id") or {}).get("S", REGION)
    drone_id = (item.get("drone_id") or {}).get("S", "")
    metadata_raw = item.get("metadata", {}).get("S")
    metadata = {}
    if metadata_raw:
        try:
            metadata = json.loads(metadata_raw)
        except (json.JSONDecodeError, TypeError):
            pass
    radio = radio_fields_from_metadata(metadata if isinstance(metadata, dict) else None)
    if relay_id:
        if not _add_relay_active_session(
            dynamodb,
            user_id,
            relay_id,
            wl_zone,
            session_id,
            channel_arn,
            drone_id=drone_id,
            mavlink_port=eff_port,
            mavlink_host=eff_host,
            link_mode=radio.get("link_mode") or "shared_serial",
            mavlink_sysid=radio.get("mavlink_sysid"),
            mavlink_compid=radio.get("mavlink_compid"),
            radio_net_id=radio.get("radio_net_id"),
            radio_device=radio.get("radio_device") or "",
            radio_baud=radio.get("radio_baud"),
        ):
            raise RuntimeError(
                f"Failed to register reactivated session on relay {relay_id} "
                "(check relay ownership / relay-registry table)"
            )
    _log("kvs channel reactivated", session_id=session_id, channel_arn=channel_arn)
    return channel_arn


def _upsert_profile_update_name(dynamodb, user_id: str, session_id: str, name: str) -> None:
    """Update session display name in hierarchy."""
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
    hierarchy = update_session_name(hierarchy, session_id, name)
    dynamodb.update_item(
        TableName=USER_PROFILES_TABLE,
        Key={"user_id": {"S": user_id}},
        UpdateExpression="SET connection_hierarchy = :h",
        ExpressionAttributeValues={":h": _to_dynamo(hierarchy)},
    )


def _release_session(user_id: str, session_id: str | None, headers: dict, *, permanent: bool = False) -> dict:
    """Release session (mark idle) or permanently delete."""
    if not session_id:
        _log("release_session rejected", reason="no session_id")
        return _response(400, {"error": "session_id required"}, headers)

    _log("release_session start", session_id=session_id, permanent=permanent)
    dynamodb = boto3.client("dynamodb")

    if permanent:
        session_existed = True
        # Teardown while session row still exists (needs relay_id + channel_arn).
        _teardown_webrtc_session(dynamodb, user_id, session_id)
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
    _teardown_webrtc_session(dynamodb, user_id, session_id)
    if not webrtc_enabled():
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
            _teardown_webrtc_session(dynamodb, user_id, session_id)
            if not webrtc_enabled():
                _notify_proxy_session_status(session_id, "idle")
            if WAVELENGTH_INSTANCE_ID:
                _remove_session_from_agent(WAVELENGTH_INSTANCE_ID, session_id)
    _log("idle_expired_sessions done")


def _patch_session(user_id: str, body: dict, headers: dict) -> dict:
    """Update session: status (active/idle), display name, and/or TTL."""
    session_id = body.get("session_id")
    status = (body.get("status") or "").strip().lower() or None
    name = (body.get("name") or body.get("drone_name") or "").strip() or None
    ttl_raw = body.get("ttl_seconds")

    if not session_id:
        _log("patch_session rejected", reason="no session_id")
        return _response(400, {"error": "session_id required"}, headers)
    if status and status not in ("active", "idle"):
        _log("patch_session rejected", session_id=session_id, reason="invalid status", status=status)
        return _response(400, {"error": "status must be 'active' or 'idle'"}, headers)
    if not status and name is None and ttl_raw is None:
        return _response(400, {"error": "Provide status, name, and/or ttl_seconds"}, headers)

    _log("patch_session start", session_id=session_id, status=status or "(unchanged)")
    dynamodb = boto3.client("dynamodb")
    now = int(time.time())

    try:
        resp = dynamodb.get_item(
            TableName=TABLE_NAME,
            Key={"user_id": {"S": user_id}, "session_id": {"S": session_id}},
        )
    except ClientError:
        raise
    item = resp.get("Item")
    if not item:
        _log("patch_session not found", session_id=session_id)
        return _response(404, {"error": "Session not found"}, headers)

    wavelength_zone_id = item.get("wavelength_zone_id", {}).get("S")
    session_relay_id = item.get("relay_id", {}).get("S")
    session_relay_config = None
    if session_relay_id and wavelength_zone_id and RELAY_REGISTRY_TABLE:
        session_relay_config = _fetch_relay_config(
            dynamodb, user_id, session_relay_id, wavelength_zone_id
        )

    effective_status = status or (item.get("status", {}).get("S") or "idle")
    ttl_seconds = _session_ttl_seconds(item)
    if ttl_raw is not None:
        ttl_val = int(ttl_raw)
        ttl_seconds = 0 if ttl_val <= 0 else max(60, min(ttl_val, MAX_TTL_SECONDS))

    set_parts = ["updated_at = :now"]
    remove_parts: list[str] = []
    expr_names: dict[str, str] = {}
    expr_values: dict[str, dict] = {":now": {"N": str(now)}}

    if status:
        expr_names["#status"] = "status"
        set_parts.append("#status = :status")
        expr_values[":status"] = {"S": status}
        effective_status = status

    set_parts.append("ttl_seconds = :ttl")
    expr_values[":ttl"] = {"N": str(ttl_seconds)}

    if effective_status == "active" and (status == "active" or ttl_raw is not None):
        if ttl_seconds <= 0:
            remove_parts.append("idle_after")
            expr_values[":expires"] = {"N": str(INDEFINITE_EXPIRES_AT)}
            set_parts.append("expires_at = :expires")
        else:
            idle_after_ts = now + ttl_seconds
            expr_values[":idle_after"] = {"N": str(idle_after_ts)}
            expr_values[":expires"] = {"N": str(idle_after_ts)}
            set_parts.extend(["idle_after = :idle_after", "expires_at = :expires"])
        if status == "active":
            remove_parts.append("released_at")
    elif ttl_raw is not None and ttl_seconds > 0:
        # Store TTL for next activation; do not start timer while idle.
        remove_parts.append("idle_after")

    current_status = (item.get("status") or {}).get("S", "idle")
    new_channel_arn = None
    if status == "active" and current_status == "idle":
        try:
            new_channel_arn = _reactivate_webrtc_session(dynamodb, user_id, session_id, item)
        except Exception as e:
            _log("patch_session reactivate webrtc failed", session_id=session_id, error=str(e))
            return _response(500, {"error": f"WebRTC reactivation failed: {e}"}, headers)
        if new_channel_arn:
            set_parts.append("signaling_channel_arn = :channel_arn")
            expr_values[":channel_arn"] = {"S": new_channel_arn}

    update_expr = "SET " + ", ".join(set_parts)
    if remove_parts:
        update_expr += " REMOVE " + ", ".join(remove_parts)

    try:
        update_kwargs: dict[str, Any] = {
            "TableName": TABLE_NAME,
            "Key": {"user_id": {"S": user_id}, "session_id": {"S": session_id}},
            "UpdateExpression": update_expr,
            "ExpressionAttributeValues": expr_values,
        }
        if expr_names:
            update_kwargs["ExpressionAttributeNames"] = expr_names
        dynamodb.update_item(**update_kwargs)
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            _log("patch_session not found", session_id=session_id)
            return _response(404, {"error": "Session not found"}, headers)
        raise

    if name and USER_PROFILES_TABLE:
        _upsert_profile_update_name(dynamodb, user_id, session_id, name)
    if status and USER_PROFILES_TABLE:
        _upsert_profile_update_status(dynamodb, user_id, session_id, status)
    if status == "idle":
        _teardown_webrtc_session(dynamodb, user_id, session_id)
    if status and not webrtc_enabled():
        _notify_proxy_session_status(session_id, status)
    if status == "idle" and WAVELENGTH_INSTANCE_ID:
        _remove_session_from_agent(WAVELENGTH_INSTANCE_ID, session_id)
    elif status == "active" and WAVELENGTH_INSTANCE_ID and (
        not WAVELENGTH_ZONE_ID or wavelength_zone_id == WAVELENGTH_ZONE_ID
    ):
        relay_type = (session_relay_config or {}).get("relay_type")
        if session_relay_id and relay_type == "local":
            _log("add_session skipped", reason="local_relay", session_id=session_id)
        else:
            _add_session_to_agent(WAVELENGTH_INSTANCE_ID, PROXY_ENDPOINT, session_id)
    if status == "active" and session_relay_id and wavelength_zone_id:
        _update_relay_status(dynamodb, user_id, session_relay_id, wavelength_zone_id, "online")

    out: dict[str, Any] = {
        "message": "Session updated",
        "session_id": session_id,
        "status": effective_status,
        "ttl_seconds": ttl_seconds,
    }
    if effective_status == "active" and ttl_seconds > 0:
        out["expires_at"] = now + ttl_seconds
    elif ttl_seconds <= 0:
        out["expires_at"] = INDEFINITE_EXPIRES_AT
    if name:
        out["name"] = name
    channel_arn = new_channel_arn or (item.get("signaling_channel_arn") or {}).get("S", "")
    if webrtc_enabled() and effective_status == "active":
        if not channel_arn and status == "active" and current_status == "idle":
            return _response(
                500,
                {"error": "WebRTC reactivation failed: no signaling channel (redeploy Session API)"},
                headers,
            )
        if channel_arn:
            try:
                out["webrtc"] = build_webrtc_viewer_bundle(session_id, channel_arn)
            except Exception as e:
                _log("patch_session webrtc creds failed", session_id=session_id, error=str(e))
                if status == "active" and current_status == "idle":
                    return _response(
                        500,
                        {"error": f"WebRTC reactivation failed: {e}"},
                        headers,
                    )

    _log("patch_session done", session_id=session_id, status=effective_status)
    return _response(200, out, headers)


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
        transport = (item.get("transport") or {}).get("S")
        if transport:
            out["transport"] = transport
        elif webrtc_enabled():
            out["transport"] = "webrtc"
        relay_id = item.get("relay_id", {}).get("S")
        wl_zone = item.get("wavelength_zone_id", {}).get("S")
        if relay_id:
            out["relay_id"] = relay_id
        # Effective mavlink: host from relay, port from session metadata
        relay_config = (
            _fetch_relay_config(dynamodb, user_id, relay_id, wl_zone or "")
            if relay_id and RELAY_REGISTRY_TABLE
            else None
        )
        metadata_raw = item.get("metadata", {}).get("S")
        metadata = {}
        if metadata_raw:
            try:
                metadata = json.loads(metadata_raw)
            except (json.JSONDecodeError, TypeError):
                pass
        eff_port = None
        if isinstance(metadata, dict) and metadata.get("mavlink_port") is not None:
            try:
                eff_port = int(metadata["mavlink_port"])
            except (TypeError, ValueError):
                pass
        if eff_port is None:
            eff_port = int(MAVLINK_PORT) if MAVLINK_PORT else 18570
        if relay_config and relay_config.get("mavlink_host"):
            out["mavlink_host"] = relay_config["mavlink_host"]
        else:
            out["mavlink_host"] = "127.0.0.1"
        out["mavlink_port"] = eff_port
        if WAVELENGTH_CARRIER_IP and wl_zone and (not WAVELENGTH_ZONE_ID or wl_zone == WAVELENGTH_ZONE_ID):
            out["carrier_ip"] = WAVELENGTH_CARRIER_IP
        ttl = _session_ttl_seconds(item)
        out["ttl_seconds"] = ttl
        exp_n = (item.get("idle_after") or item.get("expires_at")) or {}
        out["expires_at"] = int(exp_n.get("N", "0") or "0")
        if webrtc_enabled():
            channel_arn = (item.get("signaling_channel_arn") or {}).get("S", "")
            if channel_arn and out.get("status") == "active":
                try:
                    out["webrtc"] = build_webrtc_viewer_bundle(session_id, channel_arn)
                except Exception as e:
                    _log("get_session webrtc creds failed", session_id=session_id, error=str(e))
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
            "ttl_seconds": _session_ttl_seconds(item),
        }
        transport = (item.get("transport") or {}).get("S")
        if transport:
            sess["transport"] = transport
        elif webrtc_enabled():
            sess["transport"] = "webrtc"
        if item.get("relay_id", {}).get("S"):
            sess["relay_id"] = item["relay_id"]["S"]
        metadata_raw = item.get("metadata", {}).get("S")
        eff_port = int(MAVLINK_PORT) if MAVLINK_PORT else 18570
        if metadata_raw:
            try:
                metadata = json.loads(metadata_raw)
                if isinstance(metadata, dict) and metadata.get("mavlink_port") is not None:
                    eff_port = int(metadata["mavlink_port"])
            except (json.JSONDecodeError, TypeError, ValueError):
                pass
        sess["mavlink_port"] = eff_port
        if WAVELENGTH_CARRIER_IP:
            wl_zone = item.get("wavelength_zone_id", {}).get("S")
            if not WAVELENGTH_ZONE_ID or wl_zone == WAVELENGTH_ZONE_ID:
                sess["carrier_ip"] = WAVELENGTH_CARRIER_IP
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
