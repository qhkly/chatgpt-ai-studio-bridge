import { createBadgeState } from './badge.js';
import {
  DEFAULT_BRIDGE_URL,
  buildCompletionPrompt,
  buildRemoteWebSocketUrl,
  eventKey,
  isTaskCompletedEvent,
  routeIdFromRequestId,
} from './protocol.js';
import {
  buildStatusSnapshot,
  findTabRouteBinding,
  normalizeInjectionOutcome,
  normalizeRedetectResult,
} from './status.js';

const REMOTE_SETTINGS_KEY = 'remoteRelay';
const RECENT_EVENTS_KEY = 'recentEventIds';
const ROUTE_BINDINGS_KEY = 'routeBindings';
const RECONNECT_MS = 3000;
const PING_MS = 20000;
const MAX_RECENT_EVENTS = 100;
const MAX_ROUTE_BINDINGS = 300;
const ROUTE_TTL_MS = 24 * 60 * 60 * 1000;
// Popup status lives in chrome.storage.session: it survives service-worker
// restarts but not a browser restart, and content scripts cannot read it.
const INJECTION_OUTCOMES_KEY = 'injectionOutcomes';
const LAST_DELIVERY_KEY = 'lastDelivery';
const LAST_REDETECTS_KEY = 'lastRedetects';

let localSocket = null;
let remoteSocket = null;
let localReconnectTimer = null;
let remoteReconnectTimer = null;
let localPingTimer = null;
let remotePingTimer = null;
let deliveryQueue = Promise.resolve();
const pendingRouteIds = new Set();
let localBridgeSince = null;
let sessionWrites = Promise.resolve();

// "ON" only ever claims route registration. A send-injection failure latches
// "!" until an injection succeeds again, even across re-registrations.
const badgeState = createBadgeState();

const setBadge = async (text) => {
  await chrome.action.setBadgeText({ text });
};

const isChatGptUrl = (url = '') => url.startsWith('https://chatgpt.com/');

// Serialized read-modify-write so concurrent reports never drop each other,
// and so a status read observes every report received before it.
const updateSession = (key, update) => {
  sessionWrites = sessionWrites
    .then(async () => {
      const stored = await chrome.storage.session.get(key);
      await chrome.storage.session.set({ [key]: update(stored[key]) });
    })
    .catch((error) => {
      console.error('[AI Studio Bridge] Failed to update status', error);
    });
  return sessionWrites;
};

const readSession = async (key) => {
  await sessionWrites;
  const stored = await chrome.storage.session.get(key);
  return stored[key];
};

const recordInjectionOutcome = (tabId, outcome) =>
  updateSession(INJECTION_OUTCOMES_KEY, (current) => ({
    ...(current ?? {}),
    [tabId]: outcome,
  }));

const recordRedetect = (tabId, record) =>
  updateSession(LAST_REDETECTS_KEY, (current) => ({
    ...(current ?? {}),
    [tabId]: record,
  }));

const recordDelivery = (outcome, routeId) =>
  updateSession(LAST_DELIVERY_KEY, () => ({
    outcome,
    routeId,
    at: Date.now(),
  }));

const getRouteBindings = async () => {
  const stored = await chrome.storage.local.get(ROUTE_BINDINGS_KEY);
  return stored[ROUTE_BINDINGS_KEY] ?? {};
};

const saveRouteBinding = async (routeId, tabId) => {
  if (!routeId || !Number.isInteger(tabId) || tabId < 0) return;

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return;
  }
  if (!tab?.id || !isChatGptUrl(tab.url)) return;

  const now = Date.now();
  const bindings = await getRouteBindings();
  const fresh = Object.entries(bindings)
    .filter(([, value]) => value && now - Number(value.at || 0) <= ROUTE_TTL_MS)
    .sort((a, b) => Number(b[1].at || 0) - Number(a[1].at || 0))
    .slice(0, MAX_ROUTE_BINDINGS - 1);

  const next = Object.fromEntries(fresh);
  next[routeId] = {
    tabId: tab.id,
    url: tab.url,
    at: now,
  };

  await chrome.storage.local.set({ [ROUTE_BINDINGS_KEY]: next });
  await setBadge(badgeState.onRouteRegistered());

  // Recycle the relay only when an unmatched completion is actually waiting
  // for this exact route. Normal ChatGPT traffic must not churn the socket.
  if (
    pendingRouteIds.delete(routeId) &&
    remoteSocket?.readyState === WebSocket.OPEN
  ) {
    remoteSocket.close();
  }
};

