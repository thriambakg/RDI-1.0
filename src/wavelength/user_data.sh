#!/bin/bash
# RDI Wavelength EC2 user_data - install agent binary from S3 for session connections.
# Agent is started per-session via Lambda (SSM SendCommand); this only installs the binary.
set -e

yum update -y
yum install -y aws-cli

mkdir -p /opt/rdi-agent
cd /opt/rdi-agent

if aws s3 cp "s3://${s3_bucket}/${s3_key}" ./rdi-agent 2>/dev/null; then
  chmod +x ./rdi-agent
  echo "RDI agent binary installed at /opt/rdi-agent/rdi-agent"
else
  echo "Agent binary not found at s3://${s3_bucket}/${s3_key} - Lambda will start agent when session is created"
fi
