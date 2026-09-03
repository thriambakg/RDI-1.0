"""MAVLink TUNNEL bridge: Pi /dev/serial0 (TELEM2) ↔ PX4 ↔ TELEM1 radio.

Wraps our hop JSON inside MAVLink TUNNEL messages so PX4 can forward them
between the companion UART and the air radio without a second FTDI.
"""

from __future__ import annotations

import asyncio
import logging
import os
import threading
import time
from typing import Any

# TUNNEL exists only in MAVLink 2 dialects; must be set before pymavlink import.
os.environ["MAVLINK20"] = "1"

from radio_hop_protocol import (
    compact_ctrl_ack_for_tunnel,
    compact_ctrl_for_tunnel,
    compact_hop_msg_for_tunnel,
    decode_line,
    encode_line,
    make_ctrl,
    make_ping,
)

LOG = logging.getLogger("rdi.radio_mavlink")

# Custom payload type so we can ignore unrelated TUNNEL traffic.
RDI_TUNNEL_PAYLOAD_TYPE = 201
TUNNEL_PAYLOAD_MAX = 128
# Companion / GCS-like ids; PX4 routes broadcast (0) to other instances when FORWARD=1.
SOURCE_SYSTEM = 255
SOURCE_COMPONENT = 190


def _pack_payload(msg: dict[str, Any]) -> bytes:
    # CTRL must NOT use the ping hop-compaction path (that drops actions → false "release").
    if msg.get("type") == "ctrl":
        compact = compact_ctrl_for_tunnel(msg)
        raw = encode_line(compact).rstrip(b"\n")
        if len(raw) > TUNNEL_PAYLOAD_MAX:
            # Drop stream keys first — actions matter more.
            compact.pop("s", None)
            raw = encode_line(compact).rstrip(b"\n")
        if len(raw) > TUNNEL_PAYLOAD_MAX:
            raise ValueError(f"ctrl payload too large for TUNNEL ({len(raw)} > {TUNNEL_PAYLOAD_MAX})")
        LOG.debug("ctrl tunnel compacted to %d bytes actions=%s", len(raw), compact.get("a"))
        return raw

    if msg.get("type") == "ctrl_ack":
        compact = compact_ctrl_ack_for_tunnel(msg)
        raw = encode_line(compact).rstrip(b"\n")
        if len(raw) > TUNNEL_PAYLOAD_MAX:
            raise ValueError(f"ctrl_ack too large for TUNNEL ({len(raw)} > {TUNNEL_PAYLOAD_MAX})")
        return raw

    if msg.get("type") in ("ping", "pong"):
        # Always compact — float hop timestamps alone blow the 128-byte TUNNEL limit.
        compact = compact_hop_msg_for_tunnel(msg)
        raw = encode_line(compact).rstrip(b"\n")
        while len(raw) > TUNNEL_PAYLOAD_MAX and compact.get("hops"):
            compact["hops"] = compact["hops"][1:]  # drop oldest hop
            raw = encode_line(compact).rstrip(b"\n")
        if len(raw) > TUNNEL_PAYLOAD_MAX:
            compact.pop("sid", None)
            raw = encode_line(compact).rstrip(b"\n")
        if len(raw) > TUNNEL_PAYLOAD_MAX:
            raise ValueError(f"hop payload too large for TUNNEL ({len(raw)} > {TUNNEL_PAYLOAD_MAX})")
        return raw

    raw = encode_line(msg).rstrip(b"\n")
    if len(raw) > TUNNEL_PAYLOAD_MAX:
        raise ValueError(f"payload too large for TUNNEL ({len(raw)} > {TUNNEL_PAYLOAD_MAX})")
    return raw


def _unpack_payload(payload: bytes, length: int) -> dict[str, Any] | None:
    data = bytes(payload[: max(0, int(length))])
    # Allow missing trailing newline from TUNNEL packing.
    if data and not data.endswith(b"\n"):
        data = data + b"\n"
    # decode_line already expands compact hop/ctrl fields.
    return decode_line(data)


