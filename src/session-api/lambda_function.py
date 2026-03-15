"""
Session API - Connection pool management for RDI drone control.
Assigns proxy endpoints to users, manages session lifecycle.
Updates user profile connection_hierarchy on create, release, delete.
Notifies proxy (EC2) on session status change so it only allows active connections
and clears idle sessions from memory.
"""

import json
import os
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


def _notify_proxy_session_status(session_id: str, status: str) -> None:
    """Tell the proxy to set session status (active/idle). Idle => disconnect and clear from memory."""
    if not PROXY_STATUS_URL or not PROXY_STATUS_SECRET:
        return
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
                print(f"Proxy status API returned {resp.status} for session {session_id}")
    except urllib.error.URLError as e:
        print(f"Proxy status notify failed for session {session_id}: {e}")
    except Exception as e:
        print(f"Proxy status notify error: {e}")


def lambda_handler(event: dict, context: Any) -> dict:
    """Handle API Gateway requests."""
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


# TTL bounds: default 4h for idle sessions, max 7 days
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
    else:
        ttl_val = int(ttl_seconds)
        if ttl_val <= 0:
            expires_at = INDEFINITE_EXPIRES_AT  # No TTL (indefinite)
            ttl_seconds = None  # Not used for calculation
        else:
            ttl_seconds = max(60, min(ttl_val, MAX_TTL_SECONDS))
            expires_at = now + ttl_seconds

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

    return _response(
        200,
        {
            "session_id": session_id,
            "drone_id": drone_id,
            "endpoint": PROXY_ENDPOINT,
            "expires_at": expires_at,
        },
        headers,
    )


def _release_session(user_id: str, session_id: str | None, headers: dict, *, permanent: bool = False) -> dict:
    """Release session (mark idle) or permanently delete."""
    if not session_id:
        return _response(400, {"error": "session_id required"}, headers)

    dynamodb = boto3.client("dynamodb")

    if permanent:
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
                return _response(404, {"error": "Session not found"}, headers)
            raise
        if USER_PROFILES_TABLE:
            _upsert_profile_remove_session(dynamodb, user_id, session_id)
        return _response(200, {"message": "Session deleted"}, headers)

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

    if USER_PROFILES_TABLE:
        _upsert_profile_update_status(dynamodb, user_id, session_id, "idle")
    _notify_proxy_session_status(session_id, "idle")

    return _response(200, {"message": "Session released"}, headers)


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

        return _response(
            200,
            {
                "session_id": session_id,
                "drone_id": item.get("drone_id", {}).get("S"),
                "endpoint": item.get("endpoint", {}).get("S"),
                "status": item.get("status", {}).get("S"),
            },
            headers,
        )

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
        sessions.append({
            "session_id": sid,
            "drone_id": drone_id,
            "name": name,
            "status": item.get("status", {}).get("S") or "idle",
            "wavelength_zone_id": item.get("wavelength_zone_id", {}).get("S"),
            "endpoint": item.get("endpoint", {}).get("S"),
            "expires_at": int(item.get("expires_at", {}).get("N", "0")),
        })

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
