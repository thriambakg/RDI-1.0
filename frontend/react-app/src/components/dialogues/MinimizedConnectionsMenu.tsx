/**
 * Cosine-style bubble: restore / close minimized connection windows
 * without tearing down WebRTC (close only hides the deck UI).
 */
import { useState } from 'react'
import {
  Badge,
  Box,
  IconButton,
  Menu,
  MenuItem,
  Tooltip,
  Typography,
} from '@mui/material'
import MinimizeIcon from '@mui/icons-material/Minimize'
import CloseIcon from '@mui/icons-material/Close'

export type MinimizedConnectionEntry = {
  sessionId: string
  title: string
  status?: string
}

export type MinimizedConnectionsMenuProps = {
  minimized: MinimizedConnectionEntry[]
  active: MinimizedConnectionEntry[]
  onRestore: (sessionId: string) => void
  onCloseWindow: (sessionId: string) => void
}

export function MinimizedConnectionsMenu({
  minimized,
  active,
  onRestore,
  onCloseWindow,
}: MinimizedConnectionsMenuProps) {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  const open = Boolean(anchorEl)
  const total = minimized.length + active.length

  if (total === 0) return null

  return (
    <Box sx={{ mr: 1 }}>
      <Tooltip
        title={`${total} open connection window${total !== 1 ? 's' : ''}${
          minimized.length ? ` · ${minimized.length} minimized` : ''
        }`}
      >
        <IconButton
          onClick={(e) => setAnchorEl(e.currentTarget)}
          size="small"
          sx={{
            color: minimized.length ? '#38bdf8' : '#94a3b8',
            border: '1px solid',
            borderColor: minimized.length ? '#38bdf8' : '#334155',
            borderRadius: '2px',
            width: 36,
            height: 36,
            '&:hover': {
              backgroundColor: 'rgba(56,189,248,0.12)',
              borderColor: '#38bdf8',
            },
          }}
        >
          <Badge
            badgeContent={minimized.length || total}
            color="primary"
            max={99}
            sx={{
              '& .MuiBadge-badge': {
                fontSize: '0.65rem',
                minWidth: 16,
                height: 16,
                backgroundColor: '#3b82f6',
              },
            }}
          >
            <MinimizeIcon sx={{ fontSize: 18 }} />
          </Badge>
        </IconButton>
      </Tooltip>

      <Menu
        anchorEl={anchorEl}
        open={open}
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        PaperProps={{
          sx: {
            backgroundColor: 'rgba(15, 23, 42, 0.98)',
            border: '1px solid #334155',
            borderRadius: '2px',
            minWidth: 260,
            maxWidth: 360,
            maxHeight: 420,
            mt: 1,
          },
        }}
      >
        {minimized.length > 0 && (
          <>
            <MenuItem disabled sx={{ color: '#64748b', fontSize: '0.7rem', fontWeight: 600, opacity: 1 }}>
              Minimized ({minimized.length})
            </MenuItem>
            {minimized.map((c) => (
              <MenuItem
                key={c.sessionId}
                onClick={() => {
                  onRestore(c.sessionId)
                  setAnchorEl(null)
                }}
                sx={{
                  color: '#f8fafc',
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 1,
                  '&:hover': { backgroundColor: 'rgba(59, 130, 246, 0.12)' },
                }}
              >
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Typography variant="body2" noWrap>
                    {c.title}
                  </Typography>
                  {c.status && (
                    <Typography variant="caption" sx={{ color: '#64748b' }}>
                      {c.status}
                    </Typography>
                  )}
                </Box>
                <IconButton
                  size="small"
                  aria-label="Close window"
                  onClick={(e) => {
                    e.stopPropagation()
                    onCloseWindow(c.sessionId)
                    if (minimized.length <= 1 && active.length === 0) setAnchorEl(null)
                  }}
                  sx={{
                    color: '#f87171',
                    '&:hover': { backgroundColor: 'rgba(248, 113, 113, 0.12)' },
                  }}
                >
                  <CloseIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </MenuItem>
            ))}
            {active.length > 0 && <Box sx={{ borderTop: '1px solid #1e293b', my: 0.5 }} />}
          </>
        )}

        {active.length > 0 && (
          <>
            <MenuItem disabled sx={{ color: '#64748b', fontSize: '0.7rem', fontWeight: 600, opacity: 1 }}>
              Open ({active.length})
            </MenuItem>
            {active.map((c) => (
              <MenuItem
                key={c.sessionId}
                onClick={() => {
                  onRestore(c.sessionId)
                  setAnchorEl(null)
                }}
                sx={{
                  color: '#94a3b8',
                  '&:hover': { backgroundColor: 'rgba(59, 130, 246, 0.08)' },
                }}
              >
                <Typography variant="body2" noWrap sx={{ flex: 1 }}>
                  {c.title}
                </Typography>
                <Typography variant="caption" sx={{ color: '#475569', ml: 1 }}>
                  Visible
                </Typography>
              </MenuItem>
            ))}
          </>
        )}
      </Menu>
    </Box>
  )
}
