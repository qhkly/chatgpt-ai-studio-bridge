// Automated-send timing. Tests shorten these through a content-script-world
// global that the page itself cannot reach.
const SEND_TIMING = {
  // WAIT: how long a completion waits for an empty, idle composer. Nothing
  // has been written yet, so giving up here is safe to retry.
  waitEmptyMs: 60000,
  // SUBMIT: how long the filled prompt may wait for a usable send button
  // before we stop and leave it to the user. No click has happened yet.
  submitMs: 45000,
  pollMs: 300,
  // After THE click (there is only ever one per event): how long ChatGPT may
  // take to show the sent turn or start a reply. A slow page is not a reason
  // to click again; past this the outcome is unconfirmed and the draft stays.
  clickConfirmMs: 30000,
  // Once our text left the composer, how long the sent user turn (or a
  // started reply) may take to appear before the outcome is unconfirmed.
  confirmMs: 8000,
  // Re-announce the unchanged text so a framework that missed the first
  // input event can enable the send button. Only before the click.
  nudgeMs: 1000,
  ...(globalThis.__aiStudioBridgeTiming ?? {}),
};
const ROUTE_SYNC_MS = 1000;
// Automated sends can afford to wait one render cycle before trusting a
// write: framework re-renders that revert the composer happen asynchronously.
const MARKER_SETTLE_MS = 50;
const MARKER_INJECT_ATTEMPTS = 3;
const ROUTE_PENDING_KEY = 'aiStudio.route.pending';
const ROUTE_CONVERSATION_PREFIX = 'aiStudio.route.conversation.';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Markdown reference-definition marker: invisible when rendered, but kept in
// the message text the model sees (HTML comments get stripped upstream).
// Must match CHATGPT_ROUTE_MARKER_MD_START in AI Studio's tools_chatgpt.rs.
// Not line-anchored: Lexical's textContent joins paragraphs without newlines.
const ROUTE_MARKER_RE =
  /\[AI_STUDIO_ROUTE\]:[ \t]*ai-studio-route:([0-9a-f-]{36})(?:[ \t]+"[^"\n]*")?/gi;
// Legacy HTML-comment marker: still recognised so it is replaced, never written.
const LEGACY_ROUTE_MARKER_RE = /<!--\s*AI_STUDIO_ROUTE:([0-9a-f-]{36})[^>]*-->/gi;

let lastObservedUrl = '';
// Tri-state send-injection health. "Route registered" (badge ON) and "route
// marker actually reached the composer" are tracked separately so a clean
// registration never masks a failed send injection.
let lastInjectionOk = null;

// --- Composer resolver --------------------------------------------------------
// ChatGPT ships several composer generations (React textarea, Lexical, and the
// current ProseMirror editor with data-composer-* wrappers). Candidates are
// collected inside the composer containers first, every candidate is
// validated (connected, visible, editable, non-zero size), and the best-scored
// one wins. The page is never blindly searched for "the first contenteditable".
const COMPOSER_SCOPE_SELECTORS = [
  'form[data-chatgpt-composer]',
  '[data-composer-body]',
  '[data-composer-input-layout]',
  '[data-rich-text-layout]',
];

// Precise selectors are also tried page-wide; generic ones only inside a
// composer container, where they cannot hit an unrelated editor.
const COMPOSER_CANDIDATES = [
  { selector: '[data-testid="prompt-textarea"]', precise: true },
  { selector: '#prompt-textarea', precise: true },
  { selector: '[data-composer-markdown][contenteditable="true"][role="textbox"]', precise: true },
  { selector: 'div.ProseMirror[contenteditable="true"][role="textbox"]', precise: true },
  { selector: '[contenteditable="true"][data-lexical-editor="true"]', precise: true },
  // Editability left to validation, so a read-only editor (e.g. while a reply
  // streams) is diagnosed as readonly instead of "selectors missed".
  { selector: '[data-composer-markdown]', precise: true },
  { selector: 'div.ProseMirror', precise: true },
  { selector: '[contenteditable="true"][role="textbox"]', precise: false },
  { selector: 'textarea', precise: false },
];

