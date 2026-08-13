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
# After a ping round-trip, keep the air quiet briefly so half-duplex RFD can
# finish the return before the next session's ping TX.
PING_AIR_QUIET_SEC = float(os.environ.get("RDI_RADIO_PING_QUIET_SEC", "0.25"))


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
        # Ping-only lock: multi-session CTRL stays concurrent (required for
        # simultaneous multi-drone). Concurrent pings on half-duplex RF destroy
        # return pongs (desktop echoes, Pi times out) — serialize round-trips.
        self._ping_lock: asyncio.Lock | None = None

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
            "radio router listening on %s:%s mode=%s serial=%s baud=%s",
            self.listen_host,
            self.listen_port,
            self.mode,
            self.serial_port,
            self.baud,
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

    async def _dispatch(self, req: dict[str, Any]) -> dict[str, Any]:
        cmd = str(req.get("cmd") or "").strip().lower()
        if cmd == "status":
            return {
                "ok": True,
                "enabled": bool(self._bridge and self._bridge.enabled),
                "mode": self.mode,
                "serial_port": self.serial_port,
                "baud": self.baud,
            }
        if cmd == "ping":
            if self._bridge is None or not self._bridge.enabled:
                return {"ok": False, "error": "radio bridge not ready"}
            hop_relay = str(req.get("hop_relay") or "relay")
            target_sysid = req.get("target_sysid")
            try:
                target = int(target_sysid) if target_sysid is not None else None
            except (TypeError, ValueError):
                target = None
            t0 = time.time()
            LOG.info("router ping START sysid=%s hop=%s", target, hop_relay)
            try:
                if self._ping_lock is not None:
                    async with self._ping_lock:
                        pong = await self._bridge.roundtrip_ping(
                            hop_relay=hop_relay,
                            target_sysid=target,
                        )
                        # Let half-duplex air settle before next session's ping.
                        await asyncio.sleep(PING_AIR_QUIET_SEC)
                else:
                    pong = await self._bridge.roundtrip_ping(
                        hop_relay=hop_relay,
                        target_sysid=target,
                    )
                LOG.info(
                    "router ping OK sysid=%s id=%s ms=%.0f",
                    target,
                    (pong or {}).get("id"),
                    (time.time() - t0) * 1000.0,
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
            target_sysid = req.get("target_sysid")
            try:
                target = int(target_sysid) if target_sysid is not None else None
            except (TypeError, ValueError):
                target = None
            actions = req.get("actions") or []
            if not isinstance(actions, list):
                actions = []
            stream = str(req.get("stream") or "")
            stack = str(req.get("stack") or "")
            pipe = str(req.get("pipe") or "")
            try:
                msg = self._bridge.send_ctrl(
                    [str(a) for a in actions],
                    stream,
                    hop_relay=hop_relay,
                    target_sysid=target,
                    stack=stack,
                    pipe=pipe,
                )
                return {"ok": True, "ctrl": msg}
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
    timeout_sec = float(os.environ.get("RDI_RADIO_TIMEOUT_SEC", "8" if mode == "mavlink" else "5"))
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
