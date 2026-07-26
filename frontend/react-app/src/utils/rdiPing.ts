/** Binary ping protocol shared with legacy proxy/agent and Pi WebRTC master. */
export const PING_BYTES = new Uint8Array([0x50, 0x49, 0x4e, 0x47]) // "PING"
export const PONG_BYTES = new Uint8Array([0x50, 0x4f, 0x4e, 0x47]) // "PONG"

export type PingHop = { hop: string; ts?: number }

export type PingResult = {
  rttMs: number
  hops: PingHop[]
  lines: string[]
  error?: string
}

export function isPongPayload(data: ArrayBuffer | ArrayBufferView): boolean {
  const arr = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  return arr.length === PONG_BYTES.length && arr.every((b, i) => b === PONG_BYTES[i])
}

function parseRdiPong(raw: ArrayBuffer | ArrayBufferView | string): Partial<PingResult> | null {
  try {
    const text =
      typeof raw === 'string'
        ? raw
        : new TextDecoder().decode(
            raw instanceof ArrayBuffer ? raw : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength),
          )
    const obj = JSON.parse(text) as {
      type?: string
      hops?: PingHop[]
      lines?: string[]
      error?: string
    }
    if (obj?.type !== 'rdi_pong') return null
    return {
      hops: Array.isArray(obj.hops) ? obj.hops : [],
      lines: Array.isArray(obj.lines) ? obj.lines : [],
      error: typeof obj.error === 'string' ? obj.error : undefined,
    }
  } catch {
    return null
  }
}

/** Send PING on an open data channel; resolves with RTT and optional radio hop trackers. */
export function pingDataChannel(channel: RTCDataChannel, timeoutMs = 12000): Promise<PingResult> {
  if (channel.readyState !== 'open') {
    return Promise.reject(new Error('Data channel is not open'))
  }

  return new Promise((resolve, reject) => {
    const start = performance.now()
    let settled = false
    let hops: PingHop[] = []
    let lines: string[] = []
    let hopError: string | undefined

    const finish = (err?: Error, rttMs?: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      channel.removeEventListener('message', onMessage)
      if (err) reject(err)
      else
        resolve({
          rttMs: rttMs ?? Math.round(performance.now() - start),
          hops,
          lines,
          error: hopError,
        })
    }

    const ingest = (data: unknown) => {
      if (typeof data === 'string') {
        const parsed = parseRdiPong(data)
        if (parsed) {
          hops = parsed.hops ?? hops
          lines = parsed.lines ?? lines
          hopError = parsed.error
        }
        return
      }
      if (data instanceof ArrayBuffer) {
        const parsed = parseRdiPong(data)
        if (parsed) {
          hops = parsed.hops ?? hops
          lines = parsed.lines ?? lines
          hopError = parsed.error
          return
        }
        if (isPongPayload(data)) {
          finish(undefined, Math.round(performance.now() - start))
        }
        return
      }
      if (data instanceof Blob) {
        data.arrayBuffer().then((buf) => ingest(buf))
        return
      }
      if (data instanceof Uint8Array) {
        ingest(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
      }
    }

    const onMessage = (event: MessageEvent) => ingest(event.data)

    const timer = window.setTimeout(() => {
      finish(new Error(`Ping timed out (${timeoutMs / 1000}s).`))
    }, timeoutMs)

    channel.addEventListener('message', onMessage)
    channel.send(PING_BYTES)
  })
}
