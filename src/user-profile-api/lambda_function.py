"""
User Profile API - Returns user profile including connection hierarchy (folders).
Separate Lambda from Session API for clear separation of concerns.
"""

import copy
import json
import os
from typing import Any

import boto3
from botocore.exceptions import ClientError

TABLE_NAME = os.environ["USER_PROFILES_TABLE"]

# Shared folder has nested "Shared with me" and "Shared with others"
SHARED_DEFAULT = {
    "sessions": [],
    "subfolders": {
        "Shared with me": {"sessions": [], "subfolders": {}},
        "Shared with others": {"sessions": [], "subfolders": {}},
    },
}

DEFAULT_HIERARCHY = {
    "My Drones": {"sessions": [], "subfolders": {}},
    "Shared": dict(SHARED_DEFAULT),
}


def _ensure_shared_folder(hierarchy: dict) -> None:
    """Ensure 'Shared' exists at root with nested 'Shared with me' and 'Shared with others'. Skip if already present."""
    if not isinstance(hierarchy, dict):
        return
    if "Shared" not in hierarchy:
        hierarchy["Shared"] = {
            "sessions": [],
            "subfolders": {
                "Shared with me": {"sessions": [], "subfolders": {}},
                "Shared with others": {"sessions": [], "subfolders": {}},
            },
        }
        return
    node = hierarchy["Shared"]
    if not isinstance(node, dict):
        hierarchy["Shared"] = {
            "sessions": [],
            "subfolders": {
                "Shared with me": {"sessions": [], "subfolders": {}},
                "Shared with others": {"sessions": [], "subfolders": {}},
            },
        }
        return
    node.setdefault("sessions", [])
    if not isinstance(node.get("subfolders"), dict):
        node["subfolders"] = {}
    sub = node["subfolders"]
    for key in ("Shared with me", "Shared with others"):
        if key not in sub or not isinstance(sub.get(key), dict):
            sub[key] = {"sessions": [], "subfolders": {}}
        else:
            sub[key].setdefault("sessions", [])
            sub[key].setdefault("subfolders", {})


def _response(status_code: int, body: dict, headers: dict) -> dict:
    """Return API Gateway Lambda proxy response."""
    return {
        "statusCode": status_code,
        "headers": headers,
        "body": json.dumps(body),
    }


def lambda_handler(event: dict, context: Any) -> dict:
    """Handle API Gateway GET /user-profile."""
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

        if http_method == "GET" and "user-profile" in path:
            return _get_profile(user_id, headers)
        if http_method == "PATCH" and "user-profile" in path:
            body = json.loads(event.get("body") or "{}")
            return _patch_profile(user_id, body, headers)

        return _response(404, {"error": "Not found"}, headers)

    except Exception as e:
        print(f"Error: {e}")
        return _response(500, {"error": str(e)}, headers)


def _get_user_id(event: dict) -> str | None:
    """Extract user ID from Cognito JWT claims."""
    claims = event.get("requestContext", {}).get("authorizer", {}).get("claims", {})
    return claims.get("sub")


def _get_profile(user_id: str, headers: dict) -> dict:
    """Get user profile including connection_hierarchy."""
    dynamodb = boto3.client("dynamodb")
    try:
        resp = dynamodb.get_item(
            TableName=TABLE_NAME,
            Key={"user_id": {"S": user_id}},
        )
    except ClientError:
        raise

    item = resp.get("Item")
    if item and "connection_hierarchy" in item:
        connection_hierarchy = _from_dynamo_value(item["connection_hierarchy"])
        if not isinstance(connection_hierarchy, dict):
            connection_hierarchy = copy.deepcopy(DEFAULT_HIERARCHY)
    else:
        connection_hierarchy = copy.deepcopy(DEFAULT_HIERARCHY)

    _ensure_shared_folder(connection_hierarchy)

    return _response(
        200,
        {
            "user_id": user_id,
            "connection_hierarchy": connection_hierarchy,
        },
        headers,
    )


