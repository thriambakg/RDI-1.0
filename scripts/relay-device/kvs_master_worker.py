#!/usr/bin/env python3
"""
Per-session KVS WebRTC MASTER worker (data channel only).

Spawned by rdi-relay-daemon with RDI_WORKER_CONFIG JSON env var.
Waits for a browser Viewer SDP offer via KVS signaling, then bridges the
mavlink data channel (Step 3 will forward bytes to UDP serial).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from base64 import b64decode, b64encode

import boto3
import websockets
from aiortc import RTCConfiguration, RTCIceServer, RTCPeerConnection, RTCSessionDescription
from aiortc.sdp import candidate_from_sdp
from botocore.auth import SigV4QueryAuth
from botocore.awsrequest import AWSRequest
from botocore.credentials import Credentials

LOG = logging.getLogger("rdi.kvs_master")

PING_BYTES = b"PING"
PONG_BYTES = b"PONG"


def _load_config() -> dict:
    raw = os.environ.get("RDI_WORKER_CONFIG", "")
    if not raw:
        raise RuntimeError("RDI_WORKER_CONFIG not set")
    return json.loads(raw)


def _signed_wss_url(endpoint_wss: str, channel_arn: str, region: str, credentials: dict, client_id: str) -> str:
    creds = Credentials(
        access_key=credentials["accessKeyId"],
        secret_key=credentials["secretAccessKey"],
        token=credentials.get("sessionToken"),
    )
    signer = SigV4QueryAuth(creds, "kinesisvideo", region, 299)
    request = AWSRequest(
        method="GET",
        url=endpoint_wss,
        params={"X-Amz-ChannelARN": channel_arn, "X-Amz-ClientId": client_id},
    )
    signer.add_auth(request)
    return request.prepare().url


def _decode_msg(msg: str) -> tuple[str, dict, str]:
    try:
        data = json.loads(msg)
        payload = json.loads(b64decode(data["messagePayload"].encode("ascii")).decode("ascii"))
        return data.get("messageType", ""), payload, data.get("senderClientId", "")
    except (json.JSONDecodeError, KeyError, ValueError):
        return "", {}, ""


def _encode_msg(action: str, payload, client_id: str) -> str:
    body = {"sdp": payload.sdp, "type": payload.type} if hasattr(payload, "sdp") else payload
    return json.dumps(
        {
            "action": action,
            "messagePayload": b64encode(json.dumps(body).encode("ascii")).decode("ascii"),
            "recipientClientId": client_id,
        }
    )


def _ice_servers(channel_arn: str, https_endpoint: str, region: str, credentials: dict) -> list[RTCIceServer]:
    kv_sig = boto3.client(
        "kinesis-video-signaling",
        endpoint_url=https_endpoint,
        region_name=region,
        aws_access_key_id=credentials["accessKeyId"],
        aws_secret_access_key=credentials["secretAccessKey"],
        aws_session_token=credentials.get("sessionToken"),
    )
    ice_cfg = kv_sig.get_ice_server_config(ChannelARN=channel_arn, ClientId="MASTER")
    servers = [RTCIceServer(urls=f"stun:stun.kinesisvideo.{region}.amazonaws.com:443")]
    for entry in ice_cfg.get("IceServerList", []):
        servers.append(
            RTCIceServer(
                urls=entry["Uris"],
                username=entry.get("Username"),
                credential=entry.get("Password"),
            )
        )
    return servers


async def run_master(cfg: dict) -> None:
    session_id = cfg["session_id"]
    webrtc = cfg["webrtc"]
    channel_arn = webrtc["channel_arn"]
    region = webrtc["region"]
    credentials = webrtc["credentials"]
    mavlink_host = cfg.get("mavlink_host") or "127.0.0.1"
    mavlink_port = int(cfg.get("mavlink_port") or 18570)

    kv = boto3.client(
        "kinesisvideo",
        region_name=region,
        aws_access_key_id=credentials["accessKeyId"],
        aws_secret_access_key=credentials["secretAccessKey"],
        aws_session_token=credentials.get("sessionToken"),
    )
    endpoints = kv.get_signaling_channel_endpoint(
        ChannelARN=channel_arn,
        SingleMasterChannelEndpointConfiguration={"Protocols": ["HTTPS", "WSS"], "Role": "MASTER"},
    )
    endpoint_https = next(
        o["ResourceEndpoint"] for o in endpoints["ResourceEndpointList"] if o["Protocol"] == "HTTPS"
    )
    endpoint_wss = webrtc.get("signaling_endpoint") or next(
        o["ResourceEndpoint"] for o in endpoints["ResourceEndpointList"] if o["Protocol"] == "WSS"
    )

    LOG.info(
        "worker start session_id=%s mavlink=%s:%s channel=%s",
        session_id,
        mavlink_host,
        mavlink_port,
        channel_arn,
    )

    pc_by_client: dict[str, RTCPeerConnection] = {}

    while True:
        wss_url = _signed_wss_url(endpoint_wss, channel_arn, region, credentials, "MASTER")
        try:
            async with websockets.connect(wss_url, ping_interval=20, ping_timeout=20) as ws:
                LOG.info("KVS signaling connected session_id=%s", session_id)
                async for message in ws:
                    msg_type, payload, client_id = _decode_msg(message)
                    if msg_type == "SDP_OFFER" and client_id:
                        ice = _ice_servers(channel_arn, endpoint_https, region, credentials)
                        pc = RTCPeerConnection(configuration=RTCConfiguration(iceServers=ice))
                        pc_by_client[client_id] = pc
                        channel = pc.createDataChannel("mavlink", ordered=False, maxRetransmits=0)

                        @channel.on("open")
                        def on_open(ch=channel) -> None:
                            LOG.info("data channel open session_id=%s viewer=%s", session_id, client_id)

                        @channel.on("message")
                        def on_message(message, ch=channel) -> None:
                            if isinstance(message, bytes):
                                if message == PING_BYTES:
                                    ch.send(PONG_BYTES)
                                    LOG.info(
                                        "ping pong session_id=%s viewer=%s",
                                        session_id,
                                        client_id,
                                    )
                                    return
                                LOG.debug("datachannel rx %d bytes", len(message))
                            else:
                                LOG.debug("datachannel rx %s", message)

                        @pc.on("icecandidate")
                        async def on_ice(candidate, cid=client_id, sock=ws) -> None:
                            if candidate is None:
                                return
                            payload = {
                                "candidate": candidate.candidate,
                                "sdpMid": candidate.sdpMid,
                                "sdpMLineIndex": candidate.sdpMLineIndex,
                            }
                            await sock.send(_encode_msg("ICE_CANDIDATE", payload, cid))

                        @pc.on("connectionstatechange")
                        async def on_state_change(c=pc, cid=client_id) -> None:
                            LOG.info(
                                "peer connection state session_id=%s viewer=%s state=%s",
                                session_id,
                                cid,
                                c.connectionState,
                            )

                        await pc.setRemoteDescription(
                            RTCSessionDescription(sdp=payload["sdp"], type=payload["type"])
                        )
                        answer = await pc.createAnswer()
                        await pc.setLocalDescription(answer)
                        await ws.send(_encode_msg("SDP_ANSWER", pc.localDescription, client_id))
                    elif msg_type == "ICE_CANDIDATE" and client_id in pc_by_client:
                        candidate = candidate_from_sdp(payload["candidate"])
                        candidate.sdpMid = payload.get("sdpMid")
                        candidate.sdpMLineIndex = payload.get("sdpMLineIndex")
                        await pc_by_client[client_id].addIceCandidate(candidate)
        except websockets.ConnectionClosed:
            LOG.warning("KVS signaling closed; reconnecting session_id=%s", session_id)
            await asyncio.sleep(2)
        except Exception as e:
            LOG.error("signaling error session_id=%s: %s", session_id, e)
            await asyncio.sleep(5)


def main() -> None:
    logging.basicConfig(
        level=os.environ.get("RDI_LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        stream=sys.stdout,
    )
    cfg = _load_config()
    asyncio.run(run_master(cfg))


if __name__ == "__main__":
    main()
