# RDI Test Scripts

Standalone test utilities for local development and validation.

## drone-test

Terminal-based MAVLink manual control for PX4 Gazebo. Sends MANUAL_CONTROL messages via UDP based on keyboard input.

**Usage:**

```bash
cd drone-test
cargo run
```

Start PX4 SITL with Gazebo first, then run. Optionally override the MAVLink port:

```bash
RDI_MAVLINK_PORT=14540 cargo run
```

**Controls:**

- **W/S** - Pitch (forward/back)
- **A/D** - Roll (left/right)
- **Q/E** - Yaw (counter-clockwise/clockwise)
- **Space** - Throttle up
- **C** - Throttle down
- **ESC** - Quit
