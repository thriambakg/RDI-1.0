import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Box,
  Typography,
  TextField,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  IconButton,
  Popover,
} from '@mui/material'
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined'
import { useCallback, useEffect, useState } from 'react'
import { getSession, updateSession } from '../../services/sessionApi'
import { useSessionWebSocket } from '../../contexts/SessionWebSocketContext'
import { useSessionWebRtc } from '../../contexts/SessionWebRtcContext'
import { usesWebSocketTransport } from '../../utils/sessionTransport'
import { pingDataChannel, PING_BYTES, PONG_BYTES } from '../../utils/rdiPing'
import type { WebRtcViewerBundle } from '../../services/sessionApi'
import type { RelayRef } from '../../services/profileApi'

const RLOG_PREFIX = new Uint8Array([0x52, 0x4c, 0x4f, 0x47]) // "RLOG"
const CTRL_PREFIX = new TextEncoder().encode('CTRL')

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
  const full = new Uint8Array(CTRL_PREFIX.length + json.length)
  full.set(CTRL_PREFIX)
  full.set(new TextEncoder().encode(json), CTRL_PREFIX.length)
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
  } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editTtl, setEditTtl] = useState(14400)
  const [savingSettings, setSavingSettings] = useState(false)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [settingsAnchor, setSettingsAnchor] = useState<HTMLElement | null>(null)
  const settingsOpen = Boolean(settingsAnchor)
  const [logLines, setLogLines] = useState<string[]>([])
  const [pingRunning, setPingRunning] = useState(false)
  const [pingError, setPingError] = useState<string | null>(null)
  const [ctrlError, setCtrlError] = useState<string | null>(null)

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
      setSettingsAnchor(null)
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
    if (!open || !sessionId || !sessionStatus) return
    getSession(sessionId)
      .then((session) => {
        setData(session)
        setEditTtl(session.ttl_seconds ?? 14400)
      })
      .catch(() => { /* ignore */ })
  }, [open, sessionId, sessionStatus])

  // Keep WebSocket open for legacy WebSocket sessions when dialog is open
  useEffect(() => {
    if (!open || !sessionId || !data?.endpoint || data?.status !== 'active') return
    if (!usesWebSocketTransport(data)) return
    openSession(sessionId, data.endpoint)
  }, [open, sessionId, data?.endpoint, data?.status, data?.transport, openSession])

  const handleSaveSettings = useCallback(async () => {
    if (!sessionId || !data) return
    setSavingSettings(true)
    setSettingsError(null)
    try {
      const patch = await updateSession({
        session_id: sessionId,
        name: editName.trim() || 'drone',
        ttl_seconds: editTtl,
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
        openWebRtcSession(sessionId, patch.webrtc, { force: true, waitForPiMs: 6000 })
      }
      setSettingsAnchor(null)
    } catch (e) {
      setSettingsError(e instanceof Error ? e.message : 'Failed to save settings')
    } finally {
      setSavingSettings(false)
    }
  }, [sessionId, data, editName, editTtl, onSessionUpdated, openWebRtcSession])

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

  const runPing = useCallback(() => {
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
      addLog('Pinging over WebRTC data channel…')
      pingDataChannel(channel)
        .then((rttMs) => {
          addLog(`Pi relay responded (round-trip ${rttMs}ms).`)
        })
        .catch((e) => {
          const message = e instanceof Error ? e.message : 'Ping failed'
          setPingError(message)
          addLog(`Ping failed: ${message}`)
        })
        .finally(() => setPingRunning(false))
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

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      PaperProps={{
        sx: {
          backgroundColor: '#1e293b',
          border: '1px solid #334155',
          borderRadius: '0.5rem',
        },
      }}
      BackdropProps={{
        sx: { backgroundColor: 'rgba(0, 0, 0, 0.6)', backdropFilter: 'blur(4px)' },
      }}
    >
      <DialogTitle
        sx={{
          color: '#ffffff',
          fontWeight: 600,
          textTransform: 'uppercase',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          pr: 6,
        }}
      >
        Connection details
        {data?.status === 'active' && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
            <Box
              sx={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                backgroundColor:
                  isWebRtc
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
                flexShrink: 0,
              }}
              aria-label={
                isWebRtc
                  ? isConnected
                    ? 'WebRTC connected'
                    : isFailed
                      ? 'WebRTC connection failed'
                      : isConnecting
                        ? 'WebRTC connecting'
                        : 'WebRTC not connected'
                  : isConnected
                    ? 'Connection established'
                    : isFailed
                      ? 'Connection failed'
                      : wsState === 'connecting'
                        ? 'Connecting'
                        : 'Not connected'
              }
            />
            <Typography component="span" variant="caption" sx={{ color: '#94a3b8', textTransform: 'none' }}>
              {isWebRtc
                ? isConnected
                  ? 'WebRTC connected'
                  : isFailed
                    ? 'WebRTC failed'
                    : isConnecting
                      ? 'WebRTC connecting…'
                      : 'WebRTC not connected'
                : wsState === 'open'
                  ? 'Connection established'
                  : isFailed
                    ? 'Connection failed'
                    : wsState === 'connecting'
                      ? 'Connecting…'
                      : 'Not connected'}
            </Typography>
          </Box>
        )}
      </DialogTitle>
      <DialogContent sx={{ color: '#f8fafc' }}>
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
            Connecting WebRTC viewer to Pi via KVS signaling. Ensure <code style={{ color: '#cbd5e1' }}>rdi-relay-daemon</code> is running on the relay.
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
        {data && (
          <>
            <Box
              sx={{
                p: 2,
                backgroundColor: '#0f172a',
                border: '1px solid #334155',
                borderRadius: '0.375rem',
                mb: 2,
              }}
            >
              <Typography sx={{ fontSize: '0.875rem', mb: 1 }}>
                <strong>Name:</strong> {editName || name || data.drone_id}
              </Typography>
              <Typography sx={{ fontSize: '0.875rem', mb: 1 }}>
                <strong>Session ID:</strong> {data.session_id}
              </Typography>
              <Typography sx={{ fontSize: '0.875rem', mb: 1 }}>
                <strong>Drone ID:</strong> {data.drone_id}
              </Typography>
              <Typography sx={{ fontSize: '0.875rem', mb: 1 }}>
                <strong>Status:</strong> {data.status}
              </Typography>
              {data.relay_id && (() => {
                const relay = relays.find((r) => r.relay_id === data.relay_id)
                return relay ? (
                  <Typography sx={{ fontSize: '0.875rem', mb: 1 }}>
                    <strong>Relay:</strong> {relay.name}
                  </Typography>
                ) : (
                  <Typography sx={{ fontSize: '0.875rem', mb: 1 }}>
                    <strong>Relay ID:</strong> {data.relay_id}
                  </Typography>
                )
              })()}
              <Typography sx={{ fontSize: '0.875rem', color: '#94a3b8' }}>
                <strong>Endpoint:</strong> {data.endpoint}
              </Typography>
              {(data.mavlink_host || data.mavlink_port != null) && (
                <>
                  <Typography sx={{ fontSize: '0.875rem', mt: 1, color: '#22c55e' }}>
                    <strong>MAVLink target:</strong>{' '}
                    {data.mavlink_host ?? '127.0.0.1'}:{data.mavlink_port ?? '—'}
                  </Typography>
                  {(data.mavlink_host === '127.0.0.1' || !data.mavlink_host) && (
                    <Typography sx={{ fontSize: '0.75rem', mt: 0.5, color: '#94a3b8' }}>
                      PX4 must run on the same host as the MAVLink agent (e.g. relay or edge compute). Local PX4 on your laptop
                      will not receive commands — run PX4 SITL on that host instead.
                    </Typography>
                  )}
                </>
              )}
              {data.carrier_ip && (
                <Typography sx={{ fontSize: '0.875rem', mt: 0.5, color: '#94a3b8' }}>
                  <strong>Carrier / edge IP:</strong> {data.carrier_ip}
                </Typography>
              )}
            </Box>

            <Typography variant="subtitle2" sx={{ color: '#94a3b8', mb: 1 }}>
              Test connection
            </Typography>
            <Button
              variant="outlined"
              size="small"
              onClick={runPing}
              disabled={pingRunning || (isWebRtc && isConnecting)}
              disableRipple
              sx={{
                color: '#3b82f6',
                borderColor: '#475569',
                mb: 1,
                textTransform: 'none',
                '&:hover': { borderColor: '#3b82f6' },
              }}
            >
              {pingRunning ? 'Pinging…' : 'Ping'}
            </Button>
            {pingError && (
              <Typography sx={{ color: '#f87171', fontSize: '0.875rem', mb: 1 }}>{pingError}</Typography>
            )}
            <Typography variant="subtitle2" sx={{ color: '#94a3b8', mb: 1, mt: 2 }}>
              Drone controls
            </Typography>
            {isWebRtc && (
              <Typography sx={{ color: '#64748b', fontSize: '0.8125rem', mb: 1 }}>
                MAVLink commands will be available after the data channel bridge is wired on the Pi.
              </Typography>
            )}
            <Box sx={{ display: 'flex', gap: 1, mb: 1, flexWrap: 'wrap' }}>
              <Button
                variant="outlined"
                size="small"
                onClick={() => sendCommand('takeoff', 2.5)}
                disabled={isWebRtc}
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
                disabled={isWebRtc}
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
            {ctrlError && (
              <Typography sx={{ color: '#f87171', fontSize: '0.875rem', mb: 1 }}>{ctrlError}</Typography>
            )}
            {logLines.length > 0 && (
              <Box
                component="pre"
                sx={{
                  p: 1.5,
                  backgroundColor: '#0f172a',
                  border: '1px solid #334155',
                  borderRadius: '0.375rem',
                  fontSize: '0.8125rem',
                  color: '#e2e8f0',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  maxHeight: 200,
                  overflow: 'auto',
                }}
              >
                {logLines.join('\n')}
              </Box>
            )}
          </>
        )}
      </DialogContent>
      <DialogActions
        sx={{
          borderTop: '1px solid #334155',
          p: 2,
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <IconButton
          size="small"
          aria-label="Connection settings"
          disabled={!data}
          onClick={(e) => {
            setSettingsError(null)
            setSettingsAnchor(e.currentTarget)
          }}
          sx={{
            color: '#64748b',
            '&:hover': { color: '#94a3b8', backgroundColor: 'rgba(148, 163, 184, 0.08)' },
          }}
        >
          <SettingsOutlinedIcon sx={{ fontSize: 20 }} />
        </IconButton>
        <Button onClick={onClose} sx={{ color: '#3b82f6' }} disableRipple>
          Close
        </Button>
      </DialogActions>
      <Popover
        open={settingsOpen}
        anchorEl={settingsAnchor}
        onClose={() => setSettingsAnchor(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{
          paper: {
            sx: {
              backgroundColor: '#1e293b',
              border: '1px solid #334155',
              borderRadius: '0.5rem',
              p: 2,
              width: 280,
              maxWidth: '90vw',
            },
          },
        }}
      >
        <Typography sx={{ fontSize: '0.8125rem', fontWeight: 600, color: '#e2e8f0', mb: 1.5 }}>
          Connection settings
        </Typography>
        <TextField
          label="Name"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          size="small"
          fullWidth
          sx={{
            mb: 1.5,
            '& .MuiOutlinedInput-root': { color: '#f8fafc', backgroundColor: '#0f172a' },
            '& .MuiInputLabel-root': { color: '#94a3b8' },
          }}
        />
        <FormControl fullWidth size="small" sx={{ mb: 1.5 }}>
          <InputLabel sx={{ color: '#94a3b8' }}>Session TTL</InputLabel>
          <Select
            label="Session TTL"
            value={editTtl}
            onChange={(e) => setEditTtl(Number(e.target.value))}
            sx={{ color: '#f8fafc', backgroundColor: '#0f172a' }}
          >
            {TTL_OPTIONS.map((o) => (
              <MenuItem key={o.value} value={o.value}>
                {o.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        {data?.status === 'active' && (
          <Typography sx={{ fontSize: '0.75rem', mb: 1.5, color: '#64748b' }}>
            Auto-idle: {formatExpiresAt(data.expires_at)}
          </Typography>
        )}
        {settingsError && (
          <Typography sx={{ color: '#f87171', fontSize: '0.8125rem', mb: 1 }}>{settingsError}</Typography>
        )}
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
          <Button
            size="small"
            onClick={() => setSettingsAnchor(null)}
            sx={{ color: '#94a3b8', textTransform: 'none' }}
          >
            Cancel
          </Button>
          <Button
            size="small"
            variant="contained"
            disabled={savingSettings}
            onClick={() => void handleSaveSettings()}
            sx={{ textTransform: 'none', backgroundColor: '#3b82f6' }}
          >
            {savingSettings ? 'Saving…' : 'Save'}
          </Button>
        </Box>
      </Popover>
    </Dialog>
  )
}
