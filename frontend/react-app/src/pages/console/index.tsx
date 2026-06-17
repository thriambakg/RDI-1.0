import { useState, useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Alert,
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
  Snackbar,
} from '@mui/material'
import type { SelectChangeEvent } from '@mui/material'
import { Delete as DeleteIcon, ExpandLess, ExpandMore, Folder, FolderOpen, MoreVert, PauseCircleOutline, PlayArrow } from '@mui/icons-material'
import { useAuth } from '../../contexts/AuthContext'
import { useSessionWebSocket } from '../../contexts/SessionWebSocketContext'
import { getEnvironmentRegions } from '../../config'
import { CreateConnectionDialog, CreateFolderDialog, ConnectionDetailDialog, RegisterRelayDialog, RelayDetailDialog } from '../../components/dialogues'
import { useProfile } from '../../contexts/ProfileContext'
import {
  deleteFolder,
  removeFolderAtPath,
  removeSessionFromHierarchy,
  removeRelayFromRelays,
  addFolderAtPath,
  addSessionAtPath,
  updateSessionStatusInHierarchy,
  updateRelayStatusInRelays,
  type FolderNode,
  type SessionRef,
  type ConnectionHierarchy,
  type RelayRef,
} from '../../services/profileApi'
import { deleteSession, releaseSession, activateSession, getSession } from '../../services/sessionApi'
import { deleteRelay, updateRelayStatus } from '../../services/relayApi'
import type { CreateSessionResponse } from '../../services/sessionApi'
import { usesWebSocketTransport } from '../../utils/sessionTransport'
import './Console.css'

