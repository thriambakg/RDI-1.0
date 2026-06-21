/**
 * Lightweight KVS WebRTC signaling client (VIEWER role).
 * SigV4 WSS signing matches amazon-kinesis-video-streams-webrtc / Pi worker wire format.
 */

export interface KvsCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}

const MASTER_CLIENT_ID = 'MASTER'

/** KVS often omits senderClientId on relayed MASTER messages; treat empty as MASTER. */
function isFromMaster(senderClientId: string): boolean {
  return senderClientId === '' || senderClientId === MASTER_CLIENT_ID
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function toUint8Array(input: string): Uint8Array {
  const buf = new Uint8Array(input.length)
  for (let i = 0; i < input.length; i++) buf[i] = input.charCodeAt(i)
  return buf
}

async function hmac(key: ArrayBuffer | string, message: string): Promise<ArrayBuffer> {
  const keyBuffer = typeof key === 'string' ? toUint8Array(key).buffer : key
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBuffer as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return crypto.subtle.sign('HMAC', cryptoKey, toUint8Array(message).buffer as ArrayBuffer)
}

async function sha256Hex(message: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', toUint8Array(message).buffer as ArrayBuffer)
  return toHex(hash)
}

function sortedQueryString(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${k}=${encodeURIComponent(params[k])}`)
    .join('&')
}

function dateTimeString(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[:\-]/g, '')
}

/** SigV4 presigned WSS URL for KVS signaling (VIEWER includes X-Amz-ClientId). */
export async function signKvsViewerWssUrl(
  endpointWss: string,
  channelArn: string,
  region: string,
  credentials: KvsCredentials,
  clientId: string,
): Promise<string> {
  const protocol = 'wss://'
  if (!endpointWss.startsWith(protocol)) {
    throw new Error(`KVS signaling endpoint must start with ${protocol}`)
  }
  const pathStart = endpointWss.indexOf('/', protocol.length)
  const host =
    pathStart < 0 ? endpointWss.slice(protocol.length) : endpointWss.slice(protocol.length, pathStart)
  const path = pathStart < 0 ? '/' : endpointWss.slice(pathStart)

  const now = new Date()
  const amzDate = dateTimeString(now)
  const dateStamp = amzDate.slice(0, 8)
  const credentialScope = `${dateStamp}/${region}/kinesisvideo/aws4_request`
  const signedHeaders = 'host'

  const queryParams: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-ChannelARN': channelArn,
    'X-Amz-ClientId': clientId,
    'X-Amz-Credential': `${credentials.accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': '299',
    'X-Amz-SignedHeaders': signedHeaders,
  }
  if (credentials.sessionToken) {
    queryParams['X-Amz-Security-Token'] = credentials.sessionToken
  }

  const canonicalQueryString = sortedQueryString(queryParams)
  const canonicalHeaders = `host:${host}\n`
  const payloadHash = await sha256Hex('')
  const canonicalRequest = [
    'GET',
    path,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n')

  const kDate = await hmac(`AWS4${credentials.secretAccessKey}`, dateStamp)
  const kRegion = await hmac(kDate, region)
  const kService = await hmac(kRegion, 'kinesisvideo')
  const kSigning = await hmac(kService, 'aws4_request')
  const signature = toHex(await hmac(kSigning, stringToSign))

  return `${protocol}${host}${path}?${canonicalQueryString}&X-Amz-Signature=${signature}`
}

function encodePayload(payload: object): string {
  return btoa(JSON.stringify(payload))
}

function decodePayload<T = Record<string, unknown>>(b64: string): T {
  return JSON.parse(atob(b64)) as T
}

/** Chrome rejects session-level a=setup; keep aiortc media-level DTLS role unchanged. */
function normalizeAnswerSdp(sdp: string): string {
  const linesOut: string[] = []
  let inMedia = false
  for (const raw of sdp.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('m=')) {
      inMedia = true
      linesOut.push(line)
      continue
    }
    if (line.startsWith('a=setup:') && !inMedia) continue
    linesOut.push(line)
  }
  return `${linesOut.join('\r\n')}\r\n`
}

function encodeOutbound(action: string, payload: object): string {
  return JSON.stringify({ action, messagePayload: encodePayload(payload) })
}

function decodeInbound(raw: string): {
  messageType: string
  payload: Record<string, unknown>
  senderClientId: string
} {
  try {
    const data = JSON.parse(raw) as {
      messageType?: string
      messagePayload?: string
      senderClientId?: string
    }
    return {
      messageType: data.messageType ?? '',
      payload: data.messagePayload ? decodePayload(data.messagePayload) : {},
      senderClientId: data.senderClientId ?? '',
    }
  } catch {
    return { messageType: '', payload: {}, senderClientId: '' }
  }
}

export interface KvsSignalingViewerOptions {
  channelArn: string
  endpointWss: string
  region: string
  clientId: string
  credentials: KvsCredentials
}

export class KvsSignalingViewer {
  private ws: WebSocket | null = null
  private closed = false
  private remoteSdpReceived = false
  private pendingRemoteIce: RTCIceCandidateInit[] = []
  private readonly opts: KvsSignalingViewerOptions

  onOpen?: () => void
  onSdpAnswer?: (answer: RTCSessionDescriptionInit) => void
  onIceCandidate?: (candidate: RTCIceCandidateInit) => void
  onError?: (err: Error) => void

  constructor(opts: KvsSignalingViewerOptions) {
    this.opts = opts
  }

  async open(): Promise<void> {
    const url = await signKvsViewerWssUrl(
      this.opts.endpointWss,
      this.opts.channelArn,
      this.opts.region,
      this.opts.credentials,
      this.opts.clientId,
    )
    this.ws = new WebSocket(url)
    this.ws.onopen = () => this.onOpen?.()
    this.ws.onerror = () => this.onError?.(new Error('KVS signaling WebSocket error'))
    this.ws.onmessage = (ev) => this.handleMessage(String(ev.data))
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.ws?.close()
    } catch {
      /* ignore */
    }
    this.ws = null
  }

  sendSdpOffer(offer: RTCSessionDescriptionInit): void {
    this.send('SDP_OFFER', offer)
  }

  sendIceCandidate(candidate: RTCIceCandidate): void {
    this.send('ICE_CANDIDATE', {
      candidate: candidate.candidate,
      sdpMid: candidate.sdpMid,
      sdpMLineIndex: candidate.sdpMLineIndex,
    })
  }

  private send(action: string, payload: object): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(encodeOutbound(action, payload))
  }

  private handleMessage(raw: string): void {
    const { messageType, payload, senderClientId } = decodeInbound(raw)
    if (messageType === 'SDP_ANSWER' && isFromMaster(senderClientId)) {
      this.remoteSdpReceived = true
      this.onSdpAnswer?.({
        type: String(payload.type ?? 'answer').trim() as RTCSdpType,
        sdp: normalizeAnswerSdp(String(payload.sdp ?? '').trim()),
      })
      for (const c of this.pendingRemoteIce) {
        this.onIceCandidate?.(c)
      }
      this.pendingRemoteIce = []
      return
    }
    if (messageType === 'ICE_CANDIDATE' && isFromMaster(senderClientId)) {
      const candidate: RTCIceCandidateInit = {
        candidate: String(payload.candidate),
        sdpMid: payload.sdpMid as string | undefined,
        sdpMLineIndex: payload.sdpMLineIndex as number | undefined,
      }
      if (!this.remoteSdpReceived) {
        this.pendingRemoteIce.push(candidate)
      } else {
        this.onIceCandidate?.(candidate)
      }
      return
    }
    if (
      (messageType === 'SDP_ANSWER' || messageType === 'ICE_CANDIDATE') &&
      !isFromMaster(senderClientId)
    ) {
      console.warn(
        '[RDI KVS] ignored signaling message',
        messageType,
        'from',
        senderClientId,
      )
    }
  }
}
