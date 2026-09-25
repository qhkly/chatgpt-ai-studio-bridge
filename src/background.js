import {
  DEFAULT_BRIDGE_URL,
  buildCompletionPrompt,
  isTaskCompletedEvent,
} from './protocol.js';

const STORAGE_KEY = 'boundChatTab';
const RECONNECT_MS = 3000;
const PING_MS = 20000;

let socket = null;
let reconnectTimer = null;
let pingTimer = null;

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
    [STORAGE_KEY]: {
      tabId: tab.id,
      url: tab.url,
    },
  });

  await setBadge('ON');
};

const findBoundTab = async () => {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const binding = stored[STORAGE_KEY];

  if (!binding) return null;

  if (binding.tabId) {
    try {
      const tab = await chrome.tabs.get(binding.tabId);
      if (tab?.id && isChatGptUrl(tab.url)) return tab;
    } catch {
      // The original tab may have been closed. Fall back to its conversation URL.
    }
  }

  if (!binding.url) return null;

  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  const exact = tabs.find((tab) => tab.url === binding.url);
  if (!exact?.id) return null;

  await chrome.storage.local.set({
    [STORAGE_KEY]: {
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
    return;
  }

  await chrome.tabs.sendMessage(tab.id, {
    type: 'aiStudio.taskCompleted',
    prompt: buildCompletionPrompt(event),
    event,
  });
};

const scheduleReconnect = () => {
  if (reconnectTimer) return;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectBridge();
  }, RECONNECT_MS);
};

const startPing = () => {
  if (pingTimer) clearInterval(pingTimer);

  pingTimer = setInterval(() => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'ping' }));
    }
  }, PING_MS);
};

const handleBridgeMessage = async (raw) => {
  let event;

  try {
    event = JSON.parse(raw);
  } catch {
    return;
  }

  if (!isTaskCompletedEvent(event)) return;

  try {
    await deliverCompletion(event);
  } catch (error) {
    console.error('[AI Studio Bridge] Failed to deliver completion event', error);
  }
};

const connectBridge = () => {
  if (
    socket?.readyState === WebSocket.OPEN ||
    socket?.readyState === WebSocket.CONNECTING
  ) {
    return;
  }

  socket = new WebSocket(DEFAULT_BRIDGE_URL);

  socket.addEventListener('open', () => {
    startPing();
  });

  socket.addEventListener('message', (message) => {
    handleBridgeMessage(message.data);
  });

  socket.addEventListener('close', () => {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    socket = null;
    scheduleReconnect();
  });

  socket.addEventListener('error', () => {
    socket?.close();
  });
};

chrome.action.onClicked.addListener((tab) => {
  bindTab(tab).catch((error) => {
    console.error('[AI Studio Bridge] Failed to bind tab', error);
  });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const binding = stored[STORAGE_KEY];

  if (binding?.tabId === tabId) {
    await chrome.storage.local.set({
      [STORAGE_KEY]: {
        tabId: null,
        url: binding.url,
      },
    });
  }
});

chrome.runtime.onInstalled.addListener(() => {
  setBadge('').catch(() => {});
  connectBridge();
});

chrome.runtime.onStartup.addListener(() => {
  connectBridge();
});

connectBridge();
