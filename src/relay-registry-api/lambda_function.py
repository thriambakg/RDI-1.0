"""
Relay Registry API - Register and manage relay devices per deployment region.
The DynamoDB partition key is still named wavelength_zone_id; values are AWS region ids (e.g. us-east-1).
Relays reach the API/proxy over the public internet (e.g. Starlink); this API registers them for the console.

Hardware claim flow (Path B):
  1. Device POST /relays/announce (no Cognito) -> claim_code + pending record in __unclaimed__ partition
  2. User POST /relays/claim (Cognito) -> moves relay to user's zone, same relay_id
  3. Device GET /relays/claim-status (no Cognito) -> pending | claimed + relay_id
"""

import hashlib
import json
import os
import secrets
import string
import time
import uuid
from typing import Any

import boto3
from botocore.exceptions import ClientError

from kvs_signaling import build_webrtc_master_bundle
from relay_active_sessions import parse_active_sessions


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
UNCLAIMED_ZONE = "__unclaimed__"
SYSTEM_USER_ID = "__system__"
CLAIM_CODE_CHARS = string.ascii_uppercase + string.digits
CLAIM_CODE_LENGTH = 8
CLAIM_TTL_SECONDS = 7 * 24 * 3600  # 7 days


def _log(msg: str, **kwargs: Any) -> None:
    extra = " ".join(f"{k}={v}" for k, v in kwargs.items())
    print(f"[RDI Relay Registry] {msg}" + (f" {extra}" if extra else ""))


def _response(status_code: int, body: dict, headers: dict) -> dict:
    return {
        "statusCode": status_code,
        "headers": headers,
        "body": json.dumps(body),
    }


def _cors_headers() -> dict:
    return {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Credentials": "true",
    }


def _get_user_id(event: dict) -> str | None:
    claims = event.get("requestContext", {}).get("authorizer", {}).get("claims", {})
    return claims.get("sub")


def _normalize_path(path: str) -> str:
    return (path or "").rstrip("/")


