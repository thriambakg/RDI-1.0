"""
Relay Registry API - Register and manage relay devices per Wavelength zone.
Relays (local tunnel, SIM relays) connect to Wavelength instances; this API
registers them so users can select a relay when creating connections.
"""

import json
import os
import time
import uuid
from typing import Any

import boto3
from botocore.exceptions import ClientError


def _to_dynamo(obj: Any) -> dict:
    from boto3.dynamodb.types import TypeSerializer
    return TypeSerializer().serialize(obj)


def _from_dynamo(val: dict | None) -> Any:
    if not val:
        return None
    from boto3.dynamodb.types import TypeDeserializer
    return TypeDeserializer().deserialize(val)

TABLE_NAME = os.environ["RELAY_REGISTRY_TABLE"]
USER_PROFILES_TABLE = os.environ.get("USER_PROFILES_TABLE", "")
REGION = os.environ.get("AWS_REGION", "eu-central-1")

RELAY_TYPES = ("local", "sim_relay")


def _log(msg: str, **kwargs: Any) -> None:
    extra = " ".join(f"{k}={v}" for k, v in kwargs.items())
    print(f"[RDI Relay Registry] {msg}" + (f" {extra}" if extra else ""))


def _response(status_code: int, body: dict, headers: dict) -> dict:
    return {
        "statusCode": status_code,
        "headers": headers,
        "body": json.dumps(body),
    }


def _get_user_id(event: dict) -> str | None:
    claims = event.get("requestContext", {}).get("authorizer", {}).get("claims", {})
    return claims.get("sub")


def lambda_handler(event: dict, context: Any) -> dict:
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

        if "relays" not in path:
            return _response(404, {"error": "Not found"}, headers)

        if http_method == "POST":
            body = json.loads(event.get("body") or "{}")
            return _register_relay(user_id, body, headers)
        if http_method == "GET":
            params = event.get("queryStringParameters") or {}
            return _list_relays(user_id, params, headers)
        if http_method == "PATCH":
            body = json.loads(event.get("body") or "{}")
            return _update_relay(user_id, body, headers)
        if http_method == "DELETE":
            body = json.loads(event.get("body") or "{}")
            return _delete_relay(user_id, body, headers)

        return _response(404, {"error": "Not found"}, headers)

    except Exception as e:
        _log("handler error", error=str(e))
        return _response(500, {"error": str(e)}, headers)


def _register_relay(user_id: str, body: dict, headers: dict) -> dict:
    """POST /relays - Register a new relay for a Wavelength zone."""
    wavelength_zone_id = (body.get("wavelength_zone_id") or "").strip()
    name = (body.get("name") or "").strip() or "relay"
    relay_type = (body.get("relay_type") or "local").strip().lower()

    if not wavelength_zone_id:
        return _response(400, {"error": "wavelength_zone_id required"}, headers)
    if relay_type not in RELAY_TYPES:
        return _response(400, {"error": f"relay_type must be one of {RELAY_TYPES}"}, headers)

    relay_id = str(uuid.uuid4())
    now = int(time.time())
    user_relay_sk = f"{wavelength_zone_id}#{relay_id}"

    config = body.get("config")
    if config is not None and not isinstance(config, dict):
        config = {}
    config = config or {}

    item = {
        "wavelength_zone_id": {"S": wavelength_zone_id},
        "relay_id": {"S": relay_id},
        "user_id": {"S": user_id},
        "user_relay_sk": {"S": user_relay_sk},
        "relay_type": {"S": relay_type},
        "name": {"S": name},
        "status": {"S": "offline"},
        "last_seen": {"N": str(now)},
        "created_at": {"N": str(now)},
        "updated_at": {"N": str(now)},
    }
    if config:
        item["config"] = {"S": json.dumps(config)}
    if body.get("auth_key_hash"):
        item["auth_key_hash"] = {"S": str(body["auth_key_hash"])}

    dynamodb = boto3.client("dynamodb")
    try:
        dynamodb.put_item(
            TableName=TABLE_NAME,
            Item=item,
            ConditionExpression="attribute_not_exists(relay_id)",
        )
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            _log("register_relay conflict, retrying", relay_id=relay_id)
            return _register_relay(user_id, body, headers)
        raise

    if USER_PROFILES_TABLE:
        _upsert_profile_add_relay(
            dynamodb,
            user_id,
            relay_id=relay_id,
            wavelength_zone_id=wavelength_zone_id,
            name=name,
            relay_type=relay_type,
            status="offline",
        )

    _log("relay registered", relay_id=relay_id, zone=wavelength_zone_id, relay_type=relay_type)
    return _response(
        200,
        {
            "relay_id": relay_id,
            "wavelength_zone_id": wavelength_zone_id,
            "name": name,
            "relay_type": relay_type,
            "status": "offline",
        },
        headers,
    )


