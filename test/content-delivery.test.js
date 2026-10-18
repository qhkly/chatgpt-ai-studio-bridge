// Automated completion sends: one state machine per event. The invariant
// every test guards is "one notification → at most one ChatGPT message",
// whatever the page, the user, or the background does in between.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FAST_TIMING,
  composerTextOf,
  delay,
  fakeElement as el,
  markerIdsIn,
  sendTaskCompleted,
  sendToContent,
  setComposerText,
  withPage,
} from './helpers/fake-dom.js';

const ROUTE_ID = '11111111-2222-3333-4444-555555555555';
const PROMPT = 'AI Studio 工人任务「修复双发」已完成。任务/session ID：s-1';

// Console noise from expected "not sent" warnings stays out of test output.
const quietly = (run) => async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    await run();
  } finally {
    console.warn = warn;
  }
};

const deliveryRecords = (world) =>
  JSON.parse(world.sessionStorage.getItem('aiStudio.deliveries') ?? '{}');

// --- Filled but not yet sent -------------------------------------------------

test('a send button that stays disabled leaves the text for the user and never re-sends it', quietly(() =>
  withPage({}, async (world) => {
    world.sendButton.disabled = true;

    const first = await sendTaskCompleted(world, PROMPT, 'evt-1');
    assert.equal(first.ok, false);
    assert.equal(first.state, 'unsent');
    assert.equal(first.retryable, false, 'something was written: never invite a retry');
    assert.equal(first.detail, 'send-disabled');
    assert.equal(world.sendButton.clicks, 0);
    assert.match(composerTextOf(world), /修复双发/);
    assert.deepEqual(markerIdsIn(composerTextOf(world)), [ROUTE_ID]);

    // The user sends it by hand: one message, with its route marker.
    world.sendButton.disabled = false;
    world.app.submit();
    assert.equal(world.app.sent.length, 1);

    // The relay replays the unACKed event: answered from the record, the
    // now-empty composer is not refilled.
    const replay = await sendTaskCompleted(world, PROMPT, 'evt-1');
    assert.equal(replay.state, 'unsent');
    assert.equal(replay.retryable, false);
    assert.equal(composerTextOf(world), '');
    assert.equal(world.app.sent.length, 1);
    assert.equal(world.sendButton.clicks, 0);
  })));

test('a send button that is briefly disabled is clicked once it enables', () =>
  withPage({}, async (world) => {
    world.sendButton.disabled = true;
    setTimeout(() => { world.sendButton.disabled = false; }, 30);

    const response = await sendTaskCompleted(world, PROMPT, 'evt-1');

    assert.equal(response.ok, true);
    assert.equal(response.state, 'sent');
    assert.equal(world.sendButton.clicks, 1);
    assert.equal(world.app.sent.length, 1);
    assert.deepEqual(markerIdsIn(world.app.sent[0]), [ROUTE_ID]);
  }));

test('aria-disabled counts as disabled: no click lands on it', () =>
  withPage({}, async (world) => {
    world.sendButton.setAttribute('aria-disabled', 'true');
    let clicksWhileDisabled = 0;
    const accept = world.sendButton.onClick;
    world.sendButton.onClick = () => {
      if (world.sendButton.getAttribute('aria-disabled') === 'true') clicksWhileDisabled++;
      else accept();
    };
    setTimeout(() => world.sendButton.setAttribute('aria-disabled', 'false'), 30);

    const response = await sendTaskCompleted(world, PROMPT, 'evt-1');

    assert.equal(response.ok, true);
    assert.equal(clicksWhileDisabled, 0);
    assert.equal(world.app.sent.length, 1);
  }));

test('a framework that missed the first input event is nudged until send enables', () =>
  withPage({}, async (world) => {
    // React not hydrated yet: input events before `ready` are lost, so the
    // button would stay disabled with the text sitting in the composer.
    let ready = false;
    let inputsSeen = 0;
    world.sendButton.disabled = true;
    world.composer.addEventListener('input', () => {
      if (!ready) return;
      inputsSeen++;
      world.sendButton.disabled = composerTextOf(world).trim() === '';
    });
    setTimeout(() => { ready = true; }, 25);

    const response = await sendTaskCompleted(world, PROMPT, 'evt-1');

    assert.equal(response.ok, true);
    assert.ok(inputsSeen > 0, 'a nudge reached the framework');
    assert.equal(world.app.sent.length, 1);
    assert.equal(composerTextOf(world), '', 'the nudge never changed the text');
  }));

