#!/bin/bash
# RDI Proxy EC2 user_data - install and run proxy binary
set -e
export RDI_PROXY_WS_PORT="${ws_port}"
export RDI_PROXY_STATUS_PORT="${status_port}"
export RDI_PROXY_STATUS_SECRET="${status_secret}"

yum update -y
yum install -y aws-cli

mkdir -p /opt/rdi-proxy
cd /opt/rdi-proxy

# Download proxy binary from S3 if available
if aws s3 cp "s3://${s3_bucket}/${s3_key}" ./rdi-proxy 2>/dev/null; then
  chmod +x ./rdi-proxy
  nohup ./rdi-proxy > /var/log/rdi-proxy.log 2>&1 &
  echo "Proxy started from S3"
else
  echo "Proxy binary not found in S3 - build and upload rdi-proxy to s3://${s3_bucket}/${s3_key}"
  # Placeholder: install minimal Python relay for initial testing (replace with Rust binary)
  cat > /opt/rdi-proxy/relay.py << 'PYRELAY'
import asyncio, websockets
async def relay(ws, path):
    async for msg in ws:
        await ws.send(msg)
async def main():
    async with websockets.serve(relay, "0.0.0.0", ${ws_port}):
        await asyncio.Future()
asyncio.run(main())
PYRELAY
  yum install -y python3 python3-pip
  pip3 install websockets
  nohup python3 /opt/rdi-proxy/relay.py > /var/log/rdi-proxy.log 2>&1 &
  echo "Python placeholder relay started"
fi
