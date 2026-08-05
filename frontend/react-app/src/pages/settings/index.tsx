import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Divider,
  List,
  ListItem,
  ListItemText,
  Paper,
  Typography,
} from '@mui/material'
import { ConsoleChromeHeader } from '../../components/console/ConsoleChromeHeader'
import { getProfile, updateUserSettings } from '../../services/profileApi'
import { usePressedInputs } from '../../hooks/usePressedInputs'
import {
  CONTROL_ACTIONS,
  DEFAULT_KEYBINDS,
  type ControlActionId,
  type ControlBinding,
  type ControlKeybinds,
  formatBinding,
  mergeKeybinds,
} from '../../controls/defaultKeybinds'
import '../console/Console.css'
import './Settings.css'

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

export default function SettingsPage() {
  const [keybinds, setKeybinds] = useState<ControlKeybinds>(DEFAULT_KEYBINDS)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedMsg, setSavedMsg] = useState<string | null>(null)
  const [listeningFor, setListeningFor] = useState<ControlActionId | null>(null)
  const [captureMode, setCaptureMode] = useState<'keyboard' | 'gamepad'>('keyboard')

  const { stream, gamepads } = usePressedInputs(true)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const profile = await getProfile()
        if (cancelled) return
        const fromServer = profile.settings?.controls?.keybinds
        setKeybinds(mergeKeybinds(fromServer as Partial<ControlKeybinds> | undefined))
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load settings')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const assignBinding = useCallback((actionId: ControlActionId, binding: ControlBinding) => {
    setKeybinds((prev) => ({ ...prev, [actionId]: binding }))
    setListeningFor(null)
    setSavedMsg(null)
  }, [])

  useEffect(() => {
    if (!listeningFor || captureMode !== 'keyboard') return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return
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

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    setSavedMsg(null)
    try {
      await updateUserSettings({
        controls: {
          version: 1,
          keybinds,
        },
      })
      setSavedMsg('Controls saved to your account.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const handleResetDefaults = () => {
    setKeybinds({ ...DEFAULT_KEYBINDS })
    setSavedMsg(null)
  }

  const groups = [...new Set(CONTROL_ACTIONS.map((a) => a.group))]

  return (
    <div className="console settings-page">
      <ConsoleChromeHeader title="Settings" showBackToConsole />
      <div className="settings-body">
        <nav className="settings-nav">
          <Typography variant="overline" sx={{ color: '#64748b', px: 1 }}>
            Preferences
          </Typography>
          <Button
            fullWidth
            disableRipple
            sx={{
              justifyContent: 'flex-start',
              color: '#f8fafc',
              backgroundColor: 'rgba(59,130,246,0.15)',
              textTransform: 'none',
              mt: 1,
            }}
          >
            Controls / keybinds
          </Button>
        </nav>

        <main className="settings-main">
          <Typography variant="h5" sx={{ color: '#f8fafc', mb: 1, fontWeight: 600 }}>
            Controls
          </Typography>
          <Typography variant="body2" sx={{ color: '#94a3b8', mb: 2, maxWidth: 560 }}>
            Bind keyboard keys or a gamepad (Xbox / PlayStation via the browser Gamepad API). Bindings
            save to your user profile. Logical actions stay the same across drone types; vehicle
            profiles will map them later.
          </Typography>

          {error && (
            <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
              {error}
            </Alert>
          )}
          {savedMsg && (
            <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSavedMsg(null)}>
              {savedMsg}
            </Alert>
          )}

          <Paper
            elevation={0}
            className="input-stream-panel"
            sx={{ backgroundColor: '#0f172a', border: '1px solid #334155', p: 2, mb: 3 }}
          >
            <Typography variant="subtitle2" sx={{ color: '#94a3b8', mb: 1 }}>
              Live input stream (multi-press)
            </Typography>
            <Box
              component="pre"
              sx={{
                m: 0,
                p: 1.5,
                minHeight: 48,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: '0.95rem',
                color: stream ? '#22c55e' : '#64748b',
                backgroundColor: '#020617',
                borderRadius: '0.375rem',
                border: '1px solid #1e293b',
                wordBreak: 'break-all',
                whiteSpace: 'pre-wrap',
              }}
            >
              {stream || '(press keys or gamepad buttons…)'}
            </Box>
            <Typography variant="caption" sx={{ color: '#64748b', display: 'block', mt: 1 }}>
              Gamepads:{' '}
              {gamepads.length === 0
                ? 'none detected — press a button on the pad to wake it'
                : gamepads.map((g) => `#${g.index} ${g.id}`).join(' · ')}
            </Typography>
          </Paper>

          {loading ? (
            <CircularProgress size={28} sx={{ color: '#3b82f6' }} />
          ) : (
            <>
              {groups.map((group) => (
                <Box key={group} sx={{ mb: 3 }}>
                  <Typography variant="subtitle1" sx={{ color: '#e2e8f0', mb: 1 }}>
                    {group}
                  </Typography>
                  <List dense disablePadding sx={{ backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '0.375rem' }}>
                    {CONTROL_ACTIONS.filter((a) => a.group === group).map((action, idx, arr) => {
                      const binding = keybinds[action.id]
                      const isListening = listeningFor === action.id
                      return (
                        <Box key={action.id}>
                          <ListItem
                            secondaryAction={
                              <Box sx={{ display: 'flex', gap: 1 }}>
                                <Button
                                  size="small"
                                  disableRipple
                                  variant={isListening && captureMode === 'keyboard' ? 'contained' : 'outlined'}
                                  onClick={() => {
                                    setCaptureMode('keyboard')
                                    setListeningFor(action.id)
                                  }}
                                  sx={{ textTransform: 'none', minWidth: 88 }}
                                >
                                  {isListening && captureMode === 'keyboard' ? 'Press key…' : 'Keyboard'}
                                </Button>
                                <Button
                                  size="small"
                                  disableRipple
                                  variant={isListening && captureMode === 'gamepad' ? 'contained' : 'outlined'}
                                  onClick={() => {
                                    setCaptureMode('gamepad')
                                    setListeningFor(action.id)
                                  }}
                                  sx={{ textTransform: 'none', minWidth: 88 }}
                                >
                                  {isListening && captureMode === 'gamepad' ? 'Press pad…' : 'Gamepad'}
                                </Button>
                              </Box>
                            }
                            sx={{ pr: 28 }}
                          >
                            <ListItemText
                              primary={action.label}
                              secondary={
                                isListening
                                  ? captureMode === 'keyboard'
                                    ? 'Waiting for keyboard…'
                                    : 'Waiting for gamepad…'
                                  : formatBinding(binding)
                              }
                              primaryTypographyProps={{ color: '#f8fafc', fontSize: '0.9rem' }}
                              secondaryTypographyProps={{
                                color: isListening ? '#3b82f6' : '#94a3b8',
                                fontFamily: 'ui-monospace, monospace',
                              }}
                            />
                          </ListItem>
                          {idx < arr.length - 1 && <Divider sx={{ borderColor: '#1e293b' }} />}
                        </Box>
                      )
                    })}
                  </List>
                </Box>
              ))}

              <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                <Button variant="contained" disableRipple disabled={saving} onClick={handleSave}>
                  {saving ? 'Saving…' : 'Save to account'}
                </Button>
                <Button disableRipple sx={{ color: '#94a3b8' }} onClick={handleResetDefaults}>
                  Reset to defaults
                </Button>
                {listeningFor && (
                  <Button disableRipple sx={{ color: '#f87171' }} onClick={() => setListeningFor(null)}>
                    Cancel capture
                  </Button>
                )}
              </Box>
            </>
          )}
        </main>
      </div>
    </div>
  )
}
