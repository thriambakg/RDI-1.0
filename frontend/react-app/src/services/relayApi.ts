/**
 * Relay Registry API client - register/list/delete relays
 */
import { getConfig } from '../config'
import { getAuthHeaders } from './authHeaders'
import type { RelayRef } from './profileApi'

const getApiBaseUrl = (): string => {
  const cfg = getConfig()
  const url = cfg.API_GATEWAY_URL || ''
  return url.endsWith('/') ? url.slice(0, -1) : url
}

export interface RegisterRelayParams {
  wavelength_zone_id: string
  name: string
  relay_type: 'local' | 'sim_relay'
  config?: Record<string, unknown>
}

export interface RegisterRelayResponse {
  relay_id: string
  wavelength_zone_id: string
  name: string
  relay_type: string
  status: string
}

export async function registerRelay(params: RegisterRelayParams): Promise<RegisterRelayResponse> {
  const url = `${getApiBaseUrl()}/relays`
  const body = {
    wavelength_zone_id: params.wavelength_zone_id,
    name: params.name.trim() || 'relay',
    relay_type: params.relay_type,
    config: params.config ?? {},
  }
  const headers = await getAuthHeaders()
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as { error?: string }).error || `Register relay failed: ${res.status}`)
  }
  return res.json()
}

export async function listRelays(wavelengthZoneId?: string): Promise<{ relays: RelayRef[] }> {
  const params = wavelengthZoneId ? `?wavelength_zone_id=${encodeURIComponent(wavelengthZoneId)}` : ''
  const url = `${getApiBaseUrl()}/relays${params}`
  const headers = await getAuthHeaders()
  const res = await fetch(url, { method: 'GET', headers })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as { error?: string }).error || `List relays failed: ${res.status}`)
  }
  return res.json()
}

export async function deleteRelay(relay_id: string, wavelength_zone_id: string): Promise<void> {
  const url = `${getApiBaseUrl()}/relays`
  const headers = await getAuthHeaders()
  const res = await fetch(url, {
    method: 'DELETE',
    headers,
    body: JSON.stringify({ relay_id, wavelength_zone_id }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as { error?: string }).error || `Delete relay failed: ${res.status}`)
  }
}
