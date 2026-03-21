import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import Console from '../pages/console'

interface ConsoleRouteProps {
  socialProviders?: ('google' | 'amazon' | 'apple' | 'facebook')[]
}

/**
 * Protects /console: unauthenticated users are redirected to /?auth=signin
 */
export function ConsoleRoute(_props: ConsoleRouteProps) {
  const navigate = useNavigate()
  const { isAuthenticated, isLoading } = useAuth()

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      navigate('/?auth=signin', { replace: true })
    }
  }, [isLoading, isAuthenticated, navigate])

  if (isLoading) return null
  if (!isAuthenticated) return null

  return <Console />
}
