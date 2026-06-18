import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ThemeProvider } from '@mui/material/styles'
import CssBaseline from '@mui/material/CssBaseline'
import { Amplify } from 'aws-amplify'
import { getConfig } from './config'
import { rdiTheme } from './theme'
import { AuthProvider } from './contexts/AuthContext'
import { ProfileProvider } from './contexts/ProfileContext'
import { SessionWebSocketProvider } from './contexts/SessionWebSocketContext'
import { SessionWebRtcProvider } from './contexts/SessionWebRtcContext'
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
    <ThemeProvider theme={rdiTheme}>
      <CssBaseline />
      <AuthProvider>
        <ProfileProvider>
          <SessionWebSocketProvider>
            <SessionWebRtcProvider>
              <BrowserRouter>
                <App />
              </BrowserRouter>
            </SessionWebRtcProvider>
          </SessionWebSocketProvider>
        </ProfileProvider>
      </AuthProvider>
    </ThemeProvider>
  </StrictMode>,
)
