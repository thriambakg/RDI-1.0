#!/usr/bin/env bash
# Push relay-device package to Pi and install in one command (run from your laptop).
#
# Usage:
#   ./deploy-to-pi.sh relay@RDIRelay.local
#   ./deploy-to-pi.sh relay@192.168.1.50
#
set -euo pipefail

HOST="${1:-}"
if [[ -z "${HOST}" ]]; then
  echo "Usage: $0 relay@<pi-host>"
  exit 1
fi

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FILES=(
  rdi-relay-daemon.py
  kvs_master_worker.py
  rdi_device_config.py
  rdi-relay-claim.py
  radio_hop_protocol.py
  radio_serial_bridge.py
  radio_mavlink_bridge.py
  radio_router_server.py
  radio_router_client.py
  radio_telem_smoke_test.py
  radio_ping_desktop_agent.py
  requirements-worker.txt
  pi-install.sh
)

echo "==> Packaging RDI relay-device for ${HOST}"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

for f in "${FILES[@]}"; do
  cp "${DIR}/${f}" "${TMP}/"
done
chmod +x "${TMP}/pi-install.sh"

echo "==> Uploading and installing on Pi..."
tar czf - -C "${TMP}" . | ssh "${HOST}" 'sudo mkdir -p /tmp/rdi-package && sudo tar xzf - -C /tmp/rdi-package && sudo bash /tmp/rdi-package/pi-install.sh'

echo "==> Done. Tail logs:"
echo "    ssh ${HOST} 'sudo journalctl -u rdi-relay-daemon -f'"
