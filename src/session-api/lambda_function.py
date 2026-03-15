"""
Session API - Connection pool management for RDI drone control.
Assigns proxy endpoints to users, manages session lifecycle.
"""

import json
import os
import uuid
import time
from typing import Any

import boto3
from botocore.exceptions import ClientError

TABLE_NAME = os.environ["CONNECTION_POOL_TABLE"]
REGION = os.environ["AWS_REGION"]
PROXY_ENDPOINT = os.environ["PROXY_ENDPOINT"]


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
        if http_method == "DELETE" and "sessions" in path:
            body = json.loads(event.get("body") or "{}")
            session_id = body.get("session_id")
            return _release_session(user_id, session_id, headers)
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


def _create_session(user_id: str, body: dict, headers: dict) -> dict:
    """Create or get existing session, return proxy endpoint."""
    session_id = str(uuid.uuid4())
    now = int(time.time())
    ttl_seconds = body.get("ttl_seconds")
    if ttl_seconds is not None:
        ttl_seconds = max(60, min(int(ttl_seconds), MAX_TTL_SECONDS))
    else:
        ttl_seconds = DEFAULT_TTL_SECONDS
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


def _release_session(user_id: str, session_id: str | None, headers: dict) -> dict:
    """Release session, mark as idle."""
    if not session_id:
        return _response(400, {"error": "session_id required"}, headers)

    now = int(time.time())
    dynamodb = boto3.client("dynamodb")
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

    return _response(200, {"message": "Session released"}, headers)


def _get_session(
    user_id: str, query_params: dict | None, headers: dict
) -> dict:
    """Get session info by session_id."""
    session_id = (query_params or {}).get("session_id") if query_params else None
    if not session_id:
        return _response(400, {"error": "session_id required"}, headers)

    dynamodb = boto3.client("dynamodb")
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


def _response(status_code: int, body: dict, headers: dict) -> dict:
    return {
        "statusCode": status_code,
        "headers": headers,
        "body": json.dumps(body),
    }
