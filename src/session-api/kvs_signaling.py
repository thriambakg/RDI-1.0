"""AWS Kinesis Video Streams WebRTC signaling helpers for per-session channels."""

from __future__ import annotations

import json
import os
from typing import Any

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_REGION", "us-east-1")
KVS_WEBRTC_ROLE_ARN = os.environ.get("KVS_WEBRTC_ROLE_ARN", "")
DATA_PLANE = os.environ.get("DATA_PLANE", "webrtc").strip().lower()


def webrtc_enabled() -> bool:
    return DATA_PLANE == "webrtc" and bool(KVS_WEBRTC_ROLE_ARN)


def _kinesisvideo():
    return boto3.client("kinesisvideo", region_name=REGION)


def _sts():
    return boto3.client("sts", region_name=REGION)


def create_signaling_channel(session_id: str) -> dict[str, str]:
    """Create a SINGLE_MASTER signaling channel named after session_id."""
    kv = _kinesisvideo()
    try:
        resp = kv.create_signaling_channel(
            ChannelName=session_id,
            ChannelType="SINGLE_MASTER",
        )
    except ClientError as e:
        if e.response["Error"]["Code"] != "ResourceInUseException":
            raise
        desc = kv.describe_signaling_channel(ChannelName=session_id)
        resp = {"ChannelARN": desc["ChannelInfo"]["ChannelARN"]}
    arn = resp["ChannelARN"]
    return {"channel_arn": arn, "channel_name": session_id}


def delete_signaling_channel(channel_arn: str) -> None:
    if not channel_arn:
        return
    try:
        _kinesisvideo().delete_signaling_channel(ChannelARN=channel_arn)
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        if code not in ("ResourceNotFoundException", "NotFoundException"):
            raise


def _kinesisvideo_client(credentials: dict[str, str] | None = None):
    if credentials:
        return boto3.client(
            "kinesisvideo",
            region_name=REGION,
            aws_access_key_id=credentials["accessKeyId"],
            aws_secret_access_key=credentials["secretAccessKey"],
            aws_session_token=credentials.get("sessionToken"),
        )
    return boto3.client("kinesisvideo", region_name=REGION)


def get_signaling_endpoint(
    channel_arn: str, role: str, credentials: dict[str, str] | None = None
) -> str:
    """Return WSS URL for MASTER or VIEWER."""
    resp = _kinesisvideo_client(credentials).get_signaling_channel_endpoint(
        ChannelARN=channel_arn,
        SingleMasterChannelEndpointConfiguration={
            "Protocols": ["WSS"],
            "Role": role,
        },
    )
    endpoints = resp.get("ResourceEndpointList") or []
    for ep in endpoints:
        if ep.get("Protocol") == "WSS":
            return ep.get("ResourceEndpoint", "")
    if endpoints:
        return endpoints[0].get("ResourceEndpoint", "")
    return ""


def _session_credentials(channel_arn: str, role: str, session_id: str) -> dict[str, Any]:
    if not KVS_WEBRTC_ROLE_ARN:
        raise RuntimeError("KVS_WEBRTC_ROLE_ARN not configured")
    connect_action = (
        "kinesisvideo:ConnectAsViewer" if role == "VIEWER" else "kinesisvideo:ConnectAsMaster"
    )
    policy = {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Action": [
                    connect_action,
                    "kinesisvideo:GetSignalingChannelEndpoint",
                    "kinesisvideo:GetIceServerConfig",
                    "kinesisvideo:DescribeSignalingChannel",
                ],
                "Resource": channel_arn,
            }
        ],
    }
    assumed = _sts().assume_role(
        RoleArn=KVS_WEBRTC_ROLE_ARN,
        RoleSessionName=f"rdi-{role.lower()}-{session_id[:8]}",
        Policy=json.dumps(policy),
        DurationSeconds=3600,
    )
    creds = assumed["Credentials"]
    return {
        "accessKeyId": creds["AccessKeyId"],
        "secretAccessKey": creds["SecretAccessKey"],
        "sessionToken": creds["SessionToken"],
        "expiration": creds["Expiration"].isoformat(),
    }


def build_webrtc_viewer_bundle(session_id: str, channel_arn: str) -> dict[str, Any]:
    credentials = _session_credentials(channel_arn, "VIEWER", session_id)
    return {
        "transport": "webrtc",
        "channel_arn": channel_arn,
        "channel_name": session_id,
        "region": REGION,
        "role": "VIEWER",
        "signaling_endpoint": get_signaling_endpoint(channel_arn, "VIEWER", credentials),
        "credentials": credentials,
    }


def build_webrtc_master_bundle(session_id: str, channel_arn: str) -> dict[str, Any]:
    credentials = _session_credentials(channel_arn, "MASTER", session_id)
    return {
        "transport": "webrtc",
        "session_id": session_id,
        "channel_arn": channel_arn,
        "channel_name": session_id,
        "region": REGION,
        "role": "MASTER",
        "signaling_endpoint": get_signaling_endpoint(channel_arn, "MASTER", credentials),
        "credentials": credentials,
    }
