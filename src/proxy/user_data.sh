#!/bin/bash
# RDI Proxy EC2 user_data - Rust only; wait for S3 binary, run proxy, wait for health (infra_version=${infra_version})
set -e
export RDI_PROXY_WS_PORT="${ws_port}"
export RDI_PROXY_HEALTH_PORT="${health_port}"
export RDI_PROXY_STATUS_PORT="${status_port}"
export RDI_PROXY_STATUS_SECRET="${status_secret}"

yum update -y
yum install -y aws-cli curl

mkdir -p /opt/rdi-proxy
cd /opt/rdi-proxy

touch /var/log/rdi-proxy.log
chmod 644 /var/log/rdi-proxy.log

# Wait for proxy health (http://127.0.0.1:HEALTH_PORT/) with timeout
wait_for_proxy_health() {
  local port="${health_port}"
  local max_attempts=24
  local attempt=1
  while [ "$attempt" -le "$max_attempts" ]; do
    if curl -sf -o /dev/null --connect-timeout 2 "http://127.0.0.1:$${port}/" 2>/dev/null; then
      echo "Proxy health check passed on port $${port} (attempt $attempt)"
      return 0
    fi
    echo "Waiting for proxy health on :$${port} (attempt $attempt/$max_attempts)..."
    sleep 5
    attempt=$((attempt + 1))
  done
  echo "ERROR: Proxy health check did not pass within $((max_attempts * 5))s" >> /var/log/rdi-proxy.log
  return 1
}

# Retry S3 download (pipeline may upload after instance starts)
echo "Waiting for proxy binary in S3..."
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if aws s3 cp "s3://${s3_bucket}/${s3_key}" ./rdi-proxy 2>/dev/null; then
    break
  fi
  if [ "$attempt" -eq 10 ]; then
    echo "Proxy binary not found at s3://${s3_bucket}/${s3_key} after 10 attempts. Build and upload rdi-proxy, then run: sudo /opt/rdi-proxy/update-from-s3.sh" >> /var/log/rdi-proxy.log
    exit 1
  fi
  sleep 30
done

chmod +x ./rdi-proxy

# Update script for pipeline/SSM (templatefile substitutes s3_bucket, s3_key at apply time)
cat > /opt/rdi-proxy/update-from-s3.sh << UPDATEEND
#!/bin/bash
set -e
BUCKET="${s3_bucket}"
KEY="${s3_key}"
cd /opt/rdi-proxy
pkill -f ./rdi-proxy || true
sleep 2
aws s3 cp "s3://\$BUCKET/\$KEY" ./rdi-proxy
chmod +x ./rdi-proxy
nohup ./rdi-proxy >> /var/log/rdi-proxy.log 2>&1 &
echo "Proxy updated and restarted \$(date)"
UPDATEEND
chmod +x /opt/rdi-proxy/update-from-s3.sh

nohup ./rdi-proxy >> /var/log/rdi-proxy.log 2>&1 &
wait_for_proxy_health

# CloudWatch logs
if [ -n "${cloudwatch_log_group}" ]; then
  CWA_LOG="/var/log/cloudwatch-agent-setup.log"
  { set +e
    echo "=== CloudWatch agent setup $(date) ==="
    yum install -y amazon-cloudwatch-agent 2>/dev/null || dnf install -y amazon-cloudwatch-agent 2>/dev/null || echo "WARN: install failed"
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
    CTL="/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl"
    [ -x "$CTL" ] || CTL=$(command -v amazon-cloudwatch-agent-ctl 2>/dev/null)
    if [ -n "$CTL" ] && [ -x "$CTL" ]; then
      $CTL -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json
      echo "CloudWatch agent started"
    fi
  } >> "$CWA_LOG" 2>&1
  set -e
fi
