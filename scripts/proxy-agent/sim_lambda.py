#!/usr/bin/env python3
"""
Simulates the Lambda session-create flow: register session with proxy (status API)
and with the agent (POST /sessions). Uses HTTP only (no SSM); agent is assumed
to be reachable at AGENT_URL (e.g. http://127.0.0.1:8080).
Mirrors: src/session-api/lambda_function.py _notify_proxy_session_status + _start_agent_on_wavelength.
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request
import uuid


def _notify_proxy_session_status(
    session_id: str,
    status: str,
    proxy_status_url: str,
    proxy_status_secret: str,
) -> None:
    """Tell the proxy to set session status (active/idle). Same as Lambda."""
    if not proxy_status_url or not proxy_status_secret:
        print(f"[sim_lambda] proxy status notify skipped (no URL/SECRET) session_id={session_id} status={status}")
        return
    print(f"[sim_lambda] notifying proxy session_id={session_id} status={status}")
    body = json.dumps({"session_id": session_id, "status": status}).encode("utf-8")
    req = urllib.request.Request(
        proxy_status_url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "X-Proxy-Secret": proxy_status_secret,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            if resp.status != 200:
                print(f"[sim_lambda] proxy status API returned {resp.status} for session {session_id}")
            else:
                print(f"[sim_lambda] proxy status acknowledged session_id={session_id} status={status}")
    except urllib.error.URLError as e:
        print(f"[sim_lambda] proxy status notify failed session_id={session_id} error={e}")
        raise
    except Exception as e:
        print(f"[sim_lambda] proxy status notify error session_id={session_id}: {e}")
        raise


def _start_agent_on_wavelength(
    session_id: str,
    proxy_url: str,
    agent_url: str,
) -> None:
    """Tell the agent to add this session (open WebSocket to proxy). Locally we POST to agent URL instead of SSM."""
    if not agent_url or not proxy_url or not session_id:
        print(f"[sim_lambda] agent add skipped: missing agent_url={bool(agent_url)} proxy_url={bool(proxy_url)} session_id={bool(session_id)}")
        return
    print(f"[sim_lambda] starting agent session_id={session_id} proxy_url={proxy_url} (agent will open WebSocket to proxy)")
    body = json.dumps({"session_id": session_id, "proxy_url": proxy_url}).encode("utf-8")
    req = urllib.request.Request(
        agent_url.rstrip("/") + "/sessions",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = resp.read().decode()
            print(f"[sim_lambda] agent add session_id={session_id} response={resp.status} {data}")
    except urllib.error.URLError as e:
        print(f"[sim_lambda] agent add failed session_id={session_id} error={e}")
        raise
    except Exception as e:
        print(f"[sim_lambda] agent add error session_id={session_id}: {e}")
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description="Simulate Lambda: register session with proxy + agent")
    parser.add_argument("--session-id", default=None, help="Session ID (default: new UUID)")
    parser.add_argument("--proxy-status-url", default=os.environ.get("PROXY_STATUS_URL", "http://127.0.0.1:8767/session-status"))
    parser.add_argument("--proxy-status-secret", default=os.environ.get("PROXY_STATUS_SECRET", "sim-secret"))
    parser.add_argument("--agent-url", default=os.environ.get("AGENT_URL", "http://127.0.0.1:8080"))
    parser.add_argument("--proxy-ws-url", default=os.environ.get("PROXY_WS_URL", "ws://127.0.0.1:8765"))
    parser.add_argument("--status", default="active", choices=("active", "idle"))
    args = parser.parse_args()

    session_id = args.session_id or str(uuid.uuid4())
    print(f"[sim_lambda] session_id={session_id}")

    # Order: 1) Add session on agent (so it is waiting for proxy to connect), 2) Notify proxy
    # (proxy then opens WebSocket to agent at AGENT_WS_URL, e.g. ws://127.0.0.1:8769).
    if args.status == "active":
        _start_agent_on_wavelength(session_id, args.proxy_ws_url, args.agent_url)
    _notify_proxy_session_status(
        session_id,
        args.status,
        args.proxy_status_url,
        args.proxy_status_secret,
    )

    print(f"[sim_lambda] done. Use session_id={session_id} for frontend WebSocket handshake (frontend:{session_id})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
