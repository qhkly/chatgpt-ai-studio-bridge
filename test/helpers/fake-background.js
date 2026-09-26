// Minimal fake extension runtime good enough to execute src/background.js
// inside node --test: chrome.* storage/tabs/action/runtime plus a WebSocket
// whose lifecycle the test drives by hand. Timers never fire, so reconnect
// and ping loops cannot keep the test process alive.

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this._listeners = {};
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, listener) {
    (this._listeners[type] ??= []).push(listener);
  }

  _fire(type, event = {}) {
    for (const listener of this._listeners[type] ?? []) listener(event);
  }

  send(data) {
    this.sent.push(data);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this._fire('open');
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this._fire('close', { code: 1005 });
  }

  // The peer closed the connection with a specific close code.
  serverClose(code) {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this._fire('close', { code });
  }
}

const createStorageArea = (initial = {}, onSet = () => {}) => {
  const data = structuredClone(initial);
  return {
    data,
    get: async (key) => {
      if (typeof key === 'string') {
        return key in data ? { [key]: structuredClone(data[key]) } : {};
      }
      return structuredClone(data);
    },
    set: async (items) => {
      const changes = Object.fromEntries(Object.keys(items).map((key) => [
        key,
        { oldValue: structuredClone(data[key]), newValue: structuredClone(items[key]) },
      ]));
      Object.assign(data, structuredClone(items));
      onSet(changes);
    },
  };
};

let importCounter = 0;

export const setupBackground = async ({
  version = '9.9.9',
  local = {},
  tabs = [],
  fetch = async () => {
    throw new TypeError('Failed to fetch');
  },
  // Deliver chrome.storage.onChanged like Chrome does. Off by default so
  // older tests keep their exact socket counts.
  emitStorageChanges = false,
} = {}) => {
  FakeWebSocket.instances = [];

  const listeners = {
    message: [],
    removed: [],
    storageChanged: [],
  };
  const tabMap = new Map(tabs.map((tab) => [tab.id, { ...tab }]));
  const world = {
    badge: '',
    tabMap,
    // tabId -> (message) => response; simulates the tab's content script.
    tabHandlers: new Map(),
    executed: [],
  };

  const chrome = {
    storage: {
      local: createStorageArea(local, (changes) => {
        if (!emitStorageChanges) return;
        for (const listener of listeners.storageChanged) listener(changes, 'local');
      }),
      session: createStorageArea(),
      onChanged: { addListener: (listener) => listeners.storageChanged.push(listener) },
    },
    tabs: {
      get: async (tabId) => {
        const tab = tabMap.get(tabId);
        if (!tab) throw new Error('No tab with id: ' + tabId);
        return { ...tab };
      },
      query: async ({ url } = {}) => [...tabMap.values()]
        .filter((tab) => !url || tab.url.startsWith(url.replace(/\*$/, '')))
        .map((tab) => ({ ...tab })),
      sendMessage: async (tabId, message) => {
        const handler = world.tabHandlers.get(tabId);
        if (!handler) throw new Error('Could not establish connection.');
        return handler(message);
      },
      onRemoved: { addListener: (listener) => listeners.removed.push(listener) },
    },
    scripting: {
      executeScript: async ({ target }) => {
        world.executed.push(target.tabId);
        throw new Error('Cannot access contents of the page');
      },
    },
    action: {
      setBadgeText: async ({ text }) => {
        world.badge = text;
      },
      getBadgeText: async () => world.badge,
    },
    runtime: {
      getManifest: () => ({ version }),
      reload() {},
      onMessage: { addListener: (listener) => listeners.message.push(listener) },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
    },
  };

  const noop = () => 0;
  // Timers never fire on their own; tests may run the pending ones by hand.
  const timers = new Map();
  let nextTimerId = 1;
  world.pendingTimers = () => timers.size;
  world.runTimers = () => {
    const pending = [...timers.values()];
    timers.clear();
    for (const callback of pending) callback();
  };
  const globals = {
    chrome,
    fetch,
    WebSocket: FakeWebSocket,
    setTimeout: (callback) => {
      const id = nextTimerId++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    setInterval: noop,
    clearInterval: noop,
  };
  const previous = Object.fromEntries(
    Object.keys(globals).map((key) => [key, globalThis[key]]),
  );
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }

  world.restoreGlobals = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    }
  };

  // A fresh module instance per world, so in-memory state never leaks
  // between tests.
  importCounter++;
  await import(new URL('../../src/background.js?world=' + importCounter, import.meta.url));

  world.chrome = chrome;
  world.sockets = FakeWebSocket.instances;
  world.localSocket = () =>
    FakeWebSocket.instances.filter((socket) => socket.url.startsWith('ws://127.0.0.1')).at(-1);

  // Dispatches a runtime message the way Chrome would and resolves with the
  // response, whether the listener answered synchronously or asynchronously.
  world.send = (message, sender = {}) =>
    new Promise((resolve) => {
      for (const listener of listeners.message) {
        const async = listener(message, sender, resolve);
        if (async === true) return;
      }
      resolve(undefined);
    });

  world.fromTab = (tabId, message) =>
    world.send(message, { tab: { ...tabMap.get(tabId) } });

  world.popup = (type, tabId) => world.send({ type, tabId });

  world.removeTab = async (tabId) => {
    tabMap.delete(tabId);
    await Promise.all(listeners.removed.map((listener) => listener(tabId)));
  };

  return world;
};
