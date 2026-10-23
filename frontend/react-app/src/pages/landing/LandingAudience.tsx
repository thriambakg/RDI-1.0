import { Box, Container, Typography } from '@mui/material'

const AUDIENCE = [
  {
    title: 'Field operators',
    desc: 'Keep a stable link to aircraft from a mothership or remote site, with a console that stays out of the way when you need to fly.',
  },
  {
    title: 'Remote pilots',
    desc: 'Sign in from the browser, open a connection, and work with live presence — without installing a separate ground-control desktop for every job.',
  },
  {
    title: 'Ops teams',
    desc: 'Share access intentionally, keep accounts protected, and give the right people a clear path into the same operational workspace.',
  },
]

export function LandingAudience() {
  return (
    <Box component="section" sx={{ py: { xs: 8, md: 10 }, px: 2, bgcolor: '#1e293b' }}>
      <Container maxWidth="lg">
        <Box sx={{ textAlign: 'center', mb: 5, maxWidth: 720, mx: 'auto' }}>
          <Typography
            variant="h2"
            sx={{
              fontFamily: '"Space Grotesk", sans-serif',
              fontWeight: 700,
              fontSize: { xs: '1.75rem', md: '2rem' },
              mb: 1.25,
            }}
          >
            Who uses RDI
          </Typography>
          <Typography sx={{ color: 'text.secondary', fontSize: { xs: '1.05rem', md: '1.15rem' }, lineHeight: 1.65 }}>
            Built for people who need to reach aircraft over distance — and stay in control when they do.
          </Typography>
        </Box>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', md: 'repeat(3, 1fr)' },
            gap: 3,
          }}
        >
          {AUDIENCE.map((item) => (
            <Box
              key={item.title}
              sx={{
                p: 3,
                border: '1px solid',
                borderColor: 'divider',
                bgcolor: '#0f172a',
              }}
            >
              <Typography
                sx={{
                  fontFamily: '"Space Grotesk", sans-serif',
                  fontWeight: 700,
                  fontSize: '1.125rem',
                  mb: 1,
                }}
              >
                {item.title}
              </Typography>
              <Typography sx={{ color: 'text.secondary', lineHeight: 1.65, fontSize: '1rem' }}>
                {item.desc}
              </Typography>
            </Box>
          ))}
        </Box>
      </Container>
    </Box>
  )
}
