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
PROXY_STATUS_URL = os.environ.get("PROXY_STATUS_URL", "")
PROXY_STATUS_SECRET = os.environ.get("PROXY_STATUS_SECRET", "")
WAVELENGTH_INSTANCE_ID = os.environ.get("WAVELENGTH_INSTANCE_ID", "")
WAVELENGTH_ZONE_ID = os.environ.get("WAVELENGTH_ZONE_ID", "")
WAVELENGTH_CARRIER_IP = os.environ.get("WAVELENGTH_CARRIER_IP", "")
MAVLINK_PORT = os.environ.get("MAVLINK_PORT", "18570")


AGENT_API_PORT = "8080"  # RDI_AGENT_API_PORT on Wavelength (agent daemon)


def _start_agent_on_wavelength(instance_id: str, proxy_url: str, session_id: str) -> None:
    """Tell the agent daemon on Wavelength to add this session (open proxy connection). Option A: daemon + local API."""
    if not instance_id or not proxy_url or not session_id:
        print(f"[RDI Session] agent add skipped: missing instance_id={bool(instance_id)} proxy_url={bool(proxy_url)} session_id={bool(session_id)}")
        return
    print(f"[RDI Session] starting agent on Wavelength session_id={session_id} proxy_url={proxy_url} instance_id={instance_id} (agent will open WebSocket to proxy)")
    body = json.dumps({"session_id": session_id, "proxy_url": proxy_url})
    # One shell command: curl to local agent API (daemon must already be running on the instance)
    cmd = f"curl -s -X POST http://127.0.0.1:{AGENT_API_PORT}/sessions -H 'Content-Type: application/json' -d {shlex.quote(body)}"
    try:
        ssm = boto3.client("ssm", region_name=REGION)
        result = ssm.send_command(
            InstanceIds=[instance_id],
            DocumentName="AWS-RunShellScript",
            Parameters={"commands": [cmd]},
        )
        cmd_id = result.get("Command", {}).get("CommandId", "")
        print(f"[RDI Session] SSM agent add session_id={session_id} instance_id={instance_id} command_id={cmd_id} (WebSocket connection will appear in proxy/agent logs)")
    except Exception as e:
        print(f"[RDI Session] SSM agent add failed session_id={session_id} instance_id={instance_id} error={e}")


def _stop_agent_on_wavelength(instance_id: str, session_id: str) -> None:
    """Tell the agent daemon on Wavelength to remove this session (close proxy connection)."""
    if not instance_id or not session_id:
        return
    print(f"[RDI Session] stopping agent on Wavelength session_id={session_id} instance_id={instance_id} (WebSocket to proxy will close)")
    url = f"http://127.0.0.1:{AGENT_API_PORT}/sessions/{session_id}"
    cmd = f"curl -s -X DELETE {shlex.quote(url)}"
    try:
        ssm = boto3.client("ssm", region_name=REGION)
        ssm.send_command(
            InstanceIds=[instance_id],
            DocumentName="AWS-RunShellScript",
            Parameters={"commands": [cmd]},
        )
        print(f"[RDI Session] SSM agent remove session_id={session_id} instance_id={instance_id}")
    except Exception as e:
        print(f"[RDI Session] SSM agent remove failed session_id={session_id} error={e}")


