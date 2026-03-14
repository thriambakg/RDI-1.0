import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Heading } from '@aws-amplify/ui-react'
import { signOut } from 'aws-amplify/auth'
import { getEnvironmentRegions } from '../../config'
import './Console.css'

const { regions: EDGE_ZONES } = getEnvironmentRegions()

const MOCK_DRONES: Record<string, { id: string; name: string; status: string }[]> = {
  'use1-wl1-chi-wlz1': [{ id: 'drone-1', name: 'Chicago-Test', status: 'idle' }],
  'euc1-wl1-ber-wlz1': [
    { id: 'drone-2', name: 'FPV-Racer-01', status: 'connected' },
    { id: 'drone-3', name: 'Survey-Pro', status: 'idle' },
  ],
  'euc1-wl1-dtm-wlz1': [],
  'euc1-wl1-muc-wlz1': [],
  'euw2-wl1-lon-wlz1': [{ id: 'drone-4', name: 'Cine-UK-01', status: 'connected' }],
  'euw2-wl1-man-wlz1': [],
  'euw2-wl2-man-wlz1': [],
}

export default function Console() {
  const [selectedZone, setSelectedZone] = useState(EDGE_ZONES[0] ?? { id: 'use1-wl1-chi-wlz1', city: 'Chicago', country: 'USA', carrier: 'Verizon' })
  const [folders] = useState<string[]>(['My Drones', 'Shared'])
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)')
    const handler = () => { if (mq.matches) setSidebarOpen(false) }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const { environment, regions } = getEnvironmentRegions()
      console.log('[RDI Console] Environment', environment, '| Edge zones', regions.map((r) => r.id).join(', '))
    }
  }, [])

  const drones = MOCK_DRONES[selectedZone.id] || []

  const handleSignOut = async () => {
    await signOut()
    navigate('/')
  }

  return (
    <div className="console">
      <header className="console-header">
        <button className="sidebar-toggle" onClick={() => setSidebarOpen((o) => !o)} aria-label="Toggle sidebar">
          <span className="hamburger" />
          <span className="hamburger" />
          <span className="hamburger" />
        </button>
        <Heading level={4}>RDI Console</Heading>
        <Button variation="link" onClick={handleSignOut}>Sign Out</Button>
      </header>

      <div className={`sidebar-backdrop ${sidebarOpen ? 'open' : ''}`} onClick={() => setSidebarOpen(false)} aria-hidden="true" />

      <div className="console-body">
        <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
          <h3>Edge Location</h3>
          <select
            value={selectedZone.id}
            onChange={(e) => {
              const z = EDGE_ZONES.find((x) => x.id === e.target.value)
              if (z) setSelectedZone(z)
            }}
          >
            {EDGE_ZONES.map((z) => (
              <option key={z.id} value={z.id}>{z.city} ({z.carrier})</option>
            ))}
          </select>
          <h3>Folders</h3>
          <ul>
            {folders.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
          <button className="link-btn">+ New folder</button>
        </aside>

        <main className="main">
          <div className="main-top-bar">
            <div className="region-header">
              <h2>{selectedZone.city}</h2>
              <span className="region-id">{selectedZone.carrier} · {selectedZone.id}</span>
            </div>
            <button className="link-btn new-connection-btn">+ New connection</button>
          </div>
          <div className="drones-grid">
            {drones.map((d) => (
              <div key={d.id} className="drone-card">
                <div className={`status-dot ${d.status}`} />
                <h4>{d.name}</h4>
                <span className="status-text">{d.status}</span>
              </div>
            ))}
          </div>
          <p className="mock-note">Mock connections — Wavelength integration coming soon</p>
        </main>
      </div>
    </div>
  )
}
