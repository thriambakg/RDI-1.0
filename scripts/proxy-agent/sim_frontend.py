#!/usr/bin/env python3
"""
Simulates a frontend WebSocket connection to the proxy.
Connects to PROXY_WS_URL, sends handshake "frontend:session_id", keeps session open,
and implements ping like the main project: binary PING, round-trip timing,
"1. Proxy EC2: ..." / "2. Wavelength: instance responded" or "no agent connected".
"""
import argparse
import asyncio
import json
import os
import sys
import time

try:
    import websockets
except ImportError:
    print("Install websockets: pip install websockets", file=sys.stderr)
    sys.exit(1)

PING_BYTES = b"PING"
PONG_BYTES = b"PONG"
PING_TIMEOUT_S = 8


def parse_hop_message(text: str):
    """Parse JSON hop log like {"hop":"proxy_ec2","message":"handshake accepted"}."""
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def is_proxy_heartbeat(msg) -> bool:
    """True if msg is proxy heartbeat text: {"hop":"proxy_ec2","message":"heartbeat",...}."""
    if not isinstance(msg, str):
        return False
    obj = parse_hop_message(msg)
    return obj is not None and obj.get("hop") == "proxy_ec2" and obj.get("message") == "heartbeat"


async def recv_into_queue(ws, queue: asyncio.Queue) -> None:
    """Consume WebSocket messages into a queue until closed."""
    try:
        async for msg in ws:
            await queue.put(msg)
    except websockets.exceptions.ConnectionClosed:
        await queue.put(None)
    except Exception as e:
        await queue.put(e)


async def run(session_id: str, proxy_ws_url: str, ping_once: bool) -> None:
    print(f"[sim_frontend] Connecting to {proxy_ws_url} with session_id={session_id}")
    async with websockets.connect(proxy_ws_url, open_timeout=5, close_timeout=2) as ws:
        await ws.send(f"frontend:{session_id}")
        print(f"[sim_frontend] Sent handshake frontend:{session_id}")

        queue: asyncio.Queue = asyncio.Queue()
        recv_task = asyncio.create_task(recv_into_queue(ws, queue))

        # Drain until handshake accepted
        while True:
            msg = await queue.get()
            if msg is None or isinstance(msg, Exception):
                break
            text = msg.decode() if isinstance(msg, bytes) else msg
            if isinstance(msg, str):
                obj = parse_hop_message(text)
                if obj and obj.get("hop") == "proxy_ec2" and "handshake accepted" in (obj.get("message") or ""):
                    print("[sim_frontend] 1. Proxy EC2: handshake accepted")
                    print("[sim_frontend] Session open. Proxy will send heartbeats; use Ping to test round-trip to agent.")
                    break
                print(f"[sim_frontend] Text: {text}")
            else:
                print(f"[sim_frontend] Binary: {len(msg)} bytes")

        # Route incoming messages: print heartbeats from proxy, pass everything else to ping/response handling.
        response_queue: asyncio.Queue = asyncio.Queue()

        async def router():
            while True:
                msg = await queue.get()
                if msg is None or isinstance(msg, Exception):
                    await response_queue.put(msg)
                    return
                if is_proxy_heartbeat(msg):
                    ts = ""
                    try:
                        obj = json.loads(msg)
                        ts = obj.get("ts", "")
                    except Exception:
                        pass
                    print(f"[sim_frontend] Heartbeat from proxy (ts={ts})")
                    continue
                await response_queue.put(msg)

        router_task = asyncio.create_task(router())

        async def do_one_ping_async():
            """Send PING and wait for wavelength response; returns (success, elapsed_ms)."""
            start = time.perf_counter()
            await ws.send(PING_BYTES)
            print("  Pinging over existing connection…")
            while True:
                try:
                    msg = await asyncio.wait_for(response_queue.get(), timeout=PING_TIMEOUT_S)
                except asyncio.TimeoutError:
                    return False, int((time.perf_counter() - start) * 1000)
                if msg is None or isinstance(msg, Exception):
                    return False, int((time.perf_counter() - start) * 1000)
                if isinstance(msg, bytes):
                    if msg == PONG_BYTES:
                        elapsed_ms = int((time.perf_counter() - start) * 1000)
                        print(f"  2. Wavelength: binary PONG (T+{elapsed_ms}ms)")
                        print(f"  Success — full round-trip (client → proxy → Wavelength instance → proxy → client) (T+{elapsed_ms}ms).")
                        return True, elapsed_ms
                    print(f"  [sim_frontend] Binary: {len(msg)} bytes (not PONG)")
                    continue
                obj = parse_hop_message(msg)
                if not obj:
                    continue
                elapsed_ms = int((time.perf_counter() - start) * 1000)
                hop = obj.get("hop", "")
                message = obj.get("message", "")
                if hop == "proxy_ec2":
                    print(f"  1. Proxy EC2: {message} (T+{elapsed_ms}ms)")
                elif hop == "wavelength":
                    print(f"  2. Wavelength: {message} (T+{elapsed_ms}ms)")
                    if message == "instance responded":
                        print(f"  Success — full round-trip (client → proxy → Wavelength instance → proxy → client) (T+{elapsed_ms}ms).")
                        return True, elapsed_ms
                    if message == "no agent connected":
                        print("  Proxy reached; no agent on Wavelength instance.")
                        return False, elapsed_ms
                    return False, elapsed_ms
            return False, 0

        if ping_once:
            success, elapsed = await do_one_ping_async()
            if not success and elapsed >= PING_TIMEOUT_S * 1000:
                print("  Ping timed out (8s).")
            recv_task.cancel()
            router_task.cancel()
            try:
                await recv_task
            except asyncio.CancelledError:
                pass
            try:
                await router_task
            except asyncio.CancelledError:
                pass
            sys.exit(0 if success else 1)

        # Interactive: keep session open, Enter to ping
        loop = asyncio.get_event_loop()
        while True:
            try:
                line = await loop.run_in_executor(None, lambda: input("\nPress Enter to ping (q=quit): "))
            except (EOFError, KeyboardInterrupt):
                break
            if line.strip().lower() == "q":
                break
            success, elapsed = await do_one_ping_async()
            if not success and elapsed >= PING_TIMEOUT_S * 1000:
                print("  Ping timed out (8s).")

        recv_task.cancel()
        router_task.cancel()
        try:
            await recv_task
        except asyncio.CancelledError:
            pass
        try:
            await router_task
        except asyncio.CancelledError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Simulate frontend: WebSocket to proxy, keep session open, ping for round-trip."
    )
    parser.add_argument("session_id", help="Session ID (from sim_lambda.py output)")
    parser.add_argument("--proxy-ws-url", default=os.environ.get("PROXY_WS_URL", "ws://127.0.0.1:8765"))
    parser.add_argument("--ping-once", action="store_true", help="Send one ping after handshake then exit (0=success, 1=no agent/timeout)")
    args = parser.parse_args()
    asyncio.run(run(args.session_id, args.proxy_ws_url, args.ping_once))
    return 0


if __name__ == "__main__":
    sys.exit(main())
