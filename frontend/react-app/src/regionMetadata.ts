/**
 * Display metadata for AWS regions (city, country).
 * Used with AVAILABLE_REGIONS from config to build the region dropdown.
 */
export const REGION_METADATA: Record<
  string,
  { city: string; country: string }
> = {
  'eu-central-1': { city: 'Frankfurt', country: 'Germany' },
  'eu-west-1': { city: 'Dublin', country: 'Ireland' },
  'eu-west-2': { city: 'London', country: 'UK' },
  'eu-west-3': { city: 'Paris', country: 'France' },
  'us-east-1': { city: 'N. Virginia', country: 'USA' },
  'us-east-2': { city: 'Columbus', country: 'USA (Ohio)' },
  'us-west-1': { city: 'N. California', country: 'USA' },
  'us-west-2': { city: 'Oregon', country: 'USA' },
  'ap-southeast-1': { city: 'Singapore', country: 'Singapore' },
  'ap-southeast-2': { city: 'Sydney', country: 'Australia' },
  'ap-northeast-1': { city: 'Tokyo', country: 'Japan' },
}

export function getRegionsForConfig(regionIds: string[]) {
  return regionIds.map((id) => ({
    id,
    city: REGION_METADATA[id]?.city ?? id,
    country: REGION_METADATA[id]?.country ?? '',
  }))
}
