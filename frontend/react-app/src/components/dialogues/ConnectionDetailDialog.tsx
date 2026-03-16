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
import { getSession } from '../../services/sessionApi'
import { useSessionWebSocket } from '../../contexts/SessionWebSocketContext'

const PING_BYTES = new Uint8Array([0x50, 0x49, 0x4e, 0x47]) // "PING"

const WS_CLOSE_REASONS: Record<number, string> = {
  1000: 'Normal closure',
  1001: 'Going away',
  1002: 'Protocol error',
  1003: 'Unsupported data',
  1005: 'No status received',
  1006: 'Abnormal closure (no close frame — check ALB target health, listener, proxy)',
  1007: 'Invalid frame payload',
  1008: 'Policy violation',
  1011: 'Internal server error',
  1015: 'TLS handshake failed',
}

interface ConnectionDetailDialogProps {
  sessionId: string | null
  open: boolean
  onClose: () => void
}

interface HopLog {
  hop: string
  message: string
}

export function ConnectionDetailDialog({ sessionId, open, onClose }: ConnectionDetailDialogProps) {
  const [data, setData] = useState<{ session_id: string; drone_id: string; endpoint: string; status: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pingLog, setPingLog] = useState<string[]>([])
  const [pingRunning, setPingRunning] = useState(false)
  const [pingError, setPingError] = useState<string | null>(null)

  const { getWs, openSession, connectionState } = useSessionWebSocket()

  useEffect(() => {
    if (!open || !sessionId) {
      setData(null)
      setError(null)
      setPingLog([])
      setPingError(null)
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

  const runPing = useCallback(() => {
    if (!data?.session_id) return
    const ws = getWs(data.session_id)
    if (!ws) {
      setPingError('Connection not ready. Wait a moment for the connection to establish, then try again.')
      return
    }

    setPingRunning(true)
    setPingError(null)
    setPingLog([])

    const start = performance.now()
    const logs: string[] = []
    const add = (line: string) => {
      logs.push(line)
      setPingLog([...logs])
    }
    const elapsed = () => Math.round(performance.now() - start)

    let closed = false
    const finish = (err?: string) => {
      if (closed) return
      closed = true
      setPingRunning(false)
      if (err) setPingError(err)
      ws.onmessage = () => {}
    }

    add(`Pinging over existing connection…`)

    const prevOnMessage = ws.onmessage
    ws.onmessage = (event) => {
      const ms = elapsed()
      if (typeof event.data === 'string') {
        try {
          const obj = JSON.parse(event.data) as HopLog & { error?: string; message?: string }
          if (obj.error === 'session idle') {
            add(`Session is idle (T+${ms}ms). Reactivate in console to connect.`)
            finish('Session is idle. Reactivate this connection in the console, then ping again.')
            return
          }
          if (obj.hop === 'proxy_ec2') {
            add(`1. Proxy EC2: ${obj.message} (T+${ms}ms)`)
          } else if (obj.hop === 'wavelength') {
            add(`2. Wavelength: ${obj.message} (T+${ms}ms)`)
            add(`Success — all hops reached (T+${ms}ms).`)
            finish()
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
  }, [data?.session_id, getWs])

  const name = data?.drone_id ? data.drone_id.split('-').slice(0, -1).join('-') || data.drone_id : ''
  const wsState = sessionId ? connectionState(sessionId) : 'closed'
  const isConnected = wsState === 'open'

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
                  wsState === 'open' ? '#22c55e' : wsState === 'connecting' ? '#eab308' : '#64748b',
                flexShrink: 0,
              }}
              aria-label={isConnected ? 'Connection established' : wsState === 'connecting' ? 'Connecting' : 'Disconnected'}
            />
            <Typography component="span" variant="caption" sx={{ color: '#94a3b8', textTransform: 'none' }}>
              {wsState === 'open' ? 'Connection established' : wsState === 'connecting' ? 'Connecting…' : 'Not connected'}
            </Typography>
          </Box>
        )}
      </DialogTitle>
      <DialogContent sx={{ color: '#f8fafc' }}>
        {loading && <Typography sx={{ color: '#94a3b8' }}>Loading…</Typography>}
        {error && <Typography sx={{ color: '#f87171' }}>{error}</Typography>}
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
              <Typography sx={{ fontSize: '0.875rem', color: '#94a3b8' }}>
                <strong>Endpoint:</strong> {data.endpoint}
              </Typography>
            </Box>

            <Typography variant="subtitle2" sx={{ color: '#94a3b8', mb: 1 }}>
              Test connection
            </Typography>
            <Button
              variant="outlined"
              size="small"
              onClick={runPing}
              disabled={pingRunning}
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
            {pingLog.length > 0 && (
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
                {pingLog.join('\n')}
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
