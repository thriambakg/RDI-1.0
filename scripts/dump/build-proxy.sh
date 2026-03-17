#!/usr/bin/env bash
# Build RDI proxy binary for EC2 deployment.
# Run from repo root. If rdi-proxy already exists at target/release, skips build.
set -e

PROXY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../src/proxy" && pwd)"
TARGET_BINARY="${PROXY_DIR}/target/release/rdi-proxy"

if [ -x "${TARGET_BINARY}" ]; then
  echo "Proxy binary already exists at ${TARGET_BINARY}, skipping build"
  exit 0
fi

if ! command -v cargo &>/dev/null; then
  echo "ERROR: cargo not found. Install Rust (https://rustup.rs) or set skip_proxy_build=true"
  exit 1
fi

echo "Building RDI proxy..."
cd "${PROXY_DIR}"
cargo build --release
echo "Proxy built at ${TARGET_BINARY}"
exit 0
