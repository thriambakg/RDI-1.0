import { Link } from 'react-router-dom'
import { Box, Button, Container, Typography } from '@mui/material'

export function LandingFooter() {
  return (
    <Box
      component="footer"
      sx={{ py: 4, px: 2, borderTop: 1, borderColor: 'divider' }}
    >
      <Container maxWidth="lg">
        <Box
          sx={{
            display: 'flex',
            flexDirection: { xs: 'column', md: 'row' },
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 2,
          }}
        >
          <Typography variant="body2" color="text.secondary">
            © {new Date().getFullYear()} RDI. All rights reserved.
          </Typography>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Button component={Link} to="/" size="small" color="inherit" sx={{ textTransform: 'none' }}>
              Privacy
            </Button>
            <Button component={Link} to="/" size="small" color="inherit" sx={{ textTransform: 'none' }}>
              Terms
            </Button>
          </Box>
        </Box>
      </Container>
    </Box>
  )
}
