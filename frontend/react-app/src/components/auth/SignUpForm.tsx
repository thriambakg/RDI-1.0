import { useState } from 'react'
import { Box, Button, Card, Divider, LinearProgress, TextField, Typography } from '@mui/material'
import { Check, Clear } from '@mui/icons-material'
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

function getPasswordStrength(password: string) {
  if (!password)
    return { score: 0, level: '', color: '', requirements: [] as { text: string; met: boolean }[] }

  const requirements = [
    { text: 'At least 8 characters', met: password.length >= 8 },
    { text: 'Contains uppercase letter', met: /[A-Z]/.test(password) },
    { text: 'Contains lowercase letter', met: /[a-z]/.test(password) },
    { text: 'Contains number', met: /\d/.test(password) },
    { text: 'Contains special character', met: /[!@#$%^&*(),.?":{}|<>]/.test(password) },
  ]

  let score = 0
  requirements.forEach((req) => {
    if (req.met) score += 20
  })

  let level = ''
  let color = ''
  if (score === 0) {
    level = ''
    color = '#9ca3af'
  } else if (score <= 40) {
    level = 'Weak'
    color = '#ef4444'
  } else if (score <= 60) {
    level = 'Fair'
    color = '#f59e0b'
  } else if (score <= 80) {
    level = 'Good'
    color = '#3b82f6'
  } else {
    level = 'Strong'
    color = '#10b981'
  }

  return { score, level, color, requirements }
}

interface SignUpFormProps {
  onSwitchToSignIn: () => void
  onVerificationRequired: (email: string) => void
}

export function SignUpForm({ onSwitchToSignIn, onVerificationRequired }: SignUpFormProps) {
  const { register, loginWithProvider } = useAuth()
  const config = getConfig()
  const hasGoogle = config.COGNITO_USER_POOL_ID && config.COGNITO_CLIENT_ID

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const passwordStrength = getPasswordStrength(password)
  const canSignUp = passwordStrength.score >= 60 && password === confirm

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (password !== confirm) {
      setError('Passwords do not match')
      return
    }
    if (passwordStrength.score < 60) {
      setError('Password must meet minimum strength (Fair or better)')
      return
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }
    setLoading(true)
    try {
      const result = await register(email, password)
      if (result.success) {
        if (result.verificationRequired) {
          onVerificationRequired(email)
        } else {
          onSwitchToSignIn()
        }
      } else {
        setError(result.error || 'Sign up failed')
      }
    } catch {
      setError('Sign up failed')
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
          Create account
        </Typography>
        <Typography variant="body2" sx={{ fontSize: '0.875rem', color: '#94a3b8' }}>
          Choose your preferred sign-up method
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
        <Box>
          <TextField
            fullWidth
            label="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="new-password"
            sx={fieldSx}
          />
          {password && (
            <Box sx={{ mt: 1, mb: 0 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                <LinearProgress
                  variant="determinate"
                  value={passwordStrength.score}
                  sx={{
                    flex: 1,
                    height: 6,
                    borderRadius: 0,
                    backgroundColor: '#374151',
                    '& .MuiLinearProgress-bar': {
                      backgroundColor: passwordStrength.color,
                      borderRadius: 0,
                    },
                  }}
                />
                {passwordStrength.level && (
                  <Typography
                    variant="caption"
                    sx={{
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      color: passwordStrength.color,
                      minWidth: 'fit-content',
                    }}
                  >
                    {passwordStrength.level}
                  </Typography>
                )}
              </Box>
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
                  gap: 0.5,
                  fontSize: '0.75rem',
                }}
              >
                {passwordStrength.requirements.map((req, index) => (
                  <Box
                    key={index}
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 0.5,
                      color: req.met ? '#22c55e' : '#9ca3af',
                    }}
                  >
                    {req.met ? <Check sx={{ fontSize: 12 }} /> : <Clear sx={{ fontSize: 12 }} />}
                    <Typography variant="caption" sx={{ fontSize: '0.75rem' }}>
                      {req.text}
                    </Typography>
                  </Box>
                ))}
              </Box>
            </Box>
          )}
        </Box>
        <TextField
          fullWidth
          label="Confirm password"
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
          autoComplete="new-password"
          sx={fieldSx}
        />
        <Button type="submit" variant="contained" fullWidth disabled={loading || !canSignUp} disableRipple>
          {loading ? 'Creating account...' : 'Sign up with Email'}
        </Button>
      </Box>

      <Box textAlign="center" sx={{ mt: 3 }}>
        <Typography sx={{ color: '#94a3b8', fontSize: '0.875rem' }}>
          Already have an account?{' '}
          <Typography
            component="button"
            type="button"
            onClick={onSwitchToSignIn}
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
            Sign in
          </Typography>
        </Typography>
      </Box>
    </Card>
  )
}