const COMPOSER_ARIA_LABELS = ['询问 ChatGPT', 'Ask ChatGPT', 'Message ChatGPT', 'Ask anything'];

const queryAll = (root, selector) => {
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return [];
  }
};

const isHiddenElement = (element) => {
  for (let el = element; el && el.getAttribute; el = el.parentElement ?? el.parent) {
    if (el.getAttribute('hidden') !== null || el.getAttribute('aria-hidden') === 'true') {
      return true;
    }
    if (el.getAttribute('inert') !== null) return true;
  }
  if (typeof window.getComputedStyle === 'function') {
    try {
      const style = window.getComputedStyle(element);
      if (style?.display === 'none' || style?.visibility === 'hidden') return true;
    } catch {
    }
  }
  return false;
};

const hasLayoutBox = (element) => {
  if (typeof element.getBoundingClientRect !== 'function') return true;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
};

const isEditableComposer = (element) => {
  if (element.getAttribute('aria-disabled') === 'true' ||
      element.getAttribute('aria-readonly') === 'true') {
    return false;
  }
  if (element instanceof HTMLTextAreaElement) {
    return !element.disabled && !element.readOnly &&
      element.getAttribute('disabled') === null &&
      element.getAttribute('readonly') === null;
  }
  if (typeof element.isContentEditable === 'boolean') return element.isContentEditable;
  const editable = element.getAttribute('contenteditable');
  return editable === 'true' || editable === '' || editable === 'plaintext-only';
};

// null when usable, otherwise the rejection reason (diagnostics only).
const composerRejection = (element) => {
  if (!element?.isConnected) return 'disconnected';
  if (isHiddenElement(element) || !hasLayoutBox(element)) return 'hidden';
  if (!isEditableComposer(element)) return 'readonly';
  return null;
};

const scoreComposer = (element, inScope, selectorIndex) => {
  let score = COMPOSER_CANDIDATES.length - selectorIndex;
  if (inScope) score += 20;
  if (element.getAttribute('data-composer-markdown') !== null) score += 8;
  if (/(?:^|\s)ProseMirror(?:\s|$)/.test(element.getAttribute('class') ?? '')) score += 6;
  if (element.getAttribute('role') === 'textbox') score += 3;
  if (COMPOSER_ARIA_LABELS.includes(element.getAttribute('aria-label'))) score += 4;
  if (element.getAttribute('id') === 'prompt-textarea' ||
      element.getAttribute('data-testid') === 'prompt-textarea') {
    score += 4;
  }
  return score;
};

const composerScopes = () => {
  const scopes = [];
  for (const selector of COMPOSER_SCOPE_SELECTORS) {
    for (const scope of queryAll(document, selector)) {
      if (!scopes.includes(scope)) scopes.push(scope);
    }
  }
  return scopes;
};

// Returns { composer, summary }. summary is a short, content-free capability
// string (counts and a reason) explaining a miss; it never contains text.
const resolveComposer = () => {
  const scopes = composerScopes();
  const seen = new Map();

  const consider = (element, inScope, selectorIndex) => {
    const score = scoreComposer(element, inScope, selectorIndex);
    const previous = seen.get(element);
    if (previous === undefined || score > previous) seen.set(element, score);
  };

  COMPOSER_CANDIDATES.forEach(({ selector, precise }, index) => {
    for (const scope of scopes) {
      for (const element of queryAll(scope, selector)) consider(element, true, index);
    }
    if (precise) {
      for (const element of queryAll(document, selector)) {
        consider(element, scopes.some((scope) => scope.contains(element)), index);
      }
    }
  });

  let best = null;
  let bestScore = -Infinity;
  const rejections = { disconnected: 0, hidden: 0, readonly: 0 };
  for (const [element, score] of seen) {
    const rejection = composerRejection(element);
    if (rejection) {
      rejections[rejection]++;
      continue;
    }
    if (score > bestScore) {
      best = element;
      bestScore = score;
    }
  }

  if (best) return { composer: best, summary: null };

  const candidates = seen.size;
  let reason = 'rejected';
  if (candidates === 0) reason = 'selectors-missed';
  else if (rejections.hidden === candidates) reason = 'hidden-only';
  else if (rejections.readonly === candidates) reason = 'readonly-only';
  return {
    composer: null,
    summary: reason + ';scopes=' + scopes.length + ';candidates=' + candidates +
      ';hidden=' + rejections.hidden + ';readonly=' + rejections.readonly,
  };
};

