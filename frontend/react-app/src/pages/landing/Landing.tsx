import { getConfig } from '../../config'
import { LandingNav } from './LandingNav'
import { LandingHero } from './LandingHero'
import { LandingFeatures } from './LandingFeatures'
import { LandingCta } from './LandingCta'
import { LandingFooter } from './LandingFooter'
import './Landing.css'

export function Landing() {
  const config = getConfig()
  const hasAuth = Boolean(config.COGNITO_USER_POOL_ID && config.COGNITO_CLIENT_ID)

  return (
    <div className="landing">
      <LandingNav hasAuth={hasAuth} />
      <LandingHero hasAuth={hasAuth} />
      <LandingFeatures />
      {hasAuth && <LandingCta />}
      <LandingFooter />
    </div>
  )
}
