/** Control-frame protocol over WebRTC data channel (does not collide with PING/PINGR/PONG). */

export const CTRL_PREFIX = new TextEncoder().encode('CTRL')

export type ControlPath = 'relay' | 'radio'

export type RdiCtrlPayload = {
  type: 'rdi_ctrl'
  path: ControlPath
  /** Vehicle stack / firmware adapter for this connection */
  stack?: string
  /** Logical pipe hint for agents: webrtc_relay | radio_mavlink | radio_raw */
  pipe?: string
  actions: string[]
  stream: string
  ts: number
}

export type RdiCtrlAck = {
  type: 'rdi_ctrl_ack'
  path: ControlPath
  stack?: string
  pipe?: string
  actions: string[]
  delivered: boolean
  error?: string
}

/** Derive a pipe label for CTRL frames from path + link mode. */
export function pipeLabelForCtrl(path: ControlPath, linkMode?: string | null): string {
  if (path === 'relay') return 'webrtc_relay'
  const mode = (linkMode || '').toLowerCase()
  if (mode === 'dedicated_serial' || mode === 'raw') return 'radio_raw'
  return 'radio_mavlink'
}

export function encodeCtrlFrame(payload: Omit<RdiCtrlPayload, 'type'>): ArrayBuffer {
  const body = JSON.stringify({ type: 'rdi_ctrl', ...payload })
  const json = new TextEncoder().encode(body)
  const full = new Uint8Array(CTRL_PREFIX.length + json.length)
  full.set(CTRL_PREFIX)
  full.set(json, CTRL_PREFIX.length)
  return full.buffer
}

export function parseCtrlAck(data: ArrayBuffer | ArrayBufferView | string): RdiCtrlAck | null {
  try {
    const text =
      typeof data === 'string'
        ? data
        : new TextDecoder().decode(
            data instanceof ArrayBuffer
              ? new Uint8Array(data)
              : new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
          )
    const obj = JSON.parse(text) as RdiCtrlAck
    if (obj?.type !== 'rdi_ctrl_ack') return null
    return obj
  } catch {
    return null
  }
}

export function sendCtrlFrame(
  channel: RTCDataChannel,
  payload: Omit<RdiCtrlPayload, 'type'>,
): void {
  if (channel.readyState !== 'open') {
    throw new Error('Data channel is not open')
  }
  channel.send(encodeCtrlFrame(payload))
}
