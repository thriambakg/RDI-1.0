# WebSocket / ALB Connection Diagnostic Guide

When the frontend fails to establish a WebSocket to the ALB (`wss://rdi-alb-v2-staging-....elb.amazonaws.com/`) with **code 1006, neverOpened**, use this checklist to find the root cause.

## 1. Target group health (most common)

**Symptom:** Connection never opens; 1006 after ~100ms–8s.

**Check:**
- AWS Console → **EC2 → Target Groups** → select the RDI staging target group (name like `rdi-...-tg-v2-staging`).
- Open the **Targets** tab.
- **Expected:** At least one target with status **Healthy**.
- **If Unhealthy or no targets:** The ALB will not forward traffic. Fix health checks first.

**Why it fails:** Health checks use port **8766**; the ALB security group must allow egress to 8766 (see `alb_egress_health_check` in `terraform/modules/alb/main.tf`). If that rule was missing, targets stay Unhealthy.

**Fix:** Ensure `terraform apply` has been run with the ALB module that includes the health-check egress rule. Wait 1–2 health check intervals (e.g. 30–60s) for the proxy instance to become Healthy.

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
- **Self-signed:** Browsers may block; usually you’d only use for testing or with a custom domain and trust.

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
