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
import { listRelays } from '../../services/relayApi'
import type { RelayRef } from '../../services/profileApi'

interface RelayDetailDialogProps {
  relay: RelayRef | null
  open: boolean
  onClose: () => void
}

interface RelayDetails extends RelayRef {
  config?: { mavlink_host?: string }
}

export function RelayDetailDialog({ relay, open, onClose }: RelayDetailDialogProps) {
  const [details, setDetails] = useState<RelayDetails | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open || !relay) {
      setDetails(null)
      return
    }
    setDetails({ ...relay })
    setLoading(true)
    listRelays(relay.wavelength_zone_id)
      .then((res) => {
        const full = res.relays.find((r) => r.relay_id === relay.relay_id)
        if (full && 'config' in full) {
          setDetails({ ...relay, ...full } as RelayDetails)
        }
      })
      .catch(() => setDetails(relay))
      .finally(() => setLoading(false))
  }, [open, relay])

  if (!relay) return null

  const config = details?.config
  const hasMavlinkConfig = config && config.mavlink_host

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
        }}
      >
        Relay details
      </DialogTitle>
      <DialogContent sx={{ color: '#f8fafc' }}>
        {loading && !details ? (
          <Typography sx={{ color: '#94a3b8' }}>Loading…</Typography>
        ) : (
          <Box
            sx={{
              p: 2,
              backgroundColor: '#0f172a',
              border: '1px solid #334155',
              borderRadius: '0.375rem',
            }}
          >
            <Typography sx={{ fontSize: '0.875rem', mb: 1 }}>
              <strong>Name:</strong> {relay.name}
            </Typography>
            <Typography sx={{ fontSize: '0.875rem', mb: 1 }}>
              <strong>Relay ID:</strong> {relay.relay_id}
            </Typography>
            <Typography sx={{ fontSize: '0.875rem', mb: 1 }}>
              <strong>Region:</strong> {relay.wavelength_zone_id}
            </Typography>
            <Typography sx={{ fontSize: '0.875rem', mb: 1 }}>
              <strong>Type:</strong> {relay.relay_type}
            </Typography>
            <Typography sx={{ fontSize: '0.875rem', mb: hasMavlinkConfig ? 1 : 0 }}>
              <strong>Status:</strong>{' '}
              <Box
                component="span"
                sx={{
                  color:
                    relay.status === 'online'
                      ? '#22c55e'
                      : relay.status === 'idle'
                        ? '#eab308'
                        : '#94a3b8',
                }}
              >
                {relay.status === 'online' ? 'Online' : relay.status === 'idle' ? 'Idle' : 'Offline'}
              </Box>
            </Typography>
            {hasMavlinkConfig && (
              <Box sx={{ mt: 1, pt: 1, borderTop: '1px solid #334155' }}>
                <Typography sx={{ fontSize: '0.875rem', color: '#94a3b8', mb: 0.5 }}>
                  MAVLink host
                </Typography>
                <Typography sx={{ fontSize: '0.875rem' }}>
                  {config.mavlink_host ?? '127.0.0.1'} (port set per connection)
                </Typography>
              </Box>
            )}
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
