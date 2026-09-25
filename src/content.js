const SEND_TIMEOUT_MS = 60000;
const RETRY_MS = 300;
const ROUTE_SYNC_MS = 1000;
const ROUTE_PENDING_KEY = 'aiStudio.route.pending';
const ROUTE_CONVERSATION_PREFIX = 'aiStudio.route.conversation.';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROUTE_MARKER_RE = /<!--\s*AI_STUDIO_ROUTE:([0-9a-f-]{36})[^>]*-->/gi;

let lastObservedUrl = '';

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

const ensureComposerRouteMarker = (composer) => {
  if (!composer) return null;

  const routeId = registerCurrentRoute();
  const current = composerRawText(composer);
  const withoutOldMarkers = current.replace(ROUTE_MARKER_RE, '').trimEnd();
  const next = withoutOldMarkers +
    (withoutOldMarkers ? '\n\n' : '') +
    buildRouteMarker(routeId);

  if (next !== current) writePrompt(composer, next);
  return routeId;
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
      ensureComposerRouteMarker(composer);
      await sleep(100);

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

document.addEventListener(
  'pointerdown',
  (event) => {
    const target = event.target instanceof Element
      ? event.target.closest(SEND_BUTTON_SELECTOR)
      : null;
    if (!target) return;
    ensureComposerRouteMarker(findComposer());
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

    ensureComposerRouteMarker(composer);
  },
  true,
);

document.addEventListener(
  'submit',
  () => {
    ensureComposerRouteMarker(findComposer());
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
