import { Box, Container, Typography } from '@mui/material'

const FEATURES = [
  {
    id: 'console',
    title: 'One console for your fleet',
    description:
      'Organize field nodes and connections in a single workspace. Open what you need, keep the rest tidy, and move between aircraft without juggling separate tools.',
    image: '/landing/ops.jpg',
    alt: 'Aircraft on a remote operations site',
  },
  {
    id: 'presence',
    title: 'Live presence when it matters',
    description:
      'When a connection is open, you have live video and control for that session — built for operators who need to be there, not just watch a recording later.',
    image: '/landing/presence.jpg',
    alt: 'Drone in flight against open sky',
  },
  {
    id: 'secure',
    title: 'Secure access by design',
    description:
      'Sign-in with multi-factor authentication and account protections suited to operational use. Your console stays yours — shared only when you choose.',
    image: '/landing/secure.jpg',
    alt: 'Abstract network and earth from orbit',
  },
]

export function LandingFeatures() {
  return (
    <Box id="features" component="section" sx={{ py: { xs: 8, md: 10 }, px: 2, scrollMarginTop: 80 }}>
      <Container maxWidth="lg">
        <Box sx={{ textAlign: 'center', mb: { xs: 5, md: 7 }, maxWidth: 720, mx: 'auto' }}>
          <Typography
            variant="h2"
            sx={{
              fontFamily: '"Space Grotesk", sans-serif',
              fontWeight: 700,
              fontSize: { xs: '1.75rem', md: '2rem' },
              color: 'text.primary',
              mb: 1.25,
            }}
          >
            Built for remote operators
          </Typography>
          <Typography sx={{ color: 'text.secondary', fontSize: { xs: '1.05rem', md: '1.15rem' }, lineHeight: 1.65 }}>
            High-level tools for reaching aircraft beyond the local horizon — without drowning in setup noise.
          </Typography>
        </Box>

        {FEATURES.map((feature, index) => {
          const reverse = index % 2 === 1
          return (
            <Box
              key={feature.id}
              sx={{
                display: 'grid',
                gridTemplateColumns: { xs: '1fr', md: reverse ? '1.25fr 1fr' : '1fr 1.25fr' },
                gap: { xs: 3, md: 5 },
                alignItems: 'center',
                mb: index === FEATURES.length - 1 ? 0 : { xs: 6, md: 8 },
              }}
            >
              <Box sx={{ order: { xs: 1, md: reverse ? 2 : 1 } }}>
                <Typography
                  sx={{
                    fontFamily: '"Space Grotesk", sans-serif',
                    fontWeight: 700,
                    fontSize: { xs: '1.2rem', md: '1.4rem' },
                    color: 'text.primary',
                    mb: 1.25,
                  }}
                >
                  {feature.title}
                </Typography>
                <Typography sx={{ color: 'text.secondary', lineHeight: 1.7, fontSize: { xs: '0.98rem', md: '1.05rem' } }}>
                  {feature.description}
                </Typography>
              </Box>
              <Box
                sx={{
                  order: { xs: 2, md: reverse ? 1 : 2 },
                  border: '1px solid',
                  borderColor: 'divider',
                  overflow: 'hidden',
                  bgcolor: 'grey.900',
                }}
              >
                <Box
                  component="img"
                  src={feature.image}
                  alt={feature.alt}
                  loading="lazy"
                  sx={{
                    display: 'block',
                    width: '100%',
                    height: 'auto',
                    maxHeight: { xs: 280, md: 360 },
                    objectFit: 'cover',
                    transition: 'transform 0.6s ease',
                    '&:hover': { transform: 'scale(1.03)' },
                  }}
                />
              </Box>
            </Box>
          )
        })}
      </Container>
    </Box>
  )
}
