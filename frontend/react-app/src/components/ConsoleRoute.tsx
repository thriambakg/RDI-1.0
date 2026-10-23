import { useEffect } from 'react'
import { Outlet, useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'

interface ConsoleRouteProps {
  socialProviders?: ('google' | 'amazon' | 'apple' | 'facebook')[]
}

/**
 * Protects /console/*: requires Cognito session + MFA gate (email Cognito TOTP or Google app TOTP).
 */
export function ConsoleRoute(_props: ConsoleRouteProps) {
  const navigate = useNavigate()
  const { canAccessApp, isLoading, mfaPending } = useAuth()

  useEffect(() => {
    if (isLoading) return
    if (mfaPending || !canAccessApp) {
      navigate('/?auth=signin', { replace: true })
    }
  }, [isLoading, canAccessApp, mfaPending, navigate])

  if (isLoading) return null
  if (!canAccessApp) return null

  return <Outlet />
}
