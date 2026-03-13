/** Region entry for the console region selector */
export interface RegionConfig {
  id: string
  city: string
  country: string
}

/**
 * Regions per environment — Wavelength zones only
 * staging: us-east-1 (N. Virginia)
 * production: eu-central-1 (Frankfurt), eu-west-2 (London)
 */
export const ENVIRONMENT_REGIONS: Record<string, RegionConfig[]> = {
  staging: [
    { id: 'us-east-1', city: 'N. Virginia', country: 'USA' },
  ],
  production: [
    { id: 'eu-central-1', city: 'Frankfurt', country: 'Germany' },
    { id: 'eu-west-2', city: 'London', country: 'UK' },
  ],
}

/** Returns regions for the given environment; defaults to staging if unknown */
export function getRegionsForEnvironment(environment: string): RegionConfig[] {
  return ENVIRONMENT_REGIONS[environment] ?? ENVIRONMENT_REGIONS.staging
}
