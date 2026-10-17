import { useMemo } from 'react'
import {
  CONTROL_ACTIONS,
  formatBinding,
  formatGamepadId,
  formatInputToken,
  type ControlActionId,
  type ControlKeybinds,
} from '../../controls/defaultKeybinds'
import type { ControlPath } from '../../utils/rdiControl'
import './ConnectionControlHud.css'

const PAD_ACTIONS: { action: ControlActionId; row: number; col: number }[] = [
  { action: 'yaw_left', row: 0, col: 0 },
  { action: 'move_forward', row: 0, col: 1 },
  { action: 'yaw_right', row: 0, col: 2 },
  { action: 'move_left', row: 1, col: 0 },
  { action: 'move_back', row: 1, col: 1 },
  { action: 'move_right', row: 1, col: 2 },
]

const EXTRA_ACTIONS: ControlActionId[] = ['move_up', 'move_down', 'brake', 'rtl']

function shortOne(b: import('../../controls/defaultKeybinds').ControlBinding): string {
  if (b.device === 'keyboard') {
    const full = formatBinding(b)
    return full.length <= 8 ? full : full.slice(0, 7)
  }
  if (b.control.startsWith('axis:')) {
    const parts = b.control.split(':')
    return `A${parts[1]}${parts[2]}`
  }
  return `B${b.control}`
}

function shortBindLabel(keybinds: ControlKeybinds, action: ControlActionId): string {
  const slots = keybinds[action]
  if (!slots) return '—'
  return `${shortOne(slots.keyboard)}/${shortOne(slots.gamepad)}`
}

export type LivePingState = {
  ms: number | null
  /** probing | live | timeout | error | idle */
  status: 'idle' | 'probing' | 'live' | 'timeout' | 'error'
  path: ControlPath
}

function labelForAction(id: ControlActionId): string {
  return CONTROL_ACTIONS.find((a) => a.id === id)?.label ?? id
}

function prettyStream(stream: string): string {
  if (!stream) return ''
  return stream
    .split('+')
    .map((token) => formatInputToken(token))
    .join(' + ')
}

function pingTone(path: ControlPath, ms: number | null, status: LivePingState['status']): string {
  if (status === 'timeout' || status === 'error') return 'is-bad'
  if (status === 'probing' && ms == null) return 'is-wait'
  if (ms == null) return ''
  if (path === 'radio') {
    if (ms < 200) return 'is-good'
    if (ms < 450) return 'is-ok'
    return 'is-bad'
  }
  if (ms < 80) return 'is-good'
  if (ms < 160) return 'is-ok'
  return 'is-bad'
}

export type ConnectionControlHudProps = {
  path: ControlPath
  onPathChange: (path: ControlPath) => void
  stream: string
  activeActions: ControlActionId[]
  keybinds: ControlKeybinds
  armed: boolean
  transmitting: boolean
  lastTxNote?: string | null
  connected: boolean
  livePing: LivePingState
  gamepads?: { index: number; id: string }[]
}

