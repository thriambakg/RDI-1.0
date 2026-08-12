#!/usr/bin/env python3
"""
Per-session KVS WebRTC MASTER worker (data channel only).

Spawned by rdi-relay-daemon with RDI_WORKER_CONFIG JSON env var.
Waits for a browser Viewer SDP offer via KVS signaling, then bridges the
mavlink data channel (Step 3 will forward bytes to UDP serial).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import sys
import time
from base64 import b64decode, b64encode

import boto3
import websockets
from aiortc import RTCConfiguration, RTCIceServer, RTCPeerConnection, RTCSessionDescription
from aiortc.sdp import candidate_from_sdp
from botocore.auth import SigV4QueryAuth
from botocore.awsrequest import AWSRequest
from botocore.credentials import Credentials

from radio_hop_protocol import format_hops
from radio_mavlink_bridge import RadioMavlinkBridge
from radio_router_client import RadioRouterClient, router_client_from_env
from radio_serial_bridge import RadioSerialBridge

LOG = logging.getLogger("rdi.kvs_master")

PING_BYTES = b"PING"
PING_RADIO_BYTES = b"PINGR"
CTRL_PREFIX = b"CTRL"
# Exit so rdi-relay-daemon can respawn with fresh STS creds from active-sessions.
SIGNALING_AUTH_EXIT_CODE = 2
SIGNALING_AUTH_MAX_RETRIES = int(os.environ.get("RDI_SIGNALING_AUTH_MAX_RETRIES", "3"))
PONG_BYTES = b"PONG"
# Optional radio round-trip. Prefer daemon-owned router (RDI_RADIO_USE_ROUTER=1).
# Modes for dedicated_serial lab fallback:
#   mavlink — TELEM2 /dev/serial0 → PX4 → TELEM1 radio
#   raw     — direct serial JSON (second FTDI / USB lab path)
RADIO_USE_ROUTER = os.environ.get("RDI_RADIO_USE_ROUTER", "").strip() in ("1", "true", "yes")
RADIO_PORT = os.environ.get("RDI_RADIO_PORT", "").strip()
RADIO_MODE = os.environ.get("RDI_RADIO_MODE", "mavlink").strip().lower() or "mavlink"
_DEFAULT_BAUD = "921600" if RADIO_MODE == "mavlink" else "57600"
RADIO_BAUD = int(os.environ.get("RDI_RADIO_BAUD", _DEFAULT_BAUD))
RADIO_TIMEOUT_SEC = float(os.environ.get("RDI_RADIO_TIMEOUT_SEC", "8" if RADIO_MODE == "mavlink" else "5"))


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
    if hasattr(payload, "sdp"):
        body = {"sdp": payload.sdp, "type": payload.type}
    else:
        body = payload
    return json.dumps(
        {
            "action": action,
            "messagePayload": b64encode(json.dumps(body).encode("ascii")).decode("ascii"),
            "recipientClientId": client_id,
        }
    )


def _datachannel_attrs(sdp: str) -> dict[str, str]:
    attrs: dict[str, str] = {}
    for raw in sdp.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = raw.strip()
        if line.startswith("a=sctp-port:"):
            attrs["sctp_port"] = line.split(":", 1)[1]
        elif line.startswith("a=max-message-size:"):
            attrs["max_message_size"] = line.split(":", 1)[1]
    return attrs


def _normalize_answer_sdp(answer_sdp: str, offer_sdp: str) -> str:
    """Drop session-level a=setup (Chrome rejects); keep aiortc media-level role for DTLS."""
    offer_attrs = _datachannel_attrs(offer_sdp)
    lines_out: list[str] = []
    in_media = False
    has_sctp_port = False
    has_max_msg = False
    for raw in answer_sdp.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = raw.strip()
        if not line:
            continue
        if line.startswith("m="):
            in_media = True
            lines_out.append(line)
            continue
        if line.startswith("a=setup:") and not in_media:
            continue
        if line.startswith("a=sctp-port:"):
            has_sctp_port = True
            if offer_attrs.get("sctp_port"):
                line = f"a=sctp-port:{offer_attrs['sctp_port']}"
        elif line.startswith("a=max-message-size:"):
            has_max_msg = True
            if offer_attrs.get("max_message_size"):
                line = f"a=max-message-size:{offer_attrs['max_message_size']}"
        lines_out.append(line)
    if in_media and offer_attrs.get("sctp_port") and not has_sctp_port:
        lines_out.append(f"a=sctp-port:{offer_attrs['sctp_port']}")
    if in_media and offer_attrs.get("max_message_size") and not has_max_msg:
        lines_out.append(f"a=max-message-size:{offer_attrs['max_message_size']}")
    return "\r\n".join(lines_out) + "\r\n"


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
    link_mode = str(cfg.get("link_mode") or "shared_serial").strip().lower() or "shared_serial"
    vehicle_stack = str(cfg.get("vehicle_stack") or "px4").strip().lower() or "px4"
    mavlink_sysid = cfg.get("mavlink_sysid")
    try:
        target_sysid = int(mavlink_sysid) if mavlink_sysid is not None else None
    except (TypeError, ValueError):
        target_sysid = None
    dedicated_device = str(cfg.get("radio_device") or "").strip()
    try:
        dedicated_baud = int(cfg.get("radio_baud") or RADIO_BAUD)
    except (TypeError, ValueError):
        dedicated_baud = RADIO_BAUD

    def _pipe_for_path(path: str) -> str:
        if path != "radio":
            return "webrtc_relay"
        if link_mode == "dedicated_serial" and RADIO_MODE == "raw":
            return "radio_raw"
        return "radio_mavlink"

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
        "worker start session_id=%s mavlink=%s:%s channel=%s link_mode=%s stack=%s sysid=%s radio=%s",
        session_id,
        mavlink_host,
        mavlink_port,
        channel_arn,
        link_mode,
        vehicle_stack,
        target_sysid,
        "router" if RADIO_USE_ROUTER else (dedicated_device or RADIO_PORT or "off"),
    )

    pc_by_client: dict[str, RTCPeerConnection] = {}
    pending_ice: dict[str, list[dict]] = {}
    loop = asyncio.get_running_loop()
    radio: RadioSerialBridge | RadioMavlinkBridge | RadioRouterClient | None = None

    if link_mode == "none":
        LOG.info("link_mode=none — radio ping disabled for session_id=%s", session_id)
    elif link_mode == "dedicated_serial" and dedicated_device:
        if RADIO_MODE == "raw":
            radio = RadioSerialBridge(dedicated_device, dedicated_baud, RADIO_TIMEOUT_SEC)
        else:
            radio = RadioMavlinkBridge(dedicated_device, dedicated_baud, RADIO_TIMEOUT_SEC)
        try:
            radio.start(loop)
        except Exception as e:
            LOG.error("dedicated radio failed %s: %s", dedicated_device, e)
            radio = None
    elif link_mode in ("shared_serial", "udp_mavlink") or RADIO_USE_ROUTER:
        # udp_mavlink still allows shared radio hop when router is up (HITL may use both).
        if link_mode == "udp_mavlink" and not RADIO_USE_ROUTER and not RADIO_PORT:
            LOG.info("link_mode=udp_mavlink without radio — local ping only")
        elif RADIO_USE_ROUTER or not RADIO_PORT:
            client = router_client_from_env(RADIO_TIMEOUT_SEC)
            await client.start()
            radio = client if client.enabled else None
        elif RADIO_PORT:
            # Legacy fallback if worker still has RDI_RADIO_PORT (should be rare).
            if RADIO_MODE == "raw":
                radio = RadioSerialBridge(RADIO_PORT, RADIO_BAUD, RADIO_TIMEOUT_SEC)
            else:
                radio = RadioMavlinkBridge(RADIO_PORT, RADIO_BAUD, RADIO_TIMEOUT_SEC)
            try:
                radio.start(loop)
            except Exception as e:
                LOG.error("radio bridge failed to open %s: %s", RADIO_PORT, e)
                radio = None

    async def _handle_ping(channel, cid: str, *, radio_path: bool) -> None:
        """Local relay PONG, or full WebRTC → radio → desktop → back hop ping."""
        t_browser = time.time()
        if not radio_path:
            hops = [
                {"hop": "browser", "ts": t_browser},
                {"hop": "relay", "ts": time.time()},
            ]
            channel.send(
                json.dumps(
                    {
                        "type": "rdi_pong",
                        "scope": "local",
                        "hops": hops,
                        "lines": format_hops(hops),
                    }
                ).encode("utf-8")
            )
            channel.send(PONG_BYTES)
            LOG.info("ping pong (local) session_id=%s viewer=%s", session_id, cid)
            return

        if link_mode == "none":
            err = "link_mode=none (radio not configured for this connection)"
            hops = [
                {"hop": "browser", "ts": t_browser},
                {"hop": "relay", "ts": time.time()},
            ]
            channel.send(
                json.dumps(
                    {
                        "type": "rdi_pong",
                        "scope": "radio",
                        "error": err,
                        "hops": hops,
                        "lines": [err, "fell back to local relay pong"],
                    }
                ).encode("utf-8")
            )
            channel.send(PONG_BYTES)
            return

        if radio is None or not radio.enabled:
            err = "radio path not available (shared router / bridge)"
            hops = [
                {"hop": "browser", "ts": t_browser},
                {"hop": "relay", "ts": time.time()},
            ]
            channel.send(
                json.dumps(
                    {
                        "type": "rdi_pong",
                        "scope": "radio",
                        "error": err,
                        "hops": hops,
                        "lines": [err, "fell back to local relay pong"],
                    }
                ).encode("utf-8")
            )
            channel.send(PONG_BYTES)
            LOG.info("ping pong (radio unavailable) session_id=%s viewer=%s", session_id, cid)
            return

        try:
            pong = await radio.roundtrip_ping(hop_relay="relay", target_sysid=target_sysid)
            hops = [{"hop": "browser", "ts": t_browser}] + list(pong.get("hops") or [])
            summary = {
                "type": "rdi_pong",
                "scope": "radio",
                "id": pong.get("id"),
                "target_sysid": target_sysid,
                "hops": hops,
                "lines": format_hops(hops),
            }
            channel.send(json.dumps(summary).encode("utf-8"))
            channel.send(PONG_BYTES)
            LOG.info(
                "ping pong (radio/%s) session_id=%s viewer=%s id=%s sysid=%s hops=%s",
                link_mode,
                session_id,
                cid,
                pong.get("id"),
                target_sysid,
                ",".join(str(h.get("hop")) for h in hops),
            )
        except Exception as e:
            err = str(e) or e.__class__.__name__
            LOG.warning("radio ping failed session_id=%s: %s — local pong fallback", session_id, err)
            channel.send(
                json.dumps(
                    {
                        "type": "rdi_pong",
                        "scope": "radio",
                        "error": err,
                        "hops": [
                            {"hop": "browser", "ts": t_browser},
                            {"hop": "relay", "ts": time.time()},
                        ],
                        "lines": [f"radio ping failed: {err}", "fell back to local relay pong"],
                    }
                ).encode("utf-8")
            )
            channel.send(PONG_BYTES)

    async def _handle_ctrl(channel, cid: str, payload: dict) -> None:
        """Preliminary control frames: relay log/ack, or fire-and-forget over radio."""
        path = str(payload.get("path") or "relay").strip().lower()
        if path not in ("relay", "radio"):
            path = "relay"
        stack = str(payload.get("stack") or vehicle_stack or "px4").strip().lower() or vehicle_stack
        pipe = str(payload.get("pipe") or _pipe_for_path(path)).strip() or _pipe_for_path(path)
        actions = payload.get("actions") or []
        if not isinstance(actions, list):
            actions = []
        actions_s = [str(a) for a in actions]
        stream = str(payload.get("stream") or "")
        delivered = True
        err: str | None = None

        LOG.info(
            "ctrl rx session_id=%s viewer=%s path=%s pipe=%s stack=%s actions=%s stream=%s",
            session_id,
            cid,
            path,
            pipe,
            stack,
            ",".join(actions_s) or "(none)",
            stream or "—",
        )

        if path == "radio":
            if link_mode == "none":
                delivered = False
                err = "link_mode=none (radio not configured for this connection)"
            elif radio is None or not radio.enabled:
                delivered = False
                err = "radio path not available (shared router / bridge)"
            else:
                try:
                    send = getattr(radio, "send_ctrl", None)
                    if send is None:
                        delivered = False
                        err = "radio client lacks send_ctrl"
                    else:
                        result = send(
                            actions_s,
                            stream,
                            hop_relay="relay",
                            target_sysid=target_sysid,
                            stack=stack,
                            pipe=pipe,
                        )
                        if asyncio.iscoroutine(result):
                            await result
                except Exception as e:
                    delivered = False
                    err = str(e) or e.__class__.__name__
                    LOG.warning("ctrl radio tx failed session_id=%s: %s", session_id, err)

        ack = {
            "type": "rdi_ctrl_ack",
            "path": path,
            "stack": stack,
            "pipe": pipe,
            "actions": actions_s,
            "delivered": delivered,
        }
        if err:
            ack["error"] = err
        try:
            channel.send(json.dumps(ack).encode("utf-8"))
        except Exception as e:
            LOG.warning("ctrl ack send failed session_id=%s: %s", session_id, e)

    async def _apply_ice(pc: RTCPeerConnection, payload: dict) -> None:
        candidate = candidate_from_sdp(payload["candidate"])
        candidate.sdpMid = payload.get("sdpMid")
        candidate.sdpMLineIndex = payload.get("sdpMLineIndex")
        await pc.addIceCandidate(candidate)

    async def _close_pc(pc: RTCPeerConnection) -> None:
        try:
            await pc.close()
        except Exception:
            pass

    async def _wait_for_local_ice(pc: RTCPeerConnection, timeout: float = 5.0) -> None:
        """Poll until aioice finishes gathering local candidates for the answer SDP."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if pc.iceGatheringState == "complete":
                return
            await asyncio.sleep(0.1)
        LOG.warning(
            "local ice gathering timeout session_id=%s state=%s",
            session_id,
            pc.iceGatheringState,
        )

    signaling_auth_failures = 0

    try:
        while True:
            wss_url = _signed_wss_url(endpoint_wss, channel_arn, region, credentials, "MASTER")
            try:
                async with websockets.connect(wss_url, ping_interval=20, ping_timeout=20) as ws:
                    signaling_auth_failures = 0
                    LOG.info("KVS signaling connected session_id=%s", session_id)
                    heartbeat = asyncio.create_task(_signaling_heartbeat(session_id, pc_by_client))
                    try:
                        async for message in ws:
                            msg_type, payload, client_id = _decode_msg(message)
                            if msg_type:
                                LOG.info(
                                    "signaling rx type=%s from=%s session_id=%s",
                                    msg_type,
                                    client_id or "?",
                                    session_id,
                                )
                            if msg_type == "SDP_OFFER" and client_id:
                                for old_cid, old_pc in list(pc_by_client.items()):
                                    if old_cid != client_id:
                                        await _close_pc(old_pc)
                                        del pc_by_client[old_cid]
                                        LOG.info(
                                            "closed stale peer session_id=%s viewer=%s",
                                            session_id,
                                            old_cid,
                                        )
                                old = pc_by_client.pop(client_id, None)
                                if old:
                                    await _close_pc(old)
                                ice = _ice_servers(channel_arn, endpoint_https, region, credentials)
                                pc = RTCPeerConnection(configuration=RTCConfiguration(iceServers=ice))
                                pc_by_client[client_id] = pc

                                @pc.on("datachannel")
                                def on_datachannel(ch, cid=client_id) -> None:
                                    if ch.label != "mavlink":
                                        return

                                    @ch.on("open")
                                    def on_open() -> None:
                                        LOG.info("data channel open session_id=%s viewer=%s", session_id, cid)

                                    @ch.on("message")
                                    def on_message(message, channel=ch) -> None:
                                        if isinstance(message, bytes):
                                            if message == PING_BYTES:
                                                loop.create_task(_handle_ping(channel, cid, radio_path=False))
                                                return
                                            if message == PING_RADIO_BYTES:
                                                loop.create_task(_handle_ping(channel, cid, radio_path=True))
                                                return
                                            if message.startswith(CTRL_PREFIX) and len(message) > len(CTRL_PREFIX):
                                                try:
                                                    payload = json.loads(
                                                        message[len(CTRL_PREFIX) :].decode("utf-8")
                                                    )
                                                except Exception as e:
                                                    LOG.warning("ctrl parse failed session_id=%s: %s", session_id, e)
                                                    return
                                                if isinstance(payload, dict):
                                                    # Legacy takeoff/land used {cmd}; new frames use type rdi_ctrl
                                                    if payload.get("type") == "rdi_ctrl" or "actions" in payload or "path" in payload:
                                                        loop.create_task(_handle_ctrl(channel, cid, payload))
                                                    else:
                                                        LOG.info(
                                                            "legacy CTRL ignored on webrtc session_id=%s payload=%s",
                                                            session_id,
                                                            payload,
                                                        )
                                                return
                                            LOG.debug("datachannel rx %d bytes", len(message))
                                        else:
                                            LOG.debug("datachannel rx %s", message)

                                @pc.on("icecandidate")
                                async def on_ice(candidate, cid=client_id, sock=ws) -> None:
                                    if candidate is None:
                                        return
                                    ice_payload = {
                                        "candidate": candidate.candidate,
                                        "sdpMid": candidate.sdpMid,
                                        "sdpMLineIndex": candidate.sdpMLineIndex,
                                    }
                                    try:
                                        await sock.send(_encode_msg("ICE_CANDIDATE", ice_payload, cid))
                                        LOG.info("sent ICE_CANDIDATE to viewer=%s", cid)
                                    except Exception as e:
                                        LOG.error("failed to send ICE to viewer=%s: %s", cid, e)

                                @pc.on("connectionstatechange")
                                async def on_state_change(c=pc, cid=client_id) -> None:
                                    LOG.info(
                                        "peer connection state session_id=%s viewer=%s state=%s ice=%s",
                                        session_id,
                                        cid,
                                        c.connectionState,
                                        c.iceConnectionState,
                                    )
                                    if c.connectionState in ("closed", "failed"):
                                        if pc_by_client.get(cid) is c:
                                            del pc_by_client[cid]
                                            pending_ice.pop(cid, None)

                                @pc.on("iceconnectionstatechange")
                                async def on_ice_state(c=pc, cid=client_id) -> None:
                                    if c.iceConnectionState in ("failed", "closed"):
                                        if pc_by_client.get(cid) is c:
                                            LOG.info(
                                                "ice closed session_id=%s viewer=%s ice=%s",
                                                session_id,
                                                cid,
                                                c.iceConnectionState,
                                            )
                                            del pc_by_client[cid]
                                            pending_ice.pop(cid, None)
                                            await _close_pc(c)

                                await pc.setRemoteDescription(
                                    RTCSessionDescription(sdp=payload["sdp"], type=payload["type"])
                                )
                                buffered = pending_ice.pop(client_id, [])
                                for ice_payload in buffered:
                                    await _apply_ice(pc, ice_payload)
                                if buffered:
                                    LOG.info(
                                        "applied %d buffered viewer ICE session_id=%s viewer=%s",
                                        len(buffered),
                                        session_id,
                                        client_id,
                                    )
                                answer = await pc.createAnswer()
                                await pc.setLocalDescription(answer)
                                await _wait_for_local_ice(pc)
                                offer_sdp = payload["sdp"]
                                answer_body = {
                                    "sdp": _normalize_answer_sdp(pc.localDescription.sdp, offer_sdp),
                                    "type": "answer",
                                }
                                await ws.send(_encode_msg("SDP_ANSWER", answer_body, client_id))
                                LOG.info(
                                    "sent SDP_ANSWER session_id=%s viewer=%s ice_state=%s",
                                    session_id,
                                    client_id,
                                    pc.iceGatheringState,
                                )
                            elif msg_type == "SDP_OFFER" and not client_id:
                                LOG.warning("SDP_OFFER without senderClientId session_id=%s", session_id)
                            elif msg_type == "ICE_CANDIDATE" and client_id:
                                if client_id in pc_by_client:
                                    await _apply_ice(pc_by_client[client_id], payload)
                                else:
                                    pending_ice.setdefault(client_id, []).append(payload)
                    finally:
                        heartbeat.cancel()
                        with contextlib.suppress(asyncio.CancelledError):
                            await heartbeat
            except websockets.ConnectionClosed:
                LOG.warning("KVS signaling closed; reconnecting session_id=%s", session_id)
                await asyncio.sleep(2)
            except Exception as e:
                err = str(e)
                if "403" in err:
                    signaling_auth_failures += 1
                    LOG.error(
                        "signaling auth error session_id=%s (%d/%d): %s",
                        session_id,
                        signaling_auth_failures,
                        SIGNALING_AUTH_MAX_RETRIES,
                        e,
                    )
                    if signaling_auth_failures >= SIGNALING_AUTH_MAX_RETRIES:
                        LOG.error(
                            "exiting for credential refresh session_id=%s (STS creds expired)",
                            session_id,
                        )
                        sys.exit(SIGNALING_AUTH_EXIT_CODE)
                else:
                    signaling_auth_failures = 0
                    LOG.error("signaling error session_id=%s: %s", session_id, e)
                await asyncio.sleep(5)
    finally:
        if radio is not None:
            radio.stop()


async def _signaling_heartbeat(session_id: str, pc_by_client: dict) -> None:
    """Periodic log so multi-session workers are visible when idle."""
    while True:
        await asyncio.sleep(60)
        LOG.info(
            "heartbeat session_id=%s viewers=%d",
            session_id,
            len(pc_by_client),
        )


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
