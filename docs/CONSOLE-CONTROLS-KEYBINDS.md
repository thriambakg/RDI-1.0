# Console controls / keybinds

**Storage:** `user-profiles` DynamoDB table (`user_id` PK) — attribute `settings.controls`  
(No new table; same profile row as `connection_hierarchy`.)

**API:** `PATCH /user-profile` with `{ "action": "update_settings", "settings": { "controls": { ... } } }`  
**GET** `/user-profile` now returns `settings`.

**UI:** Profile icon (top right) → Settings → Controls / keybinds (`/console/settings`)

**Live stream:** `usePressedInputs` joins currently held keyboard `code`s and gamepad tokens, e.g. `KeyA+KeyW+GP0-BTN0`.

## Gamepads (Xbox / PlayStation)

Use the browser [Gamepad API](https://developer.mozilla.org/en-US/docs/Web/API/Gamepad_API):

1. Plug in USB or pair Bluetooth.
2. Press any button once so the browser “wakes” the pad (`gamepadconnected`).
3. Chromium maps Xbox and DualSense to the **standard** layout (same button indices).
4. We poll `navigator.getGamepads()` every animation frame.

Safari / some Firefox builds are weaker on DualSense over Bluetooth; Chrome/Edge recommended for now.

## Deploy

1. Deploy **user-profile-api** Lambda (settings merge) — e.g. `tfpush` from RDI-1.0 app terraform.  
2. Deploy frontend with the settings page.
