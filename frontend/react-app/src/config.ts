const DEFAULT_AVAILABLE_REGIONS = ['us-east-2']

export function getConfig(): RDIConfig {
  const cfg = (typeof window !== 'undefined' && window.__RDI_CONFIG__) || {
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
    AVAILABLE_REGIONS: (() => {
      try {
        const v = import.meta.env.VITE_AVAILABLE_REGIONS;
        return v ? JSON.parse(v) : ['us-east-2'];
      } catch {
        return ['us-east-2'];
      }
    })(),
  }
  const merged: RDIConfig = { ...cfg }
  if (!Array.isArray(merged.AVAILABLE_REGIONS) || merged.AVAILABLE_REGIONS.length === 0) {
    merged.AVAILABLE_REGIONS = DEFAULT_AVAILABLE_REGIONS
  }
  return merged
}
