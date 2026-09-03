"""Daemon-owned shared radio router (single serial owner for all workers).

Listens on 127.0.0.1 TCP with newline-delimited JSON requests so N WebRTC
workers can ping/command without each opening /dev/serial0.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
import time
from typing import Any

from radio_mavlink_bridge import RadioMavlinkBridge
from radio_serial_bridge import RadioSerialBridge

LOG = logging.getLogger("rdi.radio_router")

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = int(os.environ.get("RDI_RADIO_ROUTER_PORT", "18771"))
# After a ping round-trip, keep the air quiet so half-duplex RFD can finish RX
# before the next session's ping/CTRL TX blinds the return path.
PING_AIR_QUIET_SEC = float(os.environ.get("RDI_RADIO_PING_QUIET_SEC", "0.12"))
# Max time a CTRL waits for an in-flight ping lock before being queued/dropped.
CTRL_WAIT_PING_SEC = float(os.environ.get("RDI_RADIO_CTRL_WAIT_SEC", "0.35"))


class RadioRouterServer:
    """Owns one RadioMavlinkBridge or RadioSerialBridge; serves localhost clients."""

    def __init__(
        self,
        port: str,
        baud: int,
        *,
        mode: str = "mavlink",
        timeout_sec: float = 8.0,
        listen_host: str = DEFAULT_HOST,
        listen_port: int = DEFAULT_PORT,
    ):
        self.serial_port = port
        self.baud = baud
        self.mode = (mode or "mavlink").strip().lower()
        self.timeout_sec = timeout_sec
        self.listen_host = listen_host
        self.listen_port = listen_port
        self._bridge: RadioMavlinkBridge | RadioSerialBridge | None = None
        self._thread: threading.Thread | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._server: asyncio.AbstractServer | None = None
        self._ready = threading.Event()
        self._stop = threading.Event()
        self._start_error: str | None = None
        # Single-flight RF TX during ping: serialize round-trips and hold CTRL
        # so Pi TX does not blind the inbound pong on half-duplex air.
        self._ping_lock: asyncio.Lock | None = None
        self._ctrl_queue: asyncio.Queue | None = None

    @property
    def enabled(self) -> bool:
        return self._ready.is_set() and self._bridge is not None and self._bridge.enabled

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._ready.clear()
        self._start_error = None
        self._thread = threading.Thread(target=self._run, name="rdi-radio-router", daemon=True)
        self._thread.start()
        if not self._ready.wait(timeout=15):
            raise RuntimeError(self._start_error or "radio router failed to start within 15s")
        if self._start_error:
            raise RuntimeError(self._start_error)
        LOG.info(
            "radio router listening on %s:%s mode=%s serial=%s baud=%s quiet=%.0fms",
            self.listen_host,
            self.listen_port,
            self.mode,
            self.serial_port,
            self.baud,
            PING_AIR_QUIET_SEC * 1000.0,
        )

    def stop(self) -> None:
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=8)
        self._thread = None
        self._ready.clear()
        LOG.info("radio router stopped")

    def _run(self) -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self._loop = loop
        self._ping_lock = asyncio.Lock()
        self._ctrl_queue = asyncio.Queue(maxsize=32)
        try:
            if self.mode == "raw":
                self._bridge = RadioSerialBridge(self.serial_port, self.baud, self.timeout_sec)
            else:
                self._bridge = RadioMavlinkBridge(self.serial_port, self.baud, self.timeout_sec)
            self._bridge.start(loop)
            loop.run_until_complete(self._main())
        except Exception as e:
            self._start_error = str(e) or e.__class__.__name__
            LOG.error("radio router failed: %s", e)
            self._ready.set()
        finally:
            if self._bridge is not None:
                try:
                    self._bridge.stop()
                except Exception:
                    pass
                self._bridge = None
            try:
                loop.close()
            except Exception:
                pass
            self._loop = None

    async def _main(self) -> None:
        self._server = await asyncio.start_server(
            self._handle_client,
            host=self.listen_host,
            port=self.listen_port,
        )
        self._ready.set()
        assert self._server is not None
        async with self._server:
            while not self._stop.is_set():
                await asyncio.sleep(0.25)

    async def _handle_client(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        peer = writer.get_extra_info("peername")
        try:
            while not self._stop.is_set():
                line = await reader.readline()
                if not line:
                    break
                try:
                    req = json.loads(line.decode("utf-8"))
                except (json.JSONDecodeError, UnicodeDecodeError) as e:
                    await self._reply(writer, {"ok": False, "error": f"bad json: {e}"})
                    continue
                resp = await self._dispatch(req if isinstance(req, dict) else {})
                await self._reply(writer, resp)
        except (asyncio.CancelledError, ConnectionResetError, BrokenPipeError):
            pass
        except Exception as e:
            LOG.warning("radio router client error peer=%s: %s", peer, e)
        finally:
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass

    async def _reply(self, writer: asyncio.StreamWriter, resp: dict[str, Any]) -> None:
        data = (json.dumps(resp, separators=(",", ":")) + "\n").encode("utf-8")
        writer.write(data)
        await writer.drain()

    def _parse_target(self, req: dict[str, Any]) -> int | None:
        target_sysid = req.get("target_sysid")
        try:
            return int(target_sysid) if target_sysid is not None else None
        except (TypeError, ValueError):
            return None

    async def _flush_ctrl_queue(self) -> int:
        """TX any CTRL frames deferred while a ping owned the air."""
        if self._ctrl_queue is None or self._bridge is None:
            return 0
        flushed = 0
        while not self._ctrl_queue.empty():
            try:
                item = self._ctrl_queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            try:
                self._bridge.send_ctrl(**item)
                flushed += 1
            except Exception as e:
                LOG.warning("queued ctrl flush failed: %s", e)
        if flushed:
            LOG.info("flushed %d queued ctrl frame(s) after ping", flushed)
        return flushed

    async def _dispatch(self, req: dict[str, Any]) -> dict[str, Any]:
        cmd = str(req.get("cmd") or "").strip().lower()
        if cmd == "status":
            return {
                "ok": True,
                "enabled": bool(self._bridge and self._bridge.enabled),
                "mode": self.mode,
                "serial_port": self.serial_port,
                "baud": self.baud,
                "ping_locked": bool(self._ping_lock and self._ping_lock.locked()),
            }
        if cmd == "ping":
            if self._bridge is None or not self._bridge.enabled:
                return {"ok": False, "error": "radio bridge not ready"}
            hop_relay = str(req.get("hop_relay") or "relay")
            target = self._parse_target(req)
            t0 = time.time()
            LOG.info("router ping START sysid=%s hop=%s", target, hop_relay)
            try:
                if self._ping_lock is not None:
                    async with self._ping_lock:
                        try:
                            pong = await self._bridge.roundtrip_ping(
                                hop_relay=hop_relay,
                                target_sysid=target,
                            )
                            await asyncio.sleep(PING_AIR_QUIET_SEC)
                        finally:
                            await self._flush_ctrl_queue()
                else:
                    pong = await self._bridge.roundtrip_ping(
                        hop_relay=hop_relay,
                        target_sysid=target,
                    )
                LOG.info(
                    "router ping OK sysid=%s id=%s ms=%.0f air=%s",
                    target,
                    (pong or {}).get("id"),
                    (time.time() - t0) * 1000.0,
                    (pong or {}).get("air_rtt_ms"),
                )
                return {"ok": True, "pong": pong}
            except Exception as e:
                LOG.warning(
                    "router ping FAIL sysid=%s ms=%.0f err=%s",
                    target,
                    (time.time() - t0) * 1000.0,
                    e,
                )
                return {"ok": False, "error": str(e) or e.__class__.__name__}
        if cmd == "ctrl":
            if self._bridge is None or not self._bridge.enabled:
                return {"ok": False, "error": "radio bridge not ready"}
            hop_relay = str(req.get("hop_relay") or "relay")
            target = self._parse_target(req)
            actions = req.get("actions") or []
            if not isinstance(actions, list):
                actions = []
            kwargs = {
                "actions": [str(a) for a in actions],
                "stream": str(req.get("stream") or ""),
                "hop_relay": hop_relay,
                "target_sysid": target,
                "stack": str(req.get("stack") or ""),
                "pipe": str(req.get("pipe") or ""),
            }
            # CTRL stays concurrent with other CTRL; only pings serialize on
            # _ping_lock. Do not block sticks while a rare diagnostic ping runs.
            try:
                msg = self._bridge.send_ctrl(**kwargs)
                return {"ok": True, "ctrl": msg}
            except Exception as e:
                return {"ok": False, "error": str(e) or e.__class__.__name__}
        if cmd == "await_ctrl_ack":
            if self._bridge is None or not self._bridge.enabled:
                return {"ok": False, "error": "radio bridge not ready"}
            ctrl_id = str(req.get("id") or "").strip()
            if not ctrl_id:
                return {"ok": False, "error": "id required"}
            try:
                timeout_sec = float(req.get("timeout_sec") or 2.0)
            except (TypeError, ValueError):
                timeout_sec = 2.0
            wait = getattr(self._bridge, "wait_ctrl_ack", None)
            if wait is None:
                return {"ok": False, "error": "bridge lacks wait_ctrl_ack"}
            try:
                ack = await wait(ctrl_id, timeout_sec=timeout_sec)
                return {"ok": True, "ack": ack}
            except Exception as e:
                return {"ok": False, "error": str(e) or e.__class__.__name__}
        return {"ok": False, "error": f"unknown cmd: {cmd or '(empty)'}"}


def maybe_start_from_env() -> RadioRouterServer | None:
    """Start router if RDI_RADIO_PORT is set. Returns None when radio disabled."""
    serial_port = os.environ.get("RDI_RADIO_PORT", "").strip()
    if not serial_port:
        LOG.info("RDI_RADIO_PORT unset — radio router not started")
        return None
    mode = os.environ.get("RDI_RADIO_MODE", "mavlink").strip().lower() or "mavlink"
    default_baud = "921600" if mode == "mavlink" else "57600"
    baud = int(os.environ.get("RDI_RADIO_BAUD", default_baud))
    # 5s is enough for a healthy round-trip; shorter than 8s so a dead peer
    # does not stall the other connection's ping queue as long.
    timeout_sec = float(os.environ.get("RDI_RADIO_TIMEOUT_SEC", "5" if mode == "mavlink" else "5"))
    listen_port = int(os.environ.get("RDI_RADIO_ROUTER_PORT", str(DEFAULT_PORT)))
    listen_host = os.environ.get("RDI_RADIO_ROUTER_HOST", DEFAULT_HOST).strip() or DEFAULT_HOST
    server = RadioRouterServer(
        serial_port,
        baud,
        mode=mode,
        timeout_sec=timeout_sec,
        listen_host=listen_host,
        listen_port=listen_port,
    )
    server.start()
    return server
