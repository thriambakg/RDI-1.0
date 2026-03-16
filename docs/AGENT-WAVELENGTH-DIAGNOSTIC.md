# "No agent connected" diagnostic guide

When the ping shows **Proxy reached; no agent on Wavelength instance** (or "2. Wavelength: no agent connected"), the WebSocket path to the proxy works but the agent on the Wavelength EC2 instance is not connected to the proxy for this session. Use this guide to find and fix the cause.

## Important: create a new connection after redeploy

The agent is started **only when a session is created** (POST /sessions). If you redeployed Terraform (e.g. fixed `WAVELENGTH_ZONE_ID`), existing sessions were created **before** the fix — Lambda never ran the agent start for them. **Create a brand-new connection** (new session) from the UI after redeploy, then ping that new connection. Do not reuse an old connection’s details.

## CloudWatch Logs

### Session API Lambda

The Session API Lambda logs to **CloudWatch Logs**. You can see whether the agent was started and why not.

**Log group:** `/aws/lambda/rdi-session-api-staging-<region>` (e.g. `/aws/lambda/rdi-session-api-staging-us-east-1`).

**Filter for:** `[RDI Session]` to see agent-related lines.

**What you’ll see:**

| Log message | Meaning |
|-------------|--------|
| `[RDI Session] starting agent session_id=... wavelength_zone_id=... WAVELENGTH_ZONE_ID=...` | Zone matched; Lambda is calling SSM to start the agent. |
| `[RDI Session] SSM SendCommand started agent session_id=... command_id=...` | SSM command was sent; check the instance for the agent process and `/var/log/rdi-agent.log`. |
| `[RDI Session] SSM SendCommand failed session_id=... error=...` | SSM failed (permissions, instance not in SSM, etc.). |
| `[RDI Session] agent not started (zone mismatch) session_id=... request_zone=... deployed_zone=...` | Request zone (from frontend) did not match deployed zone; agent not started. |
| `[RDI Session] agent start skipped: missing ...` | Lambda env missing `WAVELENGTH_INSTANCE_ID` or `PROXY_ENDPOINT`. |

**How to view:** AWS Console → CloudWatch → Log groups → open the log group above → Log streams (pick the latest) or use **Filter log events** with filter pattern `[RDI Session]`. Or use CLI: `aws logs filter-log-events --log-group-name /aws/lambda/rdi-session-api-staging-us-east-1 --filter-pattern "[RDI Session]" --start-time <timestamp_ms>`.

### Proxy and Agent (EC2 instances)

After deploying with the CloudWatch agent (Terraform ships `/var/log/rdi-proxy.log` and `/var/log/rdi-agent.log` to CloudWatch), you can see **why the connection is failing** directly in CloudWatch:

| Log group | Contents |
|-----------|----------|
| `/rdi/<env>/proxy` (e.g. `/rdi/staging/proxy`) | Proxy stdout: handshakes, **"session_id=... frontend connected but no agent; PING returned no agent"**, disconnects. |
| `/rdi/<env>/agent` (e.g. `/rdi/staging/agent`) | Agent stdout: **"Connecting to ... session=..."**, **"Failed to connect to proxy ... error=..."** or **"Connected to proxy session=..."**. |

**Log streams** are the instance ID (one stream per instance), so you can see which proxy or Wavelength instance produced the log.

- If the **proxy** log shows `session_id=... frontend connected but no agent` for your session, the frontend reached the proxy but no agent has connected with that session_id (Lambda didn’t start it, or it failed to connect).
- If the **agent** log shows `Failed to connect to proxy url=... error=...`, the agent ran but could not reach the proxy (network, DNS, TLS, or wrong URL).

**How to view:** CloudWatch → Log groups → `/rdi/staging/proxy` or `/rdi/staging/agent` → open a log stream (instance ID) or use **Filter log events** with a pattern like `no agent` or `Failed to connect`.

## Run CLI diagnostics

From the repo root (with AWS CLI configured and `us-east-1` or your region):

```powershell
.\scripts\agent-wavelength-diagnostics.ps1
# Or: .\scripts\agent-wavelength-diagnostics.ps1 -Region us-east-1
```

The script will:

1. **List running EC2 instances** — Confirm the Wavelength instance exists and is running.
2. **Session API Lambda env** — Show `WAVELENGTH_INSTANCE_ID`, `PROXY_ENDPOINT`, `WAVELENGTH_ZONE_ID`. If `WAVELENGTH_INSTANCE_ID` is empty, Lambda never starts the agent.
3. **SSM managed instances** — The Wavelength instance must appear here (Ping: Online) for Lambda’s SSM SendCommand to work.
4. **Agent on instance** — Run an SSM command to check for `rdi-agent` process and tail `/var/log/rdi-agent.log`.

