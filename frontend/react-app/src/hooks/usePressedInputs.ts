/**
 * Live keyboard + gamepad press stream.
 *
 * Keyboard: KeyboardEvent.code tokens (KeyW, Space, …)
 * Gamepad: Browser Gamepad API (Xbox + DualSense use the "standard" mapping in Chromium).
 *   - Buttons: GP0-BTN0 …
 *   - Axes: GP0-AX0+ / GP0-AX0- when past deadzone
 *
 * `stream` is a sorted join of currently held inputs, e.g. "KeyA+KeyW+GP0-BTN0"
 */

import { useCallback, useEffect, useRef, useState } from 'react'

const AXIS_DEADZONE = 0.35

export type PressedInputsState = {
  /** Currently held physical input tokens */
  pressed: ReadonlySet<string>
  /** Sorted multi-press stream string (empty when nothing held) */
  stream: string
  /** Connected gamepad summaries */
  gamepads: { index: number; id: string }[]
}

function sortedStream(pressed: Set<string>): string {
  return [...pressed].sort().join('+')
}

function collectGamepadTokens(out: Set<string>): { index: number; id: string }[] {
  const list = typeof navigator !== 'undefined' ? navigator.getGamepads?.() ?? [] : []
  const connected: { index: number; id: string }[] = []
  for (const gp of list) {
    if (!gp || !gp.connected) continue
    connected.push({ index: gp.index, id: gp.id })
    const prefix = `GP${gp.index}`
    gp.buttons.forEach((btn, i) => {
      if (btn.pressed || btn.value > 0.5) out.add(`${prefix}-BTN${i}`)
    })
    gp.axes.forEach((axis, i) => {
      if (axis >= AXIS_DEADZONE) out.add(`${prefix}-AX${i}+`)
      if (axis <= -AXIS_DEADZONE) out.add(`${prefix}-AX${i}-`)
    })
  }
  return connected
}

export function usePressedInputs(enabled = true): PressedInputsState {
  const keysRef = useRef<Set<string>>(new Set())
  const [pressed, setPressed] = useState<ReadonlySet<string>>(() => new Set())
  const [gamepads, setGamepads] = useState<{ index: number; id: string }[]>([])
  const rafRef = useRef<number>(0)

  const publish = useCallback(() => {
    const next = new Set(keysRef.current)
    const gp = collectGamepadTokens(next)
    setGamepads(gp)
    setPressed(next)
  }, [])

  useEffect(() => {
    if (!enabled) return

    const onDown = (e: KeyboardEvent) => {
      if (e.repeat) return
      // Ignore pure modifier-only as primary stream noise when composing binds
      keysRef.current.add(e.code)
      publish()
    }
    const onUp = (e: KeyboardEvent) => {
      keysRef.current.delete(e.code)
      publish()
    }
    const onBlur = () => {
      keysRef.current.clear()
      publish()
    }

    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', onBlur)

    const onGpConnect = () => publish()
    const onGpDisconnect = () => publish()
    window.addEventListener('gamepadconnected', onGpConnect)
    window.addEventListener('gamepaddisconnected', onGpDisconnect)

    const tick = () => {
      publish()
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)

    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('gamepadconnected', onGpConnect)
      window.removeEventListener('gamepaddisconnected', onGpDisconnect)
      cancelAnimationFrame(rafRef.current)
    }
  }, [enabled, publish])

  return {
    pressed,
    stream: sortedStream(new Set(pressed)),
    gamepads,
  }
}
