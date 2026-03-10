import { Link } from 'react-router-dom'
import { getConfig } from '../config'
import './Landing.css'

export default function Landing() {
  const config = getConfig()
  const hasAuth = Boolean(config.COGNITO_USER_POOL_ID && config.COGNITO_CLIENT_ID)

  return (
    <div className="landing">
      <nav className="landing-nav">
        <div className="nav-inner">
          <span className="nav-logo">RDI</span>
          {hasAuth && (
            <div className="nav-cta">
              <Link to="/console" className="nav-link">Sign In</Link>
              <Link to="/console?signup=true" className="nav-btn">Get Started</Link>
            </div>
          )}
        </div>
      </nav>

      <section className="hero">
        <div className="hero-inner">
          <h1>Remote Drone Interface</h1>
          <p className="hero-tagline">
            Manage and control your drones across regions with low-latency connectivity. Built for FPV and professional operations.
          </p>
          {hasAuth ? (
            <div className="hero-cta">
              <Link to="/console" className="btn btn-primary">Sign In</Link>
              <Link to="/console?signup=true" className="btn btn-secondary">Sign Up</Link>
            </div>
          ) : (
            <p className="muted">Cognito not configured. Deploy base infra and set Cognito outputs in RDI-1.0 tfvars.</p>
          )}
        </div>
      </section>

      <section className="features">
        <div className="features-inner">
          <h2>Built for scale and reliability</h2>
          <div className="features-grid">
            <div className="feature-card">
              <h3>Multi-region deployment</h3>
              <p>Deploy across AWS regions for low-latency access to your fleet from anywhere.</p>
            </div>
            <div className="feature-card">
              <h3>Latency-optimized</h3>
              <p>Designed for FPV and real-time control where every millisecond counts.</p>
            </div>
            <div className="feature-card">
              <h3>Secure by default</h3>
              <p>Auth and identity via Cognito. Infrastructure managed with Terraform.</p>
            </div>
          </div>
        </div>
      </section>

      {hasAuth && (
        <section className="cta-section">
          <div className="cta-inner">
            <h2>Ready to get started?</h2>
            <p>Sign in or create an account to manage your drone fleet.</p>
            <div className="cta-buttons">
              <Link to="/console" className="btn btn-primary btn-lg">Sign In</Link>
              <Link to="/console?signup=true" className="btn btn-secondary btn-lg">Create Account</Link>
            </div>
          </div>
        </section>
      )}

      <footer className="landing-footer">
        <div className="footer-inner">
          <small>Latency-optimized for FPV and professional drone operations</small>
        </div>
      </footer>
    </div>
  )
}
