// Environment-specific config: API base URL from hardcoded env files.
// WebSocket endpoint is not global — it comes per-session from POST /sessions (ALB/Proxy; see ARCHITECTURE.md).

import { DEVELOPMENT_CONFIG } from './environments/development';
import { STAGING_CONFIG } from './environments/staging';
import { PRODUCTION_CONFIG } from './environments/production';

export type RDIEnvironment = 'development' | 'staging' | 'production';

export interface RDIEnvironmentConfig {
  environment: RDIEnvironment;
  apiGatewayUrl: string;
  awsRegion: string;
  cognitoUserPoolId: string;
  cognitoClientId: string;
  cognitoDomain: string;
}

const ENV_CONFIGS: Record<RDIEnvironment, RDIEnvironmentConfig> = {
  development: DEVELOPMENT_CONFIG,
  staging: STAGING_CONFIG,
  production: PRODUCTION_CONFIG,
};

function getCurrentEnvironment(): RDIEnvironment {
  if (typeof window !== 'undefined' && window.__RDI_CONFIG__?.ENVIRONMENT) {
    const e = window.__RDI_CONFIG__.ENVIRONMENT;
    if (e === 'development' || e === 'staging' || e === 'production') return e;
  }
  const viteEnv = import.meta.env.VITE_ENVIRONMENT;
  if (viteEnv === 'development' || viteEnv === 'staging' || viteEnv === 'production') return viteEnv;
  if (typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
    return 'staging';
  }
  return 'staging';
}

function isPlaceholderUrl(url: string): boolean {
  return !url || url.includes('your-api-id');
}

/** API Gateway base URL (Session API + User Profile API). Env file first, then runtime/VITE (only if non-empty). */
export function getApiGatewayUrl(): string {
  const env = getCurrentEnvironment();
  const fromEnvFile = ENV_CONFIGS[env].apiGatewayUrl;
  if (fromEnvFile && !isPlaceholderUrl(fromEnvFile)) {
    return fromEnvFile.replace(/\/$/, '');
  }
  const runtime = typeof window !== 'undefined' ? window.__RDI_CONFIG__?.API_GATEWAY_URL : undefined;
  if (runtime && !isPlaceholderUrl(runtime)) return runtime.replace(/\/$/, '');
  const vite = import.meta.env.VITE_API_GATEWAY_URL;
  if (vite && typeof vite === 'string' && !isPlaceholderUrl(vite)) return vite.replace(/\/$/, '');
  return (fromEnvFile || '').replace(/\/$/, '');
}

/** AWS region for this environment. */
export function getAwsRegion(): string {
  const runtime = typeof window !== 'undefined' ? window.__RDI_CONFIG__?.AWS_REGION : undefined;
  if (runtime) return runtime;
  const vite = import.meta.env.VITE_AWS_REGION;
  if (vite && typeof vite === 'string') return vite;
  return ENV_CONFIGS[getCurrentEnvironment()].awsRegion;
}

/** Cognito User Pool ID for this environment. Env file overrides runtime when set (so staging can use us-east-1 pool). */
export function getCognitoUserPoolId(): string {
  const env = getCurrentEnvironment();
  const fromEnv = ENV_CONFIGS[env].cognitoUserPoolId;
  if (fromEnv) return fromEnv;
  const runtime = typeof window !== 'undefined' ? window.__RDI_CONFIG__?.COGNITO_USER_POOL_ID : undefined;
  if (runtime) return runtime;
  return import.meta.env.VITE_COGNITO_USER_POOL_ID ?? '';
}

export function getCognitoClientId(): string {
  const env = getCurrentEnvironment();
  const fromEnv = ENV_CONFIGS[env].cognitoClientId;
  if (fromEnv) return fromEnv;
  const runtime = typeof window !== 'undefined' ? window.__RDI_CONFIG__?.COGNITO_CLIENT_ID : undefined;
  if (runtime) return runtime;
  return import.meta.env.VITE_COGNITO_USER_POOL_CLIENT_ID ?? '';
}

export function getCognitoDomain(): string {
  const env = getCurrentEnvironment();
  const fromEnv = ENV_CONFIGS[env].cognitoDomain;
  if (fromEnv) return fromEnv;
  const runtime = typeof window !== 'undefined' ? window.__RDI_CONFIG__?.COGNITO_DOMAIN : undefined;
  if (runtime) return runtime;
  return import.meta.env.VITE_COGNITO_DOMAIN ?? '';
}

export function getEnvironmentConfig(): RDIEnvironmentConfig {
  const environment = getCurrentEnvironment();
  return {
    environment,
    apiGatewayUrl: getApiGatewayUrl(),
    awsRegion: getAwsRegion(),
    cognitoUserPoolId: getCognitoUserPoolId(),
    cognitoClientId: getCognitoClientId(),
    cognitoDomain: getCognitoDomain(),
  };
}
