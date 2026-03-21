import { getEdgeZonesForEnvironment } from './config/environment-regions'
import {
  getApiGatewayUrl,
  getAwsRegion,
  getEnvironmentConfig,
  getCognitoUserPoolId,
  getCognitoClientId,
  getCognitoDomain,
  getDefaultRedirectSignIn,
  getDefaultRedirectSignOut,
} from './config/environment'

export function getConfig(): RDIConfig {
  const envConfig = getEnvironmentConfig();
  const runtime = typeof window !== 'undefined' ? window.__RDI_CONFIG__ : undefined;
  return {
    AWS_REGION: getAwsRegion(),
    COGNITO_USER_POOL_ID: getCognitoUserPoolId(),
    COGNITO_CLIENT_ID: getCognitoClientId(),
    COGNITO_DOMAIN: getCognitoDomain(),
    REDIRECT_SIGN_IN: runtime?.REDIRECT_SIGN_IN ?? import.meta.env.VITE_REDIRECT_SIGN_IN ?? getDefaultRedirectSignIn(),
    REDIRECT_SIGN_OUT: runtime?.REDIRECT_SIGN_OUT ?? import.meta.env.VITE_REDIRECT_SIGN_OUT ?? getDefaultRedirectSignOut(),
    API_GATEWAY_URL: getApiGatewayUrl(),
    WEBSOCKET_URL: '', // Not used; WebSocket endpoint is per-session from POST /sessions (ALB/Proxy)
    ENVIRONMENT: envConfig.environment,
    ENABLE_GOOGLE_AUTH: runtime?.ENABLE_GOOGLE_AUTH ?? (import.meta.env.VITE_ENABLE_GOOGLE_AUTH === 'true'),
  };
}

export function getEnvironmentRegions(): { environment: string; regions: ReturnType<typeof getEdgeZonesForEnvironment> } {
  const config = getConfig()
  const environment = config.ENVIRONMENT || getEnvironmentConfig().environment
  const regions = getEdgeZonesForEnvironment(environment)
  return { environment, regions }
}
