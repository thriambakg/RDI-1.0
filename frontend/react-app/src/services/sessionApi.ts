/**
 * Session API client - create/release sessions with Cognito Bearer token
 */
import { getConfig } from '../config'
import { getAuthHeaders } from './authHeaders'

const getApiBaseUrl = (): string => {
  const cfg = getConfig()
  const url = cfg.API_GATEWAY_URL || ''
  return url.endsWith('/') ? url.slice(0, -1) : url
}

if (typeof window !== 'undefined') {
  const baseUrl = getApiBaseUrl()
  console.log('🚀 [RDI Session API] Initialized:', {
    baseUrl: baseUrl || '(not set)',
    isConfigured: !!baseUrl,
  })
}

export interface CreateSessionParams {
  drone_name: string
  ttl_seconds?: number
  wavelength_zone_id?: string
  folder_path?: string[]
  relay_id?: string
  metadata?: {
    mavlink_port?: number
    mavlink_host?: string
    px4_version?: string
    /** Firmware / dialect adapter for this connection (one relay, many stacks). */
    vehicle_stack?: 'px4' | 'ardupilot' | 'rdi_companion' | 'aux_only' | 'gazebo_px4'
    link_mode?: 'none' | 'shared_serial' | 'dedicated_serial' | 'udp_mavlink'
    mavlink_sysid?: number
    mavlink_compid?: number
    radio_net_id?: number
    radio_device?: string
    radio_baud?: number
  }
}

export interface RelayConfig {
  mavlink_host?: string
  mavlink_port?: number
}

export type SessionTransport = 'webrtc' | 'websocket'

export interface WebRtcViewerBundle {
  channel_arn: string
  region: string
  signaling_endpoint: string
  signaling_endpoint_https?: string
  credentials: {
    accessKeyId: string
    secretAccessKey: string
    sessionToken?: string
    expiration?: string
  }
}

export interface CreateSessionResponse {
  session_id: string
  drone_id: string
  endpoint: string
  expires_at: number
  transport?: SessionTransport
  webrtc?: WebRtcViewerBundle
  relay_id?: string
  relay_config?: RelayConfig
  carrier_ip?: string
  mavlink_host?: string
  mavlink_port?: number
}

export interface SessionInfo {
  session_id: string
  drone_id: string
  name: string
  status: string
  wavelength_zone_id?: string
  endpoint?: string
  transport?: SessionTransport
  expires_at?: number
  ttl_seconds?: number
}

export interface ListSessionsResponse {
  sessions: SessionInfo[]
}