// --- At most one click per event -------------------------------------------------

test('a click ChatGPT accepted but shows only 3s later is never clicked again', () =>
  withPage({
    app: { latencyMs: 3000 },
    timing: { ...FAST_TIMING, clickConfirmMs: 10000 },
  }, async (world) => {
    const response = await sendTaskCompleted(world, PROMPT, 'evt-1');

    assert.equal(response.ok, true);
    assert.equal(world.sendButton.clicks, 1);
    assert.equal(world.app.accepted, 1);
    assert.equal(world.app.sent.length, 1);
  }));

test('a 6s render delay with the composer already cleared is still one click, one message', () =>
  withPage({
    app: { latencyMs: 6000, clearFirst: true },
    timing: { ...FAST_TIMING, clickConfirmMs: 10000 },
  }, async (world) => {
    const response = await sendTaskCompleted(world, PROMPT, 'evt-1');

    assert.equal(response.ok, true);
    assert.equal(world.sendButton.clicks, 1);
    assert.equal(world.app.sent.length, 1);
  }));

test('a send slower than the confirm window is unconfirmed, not re-clicked', quietly(() =>
  withPage({ app: { latencyMs: 400 } }, async (world) => {
    const response = await sendTaskCompleted(world, PROMPT, 'evt-1');

    assert.equal(response.state, 'unconfirmed');
    assert.equal(response.retryable, false);
    assert.equal(world.sendButton.clicks, 1);

    // It lands later; a replay of the event must not add a second one.
    await delay(300);
    const replay = await sendTaskCompleted(world, PROMPT, 'evt-1');
    assert.equal(replay.state, 'unconfirmed');
    assert.equal(world.sendButton.clicks, 1);
    assert.equal(world.app.sent.length, 1);
  })));

test('an ignored click degrades safely: no second click, draft kept for the user', quietly(() =>
  withPage({ app: { accept: () => false } }, async (world) => {
    const response = await sendTaskCompleted(world, PROMPT, 'evt-1');

    assert.equal(response.state, 'unconfirmed');
    assert.equal(response.detail, 'click-not-confirmed;draft-kept');
    assert.equal(response.retryable, false);
    assert.equal(world.sendButton.clicks, 1);
    assert.match(composerTextOf(world), /修复双发/);
    assert.deepEqual(markerIdsIn(composerTextOf(world)), [ROUTE_ID]);
    assert.equal(world.app.sent.length, 0);

    const replay = await sendTaskCompleted(world, PROMPT, 'evt-1');
    assert.equal(replay.state, 'unconfirmed');
    assert.equal(world.sendButton.clicks, 1);
  })));

test('an ignored click, then the user sends the kept draft: one message, reported sent', () =>
  withPage({ app: { accept: () => false } }, async (world) => {
    setTimeout(() => world.app.submit(), 60);

    const response = await sendTaskCompleted(world, PROMPT, 'evt-1');

    assert.equal(response.ok, true);
    assert.equal(world.sendButton.clicks, 1);
    assert.equal(world.app.sent.length, 1);
  }));

test('a resumed event with no page record stops instead of starting a send', quietly(() =>
  withPage({}, async (world) => {
    const response = await sendToContent(world, {
      type: 'aiStudio.taskCompleted',
      prompt: PROMPT,
      eventKey: 'evt-1',
      resume: true,
    });

    assert.equal(response.state, 'ambiguous');
    assert.equal(response.detail, 'no-record-for-resumed-attempt');
    assert.equal(composerTextOf(world), '');
    assert.equal(world.sendButton.clicks, 0);
  })));