const { regions: REGION_OPTIONS } = getEnvironmentRegions()

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
  const [selectedZone, setSelectedZone] = useState(
    REGION_OPTIONS[0] ?? { id: 'us-east-1', label: 'N. Virginia', country: 'USA' }
  )
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [createFolderDialogOpen, setCreateFolderDialogOpen] = useState(false)
  const [registerRelayDialogOpen, setRegisterRelayDialogOpen] = useState(false)
  const { profile, hierarchy, isLoading: profileLoading, refetch: fetchProfile, updateHierarchy, updateRelays } = useProfile()
  const [selectedFolderPath, setSelectedFolderPath] = useState<string[]>([])
  const [deleteLoading, setDeleteLoading] = useState<string | null>(null)
  const [connectionMenuAnchor, setConnectionMenuAnchor] = useState<{ sessionId: string; el: HTMLElement } | null>(null)
  const [confirmDeleteConnection, setConfirmDeleteConnection] = useState<string | null>(null)
  const [confirmDeleteFolderPath, setConfirmDeleteFolderPath] = useState<string[] | null>(null)
  const [confirmDeleteRelay, setConfirmDeleteRelay] = useState<{ relay_id: string; wavelength_zone_id: string; name: string } | null>(null)
  const [relayMenuAnchor, setRelayMenuAnchor] = useState<{ relay: RelayRef; el: HTMLElement } | null>(null)
  const [selectedRelayId, setSelectedRelayId] = useState<string | null>(null)
  const [detailRelay, setDetailRelay] = useState<RelayRef | null>(null)
  const [relayDetailDialogOpen, setRelayDetailDialogOpen] = useState(false)
  const [detailSessionId, setDetailSessionId] = useState<string | null>(null)
  const [detailDialogOpen, setDetailDialogOpen] = useState(false)
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({
    open: false,
    message: '',
    severity: 'error',
  })
  const navigate = useNavigate()

  function showSessionError(message: string) {
    setSnackbar({ open: true, message, severity: 'error' })
  }

  function getSessionErrorMessage(err: unknown, action: 'activate' | 'pause' | 'delete'): string {
    const msg = err instanceof Error ? err.message : String(err)
    if (/not found|session not found/i.test(msg)) return 'This session does not exist.'
    if (action === 'activate') return 'Unable to activate connection.'
    if (action === 'pause') return 'Unable to pause connection.'
    if (action === 'delete') return 'Delete failed.'
    return msg || 'Something went wrong.'
  }
  const { logout } = useAuth()

  const allConnections = collectSessions(hierarchy, selectedFolderPath)
  const connections = selectedRelayId
    ? allConnections.filter((c) => c.relay_id === selectedRelayId)
    : allConnections
  const relays = (profile?.relays ?? []).filter((r: RelayRef) => r.wavelength_zone_id === selectedZone.id)
  const selectedRelay = selectedRelayId ? relays.find((r) => r.relay_id === selectedRelayId) : null

  const effectiveParentForNewFolder = selectedFolderPath.length > 0 ? selectedFolderPath : ['My Drones']
  const canCreateFolderUnderSelection = effectiveParentForNewFolder[0] !== 'Shared'
  const effectiveParentForNewConnection = selectedFolderPath.length > 0 ? selectedFolderPath : ['My Drones']
  const canCreateConnectionUnderSelection = effectiveParentForNewConnection[0] !== 'Shared'

  const { openSession: openSessionWs, closeSession: closeSessionWs, connectionState } = useSessionWebSocket()

  const handleRelayClick = (relayId: string) => {
    setSelectedRelayId((prev) => (prev === relayId ? null : relayId))
  }

  const handleRelayDoubleClick = (relay: RelayRef) => {
    setDetailRelay(relay)
    setSelectedRelayId(relay.relay_id)
    setRelayDetailDialogOpen(true)
  }

  // Keep WebSockets open for all active sessions. Connect as soon as hierarchy loads and on any hierarchy change.
  useEffect(() => {
    if (profileLoading || !hierarchy) return
    const allSessions = collectSessions(hierarchy, [])
    const active = allSessions.filter((s) => s.status === 'active')
    if (active.length === 0) return
    // Fetch endpoint for each active WebSocket session (skip WebRTC and failed retries)
    active.forEach((s) => {
      const state = connectionState(s.session_id)
      if (state === 'open' || state === 'connecting' || state === 'failed') return
      getSession(s.session_id)
        .then((data) => {
          if (data.status === 'active' && data.endpoint && usesWebSocketTransport(data)) {
            openSessionWs(s.session_id, data.endpoint)
          }
        })
        .catch(() => { /* ignore; session may be stale */ })
    })
  }, [hierarchy, profileLoading, openSessionWs, connectionState])

  const handleConnectionCreated = useCallback(
    (res: CreateSessionResponse, displayName: string) => {
      updateHierarchy((h) =>
        addSessionAtPath(h, effectiveParentForNewConnection, {
          session_id: res.session_id,
          name: displayName,
          status: 'active',
          relay_id: res.relay_id,
        })
      )
      if (usesWebSocketTransport(res)) {
        openSessionWs(res.session_id, res.endpoint)
      }
      if (res.relay_id) {
        updateRelays((r) =>
          updateRelayStatusInRelays(r, res.relay_id!, selectedZone.id, 'online')
        )
      }
    },
    [effectiveParentForNewConnection, selectedZone.id, updateHierarchy, openSessionWs, updateRelays]
  )

  const handleFolderCreated = useCallback(
    (folderName?: string) => {
      if (folderName) {
        updateHierarchy((h) => addFolderAtPath(h, effectiveParentForNewFolder, folderName))
      }
    },
    [effectiveParentForNewFolder, updateHierarchy]
  )

  const handleDeleteConnection = async (sessionId: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
    setConfirmDeleteConnection(null)
    setConnectionMenuAnchor(null)
    setDeleteLoading(sessionId)
    closeSessionWs(sessionId)
    if (detailSessionId === sessionId) {
      setDetailSessionId(null)
      setDetailDialogOpen(false)
    }
    updateHierarchy((h) => removeSessionFromHierarchy(h, sessionId))
    try {
      await deleteSession(sessionId, true)
      // Cache live update only; no refresh so UI stays in sync with optimistic remove
    } catch (err) {
      console.error('[RDI Console] Delete failed', err)
      showSessionError(getSessionErrorMessage(err, 'delete'))
    } finally {
      setDeleteLoading(null)
    }
  }

  const handlePauseConnection = async (sessionId: string) => {
    setConnectionMenuAnchor(null)
    setDeleteLoading(sessionId)
    closeSessionWs(sessionId)
    updateHierarchy((h) => updateSessionStatusInHierarchy(h, sessionId, 'idle'))
    try {
      await releaseSession(sessionId)
    } catch (err) {
      console.error('[RDI Console] Pause failed', err)
      const isNotFound = err instanceof Error && /not found/i.test(err.message)
      if (isNotFound) {
        updateHierarchy((h) => removeSessionFromHierarchy(h, sessionId))
      } else {
        updateHierarchy((h) => updateSessionStatusInHierarchy(h, sessionId, 'active'))
      }
      showSessionError(getSessionErrorMessage(err, 'pause'))
    } finally {
      setDeleteLoading(null)
    }
  }

  const handleActivateConnection = async (sessionId: string) => {
    setConnectionMenuAnchor(null)
    setDeleteLoading(sessionId)
    const session = allConnections.find((c) => c.session_id === sessionId)
    updateHierarchy((h) => updateSessionStatusInHierarchy(h, sessionId, 'active'))
    if (session?.relay_id) {
      const relay = relays.find((r) => r.relay_id === session.relay_id)
      if (relay) updateRelays((r) => updateRelayStatusInRelays(r, relay.relay_id, relay.wavelength_zone_id, 'online'))
    }
    try {
      await activateSession(sessionId)
      const data = await getSession(sessionId)
      if (data.status === 'active' && data.endpoint && usesWebSocketTransport(data)) {
        openSessionWs(sessionId, data.endpoint)
      }
    } catch (err) {
      console.error('[RDI Console] Activate failed', err)
      const isNotFound = err instanceof Error && /not found/i.test(err.message)
      if (isNotFound) {
        updateHierarchy((h) => removeSessionFromHierarchy(h, sessionId))
      } else {
        updateHierarchy((h) => updateSessionStatusInHierarchy(h, sessionId, 'idle'))
        if (session?.relay_id) {
          const relay = relays.find((r) => r.relay_id === session.relay_id)
          if (relay) updateRelays((r) => updateRelayStatusInRelays(r, relay.relay_id, relay.wavelength_zone_id, 'idle'))
        }
      }
      showSessionError(getSessionErrorMessage(err, 'activate'))
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
    } catch (err) {
      console.error('[RDI Console] Delete folder failed', err)
      await fetchProfile({ silent: true })
    }
  }

  const handleSetRelayIdle = async (relay: RelayRef) => {
    setRelayMenuAnchor(null)
    const childSessions = allConnections.filter((c) => c.relay_id === relay.relay_id && c.status === 'active')
    setDeleteLoading(relay.relay_id)
    childSessions.forEach((s) => closeSessionWs(s.session_id))
    childSessions.forEach((s) => updateHierarchy((h) => updateSessionStatusInHierarchy(h, s.session_id, 'idle')))
    updateRelays((r) => updateRelayStatusInRelays(r, relay.relay_id, relay.wavelength_zone_id, 'idle'))
    try {
      for (const s of childSessions) {
        await releaseSession(s.session_id)
      }
      updateRelayStatus(relay.relay_id, relay.wavelength_zone_id, 'idle').catch((err) => {
        console.error('[RDI Console] Relay status persist failed', err)
      })
    } catch (err) {
      console.error('[RDI Console] Set relay idle failed', err)
      childSessions.forEach((s) => updateHierarchy((h) => updateSessionStatusInHierarchy(h, s.session_id, 'active')))
      updateRelays((r) => updateRelayStatusInRelays(r, relay.relay_id, relay.wavelength_zone_id, 'online'))
      showSessionError(err instanceof Error ? err.message : 'Set relay idle failed')
    } finally {
      setDeleteLoading(null)
    }
  }

  const handleDeleteRelay = async () => {
    if (!confirmDeleteRelay) return
    const { relay_id, wavelength_zone_id } = confirmDeleteRelay
    setConfirmDeleteRelay(null)
    setRelayMenuAnchor(null)
    if (selectedRelayId === relay_id) setSelectedRelayId(null)
    if (detailRelay?.relay_id === relay_id) {
      setDetailRelay(null)
      setRelayDetailDialogOpen(false)
    }
    // Immediate UI update (mirrors handleDeleteConnection, handleSetRelayIdle)
    const childSessions = allConnections.filter((c) => c.relay_id === relay_id && c.status === 'active')
    childSessions.forEach((s) => closeSessionWs(s.session_id))
    childSessions.forEach((s) => updateHierarchy((h) => updateSessionStatusInHierarchy(h, s.session_id, 'idle')))
    updateRelays((r) => removeRelayFromRelays(r, relay_id, wavelength_zone_id))
    setDeleteLoading(relay_id)
    try {
      await deleteRelay(relay_id, wavelength_zone_id)
      await Promise.all(childSessions.map((s) => releaseSession(s.session_id).catch(() => {})))
      // Persist succeeded; UI already updated
    } catch (err) {
      console.error('[RDI Console] Delete relay failed', err)
      showSessionError(err instanceof Error ? err.message : 'Delete relay failed')
      await fetchProfile({ silent: true })
    } finally {
      setDeleteLoading(null)
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
    const z = REGION_OPTIONS.find((x) => x.id === e.target.value)
    if (z) {
      setSelectedZone(z)
      setSelectedRelayId(null)
    }
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
            Region
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
              {REGION_OPTIONS.map((z) => (
                <MenuItem key={z.id} value={z.id} disableRipple>
                  {z.label} ({z.id})
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
              <Typography variant="h6" sx={{ margin: 0, color: '#f8fafc' }}>{selectedZone.label}</Typography>
              <Typography component="span" sx={{ fontSize: '0.8rem', color: '#64748b', display: 'block' }}>
                {selectedZone.country} · {selectedZone.id}
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
                onClick={() => setRegisterRelayDialogOpen(true)}
                disableRipple
                variant="outlined"
                sx={{
                  color: '#94a3b8',
                  borderColor: '#475569',
                  textTransform: 'none',
                  '&:hover': { borderColor: '#64748b', backgroundColor: 'rgba(71, 85, 105, 0.2)' },
                }}
              >
                + Register relay
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
            relays={(profile?.relays ?? []).filter((r: RelayRef) => r.wavelength_zone_id === selectedZone.id)}
            onRegisterRelayClick={() => {
              setCreateDialogOpen(false)
              setRegisterRelayDialogOpen(true)
            }}
            onSuccess={handleConnectionCreated}
          />
          <RegisterRelayDialog
            isOpen={registerRelayDialogOpen}
            onClose={() => setRegisterRelayDialogOpen(false)}
            wavelengthZoneId={selectedZone.id}
            zoneLabel={`${selectedZone.label} (${selectedZone.id})`}
            onSuccess={() => {
              fetchProfile({ silent: true })
            }}
          />
          <RelayDetailDialog
            relay={detailRelay}
            open={relayDetailDialogOpen}
            onClose={() => { setRelayDetailDialogOpen(false); setDetailRelay(null) }}
          />
          <ConnectionDetailDialog
            sessionId={detailSessionId}
            open={detailDialogOpen}
            onClose={() => { setDetailDialogOpen(false); setDetailSessionId(null) }}
            relays={relays}
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

          <Menu
            open={relayMenuAnchor !== null}
            anchorEl={relayMenuAnchor?.el ?? null}
            onClose={() => setRelayMenuAnchor(null)}
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
              onClick={() => relayMenuAnchor && handleSetRelayIdle(relayMenuAnchor.relay)}
            >
              <PauseCircleOutline sx={{ fontSize: 18, mr: 1 }} /> Set idle (idle all connections)
            </MenuItem>
            <MenuItem
              onClick={() => {
                if (relayMenuAnchor) {
                  setConfirmDeleteRelay({
                    relay_id: relayMenuAnchor.relay.relay_id,
                    wavelength_zone_id: relayMenuAnchor.relay.wavelength_zone_id,
                    name: relayMenuAnchor.relay.name,
                  })
                  setRelayMenuAnchor(null)
                }
              }}
              sx={{ color: '#f87171' }}
            >
              <DeleteIcon sx={{ fontSize: 18, mr: 1 }} /> Delete
            </MenuItem>
          </Menu>

          <Dialog
            open={confirmDeleteRelay !== null}
            onClose={() => setConfirmDeleteRelay(null)}
            PaperProps={{
              sx: {
                backgroundColor: '#1e293b',
                border: '1px solid #334155',
                color: '#f8fafc',
              },
            }}
          >
            <DialogTitle>Delete relay</DialogTitle>
            <DialogContent>
              <Typography>
                Are you sure you want to delete the relay &quot;{confirmDeleteRelay?.name ?? ''}&quot;?
                Connections using this relay will need to be updated.
              </Typography>
            </DialogContent>
            <DialogActions sx={{ borderTop: '1px solid #334155', p: 2 }}>
              <Button onClick={() => setConfirmDeleteRelay(null)} sx={{ color: '#94a3b8' }} disableRipple>
                Cancel
              </Button>
              <Button
                onClick={handleDeleteRelay}
                sx={{ color: '#f87171' }}
                disableRipple
                disabled={confirmDeleteRelay !== null && deleteLoading === confirmDeleteRelay.relay_id}
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
            Relays
          </Typography>
          <div className="drones-grid">
            {relays.length === 0 ? (
              <Typography sx={{ color: '#94a3b8', fontSize: '0.875rem' }}>
                No relays for this zone
              </Typography>
            ) : (
              relays.map((r) => (
                <Box
                  key={r.relay_id}
                  className="drone-card"
                  sx={{
                    position: 'relative',
                    cursor: 'pointer',
                    borderColor: selectedRelayId === r.relay_id ? '#3b82f6' : undefined,
                    borderWidth: selectedRelayId === r.relay_id ? 2 : undefined,
                    backgroundColor: selectedRelayId === r.relay_id ? 'rgba(59, 130, 246, 0.1)' : undefined,
                  }}
                  onClick={() => handleRelayClick(r.relay_id)}
                  onDoubleClick={() => handleRelayDoubleClick(r)}
                >
                  <IconButton
                    aria-label="Relay options"
                    onClick={(e) => { e.stopPropagation(); setRelayMenuAnchor({ relay: r, el: e.currentTarget }) }}
                    disabled={deleteLoading === r.relay_id}
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
                  <div className={`status-dot ${r.status === 'online' ? 'connected' : r.status === 'idle' ? 'idle' : 'offline'}`} />
                  <Typography variant="subtitle1" sx={{ m: '0.5rem 0 0.25rem', color: '#f8fafc', pr: 3 }}>{r.name}</Typography>
                  <Typography component="span" sx={{ fontSize: '0.8rem', color: r.status === 'online' ? '#22c55e' : r.status === 'idle' ? '#eab308' : '#94a3b8' }}>
                    {r.status === 'online' ? 'Online' : r.status === 'idle' ? 'Idle' : 'Offline'}
                  </Typography>
                  <Typography component="span" sx={{ fontSize: '0.75rem', color: '#64748b', display: 'block', mt: 0.25 }}>
                    {r.relay_type}
                  </Typography>
                </Box>
              ))
            )}
          </div>

          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 3, mb: 1, flexWrap: 'wrap' }}>
            <Typography component="h2" variant="subtitle2" sx={{ color: '#64748b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {selectedRelay ? `Connections for ${selectedRelay.name}` : 'Connections'}
            </Typography>
            {selectedRelay && (
              <Button
                size="small"
                onClick={() => setSelectedRelayId(null)}
                disableRipple
                sx={{ color: '#64748b', textTransform: 'none', fontSize: '0.75rem', minWidth: 'auto', p: 0 }}
              >
                Show all
              </Button>
            )}
          </Box>
          <div className="drones-grid">
            {connections.length === 0 ? (
              <Typography sx={{ color: '#94a3b8', fontSize: '0.875rem' }}>
                {selectedRelay ? 'No connections for this relay' : 'No connections in this folder'}
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
                  {c.relay_id && (() => {
                    const relay = relays.find((r) => r.relay_id === c.relay_id)
                    return relay ? (
                      <Typography component="span" sx={{ fontSize: '0.75rem', color: '#64748b', display: 'block', mt: 0.25 }}>
                        Relay: {relay.name}
                      </Typography>
                    ) : null
                  })()}
                </Box>
              ))
            )}
          </div>
        </main>
      </div>

      <Snackbar
        open={snackbar.open}
        autoHideDuration={5000}
        onClose={() => setSnackbar((s) => ({ ...s, open: false }))}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      >
        <Alert
          onClose={() => setSnackbar((s) => ({ ...s, open: false }))}
          severity={snackbar.severity}
          sx={{
            backgroundColor: snackbar.severity === 'error' ? '#ef4444' : '#10b981',
            color: '#ffffff',
          }}
        >
          {snackbar.message}
        </Alert>
      </Snackbar>
    </div>
  )
}
