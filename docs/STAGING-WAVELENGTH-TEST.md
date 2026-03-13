# Staging Wavelength Test – Full CloudFront Flow

End-to-end test: **CloudFront (staging)** → **Proxy in Wavelength** → **Local tunnel** → **PX4 on laptop**

---

## Test Setup

1. **Phone hotspot** (Verizon, same carrier as `use1-wl1-atl-wlz1`)
2. **Laptop** connected to hotspot (uses cellular data)
3. **PX4 + Gazebo** running on laptop
4. **Frontend** at CloudFront staging URL (not localhost)
5. **Proxy** in Wavelength (Atlanta, Verizon zone)

---

## Architecture for This Test

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  LAPTOP (on Verizon cellular via phone hotspot)                              │
│                                                                             │
│  ┌─────────────┐     ┌──────────────────┐     ┌─────────────────────────┐   │
│  │  Browser    │     │  Tunnel Agent    │     │  PX4 + Gazebo           │   │
│  │  (frontend) │     │  (outbound conn) │     │  localhost:14540        │   │
│  └──────┬──────┘     └────────┬─────────┘     └──────────▲──────────────┘   │
│         │                     │                          │                  │
└─────────┼─────────────────────┼──────────────────────────┼──────────────────┘
          │                     │                          │
          │ HTTPS               │ WebSocket/TCP            │ (local)
          │ (CloudFront)        │ (to Wavelength)          │
          ▼                     ▼                          │
┌─────────────────────────────────────────────────────────────────────────────┐
│  AWS                                                                        │
│                                                                             │
│  CloudFront ──► S3 (frontend)     Wavelength Zone (use1-wl1-atl-wlz1)       │
│                                        │                                    │
│                                        ▼                                    │
│                                 ┌──────────────┐                            │
│                                 │ Proxy EC2    │◄── Carrier IP (public)     │
│                                 │ - Frontend   │                            │
│                                 │ - Tunnel     │                            │
│                                 │   bridge     │                            │
│                                 └──────┬───────┘                            │
│                                        │                                    │
└────────────────────────────────────────┼────────────────────────────────────┘
                                         │
                              (both connect to same proxy)
```

---

## Prerequisites (Must Be Deployed)

| Component | Where | Status |
|-----------|-------|--------|
| Base Infra (Cognito, S3, CloudFront) | RDI-Base-Infra | Deploy to us-east-1 staging |
| Frontend build | React app | Build with staging env, deploy to S3 |
| Wavelength EC2 (as proxy) | RDI-1.0 terraform | Already in main.tf |
| Session API (Lambda + API GW) | RDI-1.0 | **To add** |
| Proxy software on Wavelength EC2 | user_data / SSM | **To add** |
| Local tunnel agent | Standalone app | **To build** |

---

## Staging Environment Checklist

### 1. Base Infra (RDI-Base-Infra) – us-east-1

- [ ] Deploy with `environment = staging`, `region = us-east-1`
- [ ] Verify CloudFront URL: `https://<distribution>.cloudfront.net`
- [ ] Cognito redirect URLs include CloudFront URL (not just localhost)
- [ ] Frontend build uses `VITE_*` vars from Base Infra outputs

### 2. Frontend Build for Staging

Set these (e.g. in `.env.staging` or CI):

```
VITE_ENVIRONMENT=staging
VITE_AWS_REGION=us-east-1
VITE_COGNITO_USER_POOL_ID=<from Base Infra>
VITE_COGNITO_USER_POOL_CLIENT_ID=<from Base Infra>
VITE_COGNITO_DOMAIN=<from Base Infra>
VITE_REDIRECT_SIGN_IN=https://<cloudfront-domain>/auth/callback
VITE_REDIRECT_SIGN_OUT=https://<cloudfront-domain>
VITE_API_GATEWAY_URL=<Session API URL when deployed>
VITE_WEBSOCKET_URL=wss://<proxy-endpoint>  # or from Session API response
```

Build and sync to S3:

```bash
npm run build
aws s3 sync dist/ s3://<frontend-bucket>/ --delete
aws cloudfront create-invalidation --distribution-id <id> --paths "/*"
```

### 3. RDI-1.0 – Wavelength Proxy

The Wavelength EC2 (`wavelength_zone_id = "use1-wl1-atl-wlz1"`) becomes the **proxy**:

- [ ] Repurpose for proxy role (no PX4 on it)
- [ ] user_data or SSM installs proxy app (WebSocket ↔ UDP bridge)
- [ ] Security group: allow WebSocket port (e.g. 8080) and UDP 14540 from 0.0.0.0/0 for testing
- [ ] Output: `wavelength_carrier_ip` – this is the proxy endpoint

**HTTPS/WebSocket:**  
CloudFront serves the frontend over HTTPS. Connecting to `ws://carrier-ip:port` from an HTTPS page is mixed content and will be blocked.

Options:

- **A) Domain + ACM (recommended):** Create `proxy-staging.rdi.yourdomain.com` → CNAME to carrier IP (or use Route53 A record). Request ACM cert for that domain. Run the proxy with TLS (e.g. nginx + certbot, or proxy with built-in TLS).
- **B) Region proxy with domain:** Put a region EC2 (or ALB) in front with a domain + cert; it forwards to the Wavelength proxy. Simpler TLS setup, but adds a hop.
- **C) Dev-only:** For quick tests, serve the frontend over HTTP from a temporary origin so `ws://` is allowed (not ideal).

### 4. Session API (Lambda + API Gateway)

- [ ] `POST /sessions` – returns `{ endpoint: "wss://proxy-host:port", sessionId }`
- [ ] `DELETE /sessions/:id` – releases session (for future pool management)
- [ ] For MVP: single proxy, single port; Session API just returns the fixed endpoint
- [ ] Deploy in us-east-1, same account as Base Infra and RDI-1.0

### 5. Local Tunnel Agent

- [ ] Connects outbound to `wss://proxy-host:port` (or `ws://` if no TLS)
- [ ] Registers with session ID or token
- [ ] Bridges proxy ↔ `localhost:14540` (PX4 MAVLink)
- [ ] Run on the same laptop as PX4, while laptop is on phone hotspot

---

## Test Flow

1. Deploy Base Infra + RDI-1.0 + Session API + proxy software.
2. Connect laptop to Verizon phone hotspot.
3. Start PX4 + Gazebo on laptop.
4. Start local tunnel agent (points at Wavelength proxy).
5. Open `https://<cloudfront-domain>` in browser.
6. Log in (Cognito).
7. Frontend calls Session API → gets proxy endpoint.
8. Frontend opens WebSocket to proxy.
9. Proxy bridges frontend ↔ tunnel agent ↔ PX4.
10. Control drone from CloudFront-served UI.

---

## Carrier Alignment

Wavelength zone `use1-wl1-atl-wlz1` is **Verizon** (Atlanta).

- Phone hotspot should use **Verizon** to maximize benefit.
- AT&T/T-Mobile will still work, but traffic may not stay in the Verizon Wavelength path.

---

## File References

| Item | Path |
|------|------|
| Staging tfvars | `RDI-1.0/terraform/environments/staging.auto.tfvars` |
| Wavelength module | `RDI-1.0/terraform/modules/wavelength-ec2/` |
| Frontend config | `RDI-1.0/frontend/react-app/src/config.ts` |
| Base Infra | `RDI-Base-Infra/terraform/` |
