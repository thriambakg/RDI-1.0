import { useCallback, useMemo, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import type { ControlActionId } from '../../controls/defaultKeybinds'
import type { ControlPath } from '../../utils/rdiControl'
import type { LivePingState } from './ConnectionControlHud'
import './MobileVirtualGamepad.css'

type PadCell =
  | { kind: 'empty' }
  | { kind: 'action'; action: ControlActionId; label: string; warn?: boolean }

const LEFT_CROSS: PadCell[] = [
  { kind: 'empty' },
  { kind: 'action', action: 'move_forward', label: 'FWD' },
  { kind: 'empty' },
  { kind: 'action', action: 'move_left', label: 'L' },
  { kind: 'empty' },
  { kind: 'action', action: 'move_right', label: 'R' },
  { kind: 'empty' },
  { kind: 'action', action: 'move_back', label: 'BACK' },
  { kind: 'empty' },
]

const RIGHT_CROSS: PadCell[] = [
  { kind: 'empty' },
  { kind: 'action', action: 'move_up', label: 'UP' },
  { kind: 'empty' },
  { kind: 'action', action: 'yaw_left', label: 'YAW L' },
  { kind: 'empty' },
  { kind: 'action', action: 'yaw_right', label: 'YAW R' },
  { kind: 'empty' },
  { kind: 'action', action: 'move_down', label: 'DOWN' },
  { kind: 'empty' },
]

const EXTRAS: { action: ControlActionId; label: string; warn?: boolean }[] = [
  { action: 'brake', label: 'BRAKE', warn: true },
  { action: 'rtl', label: 'RTL', warn: true },
]

export type MobileVirtualGamepadProps = {
  activeActions: ControlActionId[]
  onActionsChange: (actions: ControlActionId[]) => void
  path: ControlPath
  onPathChange: (path: ControlPath) => void
  armed: boolean
  connected: boolean
  livePing: LivePingState
  landscape: boolean
}

export function MobileVirtualGamepad({
  activeActions,
  onActionsChange,
  path,
  onPathChange,
  armed,
  connected,
  livePing,
  landscape,
}: MobileVirtualGamepadProps) {
  const activeSet = useMemo(() => new Set(activeActions), [activeActions])
  /** pointerId → action — supports multi-touch chords */
  const pointersRef = useRef<Map<number, ControlActionId>>(new Map())

  const publish = useCallback(() => {
    const next = [...new Set(pointersRef.current.values())]
    onActionsChange(next)
  }, [onActionsChange])

  const press = useCallback(
    (pointerId: number, action: ControlActionId) => {
      pointersRef.current.set(pointerId, action)
      publish()
    },
    [publish],
  )

  const release = useCallback(
    (pointerId: number) => {
      if (!pointersRef.current.has(pointerId)) return
      pointersRef.current.delete(pointerId)
      publish()
    },
    [publish],
  )

  const onPadPointerDown = useCallback(
    (action: ControlActionId) => (e: ReactPointerEvent<HTMLButtonElement>) => {
      e.preventDefault()
      e.stopPropagation()
      e.currentTarget.setPointerCapture(e.pointerId)
      press(e.pointerId, action)
    },
    [press],
  )

  const onPadPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
      e.preventDefault()
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        /* already released */
      }
      release(e.pointerId)
    },
    [release],
  )

  if (!landscape) {
    return (
      <section className="rdi-vpad" aria-label="Rotate device">
        <div className="rdi-vpad-rotate">
          <strong>Rotate to landscape</strong>
          <p>Flight controls use a landscape virtual gamepad. Turn your phone sideways to fly.</p>
        </div>
      </section>
    )
  }

  const pingText =
    livePing.ms != null
      ? `${livePing.ms} ms`
      : livePing.status === 'probing'
        ? '…'
        : livePing.status === 'timeout' || livePing.status === 'error'
          ? '—'
          : '—'

  return (
    <section className="rdi-vpad" aria-label="Virtual gamepad">
      <div className="rdi-vpad-status">
        <strong>Touch controls</strong>
        <div className="rdi-vpad-path" role="group" aria-label="Command destination">
          <button
            type="button"
            className={path === 'relay' ? 'is-active' : ''}
            onClick={() => onPathChange('relay')}
          >
            Relay
          </button>
          <button
            type="button"
            className={path === 'radio' ? 'is-active is-radio' : ''}
            onClick={() => onPathChange('radio')}
          >
            Radio
          </button>
        </div>
        <span>{connected ? 'Channel live' : 'Waiting…'}</span>
      </div>

      <div className="rdi-vpad-body">
        <div className="rdi-vpad-cluster">
          <div className="rdi-vpad-cluster-label">Movement</div>
          <div className="rdi-vpad-cross" aria-label="Movement pad">
            {LEFT_CROSS.map((cell, i) =>
              cell.kind === 'empty' ? (
                <div key={i} className="rdi-vpad-btn is-empty" />
              ) : (
                <button
                  key={cell.action}
                  type="button"
                  className={`rdi-vpad-btn ${activeSet.has(cell.action) ? 'is-lit' : ''}`}
                  onPointerDown={onPadPointerDown(cell.action)}
                  onPointerUp={onPadPointerUp}
                  onPointerCancel={onPadPointerUp}
                  onContextMenu={(e) => e.preventDefault()}
                >
                  {cell.label}
                </button>
              ),
            )}
          </div>
        </div>

        <div className="rdi-vpad-center">
          <div className={`rdi-vpad-armed ${armed ? '' : 'is-off'}`}>
            <span className="dot" />
            {armed ? 'Armed' : 'Standby'}
          </div>
          <div className="rdi-vpad-ping">
            {livePing.path === 'radio' ? 'Radio' : 'Relay'}{' '}
            <strong>{pingText}</strong>
          </div>
          <div className="rdi-vpad-extras">
            {EXTRAS.map((btn) => (
              <button
                key={btn.action}
                type="button"
                className={`rdi-vpad-btn ${btn.warn ? 'is-warn' : ''} ${
                  activeSet.has(btn.action) ? 'is-lit' : ''
                }`}
                onPointerDown={onPadPointerDown(btn.action)}
                onPointerUp={onPadPointerUp}
                onPointerCancel={onPadPointerUp}
                onContextMenu={(e) => e.preventDefault()}
              >
                {btn.label}
              </button>
            ))}
          </div>
        </div>

        <div className="rdi-vpad-cluster">
          <div className="rdi-vpad-cluster-label">Altitude / yaw</div>
          <div className="rdi-vpad-cross" aria-label="Yaw and altitude pad">
            {RIGHT_CROSS.map((cell, i) =>
              cell.kind === 'empty' ? (
                <div key={i} className="rdi-vpad-btn is-empty" />
              ) : (
                <button
                  key={cell.action}
                  type="button"
                  className={`rdi-vpad-btn ${activeSet.has(cell.action) ? 'is-lit' : ''}`}
                  onPointerDown={onPadPointerDown(cell.action)}
                  onPointerUp={onPadPointerUp}
                  onPointerCancel={onPadPointerUp}
                  onContextMenu={(e) => e.preventDefault()}
                >
                  {cell.label}
                </button>
              ),
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
