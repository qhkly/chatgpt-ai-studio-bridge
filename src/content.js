const SEND_TIMEOUT_MS = 60000;
const RETRY_MS = 300;
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

const findComposer = () =>
  document.querySelector('#prompt-textarea') ||
  document.querySelector('[contenteditable="true"][data-lexical-editor="true"]');

const SEND_BUTTON_SELECTOR = [
  '[data-testid="send-button"]',
  'button[aria-label="Send prompt"]',
  'button[aria-label="发送提示"]',
].join(',');

const findSendButton = () => document.querySelector(SEND_BUTTON_SELECTOR);

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
    if (reportMissingComposer) {
      reportInjectionOutcome(false, null, 'composer-not-found', source);
    }
    return { ok: false, routeId: null, detail: 'composer-not-found' };
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
  const composer = findComposer();
  if (!composer) return { status: 'skipped', detail: 'composer-not-found' };
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

// Variant for automated sends, which can wait one render cycle: verify again
// after a settle delay so an asynchronous framework re-render that reverted
// the marker is caught instead of shipped.
const injectRouteMarkerSettled = async (composer) => {
  const result = injectRouteMarker(composer);
  if (!result.ok) return result;

  await sleep(MARKER_SETTLE_MS);

  if (markerVerified(composer, result.routeId)) {
    return result;
  }

  // The settle window reverted the marker. Rewrite and verify within the
  // same task — the send that follows immediately cannot be raced by
  // another render pass.
  writePrompt(
    composer,
    buildTextWithMarker(composerRawText(composer), result.routeId),
  );
  if (markerVerified(composer, result.routeId)) {
    reportInjectionOutcome(true, result.routeId);
    return result;
  }

  reportInjectionOutcome(false, result.routeId, 'settled-readback-mismatch');
  return { ok: false, routeId: result.routeId };
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

const sendPrompt = async (prompt) => {
  const deadline = Date.now() + SEND_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const composer = findComposer();

    if (composer && composerText(composer) === '') {
      writePrompt(composer, prompt);
      const injection = await injectRouteMarkerSettled(composer);

      if (!injection.ok) {
        // Never click send without a verified marker: an unroutable message
        // is worse than a visible failure (badge "!").
        return false;
      }

      // Final read-back immediately before triggering the send action.
      if (!markerVerified(composer, injection.routeId)) {
        reportInjectionOutcome(false, injection.routeId, 'pre-send-readback-mismatch');
        return false;
      }

      const sendButton = findSendButton();
      if (sendButton && !sendButton.disabled) {
        sendButton.click();
        return true;
      }
    }

    await sleep(RETRY_MS);
  }

  return false;
};

const sendGestureTarget = (event) =>
  event.target instanceof Element
    ? event.target.closest(SEND_BUTTON_SELECTOR)
    : null;

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

  sendPrompt(message.prompt)
    .then((ok) => sendResponse({ ok }))
    .catch((error) => {
      console.error('[AI Studio Bridge] Failed to send prompt', error);
      sendResponse({ ok: false });
    });

  return true;
});

reconcileRoute();
setInterval(reconcileRoute, ROUTE_SYNC_MS);
