import { useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Box,
  Button,
  Typography,
  FormControl,
  Select,
  MenuItem,
  Menu,
  IconButton,
  Collapse,
  List,
  ListItemButton,
  ListItemText,
  ListItemSecondaryAction,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
} from '@mui/material'
import type { SelectChangeEvent } from '@mui/material'
import { Delete as DeleteIcon, ExpandLess, ExpandMore, Folder, FolderOpen, MoreVert, PauseCircleOutline, PlayArrow } from '@mui/icons-material'
import { useAuth } from '../../contexts/AuthContext'
import { getEnvironmentRegions } from '../../config'
import { CreateConnectionDialog, CreateFolderDialog, ConnectionDetailDialog } from '../../components/dialogues'
import { useProfile } from '../../contexts/ProfileContext'
import {
  deleteFolder,
  removeFolderAtPath,
  removeSessionFromHierarchy,
  addFolderAtPath,
  updateSessionStatusInHierarchy,
  type FolderNode,
  type SessionRef,
  type ConnectionHierarchy,
} from '../../services/profileApi'
import { deleteSession, releaseSession, activateSession } from '../../services/sessionApi'
import type { CreateSessionResponse } from '../../services/sessionApi'
import './Console.css'

const { regions: EDGE_ZONES } = getEnvironmentRegions()

const selectSx = {
  '& .MuiOutlinedInput-root': {
    backgroundColor: '#1e293b',
    color: '#f8fafc',
    '& fieldset': { borderColor: '#334155' },
    '&:hover fieldset': { borderColor: '#475569' },
  },
  '& .MuiSelect-select': { color: '#f8fafc' },
}

function collectSessions(hierarchy: ConnectionHierarchy, folderPath: string[]): SessionRef[] {
  if (folderPath.length === 0) {
    const all: SessionRef[] = []
    const walk = (node: FolderNode) => {
      all.push(...(node.sessions || []))
      Object.values(node.subfolders || {}).forEach(walk)
    }
    Object.values(hierarchy).forEach(walk)
    return all
  }
  let node: FolderNode | undefined = hierarchy[folderPath[0]]
  for (let i = 1; i < folderPath.length && node; i++) {
    node = node.subfolders?.[folderPath[i]]
  }
  return node?.sessions ?? []
}

/** Paths under "Shared" (and Shared itself) are not deletable. */
function isSharedOrUnderShared(path: string[]): boolean {
  return path.length > 0 && path[0] === 'Shared'
}

