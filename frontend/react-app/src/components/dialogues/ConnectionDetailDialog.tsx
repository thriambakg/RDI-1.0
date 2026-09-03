import { Button, Box, Typography, IconButton } from '@mui/material'
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FloatingWindow, type WindowRect } from './FloatingWindow'
import { getSession, updateSession, fetchWebRtcBundleForSession } from '../../services/sessionApi'
import { useSessionWebSocket } from '../../contexts/SessionWebSocketContext'
import { useSessionWebRtc } from '../../contexts/SessionWebRtcContext'
import { usesWebSocketTransport, WEBRTC_PI_READY_MS } from '../../utils/sessionTransport'
import { pingDataChannel, type PingMode, PING_BYTES, PONG_BYTES } from '../../utils/rdiPing'
import {
  parseCtrlAck,
  parseLinkRtt,
  pipeLabelForCtrl,
  sendCtrlFrame,
  type ControlPath,
} from '../../utils/rdiControl'
import { labelForVehicleStack } from '../../controls/vehicleStacks'
import { usePressedInputs } from '../../hooks/usePressedInputs'
import {
  DEFAULT_KEYBINDS,
  resolveConnectionKeybinds,
  resolveActiveActions,
  type ControlKeybinds,
} from '../../controls/defaultKeybinds'
import { getProfile, updateUserSettings, type RelayRef } from '../../services/profileApi'
import type { WebRtcViewerBundle } from '../../services/sessionApi'
import { ConnectionControlHud, type LivePingState } from './ConnectionControlHud'
import { ConnectionSetupPanel } from './ConnectionSetupPanel'

const RLOG_PREFIX = new Uint8Array([0x52, 0x4c, 0x4f, 0x47]) // "RLOG"
const LEGACY_CTRL_PREFIX = new TextEncoder().encode('CTRL')

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return target.isContentEditable
}

const TTL_OPTIONS = [
  { value: 0, label: 'No TTL (indefinite)' },
  { value: 3600, label: '1 hour' },
  { value: 14400, label: '4 hours' },
  { value: 86400, label: '24 hours' },
  { value: 604800, label: '7 days' },
]

function formatExpiresAt(ts?: number): string {
  if (!ts || ts >= 4102444800) return 'Indefinite (until paused or deleted)'
  return new Date(ts * 1000).toLocaleString()
}

function isRlogMessage(arr: Uint8Array): boolean {
  return arr.length >= 4 && arr[0] === RLOG_PREFIX[0] && arr[1] === RLOG_PREFIX[1] && arr[2] === RLOG_PREFIX[2] && arr[3] === RLOG_PREFIX[3]
}

function sendDroneCommand(ws: WebSocket, cmd: string, alt?: number): void {
  const payload = alt != null ? { cmd, alt } : { cmd }
  const json = JSON.stringify(payload)
  const full = new Uint8Array(LEGACY_CTRL_PREFIX.length + json.length)
  full.set(LEGACY_CTRL_PREFIX)
  full.set(new TextEncoder().encode(json), LEGACY_CTRL_PREFIX.length)
  ws.send(full.buffer)
}

interface ConnectionDetailDialogProps {
  sessionId: string | null
  open: boolean
  onClose: () => void
  /** Live status from console hierarchy (updates when user reactivates without closing dialog). */
  sessionStatus?: string
  onSessionUpdated?: (sessionId: string, updates: { name?: string; ttl_seconds?: number }) => void
  relays?: RelayRef[]
  /** Stacking order among multiple open connection windows */
  zIndex?: number
  /** Only the focused window captures keyboard/gamepad control */
  focused?: boolean
  onFocus?: () => void
  /** Hide window chrome; session/WebRTC stay alive */
  minimized?: boolean
  onMinimize?: () => void
  initialRect?: Partial<WindowRect>
}

interface HopLog {
  hop: string
  message: string
}

