# RDI Source Code

## Structure

- **session-api/** - Session API Lambda (Python). Manages connection pool, returns proxy endpoint.
- **proxy/** - Rust WebSocket relay. Runs on EC2, bridges frontend <-> agent.
- **agent/** - Rust tunnel agent. Runs on local machine or Pi, bridges proxy WebSocket <-> PX4 UDP.

## MAVLink Compatibility (Proxy/Agent vs drone-test)

The **proxy** and **agent** are byte-level tunnels: they pass raw MAVLink binary between WebSocket and UDP without parsing. The drone-test script is the reference implementation for MAVLink format:

| Message           | Purpose                                   | drone-test |
|-------------------|-------------------------------------------|------------|
| MANUAL_CONTROL    | Pitch, roll, yaw, throttle (-1000..1000)  | ✓          |
| COMMAND_LONG      | Arm, disarm, takeoff, land, RTL           | ✓          |

**Target system/component:** `1/1` (PX4 autopilot). **Send rate:** 25 Hz for MANUAL_CONTROL.

When building the frontend WebSocket client, ensure it emits the same MAVLink messages; see `test-scripts/drone-test/src/main.rs` for the reference format.

## PX4 Port

- **PX4 v1.13+**: GCS MAVLink listens on UDP **18570** (Normal mode).
- **Older PX4**: Often **14540**.
- Set `RDI_MAVLINK_PORT=18570` (or `14540`) for both the **agent** and **drone-test** to match your PX4 version.

## Building the Proxy

```bash
cd src/proxy
cargo build --release
# Binary at target/release/rdi-proxy
# Upload to S3: aws s3 cp target/release/rdi-proxy s3://<bucket>/proxy/rdi-proxy
```

## Building the Agent

```bash
cd agent
cargo build --release
# Binary at target/release/rdi-agent
# For Pi: cargo build --release --target armv7-unknown-linux-gnueabihf
```

## Running the Agent

```bash
export RDI_PROXY_URL=ws://<proxy-ip>:8765
export RDI_SESSION_ID=<session-id-from-api>
export RDI_MAVLINK_PORT=18570   # for PX4 v1.13+; use 14540 for older
./rdi-agent
```

## Session API (Rust - optional low-latency)

An async Rust implementation of the Session API for lower latency when run on EC2:

```bash
cd src/session-api-rs
cargo build --release
CONNECTION_POOL_TABLE=xxx AWS_REGION=us-east-1 PROXY_ENDPOINT=ws://ip:8765 \
  X-User-Id=<cognito-sub> ./target/release/rdi-session-api
```

See [`../docs/LATENCY-ASYNC.md`](../docs/LATENCY-ASYNC.md) for design and deployment options.

## Test Scripts

See [`../test-scripts/README.md`](../test-scripts/README.md) for local test utilities (e.g. `drone-test` - terminal MAVLink control for PX4 Gazebo).
