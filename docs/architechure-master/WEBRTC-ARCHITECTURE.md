# RDI WebRTC Data Plane

**Status:** Active — replaces ECS `rdi-proxy` WebSocket tunnel.

## Topology

```
[ Browser Viewer ] ◄── KVS Signaling (WSS) ──► [ AWS Kinesis Video Streams ]
        │                                              ▲
        └──── WebRTC media + data channel (UDP) ───────┘
                              ▲
                              │ outbound signaling
                    [ Pi rdi-agent Master ]
                              │
                         /dev/serial0 or MAVLink UDP
                              │
                    [ Pixhawk / SITL ]
```

**Control plane (unchanged):** API Gateway EDGE + Lambda + DynamoDB (`/sessions`, `/relays`, Cognito).

## Session create flow

1. Console `POST /sessions` with `relay_id`.
2. Session API creates KVS `SINGLE_MASTER` signaling channel named `session_id`.
3. Response includes `transport: "webrtc"` and `webrtc` viewer bundle (endpoint + STS creds).
4. Relay registry item gets `active_session_id` + `signaling_channel_arn`.
5. Pi polls `GET /relays/webrtc-master?device_serial&device_secret` → MASTER creds.
6. Browser + Pi connect via KVS WebRTC SDK (frontend TBD; Pi agent rewrite TBD).

## Deprecated

| Component | Replacement |
|-----------|-------------|
| `module.proxy_ecs` (Fargate) | KVS per-session signaling |
| `rdi-proxy` WebSocket pairing | WebRTC Master/Viewer |
| `SessionWebSocketContext` | WebRTC viewer client (in progress) |
| `PROXY_ENDPOINT` / `wss://` session field | `signaling_channel_arn` + role creds |

Set `use_proxy_ecs = false` and `data_plane = "webrtc"` in tfvars. IAM is provisioned by `terraform/modules/kvs-webrtc`; signaling channels are created per session by Session API Lambda at runtime.

## Phase 1 local spike (no AWS)

See `scripts/webrtc-spike/README.md` — validate UDP-like data channel on workshop Wi‑Fi before KVS integration.

## Safety (Phase 3)

Pi agent watchdog: on data channel `disconnected` or telemetry gap, send MAVLink RTL/Loiter via serial. Test on bench + SITL before flight.
