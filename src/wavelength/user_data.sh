#!/bin/bash
# RDI Wavelength EC2 user_data - install agent binary from S3 (infra_version=${infra_version})
set -e

yum update -y
yum install -y aws-cli jq

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
  # Script to reinstate active sessions after agent reboot (queries DynamoDB ZoneIndex, POSTs to agent API)
  cat > /opt/rdi-agent/reinstate-sessions.sh << REINSTATEEND
#!/bin/bash
# Reinstate active sessions to agent after reboot. Requires: connection_pool_table, proxy_endpoint, wavelength_zone_id, aws_region
set +e  # Don't exit on reinstate failures - agent is already up
CONNECTION_POOL_TABLE="${connection_pool_table}"
PROXY_ENDPOINT="${proxy_endpoint}"
WAVELENGTH_ZONE_ID="${wavelength_zone_id}"
RELAY_REGISTRY_TABLE="${relay_registry_table}"
AWS_REGION="${aws_region}"
DEFAULT_MAVLINK_PORT="${mavlink_port}"
AGENT_PORT="8080"

if [ -z "\$CONNECTION_POOL_TABLE" ] || [ -z "\$PROXY_ENDPOINT" ] || [ -z "\$WAVELENGTH_ZONE_ID" ] || [ -z "\$AWS_REGION" ]; then
  echo "[reinstate] Skipping: missing CONNECTION_POOL_TABLE, PROXY_ENDPOINT, WAVELENGTH_ZONE_ID, or AWS_REGION"
  exit 0
fi

# Ensure jq for JSON parsing
command -v jq >/dev/null 2>&1 || (yum install -y jq 2>/dev/null || dnf install -y jq 2>/dev/null || true)
if ! command -v jq >/dev/null 2>&1; then
  echo "[reinstate] jq not available, skipping session reinstate"
  exit 0
fi

# Wait for agent API to be ready
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -s -o /dev/null -w "%%{http_code}" "http://127.0.0.1:\$AGENT_PORT/health" 2>/dev/null | grep -q 200; then
    break
  fi
  sleep 2
done

RESP=$(aws dynamodb query \
  --table-name "\$CONNECTION_POOL_TABLE" \
  --index-name "ZoneIndex" \
  --key-condition-expression "wavelength_zone_id = :zone" \
  --filter-expression "#s = :active" \
  --expression-attribute-names '{"#s":"status"}' \
  --expression-attribute-values "{\":zone\":{\"S\":\"\$WAVELENGTH_ZONE_ID\"},\":active\":{\"S\":\"active\"}}" \
  --region "\$AWS_REGION" \
  --output json 2>/dev/null)

if [ -z "\$RESP" ]; then
  echo "[reinstate] DynamoDB query failed (check IAM or table)"
  exit 0
fi

COUNT=\$(echo "\$RESP" | jq -r '.Items | length')
echo "[reinstate] Found \$COUNT active session(s) for zone \$WAVELENGTH_ZONE_ID"

echo "\$RESP" | jq -c '.Items[]' | while read -r item; do
  SESSION_ID=\$(echo "\$item" | jq -r '.session_id.S // empty')
  RELAY_ID=\$(echo "\$item" | jq -r '.relay_id.S // empty')
  USER_ID=\$(echo "\$item" | jq -r '.user_id.S // empty')
  ENDPOINT=\$(echo "\$item" | jq -r '.endpoint.S // empty')
  METADATA=\$(echo "\$item" | jq -r '.metadata.S // "{}"')
  [ -z "\$SESSION_ID" ] && continue

  PROXY_URL="\$ENDPOINT"
  [ -z "\$PROXY_URL" ] && PROXY_URL="\$PROXY_ENDPOINT"
  [ -z "\$PROXY_URL" ] && continue

  MAVLINK_HOST="127.0.0.1"
  MAVLINK_PORT="\$DEFAULT_MAVLINK_PORT"
  if [ -n "\$METADATA" ] && [ "\$METADATA" != "{}" ]; then
    P=\$(echo "\$METADATA" | jq -r '.mavlink_port // empty')
    [ -n "\$P" ] && MAVLINK_PORT="\$P"
  fi

  # Skip local relays (agent runs on user machine, not Wavelength)
  if [ -n "\$RELAY_ID" ] && [ -n "\$RELAY_REGISTRY_TABLE" ] && [ -n "\$USER_ID" ]; then
    RELAY_ITEM=\$(aws dynamodb get_item \
      --table-name "\$RELAY_REGISTRY_TABLE" \
      --key "{\"wavelength_zone_id\":{\"S\":\"\$WAVELENGTH_ZONE_ID\"},\"relay_id\":{\"S\":\"\$RELAY_ID\"}}" \
      --region "\$AWS_REGION" \
      --output json 2>/dev/null)
    RELAY_USER=\$(echo "\$RELAY_ITEM" | jq -r '.Item.user_id.S // empty')
    if [ "\$RELAY_USER" != "\$USER_ID" ]; then
      continue
    fi
    RELAY_TYPE=\$(echo "\$RELAY_ITEM" | jq -r '.Item.relay_type.S // "sim_relay"')
    if [ "\$RELAY_TYPE" = "local" ]; then
      echo "[reinstate] Skipping session \$SESSION_ID (local relay)"
      continue
    fi
    CONFIG=\$(echo "\$RELAY_ITEM" | jq -r '.Item.config.S // "{}"')
    if [ -n "\$CONFIG" ] && [ "\$CONFIG" != "{}" ]; then
      H=\$(echo "\$CONFIG" | jq -r '.mavlink_host // empty')
      [ -n "\$H" ] && MAVLINK_HOST="\$H"
    fi
  fi

  BODY="{\"session_id\":\"\$SESSION_ID\",\"proxy_url\":\"\$PROXY_URL\",\"mavlink_host\":\"\$MAVLINK_HOST\",\"mavlink_port\":\$MAVLINK_PORT}"
  HTTP=\$(curl -s -o /dev/null -w "%%{http_code}" -X POST "http://127.0.0.1:\$AGENT_PORT/sessions" \
    -H "Content-Type: application/json" -d "\$BODY" 2>/dev/null)
  if [ "\$HTTP" = "201" ] || [ "\$HTTP" = "200" ]; then
    echo "[reinstate] Reinstated session \$SESSION_ID"
  else
    echo "[reinstate] Failed to reinstate \$SESSION_ID (HTTP \$HTTP)"
  fi
done
echo "[reinstate] Done"
REINSTATEEND
  chmod +x /opt/rdi-agent/reinstate-sessions.sh

  systemctl daemon-reload
  systemctl enable rdi-agent
  systemctl start rdi-agent
  echo "RDI agent daemon started via systemd (API on 127.0.0.1:8080)"
  # Reinstate active sessions on first boot (same as after update-from-s3)
  sleep 6
  /opt/rdi-agent/reinstate-sessions.sh >> /var/log/rdi-agent.log 2>&1 || true

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
# Reinstate active sessions from DynamoDB so users don't lose connections on reboot
sleep 6
/opt/rdi-agent/reinstate-sessions.sh >> /var/log/rdi-agent.log 2>&1 || true
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
