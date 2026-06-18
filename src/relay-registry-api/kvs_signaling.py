"""Shared KVS WebRTC credential helper (device master role). Mirrors session-api/kvs_signaling.py."""

from __future__ import annotations

import json
import os
from typing import Any

import boto3

REGION = os.environ.get("AWS_REGION", "us-east-1")
KVS_WEBRTC_ROLE_ARN = os.environ.get("KVS_WEBRTC_ROLE_ARN", "")


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


def _sts():
    return boto3.client("sts", region_name=REGION)


def get_signaling_endpoint(
    channel_arn: str, role: str, credentials: dict[str, str] | None = None
) -> str:
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


def build_webrtc_master_bundle(session_id: str, channel_arn: str) -> dict[str, Any]:
    if not KVS_WEBRTC_ROLE_ARN:
        raise RuntimeError("KVS_WEBRTC_ROLE_ARN not configured")
    policy = {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Action": [
                    "kinesisvideo:ConnectAsMaster",
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
        RoleSessionName=f"rdi-master-{session_id[:8]}",
        Policy=json.dumps(policy),
        DurationSeconds=3600,
    )
    creds = assumed["Credentials"]
    cred_dict = {
        "accessKeyId": creds["AccessKeyId"],
        "secretAccessKey": creds["SecretAccessKey"],
        "sessionToken": creds["SessionToken"],
        "expiration": creds["Expiration"].isoformat(),
    }
    return {
        "transport": "webrtc",
        "session_id": session_id,
        "channel_arn": channel_arn,
        "channel_name": session_id,
        "region": REGION,
        "role": "MASTER",
        "signaling_endpoint": get_signaling_endpoint(channel_arn, "MASTER", cred_dict),
        "credentials": cred_dict,
    }
