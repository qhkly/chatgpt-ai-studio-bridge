import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FAST_TIMING,
  composerTextOf,
  fakeElement,
  dispatchDocumentFor as dispatch,
  legacyMarkerIdsIn,
  legacyRouteMarkerText,
  markerIdsIn,
  routeMarkerText,
  sendTaskCompleted,
  setComposerText,
  setupPage,
} from './helpers/fake-dom.js';

const ROUTE_ID = '11111111-2222-3333-4444-555555555555';
const OLD_ROUTE_ID = '99999999-8888-7777-6666-555555555555';

const injectFailures = (world) =>
  world.sentMessages.filter((message) => message.type === 'aiStudio.routeInjectFailed');

const injectRecoveries = (world) =>
  world.sentMessages.filter((message) => message.type === 'aiStudio.routeInjectRecovered');

// --- Manual path: clicking the send button -------------------------------

test('pointerdown on send button writes the marker into a textarea composer and read-back verifies it', () => {
  const world = setupPage({ composer: 'textarea' });
  setComposerText(world, 'please review the worker output');

  dispatch(world, 'pointerdown', world.sendButton);

  const text = composerTextOf(world);
  assert.equal(markerIdsIn(text).join(), ROUTE_ID);
  assert.match(text, /please review the worker output\n\n\[AI_STUDIO_ROUTE\]: ai-studio-route:/);
  assert.equal(injectFailures(world).length, 0);
});

test('pointerdown on send button writes the marker into a Lexical-style contenteditable composer', () => {
  const world = setupPage({ composer: 'lexical' });
  setComposerText(world, 'please review');

  dispatch(world, 'pointerdown', world.sendButton);

  assert.equal(markerIdsIn(composerTextOf(world)).join(), ROUTE_ID);
  assert.equal(injectFailures(world).length, 0);
});

test('pointerdown outside the send button does not touch the composer', () => {
  const world = setupPage({ composer: 'textarea' });
  setComposerText(world, 'draft');

  dispatch(world, 'pointerdown', world.composer);

  assert.equal(composerTextOf(world), 'draft');
});

// --- Manual path: pressing Enter ------------------------------------------

test('Enter keydown inside the composer injects the marker before the app handler runs', () => {
  const world = setupPage({ composer: 'textarea' });
  setComposerText(world, 'continue the task');

  dispatch(world, 'keydown', world.composer, { key: 'Enter' });

  assert.equal(markerIdsIn(composerTextOf(world)).join(), ROUTE_ID);
});

test('Shift+Enter and Enter outside the composer do not inject', () => {
  const world = setupPage({ composer: 'textarea' });
  setComposerText(world, 'draft');

  dispatch(world, 'keydown', world.composer, { key: 'Enter', shiftKey: true });
  dispatch(world, 'keydown', world.sendButton, { key: 'Enter' });

  assert.equal(composerTextOf(world), 'draft');
});

// --- Click checkpoint: last chance before the app serializes the composer -

test('click checkpoint does not rewrite a marker that is already correct', () => {
  const world = setupPage({ composer: 'textarea' });
  setComposerText(world, 'hello');

  dispatch(world, 'pointerdown', world.sendButton);
  const afterPointerdown = composerTextOf(world);

  dispatch(world, 'click', world.sendButton);

  assert.equal(composerTextOf(world), afterPointerdown);
});

test('click checkpoint repairs a marker that a re-render reverted between pointerdown and click', () => {
  const world = setupPage({ composer: 'textarea' });
  setComposerText(world, 'hello');

  dispatch(world, 'pointerdown', world.sendButton);
  // Simulate React re-rendering the textarea from stale state.
  setComposerText(world, 'hello');

  dispatch(world, 'click', world.sendButton);

  assert.equal(markerIdsIn(composerTextOf(world)).join(), ROUTE_ID);
});

// --- Stale marker replacement ----------------------------------------------

test('an old route marker is replaced by the current route, never stacked', () => {
  const world = setupPage({ composer: 'textarea' });
  setComposerText(world, 'hello\n\n' + routeMarkerText(OLD_ROUTE_ID));

  dispatch(world, 'keydown', world.composer, { key: 'Enter' });

  const text = composerTextOf(world);
  assert.deepEqual(markerIdsIn(text), [ROUTE_ID]);
  assert.equal(text, 'hello\n\n' + routeMarkerText(ROUTE_ID));
});

