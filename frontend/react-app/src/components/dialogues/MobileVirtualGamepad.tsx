import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import type { ControlActionId } from '../../controls/defaultKeybinds'
import { CONTROL_ACTIONS } from '../../controls/defaultKeybinds'
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
  corner: 'left' | 'right'
  label: string
  active: boolean
  onAxes: (nx: number, ny: number) => void
}

function VirtualJoystick({ corner, label, active, onAxes }: StickProps) {
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

  useEffect(() => () => onAxes(0, 0), [onAxes])

  return (
    <div
      className={`rdi-vpad-float-stick rdi-vpad-float-stick--${corner} ${active ? 'is-active' : ''}`}
      ref={baseRef}
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
  )
}

export type MobileVirtualGamepadProps = {
  activeActions: ControlActionId[]
  onActionsChange: (actions: ControlActionId[]) => void
  /** When false, show rotate prompt instead of sticks */
  landscape: boolean
  /** Lift sticks above a bottom drawer (e.g. locked-video log panel), CSS length */
  bottomInset?: string
}

/**
 * Floating dual-joystick overlay (bottom-left / bottom-right) + BRAKE/RTL.
 * Semi-transparent so a video feed behind remains visible.
 */
export function MobileVirtualGamepad({
  activeActions,
  onActionsChange,
  landscape,
  bottomInset = '0px',
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
      <div className="rdi-vpad-overlay rdi-vpad-overlay--rotate" aria-label="Rotate device">
        <strong>Rotate to landscape</strong>
        <p>Flight sticks need landscape. Turn your phone sideways.</p>
      </div>
    )
  }

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
    <div
      className="rdi-vpad-overlay"
      aria-label="Virtual gamepad overlay"
      style={{ '--vpad-bottom-inset': bottomInset } as CSSProperties}
    >
      <div className="rdi-vpad-float-center">
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

      <VirtualJoystick
        corner="left"
        label="Movement"
        active={leftActive}
        onAxes={onLeftAxes}
      />
      <VirtualJoystick
        corner="right"
        label="Yaw / altitude"
        active={rightActive}
        onAxes={onRightAxes}
      />
    </div>
  )
}
