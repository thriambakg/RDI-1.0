import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import type { ControlActionId } from '../../controls/defaultKeybinds'
import { CONTROL_ACTIONS } from '../../controls/defaultKeybinds'
import type { ControlPath } from '../../utils/rdiControl'
import type { LivePingState } from './ConnectionControlHud'
import './MobileVirtualGamepad.css'

const DEADZONE = 0.28

const EXTRAS: { action: ControlActionId; label: string; warn?: boolean }[] = [
  { action: 'brake', label: 'BRAKE', warn: true },
  { action: 'rtl', label: 'RTL', warn: true },
]

function orderActions(actions: Iterable<ControlActionId>): ControlActionId[] {
  const held = new Set(actions)
  return CONTROL_ACTIONS.map((a) => a.id).filter((id) => held.has(id))
}

/** Map normalized stick (-1..1, y+ = down) to discrete flight actions. */
function leftStickActions(nx: number, ny: number): ControlActionId[] {
  const out: ControlActionId[] = []
  if (ny <= -DEADZONE) out.push('move_forward')
  if (ny >= DEADZONE) out.push('move_back')
  if (nx <= -DEADZONE) out.push('move_left')
  if (nx >= DEADZONE) out.push('move_right')
  return out
}

function rightStickActions(nx: number, ny: number): ControlActionId[] {
  const out: ControlActionId[] = []
  if (nx <= -DEADZONE) out.push('yaw_left')
  if (nx >= DEADZONE) out.push('yaw_right')
  if (ny <= -DEADZONE) out.push('move_up')
  if (ny >= DEADZONE) out.push('move_down')
  return out
}

type StickProps = {
  label: string
  hint: string
  active: boolean
  onAxes: (nx: number, ny: number) => void
}

function VirtualJoystick({ label, hint, active, onAxes }: StickProps) {
  const baseRef = useRef<HTMLDivElement>(null)
  const pointerIdRef = useRef<number | null>(null)
  const [knob, setKnob] = useState({ x: 0, y: 0 })

  const reset = useCallback(() => {
    pointerIdRef.current = null
    setKnob({ x: 0, y: 0 })
    onAxes(0, 0)
  }, [onAxes])

  const updateFromClient = useCallback(
    (clientX: number, clientY: number) => {
      const el = baseRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const cx = rect.left + rect.width / 2
      const cy = rect.top + rect.height / 2
      const max = Math.min(rect.width, rect.height) * 0.38
      let dx = clientX - cx
      let dy = clientY - cy
      const dist = Math.hypot(dx, dy)
      if (dist > max && dist > 0) {
        dx = (dx / dist) * max
        dy = (dy / dist) * max
      }
      setKnob({ x: dx, y: dy })
      onAxes(max > 0 ? dx / max : 0, max > 0 ? dy / max : 0)
    },
    [onAxes],
  )

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    pointerIdRef.current = e.pointerId
    e.currentTarget.setPointerCapture(e.pointerId)
    updateFromClient(e.clientX, e.clientY)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (pointerIdRef.current !== e.pointerId) return
    e.preventDefault()
    updateFromClient(e.clientX, e.clientY)
  }

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (pointerIdRef.current !== e.pointerId) return
    e.preventDefault()
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* already released */
    }
    reset()
  }

  useEffect(() => {
    return () => {
      onAxes(0, 0)
    }
  }, [onAxes])

  return (
    <div className="rdi-vpad-cluster">
      <div className="rdi-vpad-cluster-label">{label}</div>
      <div
        ref={baseRef}
        className={`rdi-vpad-stick ${active ? 'is-active' : ''}`}
        role="application"
        aria-label={label}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div className="rdi-vpad-stick-ring" aria-hidden />
        <div className="rdi-vpad-stick-cross" aria-hidden />
        <div
          className="rdi-vpad-stick-knob"
          style={{ transform: `translate(${knob.x}px, ${knob.y}px)` }}
        />
      </div>
      <div className="rdi-vpad-cluster-hint">{hint}</div>
    </div>
  )
}

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
  const leftRef = useRef<ControlActionId[]>([])
  const rightRef = useRef<ControlActionId[]>([])
  const buttonsRef = useRef<Map<number, ControlActionId>>(new Map())

  const publish = useCallback(() => {
    onActionsChange(
      orderActions([...leftRef.current, ...rightRef.current, ...buttonsRef.current.values()]),
    )
  }, [onActionsChange])

  const onLeftAxes = useCallback(
    (nx: number, ny: number) => {
      leftRef.current = leftStickActions(nx, ny)
      publish()
    },
    [publish],
  )

  const onRightAxes = useCallback(
    (nx: number, ny: number) => {
      rightRef.current = rightStickActions(nx, ny)
      publish()
    },
    [publish],
  )

  const onBtnDown = useCallback(
    (action: ControlActionId) => (e: ReactPointerEvent<HTMLButtonElement>) => {
      e.preventDefault()
      e.stopPropagation()
      e.currentTarget.setPointerCapture(e.pointerId)
      buttonsRef.current.set(e.pointerId, action)
      publish()
    },
    [publish],
  )

  const onBtnUp = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
      e.preventDefault()
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        /* already released */
      }
      if (buttonsRef.current.delete(e.pointerId)) publish()
    },
    [publish],
  )

  if (!landscape) {
    return (
      <section className="rdi-vpad" aria-label="Rotate device">
        <div className="rdi-vpad-rotate">
          <strong>Rotate to landscape</strong>
          <p>Flight controls use a landscape dual-joystick pad. Turn your phone sideways to fly.</p>
        </div>
      </section>
    )
  }

  const pingText =
    livePing.ms != null
      ? `${livePing.ms} ms`
      : livePing.status === 'probing'
        ? '…'
        : '—'

  const leftActive =
    activeSet.has('move_forward') ||
    activeSet.has('move_back') ||
    activeSet.has('move_left') ||
    activeSet.has('move_right')
  const rightActive =
    activeSet.has('yaw_left') ||
    activeSet.has('yaw_right') ||
    activeSet.has('move_up') ||
    activeSet.has('move_down')

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
        <VirtualJoystick
          label="Movement"
          hint="Strafe / forward"
          active={leftActive}
          onAxes={onLeftAxes}
        />

        <div className="rdi-vpad-center">
          <div className={`rdi-vpad-armed ${armed ? '' : 'is-off'}`}>
            <span className="dot" />
            {armed ? 'Armed' : 'Standby'}
          </div>
          <div className="rdi-vpad-ping">
            {livePing.path === 'radio' ? 'Radio' : 'Relay'} <strong>{pingText}</strong>
          </div>
          <div className="rdi-vpad-extras">
            {EXTRAS.map((btn) => (
              <button
                key={btn.action}
                type="button"
                className={`rdi-vpad-btn ${btn.warn ? 'is-warn' : ''} ${
                  activeSet.has(btn.action) ? 'is-lit' : ''
                }`}
                onPointerDown={onBtnDown(btn.action)}
                onPointerUp={onBtnUp}
                onPointerCancel={onBtnUp}
                onContextMenu={(e) => e.preventDefault()}
              >
                {btn.label}
              </button>
            ))}
          </div>
        </div>

        <VirtualJoystick
          label="Yaw / altitude"
          hint="Yaw · up / down"
          active={rightActive}
          onAxes={onRightAxes}
        />
      </div>
    </section>
  )
}
