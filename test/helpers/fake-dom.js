// Minimal fake DOM good enough to execute src/content.js inside node --test.
// The point is to exercise the real content script end-to-end: event capture,
// composer writes, read-back verification, and background messaging.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const CONVERSATION_ID = 'b72b6f8f-20ce-4c89-a54f-7cb52c9d0f42';

// Compound selectors only (no combinators): tag, #id, .class, [attr],
// [attr="value"], comma-separated lists.
const COMPOUND_TOKEN_RE = /^(?:([a-zA-Z][a-zA-Z0-9-]*)|#([\w-]+)|\.([\w-]+)|\[([a-zA-Z-]+)(?:="([^"]*)")?\])/;

const matchesSimpleSelector = (element, simple) => {
  let rest = simple.trim();
  if (!rest) return false;
  while (rest) {
    const match = rest.match(COMPOUND_TOKEN_RE);
    if (!match) throw new Error('fake-dom: unsupported selector ' + simple);
    const [token, tag, id, className, attr, value] = match;
    if (tag && element.tagName !== tag.toUpperCase()) return false;
    if (id && element.getAttribute('id') !== id) return false;
    if (className &&
        !(element.getAttribute('class') ?? '').split(/\s+/).includes(className)) {
      return false;
    }
    if (attr) {
      const actual = element.getAttribute(attr);
      if (actual === null) return false;
      if (value !== undefined && actual !== value) return false;
    }
    rest = rest.slice(token.length);
  }
  return true;
};

const matchesSelector = (element, selector) =>
  selector
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .some((simple) => matchesSimpleSelector(element, simple));

const descendantsOf = (root) => {
  const out = [];
  const walk = (node) => {
    for (const child of node.childNodes) {
      out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
};

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
    // Layout box reported by getBoundingClientRect; tests shrink it to 0x0.
    this.rect = { width: 320, height: 24 };
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  get parentElement() {
    return this.parent instanceof FakeElement ? this.parent : null;
  }

  // Attached means reachable from <body> through live childNodes links.
  get isConnected() {
    const body = this.ownerDocument?.body;
    let node = this;
    while (node !== body) {
      const parent = node.parent;
      if (!parent || !parent.childNodes.includes(node)) return false;
      node = parent;
    }
    return true;
  }

  getBoundingClientRect() {
    return { ...this.rect };
  }

  matches(selector) {
    return matchesSelector(this, selector);
  }

  querySelectorAll(selector) {
    return descendantsOf(this).filter((element) => matchesSelector(element, selector));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  get textContent() {
    return this._textContent;
  }

  set textContent(value) {
    this._textContent = String(value);
  }

  appendChild(child) {
    child.parent = this;
    child.ownerDocument ??= this.ownerDocument;
    for (const node of descendantsOf(child)) node.ownerDocument ??= this.ownerDocument;
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

  const allElements = () => [document.body, ...descendantsOf(document.body)];

  document.querySelectorAll = (selector) =>
    allElements().filter((element) => matchesSelector(element, selector));
  document.querySelector = (selector) => document.querySelectorAll(selector)[0] ?? null;

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
        callback?.(world.respondToMessage(message));
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
    // What the background answers; route registrations succeed by default.
    respondToMessage: (message) =>
      message.type === 'aiStudio.routeRegistered' ? { ok: true } : undefined,
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

const el = (tag, attributes = {}, children = []) => {
  const element = tag === 'textarea'
    ? new FakeHTMLTextAreaElement(attributes)
    : new FakeElement(tag, attributes);
  for (const child of children) element.appendChild(child);
  return element;
};
export { el as fakeElement };

// Mirrors the current ChatGPT DOM: a ProseMirror editor with
// data-composer-markdown/role=textbox inside data-composer-* wrappers, and the
// send button in the same composer form (outside the rich-text layout).
const buildProseMirrorComposer = () => {
  const composer = el('div', {
    contenteditable: 'true',
    'aria-multiline': 'true',
    role: 'textbox',
    class: 'ProseMirror',
    'data-composer-markdown': '',
    'aria-label': '询问 ChatGPT',
    translate: 'no',
  });
  const sendButton = el('button', {
    'data-testid': 'send-button',
    'aria-label': '发送提示',
    class: 'composer-submit-btn',
  });
  const form = el('form', { class: 'group/composer', 'data-type': 'unified-composer' }, [
    el('div', { 'data-composer-layout-root': '', class: 'ComposerLayoutRoot' }, [
      el('div', { 'data-composer-body': '' }, [
        el('div', { 'data-composer-input-layout': '' }, [
          el('div', { 'data-rich-text-layout': '' }, [composer]),
        ]),
      ]),
      el('div', { 'data-composer-trailing': '' }, [sendButton]),
    ]),
  ]);
  return { root: form, composer, sendButton };
};

// Builds a ChatGPT-like page — a composer (textarea, Lexical-style or
// ProseMirror contenteditable) plus a send button — then executes the real
// content script against it. `decorate(world)` may add extra DOM first.
export const setupPage = ({ composer = 'textarea', execCommand, routeId, decorate } = {}) => {
  const world = createWorld({ execCommand });

  let root;
  let composerElement;
  let sendButton;
  if (composer === 'prosemirror') {
    ({ root, composer: composerElement, sendButton } = buildProseMirrorComposer());
  } else {
    composerElement = composer === 'textarea'
      ? new FakeHTMLTextAreaElement({ id: 'prompt-textarea' })
      : new FakeElement('div', { contenteditable: 'true', 'data-lexical-editor': 'true' });
    sendButton = new FakeElement('button', { 'data-testid': 'send-button' });
    root = el('div', {}, [composerElement, el('div', {}, [sendButton])]);
  }

  root.ownerDocument = world.document;
  world.document.body.appendChild(root);
  world.composer = composerElement;
  world.sendButton = sendButton;
  world.composerRoot = root;
  world.isTextarea = composer === 'textarea';

  if (routeId) world.setFixedRoute(routeId);
  else world.setFixedRoute('11111111-2222-3333-4444-555555555555');

  decorate?.(world);
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

// Delivers any background → content message and resolves with the
// content script's response (sync or async).
export const sendToContent = (world, message) =>
  new Promise((resolve) => {
    for (const listener of world.messageListeners) {
      const async = listener(message, {}, resolve);
      if (async === true) return;
    }
    resolve(undefined);
  });

export const withPage = async (options, run) => {
  const world = setupPage(options);
  try {
    await run(world);
  } finally {
    world.restoreGlobals();
  }
};
