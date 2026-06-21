#!/usr/bin/env python3
"""
RDI relay daemon — poll active WebRTC sessions and spawn one worker per session_id.

Requires hardware claim first (rdi-relay-claim.py → /etc/rdi/relay.conf + device.json).

Usage:
  python3 rdi-relay-daemon.py

Environment:
  RDI_POLL_INTERVAL_SEC  — default 5
  RDI_WORKER_DRY_RUN=1   — log spawns without starting workers (daemon test)
"""

from __future__ import annotations

import json
import logging
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from rdi_device_config import load_device_config

LOG = logging.getLogger("rdi.daemon")
POLL_INTERVAL_SEC = int(os.environ.get("RDI_POLL_INTERVAL_SEC", "5"))
CREDS_REFRESH_MARGIN_SEC = int(os.environ.get("RDI_CREDS_REFRESH_MARGIN_SEC", "300"))
WORKER_SCRIPT = Path(__file__).resolve().parent / "kvs_master_worker.py"
WORKER_DRY_RUN = os.environ.get("RDI_WORKER_DRY_RUN", "").strip() in ("1", "true", "yes")


class WorkerProcess:
    def __init__(
        self,
        session_id: str,
        proc: subprocess.Popen | None = None,
        creds_expiration: str | None = None,
        channel_arn: str | None = None,
    ):
        self.session_id = session_id
        self.proc = proc
        self.creds_expiration = creds_expiration
        self.channel_arn = channel_arn or ""


def _creds_expiration(session: dict) -> str | None:
    creds = (session.get("webrtc") or {}).get("credentials") or {}
    exp = creds.get("expiration")
    return str(exp) if exp else None


def _creds_expire_within(expiration: str | None, margin_sec: int) -> bool:
    """True if STS creds are expired or expire within margin_sec."""
    if not expiration:
        return False
    try:
        exp_dt = datetime.fromisoformat(expiration.replace("Z", "+00:00"))
        if exp_dt.tzinfo is None:
            exp_dt = exp_dt.replace(tzinfo=timezone.utc)
        return exp_dt.timestamp() - time.time() <= margin_sec
    except (TypeError, ValueError):
        return False


def _http_get(url: str) -> tuple[int, dict]:
    req = urllib.request.Request(url, headers={"Accept": "application/json"}, method="GET")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.status, json.loads(resp.read().decode("utf-8"))


def fetch_active_sessions(api_base: str, device_serial: str, device_secret: str) -> list[dict]:
    qs = urllib.parse.urlencode({"device_serial": device_serial, "device_secret": device_secret})
    url = f"{api_base}/relays/active-sessions?{qs}"
    try:
        status, body = _http_get(url)
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")
        LOG.error("active-sessions HTTP %s: %s", e.code, err_body[:500])
        return []
    except urllib.error.URLError as e:
        LOG.error("active-sessions request failed: %s", e)
        return []

    if status != 200:
        LOG.error("active-sessions unexpected status %s: %s", status, body)
        return []

    sessions = body.get("sessions") or []
    if not isinstance(sessions, list):
        return []
    api_status = body.get("status", "")
    session_ids = [str(s.get("session_id", ""))[:8] for s in sessions if s.get("session_id")]
    LOG.info(
        "poll active-sessions: %d session(s) status=%s ids=%s",
        len(sessions),
        api_status,
        ",".join(session_ids) or "(none)",
    )
    return sessions


def _channel_arn(session: dict) -> str:
    webrtc = session.get("webrtc") or {}
    return str(webrtc.get("channel_arn") or "")


def _worker_config(session: dict) -> dict:
    return {
        "session_id": session["session_id"],
        "drone_id": session.get("drone_id", ""),
        "mavlink_host": session.get("mavlink_host") or "127.0.0.1",
        "mavlink_port": session.get("mavlink_port") or 18570,
        "webrtc": session["webrtc"],
    }


def start_worker(session: dict) -> WorkerProcess | None:
    session_id = session.get("session_id", "")
    if not session_id or not session.get("webrtc"):
        LOG.warning("skip session missing id or webrtc bundle: %s", session_id)
        return None

    if WORKER_DRY_RUN:
        LOG.info("[dry-run] would start worker session_id=%s mavlink=%s:%s", session_id, session.get("mavlink_host"), session.get("mavlink_port"))
        return WorkerProcess(session_id, None, _creds_expiration(session), _channel_arn(session))

    env = os.environ.copy()
    env["RDI_WORKER_CONFIG"] = json.dumps(_worker_config(session))
    env["PYTHONUNBUFFERED"] = "1"

    proc = subprocess.Popen(
        [sys.executable, str(WORKER_SCRIPT)],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        start_new_session=True,
    )
    LOG.info(
        "started worker pid=%s session_id=%s channel=%s creds_exp=%s",
        proc.pid,
        session_id,
        _channel_arn(session)[-36:] if _channel_arn(session) else "?",
        _creds_expiration(session) or "?",
    )
    return WorkerProcess(session_id, proc, _creds_expiration(session), _channel_arn(session))


