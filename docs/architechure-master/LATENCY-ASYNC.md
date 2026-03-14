# Latency and Async API Recommendations

## Current Architecture

- **Session API**: Python Lambda behind API Gateway (Cognito auth). Create/release/get sessions, returns proxy endpoint.
- **Real-time control path**: Frontend → WebSocket → Proxy (EC2) → Agent → PX4. No API Gateway in this path.
- **Session API is not in the real-time loop**; it's used for session provisioning (create, get, release).

## Latency Sources (Session API)

| Source            | Typical latency  | Mitigation                    |
|-------------------|------------------|-------------------------------|
| Lambda cold start | 100–500 ms       | Provisioned concurrency       |
| API Gateway       | 10–30 ms         | Minimal; HTTP/2 may help      |
| DynamoDB          | 5–20 ms          | Already low                   |
| Cognito auth      | ~5 ms            | Cached in API Gateway         |

## Option 1: Lambda Optimizations (Quick Wins)

1. **Provisioned concurrency** – Keeps one or more instances warm; removes cold start for baseline traffic.
2. **Python async** – Use `aioboto3` and `async def lambda_handler` for concurrent DynamoDB calls (helpful if you add more parallel ops).
3. **Power tuning** – 512 MB–1 GB often balances cold start vs throughput.

## Option 2: Async Rust Session API on EC2 (Recommended for Low Latency)

Run the Session API on the **same EC2 instance as the proxy** to:

- Remove Lambda cold start
- Reduce network hops (API Gateway → Lambda → DynamoDB vs LB → EC2 → DynamoDB)
- Co-locate with the proxy for simpler ops and lower latency

### Design

```
[Frontend] --HTTPS--> [ALB/API GW] --> [EC2: Proxy (WS) + Session API (HTTP)]
                                              |
                                              v
                                         [DynamoDB]
```

- **Stack**: axum (async HTTP) + aws-sdk-dynamodb (async)
- **Endpoints**: Same as Lambda – POST /sessions, DELETE /sessions, GET /sessions
- **Auth**: Validate Cognito JWT in the service, or use API Gateway authorizer in front of ALB

### Implementation

See `src/session-api-rs/` for a minimal async Rust Session API. It can run alongside the proxy:

```bash
# On EC2: proxy on :8765, session API on :8080
./rdi-proxy &           # WebSocket
./rdi-session-api &     # REST
```

### Terraform Changes

- Add ALB or route API Gateway to EC2 (or use API Gateway HTTP API with VPC Link).
- Give EC2 IAM role DynamoDB access (connection pool table).
- Optional: move Cognito validation into the Rust service or keep at API Gateway.

## Option 3: Merge Session API into Proxy Binary

Run both WebSocket and HTTP in one process (e.g. axum serving `/sessions` and a separate WebSocket upgrade path). Simplest deployment; one binary, one port or two paths.

## Summary

| Approach              | Effort | Latency impact      |
|-----------------------|--------|---------------------|
| Lambda provisioned    | Low    | Removes cold start  |
| Rust API on EC2       | Medium | ~50–200 ms saved    |
| Merge into proxy      | Medium | Same as above       |