def _patch_profile(user_id: str, body: dict, headers: dict) -> dict:
    """Update profile - e.g. create_folder, delete_folder."""
    action = body.get("action")
    if action == "create_folder":
        parent_path = body.get("parent_path")
        folder_name = (body.get("folder_name") or "").strip()
        if not folder_name:
            return _response(400, {"error": "folder_name required"}, headers)
        if parent_path is not None and not isinstance(parent_path, list):
            return _response(400, {"error": "parent_path must be a list"}, headers)
        return _create_folder(user_id, parent_path or [], folder_name, headers)
    if action == "delete_folder":
        folder_path = body.get("folder_path")
        if not isinstance(folder_path, list) or not folder_path:
            return _response(400, {"error": "folder_path required (list)"}, headers)
        return _delete_folder(user_id, folder_path, headers)
    return _response(400, {"error": f"Unknown action: {action}"}, headers)


def _create_folder(user_id: str, parent_path: list[str], folder_name: str, headers: dict) -> dict:
    """Add a new folder at parent_path. E.g. parent_path=['My Drones'], folder_name='Fleet A'."""
    dynamodb = boto3.client("dynamodb")
    try:
        resp = dynamodb.get_item(
            TableName=TABLE_NAME,
            Key={"user_id": {"S": user_id}},
        )
    except ClientError:
        raise
    item = resp.get("Item")
    hierarchy = copy.deepcopy(DEFAULT_HIERARCHY)
    if item and "connection_hierarchy" in item:
        hierarchy = _from_dynamo_value(item["connection_hierarchy"]) or copy.deepcopy(DEFAULT_HIERARCHY)
    parent = hierarchy
    for part in parent_path:
        if part not in parent:
            parent[part] = {"sessions": [], "subfolders": {}}
        node = parent[part]
        if "subfolders" not in node:
            node["subfolders"] = {}
        parent = node["subfolders"]
    if folder_name in parent:
        return _response(400, {"error": f"Folder '{folder_name}' already exists"}, headers)
    parent[folder_name] = {"sessions": [], "subfolders": {}}
    dynamodb.update_item(
        TableName=TABLE_NAME,
        Key={"user_id": {"S": user_id}},
        UpdateExpression="SET connection_hierarchy = :h",
        ExpressionAttributeValues={":h": _to_dynamo(hierarchy)},
    )
    return _response(200, {"message": "Folder created"}, headers)


def _delete_folder(user_id: str, folder_path: list[str], headers: dict) -> dict:
    """Remove a folder from hierarchy. Sessions in it become uncategorized."""
    dynamodb = boto3.client("dynamodb")
    try:
        resp = dynamodb.get_item(
            TableName=TABLE_NAME,
            Key={"user_id": {"S": user_id}},
        )
    except ClientError:
        raise
    item = resp.get("Item")
    if not item or "connection_hierarchy" not in item:
        return _response(200, {"message": "Folder deleted"}, headers)
    hierarchy = _from_dynamo_value(item["connection_hierarchy"]) or copy.deepcopy(DEFAULT_HIERARCHY)
    last = folder_path[-1]
    if len(folder_path) == 1:
        if last in hierarchy:
            del hierarchy[last]
    else:
        parent = hierarchy
        for part in folder_path[:-1]:
            parent = parent.get(part, {}).get("subfolders", {})
        if last in parent:
            del parent[last]
    dynamodb.update_item(
        TableName=TABLE_NAME,
        Key={"user_id": {"S": user_id}},
        UpdateExpression="SET connection_hierarchy = :h",
        ExpressionAttributeValues={":h": _to_dynamo(hierarchy)},
    )
    return _response(200, {"message": "Folder deleted"}, headers)


def _to_dynamo(obj) -> dict:
    from boto3.dynamodb.types import TypeSerializer
    return TypeSerializer().serialize(obj)


def _from_dynamo_value(val: dict | None) -> Any:
    """Convert DynamoDB format to Python using TypeDeserializer."""
    if not val:
        return None
    from boto3.dynamodb.types import TypeDeserializer
    return TypeDeserializer().deserialize(val)
