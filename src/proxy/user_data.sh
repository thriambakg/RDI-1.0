#!/bin/bash
# RDI Proxy EC2 user_data - install and run proxy binary (infra_version=${infra_version})
set -e
export RDI_PROXY_WS_PORT="${ws_port}"
export RDI_PROXY_HEALTH_PORT="${health_port}"
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
  # ALB health check needs HTTP 200 on health_port; Python relay only has WS on ws_port
  python3 -c "
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(('0.0.0.0', ${health_port}))
s.listen(8)
while True:
    c, _ = s.accept()
    c.recv(4096)
    c.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
    c.close()
" &
  # Placeholder: minimal Python relay for initial testing (replace with Rust binary)
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
  echo "Python placeholder relay and health server on ${health_port} started"
fi

# Ship proxy log to CloudWatch (so you can see connection failures in CloudWatch)
if [ -n "${cloudwatch_log_group}" ]; then
  yum install -y amazon-cloudwatch-agent
  mkdir -p /opt/aws/amazon-cloudwatch-agent/etc
  INSTANCE_ID=$(curl -s http://169.254.169.254/latest/meta-data/instance-id)
  cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json << CWCONF
{
  "agent": { "metrics_collection_interval": 60, "run_as_user": "root" },
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          {
            "file_path": "/var/log/rdi-proxy.log",
            "log_group_name": "${cloudwatch_log_group}",
            "log_stream_name": "$INSTANCE_ID"
          }
        ]
      }
    }
  }
}
CWCONF
  /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json
  echo "CloudWatch agent started; proxy log group ${cloudwatch_log_group}"
fi