def _notify_proxy_session_status(session_id: str, status: str) -> None:
    """Tell the proxy to set session status (active/idle). Idle => disconnect and clear from memory."""
    if not PROXY_STATUS_URL or not PROXY_STATUS_SECRET:
        print(f"[RDI Session] proxy status notify skipped (no PROXY_STATUS_URL/SECRET) session_id={session_id} status={status}")
        return
    print(f"[RDI Session] notifying proxy session_id={session_id} status={status} (proxy will {'accept' if status == 'active' else 'disconnect'} WebSocket connections for this session)")
    body = json.dumps({"session_id": session_id, "status": status}).encode("utf-8")
    req = urllib.request.Request(
        PROXY_STATUS_URL,
        data=body,
        headers={
            "Content-Type": "application/json",
            "X-Proxy-Secret": PROXY_STATUS_SECRET,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            if resp.status != 200:
                print(f"[RDI Session] proxy status API returned {resp.status} for session {session_id}")
            else:
                print(f"[RDI Session] proxy status acknowledged session_id={session_id} status={status}")
    except urllib.error.URLError as e:
        print(f"[RDI Session] proxy status notify failed session_id={session_id} error={e}")
    except Exception as e:
        print(f"[RDI Session] proxy status notify error session_id={session_id}: {e}")


def lambda_handler(event: dict, context: Any) -> dict:
    """Handle API Gateway requests or scheduled idle-expiry (EventBridge)."""
    if event.get("source") == "schedule" and event.get("action") == "idle_expired_sessions":
        _idle_expired_sessions()
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
            return _response(401, {"error": "Unauthorized"}, headers)

        if http_method == "POST" and "sessions" in path:
            body = json.loads(event.get("body") or "{}")
            return _create_session(user_id, body, headers)
        if http_method == "PATCH" and "sessions" in path:
            body = json.loads(event.get("body") or "{}")
            return _patch_session(user_id, body, headers)
        if http_method == "DELETE" and "sessions" in path:
            body = json.loads(event.get("body") or "{}")
            session_id = body.get("session_id")
            permanent = body.get("permanent", False)
            return _release_session(user_id, session_id, headers, permanent=permanent)
        if http_method == "GET" and "sessions" in path:
            return _get_session(user_id, event.get("queryStringParameters"), headers)

        return _response(404, {"error": "Not found"}, headers)

    except Exception as e:
        print(f"Error: {e}")
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
        return _response(400, {"error": "Cannot create connections in Shared or its subfolders"}, headers)

    session_id = str(uuid.uuid4())
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
    if body.get("metadata") and isinstance(body["metadata"], dict):
        item["metadata"] = {"S": json.dumps(body["metadata"])}

    dynamodb = boto3.client("dynamodb")
    try:
        dynamodb.put_item(
            TableName=TABLE_NAME,
            Item=item,
            ConditionExpression="attribute_not_exists(session_id)",
        )
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            pass  # Retry with new session_id
            return _create_session(user_id, body, headers)
        raise

    if USER_PROFILES_TABLE:
        _upsert_profile_add_session(
            dynamodb, user_id,
            session_id=session_id,
            name=drone_name,
            status="active",
            folder_path=folder_path,
        )

    # Mark session active on the proxy so it accepts UI and agent WebSocket connections for this session.
    idle_desc = f"idle_after_ts={idle_after_ts}" if idle_after_ts else "indefinite (no TTL; only explicit release marks idle)"
    print(f"[RDI Session] session created session_id={session_id} endpoint={PROXY_ENDPOINT} drone_id={drone_id} {idle_desc} wavelength_zone_id={wavelength_zone_id}")
    _notify_proxy_session_status(session_id, "active")

    if not WAVELENGTH_INSTANCE_ID:
        print(f"[RDI Session] proxy-only mode: no WAVELENGTH_INSTANCE_ID; frontend may connect to proxy WebSocket without an edge agent (proxy acks PING with ping_ack + server_ts_ms)")
    elif WAVELENGTH_ZONE_ID and wavelength_zone_id != WAVELENGTH_ZONE_ID:
        print(f"[RDI Session] agent not started: zone mismatch request_zone={wavelength_zone_id} deployed_zone={WAVELENGTH_ZONE_ID}")
    else:
        _start_agent_on_wavelength(WAVELENGTH_INSTANCE_ID, PROXY_ENDPOINT, session_id)

    payload = {
        "session_id": session_id,
        "drone_id": drone_id,
        "endpoint": PROXY_ENDPOINT,
        "expires_at": display_expires_at,
    }
    if WAVELENGTH_CARRIER_IP and (not WAVELENGTH_ZONE_ID or wavelength_zone_id == WAVELENGTH_ZONE_ID):
        payload["carrier_ip"] = WAVELENGTH_CARRIER_IP
        payload["mavlink_port"] = MAVLINK_PORT
    return _response(200, payload, headers)


def _release_session(user_id: str, session_id: str | None, headers: dict, *, permanent: bool = False) -> dict:
    """Release session (mark idle) or permanently delete."""
    if not session_id:
        return _response(400, {"error": "session_id required"}, headers)

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
            return _response(404, {"error": "Session not found"}, headers)
        raise

    print(f"[RDI Session] session released (user) session_id={session_id} -> idle (proxy will disconnect WebSocket; agent will close)")
    if USER_PROFILES_TABLE:
        _upsert_profile_update_status(dynamodb, user_id, session_id, "idle")
    _notify_proxy_session_status(session_id, "idle")
    if WAVELENGTH_INSTANCE_ID:
        _stop_agent_on_wavelength(WAVELENGTH_INSTANCE_ID, session_id)

    return _response(200, {"message": "Session released"}, headers)


def _idle_expired_sessions() -> None:
    """Scheduled job: mark active sessions as idle when idle_after has passed. Does not delete.
    TTL is shared with connection lifetime: only sessions with idle_after set will transition to idle;
    sessions with ttl_seconds=0 have no idle_after and stay active until explicit release."""
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
                print(f"[RDI Session] idle_expired marking idle session_id={session_id} (idle_after passed; proxy/agent will disconnect)")
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
                _stop_agent_on_wavelength(WAVELENGTH_INSTANCE_ID, session_id)


def _patch_session(user_id: str, body: dict, headers: dict) -> dict:
    """Set session status (e.g. active). Body: session_id, status."""
    session_id = body.get("session_id")
    status = (body.get("status") or "").strip().lower()
    if not session_id:
        return _response(400, {"error": "session_id required"}, headers)
    if status not in ("active", "idle"):
        return _response(400, {"error": "status must be 'active' or 'idle'"}, headers)

    dynamodb = boto3.client("dynamodb")
    now = int(time.time())
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
            return _response(404, {"error": "Session not found"}, headers)
        raise

    if USER_PROFILES_TABLE:
        _upsert_profile_update_status(dynamodb, user_id, session_id, status)
    _notify_proxy_session_status(session_id, status)
    if status == "idle" and WAVELENGTH_INSTANCE_ID:
        _stop_agent_on_wavelength(WAVELENGTH_INSTANCE_ID, session_id)

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
            return _response(404, {"error": "Session not found"}, headers)

        out = {
            "session_id": session_id,
            "drone_id": item.get("drone_id", {}).get("S"),
            "endpoint": item.get("endpoint", {}).get("S"),
            "status": item.get("status", {}).get("S"),
        }
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


def _upsert_profile_add_session(dynamodb, user_id: str, *, session_id: str, name: str, status: str, folder_path: list) -> None:
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
    hierarchy = add_session_to_folder(hierarchy, folder_path, session_id, name, status)
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
