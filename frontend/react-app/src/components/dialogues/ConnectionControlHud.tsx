import { useMemo } from 'react'
import {
  CONTROL_ACTIONS,
  formatKeyboardCode,
  type ControlActionId,
  type ControlKeybinds,
} from '../../controls/defaultKeybinds'
import type { ControlPath } from '../../utils/rdiControl'
import './ConnectionControlHud.css'

const PAD: { id: string; label: string; action?: ControlActionId; row: number; col: number }[] = [
  { id: 'q', label: 'Q', action: 'yaw_left', row: 0, col: 0 },
  { id: 'w', label: 'W', action: 'move_forward', row: 0, col: 1 },
  { id: 'e', label: 'E', action: 'yaw_right', row: 0, col: 2 },
  { id: 'a', label: 'A', action: 'move_left', row: 1, col: 0 },
  { id: 's', label: 'S', action: 'move_back', row: 1, col: 1 },
  { id: 'd', label: 'D', action: 'move_right', row: 1, col: 2 },
]

const EXTRA: { label: string; action: ControlActionId }[] = [
  { label: 'Space', action: 'move_up' },
  { label: 'C', action: 'move_down' },
  { label: 'X', action: 'brake' },
  { label: 'R', action: 'rtl' },
]

function labelForAction(id: ControlActionId): string {
  return CONTROL_ACTIONS.find((a) => a.id === id)?.label ?? id
}

function prettyStream(stream: string): string {
  if (!stream) return ''
  return stream
    .split('+')
    .map((token) => {
      if (token.startsWith('Key') || token === 'Space' || token.startsWith('Digit') || token.startsWith('Arrow')) {
        return formatKeyboardCode(token)
      }
      return token
    })
    .join(' + ')
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
        const item = PAD.find((p) => p.row === row && p.col === col)
        if (!item?.action) {
          cells.push({ kind: 'empty' })
          continue
        }
        cells.push({
          kind: 'key',
          label: item.label,
          lit: activeSet.has(item.action),
        })
      }
    }
    return cells
  }, [activeSet])

  return (
    <section className="rdi-hud" aria-label="Flight control HUD">
      <div className="rdi-hud-header">
        <div className="rdi-hud-title">
          <strong>Control link</strong>
          <span>{connected ? 'Channel live — hold binds (chords OK)' : 'Waiting for WebRTC channel…'}</span>
        </div>
        <div className={`rdi-hud-armed ${armed ? '' : 'is-off'}`}>
          <span className="dot" />
          {armed ? 'Armed' : 'Standby'}
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
            Binds from Settings
            {keybinds.move_forward?.device === 'keyboard'
              ? ` (e.g. ${formatKeyboardCode(
                  keybinds.move_forward.device === 'keyboard' ? keybinds.move_forward.code : 'KeyW',
                )} = forward).`
              : '.'}
          </p>
        </div>
      </div>

      <div className="rdi-hud-extra" aria-hidden>
        {EXTRA.map((item) => (
          <div key={item.action} className={`rdi-hud-key ${activeSet.has(item.action) ? 'is-lit' : ''}`}>
            {item.label}
          </div>
        ))}
      </div>
    </section>
  )
}
