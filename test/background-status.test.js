import assert from 'node:assert/strict';
import test from 'node:test';

import { setupBackground } from './helpers/fake-background.js';
import {
  describeDeliveryIssue,
  describeSnapshot,
  formatDiagnostics,
} from '../src/status.js';

const ROUTE_ID = '11111111-2222-3333-4444-555555555555';
const OTHER_ROUTE_ID = '99999999-8888-7777-6666-555555555555';
const URL_A = 'https://chatgpt.com/c/b72b6f8f-20ce-4c89-a54f-7cb52c9d0f42';
const URL_B = 'https://chatgpt.com/c/0f0f0f0f-1111-2222-3333-444444444444';
const SECRET = 'relay-secret-token-DO-NOT-LEAK';

const TABS = [
  { id: 7, url: URL_A },
  { id: 8, url: URL_B },
  { id: 9, url: 'https://example.com/' },
];

const flush = async (rounds = 20) => {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const withBackground = (options, run) => async () => {
  const world = await setupBackground({ tabs: TABS, ...options });
  try {
    await run(world);
  } finally {
    world.restoreGlobals();
  }
};

const snapshotOf = (world, tabId = 7) => world.popup('aiStudio.popup.getStatus', tabId);

const rowOf = (snapshot, key) => describeSnapshot(snapshot).find((row) => row.key === key);

const injectOutcome = (world, tabId, fields) =>
  world.fromTab(tabId, {
    type: 'aiStudio.routeInjectOutcome',
    routeId: ROUTE_ID,
    at: Date.now(),
    url: world.tabMap.get(tabId).url,
    source: 'send',
    ...fields,
  });

test('snapshot keeps local bridge, route and injection as independent real states', withBackground({}, async (world) => {
  let snapshot = await snapshotOf(world);
  assert.equal(snapshot.version, '9.9.9');
  assert.equal(snapshot.localBridge.state, 'connecting');
  assert.equal(snapshot.route.state, 'unbound');
  assert.equal(snapshot.injection.state, 'unverified');

  world.localSocket().open();
  snapshot = await snapshotOf(world);
  assert.equal(snapshot.localBridge.state, 'connected');
  assert.ok(snapshot.localBridge.since);
  // A live bridge says nothing about this page's route.
  assert.equal(snapshot.route.state, 'unbound');

  await world.fromTab(7, { type: 'aiStudio.routeRegistered', routeId: ROUTE_ID });
  snapshot = await snapshotOf(world);
  assert.equal(snapshot.route.state, 'bound');
  assert.equal(snapshot.route.routeId, ROUTE_ID);
  assert.equal(world.badge, 'ON');
  // Registration alone never claims an injection happened.
  assert.equal(snapshot.injection.state, 'unverified');
  assert.equal(rowOf(snapshot, 'injection').text, '尚未验证');

  world.localSocket().close();
  snapshot = await snapshotOf(world);
  assert.equal(snapshot.localBridge.state, 'disconnected');
  assert.equal(snapshot.route.state, 'bound');
  assert.equal(rowOf(snapshot, 'bridge').text, '本地桥未连接');
  assert.equal(rowOf(snapshot, 'bridge').tone, 'bad');
}));

test('injection failure shows as failed with its reason, then recovery shows success', withBackground({}, async (world) => {
  await world.fromTab(7, { type: 'aiStudio.routeRegistered', routeId: ROUTE_ID });

  await injectOutcome(world, 7, {
    ok: false,
    detail: 'readback-mismatch:composer=TEXTAREA:markers=none',
  });
  await world.fromTab(7, { type: 'aiStudio.routeInjectFailed', routeId: ROUTE_ID });

  let snapshot = await snapshotOf(world);
  assert.equal(snapshot.injection.state, 'failed');
  assert.equal(snapshot.injection.detail, 'readback-mismatch:composer=TEXTAREA:markers=none');
  assert.equal(snapshot.injection.routeId, ROUTE_ID);
  assert.equal(snapshot.injection.url, URL_A);
  // Route registration is still fine: the popup must not collapse the two.
  assert.equal(snapshot.route.state, 'bound');
  assert.equal(world.badge, '!');
  let row = rowOf(snapshot, 'injection');
  assert.equal(row.tone, 'bad');
  assert.equal(row.text, '最近一次失败');
  assert.match(row.detail, /读回不一致/);
  assert.match(formatDiagnostics(snapshot), /injection: failed .*error=readback-mismatch/);

  await injectOutcome(world, 7, { ok: true, detail: 'ignored-on-success' });
  await world.fromTab(7, { type: 'aiStudio.routeInjectRecovered', routeId: ROUTE_ID });

  snapshot = await snapshotOf(world);
  assert.equal(snapshot.injection.state, 'ok');
  assert.equal(snapshot.injection.detail, null);
  assert.equal(world.badge, 'ON');
  row = rowOf(snapshot, 'injection');
  assert.equal(row.tone, 'ok');
  assert.equal(row.text, '最近一次成功');
}));

test('injection outcomes are kept per tab and dropped when the tab closes', withBackground({}, async (world) => {
  await injectOutcome(world, 8, { ok: false, detail: 'composer-not-found' });

  assert.equal((await snapshotOf(world, 7)).injection.state, 'unverified');
  assert.equal((await snapshotOf(world, 8)).injection.state, 'failed');

  await world.removeTab(8);
  world.tabMap.set(8, { id: 8, url: URL_B });
  assert.equal((await snapshotOf(world, 8)).injection.state, 'unverified');
}));

test('route binding is exact: same tab on a different conversation URL is unbound', withBackground({}, async (world) => {
  await world.fromTab(7, { type: 'aiStudio.routeRegistered', routeId: ROUTE_ID });
  // Another tab's route must not make tab 7 look bound, and vice versa.
  await world.fromTab(8, { type: 'aiStudio.routeRegistered', routeId: OTHER_ROUTE_ID });
  assert.equal((await snapshotOf(world, 7)).route.routeId, ROUTE_ID);
  assert.equal((await snapshotOf(world, 8)).route.routeId, OTHER_ROUTE_ID);

  world.tabMap.get(7).url = URL_B;
  assert.equal((await snapshotOf(world, 7)).route.state, 'unbound');
}));

test('non-ChatGPT tabs report not-chatgpt instead of a fake route/injection state', withBackground({}, async (world) => {
  const snapshot = await snapshotOf(world, 9);
  assert.equal(snapshot.tab.isChatGpt, false);
  assert.equal(snapshot.route.state, 'not-chatgpt');
  assert.equal(snapshot.injection.state, 'not-chatgpt');
  assert.equal(rowOf(snapshot, 'route').text, '不是 ChatGPT 页面');
}));

test('snapshot and diagnostics never contain the remote relay token', withBackground({
  local: {
    remoteRelay: { enabled: true, url: 'https://notify.qhkly.com', token: SECRET },
  },
}, async (world) => {
  await flush();
  const remote = world.sockets.find((socket) => socket.url.startsWith('wss://'));
  // Sanity: the secret really is live inside the worker.
  assert.ok(remote.url.includes(SECRET));
  remote.open();

  await world.fromTab(7, { type: 'aiStudio.routeRegistered', routeId: ROUTE_ID });
  await injectOutcome(world, 7, { ok: false, detail: 'composer-not-found' });

  const snapshot = await snapshotOf(world);
  assert.deepEqual(snapshot.remoteRelay, { enabled: true, connected: true });

  const serialized = JSON.stringify(snapshot);
  const diagnostics = formatDiagnostics(snapshot);
  for (const text of [serialized, diagnostics]) {
    assert.ok(!text.includes(SECRET), 'relay token leaked');
    assert.ok(!/token/i.test(text), 'no token field at all');
    assert.ok(!text.includes('notify.qhkly.com'), 'relay URL (token carrier) not exposed');
  }

  assert.match(diagnostics, /version: 9\.9\.9/);
  assert.match(diagnostics, /local bridge: connecting/);
  assert.match(diagnostics, new RegExp('tab: ' + URL_A));
  assert.match(diagnostics, new RegExp('route: bound routeId=' + ROUTE_ID));
  assert.match(diagnostics, /injection: failed at=\S+ source=send .*error=composer-not-found/);
}));

test('re-detect re-registers the route and records the probe result', withBackground({}, async (world) => {
  world.tabHandlers.set(7, async (message) => {
    if (message.type === 'aiStudio.ping') return { ok: true };
    assert.equal(message.type, 'aiStudio.requestRouteRegistration');
    assert.equal(message.probe, true);
    const ack = await world.fromTab(7, { type: 'aiStudio.routeRegistered', routeId: ROUTE_ID });
    return {
      ok: ack.ok,
      routeId: ROUTE_ID,
      probe: {
        status: 'ok',
        detail: null,
        outcome: { ok: true, routeId: ROUTE_ID, detail: null, source: 'probe' },
      },
    };
  });

  const result = await world.popup('aiStudio.popup.redetect', 7);
  assert.deepEqual(result, { ok: true, reason: null, probe: { status: 'ok', detail: null } });

  const snapshot = await snapshotOf(world);
  assert.equal(snapshot.route.state, 'bound');
  assert.equal(snapshot.injection.state, 'ok');
  assert.equal(snapshot.injection.source, 'probe');
}));

test('re-detect with a skipped probe leaves injection unverified', withBackground({}, async (world) => {
  world.tabHandlers.set(7, async (message) => {
    if (message.type === 'aiStudio.ping') return { ok: true };
    await world.fromTab(7, { type: 'aiStudio.routeRegistered', routeId: ROUTE_ID });
    return { ok: true, routeId: ROUTE_ID, probe: { status: 'skipped', detail: 'composer-has-text' } };
  });

  const result = await world.popup('aiStudio.popup.redetect', 7);
  assert.equal(result.probe.status, 'skipped');

  const snapshot = await snapshotOf(world);
  assert.equal(snapshot.route.state, 'bound');
  assert.equal(snapshot.injection.state, 'unverified');
}));

test('re-detect reports why it could not run', withBackground({}, async (world) => {
  assert.equal((await world.popup('aiStudio.popup.redetect', 9)).reason, 'not-chatgpt');
  assert.equal((await world.popup('aiStudio.popup.redetect', 404)).reason, 'tab-not-found');
  // No content script answers and injection is refused.
  assert.equal(
    (await world.popup('aiStudio.popup.redetect', 8)).reason,
    'content-script-unavailable',
  );
  assert.deepEqual(world.executed, [8]);
}));

test('popup requests coming from a web page are ignored', withBackground({}, async (world) => {
  assert.equal(
    await world.fromTab(7, { type: 'aiStudio.popup.getStatus', tabId: 7 }),
    undefined,
  );
  assert.equal(
    await world.fromTab(7, { type: 'aiStudio.popup.redetect', tabId: 7 }),
    undefined,
  );
}));

test('an unmatched completion explains the "!" badge as a delivery problem', withBackground({}, async (world) => {
  world.localSocket().open();
  world.localSocket()._fire('message', {
    data: JSON.stringify({
      type: 'task.completed',
      eventId: 'evt-1',
      sessionId: 'session-1',
      routeId: OTHER_ROUTE_ID,
    }),
  });
  await flush();

  const snapshot = await snapshotOf(world);
  assert.equal(world.badge, '!');
  assert.equal(snapshot.lastDelivery.outcome, 'unmatched');
  assert.equal(snapshot.lastDelivery.routeId, OTHER_ROUTE_ID);
  // Injection itself was never attempted, so it stays unverified.
  assert.equal(snapshot.injection.state, 'unverified');
  assert.match(describeDeliveryIssue(snapshot), /找不到匹配 route/);
  assert.match(formatDiagnostics(snapshot), /last delivery: unmatched/);
}));
