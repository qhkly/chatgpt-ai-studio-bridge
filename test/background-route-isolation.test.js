// A completion belongs to exactly one conversation. A tab that left that
// conversation, or a URL shared by several tabs, is never a delivery target.
import assert from 'node:assert/strict';
import test from 'node:test';

import { setupBackground } from './helpers/fake-background.js';

const ROUTE_A = '11111111-2222-3333-4444-555555555555';
const ROUTE_B = '66666666-7777-8888-9999-000000000000';
const URL_A = 'https://chatgpt.com/c/b72b6f8f-20ce-4c89-a54f-7cb52c9d0f42';
const URL_B = 'https://chatgpt.com/c/c83c7a9a-31df-4d9a-b65a-8dc63ada1e53';
const NEW_CHAT = 'https://chatgpt.com/';
const RELAY = { local: { remoteRelay: { enabled: true, url: 'https://notify.qhkly.com', token: 't' } } };

const flush = async () => {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
};

const withBackground = (tabs, run) => async () => {
  const originals = { warn: console.warn, error: console.error };
  console.warn = console.error = () => {};
  const world = await setupBackground({ tabs, ...RELAY });
  try {
    await flush();
    await run(world);
  } finally {
    world.restoreGlobals();
    Object.assign(console, originals);
  }
};

// Each tab records the completions it was asked to post.
const attach = (world, tabId) => {
  const calls = [];
  world.tabHandlers.set(tabId, async (message) => {
    if (message.type === 'aiStudio.ping') return { ok: true };
    if (message.type === 'aiStudio.taskCompleted') {
      calls.push(message);
      return { ok: true, state: 'sent', retryable: false };
    }
    return undefined;
  });
  return calls;
};

const complete = async (world, routeId, eventId) => {
  const socket = world.sockets.filter((s) => s.url.startsWith('wss://')).at(-1);
  socket.open();
  socket._fire('message', {
    data: JSON.stringify({ type: 'task.completed', eventId, sessionId: 's', routeId }),
  });
  await flush();
  return socket;
};

const register = (world, tabId, routeId) =>
  world.fromTab(tabId, { type: 'aiStudio.routeRegistered', routeId });

const lastDelivery = async (world) =>
  (await world.chrome.storage.session.get('lastDelivery')).lastDelivery;

test('A navigates to B: A\'s completion is not injected into the tab, now B', withBackground(
  [{ id: 7, url: URL_A }],
  async (world) => {
    const calls = attach(world, 7);
    await register(world, 7, ROUTE_A);
    world.tabMap.get(7).url = URL_B; // same tab, different conversation

    await complete(world, ROUTE_A, 'evt-1');

    assert.equal(calls.length, 0);
    assert.equal((await lastDelivery(world)).outcome, 'unmatched');
  },
));

test('A and B in parallel tabs: each completion reaches only its own tab', withBackground(
  [{ id: 7, url: URL_A }, { id: 8, url: URL_B }],
  async (world) => {
    const callsA = attach(world, 7);
    const callsB = attach(world, 8);
    await register(world, 7, ROUTE_A);
    await register(world, 8, ROUTE_B);

    await complete(world, ROUTE_A, 'evt-a');
    await complete(world, ROUTE_B, 'evt-b');

    assert.deepEqual(callsA.map((c) => c.eventKey.includes('evt-a')), [true]);
    assert.deepEqual(callsB.map((c) => c.eventKey.includes('evt-b')), [true]);
  },
));

test('A moves to B while B also exists in another tab: A is still never delivered to B', withBackground(
  [{ id: 7, url: URL_A }, { id: 8, url: URL_B }],
  async (world) => {
    const callsA = attach(world, 7);
    const callsB = attach(world, 8);
    await register(world, 7, ROUTE_A);
    await register(world, 8, ROUTE_B);
    world.tabMap.get(7).url = URL_B;

    await complete(world, ROUTE_A, 'evt-1');

    assert.equal(callsA.length + callsB.length, 0);
  },
));

test('a URL change re-registered by the page (new chat -> /c/id) is delivered after the update', withBackground(
  [{ id: 7, url: NEW_CHAT }],
  async (world) => {
    const calls = attach(world, 7);
    await register(world, 7, ROUTE_A);
    world.tabMap.get(7).url = URL_A;
    // Page has not re-registered yet: fail safe.
    await complete(world, ROUTE_A, 'evt-1');
    assert.equal(calls.length, 0);

    await register(world, 7, ROUTE_A); // reconcileRoute on the URL change
    await complete(world, ROUTE_A, 'evt-1');
    assert.equal(calls.length, 1);
  },
));

test('closed tab: the exact conversation URL in a single other tab still matches', withBackground(
  [{ id: 7, url: URL_A }],
  async (world) => {
    await register(world, 7, ROUTE_A);
    world.tabMap.delete(7);
    world.tabMap.set(9, { id: 9, url: URL_A });
    const calls = attach(world, 9);
    await complete(world, ROUTE_A, 'evt-1');
    assert.equal(calls.length, 1);
  },
));

test('closed tab: two tabs on the same URL are ambiguous and refused', withBackground(
  [{ id: 7, url: URL_A }],
  async (world) => {
    await register(world, 7, ROUTE_A);
    world.tabMap.delete(7);
    world.tabMap.set(9, { id: 9, url: URL_A });
    world.tabMap.set(10, { id: 10, url: URL_A });
    const calls = [...attach(world, 9), ...attach(world, 10)];
    const callsAll = [attach(world, 9), attach(world, 10)];
    await complete(world, ROUTE_A, 'evt-1');
    assert.equal(callsAll[0].length + callsAll[1].length + calls.length, 0);
  },
));

test('closed new-chat tab: the shared bare URL never identifies a tab', withBackground(
  [{ id: 7, url: NEW_CHAT }],
  async (world) => {
    await register(world, 7, ROUTE_A);
    world.tabMap.delete(7);
    world.tabMap.set(9, { id: 9, url: NEW_CHAT }); // someone else's fresh chat
    const calls = attach(world, 9);
    await complete(world, ROUTE_A, 'evt-1');
    assert.equal(calls.length, 0);
  },
));

test('the tab moving on during the pre-send awaits is caught by the re-check', withBackground(
  [{ id: 7, url: URL_A }],
  async (world) => {
    const calls = [];
    world.tabHandlers.set(7, async (message) => {
      if (message.type === 'aiStudio.ping') {
        world.tabMap.get(7).url = URL_B; // navigates while ensureContentScript runs
        return { ok: true };
      }
      if (message.type === 'aiStudio.taskCompleted') calls.push(message);
      return { ok: true, state: 'sent', retryable: false };
    });
    await register(world, 7, ROUTE_A);

    await complete(world, ROUTE_A, 'evt-1');

    assert.equal(calls.length, 0);
    assert.equal((await lastDelivery(world)).outcome, 'unmatched');
  },
));

test('the page is told which route the event belongs to', withBackground(
  [{ id: 7, url: URL_A }],
  async (world) => {
    const calls = attach(world, 7);
    await register(world, 7, ROUTE_A);
    await complete(world, ROUTE_A, 'evt-1');
    assert.equal(calls[0].expectedRouteId, ROUTE_A);
  },
));
