# RDI Testing Guide

How to test the deployed RDI infrastructure (Session API, WebSocket proxy, Agent) before or alongside frontend integration.

---

## 1. Session API – Lambda Test (no auth)

**Use when:** You want to verify Lambda + DynamoDB without Cognito or API Gateway.

1. Open **AWS Console → Lambda** → find `rdi-session-api-staging-us-east-1` (or your region).
2. **Test** tab → **Create new event**.
3. Use this payload (simulates API Gateway with Cognito authorizer):

```json
{
  "httpMethod": "POST",
  "path": "/sessions",
  "body": "{\"ttl_seconds\": 14400, \"drone_name\": \"survey-alpha\", \"wavelength_zone_id\": \"use1-wl1-chi-wlz1\"}",
  "requestContext": {
    "authorizer": {
      "claims": {
        "sub": "test-user-123"
      }
    }
  }
}
```

`body` fields: `ttl_seconds` (60–604800), `drone_name` (default `"drone"`), `wavelength_zone_id`, `metadata`. Omit for defaults.

4. **Test** → You should get `200` with `session_id`, `endpoint`, `expires_at`.
5. Check **DynamoDB** → connection pool table → new item with that `session_id`.

---

## 2. Session API – curl (Cognito auth)

**Use when:** You want to test the full API Gateway path.

You need a Cognito JWT. Options:

### Option A: Get token from browser

1. Log in to the RDI frontend (or hosted UI).
2. DevTools → Application → Local Storage (or Cookies) → find `CognitoIdentityServiceProvider...IdToken` or similar.
3. Copy the token value.

### Option B: AWS CLI (if you have user credentials)

```bash
# Replace with your Cognito User Pool ID, Client ID, username, password
aws cognito-idp initiate-auth \
  --auth-flow USER_PASSWORD_AUTH \
  --client-id YOUR_CLIENT_ID \
  --auth-parameters USERNAME=youruser,PASSWORD=yourpassword \
  --query 'AuthenticationResult.IdToken' --output text
```

### Test POST /sessions

```bash
# Replace SESSION_API_URL and TOKEN
export SESSION_API_URL="https://xxxx.execute-api.us-east-1.amazonaws.com/production/sessions"
export TOKEN="eyJ..."

curl -X POST "$SESSION_API_URL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Expected: `{"session_id":"...","endpoint":"wss://...","expires_at":...}`

### Test GET /sessions

```bash
curl -X GET "$SESSION_API_URL?session_id=YOUR_SESSION_ID" \
  -H "Authorization: Bearer $TOKEN"
```

### Test DELETE /sessions

```bash
curl -X DELETE "$SESSION_API_URL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"session_id":"YOUR_SESSION_ID"}'
```

---

## 3. WebSocket Proxy – wscat

**Use when:** You want to verify WSS and the proxy handshake.

Install [wscat](https://github.com/websockets/wscat): `npm install -g wscat`

1. Create a session via Lambda test or curl (get `session_id` and `endpoint`).
2. Connect as frontend:

```bash
# endpoint is wss://ALB-DNS (no path)
wscat -c "wss://YOUR-ALB-DNS-NAME" -x "frontend:YOUR_SESSION_ID"
```

3. In another terminal, connect as agent:

```bash
wscat -c "wss://YOUR-ALB-DNS-NAME" -x "agent:YOUR_SESSION_ID"
```

4. Send binary or text from one terminal; it should appear in the other (proxy bridges by `session_id`).

---

## 4. Agent + Proxy (full tunnel)

**Use when:** You want to test the full path: frontend ↔ proxy ↔ agent ↔ PX4.

1. **Create session** (Lambda test or curl) → note `session_id` and `endpoint`.
2. **Start PX4 SITL** (e.g. `make px4_sitl gazebo`).
3. **Run agent** pointing at the proxy:

```bash
cd src/agent
RDI_PROXY_URL="wss://YOUR-ALB-DNS-NAME" RDI_SESSION_ID="YOUR_SESSION_ID" cargo run
```

4. **Connect frontend** (or wscat) to same `wss://...` with `frontend:YOUR_SESSION_ID`.
5. MAVLink bytes from frontend should reach PX4 via the agent.

---

## 5. Frontend integration

The console has a “+ New connection” button but it currently shows mock data. To test end-to-end:

1. Ensure `API_GATEWAY_URL` (Session API) and `WEBSOCKET_URL` (WSS endpoint) are set in the frontend config.
2. Wire “New connection” to:
   - `POST /sessions` (with Cognito token)
   - Open WebSocket to `endpoint` with first message `frontend:{session_id}`.
3. Use the same `session_id` when starting the agent (e.g. from env or a simple UI field).

**Recommended order:** Validate Session API and WebSocket via CLI/Console first, then add frontend calls. That isolates API/network issues from UI logic.

---

## Quick reference

| Test              | Requires                     | Command / location                         |
|-------------------|------------------------------|--------------------------------------------|
| Session create    | Lambda console               | Test event with mock `authorizer.claims`   |
| Session API curl  | Cognito JWT                  | `curl -X POST ... -H "Authorization: Bearer $TOKEN"` |
| WebSocket proxy   | session_id + endpoint        | `wscat -c wss://... -x "frontend:SESSION_ID"` |
| Agent + PX4       | PX4 SITL, session_id         | `RDI_PROXY_URL=wss://... RDI_SESSION_ID=... cargo run` |