function FolderTree({
  hierarchy,
  selectedPath,
  onSelect,
  onDeleteRequest,
  pathPrefix,
  depth = 0,
}: {
  hierarchy: ConnectionHierarchy
  selectedPath: string[]
  onSelect: (path: string[]) => void
  onDeleteRequest: (path: string[]) => void
  pathPrefix?: string[]
  depth?: number
}) {
  const prefix = pathPrefix ?? []
  const [open, setOpen] = useState<Record<string, boolean>>(depth === 0 ? { Shared: true } : {})
  const [menuAnchor, setMenuAnchor] = useState<{ path: string[]; el: HTMLElement } | null>(null)
  const indentPx = 20

  return (
    <>
      {Object.entries(hierarchy).map(([name, node]) => {
        const fullPath = [...prefix, name]
        const isSelected = selectedPath.length === fullPath.length && selectedPath.every((p, i) => p === fullPath[i])
        const hasSubfolders = node.subfolders && Object.keys(node.subfolders).length > 0
        const isOpen = open[name] ?? false
        const nonDeletable = isSharedOrUnderShared(fullPath)
        const isMenuOpen = menuAnchor !== null && menuAnchor.path.length === fullPath.length && menuAnchor.path.every((p, i) => p === fullPath[i])
        return (
          <Box key={name} className="folder-tree-item" sx={{ pl: depth * indentPx }}>
            <ListItemButton
              selected={isSelected}
              onClick={() => onSelect(fullPath)}
              className="folder-tree-row"
              sx={{
                py: 0.5,
                borderRadius: '0.25rem',
                minHeight: 36,
                '&.Mui-selected': { backgroundColor: 'rgba(59, 130, 246, 0.2)' },
              }}
            >
              {hasSubfolders ? (
                <IconButton
                  size="small"
                  onClick={(e) => { e.stopPropagation(); setOpen((o) => ({ ...o, [name]: !o[name] })) }}
                  sx={{ mr: 0.5, color: '#94a3b8', p: 0.25 }}
                  aria-label={isOpen ? 'Collapse' : 'Expand'}
                >
                  {isOpen ? <ExpandLess /> : <ExpandMore />}
                </IconButton>
              ) : (
                <Box component="span" sx={{ width: 28, display: 'inline-block', flexShrink: 0 }} />
              )}
              {isOpen ? (
                <FolderOpen sx={{ mr: 0.5, fontSize: 20, color: '#94a3b8', flexShrink: 0 }} />
              ) : (
                <Folder sx={{ mr: 0.5, fontSize: 20, color: '#94a3b8', flexShrink: 0 }} />
              )}
              <ListItemText
                primary={name}
                primaryTypographyProps={{ fontSize: '0.875rem', color: '#e2e8f0' }}
                sx={{ flex: '1 1 auto', minWidth: 0 }}
              />
              {!nonDeletable && (
                <ListItemSecondaryAction>
                  <IconButton
                    size="small"
                    edge="end"
                    onClick={(e) => { e.stopPropagation(); setMenuAnchor({ path: fullPath, el: e.currentTarget }) }}
                    sx={{ color: '#94a3b8' }}
                    aria-label="Folder options"
                  >
                    <MoreVert sx={{ fontSize: 18 }} />
                  </IconButton>
                </ListItemSecondaryAction>
              )}
            </ListItemButton>
            <Menu
              open={isMenuOpen}
              anchorEl={isMenuOpen ? menuAnchor!.el : null}
              onClose={() => setMenuAnchor(null)}
              anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
              transformOrigin={{ vertical: 'top', horizontal: 'right' }}
              PaperProps={{
                sx: {
                  backgroundColor: '#1e293b',
                  border: '1px solid #334155',
                  '& .MuiMenuItem-root': { color: '#e2e8f0' },
                },
              }}
            >
              <MenuItem
                onClick={() => {
                  onDeleteRequest(fullPath)
                  setMenuAnchor(null)
                }}
                sx={{ color: '#f87171' }}
              >
                <DeleteIcon sx={{ fontSize: 18, mr: 1 }} /> Delete
              </MenuItem>
            </Menu>
            {hasSubfolders && (
              <Collapse in={isOpen} unmountOnExit>
                <FolderTree
                  hierarchy={node.subfolders ?? {}}
                  selectedPath={selectedPath}
                  onSelect={onSelect}
                  onDeleteRequest={onDeleteRequest}
                  pathPrefix={fullPath}
                  depth={depth + 1}
                />
              </Collapse>
            )}
          </Box>
        )
      })}
    </>
  )
}

