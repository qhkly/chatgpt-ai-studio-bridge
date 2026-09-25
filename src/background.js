import {
  DEFAULT_BRIDGE_URL,
  buildCompletionPrompt,
  buildRemoteWebSocketUrl,
  eventKey,
  isTaskCompletedEvent,
} from './protocol.js';

const BOUND_TAB_KEY = 'boundChatTab';
const REMOTE_SETTINGS_KEY = 'remoteRelay';
const RECENT_EVENTS_KEY = 'recentEventIds';
const RECONNECT_MS = 3000;
const PING_MS = 20000;
const MAX_RECENT_EVENTS = 100;

let localSocket = null;
let remoteSocket = null;
let localReconnectTimer = null;
let remoteReconnectTimer = null;
let localPingTimer = null;
let remotePingTimer = null;

const setBadge = async (text) => {
  await chrome.action.setBadgeText({ text });
};

const isChatGptUrl = (url = '') => url.startsWith('https://chatgpt.com/');

const bindTab = async (tab) => {
  if (!tab?.id || !isChatGptUrl(tab.url)) {
    await setBadge('!');
    return;
  }

  await chrome.storage.local.set({
    [BOUND_TAB_KEY]: {
      tabId: tab.id,
      url: tab.url,
    },
  });

  await setBadge('ON');
};

const findBoundTab = async () => {
  const stored = await chrome.storage.local.get(BOUND_TAB_KEY);
  const binding = stored[BOUND_TAB_KEY];

  if (!binding) return null;

  if (binding.tabId) {
    try {
      const tab = await chrome.tabs.get(binding.tabId);
      if (tab?.id && isChatGptUrl(tab.url)) return tab;
    } catch {
      // Fall back to the stored conversation URL.
    }
  }

  if (!binding.url) return null;

  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  const exact = tabs.find((tab) => tab.url === binding.url);
  if (!exact?.id) return null;

  await chrome.storage.local.set({
    [BOUND_TAB_KEY]: {
      tabId: exact.id,
      url: exact.url,
    },
  });

  return exact;
};

const deliverCompletion = async (event) => {
  const tab = await findBoundTab();

  if (!tab?.id) {
    await setBadge('!');
    return false;
  }

  try {
    const result = await chrome.tabs.sendMessage(tab.id, {
      type: 'aiStudio.taskCompleted',
      prompt: buildCompletionPrompt(event),
      event,
    });
    return result?.ok === true;
  } catch (error) {
    console.error('[AI Studio Bridge] Failed to deliver completion event', error);
    return false;
  }
};

const hasDelivered = async (key) => {
  const stored = await chrome.storage.local.get(RECENT_EVENTS_KEY);
  const recent = stored[RECENT_EVENTS_KEY] ?? [];
  return recent.includes(key);
};

const markDelivered = async (key) => {
  const stored = await chrome.storage.local.get(RECENT_EVENTS_KEY);
  const recent = stored[RECENT_EVENTS_KEY] ?? [];
  const next = [key, ...recent.filter((value) => value !== key)]
    .slice(0, MAX_RECENT_EVENTS);

  await chrome.storage.local.set({ [RECENT_EVENTS_KEY]: next });
};

const ackRemote = (event) => {
  if (
    typeof event.eventId !== 'string' ||
    !event.eventId ||
    remoteSocket?.readyState !== WebSocket.OPEN
  ) {
    return;
  }

  remoteSocket.send(JSON.stringify({
    type: 'ack',
    eventId: event.eventId,
  }));
};

const handleCompletion = async (event, source) => {
  if (!isTaskCompletedEvent(event)) return;

  const key = eventKey(event);
  if (await hasDelivered(key)) {
    if (source === 'remote') ackRemote(event);
    return;
  }

  const delivered = await deliverCompletion(event);
  if (!delivered) return;

  await markDelivered(key);
  if (source === 'remote') ackRemote(event);
};

const parseBridgeMessage = async (raw, source) => {
  let event;

  try {
    event = JSON.parse(raw);
  } catch {
    return;
  }

  if (event?.type === 'hello' || event?.type === 'pong') return;
  await handleCompletion(event, source);
};

const clearTimer = (timer) => {
  if (timer) clearTimeout(timer);
};

