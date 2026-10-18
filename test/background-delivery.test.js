// Background side of "one notification → at most one message": ACK only on a
// confirmed send, retry only when the page wrote nothing, and never start an
// event again once an attempt began.
import assert from 'node:assert/strict';
import test from 'node:test';

import { setupBackground } from './helpers/fake-background.js';

const TOKEN = 'relay-token-DO-NOT-LEAK';
const ROUTE_ID = '11111111-2222-3333-4444-555555555555';
const URL_A = 'https://chatgpt.com/c/b72b6f8f-20ce-4c89-a54f-7cb52c9d0f42';
const RELAY = { remoteRelay: { enabled: true, url: 'https://notify.qhkly.com', token: TOKEN } };
const REMOTE = { local: RELAY };

const flush = async (rounds = 30) => {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const quietConsole = () => {
  const originals = { warn: console.warn, error: console.error };
  const lines = [];
  console.warn = console.error = (...args) => lines.push(args.map(String).join(' '));
  return { lines, restore: () => Object.assign(console, originals) };
};

const withBackground = (options, run) => async () => {
  const logs = quietConsole();
  const world = await setupBackground({ tabs: [{ id: 7, url: URL_A }], ...options });
  try {
    await flush();
    await run(world, logs);
  } finally {
    world.restoreGlobals();
    logs.restore();
  }
};

const remoteSocket = (world) =>
  world.sockets.filter((socket) => socket.url.startsWith('wss://')).at(-1);

const acks = (socket) =>
  socket.sent.map((raw) => JSON.parse(raw)).filter((frame) => frame.type === 'ack');

const event = (eventId = 'evt-1') => JSON.stringify({
  type: 'task.completed',
  eventId,
  sessionId: 'session-1',
  routeId: ROUTE_ID,
});

// The tab answers pings and hands each completion to `onCompletion`.
const contentScript = (world, onCompletion) => {
  const calls = [];
  world.tabHandlers.set(7, async (message) => {
    if (message.type === 'aiStudio.ping') return { ok: true };
    if (message.type !== 'aiStudio.taskCompleted') return undefined;
    calls.push(message);
    return onCompletion(message, calls.length);
  });
  return calls;
};

const openRemote = async (world) => {
  const socket = remoteSocket(world);
  socket.open();
  await world.fromTab(7, { type: 'aiStudio.routeRegistered', routeId: ROUTE_ID });
  return socket;
};

const lastDelivery = async (world) =>
  (await world.chrome.storage.session.get('lastDelivery')).lastDelivery;

test('a confirmed send is ACKed once and the event key reaches the page', withBackground(REMOTE, async (world) => {
  const calls = contentScript(world, () => ({ ok: true, state: 'sent', retryable: false }));
  const socket = await openRemote(world);

  socket._fire('message', { data: event() });
  await flush();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].eventKey, 'evt-1');
  assert.deepEqual(acks(socket).map((frame) => frame.eventId), ['evt-1']);
  const stored = await world.chrome.storage.local.get('eventAttempts');
  assert.deepEqual(stored.eventAttempts, {});
}));

test('an unconfirmed attempt is not ACKed, not retried, and replays are dropped', withBackground(REMOTE, async (world, logs) => {
  const calls = contentScript(world, () => ({
    ok: false,
    state: 'unsent',
    retryable: false,
    detail: 'send-disabled;clicks=0',
  }));
  const socket = await openRemote(world);

  socket._fire('message', { data: event() });
  await flush();

  assert.equal(calls.length, 1);
  assert.deepEqual(acks(socket), []);
  assert.equal(socket.readyState, 1, 'the relay is not recycled to force a replay');
  assert.equal(world.badge, '!');
  const delivery = await lastDelivery(world);
  assert.equal(delivery.outcome, 'stopped');
  assert.equal(delivery.detail, 'unsent:send-disabled;clicks=0');
  assert.ok(logs.lines.some((line) => /unconfirmed/.test(line)), 'error is logged explicitly');

  // Relay reconnect replays it, the local bridge sends its copy: both dropped.
  socket._fire('message', { data: event() });
  world.localSocket().open();
  world.localSocket()._fire('message', { data: event() });
  await flush();
  assert.equal(calls.length, 1);
}));

