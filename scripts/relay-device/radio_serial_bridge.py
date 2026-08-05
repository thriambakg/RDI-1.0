"""Async-friendly serial bridge for radio hop pings (daemon-safe helper)."""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from typing import Any

from radio_hop_protocol import decode_line, encode_line, make_ctrl, make_ping

LOG = logging.getLogger("rdi.radio_bridge")


class RadioSerialBridge:
    """
    Background reader thread + asyncio waiters for ping/pong over a serial port.

    When disabled (no port), callers should local-echo PONG as before.
    """

    def __init__(self, port: str, baud: int = 57600, timeout_sec: float = 5.0):
        self.port = port
        self.baud = baud
        self.timeout_sec = timeout_sec
        self._ser = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._pending: dict[str, asyncio.Future] = {}
        self._loop: asyncio.AbstractEventLoop | None = None
        self._rx_buf = bytearray()

    @property
    def enabled(self) -> bool:
        return self._ser is not None and getattr(self._ser, "is_open", False)

    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        import serial

        self._loop = loop
        self._ser = serial.Serial(
            port=self.port,
            baudrate=self.baud,
            bytesize=serial.EIGHTBITS,
            parity=serial.PARITY_NONE,
            stopbits=serial.STOPBITS_ONE,
            timeout=0.1,
        )
        self._stop.clear()
        self._thread = threading.Thread(target=self._reader, name="rdi-radio-rx", daemon=True)
        self._thread.start()
        LOG.info("radio bridge open port=%s baud=%s", self.port, self.baud)

    def stop(self) -> None:
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2)
        self._thread = None
        if self._ser is not None:
            try:
                self._ser.close()
            except Exception:
                pass
            self._ser = None
        for fut in list(self._pending.values()):
            if not fut.done():
                fut.set_exception(TimeoutError("radio bridge stopped"))
        self._pending.clear()
        LOG.info("radio bridge closed")

    def _reader(self) -> None:
        assert self._ser is not None
        while not self._stop.is_set():
            try:
                chunk = self._ser.read(256)
                if not chunk:
                    continue
                self._rx_buf.extend(chunk)
                while True:
                    nl = self._rx_buf.find(b"\n")
                    if nl < 0:
                        break
                    line = bytes(self._rx_buf[: nl + 1])
                    del self._rx_buf[: nl + 1]
                    msg = decode_line(line)
                    if not msg:
                        continue
                    if msg.get("type") != "pong":
                        continue
                    ping_id = str(msg.get("id") or "")
                    fut = self._pending.get(ping_id)
                    if fut and self._loop and not fut.done():
                        self._loop.call_soon_threadsafe(fut.set_result, msg)
            except Exception as e:
                if not self._stop.is_set():
                    LOG.warning("radio rx error: %s", e)
                    time.sleep(0.2)

    async def roundtrip_ping(
        self,
        hop_relay: str = "relay",
        target_sysid: int | None = None,
    ) -> dict[str, Any]:
        if not self.enabled or self._loop is None:
            raise RuntimeError("radio bridge not started")

        msg = make_ping(hop_relay, target_sysid=target_sysid)
        ping_id = str(msg["id"])
        fut: asyncio.Future = self._loop.create_future()
        self._pending[ping_id] = fut
        try:
            data = encode_line(msg)
            with self._lock:
                assert self._ser is not None
                self._ser.write(data)
                self._ser.flush()
            LOG.info(
                "radio ping tx id=%s bytes=%d target_sysid=%s",
                ping_id,
                len(data),
                target_sysid if target_sysid is not None else "any",
            )
            pong = await asyncio.wait_for(fut, timeout=self.timeout_sec)
            # stamp relay return hop
            hops = list(pong.get("hops") or [])
            hops.append({"hop": hop_relay, "ts": time.time()})
            pong = {**pong, "hops": hops}
            LOG.info("radio pong rx id=%s hops=%d", ping_id, len(hops))
            return pong
        finally:
            self._pending.pop(ping_id, None)

    def send_ctrl(
        self,
        actions: list[str],
        stream: str = "",
        *,
        hop_relay: str = "relay",
        target_sysid: int | None = None,
    ) -> dict[str, Any]:
        """Fire-and-forget control frame over raw serial JSON."""
        if not self.enabled:
            raise RuntimeError("radio bridge not started")
        msg = make_ctrl(hop_relay, actions, stream, target_sysid=target_sysid)
        data = encode_line(msg)
        with self._lock:
            assert self._ser is not None
            self._ser.write(data)
            self._ser.flush()
        LOG.info(
            "radio ctrl tx id=%s actions=%s bytes=%d target_sysid=%s",
            msg.get("id"),
            ",".join(actions) or "(none)",
            len(data),
            target_sysid if target_sysid is not None else "any",
        )
        return msg
