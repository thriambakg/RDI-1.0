import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getCurrentUser } from 'aws-amplify/auth'
import { AuthModal } from './authmodals'
import Console from '../pages/console'

interface ConsoleRouteProps {
  socialProviders: ('google' | 'amazon' | 'apple' | 'facebook')[]
}

/**
 * Protects /console: unauthenticated users are redirected to /?auth=signin
 * so they get the blurred landing + auth modal experience, not the standalone auth page.
 */
export function ConsoleRoute({ socialProviders }: ConsoleRouteProps) {
  const navigate = useNavigate()
  const [checked, setChecked] = useState(false)
  const [authenticated, setAuthenticated] = useState(false)

  useEffect(() => {
    getCurrentUser()
      .then(() => setAuthenticated(true))
      .catch(() => navigate('/?auth=signin', { replace: true }))
      .finally(() => setChecked(true))
  }, [navigate])

  if (!checked || !authenticated) {
    return null
  }

  return (
    <AuthModal socialProviders={socialProviders} variation="modal">
      <Console />
    </AuthModal>
  )
}
