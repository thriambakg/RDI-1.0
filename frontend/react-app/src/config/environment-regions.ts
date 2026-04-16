/**
 * Deployable AWS regions for the console selector. `id` is the region code sent
 * as `wavelength_zone_id` in APIs (legacy field name; value is the AWS region).
 */
export interface RegionOption {
  /** AWS region code, e.g. us-east-1 */
  id: string
  /** Human-friendly name (city / location) */
  label: string
  country: string
}

/**
 * Regions per environment — parent regions where ECS proxy / session API run.
 * Staging: US East (N. Virginia). Production: EU (Frankfurt) + US East options.
 */
export const ENVIRONMENT_REGIONS: Record<string, RegionOption[]> = {
  staging: [{ id: 'us-east-1', label: 'N. Virginia', country: 'USA' }],
  production: [
    { id: 'eu-central-1', label: 'Frankfurt', country: 'Europe' },
    { id: 'us-east-1', label: 'N. Virginia', country: 'USA' },
    { id: 'us-east-2', label: 'Ohio', country: 'USA' },
  ],
}

/** @deprecated Use getRegionsForEnvironment */
export function getEdgeZonesForEnvironment(environment: string): RegionOption[] {
  return getRegionsForEnvironment(environment)
}

export function getRegionsForEnvironment(environment: string): RegionOption[] {
  return ENVIRONMENT_REGIONS[environment] ?? ENVIRONMENT_REGIONS.staging
}
