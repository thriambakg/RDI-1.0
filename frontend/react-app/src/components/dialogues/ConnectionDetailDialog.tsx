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

  const runPing = useCallback(() => {
    if (!data?.endpoint || !data?.session_id) return
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

    const wsUrl = data.endpoint.replace(/^http/, 'ws')
    let ws: WebSocket | null = null
    let closed = false

    console.log('[RDI Ping] Starting', {
      wsUrl,
      sessionId: data.session_id,
      status: data.status,
    })
    add(`T+0ms — Connecting to ${wsUrl.split('/')[2] ?? wsUrl}…`)

    let opened = false
    const finish = (err?: string) => {
      if (closed) return
      closed = true
      setPingRunning(false)
      if (err) setPingError(err)
      try {
        if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
          ws.close()
        }
      } catch {
        // ignore
      }
    }

    try {
      ws = new WebSocket(wsUrl)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to open WebSocket'
      console.error('[RDI Ping] WebSocket constructor threw', { error: e, msg })
      finish(msg)
      return
    }

    ws.onopen = () => {
      opened = true
      const ms = elapsed()
      console.log('[RDI Ping] WebSocket open', { ms, readyState: ws?.readyState })
      add(`1. ALB: connection established (T+${ms}ms)`)
      ws?.send(`frontend:${data!.session_id}`)
    }

    ws.onmessage = (event) => {
      const ms = elapsed()
      if (typeof event.data === 'string') {
        console.log('[RDI Ping] Message (string)', { ms, data: event.data })
        try {
          const obj = JSON.parse(event.data) as HopLog & { error?: string; message?: string }
          if (obj.error === 'session idle') {
            add(`Session is idle (T+${ms}ms). Reactivate in console to connect.`)
            console.warn('[RDI Ping] Session idle — proxy rejected', { ms })
            finish('Session is idle. Reactivate this connection in the console, then ping again.')
            return
          }
          if (obj.hop === 'proxy_ec2') {
            add(`2. Proxy EC2: ${obj.message} (T+${ms}ms)`)
            ws?.send(PING_BYTES)
          } else if (obj.hop === 'wavelength') {
            add(`3. Wavelength: ${obj.message} (T+${ms}ms)`)
            add(`Success — all hops reached (T+${ms}ms).`)
            console.log('[RDI Ping] Done', { totalMs: ms })
            finish()
          } else {
            add(`Hop: ${obj.hop} — ${obj.message ?? ''} (T+${ms}ms)`)
          }
        } catch {
          if ((event.data as string).trim().length > 0) {
            add(`Raw: ${(event.data as string).slice(0, 80)} (T+${ms}ms)`)
          }
        }
      } else {
        console.log('[RDI Ping] Message (binary)', { ms })
      }
    }

    ws.onerror = (event) => {
      const ms = elapsed()
      console.warn('[RDI Ping] WebSocket error', { ms, event, readyState: ws?.readyState })
      if (!closed) add(`WebSocket error (T+${ms}ms)`)
    }

    ws.onclose = (event) => {
      const ms = elapsed()
      console.warn('[RDI Ping] WebSocket close', {
        ms,
        code: event.code,
        reason: event.reason || '(none)',
        wasClean: event.wasClean,
        neverOpened: !opened,
        hint:
          !opened && event.code === 1006
            ? '1006 = abnormal closure; connection never reached OPEN. Check ALB/proxy/network.'
            : undefined,
      })
      if (!closed) {
        const codeLabel = WS_CLOSE_REASONS[event.code] ?? `Code ${event.code}`
        const reason = event.reason || codeLabel
        const neverOpenedMsg =
          event.code === 1006
            ? `Connection never established (T+${ms}ms): ${reason}. The ALB has no healthy target — in AWS Console check EC2 → Target Groups → rdi-tg-v2-staging → Targets (port 8766 must return HTTP 200). Replace the proxy instance if it was created before the health-check fix, or see docs/WEBSOCKET-ALB-DIAGNOSTIC.md`
            : `Connection never established (T+${ms}ms): ${reason}. See docs/WEBSOCKET-ALB-DIAGNOSTIC.md`
        finish(
          opened
            ? `Connection closed before completing ping (T+${ms}ms): ${reason}`
            : neverOpenedMsg
        )
      }
    }

    const t = setTimeout(() => {
      if (!closed) {
        const ms = elapsed()
        console.warn('[RDI Ping] Timeout', {
          elapsedMs: ms,
          onopenNeverFired: !opened,
          readyState: ws?.readyState,
          hint: !opened
            ? 'Connection never established — check ALB listener, target group health, and proxy reachability.'
            : undefined,
        })
        finish(
          opened
            ? 'Ping timed out (8s).'
            : 'Connection never established (8s). Check ALB, target group health, and proxy.'
        )
      }
    }, 8000)
    return () => clearTimeout(t)
  }, [data?.endpoint, data?.session_id, data?.status])

  const name = data?.drone_id ? data.drone_id.split('-').slice(0, -1).join('-') || data.drone_id : ''

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
      <DialogTitle sx={{ color: '#ffffff', fontWeight: 600, textTransform: 'uppercase' }}>
        Connection details
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
