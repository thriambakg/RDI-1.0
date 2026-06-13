# Phase 1: Local WebRTC Data Channel Spike

Prove Pi ↔ browser UDP-like telemetry **without AWS** before using KVS.

## Prerequisites

- Pi and laptop on same Wi‑Fi
- Python 3.11+ on Pi: `pip install aiortc aiohttp`

## Run

**1. Laptop — signaling server**

```bash
cd scripts/webrtc-spike
python signaling_server.py
```

**2. Laptop — open viewer**

Open `viewer.html` in Chrome (file:// or serve via `python -m http.server 8080`).

**3. Pi — master**

```bash
export RDI_SIGNALING_URL=ws://<laptop-ip>:8780
python3 pi_master.py
```

**4. Connect**

- Click **Connect** in the browser.
- Pi auto-joins and sends `TELEM` mock packets every 100ms.
- Browser console shows received messages.

## Data channel settings

```python
channel = pc.createDataChannel("mavlink", ordered=False, maxRetransmits=0)
```

Matches production requirement: unreliable, unordered (UDP-like).

## Next

After this works, deploy terraform (`data_plane=webrtc`) and wire KVS signaling using `POST /sessions` + `/relays/webrtc-master`.
