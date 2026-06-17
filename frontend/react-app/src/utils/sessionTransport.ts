/** Session data-plane transport from Session API. */

export type SessionTransport = 'webrtc' | 'websocket'

export function getSessionTransport(data?: { transport?: string }): SessionTransport {
  return data?.transport === 'webrtc' ? 'webrtc' : 'websocket'
}

export function usesWebSocketTransport(data?: { transport?: string }): boolean {
  return getSessionTransport(data) === 'websocket'
}