test('a legacy HTML comment marker is replaced by the Markdown marker (textarea)', () => {
  const world = setupPage({ composer: 'textarea' });
  setComposerText(world, 'hello\n\n' + legacyRouteMarkerText(OLD_ROUTE_ID));

  dispatch(world, 'pointerdown', world.sendButton);

  const text = composerTextOf(world);
  assert.deepEqual(markerIdsIn(text), [ROUTE_ID]);
  assert.deepEqual(legacyMarkerIdsIn(text), []);
  assert.equal(text, 'hello\n\n' + routeMarkerText(ROUTE_ID));
});

test('a legacy HTML marker with the current route id is still rewritten in Markdown (Lexical)', () => {
  const world = setupPage({ composer: 'lexical' });
  setComposerText(world, 'hello\n\n' + legacyRouteMarkerText(ROUTE_ID));

  dispatch(world, 'keydown', world.composer, { key: 'Enter' });

  const text = composerTextOf(world);
  assert.deepEqual(markerIdsIn(text), [ROUTE_ID]);
  assert.deepEqual(legacyMarkerIdsIn(text), []);
  assert.equal(text, 'hello\n\n' + routeMarkerText(ROUTE_ID));
});

test('mixed legacy and Markdown markers collapse to a single Markdown marker', () => {
  const world = setupPage({ composer: 'textarea' });
  setComposerText(
    world,
    'hello\n\n' + legacyRouteMarkerText(OLD_ROUTE_ID) + '\n\n' +
      routeMarkerText(ROUTE_ID) + '\n\n' + routeMarkerText(OLD_ROUTE_ID),
  );

  dispatch(world, 'pointerdown', world.sendButton);

  const text = composerTextOf(world);
  assert.deepEqual(markerIdsIn(text), [ROUTE_ID]);
  assert.deepEqual(legacyMarkerIdsIn(text), []);
  assert.equal(text, 'hello\n\n' + routeMarkerText(ROUTE_ID));
});

test('repeated send gestures never stack Markdown markers', () => {
  const world = setupPage({ composer: 'textarea' });
  setComposerText(world, 'hello');

  dispatch(world, 'pointerdown', world.sendButton);
  dispatch(world, 'click', world.sendButton);
  dispatch(world, 'keydown', world.composer, { key: 'Enter' });
  dispatch(world, 'pointerdown', world.sendButton);

  const text = composerTextOf(world);
  assert.deepEqual(markerIdsIn(text), [ROUTE_ID]);
  assert.equal(text, 'hello\n\n' + routeMarkerText(ROUTE_ID));
});

// --- Failure detection ------------------------------------------------------

test('a silently failing execCommand is detected and reported, never treated as success', () => {
  const world = setupPage({ composer: 'lexical', execCommand: () => false });
  setComposerText(world, 'hello');

  dispatch(world, 'pointerdown', world.sendButton);

  assert.equal(composerTextOf(world), 'hello'); // nothing pretended to be written
  const failures = injectFailures(world);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].routeId, ROUTE_ID);
  assert.match(failures[0].detail, /readback-mismatch/);
});

test('a React-controlled composer that reverts every write is detected via read-back', () => {
  const world = setupPage({ composer: 'textarea' });
  // Simulate a hostile controlled component: React state ignores the
  // extension's input events and restores its own text synchronously.
  world.composer.addEventListener('input', () => {
    world.composer.value = '';
  });
  setComposerText(world, '');

  dispatch(world, 'pointerdown', world.sendButton);

  assert.equal(composerTextOf(world), '');
  assert.equal(injectFailures(world).length, 1);
});

test('a later successful injection reports recovery after a failure', () => {
  let execOk = false;
  const world = setupPage({
    composer: 'lexical',
    execCommand: (command, _ui, value, document) => {
      if (!execOk || command !== 'insertText') return false;
      const active = document.activeElement;
      if (!active?.focused) return false;
      active.textContent = String(value);
      return true;
    },
  });

  dispatch(world, 'pointerdown', world.sendButton);
  assert.equal(injectFailures(world).length, 1);
  assert.equal(injectRecoveries(world).length, 0);

  execOk = true;
  setComposerText(world, 'hello');
  dispatch(world, 'pointerdown', world.sendButton);

  assert.equal(markerIdsIn(composerTextOf(world)).join(), ROUTE_ID);
  assert.equal(injectRecoveries(world).length, 1);
});

