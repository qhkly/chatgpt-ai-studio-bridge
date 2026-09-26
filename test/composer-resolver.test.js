import assert from 'node:assert/strict';
import test from 'node:test';

import {
  composerTextOf,
  dispatchDocumentFor as dispatch,
  fakeElement as el,
  legacyMarkerIdsIn,
  legacyRouteMarkerText,
  markerIdsIn,
  routeMarkerText,
  sendTaskCompleted,
  sendToContent,
  setComposerText,
  setupPage,
  withPage,
} from './helpers/fake-dom.js';

const ROUTE_ID = '11111111-2222-3333-4444-555555555555';

const injectFailures = (world) =>
  world.sentMessages.filter((message) => message.type === 'aiStudio.routeInjectFailed');

const outcomes = (world) =>
  world.sentMessages.filter((message) => message.type === 'aiStudio.routeInjectOutcome');

const redetect = (world) =>
  sendToContent(world, { type: 'aiStudio.requestRouteRegistration', probe: true });

// Inserts decoys ahead of the real composer so DOM order alone would pick them.
const prepend = (world, ...elements) => {
  const body = world.document.body;
  const adopt = (node) => {
    node.ownerDocument = world.document;
    node.childNodes.forEach(adopt);
  };
  for (const element of elements.reverse()) {
    element.parent = body;
    adopt(element);
    body.childNodes.unshift(element);
  }
};

const visibleEditable = (attributes = {}) =>
  el('div', { contenteditable: 'true', role: 'textbox', ...attributes });

// --- Real ChatGPT DOM: ProseMirror + data-composer-markdown ------------------

test('ProseMirror composer: pointerdown on send injects a read-back verified Markdown marker', () => {
  const world = setupPage({ composer: 'prosemirror' });
  setComposerText(world, 'please review');

  dispatch(world, 'pointerdown', world.sendButton);

  const text = composerTextOf(world);
  assert.deepEqual(markerIdsIn(text), [ROUTE_ID]);
  assert.equal(text, 'please review\n\n' + routeMarkerText(ROUTE_ID));
  assert.equal(world.composer.focused, true, 'written through focus + execCommand');
  assert.equal(injectFailures(world).length, 0);
  assert.equal(outcomes(world).at(-1).ok, true);
});

test('ProseMirror composer: Enter inside the editor injects before the app handler', () => {
  const world = setupPage({ composer: 'prosemirror' });
  setComposerText(world, 'continue');
  const paragraph = el('p');
  world.composer.appendChild(paragraph);

  dispatch(world, 'keydown', paragraph, { key: 'Enter' });

  assert.deepEqual(markerIdsIn(composerTextOf(world)), [ROUTE_ID]);
  assert.equal(injectFailures(world).length, 0);
});

test('ProseMirror composer: a legacy HTML marker is replaced by the Markdown marker', () => {
  const world = setupPage({ composer: 'prosemirror' });
  setComposerText(world, 'hello\n\n' + legacyRouteMarkerText(ROUTE_ID));

  dispatch(world, 'click', world.sendButton);

  const text = composerTextOf(world);
  assert.deepEqual(markerIdsIn(text), [ROUTE_ID]);
  assert.deepEqual(legacyMarkerIdsIn(text), []);
});

test('ProseMirror composer: re-detect probe passes and leaves the editor empty', () =>
  withPage({ composer: 'prosemirror' }, async (world) => {
    const response = await redetect(world);

    assert.equal(response.ok, true);
    assert.equal(response.probe.status, 'ok');
    assert.equal(response.probe.outcome.source, 'probe');
    assert.equal(composerTextOf(world), '');
  }));

test('ProseMirror composer: sendPrompt writes, verifies and clicks the form send button', async () => {
  const world = setupPage({ composer: 'prosemirror' });

  const response = await sendTaskCompleted(world, 'worker finished');

  assert.deepEqual(response, { ok: true });
  assert.equal(world.sendButton.clicks, 1);
  assert.match(composerTextOf(world), /worker finished/);
  assert.deepEqual(markerIdsIn(composerTextOf(world)), [ROUTE_ID]);
});

// --- Candidate validation ----------------------------------------------------

test('a hidden #prompt-textarea and a 0x0 composer editor are skipped for the visible ProseMirror', () => {
  const zeroSize = visibleEditable({
    class: 'ProseMirror',
    'data-composer-markdown': '',
    'aria-label': '询问 ChatGPT',
  });
  zeroSize.rect = { width: 0, height: 0 };
  const world = setupPage({
    composer: 'prosemirror',
    decorate: (w) => prepend(
      w,
      el('div', { 'data-composer-body': '' }, [
        el('textarea', { id: 'prompt-textarea', hidden: '' }),
      ]),
      el('div', { 'data-composer-body': '' }, [zeroSize]),
    ),
  });
  setComposerText(world, 'hi');

  dispatch(world, 'pointerdown', world.sendButton);

  assert.deepEqual(markerIdsIn(composerTextOf(world)), [ROUTE_ID]);
  assert.equal(zeroSize.textContent, '');
  assert.equal(injectFailures(world).length, 0);
});

