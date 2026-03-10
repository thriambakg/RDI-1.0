import { Link } from 'react-router-dom'

interface LandingHeroProps {
  hasAuth: boolean
}

export function LandingHero({ hasAuth }: LandingHeroProps) {
  return (
    <section className="hero">
      <div className="hero-inner">
        <h1>Remote Drone Interface</h1>
        <p className="hero-tagline">
          Manage and control your drones across regions with low-latency connectivity. Built for FPV and professional operations.
        </p>
        {hasAuth ? (
          <div className="hero-cta">
            <Link to="/?auth=signin" className="btn btn-primary">Sign In</Link>
            <Link to="/?auth=signup" className="btn btn-secondary">Sign Up</Link>
          </div>
        ) : (
          <p className="muted">Cognito not configured. Deploy base infra and set Cognito outputs in RDI-1.0 tfvars.</p>
        )}
      </div>
    </section>
  )
}
