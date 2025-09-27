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
    pairTtlMs: parseNumber(options.pairTtlMs ?? process.env.ROOM_TTL_MS, 5 * 60 * 1000),
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
      config.logger.warn('[signal] shared-secret mode enabled but AUTH_SHARED_SECRET missing; denying all tokens');
      return async () => false;
    }
    return async (token) => token === secret;
  }

  if (mode === 'are') {
    const areUrl = config.authVerifyUrl;
    if (!areUrl) {
      config.logger.warn('[signal] ARE auth mode enabled but AUTH_VERIFY_URL missing; denying all tokens');
      return async () => false;
    }
    return async (token, _roomId, userId) => {
      try {
        const response = await fetch(areUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ token, userId }),
        });
        if (!response.ok) {
          config.logger.warn('[signal] ARE token verification failed', { status: response.status });
          return false;
        }
        const data = await response.json().catch(() => null);
        return Boolean(data && data.valid === true);
      } catch (err) {
        config.logger.error('[signal] ARE token verification error', err);
        return false;
      }
    };
  }

  const verifyUrl = config.authVerifyUrl;
  if (!verifyUrl) {
    config.logger.warn('[signal] cloud auth mode enabled but AUTH_VERIFY_URL missing; denying all tokens');
    return async () => false;
  }

  return async (token, _roomId, userId) => {
    try {
      const response = await fetch(verifyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.authApiKey ? { Authorization: `Bearer ${config.authApiKey}` } : {}),
        },
        body: JSON.stringify({ token, userId }),
      });
      if (!response.ok) {
        config.logger.warn('[signal] cloud token verification failed', { status: response.status });
        return false;
      }
      const data = await response.json().catch(() => null);
      return Boolean(data && data.valid === true);
    } catch (err) {
      config.logger.error('[signal] cloud token verification error', err);
      return false;
    }
  };
}