def stop_worker(worker: WorkerProcess) -> None:
    if worker.proc is None:
        LOG.info("stop worker (dry-run) session_id=%s", worker.session_id)
        return
    pid = worker.proc.pid
    if worker.proc.poll() is None:
        try:
            os.killpg(os.getpgid(pid), signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            worker.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            LOG.warning("worker SIGKILL session_id=%s pid=%s", worker.session_id, pid)
            try:
                os.killpg(os.getpgid(pid), signal.SIGKILL)
            except ProcessLookupError:
                pass
    LOG.info("stopped worker session_id=%s", worker.session_id)


def _drain_worker_logs(workers: dict[str, WorkerProcess]) -> None:
    for sid, worker in list(workers.items()):
        proc = worker.proc
        if proc is None or proc.stdout is None:
            continue
        while True:
            line = proc.stdout.readline()
            if not line:
                break
            LOG.info("[worker %s] %s", sid[:8], line.rstrip())
        if proc.poll() is not None:
            code = proc.returncode
            if code == 2:
                LOG.warning(
                    "worker exited for credential refresh session_id=%s",
                    sid,
                )
            else:
                LOG.warning("worker exited code=%s session_id=%s", code, sid)


def reconcile(workers: dict[str, WorkerProcess], desired: list[dict]) -> dict[str, WorkerProcess]:
    desired_ids = {s["session_id"] for s in desired if s.get("session_id")}
    for sid in list(workers.keys()):
        if sid not in desired_ids:
            LOG.info("worker no longer active, stopping session_id=%s", sid)
            stop_worker(workers[sid])
            del workers[sid]

    by_id = {s["session_id"]: s for s in desired if s.get("session_id")}
    for sid, session in by_id.items():
        existing = workers.get(sid)
        desired_arn = _channel_arn(session)
        if existing and existing.proc and existing.proc.poll() is None:
            creds_stale = _creds_expire_within(existing.creds_expiration, CREDS_REFRESH_MARGIN_SEC)
            channel_changed = bool(desired_arn) and existing.channel_arn != desired_arn
            if not creds_stale and not channel_changed:
                continue
            if channel_changed:
                LOG.info(
                    "refreshing worker session_id=%s (KVS channel changed %s -> %s)",
                    sid,
                    (existing.channel_arn or "?")[-36:],
                    (desired_arn or "?")[-36:],
                )
            else:
                LOG.info(
                    "refreshing worker session_id=%s (KVS creds expired or expiring within %ss)",
                    sid,
                    CREDS_REFRESH_MARGIN_SEC,
                )
            stop_worker(existing)
        elif existing:
            LOG.warning("restarting dead worker session_id=%s", sid)
            stop_worker(existing)
        started = start_worker(session)
        if started:
            workers[sid] = started

    active = [
        f"{sid[:8]}(pid={w.proc.pid})"
        for sid, w in workers.items()
        if w.proc and w.proc.poll() is None
    ]
    if len(active) > 1:
        LOG.info("workers active: %s", ", ".join(active))
    return workers


def main() -> None:
    logging.basicConfig(
        level=os.environ.get("RDI_LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        stream=sys.stdout,
    )

    if not WORKER_SCRIPT.exists():
        LOG.error("worker script not found: %s", WORKER_SCRIPT)
        sys.exit(1)

    try:
        cfg = load_device_config()
    except RuntimeError as e:
        LOG.error("%s", e)
        sys.exit(1)

    LOG.info(
        "relay daemon starting relay_id=%s api=%s poll=%ss dry_run=%s",
        cfg.get("relay_id") or "(unknown)",
        cfg["api_base_url"],
        POLL_INTERVAL_SEC,
        WORKER_DRY_RUN,
    )

    workers: dict[str, WorkerProcess] = {}
    running = True

    def _shutdown(signum, frame) -> None:
        nonlocal running
        LOG.info("signal %s — shutting down", signum)
        running = False

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    while running:
        _drain_worker_logs(workers)
        sessions = fetch_active_sessions(cfg["api_base_url"], cfg["device_serial"], cfg["device_secret"])
        workers = reconcile(workers, sessions)
        for _ in range(POLL_INTERVAL_SEC):
            if not running:
                break
            time.sleep(1)

    for sid in list(workers.keys()):
        stop_worker(workers[sid])
    LOG.info("relay daemon stopped")


if __name__ == "__main__":
    main()
