import { Link } from 'react-router-dom'
import { Box, Button, Container, Typography } from '@mui/material'
import ArrowForwardIcon from '@mui/icons-material/ArrowForward'

interface LandingHeroProps {
  hasAuth: boolean
}

export function LandingHero({ hasAuth }: LandingHeroProps) {
  return (
    <Box
      component="section"
      className="landing-hero"
      sx={{
        position: 'relative',
        minHeight: { xs: '100svh', md: '100vh' },
        display: 'flex',
        alignItems: 'flex-end',
        pt: { xs: 10, md: 12 },
        pb: { xs: 6, md: 10 },
        overflow: 'hidden',
      }}
    >
      <Box
        className="landing-hero__media"
        sx={{
          position: 'absolute',
          inset: 0,
          backgroundImage: 'url(/landing/hero.jpg)',
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          transform: 'scale(1.02)',
          animation: 'landingHeroDrift 28s ease-in-out infinite alternate',
        }}
        aria-hidden
      />
      <Box
        sx={{
          position: 'absolute',
          inset: 0,
          background:
            'linear-gradient(180deg, rgba(15,23,42,0.55) 0%, rgba(15,23,42,0.72) 45%, rgba(15,23,42,0.96) 100%)',
        }}
        aria-hidden
      />

      <Container maxWidth="md" sx={{ position: 'relative', zIndex: 1 }}>
        <Typography
          className="landing-hero__brand"
          component="p"
          sx={{
            fontFamily: '"Space Grotesk", sans-serif',
            fontWeight: 700,
            letterSpacing: '0.12em',
            fontSize: { xs: '2.75rem', sm: '3.5rem', md: '4.25rem' },
            lineHeight: 1,
            color: '#f8fafc',
            mb: 2,
            animation: 'landingFadeUp 0.8s ease both',
          }}
        >
          RDI
        </Typography>
        <Typography
          component="h1"
          sx={{
            fontFamily: '"Space Grotesk", sans-serif',
            fontWeight: 700,
            fontSize: { xs: '1.5rem', sm: '1.85rem', md: '2.15rem' },
            lineHeight: 1.25,
            color: '#f8fafc',
            mb: 1.5,
            maxWidth: 640,
            animation: 'landingFadeUp 0.8s ease 0.08s both',
          }}
        >
          Remote operations for the aircraft you fly
        </Typography>
        <Typography
          sx={{
            color: 'text.secondary',
            fontSize: { xs: '1.05rem', md: '1.2rem' },
            lineHeight: 1.65,
            mb: 3.5,
            maxWidth: 540,
            animation: 'landingFadeUp 0.8s ease 0.16s both',
          }}
        >
          A secure browser console for live presence and control — wherever your network reaches.
        </Typography>

        {hasAuth ? (
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5, animation: 'landingFadeUp 0.8s ease 0.24s both' }}>
            <Button
              component={Link}
              to="/?auth=signup"
              variant="contained"
              size="large"
              endIcon={<ArrowForwardIcon />}
              sx={{
                textTransform: 'none',
                fontWeight: 600,
                borderRadius: 0,
                boxShadow: 'none',
                px: 3,
                py: 1.35,
                '&:hover': { boxShadow: 'none' },
              }}
            >
              Get Started
            </Button>
            <Button
              component={Link}
              to="/?auth=signin"
              variant="outlined"
              size="large"
              sx={{
                textTransform: 'none',
                fontWeight: 600,
                borderRadius: 0,
                borderColor: 'rgba(248,250,252,0.35)',
                color: '#f8fafc',
                px: 3,
                py: 1.35,
                '&:hover': { borderColor: '#f8fafc', bgcolor: 'rgba(248,250,252,0.06)' },
              }}
            >
              Sign In
            </Button>
          </Box>
        ) : (
          <Typography color="text.secondary" sx={{ fontSize: '0.95rem' }}>
            Auth is not configured for this build.
          </Typography>
        )}
      </Container>
    </Box>
  )
}
