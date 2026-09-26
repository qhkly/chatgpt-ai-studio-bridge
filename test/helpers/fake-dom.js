// Minimal fake DOM good enough to execute src/content.js inside node --test.
// The point is to exercise the real content script end-to-end: event capture,
// composer writes, read-back verification, and background messaging.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const CONVERSATION_ID = 'b72b6f8f-20ce-4c89-a54f-7cb52c9d0f42';

const matchesAttrSelector = (element, selector) => {
  let rest = selector;

  const tagMatch = rest.match(/^[a-zA-Z][a-zA-Z0-9-]*/);
  if (tagMatch) {
    if (element.tagName !== tagMatch[0].toUpperCase()) return false;
    rest = rest.slice(tagMatch[0].length);
  }

  const attrs = [...rest.matchAll(/\[([a-zA-Z-]+)="([^"]*)"\]/g)];
  if (attrs.length === 0) return false;

  return attrs.every(([, name, value]) => element.getAttribute(name) === value);
};

const matchesSimpleSelector = (element, simple) => {
  simple = simple.trim();
  if (simple.startsWith('#')) return element.getAttribute('id') === simple.slice(1);
  return matchesAttrSelector(element, simple);
};

const matchesSelector = (element, selector) =>
  selector
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .some((simple) => matchesSimpleSelector(element, simple));

class FakeNode {
  constructor() {
    this.childNodes = [];
    this.parent = null;
  }

  contains(node) {
    for (let current = node; current; current = current.parent) {
      if (current === this) return true;
    }
    return false;
  }
}

class FakeElement extends FakeNode {
  constructor(tag, attributes = {}) {
    super();
    this.tagName = tag.toUpperCase();
    this.attributes = { ...attributes };
    this._textContent = '';
    this.disabled = false;
    this.focused = false;
    this.clicks = 0;
    this._listeners = {};
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  get textContent() {
    return this._textContent;
  }

  set textContent(value) {
    this._textContent = String(value);
  }

  appendChild(child) {
    child.parent = this;
    this.childNodes.push(child);
    return child;
  }

  focus() {
    this.ownerDocument.activeElement = this;
    this.focused = true;
  }

  click() {
    this.clicks++;
  }

  addEventListener(type, listener) {
    (this._listeners[type] ??= []).push(listener);
  }

  dispatchEvent(event) {
    for (const listener of this._listeners[event.type] ?? []) listener(event);
    return true;
  }

  closest(selector) {
    for (let el = this; el; el = el.parent) {
      if (matchesSelector(el, selector)) return el;
    }
    return null;
  }
}

// `value` lives on the prototype so content.js can reach it through
// Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value'),
// exactly like a real <textarea>.
class FakeHTMLTextAreaElement extends FakeElement {
  constructor(attributes = {}) {
    super('textarea', attributes);
    this._value = '';
  }

  get value() {
    return this._value;
  }

  set value(text) {
    this._value = String(text);
  }
}

class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    Object.assign(this, init);
  }
}

class FakeInputEvent extends FakeEvent {}

const createWorld = ({ execCommand } = {}) => {
  const document = {
    body: new FakeElement('body'),
    activeElement: null,
    _listeners: [],
  };
  document.body.ownerDocument = document;

  document.addEventListener = (type, listener) => {
    document._listeners.push({ type, listener });
  };

  const allElements = () => {
    const out = [];
    const walk = (element) => {
      out.push(element);
      element.childNodes.forEach(walk);
    };
    walk(document.body);
    return out;
  };

  document.querySelector = (selector) =>
    allElements().find((element) => matchesSelector(element, selector)) ?? null;

  document.createRange = () => ({ selectNodeContents() {} });
  document.execCommand = (command, showUI, value) => {
    if (execCommand) return execCommand(command, showUI, value, document);
    // Default, browser-like behavior: insertText only works on the focused
    // editing host and is a silent no-op otherwise.
    if (command !== 'insertText') return false;
    const active = document.activeElement;
    if (!active || !active.focused) return false;
    active._textContent = String(value);
    return true;
  };

  const sessionStorageMap = new Map();
  const sessionStorage = {
    getItem: (key) => (sessionStorageMap.has(key) ? sessionStorageMap.get(key) : null),
    setItem: (key, value) => sessionStorageMap.set(key, String(value)),
    removeItem: (key) => sessionStorageMap.delete(key),
  };

  const sentMessages = [];
  const messageListeners = [];
  const chrome = {
    runtime: {
      lastError: null,
      sendMessage: (message, callback) => {
        sentMessages.push(message);
        callback?.();
      },
      onMessage: {
        addListener: (listener) => messageListeners.push(listener),
      },
    },
  };

  const world = {
    document,
    sessionStorage,
    chrome,
    sentMessages,
    messageListeners,
    conversationId: CONVERSATION_ID,
    routeId: null,
  };

  const globals = {
    document,
    window: {
      getSelection: () => ({
        removeAllRanges() {},
        addRange() {},
      }),
    },
    chrome,
    sessionStorage,
    crypto: { randomUUID },
    Element: FakeElement,
    Node: FakeNode,
    HTMLTextAreaElement: FakeHTMLTextAreaElement,
    Event: FakeEvent,
    InputEvent: FakeInputEvent,
    location: {
      pathname: '/c/' + CONVERSATION_ID,
      href: 'https://chatgpt.com/c/' + CONVERSATION_ID,
    },
    // The 1s reconcile loop would keep the test process alive; the harness
    // only cares about event-driven behavior.
    setInterval: () => 0,
  };

  const previous = Object.fromEntries(
    Object.keys(globals).map((key) => [key, globalThis[key]]),
  );
  // Some globals (crypto on node >= 24) are getter-only, so plain
  // assignment would throw; defineProperty keeps them swappable.
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  }

  // Pin the route UUID through the same sessionStorage the content script
  // reads, so assertions can predict the exact marker.
  const setFixedRoute = (routeId) => {
    world.routeId = routeId;
    sessionStorage.setItem('aiStudio.route.conversation.' + CONVERSATION_ID, routeId);
  };
  world.setFixedRoute = setFixedRoute;
  world.restoreGlobals = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else {
        Object.defineProperty(globalThis, key, {
          value,
          configurable: true,
          writable: true,
        });
      }
    }
  };

  return world;
};