def _hash_secret(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def _generate_claim_code() -> str:
    return "".join(secrets.choice(CLAIM_CODE_CHARS) for _ in range(CLAIM_CODE_LENGTH))


def _generate_device_secret() -> str:
    return secrets.token_urlsafe(32)


def lambda_handler(event: dict, context: Any) -> dict:
    http_method = event.get("httpMethod", "GET")
    path = _normalize_path(event.get("path", ""))
    headers = _cors_headers()

    try:
        # Device endpoints — no Cognito (authenticated via device_serial + device_secret)
        if path.endswith("/announce") and http_method == "POST":
            body = json.loads(event.get("body") or "{}")
            return _device_announce(body, headers)

        if path.endswith("/claim-status") and http_method == "GET":
            params = event.get("queryStringParameters") or {}
            return _device_claim_status(params, headers)

        if path.endswith("/webrtc-master") and http_method == "GET":
            params = event.get("queryStringParameters") or {}
            return _device_webrtc_master(params, headers)

        if path.endswith("/active-sessions") and http_method == "GET":
            params = event.get("queryStringParameters") or {}
            return _device_active_sessions(params, headers)

        user_id = _get_user_id(event)
        if not user_id:
            _log("auth failed", reason="no user_id from claims", path=path)
            return _response(401, {"error": "Unauthorized"}, headers)

        if "relays" not in path:
            return _response(404, {"error": "Not found"}, headers)

        if path.endswith("/claim") and http_method == "POST":
            body = json.loads(event.get("body") or "{}")
            return _claim_relay(user_id, body, headers)

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


def _query_by_device_serial(dynamodb, device_serial: str) -> dict | None:
    resp = dynamodb.query(
        TableName=TABLE_NAME,
        IndexName="DeviceSerialIndex",
        KeyConditionExpression="device_serial = :ds",
        ExpressionAttributeValues={":ds": {"S": device_serial}},
        Limit=5,
    )
    for item in resp.get("Items", []):
        zone = (item.get("wavelength_zone_id") or {}).get("S")
        status = (item.get("claim_status") or {}).get("S")
        if zone == UNCLAIMED_ZONE and status == "pending":
            return item
    return None


def _query_by_claim_code(dynamodb, claim_code: str) -> dict | None:
    resp = dynamodb.query(
        TableName=TABLE_NAME,
        IndexName="ClaimCodeIndex",
        KeyConditionExpression="claim_code = :cc",
        ExpressionAttributeValues={":cc": {"S": claim_code}},
        Limit=1,
    )
    items = resp.get("Items", [])
    return items[0] if items else None


def _is_claim_expired(item: dict) -> bool:
    expires = int((item.get("claim_expires_at") or {}).get("N", "0") or "0")
    return expires > 0 and int(time.time()) > expires


def _device_announce(body: dict, headers: dict) -> dict:
    """POST /relays/announce — device requests or refreshes a pairing claim code."""
    device_serial = (body.get("device_serial") or "").strip().lower()
    device_secret = (body.get("device_secret") or "").strip()

    if not device_serial or len(device_serial) < 6 or len(device_serial) > 64:
        return _response(400, {"error": "device_serial required (6-64 chars)"}, headers)

    dynamodb = boto3.client("dynamodb")
    now = int(time.time())

    existing = _query_by_device_serial(dynamodb, device_serial)
    if existing:
        if _is_claim_expired(existing):
            relay_id = (existing.get("relay_id") or {}).get("S")
            try:
                dynamodb.delete_item(
                    TableName=TABLE_NAME,
                    Key={
                        "wavelength_zone_id": {"S": UNCLAIMED_ZONE},
                        "relay_id": {"S": relay_id},
                    },
                )
            except ClientError:
                pass
            existing = None
        else:
            stored_hash = (existing.get("device_secret_hash") or {}).get("S", "")
            if device_secret:
                if _hash_secret(device_secret) != stored_hash:
                    return _response(403, {"error": "Invalid device_secret"}, headers)
            else:
                return _response(400, {"error": "device_secret required for re-announce"}, headers)
            claim_code = (existing.get("claim_code") or {}).get("S", "")
            expires_at = int((existing.get("claim_expires_at") or {}).get("N", "0") or "0")
            dynamodb.update_item(
                TableName=TABLE_NAME,
                Key={
                    "wavelength_zone_id": {"S": UNCLAIMED_ZONE},
                    "relay_id": {"S": (existing.get("relay_id") or {}).get("S")},
                },
                UpdateExpression="SET last_seen = :now, updated_at = :now",
                ExpressionAttributeValues={":now": {"N": str(now)}},
            )
            _log("device re-announced", device_serial=device_serial, claim_code=claim_code)
            return _response(
                200,
                {
                    "status": "pending",
                    "claim_code": claim_code,
                    "expires_at": expires_at,
                    "message": "Enter this code in the RDI console to claim this relay",
                },
                headers,
            )

    if not device_secret:
        device_secret = _generate_device_secret()

    relay_id = str(uuid.uuid4())
    claim_code = _generate_claim_code()
    expires_at = now + CLAIM_TTL_SECONDS

    # Ensure claim code uniqueness (rare collision)
    for _ in range(5):
        if not _query_by_claim_code(dynamodb, claim_code):
            break
        claim_code = _generate_claim_code()

    item = {
        "wavelength_zone_id": {"S": UNCLAIMED_ZONE},
        "relay_id": {"S": relay_id},
        "user_id": {"S": SYSTEM_USER_ID},
        "user_relay_sk": {"S": f"{UNCLAIMED_ZONE}#{relay_id}"},
        "relay_type": {"S": "sim_relay"},
        "name": {"S": "Unclaimed device"},
        "status": {"S": "offline"},
        "claim_status": {"S": "pending"},
        "claim_code": {"S": claim_code},
        "device_serial": {"S": device_serial},
        "device_secret_hash": {"S": _hash_secret(device_secret)},
        "claim_expires_at": {"N": str(expires_at)},
        "last_seen": {"N": str(now)},
        "created_at": {"N": str(now)},
        "updated_at": {"N": str(now)},
    }

    dynamodb.put_item(TableName=TABLE_NAME, Item=item)
    _log("device announced", device_serial=device_serial, relay_id=relay_id, claim_code=claim_code)

    return _response(
        200,
        {
            "status": "pending",
            "claim_code": claim_code,
            "device_secret": device_secret,
            "expires_at": expires_at,
            "message": "Save device_secret locally. Enter claim_code in the RDI console.",
        },
        headers,
    )


def _device_claim_status(params: dict, headers: dict) -> dict:
    """GET /relays/claim-status — device polls until claimed."""
    device_serial = (params.get("device_serial") or "").strip().lower()
    device_secret = (params.get("device_secret") or "").strip()

    if not device_serial or not device_secret:
        return _response(400, {"error": "device_serial and device_secret required"}, headers)

    dynamodb = boto3.client("dynamodb")
    pending = _query_by_device_serial(dynamodb, device_serial)

    if pending:
        if _hash_secret(device_secret) != (pending.get("device_secret_hash") or {}).get("S", ""):
            return _response(403, {"error": "Invalid device_secret"}, headers)
        if _is_claim_expired(pending):
            return _response(410, {"error": "Claim code expired; re-announce device"}, headers)
        claim_code = (pending.get("claim_code") or {}).get("S", "")
        expires_at = int((pending.get("claim_expires_at") or {}).get("N", "0") or "0")
        return _response(
            200,
            {"status": "pending", "claim_code": claim_code, "expires_at": expires_at},
            headers,
        )

    # Not pending — check if device was claimed (scan user relays by device_serial on claimed items)
    resp = dynamodb.query(
        TableName=TABLE_NAME,
        IndexName="DeviceSerialIndex",
        KeyConditionExpression="device_serial = :ds",
        ExpressionAttributeValues={":ds": {"S": device_serial}},
        Limit=10,
    )
    for item in resp.get("Items", []):
        if (item.get("claim_status") or {}).get("S") != "claimed":
            continue
        if _hash_secret(device_secret) != (item.get("device_secret_hash") or {}).get("S", ""):
            continue
        relay_id = (item.get("relay_id") or {}).get("S")
        zone = (item.get("wavelength_zone_id") or {}).get("S")
        name = (item.get("name") or {}).get("S", "relay")
        relay_type = (item.get("relay_type") or {}).get("S", "sim_relay")
        _log("device claim status: claimed", device_serial=device_serial, relay_id=relay_id)
        return _response(
            200,
            {
                "status": "claimed",
                "relay_id": relay_id,
                "wavelength_zone_id": zone,
                "name": name,
                "relay_type": relay_type,
            },
            headers,
        )

    return _response(404, {"error": "Device not found; run announce first"}, headers)


def _authenticate_claimed_device(
    dynamodb, device_serial: str, device_secret: str
) -> dict | None:
    """Return relay-registry item for a claimed device, or None."""
    resp = dynamodb.query(
        TableName=TABLE_NAME,
        IndexName="DeviceSerialIndex",
        KeyConditionExpression="device_serial = :ds",
        ExpressionAttributeValues={":ds": {"S": device_serial}},
        Limit=10,
    )
    for item in resp.get("Items", []):
        if (item.get("claim_status") or {}).get("S") != "claimed":
            continue
        if _hash_secret(device_secret) != (item.get("device_secret_hash") or {}).get("S", ""):
            continue
        return item
    return None


def _device_active_sessions(params: dict, headers: dict) -> dict:
    """GET /relays/active-sessions — Pi lists all active WebRTC sessions for this relay."""
    device_serial = (params.get("device_serial") or "").strip().lower()
    device_secret = (params.get("device_secret") or "").strip()

    if not device_serial or not device_secret:
        return _response(400, {"error": "device_serial and device_secret required"}, headers)

    dynamodb = boto3.client("dynamodb")
    relay_item = _authenticate_claimed_device(dynamodb, device_serial, device_secret)
    if not relay_item:
        return _response(404, {"error": "Device not found or invalid secret"}, headers)

    relay_id = (relay_item.get("relay_id") or {}).get("S", "")
    zone = (relay_item.get("wavelength_zone_id") or {}).get("S", "")
    entries = parse_active_sessions(relay_item)
    if not entries:
        return _response(
            200,
            {
                "relay_id": relay_id,
                "wavelength_zone_id": zone,
                "sessions": [],
                "status": "no_active_sessions",
            },
            headers,
        )

    sessions_out = []
    creds_errors: list[str] = []
    for entry in entries:
        session_id = entry.get("session_id", "")
        channel_arn = entry.get("signaling_channel_arn", "")
        if not session_id or not channel_arn:
            creds_errors.append(
                f"{session_id or 'unknown'}: missing session_id or signaling_channel_arn"
            )
            continue
        try:
            master = build_webrtc_master_bundle(session_id, channel_arn)
        except Exception as e:
            _log("active-sessions creds failed", session_id=session_id, error=str(e))
            creds_errors.append(f"{session_id}: {e}")
            continue
        sessions_out.append(
            {
                "session_id": session_id,
                "drone_id": entry.get("drone_id", ""),
                "mavlink_port": entry.get("mavlink_port"),
                "mavlink_host": entry.get("mavlink_host") or "127.0.0.1",
                "webrtc": master,
            }
        )

    payload = {
        "relay_id": relay_id,
        "wavelength_zone_id": zone,
        "sessions": sessions_out,
        "status": "ok" if sessions_out else ("creds_error" if creds_errors else "ok"),
    }
    if creds_errors and not sessions_out:
        payload["errors"] = creds_errors[:5]
    return _response(200, payload, headers)


def _device_webrtc_master(params: dict, headers: dict) -> dict:
    """GET /relays/webrtc-master — legacy: MASTER creds for first active session only."""
    device_serial = (params.get("device_serial") or "").strip().lower()
    device_secret = (params.get("device_secret") or "").strip()

    if not device_serial or not device_secret:
        return _response(400, {"error": "device_serial and device_secret required"}, headers)

    dynamodb = boto3.client("dynamodb")
    relay_item = _authenticate_claimed_device(dynamodb, device_serial, device_secret)
    if not relay_item:
        return _response(404, {"error": "Device not found or invalid secret"}, headers)

    entries = parse_active_sessions(relay_item)
    if not entries:
        return _response(200, {"status": "no_active_session"}, headers)

    entry = entries[0]
    session_id = entry.get("session_id", "")
    channel_arn = entry.get("signaling_channel_arn", "")
    if not session_id or not channel_arn:
        return _response(200, {"status": "no_active_session"}, headers)

    try:
        master = build_webrtc_master_bundle(session_id, channel_arn)
    except Exception as e:
        _log("webrtc-master creds failed", session_id=session_id, error=str(e))
        return _response(500, {"error": str(e)}, headers)

    master["drone_id"] = entry.get("drone_id", "")
    master["mavlink_port"] = entry.get("mavlink_port")
    master["mavlink_host"] = entry.get("mavlink_host") or "127.0.0.1"
    return _response(200, master, headers)


def _claim_relay(user_id: str, body: dict, headers: dict) -> dict:
    """POST /relays/claim — user claims a pending device by pairing code."""
    claim_code = (body.get("claim_code") or "").strip().upper()
    name = (body.get("name") or "").strip() or "relay"
    wavelength_zone_id = (body.get("wavelength_zone_id") or "").strip()
    relay_type = (body.get("relay_type") or "sim_relay").strip().lower()

    if not claim_code or len(claim_code) != CLAIM_CODE_LENGTH:
        return _response(400, {"error": f"claim_code required ({CLAIM_CODE_LENGTH} characters)"}, headers)
    if not wavelength_zone_id:
        return _response(400, {"error": "wavelength_zone_id required"}, headers)
    if relay_type not in RELAY_TYPES:
        return _response(400, {"error": f"relay_type must be one of {RELAY_TYPES}"}, headers)

    dynamodb = boto3.client("dynamodb")
    pending = _query_by_claim_code(dynamodb, claim_code)

    if not pending:
        return _response(404, {"error": "Invalid or expired claim code"}, headers)
    if (pending.get("wavelength_zone_id") or {}).get("S") != UNCLAIMED_ZONE:
        return _response(404, {"error": "Invalid or expired claim code"}, headers)
    if (pending.get("claim_status") or {}).get("S") != "pending":
        return _response(409, {"error": "Claim code already used"}, headers)
    if _is_claim_expired(pending):
        return _response(410, {"error": "Claim code expired"}, headers)

    relay_id = (pending.get("relay_id") or {}).get("S")
    device_serial = (pending.get("device_serial") or {}).get("S", "")
    device_secret_hash = (pending.get("device_secret_hash") or {}).get("S", "")
    now = int(time.time())
    user_relay_sk = f"{wavelength_zone_id}#{relay_id}"

    config = body.get("config")
    if config is not None and not isinstance(config, dict):
        config = {}
    config = config or {}

    claimed_item = {
        "wavelength_zone_id": {"S": wavelength_zone_id},
        "relay_id": {"S": relay_id},
        "user_id": {"S": user_id},
        "user_relay_sk": {"S": user_relay_sk},
        "relay_type": {"S": relay_type},
        "name": {"S": name},
        "status": {"S": "offline"},
        "claim_status": {"S": "claimed"},
        "device_serial": {"S": device_serial},
        "device_secret_hash": {"S": device_secret_hash},
        "claimed_at": {"N": str(now)},
        "last_seen": {"N": str(now)},
        "created_at": pending.get("created_at") or {"N": str(now)},
        "updated_at": {"N": str(now)},
    }
    if config:
        claimed_item["config"] = {"S": json.dumps(config)}

    try:
        dynamodb.delete_item(
            TableName=TABLE_NAME,
            Key={
                "wavelength_zone_id": {"S": UNCLAIMED_ZONE},
                "relay_id": {"S": relay_id},
            },
            ConditionExpression="claim_status = :pending",
            ExpressionAttributeValues={":pending": {"S": "pending"}},
        )
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return _response(409, {"error": "Claim code already used"}, headers)
        raise

    dynamodb.put_item(TableName=TABLE_NAME, Item=claimed_item)

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

    _log("relay claimed", relay_id=relay_id, user_id=user_id, claim_code=claim_code)
    return _response(
        200,
        {
            "relay_id": relay_id,
            "wavelength_zone_id": wavelength_zone_id,
            "name": name,
            "relay_type": relay_type,
            "status": "offline",
            "claim_status": "claimed",
        },
        headers,
    )


def _register_relay(user_id: str, body: dict, headers: dict) -> dict:
    """POST /relays - Register a new relay for a deployment region (wavelength_zone_id = AWS region id)."""
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
    """GET /relays - List relays. Query: wavelength_zone_id (optional) region filter."""
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
        if relay.get("claim_status") == "pending":
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
    names = {}

    if "name" in body:
        name = (body.get("name") or "").strip() or "relay"
        updates.append("#name = :name")
        values[":name"] = {"S": name}
        names["#name"] = "name"
    if "config" in body:
        config = body["config"] if isinstance(body["config"], dict) else {}
        updates.append("config = :config")
        values[":config"] = {"S": json.dumps(config)}
    if "status" in body:
        status = (body.get("status") or "").strip().lower()
        if status in ("online", "idle", "offline"):
            updates.append("#status = :status")
            values[":status"] = {"S": status}
            names["#status"] = "status"
            updates.append("last_seen = :now")

    if len(updates) <= 1:
        return _response(200, {"message": "No updates"}, headers)

    kwargs = {
        "TableName": TABLE_NAME,
        "Key": {
            "wavelength_zone_id": {"S": wavelength_zone_id},
            "relay_id": {"S": relay_id},
        },
        "UpdateExpression": "SET " + ", ".join(updates),
        "ExpressionAttributeValues": values,
    }
    if names:
        kwargs["ExpressionAttributeNames"] = names
    try:
        dynamodb.update_item(**kwargs)
    except ClientError:
        raise

    if USER_PROFILES_TABLE:
        profile_updates = {}
        if "name" in body:
            profile_updates["name"] = (body.get("name") or "").strip() or "relay"
        if "status" in body:
            status = (body.get("status") or "").strip().lower()
            if status in ("online", "idle", "offline"):
                profile_updates["status"] = status
        if profile_updates:
            _upsert_profile_update_relay(
                dynamodb,
                user_id,
                relay_id=relay_id,
                wavelength_zone_id=wavelength_zone_id,
                updates=profile_updates,
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
    out = {
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
    claim_status = (item.get("claim_status") or {}).get("S")
    if claim_status:
        out["claim_status"] = claim_status
    return out