const startPing = (kind) => {
  const socket = kind === 'local' ? localSocket : remoteSocket;
  const existing = kind === 'local' ? localPingTimer : remotePingTimer;

  if (existing) clearInterval(existing);

  const timer = setInterval(() => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'ping' }));
    }
  }, PING_MS);

  if (kind === 'local') localPingTimer = timer;
  else remotePingTimer = timer;
};

const scheduleLocalReconnect = () => {
  if (localReconnectTimer) return;

  localReconnectTimer = setTimeout(() => {
    localReconnectTimer = null;
    connectLocalBridge();
  }, RECONNECT_MS);
};

const connectLocalBridge = () => {
  if (
    localSocket?.readyState === WebSocket.OPEN ||
    localSocket?.readyState === WebSocket.CONNECTING
  ) {
    return;
  }

  localSocket = new WebSocket(DEFAULT_BRIDGE_URL);

  localSocket.addEventListener('open', () => startPing('local'));
  localSocket.addEventListener('message', (message) => {
    parseBridgeMessage(message.data, 'local').catch(console.error);
  });
  localSocket.addEventListener('close', () => {
    if (localPingTimer) clearInterval(localPingTimer);
    localPingTimer = null;
    localSocket = null;
    scheduleLocalReconnect();
  });
  localSocket.addEventListener('error', () => localSocket?.close());
};

const getRemoteSettings = async () => {
  const stored = await chrome.storage.local.get(REMOTE_SETTINGS_KEY);
  return stored[REMOTE_SETTINGS_KEY] ?? {
    enabled: false,
    url: '',
    token: '',
  };
};

const scheduleRemoteReconnect = () => {
  if (remoteReconnectTimer) return;

  remoteReconnectTimer = setTimeout(() => {
    remoteReconnectTimer = null;
    connectRemoteBridge();
  }, RECONNECT_MS);
};

const connectRemoteBridge = async () => {
  if (
    remoteSocket?.readyState === WebSocket.OPEN ||
    remoteSocket?.readyState === WebSocket.CONNECTING
  ) {
    return;
  }

  const settings = await getRemoteSettings();
  if (!settings.enabled || !settings.url || !settings.token) return;

  let url;
  try {
    url = buildRemoteWebSocketUrl(settings.url, settings.token);
  } catch (error) {
    console.error('[AI Studio Bridge] Invalid remote relay URL', error);
    return;
  }

  remoteSocket = new WebSocket(url);

  remoteSocket.addEventListener('open', () => startPing('remote'));
  remoteSocket.addEventListener('message', (message) => {
    parseBridgeMessage(message.data, 'remote').catch(console.error);
  });
  remoteSocket.addEventListener('close', () => {
    if (remotePingTimer) clearInterval(remotePingTimer);
    remotePingTimer = null;
    remoteSocket = null;
    scheduleRemoteReconnect();
  });
  remoteSocket.addEventListener('error', () => remoteSocket?.close());
};

const restartRemoteBridge = () => {
  clearTimer(remoteReconnectTimer);
  remoteReconnectTimer = null;

  if (remotePingTimer) clearInterval(remotePingTimer);
  remotePingTimer = null;

  const socket = remoteSocket;
  remoteSocket = null;
  socket?.close();

  connectRemoteBridge().catch(console.error);
};

chrome.action.onClicked.addListener((tab) => {
  bindTab(tab).catch((error) => {
    console.error('[AI Studio Bridge] Failed to bind tab', error);
  });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const stored = await chrome.storage.local.get(BOUND_TAB_KEY);
  const binding = stored[BOUND_TAB_KEY];

  if (binding?.tabId === tabId) {
    await chrome.storage.local.set({
      [BOUND_TAB_KEY]: {
        tabId: null,
        url: binding.url,
      },
    });
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes[REMOTE_SETTINGS_KEY]) {
    restartRemoteBridge();
  }
});

chrome.runtime.onInstalled.addListener(() => {
  setBadge('').catch(() => {});
  connectLocalBridge();
  connectRemoteBridge().catch(console.error);
});

chrome.runtime.onStartup.addListener(() => {
  connectLocalBridge();
  connectRemoteBridge().catch(console.error);
});

connectLocalBridge();
connectRemoteBridge().catch(console.error);
