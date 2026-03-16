/**
 * Persists one WebSocket per active session. Open when session is created (or when
 * user opens connection detail); close when session is paused or deleted.
 * Connection stays open until idle/delete so Ping only measures proxy + wavelength.
 */
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'

type ConnectionState = 'connecting' | 'open' | 'closed'

export interface SessionWebSocketContextType {
  /** True if we have an open WebSocket for this session */
  isConnected: (sessionId: string) => boolean
  /** Get the open WebSocket for this session (readyState === OPEN) or null */
  getWs: (sessionId: string) => WebSocket | null
  /** Open a WebSocket for this session (idempotent if already open). Sends frontend:sessionId on open. */
  openSession: (sessionId: string, endpoint: string) => void
  /** Close and remove the WebSocket for this session */
  closeSession: (sessionId: string) => void
  /** Connection state for a session (for UI: green dot when 'open') */
  connectionState: (sessionId: string) => ConnectionState
}

const SessionWebSocketContext = createContext<SessionWebSocketContextType | undefined>(undefined)

export function SessionWebSocketProvider({ children }: { children: ReactNode }) {
  const wsMapRef = useRef<Map<string, WebSocket>>(new Map())
  const [statusMap, setStatusMap] = useState<Record<string, ConnectionState>>({})

  const setStatus = useCallback((sessionId: string, state: ConnectionState) => {
    setStatusMap((prev) => {
      if (state === 'closed') {
        const { [sessionId]: _, ...rest } = prev
        return rest
      }
      return { ...prev, [sessionId]: state }
    })
  }, [])

  const openSession = useCallback((sessionId: string, endpoint: string) => {
    const existing = wsMapRef.current.get(sessionId)
    if (existing && existing.readyState === WebSocket.OPEN) return

    if (existing) {
      try {
        existing.close()
      } catch {
        // ignore
      }
      wsMapRef.current.delete(sessionId)
    }

    const wsUrl = endpoint.replace(/^http/, 'ws')
    setStatus(sessionId, 'connecting')
    let ws: WebSocket
    try {
      ws = new WebSocket(wsUrl)
    } catch (e) {
      console.error('[RDI SessionWS] Failed to create WebSocket', e)
      setStatus(sessionId, 'closed')
      return
    }

    wsMapRef.current.set(sessionId, ws)

    ws.onopen = () => {
      setStatus(sessionId, 'open')
      ws.send(`frontend:${sessionId}`)
    }

    ws.onclose = () => {
      wsMapRef.current.delete(sessionId)
      setStatus(sessionId, 'closed')
    }

    ws.onerror = () => {
      // onclose will run after; we'll clean up there
    }
  }, [setStatus])

  const closeSession = useCallback((sessionId: string) => {
    const ws = wsMapRef.current.get(sessionId)
    if (ws) {
      try {
        if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
          ws.close()
        }
      } catch {
        // ignore
      }
      wsMapRef.current.delete(sessionId)
    }
    setStatus(sessionId, 'closed')
  }, [setStatus])

  const getWs = useCallback((sessionId: string): WebSocket | null => {
    const ws = wsMapRef.current.get(sessionId)
    return ws && ws.readyState === WebSocket.OPEN ? ws : null
  }, [])

  const isConnected = useCallback((sessionId: string) => {
    return statusMap[sessionId] === 'open'
  }, [statusMap])

  const connectionState = useCallback((sessionId: string): ConnectionState => {
    return statusMap[sessionId] ?? 'closed'
  }, [statusMap])

  const value: SessionWebSocketContextType = {
    isConnected,
    getWs,
    openSession,
    closeSession,
    connectionState,
  }

  return (
    <SessionWebSocketContext.Provider value={value}>
      {children}
    </SessionWebSocketContext.Provider>
  )
}

export function useSessionWebSocket() {
  const ctx = useContext(SessionWebSocketContext)
  if (!ctx) throw new Error('useSessionWebSocket must be used within SessionWebSocketProvider')
  return ctx
}