const findComposer = () => resolveComposer().composer;

const composerNotFoundDetail = (summary = resolveComposer().summary) =>
  summary ? 'composer-not-found:' + summary : 'composer-not-found';

// --- Send button -------------------------------------------------------------
const PRECISE_SEND_SELECTORS = [
  '[data-testid="send-button"]',
  'button[aria-label="Send prompt"]',
  'button[aria-label="发送提示"]',
];
// A bare submit button only counts when it sits next to the composer.
const NEARBY_SEND_SELECTORS = [...PRECISE_SEND_SELECTORS, 'button[type="submit"]'];
const SEND_BUTTON_SELECTOR = NEARBY_SEND_SELECTORS.join(',');
const SEND_SEARCH_DEPTH = 8;

// While a reply streams the same slot holds a stop button ("停止"/"Stop").
const isStopButton = (button) =>
  button.getAttribute('data-testid') === 'stop-button' ||
  /^(?:stop|停止)/i.test(button.getAttribute('aria-label') ?? '');

const isUsableSendButton = (button) =>
  !!button?.isConnected && !isStopButton(button) && !isHiddenElement(button);

const composerAncestors = (composer) => {
  const ancestors = [];
  let el = composer?.parentElement ?? composer?.parent ?? null;
  for (let depth = 0; el && depth < SEND_SEARCH_DEPTH; depth++) {
    if (el === document.body || el === document.documentElement) break;
    ancestors.push(el);
    if (el.tagName === 'FORM') break;
    el = el.parentElement ?? el.parent ?? null;
  }
  return ancestors;
};

const findSendButton = (composer = findComposer()) => {
  for (const ancestor of composerAncestors(composer)) {
    for (const selector of NEARBY_SEND_SELECTORS) {
      const button = queryAll(ancestor, selector).find(isUsableSendButton);
      if (button) return button;
    }
  }
  for (const selector of PRECISE_SEND_SELECTORS) {
    const button = queryAll(document, selector).find(isUsableSendButton);
    if (button) return button;
  }
  return null;
};

const composerRawText = (element) => {
  if (element instanceof HTMLTextAreaElement) return element.value;
  return element.textContent ?? '';
};

const composerText = (element) => composerRawText(element).trim();

const setTextareaValue = (element, text) => {
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  );

  descriptor?.set?.call(element, text);
  element.dispatchEvent(new Event('input', { bubbles: true }));
};

const setEditableValue = (element, text) => {
  element.focus();

  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(element);
  selection?.removeAllRanges();
  selection?.addRange(range);

  document.execCommand('insertText', false, text);
  element.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: text,
    }),
  );
};

const writePrompt = (element, text) => {
  if (element instanceof HTMLTextAreaElement) {
    setTextareaValue(element, text);
    return;
  }

  setEditableValue(element, text);
};

const storageGet = (key) => {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
};

const storageSet = (key, value) => {
  try {
    sessionStorage.setItem(key, value);
  } catch {
  }
};

const storageRemove = (key) => {
  try {
    sessionStorage.removeItem(key);
  } catch {
  }
};

const normalizeRouteId = (value) => {
  if (typeof value !== 'string' || !UUID_RE.test(value.trim())) return null;
  return value.trim().toLowerCase();
};

const conversationIdFromUrl = () => {
  const match = location.pathname.match(
    /(?:^|\/)c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i,
  );
  return match?.[1]?.toLowerCase() ?? null;
};