test('a resumed event the page already sent is answered from its record', () =>
  withPage({}, async (world) => {
    await sendTaskCompleted(world, PROMPT, 'evt-1');
    const response = await sendToContent(world, {
      type: 'aiStudio.taskCompleted',
      prompt: PROMPT,
      eventKey: 'evt-1',
      resume: true,
    });

    assert.equal(response.ok, true);
    assert.equal(world.app.sent.length, 1);
  }));

test('click() alone is not success: a cleared composer without a sent turn is unconfirmed', quietly(() =>
  withPage({ app: false }, async (world) => {
    // The page wipes the composer on click but no user turn ever renders.
    world.sendButton.onClick = () => setComposerText(world, '');

    const response = await sendTaskCompleted(world, PROMPT, 'evt-1');

    assert.equal(response.ok, false);
    assert.equal(response.state, 'unconfirmed');
    assert.equal(response.retryable, false);
    assert.equal(world.sendButton.clicks, 1);
  })));

test('a reply that starts after our click is accepted as proof of the send', () =>
  withPage({ app: false }, async (world) => {
    world.sendButton.onClick = () => {
      setComposerText(world, '');
      world.composerRoot.appendChild(el('button', { 'data-testid': 'stop-button' }));
    };

    const response = await sendTaskCompleted(world, PROMPT, 'evt-1');

    assert.equal(response.ok, true);
    assert.match(response.detail, /reply-started/);
  }));

// --- The user acts while the notification is pending ------------------------

test('a manual send racing the automated one yields one message, reported as sent', () =>
  withPage({}, async (world) => {
    world.sendButton.disabled = true;
    setTimeout(() => {
      world.sendButton.disabled = false;
      world.app.submit(); // user pressed Enter first
    }, 20);

    const response = await sendTaskCompleted(world, PROMPT, 'evt-1');

    assert.equal(response.ok, true);
    assert.equal(response.detail, 'manual');
    assert.equal(world.sendButton.clicks, 0);
    assert.equal(world.app.sent.length, 1);

    const replay = await sendTaskCompleted(world, PROMPT, 'evt-1');
    assert.equal(replay.ok, true);
    assert.equal(world.app.sent.length, 1);
  }));

test('a user edit makes the text theirs: no click, no rewrite, no retry', quietly(() =>
  withPage({}, async (world) => {
    world.sendButton.disabled = true;
    setTimeout(() => {
      setComposerText(world, composerTextOf(world) + ' 我再补充一句');
    }, 20);

    const response = await sendTaskCompleted(world, PROMPT, 'evt-1');

    assert.equal(response.state, 'user-modified');
    assert.equal(response.retryable, false);
    assert.match(composerTextOf(world), /我再补充一句$/);
    assert.equal(world.sendButton.clicks, 0);
  })));

test('a user who deletes the notification is not overridden by a later replay', quietly(() =>
  withPage({}, async (world) => {
    world.sendButton.disabled = true;
    setTimeout(() => setComposerText(world, ''), 20);

    const response = await sendTaskCompleted(world, PROMPT, 'evt-1');
    assert.equal(response.state, 'cleared');
    assert.equal(response.retryable, false);

    world.sendButton.disabled = false;
    const replay = await sendTaskCompleted(world, PROMPT, 'evt-1');
    assert.equal(replay.state, 'cleared');
    assert.equal(composerTextOf(world), '');
    assert.equal(world.app.sent.length, 0);
  })));

test('a user draft is never overwritten; giving up untouched is retryable', quietly(() =>
  withPage({}, async (world) => {
    setComposerText(world, 'my own half-written question');

    const response = await sendTaskCompleted(world, PROMPT, 'evt-1');

    assert.equal(response.state, 'busy');
    assert.equal(response.retryable, true);
    assert.equal(composerTextOf(world), 'my own half-written question');
    assert.deepEqual(deliveryRecords(world), {}, 'nothing written, nothing recorded');

    // Once the user is done, the retried event goes out normally.
    setComposerText(world, '');
    const retry = await sendTaskCompleted(world, PROMPT, 'evt-1');
    assert.equal(retry.ok, true);
    assert.equal(world.app.sent.length, 1);
  })));

// --- Several notifications ----------------------------------------------------

