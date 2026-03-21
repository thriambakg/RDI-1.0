#!/usr/bin/env bash
# Build RDI agent binary for Wavelength EC2 deployment.
# Run from repo root or terraform/. Expects repo layout: scripts/build-agent.sh, src/agent/.
set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="${REPO_ROOT}/src/agent"
TARGET_BINARY="${AGENT_DIR}/target/release/rdi-agent"

if [ -x "${TARGET_BINARY}" ]; then
  echo "Agent binary already exists at ${TARGET_BINARY}, skipping build"
  exit 0
fi

if ! command -v cargo &>/dev/null; then
  echo "ERROR: cargo not found. Install Rust (https://rustup.rs) or set skip_agent_build=true"
  exit 1
fi

echo "Building RDI agent..."
cd "${AGENT_DIR}"
cargo build --release
echo "Agent built at ${TARGET_BINARY}"
exit 0
