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
import KeyboardOutlinedIcon from '@mui/icons-material/KeyboardOutlined'
import SportsEsportsOutlinedIcon from '@mui/icons-material/SportsEsportsOutlined'
import {
  CONTROL_ACTIONS,
  type ControlActionId,
  type ControlBinding,
  type ControlKeybinds,
  formatBinding,
  formatGamepadId,
  resetGamepadDefaults,
  resetKeyboardDefaults,
  setActionGamepad,
  setActionKeyboard,
} from '../../controls/defaultKeybinds'

const BIND_BTN_SX = {
  textTransform: 'none' as const,
  minWidth: 88,
  borderRadius: '2px',
  '@keyframes rdiBindFlash': {
    '0%, 100%': {
      borderColor: 'rgba(148, 163, 184, 0.45)',
      backgroundColor: 'transparent',
      color: '#e2e8f0',
    },
    '40%, 60%': {
      borderColor: '#f87171',
      backgroundColor: 'rgba(248, 113, 113, 0.28)',
      color: '#fecaca',
    },
  },
}

function bindingConflicts(
  keybinds: ControlKeybinds,
  actionId: ControlActionId,
  binding: ControlBinding,
): boolean {
  for (const action of CONTROL_ACTIONS) {
    if (action.id === actionId) continue
    const slots = keybinds[action.id]
    if (!slots) continue
    if (binding.device === 'keyboard') {
      if (slots.keyboard.code === binding.code) return true
    } else if (slots.gamepad.control === binding.control) {
      return true
    }
  }
  return false
}

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
  type ListenTarget = { actionId: ControlActionId; device: 'keyboard' | 'gamepad' }
  const [listeningFor, setListeningFor] = useState<ListenTarget | null>(null)
  const [flashConflict, setFlashConflict] = useState<ListenTarget | null>(null)
  const [pads, setPads] = useState<{ index: number; id: string }[]>([])

  const flashBindConflict = useCallback((target: ListenTarget) => {
    setFlashConflict(target)
    window.setTimeout(() => setFlashConflict(null), 500)
  }, [])

  const assignBinding = useCallback(
    (actionId: ControlActionId, binding: ControlBinding) => {
      if (bindingConflicts(keybinds, actionId, binding)) {
        flashBindConflict({ actionId, device: binding.device })
        setListeningFor(null)
        return
      }
      if (binding.device === 'keyboard') {
        onKeybindsChange(setActionKeyboard(keybinds, actionId, binding))
      } else {
        onKeybindsChange(setActionGamepad(keybinds, actionId, binding))
      }
      setListeningFor(null)
    },
    [keybinds, onKeybindsChange, flashBindConflict],
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
    if (!listeningFor || listeningFor.device !== 'keyboard') return
    const actionId = listeningFor.actionId
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      assignBinding(actionId, { device: 'keyboard', code: e.code })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [listeningFor, assignBinding])

  useEffect(() => {
    if (!listeningFor || listeningFor.device !== 'gamepad') return
    const actionId = listeningFor.actionId
    let cancelled = false
    ;(async () => {
      const binding = await captureGamepadBinding()
      if (cancelled) return
      if (binding) assignBinding(actionId, binding)
      else setListeningFor(null)
    })()
    return () => {
      cancelled = true
    }
  }, [listeningFor, assignBinding])

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
        Keyboard and gamepad binds are saved separately. Both work at once — click a slot, then press the key /
        button / stick. Each input can only map to one action. Save stores them to your account.
      </Typography>
      <Typography sx={{ fontSize: '0.75rem', color: pads.length ? '#4ade80' : '#64748b', mb: 1.5 }}>
        {pads.length === 0
          ? 'No controller detected — connect a PS4 / PS5 / Xbox pad and press any button once (Chrome requires it).'
          : `Connected: ${pads.map((p) => formatGamepadId(p.id)).join(' · ')}`}
      </Typography>

      {/* Column icons aligned over the bind buttons */}
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 0.75,
          pr: 1.5,
          mb: 0.75,
        }}
      >
        <Box
          sx={{
            width: 88,
            display: 'flex',
            justifyContent: 'center',
            color: '#94a3b8',
          }}
          title="Keyboard Controls"
        >
          <KeyboardOutlinedIcon sx={{ fontSize: 18 }} />
        </Box>
        <Box
          sx={{
            width: 88,
            display: 'flex',
            justifyContent: 'center',
            color: '#38bdf8',
          }}
          title="Gamepad Controls"
        >
          <SportsEsportsOutlinedIcon sx={{ fontSize: 18 }} />
        </Box>
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
              const slots = keybinds[action.id]
              const listenKb =
                listeningFor?.actionId === action.id && listeningFor.device === 'keyboard'
              const listenGp =
                listeningFor?.actionId === action.id && listeningFor.device === 'gamepad'
              const flashKb =
                flashConflict?.actionId === action.id && flashConflict.device === 'keyboard'
              const flashGp =
                flashConflict?.actionId === action.id && flashConflict.device === 'gamepad'
              return (
                <ListItem
                  key={action.id}
                  secondaryAction={
                    <Box sx={{ display: 'flex', gap: 0.75 }}>
                      <Button
                        size="small"
                        variant={listenKb ? 'contained' : 'outlined'}
                        onClick={() =>
                          setListeningFor(listenKb ? null : { actionId: action.id, device: 'keyboard' })
                        }
                        sx={{
                          ...BIND_BTN_SX,
                          ...(flashKb ? { animation: 'rdiBindFlash 0.25s ease 2' } : {}),
                        }}
                        title={`Keyboard: ${formatBinding(slots.keyboard)}`}
                      >
                        {listenKb ? 'Listening…' : formatBinding(slots.keyboard)}
                      </Button>
                      <Button
                        size="small"
                        variant={listenGp ? 'contained' : 'outlined'}
                        color="info"
                        onClick={() =>
                          setListeningFor(listenGp ? null : { actionId: action.id, device: 'gamepad' })
                        }
                        sx={{
                          ...BIND_BTN_SX,
                          ...(flashGp ? { animation: 'rdiBindFlash 0.25s ease 2' } : {}),
                        }}
                        title={`Gamepad: ${formatBinding(slots.gamepad)}`}
                      >
                        {listenGp ? 'Press…' : formatBinding(slots.gamepad)}
                      </Button>
                    </Box>
                  }
                  sx={{ pr: 28, py: 0.45 }}
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

      <Box sx={{ mb: 2.5 }}>
        <Typography sx={{ fontSize: '0.7rem', color: '#64748b', mb: 1 }}>Reset</Typography>
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
          <ListItem
            secondaryAction={
              <Box sx={{ display: 'flex', gap: 0.75 }}>
                <Button
                  size="small"
                  variant="outlined"
                  onClick={() => {
                    setListeningFor(null)
                    onKeybindsChange(resetKeyboardDefaults(keybinds))
                  }}
                  sx={{ ...BIND_BTN_SX, color: '#94a3b8' }}
                  title="Reset keyboard binds to defaults"
                >
                  Reset
                </Button>
                <Button
                  size="small"
                  variant="outlined"
                  color="info"
                  onClick={() => {
                    setListeningFor(null)
                    onKeybindsChange(resetGamepadDefaults(keybinds))
                  }}
                  sx={BIND_BTN_SX}
                  title="Reset gamepad binds to defaults"
                >
                  Reset
                </Button>
              </Box>
            }
            sx={{ pr: 28, py: 0.45 }}
          >
            <ListItemText
              primary="Reset to default"
              primaryTypographyProps={{ sx: { color: '#e2e8f0', fontSize: '0.85rem' } }}
            />
          </ListItem>
        </List>
      </Box>

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
