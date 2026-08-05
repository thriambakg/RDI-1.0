import { useCallback, useEffect, useState } from 'react'
import {
  Box,
  Button,
  Divider,
  FormControl,
  InputLabel,
  List,
  ListItem,
  ListItemText,
  MenuItem,
  Select,
  TextField,
  Typography,
} from '@mui/material'
import {
  CONTROL_ACTIONS,
  DEFAULT_KEYBINDS,
  type ControlActionId,
  type ControlBinding,
  type ControlKeybinds,
  formatBinding,
} from '../../controls/defaultKeybinds'

const AXIS_DEADZONE = 0.35

function captureGamepadBinding(): Promise<ControlBinding | null> {
  return new Promise((resolve) => {
    const started = performance.now()
    let raf = 0
    const tick = () => {
      const pads = navigator.getGamepads?.() ?? []
      for (const gp of pads) {
        if (!gp?.connected) continue
        for (let i = 0; i < gp.buttons.length; i++) {
          if (gp.buttons[i]?.pressed) {
            cancelAnimationFrame(raf)
            resolve({ device: 'gamepad', control: String(i) })
            return
          }
        }
        for (let i = 0; i < gp.axes.length; i++) {
          const v = gp.axes[i]
          if (v >= AXIS_DEADZONE) {
            cancelAnimationFrame(raf)
            resolve({ device: 'gamepad', control: `axis:${i}:+` })
            return
          }
          if (v <= -AXIS_DEADZONE) {
            cancelAnimationFrame(raf)
            resolve({ device: 'gamepad', control: `axis:${i}:-` })
            return
          }
        }
      }
      if (performance.now() - started > 8000) {
        cancelAnimationFrame(raf)
        resolve(null)
        return
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
  })
}

export type ConnectionSetupPanelProps = {
  connectionName: string
  sessionId: string
  status: string
  relayLabel?: string | null
  mavlinkLabel?: string | null
  editName: string
  onEditNameChange: (v: string) => void
  editTtl: number
  onEditTtlChange: (v: number) => void
  ttlOptions: { value: number; label: string }[]
  expiresLabel?: string | null
  keybinds: ControlKeybinds
  onKeybindsChange: (next: ControlKeybinds) => void
  saving: boolean
  error: string | null
  savedMsg: string | null
  onSave: () => void
  onBackToControls: () => void
}

/**
 * In-dialog connection setup: identity / TTL at top, per-connection keybinds below.
 * Edits to keybinds call onKeybindsChange immediately so the control deck stays in sync.
 */
export function ConnectionSetupPanel({
  connectionName,
  sessionId,
  status,
  relayLabel,
  mavlinkLabel,
  editName,
  onEditNameChange,
  editTtl,
  onEditTtlChange,
  ttlOptions,
  expiresLabel,
  keybinds,
  onKeybindsChange,
  saving,
  error,
  savedMsg,
  onSave,
  onBackToControls,
}: ConnectionSetupPanelProps) {
  const [listeningFor, setListeningFor] = useState<ControlActionId | null>(null)
  const [captureMode, setCaptureMode] = useState<'keyboard' | 'gamepad'>('keyboard')

  const assignBinding = useCallback(
    (actionId: ControlActionId, binding: ControlBinding) => {
      onKeybindsChange({ ...keybinds, [actionId]: binding })
      setListeningFor(null)
    },
    [keybinds, onKeybindsChange],
  )

  useEffect(() => {
    if (!listeningFor || captureMode !== 'keyboard') return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      // Accept any physical key, including modifiers (ControlLeft, ShiftLeft, …).
      assignBinding(listeningFor, { device: 'keyboard', code: e.code })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [listeningFor, captureMode, assignBinding])

  useEffect(() => {
    if (!listeningFor || captureMode !== 'gamepad') return
    let cancelled = false
    ;(async () => {
      const binding = await captureGamepadBinding()
      if (cancelled || !listeningFor) return
      if (binding) assignBinding(listeningFor, binding)
      else setListeningFor(null)
    })()
    return () => {
      cancelled = true
    }
  }, [listeningFor, captureMode, assignBinding])

  const groups = [...new Set(CONTROL_ACTIONS.map((a) => a.group))]

  return (
    <Box>
      <Typography
        sx={{
          fontSize: '0.65rem',
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          color: '#64748b',
          mb: 1,
        }}
      >
        Connection
      </Typography>

      <Box
        sx={{
          p: 1.5,
          mb: 2,
          backgroundColor: 'rgba(2, 6, 23, 0.7)',
          border: '1px solid #1e293b',
          borderRadius: '2px',
        }}
      >
        <Typography sx={{ fontSize: '0.875rem', color: '#e2e8f0', mb: 0.5, fontWeight: 600 }}>
          {editName.trim() || connectionName || 'Unnamed'}
        </Typography>
        <Typography
          sx={{
            fontSize: '0.7rem',
            color: '#64748b',
            fontFamily: 'ui-monospace, monospace',
            mb: 0.75,
            wordBreak: 'break-all',
          }}
        >
          {sessionId}
        </Typography>
        <Typography sx={{ fontSize: '0.8rem', color: '#94a3b8' }}>
          Status: {status}
          {relayLabel ? ` · Relay: ${relayLabel}` : ''}
        </Typography>
        {mavlinkLabel && (
          <Typography sx={{ fontSize: '0.75rem', color: '#4ade80', mt: 0.5 }}>{mavlinkLabel}</Typography>
        )}
      </Box>

      <TextField
        label="Display name"
        value={editName}
        onChange={(e) => onEditNameChange(e.target.value)}
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
          onChange={(e) => onEditTtlChange(Number(e.target.value))}
          sx={{ color: '#f8fafc', backgroundColor: '#0f172a' }}
        >
          {ttlOptions.map((o) => (
            <MenuItem key={o.value} value={o.value}>
              {o.label}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      {expiresLabel && (
        <Typography sx={{ fontSize: '0.75rem', mb: 2, color: '#64748b' }}>Auto-idle: {expiresLabel}</Typography>
      )}

      <Divider sx={{ borderColor: '#1e293b', mb: 2 }} />

      <Typography
        sx={{
          fontSize: '0.65rem',
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          color: '#38bdf8',
          mb: 0.5,
        }}
      >
        Control map
      </Typography>
      <Typography sx={{ fontSize: '0.75rem', color: '#64748b', mb: 1.5 }}>
        Binds apply only to this connection. Changes update the control deck immediately; Save stores them to your
        account.
      </Typography>

      <Box sx={{ display: 'flex', gap: 1, mb: 1.5 }}>
        <Button
          size="small"
          variant={captureMode === 'keyboard' ? 'contained' : 'outlined'}
          onClick={() => setCaptureMode('keyboard')}
          sx={{ textTransform: 'none', borderRadius: '2px' }}
        >
          Keyboard
        </Button>
        <Button
          size="small"
          variant={captureMode === 'gamepad' ? 'contained' : 'outlined'}
          onClick={() => setCaptureMode('gamepad')}
          sx={{ textTransform: 'none', borderRadius: '2px' }}
        >
          Gamepad
        </Button>
        <Button
          size="small"
          onClick={() => onKeybindsChange({ ...DEFAULT_KEYBINDS })}
          sx={{ textTransform: 'none', color: '#94a3b8', ml: 'auto' }}
        >
          Reset defaults
        </Button>
      </Box>

      {groups.map((group) => (
        <Box key={group} sx={{ mb: 2.5 }}>
          <Typography sx={{ fontSize: '0.7rem', color: '#64748b', mb: 1 }}>{group}</Typography>
          <List
            dense
            disablePadding
            sx={{
              backgroundColor: '#020617',
              border: '1px solid #1e293b',
              borderRadius: '2px',
              py: 1.25,
            }}
          >
            {CONTROL_ACTIONS.filter((a) => a.group === group).map((action) => {
              const binding = keybinds[action.id]
              const listening = listeningFor === action.id
              return (
                <ListItem
                  key={action.id}
                  secondaryAction={
                    <Button
                      size="small"
                      variant={listening ? 'contained' : 'outlined'}
                      onClick={() => setListeningFor(listening ? null : action.id)}
                      sx={{ textTransform: 'none', minWidth: 88, borderRadius: '2px' }}
                    >
                      {listening ? 'Listening…' : formatBinding(binding)}
                    </Button>
                  }
                  sx={{ pr: 14, py: 0.35 }}
                >
                  <ListItemText
                    primary={action.label}
                    primaryTypographyProps={{ sx: { color: '#e2e8f0', fontSize: '0.85rem' } }}
                  />
                </ListItem>
              )
            })}
          </List>
        </Box>
      ))}

      {error && (
        <Typography sx={{ color: '#f87171', fontSize: '0.8125rem', mb: 1 }}>{error}</Typography>
      )}
      {savedMsg && (
        <Typography sx={{ color: '#4ade80', fontSize: '0.8125rem', mb: 1 }}>{savedMsg}</Typography>
      )}

      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 1 }}>
        <Button size="small" onClick={onBackToControls} sx={{ color: '#94a3b8', textTransform: 'none' }}>
          Back to controls
        </Button>
        <Button
          size="small"
          variant="contained"
          disabled={saving}
          onClick={onSave}
          sx={{ textTransform: 'none', backgroundColor: '#3b82f6', borderRadius: '2px' }}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </Box>
    </Box>
  )
}
