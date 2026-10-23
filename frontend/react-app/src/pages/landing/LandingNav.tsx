import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Box, Button, Collapse, Container, IconButton } from '@mui/material'
import MenuIcon from '@mui/icons-material/Menu'
import CloseIcon from '@mui/icons-material/Close'

interface LandingNavProps {
  hasAuth: boolean
}

function scrollTo(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' })
}

export function LandingNav({ hasAuth }: LandingNavProps) {
  const [open, setOpen] = useState(false)

  return (
    <Box
      component="nav"
      className="landing-nav"
      sx={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 50,
        bgcolor: 'rgba(15, 23, 42, 0.92)',
        backdropFilter: 'blur(10px)',
        borderBottom: '1px solid',
        borderColor: 'divider',
      }}
    >
      <Container maxWidth="lg" disableGutters sx={{ px: { xs: 2, md: 3 }, py: 1.25 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Link to="/" className="nav-brand" aria-label="RDI home">
            RDI
          </Link>

          <Box sx={{ display: { xs: 'none', md: 'flex' }, alignItems: 'center', gap: 1 }}>
            <Button color="inherit" onClick={() => scrollTo('features')} sx={{ textTransform: 'none', fontWeight: 600 }}>
              Features
            </Button>
            <Button color="inherit" onClick={() => scrollTo('faq')} sx={{ textTransform: 'none', fontWeight: 600 }}>
              FAQ
            </Button>
            {hasAuth && (
              <>
                <Button component={Link} to="/?auth=signin" color="inherit" sx={{ textTransform: 'none', fontWeight: 600 }}>
                  Sign In
                </Button>
                <Button
                  component={Link}
                  to="/?auth=signup"
                  variant="contained"
                  sx={{
                    textTransform: 'none',
                    fontWeight: 600,
                    borderRadius: 0,
                    boxShadow: 'none',
                    px: 2.5,
                    '&:hover': { boxShadow: 'none' },
                  }}
                >
                  Get Started
                </Button>
              </>
            )}
          </Box>

          <IconButton
            color="inherit"
            sx={{ display: { md: 'none' } }}
            onClick={() => setOpen((v) => !v)}
            aria-label="Toggle menu"
          >
            {open ? <CloseIcon /> : <MenuIcon />}
          </IconButton>
        </Box>
      </Container>

      <Collapse in={open} sx={{ display: { md: 'none' } }}>
        <Box sx={{ px: 2, pb: 2, display: 'flex', flexDirection: 'column', gap: 1 }}>
          <Button color="inherit" fullWidth onClick={() => { scrollTo('features'); setOpen(false) }}>
            Features
          </Button>
          <Button color="inherit" fullWidth onClick={() => { scrollTo('faq'); setOpen(false) }}>
            FAQ
          </Button>
          {hasAuth && (
            <>
              <Button component={Link} to="/?auth=signin" color="inherit" fullWidth onClick={() => setOpen(false)}>
                Sign In
              </Button>
              <Button
                component={Link}
                to="/?auth=signup"
                variant="contained"
                fullWidth
                onClick={() => setOpen(false)}
                sx={{ borderRadius: 0, boxShadow: 'none', '&:hover': { boxShadow: 'none' } }}
              >
                Get Started
              </Button>
            </>
          )}
        </Box>
      </Collapse>
    </Box>
  )
}
