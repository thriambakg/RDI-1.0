// Development environment — API base URL (REST only). WebSocket endpoint is per-session from POST /sessions (ALB/Proxy, not API Gateway).

export const DEVELOPMENT_CONFIG = {
  environment: 'development' as const,
  apiGatewayUrl: 'https://your-api-id.execute-api.us-east-1.amazonaws.com/development',
  awsRegion: 'us-east-1',
};

export default DEVELOPMENT_CONFIG;
