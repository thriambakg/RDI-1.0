# KVS WebRTC data plane — IAM foundation for per-session signaling channels.
#
# Signaling channels are NOT created here. Session API Lambda creates one channel
# per session at runtime (CreateSignalingChannel) and deletes on session idle/delete.
# This module provisions the STS assume-role used to mint scoped Master/Viewer creds.

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  name_prefix = "${var.project_name}-kvs-webrtc-${var.environment}"
  channel_arn = "arn:aws:kinesisvideo:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:channel/*"
}

# Role assumed by Lambda with inline session policies scoped to a single channel ARN.
resource "aws_iam_role" "session" {
  name = "${local.name_prefix}-session"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = merge(var.tags, {
    Name    = "${local.name_prefix}-session"
    Type    = "IAMRole"
    Purpose = "KVSWebRTCSessionCredentials"
  })
}

resource "aws_iam_role_policy" "session_connect" {
  name = "${local.name_prefix}-session-connect"
  role = aws_iam_role.session.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "kinesisvideo:ConnectAsMaster",
        "kinesisvideo:ConnectAsViewer",
        "kinesisvideo:GetSignalingChannelEndpoint",
        "kinesisvideo:GetIceServerConfig",
        "kinesisvideo:DescribeSignalingChannel",
      ]
      Resource = local.channel_arn
    }]
  })
}

# Session API: create/delete channels + assume session role for STS creds.
resource "aws_iam_policy" "session_api" {
  name        = "${local.name_prefix}-session-api"
  description = "KVS signaling channel lifecycle + STS assume for scoped WebRTC creds"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "kinesisvideo:CreateSignalingChannel",
          "kinesisvideo:DeleteSignalingChannel",
          "kinesisvideo:DescribeSignalingChannel",
          "kinesisvideo:GetSignalingChannelEndpoint",
        ]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["sts:AssumeRole"]
        Resource = [aws_iam_role.session.arn]
      }
    ]
  })

  tags = merge(var.tags, {
    Name    = "${local.name_prefix}-session-api"
    Type    = "IAMPolicy"
    Purpose = "KVSWebRTCSessionAPI"
  })
}

# Relay registry API: assume session role to issue Pi MASTER creds.
resource "aws_iam_policy" "relay_registry_api" {
  name        = "${local.name_prefix}-relay-registry-api"
  description = "STS assume for Pi MASTER WebRTC credentials"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sts:AssumeRole"]
      Resource = [aws_iam_role.session.arn]
    }]
  })

  tags = merge(var.tags, {
    Name    = "${local.name_prefix}-relay-registry-api"
    Type    = "IAMPolicy"
    Purpose = "KVSWebRTCRelayRegistryAPI"
  })
}
