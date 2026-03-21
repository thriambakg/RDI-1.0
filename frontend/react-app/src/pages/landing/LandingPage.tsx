import { useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { getConfig } from '../../config'
import { Landing } from './Landing'
import { AuthModal } from '../../components/auth'

function RedirectToConsole() {
  const navigate = useNavigate()
  useEffect(() => {
    navigate('/console', { replace: true })
  }, [navigate])
  return null
}

export default function LandingPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const authMode = searchParams.get('auth')
  const config = getConfig()
  const hasAuth = Boolean(config.COGNITO_USER_POOL_ID && config.COGNITO_CLIENT_ID)

  const showAuthOverlay = hasAuth && (authMode === 'signin' || authMode === 'signup')

  useEffect(() => {
    if (!showAuthOverlay) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') navigate('/')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [showAuthOverlay, navigate])

  const handleClose = () => navigate('/')

  return (
    <>
      <Landing />
      {showAuthOverlay && (
        <AuthModal
          initialState={authMode === 'signup' ? 'signUp' : 'signIn'}
          onClose={handleClose}
        >
          <RedirectToConsole />
        </AuthModal>
      )}
    </>
  )
}
