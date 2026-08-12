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
  Collapse,
} from '@mui/material'
import { createSession } from '../../services/sessionApi'
import type { CreateSessionResponse } from '../../services/sessionApi'
import type { RelayRef } from '../../services/profileApi'
import {
  VEHICLE_STACK_OPTIONS,
  type VehicleStackId,
} from '../../controls/vehicleStacks'
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
  { value: 18570, label: '18570 (PX4 v1.13+ / Gazebo common)' },
  { value: 14540, label: '14540 (PX4 legacy)' },
  { value: 14550, label: '14550 (ArduPilot SITL default)' },
  { value: 14580, label: '14580 (ArduPilot alt)' },
]

const LINK_MODE_OPTIONS = [
  { value: 'shared_serial', label: 'Shared radio (mothership TELEM1)' },
  { value: 'none', label: 'None (WebRTC only)' },
  { value: 'udp_mavlink', label: 'UDP MAVLink (SITL / Gazebo / local)' },
  { value: 'dedicated_serial', label: 'Dedicated serial (lab FTDI)' },
]

type ConnectionPreset = 'field' | 'sim' | 'lab'

const PRESET_DEFAULTS: Record<
  ConnectionPreset,
  { vehicleStack: VehicleStackId; linkMode: string; mavlinkPort: number }