test('an aria-hidden composer editor and a disabled composer textarea are never selected', () => {
  const world = setupPage({
    composer: 'prosemirror',
    decorate: (w) => prepend(
      w,
      el('div', { 'aria-hidden': 'true', 'data-composer-body': '' }, [
        visibleEditable({
          class: 'ProseMirror',
          'data-composer-markdown': '',
          'aria-label': '询问 ChatGPT',
        }),
      ]),
      el('form', { 'data-chatgpt-composer': '' }, [
        Object.assign(el('textarea', { 'data-testid': 'prompt-textarea' }), { disabled: true }),
      ]),
    ),
  });

  return sendTaskCompleted(world, 'done').then((response) => {
    assert.deepEqual(response, { ok: true });
    assert.deepEqual(markerIdsIn(composerTextOf(world)), [ROUTE_ID]);
  });
});

test('with several visible candidates the ProseMirror composer editor wins', () => {
  const genericInScope = visibleEditable();
  const world = setupPage({
    composer: 'prosemirror',
    decorate: (w) => {
      // A plain role=textbox editor sharing the composer container.
      w.composer.parent.parent.appendChild(genericInScope);
    },
  });
  setComposerText(world, 'hi');

  dispatch(world, 'pointerdown', world.sendButton);

  assert.deepEqual(markerIdsIn(composerTextOf(world)), [ROUTE_ID]);
  assert.equal(genericInScope.textContent, '');
});

test('an unrelated contenteditable outside any composer container is never picked', () =>
  withPage({
    composer: 'prosemirror',
    decorate: (w) => {
      w.document.body.childNodes.length = 0;
      w.document.body.appendChild(visibleEditable({ 'aria-label': 'Canvas' }));
      w.document.body.appendChild(el('textarea', { name: 'feedback' }));
    },
  }, async (world) => {
    const response = await redetect(world);

    assert.equal(response.probe.status, 'skipped');
    assert.match(response.probe.detail, /^composer-not-found:selectors-missed;/);
  }));

// --- composer-not-found diagnostics -------------------------------------------

test('only hidden candidates yield a hidden-only summary with counts and no text', () =>
  withPage({
    composer: 'prosemirror',
    decorate: (w) => {
      w.composer.rect = { width: 0, height: 0 };
      w.composer.textContent = 'secret user draft';
    },
  }, async (world) => {
    const response = await redetect(world);

    assert.equal(response.probe.status, 'skipped');
    assert.equal(
      response.probe.detail,
      'composer-not-found:hidden-only;scopes=3;candidates=1;hidden=1;readonly=0',
    );
    assert.doesNotMatch(response.probe.detail, /secret/);
    assert.equal(world.composer.textContent, 'secret user draft');
  }));

test('a send gesture without a usable composer reports the resolver summary', () => {
  const world = setupPage({
    composer: 'prosemirror',
    decorate: (w) => w.composer.setAttribute('contenteditable', 'false'),
  });

  dispatch(world, 'pointerdown', world.sendButton);

  const failures = injectFailures(world);
  assert.equal(failures.length, 1);
  assert.match(failures[0].detail, /^composer-not-found:readonly-only;scopes=3;candidates=1;/);
});

// --- Send button ----------------------------------------------------------------

test('a stop button (aria-label 停止) is not a send gesture', () => {
  const world = setupPage({ composer: 'prosemirror' });
  const stop = el('button', { 'data-testid': 'stop-button', 'aria-label': '停止', type: 'submit' });
  world.sendButton.parent.appendChild(stop);
  setComposerText(world, 'draft');

  dispatch(world, 'pointerdown', stop);

  assert.equal(composerTextOf(world), 'draft');
});

test('a bare submit button next to the composer is used; one in an unrelated form is not', async () => {
  const world = setupPage({ composer: 'prosemirror' });
  const trailing = world.sendButton.parent;
  trailing.childNodes.length = 0;
  const submit = el('button', { type: 'submit' });
  trailing.appendChild(submit);
  const loginSubmit = el('button', { type: 'submit' });
  world.document.body.appendChild(el('form', { action: '/login' }, [loginSubmit]));

  setComposerText(world, 'draft');
  dispatch(world, 'pointerdown', loginSubmit);
  assert.equal(composerTextOf(world), 'draft');

  dispatch(world, 'pointerdown', submit);
  assert.deepEqual(markerIdsIn(composerTextOf(world)), [ROUTE_ID]);

  setComposerText(world, '');
  const response = await sendTaskCompleted(world, 'next task');
  assert.deepEqual(response, { ok: true });
  assert.equal(submit.clicks, 1);
  assert.equal(loginSubmit.clicks, 0);
});

test('the send button nearest the composer wins over another one elsewhere on the page', async () => {
  const world = setupPage({ composer: 'prosemirror' });
  const elsewhere = el('button', { 'data-testid': 'send-button' });
  prepend(world, el('div', {}, [elsewhere]));

  const response = await sendTaskCompleted(world, 'task');

  assert.deepEqual(response, { ok: true });
  assert.equal(world.sendButton.clicks, 1);
  assert.equal(elsewhere.clicks, 0);
});
