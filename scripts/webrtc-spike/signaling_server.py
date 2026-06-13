#!/usr/bin/env python3
"""Minimal WebSocket signaling broker for local Phase 1 spike."""

import asyncio
import json
from aiohttp import web

PEERS: dict[str, web.WebSocketResponse] = {}


async def websocket_handler(request: web.Request) -> web.WebSocketResponse:
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    role = request.query.get("role", "unknown")
    PEERS[role] = ws
    print(f"peer joined: {role}")
    try:
        async for msg in ws:
            if msg.type != web.WSMsgType.TEXT:
                continue
            data = json.loads(msg.data)
            target = data.get("to")
            if target and target in PEERS:
                await PEERS[target].send_str(json.dumps({"from": role, **data}))
    finally:
        PEERS.pop(role, None)
        print(f"peer left: {role}")
    return ws


app = web.Application()
app.router.add_get("/ws", websocket_handler)

if __name__ == "__main__":
    print("Signaling server on ws://0.0.0.0:8780/ws")
    web.run_app(app, host="0.0.0.0", port=8780)
