import { useState } from 'react'
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
} from '@mui/material'
import { createFolder } from '../../services/profileApi'

const inputSx = {
  '& .MuiOutlinedInput-root': {
    color: '#f8fafc !important',
    backgroundColor: '#0f172a !important',
    '& fieldset': { borderColor: '#334155 !important' },
    '&:hover fieldset': { borderColor: '#475569 !important' },
    '&.Mui-focused fieldset': { borderColor: '#3b82f6 !important', borderWidth: 1 },
    '& input': { color: '#f8fafc !important' },
    '& input::placeholder': { color: '#64748b !important', opacity: 1 },
  },
  '& .MuiInputLabel-root': { color: '#94a3b8 !important' },
}

export interface CreateFolderDialogProps {
  open: boolean
  onClose: () => void
  parentPath: string[]
  onSuccess: () => void
}

export function CreateFolderDialog({ open, onClose, parentPath, onSuccess }: CreateFolderDialogProps) {
  const [folderName, setFolderName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const name = folderName.trim()
    if (!name) {
      setError('Folder name is required')
      return
    }
    setError(null)
    setLoading(true)
    try {
      await createFolder(parentPath, name)
      setFolderName('')
      onSuccess()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create folder')
    } finally {
      setLoading(false)
    }
  }

  const handleClose = () => {
    setFolderName('')
    setError(null)
    onClose()
  }

  const locationLabel = parentPath.length === 0 ? 'root' : parentPath.join(' › ')

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth="xs"
      fullWidth
      PaperProps={{
        sx: {
          backgroundColor: '#1e293b',
          border: '1px solid #334155',
          borderRadius: '0.5rem',
          color: '#f8fafc',
        },
      }}
      BackdropProps={{
        sx: { backgroundColor: 'rgba(0, 0, 0, 0.6)', backdropFilter: 'blur(4px)' },
      }}
    >
      <DialogTitle sx={{ color: '#ffffff', fontWeight: 600, textTransform: 'uppercase' }}>
        New folder
      </DialogTitle>
      <form onSubmit={handleSubmit}>
        <DialogContent sx={{ pt: 0 }}>
          <TextField
            fullWidth
            label="Folder name"
            placeholder="e.g. Fleet A"
            value={folderName}
            onChange={(e) => setFolderName(e.target.value)}
            required
            autoFocus
            autoComplete="off"
            margin="normal"
            sx={inputSx}
            helperText={parentPath.length > 0 ? `Inside ${locationLabel}` : 'At root level'}
          />
          {error && (
            <span style={{ color: '#f87171', fontSize: '0.875rem' }}>{error}</span>
          )}
        </DialogContent>
        <DialogActions sx={{ borderTop: '1px solid #334155', p: 2 }}>
          <Button onClick={handleClose} sx={{ color: '#3b82f6' }} disableRipple>
            Cancel
          </Button>
          <Button type="submit" variant="contained" disabled={loading} disableRipple>
            {loading ? 'Creating...' : 'Create'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}
