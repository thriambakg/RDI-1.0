import { getRegionsForEnvironment } from './config/environment-regions'

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
  };
  return cfg;
}

export function getEnvironmentRegions(): { environment: string; regions: ReturnType<typeof getRegionsForEnvironment> } {
  const config = getConfig()
  const environment = config.ENVIRONMENT || 'staging'
  const regions = getRegionsForEnvironment(environment)
  return { environment, regions }
}
