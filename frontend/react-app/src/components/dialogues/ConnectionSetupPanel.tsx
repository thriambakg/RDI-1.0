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
  DEFAULT_GAMEPAD_BINDS,
  DEFAULT_KEYBINDS,
  type ControlActionId,
  type ControlBinding,
  type ControlKeybinds,
  formatBinding,
  formatGamepadId,
} from '../../controls/defaultKeybinds'

const AXIS_DEADZONE = 0.45
const AXIS_DELTA = 0.35
const CAPTURE_SETTLE_MS = 220
const CAPTURE_TIMEOUT_MS = 10_000

function listConnectedPads(): { index: number; id: string }[] {
  const pads = navigator.getGamepads?.() ?? []
  const out: { index: number; id: string }[] = []
  for (const gp of pads) {
    if (gp?.connected) out.push({ index: gp.index, id: gp.id })
  }
  return out
}

/**
 * Wait for a fresh button press or stick deflection.
 * Ignores stick drift already present when listening starts (baseline + settle).
 */
function captureGamepadBinding(): Promise<ControlBinding | null> {
  return new Promise((resolve) => {
    const started = performance.now()
    const baseline = new Map<string, number>()
    let settled = false
    let raf = 0

    const sampleBaseline = () => {
      const pads = navigator.getGamepads?.() ?? []
      for (const gp of pads) {
        if (!gp?.connected) continue
        gp.axes.forEach((v, i) => baseline.set(`${gp.index}:${i}`, v))
        gp.buttons.forEach((btn, i) => {
          if (btn.pressed || btn.value > 0.5) baseline.set(`btn:${gp.index}:${i}`, 1)
        })
      }
    }

    const tick = () => {
      const elapsed = performance.now() - started
      if (!settled) {
        sampleBaseline()
        if (elapsed >= CAPTURE_SETTLE_MS) settled = true
        raf = requestAnimationFrame(tick)
        return
      }

      const pads = navigator.getGamepads?.() ?? []
      for (const gp of pads) {
        if (!gp?.connected) continue

        // Prefer buttons — less false-positive than stick noise.
        for (let i = 0; i < gp.buttons.length; i++) {
          const pressed = !!gp.buttons[i]?.pressed || (gp.buttons[i]?.value ?? 0) > 0.55
          if (!pressed) continue
          if (baseline.has(`btn:${gp.index}:${i}`)) continue
          cancelAnimationFrame(raf)
          resolve({ device: 'gamepad', control: String(i) })
          return
        }

        for (let i = 0; i < gp.axes.length; i++) {
          const v = gp.axes[i]
          const base = baseline.get(`${gp.index}:${i}`) ?? 0
          const delta = v - base
          if (Math.abs(delta) < AXIS_DELTA && Math.abs(v) < AXIS_DEADZONE) continue
          if (v >= AXIS_DEADZONE || delta >= AXIS_DELTA) {
            cancelAnimationFrame(raf)
            resolve({ device: 'gamepad', control: `axis:${i}:+` })
            return
          }
          if (v <= -AXIS_DEADZONE || delta <= -AXIS_DELTA) {
            cancelAnimationFrame(raf)
            resolve({ device: 'gamepad', control: `axis:${i}:-` })
            return
          }
        }
      }

      if (elapsed > CAPTURE_TIMEOUT_MS) {
        cancelAnimationFrame(raf)
        resolve(null)
        return
      }
      raf = requestAnimationFrame(tick)
    }

    sampleBaseline()
    raf = requestAnimationFrame(tick)
  })
}

