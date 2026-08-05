# Gazebo desktop sim (custom drones)

Yes — you can simulate customized airframes on your desktop with **Gazebo + PX4 SITL**, then point an RDI connection at that MAVLink endpoint.

## What RDI expects

| Create-connection field | Recommended for Gazebo |
|---|---|
| **Vehicle stack** | `Gazebo + PX4 SITL` (`gazebo_px4`) |
| **Link mode** | `UDP MAVLink (SITL / Gazebo / local)` (`udp_mavlink`) |
| **MAVLink host** | `127.0.0.1` (default) on the machine running the relay agent |
| **MAVLink port** | `18570` (PX4 v1.13+ / Gazebo common) or `14540` (legacy) |

CTRL frames tag `stack=gazebo_px4` and `pipe=webrtc_relay` (console → Pi) or radio pipes when you toggle **Via radio**. The desktop radio agent prints `pipe` / `stack` on every CTRL so you can confirm the hop.

## Host OS notes

- **Linux** (or **WSL2** on Windows): preferred for PX4 + Gazebo. Native Windows Gazebo/PX4 SITL is fragile; use WSL2 Ubuntu and expose UDP to the Windows relay if needed.
- Relay / desktop agent can stay on Windows; SITL listens on UDP inside WSL. Forward or bind so `127.0.0.1:18570` on the relay host reaches SITL (same machine, or set `mavlink_host` to the WSL IP).

## Minimal PX4 + Gazebo path

1. Install PX4 toolchain + Gazebo (Harmonic or Classic per PX4 docs for your branch).
2. From the PX4 tree:

```bash
make px4_sitl gz_x500
# or classic: make px4_sitl gazebo-classic_iris
```

3. Confirm MAVLink is up (QGroundControl / `mavlink-routerd` / `nc -u` traffic on the SITL port).
4. In the RDI console: **Create connection** → stack **Gazebo + PX4 SITL** → link **UDP MAVLink** → port **18570** (or whatever SITL prints).
5. Activate the connection; keyboard CTRL on **Relay only** hits the Pi worker, which talks MAVLink UDP to SITL.

## Customized drones

Gazebo airframes are **models** (SDF / meshes / plugins), not RDI UI skins:

1. Copy a stock model (e.g. `x500`) under your Gazebo models path.
2. Edit mass, inertia, motor layout, props, and sensors in the SDF.
3. Register the model name for PX4 SITL (`PX4_GZ_MODEL` / world spawn args — see current PX4 Gazebo docs for your version).
4. Launch SITL with that model; keep the same RDI `gazebo_px4` + `udp_mavlink` connection — RDI does not need a new stack id for each custom airframe unless you add a dedicated action dialect later.

ArduPilot + Gazebo is also possible: choose stack **ArduPilot**, port **14550** (typical SITL), still `udp_mavlink`.

## What is not simulated by Gazebo alone

- RFD900 / radio hop — use the lab radio path or the desktop agent separately.
- Browser video — still WebRTC on the same peer (roadmap); Gazebo camera plugins can feed a future track, but are not wired today.

## Quick check

After create + activate, Connection setup should show `Stack: Gazebo + PX4 SITL` and `Link: udp_mavlink`. Hold WASD with **Relay only**; Pi worker logs should include `stack=gazebo_px4 pipe=webrtc_relay`.
