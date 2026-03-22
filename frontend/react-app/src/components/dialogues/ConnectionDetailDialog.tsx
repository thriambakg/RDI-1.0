import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Box,
  Typography,
} from '@mui/material'
import { useCallback, useEffect, useState } from 'react'
import { getSession, reconnectSession } from '../../services/sessionApi'
import { useSessionWebSocket } from '../../contexts/SessionWebSocketContext'
import type { RelayRef } from '../../services/profileApi'

const PING_BYTES = new Uint8Array([0x50, 0x49, 0x4e, 0x47]) // "PING"
const PONG_BYTES = new Uint8Array([0x50, 0x4f, 0x4e, 0x47]) // "PONG"
const RLOG_PREFIX = new Uint8Array([0x52, 0x4c, 0x4f, 0x47]) // "RLOG"
const CTRL_PREFIX = new TextEncoder().encode('CTRL')

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
  relays?: RelayRef[]
}

interface HopLog {
  hop: string
  message: string
}

export function ConnectionDetailDialog({ sessionId, open, onClose, relays = [] }: ConnectionDetailDialogProps) {
  const [data, setData] = useState<{
    session_id: string
    drone_id: string
    endpoint: string
    status: string
    relay_id?: string
    carrier_ip?: string
    mavlink_host?: string
    mavlink_port?: string | number
  } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [logLines, setLogLines] = useState<string[]>([])
  const [pingRunning, setPingRunning] = useState(false)
  const [pingError, setPingError] = useState<string | null>(null)
  const [ctrlError, setCtrlError] = useState<string | null>(null)
  const [reconnectLoading, setReconnectLoading] = useState(false)
  const [reconnectError, setReconnectError] = useState<string | null>(null)

  const { getWs, openSession, connectionState, connectionError } = useSessionWebSocket()

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
      setCtrlError(null)
      try {
        sendDroneCommand(ws, cmd, alt)
      } catch (e) {
        setCtrlError(e instanceof Error ? e.message : 'Failed to send command')
      }
    },
    [data?.session_id, getWs]
  )

  useEffect(() => {
    if (!open || !sessionId) {
      setData(null)
      setError(null)
      setLogLines([])
      setPingError(null)
      setCtrlError(null)
      setReconnectError(null)
      return
    }
    setLoading(true)
    setError(null)
    getSession(sessionId)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false))
  }, [open, sessionId])

  // Keep WebSocket open for active sessions when dialog is open
  useEffect(() => {
    if (!open || !sessionId || !data?.endpoint || data?.status !== 'active') return
    openSession(sessionId, data.endpoint)
  }, [open, sessionId, data?.endpoint, data?.status, openSession])

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
          add(`2. Wavelength: instance responded (T+${ms}ms)`)
          add(`Success — full round-trip (client → proxy → Wavelength instance → proxy → client) (T+${ms}ms).`)
          finish()
        }
      }
      if (event.data instanceof Blob) {
        event.data.arrayBuffer().then((ab) => {
          const arr = new Uint8Array(ab)
          if (arr.length === PONG_BYTES.length && arr.every((b, i) => b === PONG_BYTES[i])) {
            add(`2. Wavelength: instance responded (T+${ms}ms)`)
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
          } else if (obj.hop === 'wavelength') {
            add(`2. Wavelength: ${obj.message} (T+${ms}ms)`)
            if (obj.message === 'instance responded') {
              add(`Success — full round-trip (client → proxy → Wavelength instance → proxy → client) (T+${ms}ms).`)
              finish()
            } else {
              finish(
                'Proxy reached; no agent on Wavelength instance. The agent is started when you create a session and runs for that session only. ' +
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
  }, [data?.session_id, getWs, addLog])

  const handleReconnect = useCallback(async () => {
    if (!data?.session_id) return
    setReconnectLoading(true)
    setReconnectError(null)
    try {
      await reconnectSession(data.session_id)
      addLog('Reconnect requested — agent should connect within a few seconds. Try Ping to verify.')
      if (data?.endpoint) {
        openSession(data.session_id, data.endpoint)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Reconnect failed'
      setReconnectError(msg)
    } finally {
      setReconnectLoading(false)
    }
  }, [data?.session_id, data?.endpoint, openSession, addLog])

  const name = data?.drone_id ? data.drone_id.split('-').slice(0, -1).join('-') || data.drone_id : ''
  const wsState = sessionId ? connectionState(sessionId) : 'closed'
  const wsError = sessionId ? connectionError(sessionId) : null
  const isConnected = wsState === 'open'
  const isFailed = wsState === 'failed'

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
                  wsState === 'open'
                    ? '#22c55e'
                    : wsState === 'failed'
                      ? '#ef4444'
                      : wsState === 'connecting'
                        ? '#eab308'
                        : '#64748b',
                flexShrink: 0,
              }}
              aria-label={
                isConnected ? 'Connection established' : isFailed ? 'Connection failed' : wsState === 'connecting' ? 'Connecting' : 'Not connected'
              }
            />
            <Typography component="span" variant="caption" sx={{ color: '#94a3b8', textTransform: 'none' }}>
              {wsState === 'open'
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
        {isFailed && wsError && (
          <Box sx={{ mb: 2 }}>
            <Typography sx={{ color: '#f87171', fontSize: '0.875rem' }}>{wsError}</Typography>
            {data?.endpoint && (
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
        {data?.status === 'active' && data?.carrier_ip && (
          <Box sx={{ mb: 2 }}>
            <Typography sx={{ color: '#94a3b8', fontSize: '0.875rem', mb: 1 }}>
              Connection dropped after a pipeline reboot? Reinstate the agent on the Wavelength instance.
            </Typography>
            <Button
              variant="outlined"
              size="small"
              onClick={handleReconnect}
              disabled={reconnectLoading}
              disableRipple
              sx={{
                color: '#3b82f6',
                borderColor: '#475569',
                textTransform: 'none',
                '&:hover': { borderColor: '#3b82f6' },
              }}
            >
              {reconnectLoading ? 'Reconnecting…' : 'Reconnect agent'}
            </Button>
            {reconnectError && (
              <Typography sx={{ color: '#f87171', fontSize: '0.875rem', mt: 1 }}>{reconnectError}</Typography>
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
                <strong>Name:</strong> {name || data.drone_id}
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
                      PX4 must run on the same machine as the agent (Wavelength instance). Local PX4 on your laptop
                      will not receive commands — run PX4 SITL on the Wavelength EC2 instead.
                    </Typography>
                  )}
                </>
              )}
              {data.carrier_ip && (
                <Typography sx={{ fontSize: '0.875rem', mt: 0.5, color: '#94a3b8' }}>
                  <strong>Wavelength instance:</strong> {data.carrier_ip}
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
              disabled={pingRunning}
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
      <DialogActions sx={{ borderTop: '1px solid #334155', p: 2 }}>
        <Button onClick={onClose} sx={{ color: '#3b82f6' }} disableRipple>
          Close
        </Button>
      </DialogActions>
    </Dialog>
  )
}
