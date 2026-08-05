# Console controls / keybinds

**Storage:** `user-profiles` DynamoDB (`user_id` PK) — attribute `settings.controls`  
(No new table; no Base-Infra schema change — DynamoDB is schemaless beyond keys.)

| Path | Role |
|------|------|
| `settings.controls.connection_keybinds.<session_id>` | **Per-connection** control map (primary) |
| `settings.controls.keybinds` | Legacy global map (fallback only if no per-connection entry) |
| `settings.controls.version` | Schema version (`1`) |

**Why not connection-pool?** Pool `metadata` is radio/MAVLink addressing; `PATCH /sessions` only allows name/status/TTL. Keybinds are operator UI prefs → profile `settings` with deep-merge.

**API:** `PATCH /user-profile` `{ "action": "update_settings", "settings": { "controls": { "connection_keybinds": { "<session_id>": { ... } } } } }`  
**GET** `/user-profile` returns `settings` (Decimals JSON-safe).

**UI:** Open a connection → gear (top right) toggles **Connection setup** (identity + TTL + control map) vs **Control deck** (live HUD). Edits update the deck immediately; **Save** persists to the profile. Account **Settings** page is a stub pointing here.

**Live stream:** `usePressedInputs` joins held keyboard `code`s and gamepad tokens, e.g. `KeyA+KeyW+GP0-BTN0`.

**Wire format** (WebRTC `mavlink` channel): unchanged — `CTRL` + JSON (`path`, `stack`, `pipe`, `actions`, `stream`); radio CTRL uses compact TUNNEL payloads (`a`/`s`/`st`/`pp`). Desktop agent prints `pipe` + `stack` on each CTRL.

**Vehicle stack** is chosen at create-connection time (`px4` / `ardupilot` / `gazebo_px4` / …) and stored on session metadata; see [GAZEBO-DESKTOP-SIM.md](./GAZEBO-DESKTOP-SIM.md) for Gazebo SITL.

## Deploy

1. Frontend + user-profile-api (Decimal fix already required for GET after numeric settings).  
2. No Pi change for keybind storage.
