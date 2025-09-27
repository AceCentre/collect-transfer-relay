const assert = require('node:assert');
const WebSocket = require('ws');
const wrtc = require('wrtc');
const { createRelayServer } = require('../src/server');

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

async function waitForOpen(ws) {
  if (ws.readyState === ws.OPEN) {
    return;
  }
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
}

function waitForMessage(ws, expectedType, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for message type "${expectedType}"`));
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
      if (expectedType && message.type !== expectedType) {
        return;
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

async function setupOfferer(signalingUrl, token) {
  const ws = new WebSocket(signalingUrl);
  await waitForOpen(ws);

  const pc = new wrtc.RTCPeerConnection({ iceServers: [] });
  const dataChannel = pc.createDataChannel('collect');

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      ws.send(
        JSON.stringify({
          type: 'ice',
          payload: {
            token,
            candidate: event.candidate,
          },
        })
      );
    }
  };

  ws.on('message', async (raw) => {
    const message = JSON.parse(raw.toString());
    switch (message.type) {
      case 'answer': {
        const desc = new wrtc.RTCSessionDescription({ type: 'answer', sdp: message.payload.sdp });
        await pc.setRemoteDescription(desc);
        break;
      }
      case 'ice': {
        await pc.addIceCandidate(new wrtc.RTCIceCandidate(message.payload.candidate));
        break;
      }
      case 'peer-disconnected': {
        // ignore for smoke test
        break;
      }
      default:
        break;
    }
  });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  ws.send(
    JSON.stringify({
      type: 'offer',
      payload: {
        token,
        sdp: offer.sdp,
      },
    })
  );

  await waitForMessage(ws, 'offer-registered');

  return { pc, ws, dataChannel };
}

async function setupAnswerer(signalingUrl, token) {
  const ws = new WebSocket(signalingUrl);
  await waitForOpen(ws);

  const pc = new wrtc.RTCPeerConnection({ iceServers: [] });
  let dataChannel;

  pc.ondatachannel = (event) => {
    dataChannel = event.channel;
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      ws.send(
        JSON.stringify({
          type: 'ice',
          payload: {
            token,
            candidate: event.candidate,
          },
        })
      );
    }
  };

  ws.on('message', async (raw) => {
    const message = JSON.parse(raw.toString());
    switch (message.type) {
      case 'offer': {
        const desc = new wrtc.RTCSessionDescription({ type: 'offer', sdp: message.payload.sdp });
        await pc.setRemoteDescription(desc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        ws.send(
          JSON.stringify({
            type: 'answer',
            payload: {
              token,
              sdp: answer.sdp,
            },
          })
        );
        break;
      }
      case 'ice': {
        await pc.addIceCandidate(new wrtc.RTCIceCandidate(message.payload.candidate));
        break;
      }
      case 'peer-disconnected': {
        // ignore for smoke test
        break;
      }
      default:
        break;
    }
  });

  await waitForMessage(ws, 'answer-registered');

  return new Promise((resolve) => {
    const checkChannel = () => {
      if (dataChannel) {
        resolve({ pc, ws, dataChannel });
      } else {
        setTimeout(checkChannel, 10);
      }
    };
    checkChannel();
  });
}

async function run() {
  const relay = createRelayServer({
    authMode: 'allow-all',
    host: '127.0.0.1',
    wsPath: '/ws',
    logger: silentLogger,
  });

  const address = await relay.listen(0);
  const host = address.address === '::' ? '127.0.0.1' : address.address;
  const baseUrl = `ws://${host}:${address.port}${relay.config.wsPath}`;
  const token = 'rtc-smoke-token';

  const offerer = await setupOfferer(baseUrl, token);
  const answerer = await setupAnswerer(baseUrl, token);

  try {
    const offerChannel = offerer.dataChannel;
    const answerChannel = answerer.dataChannel;

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Data channel did not open'));
      }, 5000);

      function handleOpen() {
        if (offerChannel.readyState === 'open' && answerChannel.readyState === 'open') {
          clearTimeout(timer);
          resolve();
        }
      }

      offerChannel.onopen = handleOpen;
      answerChannel.onopen = handleOpen;
      handleOpen();
    });

    const received = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Did not receive message over data channel')), 5000);
      answerChannel.onmessage = (event) => {
        clearTimeout(timer);
        resolve(event.data);
      };
    });

    offerChannel.send('collect-transfer-smoke');
    const message = await received;
    assert.strictEqual(message, 'collect-transfer-smoke');
  } finally {
    offerer.dataChannel?.close();
    offerer.pc.close();
    offerer.ws.close();
    answerer.dataChannel?.close();
    answerer.pc.close();
    answerer.ws.close();
    await relay.close();
  }

  console.log('WebRTC smoke test passed');
}

run().catch((err) => {
  console.error('Smoke test failed:', err);
  process.exitCode = 1;
});
