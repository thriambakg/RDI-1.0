# WebSocket / ALB Connection Diagnostic Guide

When the frontend fails to establish a WebSocket to the ALB (`wss://rdi-alb-v2-staging-....elb.amazonaws.com/` or `wss://wss.rdistaging.com/`) with **code 1006, neverOpened**, use this checklist to find the root cause.

## 0. Custom domain `wss.rdistaging.com` (staging)

If the session API returns `wss://wss.rdistaging.com/` and the connection **never opens** (timeout, `onopenNeverFired`, code 1006), the problem is **not** the frontend — it is one of the following.

**CLI script:** From the repo root, run all checks (target health, listeners, SGs, DNS, TLS) with:
```powershell
# PowerShell (staging uses us-east-1)
.\scripts\websocket-alb-checks.ps1
# Or specify region: .\scripts\websocket-alb-checks.ps1 -Region us-east-1
```
Requires AWS CLI configured and network access.

**Run these in order:**

1. **DNS** — Does `wss.rdistaging.com` resolve to your ALB?
   ```bash
   nslookup wss.rdistaging.com
   # or
   dig +short wss.rdistaging.com
   ```
   If it fails or points elsewhere: ensure the **rdistaging.com** NS records at your registrar match the Terraform output `wss_custom_domain_name_servers`, and that Terraform created the A record (e.g. `terraform output` then check Route53 → Hosted zone `rdistaging.com` → record `wss.rdistaging.com`).

2. **Target group health** — ALB will not forward if no target is Healthy.
   ```bash
   aws elbv2 describe-target-groups --query 'TargetGroups[?contains(TargetGroupName, `rdi`) && contains(TargetGroupName, `staging`)].{Name:TargetGroupName,Arn:TargetGroupArn}' --output table
   # Use the TG ARN from above:
   aws elbv2 describe-target-health --target-group-arn <TG_ARN> --query 'TargetHealthDescriptions[*].TargetHealth.State' --output text
   ```
   You want at least one `healthy`. If `unhealthy`, fix the proxy (ports 8765/8766, security groups, process running).

3. **ALB has HTTPS:443** — Browsers use `wss://` (port 443). If the ALB only has HTTP:80, the connection will never establish.
   ```bash
   aws elbv2 describe-load-balancers --query 'LoadBalancers[?contains(LoadBalancerName, `rdi`)].LoadBalancerArn' --output text
   aws elbv2 describe-listeners --load-balancer-arn <ALB_ARN> --query 'Listeners[*].{Port:Port,Protocol:Protocol}' --output table
   ```
   You must see **443 / HTTPS**. If you only see 80, the domain module’s ACM certificate may not have been validated (check ACM and Route53 validation records; NS at registrar must point to the hosted zone).

4. **TLS from your machine** — Confirm the ALB (or the hostname) accepts TLS on 443.
   ```bash
   curl -vI --connect-timeout 10 https://wss.rdistaging.com/
   ```
   If this fails, the issue is DNS, network, or TLS (cert/hostname). If it succeeds, the issue is likely target health or WebSocket upgrade.

---

## 0b. "Connection timed out (15s)" then "Connection closed (code 1006)"

**What you see:** In the UI, the connection stays "Connecting…" then turns red with "Connection failed" and a message like "Connection timed out (15s)" or "Connection could not be established (code 1006)". In the browser console: `[RDI SessionWS] openSession: connection timeout` then `onclose { code: 1006, hadOpened: false }`.

**What it means:** The WebSocket **never reached OPEN**. The browser started the connection to `wss://...` but no handshake completed within 15 seconds. The frontend then closes the socket (so you may also see "WebSocket is closed before the connection is established"). Code **1006** = abnormal closure, no close frame from the server — typical when the connection never fully established (ALB/proxy never completed the WebSocket upgrade).

**Root cause is infrastructure**, not the frontend. The request either never reached the proxy, or the proxy/ALB did not complete the WebSocket upgrade. Follow the checks in **section 0** (DNS, target health, ALB listener 443, TLS) and **sections 1–5** (target group health, listener, security groups, certificate, proxy process). Most often: **target group Unhealthy** (ALB won’t forward) or **no HTTPS:443 listener** (browser uses wss → 443).