def _list_relays(user_id: str, params: dict, headers: dict) -> dict:
    """GET /relays - List relays. Query: wavelength_zone_id (optional) for zone filter."""
    wavelength_zone_id = (params.get("wavelength_zone_id") or "").strip()
    dynamodb = boto3.client("dynamodb")

    if wavelength_zone_id:
        resp = dynamodb.query(
            TableName=TABLE_NAME,
            KeyConditionExpression="wavelength_zone_id = :zone",
            ExpressionAttributeValues={":zone": {"S": wavelength_zone_id}},
        )
    else:
        resp = dynamodb.query(
            TableName=TABLE_NAME,
            IndexName="UserRelayIndex",
            KeyConditionExpression="user_id = :uid",
            ExpressionAttributeValues={":uid": {"S": user_id}},
        )

    items = resp.get("Items", [])
    relays = []
    for item in items:
        relay = _item_to_relay(item)
        if not relay:
            continue
        if relay.get("user_id") != user_id:
            continue
        relays.append({k: v for k, v in relay.items() if k != "user_id"})

    return _response(200, {"relays": relays}, headers)


def _update_relay(user_id: str, body: dict, headers: dict) -> dict:
    """PATCH /relays - Update relay name or config."""
    relay_id = body.get("relay_id")
    wavelength_zone_id = body.get("wavelength_zone_id")

    if not relay_id or not wavelength_zone_id:
        return _response(400, {"error": "relay_id and wavelength_zone_id required"}, headers)

    dynamodb = boto3.client("dynamodb")
    try:
        resp = dynamodb.get_item(
            TableName=TABLE_NAME,
            Key={
                "wavelength_zone_id": {"S": wavelength_zone_id},
                "relay_id": {"S": relay_id},
            },
        )
    except ClientError:
        raise

    item = resp.get("Item")
    if not item:
        return _response(404, {"error": "Relay not found"}, headers)
    if item.get("user_id", {}).get("S") != user_id:
        return _response(403, {"error": "Forbidden"}, headers)

    now = int(time.time())
    updates = ["updated_at = :now"]
    values = {":now": {"N": str(now)}}

    if "name" in body:
        name = (body.get("name") or "").strip() or "relay"
        updates.append("name = :name")
        values[":name"] = {"S": name}
    if "config" in body:
        config = body["config"] if isinstance(body["config"], dict) else {}
        updates.append("config = :config")
        values[":config"] = {"S": json.dumps(config)}

    if len(updates) <= 1:
        return _response(200, {"message": "No updates"}, headers)

    try:
        dynamodb.update_item(
            TableName=TABLE_NAME,
            Key={
                "wavelength_zone_id": {"S": wavelength_zone_id},
                "relay_id": {"S": relay_id},
            },
            UpdateExpression="SET " + ", ".join(updates),
            ExpressionAttributeValues=values,
        )
    except ClientError:
        raise

    if USER_PROFILES_TABLE and "name" in body:
        _upsert_profile_update_relay(
            dynamodb,
            user_id,
            relay_id=relay_id,
            wavelength_zone_id=wavelength_zone_id,
            updates={"name": (body.get("name") or "").strip() or "relay"},
        )

    _log("relay updated", relay_id=relay_id)
    return _response(200, {"message": "Relay updated"}, headers)


def _delete_relay(user_id: str, body: dict, headers: dict) -> dict:
    """DELETE /relays - Unregister a relay."""
    relay_id = body.get("relay_id")
    wavelength_zone_id = body.get("wavelength_zone_id")

    if not relay_id or not wavelength_zone_id:
        return _response(400, {"error": "relay_id and wavelength_zone_id required"}, headers)

    dynamodb = boto3.client("dynamodb")
    try:
        dynamodb.delete_item(
            TableName=TABLE_NAME,
            Key={
                "wavelength_zone_id": {"S": wavelength_zone_id},
                "relay_id": {"S": relay_id},
            },
            ConditionExpression="user_id = :uid",
            ExpressionAttributeValues={":uid": {"S": user_id}},
        )
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return _response(404, {"error": "Relay not found"}, headers)
        raise

    if USER_PROFILES_TABLE:
        _upsert_profile_remove_relay(dynamodb, user_id, relay_id, wavelength_zone_id)

    _log("relay deleted", relay_id=relay_id)
    return _response(200, {"message": "Relay deleted"}, headers)


