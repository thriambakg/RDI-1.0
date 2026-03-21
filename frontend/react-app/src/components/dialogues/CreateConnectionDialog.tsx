import { useState } from 'react'
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  MenuItem,
  Box,
  Typography,
} from '@mui/material'
import { createSession } from '../../services/sessionApi'
import type { CreateSessionResponse } from '../../services/sessionApi'
import type { RelayRef } from '../../services/profileApi'
import './CreateConnectionDialog.css'

const TTL_OPTIONS = [
  { value: 0, label: 'No TTL (indefinite)' },
  { value: 3600, label: '1 hour' },
  { value: 14400, label: '4 hours' },
  { value: 28800, label: '8 hours' },
  { value: 86400, label: '24 hours' },
  { value: 604800, label: '7 days' },
]

const MAVLINK_PORT_OPTIONS = [
  { value: 14540, label: '14540 (PX4 legacy)' },
  { value: 18570, label: '18570 (PX4 v1.13+)' },
]

const inputSx = {
  '& .MuiOutlinedInput-root': {
    color: '#f8fafc !important',
    backgroundColor: '#0f172a !important',
    '& fieldset': { borderColor: '#334155 !important' },
    '&:hover fieldset': { borderColor: '#475569 !important' },
    '&.Mui-focused fieldset': { borderColor: '#3b82f6 !important', borderWidth: 1 },
    '& input': { color: '#f8fafc !important' },
    '& input::placeholder': { color: '#64748b !important', opacity: 1 },
    '& .MuiSelect-select': { color: '#f8fafc !important' },
    '& .MuiSvgIcon-root': { color: '#94a3b8 !important' },
  },
  '& .MuiInputLabel-root': { color: '#94a3b8 !important' },
  '& .MuiInputLabel-root.Mui-focused': { color: '#94a3b8 !important' },
  '& .MuiInputLabel-root.MuiInputLabel-shrink': { color: '#94a3b8 !important' },
}

const menuProps = {
  PaperProps: {
    sx: {
      backgroundColor: '#1e293b',
      border: '1px solid #334155',
      '& .MuiMenuItem-root': {
        color: '#f8fafc',
        '&:hover': { backgroundColor: 'rgba(59, 130, 246, 0.15)' },
        '&.Mui-selected': { backgroundColor: 'rgba(59, 130, 246, 0.25)' },
      },
    },
  },
}

export interface CreateConnectionDialogProps {
  isOpen: boolean
  onClose: () => void
  wavelengthZoneId: string
  folderPath?: string[]
  relays: RelayRef[]
  onRegisterRelayClick?: () => void
  onSuccess?: (result: CreateSessionResponse, displayName: string) => void
}

