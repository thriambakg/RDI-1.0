# KVS WebRTC Module

IAM foundation for the RDI **WebRTC data plane** using [Amazon Kinesis Video Streams signaling channels](https://docs.aws.amazon.com/kinesisvideostreams-webrtc-dg/latest/devguide/webrtc-sig.html).

## What this module provisions

| Resource | Purpose |
|----------|---------|
| `aws_iam_role.session` | Assumed by Lambdas with inline session policy scoped to one channel |
| `aws_iam_policy.session_api` | Session API: create/delete channels + `sts:AssumeRole` |
| `aws_iam_policy.relay_registry_api` | Relay Registry API: `sts:AssumeRole` for Pi MASTER creds |

## What this module does NOT provision

- **Signaling channels** — created per session at runtime by Session API (`CreateSignalingChannel`)
- **Media storage** — not used in Phase 1 (data channel only)
- **ECS / ALB / rdi-proxy** — deprecated WebSocket path

## Usage

```hcl
module "kvs_webrtc" {
  count  = var.data_plane == "webrtc" ? 1 : 0
  source = "./modules/kvs-webrtc"

  project_name              = var.project_name
  environment               = var.environment
  trusted_assumer_role_arns = [
    "arn:aws:iam::ACCOUNT:role/rdi-session-api-staging-us-east-1-execution-role",
    "arn:aws:iam::ACCOUNT:role/rdi-relay-registry-api-staging-us-east-1-execution-role",
  ]
  tags = {}
}
```

The KVS session role **trust policy** must list the Session API and Relay Registry Lambda **execution role** ARNs (not `lambda.amazonaws.com`). Those Lambdas call `sts:AssumeRole` from code to mint scoped viewer/master creds.

Attach policies to Lambdas and set `KVS_WEBRTC_ROLE_ARN = module.kvs_webrtc[0].session_role_arn`.

## Outputs

- `session_role_arn` — pass to `KVS_WEBRTC_ROLE_ARN` env on Session + Relay Registry Lambdas
- `session_api_policy_arn` — attach to Session API Lambda
- `relay_registry_api_policy_arn` — attach to Relay Registry API Lambda
