/** Binary ping protocol shared with legacy proxy/agent and Pi WebRTC master. */
export const PING_BYTES = new Uint8Array([0x50, 0x49, 0x4e, 0x47]) // "PING" — relay only
export const PING_RADIO_BYTES = new Uint8Array([0x50, 0x49, 0x4e, 0x47, 0x52]) // "PINGR" — full radio path
export const PONG_BYTES = new Uint8Array([0x50, 0x4f, 0x4e, 0x47]) // "PONG"

export type PingMode = 'local' | 'radio'

export type PingHop = { hop: string; ts?: number }

export type PingResult = {
  rttMs: number
  hops: PingHop[]
  lines: string[]
  error?: string
  mode: PingMode
}

export function isPongPayload(data: ArrayBuffer | ArrayBufferView): boolean {
  const arr =
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  return arr.length === PONG_BYTES.length && arr.every((b, i) => b === PONG_BYTES[i])
}

type ParsedRdiPong = Partial<PingResult> & { scope?: string }

function parseRdiPong(raw: ArrayBuffer | ArrayBufferView | string): ParsedRdiPong | null {
  try {
    const text =
      typeof raw === 'string'
        ? raw
        : new TextDecoder().decode(
            raw instanceof ArrayBuffer ? raw : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength),
          )
    const obj = JSON.parse(text) as {
      type?: string
      scope?: string
      hops?: PingHop[]
      lines?: string[]
      error?: string
    }
    if (obj?.type !== 'rdi_pong') return null
    return {
      scope: typeof obj.scope === 'string' ? obj.scope : undefined,
      hops: Array.isArray(obj.hops) ? obj.hops : [],
      lines: Array.isArray(obj.lines) ? obj.lines : [],
      error: typeof obj.error === 'string' ? obj.error : undefined,
    }
  } catch {
    return null
  }
}

function scopeMatches(mode: PingMode, scope: string | undefined): boolean {
  // Older workers omit scope — accept those. Ignore the other mode's replies so
  // concurrent local live-pings cannot complete a radio attempt (and vice versa).
  if (!scope) return true
  if (mode === 'radio') return scope === 'radio'
  return scope === 'local'
}

export type PingDataChannelOptions = {
  mode?: PingMode
  timeoutMs?: number
}

/**
 * Send PING/PINGR on an open data channel; resolves with RTT and optional hop trackers.
 *
 * The mavlink datachannel is unreliable (maxRetransmits: 0) so CTRL uses heartbeats.
 * Radio ping is a single datagram — retransmit until we see a matching rdi_pong.
 */
export function pingDataChannel(
  channel: RTCDataChannel,
  options: PingDataChannelOptions | number = {},
): Promise<PingResult> {
  const opts: PingDataChannelOptions =
    typeof options === 'number' ? { timeoutMs: options } : options ?? {}
  const mode: PingMode = opts.mode ?? 'local'
  const timeoutMs = opts.timeoutMs ?? (mode === 'radio' ? 14000 : 5000)

  if (channel.readyState !== 'open') {
    return Promise.reject(new Error('Data channel is not open'))
  }

  return new Promise((resolve, reject) => {
    const start = performance.now()
    let settled = false
    let hops: PingHop[] = []
    let lines: string[] = []
    let hopError: string | undefined
    /** True once we ingested an rdi_pong for this mode (required before accepting bare PONG). */
    let sawScopedSummary = false
    let retryTimer: number | undefined

    const cleanup = () => {
      clearTimeout(timer)
      if (retryTimer != null) window.clearInterval(retryTimer)
      channel.removeEventListener('message', onMessage)
    }

    const finish = (err?: Error, rttMs?: number) => {
      if (settled) return
      settled = true
      cleanup()
      if (err) reject(err)
      else
        resolve({
          rttMs: rttMs ?? Math.round(performance.now() - start),
          hops,
          lines,
          error: hopError,
          mode,
        })
    }

    const sendPing = () => {
      if (settled || channel.readyState !== 'open') return
      try {
        channel.send(mode === 'radio' ? PING_RADIO_BYTES : PING_BYTES)
      } catch {
        /* channel may close mid-retry */
      }
    }

    const applySummary = (parsed: ParsedRdiPong) => {
      if (!scopeMatches(mode, parsed.scope)) return false
      hops = parsed.hops ?? hops
      lines = parsed.lines ?? lines
      hopError = parsed.error
      sawScopedSummary = true
      return true
    }

    const ingest = (data: unknown) => {
      if (typeof data === 'string') {
        const parsed = parseRdiPong(data)
        if (parsed) applySummary(parsed)
        return
      }
      if (data instanceof ArrayBuffer) {
        const parsed = parseRdiPong(data)
        if (parsed) {
          applySummary(parsed)
          return
        }
        // Bare PONG: ignore until we have the matching rdi_pong summary so a
        // concurrent local probe cannot complete a radio ping (or the reverse).
        if (isPongPayload(data) && sawScopedSummary) {
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
    sendPing()
    // Unreliable DC: retransmit slowly. Fast retries pile up on the shared radio
    // router and kill half-duplex return pongs (desktop echoes, Pi times out).
    const retryEveryMs = mode === 'radio' ? 2800 : 1200
    retryTimer = window.setInterval(sendPing, retryEveryMs)
  })
}
