/** Per-connection vehicle stack / firmware adapter (chosen at create time). */

export type VehicleStackId = 'px4' | 'ardupilot' | 'rdi_companion' | 'aux_only' | 'gazebo_px4'

export const VEHICLE_STACK_OPTIONS: {
  id: VehicleStackId
  label: string
  helper: string
  defaultMavlinkPort: number
}[] = [
  {
    id: 'px4',
    label: 'PX4 (MAVLink)',
    helper: 'Pixhawk / PX4 SITL — standard MAVLink dialect',
    defaultMavlinkPort: 18570,
  },
  {
    id: 'ardupilot',
    label: 'ArduPilot (MAVLink)',
    helper: 'ArduCopter / Plane / Rover — MAVLink on typical SITL ports',
    defaultMavlinkPort: 14550,
  },
  {
    id: 'gazebo_px4',
    label: 'Gazebo + PX4 SITL',
    helper: 'Desktop Gazebo sim talking MAVLink (often UDP 18570 / 14540)',
    defaultMavlinkPort: 18570,
  },
  {
    id: 'rdi_companion',
    label: 'RDI companion profile',
    helper: 'Custom actions via companion agent / profile.json (arms, aux, etc.)',
    defaultMavlinkPort: 18570,
  },
  {
    id: 'aux_only',
    label: 'Aux / manual map',
    helper: 'No autopilot dialect — numbered aux/servo effects only',
    defaultMavlinkPort: 18570,
  },
]

export function labelForVehicleStack(id: string | undefined | null): string {
  const hit = VEHICLE_STACK_OPTIONS.find((o) => o.id === id)
  return hit?.label ?? (id ? String(id) : 'Unknown stack')
}
