import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildStatusSnapshot,
  describeRedetect,
  describeSnapshot,
  findTabRouteBinding,
  formatDiagnostics,
  normalizeInjectionOutcome,
  normalizeRedetectResult,
  sanitizeUrl,
} from '../src/status.js';

const ROUTE_ID = '11111111-2222-3333-4444-555555555555';
const URL_A = 'https://chatgpt.com/c/b72b6f8f-20ce-4c89-a54f-7cb52c9d0f42';
const TTL = 1000;

test('findTabRouteBinding picks the freshest exact tab+url binding within TTL', () => {
  const tab = { id: 7, url: URL_A };
  const bindings = {
    [ROUTE_ID]: { tabId: 7, url: URL_A, at: 900 },
    'aaaaaaaa-2222-3333-4444-555555555555': { tabId: 7, url: URL_A, at: 500 },
    'bbbbbbbb-2222-3333-4444-555555555555': { tabId: 7, url: URL_A + '/other', at: 990 },
    'cccccccc-2222-3333-4444-555555555555': { tabId: 8, url: URL_A, at: 995 },
  };

  assert.deepEqual(findTabRouteBinding(bindings, tab, 1000, TTL), { routeId: ROUTE_ID, at: 900 });
  // Expired bindings do not count.
  assert.equal(findTabRouteBinding(bindings, tab, 3000, TTL), null);
  assert.equal(findTabRouteBinding(bindings, null, 1000, TTL), null);
});

test('normalizeInjectionOutcome keeps only whitelisted, bounded fields', () => {
  const outcome = normalizeInjectionOutcome({
    ok: false,
    routeId: ROUTE_ID.toUpperCase(),
    detail: 'x'.repeat(500),
    at: 42,
    source: 'probe',
    token: 'secret',
  }, URL_A + '?q=private#frag', 99);

  assert.deepEqual(Object.keys(outcome).sort(), ['at', 'detail', 'ok', 'routeId', 'source', 'url']);
  assert.equal(outcome.routeId, ROUTE_ID);
  assert.equal(outcome.detail.length, 200);
  assert.equal(outcome.at, 42);
  assert.equal(outcome.url, URL_A);
  assert.equal(outcome.source, 'probe');

  const ok = normalizeInjectionOutcome({ ok: true, detail: 'nope', routeId: 'not-a-uuid' }, '', 99);
  assert.equal(ok.detail, null);
  assert.equal(ok.routeId, null);
  assert.equal(ok.at, 99);
  assert.equal(ok.source, 'send');
});

test('sanitizeUrl drops query and fragment', () => {
  assert.equal(sanitizeUrl(URL_A + '?model=x#y'), URL_A);
  assert.equal(sanitizeUrl('not a url'), '');
  assert.equal(sanitizeUrl(undefined), '');
});

test('snapshot ignores unexpected input fields', () => {
  const snapshot = buildStatusSnapshot({
    version: '1.2.3',
    now: 1,
    localBridge: { state: 'weird', since: 5, url: 'ws://x?token=s' },
    remoteRelay: { enabled: true, connected: false, token: 's', url: 'https://r' },
    tab: { id: 7, url: URL_A, title: 'private chat title' },
    routeBinding: null,
    injection: null,
    lastDelivery: null,
    badge: 'ON',
  });

  assert.equal(snapshot.localBridge.state, 'disconnected');
  assert.deepEqual(snapshot.remoteRelay, { enabled: true, connected: false });
  assert.deepEqual(snapshot.tab, { id: 7, url: URL_A, isChatGpt: true });
  assert.ok(!JSON.stringify(snapshot).includes('token'));
  assert.ok(!JSON.stringify(snapshot).includes('private chat title'));
  assert.deepEqual(
    describeSnapshot(snapshot).map((row) => row.key),
    ['bridge', 'route', 'injection', 'version'],
  );
});

test('describeRedetect never turns a skipped probe into success', () => {
  assert.equal(describeRedetect({ ok: true, probe: { status: 'ok' } }).tone, 'ok');
  const skipped = describeRedetect({ ok: true, probe: { status: 'skipped', detail: 'composer-has-text' } });
  assert.equal(skipped.tone, 'muted');
  assert.match(skipped.text, /未做注入检测/);
  const failed = describeRedetect({ ok: true, probe: { status: 'failed', detail: 'probe-cleanup-failed' } });
  assert.equal(failed.tone, 'bad');
  assert.match(failed.text, /清理/);
  assert.equal(describeRedetect({ ok: false, reason: 'not-chatgpt' }).tone, 'bad');
  assert.equal(describeRedetect(undefined).tone, 'bad');
});

const OTHER_ROUTE_ID = '99999999-8888-7777-6666-555555555555';

const baseInput = (overrides) => ({
  version: '1.2.3',
  now: 1,
  localBridge: null,
  remoteRelay: null,
  tab: { id: 7, url: URL_A },
  routeBinding: { routeId: ROUTE_ID, at: 10 },
  injection: null,
  lastDelivery: null,
  lastRedetect: null,
  badge: '',
  ...overrides,
});

test('snapshot keeps only the delivery for the current route', () => {
  const kept = buildStatusSnapshot(baseInput({
    lastDelivery: { outcome: 'failed', routeId: ROUTE_ID.toUpperCase(), at: 20 },
  }));
  assert.deepEqual(kept.lastDelivery, { outcome: 'failed', routeId: ROUTE_ID, at: 20 });

  const stale = buildStatusSnapshot(baseInput({
    lastDelivery: { outcome: 'failed', routeId: OTHER_ROUTE_ID, at: 20 },
  }));
  assert.equal(stale.lastDelivery, null);
  assert.match(formatDiagnostics(stale), /last delivery: -/);

  const unbound = buildStatusSnapshot(baseInput({
    routeBinding: null,
    lastDelivery: { outcome: 'failed', routeId: null, at: 20 },
  }));
  assert.equal(unbound.lastDelivery, null);
});

test('normalizeRedetectResult distinguishes probe outcomes and failures', () => {
  const norm = (result) => normalizeRedetectResult(result, ROUTE_ID, URL_A + '?x=1', 5);
  assert.deepEqual(norm({ ok: true, probe: { status: 'ok', detail: 'x' } }),
    { status: 'ok', detail: null, routeId: ROUTE_ID, at: 5, url: URL_A });
  assert.equal(norm({ ok: true, probe: { status: 'failed', detail: 'probe-cleanup-failed' } }).detail,
    'probe-cleanup-failed');
  assert.deepEqual(
    norm({ ok: true, probe: { status: 'skipped', detail: 'composer-has-text' } }).status, 'skipped');
  assert.equal(norm({ ok: true, probe: { status: 'weird' } }).status, 'unsupported');
  assert.deepEqual(
    [norm({ ok: false, reason: 'registration-failed' }).status,
      norm({ ok: false, reason: 'registration-failed' }).detail],
    ['error', 'registration-failed'],
  );
});
