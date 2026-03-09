import { Routes, Route, Navigate } from 'react-router-dom'
import { Authenticator } from '@aws-amplify/ui-react'
import '@aws-amplify/ui-react/styles.css'
import Landing from './pages/Landing'
import Console from './pages/Console'
import { getConfig } from './config'

export default function App() {
  const config = getConfig()
  const hasAuth = Boolean(config.COGNITO_USER_POOL_ID && config.COGNITO_CLIENT_ID)

  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route
        path="/auth/callback"
        element={
          hasAuth ? (
            <Authenticator>
              <Console />
            </Authenticator>
          ) : (
            <Navigate to="/" replace />
          )
        }
      />
      <Route
        path="/console"
        element={
          hasAuth ? (
            <Authenticator>
              <Console />
            </Authenticator>
          ) : (
            <Navigate to="/" replace />
          )
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
