/** Control-frame protocol over WebRTC data channel (does not collide with PING/PINGR/PONG). */

export const CTRL_PREFIX = new TextEncoder().encode('CTRL')

export type ControlPath = 'relay' | 'radio'

export type RdiCtrlPayload = {
  type: 'rdi_ctrl'
  path: ControlPath
  actions: string[]
  stream: string
  ts: number
}

export type RdiCtrlAck = {
  type: 'rdi_ctrl_ack'
  path: ControlPath
  actions: string[]
  delivered: boolean
  error?: string
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
