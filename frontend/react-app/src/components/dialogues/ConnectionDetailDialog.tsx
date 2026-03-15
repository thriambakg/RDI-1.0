import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Box,
  Typography,
} from '@mui/material'
import { useEffect, useState } from 'react'
import { getSession } from '../../services/sessionApi'

interface ConnectionDetailDialogProps {
  sessionId: string | null
  open: boolean
  onClose: () => void
}

export function ConnectionDetailDialog({ sessionId, open, onClose }: ConnectionDetailDialogProps) {
  const [data, setData] = useState<{ session_id: string; drone_id: string; endpoint: string; status: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !sessionId) {
      setData(null)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    getSession(sessionId)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false))
  }, [open, sessionId])

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
          <Box
            sx={{
              p: 2,
              backgroundColor: '#0f172a',
              border: '1px solid #334155',
              borderRadius: '0.375rem',
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
