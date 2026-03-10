import { Link } from 'react-router-dom'

interface LandingNavProps {
  hasAuth: boolean
}

export function LandingNav({ hasAuth }: LandingNavProps) {
  return (
    <nav className="landing-nav">
      <div className="nav-inner">
        <span className="nav-logo">RDI</span>
        {hasAuth && (
          <div className="nav-cta">
            <Link to="/?auth=signin" className="nav-link">Sign In</Link>
            <Link to="/?auth=signup" className="nav-btn">Get Started</Link>
          </div>
        )}
      </div>
    </nav>
  )
}
