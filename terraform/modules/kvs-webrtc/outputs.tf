output "session_role_arn" {
  description = "IAM role ARN assumed by Lambdas to mint per-channel Master/Viewer STS credentials"
  value       = aws_iam_role.session.arn
}

output "session_role_name" {
  description = "IAM role name for KVS WebRTC session credentials"
  value       = aws_iam_role.session.name
}

output "session_api_policy_arn" {
  description = "Attach to Session API Lambda — channel lifecycle + sts:AssumeRole"
  value       = aws_iam_policy.session_api.arn
}

output "relay_registry_api_policy_arn" {
  description = "Attach to Relay Registry API Lambda — sts:AssumeRole for Pi MASTER creds"
  value       = aws_iam_policy.relay_registry_api.arn
}

output "signaling_channel_arn_pattern" {
  description = "ARN pattern for per-session signaling channels in this region/account"
  value       = local.channel_arn
}
