// Staging environment — API base URL (REST only). WebSocket endpoint is per-session from POST /sessions (ALB/Proxy, not API Gateway).

export const STAGING_CONFIG = {
  environment: 'staging' as const,
  apiGatewayUrl: 'https://13lmrbq5yj.execute-api.us-east-1.amazonaws.com/production',
  awsRegion: 'us-east-1',
};

export default STAGING_CONFIG;
