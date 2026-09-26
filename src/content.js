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
const ROUTE_MARKER_RE = /<!--\s*AI_STUDIO_ROUTE:([0-9a-f-]{36})[^>]*-->/gi;

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

const registerRoute = (routeId) => {
  chrome.runtime.sendMessage(
    {
      type: 'aiStudio.routeRegistered',
      routeId,
      url: location.href,
    },
    () => {
      void chrome.runtime.lastError;
    },
  );
};

const registerCurrentRoute = () => {
  const routeId = getOrCreateRouteId();
  registerRoute(routeId);
  return routeId;
};

const buildRouteMarker = (routeId) =>
  '<!-- AI_STUDIO_ROUTE:' + routeId +
  '; if using studio_create_session, pass UUID as route_id; ' +
  'if route_id is unavailable, copy this comment unchanged into task -->';

const routeMarkerIds = (text) => {
  const ids = [];
  ROUTE_MARKER_RE.lastIndex = 0;
  let match;
  while ((match = ROUTE_MARKER_RE.exec(text)) !== null) {
    ids.push(match[1].toLowerCase());
  }
  return ids;
};

// The composer text must contain exactly one marker carrying the current
// route UUID. Extra markers, a stale UUID, or no marker all fail this check.
const markerVerified = (composer, routeId) => {
  const ids = routeMarkerIds(composerRawText(composer));
  return ids.length === 1 && ids[0] === routeId;
};

const buildTextWithMarker = (text, routeId) => {
  const withoutOldMarkers = text.replace(ROUTE_MARKER_RE, '').trimEnd();
  return withoutOldMarkers +
    (withoutOldMarkers ? '\n\n' : '') +
    buildRouteMarker(routeId);
};

const sendRouteMessage = (message) => {
  chrome.runtime.sendMessage(message, () => {
    void chrome.runtime.lastError;
  });
};

const reportInjectionOutcome = (ok, routeId, detail) => {
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
const injectRouteMarker = (composer, { reportMissingComposer = true } = {}) => {
  if (!composer) {
    if (reportMissingComposer) {
      reportInjectionOutcome(false, null, 'composer-not-found');
    }
    return { ok: false, routeId: null };
  }

  const routeId = registerCurrentRoute();

  for (let attempt = 0; attempt < MARKER_INJECT_ATTEMPTS; attempt++) {
    if (markerVerified(composer, routeId)) {
      reportInjectionOutcome(true, routeId);
      return { ok: true, routeId };
    }

    writePrompt(composer, buildTextWithMarker(composerRawText(composer), routeId));

    if (markerVerified(composer, routeId)) {
      reportInjectionOutcome(true, routeId);
      return { ok: true, routeId };
    }
  }

  const found = routeMarkerIds(composerRawText(composer)).join(',') || 'none';
  reportInjectionOutcome(
    false,
    routeId,
    'readback-mismatch:composer=' + composer.tagName + ':markers=' + found,
  );
  return { ok: false, routeId };
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
    registerCurrentRoute();
    sendResponse({ ok: true });
    return false;
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
