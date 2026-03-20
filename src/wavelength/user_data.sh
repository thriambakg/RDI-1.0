#!/bin/bash
# RDI Wavelength EC2 user_data - install agent binary from S3 (infra_version=${infra_version})
set -e

yum update -y
yum install -y aws-cli

mkdir -p /opt/rdi-agent
cd /opt/rdi-agent

# Create log file so CloudWatch agent can tail it (daemon writes here)
touch /var/log/rdi-agent.log
chmod 644 /var/log/rdi-agent.log

# Wavelength instances can expose zone name as default region; use explicit region for S3.
if aws s3 cp "s3://${s3_bucket}/${s3_key}" ./rdi-agent --region "${aws_region}" 2>/dev/null; then
  chmod +x ./rdi-agent
  echo "RDI agent binary installed at /opt/rdi-agent/rdi-agent"
  # Systemd service: restart on crash, survive reboots
  cat > /etc/systemd/system/rdi-agent.service << SVCEND
[Unit]
Description=RDI tunnel agent - WebSocket bridge to proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/rdi-agent
ExecStart=/opt/rdi-agent/rdi-agent
Environment="RDI_MAVLINK_PORT=${mavlink_port}"
Environment="RDI_INSECURE_TLS=${insecure_tls}"
StandardOutput=append:/var/log/rdi-agent.log
StandardError=append:/var/log/rdi-agent.log
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SVCEND
  systemctl daemon-reload
  systemctl enable rdi-agent
  systemctl start rdi-agent
  echo "RDI agent daemon started via systemd (API on 127.0.0.1:8080)"
  # Script to update binary from S3 without replacing the instance (run via SSM or SSH: sudo /opt/rdi-agent/update-from-s3.sh)
  cat > /opt/rdi-agent/update-from-s3.sh << UPDATEEND
#!/bin/bash
set -e
BUCKET="${s3_bucket}"
KEY="${s3_key}"
REGION="${aws_region}"
cd /opt/rdi-agent
aws s3 cp "s3://\$BUCKET/\$KEY" ./rdi-agent --region "\$REGION"
chmod +x ./rdi-agent
systemctl restart rdi-agent
echo "Agent updated and restarted \$(date)"
UPDATEEND
  chmod +x /opt/rdi-agent/update-from-s3.sh
else
  echo "Agent binary not found at s3://${s3_bucket}/${s3_key} - upload and start daemon manually"
fi

# Ship agent log to CloudWatch (run without set -e so failures are logged, not fatal)
if [ -n "${cloudwatch_log_group}" ]; then
  CWA_LOG="/var/log/cloudwatch-agent-setup.log"
  { set +e
    echo "=== CloudWatch agent setup $(date) ==="
    yum install -y amazon-cloudwatch-agent 2>/dev/null || dnf install -y amazon-cloudwatch-agent 2>/dev/null || echo "WARN: install failed"
    mkdir -p /opt/aws/amazon-cloudwatch-agent/etc
    INSTANCE_ID=$(curl -s --connect-timeout 2 http://169.254.169.254/latest/meta-data/instance-id 2>/dev/null)
    [ -z "$INSTANCE_ID" ] && INSTANCE_ID="wavelength-$(hostname)-$(date +%s)"
    cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json << CWCONF
{
  "agent": { "metrics_collection_interval": 60, "run_as_user": "root" },
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          {
            "file_path": "/var/log/rdi-agent.log",
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
      echo "CloudWatch agent started (ctl=$CTL)"
    else
      echo "ERROR: amazon-cloudwatch-agent-ctl not found"
    fi
  } >> "$CWA_LOG" 2>&1
  set -e
  echo "[user_data] CloudWatch agent setup done; see $CWA_LOG if no logs in CloudWatch" >> /var/log/rdi-agent.log
fi
