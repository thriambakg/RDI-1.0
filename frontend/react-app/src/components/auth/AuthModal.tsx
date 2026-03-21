import { useState, useEffect } from 'react'
import { Box, IconButton } from '@mui/material'
import { Close } from '@mui/icons-material'
import { useAuth } from '../../contexts/AuthContext'
import { LoginForm } from './LoginForm'
import { SignUpForm } from './SignUpForm'
import { VerifyEmailForm } from './VerifyEmailForm'

export interface AuthModalProps {
  children: React.ReactNode
  socialProviders?: ('google' | 'amazon' | 'apple' | 'facebook')[]
  variation?: 'default' | 'modal'
  initialState?: 'signIn' | 'signUp'
  onClose?: () => void
}

type AuthMode = 'signIn' | 'signUp' | 'verify'

/** MUI-based auth modal. Uses aws-amplify/auth - bearer token flow unchanged. */
export function AuthModal({ children, initialState = 'signIn', onClose }: AuthModalProps) {
  const { isAuthenticated } = useAuth()
  const [mode, setMode] = useState<AuthMode>(initialState === 'signUp' ? 'signUp' : 'signIn')
  const [verifyEmail, setVerifyEmail] = useState('')

  useEffect(() => {
    setMode(initialState === 'signUp' ? 'signUp' : 'signIn')
    setVerifyEmail('')
  }, [initialState])

  if (isAuthenticated) {
    return <>{children}</>
  }

  return (
    <Box
      sx={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1300,
        p: 2,
      }}
    >
      <Box
        sx={{
          position: 'absolute',
          inset: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.6)',
          backdropFilter: 'blur(8px)',
        }}
        onClick={onClose}
        aria-hidden
      />
      <Box
        sx={{
          position: 'relative',
          width: '100%',
          maxWidth: 448,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {onClose && (
          <IconButton
            onClick={onClose}
            sx={{
              position: 'absolute',
              top: 16,
              right: 16,
              color: '#94a3b8',
              zIndex: 1,
              '&:hover': { color: '#f8fafc' },
            }}
            aria-label="Close"
          >
            <Close />
          </IconButton>
        )}
        {mode === 'signIn' && (
          <LoginForm onSwitchToSignUp={() => setMode('signUp')} onSuccess={() => {}} />
        )}
        {mode === 'signUp' && (
          <SignUpForm
            onSwitchToSignIn={() => setMode('signIn')}
            onVerificationRequired={(email) => {
              setVerifyEmail(email)
              setMode('verify')
            }}
          />
        )}
        {mode === 'verify' && verifyEmail && (
          <VerifyEmailForm
            email={verifyEmail}
            onSuccess={() => setMode('signIn')}
            onBack={() => setMode('signIn')}
          />
        )}
      </Box>
    </Box>
  )
}