const getOrCreateRouteId = () => {
  const conversationId = conversationIdFromUrl();

  if (conversationId) {
    const key = ROUTE_CONVERSATION_PREFIX + conversationId;
    const saved = normalizeRouteId(storageGet(key));
    if (saved) return saved;

    const pending = normalizeRouteId(storageGet(ROUTE_PENDING_KEY));
    const routeId = pending ?? crypto.randomUUID().toLowerCase();
    storageSet(key, routeId);
    storageRemove(ROUTE_PENDING_KEY);
    return routeId;
  }

  const pending = normalizeRouteId(storageGet(ROUTE_PENDING_KEY));
  if (pending) return pending;

  const routeId = crypto.randomUUID().toLowerCase();
  storageSet(ROUTE_PENDING_KEY, routeId);
  return routeId;
};

// Resolves true once the background has persisted the binding.
const registerRoute = (routeId) =>
  new Promise((resolve) => {
    chrome.runtime.sendMessage(
      {
        type: 'aiStudio.routeRegistered',
        routeId,
        url: location.href,
      },
      (response) => {
        void chrome.runtime.lastError;
        resolve(response?.ok === true);
      },
    );
  });

const registerCurrentRoute = () => {
  const routeId = getOrCreateRouteId();
  registerRoute(routeId);
  return routeId;
};

const buildRouteMarker = (routeId) =>
  '[AI_STUDIO_ROUTE]: ai-studio-route:' + routeId +
  ' "pass UUID as route_id; otherwise keep this line in task"';

const idsMatching = (re, text) => {
  const ids = [];
  re.lastIndex = 0;
  let match;
  while ((match = re.exec(text)) !== null) {
    ids.push(match[1].toLowerCase());
  }
  return ids;
};

// Every route marker in the text, current format and legacy alike.
const routeMarkerIds = (text) => [
  ...idsMatching(ROUTE_MARKER_RE, text),
  ...idsMatching(LEGACY_ROUTE_MARKER_RE, text),
];

// The composer text must contain exactly one marker — in the current Markdown
// format — carrying the current route UUID. Extra markers, a stale UUID, a
// leftover legacy HTML marker, or no marker all fail this check.
const markerVerified = (composer, routeId) => {
  const text = composerRawText(composer);
  const ids = idsMatching(ROUTE_MARKER_RE, text);
  return ids.length === 1 && ids[0] === routeId &&
    idsMatching(LEGACY_ROUTE_MARKER_RE, text).length === 0;
};

const buildTextWithMarker = (text, routeId) => {
  const withoutOldMarkers = text
    .replace(ROUTE_MARKER_RE, '')
    .replace(LEGACY_ROUTE_MARKER_RE, '')
    .trimEnd();
  return withoutOldMarkers +
    (withoutOldMarkers ? '\n\n' : '') +
    buildRouteMarker(routeId);
};

const sendRouteMessage = (message) => {
  chrome.runtime.sendMessage(message, () => {
    void chrome.runtime.lastError;
  });
};

// Every outcome goes to the background (per-tab record behind the popup);
// the failed/recovered pair below only drives the badge latch.
const reportInjectionOutcome = (ok, routeId, detail, source = 'send') => {
  sendRouteMessage({
    type: 'aiStudio.routeInjectOutcome',
    ok,
    routeId,
    detail: ok ? null : detail,
    at: Date.now(),
    url: location.href,
    source,
  });

  if (ok) {
    if (lastInjectionOk === false) {
      sendRouteMessage({
        type: 'aiStudio.routeInjectRecovered',
        routeId,
        url: location.href,
      });
    }
  } else {
    sendRouteMessage({
      type: 'aiStudio.routeInjectFailed',
      routeId,
      url: location.href,
      detail,
    });
  }
  lastInjectionOk = ok;
};