// --- Submit path -------------------------------------------------------------

test('submit injects into a visible composer but stays silent when there is none', () => {
  const world = setupPage({ composer: 'textarea' });
  setComposerText(world, 'hello');

  dispatch(world, 'submit', world.document.body);
  assert.equal(markerIdsIn(composerTextOf(world)).join(), ROUTE_ID);
  assert.equal(injectFailures(world).length, 0);

  // A page without any composer (e.g. an unrelated form) must not raise alarms.
  world.document.body.childNodes.length = 0;
  dispatch(world, 'submit', world.document.body);
  assert.equal(injectFailures(world).length, 0);
});

// --- Automated path: sendPrompt (task.completed notification) ----------------

test('sendPrompt writes prompt + verified marker and clicks send once (textarea)', async () => {
  const world = setupPage({ composer: 'textarea' });

  const response = await sendTaskCompleted(world, '任务已完成，请继续审查');

  assert.equal(response.ok, true);
  assert.equal(response.state, 'sent');
  assert.equal(world.sendButton.clicks, 1);
  assert.equal(world.app.sent.length, 1);
  const text = world.app.sent[0];
  assert.match(text, /任务已完成，请继续审查/);
  assert.deepEqual(markerIdsIn(text), [ROUTE_ID]);
  assert.equal(injectFailures(world).length, 0);
});

test('sendPrompt writes prompt + verified marker and clicks send once (Lexical contenteditable)', async () => {
  const world = setupPage({ composer: 'lexical' });

  const response = await sendTaskCompleted(world, 'worker finished');

  assert.equal(response.ok, true);
  assert.equal(world.sendButton.clicks, 1);
  assert.deepEqual(markerIdsIn(world.app.sent[0]), [ROUTE_ID]);
});

test('sendPrompt survives a re-render that reverts the marker asynchronously', async () => {
  const world = setupPage({ composer: 'textarea' });
  // The framework re-renders ~10ms after each write and restores stale text.
  // The settle re-verify catches it, and the same-task rewrite wins the race
  // against the next render because the click follows synchronously.
  world.composer.addEventListener('input', () => {
    const revertTo = composerTextOf(world);
    setTimeout(() => {
      world.composer.value = revertTo;
    }, 10);
  });

  const response = await sendTaskCompleted(world, 'task done');

  assert.equal(response.ok, true);
  assert.equal(world.sendButton.clicks, 1);
  assert.equal(world.app.sent.length, 1);
  assert.deepEqual(markerIdsIn(world.app.sent[0]), [ROUTE_ID]);
});

test('sendPrompt never clicks send when the composer reverts every write', async () => {
  const world = setupPage({ composer: 'textarea' });
  world.composer.addEventListener('input', () => {
    world.composer.value = '';
  });

  const response = await sendTaskCompleted(world, 'task done');

  assert.equal(response.ok, false);
  assert.equal(response.state, 'inject-failed');
  // Terminal: something was written, so the background must not retry.
  assert.equal(response.retryable, false);
  assert.equal(world.sendButton.clicks, 0);
  const failures = injectFailures(world);
  assert.equal(failures.length, 1);
  assert.match(failures[0].detail, /readback-mismatch/);
});

test('the marker is a Markdown reference definition matching the AI Studio backend format', () => {
  const world = setupPage({ composer: 'textarea' });
  setComposerText(world, 'hello');

  dispatch(world, 'pointerdown', world.sendButton);

  const text = composerTextOf(world);
  assert.equal(
    text,
    'hello\n\n[AI_STUDIO_ROUTE]: ai-studio-route:' + ROUTE_ID +
      ' "pass UUID as route_id; otherwise keep this line in task"',
  );
  assert.deepEqual(legacyMarkerIdsIn(text), []);
});

// --- Voice paths and unmarked sends -----------------------------------------
// Dictation puts text into the composer through ordinary input events and the
// user then sends with the normal control, so it is the text path. Native Live
// voice never touches the composer: there is nothing to inject into, so the
// bridge must say so instead of pretending the turn is routable.

const UNMARKED_TIMING = {
  routeSyncMs: 1000,
  unmarkedSettleMs: 20,
  markedSendWindowMs: 500,
};
const unmarkedTiming = { ...FAST_TIMING, ...UNMARKED_TIMING };
const unmarkedReports = (world) =>
  injectFailures(world).filter((m) => /^unmarked-send:/.test(m.detail));