class RadioMavlinkBridge:
    """Background MAVLink reader + asyncio waiters for hop ping over TUNNEL."""

    def __init__(self, port: str, baud: int = 921600, timeout_sec: float = 8.0):
        self.port = port
        self.baud = baud
        self.timeout_sec = timeout_sec
        self._conn = None
        self._thread: threading.Thread | None = None
        self._hb_thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._pending: dict[str, asyncio.Future] = {}
        self._pending_ctrl: dict[str, asyncio.Future] = {}
        self._ctrl_t0: dict[str, float] = {}
        self._loop: asyncio.AbstractEventLoop | None = None

    @property
    def enabled(self) -> bool:
        return self._conn is not None

    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        from pymavlink import mavutil

        self._loop = loop
        self._conn = mavutil.mavlink_connection(
            self.port,
            baud=self.baud,
            source_system=SOURCE_SYSTEM,
            source_component=SOURCE_COMPONENT,
            autoreconnect=True,
        )
        self._stop.clear()
        self._thread = threading.Thread(target=self._reader, name="rdi-mav-rx", daemon=True)
        self._hb_thread = threading.Thread(target=self._heartbeat, name="rdi-mav-hb", daemon=True)
        self._thread.start()
        self._hb_thread.start()
        LOG.info("mavlink bridge open port=%s baud=%s", self.port, self.baud)

    def stop(self) -> None:
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2)
        if self._hb_thread and self._hb_thread.is_alive():
            self._hb_thread.join(timeout=2)
        self._thread = None
        self._hb_thread = None
        if self._conn is not None:
            try:
                self._conn.close()
            except Exception:
                pass
            self._conn = None
        for fut in list(self._pending.values()):
            if not fut.done():
                fut.set_exception(TimeoutError("mavlink bridge stopped"))
        self._pending.clear()
        for fut in list(self._pending_ctrl.values()):
            if not fut.done():
                fut.set_exception(TimeoutError("mavlink bridge stopped"))
        self._pending_ctrl.clear()
        self._ctrl_t0.clear()
        LOG.info("mavlink bridge closed")

    def _heartbeat(self) -> None:
        from pymavlink import mavutil

        while not self._stop.is_set():
            try:
                with self._lock:
                    if self._conn is not None:
                        self._conn.mav.heartbeat_send(
                            mavutil.mavlink.MAV_TYPE_ONBOARD_CONTROLLER,
                            mavutil.mavlink.MAV_AUTOPILOT_INVALID,
                            0,
                            0,
                            0,
                        )
            except Exception as e:
                if not self._stop.is_set():
                    LOG.warning("mavlink heartbeat error: %s", e)
            self._stop.wait(1.0)

    def _reader(self) -> None:
        while not self._stop.is_set():
            try:
                if self._conn is None:
                    time.sleep(0.1)
                    continue
                msg = self._conn.recv_match(type="TUNNEL", blocking=True, timeout=0.2)
                if msg is None:
                    continue
                if int(getattr(msg, "payload_type", -1)) != RDI_TUNNEL_PAYLOAD_TYPE:
                    continue
                decoded = _unpack_payload(bytes(msg.payload), int(msg.payload_length))
                if not decoded:
                    continue
                msg_type = decoded.get("type")
                if msg_type == "ctrl_ack":
                    ack_id = str(decoded.get("id") or "")
                    fut = self._pending_ctrl.get(ack_id)
                    if fut and self._loop and not fut.done():
                        LOG.info(
                            "mavlink tunnel ctrl_ack MATCH id=%s pending_ctrl=%s",
                            ack_id,
                            [k for k in self._pending_ctrl if k != ack_id],
                        )
                        self._loop.call_soon_threadsafe(fut.set_result, decoded)
                    else:
                        LOG.debug(
                            "mavlink tunnel ctrl_ack UNMATCHED id=%s pending_ctrl=%s",
                            ack_id,
                            list(self._pending_ctrl.keys()),
                        )
                    continue
                if msg_type != "pong":
                    # Non-pong TUNNEL (ping/ctrl loopback) — useful when diagnosing
                    # whether return path or only outbound is alive.
                    if msg_type in ("ping", "ctrl"):
                        LOG.debug(
                            "mavlink tunnel rx type=%s id=%s sid=%s pending=%s",
                            msg_type,
                            decoded.get("id"),
                            decoded.get("target_sysid", decoded.get("sid")),
                            list(self._pending.keys()),
                        )
                    continue
                ping_id = str(decoded.get("id") or "")
                fut = self._pending.get(ping_id)
                if fut and self._loop and not fut.done():
                    LOG.info(
                        "mavlink tunnel pong MATCH id=%s pending_left=%s",
                        ping_id,
                        [k for k in self._pending if k != ping_id],
                    )
                    self._loop.call_soon_threadsafe(fut.set_result, decoded)
                else:
                    LOG.warning(
                        "mavlink tunnel pong UNMATCHED id=%s pending=%s "
                        "(late/duplicate/collision — Pi timed out or wrong id)",
                        ping_id,
                        list(self._pending.keys()),
                    )
            except Exception as e:
                if not self._stop.is_set():
                    LOG.warning("mavlink rx error: %s", e)
                    time.sleep(0.2)

    def _send_tunnel(self, hop_msg: dict[str, Any]) -> int:
        raw = _pack_payload(hop_msg)
        payload = raw + b"\x00" * (TUNNEL_PAYLOAD_MAX - len(raw))
        with self._lock:
            assert self._conn is not None
            mav = self._conn.mav
            if not hasattr(mav, "tunnel_send"):
                raise RuntimeError(
                    "pymavlink lacks tunnel_send (need MAVLINK20=1 / MAVLink 2 dialect). "
                    f"dialect={getattr(mav, '__module__', '?')}"
                )
            # Always MAVLink-broadcast (0). Per-vehicle addressing lives in the JSON
            # `target_sysid` field — addressing TUNNEL at sysid=1 (FC) stops PX4 from
            # forwarding TELEM2→TELEM1, so radio ping never reaches the desktop agent.
            mav.tunnel_send(
                0,
                0,
                RDI_TUNNEL_PAYLOAD_TYPE,
                len(raw),
                payload,
            )
        return len(raw)

    async def roundtrip_ping(
        self,
        hop_relay: str = "relay",
        target_sysid: int | None = None,
    ) -> dict[str, Any]:
        if not self.enabled or self._loop is None:
            raise RuntimeError("mavlink bridge not started")

        msg = make_ping(hop_relay, target_sysid=target_sysid)
        ping_id = str(msg["id"])
        fut: asyncio.Future = self._loop.create_future()
        already = list(self._pending.keys())
        self._pending[ping_id] = fut
        t0 = time.time()
        try:
            nbytes = self._send_tunnel(msg)
            LOG.info(
                "mavlink tunnel ping tx id=%s bytes=%d target_sysid=%s concurrent_pending=%s",
                ping_id,
                nbytes,
                target_sysid if target_sysid is not None else "any",
                already,
            )
            # Brief TX→RX settle on local RFD (RX thread still runs during sleep).
            settle_ms = 15.0
            await asyncio.sleep(settle_ms / 1000.0)
            pong = await asyncio.wait_for(fut, timeout=self.timeout_sec)
            hops = list(pong.get("hops") or [])
            hops.append({"hop": hop_relay, "ts": time.time()})
            # Wall from TX; air excludes intentional desktop turnaround (+ settle + retry gap).
            wall_ms = (time.time() - t0) * 1000.0
            try:
                ta = int(pong.get("turnaround_ms") or 0)
            except (TypeError, ValueError):
                ta = 0
            try:
                retry_ms = int(pong.get("retry_ms") or 0)
            except (TypeError, ValueError):
                retry_ms = 0
            air_ms = max(0.0, wall_ms - ta - settle_ms - retry_ms)
            pong = {
                **pong,
                "hops": hops,
                "rtt_ms": round(wall_ms, 1),
                "air_rtt_ms": round(air_ms, 1),
                "turnaround_ms": ta,
                "retry_ms": retry_ms,
            }
            LOG.info(
                "mavlink tunnel pong rx id=%s wall_ms=%.0f air_ms=%.0f ta=%d rr=%d target_sysid=%s",
                ping_id,
                wall_ms,
                air_ms,
                ta,
                retry_ms,
                target_sysid if target_sysid is not None else "any",
            )
            return pong
        except asyncio.TimeoutError as e:
            LOG.warning(
                "mavlink tunnel ping TIMEOUT id=%s target_sysid=%s waited=%.1fs "
                "still_pending=%s (desktop may have echoed — check return path)",
                ping_id,
                target_sysid if target_sysid is not None else "any",
                time.time() - t0,
                list(self._pending.keys()),
            )
            raise TimeoutError(
                f"no TUNNEL pong within {self.timeout_sec}s "
                f"(id={ping_id} sysid={target_sysid}; "
                f"check PX4 MAV_0/1_FORWARD, SER_TEL* baud, radio link)"
            ) from e
        finally:
            self._pending.pop(ping_id, None)

    def send_ctrl(
        self,
        actions: list[str],
        stream: str = "",
        *,
        hop_relay: str = "relay",
        target_sysid: int | None = None,
        stack: str = "",
        pipe: str = "",
    ) -> dict[str, Any]:
        """TX CTRL over TUNNEL and register a waiter for desktop ctrl_ack (RTT)."""
        if not self.enabled:
            raise RuntimeError("mavlink bridge not started")
        msg = compact_ctrl_for_tunnel(
            make_ctrl(
                hop_relay,
                actions,
                stream,
                target_sysid=target_sysid,
                stack=stack,
                pipe=pipe or "radio_mavlink",
            )
        )
        ctrl_id = str(msg.get("id") or "")
        if self._loop is not None and ctrl_id:
            # Cap pending waiters so a dead agent cannot grow memory forever.
            while len(self._pending_ctrl) >= 24:
                old_id, old_fut = next(iter(self._pending_ctrl.items()))
                self._pending_ctrl.pop(old_id, None)
                self._ctrl_t0.pop(old_id, None)
                if old_fut and not old_fut.done():
                    old_fut.set_exception(TimeoutError("ctrl_ack waiter evicted"))
            fut: asyncio.Future = self._loop.create_future()
            self._pending_ctrl[ctrl_id] = fut
            self._ctrl_t0[ctrl_id] = time.time()
        nbytes = self._send_tunnel(msg)
        LOG.info(
            "mavlink tunnel ctrl tx id=%s actions=%s stack=%s pipe=%s bytes=%d target_sysid=%s",
            msg.get("id"),
            ",".join(actions) or "(none)",
            stack or "—",
            msg.get("pp") or pipe or "—",
            nbytes,
            target_sysid if target_sysid is not None else "any",
        )
        return msg

    async def wait_ctrl_ack(self, ctrl_id: str, timeout_sec: float = 2.0) -> dict[str, Any]:
        """Wait for desktop ctrl_ack matching ctrl_id; returns ack + rtt_ms."""
        cid = str(ctrl_id or "")
        fut = self._pending_ctrl.get(cid)
        if fut is None:
            raise TimeoutError(f"no ctrl_ack waiter for id={cid}")
        t0 = self._ctrl_t0.get(cid, time.time())
        try:
            ack = await asyncio.wait_for(fut, timeout=timeout_sec)
            wall_ms = (time.time() - t0) * 1000.0
            try:
                ta = int(ack.get("turnaround_ms") or ack.get("ta") or 0)
            except (TypeError, ValueError):
                ta = 0
            air_ms = max(0.0, wall_ms - ta)
            return {
                **ack,
                "rtt_ms": round(wall_ms, 1),
                "air_rtt_ms": round(air_ms, 1),
                "turnaround_ms": ta,
            }
        except asyncio.TimeoutError as e:
            raise TimeoutError(f"no ctrl_ack within {timeout_sec}s (id={cid})") from e
        finally:
            self._pending_ctrl.pop(cid, None)
            self._ctrl_t0.pop(cid, None)
