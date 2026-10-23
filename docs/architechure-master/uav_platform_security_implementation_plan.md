# UAV Platform Security — Implementation Specification

**Status:** Reframed to match current RDI product architecture  
**Date:** 2026-10-23  
**Scope:** Multi-tenant UAV console (accounts, cloud APIs, live connection = video + control), plus staged hardware security.

---

## 0. Product model (authoritative — do not invent view-only)

### What a “connection” is today

When a signed-in user **opens a connection** in the console (session bound to a relay / aircraft path):

- They receive **live video / telemetry** (when the aircraft and link are up).
- They also have **flight control** over the same WebRTC data channel (CTRL), when the aircraft is powered and the control path is up.
- There is **no** separate “watch-only” vs “fly” mode in the product.
- Optional future features (e.g. remote power-on / activation) still sit inside this model: **if you are logged in and have the connection open, you have full link authority for that session.**

Security design must protect **who may open a connection** and **who may keep that session**, not invent a read-only viewer tier unless product explicitly adds it later.

### Current auth (already shipping / in staging)

| Control | Behavior |
|---|---|
| Email/password MFA | Cognito **required TOTP** (Authenticator app) on every sign-in |
| Google MFA | Cognito cannot MFA federated users → **app-level TOTP** after OAuth |
| Email signup | Cognito verification **link** email (`CONFIRM_WITH_LINK`) |
| Single active login | **Deny new login** while account has recent API activity (~15 min idle); explicit **Sign out** clears the lock immediately. Does *not* kick the pilot by allowing a second login to take over. |

### Hardware context

- **Legacy (deployed):** Pixhawk ↔ TELEM1 ↔ Holybro CM4 ↔ RFD900. Inspect wiring/MAVLink; do not assume Microhard.
- **Future (not deployed):** Microhard pMDDL900, Jetson, SIYI R1M, etc. Do not gate application security on those devices existing.

---

## 1. Objective

Prevent account takeover, cross-user drone access, unauthorized connection/control, replay where feasible, and loss of auditability.

Non-negotiables:

1. Authentication alone does not imply access to a specific connection/relay — **object-level authorization** does.
2. Opening a connection grants **video + control** for that session; protect that capability, don’t split it fictitiously.
3. Browser must not talk raw MAVLink/serial to the flight controller; path is console → cloud/APIs → relay/agent → aircraft.
4. Aircraft-side failsafes (Pixhawk) remain independent of cloud authorization.
5. Loss of cloud/link/session must yield a **defined safe behavior**, not unbounded stale commands.
6. Default deny, least privilege, explicit user/tenant boundaries.

---

## 2. Threat model (application-relevant)

| Threat | Mitigation direction |
|---|---|
| Stolen password | TOTP MFA (done); later passkeys |
| Stolen Google account without phone MFA | App-level TOTP after Google (done); encourage Google 2FA |
| Stolen access/refresh token | Short TTLs (already Cognito); revoke / session epoch; terminate live WebRTC when possible |
| Second login kicking pilot mid-flight | Deny-new-login while session active (done) |
| Cross-user IDOR on session/relay IDs | Object-level authz on every API |
| Forged / replayed CTRL | Authenticated channel + future lease/sequence; aircraft failsafes |
| Hijacked WebRTC after logout | Stop issuing credentials; tear down / stop authorizing when session revoked |
| Abusive login/MFA | Rate limits, lockout, alerts |
| Exposure of RTSP/MAVLink to internet | Never; only via authenticated relay/agent path |

---

## 3. What we can implement **right now** (application side)

These do **not** require Jetson/Microhard. They apply to Cognito, API Gateway, Lambdas, DynamoDB, frontend, and existing session/relay/WebRTC flows.

### 3.1 Done or nearly done — verify and harden

| Item | Action now |
|---|---|
| TOTP MFA (email + Google app gate) | Verify staging; encrypt/harden app TOTP secrets at rest if still plaintext; never log codes |
| Single-login (deny while active) | Keep; document 15 min idle; ensure Sign out always calls `release_auth_session` |
| Session epoch / `SESSION_SUPERSEDED` | Confirm all Cognito-protected APIs enforce; frontend signs out on focus/poll |
| Email verification link | Confirm Cognito `CONFIRM_WITH_LINK` applied; SES later for branded From |

### 3.2 High priority — application security (NOW)

1. **Object-level authorization audit**
   - Every `session_id`, `relay_id`, hierarchy mutation: caller’s `sub` must own or hold an explicit share grant.
   - Regression tests: User A token cannot GET/PATCH/DELETE User B’s session or subscribe to their WebRTC bundle.
   - Shared-folder / share-with-others paths: re-check grants on every read and control credential mint.

2. **Connection open = control authority (document + enforce)**
   - Treat “create/get WebRTC viewer bundle / open session” as the privileged capability (video **and** CTRL).
   - Do not add fake `drone:view` without `drone:control` unless product builds a real view-only mode.
   - Optional later: **exclusive CTRL among multiple watchers** — only if product allows multi-viewer; until then one open console session owns the link.

