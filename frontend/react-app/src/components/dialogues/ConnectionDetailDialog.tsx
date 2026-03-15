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

    const logs: string[] = []
    const add = (line: string) => {
      logs.push(line)
      setPingLog([...logs])
    }

    const wsUrl = data.endpoint.replace(/^http/, 'ws')
    let ws: WebSocket | null = null
    let closed = false

    const finish = (err?: string) => {
      if (closed) return
      closed = true
      setPingRunning(false)
      if (err) setPingError(err)
      try {
        ws?.close()
      } catch {
        // ignore
      }
    }

    try {
      ws = new WebSocket(wsUrl)
    } catch (e) {
      finish(e instanceof Error ? e.message : 'Failed to open WebSocket')
      return
    }

    ws.onopen = () => {
      add('1. ALB: connection established')
      ws?.send(`frontend:${data.session_id}`)
    }

    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const obj = JSON.parse(event.data) as HopLog
          if (obj.hop === 'proxy_ec2') {
            add(`2. Proxy EC2: ${obj.message}`)
            ws?.send(PING_BYTES)
          } else if (obj.hop === 'wavelength') {
            add(`3. Wavelength: ${obj.message}`)
            add('Success — all hops reached.')
            finish()
          }
        } catch {
          // ignore non-JSON
        }
      }
    }

    ws.onerror = () => {
      if (!closed) add('WebSocket error')
    }

    ws.onclose = () => {
      if (!closed) finish('Connection closed before completing ping.')
    }

    const t = setTimeout(() => {
      if (!closed) finish('Ping timed out.')
    }, 15000)
    return () => clearTimeout(t)
  }, [data?.endpoint, data?.session_id])

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
