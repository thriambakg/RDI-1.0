import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  connectKvsViewer,
  type KvsViewerConnection,
  type WebRtcViewerBundle,
} from '../services/kvsWebRtcViewer'

export type WebRtcConnectionState = 'closed' | 'connecting' | 'connected' | 'failed'

export interface OpenWebRtcOptions {
  /** Tear down any existing attempt and connect again (e.g. after reactivate + new KVS channel). */
  force?: boolean
  /** Wait for Pi relay daemon poll + KVS worker before opening viewer (default 0). */
  waitForPiMs?: number
}

export interface SessionWebRtcContextType {
  openSession: (sessionId: string, bundle: WebRtcViewerBundle, options?: OpenWebRtcOptions) => void
  closeSession: (sessionId: string) => void
  getDataChannel: (sessionId: string) => RTCDataChannel | null
  connectionState: (sessionId: string) => WebRtcConnectionState
  connectionError: (sessionId: string) => string | null
}

const SessionWebRtcContext = createContext<SessionWebRtcContextType | undefined>(undefined)

export function SessionWebRtcProvider({ children }: { children: ReactNode }) {
  const connectionsRef = useRef<Map<string, KvsViewerConnection>>(new Map())
  const abortRef = useRef<Map<string, AbortController>>(new Map())
  const [, bump] = useState(0)
  const stateRef = useRef<Map<string, WebRtcConnectionState>>(new Map())
  const errorRef = useRef<Map<string, string | null>>(new Map())

  const setState = useCallback((sessionId: string, state: WebRtcConnectionState, error?: string | null) => {
    stateRef.current.set(sessionId, state)
    errorRef.current.set(sessionId, error ?? null)
    bump((n) => n + 1)
  }, [])

  const closeSession = useCallback(
    (sessionId: string) => {
      abortRef.current.get(sessionId)?.abort()
      abortRef.current.delete(sessionId)
      const conn = connectionsRef.current.get(sessionId)
      if (conn) {
        conn.close()
        connectionsRef.current.delete(sessionId)
      }
      viewerClientIdRef.current.delete(sessionId)
      channelArnRef.current.delete(sessionId)
      setState(sessionId, 'closed', null)
    },
    [setState],
  )

  const viewerClientIdRef = useRef<Map<string, string>>(new Map())
  const channelArnRef = useRef<Map<string, string>>(new Map())

  const openSession = useCallback(
    (sessionId: string, bundle: WebRtcViewerBundle, options?: OpenWebRtcOptions) => {
      const force = options?.force === true
      const waitForPiMs = Math.max(0, options?.waitForPiMs ?? 0)
      const existing = stateRef.current.get(sessionId) ?? 'closed'
      const sameChannel = channelArnRef.current.get(sessionId) === bundle.channel_arn

      if (!force) {
        if (existing === 'connecting' && sameChannel) return
        if (existing === 'connected' && sameChannel) return
      }

      closeSession(sessionId)
      channelArnRef.current.set(sessionId, bundle.channel_arn)
      const controller = new AbortController()
      abortRef.current.set(sessionId, controller)
      setState(sessionId, 'connecting', null)

      const viewerClientId = `viewer-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
      viewerClientIdRef.current.set(sessionId, viewerClientId)

      console.log('[RDI WebRTC] opening session', {
        session_id: sessionId,
        force,
        waitForPiMs,
        channel: bundle.channel_arn.slice(-36),
      })

      void (async () => {
        if (waitForPiMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, waitForPiMs))
          if (controller.signal.aborted) return
        }

        console.log('[RDI WebRTC] starting KVS viewer connect', { session_id: sessionId, viewerClientId })

        try {
          const conn = await connectKvsViewer(bundle, { signal: controller.signal, viewerClientId })
          if (controller.signal.aborted) {
            conn.close()
            return
          }
          connectionsRef.current.set(sessionId, conn)
          setState(sessionId, 'connected', null)
        } catch (e) {
          if (controller.signal.aborted) return
          const message = e instanceof Error ? e.message : 'WebRTC connection failed'
          setState(sessionId, 'failed', message)
        }
      })()
    },
    [closeSession, setState],
  )

  const getDataChannel = useCallback((sessionId: string) => {
    const conn = connectionsRef.current.get(sessionId)
    const ch = conn?.dataChannel
    return ch && ch.readyState === 'open' ? ch : null
  }, [])

  const connectionState = useCallback((sessionId: string): WebRtcConnectionState => {
    return stateRef.current.get(sessionId) ?? 'closed'
  }, [])

  const connectionError = useCallback((sessionId: string): string | null => {
    return errorRef.current.get(sessionId) ?? null
  }, [])

  const value: SessionWebRtcContextType = {
    openSession,
    closeSession,
    getDataChannel,
    connectionState,
    connectionError,
  }

  return <SessionWebRtcContext.Provider value={value}>{children}</SessionWebRtcContext.Provider>
}

export function useSessionWebRtc() {
  const ctx = useContext(SessionWebRtcContext)
  if (!ctx) throw new Error('useSessionWebRtc must be used within SessionWebRtcProvider')
  return ctx
}
