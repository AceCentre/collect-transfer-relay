# Collect Transfer Relay

Lightweight WebSocket relay that fans out collect messages between connected AsTeRICS Grid clients. The relay keeps connections in-memory, making it easy to host centrally while allowing an ARE-hosted fallback when needed.

## Features
- Join rooms anchored to existing AsTeRICS user IDs or shared pairing codes.
- Broadcast collect payloads to peers with optional acknowledgements.
- Configurable health endpoint and heartbeat cleanup for idle rooms.
- Pluggable token verification supporting cloud-hosted auth or an ARE fallback.

## Getting Started

```bash
cd collect-transfer-relay
npm install
npm run start:allow-all # development mode without token validation
```

The server listens on `0.0.0.0:8080` by default and exposes the WebSocket endpoint at `/ws`. A `GET /health` endpoint returns basic status metrics.

### Environment Variables
| Name | Default | Description |
| --- | --- | --- |
| `PORT` | `8080` | Port for the HTTP/WebSocket server. |
| `HOST` | `0.0.0.0` | Host interface to bind. |
| `WS_PATH` | `/ws` | Path for the WebSocket endpoint. |
| `HEARTBEAT_INTERVAL_MS` | `30000` | Interval for ping/clean cycle. |
| `ROOM_TTL_MS` | `300000` | Idle time before empty rooms are purged. |
| `AUTH_MODE` | `cloud` | Token verification strategy: `cloud`, `allow-all`, `shared-secret`, or `are`. |
| `AUTH_VERIFY_URL` | _unset_ | Cloud/ARE verification endpoint for `cloud`/`are` modes. |
| `AUTH_API_KEY` | _unset_ | Bearer token appended to verification requests in cloud mode. |
| `AUTH_SHARED_SECRET` | _unset_ | Shared secret required when `AUTH_MODE=shared-secret`. |

### Token Verification Modes
- **Cloud (default)**: POSTs `{ token, roomId, userId }` to `AUTH_VERIFY_URL` with optional `AUTH_API_KEY` bearer credential. Expects `{ "valid": true }` on success.
- **Shared Secret**: compares the incoming token against `AUTH_SHARED_SECRET`.
- **ARE**: POSTs the same payload to a locally hosted ARE verification service defined by `AUTH_VERIFY_URL`.
- **Allow All**: accepts every token (intended for development only). The shortcut script `npm run start:allow-all` sets this mode.

## Message Contract

All WebSocket frames must be JSON objects with a `type` field and `payload` object.

### Join
```json
{
  "type": "join",
  "payload": {
    "roomId": "user:abc123",
    "token": "<short-lived-auth-token>",
    "userId": "abc123"
  }
}
```

### Collect
```json
{
  "type": "collect",
  "payload": {
    "messageId": "uuid-1",
    "roomId": "user:abc123",
    "senderId": "abc123",
    "data": {
      "version": "1",
      "id": "collect-id",
      "timestamp": 1737948723,
      "elements": []
    }
  }
}
```

Receivers obtain the same structure plus a `receivedAt` timestamp. Clients are expected to deduplicate messages using `messageId`.

### Ack (optional)
```json
{
  "type": "ack",
  "payload": {
    "messageId": "uuid-1",
    "targetUserId": "abc123"
  }
}
```

## Testing

```bash
npm test # runs a smoke test that spins up the relay and relays a collect + ack between two clients
```

## Next Steps
- Integrate cloud verification with the production Grid auth service.
- Add structured logging and metrics export for production monitoring.
- Package the relay as an ARE plugin and Docker image once the protocol settles.

## License
MIT