export function CreateConnectionDialog({
  isOpen,
  onClose,
  wavelengthZoneId,
  folderPath = ['My Drones'],
  relays,
  onRegisterRelayClick,
  onSuccess,
}: CreateConnectionDialogProps) {
  const [droneName, setDroneName] = useState('')
  const [relayId, setRelayId] = useState('')
  const [ttlSeconds, setTtlSeconds] = useState(14400)
  const [mavlinkPort, setMavlinkPort] = useState(18570)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<CreateSessionResponse | null>(null)

  const noRelays = relays.length === 0
  const canSubmit = !noRelays && relayId

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit) return
    setError(null)
    setLoading(true)
    try {
      const res = await createSession({
        drone_name: droneName.trim() || 'drone',
        ttl_seconds: ttlSeconds === 0 ? 0 : ttlSeconds,
        wavelength_zone_id: wavelengthZoneId,
        folder_path: folderPath,
        relay_id: relayId,
        metadata: {
          mavlink_port: mavlinkPort,
          mavlink_host: '127.0.0.1',
          px4_version: mavlinkPort === 18570 ? 'v1.13+' : 'legacy',
        },
      })
      setResult(res)
      onSuccess?.(res, droneName.trim() || res.drone_id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create session')
    } finally {
      setLoading(false)
    }
  }

  const handleClose = () => {
    setDroneName('')
    setRelayId('')
    setTtlSeconds(14400)
    setMavlinkPort(18570)
    setError(null)
    setResult(null)
    onClose()
  }

  return (
    <Dialog
      className="rdi-create-connection-dialog"
      open={isOpen}
      onClose={handleClose}
      maxWidth="xs"
      fullWidth
      BackdropProps={{
        sx: {
          backgroundColor: 'rgba(0, 0, 0, 0.6)',
          backdropFilter: 'blur(4px)',
        },
      }}
      PaperProps={{
        sx: {
          backgroundColor: '#1e293b !important',
          border: '1px solid #334155',
          borderRadius: '0.5rem',
          color: '#f8fafc',
        },
      }}
    >
      <DialogTitle
        sx={{
          color: '#ffffff !important',
          fontSize: '1.25rem',
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          pb: 1,
          backgroundColor: '#1e293b',
        }}
      >
        Create Connection
      </DialogTitle>

      {result ? (
        <DialogContent sx={{ pt: 0, backgroundColor: '#1e293b', color: '#f8fafc' }}>
          <Typography sx={{ color: '#f8fafc', mb: 2 }}>
            Connection created successfully.
          </Typography>
          <Box
            sx={{
              p: 2,
              backgroundColor: '#0f172a',
              border: '1px solid #334155',
              borderRadius: '0.375rem',
              mb: 2,
            }}
          >
            <Typography sx={{ color: '#f8fafc', fontSize: '0.875rem', mb: 1 }}>
              <strong>Session ID:</strong> {result.session_id}
            </Typography>
            <Typography sx={{ color: '#f8fafc', fontSize: '0.875rem', mb: 1 }}>
              <strong>Drone ID:</strong> {result.drone_id}
            </Typography>
            <Typography sx={{ color: '#f8fafc', fontSize: '0.875rem', mb: 1 }}>
              <strong>Endpoint:</strong> {result.endpoint}
            </Typography>
            <Typography sx={{ color: '#94a3b8', fontSize: '0.8rem' }}>
              {result.relay_config
                ? `Run the agent with RDI_SESSION_ID=${result.session_id} RDI_MAVLINK_HOST=${result.relay_config.mavlink_host ?? '127.0.0.1'} RDI_MAVLINK_PORT=${result.relay_config.mavlink_port ?? mavlinkPort}`
                : `Run the agent with RDI_SESSION_ID=${result.session_id} RDI_MAVLINK_PORT=${result.mavlink_port ?? mavlinkPort}`}
            </Typography>
          </Box>
          <DialogActions sx={{ px: 0, backgroundColor: '#1e293b' }}>
            <Button onClick={handleClose} variant="contained" disableRipple>
              Done
            </Button>
          </DialogActions>
        </DialogContent>
      ) : (
        <form onSubmit={handleSubmit}>
          <DialogContent sx={{ pt: 0, backgroundColor: '#1e293b', color: '#f8fafc' }}>
            {noRelays ? (
              <Box sx={{ mb: 2, p: 2, backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '0.375rem' }}>
                <Typography sx={{ color: '#f8fafc', fontSize: '0.875rem', mb: 1 }}>
                  No relays registered for this zone. Register a relay first to create connections.
                </Typography>
                {onRegisterRelayClick && (
                  <Button
                    onClick={onRegisterRelayClick}
                    sx={{ color: '#3b82f6', textTransform: 'none', p: 0, mt: 0.5 }}
                    disableRipple
                  >
                    Register relay
                  </Button>
                )}
              </Box>
            ) : (
              <TextField
                fullWidth
                select
                label="Relay"
                value={relayId}
                onChange={(e) => setRelayId(e.target.value)}
                required
                margin="normal"
                sx={inputSx}
                SelectProps={{ MenuProps: menuProps }}
                helperText="Select which relay this connection will route through"
              >
                <MenuItem value="" disabled>
                  Select a relay
                </MenuItem>
                {relays.map((r) => (
                  <MenuItem key={r.relay_id} value={r.relay_id} disableRipple>
                    {r.name} ({r.relay_type})
                  </MenuItem>
                ))}
              </TextField>
            )}
            <TextField
              fullWidth
              label="Connection Name"
              placeholder="e.g. survey-alpha"
              value={droneName}
              onChange={(e) => setDroneName(e.target.value)}
              required
              autoComplete="off"
              margin="normal"
              sx={inputSx}
            />
            <TextField
              fullWidth
              select
              label="Session TTL"
              value={ttlSeconds}
              onChange={(e) => setTtlSeconds(Number(e.target.value))}
              margin="normal"
              sx={inputSx}
              SelectProps={{ MenuProps: menuProps }}
            >
              {TTL_OPTIONS.map((o) => (
                <MenuItem key={o.value} value={o.value} disableRipple>
                  {o.label}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              fullWidth
              select
              label="MAVLink port (PX4)"
              value={mavlinkPort}
              onChange={(e) => setMavlinkPort(Number(e.target.value))}
              margin="normal"
              sx={inputSx}
              SelectProps={{ MenuProps: menuProps }}
            >
              {MAVLINK_PORT_OPTIONS.map((o) => (
                <MenuItem key={o.value} value={o.value} disableRipple>
                  {o.label}
                </MenuItem>
              ))}
            </TextField>
            {error && (
              <Typography sx={{ color: '#f87171', fontSize: '0.875rem', mt: 1 }}>
                {error}
              </Typography>
            )}
          </DialogContent>
          <DialogActions sx={{ borderTop: '1px solid #334155', p: 2, gap: 1, backgroundColor: '#1e293b' }}>
            <Button onClick={handleClose} disableRipple sx={{ color: '#3b82f6' }}>
              Cancel
            </Button>
            <Button type="submit" variant="contained" disabled={loading || !canSubmit} disableRipple>
              {loading ? 'Creating...' : 'Create'}
            </Button>
          </DialogActions>
        </form>
      )}
    </Dialog>
  )
}
