#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const getArg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : '';
};

const config = {
  AWS_REGION: getArg('--aws-region') || 'us-east-1',
  COGNITO_USER_POOL_ID: getArg('--cognito-user-pool-id'),
  COGNITO_CLIENT_ID: getArg('--cognito-client-id'),
  COGNITO_DOMAIN: getArg('--cognito-domain'),
  REDIRECT_SIGN_IN: getArg('--redirect-sign-in') || 'http://localhost:5173/auth/callback',
  REDIRECT_SIGN_OUT: getArg('--redirect-sign-out') || 'http://localhost:5173',
  API_GATEWAY_URL: getArg('--api-gateway-url') || '',
  WEBSOCKET_URL: getArg('--websocket-url') || '',
  ENVIRONMENT: getArg('--environment') || 'staging',
};

const outPath = getArg('--output') || 'public/config.js';
const dir = path.dirname(outPath);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const content = `window.__RDI_CONFIG__ = ${JSON.stringify(config, null, 2)};
`;
fs.writeFileSync(outPath, content);
console.log('Generated', outPath);
