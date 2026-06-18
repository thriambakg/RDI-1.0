/** Binary ping protocol shared with legacy proxy/agent and Pi WebRTC master. */
export const PING_BYTES = new Uint8Array([0x50, 0x49, 0x4e, 0x47]) // "PING"
export const PONG_BYTES = new Uint8Array([0x50, 0x4f, 0x4e, 0x47]) // "PONG"

export function isPongPayload(data: ArrayBuffer | ArrayBufferView): boolean {
  const arr = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  return arr.length === PONG_BYTES.length && arr.every((b, i) => b === PONG_BYTES[i])
}

/** Send PING on an open data channel; resolves with round-trip latency in ms. */
export function pingDataChannel(channel: RTCDataChannel, timeoutMs = 8000): Promise<number> {
  if (channel.readyState !== 'open') {
    return Promise.reject(new Error('Data channel is not open'))
  }

  return new Promise((resolve, reject) => {
    const start = performance.now()
    let settled = false

    const finish = (err?: Error, rttMs?: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      channel.removeEventListener('message', onMessage)
      if (err) reject(err)
      else resolve(rttMs ?? Math.round(performance.now() - start))
    }

    const onMessage = (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer && isPongPayload(event.data)) {
        finish(undefined, Math.round(performance.now() - start))
        return
      }
      if (event.data instanceof Blob) {
        event.data.arrayBuffer().then((buf) => {
          if (isPongPayload(buf)) finish(undefined, Math.round(performance.now() - start))
        })
        return
      }
      if (event.data instanceof Uint8Array && isPongPayload(event.data)) {
        finish(undefined, Math.round(performance.now() - start))
      }
    }

    const timer = window.setTimeout(() => {
      finish(new Error(`Ping timed out (${timeoutMs / 1000}s).`))
    }, timeoutMs)

    channel.addEventListener('message', onMessage)
    channel.send(PING_BYTES)
  })
}
