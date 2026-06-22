/** Session data-plane transport from Session API. */

/** Wait before browser WebRTC offer so Pi daemon can poll + spawn KVS worker. */
export const WEBRTC_PI_READY_MS = 12000

export type SessionTransport = 'webrtc' | 'websocket'

export function getSessionTransport(data?: { transport?: string }): SessionTransport {
  return data?.transport === 'webrtc' ? 'webrtc' : 'websocket'
}

export function usesWebSocketTransport(data?: { transport?: string }): boolean {
  return getSessionTransport(data) === 'websocket'
}