3. **Revocation that affects live sessions**
   - On logout / release_auth_session / account disable: invalidate refresh where possible; stop minting new KVS/viewer credentials.
   - Best-effort: signal agent/proxy to drop data channel / mark session idle when owner session ends.
   - Frontend: already polls; extend to disconnect WebRTC on `SESSION_SUPERSEDED` / logout.

4. **API hardening**
   - Rate-limit auth, MFA verify, claim-code, session create.
   - Consistent 401/403 without leaking whether a `session_id` exists across tenants.
   - Reduce API Gateway authorizer cache TTL if it delays revocation visibility (today can be minutes).

5. **Audit logging (application)**
   - Structured logs (no secrets): login MFA success/fail, PreAuth deny (session active), session create/release, share grant/revoke, WebRTC credential mint, relay claim.
   - Correlation id / `user_id` prefix / `session_id` for incident reconstruction.

6. **Secrets and TOTP storage**
   - App TOTP secrets: **customer-managed KMS CMK** field encryption (`enc:v1:…`) via the RDI-1.0 stack key (`module.kms`). DynamoDB AWS-managed/AWS-owned SSE alone is **not** enough (GetItem would still return plaintext).
   - Do **not** use the `aws/dynamodb` AWS managed key for app Encrypt/Decrypt of TOTP fields.
   - Review IAM least privilege on user-profiles / connection-pool / relay tables.

7. **Account security UX (app)**
   - Clear “already signed in elsewhere” and MFA enrollment copy (partially done).
   - Session / “sign out everywhere” if Cognito AdminUserGlobalSignOut is wired for compromise response.
   - Security notification email (SES) on new device login — after SES.

8. **Automated security regression**
   - CI or staging suite: cross-user session access, superseded token, MFA required path, share grant negative cases.

### 3.3 Medium priority — still application-only

| Item | Notes |
|---|---|
| Trusted devices / WebAuthn | Improves phishing resistance; does not change connection=control model |
| Risk-based step-up | Only for ownership transfer / MFA reset / API keys — **not** for every video frame or stick input |
| Explicit arm/takeoff confirm UI | UX safety; still not a second permission tier |
| CTRL command envelope (id, timestamp, sequence) | Soften replay on the data channel; aircraft failsafes remain primary |
| Soft exclusive CTRL lease API | “One controller per session_id” if multiple browser tabs become a problem |

### 3.4 Not NOW (hardware / RF / aircraft)

- Jetson command gateway, Microhard encryption assumptions, SIYI RTSP topology.
- Assuming RFD900 or MAVLink is authenticated end-to-end.
- Aircraft TPM / secure boot / signed firmware (future).
- Changing Pixhawk failsafes as part of cloud security work.

---

## 4. Identity and sessions (aligned policy)

### 4.1 Preserve current controls

1. Keep Cognito TOTP for email/password; keep app TOTP for Google.
2. Keep **deny-new-login while active** (pilot protection). Do not switch to “newest login wins” without an explicit product decision.
3. Logout → `release_auth_session` + Cognito `signOut`.
4. Prefer not storing long-lived tokens in `localStorage` beyond what Amplify requires; treat XSS as session theft.
5. Step-up MFA only for **account/security** mutations and ownership/share admin — not for routine stick/telemetry once the connection is authorized.

### 4.2 Device recognition (optional NOW)

Registry of trusted devices (WebAuthn or opaque device id) for risk signals and notifications. **Not** a substitute for MFA or object authz. Not required to open a connection.

### 4.3 UX principles (corrected)

| Journey | UX |
|---|---|
| Login | Password/Google + TOTP |
| Open connection | No extra MFA; full video+control if authorized and aircraft up |
| Stick / camera while connected | No MFA prompts |
| Sign out / idle 15 min | Lock clears; another device may log in |
| Ownership / MFA / recovery change | Fresh auth / step-up |
| Second login while first active | **Fail** with clear message |

---

## 5. Authorization model (aligned)

Use the **real** resources: `user_id`, `session_id`, `relay_id`, folder hierarchy, share grants — not a fictional `organization → drone` RBAC unless/until that exists.

Suggested **current** capabilities (names illustrative):

| Capability | Meaning |
|---|---|
| `connection:open` | Mint/use WebRTC + CTRL for this session (video **and** fly) |
| `connection:manage` | Create/rename/delete/release session, bind relay |
| `relay:claim` / `relay:admin` | Pair and configure relays |
| `share:grant` | Give another user `connection:open` (same full capability) |

There is **no** `connection:view_only` unless product builds it.

Request flow:

```text
Authenticate (Cognito JWT + session epoch / last_seen)
  -> Authorize object (session/relay ownership or share)
  -> Mint short-lived WebRTC / control credentials
  -> Audit
  -> Client opens connection (video + CTRL)
```

Never trust client-supplied `user_id`. Re-check ownership on every privileged call.

