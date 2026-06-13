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
  ToggleButton,
  ToggleButtonGroup,
} from '@mui/material'
import { registerRelay, claimRelay } from '../../services/relayApi'
import type { RegisterRelayResponse } from '../../services/relayApi'
import './CreateConnectionDialog.css'

const RELAY_TYPE_OPTIONS = [
  { value: 'local', label: 'Local (dev laptop / tunnel)' },
  { value: 'sim_relay', label: 'SIM relay (fixed-wing)' },
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

export interface RegisterRelayDialogProps {
  isOpen: boolean
  onClose: () => void
  wavelengthZoneId: string
  zoneLabel?: string
  onSuccess?: (result: RegisterRelayResponse) => void
}

type RegisterMode = 'claim' | 'manual'

export function RegisterRelayDialog({
  isOpen,
  onClose,
  wavelengthZoneId,
  zoneLabel,
  onSuccess,
}: RegisterRelayDialogProps) {
  const [mode, setMode] = useState<RegisterMode>('claim')
  const [name, setName] = useState('')
  const [claimCode, setClaimCode] = useState('')
  const [relayType, setRelayType] = useState<'local' | 'sim_relay'>('sim_relay')
  const [mavlinkHost, setMavlinkHost] = useState('127.0.0.1')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<RegisterRelayResponse | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const config: Record<string, unknown> = {}
      if (relayType === 'local') {
        config.mavlink_host = mavlinkHost.trim() || '127.0.0.1'
      }
      const res =
        mode === 'claim'
          ? await claimRelay({
              claim_code: claimCode,
              wavelength_zone_id: wavelengthZoneId,
              name: name.trim() || 'relay',
              relay_type: relayType,
              config: Object.keys(config).length > 0 ? config : undefined,
            })
          : await registerRelay({
              wavelength_zone_id: wavelengthZoneId,
              name: name.trim() || 'relay',
              relay_type: relayType,
              config: Object.keys(config).length > 0 ? config : undefined,
            })
      setResult(res)
      onSuccess?.(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to register relay')
    } finally {
      setLoading(false)
    }
  }

  const handleClose = () => {
    setMode('claim')
    setName('')
    setClaimCode('')
    setRelayType('sim_relay')
    setMavlinkHost('127.0.0.1')
    setError(null)
    setResult(null)
    onClose()
  }

  const copyRelayId = async () => {
    if (!result?.relay_id) return
    try {
      await navigator.clipboard.writeText(result.relay_id)
    } catch {
      /* ignore */
    }
  }

  return (
    <Dialog
      className="rdi-create-connection-dialog rdi-register-relay-dialog"
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
        Add Relay
      </DialogTitle>

      {result ? (
        <DialogContent sx={{ pt: 0, backgroundColor: '#1e293b', color: '#f8fafc' }}>
          <Typography sx={{ color: '#f8fafc', mb: 2 }}>
            {mode === 'claim' ? 'Relay claimed successfully.' : 'Relay registered successfully.'}
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
              <strong>Relay ID:</strong> {result.relay_id}
            </Typography>
            <Typography sx={{ color: '#f8fafc', fontSize: '0.875rem', mb: 1 }}>
              <strong>Name:</strong> {result.name}
            </Typography>
            {relayType === 'local' && mavlinkHost && (
              <Typography sx={{ color: '#f8fafc', fontSize: '0.875rem', mb: 1 }}>
                <strong>MAVLink host:</strong> {mavlinkHost} (port is set per connection)
              </Typography>
            )}
            <Typography sx={{ color: '#94a3b8', fontSize: '0.8rem' }}>
              {mode === 'claim'
                ? 'Your device will detect the claim automatically. You can now create a connection with this relay.'
                : 'You can now select this relay when creating a new connection.'}
            </Typography>
          </Box>
          <DialogActions sx={{ px: 0, backgroundColor: '#1e293b', gap: 1 }}>
            <Button onClick={copyRelayId} disableRipple sx={{ color: '#3b82f6' }}>
              Copy Relay ID
            </Button>
            <Button onClick={handleClose} variant="contained" disableRipple>
              Done
            </Button>
          </DialogActions>
        </DialogContent>
      ) : (
        <form onSubmit={handleSubmit}>
          <DialogContent sx={{ pt: 0, backgroundColor: '#1e293b', color: '#f8fafc' }}>
            {zoneLabel && (
              <Typography sx={{ color: '#94a3b8', fontSize: '0.875rem', mb: 1 }}>
                Region: {zoneLabel}
              </Typography>
            )}
            <ToggleButtonGroup
              value={mode}
              exclusive
              onChange={(_, v: RegisterMode | null) => v && setMode(v)}
              fullWidth
              sx={{ mb: 2, '& .MuiToggleButton-root': { color: '#94a3b8', borderColor: '#334155' } }}
            >
              <ToggleButton value="claim" sx={{ '&.Mui-selected': { color: '#f8fafc', backgroundColor: '#0f172a' } }}>
                Claim device
              </ToggleButton>
              <ToggleButton value="manual" sx={{ '&.Mui-selected': { color: '#f8fafc', backgroundColor: '#0f172a' } }}>
                Register manually
              </ToggleButton>
            </ToggleButtonGroup>
            {mode === 'claim' && (
              <Box sx={{ mb: 2, p: 1.5, backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '0.375rem' }}>
                <Typography sx={{ color: '#94a3b8', fontSize: '0.8rem' }}>
                  Power on your relay and run the device setup script. Enter the 8-character pairing code shown on the device (or in its logs).
                </Typography>
              </Box>
            )}
            {mode === 'claim' && (
              <TextField
                fullWidth
                label="Pairing code"
                placeholder="e.g. A1B2C3D4"
                value={claimCode}
                onChange={(e) => setClaimCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8))}
                required
                autoComplete="off"
                margin="normal"
                inputProps={{ style: { letterSpacing: '0.2em', fontFamily: 'monospace' } }}
                sx={inputSx}
                helperText="8-character code from the relay device"
              />
            )}
            <TextField
              fullWidth
              label="Relay Name"
              placeholder="e.g. RDIRelay"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoComplete="off"
              margin="normal"
              sx={inputSx}
            />
            <TextField
              fullWidth
              select
              label="Relay Type"
              value={relayType}
              onChange={(e) => setRelayType(e.target.value as 'local' | 'sim_relay')}
              margin="normal"
              sx={inputSx}
              SelectProps={{ MenuProps: menuProps }}
            >
              {RELAY_TYPE_OPTIONS.map((o) => (
                <MenuItem key={o.value} value={o.value} disableRipple>
                  {o.label}
                </MenuItem>
              ))}
            </TextField>
            {relayType === 'local' && (
              <Box sx={{ mt: 1, p: 1.5, backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '0.375rem' }}>
                <Typography sx={{ color: '#94a3b8', fontSize: '0.75rem', mb: 1.5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  MAVLink host
                </Typography>
                <TextField
                  fullWidth
                  label="Host (IP)"
                  placeholder="127.0.0.1"
                  value={mavlinkHost}
                  onChange={(e) => setMavlinkHost(e.target.value)}
                  margin="dense"
                  size="small"
                  sx={inputSx}
                  helperText="IP where PX4/sim listens. Port is set per connection."
                />
              </Box>
            )}
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
            <Button
              type="submit"
              variant="contained"
              disabled={loading || (mode === 'claim' && claimCode.length !== 8)}
              disableRipple
            >
              {loading ? (mode === 'claim' ? 'Claiming...' : 'Registering...') : mode === 'claim' ? 'Claim relay' : 'Register'}
            </Button>
          </DialogActions>
        </form>
      )}
    </Dialog>
  )
}
