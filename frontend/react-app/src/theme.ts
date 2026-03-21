import { createTheme } from '@mui/material/styles'

/** RDI dark theme - matches console (#0f172a, #1e293b, #334155) */
export const rdiTheme = createTheme({
  palette: {
    mode: 'dark',
    primary: { main: '#3b82f6' },
    background: {
      default: '#0f172a',
      paper: '#1e293b',
    },
    text: {
      primary: '#f8fafc',
      secondary: '#94a3b8',
      disabled: '#64748b',
    },
  },
  components: {
    MuiDialog: {
      styleOverrides: {
        paper: {
          backgroundColor: '#1e293b !important',
          border: '1px solid #334155',
          borderRadius: '0.5rem',
        },
        root: {
          '& .MuiDialogContent-root': {
            backgroundColor: '#1e293b',
            color: '#f8fafc',
          },
          '& .MuiDialogTitle-root': {
            color: '#ffffff',
            backgroundColor: '#1e293b',
          },
          '& .MuiDialogActions-root': {
            backgroundColor: '#1e293b',
            borderColor: '#334155',
          },
        },
      },
    },
    MuiBackdrop: {
      styleOverrides: {
        root: {
          backgroundColor: 'rgba(0, 0, 0, 0.6)',
          backdropFilter: 'blur(4px)',
        },
      },
    },
    MuiTextField: {
      styleOverrides: {
        root: {
          '& .MuiOutlinedInput-root': {
            backgroundColor: '#0f172a',
            color: '#f8fafc',
            '& fieldset': { borderColor: '#334155' },
            '&:hover fieldset': { borderColor: '#475569' },
            '&.Mui-focused fieldset': { borderColor: '#3b82f6' },
            '& input': { color: '#f8fafc' },
            '& input::placeholder': { color: '#64748b', opacity: 1 },
          },
          '& .MuiInputLabel-root': { color: '#94a3b8' },
          '& .MuiInputLabel-root.Mui-focused': { color: '#94a3b8' },
          '& .MuiSelect-select': { color: '#f8fafc' },
          '& .MuiSvgIcon-root': { color: '#94a3b8' },
        },
      },
    },
    MuiMenuItem: {
      styleOverrides: {
        root: {
          color: '#f8fafc',
          '&:hover': { backgroundColor: 'rgba(59, 130, 246, 0.15)' },
          '&.Mui-selected': { backgroundColor: 'rgba(59, 130, 246, 0.25)' },
          '&.Mui-selected:hover': { backgroundColor: 'rgba(59, 130, 246, 0.3)' },
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
        },
      },
    },
    MuiMenu: {
      defaultProps: {
        slotProps: {
          backdrop: { invisible: true },
        },
      },
    },
  },
})
