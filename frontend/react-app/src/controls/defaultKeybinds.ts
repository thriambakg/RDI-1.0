/** Logical flight/drive controls and default keyboard + gamepad bindings. */

export type ControlActionId =
  | 'move_forward'
  | 'move_back'
  | 'move_left'
  | 'move_right'
  | 'move_up'
  | 'move_down'
  | 'yaw_left'
  | 'yaw_right'
  | 'brake'
  | 'rtl'

export type KeyboardBinding = {
  device: 'keyboard'
  /** KeyboardEvent.code, e.g. KeyW, Space */
  code: string
}

/** Standard Gamepad API indices (Xbox / DualSense via Chromium "standard" mapping). */
export type GamepadBinding = {
  device: 'gamepad'
  /** button index, or axis like "axis:0:+" / "axis:1:-" */
  control: string
}

export type ControlBinding = KeyboardBinding | GamepadBinding

export type ControlKeybinds = Record<ControlActionId, ControlBinding>

export type ControlsSettings = {
  version: 1
  keybinds: ControlKeybinds
}

export const CONTROL_ACTIONS: {
  id: ControlActionId
  label: string
  group: string
}[] = [
  { id: 'move_forward', label: 'Move forward', group: 'Movement' },
  { id: 'move_back', label: 'Move back', group: 'Movement' },
  { id: 'move_left', label: 'Move left / strafe', group: 'Movement' },
  { id: 'move_right', label: 'Move right / strafe', group: 'Movement' },
  { id: 'move_up', label: 'Ascend', group: 'Movement' },
  { id: 'move_down', label: 'Descend', group: 'Movement' },
  { id: 'yaw_left', label: 'Yaw left', group: 'Orientation' },
  { id: 'yaw_right', label: 'Yaw right', group: 'Orientation' },
  { id: 'brake', label: 'Brake / hold', group: 'Safety' },
  { id: 'rtl', label: 'Return to launch', group: 'Safety' },
]

export const DEFAULT_KEYBINDS: ControlKeybinds = {
  move_forward: { device: 'keyboard', code: 'KeyW' },
  move_back: { device: 'keyboard', code: 'KeyS' },
  move_left: { device: 'keyboard', code: 'KeyA' },
  move_right: { device: 'keyboard', code: 'KeyD' },
  move_up: { device: 'keyboard', code: 'Space' },
  move_down: { device: 'keyboard', code: 'KeyC' },
  yaw_left: { device: 'keyboard', code: 'KeyQ' },
  yaw_right: { device: 'keyboard', code: 'KeyE' },
  brake: { device: 'keyboard', code: 'KeyX' },
  rtl: { device: 'keyboard', code: 'KeyR' },
}

export function mergeKeybinds(partial?: Partial<ControlKeybinds> | null): ControlKeybinds {
  return { ...DEFAULT_KEYBINDS, ...(partial ?? {}) }
}

export function formatKeyboardCode(code: string): string {
  if (code === 'Space') return 'Space'
  if (code.startsWith('Key') && code.length === 4) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  if (code.startsWith('Arrow')) return code.slice(5)
  return code
}

export function formatBinding(b: ControlBinding): string {
  if (b.device === 'keyboard') return formatKeyboardCode(b.code)
  return formatGamepadControl(b.control)
}

/** Human labels for standard gamepad button indices (Xbox naming; DualSense maps similarly). */
const GP_BUTTON_LABELS: Record<number, string> = {
  0: 'A / ✕',
  1: 'B / ○',
  2: 'X / □',
  3: 'Y / △',
  4: 'LB / L1',
  5: 'RB / R1',
  6: 'LT / L2',
  7: 'RT / R2',
  8: 'Back / Share',
  9: 'Start / Options',
  10: 'L3',
  11: 'R3',
  12: 'D-Pad ↑',
  13: 'D-Pad ↓',
  14: 'D-Pad ←',
  15: 'D-Pad →',
}

const GP_AXIS_LABELS: Record<string, string> = {
  'axis:0:+': 'Left stick →',
  'axis:0:-': 'Left stick ←',
  'axis:1:+': 'Left stick ↓',
  'axis:1:-': 'Left stick ↑',
  'axis:2:+': 'Right stick →',
  'axis:2:-': 'Right stick ←',
  'axis:3:+': 'Right stick ↓',
  'axis:3:-': 'Right stick ↑',
}

export function formatGamepadControl(control: string): string {
  if (control.startsWith('axis:')) {
    return GP_AXIS_LABELS[control] ?? control
  }
  const idx = Number(control)
  if (!Number.isNaN(idx) && GP_BUTTON_LABELS[idx]) return GP_BUTTON_LABELS[idx]
  return `Button ${control}`
}