const findTabForRoute = async (routeId) => {
  if (typeof routeId !== 'string' || !routeId.trim()) return null;

  const bindings = await getRouteBindings();
  const binding = bindings[routeId.trim().toLowerCase()];
  if (!binding) return null;
  if (Date.now() - Number(binding.at || 0) > ROUTE_TTL_MS) return null;

  if (binding.tabId) {
    try {
      const tab = await chrome.tabs.get(binding.tabId);
      if (tab?.id && isChatGptUrl(tab.url)) return tab;
    } catch {
      // Fall back to the exact stored conversation URL.
    }
  }

  if (!binding.url) return null;
  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  const exact = tabs.find((tab) => tab.url === binding.url);
  if (!exact?.id) return null;

  await saveRouteBinding(routeId.trim().toLowerCase(), exact.id);
  return exact;
};

const ensureContentScript = async (tabId) => {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'aiStudio.ping' });
    if (pong?.ok === true) return true;
  } catch {
    // The extension may have been reloaded while this ChatGPT tab stayed open.
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/content.js'],
    });
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'aiStudio.ping' });
    return pong?.ok === true;
  } catch (error) {
    console.error('[AI Studio Bridge] Failed to ensure content script', error);
    return false;
  }
};

const deliverCompletion = async (event) => {
  const tab = await findTabForRoute(event.routeId);

  if (!tab?.id) {
    console.warn('[AI Studio Bridge] No ChatGPT tab matches route', event.routeId);
    await recordDelivery('unmatched', event.routeId);
    await setBadge('!');
    return 'unmatched';
  }

  if (!(await ensureContentScript(tab.id))) {
    await recordDelivery('content-script-unavailable', event.routeId);
    await setBadge('!');
    return 'failed';
  }

  let outcome;
  try {
    const result = await chrome.tabs.sendMessage(tab.id, {
      type: 'aiStudio.taskCompleted',
      prompt: buildCompletionPrompt(event),
      event,
    });
    outcome = result?.ok === true ? 'delivered' : 'failed';
  } catch (error) {
    console.error('[AI Studio Bridge] Failed to deliver completion event', error);
    outcome = 'failed';
  }
  await recordDelivery(outcome, event.routeId);
  return outcome;
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

  // Fail closed: legacy/unrouted completion events must never be guessed into
  // the globally bound ChatGPT tab. Until the producer supplies a routeId,
  // drop the event. Remote events are ACKed so the relay does not replay them
  // forever and accidentally inject them after another tab becomes active.
  if (typeof event.routeId !== 'string' || !event.routeId.trim()) {
    console.warn('[AI Studio Bridge] Dropping unrouted completion event', event.eventId || event.sessionId);
    if (source === 'remote') ackRemote(event);
    return;
  }

  const key = eventKey(event);
  if (await hasDelivered(key)) {
    if (source === 'remote') ackRemote(event);
    return;
  }

  const outcome = await deliverCompletion(event);
  if (outcome === 'unmatched') {
    // Leave a remote event unacked in the relay. When this exact route is
    // later observed, saveRouteBinding recycles the socket and replay resumes.
    if (source === 'remote') {
      pendingRouteIds.add(event.routeId.trim().toLowerCase());
    }
    return;
  }
  if (outcome !== 'delivered') {
    if (source === 'remote' && remoteSocket?.readyState === WebSocket.OPEN) {
      remoteSocket.close();
    }
    return;
  }

  pendingRouteIds.delete(event.routeId.trim().toLowerCase());
  await markDelivered(key);
  if (source === 'remote') ackRemote(event);
};

const enqueueCompletion = (event, source) => {
  deliveryQueue = deliveryQueue
    .then(() => handleCompletion(event, source))
    .catch((error) => {
      console.error('[AI Studio Bridge] Completion queue failed', error);
    });
  return deliveryQueue;
};

