#!/usr/bin/env node

const http = require('http');
const { WebSocketServer } = require('ws');

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildConfig(options = {}) {
  return {
    host: options.host || process.env.HOST || '0.0.0.0',
    port: parseNumber(options.port ?? process.env.PORT, 8080),
    wsPath: options.wsPath || process.env.WS_PATH || '/ws',
    heartbeatIntervalMs: parseNumber(options.heartbeatIntervalMs ?? process.env.HEARTBEAT_INTERVAL_MS, 30000),
    roomTtlMs: parseNumber(options.roomTtlMs ?? process.env.ROOM_TTL_MS, 5 * 60 * 1000),
    authMode: (options.authMode || process.env.AUTH_MODE || 'cloud').toLowerCase(),
    authVerifyUrl: options.authVerifyUrl || process.env.AUTH_VERIFY_URL || '',
    authApiKey: options.authApiKey || process.env.AUTH_API_KEY || '',
    sharedSecret: options.sharedSecret || process.env.AUTH_SHARED_SECRET || '',
    logger: options.logger || console,
  };
}

function buildTokenVerifier(config, overrides = {}) {
  if (typeof overrides.verifyToken === 'function') {
    return overrides.verifyToken;
  }

  const mode = config.authMode;

  if (mode === 'allow-all') {
    return async () => true;
  }

  if (mode === 'shared-secret') {
    const secret = config.sharedSecret;
    if (!secret) {
      config.logger.warn('[relay] shared-secret mode enabled but AUTH_SHARED_SECRET missing; denying all tokens');
      return async () => false;
    }
    return async (token) => token === secret;
  }

  if (mode === 'are') {
    const areUrl = config.authVerifyUrl;
    if (!areUrl) {
      config.logger.warn('[relay] ARE auth mode enabled but AUTH_VERIFY_URL missing; denying all tokens');
      return async () => false;
    }
    return async (token, roomId, userId) => {
      try {
        const response = await fetch(areUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ token, roomId, userId }),
        });
        if (!response.ok) {
          config.logger.warn('[relay] ARE token verification failed', { status: response.status });
          return false;
        }
        const data = await response.json().catch(() => null);
        return Boolean(data && data.valid === true);
      } catch (err) {
        config.logger.error('[relay] ARE token verification error', err);
        return false;
      }
    };
  }

  // Default cloud verification mode.
  const verifyUrl = config.authVerifyUrl;
  if (!verifyUrl) {
    config.logger.warn('[relay] cloud auth mode enabled but AUTH_VERIFY_URL missing; denying all tokens');
    return async () => false;
  }

  return async (token, roomId, userId) => {
    try {
      const response = await fetch(verifyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.authApiKey ? { Authorization: `Bearer ${config.authApiKey}` } : {}),
        },
        body: JSON.stringify({ token, roomId, userId }),
      });
      if (!response.ok) {
        config.logger.warn('[relay] cloud token verification failed', { status: response.status });
        return false;
      }
      const data = await response.json().catch(() => null);
      return Boolean(data && data.valid === true);
    } catch (err) {
      config.logger.error('[relay] cloud token verification error', err);
      return false;
    }
  };
}

