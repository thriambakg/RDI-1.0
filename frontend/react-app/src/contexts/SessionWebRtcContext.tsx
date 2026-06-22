import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  connectKvsViewer,
  type KvsViewerConnection,
  type WebRtcViewerBundle,
} from '../services/kvsWebRtcViewer'

/** Shorter wait when reconnecting — Pi worker is usually already on the channel. */
const WEBRTC_RECONNECT_PI_MS = 3000
/** ICE may recover briefly after tab backgrounding; reconnect after this grace. */
const ICE_DISCONNECTED_GRACE_MS = 4000
/** Stuck in connecting longer than connectKvsViewer timeout → force retry. */
const CONNECTING_STALE_MS = 50_000

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

function isIceHealthy(ice: RTCIceConnectionState): boolean {
  return ice === 'connected' || ice === 'completed' || ice === 'checking' || ice === 'new'
}

const SessionWebRtcContext = createContext<SessionWebRtcContextType | undefined>(undefined)

export function SessionWebRtcProvider({ children }: { children: ReactNode }) {
  const connectionsRef = useRef<Map<string, KvsViewerConnection>>(new Map())
  const abortRef = useRef<Map<string, AbortController>>(new Map())
  const [, bump] = useState(0)
  const stateRef = useRef<Map<string, WebRtcConnectionState>>(new Map())
  const errorRef = useRef<Map<string, string | null>>(new Map())
  const bundleRef = useRef<Map<string, WebRtcViewerBundle>>(new Map())
  const connectingSinceRef = useRef<Map<string, number>>(new Map())
  const healthCleanupRef = useRef<Map<string, () => void>>(new Map())
  const reconnectingRef = useRef<Set<string>>(new Set())

  const setState = useCallback((sessionId: string, state: WebRtcConnectionState, error?: string | null) => {
    stateRef.current.set(sessionId, state)
    errorRef.current.set(sessionId, error ?? null)
    bump((n) => n + 1)
  }, [])

  const detachHealthMonitor = useCallback((sessionId: string) => {
    healthCleanupRef.current.get(sessionId)?.()
    healthCleanupRef.current.delete(sessionId)
  }, [])

  const tearDownTransport = useCallback(
    (sessionId: string, options?: { clearBundle?: boolean }) => {
      detachHealthMonitor(sessionId)
      abortRef.current.get(sessionId)?.abort()
      abortRef.current.delete(sessionId)
      const conn = connectionsRef.current.get(sessionId)
      if (conn) {
        conn.close()
        connectionsRef.current.delete(sessionId)
      }
      viewerClientIdRef.current.delete(sessionId)
      channelArnRef.current.delete(sessionId)
      connectingSinceRef.current.delete(sessionId)
      if (options?.clearBundle !== false) {
        bundleRef.current.delete(sessionId)
        reconnectingRef.current.delete(sessionId)
      }
    },
    [detachHealthMonitor],
  )

  const closeSession = useCallback(
    (sessionId: string) => {
      tearDownTransport(sessionId, { clearBundle: true })
      setState(sessionId, 'closed', null)
    },
    [setState, tearDownTransport],
  )

  const viewerClientIdRef = useRef<Map<string, string>>(new Map())
  const channelArnRef = useRef<Map<string, string>>(new Map())
  const openSessionRef = useRef<
    (sessionId: string, bundle: WebRtcViewerBundle, options?: OpenWebRtcOptions) => void
  >(() => {})

  const attachHealthMonitor = useCallback(
    (sessionId: string, conn: KvsViewerConnection) => {
      detachHealthMonitor(sessionId)
      const pc = conn.peerConnection
      let disconnectedAt: number | null = null
      let graceTimer: ReturnType<typeof setTimeout> | null = null

      const triggerReconnect = (reason: string) => {
        if (reconnectingRef.current.has(sessionId)) return
        const bundle = bundleRef.current.get(sessionId)
        if (!bundle) return
        reconnectingRef.current.add(sessionId)
        console.log('[RDI WebRTC] reconnecting after idle', { session_id: sessionId, reason })
        tearDownTransport(sessionId, { clearBundle: false })
        setState(sessionId, 'connecting', null)
        openSessionRef.current(sessionId, bundle, {
          force: true,
          waitForPiMs: WEBRTC_RECONNECT_PI_MS,
        })
      }

      const clearGrace = () => {
        disconnectedAt = null
        if (graceTimer) {
          clearTimeout(graceTimer)
          graceTimer = null
        }
      }

      const onIce = () => {
        const ice = pc.iceConnectionState
        if (isIceHealthy(ice)) {
          clearGrace()
          return
        }
        if (ice === 'disconnected') {
          if (!disconnectedAt) disconnectedAt = Date.now()
          if (!graceTimer) {
            graceTimer = setTimeout(() => {
              graceTimer = null
              if (pc.iceConnectionState === 'disconnected') {
                triggerReconnect('ice disconnected')
              }
            }, ICE_DISCONNECTED_GRACE_MS)
          }
          return
        }
        if (ice === 'failed' || ice === 'closed') {
          triggerReconnect(`ice ${ice}`)
        }
      }

      const onConn = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          triggerReconnect(`peer ${pc.connectionState}`)
        }
      }

      pc.addEventListener('iceconnectionstatechange', onIce)
      pc.addEventListener('connectionstatechange', onConn)
      healthCleanupRef.current.set(sessionId, () => {
        pc.removeEventListener('iceconnectionstatechange', onIce)
        pc.removeEventListener('connectionstatechange', onConn)
        clearGrace()
      })
    },
    [detachHealthMonitor, setState, tearDownTransport],
  )

  const openSession = useCallback(
    (sessionId: string, bundle: WebRtcViewerBundle, options?: OpenWebRtcOptions) => {
      const force = options?.force === true
      const waitForPiMs = Math.max(0, options?.waitForPiMs ?? 0)
      const existing = stateRef.current.get(sessionId) ?? 'closed'
      const sameChannel = channelArnRef.current.get(sessionId) === bundle.channel_arn
      const connectingSince = connectingSinceRef.current.get(sessionId)
      const connectingStale =
        existing === 'connecting' &&
        connectingSince != null &&
        Date.now() - connectingSince > CONNECTING_STALE_MS

      if (!force && !connectingStale) {
        if (existing === 'connecting' && sameChannel) return
        if (existing === 'connected' && sameChannel) {
          const conn = connectionsRef.current.get(sessionId)
          if (conn && isIceHealthy(conn.peerConnection.iceConnectionState)) return
        }
      }

      bundleRef.current.set(sessionId, bundle)
      tearDownTransport(sessionId, { clearBundle: false })
      channelArnRef.current.set(sessionId, bundle.channel_arn)
      connectingSinceRef.current.set(sessionId, Date.now())

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
          connectingSinceRef.current.delete(sessionId)
          reconnectingRef.current.delete(sessionId)
          setState(sessionId, 'connected', null)
          attachHealthMonitor(sessionId, conn)
        } catch (e) {
          if (controller.signal.aborted) return
          connectingSinceRef.current.delete(sessionId)
          reconnectingRef.current.delete(sessionId)
          const message = e instanceof Error ? e.message : 'WebRTC connection failed'
          setState(sessionId, 'failed', message)
        }
      })()
    },
    [attachHealthMonitor, setState, tearDownTransport],
  )

  openSessionRef.current = openSession

  useEffect(() => {
    const recheckSessions = () => {
      if (document.visibilityState !== 'visible') return

      for (const [sessionId, conn] of connectionsRef.current.entries()) {
        const ice = conn.peerConnection.iceConnectionState
        if (isIceHealthy(ice)) continue
        const bundle = bundleRef.current.get(sessionId)
        if (!bundle || reconnectingRef.current.has(sessionId)) continue
        console.log('[RDI WebRTC] tab visible — stale ice, reconnecting', {
          session_id: sessionId,
          ice,
        })
        openSessionRef.current(sessionId, bundle, {
          force: true,
          waitForPiMs: WEBRTC_RECONNECT_PI_MS,
        })
      }

      const now = Date.now()
      for (const [sessionId, since] of connectingSinceRef.current.entries()) {
        if (now - since <= CONNECTING_STALE_MS) continue
        const bundle = bundleRef.current.get(sessionId)
        if (!bundle || reconnectingRef.current.has(sessionId)) continue
        console.log('[RDI WebRTC] tab visible — connecting stale, retrying', { session_id: sessionId })
        openSessionRef.current(sessionId, bundle, {
          force: true,
          waitForPiMs: WEBRTC_RECONNECT_PI_MS,
        })
      }
    }

    document.addEventListener('visibilitychange', recheckSessions)
    return () => document.removeEventListener('visibilitychange', recheckSessions)
  }, [])

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