const provisionRemoteRelay = async (remoteRelay) => {
  if (
    !remoteRelay ||
    typeof remoteRelay.url !== 'string' ||
    !remoteRelay.url ||
    typeof remoteRelay.token !== 'string' ||
    !remoteRelay.token
  ) {
    return;
  }

  const next = {
    enabled: true,
    url: remoteRelay.url,
    token: remoteRelay.token,
  };
  const current = await getRemoteSettings();

  if (
    current.enabled === next.enabled &&
    current.url === next.url &&
    current.token === next.token
  ) {
    return;
  }

  await chrome.storage.local.set({
    [REMOTE_SETTINGS_KEY]: next,
  });
};

const parseBridgeMessage = async (raw, source) => {
  let event;

  try {
    event = JSON.parse(raw);
  } catch {
    return;
  }

  if (event?.type === 'hello') {
    if (source === 'local') {
      await provisionRemoteRelay(event.remoteRelay);
    }
    return;
  }
  if (event?.type === 'pong') return;
  if (event?.type === 'extension.reload') {
    // AI Studio swapped the unpacked extension directory; pick it up without a
    // manual reload on chrome://extensions. Reload unconditionally on local
    // broadcasts — the upgrade identity is the GitHub Release behind the swap,
    // not the manifest version.
    if (source === 'local') {
      chrome.runtime.reload();
    }
    return;
  }

  await enqueueCompletion(event, source);
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

  localSocket.addEventListener('open', () => {
    localBridgeSince = Date.now();
    startPing('local');
  });
  localSocket.addEventListener('message', (message) => {
    parseBridgeMessage(message.data, 'local').catch(console.error);
  });
  localSocket.addEventListener('close', () => {
    localBridgeSince = null;
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


const socketState = (socket) => {
  if (socket?.readyState === WebSocket.OPEN) return 'connected';
  if (socket?.readyState === WebSocket.CONNECTING) return 'connecting';
  return 'disconnected';
};

const getTabOrNull = async (tabId) => {
  if (!Number.isInteger(tabId) || tabId < 0) return null;
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
};

// Real state only: socket readyState, the exact routeBindings entry for this
// tab, and the last injection report the tab's content script sent. The
// badge text is included for diagnostics but never used to derive status.
const getStatusSnapshot = async (tabId) => {
  const now = Date.now();
  const tab = await getTabOrNull(tabId);
  const [bindings, outcomes, lastDelivery, redetects, remote, badge] = await Promise.all([
    getRouteBindings(),
    readSession(INJECTION_OUTCOMES_KEY),
    readSession(LAST_DELIVERY_KEY),
    readSession(LAST_REDETECTS_KEY),
    getRemoteSettings(),
    chrome.action.getBadgeText({}).catch(() => ''),
  ]);

  return buildStatusSnapshot({
    version: chrome.runtime.getManifest().version,
    now,
    localBridge: {
      state: socketState(localSocket),
      since: localBridgeSince,
    },
    remoteRelay: {
      enabled: Boolean(remote.enabled && remote.url && remote.token),
      connected: socketState(remoteSocket) === 'connected',
    },
    tab,
    routeBinding: findTabRouteBinding(bindings, tab, now, ROUTE_TTL_MS),
    injection: tab ? outcomes?.[tab.id] ?? null : null,
    lastDelivery: lastDelivery ?? null,
    lastRedetect: tab ? redetects?.[tab.id] ?? null : null,
    badge,
  });
};

// Replaces the old action.onClicked re-registration (a default_popup
// suppresses onClicked). Re-registers the tab's route and asks the page for a
// non-destructive injection probe; the probe's own outcome is recorded here
// too so the popup's next snapshot cannot race the content-script report.
// Every result on a ChatGPT tab, including a skipped probe, is kept as the
// tab's lastRedetect so diagnostics can say why injection is unverified.
const redetectTab = async (tabId) => {
  const tab = await getTabOrNull(tabId);
  if (!tab) return { ok: false, reason: 'tab-not-found' };
  if (!isChatGptUrl(tab.url)) return { ok: false, reason: 'not-chatgpt' };

  const { result, routeId } = await runRedetect(tab);
  await recordRedetect(
    tab.id,
    normalizeRedetectResult(result, routeId, tab.url, Date.now()),
  );
  return result;
};

const runRedetect = async (tab) => {
  if (!(await ensureContentScript(tab.id))) {
    return { result: { ok: false, reason: 'content-script-unavailable' } };
  }

  let response;
  try {
    response = await chrome.tabs.sendMessage(tab.id, {
      type: 'aiStudio.requestRouteRegistration',
      probe: true,
    });
  } catch (error) {
    console.error('[AI Studio Bridge] Failed to request route registration', error);
    return { result: { ok: false, reason: 'registration-request-failed' } };
  }

  const probe = response?.probe;
  if (probe?.outcome) {
    await recordInjectionOutcome(
      tab.id,
      normalizeInjectionOutcome(probe.outcome, tab.url, Date.now()),
    );
  }

  return {
    routeId: response?.routeId ?? null,
    result: {
      ok: response?.ok === true,
      reason: response?.ok === true ? null : 'registration-failed',
      probe: probe
        ? { status: String(probe.status), detail: probe.detail ?? null }
        : { status: 'unsupported', detail: null },
    },
  };
};

const respondAsync = (promise, sendResponse, fallback) => {
  promise
    .then(sendResponse)
    .catch((error) => {
      console.error('[AI Studio Bridge] Popup request failed', error);
      sendResponse(fallback);
    });
  return true;
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Popup requests come from the extension page itself, never from a tab.
  if (message?.type === 'aiStudio.popup.getStatus' && !sender.tab) {
    return respondAsync(getStatusSnapshot(message.tabId), sendResponse, null);
  }

  if (message?.type === 'aiStudio.popup.redetect' && !sender.tab) {
    return respondAsync(
      redetectTab(message.tabId),
      sendResponse,
      { ok: false, reason: 'internal-error' },
    );
  }

  if (message?.type === 'aiStudio.routeInjectOutcome') {
    const tabId = sender.tab?.id;
    if (!Number.isInteger(tabId) || tabId < 0) {
      sendResponse({ ok: false });
      return false;
    }
    recordInjectionOutcome(
      tabId,
      normalizeInjectionOutcome(message, sender.tab.url, Date.now()),
    ).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message?.type === 'aiStudio.routeInjectFailed') {
    console.warn(
      '[AI Studio Bridge] Route marker injection failed',
      { routeId: message.routeId, detail: message.detail, url: message.url },
    );
    setBadge(badgeState.onInjectFailed()).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === 'aiStudio.routeInjectRecovered') {
    console.info(
      '[AI Studio Bridge] Route marker injection recovered',
      { routeId: message.routeId, url: message.url },
    );
    setBadge(badgeState.onInjectRecovered()).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type !== 'aiStudio.routeRegistered') return undefined;

  const routeId = routeIdFromRequestId(message.routeId);
  const tabId = sender.tab?.id;
  if (!routeId || !Number.isInteger(tabId) || tabId < 0) {
    sendResponse({ ok: false });
    return false;
  }

  saveRouteBinding(routeId, tabId)
    .then(() => sendResponse({ ok: true }))
    .catch((error) => {
      console.error('[AI Studio Bridge] Failed to register ChatGPT route', error);
      sendResponse({ ok: false });
    });
  return true;
});

// Declared content scripts only reach pages loaded after install/update.
// Inject into ChatGPT tabs that were already open so they register their
// route without a reload or a manual click.
const registerOpenChatGptTabs = async () => {
  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  await Promise.all(
    tabs
      .filter((tab) => Number.isInteger(tab.id))
      .map((tab) => ensureContentScript(tab.id)),
  );
};

chrome.tabs.onRemoved.addListener(async (tabId) => {
  for (const key of [INJECTION_OUTCOMES_KEY, LAST_REDETECTS_KEY]) {
    updateSession(key, (current) => {
      const next = { ...(current ?? {}) };
      delete next[tabId];
      return next;
    });
  }

  const stored = await chrome.storage.local.get(ROUTE_BINDINGS_KEY);
  const routes = stored[ROUTE_BINDINGS_KEY] ?? {};
  let changed = false;

  for (const value of Object.values(routes)) {
    if (value?.tabId === tabId) {
      value.tabId = null;
      changed = true;
    }
  }

  if (changed) {
    await chrome.storage.local.set({ [ROUTE_BINDINGS_KEY]: routes });
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
  registerOpenChatGptTabs().catch(console.error);
});

chrome.runtime.onStartup.addListener(() => {
  connectLocalBridge();
  connectRemoteBridge().catch(console.error);
});

connectLocalBridge();
connectRemoteBridge().catch(console.error);
