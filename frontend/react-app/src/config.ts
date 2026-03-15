import { getEdgeZonesForEnvironment } from './config/environment-regions'
import { getApiGatewayUrl, getAwsRegion, getEnvironmentConfig } from './config/environment'

export function getConfig(): RDIConfig {
  const envConfig = getEnvironmentConfig();
  const runtime = typeof window !== 'undefined' ? window.__RDI_CONFIG__ : undefined;
  return {
    AWS_REGION: getAwsRegion(),
    COGNITO_USER_POOL_ID: runtime?.COGNITO_USER_POOL_ID ?? import.meta.env.VITE_COGNITO_USER_POOL_ID ?? '',
    COGNITO_CLIENT_ID: runtime?.COGNITO_CLIENT_ID ?? import.meta.env.VITE_COGNITO_USER_POOL_CLIENT_ID ?? '',
    COGNITO_DOMAIN: runtime?.COGNITO_DOMAIN ?? import.meta.env.VITE_COGNITO_DOMAIN ?? '',
    REDIRECT_SIGN_IN: runtime?.REDIRECT_SIGN_IN ?? import.meta.env.VITE_REDIRECT_SIGN_IN ?? 'http://localhost:5173/auth/callback',
    REDIRECT_SIGN_OUT: runtime?.REDIRECT_SIGN_OUT ?? import.meta.env.VITE_REDIRECT_SIGN_OUT ?? 'http://localhost:5173',
    API_GATEWAY_URL: getApiGatewayUrl(),
    WEBSOCKET_URL: '', // Not used; WebSocket endpoint is per-session from POST /sessions (ALB/Proxy)
    ENVIRONMENT: envConfig.environment,
    ENABLE_GOOGLE_AUTH: runtime?.ENABLE_GOOGLE_AUTH ?? (import.meta.env.VITE_ENABLE_GOOGLE_AUTH === 'true'),
  };
}

export function getEnvironmentRegions(): { environment: string; regions: ReturnType<typeof getEdgeZonesForEnvironment> } {
  const config = getConfig()
  const environment = config.ENVIRONMENT || getDefaultEnvironment()
  const regions = getEdgeZonesForEnvironment(environment)
  return { environment, regions }
}
