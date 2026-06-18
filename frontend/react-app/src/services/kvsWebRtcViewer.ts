/**
 * KVS WebRTC Viewer client — connects browser to Pi MASTER for a session.
 * Uses the same signaling message format as scripts/relay-device/kvs_master_worker.py.
 */

import { Sha256 } from '@aws-crypto/sha256-js'
import {
  GetIceServerConfigCommand,
  KinesisVideoSignalingClient,
} from '@aws-sdk/client-kinesis-video-signaling'
import { formatUrl } from '@aws-sdk/util-format-url'
import { HttpRequest } from '@smithy/protocol-http'
import { SignatureV4 } from '@smithy/signature-v4'

export interface WebRtcCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}

export interface WebRtcViewerBundle {
  channel_arn: string
  region: string
  signaling_endpoint: string
  signaling_endpoint_https?: string
  credentials: WebRtcCredentials
}

export interface KvsViewerConnection {
  dataChannel: RTCDataChannel
  peerConnection: RTCPeerConnection
  close: () => void
}

const MASTER_CLIENT_ID = 'MASTER'

function decodeKvsMessage(raw: string): { messageType: string; payload: Record<string, unknown>; senderClientId: string } {
  try {
    const data = JSON.parse(raw) as {
      messageType?: string
      messagePayload?: string
      senderClientId?: string
    }
    const payload = JSON.parse(atob(data.messagePayload ?? '')) as Record<string, unknown>
    return {
      messageType: data.messageType ?? '',
      payload,
      senderClientId: data.senderClientId ?? '',
    }
  } catch {
    return { messageType: '', payload: {}, senderClientId: '' }
  }
}

function encodeKvsMessage(
  action: string,
  payload: RTCSessionDescriptionInit | RTCIceCandidateInit | Record<string, unknown>,
  recipientClientId: string,
): string {
  return JSON.stringify({
    action,
    messagePayload: btoa(JSON.stringify(payload)),
    recipientClientId,
  })
}

async function signKvsWssUrl(
  endpointWss: string,
  channelArn: string,
  region: string,
  credentials: WebRtcCredentials,
  clientId: string,
): Promise<string> {
  const url = new URL(endpointWss)
  url.searchParams.set('X-Amz-ChannelARN', channelArn)
  url.searchParams.set('X-Amz-ClientId', clientId)

  const signer = new SignatureV4({
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    },
    region,
    service: 'kinesisvideo',
    sha256: Sha256,
  })

  const signed = await signer.presign(
    new HttpRequest({
      method: 'GET',
      hostname: url.hostname,
      path: url.pathname,
      protocol: url.protocol,
      query: Object.fromEntries(url.searchParams.entries()),
      headers: { host: url.hostname },
    }),
    { expiresIn: 299 },
  )

  return formatUrl(signed)
}

async function fetchIceServers(
  bundle: WebRtcViewerBundle,
  viewerClientId: string,
): Promise<RTCIceServer[]> {
  const httpsEndpoint = bundle.signaling_endpoint_https
  if (!httpsEndpoint) {
    throw new Error('signaling_endpoint_https missing from session webrtc bundle')
  }

  const client = new KinesisVideoSignalingClient({
    region: bundle.region,
    endpoint: httpsEndpoint,
    credentials: {
      accessKeyId: bundle.credentials.accessKeyId,
      secretAccessKey: bundle.credentials.secretAccessKey,
      sessionToken: bundle.credentials.sessionToken,
    },
  })

  const iceCfg = await client.send(
    new GetIceServerConfigCommand({
      ChannelARN: bundle.channel_arn,
      ClientId: viewerClientId,
    }),
  )

  const servers: RTCIceServer[] = [
    { urls: `stun:stun.kinesisvideo.${bundle.region}.amazonaws.com:443` },
  ]
  for (const entry of iceCfg.IceServerList ?? []) {
    servers.push({
      urls: entry.Uris ?? [],
      username: entry.Username,
      credential: entry.Password,
    })
  }
  return servers
}

export async function connectKvsViewer(
  bundle: WebRtcViewerBundle,
  options?: { viewerClientId?: string; signal?: AbortSignal },
): Promise<KvsViewerConnection> {
  const viewerClientId = options?.viewerClientId ?? `viewer-${crypto.randomUUID().slice(0, 8)}`
  const iceServers = await fetchIceServers(bundle, viewerClientId)
  const wssUrl = await signKvsWssUrl(
    bundle.signaling_endpoint,
    bundle.channel_arn,
    bundle.region,
    bundle.credentials,
    viewerClientId,
  )

  const pc = new RTCPeerConnection({ iceServers })
  let ws: WebSocket | null = null
  let closed = false
  let dataChannel: RTCDataChannel | null = null

  const close = () => {
    if (closed) return
    closed = true
    try {
      ws?.close()
    } catch {
      /* ignore */
    }
    ws = null
    pc.close()
  }

  if (options?.signal) {
    if (options.signal.aborted) {
      close()
      throw new DOMException('Aborted', 'AbortError')
    }
    options.signal.addEventListener('abort', close, { once: true })
  }

  return new Promise<KvsViewerConnection>((resolve, reject) => {
    const fail = (err: Error) => {
      close()
      reject(err)
    }

    const connectTimeout = window.setTimeout(() => {
      fail(new Error('WebRTC connection timed out (30s). Is the Pi worker running?'))
    }, 30000)

    const finish = () => {
      clearTimeout(connectTimeout)
      if (!dataChannel) return
      resolve({ dataChannel, peerConnection: pc, close })
    }

    pc.ondatachannel = (ev) => {
      if (ev.channel.label !== 'mavlink') return
      dataChannel = ev.channel
      dataChannel.onopen = () => {
        if (dataChannel?.readyState === 'open') finish()
      }
      if (dataChannel.readyState === 'open') finish()
    }

    pc.onicecandidate = (ev) => {
      if (!ev.candidate || !ws || ws.readyState !== WebSocket.OPEN) return
      ws.send(
        encodeKvsMessage(
          'ICE_CANDIDATE',
          {
            candidate: ev.candidate.candidate,
            sdpMid: ev.candidate.sdpMid,
            sdpMLineIndex: ev.candidate.sdpMLineIndex,
          },
          MASTER_CLIENT_ID,
        ),
      )
    }

    ws = new WebSocket(wssUrl)

    ws.onerror = () => fail(new Error('KVS signaling WebSocket error'))

    ws.onopen = async () => {
      try {
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        ws?.send(encodeKvsMessage('SDP_OFFER', offer, MASTER_CLIENT_ID))
      } catch (e) {
        fail(e instanceof Error ? e : new Error('Failed to create WebRTC offer'))
      }
    }

    ws.onmessage = async (ev) => {
      const { messageType, payload, senderClientId } = decodeKvsMessage(String(ev.data))
      try {
        if (messageType === 'SDP_ANSWER' && senderClientId === MASTER_CLIENT_ID) {
          await pc.setRemoteDescription({
            type: payload.type as RTCSdpType,
            sdp: String(payload.sdp),
          })
        } else if (messageType === 'ICE_CANDIDATE' && senderClientId === MASTER_CLIENT_ID) {
          await pc.addIceCandidate({
            candidate: String(payload.candidate),
            sdpMid: payload.sdpMid as string | undefined,
            sdpMLineIndex: payload.sdpMLineIndex as number | undefined,
          })
        }
      } catch (e) {
        fail(e instanceof Error ? e : new Error('Failed to handle KVS signaling message'))
      }
    }
  })
}
