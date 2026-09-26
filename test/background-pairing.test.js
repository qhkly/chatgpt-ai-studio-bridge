import assert from 'node:assert/strict';
import test from 'node:test';

import { setupBackground } from './helpers/fake-background.js';
import { formatDiagnostics } from '../src/status.js';

const TOKEN = 'paired-device-token-DO-NOT-LEAK';
const ROUTE_ID = '11111111-2222-3333-4444-555555555555';
const URL_A = 'https://chatgpt.com/c/b72b6f8f-20ce-4c89-a54f-7cb52c9d0f42';

const flush = async (rounds = 20) => {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const claimResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const PAIRED = {
  deviceId: 'dev-42',
  deviceToken: TOKEN,
  relayUrl: 'https://notify.qhkly.com',
};

// Captures console output so tests can assert the token never gets logged.
const captureConsole = () => {
  const lines = [];
  const originals = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    originals[level] = console[level];
    console[level] = (...args) => lines.push(args.map((arg) =>
      arg instanceof Error ? arg.stack : typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' '));
  }
  return {
    text: () => lines.join('\n'),
    restore: () => Object.assign(console, originals),
  };
};

const withBackground = (options, run) => async () => {
  const logs = captureConsole();
  const world = await setupBackground({ tabs: [{ id: 7, url: URL_A }], ...options });
  try {
    await run(world, logs);
  } finally {
    world.restoreGlobals();
    logs.restore();
  }
};

const fetchReturning = (response, calls = []) => async (url, init) => {
  calls.push({ url, init });
  if (response instanceof Error) throw response;
  return response;
};

const remoteSockets = (world) => world.sockets.filter((socket) => socket.url.startsWith('wss://'));
const pair = (world, code) => world.send({ type: 'aiStudio.popup.pairRemote', code });

test('pairing stores the device token and starts the remote relay immediately', async () => {
  const calls = [];
  await withBackground({ fetch: fetchReturning(claimResponse(200, PAIRED), calls) }, async (world, logs) => {
    await flush();
    assert.equal(remoteSockets(world).length, 0, 'not configured before pairing');

    const response = await pair(world, ' 123 456 ');
    await flush();

    assert.deepEqual(response, { ok: true }, 'popup response carries no token');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://notify.qhkly.com/v1/pairings/claim');
    assert.equal(JSON.parse(calls[0].init.body).code, '123456');

    assert.deepEqual(world.chrome.storage.local.data.remoteRelay, {
      enabled: true,
      url: 'https://notify.qhkly.com',
      token: TOKEN,
      deviceId: 'dev-42',
    });

    const sockets = remoteSockets(world);
    assert.equal(sockets.length, 1, 'exactly one remote socket');
    assert.equal(sockets[0].url, 'wss://notify.qhkly.com/ws?token=' + TOKEN);
    sockets[0].open();

    const snapshot = await world.popup('aiStudio.popup.getStatus', 7);
    assert.deepEqual(snapshot.remoteRelay, { enabled: true, connected: true });
    for (const text of [JSON.stringify(snapshot), formatDiagnostics(snapshot), logs.text()]) {
      assert.ok(!text.includes(TOKEN), 'device token leaked');
    }
  })();
});

test('failed pairing leaves storage untouched and explains why', async () => {
  const cases = [
    [claimResponse(410, { error: 'expired' }), 'code-expired'],
    [claimResponse(404, {}), 'code-invalid'],
    [new TypeError('Failed to fetch'), 'network'],
  ];
  for (const [response, reason] of cases) {
    await withBackground({ fetch: fetchReturning(response) }, async (world, logs) => {
      assert.deepEqual(await pair(world, '123456'), { ok: false, reason });
      await flush();
      assert.equal(world.chrome.storage.local.data.remoteRelay, undefined);
      assert.equal(remoteSockets(world).length, 0);
      assert.ok(!logs.text().includes(TOKEN));
    })();
  }
});

test('a malformed code is rejected before any network call', async () => {
  const calls = [];
  await withBackground({ fetch: fetchReturning(claimResponse(200, PAIRED), calls) }, async (world) => {
    assert.deepEqual(await pair(world, '12 345'), { ok: false, reason: 'invalid-format' });
    assert.equal(calls.length, 0);
  })();
});

test('pairing and disconnect requests from a web page are ignored', async () => {
  const calls = [];
  await withBackground({ fetch: fetchReturning(claimResponse(200, PAIRED), calls) }, async (world) => {
    assert.equal(await world.fromTab(7, { type: 'aiStudio.popup.pairRemote', code: '123456' }), undefined);
    assert.equal(await world.fromTab(7, { type: 'aiStudio.popup.disconnectRemote' }), undefined);
    assert.equal(calls.length, 0);
  })();
});

test('disconnect forgets only the local token and closes the relay socket', withBackground({
  local: { remoteRelay: { enabled: true, url: 'https://notify.qhkly.com', token: TOKEN, deviceId: 'dev-42' } },
}, async (world) => {
  await flush();
  const [socket] = remoteSockets(world);
  socket.open();

  assert.deepEqual(await world.send({ type: 'aiStudio.popup.disconnectRemote' }), { ok: true });
  await flush();

  assert.deepEqual(world.chrome.storage.local.data.remoteRelay, {
    enabled: false,
    url: 'https://notify.qhkly.com',
    token: '',
  });
  assert.equal(socket.readyState, 3, 'socket closed');
  assert.equal(remoteSockets(world).length, 1, 'no reconnect without a token');

  const snapshot = await world.popup('aiStudio.popup.getStatus', 7);
  assert.deepEqual(snapshot.remoteRelay, { enabled: false, connected: false });
}));

test('local and remote copies of one completion are delivered once', withBackground({
  local: { remoteRelay: { enabled: true, url: 'https://notify.qhkly.com', token: TOKEN } },
}, async (world) => {
  await flush();
  const local = world.localSocket();
  const [remote] = remoteSockets(world);
  local.open();
  remote.open();

  const delivered = [];
  world.tabHandlers.set(7, (message) => {
    if (message.type === 'aiStudio.taskCompleted') delivered.push(message.event.eventId);
    return { ok: true };
  });
  await world.fromTab(7, { type: 'aiStudio.routeRegistered', routeId: ROUTE_ID });

  const event = JSON.stringify({
    type: 'task.completed',
    eventId: 'evt-dup',
    sessionId: 'session-1',
    routeId: ROUTE_ID,
  });
  local._fire('message', { data: event });
  await flush();
  remote._fire('message', { data: event });
  await flush();

  assert.deepEqual(delivered, ['evt-dup']);
  assert.ok(remote.sent.some((raw) => JSON.parse(raw).type === 'ack'), 'remote copy still ACKed');
}));
