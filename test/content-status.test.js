import assert from 'node:assert/strict';
import test from 'node:test';

import {
  composerTextOf,
  dispatchDocumentFor as dispatch,
  legacyMarkerIdsIn,
  legacyRouteMarkerText,
  markerIdsIn,
  routeMarkerText,
  sendToContent,
  setComposerText,
  withPage,
} from './helpers/fake-dom.js';

const ROUTE_ID = '11111111-2222-3333-4444-555555555555';

const outcomes = (world) =>
  world.sentMessages.filter((message) => message.type === 'aiStudio.routeInjectOutcome');

const redetect = (world) =>
  sendToContent(world, { type: 'aiStudio.requestRouteRegistration', probe: true });

// --- Outcome reports that feed the popup ------------------------------------

test('every successful injection reports an ok outcome with route, url and time', () =>
  withPage({ composer: 'textarea' }, async (world) => {
    setComposerText(world, 'hello');
    const before = Date.now();

    dispatch(world, 'pointerdown', world.sendButton);
    dispatch(world, 'click', world.sendButton);

    // A reported success means the Markdown marker is really in the composer.
    assert.deepEqual(markerIdsIn(composerTextOf(world)), [ROUTE_ID]);
    assert.deepEqual(legacyMarkerIdsIn(composerTextOf(world)), []);

    const reports = outcomes(world);
    assert.equal(reports.length, 2, 'pointerdown and click each report');
    for (const report of reports) {
      assert.equal(report.ok, true);
      assert.equal(report.routeId, ROUTE_ID);
      assert.equal(report.detail, null);
      assert.equal(report.source, 'send');
      assert.match(report.url, /^https:\/\/chatgpt\.com\/c\//);
      assert.ok(report.at >= before);
    }
  }));

test('a failed injection reports its reason, and a later success reports ok again', () => {
  let execOk = false;
  return withPage({
    composer: 'lexical',
    execCommand: (command, _ui, value, document) => {
      if (!execOk || command !== 'insertText') return false;
      document.activeElement.textContent = String(value);
      return true;
    },
  }, async (world) => {
    setComposerText(world, 'hello');
    dispatch(world, 'pointerdown', world.sendButton);

    let last = outcomes(world).at(-1);
    assert.equal(last.ok, false);
    assert.match(last.detail, /^readback-mismatch:composer=DIV:markers=none$/);

    execOk = true;
    dispatch(world, 'pointerdown', world.sendButton);
    last = outcomes(world).at(-1);
    assert.equal(last.ok, true);
    assert.equal(last.detail, null);
  });
});

// --- Re-detect: registration + non-destructive probe --------------------------

test('re-detect on an empty composer registers the route, probes, and leaves the composer empty', () =>
  withPage({ composer: 'textarea' }, async (world) => {
    const written = [];
    world.composer.addEventListener('input', () => {
      written.push(world.composer.value);
    });

    const response = await redetect(world);

    // The probe exercised the real Markdown marker write, never an HTML comment.
    assert.equal(written[0], routeMarkerText(ROUTE_ID));
    assert.ok(written.every((text) => legacyMarkerIdsIn(text).length === 0));

    assert.equal(response.ok, true);
    assert.equal(response.routeId, ROUTE_ID);
    assert.equal(response.probe.status, 'ok');
    assert.deepEqual(response.probe.outcome, {
      ok: true,
      routeId: ROUTE_ID,
      detail: null,
      source: 'probe',
    });
    assert.equal(composerTextOf(world), '', 'probe marker must not be left behind');

    assert.ok(world.sentMessages.some((message) =>
      message.type === 'aiStudio.routeRegistered' && message.routeId === ROUTE_ID));
    const report = outcomes(world).at(-1);
    assert.equal(report.ok, true);
    assert.equal(report.source, 'probe');
  }));

test('re-detect probe also cleans up a Lexical-style composer', () =>
  withPage({ composer: 'lexical' }, async (world) => {
    const response = await redetect(world);

    assert.equal(response.probe.status, 'ok');
    assert.equal(composerTextOf(world), '');
  }));

test('re-detect never touches a composer the user is typing in', () =>
  withPage({ composer: 'textarea' }, async (world) => {
    setComposerText(world, 'half-written message');
    let writes = 0;
    world.composer.addEventListener('input', () => {
      writes++;
    });

    const response = await redetect(world);

    assert.equal(response.ok, true);
    assert.deepEqual(response.probe, { status: 'skipped', detail: 'composer-has-text' });
    assert.equal(composerTextOf(world), 'half-written message');
    assert.equal(writes, 0);
    // Skipping is not a result: nothing claims success or failure.
    assert.equal(outcomes(world).length, 0);
  }));

test('re-detect leaves a composer holding only a legacy HTML marker untouched', () =>
  withPage({ composer: 'textarea' }, async (world) => {
    const legacy = legacyRouteMarkerText(ROUTE_ID);
    setComposerText(world, legacy);

    const response = await redetect(world);

    assert.deepEqual(response.probe, { status: 'skipped', detail: 'composer-has-text' });
    assert.equal(composerTextOf(world), legacy);
  }));

test('re-detect cleans up a Markdown marker resurrected by a late re-render', () =>
  withPage({ composer: 'textarea' }, async (world) => {
    let resurrected = false;
    world.composer.addEventListener('input', () => {
      if (world.composer.value !== '' || resurrected) return;
      resurrected = true;
      // A stale render restores the probe marker after the synchronous clear.
      setTimeout(() => {
        world.composer.value = routeMarkerText(ROUTE_ID);
      }, 10);
    });

    const response = await redetect(world);

    assert.equal(response.probe.status, 'ok');
    assert.equal(composerTextOf(world), '');
  }));

test('re-detect reports a real probe failure and still leaves the composer empty', () =>
  withPage({ composer: 'textarea' }, async (world) => {
    world.composer.addEventListener('input', () => {
      world.composer.value = '';
    });

    const response = await redetect(world);

    assert.equal(response.probe.status, 'failed');
    assert.match(response.probe.detail, /readback-mismatch/);
    assert.equal(response.probe.outcome.ok, false);
    assert.equal(composerTextOf(world), '');
    assert.equal(outcomes(world).at(-1).ok, false);
    // The badge latch still hears about the failure.
    assert.ok(world.sentMessages.some((message) => message.type === 'aiStudio.routeInjectFailed'));
  }));

test('re-detect reports a probe whose marker cannot be removed as a failure', () =>
  withPage({ composer: 'textarea' }, async (world) => {
    // Accepts the marker but refuses to be cleared.
    world.composer.addEventListener('input', () => {
      if (world.composer.value === '') world.composer.value = world.lastNonEmpty;
      else world.lastNonEmpty = world.composer.value;
    });

    const response = await redetect(world);

    assert.equal(response.probe.status, 'failed');
    assert.equal(response.probe.detail, 'probe-cleanup-failed');
    // What could not be removed is the Markdown probe marker.
    assert.deepEqual(markerIdsIn(composerTextOf(world)), [ROUTE_ID]);
    assert.equal(outcomes(world).at(-1).detail, 'probe-cleanup-failed');
  }));

test('re-detect without a composer only registers the route', () =>
  withPage({ composer: 'textarea' }, async (world) => {
    world.document.body.childNodes.length = 0;

    const response = await redetect(world);

    assert.equal(response.ok, true);
    assert.equal(response.probe.status, 'skipped');
    assert.equal(
      response.probe.detail,
      'composer-not-found:selectors-missed;scopes=0;candidates=0;hidden=0;readonly=0',
    );
    assert.equal(outcomes(world).length, 0);
  }));

test('re-detect reports ok:false when the background did not persist the route', () =>
  withPage({ composer: 'textarea' }, async (world) => {
    world.respondToMessage = () => ({ ok: false });

    const response = await redetect(world);
    assert.equal(response.ok, false);
  }));
