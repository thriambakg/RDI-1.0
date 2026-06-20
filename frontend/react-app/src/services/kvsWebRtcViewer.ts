/**
 * KVS WebRTC Viewer client — connects browser to Pi MASTER for a session.
 * Signaling uses the official AWS KVS WebRTC SDK (same wire format as the Pi worker).
 */

import {
  GetIceServerConfigCommand,
  KinesisVideoSignalingClient,
} from '@aws-sdk/client-kinesis-video-signaling'
import { Role, SignalingClient } from 'amazon-kinesis-video-streams-webrtc'

type KvsSignalingEvents = {
  on(event: 'open', listener: () => void): void
  on(event: 'sdpAnswer', listener: (answer: RTCSessionDescriptionInit) => void): void
  on(event: 'iceCandidate', listener: (candidate: RTCIceCandidateInit) => void): void
  on(
    event: 'statusResponse',
    listener: (status: {
      success?: boolean
      errorType?: string
      description?: string
      statusCode?: string
    }) => void,
  ): void
  on(event: 'error', listener: (err: unknown) => void): void
  drainPendingIceCandidates(clientId?: string): void
}

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

async function fetchIceServers(
  bundle: WebRtcViewerBundle,
  viewerClientId: string,
): Promise<RTCIceServer[]> {
  const httpsEndpoint = bundle.signaling_endpoint_https
  if (!httpsEndpoint) {
    throw new Error('signaling_endpoint_https missing from session webrtc bundle (redeploy Session API)')
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

function waitForIceGathering(pc: RTCPeerConnection, timeoutMs = 8000): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', onChange)
      clearTimeout(timer)
      resolve()
    }
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') done()
    }
    pc.addEventListener('icegatheringstatechange', onChange)
    const timer = window.setTimeout(done, timeoutMs)
  })
}

export async function connectKvsViewer(
  bundle: WebRtcViewerBundle,
  options?: { viewerClientId?: string; signal?: AbortSignal },
): Promise<KvsViewerConnection> {
  const viewerClientId =
    options?.viewerClientId ??
    `viewer-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
  const iceServers = await fetchIceServers(bundle, viewerClientId)
  const pc = new RTCPeerConnection({ iceServers })
  let signalingClient: SignalingClient | null = null
  let closed = false

  // Viewer creates the data channel (included in SDP offer — more reliable with aiortc master).
  const dataChannel = pc.createDataChannel('mavlink', { ordered: false, maxRetransmits: 0 })

  const close = () => {
    if (closed) return
    closed = true
    try {
      signalingClient?.close()
    } catch {
      /* ignore */
    }
    signalingClient = null
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
      fail(
        new Error(
          `WebRTC connection timed out (30s). Pi state=${pc.connectionState}, ice=${pc.iceConnectionState}. Check Pi logs for "signaling rx SDP_OFFER".`,
        ),
      )
    }, 30000)

    const finish = () => {
      clearTimeout(connectTimeout)
      if (dataChannel.readyState !== 'open') return
      resolve({ dataChannel, peerConnection: pc, close })
    }

    dataChannel.addEventListener('open', () => finish(), { once: true })
    if (dataChannel.readyState === 'open') finish()

    pc.onconnectionstatechange = () => {
      console.log('[RDI WebRTC] connectionState=', pc.connectionState, 'ice=', pc.iceConnectionState)
      if (pc.connectionState === 'connected' && dataChannel.readyState === 'open') {
        finish()
      }
      if (pc.connectionState === 'failed') {
        fail(new Error(`WebRTC peer connection failed (ice=${pc.iceConnectionState})`))
      }
    }

    pc.oniceconnectionstatechange = () => {
      console.log('[RDI WebRTC] iceConnectionState=', pc.iceConnectionState)
    }

    pc.onicecandidate = ({ candidate }) => {
      if (!candidate || !signalingClient) return
      try {
        signalingClient.sendIceCandidate(candidate)
      } catch {
        /* signaling may be closing */
      }
    }

    let remoteDescriptionSet = false
    const pendingRemoteIce: RTCIceCandidateInit[] = []

    signalingClient = new SignalingClient({
      channelARN: bundle.channel_arn,
      channelEndpoint: bundle.signaling_endpoint,
      region: bundle.region,
      role: Role.VIEWER,
      clientId: viewerClientId,
      enableEarlyIceCandidateBuffering: true,
      credentials: {
        accessKeyId: bundle.credentials.accessKeyId,
        secretAccessKey: bundle.credentials.secretAccessKey,
        sessionToken: bundle.credentials.sessionToken,
      },
    })

    const sig = signalingClient as SignalingClient & KvsSignalingEvents

    sig.on('open', async () => {
      try {
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        await waitForIceGathering(pc)
        if (pc.localDescription) {
          signalingClient?.sendSdpOffer(pc.localDescription)
        }
      } catch (e) {
        fail(e instanceof Error ? e : new Error('Failed to create WebRTC offer'))
      }
    })

    sig.on('sdpAnswer', async (answer: RTCSessionDescriptionInit) => {
      try {
        await pc.setRemoteDescription(answer as RTCSessionDescriptionInit)
        remoteDescriptionSet = true
        sig.drainPendingIceCandidates()
        for (const candidate of pendingRemoteIce) {
          await pc.addIceCandidate(candidate)
        }
        pendingRemoteIce.length = 0
      } catch (e) {
        fail(e instanceof Error ? e : new Error('Failed to apply SDP answer from Pi'))
      }
    })

    sig.on('iceCandidate', async (candidate: RTCIceCandidateInit) => {
      if (!remoteDescriptionSet) {
        pendingRemoteIce.push(candidate)
        return
      }
      try {
        await pc.addIceCandidate(candidate)
      } catch {
        /* ignore duplicate or late candidates */
      }
    })

    sig.on('statusResponse', (status: { success?: boolean; errorType?: string; description?: string; statusCode?: string }) => {
      if (status && status.success === false) {
        fail(
          new Error(
            `KVS signaling error: ${status.errorType ?? 'unknown'} — ${status.description ?? status.statusCode ?? ''}`,
          ),
        )
      }
    })

    sig.on('error', (err: unknown) => {
      const message = err instanceof Error ? err.message : 'KVS signaling error'
      fail(new Error(message))
    })

    signalingClient.open()
  })
}
