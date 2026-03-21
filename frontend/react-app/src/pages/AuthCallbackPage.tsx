import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Box, Typography, CircularProgress } from '@mui/material'
import { useAuth } from '../contexts/AuthContext'

/** Handles OAuth redirect from Cognito. Amplify processes the callback automatically. */
export default function AuthCallbackPage() {
  const navigate = useNavigate()
  const { isAuthenticated, isLoading } = useAuth()
  const fallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (isAuthenticated) {
      navigate('/console', { replace: true })
      return
    }
    if (!isLoading) {
      fallbackRef.current = setTimeout(() => {
        navigate('/?auth=signin', { replace: true })
      }, 2500)
    }
    return () => {
      if (fallbackRef.current != null) clearTimeout(fallbackRef.current)
    }
  }, [isAuthenticated, isLoading, navigate])

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', gap: 2 }}>
      <CircularProgress sx={{ color: '#3b82f6' }} />
      <Typography sx={{ color: '#94a3b8' }}>Completing sign in...</Typography>
    </Box>
  )
}
