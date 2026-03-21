import { useState } from 'react'
import { Box, Button, Card, Divider, TextField, Typography } from '@mui/material'
import { useAuth } from '../../contexts/AuthContext'
import { getConfig } from '../../config'
import { GoogleIcon } from './GoogleIcon'

const fieldSx = {
  '& .MuiOutlinedInput-root': {
    backgroundColor: 'rgba(15, 23, 42, 0.9)',
    color: '#f8fafc',
    '& fieldset': { borderColor: '#334155' },
    '&:hover fieldset': { borderColor: '#475569' },
    '&.Mui-focused fieldset': { borderColor: '#3b82f6' },
  },
  '& .MuiInputLabel-root': { color: '#94a3b8' },
}

interface LoginFormProps {
  onSwitchToSignUp: () => void
  onSuccess: () => void
}

export function LoginForm({ onSwitchToSignUp, onSuccess }: LoginFormProps) {
  const { login, loginWithProvider } = useAuth()
  const config = getConfig()
  const hasGoogle = config.COGNITO_USER_POOL_ID && config.COGNITO_CLIENT_ID

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const result = await login(email, password)
      if (result.success) {
        onSuccess()
      } else {
        setError(result.error || 'Login failed')
      }
    } catch {
      setError('Login failed')
    } finally {
      setLoading(false)
    }
  }

  const handleGoogle = async () => {
    setError('')
    setLoading(true)
    try {
      await loginWithProvider('Google')
    } catch {
      setError('Google sign-in failed')
      setLoading(false)
    }
  }

  return (
    <Card
      sx={{
        maxWidth: 448,
        width: '100%',
        p: 4,
        backgroundColor: 'rgba(15, 23, 42, 0.95)',
        borderRadius: 0,
        boxShadow: '0 25px 50px -12px rgb(0 0 0 / 0.5)',
        border: '2px solid #334155',
        backdropFilter: 'blur(16px)',
      }}
    >
      <Box textAlign="center" sx={{ mb: 4 }}>
        <Typography variant="h5" sx={{ fontWeight: 700, color: '#ffffff', mb: 1, textTransform: 'uppercase' }}>
          Sign in
        </Typography>
        <Typography variant="body2" sx={{ fontSize: '0.875rem', color: '#94a3b8' }}>
          Choose your preferred sign-in method
        </Typography>
      </Box>

      {error && (
        <Typography sx={{ color: '#f87171', fontSize: '0.875rem', mb: 2 }}>{error}</Typography>
      )}

      {hasGoogle && (
        <>
          <Button
            fullWidth
            variant="outlined"
            onClick={handleGoogle}
            disabled={loading}
            disableRipple
            sx={{
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              py: 1.5,
              border: '2px solid #334155',
              borderRadius: 0,
              backgroundColor: 'rgba(15, 23, 42, 0.8)',
              fontSize: '0.875rem',
              fontWeight: 600,
              color: '#f8fafc',
              textTransform: 'uppercase',
              '&:hover': {
                backgroundColor: 'rgba(59, 130, 246, 0.15)',
                borderColor: '#3b82f6',
                color: '#93c5fd',
              },
            }}
          >
            <GoogleIcon size={20} />
            Continue with Google
          </Button>

          <Box sx={{ position: 'relative', my: 3 }}>
            <Divider sx={{ borderColor: '#334155' }} />
            <Typography
              variant="body2"
              sx={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                backgroundColor: 'rgba(15, 23, 42, 0.95)',
                px: 2,
                color: '#94a3b8',
                fontSize: '0.875rem',
              }}
            >
              Or continue with email
            </Typography>
          </Box>
        </>
      )}

      <Box component="form" onSubmit={handleSubmit} sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <TextField
          fullWidth
          label="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="email"
          sx={fieldSx}
        />
        <TextField
          fullWidth
          label="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoComplete="current-password"
          sx={fieldSx}
        />
        <Button type="submit" variant="contained" fullWidth disabled={loading} disableRipple>
          {loading ? 'Signing in...' : 'Sign in with Email'}
        </Button>
      </Box>

      <Box textAlign="center" sx={{ mt: 3 }}>
        <Typography sx={{ color: '#94a3b8', fontSize: '0.875rem' }}>
          Don&apos;t have an account?{' '}
          <Typography
            component="button"
            type="button"
            onClick={onSwitchToSignUp}
            sx={{
              fontWeight: 600,
              color: '#3b82f6',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              textDecoration: 'underline',
              '&:hover': { color: '#93c5fd' },
            }}
          >
            Sign up
          </Typography>
        </Typography>
      </Box>
    </Card>
  )
}