---

## 6. Command path (application vs aircraft)

### Application NOW

- Only the authorized connection session may obtain control credentials.
- On session release / logout / supersede: stop issuing credentials; disconnect client.
- Optional: command id + timestamp on CTRL messages for soft anti-replay.

### Aircraft / agent (legacy + future)

- Pixhawk failsafes independent of cloud.
- Agent/CM4: validate session still active with cloud when practical; drop CTRL if lease/session dead.
- **AFTER HARDWARE:** Jetson gateway, device identity, stronger command auth — design now, enforce when hardware exists.

---

## 7. WebRTC / video / telemetry (application)

- Authorize before issuing signaling/viewer bundles.
- Short-lived credentials; no public RTSP.
- On revoke: frontend tears down peer connection; backend refuses renewals.
- Rate/size limits on APIs that mint credentials or accept device announce/claim.

---

## 8. Audit and incident response (application)

Log: MFA outcomes, PreAuth deny, session lifecycle, share changes, credential mint, relay claim.  
Emergency: revoke Cognito sessions (global sign-out), clear `auth_session_last_seen` / epoch, disable user, revoke shares.  
Do not send “emergency land” as the only safety story — Pixhawk link-loss behavior remains primary.

---

## 9. Phases (reframed)

### Phase 0 — Map reality (NOW)

1. Cognito + Amplify login/MFA/single-session diagram (as built).
2. Inventory session-api, user-profile-api, relay-registry-api, KVS WebRTC paths and authz gaps.
3. Legacy CM4–Pixhawk–RFD900 command/telemetry path (what reaches the FC today).
4. Gap list tagged **APP-NOW** vs **HARDWARE-LATER**.

### Phase 1 — Application critical (NOW)

- Object-level authz + automated cross-user tests.
- Revocation → live WebRTC teardown / no credential renew.
- Audit events + rate limits.
- KMS for app TOTP secrets.
- Confirm MFA + deny-while-active in staging/prod.

### Phase 2 — Stronger account security (NOW, optional order)

- WebAuthn/passkeys; trusted devices; notify on new login (SES).
- Compromise playbook: global sign-out + lock clear + support process.

### Phase 3 — Soften control-plane abuse (NOW design / incremental)

- CTRL message envelope (id/seq/expiry) end-to-end with agent.
- Optional exclusive controller if multi-tab becomes an issue.
- Still: **connection open = control**, not view-only.

### Phase 4 — New hardware (DEFER)

Microhard / Jetson / SIYI identity, link crypto as transport only, gateway enforcement, HIL tests.

### Phase 5 — Pre-customer flight

Pentest, HIL, RF, operational procedures, compliance review.

---

## 10. Acceptance criteria (aligned)

- [ ] User A cannot open, list, or control User B’s connection/relay without an explicit share.
- [ ] Share grants convey **full** connection capability (video + control), matching product.
- [ ] Active login blocks a second login until idle timeout or Sign out.
- [ ] Superseded / logged-out clients lose API access and drop WebRTC promptly.
- [ ] Email and Google paths both require TOTP before console use.
- [ ] Signup sends a **verification link** email; unverified email/password users cannot complete sign-in.
- [ ] Routine stick/video while connected does **not** re-prompt MFA.
- [ ] Security-sensitive account actions require fresh authentication.
- [ ] Audit can reconstruct who opened which session without logging secrets.
- [ ] Automated tests cover cross-user access and session revocation.
- [ ] **AFTER HARDWARE:** aircraft/gateway rejects unauthorized commands with device identity (separate gate).

---

## 11. Agent / engineering instructions

1. Prefer **application** changes in RDI-1.0 / RDI-Base-Infra Cognito; use `tfpush` per repo when done.
2. Do not implement view-only permissions or “new login kicks pilot” without product owner approval.
3. Do not assume Jetson/Microhard for NOW work.
4. Inspect code before inventing auth providers or data models.
5. No live-flight experiments as part of security refactors; use mocks/simulators for CTRL envelope work.

---

## 12. Decisions for product owner

| Topic | Current default |
|---|---|
| Connection capability | Open = video + fly |
| View-only mode | **Not planned** unless separately approved |
| Concurrent logins | Deny while active (~15 min idle) |
| MFA | Every login (email Cognito TOTP; Google app TOTP) |
| Passkeys / trusted devices | Optional follow-on |
| Exclusive CTRL with multi-viewer | Only if multi-viewer ships |
| Remote activation | Same trust as open connection |

---

## 13. Immediate backlog (application-only checklist)

1. Authz audit + cross-user API tests on sessions/relays/shares.  
2. WebRTC disconnect on logout / `SESSION_SUPERSEDED`.  
3. KMS-encrypt `app_totp_secret`.  
4. Rate limits on auth and session-create.  
5. Structured security audit log fields.  
6. Staging validation of MFA + deny-login + verify-link email.  
7. (Optional) WebAuthn + new-login email notification via SES.