export default function Console() {
  const [selectedZone] = useState(EDGE_ZONES[0] ?? { id: 'use1-wl1-chi-wlz1', city: 'Chicago', country: 'USA', carrier: 'Verizon' })
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [createFolderDialogOpen, setCreateFolderDialogOpen] = useState(false)
  const { hierarchy, isLoading: profileLoading, refetch: fetchProfile, updateHierarchy } = useProfile()
  const [selectedFolderPath, setSelectedFolderPath] = useState<string[]>([])
  const [deleteLoading, setDeleteLoading] = useState<string | null>(null)
  const [connectionMenuAnchor, setConnectionMenuAnchor] = useState<{ sessionId: string; el: HTMLElement } | null>(null)
  const [confirmDeleteConnection, setConfirmDeleteConnection] = useState<string | null>(null)
  const [confirmDeleteFolderPath, setConfirmDeleteFolderPath] = useState<string[] | null>(null)
  const [detailSessionId, setDetailSessionId] = useState<string | null>(null)
  const [detailDialogOpen, setDetailDialogOpen] = useState(false)
  const navigate = useNavigate()
  const { logout } = useAuth()

  const connections = collectSessions(hierarchy, selectedFolderPath)

  const handleConnectionCreated = useCallback(
    (res: CreateSessionResponse) => {
      console.log('[RDI Console] Session created', res)
      fetchProfile()
    },
    [fetchProfile]
  )

  const effectiveParentForNewFolder = selectedFolderPath.length > 0 ? selectedFolderPath : ['My Drones']
  const canCreateFolderUnderSelection = effectiveParentForNewFolder[0] !== 'Shared'
  const effectiveParentForNewConnection = selectedFolderPath.length > 0 ? selectedFolderPath : ['My Drones']
  const canCreateConnectionUnderSelection = effectiveParentForNewConnection[0] !== 'Shared'

  const handleFolderCreated = useCallback(
    (folderName?: string) => {
      if (folderName) {
        updateHierarchy((h) => addFolderAtPath(h, effectiveParentForNewFolder, folderName))
      }
      return fetchProfile({ silent: true })
    },
    [effectiveParentForNewFolder, updateHierarchy, fetchProfile]
  )

  const handleDeleteConnection = async (sessionId: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
    setConfirmDeleteConnection(null)
    setConnectionMenuAnchor(null)
    setDeleteLoading(sessionId)
    if (detailSessionId === sessionId) {
      setDetailSessionId(null)
      setDetailDialogOpen(false)
    }
    updateHierarchy((h) => removeSessionFromHierarchy(h, sessionId))
    try {
      await deleteSession(sessionId, true)
      await fetchProfile({ silent: true })
    } catch (err) {
      console.error('[RDI Console] Delete failed', err)
      await fetchProfile()
    } finally {
      setDeleteLoading(null)
    }
  }

  const handlePauseConnection = async (sessionId: string) => {
    setConnectionMenuAnchor(null)
    setDeleteLoading(sessionId)
    updateHierarchy((h) => updateSessionStatusInHierarchy(h, sessionId, 'idle'))
    try {
      await releaseSession(sessionId)
      await fetchProfile({ silent: true })
    } catch (err) {
      console.error('[RDI Console] Pause failed', err)
      await fetchProfile()
    } finally {
      setDeleteLoading(null)
    }
  }

  const handleActivateConnection = async (sessionId: string) => {
    setConnectionMenuAnchor(null)
    setDeleteLoading(sessionId)
    updateHierarchy((h) => updateSessionStatusInHierarchy(h, sessionId, 'active'))
    try {
      await activateSession(sessionId)
      await fetchProfile({ silent: true })
    } catch (err) {
      console.error('[RDI Console] Activate failed', err)
      await fetchProfile()
    } finally {
      setDeleteLoading(null)
    }
  }

  const handleConfirmDeleteFolder = async () => {
    if (!confirmDeleteFolderPath) return
    const path = confirmDeleteFolderPath
    setConfirmDeleteFolderPath(null)
    const wasSelected =
      selectedFolderPath.length >= path.length &&
      selectedFolderPath.slice(0, path.length).every((p, i) => p === path[i])
    if (wasSelected) setSelectedFolderPath([])
    updateHierarchy((h) => removeFolderAtPath(h, path))
    try {
      await deleteFolder(path)
      await fetchProfile({ silent: true })
    } catch (err) {
      console.error('[RDI Console] Delete folder failed', err)
      await fetchProfile()
    }
  }

  const handleConnectionClick = (sessionId: string) => {
    setDetailSessionId(sessionId)
    setDetailDialogOpen(true)
  }

  const handleSignOut = async () => {
    await logout()
    navigate('/')
  }

  const handleZoneChange = (e: SelectChangeEvent<string>) => {
    const z = EDGE_ZONES.find((x) => x.id === e.target.value)
    if (z) return // keep selectedZone for now
  }

  return (
    <div className="console">
      <header className="console-header">
        <button className="sidebar-toggle" onClick={() => setSidebarOpen((o) => !o)} aria-label="Toggle sidebar">
          <span className="hamburger" />
          <span className="hamburger" />
          <span className="hamburger" />
        </button>
        <Typography variant="h6" component="h1" sx={{ flex: 1, margin: 0, color: '#f8fafc' }}>
          RDI Console
        </Typography>
        <Button onClick={handleSignOut} disableRipple sx={{ color: '#3b82f6', textTransform: 'none' }}>
          Sign Out
        </Button>
      </header>

      <div className={`sidebar-backdrop ${sidebarOpen ? 'open' : ''}`} onClick={() => setSidebarOpen(false)} aria-hidden="true" />

      <div className="console-body">
        <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
          <Typography variant="overline" sx={{ color: '#64748b', display: 'block', mb: 1 }}>
            Edge Location
          </Typography>
          <FormControl fullWidth size="small" sx={selectSx}>
            <Select
              value={selectedZone.id}
              onChange={handleZoneChange}
              MenuProps={{
                PaperProps: {
                  sx: {
                    backgroundColor: '#1e293b',
                    border: '1px solid #334155',
                    '& .MuiMenuItem-root': { color: '#f8fafc' },
                  },
                },
              }}
            >
              {EDGE_ZONES.map((z) => (
                <MenuItem key={z.id} value={z.id} disableRipple>
                  {z.city} ({z.carrier})
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <Typography variant="overline" sx={{ color: '#64748b', display: 'block', mt: 2, mb: 1 }}>
            Folders
          </Typography>
          {profileLoading ? (
            <Typography sx={{ color: '#94a3b8', fontSize: '0.875rem' }}>Loading…</Typography>
          ) : (
            <List dense disablePadding>
              <ListItemButton
                selected={selectedFolderPath.length === 0}
                onClick={() => setSelectedFolderPath([])}
                sx={{
                  py: 0.5,
                  borderRadius: '0.25rem',
                  '&.Mui-selected': { backgroundColor: 'rgba(59, 130, 246, 0.2)' },
                }}
              >
                <ListItemText primary="All" primaryTypographyProps={{ fontSize: '0.875rem', color: '#e2e8f0' }} />
              </ListItemButton>
              <FolderTree
                hierarchy={hierarchy}
                selectedPath={selectedFolderPath}
                onSelect={setSelectedFolderPath}
                onDeleteRequest={setConfirmDeleteFolderPath}
              />
            </List>
          )}
          <Button
            onClick={() => setCreateFolderDialogOpen(true)}
            disabled={!canCreateFolderUnderSelection}
            disableRipple
            sx={{ color: '#3b82f6', textTransform: 'none', p: 0, mt: 0.5, minWidth: 'auto' }}
          >
            + New folder
          </Button>
          <CreateFolderDialog
            open={createFolderDialogOpen}
            onClose={() => setCreateFolderDialogOpen(false)}
            parentPath={effectiveParentForNewFolder}
            onSuccess={handleFolderCreated}
          />
        </aside>

        <main className="main">
          <div className="main-top-bar">
            <div className="region-header">
              <Typography variant="h6" sx={{ margin: 0, color: '#f8fafc' }}>{selectedZone.city}</Typography>
              <Typography component="span" sx={{ fontSize: '0.8rem', color: '#64748b', display: 'block' }}>
                {selectedZone.carrier} · {selectedZone.id}
              </Typography>
              <Typography
                component="span"
                sx={{
                  display: 'block',
                  mt: 0.5,
                  fontSize: '0.8rem',
                  color: '#94a3b8',
                }}
              >
                {selectedFolderPath.length === 0
                  ? 'All connections'
                  : selectedFolderPath.join(' › ')}
              </Typography>
            </div>
            <Box sx={{ display: 'flex', gap: 1, flexShrink: 0 }}>
              <Button
                onClick={() => setCreateFolderDialogOpen(true)}
                disabled={!canCreateFolderUnderSelection}
                disableRipple
                variant="outlined"
                sx={{
                  color: '#94a3b8',
                  borderColor: '#475569',
                  textTransform: 'none',
                  '&:hover': { borderColor: '#64748b', backgroundColor: 'rgba(71, 85, 105, 0.2)' },
                }}
              >
                + New folder
              </Button>
              <Button
                onClick={() => setCreateDialogOpen(true)}
                disabled={!canCreateConnectionUnderSelection}
                disableRipple
                sx={{ color: '#3b82f6', textTransform: 'none' }}
                title={!canCreateConnectionUnderSelection ? 'Connections cannot be created in Shared' : undefined}
              >
                + New connection
              </Button>
            </Box>
          </div>
          <CreateConnectionDialog
            isOpen={createDialogOpen}
            onClose={() => setCreateDialogOpen(false)}
            wavelengthZoneId={selectedZone.id}
            folderPath={selectedFolderPath.length > 0 ? selectedFolderPath : ['My Drones']}
            onSuccess={handleConnectionCreated}
          />
          <ConnectionDetailDialog
            sessionId={detailSessionId}
            open={detailDialogOpen}
            onClose={() => { setDetailDialogOpen(false); setDetailSessionId(null) }}
          />

          <Menu
            open={connectionMenuAnchor !== null}
            anchorEl={connectionMenuAnchor?.el ?? null}
            onClose={() => setConnectionMenuAnchor(null)}
            anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
            transformOrigin={{ vertical: 'top', horizontal: 'right' }}
            PaperProps={{
              sx: {
                backgroundColor: '#1e293b',
                border: '1px solid #334155',
                '& .MuiMenuItem-root': { color: '#e2e8f0' },
              },
            }}
          >
            <MenuItem
              onClick={() => connectionMenuAnchor && handlePauseConnection(connectionMenuAnchor.sessionId)}
              disabled={connectionMenuAnchor ? connections.find((x) => x.session_id === connectionMenuAnchor.sessionId)?.status === 'idle' : false}
            >
              <PauseCircleOutline sx={{ fontSize: 18, mr: 1 }} /> Pause (set idle)
            </MenuItem>
            <MenuItem
              onClick={() => connectionMenuAnchor && handleActivateConnection(connectionMenuAnchor.sessionId)}
              disabled={connectionMenuAnchor ? connections.find((x) => x.session_id === connectionMenuAnchor.sessionId)?.status === 'active' : false}
            >
              <PlayArrow sx={{ fontSize: 18, mr: 1 }} /> Reactivate
            </MenuItem>
            <MenuItem
              onClick={() => {
                if (connectionMenuAnchor) {
                  setConfirmDeleteConnection(connectionMenuAnchor.sessionId)
                  setConnectionMenuAnchor(null)
                }
              }}
              sx={{ color: '#f87171' }}
            >
              <DeleteIcon sx={{ fontSize: 18, mr: 1 }} /> Delete
            </MenuItem>
          </Menu>

          <Dialog
            open={confirmDeleteConnection !== null}
            onClose={() => setConfirmDeleteConnection(null)}
            PaperProps={{
              sx: {
                backgroundColor: '#1e293b',
                border: '1px solid #334155',
                color: '#f8fafc',
              },
            }}
          >
            <DialogTitle>Delete connection</DialogTitle>
            <DialogContent>
              <Typography>Are you sure you want to delete this connection? This cannot be undone.</Typography>
            </DialogContent>
            <DialogActions sx={{ borderTop: '1px solid #334155', p: 2 }}>
              <Button onClick={() => setConfirmDeleteConnection(null)} sx={{ color: '#94a3b8' }} disableRipple>
                Cancel
              </Button>
              <Button
                onClick={() => confirmDeleteConnection && handleDeleteConnection(confirmDeleteConnection)}
                sx={{ color: '#f87171' }}
                disableRipple
                disabled={deleteLoading === confirmDeleteConnection}
              >
                Delete
              </Button>
            </DialogActions>
          </Dialog>

          <Dialog
            open={confirmDeleteFolderPath !== null && confirmDeleteFolderPath.length > 0}
            onClose={() => setConfirmDeleteFolderPath(null)}
            PaperProps={{
              sx: {
                backgroundColor: '#1e293b',
                border: '1px solid #334155',
                color: '#f8fafc',
              },
            }}
          >
            <DialogTitle>Delete folder</DialogTitle>
            <DialogContent>
              <Typography>
                Are you sure you want to delete the folder &quot;{confirmDeleteFolderPath?.[confirmDeleteFolderPath.length - 1] ?? ''}&quot;?
                Sessions in it will become uncategorized.
              </Typography>
            </DialogContent>
            <DialogActions sx={{ borderTop: '1px solid #334155', p: 2 }}>
              <Button onClick={() => setConfirmDeleteFolderPath(null)} sx={{ color: '#94a3b8' }} disableRipple>
                Cancel
              </Button>
              <Button onClick={handleConfirmDeleteFolder} sx={{ color: '#f87171' }} disableRipple>
                Delete
              </Button>
            </DialogActions>
          </Dialog>

          <Typography component="h2" variant="subtitle2" sx={{ color: '#64748b', mb: 1, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Connections
          </Typography>
          <div className="drones-grid">
            {connections.length === 0 ? (
              <Typography sx={{ color: '#94a3b8', fontSize: '0.875rem' }}>
                No connections in this folder
              </Typography>
            ) : (
              connections.map((c) => (
                <Box
                  key={c.session_id}
                  className="drone-card"
                  sx={{ position: 'relative', cursor: 'pointer' }}
                  onClick={() => handleConnectionClick(c.session_id)}
                >
                  <IconButton
                    aria-label="Connection options"
                    onClick={(e) => { e.stopPropagation(); setConnectionMenuAnchor({ sessionId: c.session_id, el: e.currentTarget }) }}
                    disabled={deleteLoading === c.session_id}
                    sx={{
                      position: 'absolute',
                      top: 4,
                      right: 4,
                      color: '#94a3b8',
                      p: 0.5,
                      '&:hover': { color: '#e2e8f0', backgroundColor: 'rgba(148, 163, 184, 0.1)' },
                    }}
                    size="small"
                  >
                    <MoreVert sx={{ fontSize: 18 }} />
                  </IconButton>
                  <div className={`status-dot ${c.status === 'active' ? 'connected' : c.status === 'idle' ? 'idle' : 'offline'}`} />
                  <Typography variant="subtitle1" sx={{ m: '0.5rem 0 0.25rem', color: '#f8fafc', pr: 3 }}>{c.name}</Typography>
                  <Typography component="span" sx={{ fontSize: '0.8rem', color: c.status === 'idle' ? '#eab308' : '#94a3b8' }}>
                    {c.status === 'active' ? 'Active' : c.status === 'idle' ? 'Idle' : c.status}
                  </Typography>
                </Box>
              ))
            )}
          </div>
        </main>
      </div>
    </div>
  )
}
