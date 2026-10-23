import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import {
  parseCtrlAck,
  parseLinkRtt,
  pipeLabelForCtrl,
  sendCtrlFrame,
  type ControlPath,
  type LivePingState,
} from '../utils/rdiControl'
import {
  RADIO_LINK_HEALTH,
  radioLinkIdleDueInMs,
} from '../utils/radioLinkHealth'
import { pingDataChannel } from '../utils/rdiPing'

type Args = {
  open: boolean
  sessionId: string | undefined
  /** True when this window may TX probes / sticks (focused controls). */
  isActiveController: boolean
  controlPath: ControlPath
  transmitting: boolean
  pingRunning: boolean
  vehicleStack?: string
  linkMode?: string
  usesWebSocket: boolean
  webRtcConnected: boolean
  getDataChannel: (sessionId: string) => RTCDataChannel | null | undefined
  addLog: (line: string) => void
}

/**
 * Per-connection link meter. Same code path for every drone on a shared relay:
 * - Arm on first RF RTT (idle hb or stick CTRL-ACK)
 * - Stay Armed with last RTT while inactive (blur) — no probes, no miss counting
 * - While active + idle: silent hb on a fixed interval (phase from session id)
 * - Standby only after consecutive misses while active, or channel loss
 */
export function useRadioLinkHealth({
  open,
  sessionId,
  isActiveController,
  controlPath,
  transmitting,
  pingRunning,
  vehicleStack,
  linkMode,
  usesWebSocket,
  webRtcConnected,
  getDataChannel,
  addLog,
}: Args): {
  radioLinkArmed: boolean
  livePing: LivePingState
  setLivePing: Dispatch<SetStateAction<LivePingState>>
  pingError: string | null
  setPingError: Dispatch<SetStateAction<string | null>>
} {
  const [radioLinkArmed, setRadioLinkArmed] = useState(false)
  const [livePing, setLivePing] = useState<LivePingState>({
    ms: null,
    status: 'idle',
    path: controlPath,
  })
  const [pingError, setPingError] = useState<string | null>(null)

  const linkRttEwmaRef = useRef<number | null>(null)
  const lastRadioRttAtRef = useRef(0)
  const expectByRef = useRef(0)
  const missesRef = useRef(0)
  const controlPathRef = useRef(controlPath)
  controlPathRef.current = controlPath
  const activeRef = useRef(isActiveController)
  activeRef.current = isActiveController
  const transmittingRef = useRef(transmitting)
  transmittingRef.current = transmitting
  const pingRunningRef = useRef(pingRunning)
  pingRunningRef.current = pingRunning
  const vehicleStackRef = useRef(vehicleStack)
  vehicleStackRef.current = vehicleStack
  const linkModeRef = useRef(linkMode)
  linkModeRef.current = linkMode
  const webRtcConnectedRef = useRef(webRtcConnected)
  webRtcConnectedRef.current = webRtcConnected

  // CTRL delivery ack (local) + RF RTT samples.
  useEffect(() => {
    if (!open || !sessionId || usesWebSocket) return
    const channel = getDataChannel(sessionId)
    if (!channel) return

    const onMessage = (event: MessageEvent) => {
      const link = parseLinkRtt(event.data)
      if (link && link.path === 'radio') {
        const sample =
          typeof link.rtt_ms === 'number' && Number.isFinite(link.rtt_ms)
            ? Math.round(link.rtt_ms)
            : typeof link.air_rtt_ms === 'number' && Number.isFinite(link.air_rtt_ms)
              ? Math.round(link.air_rtt_ms)
              : null
        if (sample != null) {
          const prev = linkRttEwmaRef.current
          const ewma = prev == null ? sample : Math.round(0.35 * sample + 0.65 * prev)
          linkRttEwmaRef.current = ewma
          lastRadioRttAtRef.current = Date.now()
          expectByRef.current = 0
          missesRef.current = 0
          setRadioLinkArmed(true)
          setPingError(null)
          if (controlPathRef.current === 'radio') {
            setLivePing({ ms: ewma, status: 'live', path: 'radio' })
          }
        }
        return
      }

      const ack = parseCtrlAck(event.data)
      if (!ack) return
      const pipeTag = ack.pipe || ack.path
      const stackTag = ack.stack ? `|${ack.stack}` : ''
      if (ack.error) {
        addLog(`[ctrl ack] ${pipeTag}${stackTag}: ${ack.error}`)
      } else if (ack.actions?.length) {
        addLog(`[ctrl ack] ${pipeTag}${stackTag} ok · ${ack.actions.join(' + ')}`)
      }
    }
    channel.addEventListener('message', onMessage)
    return () => channel.removeEventListener('message', onMessage)
  }, [open, sessionId, usesWebSocket, webRtcConnected, getDataChannel, addLog])

  // Probe loop — reset only on sessionId / controlPath / open (not session JSON refresh).
  useEffect(() => {
    if (!open || !sessionId || usesWebSocket) return

    let cancelled = false
    let timer: number | undefined
    let watchTimer: number | undefined
    let inFlight = false

    const schedule = (ms: number) => {
      if (cancelled) return
      timer = window.setTimeout(() => {
        void tick()
      }, Math.max(50, ms))
    }

    const failRadio = (why: 'timeout' | 'error', detail: string) => {
      expectByRef.current = 0
      lastRadioRttAtRef.current = Date.now()
      setRadioLinkArmed(false)
      setPingError(detail)
      setLivePing((prev) => ({
        ms: prev.ms,
        status: why,
        path: 'radio',
      }))
    }

    const checkExpect = () => {
      if (cancelled || controlPathRef.current !== 'radio') return
      const by = expectByRef.current
      if (!by || Date.now() < by) return

      // Inactive controller: drop pending probe — never count as link-down.
      if (!activeRef.current) {
        expectByRef.current = 0
        return
      }

      expectByRef.current = 0
      missesRef.current += 1
      const hadSample = linkRttEwmaRef.current != null
      if (missesRef.current < RADIO_LINK_HEALTH.missLimit) {
        lastRadioRttAtRef.current =
          Date.now() - RADIO_LINK_HEALTH.idleHbMs + RADIO_LINK_HEALTH.softRetryMs
        return
      }
      failRadio(
        'timeout',
        hadSample
          ? 'Radio RTT heartbeat timed out — link may be down'
          : 'Radio arming RTT timed out — check Pi + desktop agent',
      )
    }

    const tick = async () => {
      if (cancelled) return
      const path = controlPathRef.current

      if (!webRtcConnectedRef.current) {
        setLivePing((prev) => ({ ...prev, status: 'idle', path }))
        if (path === 'radio') {
          setRadioLinkArmed(false)
          expectByRef.current = 0
          missesRef.current = 0
        }
        schedule(1200)
        return
      }

      const channel = getDataChannel(sessionId)
      if (!channel || channel.readyState !== 'open') {
        setLivePing((prev) => ({ ...prev, status: 'idle', path }))
        schedule(1200)
        return
      }

      if (path === 'radio') {
        checkExpect()

        // Blur / other window flying: freeze Armed + last RTT. Do not contend for RF.
        if (!activeRef.current) {
          expectByRef.current = 0
          schedule(1000)
          return
        }

        if (inFlight || pingRunningRef.current || transmittingRef.current) {
          schedule(800)
          return
        }

        const dueIn = radioLinkIdleDueInMs(lastRadioRttAtRef.current, sessionId)
        if (dueIn > 0) {
          schedule(dueIn)
          return
        }
        if (expectByRef.current > Date.now()) {
          schedule(expectByRef.current - Date.now() + 50)
          return
        }

        inFlight = true
        try {
          const stack = vehicleStackRef.current || 'px4'
          const pipe = pipeLabelForCtrl('radio', linkModeRef.current)
          sendCtrlFrame(channel, {
            path: 'radio',
            stack,
            pipe,
            actions: [],
            stream: 'hb',
            ts: Date.now(),
          })
          expectByRef.current = Date.now() + RADIO_LINK_HEALTH.ackWaitMs
          if (linkRttEwmaRef.current == null) {
            setLivePing({ ms: null, status: 'probing', path: 'radio' })
          }
        } catch {
          failRadio('error', 'Radio heartbeat failed to send')
        } finally {
          inFlight = false
          schedule(RADIO_LINK_HEALTH.ackWaitMs + 100)
        }
        return
      }

      // Relay path: local WebRTC PING.
      if (inFlight || pingRunningRef.current) {
        schedule(800)
        return
      }
      inFlight = true
      setLivePing((prev) => ({
        ...prev,
        status: prev.ms == null ? 'probing' : 'live',
        path: 'relay',
      }))
      try {
        const result = await pingDataChannel(channel, { mode: 'local', timeoutMs: 4000 })
        if (cancelled) return
        setLivePing({ ms: result.rttMs, status: 'live', path: 'relay' })
      } catch (e) {
        if (cancelled) return
        const msg = e instanceof Error ? e.message : 'ping failed'
        setLivePing((prev) => ({
          ms: prev.ms,
          status: /timed out/i.test(msg) ? 'timeout' : 'error',
          path: 'relay',
        }))
      } finally {
        inFlight = false
        schedule(1400)
      }
    }

    linkRttEwmaRef.current = null
    lastRadioRttAtRef.current = 0
    expectByRef.current = 0
    missesRef.current = 0
    setRadioLinkArmed(false)
    setPingError(null)
    setLivePing({
      ms: null,
      status: 'probing',
      path: controlPath,
    })
    schedule(controlPath === 'radio' ? radioLinkIdleDueInMs(0, sessionId) : 200)
    watchTimer = window.setInterval(checkExpect, 500)

    return () => {
      cancelled = true
      if (timer != null) window.clearTimeout(timer)
      if (watchTimer != null) window.clearInterval(watchTimer)
    }
  }, [open, sessionId, controlPath, usesWebSocket, getDataChannel])

  return {
    radioLinkArmed,
    livePing,
    setLivePing,
    pingError,
    setPingError,
  }
}