export type ConnectionSetupPanelProps = {
  connectionName: string
  sessionId: string
  status: string
  relayLabel?: string | null
  mavlinkLabel?: string | null
  /** Live link readout so editing settings never looks like a dropped connection. */
  linkLabel?: string | null
  linkOk?: boolean
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
  linkLabel,
  linkOk = false,
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
  const [pads, setPads] = useState<{ index: number; id: string }[]>([])

  const assignBinding = useCallback(
    (actionId: ControlActionId, binding: ControlBinding) => {
      onKeybindsChange({ ...keybinds, [actionId]: binding })
      setListeningFor(null)
    },
    [keybinds, onKeybindsChange],
  )

  // Keep connected-pad list fresh (Chrome only exposes pads after a button press).
  useEffect(() => {
    const refresh = () => setPads(listConnectedPads())
    refresh()
    window.addEventListener('gamepadconnected', refresh)
    window.addEventListener('gamepaddisconnected', refresh)
    const id = window.setInterval(refresh, 1500)
    return () => {
      window.removeEventListener('gamepadconnected', refresh)
      window.removeEventListener('gamepaddisconnected', refresh)
      window.clearInterval(id)
    }
  }, [])

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
        {linkLabel && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mt: 0.75 }}>
            <Box
              sx={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                backgroundColor: linkOk ? '#22c55e' : '#64748b',
                flexShrink: 0,
              }}
            />
            <Typography sx={{ fontSize: '0.75rem', color: linkOk ? '#38bdf8' : '#64748b' }}>
              {linkLabel}
            </Typography>
          </Box>
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
      <Typography sx={{ fontSize: '0.75rem', color: '#64748b', mb: 1 }}>
        Binds apply only to this connection. Use Keyboard or Gamepad mode, click a bind, then press the key /
        button / stick direction. Save stores them to your account.
      </Typography>
      <Typography sx={{ fontSize: '0.75rem', color: pads.length ? '#4ade80' : '#64748b', mb: 1.5 }}>
        {pads.length === 0
          ? 'No controller detected — connect a PS4 / PS5 / Xbox pad and press any button once (Chrome requires it).'
          : `Connected: ${pads.map((p) => formatGamepadId(p.id)).join(' · ')}`}
      </Typography>

      <Box sx={{ display: 'flex', gap: 1, mb: 1, flexWrap: 'wrap' }}>
        <Button
          size="small"
          variant={captureMode === 'keyboard' ? 'contained' : 'outlined'}
          onClick={() => {
            setCaptureMode('keyboard')
            setListeningFor(null)
          }}
          sx={{ textTransform: 'none', borderRadius: '2px' }}
        >
          Keyboard
        </Button>
        <Button
          size="small"
          variant={captureMode === 'gamepad' ? 'contained' : 'outlined'}
          onClick={() => {
            setCaptureMode('gamepad')
            setListeningFor(null)
          }}
          sx={{ textTransform: 'none', borderRadius: '2px' }}
        >
          Gamepad
        </Button>
        <Button
          size="small"
          onClick={() => onKeybindsChange({ ...DEFAULT_KEYBINDS })}
          sx={{ textTransform: 'none', color: '#94a3b8', ml: 'auto' }}
        >
          Keyboard defaults
        </Button>
        <Button
          size="small"
          onClick={() => {
            setCaptureMode('gamepad')
            onKeybindsChange({ ...DEFAULT_GAMEPAD_BINDS })
          }}
          sx={{ textTransform: 'none', color: '#38bdf8' }}
        >
          Gamepad defaults
        </Button>
      </Box>
      {captureMode === 'gamepad' && (
        <Typography sx={{ fontSize: '0.7rem', color: '#64748b', mb: 1.5 }}>
          Defaults: left stick move, right stick yaw, RT ascend, LT descend, B/○ brake, Y/△ RTL. Works with Xbox
          Series and PlayStation DualShock / DualSense on the browser standard mapping.
        </Typography>
      )}

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
                      sx={{ textTransform: 'none', minWidth: 100, borderRadius: '2px' }}
                      title={binding ? formatBinding(binding) : undefined}
                    >
                      {listening
                        ? captureMode === 'gamepad'
                          ? 'Press…'
                          : 'Listening…'
                        : formatBinding(binding)}
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
