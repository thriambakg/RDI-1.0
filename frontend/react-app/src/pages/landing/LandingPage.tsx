import React, { useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { getConfig } from '../../config'
import { Landing } from './Landing'
import { AuthModal } from '../../components/authmodals'

/** Shows auth modal over landing when ?auth=signin or ?auth=signup (so landing stays visible/blurred behind modal) */
function RedirectToConsole() {
  const navigate = useNavigate()
  React.useEffect(() => {
    navigate('/console', { replace: true })
  }, [navigate])
  return null
}

export default function LandingPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const authMode = searchParams.get('auth') // 'signin' | 'signup'
  const config = getConfig()
  const hasAuth = Boolean(config.COGNITO_USER_POOL_ID && config.COGNITO_CLIENT_ID)
  const socialProviders: ('google' | 'amazon' | 'apple' | 'facebook')[] = hasAuth ? ['google'] : []

  const showAuthOverlay = hasAuth && (authMode === 'signin' || authMode === 'signup')

  useEffect(() => {
    if (!showAuthOverlay) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') navigate('/')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [showAuthOverlay, navigate])

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (!(e.target as HTMLElement).closest('[data-amplify-container]')) {
      navigate('/')
    }
  }

  return (
    <>
      <Landing />
      {showAuthOverlay && (
        <div className="auth-overlay-root" data-rdi-auth-overlay>
          <div className="auth-overlay-backdrop" onClick={handleBackdropClick} aria-hidden="true">
            <AuthModal
            socialProviders={socialProviders}
            variation="modal"
            initialState={authMode === 'signup' ? 'signUp' : 'signIn'}
          >
            <RedirectToConsole />
          </AuthModal>
          </div>
        </div>
      )}
    </>
  )
}
