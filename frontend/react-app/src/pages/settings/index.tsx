import { Typography } from '@mui/material'
import { ConsoleChromeHeader } from '../../components/console/ConsoleChromeHeader'
import '../console/Console.css'
import './Settings.css'

/** Account preferences shell — control maps live on each connection (gear → setup). */
export default function SettingsPage() {
  return (
    <div className="console settings-page">
      <ConsoleChromeHeader title="Settings" showBackToConsole />
      <div className="settings-body">
        <main className="settings-main">
          <Typography variant="h5" sx={{ color: '#f8fafc', mb: 1, fontWeight: 600 }}>
            Settings
          </Typography>
          <Typography variant="body2" sx={{ color: '#94a3b8', maxWidth: 520 }}>
            Control maps are configured per connection. Open a connection, then use the gear to edit that drone’s
            keybinds and connection details.
          </Typography>
        </main>
      </div>
    </div>
  )
}