// Write the route marker into the live composer and prove it stuck by
// reading the composer text back. The composer is framework-controlled
// (React textarea / Lexical contenteditable), so a DOM write can be silently
// dropped — the read-back, not the write, is the source of truth.
const injectRouteMarker = (
  composer,
  { reportMissingComposer = true, source = 'send' } = {},
) => {
  if (!composer) {
    const detail = composerNotFoundDetail();
    if (reportMissingComposer) {
      reportInjectionOutcome(false, null, detail, source);
    }
    return { ok: false, routeId: null, detail };
  }

  const routeId = registerCurrentRoute();

  for (let attempt = 0; attempt < MARKER_INJECT_ATTEMPTS; attempt++) {
    if (markerVerified(composer, routeId)) {
      reportInjectionOutcome(true, routeId, null, source);
      return { ok: true, routeId };
    }

    writePrompt(composer, buildTextWithMarker(composerRawText(composer), routeId));

    if (markerVerified(composer, routeId)) {
      reportInjectionOutcome(true, routeId, null, source);
      return { ok: true, routeId };
    }
  }

  const found = routeMarkerIds(composerRawText(composer)).join(',') || 'none';
  const detail = 'readback-mismatch:composer=' + composer.tagName + ':markers=' + found;
  reportInjectionOutcome(false, routeId, detail, source);
  return { ok: false, routeId, detail };
};

// Popup "re-detect" capability check. It only runs on an EMPTY composer, so
// there is no user text to damage, and it removes its own marker within the
// same task (no await between write and cleanup), so neither the user nor an
// automated send can observe the marker. A composer with text is never
// touched: the probe is skipped and the injection state stays as it was.
const clearComposer = (composer) => {
  writePrompt(composer, '');
  if (composerRawText(composer).trim() !== '') {
    // Some editors ignore an empty insertText; delete the selection instead.
    document.execCommand('delete');
  }
  return composerRawText(composer).trim() === '';
};

// Text the user could have typed, i.e. anything besides route markers
// (current Markdown format or legacy HTML comments).
const nonMarkerText = (composer) =>
  composerRawText(composer)
    .replace(ROUTE_MARKER_RE, '')
    .replace(LEGACY_ROUTE_MARKER_RE, '')
    .trim();

const probeInjection = async () => {
  const { composer, summary } = resolveComposer();
  if (!composer) return { status: 'skipped', detail: composerNotFoundDetail(summary) };
  if (composerRawText(composer).trim() !== '') {
    return { status: 'skipped', detail: 'composer-has-text' };
  }

  const result = injectRouteMarker(composer, { source: 'probe' });
  const cleaned = clearComposer(composer);

  // Catch a framework re-render that resurrects the probe marker; only a
  // composer holding nothing but markers is cleared again.
  await sleep(MARKER_SETTLE_MS);
  const residue = composerRawText(composer).trim() !== '';
  const stillClean = cleaned && (!residue ||
    (nonMarkerText(composer) === '' && clearComposer(composer)));

  if (!stillClean) {
    const detail = 'probe-cleanup-failed';
    reportInjectionOutcome(false, result.routeId, detail, 'probe');
    return {
      status: 'failed',
      detail,
      outcome: { ok: false, routeId: result.routeId, detail, source: 'probe' },
    };
  }

  return {
    status: result.ok ? 'ok' : 'failed',
    detail: result.ok ? null : result.detail,
    outcome: {
      ok: result.ok,
      routeId: result.routeId,
      detail: result.ok ? null : result.detail,
      source: 'probe',
    },
  };
};

const reconcileRoute = () => {
  if (location.href === lastObservedUrl) return;
  lastObservedUrl = location.href;
  registerCurrentRoute();
};

