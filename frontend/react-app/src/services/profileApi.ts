/**
 * User Profile API - fetches connection hierarchy (folders)
 */
import { fetchAuthSession } from 'aws-amplify/auth'
import { getConfig } from '../config'

const getApiBaseUrl = (): string => {
  const cfg = getConfig()
  const url = cfg.API_GATEWAY_URL || ''
  return url.endsWith('/') ? url.slice(0, -1) : url
}

function logProfileRequest(method: string, url: string, body?: unknown) {
  if (typeof window === 'undefined') return
  const base = getApiBaseUrl()
  console.log('[RDI Profile API]', method, url, {
    resolvedUrl: url,
    apiBaseUrl: base || '(empty – requests will go to same origin)',
    ...(body !== undefined && { body }),
  })
}

function logProfileResponse(method: string, url: string, status: number, ok: boolean, errBody?: unknown) {
  if (typeof window === 'undefined') return
  console.log('[RDI Profile API] Response:', { method, url, status, ok, ...(errBody !== undefined && { errBody }) })
  if (!ok && errBody !== undefined) {
    console.error('[RDI Profile API] Error response body:', errBody)
  }
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  try {
    const session = await fetchAuthSession()
    const token = session.tokens?.idToken || session.tokens?.accessToken
    if (token && typeof token.toString === 'function') {
      headers['Authorization'] = `Bearer ${token.toString()}`
    }
  } catch {
    /* ignore */
  }
  return headers
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
  logProfileRequest('GET', url)
  const headers = await getAuthHeaders()
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
  logProfileRequest('PATCH', url, body)
  const headers = await getAuthHeaders()
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
  logProfileRequest('PATCH', url, body)
  const headers = await getAuthHeaders()
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
