#!/usr/bin/env python3
"""Pi WebRTC MASTER — local spike. Sends mock telemetry over unreliable data channel."""

import asyncio
import json
import os
import time

import aiohttp
from aiortc import RTCPeerConnection, RTCSessionDescription
from aiortc.contrib.signaling import BYE

SIGNALING = os.environ.get("RDI_SIGNALING_URL", "ws://127.0.0.1:8780/ws?role=master")


async def signaling_send(ws, payload: dict) -> None:
    await ws.send_str(json.dumps({"to": "viewer", **payload}))


async def run() -> None:
    pc = RTCPeerConnection()
    channel = pc.createDataChannel("mavlink", ordered=False, maxRetransmits=0)

    @channel.on("open")
    def on_open() -> None:
        print("data channel open")

        async def telemetry_loop() -> None:
            seq = 0
            while channel.readyState == "open":
                msg = json.dumps({"type": "TELEM", "seq": seq, "ts": time.time()})
                channel.send(msg)
                seq += 1
                await asyncio.sleep(0.1)

        asyncio.ensure_future(telemetry_loop())

    async with aiohttp.ClientSession() as session:
        async with session.ws_connect(SIGNALING) as ws:
            offer = await pc.createOffer()
            await pc.setLocalDescription(offer)
            await signaling_send(ws, {"type": "offer", "sdp": pc.localDescription.sdp})

            async for msg in ws:
                if msg.type != aiohttp.WSMsgType.TEXT:
                    continue
                data = json.loads(msg.data)
                if data.get("type") == "answer":
                    await pc.setRemoteDescription(
                        RTCSessionDescription(sdp=data["sdp"], type="answer")
                    )
                    print("connected — sending TELEM packets")
                elif data.get("type") == BYE:
                    break

    await pc.close()


if __name__ == "__main__":
    asyncio.run(run())
