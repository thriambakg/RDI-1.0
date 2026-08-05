import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { IconButton, Menu, MenuItem, ListItemIcon, ListItemText } from '@mui/material'
import AccountCircleOutlinedIcon from '@mui/icons-material/AccountCircleOutlined'
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined'
import LogoutOutlinedIcon from '@mui/icons-material/LogoutOutlined'
import { useAuth } from '../../contexts/AuthContext'

type UserAccountMenuProps = {
  /** When on settings, hide redundant "Settings" or mark active — optional */
  dense?: boolean
}

export function UserAccountMenu(_props: UserAccountMenuProps) {
  const navigate = useNavigate()
  const { logout } = useAuth()
  const [anchor, setAnchor] = useState<null | HTMLElement>(null)
  const open = Boolean(anchor)

  const handleSignOut = async () => {
    setAnchor(null)
    await logout()
    navigate('/')
  }

  return (
    <>
      <IconButton
        aria-label="Account menu"
        aria-controls={open ? 'user-account-menu' : undefined}
        aria-haspopup="true"
        aria-expanded={open ? 'true' : undefined}
        onClick={(e) => setAnchor(e.currentTarget)}
        disableRipple
        sx={{
          color: '#94a3b8',
          border: '1px solid #334155',
          borderRadius: '0.5rem',
          width: 40,
          height: 40,
          '&:hover': { color: '#f8fafc', borderColor: '#475569', backgroundColor: 'rgba(148,163,184,0.08)' },
        }}
      >
        <AccountCircleOutlinedIcon />
      </IconButton>
      <Menu
        id="user-account-menu"
        anchorEl={anchor}
        open={open}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{
          paper: {
            sx: {
              mt: 1,
              minWidth: 180,
              backgroundColor: '#1e293b',
              border: '1px solid #334155',
              color: '#f8fafc',
              '& .MuiMenuItem-root': {
                fontSize: '0.875rem',
                '&:hover': { backgroundColor: 'rgba(59, 130, 246, 0.12)' },
              },
            },
          },
        }}
      >
        <MenuItem
          onClick={() => {
            setAnchor(null)
            navigate('/console/settings')
          }}
          disableRipple
        >
          <ListItemIcon sx={{ color: '#94a3b8', minWidth: 36 }}>
            <SettingsOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Settings</ListItemText>
        </MenuItem>
        <MenuItem onClick={handleSignOut} disableRipple>
          <ListItemIcon sx={{ color: '#94a3b8', minWidth: 36 }}>
            <LogoutOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Sign out</ListItemText>
        </MenuItem>
      </Menu>
    </>
  )
}
