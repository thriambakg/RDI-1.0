import { Link } from 'react-router-dom'

export function LandingCta() {
  return (
    <section className="cta-section">
      <div className="cta-inner">
        <h2>Ready to get started?</h2>
        <p>Sign in or create an account to manage your drone fleet.</p>
        <div className="cta-buttons">
          <Link to="/?auth=signin" className="btn btn-primary btn-lg">Sign In</Link>
          <Link to="/?auth=signup" className="btn btn-secondary btn-lg">Create Account</Link>
        </div>
      </div>
    </section>
  )
}