const turnsOf = (world) => world.app.thread.childNodes;
const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

test('typed text send: marker reaches the sent message and nothing is flagged', async () => {
  const world = setupPage({ composer: 'textarea', timing: unmarkedTiming });
  try {
    world.tick();
    await settle();
    setComposerText(world, 'typed task');
    dispatch(world, 'pointerdown', world.sendButton);
    world.app.submit();
    world.tick();
    assert.equal(markerIdsIn(world.app.sent[0]).join(), ROUTE_ID);
    assert.equal(unmarkedReports(world).length, 0);
  } finally {
    world.restoreGlobals();
  }
});

test('dictation: transcript lands in the composer, normal send injects the marker', async () => {
  const world = setupPage({ composer: 'lexical', timing: unmarkedTiming });
  try {
    world.tick();
    await settle();
    // Dictation inserts the transcript like typing; it is not altered.
    setComposerText(world, '帮我跑一下测试');
    dispatch(world, 'keydown', world.composer, { key: 'Enter' });
    world.app.submit();
    world.tick();
    assert.equal(markerIdsIn(world.app.sent[0]).join(), ROUTE_ID);
    assert.ok(world.app.sent[0].startsWith('帮我跑一下测试'));
    assert.equal(unmarkedReports(world).length, 0);
  } finally {
    world.restoreGlobals();
  }
});

test('a turn sent without any gesture (Live voice) is reported as unmarked, then a text send recovers', async () => {
  const world = setupPage({ composer: 'textarea', timing: unmarkedTiming });
  try {
    world.tick();
    await settle();
    // Live voice: a user turn appears; composer and send controls untouched.
    const turn = fakeElement('div', { 'data-message-author-role': 'user' });
    turn.textContent = 'spoken request';
    world.app.thread.appendChild(turn);
    world.tick();

    const reports = unmarkedReports(world);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].routeId, ROUTE_ID);
    assert.equal(markerIdsIn(composerTextOf(world)).length, 0, 'composer untouched');

    // The next ordinary text send is bound again and clears the alarm.
    setComposerText(world, 'follow up by typing');
    dispatch(world, 'pointerdown', world.sendButton);
    world.app.submit();
    world.tick();
    assert.equal(markerIdsIn(world.app.sent[0]).join(), ROUTE_ID);
    assert.equal(injectRecoveries(world).length, 1);
    assert.equal(unmarkedReports(world).length, 1, 'the marked turn is not flagged');
  } finally {
    world.restoreGlobals();
  }
});

test('history rendering after an SPA navigation is not mistaken for a send', async () => {
  const world = setupPage({ composer: 'textarea', timing: unmarkedTiming });
  try {
    world.tick();
    await settle();
    world.navigate('/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    world.tick(); // new URL: baseline taken, settle window starts
    for (let i = 0; i < 4; i++) {
      const turn = fakeElement('div', { 'data-message-author-role': 'user' });
      turn.textContent = 'old ' + i;
      world.app.thread.appendChild(turn);
    }
    world.tick();
    assert.equal(unmarkedReports(world).length, 0);
  } finally {
    world.restoreGlobals();
  }
});

test('after an SPA route change the next send carries the new conversation route', async () => {
  const world = setupPage({ composer: 'textarea', timing: unmarkedTiming });
  try {
    const NEW_CONV = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    world.navigate('/c/' + NEW_CONV);
    world.tick();
    const registered = world.sentMessages.filter((m) => m.type === 'aiStudio.routeRegistered');
    assert.match(registered.at(-1).url, new RegExp(NEW_CONV));
    setComposerText(world, 'in the new chat');
    dispatch(world, 'pointerdown', world.sendButton);
    const ids = markerIdsIn(composerTextOf(world));
    assert.equal(ids.length, 1);
    assert.notEqual(ids[0], ROUTE_ID, 'a different conversation never reuses another route');
  } finally {
    world.restoreGlobals();
  }
});

// A programmatic button.click() (e.g. another extension's sendPrompt) fires a
// click event with no preceding pointerdown; the click listener alone must
// mark the message.
test('a lone programmatic click on the send button injects the marker', () => {
  const world = setupPage({ composer: 'textarea' });
  setComposerText(world, 'sent by another extension');

  dispatch(world, 'click', world.sendButton, { isTrusted: false });

  assert.equal(markerIdsIn(composerTextOf(world)).join(), ROUTE_ID);
});
