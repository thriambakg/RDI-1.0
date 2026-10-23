"""
User Profile API - Returns user profile including connection hierarchy (folders).
Separate Lambda from Session API for clear separation of concerns.
"""

import copy
import json
import os
from decimal import Decimal
from typing import Any

import boto3
from botocore.exceptions import ClientError

from auth_session import reject_if_session_superseded, release_auth_session
from security_audit import audit
from totp_crypto import decrypt_secret, encrypt_secret
from totp_util import generate_secret, otpauth_uri, verify_totp

TABLE_NAME = os.environ["USER_PROFILES_TABLE"]
# Soft MFA attempt limit per user (sliding window in Dynamo).
_MFA_MAX_ATTEMPTS = 8
_MFA_WINDOW_SECONDS = 300

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


def _json_safe(obj: Any) -> Any:
    """Convert DynamoDB/Python values into JSON-serializable forms (Decimal → int/float)."""
    if isinstance(obj, Decimal):
        if obj % 1 == 0:
            return int(obj)
        return float(obj)
    if isinstance(obj, dict):
        return {str(k): _json_safe(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_json_safe(v) for v in obj]
    if isinstance(obj, tuple):
        return [_json_safe(v) for v in obj]
    if isinstance(obj, set):
        return [_json_safe(v) for v in obj]
    return obj


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
        "body": json.dumps(_json_safe(body)),
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
        superseded = reject_if_session_superseded(event, headers, _response)
        if superseded is not None:
            return superseded

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
    """Get user profile including connection_hierarchy and settings."""
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

    relays = []
    if item and "relays" in item:
        relays = _from_dynamo_value(item["relays"]) or []
    if not isinstance(relays, list):
        relays = []

    settings = {}
    if item and "settings" in item:
        settings = _from_dynamo_value(item["settings"]) or {}
    if not isinstance(settings, dict):
        settings = {}

    return _response(
        200,
        {
            "user_id": user_id,
            "connection_hierarchy": connection_hierarchy,
            "relays": relays,
            "settings": settings,
        },
        headers,
    )


def _patch_profile(user_id: str, body: dict, headers: dict) -> dict:
    """Update profile - e.g. create_folder, delete_folder, update_settings."""
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
    if action == "update_settings":
        settings_patch = body.get("settings")
        if not isinstance(settings_patch, dict):
            return _response(400, {"error": "settings object required"}, headers)
        return _update_settings(user_id, settings_patch, headers)
    if action == "release_auth_session":
        release_auth_session(user_id)
        return _response(200, {"ok": True}, headers)
    if action == "mfa_status":
        return _mfa_status(user_id, headers)
    if action == "mfa_setup_start":
        return _mfa_setup_start(user_id, body, headers)
    if action == "mfa_setup_verify":
        return _mfa_setup_verify(user_id, body, headers)
    if action == "mfa_verify":
        return _mfa_verify(user_id, body, headers)
    return _response(400, {"error": f"Unknown action: {action}"}, headers)


def _mfa_rate_limited(dynamodb, user_id: str) -> bool:
    """Return True if too many recent MFA failures."""
    import time as _time

    now = int(_time.time())
    try:
        resp = dynamodb.get_item(
            TableName=TABLE_NAME,
            Key={"user_id": {"S": user_id}},
            ProjectionExpression="mfa_fail_count, mfa_fail_window_start",
        )
        item = resp.get("Item") or {}
        start = int((item.get("mfa_fail_window_start") or {}).get("N") or "0")
        count = int((item.get("mfa_fail_count") or {}).get("N") or "0")
        if start and now - start < _MFA_WINDOW_SECONDS and count >= _MFA_MAX_ATTEMPTS:
            return True
    except Exception as e:
        print(f"[mfa] rate check failed: {e}")
    return False


def _mfa_record_failure(dynamodb, user_id: str) -> None:
    import time as _time

    now = int(_time.time())
    try:
        resp = dynamodb.get_item(
            TableName=TABLE_NAME,
            Key={"user_id": {"S": user_id}},
            ProjectionExpression="mfa_fail_count, mfa_fail_window_start",
        )
        item = resp.get("Item") or {}
        start = int((item.get("mfa_fail_window_start") or {}).get("N") or "0")
        count = int((item.get("mfa_fail_count") or {}).get("N") or "0")
        if not start or now - start >= _MFA_WINDOW_SECONDS:
            start, count = now, 0
        count += 1
        dynamodb.update_item(
            TableName=TABLE_NAME,
            Key={"user_id": {"S": user_id}},
            UpdateExpression="SET mfa_fail_count = :c, mfa_fail_window_start = :w",
            ExpressionAttributeValues={
                ":c": {"N": str(count)},
                ":w": {"N": str(start)},
            },
        )
    except Exception as e:
        print(f"[mfa] record failure failed: {e}")


def _mfa_clear_failures(dynamodb, user_id: str) -> None:
    try:
        dynamodb.update_item(
            TableName=TABLE_NAME,
            Key={"user_id": {"S": user_id}},
            UpdateExpression="REMOVE mfa_fail_count, mfa_fail_window_start",
        )
    except Exception:
        pass


def _mfa_status(user_id: str, headers: dict) -> dict:
    dynamodb = boto3.client("dynamodb")
    resp = dynamodb.get_item(
        TableName=TABLE_NAME,
        Key={"user_id": {"S": user_id}},
        ProjectionExpression="app_totp_enabled",
    )
    item = resp.get("Item") or {}
    enabled = (item.get("app_totp_enabled") or {}).get("BOOL") is True
    audit("mfa_status", user_id=user_id, enrolled=enabled)
    return _response(200, {"enrolled": enabled}, headers)


def _mfa_setup_start(user_id: str, body: dict, headers: dict) -> dict:
    """Begin app-level TOTP enroll (used for Google / federated users)."""
    account = (body.get("account_name") or user_id)[:128]
    secret = generate_secret()
    stored = encrypt_secret(secret)
    dynamodb = boto3.client("dynamodb")
    dynamodb.update_item(
        TableName=TABLE_NAME,
        Key={"user_id": {"S": user_id}},
        UpdateExpression="SET app_totp_secret_pending = :s",
        ExpressionAttributeValues={":s": {"S": stored}},
    )
    audit("mfa_setup_start", user_id=user_id)
    return _response(
        200,
        {
            "shared_secret": secret,
            "setup_uri": otpauth_uri(secret, account, issuer="RDI"),
        },
        headers,
    )


def _mfa_setup_verify(user_id: str, body: dict, headers: dict) -> dict:
    code = (body.get("code") or "").strip()
    dynamodb = boto3.client("dynamodb")
    if _mfa_rate_limited(dynamodb, user_id):
        audit("mfa_setup_verify_rate_limited", user_id=user_id)
        return _response(
            429,
            {"error": "Too many attempts. Try again later.", "code": "MFA_RATE_LIMITED"},
            headers,
        )
    resp = dynamodb.get_item(
        TableName=TABLE_NAME,
        Key={"user_id": {"S": user_id}},
        ProjectionExpression="app_totp_secret_pending",
    )
    item = resp.get("Item") or {}
    stored = (item.get("app_totp_secret_pending") or {}).get("S") or ""
    try:
        secret = decrypt_secret(stored) if stored else ""
    except Exception:
        secret = ""
    if not secret or not verify_totp(secret, code):
        _mfa_record_failure(dynamodb, user_id)
        audit("mfa_setup_verify_fail", user_id=user_id)
        return _response(400, {"error": "Invalid authenticator code", "code": "MFA_INVALID"}, headers)
    encrypted = encrypt_secret(secret)
    dynamodb.update_item(
        TableName=TABLE_NAME,
        Key={"user_id": {"S": user_id}},
        UpdateExpression=(
            "SET app_totp_secret = :s, app_totp_enabled = :t "
            "REMOVE app_totp_secret_pending"
        ),
        ExpressionAttributeValues={
            ":s": {"S": encrypted},
            ":t": {"BOOL": True},
        },
    )
    _mfa_clear_failures(dynamodb, user_id)
    audit("mfa_setup_verify_ok", user_id=user_id)
    return _response(200, {"ok": True, "enrolled": True}, headers)


def _mfa_verify(user_id: str, body: dict, headers: dict) -> dict:
    code = (body.get("code") or "").strip()
    dynamodb = boto3.client("dynamodb")
    if _mfa_rate_limited(dynamodb, user_id):
        audit("mfa_verify_rate_limited", user_id=user_id)
        return _response(
            429,
            {"error": "Too many attempts. Try again later.", "code": "MFA_RATE_LIMITED"},
            headers,
        )
    resp = dynamodb.get_item(
        TableName=TABLE_NAME,
        Key={"user_id": {"S": user_id}},
        ProjectionExpression="app_totp_secret, app_totp_enabled",
    )
    item = resp.get("Item") or {}
    if (item.get("app_totp_enabled") or {}).get("BOOL") is not True:
        audit("mfa_verify_not_enrolled", user_id=user_id)
        return _response(400, {"error": "Authenticator not enrolled", "code": "MFA_NOT_ENROLLED"}, headers)
    stored = (item.get("app_totp_secret") or {}).get("S") or ""
    try:
        secret = decrypt_secret(stored) if stored else ""
    except Exception:
        secret = ""
    if not secret or not verify_totp(secret, code):
        _mfa_record_failure(dynamodb, user_id)
        audit("mfa_verify_fail", user_id=user_id)
        return _response(400, {"error": "Invalid authenticator code", "code": "MFA_INVALID"}, headers)
    # Re-encrypt legacy plaintext on successful verify
    if stored and not stored.startswith("enc:v1:"):
        try:
            dynamodb.update_item(
                TableName=TABLE_NAME,
                Key={"user_id": {"S": user_id}},
                UpdateExpression="SET app_totp_secret = :s",
                ExpressionAttributeValues={":s": {"S": encrypt_secret(secret)}},
            )
        except Exception as e:
            print(f"[mfa] re-encrypt legacy failed: {e}")
    _mfa_clear_failures(dynamodb, user_id)
    audit("mfa_verify_ok", user_id=user_id)
    return _response(200, {"ok": True}, headers)


def _update_settings(user_id: str, settings_patch: dict, headers: dict) -> dict:
    """Merge settings onto the user-profiles item (e.g. controls.keybinds)."""
    dynamodb = boto3.client("dynamodb")
    try:
        resp = dynamodb.get_item(
            TableName=TABLE_NAME,
            Key={"user_id": {"S": user_id}},
        )
    except ClientError:
        raise
    item = resp.get("Item")
    current: dict = {}
    if item and "settings" in item:
        current = _from_dynamo_value(item["settings"]) or {}
    if not isinstance(current, dict):
        current = {}
    merged = _merge_settings(current, settings_patch)
    dynamodb.update_item(
        TableName=TABLE_NAME,
        Key={"user_id": {"S": user_id}},
        UpdateExpression="SET settings = :s",
        ExpressionAttributeValues={":s": _to_dynamo(merged)},
    )
    return _response(200, {"message": "Settings updated", "settings": merged}, headers)


def _deep_merge_dicts(base: dict, patch: dict) -> dict:
    out = copy.deepcopy(base)
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge_dicts(out[key], value)
        else:
            out[key] = copy.deepcopy(value)
    return out


def _merge_controls(base: dict, patch: dict) -> dict:
    """Merge controls; replace each session's connection_keybinds map (no deep-merge into actions)."""
    out = copy.deepcopy(base) if isinstance(base, dict) else {}
    for key, value in patch.items():
        if key == "connection_keybinds" and isinstance(value, dict):
            ck = out.get("connection_keybinds")
            ck = copy.deepcopy(ck) if isinstance(ck, dict) else {}
            for session_id, binds in value.items():
                # Wholesale replace — dual-slot binds must not merge into legacy {device,code}.
                ck[session_id] = copy.deepcopy(binds)
            out["connection_keybinds"] = ck
        elif isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge_dicts(out[key], value)
        else:
            out[key] = copy.deepcopy(value)
    return out


def _merge_settings(base: dict, patch: dict) -> dict:
    out = copy.deepcopy(base)
    for key, value in patch.items():
        if key == "controls" and isinstance(value, dict):
            existing = out.get("controls")
            out[key] = _merge_controls(existing if isinstance(existing, dict) else {}, value)
        elif isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge_dicts(out[key], value)
        else:
            out[key] = copy.deepcopy(value)
    return out


def _create_folder(user_id: str, parent_path: list[str], folder_name: str, headers: dict) -> dict:
    """Add a new folder at parent_path. E.g. parent_path=['My Drones'], folder_name='Fleet A'. Cannot create under Shared."""
    if parent_path and parent_path[0] == "Shared":
        return _response(400, {"error": "Cannot create folders under Shared"}, headers)
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
    """Remove a folder from hierarchy. Sessions in it become uncategorized. Shared and its fixed subfolders cannot be deleted."""
    if folder_path and folder_path[0] == "Shared":
        return _response(400, {"error": "Cannot delete Shared or its subfolders"}, headers)
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
    return _json_safe(TypeDeserializer().deserialize(val))
