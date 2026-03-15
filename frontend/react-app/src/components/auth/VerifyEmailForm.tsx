import { useState } from 'react'
import { Box, Button, Card, TextField, Typography } from '@mui/material'
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

export function VerifyEmailForm({ email, onSuccess, onBack }: VerifyEmailFormProps) {
  const { verifyEmail } = useAuth()
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
      <Box textAlign="center" sx={{ mb: 4 }}>
        <Typography variant="h5" sx={{ fontWeight: 700, color: '#ffffff', mb: 1, textTransform: 'uppercase' }}>
          Verify your email
        </Typography>
        <Typography variant="body2" sx={{ fontSize: '0.875rem', color: '#94a3b8' }}>
          We sent a verification code to {email}
        </Typography>
      </Box>

      {error && (
        <Typography sx={{ color: '#f87171', fontSize: '0.875rem', mb: 2 }}>{error}</Typography>
      )}

      <Box component="form" onSubmit={handleSubmit} sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <TextField
          fullWidth
          label="Verification code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          required
          autoComplete="one-time-code"
          placeholder="Enter 6-digit code"
          sx={fieldSx}
        />
        <Button type="submit" variant="contained" fullWidth disabled={loading} disableRipple>
          {loading ? 'Verifying...' : 'Verify'}
        </Button>
      </Box>

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
