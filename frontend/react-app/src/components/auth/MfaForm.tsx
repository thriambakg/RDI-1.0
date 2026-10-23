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

interface MfaFormProps {
  onSuccess: () => void
}

export function MfaForm({ onSuccess }: MfaFormProps) {
  const { mfaPending, confirmMfa, cancelMfa } = useAuth()
  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  if (!mfaPending) return null

  const isSetup = mfaPending.kind === 'setup'
  const qrUrl =
    isSetup
      ? `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(mfaPending.setupUri)}`
      : null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const result = await confirmMfa(code)
      if (result.success) {
        onSuccess()
      } else if (result.mfa) {
        setCode('')
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
          {isSetup ? 'Set up authenticator' : 'Authenticator code'}
        </Typography>
        <Typography variant="body2" sx={{ fontSize: '0.875rem', color: '#94a3b8' }}>
          {isSetup
            ? 'Scan with Microsoft Authenticator, Google Authenticator, or any TOTP app. You will need this on every sign-in.'
            : 'Enter the 6-digit code from your authenticator app.'}
        </Typography>
      </Box>

      {isSetup && qrUrl && (
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, mb: 3 }}>
          <Box
            component="img"
            src={qrUrl}
            alt="Authenticator QR code"
            sx={{ width: 220, height: 220, backgroundColor: '#fff', p: 1 }}
          />
          <Typography variant="caption" sx={{ color: '#94a3b8', wordBreak: 'break-all', textAlign: 'center' }}>
            Or enter key manually:{' '}
            <Box component="span" sx={{ color: '#e2e8f0', fontFamily: 'monospace' }}>
              {mfaPending.sharedSecret}
            </Box>
          </Typography>
        </Box>
      )}

      {error && (
        <Typography sx={{ color: '#f87171', fontSize: '0.875rem', mb: 2 }}>{error}</Typography>
      )}

      <Box component="form" onSubmit={handleSubmit} sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <TextField
          fullWidth
          label="6-digit code"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          required
          autoComplete="one-time-code"
          inputMode="numeric"
          sx={fieldSx}
        />
        <Button type="submit" variant="contained" fullWidth disabled={loading || code.length < 6} disableRipple>
          {loading ? 'Verifying...' : isSetup ? 'Verify and continue' : 'Verify'}
        </Button>
        <Button
          type="button"
          variant="text"
          fullWidth
          disabled={loading}
          onClick={() => void cancelMfa()}
          sx={{ color: '#94a3b8' }}
        >
          Cancel
        </Button>
      </Box>
    </Card>
  )
}
