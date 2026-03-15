// Production environment — eu-central-1. API + Cognito from this file when ENVIRONMENT=production.

export const PRODUCTION_CONFIG = {
  environment: 'production' as const,
  // Paste your eu-central-1 API Gateway base URL when deployed (terraform output api_gateway_base_url).
  apiGatewayUrl: 'https://your-api-id.execute-api.eu-central-1.amazonaws.com/production',
  awsRegion: 'eu-central-1',
  cognitoUserPoolId: 'eu-central-1_2MZi63N2J',
  cognitoClientId: '6idfi4j7lgij353qlfndj3gfb3',
  cognitoDomain: 'rdi-production-128247.auth.eu-central-1.amazoncognito.com',
};

export default PRODUCTION_CONFIG;
