import { Routes, Route, Navigate } from 'react-router-dom'
import '@aws-amplify/ui-react/styles.css'
import Landing from './pages/Landing'
import Console from './pages/Console'
import { AuthWrapper } from './components/AuthWrapper'
import { getConfig } from './config'

export default function App() {
  const config = getConfig()
  const hasAuth = Boolean(config.COGNITO_USER_POOL_ID && config.COGNITO_CLIENT_ID)
  const socialProviders = config.ENABLE_GOOGLE_AUTH ? (['google'] as const) : []

  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route
        path="/auth/callback"
        element={
          hasAuth ? (
            <AuthWrapper socialProviders={socialProviders} variation="modal">
              <Console />
            </AuthWrapper>
          ) : (
            <Navigate to="/" replace />
          )
        }
      />
      <Route
        path="/console"
        element={
          hasAuth ? (
            <AuthWrapper socialProviders={socialProviders} variation="modal">
              <Console />
            </AuthWrapper>
          ) : (
            <Navigate to="/" replace />
          )
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
