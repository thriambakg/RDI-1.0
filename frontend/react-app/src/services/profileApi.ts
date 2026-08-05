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
  relay_id?: string
}

export interface RelayRef {
  relay_id: string
  wavelength_zone_id: string
  name: string
  relay_type: string
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
  relays?: RelayRef[]
  settings?: {
    controls?: {
      version?: number
      keybinds?: Record<string, unknown>
    }
    [key: string]: unknown
  }
}

export async function getProfile(): Promise<UserProfile> {
  const url = `${getApiBaseUrl()}/user-profile`
  const headers = await getAuthHeaders()
  logProfileRequest('GET', url, headers)
  const res = await fetch(url, { method: 'GET', headers, cache: 'no-store' })
  const errBody = !res.ok ? await res.json().catch(() => ({})) : undefined
  logProfileResponse('GET', url, res.status, res.ok, errBody)
  if (!res.ok) {
    const err = errBody as { error?: string }
    throw new Error(err?.error || `Get profile failed: ${res.status}`)
  }
  return res.json()
}

export async function updateUserSettings(settings: Record<string, unknown>): Promise<UserProfile['settings']> {
  const url = `${getApiBaseUrl()}/user-profile`
  const body = { action: 'update_settings', settings }
  const headers = await getAuthHeaders()
  logProfileRequest('PATCH', url, headers, body)
  const res = await fetch(url, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  logProfileResponse('PATCH', url, res.status, res.ok, res.ok ? undefined : data)
  if (!res.ok) {
    const err = data as { error?: string }
    throw new Error(err?.error || `Update settings failed: ${res.status}`)
  }
  return (data as { settings?: UserProfile['settings'] }).settings
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

/** Immutable: remove a folder at path from hierarchy. */
export function removeFolderAtPath(h: ConnectionHierarchy, path: string[]): ConnectionHierarchy {
  if (path.length === 0) return h
  if (path.length === 1) {
    const { [path[0]]: _, ...rest } = h
    return rest
  }
  const [first, ...rest] = path
  const node = h[first]
  if (!node) return h
  if (rest.length === 1) {
    const sub = node.subfolders ?? {}
    const { [rest[0]]: _, ...subRest } = sub
    return { ...h, [first]: { ...node, subfolders: subRest } }
  }
  const updatedSub = removeFolderAtPath(node.subfolders ?? {}, rest)
  return { ...h, [first]: { ...node, subfolders: updatedSub } }
}

/** Immutable: remove one session from all folders. */
export function removeSessionFromHierarchy(h: ConnectionHierarchy, sessionId: string): ConnectionHierarchy {
  const out: ConnectionHierarchy = {}
  for (const [name, node] of Object.entries(h)) {
    const sessions = (node.sessions ?? []).filter((s) => s.session_id !== sessionId)
    const subfolders = removeSessionFromHierarchy(node.subfolders ?? {}, sessionId)
    out[name] = { ...node, sessions, subfolders }
  }
  return out
}

/** Immutable: set status of a session (e.g. to 'idle') everywhere in hierarchy. */
export function updateSessionStatusInHierarchy(h: ConnectionHierarchy, sessionId: string, status: string): ConnectionHierarchy {
  const out: ConnectionHierarchy = {}
  for (const [name, node] of Object.entries(h)) {
    const sessions = (node.sessions ?? []).map((s) =>
      s.session_id === sessionId ? { ...s, status } : s
    )
    const subfolders = updateSessionStatusInHierarchy(node.subfolders ?? {}, sessionId, status)
    out[name] = { ...node, sessions, subfolders }
  }
  return out
}

export function updateSessionNameInHierarchy(h: ConnectionHierarchy, sessionId: string, name: string): ConnectionHierarchy {
  const out: ConnectionHierarchy = {}
  for (const [folderName, node] of Object.entries(h)) {
    const sessions = (node.sessions ?? []).map((s) =>
      s.session_id === sessionId ? { ...s, name } : s
    )
    const subfolders = updateSessionNameInHierarchy(node.subfolders ?? {}, sessionId, name)
    out[folderName] = { ...node, sessions, subfolders }
  }
  return out
}

/** Immutable: add a folder at parentPath with given name. */
export function addFolderAtPath(h: ConnectionHierarchy, parentPath: string[], folderName: string): ConnectionHierarchy {
  const newFolder: FolderNode = { sessions: [], subfolders: {} }
  if (parentPath.length === 0) {
    return { ...h, [folderName]: newFolder }
  }
  const [first, ...rest] = parentPath
  const node = h[first] ?? { sessions: [], subfolders: {} }
  const updatedSub = addFolderAtPath(node.subfolders ?? {}, rest, folderName)
  return { ...h, [first]: { ...node, subfolders: updatedSub } }
}

/** Immutable: update a relay's status in the relays array. */
export function updateRelayStatusInRelays(
  relays: RelayRef[],
  relay_id: string,
  wavelength_zone_id: string,
  status: string
): RelayRef[] {
  return relays.map((r) =>
    r.relay_id === relay_id && r.wavelength_zone_id === wavelength_zone_id ? { ...r, status } : r
  )
}

/** Immutable: remove a relay from the relays array. */
export function removeRelayFromRelays(
  relays: RelayRef[],
  relay_id: string,
  wavelength_zone_id: string
): RelayRef[] {
  return relays.filter(
    (r) => !(r.relay_id === relay_id && r.wavelength_zone_id === wavelength_zone_id)
  )
}

/** Immutable: add a session to the folder at parentPath. Creates path if missing. */
export function addSessionAtPath(h: ConnectionHierarchy, parentPath: string[], session: SessionRef): ConnectionHierarchy {
  if (parentPath.length === 0) return h
  const [first, ...rest] = parentPath
  const node = h[first] ?? { sessions: [], subfolders: {} }
  if (rest.length === 0) {
    const sessions = [...(node.sessions ?? []), session]
    return { ...h, [first]: { ...node, sessions } }
  }
  const updatedSub = addSessionAtPath(node.subfolders ?? {}, rest, session)
  return { ...h, [first]: { ...node, subfolders: updatedSub } }
}