test('a retryable miss (nothing written) recycles the relay and is sent on replay', withBackground(REMOTE, async (world) => {
  const calls = contentScript(world, (_message, n) => (n === 1
    ? { ok: false, state: 'busy', retryable: true, detail: 'composer-has-text' }
    : { ok: true, state: 'sent', retryable: false }));
  const socket = await openRemote(world);

  socket._fire('message', { data: event() });
  await flush();
  assert.equal(socket.readyState, 3, 'closed so the relay replays');
  assert.deepEqual(acks(socket), []);

  world.runTimers();
  await flush();
  const replay = remoteSocket(world);
  assert.notEqual(replay, socket);
  replay.open();
  replay._fire('message', { data: event() });
  await flush();

  assert.equal(calls.length, 2);
  assert.deepEqual(acks(replay).map((frame) => frame.eventId), ['evt-1']);
}));

test('a message channel closed mid-send is ambiguous: stopped, never retried', withBackground(REMOTE, async (world) => {
  const calls = contentScript(world, () => {
    throw new Error('A listener indicated an asynchronous response by returning true, ' +
      'but the message channel closed before a response was received');
  });
  const socket = await openRemote(world);

  socket._fire('message', { data: event() });
  await flush();
  socket._fire('message', { data: event() });
  await flush();

  assert.equal(calls.length, 1);
  assert.deepEqual(acks(socket), []);
  assert.equal((await lastDelivery(world)).detail, 'ambiguous:channel-closed');
}));

test('a message that never reached the page is a plain retryable failure', withBackground(REMOTE, async (world) => {
  const calls = contentScript(world, () => {
    throw new Error('Could not establish connection. Receiving end does not exist.');
  });
  const socket = await openRemote(world);

  socket._fire('message', { data: event() });
  await flush();

  assert.equal(calls.length, 1);
  assert.equal(socket.readyState, 3);
  const stored = await world.chrome.storage.local.get('eventAttempts');
  assert.deepEqual(stored.eventAttempts, {});
}));

test('after a worker restart an in-flight event is re-asked of the same tab only', withBackground({
  local: {
    ...RELAY,
    eventAttempts: { 'evt-1': { state: 'inflight', tabId: 7, at: Date.now() } },
  },
}, async (world) => {
  // The page answers from its own record (it already sent this event).
  const calls = contentScript(world, () => ({ ok: true, state: 'sent', retryable: false }));
  const socket = await openRemote(world);

  socket._fire('message', { data: event() });
  await flush();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].eventKey, 'evt-1');
  assert.deepEqual(acks(socket).map((frame) => frame.eventId), ['evt-1']);
}));

test('an in-flight event owned by another (gone) tab is stopped, not sent to this one', withBackground({
  local: {
    ...RELAY,
    eventAttempts: { 'evt-1': { state: 'inflight', tabId: 99, at: Date.now() } },
  },
}, async (world) => {
  const calls = contentScript(world, () => ({ ok: true, state: 'sent', retryable: false }));
  const socket = await openRemote(world);

  socket._fire('message', { data: event() });
  await flush();

  assert.equal(calls.length, 0);
  assert.deepEqual(acks(socket), []);
  assert.equal((await lastDelivery(world)).detail, 'inflight-in-other-tab');
}));

test('two different completions are both delivered, one at a time', withBackground(REMOTE, async (world) => {
  let active = 0;
  let overlapped = false;
  const calls = contentScript(world, async () => {
    active++;
    if (active > 1) overlapped = true;
    await flush(5);
    active--;
    return { ok: true, state: 'sent', retryable: false };
  });
  const socket = await openRemote(world);

  socket._fire('message', { data: event('evt-1') });
  socket._fire('message', { data: event('evt-2') });
  await flush(60);

  assert.deepEqual(calls.map((message) => message.eventKey), ['evt-1', 'evt-2']);
  assert.equal(overlapped, false);
  assert.deepEqual(acks(socket).map((frame) => frame.eventId), ['evt-1', 'evt-2']);
}));

test('a page response without a retryable flag is never treated as safe to retry', withBackground(REMOTE, async (world) => {
  const calls = contentScript(world, () => ({ ok: false }));
  const socket = await openRemote(world);

  socket._fire('message', { data: event() });
  await flush();
  socket._fire('message', { data: event() });
  await flush();

  assert.equal(calls.length, 1);
  assert.equal(socket.readyState, 1);
}));