const loadContentScript = () => {
  const code = readFileSync(new URL('../../src/content.js', import.meta.url), 'utf8');
  new Function(code)();
};

const dispatchDocument = (world, type, target, init = {}) => {
  const event = {
    type,
    target,
    ...init,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {},
    stopImmediatePropagation() {},
  };
  for (const { type: listenerType, listener } of world.document._listeners) {
    if (listenerType === type) listener(event);
  }
  return event;
};

// Builds a ChatGPT-like page: a composer (textarea or Lexical-style
// contenteditable) plus a send button nested inside a toolbar wrapper, then
// executes the real content script against it.
export const setupPage = ({ composer = 'textarea', execCommand, routeId } = {}) => {
  const world = createWorld({ execCommand });

  const composerElement = composer === 'textarea'
    ? new FakeHTMLTextAreaElement({ id: 'prompt-textarea' })
    : new FakeElement('div', { contenteditable: 'true', 'data-lexical-editor': 'true' });
  composerElement.ownerDocument = world.document;

  const toolbar = new FakeElement('div');
  toolbar.ownerDocument = world.document;
  const sendButton = new FakeElement('button', { 'data-testid': 'send-button' });
  sendButton.ownerDocument = world.document;
  toolbar.appendChild(sendButton);

  world.document.body.appendChild(composerElement);
  world.document.body.appendChild(toolbar);
  world.composer = composerElement;
  world.sendButton = sendButton;
  world.isTextarea = composer === 'textarea';

  if (routeId) world.setFixedRoute(routeId);
  else world.setFixedRoute('11111111-2222-3333-4444-555555555555');

  loadContentScript();
  world.sentMessages.length = 0; // drop the initial registration burst
  return world;
};

export const dispatchDocumentFor = dispatchDocument;

export const composerTextOf = (world) =>
  world.isTextarea ? world.composer.value : world.composer.textContent;

export const setComposerText = (world, text) => {
  if (world.isTextarea) world.composer.value = text;
  else world.composer.textContent = text;
};

export const routeMarkerText = (routeId) =>
  '[AI_STUDIO_ROUTE]: ai-studio-route:' + routeId +
  ' "pass UUID as route_id; otherwise keep this line in task"';

// Pre-Markdown marker format; must still be recognised and replaced.
export const legacyRouteMarkerText = (routeId) =>
  '<!-- AI_STUDIO_ROUTE:' + routeId +
  '; if using studio_create_session, pass UUID as route_id; ' +
  'if route_id is unavailable, copy this comment unchanged into task -->';

export const MARKER_IDS_RE = /\[AI_STUDIO_ROUTE\]: ai-studio-route:([0-9a-f-]{36})/gi;
export const LEGACY_MARKER_IDS_RE = /<!--\s*AI_STUDIO_ROUTE:([0-9a-f-]{36})[^>]*-->/gi;

const idsMatching = (re, text) => {
  const ids = [];
  re.lastIndex = 0;
  let match;
  while ((match = re.exec(text)) !== null) ids.push(match[1]);
  return ids;
};

export const markerIdsIn = (text) => idsMatching(MARKER_IDS_RE, text);
export const legacyMarkerIdsIn = (text) => idsMatching(LEGACY_MARKER_IDS_RE, text);

// Drives the content script's chrome.runtime.onMessage listener the way the
// background worker would for a completion notification.
export const sendTaskCompleted = async (world, prompt) => {
  const listener = world.messageListeners.find(
    (candidate) => candidate !== undefined,
  );
  return new Promise((resolve) => {
    const async = listener(
      { type: 'aiStudio.taskCompleted', prompt },
      {},
      resolve,
    );
    if (async !== true) resolve(undefined);
  });
};

export const withPage = async (options, run) => {
  const world = setupPage(options);
  try {
    await run(world);
  } finally {
    world.restoreGlobals();
  }
};
