import { useState } from 'react'
import { Box, Button, Collapse, Container, Typography } from '@mui/material'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'

const FAQ_ITEMS = [
  {
    q: 'What is RDI?',
    a: 'RDI (Remote Drone Infrastructure) is a browser-based console for remote aircraft operations. Sign in, open a connection to your field equipment, and work with live presence and control from wherever you have network access.',
  },
  {
    q: 'Do I need special desktop software to fly?',
    a: 'The operator experience is in the browser. You create an account, sign in, and use the console. Field gear runs on your side of the link — the console is how you reach it.',
  },
  {
    q: 'How is access protected?',
    a: 'Accounts use multi-factor authentication, and RDI is designed so an open connection stays with the operator who is signed in. Share access only when you intend to.',
  },
  {
    q: 'Who is this for?',
    a: 'Operators and teams who need human-in-the-loop remote control beyond a local radio horizon — mothership, relay, or distributed field setups — without locking into a closed single-vendor app.',
  },
]

export function LandingFaq() {
  const [open, setOpen] = useState<number | null>(null)

  return (
    <Box id="faq" component="section" sx={{ py: { xs: 8, md: 10 }, px: 2, scrollMarginTop: 80 }}>
      <Container maxWidth="md">
        <Box sx={{ textAlign: 'center', mb: 5 }}>
          <Typography
            variant="h2"
            sx={{
              fontFamily: '"Space Grotesk", sans-serif',
              fontWeight: 700,
              fontSize: { xs: '1.75rem', md: '2rem' },
            }}
          >
            Frequently asked questions
          </Typography>
        </Box>
        {FAQ_ITEMS.map((item, i) => (
          <Box key={item.q} sx={{ borderBottom: 1, borderColor: 'divider', py: 1.5 }}>
            <Button
              fullWidth
              onClick={() => setOpen(open === i ? null : i)}
              endIcon={
                <ExpandMoreIcon sx={{ transform: open === i ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
              }
              sx={{
                justifyContent: 'space-between',
                textTransform: 'none',
                fontWeight: 600,
                color: 'text.primary',
                fontSize: '1.05rem',
                py: 1.25,
              }}
            >
              {item.q}
            </Button>
            <Collapse in={open === i}>
              <Typography sx={{ color: 'text.secondary', pb: 2, pr: 4, fontSize: '1.02rem', lineHeight: 1.65 }}>
                {item.a}
              </Typography>
            </Collapse>
          </Box>
        ))}
      </Container>
    </Box>
  )
}
