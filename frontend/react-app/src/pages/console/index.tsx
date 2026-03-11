import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Heading } from '@aws-amplify/ui-react'
import { signOut } from 'aws-amplify/auth'
import { getConfig } from '../../config'
import './Console.css'

const ALL_REGIONS = [
  { id: 'eu-central-1', city: 'Frankfurt', country: 'Germany' },
  { id: 'eu-west-2', city: 'London', country: 'UK' },
  { id: 'eu-west-3', city: 'Paris', country: 'France' },
  { id: 'us-east-2', city: 'Columbus', country: 'USA (Ohio)' },
] as const

type Region = (typeof ALL_REGIONS)[number]

function getAvailableRegions(): Region[] {
  const config = getConfig()
  const ids = config.AVAILABLE_REGIONS
  if (!ids || ids.length === 0) return [...ALL_REGIONS]
  return ALL_REGIONS.filter((r) => ids.includes(r.id))
}

const MOCK_DRONES: Record<string, { id: string; name: string; status: string }[]> = {
  'eu-central-1': [
    { id: 'drone-1', name: 'FPV-Racer-01', status: 'connected' },
    { id: 'drone-2', name: 'Survey-Pro', status: 'idle' },
  ],
  'eu-west-2': [{ id: 'drone-3', name: 'Cine-UK-01', status: 'connected' }],
  'eu-west-3': [{ id: 'drone-4', name: 'Paris-Inspector', status: 'offline' }],
  'us-east-2': [{ id: 'drone-5', name: 'Ohio-Test', status: 'idle' }],
}

export default function Console() {
  const availableRegions = useMemo(() => getAvailableRegions(), [])
  const [selectedRegion, setSelectedRegion] = useState<Region>(availableRegions[0] ?? ALL_REGIONS[0])
  const [folders] = useState<string[]>(['My Drones', 'Shared'])
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    const valid = availableRegions.some((r) => r.id === selectedRegion.id)
    if (!valid && availableRegions.length > 0) {
      setSelectedRegion(availableRegions[0])
    }
  }, [availableRegions, selectedRegion.id])

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)')
    const handler = () => { if (mq.matches) setSidebarOpen(false) }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  const drones = MOCK_DRONES[selectedRegion.id] || []

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
          <h3>Region</h3>
          <select
            value={selectedRegion.id}
            onChange={(e) => {
              const r = availableRegions.find((x) => x.id === e.target.value)
              if (r) setSelectedRegion(r)
            }}
          >
            {availableRegions.map((r) => (
              <option key={r.id} value={r.id}>{r.city} ({r.country})</option>
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
              <h2>{selectedRegion.city}</h2>
              <span className="region-id">{selectedRegion.id}</span>
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