export async function createSession(params: CreateSessionParams): Promise<CreateSessionResponse> {
  const url = `${getApiBaseUrl()}/sessions`
  const body = {
    drone_name: params.drone_name.trim() || 'drone',
    ttl_seconds: params.ttl_seconds ?? 14400,
    wavelength_zone_id: params.wavelength_zone_id,
    folder_path: params.folder_path ?? ['My Drones'],
    relay_id: params.relay_id,
    metadata: params.metadata,
  }
  console.log('🌐 [RDI Session API] POST /sessions', { url, body })
  const headers = await getAuthHeaders()
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  console.log('📥 [RDI Session API] Response:', {
    status: res.status,
    statusText: res.statusText,
    ok: res.ok,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    console.error('❌ [RDI Session API] Create session failed:', { status: res.status, error: err })
    throw new Error(err.error || `Session create failed: ${res.status}`)
  }
  const data = await res.json()
  console.log('✅ [RDI Session API] Session created:', {
    session_id: data.session_id,
    drone_id: data.drone_id,
    transport: data.transport,
    endpoint: data.endpoint,
  })
  return data
}

export async function releaseSession(session_id: string): Promise<void> {
  const url = `${getApiBaseUrl()}/sessions`
  const body = { session_id }
  console.log('🌐 [RDI Session API] DELETE /sessions', { url, body })
  const headers = await getAuthHeaders()
  const res = await fetch(url, {
    method: 'DELETE',
    headers,
    body: JSON.stringify(body),
  })
  console.log('📥 [RDI Session API] Release response:', {
    status: res.status,
    statusText: res.statusText,
    ok: res.ok,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    console.error('❌ [RDI Session API] Release session failed:', { status: res.status, error: err })
    throw new Error(err.error || `Session release failed: ${res.status}`)
  }
  console.log('✅ [RDI Session API] Session released:', { session_id })
}

export async function activateSession(session_id: string): Promise<PatchSessionResponse> {
  return updateSession({ session_id, status: 'active' })
}

export interface PatchSessionResponse {
  message: string
  session_id: string
  status: string
  ttl_seconds?: number
  expires_at?: number
  name?: string
  webrtc?: WebRtcViewerBundle
}

export async function updateSession(params: {
  session_id: string
  status?: 'active' | 'idle'
  name?: string
  ttl_seconds?: number
}): Promise<PatchSessionResponse> {
  const url = `${getApiBaseUrl()}/sessions`
  const body: Record<string, unknown> = { session_id: params.session_id }
  if (params.status) body.status = params.status
  if (params.name != null) body.name = params.name
  if (params.ttl_seconds != null) body.ttl_seconds = params.ttl_seconds
  console.log('🌐 [RDI Session API] PATCH /sessions', { url, body })
  const headers = await getAuthHeaders()
  const res = await fetch(url, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body),
  })
  console.log('📥 [RDI Session API] PATCH response:', {
    status: res.status,
    statusText: res.statusText,
    ok: res.ok,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    console.error('❌ [RDI Session API] PATCH session failed:', { status: res.status, error: err })
    throw new Error((err as { error?: string }).error || `Update session failed: ${res.status}`)
  }
  const data = (await res.json()) as PatchSessionResponse
  console.log('✅ [RDI Session API] Session updated:', {
    session_id: data.session_id,
    status: data.status,
    hasWebrtc: Boolean(data.webrtc),
  })
  return data
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Resolve viewer WebRTC bundle after activate/reactivate (PATCH may omit webrtc briefly). */
export async function fetchWebRtcBundleForSession(
  session_id: string,
  patch?: PatchSessionResponse,
  options?: { attempts?: number; delayMs?: number },
): Promise<WebRtcViewerBundle | undefined> {
  if (patch?.webrtc) return patch.webrtc
  const attempts = options?.attempts ?? 5
  const delayMs = options?.delayMs ?? 1500
  for (let i = 0; i < attempts; i += 1) {
    if (i > 0) await sleep(delayMs)
    try {
      const data = await getSession(session_id)
      if (data.status === 'active' && data.webrtc) {
        console.log('[RDI Session API] WebRTC bundle resolved via GET /sessions', {
          session_id,
          attempt: i + 1,
          channel: data.webrtc.channel_arn.slice(-36),
        })
        return data.webrtc
      }
    } catch (e) {
      console.warn('[RDI Session API] GET /sessions while resolving WebRTC failed', e)
    }
  }
  return undefined
}

export async function listSessions(wavelengthZoneId?: string): Promise<ListSessionsResponse> {
  const params = wavelengthZoneId ? `?wavelength_zone_id=${encodeURIComponent(wavelengthZoneId)}` : ''
  const url = `${getApiBaseUrl()}/sessions${params}`
  console.log('🌐 [RDI Session API] GET /sessions', { url })
  const headers = await getAuthHeaders()
  const res = await fetch(url, { method: 'GET', headers })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    console.error('❌ [RDI Session API] List sessions failed:', { status: res.status, error: err })
    throw new Error(err.error || `List sessions failed: ${res.status}`)
  }
  const data = await res.json()
  return data
}

export async function getSession(session_id: string): Promise<{
  session_id: string
  drone_id: string
  endpoint: string
  status: string
  transport?: SessionTransport
  relay_id?: string
  mavlink_host?: string
  mavlink_port?: number
  carrier_ip?: string
  webrtc?: WebRtcViewerBundle
  ttl_seconds?: number
  expires_at?: number
  link_mode?: string
  vehicle_stack?: string
  mavlink_sysid?: number
}> {
  const url = `${getApiBaseUrl()}/sessions?session_id=${encodeURIComponent(session_id)}`
  const headers = await getAuthHeaders()
  const res = await fetch(url, { method: 'GET', headers })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || `Get session failed: ${res.status}`)
  }
  return res.json()
}

export async function deleteSession(session_id: string, permanent = true): Promise<void> {
  const url = `${getApiBaseUrl()}/sessions`
  const body = { session_id, permanent }
  console.log('🌐 [RDI Session API] DELETE /sessions (permanent)', { url, body })
  const headers = await getAuthHeaders()
  const res = await fetch(url, {
    method: 'DELETE',
    headers,
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    console.error('❌ [RDI Session API] Delete session failed:', { status: res.status, error: err })
    throw new Error(err.error || `Delete session failed: ${res.status}`)
  }
  console.log('✅ [RDI Session API] Session deleted:', { session_id })
}