function createRelayServer(options = {}) {
  const config = buildConfig(options);
  const verifyToken = buildTokenVerifier(config, options);

  /** @type {Map<string, any>} */
  const pairs = new Map();

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      const body = JSON.stringify({
        status: 'ok',
        pairs: pairs.size,
        clients: wss.clients.size,
      });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'private',
      });
      res.end(body);
      return;
    }

    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ server, path: config.wsPath });

  /** @type {Map<string, PairRecord>} */
  // reuse the same pairs map declared above

  function now() {
    return Date.now();
  }

  function createEmptyPair(token) {
    return {
      token,
      createdAt: now(),
      lastActivity: now(),
      offerer: null,
      answerer: null,
      pendingOffer: null,
      pendingCandidates: {
        offerer: [],
        answerer: [],
      },
    };
  }

  function getOrCreatePair(token) {
    let pair = pairs.get(token);
    if (!pair) {
      pair = createEmptyPair(token);
      pairs.set(token, pair);
    }
    return pair;
  }

  function touchPair(pair) {
    pair.lastActivity = now();
  }

  function send(socket, type, payload) {
    if (socket.readyState !== socket.OPEN) {
      return;
    }
    try {
      socket.send(JSON.stringify({ type, payload }));
    } catch (err) {
      config.logger.warn('[signal] failed to send message', err);
    }
  }

  function sendError(socket, code, message) {
    send(socket, 'error', { code, message });
  }

  function detachSocket(socket, reason = 'disconnect') {
    const token = socket.__pairToken;
    const role = socket.__pairRole;
    if (!token || !role) {
      return;
    }
    const pair = pairs.get(token);
    if (!pair) {
      return;
    }

    if (pair[role] && pair[role].socket === socket) {
      pair[role] = null;
      pair.pendingCandidates[role] = [];
      touchPair(pair);
      const otherRole = role === 'offerer' ? 'answerer' : 'offerer';
      const other = pair[otherRole];
      if (other && other.socket && other.socket.readyState === other.socket.OPEN) {
        send(other.socket, 'peer-disconnected', { reason });
      }
    }

    delete socket.__pairToken;
    delete socket.__pairRole;
    delete socket.__pairUserId;

    if (!pair.offerer && !pair.answerer) {
      pairs.delete(token);
    }
  }

  function forwardPendingOffer(pair) {
    if (!pair.pendingOffer) {
      return;
    }
    if (pair.answerer && pair.answerer.socket.readyState === pair.answerer.socket.OPEN) {
      send(pair.answerer.socket, 'offer', {
        token: pair.token,
        sdp: pair.pendingOffer.sdp,
        userId: pair.pendingOffer.userId,
      });
      pair.pendingOffer = null;
    }
  }

  function flushCandidates(pair, targetRole) {
    const sourceRole = targetRole === 'offerer' ? 'answerer' : 'offerer';
    const target = pair[targetRole];
    if (!target || !pair.pendingCandidates[sourceRole]) {
      return;
    }
    const queue = pair.pendingCandidates[sourceRole];
    if (!queue.length) {
      return;
    }
    for (const candidate of queue) {
      send(target.socket, 'ice', {
        token: pair.token,
        candidate,
      });
    }
    pair.pendingCandidates[sourceRole] = [];
  }

  async function handleOffer(socket, payload) {
    const token = payload?.token;
    const sdp = payload?.sdp;
    const userId = payload?.userId ?? null;
    if (!token || !sdp) {
      sendError(socket, 'invalid_offer', 'token and sdp are required');
      return;
    }

    if (!(await verifyToken(token, token, userId))) {
      sendError(socket, 'unauthorized', 'token rejected');
      socket.close(4403, 'unauthorized');
      return;
    }

    const pair = getOrCreatePair(token);
    touchPair(pair);

    if (pair.offerer && pair.offerer.socket !== socket) {
      sendError(socket, 'token_in_use', 'offer already registered for this token');
      return;
    }

    pair.offerer = { socket, userId };
    pair.pendingOffer = { sdp, userId };

    socket.__pairToken = token;
    socket.__pairRole = 'offerer';
    socket.__pairUserId = userId;

    send(socket, 'offer-registered', { token });
    forwardPendingOffer(pair);
    flushCandidates(pair, 'answerer');
  }

  async function handleAnswer(socket, payload) {
    const token = payload?.token;
    const sdp = payload?.sdp;
    const userId = payload?.userId ?? null;
    if (!token) {
      sendError(socket, 'invalid_answer', 'token is required');
      return;
    }

    if (!(await verifyToken(token, token, userId))) {
      sendError(socket, 'unauthorized', 'token rejected');
      socket.close(4403, 'unauthorized');
      return;
    }

    const pair = getOrCreatePair(token);
    touchPair(pair);

    if (pair.answerer && pair.answerer.socket !== socket) {
      sendError(socket, 'token_in_use', 'answer already registered for this token');
      return;
    }

    pair.answerer = { socket, userId };
    socket.__pairToken = token;
    socket.__pairRole = 'answerer';
    socket.__pairUserId = userId;

    send(socket, 'answer-registered', { token });

    if (!sdp) {
      forwardPendingOffer(pair);
      flushCandidates(pair, 'answerer');
      return;
    }

    if (!pair.offerer || !pair.offerer.socket || pair.offerer.socket.readyState !== pair.offerer.socket.OPEN) {
      sendError(socket, 'no_offer', 'No registered offer for this token');
      return;
    }

    send(pair.offerer.socket, 'answer', { token, sdp, userId });
    flushCandidates(pair, 'offerer');
  }

  function forwardIce(socket, payload) {
    const token = payload?.token;
    const candidate = payload?.candidate;
    if (!token || !candidate) {
      sendError(socket, 'invalid_candidate', 'token and candidate are required');
      return;
    }

    const role = socket.__pairRole;
    if (!role || socket.__pairToken !== token) {
      sendError(socket, 'not_registered', 'register offer or answer before sending ICE');
      return;
    }

    const pair = pairs.get(token);
    if (!pair) {
      sendError(socket, 'unknown_token', 'pairing token not found');
      return;
    }

    touchPair(pair);
    const otherRole = role === 'offerer' ? 'answerer' : 'offerer';
    const other = pair[otherRole];
    if (other && other.socket.readyState === other.socket.OPEN) {
      send(other.socket, 'ice', { token, candidate });
    } else {
      pair.pendingCandidates[role].push(candidate);
    }
  }

  function handleLeave(socket) {
    if (!socket.__pairToken) {
      return;
    }
    detachSocket(socket, 'leave');
  }

  async function handleMessage(socket, raw) {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch (err) {
      sendError(socket, 'invalid_json', 'Message must be valid JSON');
      return;
    }

    const { type, payload = {} } = message || {};
    switch (type) {
      case 'offer':
        await handleOffer(socket, payload);
        break;
      case 'answer':
        await handleAnswer(socket, payload);
        break;
      case 'ice':
        forwardIce(socket, payload);
        break;
      case 'leave':
        handleLeave(socket);
        break;
      default:
        sendError(socket, 'unknown_type', `Unsupported message type: ${type}`);
    }
  }

  wss.on('connection', (socket) => {
    socket.isAlive = true;

    socket.on('pong', () => {
      socket.isAlive = true;
    });

    socket.on('message', (raw) => {
      handleMessage(socket, raw).catch((err) => {
        config.logger.error('[signal] message handler error', err);
        sendError(socket, 'internal_error', 'Unexpected server error');
      });
    });

    socket.on('close', () => {
      detachSocket(socket, 'disconnect');
    });

    socket.on('error', (err) => {
      config.logger.error('[signal] socket error', err);
      detachSocket(socket, 'error');
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
        config.logger.error('[signal] failed to ping client', err);
      }
    }

    const expiry = now() - config.pairTtlMs;
    for (const pair of pairs.values()) {
      const hasActiveSockets = Boolean(pair.offerer || pair.answerer);
      if (!hasActiveSockets && pair.lastActivity < expiry) {
        pairs.delete(pair.token);
      }
    }
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
    config.logger.info('[signal] listening', { host: address.address, port: address.port, wsPath: config.wsPath });
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
        config.logger.error('[signal] failed to terminate client', err);
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
    pairs.clear();
  }

  return {
    config,
    listen,
    close,
    server,
    wss,
    pairs,
  };
}

if (require.main === module) {
  const relay = createRelayServer();
  relay
    .listen()
    .catch((err) => {
      console.error('[signal] failed to start', err);
      process.exitCode = 1;
    });
}

module.exports = { createRelayServer };
