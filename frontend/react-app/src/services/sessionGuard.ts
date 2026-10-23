/**
 * Single-login: when APIs return SESSION_SUPERSEDED, notify AuthContext to sign out.
 * Also tear down live WebRTC / WS transports on logout or supersede.
 */

export const SESSION_SUPERSEDED_EVENT = 'rdi:session-superseded'
/** Fired on explicit logout or session supersede — close all live connections. */
export const AUTH_TRANSPORT_TEARDOWN_EVENT = 'rdi:auth-transport-teardown'

export function isSessionSuperseded(status: number, body: unknown): boolean {
  if (status !== 401) return false
  const code = (body as { code?: string } | null)?.code
  return code === 'SESSION_SUPERSEDED'
}

export function notifyTransportTeardown(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(AUTH_TRANSPORT_TEARDOWN_EVENT))
}

export function notifySessionSuperseded(): void {
  if (typeof window === 'undefined') return
  notifyTransportTeardown()
  window.dispatchEvent(new CustomEvent(SESSION_SUPERSEDED_EVENT))
}

/** Call after parsing an error JSON body from a failed API response. */
export function checkSessionSuperseded(status: number, body: unknown): void {
  if (isSessionSuperseded(status, body)) {
    notifySessionSuperseded()
  }
}
