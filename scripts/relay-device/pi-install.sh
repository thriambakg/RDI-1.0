#!/usr/bin/env bash
# Install or update RDI relay software on the Pi. Run on-device (or via deploy-to-pi.sh).
set -euo pipefail

INSTALL_DIR="${RDI_INSTALL_DIR:-/opt/rdi}"
SERVICE_NAME="rdi-relay-daemon"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root: sudo bash pi-install.sh"
  exit 1
fi

echo "==> RDI Pi install (target: ${INSTALL_DIR})"

apt-get update -qq
apt-get install -y -qq python3 python3-pip python3-venv python3-boto3 \
  libavformat-dev libavdevice-dev libavfilter-dev libopus-dev libvpx-dev pkg-config

mkdir -p "${INSTALL_DIR}"
for f in rdi-relay-daemon.py kvs_master_worker.py rdi_device_config.py rdi-relay-claim.py \
  radio_hop_protocol.py radio_serial_bridge.py radio_mavlink_bridge.py \
  radio_router_server.py radio_router_client.py \
  radio_telem_smoke_test.py radio_ping_desktop_agent.py \
  requirements-worker.txt; do
  if [[ ! -f "${SCRIPT_DIR}/${f}" ]]; then
    echo "Missing ${SCRIPT_DIR}/${f}"
    exit 1
  fi
  install -m 0644 "${SCRIPT_DIR}/${f}" "${INSTALL_DIR}/${f}"
done

if [[ ! -d "${INSTALL_DIR}/venv" ]]; then
  python3 -m venv --system-site-packages "${INSTALL_DIR}/venv"
fi
"${INSTALL_DIR}/venv/bin/pip" install --upgrade pip -q
"${INSTALL_DIR}/venv/bin/pip" install \
  --default-timeout=300 --retries=10 \
  -r "${INSTALL_DIR}/requirements-worker.txt" -q

PYTHON="${INSTALL_DIR}/venv/bin/python3"
cat >"/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=RDI relay daemon (WebRTC session workers)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
Environment=PYTHONUNBUFFERED=1
EnvironmentFile=-/etc/rdi/radio.env
ExecStart=${PYTHON} ${INSTALL_DIR}/rdi-relay-daemon.py
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"

echo "==> Installed. Status:"
systemctl --no-pager status "${SERVICE_NAME}" || true
echo ""
echo "Logs: sudo journalctl -u ${SERVICE_NAME} -f"
