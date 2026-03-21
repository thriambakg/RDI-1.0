// Staging environment — us-east-1. API + Cognito must be the same pool as the API Gateway authorizer.
// 401 Unauthorized = token from a different pool. Fill the three Cognito values below with the us-east-1
// User Pool that your RDI Terraform uses (base infra for us-east-1: cognito_user_pool_id + app client + domain).
// Add these callback/sign-out URLs to the Cognito App client so logins from rdistaging.com work (see docs/COGNITO-RDISTAGING.md).

export const STAGING_CONFIG = {
  environment: 'staging' as const,
  apiGatewayUrl: 'https://13lmrbq5yj.execute-api.us-east-1.amazonaws.com/production',
  awsRegion: 'us-east-1',
  cognitoUserPoolId: 'us-east-1_bUbIAgvZs',
  cognitoClientId: '5ok2o6fih5b9tani9lfnmeq09b',
  cognitoDomain: '',     // From same App client: Hosted UI domain, e.g. rdi-staging-xxxx.auth.us-east-1.amazoncognito.com
  redirectSignIn: 'https://rdistaging.com/auth/callback',
  redirectSignOut: 'https://rdistaging.com',
};

export default STAGING_CONFIG;
