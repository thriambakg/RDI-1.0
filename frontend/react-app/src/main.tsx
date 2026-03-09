import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { Amplify } from 'aws-amplify'
import { getConfig } from './config'
import './index.css'
import App from './App'

const config = getConfig()
if (config.COGNITO_USER_POOL_ID && config.COGNITO_CLIENT_ID) {
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: config.COGNITO_USER_POOL_ID,
        userPoolClientId: config.COGNITO_CLIENT_ID,
        identityPoolId: undefined,
        loginWith: {
          oauth: {
            domain: `${config.COGNITO_DOMAIN}`,
            scopes: ['email', 'openid', 'profile'],
            redirectSignIn: [config.REDIRECT_SIGN_IN],
            redirectSignOut: [config.REDIRECT_SIGN_OUT],
            responseType: 'code',
          },
        },
        passwordFormat: {
          minLength: 8,
          requireLowercase: true,
          requireUppercase: true,
          requireNumbers: true,
          requireSpecialCharacters: true,
        },
      },
    },
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