test('the same event delivered twice at once is sent once; both callers get the result', () =>
  withPage({}, async (world) => {
    world.sendButton.disabled = true;
    setTimeout(() => { world.sendButton.disabled = false; }, 20);

    const [a, b] = await Promise.all([
      sendTaskCompleted(world, PROMPT, 'evt-1'),
      sendTaskCompleted(world, PROMPT, 'evt-1'),
    ]);

    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(world.app.sent.length, 1);
  }));

test('two notifications at once go out one after the other, each exactly once', () =>
  withPage({ app: { stream: true } }, async (world) => {
    const second = 'AI Studio 工人任务「第二轮」已完成。任务/session ID：s-2';
    // The first send starts a streaming reply; the second must wait for it.
    world.sendButton.onClick = ((accept) => () => {
      accept();
      setTimeout(() => world.app.finishReply(), 40);
    })(world.sendButton.onClick);

    const [a, b] = await Promise.all([
      sendTaskCompleted(world, PROMPT, 'evt-1'),
      sendTaskCompleted(world, second, 'evt-2'),
    ]);

    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(world.app.sent.length, 2);
    assert.match(world.app.sent[0], /修复双发/);
    assert.match(world.app.sent[1], /第二轮/);
    assert.doesNotMatch(world.app.sent[1], /修复双发/, 'never merged into one composer');
  }));

test('an earlier identical message in the thread is not mistaken for this send', quietly(() =>
  withPage({}, async (world) => {
    // The same task completed before; its turn is already on screen.
    setComposerText(world, PROMPT);
    world.app.submit();
    assert.equal(world.app.userTurns(), 1);
    world.sendButton.disabled = true;

    const response = await sendTaskCompleted(world, PROMPT, 'evt-2');

    assert.equal(response.state, 'unsent');
  })));

// --- Content-script restarts ---------------------------------------------------

test('an attempt left pending by a previous script instance is not restarted', quietly(() =>
  withPage({}, async (world) => {
    world.sessionStorage.setItem('aiStudio.deliveries', JSON.stringify({
      'evt-1': { state: 'pending', at: Date.now() },
    }));

    const response = await sendTaskCompleted(world, PROMPT, 'evt-1');

    assert.equal(response.state, 'ambiguous');
    assert.equal(response.detail, 'orphaned-attempt');
    assert.equal(response.retryable, false);
    assert.equal(composerTextOf(world), '');
    assert.equal(world.sendButton.clicks, 0);
  })));

test('delivery records hold event keys and states only, never message text', () =>
  withPage({}, async (world) => {
    await sendTaskCompleted(world, PROMPT, 'evt-1');

    const raw = world.sessionStorage.getItem('aiStudio.deliveries');
    assert.doesNotMatch(raw, /修复双发|session ID/);
    assert.equal(deliveryRecords(world)['evt-1'].state, 'sent');
  }));

// --- Marker safety is unchanged ----------------------------------------------------

test('a marker reverted right before the click is repaired in the same task, or the send is withheld', () =>
  withPage({}, async (world) => {
    world.sendButton.disabled = true;
    setTimeout(() => {
      // A re-render strips the marker while the button is still disabled.
      setComposerText(world, PROMPT);
      world.sendButton.disabled = false;
    }, 20);

    const response = await sendTaskCompleted(world, PROMPT, 'evt-1');

    assert.equal(response.ok, true);
    assert.deepEqual(markerIdsIn(world.app.sent[0]), [ROUTE_ID]);
  }));

test('an unrepairable marker before the click withholds the send and retracts our text', quietly(() =>
  withPage({}, async (world) => {
    world.sendButton.disabled = true;
    setTimeout(() => {
      setComposerText(world, PROMPT);
      // From now on every write is reverted.
      world.composer.addEventListener('input', () => { world.composer.value = PROMPT; });
      world.sendButton.disabled = false;
    }, 20);

    const response = await sendTaskCompleted(world, PROMPT, 'evt-1');

    assert.equal(response.state, 'inject-failed');
    assert.equal(response.retryable, false);
    assert.equal(world.sendButton.clicks, 0);
    assert.equal(world.app.sent.length, 0);
  })));