> = {
  field: { vehicleStack: 'px4', linkMode: 'shared_serial', mavlinkPort: 18570 },
  sim: { vehicleStack: 'gazebo_px4', linkMode: 'udp_mavlink', mavlinkPort: 18570 },
  lab: { vehicleStack: 'px4', linkMode: 'dedicated_serial', mavlinkPort: 18570 },
}

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
  const [preset, setPreset] = useState<ConnectionPreset>('field')
  const [ttlSeconds, setTtlSeconds] = useState(14400)
  const [mavlinkPort, setMavlinkPort] = useState(PRESET_DEFAULTS.field.mavlinkPort)
  const [vehicleStack, setVehicleStack] = useState<VehicleStackId>(PRESET_DEFAULTS.field.vehicleStack)
  const [linkMode, setLinkMode] = useState(PRESET_DEFAULTS.field.linkMode)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [overrideSysid, setOverrideSysid] = useState(false)
  const [mavlinkSysid, setMavlinkSysid] = useState(1)
  const [overrideNetId, setOverrideNetId] = useState(false)
  const [radioNetId, setRadioNetId] = useState(25)
  const [radioDevice, setRadioDevice] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<CreateSessionResponse | null>(null)

  const noRelays = relays.length === 0
  const canSubmit = !noRelays && relayId
  const isRfLink = linkMode === 'shared_serial' || linkMode === 'dedicated_serial'

  const applyPreset = (next: ConnectionPreset) => {
    setPreset(next)
    const d = PRESET_DEFAULTS[next]
    setVehicleStack(d.vehicleStack)
    setLinkMode(d.linkMode)
    setMavlinkPort(d.mavlinkPort)
  }

  const handleStackChange = (stack: VehicleStackId) => {
    setVehicleStack(stack)
    const opt = VEHICLE_STACK_OPTIONS.find((o) => o.id === stack)
    if (opt) setMavlinkPort(opt.defaultMavlinkPort)
    if (stack === 'gazebo_px4') setLinkMode('udp_mavlink')
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit) return
    setError(null)
    setLoading(true)
    try {
      const metadata: NonNullable<Parameters<typeof createSession>[0]['metadata']> = {
        mavlink_port: mavlinkPort,
        mavlink_host: '127.0.0.1',
        px4_version: mavlinkPort === 18570 ? 'v1.13+' : 'legacy',
        vehicle_stack: vehicleStack,
        link_mode: linkMode as 'none' | 'shared_serial' | 'dedicated_serial' | 'udp_mavlink',
      }
      // Sysid / net id: omit so API auto-allocates / inherits from relay (unless Advanced override).
      if (isRfLink) {
        if (overrideSysid) metadata.mavlink_sysid = mavlinkSysid
        if (overrideNetId) metadata.radio_net_id = radioNetId
      }
      if (linkMode === 'dedicated_serial' && radioDevice.trim()) {
        metadata.radio_device = radioDevice.trim()
        metadata.radio_baud = 57600
      }
      const res = await createSession({
        drone_name: droneName.trim() || 'drone',
        ttl_seconds: ttlSeconds === 0 ? 0 : ttlSeconds,
        wavelength_zone_id: wavelengthZoneId,
        folder_path: folderPath,
        relay_id: relayId,
        metadata,
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
    setPreset('field')
    setTtlSeconds(14400)
    setMavlinkPort(PRESET_DEFAULTS.field.mavlinkPort)
    setVehicleStack(PRESET_DEFAULTS.field.vehicleStack)
    setLinkMode(PRESET_DEFAULTS.field.linkMode)
    setShowAdvanced(false)
    setOverrideSysid(false)
    setMavlinkSysid(1)
    setOverrideNetId(false)
    setRadioNetId(25)
    setRadioDevice('')
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
              <strong>Transport:</strong>{' '}
              {result.transport === 'webrtc' ? 'WebRTC (KVS signaling)' : 'WebSocket proxy'}
            </Typography>
            {result.mavlink_sysid != null && (
              <Typography sx={{ color: '#f8fafc', fontSize: '0.875rem', mb: 1 }}>
                <strong>MAVLink sysid:</strong> {result.mavlink_sysid} — set FC{' '}
                <code>MAV_SYS_ID</code> to match
              </Typography>
            )}
            {result.radio_net_id != null && (
              <Typography sx={{ color: '#f8fafc', fontSize: '0.875rem', mb: 1 }}>
                <strong>Radio Net ID:</strong> {result.radio_net_id} — match SiK / RFD on air + ground
              </Typography>
            )}
            {result.link_mode && (
              <Typography sx={{ color: '#f8fafc', fontSize: '0.875rem', mb: 1 }}>
                <strong>Link mode:</strong> {result.link_mode}
              </Typography>
            )}
            {result.transport !== 'webrtc' && (
              <Typography sx={{ color: '#f8fafc', fontSize: '0.875rem', mb: 1 }}>
                <strong>Endpoint:</strong> {result.endpoint}
              </Typography>
            )}
            <Typography sx={{ color: '#94a3b8', fontSize: '0.8rem' }}>
              Run the agent with RDI_SESSION_ID={result.session_id} RDI_MAVLINK_HOST=
              {result.mavlink_host ?? result.relay_config?.mavlink_host ?? '127.0.0.1'}{' '}
              RDI_MAVLINK_PORT={result.mavlink_port ?? mavlinkPort}
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
              <Box
                sx={{
                  mb: 2,
                  p: 2,
                  backgroundColor: '#0f172a',
                  border: '1px solid #334155',
                  borderRadius: '0.375rem',
                }}
              >
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
                label="Mothership / Relay"
                value={relayId}
                onChange={(e) => setRelayId(e.target.value)}
                required
                margin="normal"
                sx={inputSx}
                SelectProps={{ MenuProps: menuProps }}
                helperText="Radio Net ID is inherited from this relay"
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
            <Typography sx={{ color: '#94a3b8', fontSize: '0.75rem', mt: 1.5, mb: 0.5 }}>
              Preset
            </Typography>
            <ToggleButtonGroup
              value={preset}
              exclusive
              onChange={(_, v: ConnectionPreset | null) => v && applyPreset(v)}
              fullWidth
              sx={{
                mb: 1,
                '& .MuiToggleButton-root': { color: '#94a3b8', borderColor: '#334155', fontSize: '0.8rem' },
              }}
            >
              <ToggleButton
                value="field"
                sx={{ '&.Mui-selected': { color: '#f8fafc', backgroundColor: '#0f172a' } }}
              >
                Field
              </ToggleButton>
              <ToggleButton
                value="sim"
                sx={{ '&.Mui-selected': { color: '#f8fafc', backgroundColor: '#0f172a' } }}
              >
                Sim
              </ToggleButton>
              <ToggleButton
                value="lab"
                sx={{ '&.Mui-selected': { color: '#f8fafc', backgroundColor: '#0f172a' } }}
              >
                Lab
              </ToggleButton>
            </ToggleButtonGroup>
            <Typography sx={{ color: '#64748b', fontSize: '0.75rem', mb: 1 }}>
              {preset === 'field' && 'Shared mothership radio — sysid auto-allocated.'}
              {preset === 'sim' && 'UDP MAVLink to Gazebo / SITL on the relay.'}
              {preset === 'lab' && 'Dedicated serial (FTDI) — sysid auto-allocated.'}
            </Typography>
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
            {linkMode === 'dedicated_serial' && (
              <TextField
                fullWidth
                label="Serial device on Pi"
                placeholder="/dev/ttyUSB0"
                value={radioDevice}
                onChange={(e) => setRadioDevice(e.target.value)}
                margin="normal"
                sx={inputSx}
                helperText="Lab: UART this connection owns"
              />
            )}
            <Button
              onClick={() => setShowAdvanced((v) => !v)}
              sx={{ color: '#3b82f6', textTransform: 'none', mt: 1, px: 0 }}
              disableRipple
            >
              {showAdvanced ? 'Hide advanced' : 'Advanced'}
            </Button>
            <Collapse in={showAdvanced}>
              <Box sx={{ mt: 0.5 }}>
                <TextField
                  fullWidth
                  select
                  label="Vehicle stack"
                  value={vehicleStack}
                  onChange={(e) => handleStackChange(e.target.value as VehicleStackId)}
                  margin="normal"
                  sx={inputSx}
                  SelectProps={{ MenuProps: menuProps }}
                  helperText={
                    VEHICLE_STACK_OPTIONS.find((o) => o.id === vehicleStack)?.helper ??
                    'Firmware / dialect this connection will speak'
                  }
                >
                  {VEHICLE_STACK_OPTIONS.map((o) => (
                    <MenuItem key={o.id} value={o.id} disableRipple>
                      {o.label}
                    </MenuItem>
                  ))}
                </TextField>
                <TextField
                  fullWidth
                  select
                  label="MAVLink port"
                  value={mavlinkPort}
                  onChange={(e) => setMavlinkPort(Number(e.target.value))}
                  margin="normal"
                  sx={inputSx}
                  SelectProps={{ MenuProps: menuProps }}
                  helperText="UDP port on the relay (SITL / Gazebo / bridge)"
                >
                  {MAVLINK_PORT_OPTIONS.map((o) => (
                    <MenuItem key={o.value} value={o.value} disableRipple>
                      {o.label}
                    </MenuItem>
                  ))}
                </TextField>
                <TextField
                  fullWidth
                  select
                  label="Radio link mode"
                  value={linkMode}
                  onChange={(e) => setLinkMode(e.target.value)}
                  margin="normal"
                  sx={inputSx}
                  SelectProps={{ MenuProps: menuProps }}
                >
                  {LINK_MODE_OPTIONS.map((o) => (
                    <MenuItem key={o.value} value={o.value} disableRipple>
                      {o.label}
                    </MenuItem>
                  ))}
                </TextField>
                {isRfLink && (
                  <>
                    <TextField
                      fullWidth
                      type="number"
                      label="Override MAVLink sysid"
                      value={mavlinkSysid}
                      onChange={(e) => {
                        setOverrideSysid(true)
                        setMavlinkSysid(Math.max(1, Math.min(255, Number(e.target.value) || 1)))
                      }}
                      margin="normal"
                      sx={inputSx}
                      inputProps={{ min: 1, max: 255 }}
                      helperText={
                        overrideSysid
                          ? 'Sent to API (must be unique on this relay)'
                          : 'Leave untouched to auto-allocate'
                      }
                      onFocus={() => setOverrideSysid(true)}
                    />
                    <TextField
                      fullWidth
                      type="number"
                      label="Override Radio Net ID"
                      value={radioNetId}
                      onChange={(e) => {
                        setOverrideNetId(true)
                        setRadioNetId(Math.max(0, Math.min(255, Number(e.target.value) || 0)))
                      }}
                      margin="normal"
                      sx={inputSx}
                      inputProps={{ min: 0, max: 255 }}
                      helperText={
                        overrideNetId
                          ? 'Overrides relay-inherited SiK net id'
                          : 'Leave untouched to inherit from relay (default 25)'
                      }
                      onFocus={() => setOverrideNetId(true)}
                    />
                  </>
                )}
              </Box>
            </Collapse>
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
