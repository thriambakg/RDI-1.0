import { Link as RouterLink } from 'react-router-dom'
import { Typography } from '@mui/material'
import { UserAccountMenu } from './UserAccountMenu'

type ConsoleChromeHeaderProps = {
  title: string
  /** Show back link to console (settings pages) */
  showBackToConsole?: boolean
}

/** Shared top bar: title + account menu (profile icon). */
export function ConsoleChromeHeader({ title, showBackToConsole = false }: ConsoleChromeHeaderProps) {
  return (
    <header className="console-header">
      {showBackToConsole ? (
        <Typography
          component={RouterLink}
          to="/console"
          variant="body2"
          sx={{
            color: '#94a3b8',
            textDecoration: 'none',
            mr: 1,
            '&:hover': { color: '#3b82f6' },
            display: { xs: 'none', sm: 'block' },
          }}
        >
          ← Console
        </Typography>
      ) : null}
      <Typography variant="h6" component="h1" sx={{ flex: 1, margin: 0, color: '#f8fafc' }}>
        {title}
      </Typography>
      <UserAccountMenu />
    </header>
  )
}
