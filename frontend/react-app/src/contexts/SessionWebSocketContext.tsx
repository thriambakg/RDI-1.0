/**
 * Persists one WebSocket per active session. Open when session is created (or when
 * user opens connection detail); close when session is paused or deleted.
 * Connection stays open until idle/delete so Ping only measures proxy + wavelength.
 */
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'

const LOG_PREFIX = '[RDI SessionWS]'
const CONNECT_TIMEOUT_MS = 15_000

type ConnectionState = 'connecting' | 'open' | 'closed' | 'failed'

export interface SessionWebSocketContextType {
  /** True if we have an open WebSocket for this session */
  isConnected: (sessionId: string) => boolean
  /** Get the open WebSocket for this session (readyState === OPEN) or null */
  getWs: (sessionId: string) => WebSocket | null
  /** Open a WebSocket for this session (idempotent if already open). Sends frontend:sessionId on open. */
  openSession: (sessionId: string, endpoint: string) => void
  /** Close and remove the WebSocket for this session */
  closeSession: (sessionId: string) => void
  /** Connection state for a session (for UI: green dot when 'open', red when 'failed') */
  connectionState: (sessionId: string) => ConnectionState
  /** Last error message for a session (when state is 'failed') */
  connectionError: (sessionId: string) => string | null
}

const SessionWebSocketContext = createContext<SessionWebSocketContextType | undefined>(undefined)

export function SessionWebSocketProvider({ children }: { children: ReactNode }) {
  const wsMapRef = useRef<Map<string, WebSocket>>(new Map())
  const timeoutRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const openedRef = useRef<Set<string>>(new Set())
  const failedMessageRef = useRef<Map<string, string>>(new Map())
  const [statusMap, setStatusMap] = useState<Record<string, ConnectionState>>({})
  const [errorMap, setErrorMap] = useState<Record<string, string>>({})

  const setStatus = useCallback((sessionId: string, state: ConnectionState, errorMessage?: string) => {
    setStatusMap((prev) => {
      if (state === 'closed' || state === 'failed') {
        const { [sessionId]: _, ...rest } = prev
        return { ...rest, ...(state === 'failed' ? { [sessionId]: 'failed' } : {}) }
      }
      return { ...prev, [sessionId]: state }
    })
    if (errorMessage != null) {
      setErrorMap((prev) => ({ ...prev, [sessionId]: errorMessage }))
    }
  }, [])

  const clearTimeoutForSession = useCallback((sessionId: string) => {
    const t = timeoutRef.current.get(sessionId)
    if (t) {
      clearTimeout(t)
      timeoutRef.current.delete(sessionId)
    }
  }, [])

  const openSession = useCallback((sessionId: string, endpoint: string) => {
    const existing = wsMapRef.current.get(sessionId)
    if (existing && existing.readyState === WebSocket.OPEN) {
      console.log(LOG_PREFIX, 'openSession: already open', { sessionId })
      return
    }

    clearTimeoutForSession(sessionId)
    if (existing) {
      try {
        existing.close()
      } catch {
        // ignore
      }
      wsMapRef.current.delete(sessionId)
    }

    const wsUrl = endpoint.replace(/^http/, 'ws')
    console.log(LOG_PREFIX, 'openSession: connecting', { sessionId, endpoint: wsUrl })
    setStatus(sessionId, 'connecting')
    setErrorMap((prev) => {
      const { [sessionId]: _, ...rest } = prev
      return rest
    })

    let ws: WebSocket
    try {
      ws = new WebSocket(wsUrl)
      ws.binaryType = 'arraybuffer' // Synchronous binary receive for accurate ping timing (avoids Blob->ArrayBuffer async)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(LOG_PREFIX, 'openSession: WebSocket constructor threw', { sessionId, error: msg })
      setStatus(sessionId, 'closed')
      return
    }

    wsMapRef.current.set(sessionId, ws)

    const timeoutId = setTimeout(() => {
      timeoutRef.current.delete(sessionId)
      const current = wsMapRef.current.get(sessionId)
      if (current === ws && current.readyState !== WebSocket.OPEN) {
        const msg = 'Connection timed out (15s). Check ALB and proxy — see docs/WEBSOCKET-ALB-DIAGNOSTIC.md'
        console.warn(LOG_PREFIX, 'openSession: connection timeout', { sessionId, endpoint: wsUrl })
        failedMessageRef.current.set(sessionId, msg)
        try {
          ws.close()
        } catch {
          // ignore
        }
        wsMapRef.current.delete(sessionId)
        setStatus(sessionId, 'failed', msg)
      }
    }, CONNECT_TIMEOUT_MS)
    timeoutRef.current.set(sessionId, timeoutId)

    ws.onopen = () => {
      clearTimeoutForSession(sessionId)
      openedRef.current.add(sessionId)
      console.log(LOG_PREFIX, 'openSession: connected', { sessionId })
      setStatus(sessionId, 'open')
      ws.send(`frontend:${sessionId}`)
    }

    ws.onclose = (event) => {
      clearTimeoutForSession(sessionId)
      wsMapRef.current.delete(sessionId)
      const hadOpened = openedRef.current.has(sessionId)
      openedRef.current.delete(sessionId)
      const reason = event.code !== 1000 ? ` (code ${event.code}${event.reason ? `: ${event.reason}` : ''})` : ''
      console.log(LOG_PREFIX, 'onclose', { sessionId, code: event.code, reason: event.reason, hadOpened })
      if (!hadOpened) {
        const existingMsg = failedMessageRef.current.get(sessionId)
        failedMessageRef.current.delete(sessionId)
        const msg =
          existingMsg ||
          (event.reason ? `Connection failed: ${event.reason}` : `Connection could not be established${reason}. Check ALB and proxy — see docs/WEBSOCKET-ALB-DIAGNOSTIC.md`)
        setStatus(sessionId, 'failed', msg)
      } else {
        setStatus(sessionId, 'closed')
      }
    }

    ws.onerror = () => {
      console.warn(LOG_PREFIX, 'onerror', { sessionId })
      // onclose will run after; we set 'failed' there if never opened
    }
  }, [setStatus, clearTimeoutForSession])

  const closeSession = useCallback((sessionId: string) => {
    clearTimeoutForSession(sessionId)
    openedRef.current.delete(sessionId)
    failedMessageRef.current.delete(sessionId)
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
    setErrorMap((prev) => {
      const { [sessionId]: _, ...rest } = prev
      return rest
    })
  }, [setStatus, clearTimeoutForSession])

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

  const connectionError = useCallback((sessionId: string): string | null => {
    return errorMap[sessionId] ?? null
  }, [errorMap])

  const value: SessionWebSocketContextType = {
    isConnected,
    getWs,
    openSession,
    closeSession,
    connectionState,
    connectionError,
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