const sleep = async (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// --- Automated send: one state machine per completion event ----------------
// WAIT (composer empty + idle) → FILL (prompt + verified marker) → SUBMIT
// (click only while the composer still holds exactly our text) → CONFIRM
// (the user turn renders or a reply starts). A click is never trusted on its
// own, the user's text is never overwritten, and once anything was written
// the event is never started again: a second attempt is how one notification
// turns into two messages.
const DELIVERY_RECORDS_KEY = 'aiStudio.deliveries';
// The background ledger (event-ledger.js) is the primary replay guard; these
// records only answer re-asks to this tab. Same time bound as the ledger,
// a smaller count (one tab's share), a few dozen KB at most.
const DELIVERY_RECORD_TTL_MS = 8 * 24 * 60 * 60 * 1000;
const MAX_DELIVERY_RECORDS = 500;
// Nothing was written to the composer, so the background may retry.
const RETRYABLE_DELIVERY_STATES = new Set(['busy', 'composer-not-found']);
const USER_TURN_SELECTOR = '[data-message-author-role="user"]';

// Per-tab record (sessionStorage survives reloads and content-script
// re-injection) so a redelivered event is answered, not re-sent. Holds the
// event key and a state only, never message text.
const readDeliveryRecords = () => {
  try {
    const records = JSON.parse(storageGet(DELIVERY_RECORDS_KEY) ?? '{}');
    return records && typeof records === 'object' ? records : {};
  } catch {
    return {};
  }
};

const writeDeliveryRecord = (key, record) => {
  const now = Date.now();
  const records = readDeliveryRecords();
  if (record) records[key] = { ...record, at: now };
  else delete records[key];
  const kept = Object.entries(records)
    .filter(([, value]) => now - Number(value?.at || 0) <= DELIVERY_RECORD_TTL_MS)
    .sort((a, b) => Number(b[1]?.at || 0) - Number(a[1]?.at || 0))
    .slice(0, MAX_DELIVERY_RECORDS);
  storageSet(DELIVERY_RECORDS_KEY, JSON.stringify(Object.fromEntries(kept)));
};

const deliveryResult = (state, detail = null) => ({
  ok: state === 'sent',
  state,
  retryable: RETRYABLE_DELIVERY_STATES.has(state),
  detail,
});

const squashSpace = (text) => text.replace(/\s+/g, '');

// Where our prompt stands in the composer. Whitespace is ignored because
// rich editors turn "\n\n" into paragraphs whose textContent has no newline.
const composerHolding = (composer, prompt) => {
  if (!composer) return 'missing';
  const text = squashSpace(nonMarkerText(composer));
  if (text === '') return 'empty';
  return text === squashSpace(prompt) ? 'ours' : 'other';
};

// Rendered user turns carrying this prompt. Compared against a baseline taken
// before the fill, because the same task can complete (and notify) twice.
const sentTurnCount = (prompt) => {
  const needle = squashSpace(prompt);
  return queryAll(document, USER_TURN_SELECTOR)
    .filter((turn) => squashSpace(turn.textContent ?? '').includes(needle))
    .length;
};

const isGenerating = () =>
  queryAll(document, 'button').some((button) =>
    isStopButton(button) && button.isConnected && !isHiddenElement(button));

const isSendEnabled = (button) =>
  !button.disabled &&
  button.getAttribute('disabled') === null &&
  button.getAttribute('aria-disabled') !== 'true';

const nudgeComposer = (composer) => {
  composer.dispatchEvent(new Event('input', { bubbles: true }));
};

const waitForIdleComposer = async () => {
  const deadline = Date.now() + SEND_TIMING.waitEmptyMs;
  for (;;) {
    const composer = findComposer();
    const busy = composer && (nonMarkerText(composer) !== '' || isGenerating());
    if (composer && !busy) return { composer };
    if (Date.now() >= deadline) {
      if (!composer) return { state: 'composer-not-found', detail: composerNotFoundDetail() };
      return { state: 'busy', detail: isGenerating() ? 'reply-streaming' : 'composer-has-text' };
    }
    await sleep(SEND_TIMING.pollMs);
  }
};

// Fill failed: take back exactly what we wrote (and nothing else), so a
// half-written notification cannot be sent later without its marker.
const retractFill = (prompt, detail) => {
  const composer = findComposer();
  const holding = composerHolding(composer, prompt);
  if (holding === 'other') return detail + ';left-user-text';
  if (holding === 'missing' || composerRawText(composer).trim() === '') return detail;
  return clearComposer(composer) ? detail : detail + ';cleanup-failed';
};

// At most ONE click per event. Before it, waiting and nudging are free:
// nothing can have been sent. After it, ChatGPT may have accepted the send
// even if the page shows nothing for seconds (slow React render, network),
// so a second click could post the message twice. From then on we only
// watch; if nothing proves the send, the event stops as unconfirmed and the
// draft (if still there) is left for the user.
const submitFilledPrompt = async (prompt, baseline) => {
  const submitDeadline = Date.now() + SEND_TIMING.submitMs;
  let clickedAt = 0;
  let lastNudgeAt = Date.now();
  let leftAt = 0;
  const attempt = () => (clickedAt ? 'clicked' : 'manual');

  for (;;) {
    // A new user turn with this prompt is the proof, whoever pressed send.
    if (sentTurnCount(prompt) > baseline) {
      return { state: 'sent', detail: attempt() };
    }

    const composer = findComposer();
    const holding = composerHolding(composer, prompt);

    if (holding === 'other') {
      // The user edited the notification: it is theirs now. Never click,
      // never rewrite.
      return { state: 'user-modified', detail: clickedAt ? 'after-click' : 'before-click' };
    }

    if (holding === 'ours') {
      leftAt = 0;
      if (clickedAt) {
        if (Date.now() - clickedAt >= SEND_TIMING.clickConfirmMs) {
          return { state: 'unconfirmed', detail: 'click-not-confirmed;draft-kept' };
        }
      } else {
        const button = findSendButton(composer);
        if (button && isSendEnabled(button) && !isGenerating()) {
          // Pre-send read-back, repaired within the same task as the click.
          if (!injectRouteMarker(composer).ok) {
            return {
              state: 'inject-failed',
              detail: retractFill(prompt, 'pre-send-readback-mismatch'),
            };
          }
          button.click();
          clickedAt = Date.now();
        } else if (Date.now() >= submitDeadline) {
          // Never clicked: leave it to the user. A retry later would race
          // their own send.
          return {
            state: 'unsent',
            detail: !button ? 'no-send-button' : !isSendEnabled(button) ? 'send-disabled' : 'reply-streaming',
          };
        } else if (Date.now() - lastNudgeAt >= SEND_TIMING.nudgeMs) {
          nudgeComposer(composer);
          lastNudgeAt = Date.now();
        }
      }
    } else {
      // Our text left the composer (sent, or removed by the user). A reply
      // starting is evidence of a send; otherwise wait for the turn.
      leftAt ||= Date.now();
      if (isGenerating()) {
        return { state: 'sent', detail: attempt() + ';reply-started' };
      }
      const confirmWindow = clickedAt
        ? Math.max(SEND_TIMING.confirmMs, clickedAt + SEND_TIMING.clickConfirmMs - leftAt)
        : SEND_TIMING.confirmMs;
      if (Date.now() - leftAt >= confirmWindow) {
        return clickedAt
          ? { state: 'unconfirmed', detail: 'composer-cleared-after-click' }
          : { state: 'cleared', detail: 'composer-cleared-without-send' };
      }
    }

    await sleep(SEND_TIMING.pollMs);
  }
};

const runDelivery = async (prompt, key) => {
  const finish = ({ state, detail = null }) => {
    const result = deliveryResult(state, detail);
    if (key) {
      writeDeliveryRecord(key, result.retryable ? null : { state, detail });
    }
    if (!result.ok) {
      console.warn('[AI Studio Bridge] Completion not sent', { state, detail });
    }
    return result;
  };

  const idle = await waitForIdleComposer();
  if (!idle.composer) return finish(idle);

  const { composer } = idle;
  // Recorded before the first write: from here on this event is never
  // started again, only answered.
  if (key) writeDeliveryRecord(key, { state: 'pending' });
  const baseline = sentTurnCount(prompt);

  writePrompt(composer, prompt);
  const injection = injectRouteMarker(composer);
  if (!injection.ok) {
    // Never submit without a verified marker: an unroutable message is worse
    // than a visible failure (badge "!").
    return finish({ state: 'inject-failed', detail: retractFill(prompt, injection.detail) });
  }
  if (composerHolding(composer, prompt) !== 'ours') {
    return finish({ state: 'inject-failed', detail: retractFill(prompt, 'prompt-not-written') });
  }

  // Let one render cycle pass before the first click. A re-render that
  // reverted the marker is repaired right before the click (same task);
  // anything the user did meanwhile is classified, never written over.
  await sleep(MARKER_SETTLE_MS);
  return finish(await submitFilledPrompt(prompt, baseline));
};

const activeDeliveries = new Map();
let deliveryChain = Promise.resolve();

// One delivery at a time per tab, and one run per event key: a concurrent
// copy joins the running attempt, a later copy gets the recorded outcome.
const deliverCompletion = (prompt, key, resume = false) => {
  if (key) {
    const running = activeDeliveries.get(key);
    if (running) return running;
    const record = readDeliveryRecords()[key];
    if (record) {
      // 'pending' without a running job: a previous instance of this script
      // (extension reload) owned the attempt and its fate is unknown.
      return Promise.resolve(record.state === 'pending'
        ? deliveryResult('ambiguous', 'orphaned-attempt')
        : { ...deliveryResult(record.state, record.detail), retryable: false });
    }
    if (resume) {
      // The background began this event earlier and lost track (worker
      // restart, browser restart). No record here does not prove nothing
      // was sent (records expire, sessionStorage can be lost), so stop.
      return Promise.resolve(deliveryResult('ambiguous', 'no-record-for-resumed-attempt'));
    }
  }

  const job = deliveryChain.then(() => runDelivery(prompt, key));
  deliveryChain = job.catch(() => {});
  if (key) {
    activeDeliveries.set(key, job);
    job.finally(() => activeDeliveries.delete(key)).catch(() => {});
  }
  return job;
};

// A precise send button anywhere, or a bare submit button that shares the
// composer's container; never a stop button.
const sendGestureTarget = (event) => {
  if (!(event.target instanceof Element)) return null;
  const button = event.target.closest(SEND_BUTTON_SELECTOR);
  if (!button || isStopButton(button)) return null;
  if (PRECISE_SEND_SELECTORS.some((selector) => button.matches(selector))) return button;
  const composer = findComposer();
  return composer && composerAncestors(composer).some((el) => el.contains(button))
    ? button
    : null;
};

// pointerdown fires before the app's click handler reads the editor state:
// inject and verify while there is still time for a retry to land.
document.addEventListener(
  'pointerdown',
  (event) => {
    if (!sendGestureTarget(event)) return;
    injectRouteMarker(findComposer());
  },
  true,
);

// click is the last checkpoint before the app serializes the composer:
// re-verify, and repair synchronously if a re-render reverted the marker.
document.addEventListener(
  'click',
  (event) => {
    if (!sendGestureTarget(event)) return;
    injectRouteMarker(findComposer());
  },
  true,
);

document.addEventListener(
  'keydown',
  (event) => {
    if (
      event.key !== 'Enter' ||
      event.shiftKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.isComposing
    ) {
      return;
    }

    const composer = findComposer();
    if (!composer) return;
    const target = event.target;
    if (target !== composer && !(target instanceof Node && composer.contains(target))) {
      return;
    }

    injectRouteMarker(composer);
  },
  true,
);

document.addEventListener(
  'submit',
  () => {
    // Forms unrelated to the composer (login, feedback) must not raise
    // injection alarms; only a composer we can see but fail to mark is a
    // genuine send-injection fault.
    injectRouteMarker(findComposer(), { reportMissingComposer: false });
  },
  true,
);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'aiStudio.ping') {
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === 'aiStudio.requestRouteRegistration') {
    const routeId = getOrCreateRouteId();
    registerRoute(routeId)
      .then(async (registered) => ({
        ok: registered,
        routeId,
        probe: message.probe === true ? await probeInjection() : null,
      }))
      .then(sendResponse)
      .catch((error) => {
        console.error('[AI Studio Bridge] Re-detection failed', error);
        sendResponse({ ok: false, routeId });
      });
    return true;
  }

  if (message?.type !== 'aiStudio.taskCompleted') return undefined;

  const key = typeof message.eventKey === 'string' && message.eventKey
    ? message.eventKey
    : null;
  deliverCompletion(message.prompt, key, message.resume === true)
    .then(sendResponse)
    .catch((error) => {
      console.error('[AI Studio Bridge] Failed to send prompt', error);
      // Unknown how far it got: never invite a retry.
      sendResponse(deliveryResult('ambiguous', 'internal-error'));
    });

  return true;
});

reconcileRoute();
setInterval(reconcileRoute, ROUTE_SYNC_MS);
