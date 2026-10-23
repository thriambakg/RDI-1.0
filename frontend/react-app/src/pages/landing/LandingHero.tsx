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
        alignItems: 'center',
        pt: { xs: 12, md: 14 },
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
            'linear-gradient(180deg, rgba(15,23,42,0.62) 0%, rgba(15,23,42,0.78) 45%, rgba(15,23,42,0.96) 100%)',
        }}
        aria-hidden
      />

      <Container maxWidth="md" sx={{ position: 'relative', zIndex: 1, textAlign: 'center' }}>
        <Box
          sx={{
            display: 'flex',
            justifyContent: 'center',
            mb: { xs: 2.5, md: 3.5 },
            animation: 'landingFadeUp 0.8s ease both',
          }}
        >
          <Box
            component="img"
            src="/landing/logo.png"
            alt="RDI — Remote Drone Interfaces"
            className="landing-hero__brand"
            sx={{
              height: { xs: 120, sm: 150, md: 180 },
              width: 'auto',
              maxWidth: '100%',
              display: 'block',
            }}
          />
        </Box>

        <Typography
          component="h1"
          sx={{
            fontFamily: '"Space Grotesk", sans-serif',
            fontWeight: 700,
            fontSize: { xs: '1.5rem', sm: '1.85rem', md: '2.15rem' },
            lineHeight: 1.25,
            color: '#f8fafc',
            mb: 1.5,
            mx: 'auto',
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
            mx: 'auto',
            maxWidth: 540,
            animation: 'landingFadeUp 0.8s ease 0.16s both',
          }}
        >
          A secure browser console for live presence and control — wherever your network reaches.
        </Typography>

        {hasAuth ? (
          <Box
            sx={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 1.5,
              justifyContent: 'center',
              animation: 'landingFadeUp 0.8s ease 0.24s both',
            }}
          >
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
