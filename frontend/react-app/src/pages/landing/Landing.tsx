import { getConfig } from '../../config'
import { LandingNav } from './LandingNav'
import { LandingHero } from './LandingHero'
import { LandingFeatures } from './LandingFeatures'
import { LandingAudience } from './LandingAudience'
import { LandingFaq } from './LandingFaq'
import { LandingCta } from './LandingCta'
import { LandingFooter } from './LandingFooter'
import './Landing.css'

export function Landing() {
  const config = getConfig()
  const hasAuth = Boolean(config.COGNITO_USER_POOL_ID && config.COGNITO_CLIENT_ID)

  return (
    <div className="landing">
      <div className="landing-glow landing-glow--a" aria-hidden />
      <div className="landing-glow landing-glow--b" aria-hidden />
      <LandingNav hasAuth={hasAuth} />
      <main className="landing-main">
        <LandingHero hasAuth={hasAuth} />
        <LandingFeatures />
        <LandingAudience />
        <LandingFaq />
        {hasAuth && <LandingCta />}
        <LandingFooter />
      </main>
    </div>
  )
}
