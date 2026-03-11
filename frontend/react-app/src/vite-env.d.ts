/// <reference types="vite/client" />

interface RDIConfig {
  AWS_REGION: string;
  COGNITO_USER_POOL_ID: string;
  COGNITO_CLIENT_ID: string;
  COGNITO_DOMAIN: string;
  REDIRECT_SIGN_IN: string;
  REDIRECT_SIGN_OUT: string;
  API_GATEWAY_URL: string;
  WEBSOCKET_URL: string;
  ENVIRONMENT: string;
  ENABLE_GOOGLE_AUTH?: boolean;
}

interface Window {
  __RDI_CONFIG__?: RDIConfig;
}
