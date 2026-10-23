import { useState } from 'react'
import { Box, Button, Card, Collapse, TextField, Typography } from '@mui/material'
import { useAuth } from '../../contexts/AuthContext'

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

interface VerifyEmailFormProps {
  email: string
  onSuccess: () => void
  onBack: () => void
}

/**
 * After email/password signup, Cognito emails a verification *link*.
 * Primary UX: open email → click Verify Email → return here to sign in.
 * Optional: paste the code from the link URL if the click failed.
 */
export function VerifyEmailForm({ email, onSuccess, onBack }: VerifyEmailFormProps) {
  const { verifyEmail } = useAuth()
  const [showCode, setShowCode] = useState(false)
  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const result = await verifyEmail(email, code)
      if (result.success) {
        onSuccess()
      } else {
        setError(result.error || 'Verification failed')
      }
    } catch {
      setError('Verification failed')
    } finally {
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
      <Box textAlign="center" sx={{ mb: 3 }}>
        <Typography variant="h5" sx={{ fontWeight: 700, color: '#ffffff', mb: 1, textTransform: 'uppercase' }}>
          Check your email
        </Typography>
        <Typography variant="body2" sx={{ fontSize: '0.875rem', color: '#94a3b8', mb: 1 }}>
          We sent a verification link to
        </Typography>
        <Typography sx={{ color: '#e2e8f0', fontWeight: 600, wordBreak: 'break-all' }}>{email}</Typography>
        <Typography variant="body2" sx={{ fontSize: '0.875rem', color: '#94a3b8', mt: 2 }}>
          Open the message and click <strong style={{ color: '#93c5fd' }}>Verify Email</strong>. Then come back
          here and sign in. Check spam if you do not see it within a minute.
        </Typography>
      </Box>

      <Button type="button" variant="contained" fullWidth disableRipple onClick={onSuccess} sx={{ mb: 2 }}>
        I verified — go to sign in
      </Button>

      <Typography
        component="button"
        type="button"
        onClick={() => setShowCode((v) => !v)}
        sx={{
          display: 'block',
          width: '100%',
          textAlign: 'center',
          fontWeight: 600,
          color: '#64748b',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          fontSize: '0.8rem',
          mb: 1,
          '&:hover': { color: '#94a3b8' },
        }}
      >
        {showCode ? 'Hide code entry' : 'Have a code instead?'}
      </Typography>

      <Collapse in={showCode}>
        {error && (
          <Typography sx={{ color: '#f87171', fontSize: '0.875rem', mb: 2 }}>{error}</Typography>
        )}
        <Box component="form" onSubmit={handleSubmit} sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <TextField
            fullWidth
            label="Verification code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="one-time-code"
            placeholder="From the email link URL if needed"
            sx={fieldSx}
          />
          <Button type="submit" variant="outlined" fullWidth disabled={loading || !code.trim()} disableRipple>
            {loading ? 'Verifying...' : 'Verify with code'}
          </Button>
        </Box>
      </Collapse>

      <Box textAlign="center" sx={{ mt: 3 }}>
        <Typography
          component="button"
          type="button"
          onClick={onBack}
          sx={{
            fontWeight: 600,
            color: '#3b82f6',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            textDecoration: 'underline',
            fontSize: '0.875rem',
            '&:hover': { color: '#93c5fd' },
          }}
        >
          ← Back to sign in
        </Typography>
      </Box>
    </Card>
  )
}
