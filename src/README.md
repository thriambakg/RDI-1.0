# RDI Source Code

## Structure

- **session-api/** - Session API Lambda (Python). Manages connection pool, returns proxy endpoint.
- **proxy/** - Rust WebSocket relay. Runs on EC2, bridges frontend <-> agent.
- **agent/** - Rust tunnel agent. Runs on local machine or Pi, bridges proxy WebSocket <-> localhost:14540 (PX4).

## Building the Proxy

```bash
cd proxy
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
./rdi-agent
```