function createRelayServer(options = {}) {
  const config = buildConfig(options);
  const verifyToken = buildTokenVerifier(config, options);

  /** @type {Map<string, { id: string, clients: Set<any>, lastActive: number }>} */
  const rooms = new Map();

  function now() {
    return Date.now();
  }

  function getOrCreateRoom(roomId) {
    let room = rooms.get(roomId);
    if (!room) {
      room = { id: roomId, clients: new Set(), lastActive: now() };
      rooms.set(roomId, room);
    } else {
      room.lastActive = now();
    }
    return room;
  }

  function dropRoomIfEmpty(room) {
    if (room.clients.size === 0) {
      rooms.delete(room.id);
    }
  }

  function cleanExpiredRooms() {
    const cutoff = now() - config.roomTtlMs;
    for (const room of rooms.values()) {
      if (room.clients.size === 0 && room.lastActive < cutoff) {
        rooms.delete(room.id);
      }
    }
  }

  function buildError(type, message) {
    return JSON.stringify({ type: 'error', error: { type, message } });
  }

  function validateJoinPayload(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new Error('Join payload must be an object');
    }
    const { roomId, token, userId } = payload;
    if (!roomId || typeof roomId !== 'string') {
      throw new Error('roomId is required');
    }
    if (roomId.length > 128) {
      throw new Error('roomId is too long');
    }
    if (typeof token !== 'string' || token.length === 0) {
      throw new Error('token is required');
    }
    if (userId && typeof userId !== 'string') {
      throw new Error('userId must be a string');
    }
    return { roomId, token, userId: userId || null };
  }

  function validateCollectPayload(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new Error('collect payload must be an object');
    }
    const { messageId, roomId, senderId, data } = payload;
    if (!messageId || typeof messageId !== 'string') {
      throw new Error('messageId is required');
    }
    if (messageId.length > 128) {
      throw new Error('messageId is too long');
    }
    if (!roomId || typeof roomId !== 'string') {
      throw new Error('roomId is required');
    }
    if (!data || typeof data !== 'object') {
      throw new Error('data must be an object');
    }
    if (senderId && typeof senderId !== 'string') {
      throw new Error('senderId must be a string');
    }
    return { messageId, roomId, senderId: senderId || null, data };
  }

  function attachClientToRoom(client, roomId, userId) {
    const room = getOrCreateRoom(roomId);
    room.clients.add(client);
    client.roomId = roomId;
    client.userId = userId;
    client.joinedAt = now();
    config.logger.info('[relay] user joined room', { roomId, userId, clientCount: room.clients.size });
  }

  function detachClient(client) {
    if (!client.roomId) {
      return;
    }
    const room = rooms.get(client.roomId);
    if (!room) {
      return;
    }
    room.clients.delete(client);
    client.roomId = undefined;
    client.userId = undefined;
    client.joinedAt = undefined;
    room.lastActive = now();
    config.logger.info('[relay] user left room', { roomId: room.id, clientCount: room.clients.size });
    dropRoomIfEmpty(room);
  }

  function forwardCollect(sender, { messageId, roomId, senderId, data }) {
    const room = rooms.get(roomId);
    if (!room) {
      sender.send(buildError('room_not_found', 'Room is not active'));
      return;
    }
    const envelope = JSON.stringify({
      type: 'collect',
      payload: {
        messageId,
        roomId,
        senderId: senderId || sender.userId || null,
        data,
        receivedAt: new Date().toISOString(),
      },
    });
    let recipients = 0;
    for (const client of room.clients) {
      if (client === sender) {
        continue;
      }
      try {
        client.send(envelope);
        recipients += 1;
      } catch (err) {
        config.logger.error('[relay] failed to deliver collect', { roomId, messageId, error: err.message });
      }
    }
    config.logger.info('[relay] collect forwarded', { roomId, messageId, recipients });
  }

  function forwardAck(sender, payload) {
    if (!payload || typeof payload !== 'object') {
      sender.send(buildError('ack_failed', 'Ack payload must be an object'));
      return;
    }
    const { messageId, targetUserId } = payload;
    if (!messageId || typeof messageId !== 'string') {
      sender.send(buildError('ack_failed', 'messageId is required'));
      return;
    }
    const room = rooms.get(sender.roomId);
    if (!room) {
      sender.send(buildError('ack_failed', 'Room is not active'));
      return;
    }
    const envelope = JSON.stringify({
      type: 'ack',
      payload: {
        messageId,
        fromUserId: sender.userId || null,
      },
    });
    let delivered = false;
    for (const client of room.clients) {
      if (client === sender) {
        continue;
      }
      if (targetUserId && client.userId !== targetUserId) {
        continue;
      }
      try {
        client.send(envelope);
        delivered = true;
      } catch (err) {
        config.logger.error('[relay] failed to deliver ack', { roomId: room.id, messageId, error: err.message });
      }
    }
    if (!delivered) {
      sender.send(buildError('ack_failed', 'No matching peer to deliver ack'));
    }
  }

  const server = http.createServer((req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', rooms: rooms.size, clients: wss.clients.size }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  const wss = new WebSocketServer({ server, path: config.wsPath });

  function handleMessage(socket, raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw.toString());
    } catch (err) {
      socket.send(buildError('invalid_json', 'Payload must be valid JSON'));
      return;
    }

    if (!parsed || typeof parsed !== 'object') {
      socket.send(buildError('invalid_payload', 'Payload must be an object'));
      return;
    }

    const { type, payload } = parsed;

    if (type === 'join') {
      let joinPayload;
      try {
        joinPayload = validateJoinPayload(payload);
      } catch (err) {
        socket.send(buildError('join_failed', err.message));
        return;
      }

      Promise.resolve(verifyToken(joinPayload.token, joinPayload.roomId, joinPayload.userId))
        .then((valid) => {
          if (!valid) {
            socket.send(buildError('unauthorized', 'Invalid or expired token'));
            socket.close(4401, 'unauthorized');
            return;
          }
          attachClientToRoom(socket, joinPayload.roomId, joinPayload.userId);
          socket.send(JSON.stringify({ type: 'joined', payload: { roomId: joinPayload.roomId } }));
        })
        .catch((err) => {
          config.logger.error('[relay] token verification failed', err);
          socket.send(buildError('unauthorized', 'Token verification error'));
          socket.close(4401, 'unauthorized');
        });
      return;
    }

    if (!socket.roomId) {
      socket.send(buildError('not_joined', 'Join a room before sending messages'));
      return;
    }

    switch (type) {
      case 'collect': {
        try {
          const validated = validateCollectPayload(payload);
          if (validated.roomId !== socket.roomId) {
            throw new Error('roomId does not match joined room');
          }
          forwardCollect(socket, validated);
        } catch (err) {
          socket.send(buildError('collect_failed', err.message));
        }
        break;
      }
      case 'ack':
        forwardAck(socket, payload);
        break;
      default:
        socket.send(buildError('unknown_type', `Unsupported message type: ${type}`));
    }
  }

  wss.on('connection', (socket) => {
    socket.isAlive = true;
    socket.roomId = undefined;
    socket.userId = undefined;

    socket.on('pong', () => {
      socket.isAlive = true;
    });

    socket.on('message', (raw) => handleMessage(socket, raw));

    socket.on('close', () => {
      detachClient(socket);
    });

    socket.on('error', (err) => {
      config.logger.error('[relay] socket error', err);
    });
  });

  function heartbeat() {
    for (const client of wss.clients) {
      if (client.isAlive === false) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      try {
        client.ping();
      } catch (err) {
        config.logger.error('[relay] failed to ping client', err);
      }
    }
    cleanExpiredRooms();
  }

  let heartbeatInterval;

  async function listen(port = config.port, host = config.host) {
    if (heartbeatInterval) {
      throw new Error('Server already listening');
    }
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    heartbeatInterval = setInterval(heartbeat, config.heartbeatIntervalMs);
    const address = server.address();
    config.logger.info('[relay] listening', { host: address.address, port: address.port, wsPath: config.wsPath });
    return address;
  }

  async function close() {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = undefined;
    }
    for (const client of wss.clients) {
      try {
        client.terminate();
      } catch (err) {
        config.logger.error('[relay] failed to terminate client', err);
      }
    }
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  return {
    config,
    listen,
    close,
    server,
    wss,
    rooms,
  };
}

if (require.main === module) {
  const relay = createRelayServer();
  relay
    .listen()
    .catch((err) => {
      console.error('[relay] failed to start', err);
      process.exitCode = 1;
    });
}

module.exports = { createRelayServer };
