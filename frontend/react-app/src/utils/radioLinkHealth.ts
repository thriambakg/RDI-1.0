/**
 * Shared radio link-health policy for N connections on one half-duplex relay.
 * No per-sysid branches — cadence/phase come from session id only.
 */

export const RADIO_LINK_HEALTH = {
  /** Idle CTRL heartbeat interval while this connection is the active controller. */
  idleHbMs: 12_000,
  /** How long to wait for rdi_link_rtt after an idle/arming hb. */
  ackWaitMs: 5_000,
  /** Soft-retry delay after a single missed ACK (still Armed). */
  softRetryMs: 2_500,
  /** Consecutive misses (while active) before Standby + error. */
  missLimit: 5,
  /**
   * Spread first-probe / idle phases across this window using a session hash so
   * N peers on one radio do not TX heartbeats in lockstep.
   */
  phaseSpanMs: 10_000,
} as const

/** Deterministic phase in [0, spanMs) from session id (stable across remounts). */
export function radioLinkPhaseOffsetMs(
  sessionId: string,
  spanMs: number = RADIO_LINK_HEALTH.phaseSpanMs,
): number {
  let h = 2166136261
  for (let i = 0; i < sessionId.length; i++) {
    h ^= sessionId.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h >>> 0) % Math.max(1, spanMs)
}

/** ms until next idle hb is due (0 = send now). */
export function radioLinkIdleDueInMs(
  lastRttAt: number,
  sessionId: string,
  now: number = Date.now(),
): number {
  if (lastRttAt <= 0) {
    // First arm: small base + phase so N windows do not all probe at T+0.
    return 250 + radioLinkPhaseOffsetMs(sessionId, 2_000)
  }
  return Math.max(0, lastRttAt + RADIO_LINK_HEALTH.idleHbMs - now)
}
