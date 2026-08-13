/** Binary ping protocol shared with legacy proxy/agent and Pi WebRTC master. */
export const PING_BYTES = new Uint8Array([0x50, 0x49, 0x4e, 0x47]) // "PING" — relay only
export const PING_RADIO_BYTES = new Uint8Array([0x50, 0x49, 0x4e, 0x47, 0x52]) // "PINGR" — full radio path
export const PONG_BYTES = new Uint8Array([0x50, 0x4f, 0x4e, 0x47]) // "PONG"

export type PingMode = 'local' | 'radio'

export type PingHop = { hop: string; ts?: number }

export type PingResult = {
  /** Display RTT: prefers Pi-measured air RTT (excl. turnaround) when present. */
  rttMs: number
  /** Browser wall clock (WebRTC + queue + turnaround + air). */
  wallRttMs?: number
  /** RF round-trip excluding intentional half-duplex turnaround (from Pi). */
  airRttMs?: number
  turnaroundMs?: number
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
      air_rtt_ms?: number
      rtt_ms?: number
      turnaround_ms?: number
    }
    if (obj?.type !== 'rdi_pong') return null
    const air =
      typeof obj.air_rtt_ms === 'number' && Number.isFinite(obj.air_rtt_ms)
        ? Math.round(obj.air_rtt_ms)
        : undefined
    const wallPi =
      typeof obj.rtt_ms === 'number' && Number.isFinite(obj.rtt_ms) ? Math.round(obj.rtt_ms) : undefined
    const ta =
      typeof obj.turnaround_ms === 'number' && Number.isFinite(obj.turnaround_ms)
        ? Math.round(obj.turnaround_ms)
        : undefined
    return {
      scope: typeof obj.scope === 'string' ? obj.scope : undefined,
      hops: Array.isArray(obj.hops) ? obj.hops : [],
      lines: Array.isArray(obj.lines) ? obj.lines : [],
      error: typeof obj.error === 'string' ? obj.error : undefined,
      airRttMs: air,
      wallRttMs: wallPi,
      turnaroundMs: ta,
    }
  } catch {
    return null
  }
}

function scopeMatches(mode: PingMode, scope: string | undefined): boolean {
  if (!scope) return true
  if (mode === 'radio') return scope === 'radio'
  return scope === 'local'
}

export type PingDataChannelOptions = {
  mode?: PingMode
  timeoutMs?: number
}

/** Send PING/PINGR on an open data channel; resolves with RTT and optional hop trackers. */
export function pingDataChannel(
  channel: RTCDataChannel,
  options: PingDataChannelOptions | number = {},
): Promise<PingResult> {
  const opts: PingDataChannelOptions =
    typeof options === 'number' ? { timeoutMs: options } : options ?? {}
  const mode: PingMode = opts.mode ?? 'local'
  const timeoutMs = opts.timeoutMs ?? (mode === 'radio' ? 10000 : 5000)

  if (channel.readyState !== 'open') {
    return Promise.reject(new Error('Data channel is not open'))
  }

  return new Promise((resolve, reject) => {
    const start = performance.now()
    let settled = false
    let hops: PingHop[] = []
    let lines: string[] = []
    let hopError: string | undefined
    let airRttMs: number | undefined
    let wallFromPi: number | undefined
    let turnaroundMs: number | undefined
    let sawScopedSummary = false

    const finish = (err?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      channel.removeEventListener('message', onMessage)
      if (err) {
        reject(err)
        return
      }
      const wallBrowser = Math.round(performance.now() - start)
      // Prefer Pi air RTT (true RF path excl. intentional turnaround).
      const rttMs = airRttMs ?? wallFromPi ?? wallBrowser
      resolve({
        rttMs,
        wallRttMs: wallBrowser,
        airRttMs,
        turnaroundMs,
        hops,
        lines,
        error: hopError,
        mode,
      })
    }

    const applySummary = (parsed: ParsedRdiPong) => {
      if (!scopeMatches(mode, parsed.scope)) return false
      hops = parsed.hops ?? hops
      lines = parsed.lines ?? lines
      hopError = parsed.error
      if (parsed.airRttMs != null) airRttMs = parsed.airRttMs
      if (parsed.wallRttMs != null) wallFromPi = parsed.wallRttMs
      if (parsed.turnaroundMs != null) turnaroundMs = parsed.turnaroundMs
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
        if (isPongPayload(data)) {
          // For radio, require rdi_pong so we don't steal a concurrent local PONG.
          if (mode === 'radio' && !sawScopedSummary) return
          if (mode === 'local' && !sawScopedSummary) {
            // local always sends rdi_pong first; accept bare PONG as fallback
          }
          finish()
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
    channel.send(mode === 'radio' ? PING_RADIO_BYTES : PING_BYTES)
  })
}