def _upsert_profile_add_relay(
    dynamodb, user_id: str, *, relay_id: str, wavelength_zone_id: str, name: str, relay_type: str, status: str
) -> None:
    """Add relay ref to user profile relays array."""
    try:
        resp = dynamodb.get_item(TableName=USER_PROFILES_TABLE, Key={"user_id": {"S": user_id}})
    except ClientError:
        return
    item = resp.get("Item")
    relays = []
    if item and "relays" in item:
        relays = _from_dynamo(item["relays"]) or []
    if not isinstance(relays, list):
        relays = []
    relays = [r for r in relays if not (isinstance(r, dict) and r.get("relay_id") == relay_id and r.get("wavelength_zone_id") == wavelength_zone_id)]
    relays.append({
        "relay_id": relay_id,
        "wavelength_zone_id": wavelength_zone_id,
        "name": name,
        "relay_type": relay_type,
        "status": status,
    })
    dynamodb.update_item(
        TableName=USER_PROFILES_TABLE,
        Key={"user_id": {"S": user_id}},
        UpdateExpression="SET relays = :r",
        ExpressionAttributeValues={":r": _to_dynamo(relays)},
    )


def _upsert_profile_remove_relay(dynamodb, user_id: str, relay_id: str, wavelength_zone_id: str) -> None:
    """Remove relay from user profile relays array."""
    try:
        resp = dynamodb.get_item(TableName=USER_PROFILES_TABLE, Key={"user_id": {"S": user_id}})
    except ClientError:
        return
    item = resp.get("Item")
    relays = []
    if item and "relays" in item:
        relays = _from_dynamo(item["relays"]) or []
    if not isinstance(relays, list):
        relays = []
    relays = [
        r for r in relays
        if not (isinstance(r, dict) and r.get("relay_id") == relay_id and r.get("wavelength_zone_id") == wavelength_zone_id)
    ]
    dynamodb.update_item(
        TableName=USER_PROFILES_TABLE,
        Key={"user_id": {"S": user_id}},
        UpdateExpression="SET relays = :r",
        ExpressionAttributeValues={":r": _to_dynamo(relays)},
    )


def _upsert_profile_update_relay(
    dynamodb, user_id: str, *, relay_id: str, wavelength_zone_id: str, updates: dict
) -> None:
    """Update relay in user profile (name, etc)."""
    if not updates:
        return
    try:
        resp = dynamodb.get_item(TableName=USER_PROFILES_TABLE, Key={"user_id": {"S": user_id}})
    except ClientError:
        return
    item = resp.get("Item")
    relays = []
    if item and "relays" in item:
        relays = _from_dynamo(item["relays"]) or []
    if not isinstance(relays, list):
        relays = []
    out = []
    for r in relays:
        if isinstance(r, dict) and r.get("relay_id") == relay_id and r.get("wavelength_zone_id") == wavelength_zone_id:
            r = {**r, **updates}
        out.append(r)
    dynamodb.update_item(
        TableName=USER_PROFILES_TABLE,
        Key={"user_id": {"S": user_id}},
        UpdateExpression="SET relays = :r",
        ExpressionAttributeValues={":r": _to_dynamo(out)},
    )


def _item_to_relay(item: dict) -> dict | None:
    relay_id = (item.get("relay_id") or {}).get("S")
    if not relay_id:
        return None
    config_raw = item.get("config", {}).get("S")
    config = json.loads(config_raw) if config_raw else {}
    return {
        "relay_id": relay_id,
        "wavelength_zone_id": (item.get("wavelength_zone_id") or {}).get("S"),
        "user_id": (item.get("user_id") or {}).get("S"),
        "relay_type": (item.get("relay_type") or {}).get("S") or "local",
        "name": (item.get("name") or {}).get("S") or "relay",
        "status": (item.get("status") or {}).get("S") or "offline",
        "last_seen": int((item.get("last_seen") or {}).get("N", "0") or "0"),
        "config": config,
        "created_at": int((item.get("created_at") or {}).get("N", "0") or "0"),
    }
