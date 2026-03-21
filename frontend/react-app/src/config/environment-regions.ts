/** Edge (Wavelength) zone entry for the console selector */
export interface EdgeZoneConfig {
  id: string       // Wavelength Zone ID (e.g. use1-wl1-chi-wlz1)
  city: string
  country: string
  carrier: string
}

/**
 * Edge zones per environment — Wavelength zones only
 * staging: Chicago (Verizon)
 * production: Europe (Frankfurt), Europe (London)
 */
export const ENVIRONMENT_EDGE_ZONES: Record<string, EdgeZoneConfig[]> = {
  staging: [
    { id: 'use1-wl1-chi-wlz1', city: 'Chicago', country: 'USA', carrier: 'Verizon' },
  ],
  production: [
    // Europe (Frankfurt) — Vodafone
    { id: 'euc1-wl1-ber-wlz1', city: 'Berlin', country: 'Germany', carrier: 'Vodafone' },
    { id: 'euc1-wl1-dtm-wlz1', city: 'Dortmund', country: 'Germany', carrier: 'Vodafone' },
    { id: 'euc1-wl1-muc-wlz1', city: 'Munich', country: 'Germany', carrier: 'Vodafone' },
    // Europe (London) — Vodafone, BT
    { id: 'euw2-wl1-lon-wlz1', city: 'London', country: 'UK', carrier: 'Vodafone' },
    { id: 'euw2-wl1-man-wlz1', city: 'Manchester', country: 'UK', carrier: 'Vodafone' },
    { id: 'euw2-wl2-man-wlz1', city: 'Manchester', country: 'UK', carrier: 'British Telecom' },
  ],
}

/** Returns edge zones for the given environment; defaults to staging if unknown */
export function getEdgeZonesForEnvironment(environment: string): EdgeZoneConfig[] {
  return ENVIRONMENT_EDGE_ZONES[environment] ?? ENVIRONMENT_EDGE_ZONES.staging
}

/** @deprecated Use getEdgeZonesForEnvironment */
export function getRegionsForEnvironment(environment: string): EdgeZoneConfig[] {
  return getEdgeZonesForEnvironment(environment)
}
