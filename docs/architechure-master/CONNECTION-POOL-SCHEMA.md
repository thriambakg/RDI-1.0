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
| `expires_at` | N | Unix timestamp — TTL attribute |
| `created_at` | N | Unix timestamp |
| `updated_at` | N | Unix timestamp — last modification |
| `released_at` | N | Unix timestamp — when status went to idle (optional) |
| `metadata` | S | JSON string for extensibility (optional) |

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

## TTL

- `expires_at` is the TTL attribute.
- `POST /sessions` body accepts `ttl_seconds` (optional). Default 4h, min 60s, max 7 days.

---

## POST /sessions body

| Field | Type | Notes |
|-------|------|-------|
| `ttl_seconds` | number | Optional; 60–604800 |
| `drone_name` | string | Optional; default `"drone"`; becomes `{drone_name}-{uuid}` |
| `wavelength_zone_id` | string | Optional; default region |
| `metadata` | object | Optional; stored as JSON string |

---

## Flight logs S3 path

When EC2 writes logs on session close:

```
{user_id}/{wavelength_zone_id}/{drone_id}-{session_id}.log
```
