"""Worker client for the daemon-owned radio router (localhost JSON-lines TCP)."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
from typing import Any

LOG = logging.getLogger("rdi.radio_router_client")

DEFAULT_HOST = os.environ.get("RDI_RADIO_ROUTER_HOST", "127.0.0.1").strip() or "127.0.0.1"
DEFAULT_PORT = int(os.environ.get("RDI_RADIO_ROUTER_PORT", "18771"))


class RadioRouterClient:
    """Drop-in async ping client matching RadioMavlinkBridge.roundtrip_ping."""

    def __init__(
        self,
        host: str = DEFAULT_HOST,
        port: int = DEFAULT_PORT,
        timeout_sec: float = 10.0,
    ):
        self.host = host
        self.port = port
        self.timeout_sec = timeout_sec
        self._enabled = False

    @property
    def enabled(self) -> bool:
        return self._enabled

    async def start(self) -> None:
        """Probe router status; marks enabled on success."""
        try:
            resp = await self._request({"cmd": "status"}, timeout=3.0)
            self._enabled = bool(resp.get("ok") and resp.get("enabled"))
            if self._enabled:
                LOG.info(
                    "radio router client connected %s:%s mode=%s serial=%s",
                    self.host,
                    self.port,
                    resp.get("mode"),
                    resp.get("serial_port"),
                )
            else:
                LOG.warning("radio router status not ready: %s", resp)
        except Exception as e:
            self._enabled = False
            LOG.warning("radio router unreachable %s:%s — %s", self.host, self.port, e)

    def stop(self) -> None:
        self._enabled = False

    async def roundtrip_ping(
        self,
        hop_relay: str = "relay",
        target_sysid: int | None = None,
    ) -> dict[str, Any]:
        if not self._enabled:
            raise RuntimeError("radio router client not connected")
        req: dict[str, Any] = {"cmd": "ping", "hop_relay": hop_relay}
        if target_sysid is not None:
            req["target_sysid"] = int(target_sysid)
        resp = await self._request(req, timeout=self.timeout_sec + 2.0)
        if not resp.get("ok"):
            raise TimeoutError(str(resp.get("error") or "radio router ping failed"))
        pong = resp.get("pong")
        if not isinstance(pong, dict):
            raise RuntimeError("radio router returned no pong payload")
        return pong

    async def _request(self, req: dict[str, Any], timeout: float) -> dict[str, Any]:
        async def _once() -> dict[str, Any]:
            reader, writer = await asyncio.open_connection(self.host, self.port)
            try:
                writer.write((json.dumps(req, separators=(",", ":")) + "\n").encode("utf-8"))
                await writer.drain()
                line = await reader.readline()
                if not line:
                    raise ConnectionError("radio router closed connection")
                data = json.loads(line.decode("utf-8"))
                if not isinstance(data, dict):
                    raise RuntimeError("radio router returned non-object")
                return data
            finally:
                writer.close()
                with contextlib.suppress(Exception):
                    await writer.wait_closed()

        return await asyncio.wait_for(_once(), timeout=timeout)


def router_client_from_env(timeout_sec: float | None = None) -> RadioRouterClient:
    host = os.environ.get("RDI_RADIO_ROUTER_HOST", DEFAULT_HOST).strip() or DEFAULT_HOST
    port = int(os.environ.get("RDI_RADIO_ROUTER_PORT", str(DEFAULT_PORT)))
    to = timeout_sec
    if to is None:
        to = float(os.environ.get("RDI_RADIO_TIMEOUT_SEC", "8"))
    return RadioRouterClient(host=host, port=port, timeout_sec=to)