export function ConnectionControlHud({
  path,
  onPathChange,
  stream,
  activeActions,
  keybinds,
  armed,
  transmitting,
  lastTxNote,
  connected,
  livePing,
  gamepads = [],
}: ConnectionControlHudProps) {
  const activeSet = useMemo(() => new Set(activeActions), [activeActions])
  const padCells = useMemo(() => {
    const cells: ({ kind: 'empty' } | { kind: 'key'; label: string; lit: boolean })[] = []
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        if (row === 2) {
          cells.push({ kind: 'empty' })
          continue
        }
        const item = PAD_ACTIONS.find((p) => p.row === row && p.col === col)
        if (!item) {
          cells.push({ kind: 'empty' })
          continue
        }
        cells.push({
          kind: 'key',
          label: shortBindLabel(keybinds, item.action),
          lit: activeSet.has(item.action),
        })
      }
    }
    return cells
  }, [activeSet, keybinds])

  const tone = pingTone(livePing.path, livePing.ms, livePing.status)
  const pingLabel = livePing.path === 'radio' ? 'Radio RTT' : 'Relay ping'
  // Keep last good sample on timeout/error — status tone carries the failure.
  const pingText =
    livePing.ms != null
      ? String(livePing.ms)
      : livePing.status === 'probing'
        ? '···'
        : livePing.status === 'error'
          ? 'ERR'
          : '—'
  const showUnit = livePing.ms != null
  const pingTitle =
    livePing.status === 'timeout'
      ? `${pingLabel} timed out (showing last sample)`
      : livePing.status === 'error'
        ? `${pingLabel} error (showing last sample)`
        : `Live ${livePing.path} round-trip`

  return (
    <section className="rdi-hud" aria-label="Flight control HUD">
      <div className="rdi-hud-header">
        <div className="rdi-hud-title">
          <strong>Control link</strong>
          <span>
            {connected
              ? gamepads.length > 0
                ? `Channel live · keyboard + ${gamepads.map((g) => formatGamepadId(g.id)).join(', ')}`
                : 'Channel live — keyboard ready; press a controller button to wake gamepad'
              : 'Waiting for WebRTC channel…'}
          </span>
        </div>
        <div className="rdi-hud-status">
          <div className={`rdi-hud-armed ${armed ? '' : 'is-off'}`}>
            <span className="dot" />
            {armed ? 'Armed' : 'Standby'}
          </div>
          <div className="rdi-hud-ping" title={pingTitle}>
            <span className="rdi-hud-ping-label">{pingLabel}</span>
            <span className={`rdi-hud-ping-value ${tone}`}>
              {pingText}
              {showUnit ? <span className="rdi-hud-ping-unit">ms</span> : null}
            </span>
          </div>
        </div>
      </div>

      <div className="rdi-hud-path" role="group" aria-label="Command destination">
        <button
          type="button"
          className={path === 'relay' ? 'is-active' : ''}
          onClick={() => onPathChange('relay')}
        >
          Relay only
        </button>
        <button
          type="button"
          className={path === 'radio' ? 'is-active is-radio' : ''}
          onClick={() => onPathChange('radio')}
        >
          Via radio
        </button>
      </div>

      <div className="rdi-hud-body">
        <div className="rdi-hud-pad" aria-hidden>
          {padCells.map((cell, i) =>
            cell.kind === 'empty' ? (
              <div key={i} className="rdi-hud-key is-empty" />
            ) : (
              <div key={i} className={`rdi-hud-key ${cell.lit ? 'is-lit' : ''}`}>
                {cell.label}
              </div>
            ),
          )}
        </div>

        <div className="rdi-hud-side">
          <div>
            <div className="rdi-hud-stream-label">Live input</div>
            <div className={`rdi-hud-stream ${stream ? '' : 'is-idle'}`}>
              {prettyStream(stream) || '— awaiting input —'}
            </div>
          </div>

          <div className="rdi-hud-actions" aria-label="Active actions">
            {activeActions.length === 0 ? (
              <span className="rdi-hud-meta">No actions held</span>
            ) : (
              activeActions.map((id) => (
                <span key={id} className={`rdi-hud-chip ${path === 'radio' ? 'is-radio' : ''}`}>
                  {labelForAction(id)}
                </span>
              ))
            )}
          </div>

          <div className={`rdi-hud-tx ${transmitting ? 'is-live' : ''}`}>
            {transmitting ? `TX · ${path === 'radio' ? 'radio' : 'relay'}` : 'TX idle'}
            {lastTxNote ? ` · ${lastTxNote}` : ''}
          </div>

          <p className="rdi-hud-meta">
            <strong>Path:</strong>{' '}
            {path === 'radio'
              ? 'Browser → Pi → radio (desktop agent should log ctrl frames).'
              : 'Browser → Pi only (relay logs + ack).'}{' '}
            Binds: gear → setup
            {keybinds.move_forward
              ? ` — e.g. ${formatBinding(keybinds.move_forward.keyboard)} / ${formatBinding(keybinds.move_forward.gamepad)} = forward.`
              : '.'}
          </p>
        </div>
      </div>

      <div className="rdi-hud-extra" aria-hidden>
        {EXTRA_ACTIONS.map((action) => (
          <div key={action} className={`rdi-hud-key ${activeSet.has(action) ? 'is-lit' : ''}`}>
            {shortBindLabel(keybinds, action)}
          </div>
        ))}
      </div>
    </section>
  )
}