## Common causes and fixes

### 1. WAVELENGTH_INSTANCE_ID not set in Lambda

**Symptom:** Script shows `WAVELENGTH_INSTANCE_ID =` empty.

**Cause:** Session API Lambda was deployed without a Wavelength EC2 (e.g. `wavelength_zone_id` was empty or module not created).

**Fix:** Deploy with Wavelength enabled (set `wavelength_zone_id` in tfvars, apply). Ensure `module.wavelength_ec2` has count 1 so Lambda gets `WAVELENGTH_INSTANCE_ID`.

### 2. Wavelength instance not in SSM (Ping: not Online)

**Symptom:** Instance appears in EC2 list but not in "SSM managed instances", or Ping status is not Online.

**Cause:** SSM agent not running, instance not registered (wrong IAM role, no outbound to SSM endpoints, or instance just started).

**Fix:** Ensure the Wavelength instance has the SSM-managed instance IAM role and can reach SSM (e.g. VPC endpoint or internet). Wait a few minutes after boot. Check user_data installs and starts the agent binary; SSM agent is usually preinstalled on Amazon Linux.

### 3. Agent not started or crashed (no process / errors in log)

**Symptom:** SSM command shows no `rdi-agent` process or errors in `/var/log/rdi-agent.log`.

**Cause:** Lambda runs SSM SendCommand only when a **session is created** (POST sessions). If you opened an existing session or the command failed silently, the agent may never have been started. Or the agent started but crashed (e.g. wrong `RDI_PROXY_URL`, connection refused).

**Fix:**

- **Start agent for current session:** Create a **new** session from the UI (or POST sessions with the same edge zone). Lambda will call `_start_agent_on_wavelength(instance_id, proxy_url, session_id)`.
- **Session ID must match:** Frontend connects with `frontend:<session_id>`, agent must connect with `agent:<session_id>`. Lambda passes the same `session_id` when starting the agent. If you’re pinging on an old session, create a new session and ping again.
- **Check log on instance:** Use SSM Session Manager to open a shell and run:
  - `pgrep -a rdi-agent`
  - `tail -100 /var/log/rdi-agent.log`
  - If connection errors: ensure `PROXY_ENDPOINT` is reachable from the instance (e.g. `wss://wss.rdistaging.com`).

### 4. Wrong Wavelength zone for session (or zone ID vs name mismatch)

**Symptom:** Lambda has `WAVELENGTH_ZONE_ID` set and the session was created with the correct zone in the UI, but the agent still doesn’t start.

**Cause:** The frontend sends the **Zone ID** (e.g. `use1-wl1-chi-wlz1`); Lambda must compare it to the same format. If Lambda was given the **Zone Name** (e.g. `us-east-1-wl1-chi-wlz-1`) instead of the Zone ID, the values never match and the agent is never started. Terraform should set `WAVELENGTH_ZONE_ID` to the Zone ID (e.g. from `edge_zone_ids[0]`), not `wavelength_zone_id` (Zone Name).

**Fix:** Ensure Terraform passes the Zone **ID** to Lambda (e.g. `WAVELENGTH_ZONE_ID = var.edge_zone_ids[0]` when using a single Wavelength zone). Apply, then create a new session with that edge zone selected.

### 5. Agent binary missing on instance

**Symptom:** Log shows "agent binary not found" or SSM command fails to run `/opt/rdi-agent/rdi-agent`.

**Cause:** Wavelength user_data downloads the agent from S3; if the bucket/key is wrong or the instance has no IAM permission, the binary is missing.

**Fix:** Ensure Terraform uploads the agent to S3 and the Wavelength instance role has `s3:GetObject` for that bucket/key. Re-run user_data or replace the instance so the binary is installed.

## Quick checklist

- [ ] EC2 shows the Wavelength instance running.
- [ ] Lambda env has `WAVELENGTH_INSTANCE_ID` and `PROXY_ENDPOINT` set.
- [ ] Instance appears in SSM with Ping: Online.
- [ ] Session was **created** (POST) after instance was ready (Lambda starts agent on create).
- [ ] Session’s edge zone matches the zone of the Wavelength instance.
- [ ] On instance: `rdi-agent` process exists and `/var/log/rdi-agent.log` has no connection errors.
