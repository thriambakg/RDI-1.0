# RDI relay device (Pi / CM4)

Software for a claimed Holybro Pixhawk CM4 relay.

| Script | When |
|--------|------|
| `rdi-relay-claim.py` | Once — pairing code → `/etc/rdi/relay.conf` + `device.json` |
| `rdi-relay-daemon.py` | Always on — polls API, spawns WebRTC master per connection |
| `kvs_master_worker.py` | Per session — started by daemon (do not run manually) |

There is **no over-the-air updater** yet. You copy files to the Pi over SSH (or `scp`) after changing this directory in git.

## Prerequisites on Pi

- Claim completed (`/etc/rdi/relay.conf` and `/etc/rdi/device.json` exist)
- Python 3.11+
- System packages (Debian / Raspberry Pi OS):

```bash
sudo apt-get update
sudo apt-get install -y python3-pip python3-venv python3-boto3 \
  libavformat-dev libavdevice-dev libavfilter-dev libopus-dev libvpx-dev pkg-config
```

`python3-boto3` avoids pip downloading large `botocore` wheels from piwheels (common failure on slow Wi‑Fi).

## Install from your laptop

Replace `relay@RDIRelay.local` with your Pi host.

```bash
cd RDI-1.0/scripts/relay-device

# Copy scripts to Pi
scp rdi-relay-daemon.py kvs_master_worker.py rdi_device_config.py \
  requirements-worker.txt rdi-relay-daemon.service.example \
  relay@RDIRelay.local:/tmp/rdi-install/

# SSH in and install
ssh relay@RDIRelay.local
```

On the Pi:

```bash
sudo apt-get install -y python3-boto3 python3-venv libavformat-dev libavdevice-dev pkg-config

sudo mkdir -p /opt/rdi
sudo cp /tmp/rdi-install/*.py /opt/rdi/
sudo cp /tmp/rdi-install/requirements-worker.txt /opt/rdi/

# --system-site-packages so venv sees apt-installed boto3
sudo python3 -m venv --system-site-packages /opt/rdi/venv
sudo /opt/rdi/venv/bin/pip install --upgrade pip
sudo /opt/rdi/venv/bin/pip install \
  --default-timeout=300 --retries=10 --resume-retries=10 \
  -r /opt/rdi/requirements-worker.txt

sudo cp /tmp/rdi-install/rdi-relay-daemon.service.example /etc/systemd/system/rdi-relay-daemon.service
```

Edit the service file — `ExecStart` must use the venv:

```
ExecStart=/opt/rdi/venv/bin/python3 /opt/rdi/rdi-relay-daemon.py
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now rdi-relay-daemon
sudo journalctl -u rdi-relay-daemon -f
```

### If `pip install` still fails (incomplete-download)

1. **Retry** (pip 24+):

```bash
sudo /opt/rdi/venv/bin/pip install \
  --default-timeout=300 --retries=10 --resume-retries=10 \
  -r /opt/rdi/requirements-worker.txt
```

2. **Skip piwheels** (use PyPI only — can be slower but sometimes more reliable):

```bash
sudo /opt/rdi/venv/bin/pip install \
  --index-url https://pypi.org/simple \
  --default-timeout=300 --retries=10 --resume-retries=10 \
  -r /opt/rdi/requirements-worker.txt
```

3. **Daemon-only test** (no aiortc — proves API polling works):

```bash
cd /opt/rdi
RDI_WORKER_DRY_RUN=1 RDI_POLL_INTERVAL_SEC=3 python3 rdi-relay-daemon.py
```

Uses system Python only; no venv deps required.

4. **Download wheels on your laptop**, copy to Pi, install offline:

```bash
# Laptop (same Python version as Pi if possible, e.g. 3.11)
pip download -r requirements-worker.txt -d ./wheels
scp -r wheels relay@RDIRelay.local:/tmp/rdi-install/
# Pi
sudo /opt/rdi/venv/bin/pip install --no-index --find-links=/tmp/rdi-install/wheels -r /opt/rdi/requirements-worker.txt
```

## Quick test (no WebRTC deps)

```bash
RDI_WORKER_DRY_RUN=1 RDI_POLL_INTERVAL_SEC=3 python3 rdi-relay-daemon.py
```

Create a connection in the console — logs should show `would start worker session_id=...`.

## Updating after code changes

Same as install: `scp` changed files to `/opt/rdi/`, then:

```bash
sudo systemctl restart rdi-relay-daemon
```

Only re-run `pip install` when `requirements-worker.txt` changes.

## Config files

| Path | Contents |
|------|----------|
| `/etc/rdi/relay.conf` | `relay_id`, `api_base_url`, zone (from claim) |
| `/etc/rdi/device.json` | `device_serial`, `device_secret` (from announce) |
