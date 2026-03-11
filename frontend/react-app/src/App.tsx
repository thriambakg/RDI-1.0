import { useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import '@aws-amplify/ui-react/styles.css'
import Landing from './pages/landing'
import Console from './pages/console'
import { AuthModal } from './components/authmodals'
import { ConsoleRoute } from './components/ConsoleRoute'
import { getConfig, getEnvironmentRegions } from './config'

export default function App() {
  const config = getConfig()
  const hasAuth = Boolean(config.COGNITO_USER_POOL_ID && config.COGNITO_CLIENT_ID)
  const socialProviders: ('google' | 'amazon' | 'apple' | 'facebook')[] = hasAuth ? ['google'] : []

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const { environment, regions } = getEnvironmentRegions()
      console.log('[RDI] Environment', {
        environment,
        regions: regions.map((r) => `${r.id} (${r.city})`),
        regionCount: regions.length,
      })
      console.log('[RDI] App config', { hasAuth, socialProviders })
    }
  }, [hasAuth, socialProviders])

  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route
        path="/auth/callback"
        element={
          hasAuth ? (
            <AuthModal socialProviders={socialProviders} variation="modal">
              <Console />
            </AuthModal>
          ) : (
            <Navigate to="/" replace />
          )
        }
      />
      <Route
        path="/console"
        element={
          hasAuth ? (
            <ConsoleRoute socialProviders={socialProviders} />
          ) : (
            <Navigate to="/" replace />
          )
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