**Retry:** After fixing infra, use the **Retry connection** button in the Connection details dialog, or close and reopen the dialog to trigger a fresh connection.

---

## 1. Target group health (most common)

**Symptom:** Connection never opens; 1006 after ~100ms–8s.

**Check:**
- AWS Console → **EC2 → Target Groups** → select the RDI staging target group (name like `rdi-...-tg-v2-staging`).
- Open the **Targets** tab.
- **Expected:** At least one target with status **Healthy**.
- **If Unhealthy or no targets:** The ALB will not forward traffic. Fix health checks first.

**Why it fails:** Health checks use port **8766**; the ALB security group must allow egress to 8766 (see `alb_egress_health_check` in `terraform/modules/alb/main.tf`). If that rule was missing, targets stay Unhealthy.

**Fix:** Ensure `terraform apply` has been run with the ALB module that includes the health-check egress rule. Wait 1–2 health check intervals (e.g. 30–60s) for the proxy instance to become Healthy.

**Proxy must listen on port 8766:** The ALB health check uses **HTTP GET /** on port **8766**. The Rust proxy binary listens on 8766 by default. If the instance fell back to the Python placeholder (binary not in S3), user_data now starts a minimal HTTP server on 8766 so the target becomes healthy. **To force full recreation** of proxy and ALB: set `infra_version = 0`, apply (removes resources), then set `infra_version = 1` (or bump the number) and apply again (creates fresh resources). Or SSH/SSM in and start an HTTP server on 8766 that returns 200 for GET /.

**ALB security group must have egress:** The ALB needs **egress** to the VPC on **8765** (traffic) and **8766** (health check). If the ALB SG has no egress rules, health checks will always fail. In AWS Console → EC2 → Security Groups → `rdi-alb-sg-v2-staging`, ensure there are egress rules to the VPC CIDR (e.g. 10.200.0.0/16) for ports 8765 and 8766. Then run `terraform apply` so Terraform (re)creates the rules and keeps them in sync.

**Unhealthy target group – quick checks:** If the target shows **Unhealthy** in the Targets tab, use the **Reason** column (e.g. "Health checks failed") to confirm it’s the health check. Then:

1. **On the proxy instance** (SSH or Session Manager): run `curl -I http://localhost:8766`. You should get `HTTP/1.1 200 OK`. If it fails or times out, nothing is listening on 8766 — the proxy process didn’t start or crashed. Check `/var/log/rdi-proxy.log` and ensure user_data completed (binary from S3 or Python fallback with the health server on 8766).
2. **Security groups:** ALB SG must have **egress** to the proxy VPC CIDR on **8766** (and 8765). Proxy SG must allow **ingress** from the proxy VPC CIDR (or the ALB’s source range) on **8766**. If the proxy is in a separate VPC from the ALB, the proxy’s `vpc_cidr` must include the ALB subnet(s) so health checks from the ALB are allowed in.

After fixing (e.g. ensuring 8766 responds on the instance and SGs are correct), wait 1–2 health check intervals (e.g. 30–60s) for the target to turn Healthy; then retry the WebSocket connection.

---

## 1b. Granular logs for the ping flow (ALB → proxy → agent)

To see exactly where the ping flow stops (ALB, proxy, or agent), use these logs.

**Proxy EC2 (CloudWatch)**  
- **Log group:** `/rdi/<env>/proxy` (e.g. `/rdi/staging/proxy`).  
- **Log stream:** instance ID of the proxy.  
- **What you’ll see (in order when a frontend pings):**
  - `Frontend connected session_id=... addr=...` — WebSocket reached the proxy.
  - `PING received session_id=... forwarding to agent` — Proxy got PING and has an agent; it forwards to the agent.
  - `PING round-trip complete session_id=... agent responded` — Agent replied; frontend gets "instance responded".
  - If there is **no** agent: `PING received session_id=... no agent connected; replying no agent` — frontend gets "no agent connected".

**Agent (Wavelength EC2) (CloudWatch)**  
- **Log group:** `/rdi/<env>/agent` (e.g. `/rdi/staging/agent`).  
- **Log stream:** instance ID of the Wavelength instance.  
- Look for `Connected to proxy` or `Failed to connect to proxy` to see if the agent reached the proxy.

**ALB (request-level)**  
- ALB does not write to CloudWatch Logs by default. To see each request (including WebSocket upgrades) to the ALB, enable **access logs** to S3: set `enable_access_logs = true` and provide an `access_logs_bucket` (with the required ALB bucket policy). Then inspect the S3 prefix (e.g. `alb-access-logs/`) for request timestamps, client IP, target, and status codes.

**Where to find log files**

| Where | What |
|-------|------|
| **CloudWatch (proxy)** | Log group **`/rdi/staging/proxy`** → log stream = proxy instance ID (e.g. `i-0abc...`). |
| **CloudWatch (agent)** | Log group **`/rdi/staging/agent`** → log stream = Wavelength instance ID. |
| **On proxy instance (SSM)** | `/var/log/rdi-proxy.log` (proxy stdout), `/var/log/cloudwatch-agent-setup.log` (why CloudWatch agent may have failed). |
| **On Wavelength instance (SSM)** | `/var/log/rdi-agent.log` (agent stdout), `/var/log/cloudwatch-agent-setup.log`. |

**How to view:**  
- **CloudWatch:** AWS Console → **CloudWatch** → **Log groups** → `/rdi/staging/proxy` or `/rdi/staging/agent` → open the log stream (instance ID). Or CLI: `aws logs filter-log-events --log-group-name /rdi/staging/proxy --filter-pattern "PING" --region us-east-1`.  
- **On instance:** Use **SSM Run Command** or **Session Manager** to run `tail -50 /var/log/rdi-proxy.log` (or the paths above). Instance IDs: EC2 → Instances, or Target groups → Targets tab for the proxy.

**No logs appearing in the log groups?**

If you **have** recreated the instances (bumped `infra_version` and applied) but still see no log streams:

1. **CloudWatch agent may be failing on Amazon Linux 2023** — user_data now writes setup output to `/var/log/cloudwatch-agent-setup.log` on each instance so you can see install/start errors. Via SSM, run on the **proxy** instance (instance ID from EC2 or target group):
   ```powershell
   # Replace PROXY_INSTANCE_ID with the proxy EC2 instance ID (e.g. from target group Targets tab)
   aws ssm send-command --region us-east-1 --instance-ids PROXY_INSTANCE_ID --document-name "AWS-RunShellScript" --parameters '{"commands":["echo === cloudwatch-agent-setup ===","cat /var/log/cloudwatch-agent-setup.log 2>/dev/null || echo no file","echo === rdi-proxy.log tail ===","tail -15 /var/log/rdi-proxy.log","echo === cloudwatch process ===","ps aux | grep -E cloudwatch | grep -v grep"]}' --query "Command.CommandId" --output text
   ```
   Then: `aws ssm get-command-invocation --region us-east-1 --command-id <COMMAND_ID> --instance-id PROXY_INSTANCE_ID --query "StandardOutputContent" --output text`. Check for "ERROR" or "install failed" in the setup log; if the ctl path is wrong or the agent didn’t start, fix is in user_data (or use the updated user_data and replace instances again).

2. **Instances never had CloudWatch user_data** — If the instances were created before CloudWatch was added to user_data, they won’t ship logs. **Fix:** Bump `infra_version` in `variables.tf`, run `terraform apply` so proxy and Wavelength EC2 are replaced; new instances run current user_data and write to the setup log if the agent fails.

---

## 2. ALB listener and protocol

**Check:**
- **EC2 → Load Balancers** → select `rdi-alb-v2-staging` → **Listeners** tab.
- You should see:
  - **HTTPS:443** (if certificate is set) → forward to the RDI target group.
  - **HTTP:80** → forward to target group (no cert) or redirect to 443 (with cert).

**Frontend uses:** `wss://...` (port 443). So the **HTTPS:443** listener must exist and forward to the same target group that has the proxy instance.

**If using HTTP only (no cert):** Frontend would need `ws://...` and port 80. Confirm the session API returns the same scheme/port the listener uses.

---

## 3. Security groups

**ALB → Security group:**
- **Inbound:** 443 (and 80) from 0.0.0.0/0.
- **Outbound:** Port **8765** (traffic) and port **8766** (health check) to the proxy VPC CIDR. Both rules must exist.

**Proxy EC2 → Security group:**
- **Inbound:** 8765 from 0.0.0.0/0 (or ALB SG); **8766** from VPC CIDR (for ALB health checks).
- **Outbound:** All (or at least to internet if proxy needs it).

**Quick check:** From the proxy instance (SSH or Session Manager), `curl -v http://localhost:8766` should return 200. Then from a machine that can reach the ALB, confirm the ALB can reach the proxy on 8765/8766 (e.g. ALB SG egress and proxy SG ingress).

---

## 4. Certificate (HTTPS/WSS)

**If the listener is HTTPS:443:** The ALB uses a certificate. The client connects to `wss://rdi-alb-v2-staging-....elb.amazonaws.com`.

- **Possible issue:** Certificate is for a different hostname (e.g. custom domain). Browsers may reject or the connection can fail. Check the certificate’s CN/SAN in the console.
- **Self-signed:** Browsers and phones do **not** trust the ALB’s self-signed cert, so WSS can fail with 1006. For a **permanent, secure** setup that works in all browsers and on phones, use the **custom domain** option below.

---

## 5. Proxy process and ports

**On the proxy EC2 instance:**
- Process listening on **8765**: `ss -tlnp | grep 8765` or `netstat -tlnp`.
- Process listening on **8766**: `ss -tlnp | grep 8766`.
- Health response: `curl -v http://localhost:8766` → HTTP 200 with empty body.

If 8765 or 8766 isn’t listening, the proxy binary didn’t start or crashed. Check `/var/log/rdi-proxy.log` and user_data/startup.

---

## 6. Endpoint URL and path

**Session API returns:** `endpoint` (e.g. `wss://rdi-alb-v2-staging-....elb.amazonaws.com`). The frontend uses this as the WebSocket URL.

- **Path:** ALB is receiving requests at `/` (no path). If you later add a path (e.g. `/ws`), the endpoint and listener path must match.
- **Scheme:** Must match the listener: `wss://` for 443, `ws://` for 80.

---

## 7. Order of operations (summary)

1. **Target group Healthy** (ALB can reach proxy on 8766).
2. **ALB listener** 443 (or 80) forwards to that target group.
3. **Security groups** allow ALB → proxy on 8765 and 8766.
4. **Proxy** listening on 8765 and 8766.
5. **Certificate** (if HTTPS) valid for the hostname used.
6. **Frontend** uses the exact endpoint returned by the session API (same scheme and host).

---

## 8. Useful AWS Console links (staging)

- Target groups: **EC2 → Target Groups** (filter by name `rdi`, `staging`).
- Load balancers: **EC2 → Load Balancers** (`rdi-alb-v2-staging`).
- Instances: **EC2 → Instances** (proxy instance; check security group and status).

---

## 9. CLI checks (use these to verify without opening the console)

**Target group health (staging):**

```bash
# List target groups and get ARN for rdi-tg-v2-staging
aws elbv2 describe-target-groups --names rdi-tg-v2-staging --query 'TargetGroups[0].TargetGroupArn' --output text

# Get target health (replace TG_ARN with the ARN from above, or use --target-group-arn)
aws elbv2 describe-target-health --target-group-arn arn:aws:elasticloadbalancing:us-east-1:470900128247:targetgroup/rdi-tg-v2-staging/b56172aac6c7e6c9 --query 'TargetHealthDescriptions[*].{Id:Target.Id,Port:Target.Port,State:TargetHealth.State,Reason:TargetHealth.Reason}' --output table
```

**Expected:** At least one target with `State: healthy`. If `State: unhealthy`, check `Reason` and the proxy (ports 8765/8766, security groups).

**ALB listeners (optional):**

```bash
# Get ALB ARN
aws elbv2 describe-load-balancers --names rdi-alb-v2-staging --query 'LoadBalancers[0].LoadBalancerArn' --output text

# List listeners (replace ALB_ARN if needed)
aws elbv2 describe-listeners --load-balancer-arn <ALB_ARN> --query 'Listeners[*].{Port:Port,Protocol:Protocol,TargetGroup:DefaultActions[0].TargetGroupArn}' --output table
```

**cURL to ALB (from your machine):**

```bash
curl -vI --connect-timeout 10 https://rdi-alb-v2-staging-612547582.us-east-1.elb.amazonaws.com/
```

---

**Interpreting cURL:** If the cURL above fails, the problem is before WebSockets (DNS, network, or TLS). If it succeeds, the issue is likely target health or WebSocket upgrade handling.

---

## 10. Still failing? (target Healthy but connection 1006)

**1. Confirm the ALB has an HTTPS:443 listener**

The app uses `wss://` (port 443). If the ALB only has HTTP:80, the browser will try 443 and get connection refused or reset.

```bash
# Replace with your ALB ARN from describe-load-balancers
aws elbv2 describe-listeners --load-balancer-arn <ALB_ARN> --query 'Listeners[*].{Port:Port,Protocol:Protocol}' --output table
```

You should see **443 / HTTPS**. If you only see **80 / HTTP**, either add an HTTPS listener (with a valid cert) or switch the app to use **ws://** and port 80 (session API would need to return `ws://...` when no cert).

**2. Certificate / TLS**

If HTTPS:443 exists but the certificate is self-signed or for a different hostname, the browser may abort the connection (often shows as 1006). In that case:

- Use a real certificate (e.g. ACM) for the ALB hostname or your custom domain, or
- For local testing only, try opening the WebSocket from a tool that ignores cert errors (e.g. `wscat -n -c wss://rdi-alb-v2-staging-....elb.amazonaws.com/`) to see if the backend accepts the connection when TLS is accepted.

**3. Browser Network tab**

Open DevTools → **Network** → filter **WS**. Click Ping again. Click the failed request and check:

- **Status:** e.g. "pending" then failed, or a specific code.
- **Headers / Response:** Any response headers or error message from the server.

**4. What the app is using**

In the console you should see `[RDI Ping] Starting { wsUrl: 'wss://...', ... }`. Confirm:

- **wss://** and port 443 → ALB must have HTTPS listener.
- **ws://** and port 80 → ALB must have HTTP listener forwarding to the target group.

Restarting the React dev server does not change the endpoint (it comes from the session API) and will not fix ALB/listener/cert issues.

---

## 11. Permanent WSS solution (trusted cert, all browsers and phones)

To use **WSS only** with a certificate that every browser and phone trusts (no self-signed, no manual trust):

1. **Use a domain you control** (e.g. `rdi.example.com`).
2. **Set Terraform variables** (e.g. in `environments/staging.auto.tfvars` or your workspace):
   - `enable_custom_domain = true`
   - `domain_name = "rdi.example.com"`  (your root domain)
   - `subdomain = "wss.staging"`  (optional; gives `wss.staging.rdi.example.com`; leave empty to use `rdi.example.com`)
3. **Delegate the domain to Route53:** Terraform will create a Route53 hosted zone for `domain_name`. Copy the zone’s **name servers** (e.g. from `terraform output` or AWS Console → Route53 → Hosted zones). At your domain registrar, set the **NS** records for `rdi.example.com` to those name servers so DNS and ACM validation can complete.
4. **Apply:** Run `terraform apply`. The domain module will:
   - Create the hosted zone (if new).
   - Request an ACM certificate for `*.rdi.example.com` (and your subdomain is covered).
   - Create DNS validation records and wait for validation.
   - Create an **A record** (alias) pointing your WebSocket host (e.g. `wss.staging.rdi.example.com`) at the ALB.
   The ALB will use this ACM cert, and the session API will return `wss://wss.staging.rdi.example.com` (or your chosen host).
5. **Result:** Clients connect to `wss://<your-host>` with a **trusted** certificate, so WSS works in all browsers and on phones without any manual cert steps.

**Security:** TLS is terminated at the ALB with a publicly trusted certificate; traffic from the ALB to the proxy remains inside AWS.
