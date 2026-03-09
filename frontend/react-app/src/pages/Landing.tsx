import { Link } from 'react-router-dom'
import { getConfig } from '../config'
import './Landing.css'

export default function Landing() {
  const config = getConfig()
  const hasAuth = Boolean(config.COGNITO_USER_POOL_ID && config.COGNITO_CLIENT_ID)

  return (
    <div className="landing">
      <header>
        <h1>RDI</h1>
        <p>Remote Drone Interface</p>
      </header>
      <main>
        <p>Manage and control your drones across regions with low-latency Wavelength connectivity.</p>
        {hasAuth ? (
          <div className="auth-links">
            <Link to="/console" className="btn primary">Sign In</Link>
            <Link to="/console?signup=true" className="btn secondary">Sign Up</Link>
          </div>
        ) : (
          <p className="muted">Cognito not configured. Deploy base infra and set Cognito outputs in RDI-1.0 tfvars.</p>
        )}
      </main>
      <footer>
        <small>Latency-optimized for FPV and professional drone operations</small>
      </footer>
    </div>
  )
}
