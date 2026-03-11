function parseAvailableRegions(val: unknown): string[] {
  if (Array.isArray(val) && val.every((x) => typeof x === 'string')) return val
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val) as unknown
      return Array.isArray(parsed) && parsed.every((x) => typeof x === 'string') ? parsed : []
    } catch {
      return []
    }
  }
  return []
}

export function getConfig(): RDIConfig {
  const raw = typeof window !== 'undefined' ? window.__RDI_CONFIG__ : undefined
  const fallback: RDIConfig = {
    AWS_REGION: import.meta.env.VITE_AWS_REGION || 'us-east-1',
    COGNITO_USER_POOL_ID: import.meta.env.VITE_COGNITO_USER_POOL_ID || '',
    COGNITO_CLIENT_ID: import.meta.env.VITE_COGNITO_USER_POOL_CLIENT_ID || '',
    COGNITO_DOMAIN: import.meta.env.VITE_COGNITO_DOMAIN || '',
    REDIRECT_SIGN_IN: import.meta.env.VITE_REDIRECT_SIGN_IN || 'http://localhost:5173/auth/callback',
    REDIRECT_SIGN_OUT: import.meta.env.VITE_REDIRECT_SIGN_OUT || 'http://localhost:5173',
    API_GATEWAY_URL: import.meta.env.VITE_API_GATEWAY_URL || '',
    WEBSOCKET_URL: import.meta.env.VITE_WEBSOCKET_URL || '',
    ENVIRONMENT: import.meta.env.VITE_ENVIRONMENT || 'staging',
    ENABLE_GOOGLE_AUTH: import.meta.env.VITE_ENABLE_GOOGLE_AUTH === 'true' || false,
    AVAILABLE_REGIONS: parseAvailableRegions(import.meta.env.VITE_AVAILABLE_REGIONS || '[]'),
  }
  if (!raw || typeof raw !== 'object') return fallback
  const r = raw as RDIConfig
  return {
    ...r,
    AVAILABLE_REGIONS: parseAvailableRegions(r.AVAILABLE_REGIONS ?? fallback.AVAILABLE_REGIONS ?? []),
  }
}
