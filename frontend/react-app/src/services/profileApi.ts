/**
 * User Profile API - fetches connection hierarchy (folders)
 */
import { getConfig } from '../config'
import { getAuthHeaders } from './authHeaders'

const getApiBaseUrl = (): string => {
  const cfg = getConfig()
  const url = cfg.API_GATEWAY_URL || ''
  return url.endsWith('/') ? url.slice(0, -1) : url
}

function logProfileRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: unknown
) {
  if (typeof window === 'undefined') return
  const base = getApiBaseUrl()
  const authValue = headers['Authorization']
  const tokenPart = authValue?.replace(/^Bearer\s+/i, '') ?? ''
  console.log('[RDI Profile API]', method, url, {
    resolvedUrl: url,
    apiBaseUrl: base || '(empty – requests will go to same origin)',
    ...(body !== undefined && { body }),
  })
  if (authValue && tokenPart) {
    console.log('🔒 [RDI Profile API] Authorization header present:', {
      hasToken: true,
      tokenLength: tokenPart.length,
      tokenPrefix: tokenPart.substring(0, 30) + '...',
      fullHeaderPrefix: authValue.substring(0, 50) + '...',
    })
  } else {
    console.warn('⚠️ [RDI Profile API] No Authorization header – request will likely fail with 401')
  }
}

function logProfileResponse(method: string, url: string, status: number, ok: boolean, errBody?: unknown) {
  if (typeof window === 'undefined') return
  console.log('[RDI Profile API] Response:', { method, url, status, ok, ...(errBody !== undefined && { errBody }) })
  if (!ok && errBody !== undefined) {
    console.error('[RDI Profile API] Error response body:', errBody)
  }
}

export interface SessionRef {
  session_id: string
  name: string
  status: string
}

export interface FolderNode {
  sessions: SessionRef[]
  subfolders: Record<string, FolderNode>
}

export type ConnectionHierarchy = Record<string, FolderNode>

export interface UserProfile {
  user_id: string
  connection_hierarchy: ConnectionHierarchy
}

export async function getProfile(): Promise<UserProfile> {
  const url = `${getApiBaseUrl()}/user-profile`
  const headers = await getAuthHeaders()
  logProfileRequest('GET', url, headers)
  const res = await fetch(url, { method: 'GET', headers })
  const errBody = !res.ok ? await res.json().catch(() => ({})) : undefined
  logProfileResponse('GET', url, res.status, res.ok, errBody)
  if (!res.ok) {
    const err = errBody as { error?: string }
    throw new Error(err?.error || `Get profile failed: ${res.status}`)
  }
  return res.json()
}

export async function createFolder(parentPath: string[], folderName: string): Promise<void> {
  const url = `${getApiBaseUrl()}/user-profile`
  const body = { action: 'create_folder', parent_path: parentPath, folder_name: folderName }
  const headers = await getAuthHeaders()
  logProfileRequest('PATCH', url, headers, body)
  const res = await fetch(url, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body),
  })
  const errBody = !res.ok ? await res.json().catch(() => ({})) : undefined
  logProfileResponse('PATCH', url, res.status, res.ok, errBody)
  if (!res.ok) {
    const err = errBody as { error?: string }
    throw new Error(err?.error || `Create folder failed: ${res.status}`)
  }
}

export async function deleteFolder(folderPath: string[]): Promise<void> {
  const url = `${getApiBaseUrl()}/user-profile`
  const body = { action: 'delete_folder', folder_path: folderPath }
  const headers = await getAuthHeaders()
  logProfileRequest('PATCH', url, headers, body)
  const res = await fetch(url, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body),
  })
  const errBody = !res.ok ? await res.json().catch(() => ({})) : undefined
  logProfileResponse('PATCH', url, res.status, res.ok, errBody)
  if (!res.ok) {
    const err = errBody as { error?: string }
    throw new Error(err?.error || `Delete folder failed: ${res.status}`)
  }
}
