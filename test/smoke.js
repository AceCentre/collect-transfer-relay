const assert = require('node:assert');
const WebSocket = require('ws');
const { createRelayServer } = require('../src/server');

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function waitForMessage(ws, { type, timeoutMs = 2000 }) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for message type "${type}"`));
    }, timeoutMs);

    function handler(raw) {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch (err) {
        cleanup();
        reject(err);
        return;
      }
      if (type && message.type !== type) {
        return; // keep listening until desired type arrives
      }
      cleanup();
      resolve(message);
    }

    function cleanup() {
      clearTimeout(timer);
      ws.off('message', handler);
    }

    ws.on('message', handler);
  });
}

function openClient(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', (err) => reject(err));
  });
}

async function joinRoom(ws, { roomId, token, userId }) {
  ws.send(
    JSON.stringify({
      type: 'join',
      payload: { roomId, token, userId },
    })
  );
  const joined = await waitForMessage(ws, { type: 'joined' });
  assert.strictEqual(joined.payload.roomId, roomId, 'roomId mismatch on join confirmation');
}

async function run() {
  const relay = createRelayServer({
    authMode: 'allow-all',
    host: '127.0.0.1',
    wsPath: '/ws',
    logger: silentLogger,
  });

  const address = await relay.listen(0); // ephemeral port
  const host = address.address === '::' ? '127.0.0.1' : address.address;
  const baseUrl = `ws://${host}:${address.port}${relay.config.wsPath}`;

  const clientA = await openClient(baseUrl);
  const clientB = await openClient(baseUrl);

  try {
    const roomId = 'room:smoke-test';
    await Promise.all([
      joinRoom(clientA, { roomId, token: 'token-a', userId: 'userA' }),
      joinRoom(clientB, { roomId, token: 'token-b', userId: 'userB' }),
    ]);

    const expectedPayload = {
      messageId: 'mid-1',
      roomId,
      senderId: 'userA',
      data: {
        version: '1',
        id: 'collect-1',
        timestamp: Date.now(),
        elements: [],
      },
    };

    const collectPromise = waitForMessage(clientB, { type: 'collect' });

    clientA.send(JSON.stringify({ type: 'collect', payload: expectedPayload }));

    const collectMessage = await collectPromise;
    assert.strictEqual(collectMessage.type, 'collect');
    assert.strictEqual(collectMessage.payload.messageId, expectedPayload.messageId);
    assert.strictEqual(collectMessage.payload.roomId, roomId);
    assert.strictEqual(collectMessage.payload.senderId, 'userA');
    assert.deepStrictEqual(collectMessage.payload.data.id, expectedPayload.data.id);

    const ackPromise = waitForMessage(clientA, { type: 'ack' });
    clientB.send(
      JSON.stringify({
        type: 'ack',
        payload: {
          messageId: expectedPayload.messageId,
          targetUserId: 'userA',
        },
      })
    );
    const ackMessage = await ackPromise;
    assert.strictEqual(ackMessage.type, 'ack');
    assert.strictEqual(ackMessage.payload.messageId, expectedPayload.messageId);
  } finally {
    clientA.close();
    clientB.close();
    await relay.close();
  }

  console.log('Smoke test passed');
}

run().catch((err) => {
  console.error('Smoke test failed:', err);
  process.exitCode = 1;
});
