# Collect Transfer Relay

WebRTC signaling relay that pairs two AsTeRICS Grid sessions and forwards offer/answer/ICE payloads so the browsers can speak over a direct data channel. The relay keeps everything in memory and stores no collect data, which makes it easy to host centrally while still supporting an ARE-hosted fallback when needed.

## Features
- Two peers per token: the first browser that sends an offer becomes the *offerer*, the second automatically registers as the *answerer*.
- Stateless JSON signaling (`offer`, `answer`, `ice`, `peer-disconnected`) with optional token verification hooks.
- Health endpoint and heartbeat loop to prune idle pairs.
- Optional TURN support on the client side (Grid can supply TURN credentials when strict firewalls require a relay).

## Getting Started

```bash
cd collect-transfer-relay
npm install
npm run start:allow-all   # development mode without token verification
```

The server listens on `0.0.0.0:8080` by default and exposes the WebSocket endpoint at `/ws`. A `GET /health` endpoint returns basic status metrics:

```json
{"status":"ok","pairs":0,"clients":0}
```

### Environment Variables
| Name | Default | Description |
| --- | --- | --- |
| `PORT` | `8080` | HTTP/WebSocket port. |
| `HOST` | `0.0.0.0` | Interface to bind. |
| `WS_PATH` | `/ws` | WebSocket path. |
| `HEARTBEAT_INTERVAL_MS` | `30000` | Interval for ping / cleanup cycles. |
| `ROOM_TTL_MS` | `300000` | Idle time before an unused pair is purged. |
| `MAX_PEERS_PER_ROOM` | `2` | Hard cap on simultaneous peers per token. |
| `AUTH_MODE` | `cloud` | `cloud`, `allow-all`, `shared-secret`, or `are`. |
| `AUTH_VERIFY_URL` | — | Verification endpoint for `cloud`/`are` modes. |
| `AUTH_API_KEY` | — | Bearer token added to cloud verification requests. |
| `AUTH_SHARED_SECRET` | — | Shared secret used when `AUTH_MODE=shared-secret`. |

### Token Verification Modes
- **Cloud (default)** – POST `{ token, userId }` to `AUTH_VERIFY_URL` with optional `AUTH_API_KEY` and expect `{ "valid": true }`.
- **Shared Secret** – compare the incoming token with `AUTH_SHARED_SECRET`.
- **ARE** – identical to cloud mode but typically pointed at an ARE endpoint on the local network.
- **Allow All** – accept every token (development only). `npm run start:allow-all` sets this automatically.

## Signaling Contract

All frames are JSON objects with a `type` field. The most important payloads are:

- **Offer** – sent by the first peer to register the token and share the SDP offer.
  ```json
  { "type": "offer", "payload": { "token": "pair-123", "sdp": "...", "userId": "userA" } }
  ```
- **Answer** – sent by the second peer to set its SDP (the payload may omit `sdp` when only announcing readiness).
  ```json
  { "type": "answer", "payload": { "token": "pair-123", "sdp": "...", "userId": "userB" } }
  ```
- **ICE** – trickle ICE candidates in either direction.
  ```json
  { "type": "ice", "payload": { "token": "pair-123", "candidate": { ... } } }
  ```

Auxiliary notifications include `offer-registered`, `answer-registered`, and `peer-disconnected` so clients can update their status UI. All messages are transient; if a client reconnects it simply repeats the offer/answer flow.

## ICE Servers

Browsers always start with a public STUN server (currently `stun:stun.l.google.com:19302`). If a deployment needs TURN, configure a TURN URL (and optional credentials) in the AsTeRICS Grid UI. When TURN is enabled all traffic is relayed by that TURN server, so only enable it for locked-down environments.

## Testing

```bash
npm test   # spins up the relay and has two wrtc peers exchange a message over the data channel
```

## License

MIT
