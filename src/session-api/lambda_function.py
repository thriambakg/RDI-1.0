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
            return _create_session(user_id, headers)
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


def _create_session(user_id: str, headers: dict) -> dict:
    """Create or get existing session, return proxy endpoint."""
    session_id = str(uuid.uuid4())
    now = int(time.time())
    expires_at = now + 3600  # 1 hour TTL

    item = {
        "region": {"S": REGION},
        "session_id": {"S": session_id},
        "status": {"S": "active"},
        "user_id": {"S": user_id},
        "created_at": {"N": str(now)},
        "expires_at": {"N": str(expires_at)},
        "endpoint": {"S": PROXY_ENDPOINT},
    }

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
            return _create_session(user_id, headers)
        raise

    return _response(
        200,
        {
            "session_id": session_id,
            "endpoint": PROXY_ENDPOINT,
            "expires_at": expires_at,
        },
        headers,
    )


def _release_session(user_id: str, session_id: str | None, headers: dict) -> dict:
    """Release session, mark as idle."""
    if not session_id:
        return _response(400, {"error": "session_id required"}, headers)

    dynamodb = boto3.client("dynamodb")
    try:
        dynamodb.update_item(
            TableName=TABLE_NAME,
            Key={
                "region": {"S": REGION},
                "session_id": {"S": session_id},
            },
            UpdateExpression="SET #status = :idle",
            ConditionExpression="user_id = :uid",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={":idle": {"S": "idle"}, ":uid": {"S": user_id}},
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
                "region": {"S": REGION},
                "session_id": {"S": session_id},
            },
        )
    except ClientError:
        raise

    item = resp.get("Item")
    if not item or item.get("user_id", {}).get("S") != user_id:
        return _response(404, {"error": "Session not found"}, headers)

    return _response(
        200,
        {
            "session_id": session_id,
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
