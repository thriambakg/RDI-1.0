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

/** Per-action slots — keyboard and gamepad are saved and active independently. */
export type ActionBindings = {
  keyboard: KeyboardBinding
  gamepad: GamepadBinding
}

export type ControlKeybinds = Record<ControlActionId, ActionBindings>

export type ControlsSettings = {
  version: 2
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

const DEFAULT_KEYBOARD: Record<ControlActionId, KeyboardBinding> = {
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

/**
 * Video-game style defaults for the W3C "standard" gamepad mapping
 * (Xbox Series / DualSense / DualShock via Chromium).
 * Left stick = strafe/forward, right stick X = yaw, triggers = up/down.
 */
const DEFAULT_GAMEPAD: Record<ControlActionId, GamepadBinding> = {
  move_forward: { device: 'gamepad', control: 'axis:1:-' },
  move_back: { device: 'gamepad', control: 'axis:1:+' },
  move_left: { device: 'gamepad', control: 'axis:0:-' },
  move_right: { device: 'gamepad', control: 'axis:0:+' },
  move_up: { device: 'gamepad', control: '7' },
  move_down: { device: 'gamepad', control: '6' },
  yaw_left: { device: 'gamepad', control: 'axis:2:-' },
  yaw_right: { device: 'gamepad', control: 'axis:2:+' },
  brake: { device: 'gamepad', control: '1' },
  rtl: { device: 'gamepad', control: '3' },
}

function dual(
  keyboard: KeyboardBinding,
  gamepad: GamepadBinding,
): ActionBindings {
  return { keyboard, gamepad }
}

/** Full defaults: both devices bound so either can fly without a mode switch. */
export const DEFAULT_KEYBINDS: ControlKeybinds = {
  move_forward: dual(DEFAULT_KEYBOARD.move_forward, DEFAULT_GAMEPAD.move_forward),
  move_back: dual(DEFAULT_KEYBOARD.move_back, DEFAULT_GAMEPAD.move_back),
  move_left: dual(DEFAULT_KEYBOARD.move_left, DEFAULT_GAMEPAD.move_left),
  move_right: dual(DEFAULT_KEYBOARD.move_right, DEFAULT_GAMEPAD.move_right),
  move_up: dual(DEFAULT_KEYBOARD.move_up, DEFAULT_GAMEPAD.move_up),
  move_down: dual(DEFAULT_KEYBOARD.move_down, DEFAULT_GAMEPAD.move_down),
  yaw_left: dual(DEFAULT_KEYBOARD.yaw_left, DEFAULT_GAMEPAD.yaw_left),
  yaw_right: dual(DEFAULT_KEYBOARD.yaw_right, DEFAULT_GAMEPAD.yaw_right),
  brake: dual(DEFAULT_KEYBOARD.brake, DEFAULT_GAMEPAD.brake),
  rtl: dual(DEFAULT_KEYBOARD.rtl, DEFAULT_GAMEPAD.rtl),
}

/** @deprecated Use DEFAULT_KEYBINDS — kept for callers that only want gamepad slot defaults. */
export const DEFAULT_GAMEPAD_BINDS: ControlKeybinds = DEFAULT_KEYBINDS

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v != null && !Array.isArray(v)
}

function isKeyboardBinding(v: unknown): v is KeyboardBinding {
  return isRecord(v) && v.device === 'keyboard' && typeof v.code === 'string'
}

function isGamepadBinding(v: unknown): v is GamepadBinding {
  return isRecord(v) && v.device === 'gamepad' && typeof v.control === 'string'
}

/** Normalize legacy single-binding or partial dual slots into ActionBindings. */
export function normalizeActionBindings(raw: unknown, actionId: ControlActionId): ActionBindings {
  const fallback = DEFAULT_KEYBINDS[actionId]
  if (isKeyboardBinding(raw)) {
    return { keyboard: raw, gamepad: fallback.gamepad }
  }
  if (isGamepadBinding(raw)) {
    return { keyboard: fallback.keyboard, gamepad: raw }
  }
  if (isRecord(raw)) {
    const keyboard = isKeyboardBinding(raw.keyboard) ? raw.keyboard : fallback.keyboard
    const gamepad = isGamepadBinding(raw.gamepad) ? raw.gamepad : fallback.gamepad
    return { keyboard, gamepad }
  }
  return { ...fallback, keyboard: { ...fallback.keyboard }, gamepad: { ...fallback.gamepad } }
}

export function normalizeKeybinds(partial?: Partial<ControlKeybinds> | Record<string, unknown> | null): ControlKeybinds {
  const out = {} as ControlKeybinds
  for (const action of CONTROL_ACTIONS) {
    const raw = partial?.[action.id]
    out[action.id] = normalizeActionBindings(raw, action.id)
  }
  return out
}

export function mergeKeybinds(partial?: Partial<ControlKeybinds> | Record<string, unknown> | null): ControlKeybinds {
  return normalizeKeybinds(partial)
}

/** Per-connection binds from profile, falling back to defaults (and optional legacy global). */
export function resolveConnectionKeybinds(
  connectionKeybinds?: Partial<ControlKeybinds> | Record<string, unknown> | null,
  legacyGlobal?: Partial<ControlKeybinds> | Record<string, unknown> | null,
): ControlKeybinds {
  if (connectionKeybinds && Object.keys(connectionKeybinds).length > 0) {
    return mergeKeybinds(connectionKeybinds)
  }
  return mergeKeybinds(legacyGlobal)
}

/** Reset only keyboard slots; keep saved gamepad binds. */
export function resetKeyboardDefaults(current: ControlKeybinds): ControlKeybinds {
  const out = {} as ControlKeybinds
  for (const action of CONTROL_ACTIONS) {
    out[action.id] = {
      keyboard: { ...DEFAULT_KEYBOARD[action.id] },
      gamepad: { ...current[action.id].gamepad },
    }
  }
  return out
}

/** Reset only gamepad slots; keep saved keyboard binds. */
export function resetGamepadDefaults(current: ControlKeybinds): ControlKeybinds {
  const out = {} as ControlKeybinds
  for (const action of CONTROL_ACTIONS) {
    out[action.id] = {
      keyboard: { ...current[action.id].keyboard },
      gamepad: { ...DEFAULT_GAMEPAD[action.id] },
    }
  }
  return out
}

export function setActionKeyboard(
  current: ControlKeybinds,
  actionId: ControlActionId,
  binding: KeyboardBinding,
): ControlKeybinds {
  return {
    ...current,
    [actionId]: { ...current[actionId], keyboard: binding },
  }
}

export function setActionGamepad(
  current: ControlKeybinds,
  actionId: ControlActionId,
  binding: GamepadBinding,
): ControlKeybinds {
  return {
    ...current,
    [actionId]: { ...current[actionId], gamepad: binding },
  }
}

/** Friendly name from navigator.getGamepads()[].id */
export function formatGamepadId(id: string): string {
  const lower = id.toLowerCase()
  if (lower.includes('dualsense')) return 'PlayStation DualSense (PS5)'
  if (lower.includes('dualshock') || lower.includes('playstation')) return 'PlayStation DualShock (PS4)'
  if (lower.includes('054c') && lower.includes('wireless controller')) return 'PlayStation controller'
  if (lower.includes('xbox') || lower.includes('xinput') || lower.includes('045e')) return 'Xbox controller'
  if (id.length > 48) return `${id.slice(0, 45)}…`
  return id || 'Gamepad'
}

export function formatKeyboardCode(code: string): string {
  if (code === 'Space') return 'Space'
  if (code === 'ControlLeft') return 'LCtrl'
  if (code === 'ControlRight') return 'RCtrl'
  if (code === 'ShiftLeft') return 'LShift'
  if (code === 'ShiftRight') return 'RShift'
  if (code === 'AltLeft') return 'LAlt'
  if (code === 'AltRight') return 'RAlt'
  if (code === 'MetaLeft') return 'LMeta'
  if (code === 'MetaRight') return 'RMeta'
  if (code.startsWith('Key') && code.length === 4) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  if (code.startsWith('Arrow')) return code.slice(5)
  return code
}

export function formatBinding(b: ControlBinding): string {
  if (b.device === 'keyboard') return formatKeyboardCode(b.code)
  return formatGamepadControl(b.control)
}

/** True when a physical input token set satisfies a binding. */
export function bindingMatches(pressed: ReadonlySet<string>, binding: ControlBinding): boolean {
  if (binding.device === 'keyboard') return pressed.has(binding.code)
  if (binding.control.startsWith('axis:')) {
    const parts = binding.control.split(':')
    const idx = parts[1]
    const dir = parts[2]
    if (!idx || (dir !== '+' && dir !== '-')) return false
    for (const token of pressed) {
      if (token.startsWith('GP') && token.includes(`-AX${idx}${dir}`)) return true
    }
    return false
  }
  for (const token of pressed) {
    if (token.startsWith('GP') && token.endsWith(`-BTN${binding.control}`)) return true
  }
  return false
}

/** Logical actions currently held — keyboard OR gamepad slot can activate each action. */
export function resolveActiveActions(
  pressed: ReadonlySet<string>,
  keybinds: ControlKeybinds,
): ControlActionId[] {
  const out: ControlActionId[] = []
  for (const action of CONTROL_ACTIONS) {
    const slots = keybinds[action.id]
    if (!slots) continue
    if (bindingMatches(pressed, slots.keyboard) || bindingMatches(pressed, slots.gamepad)) {
      out.push(action.id)
    }
  }
  return out
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

/** Format a live pressed token (KeyW / GP0-BTN0 / GP0-AX1-) for HUD display. */
export function formatInputToken(token: string): string {
  if (token.startsWith('GP') && token.includes('-BTN')) {
    const btn = Number(token.slice(token.lastIndexOf('BTN') + 3))
    if (!Number.isNaN(btn) && GP_BUTTON_LABELS[btn]) return GP_BUTTON_LABELS[btn]
    return `Btn ${btn}`
  }
  if (token.startsWith('GP') && token.includes('-AX')) {
    const m = token.match(/-AX(\d+)([+-])$/)
    if (m) {
      const key = `axis:${m[1]}:${m[2]}`
      return GP_AXIS_LABELS[key] ?? `Axis ${m[1]}${m[2]}`
    }
  }
  return formatKeyboardCode(token)
}
