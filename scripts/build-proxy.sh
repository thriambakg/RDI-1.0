#!/usr/bin/env bash
# Build RDI proxy binary for EC2 deployment.
# Run from repo root or terraform/. Expects repo layout: scripts/build-proxy.sh, src/proxy/.
set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROXY_DIR="${REPO_ROOT}/src/proxy"
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
