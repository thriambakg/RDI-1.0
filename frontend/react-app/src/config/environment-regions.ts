/** Region entry for the console region selector */
export interface RegionConfig {
  id: string
  city: string
  country: string
}

/**
 * Regions per environment — matches terraform/environments/{staging|production}/
 * staging: us-east-2 only
 * production: EU regions only (eu-central-1, eu-west-2, eu-west-3)
 */
export const ENVIRONMENT_REGIONS: Record<string, RegionConfig[]> = {
  staging: [
    { id: 'us-east-2', city: 'Columbus', country: 'USA (Ohio)' },
  ],
  production: [
    { id: 'eu-central-1', city: 'Frankfurt', country: 'Germany' },
    { id: 'eu-west-2', city: 'London', country: 'UK' },
    { id: 'eu-west-3', city: 'Paris', country: 'France' },
  ],
}

/** Returns regions for the given environment; defaults to staging if unknown */
export function getRegionsForEnvironment(environment: string): RegionConfig[] {
  return ENVIRONMENT_REGIONS[environment] ?? ENVIRONMENT_REGIONS.staging
}
