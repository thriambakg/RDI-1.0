import { Link } from 'react-router-dom'
import { Box, Button, Container, Typography } from '@mui/material'
import ArrowForwardIcon from '@mui/icons-material/ArrowForward'

export function LandingCta() {
  return (
    <Box component="section" sx={{ py: { xs: 8, md: 10 }, px: 2, bgcolor: '#1e293b' }}>
      <Container maxWidth="sm">
        <Box sx={{ textAlign: 'center' }}>
          <Typography
            variant="h2"
            sx={{
              fontFamily: '"Space Grotesk", sans-serif',
              fontWeight: 700,
              fontSize: { xs: '1.75rem', md: '2rem' },
              mb: 1.25,
            }}
          >
            Ready to begin?
          </Typography>
          <Typography sx={{ color: 'text.secondary', mb: 3.5, fontSize: { xs: '1.05rem', md: '1.15rem' }, lineHeight: 1.65 }}>
            Create your account, confirm your email, and open the console.
          </Typography>
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
            Start free
          </Button>
        </Box>
      </Container>
    </Box>
  )
}
