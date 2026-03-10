export function LandingFeatures() {
  return (
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
  )
}