export function ConnectionDetailDialog({
  sessionId,
  open,
  onClose,
  sessionStatus,
  onSessionUpdated,
  relays = [],
  zIndex = 1300,
  focused = true,
  onFocus,
  minimized = false,
  onMinimize,
  initialRect,
}: ConnectionDetailDialogProps) {
  const [data, setData] = useState<{
    session_id: string
    drone_id: string
    endpoint: string
    status: string
    transport?: string
    relay_id?: string
    carrier_ip?: string
    mavlink_host?: string
    mavlink_port?: string | number
    webrtc?: WebRtcViewerBundle
    ttl_seconds?: number
    expires_at?: number
    link_mode?: string
    vehicle_stack?: string
    mavlink_sysid?: number
  } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editTtl, setEditTtl] = useState(14400)
  const [savingSettings, setSavingSettings] = useState(false)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [settingsSavedMsg, setSettingsSavedMsg] = useState<string | null>(null)
  /** controls = flight HUD; setup = connection info + per-connection keybinds */
  const [panelView, setPanelView] = useState<'controls' | 'setup'>('controls')
  const [logLines, setLogLines] = useState<string[]>([])
  const [pingRunning, setPingRunning] = useState(false)
  const [pingError, setPingError] = useState<string | null>(null)
  const [ctrlError, setCtrlError] = useState<string | null>(null)
  const [controlPath, setControlPath] = useState<ControlPath>('relay')
  const [keybinds, setKeybinds] = useState<ControlKeybinds>(DEFAULT_KEYBINDS)
  const [lastTxNote, setLastTxNote] = useState<string | null>(null)
  const [transmitting, setTransmitting] = useState(false)
  const [livePing, setLivePing] = useState<LivePingState>({
    ms: null,
    status: 'idle',
    path: 'relay',
  })

  const { getWs, openSession, connectionState, connectionError } = useSessionWebSocket()
  const {
    openSession: openWebRtcSession,
    getDataChannel,
    connectionState: webRtcState,
    connectionError: webRtcError,
  } = useSessionWebRtc()

  const addLog = useCallback((line: string) => {
    setLogLines((prev) => [...prev.slice(-98), line])
  }, [])

  const prevSessionStatusRef = useRef<string | undefined>(undefined)
  const lastCtrlSigRef = useRef<string>('')
  const controlPathRef = useRef<ControlPath>('relay')
  controlPathRef.current = controlPath

  const listenInputs = open && panelView === 'controls' && focused && !minimized
  const { pressed, stream } = usePressedInputs(listenInputs)
  const activeActions = useMemo(() => resolveActiveActions(pressed, keybinds), [pressed, keybinds])

  const sendCommand = useCallback(
    (cmd: 'takeoff' | 'land', alt?: number) => {
      if (!data?.session_id) return
      const ws = getWs(data.session_id)
      if (!ws) {
        setCtrlError('Connection not ready. Wait for the connection to establish.')
        return
      }
      if (ws.readyState !== WebSocket.OPEN) {
        setCtrlError('WebSocket is not open.')
        return
      }
      setCtrlError(null)
      try {
        sendDroneCommand(ws, cmd, alt)
        const localLine =
          alt != null && cmd === 'takeoff'
            ? `[local] Sent CTRL ${cmd} (alt=${alt}m) over WebSocket`
            : `[local] Sent CTRL ${cmd} over WebSocket`
        addLog(localLine)
      } catch (e) {
        setCtrlError(e instanceof Error ? e.message : 'Failed to send command')
      }
    },
    [data?.session_id, getWs, addLog]
  )

  useEffect(() => {
    if (!open || !sessionId) {
      setData(null)
      setError(null)
      setLogLines([])
      setPingError(null)
      setCtrlError(null)
      setSettingsError(null)
      setSettingsSavedMsg(null)
      setPanelView('controls')
      setLastTxNote(null)
      setTransmitting(false)
      setLivePing({ ms: null, status: 'idle', path: 'relay' })
      lastCtrlSigRef.current = ''
      return
    }
    setLoading(true)
    setError(null)
    getSession(sessionId)
      .then((session) => {
        setData(session)
        const parsedName = session.drone_id
          ? session.drone_id.split('-').slice(0, -1).join('-') || session.drone_id
          : ''
        setEditName(parsedName)
        setEditTtl(session.ttl_seconds ?? 14400)
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false))
  }, [open, sessionId])

  useEffect(() => {
    if (!open || !sessionId) return
    let cancelled = false
    getProfile()
      .then((profile) => {
        if (cancelled) return
        const per =
          profile.settings?.controls?.connection_keybinds?.[sessionId] as
            | Partial<ControlKeybinds>
            | undefined
        const legacy = profile.settings?.controls?.keybinds as Partial<ControlKeybinds> | undefined
        setKeybinds(resolveConnectionKeybinds(per, legacy))
      })
      .catch(() => {
        if (!cancelled) setKeybinds(DEFAULT_KEYBINDS)
      })
    return () => {
      cancelled = true
    }
  }, [open, sessionId])

  useEffect(() => {
    if (!open || !sessionId || !sessionStatus) return
    const prevStatus = prevSessionStatusRef.current
    prevSessionStatusRef.current = sessionStatus
    getSession(sessionId)
      .then((session) => {
        setData(session)
        setEditTtl(session.ttl_seconds ?? 14400)
        const reactivated =
          prevStatus === 'idle' && session.status === 'active' && sessionStatus === 'active'
        if (reactivated && !usesWebSocketTransport(session)) {
          void fetchWebRtcBundleForSession(sessionId, undefined, { attempts: 5, delayMs: 1500 }).then(
            (webrtc) => {
              if (webrtc) {
                console.log('[RDI ConnectionDetail] Reactivate: opening WebRTC', { session_id: sessionId })
                openWebRtcSession(sessionId, webrtc, { force: true, waitForPiMs: WEBRTC_PI_READY_MS })
              }
            },
          )
        }
      })
      .catch(() => { /* ignore */ })
  }, [open, sessionId, sessionStatus, openWebRtcSession])

  // Keep WebSocket open for legacy WebSocket sessions when dialog is open
  useEffect(() => {
    if (!open || !sessionId || !data?.endpoint || data?.status !== 'active') return
    if (!usesWebSocketTransport(data)) return
    openSession(sessionId, data.endpoint)
  }, [open, sessionId, data?.endpoint, data?.status, data?.transport, openSession])

  // Prevent browser shortcuts / scroll while flying the HUD
  useEffect(() => {
    if (!open || panelView !== 'controls') return
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return
      // Block page scroll / shortcuts for held flight binds
      const codes = new Set(
        Object.values(keybinds)
          .filter((b) => b.device === 'keyboard')
          .map((b) => (b.device === 'keyboard' ? b.code : '')),
      )
      if (codes.has(e.code)) e.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [open, panelView, keybinds])

  // Stream control frames over WebRTC — coalesce chords, heartbeat while held.
  const actionsKey = activeActions.join(',')
  const liveControlsRef = useRef({ actions: activeActions, stream })
  liveControlsRef.current = { actions: activeActions, stream }

  useEffect(() => {
    if (!open || !data?.session_id || panelView !== 'controls') return
    if (usesWebSocketTransport(data)) return

    const isWebRtcConnected = webRtcState(data.session_id) === 'connected'
    if (!isWebRtcConnected) {
      setTransmitting(false)
      return
    }

    const channel = getDataChannel(data.session_id)
    if (!channel || channel.readyState !== 'open') {
      setTransmitting(false)
      return
    }

    if (isTypingTarget(document.activeElement)) return

    const CHORD_MS = 40
    // Radio path: slower heartbeats — each frame gets a desktop ACK (airtime).
    const HEARTBEAT_MS = controlPathRef.current === 'radio' ? 500 : 200
    let chordTimer: number | undefined
    let beatTimer: number | undefined

    const flush = (reason: 'edge' | 'beat') => {
      if (channel.readyState !== 'open') return
      if (isTypingTarget(document.activeElement)) return

      const { actions, stream: liveStream } = liveControlsRef.current
      const path = controlPathRef.current
      const sig = `${path}|${actions.join(',')}`

      if (reason === 'edge') {
        if (sig === lastCtrlSigRef.current) return
        // Don't announce idle when the dialog first opens / path toggles with no keys.
        if (!lastCtrlSigRef.current && actions.length === 0) {
          lastCtrlSigRef.current = sig
          return
        }
      } else if (actions.length === 0) {
        return
      }

      const prevSig = lastCtrlSigRef.current
      lastCtrlSigRef.current = sig

      try {
        const stack = data?.vehicle_stack || 'px4'
        const pipe = pipeLabelForCtrl(path, data?.link_mode)
        sendCtrlFrame(channel, {
          path,
          stack,
          pipe,
          actions,
          stream: liveStream,
          ts: Date.now(),
        })
        setCtrlError(null)
        setTransmitting(actions.length > 0)
        if (reason === 'edge') {
          if (actions.length > 0) {
            setLastTxNote(actions.join(' + '))
            addLog(
              `[ctrl/${pipe}|${stack}] ${actions.join(' + ')} · ${liveStream || '—'}`,
            )
          } else {
            setTransmitting(false)
            if (prevSig.includes('|') && !prevSig.endsWith('|')) {
              addLog(`[ctrl/${pipe}|${stack}] release`)
            }
          }
        }
      } catch (e) {
        setTransmitting(false)
        setCtrlError(e instanceof Error ? e.message : 'Failed to send control frame')
      }
    }

    if (activeActions.length === 0) {
      // Release immediately so the receiver clears stick state.
      flush('edge')
    } else {
      // Wait briefly so W+D in the same gesture merge into one frame.
      chordTimer = window.setTimeout(() => flush('edge'), CHORD_MS)
      beatTimer = window.setInterval(() => flush('beat'), HEARTBEAT_MS)
    }

    return () => {
      if (chordTimer != null) window.clearTimeout(chordTimer)
      if (beatTimer != null) window.clearInterval(beatTimer)
    }
  }, [
    open,
    data,
    panelView,
    actionsKey,
    controlPath,
    getDataChannel,
    webRtcState,
    addLog,
    activeActions.length,
  ])

  // Handing off control (settings, another window, minimize) must not leave the
  // vehicle holding the last stick input — send an explicit release first.
  const releaseControls = useCallback(() => {
    const sid = data?.session_id
    if (!sid || usesWebSocketTransport(data ?? undefined)) return
    const prevSig = lastCtrlSigRef.current
    if (!prevSig || prevSig.endsWith('|')) return
    const channel = getDataChannel(sid)
    if (!channel || channel.readyState !== 'open') return

    const path = controlPathRef.current
    lastCtrlSigRef.current = `${path}|`
    try {
      const stack = data?.vehicle_stack || 'px4'
      const pipe = pipeLabelForCtrl(path, data?.link_mode)
      sendCtrlFrame(channel, { path, stack, pipe, actions: [], stream: '', ts: Date.now() })
      setTransmitting(false)
      addLog(`[ctrl/${pipe}|${stack}] release (controls handed off)`)
    } catch {
      setTransmitting(false)
    }
  }, [data, getDataChannel, addLog])

  useEffect(() => {
    if (!open) return
    if (panelView === 'controls' && focused && !minimized) return
    releaseControls()
  }, [open, panelView, focused, minimized, releaseControls])

  // Delivery acks (local) + RF link RTT from desktop ctrl_ack (Option B).
  const linkRttEwmaRef = useRef<number | null>(null)
  const lastRadioRttAtRef = useRef(0)
  const [radioLinkArmed, setRadioLinkArmed] = useState(false)
  useEffect(() => {
    if (!open || !data?.session_id || usesWebSocketTransport(data)) return
    const channel = getDataChannel(data.session_id)
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
          setRadioLinkArmed(true)
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
  }, [open, data, getDataChannel, webRtcState(data?.session_id ?? ''), addLog])

  // Link meter: relay keeps PING; radio uses CTRL-ACK RTT (+ idle heartbeat).
  const transmittingRef = useRef(false)
  transmittingRef.current = transmitting
  const pingRunningRef = useRef(false)
  pingRunningRef.current = pingRunning

  useEffect(() => {
    if (!open || !data?.session_id) return
    if (usesWebSocketTransport(data)) return

    let cancelled = false
    let timer: number | undefined
    let staleTimer: number | undefined
    let inFlight = false

    const schedule = (ms: number) => {
      if (cancelled) return
      timer = window.setTimeout(() => {
        void tick()
      }, ms)
    }

    const checkStale = () => {
      if (cancelled) return
      if (controlPathRef.current !== 'radio') return
      if (lastRadioRttAtRef.current === 0) return
      if (Date.now() - lastRadioRttAtRef.current > 8000) {
        setRadioLinkArmed(false)
        setLivePing((prev) =>
          prev.path === 'radio' ? { ...prev, status: 'timeout' } : prev,
        )
      }
    }

    const tick = async () => {
      if (cancelled) return
      const path = controlPathRef.current

      if (webRtcState(data.session_id) !== 'connected') {
        setLivePing((prev) => ({ ...prev, status: 'idle', ms: null, path }))
        if (path === 'radio') setRadioLinkArmed(false)
        schedule(1200)
        return
      }
      const channel = getDataChannel(data.session_id)
      if (!channel || channel.readyState !== 'open') {
        setLivePing((prev) => ({ ...prev, status: 'idle', ms: null, path }))
        schedule(1200)
        return
      }

      // Radio: idle heartbeat CTRL only — RTT comes from rdi_link_rtt messages.
      if (path === 'radio') {
        checkStale()
        if (inFlight || pingRunningRef.current || transmittingRef.current) {
          schedule(1500)
          return
        }
        inFlight = true
        try {
          const stack = data?.vehicle_stack || 'px4'
          const pipe = pipeLabelForCtrl('radio', data?.link_mode)
          sendCtrlFrame(channel, {
            path: 'radio',
            stack,
            pipe,
            actions: [],
            stream: 'hb',
            ts: Date.now(),
          })
          if (linkRttEwmaRef.current == null) {
            setLivePing((prev) => ({
              ms: prev.ms,
              status: prev.ms == null ? 'probing' : 'live',
              path: 'radio',
            }))
          }
        } catch {
          setLivePing((prev) => ({ ...prev, status: 'error', path: 'radio' }))
        } finally {
          inFlight = false
          const sid = typeof data.mavlink_sysid === 'number' ? data.mavlink_sysid : 1
          schedule(12000 + ((sid - 1) % 4) * 1500)
        }
        return
      }

      // Relay: classic local PING.
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
    setRadioLinkArmed(false)
    setLivePing({
      ms: null,
      status: 'probing',
      path: controlPathRef.current,
    })
    const sid0 = typeof data.mavlink_sysid === 'number' ? data.mavlink_sysid : 1
    schedule(controlPath === 'radio' ? 500 + ((sid0 - 1) % 4) * 400 : 200)
    staleTimer = window.setInterval(checkStale, 2000)

    return () => {
      cancelled = true
      if (timer != null) window.clearTimeout(timer)
      if (staleTimer != null) window.clearInterval(staleTimer)
    }
  }, [open, data, controlPath, getDataChannel, webRtcState, addLog])

  const handleSaveSettings = useCallback(async () => {
    if (!sessionId || !data) return
    setSavingSettings(true)
    setSettingsError(null)
    setSettingsSavedMsg(null)
    try {
      const patch = await updateSession({
        session_id: sessionId,
        name: editName.trim() || 'drone',
        ttl_seconds: editTtl,
      })
      await updateUserSettings({
        controls: {
          version: 1,
          connection_keybinds: {
            [sessionId]: keybinds,
          },
        },
      })
      const refreshed = await getSession(sessionId)
      setData(refreshed)
      setEditTtl(refreshed.ttl_seconds ?? editTtl)
      onSessionUpdated?.(sessionId, { name: editName.trim() || 'drone', ttl_seconds: patch.ttl_seconds })
      if (
        refreshed.status === 'active' &&
        patch.webrtc &&
        !usesWebSocketTransport(refreshed)
      ) {
        openWebRtcSession(sessionId, patch.webrtc, { force: true, waitForPiMs: WEBRTC_PI_READY_MS })
      }
      setSettingsSavedMsg('Connection settings saved.')
    } catch (e) {
      setSettingsError(e instanceof Error ? e.message : 'Failed to save settings')
    } finally {
      setSavingSettings(false)
    }
  }, [sessionId, data, editName, editTtl, keybinds, onSessionUpdated, openWebRtcSession])

  // Listen for agent log messages (RLOG) when WebSocket is connected
  useEffect(() => {
    if (!open || !sessionId || !data?.session_id) return
    const ws = getWs(data.session_id)
    if (!ws) return
    const handler = (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        const arr = new Uint8Array(event.data)
        if (isRlogMessage(arr)) {
          try {
            const json = JSON.parse(new TextDecoder().decode(arr.subarray(4)))
            const msg = typeof json?.msg === 'string' ? json.msg : new TextDecoder().decode(arr.subarray(4))
            addLog(msg)
          } catch {
            addLog(new TextDecoder().decode(arr.subarray(4)))
          }
        }
      }
    }
    ws.onmessage = handler
    return () => {
      ws.onmessage = () => {}
    }
  }, [open, sessionId, data?.session_id, connectionState(sessionId ?? ''), getWs, addLog])

  const runPing = useCallback((mode: PingMode = 'local') => {
    if (!data?.session_id) return

    const isWebRtcSession = !usesWebSocketTransport(data)

    if (isWebRtcSession) {
      const channel = getDataChannel(data.session_id)
      if (!channel) {
        const state = webRtcState(data.session_id)
        if (state === 'connecting') {
          setPingError('WebRTC is still connecting. Wait a moment, then try again.')
        } else if (state === 'failed') {
          setPingError(webRtcError(data.session_id) ?? 'WebRTC connection failed.')
        } else {
          setPingError('WebRTC not connected. Ensure the Pi relay daemon is running.')
        }
        return
      }

      setPingRunning(true)
      setPingError(null)
      const sysidTag = data.mavlink_sysid != null ? ` (sysid=${data.mavlink_sysid})` : ''
      addLog(
        mode === 'radio'
          ? `Pinging full radio path…${sysidTag}`
          : `Pinging relay (WebRTC only)…${sysidTag}`,
      )
      pingDataChannel(channel, { mode })
        .then((result) => {
          if (result.lines.length > 0) {
            result.lines.forEach((line) => addLog(line))
          }
          if (result.error) {
            addLog(`Radio note: ${result.error}`)
          }
          const hopNames = result.hops.map((h) => h.hop).filter(Boolean)
          if (hopNames.length > 0) {
            addLog(`Path: ${hopNames.join(' → ')}`)
          }
          const radioFailed =
            mode === 'radio' &&
            (!!result.error ||
              result.lines.some((l) => /radio ping failed|no TUNNEL pong|fell back/i.test(l)))
          if (radioFailed) {
            setPingError(`Radio RTT failed${sysidTag}`)
            addLog(
              `Radio RTT unavailable after ${result.rttMs}ms${sysidTag} — check Pi journal + desktop agent diag`,
            )
            setLivePing({ ms: null, status: 'timeout', path: 'radio' })
          } else {
            const detail =
              mode === 'radio' && result.airRttMs != null
                ? ` air=${result.airRttMs}ms` +
                  (result.turnaroundMs != null ? ` ta=${result.turnaroundMs}ms` : '') +
                  (result.wallRttMs != null ? ` wall=${result.wallRttMs}ms` : '')
                : ''
            addLog(
              `Round-trip ${result.rttMs}ms (${mode === 'radio' ? 'radio' : 'relay'})${sysidTag}${detail}.`,
            )
            if (mode === 'radio') {
              setLivePing({ ms: result.rttMs, status: 'live', path: 'radio' })
            } else {
              setLivePing({ ms: result.rttMs, status: 'live', path: 'relay' })
            }
          }
        })
        .catch((e) => {
          const message = e instanceof Error ? e.message : 'Ping failed'
          setPingError(message)
          addLog(`Ping failed${sysidTag}: ${message}`)
        })
        .finally(() => setPingRunning(false))
      return
    }

    if (mode === 'radio') {
      setPingError('Radio ping requires a WebRTC (Pi relay) session.')
      addLog('Radio ping is only available on WebRTC sessions.')
      return
    }

    const ws = getWs(data.session_id)
    if (!ws) {
      setPingError('Connection not ready. Wait a moment for the connection to establish, then try again.')
      return
    }

    setPingRunning(true)
    setPingError(null)

    const start = performance.now()
    const add = (line: string) => addLog(line)
    const elapsed = () => Math.round(performance.now() - start)

    let closed = false
    const prevOnMessage = ws.onmessage
    const finish = (err?: string) => {
      if (closed) return
      closed = true
      setPingRunning(false)
      if (err) setPingError(err)
      ws.onmessage = prevOnMessage ?? (() => {})
    }

    add(`Pinging over existing connection…`)
    ws.onmessage = (event: MessageEvent) => {
      const ms = elapsed()
      const buf = event.data instanceof ArrayBuffer ? event.data : (event.data instanceof Blob ? null : null)
      if (buf) {
        const arr = new Uint8Array(buf)
        if (isRlogMessage(arr)) {
          try {
            const json = JSON.parse(new TextDecoder().decode(arr.subarray(4)))
            const msg = typeof json?.msg === 'string' ? json.msg : new TextDecoder().decode(arr.subarray(4))
            addLog(msg)
          } catch {
            addLog(new TextDecoder().decode(arr.subarray(4)))
          }
        }
        if (arr.length === PONG_BYTES.length && arr.every((b, i) => b === PONG_BYTES[i])) {
          add(`2. Agent: responded (T+${ms}ms)`)
          add(`Success — full round-trip (client → proxy → agent → proxy → client) (T+${ms}ms).`)
          finish()
        }
      }
      if (event.data instanceof Blob) {
        event.data.arrayBuffer().then((ab) => {
          const arr = new Uint8Array(ab)
          if (arr.length === PONG_BYTES.length && arr.every((b, i) => b === PONG_BYTES[i])) {
            add(`2. Agent: responded (T+${ms}ms)`)
            add(`Success — full round-trip (T+${ms}ms).`)
            finish()
          }
        })
        return
      }
      if (typeof event.data === 'string') {
        try {
          const obj = JSON.parse(event.data) as HopLog & { error?: string; message?: string; type?: string }
          if (obj.error === 'session idle') {
            add(`Session is idle (T+${ms}ms). Reactivate in console to connect.`)
            finish('Session is idle. Reactivate this connection in the console, then ping again.')
            return
          }
          if (obj.hop === 'proxy' || obj.hop === 'proxy_ec2') {
            add(`1. Proxy: ${obj.message ?? 'responded'} (T+${ms}ms)`)
            if (obj.hop === 'proxy' && obj.type === 'ping_ack') {
              add(`Success — proxy responded (round-trip T+${ms}ms, no agent).`)
              finish()
            }
          } else if (obj.hop === 'agent' || obj.hop === 'wavelength') {
            add(`2. Agent: ${obj.message} (T+${ms}ms)`)
            if (obj.message === 'instance responded') {
              add(`Success — full round-trip (client → proxy → agent → proxy → client) (T+${ms}ms).`)
              finish()
            } else {
              finish(
                'Proxy reached; no agent connected for this session. The agent starts when you create a session and runs for that session only. ' +
                  'Use this session (see Session ID below); if you have multiple sessions, connect from the same session you just created, then ping again.'
              )
            }
          } else {
            add(`Hop: ${obj.hop} — ${obj.message ?? ''} (T+${ms}ms)`)
          }
        } catch {
          if ((event.data as string).trim().length > 0) {
            add(`Raw: ${(event.data as string).slice(0, 80)} (T+${ms}ms)`)
          }
        }
      }
    }

    ws.send(PING_BYTES)

    const t = setTimeout(() => {
      if (!closed) {
        finish('Ping timed out (8s).')
      }
    }, 8000)
    return () => {
      clearTimeout(t)
      if (!closed) ws.onmessage = prevOnMessage || (() => {})
    }
  }, [data, getWs, getDataChannel, webRtcState, webRtcError, addLog])

  const name = data?.drone_id ? data.drone_id.split('-').slice(0, -1).join('-') || data.drone_id : ''
  const isWebRtc = !usesWebSocketTransport(data ?? undefined)
  const wsState = sessionId ? connectionState(sessionId) : 'closed'
  const wsError = sessionId ? connectionError(sessionId) : null
  const rtcState = sessionId ? webRtcState(sessionId) : 'closed'
  const rtcError = sessionId ? webRtcError(sessionId) : null
  const isConnected = isWebRtc ? rtcState === 'connected' : wsState === 'open'
  const isFailed = isWebRtc ? rtcState === 'failed' : wsState === 'failed'
  const isConnecting = isWebRtc ? rtcState === 'connecting' : wsState === 'connecting'

  const windowTitle = (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, minWidth: 0, flex: 1 }}>
      <Typography
        component="span"
        sx={{
          fontSize: '0.85rem',
          fontWeight: 600,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {name || data?.drone_id || 'Connection'}
        <Typography component="span" sx={{ color: '#64748b', ml: 1, letterSpacing: '0.08em', fontWeight: 500 }}>
          · {panelView === 'setup' ? 'Setup' : 'Control'}
        </Typography>
      </Typography>
      {data?.status === 'active' && panelView === 'controls' && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexShrink: 0 }}>
          <Box
            sx={{
              width: 10,
              height: 10,
              borderRadius: '50%',
              backgroundColor: isWebRtc
                ? rtcState === 'connected'
                  ? '#22c55e'
                  : rtcState === 'failed'
                    ? '#ef4444'
                    : rtcState === 'connecting'
                      ? '#eab308'
                      : '#3b82f6'
                : wsState === 'open'
                  ? '#22c55e'
                  : wsState === 'failed'
                    ? '#ef4444'
                    : wsState === 'connecting'
                      ? '#eab308'
                      : '#64748b',
            }}
          />
          <Typography component="span" variant="caption" sx={{ color: '#94a3b8', textTransform: 'none' }}>
            {isWebRtc
              ? isConnected
                ? 'WebRTC'
                : isFailed
                  ? 'Failed'
                  : isConnecting
                    ? 'Connecting…'
                    : 'Idle'
              : wsState === 'open'
                ? 'Connected'
                : isFailed
                  ? 'Failed'
                  : wsState === 'connecting'
                    ? 'Connecting…'
                    : 'Idle'}
          </Typography>
        </Box>
      )}
    </Box>
  )

  return (
    <FloatingWindow
      open={open}
      minimized={minimized}
      title={windowTitle}
      zIndex={zIndex}
      focused={focused}
      onFocus={onFocus}
      onClose={onClose}
      onMinimize={onMinimize}
      initialRect={initialRect}
      titleExtra={
        <IconButton
          size="small"
          data-no-drag
          aria-label={panelView === 'setup' ? 'Back to control deck' : 'Connection setup'}
          disabled={!data}
          onClick={() => {
            setSettingsError(null)
            setSettingsSavedMsg(null)
            setPanelView((v) => (v === 'setup' ? 'controls' : 'setup'))
          }}
          sx={{
            color: panelView === 'setup' ? '#38bdf8' : '#64748b',
            '&:hover': { color: '#94a3b8', backgroundColor: 'rgba(148, 163, 184, 0.08)' },
          }}
        >
          <SettingsOutlinedIcon sx={{ fontSize: 20 }} />
        </IconButton>
      }
      footer={
        <Button onClick={onClose} sx={{ color: '#3b82f6' }} disableRipple>
          Close
        </Button>
      }
    >
      {loading && <Typography sx={{ color: '#94a3b8' }}>Loading…</Typography>}
      {error && <Typography sx={{ color: '#f87171' }}>{error}</Typography>}
      {isWebRtc && data?.status === 'active' && !isConnected && !isFailed && !isConnecting && data?.webrtc && (
        <Box sx={{ mb: 2 }}>
          <Button
            variant="outlined"
            size="small"
            onClick={() => openWebRtcSession(sessionId!, data.webrtc!, { force: true })}
            sx={{
              color: '#3b82f6',
              borderColor: '#475569',
              textTransform: 'none',
              '&:hover': { borderColor: '#3b82f6' },
            }}
          >
            Connect WebRTC
          </Button>
        </Box>
      )}
      {isWebRtc && data?.status === 'active' && !isConnected && !isFailed && (
        <Typography sx={{ color: '#94a3b8', fontSize: '0.875rem', mb: 2 }}>
          Connecting WebRTC viewer to Pi via KVS signaling. Ensure{' '}
          <code style={{ color: '#cbd5e1' }}>rdi-relay-daemon</code> is running on the relay.
        </Typography>
      )}
      {isWebRtc && isFailed && rtcError && (
        <Box sx={{ mb: 2 }}>
          <Typography sx={{ color: '#f87171', fontSize: '0.875rem' }}>{rtcError}</Typography>
          {data?.webrtc && (
            <Button
              variant="outlined"
              size="small"
              onClick={() => openWebRtcSession(sessionId!, data.webrtc!, { force: true })}
              sx={{
                color: '#3b82f6',
                borderColor: '#475569',
                mt: 1,
                textTransform: 'none',
                '&:hover': { borderColor: '#3b82f6' },
              }}
            >
              Retry WebRTC connection
            </Button>
          )}
        </Box>
      )}
      {isFailed && wsError && (
        <Box sx={{ mb: 2 }}>
          <Typography sx={{ color: '#f87171', fontSize: '0.875rem' }}>{wsError}</Typography>
          {data?.endpoint && usesWebSocketTransport(data) && (
            <Button
              variant="outlined"
              size="small"
              onClick={() => openSession(sessionId!, data!.endpoint)}
              sx={{
                color: '#3b82f6',
                borderColor: '#475569',
                mt: 1,
                textTransform: 'none',
                '&:hover': { borderColor: '#3b82f6' },
              }}
            >
              Retry connection
            </Button>
          )}
        </Box>
      )}
      {data && panelView === 'setup' && (
        <ConnectionSetupPanel
          connectionName={name || data.drone_id}
          sessionId={data.session_id}
          status={data.status}
          relayLabel={
            data.relay_id
              ? relays.find((r) => r.relay_id === data.relay_id)?.name ?? data.relay_id
              : null
          }
          mavlinkLabel={
            [
              data.vehicle_stack ? `Stack: ${labelForVehicleStack(data.vehicle_stack)}` : null,
              data.link_mode ? `Link: ${data.link_mode}` : null,
              data.mavlink_host || data.mavlink_port != null
                ? `MAVLink ${data.mavlink_host ?? '127.0.0.1'}:${data.mavlink_port ?? '—'}`
                : null,
            ]
              .filter(Boolean)
              .join(' · ') || null
          }
          linkLabel={
            isConnected
              ? `${livePing.path === 'radio' ? 'Radio' : 'Relay'} link live${
                  livePing.ms != null ? ` · ${livePing.ms} ms` : ''
                } — controls resume on the deck`
              : 'Link not connected'
          }
          linkOk={isConnected}
          editName={editName}
          onEditNameChange={setEditName}
          editTtl={editTtl}
          onEditTtlChange={setEditTtl}
          ttlOptions={TTL_OPTIONS}
          expiresLabel={data.status === 'active' ? formatExpiresAt(data.expires_at) : null}
          keybinds={keybinds}
          onKeybindsChange={(next) => {
            setKeybinds(next)
            setSettingsSavedMsg(null)
          }}
          saving={savingSettings}
          error={settingsError}
          savedMsg={settingsSavedMsg}
          onSave={() => void handleSaveSettings()}
          onBackToControls={() => setPanelView('controls')}
        />
      )}
      {data && panelView === 'controls' && (
        <>
          {isWebRtc && (
            <ConnectionControlHud
              path={controlPath}
              onPathChange={setControlPath}
              stream={stream}
              activeActions={activeActions}
              keybinds={keybinds}
              armed={
                isConnected &&
                data.status === 'active' &&
                (controlPath !== 'radio' || radioLinkArmed)
              }
              transmitting={transmitting}
              lastTxNote={lastTxNote}
              connected={isConnected}
              livePing={livePing}
            />
          )}
          {ctrlError && (
            <Typography sx={{ color: '#f87171', fontSize: '0.875rem', mb: 1 }}>{ctrlError}</Typography>
          )}

          <Typography
            variant="subtitle2"
            sx={{
              color: '#64748b',
              mb: 1,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              fontSize: '0.65rem',
            }}
          >
            Link test
          </Typography>
          <Box sx={{ display: 'flex', gap: 1, mb: 1, flexWrap: 'wrap' }}>
            <Button
              variant="outlined"
              size="small"
              onClick={() => runPing('local')}
              disabled={pingRunning || (isWebRtc && isConnecting)}
              disableRipple
              sx={{
                color: '#38bdf8',
                borderColor: '#334155',
                borderRadius: '2px',
                textTransform: 'none',
                '&:hover': { borderColor: '#38bdf8' },
              }}
            >
              {pingRunning ? 'Pinging…' : 'Ping relay'}
            </Button>
            <Button
              variant="outlined"
              size="small"
              onClick={() => runPing('radio')}
              disabled={pingRunning || (isWebRtc && isConnecting) || !isWebRtc}
              disableRipple
              sx={{
                color: '#fbbf24',
                borderColor: '#334155',
                borderRadius: '2px',
                textTransform: 'none',
                '&:hover': { borderColor: '#fbbf24' },
              }}
            >
              {pingRunning ? 'Pinging…' : 'Ping radio'}
            </Button>
          </Box>
          <Typography sx={{ color: '#475569', fontSize: '0.75rem', mb: 1.5 }}>
            Ping relay = browser ↔ Pi. Ping radio = full RF path. Controls use the toggle above.
            {!focused ? ' Click this window to capture keyboard.' : null}
          </Typography>
          {pingError && (
            <Typography sx={{ color: '#f87171', fontSize: '0.875rem', mb: 1 }}>{pingError}</Typography>
          )}
          {!isWebRtc && (
            <>
              <Typography variant="subtitle2" sx={{ color: '#94a3b8', mb: 1, mt: 1 }}>
                Legacy drone controls
              </Typography>
              <Box sx={{ display: 'flex', gap: 1, mb: 1, flexWrap: 'wrap' }}>
                <Button
                  variant="outlined"
                  size="small"
                  onClick={() => sendCommand('takeoff', 2.5)}
                  disableRipple
                  sx={{
                    color: '#22c55e',
                    borderColor: '#475569',
                    textTransform: 'none',
                    '&:hover': { borderColor: '#22c55e' },
                  }}
                >
                  Takeoff
                </Button>
                <Button
                  variant="outlined"
                  size="small"
                  onClick={() => sendCommand('land')}
                  disableRipple
                  sx={{
                    color: '#eab308',
                    borderColor: '#475569',
                    textTransform: 'none',
                    '&:hover': { borderColor: '#eab308' },
                  }}
                >
                  Land
                </Button>
              </Box>
            </>
          )}
          {logLines.length > 0 && (
            <Box
              component="pre"
              sx={{
                p: 1.5,
                backgroundColor: '#020617',
                border: '1px solid #1e293b',
                borderRadius: '2px',
                fontSize: '0.75rem',
                color: '#94a3b8',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                maxHeight: 180,
                overflow: 'auto',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              }}
            >
              {logLines.join('\n')}
            </Box>
          )}
        </>
      )}
    </FloatingWindow>
  )
}
