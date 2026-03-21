# Connection Pool Table — Schema (Implemented)

## Base table

| Key / Attribute | Type | Notes |
|-----------------|------|-------|
| **PK** | `user_id` (S) | Cognito sub — primary access pattern |
| **SK** | `session_id` (S) | UUID — unique per user |
| `region` | S | AWS region (e.g. `us-east-1`) — where proxy lives |
| `wavelength_zone_id` | S | Wavelength zone (e.g. `use1-wl1-chi-wlz1`); default region if omitted |
| `user_zone_sk` | S | Composite `{wavelength_zone_id}#{session_id}` for GSI |
| `status` | S | `active` \| `idle` |
| `drone_id` | S | `{drone_name}-{uuid}` — user-friendly + unique |
| `endpoint` | S | Proxy WebSocket URL (e.g. `wss://…`) |
| `expires_at` | N | Set to a far-future value so DynamoDB TTL does not delete; deletion is explicit only. |
| `idle_after` | N | Optional. Unix timestamp — when to transition to idle (scheduled Lambda). |
| `created_at` | N | Unix timestamp |
| `updated_at` | N | Unix timestamp — last modification |
| `released_at` | N | Unix timestamp — when status went to idle (optional) |
| `metadata` | S | JSON string for extensibility (optional) |
| `relay_id` | S | Optional. Which relay this session routes through. |

---

## GSIs

### UserZoneIndex

| Key | Attribute | Type |
|-----|-----------|------|
| **PK** | `user_id` | S |
| **SK** | `user_zone_sk` | S |

**Query:** `Query(UserZoneIndex, PK=user_id, SK begins_with "use1-wl1-chi-wlz1#")` → sessions for user in that zone.

### SessionIdIndex

| Key | Attribute | Type |
|-----|-----------|------|
| **PK** | `session_id` | S |

**Query:** `Query(SessionIdIndex, PK=session_id)` → O(1) lookup by session_id alone.

---

## Query patterns

| Pattern | How |
|---------|-----|
| Get one session by user + session_id | GetItem(PK=user_id, SK=session_id) |
| Get all sessions for user | Query(PK=user_id) |
| Get all sessions for user in zone Z | Query(UserZoneIndex, PK=user_id, SK begins_with "zone_id#") |
| Lookup by session_id only | Query(SessionIdIndex, PK=session_id) |

---

## TTL and idle vs delete (connection lifetime)

- **Deletion** happens only when the user explicitly deletes (DELETE with `permanent: true`). DynamoDB TTL is not used to delete session rows (that would remove the row from the connection pool but leave the user's list/hierarchy out of sync).
- **Idle after time:** `POST /sessions` accepts `ttl_seconds` (optional). Default 4h, min 60s, max 7 days. The backend stores `idle_after` = now + ttl_seconds and `expires_at` = far-future. A scheduled job (EventBridge every 5 min) invokes the Session Lambda to mark active sessions as **idle** when `idle_after` has passed (updates status, notifies proxy, updates user hierarchy). The row stays in the table until the user explicitly deletes.
- `ttl_seconds: 0` means no auto-idle (indefinite); no `idle_after` is set.
- **Connection lifetime:** TTL is shared with idle logic. While status is **active**, the WebSocket connection can stay up indefinitely: the ALB in front of the proxy has a 3600s idle timeout so long-lived connections are not closed by the load balancer. Only when the session becomes **idle** (user clicks Release, or `idle_after` has passed) does the Lambda notify the proxy to disconnect and the agent to close; the UI will then show "not connected" until the user reactivates or creates a new session.

---

## POST /sessions body

| Field | Type | Notes |
|-------|------|-------|
| `ttl_seconds` | number | Optional; 60–604800 |
| `drone_name` | string | Optional; default `"drone"`; becomes `{drone_name}-{uuid}` |
| `wavelength_zone_id` | string | Optional; default region |
| `folder_path` | array of strings | Optional; e.g. `["My Drones"]` or `["My Drones", "Fleet A"]`; default `["My Drones"]` |
| `relay_id` | string | Optional. Relay to route this session through. |
| `metadata` | object | Optional; stored as JSON string. PX4/local tunnel details: |

### metadata (PX4 / local tunnel)

| Field | Type | Notes |
|-------|------|-------|
| `mavlink_port` | number | PX4 MAVLink UDP port; 14540 (legacy) or 18570 (v1.13+) |
| `mavlink_host` | string | Local tunnel host; default `127.0.0.1` |
| `px4_version` | string | Hint: `legacy` or `v1.13+` |

---

## Flight logs S3 path

When EC2 writes logs on session close:

```
{user_id}/{wavelength_zone_id}/{drone_id}-{session_id}.log
```

---

## Connection hierarchy (folders)

Connections are organized into folders per user. The hierarchy is stored in the **user profiles** table, not the connection pool.

| Aspect | Detail |
|--------|--------|
| **Storage** | `user_profiles.connection_hierarchy` — see [USER-PROFILES-SCHEMA.md](./USER-PROFILES-SCHEMA.md) |
| **Structure** | `{ "My Drones": { sessions: [{session_id, name, status}], subfolders: {...} }, "Shared": {...} }` |
| **Default folders** | "My Drones", "Shared" (created for new users) |
| **Relationship** | `session_id` values reference items in this (connection pool) table |

When a session is created, it is added to a folder (default: "My Drones"). When a session is released (idle) or deleted, the Session Lambda updates `connection_hierarchy`. Full session details are fetched from this table when the user views a connection.
