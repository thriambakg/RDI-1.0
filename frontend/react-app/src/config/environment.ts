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

export function getEnvironmentConfig(): RDIEnvironmentConfig {
  const environment = getCurrentEnvironment();
  return {
    environment,
    apiGatewayUrl: getApiGatewayUrl(),
    awsRegion: getAwsRegion(),
  };
}
