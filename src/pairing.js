// "连接远程 AI Studio" pairing: trade a one-time 6-digit code shown in AI
// Studio for a per-device relay token. Everything here is pure (fetch is
// injected) so the claim contract can be tested without a browser.
//
// The device token only ever lives in the service worker and
// chrome.storage.local. Nothing returned from here to the popup, and nothing
// logged, carries it.

import { DEFAULT_REMOTE_RELAY_URL, buildRemoteWebSocketUrl } from './protocol.js';

export const PAIRING_CODE_LENGTH = 6;
export const PAIRING_TIMEOUT_MS = 15000;
const DEVICE_LABEL_MAX = 60;

// Accepts "123 456", "123-456", full-width digits and stray whitespace;
// returns exactly six ASCII digits or null.
export const normalizePairingCode = (input) => {
  if (typeof input !== 'string') return null;
  const ascii = input.replace(/[０-９]/g, (digit) =>
    String.fromCharCode(digit.charCodeAt(0) - 0xfee0));
  const compact = ascii.replace(/[\s\-_.·]/g, '');
  return new RegExp('^\\d{' + PAIRING_CODE_LENGTH + '}$').test(compact) ? compact : null;
};

const BROWSERS = [
  [/Edg\//, 'Edge'],
  [/OPR\//, 'Opera'],
  [/Chrome\//, 'Chrome'],
];

const PLATFORMS = [
  [/Mac/i, 'macOS'],
  [/Win/i, 'Windows'],
  [/CrOS|Chrome OS/i, 'ChromeOS'],
  [/Android/i, 'Android'],
  [/Linux/i, 'Linux'],
];

// Short human label shown in AI Studio's device list, e.g. "Chrome · macOS".
// Built only from coarse browser/OS names — no hostname, user or version.
export const buildDeviceLabel = (nav = globalThis.navigator) => {
  const ua = String(nav?.userAgent ?? '');
  const brands = (nav?.userAgentData?.brands ?? []).map((brand) => brand.brand).join(' ');
  const platformHint = String(nav?.userAgentData?.platform || nav?.platform || ua);

  const browser = /Edge/.test(brands) ? 'Edge'
    : /Opera/.test(brands) ? 'Opera'
    : BROWSERS.find(([pattern]) => pattern.test(ua))?.[1] ?? 'Chrome';
  const platform = PLATFORMS.find(([pattern]) => pattern.test(platformHint))?.[1] ?? '';

  return (platform ? browser + ' · ' + platform : browser).slice(0, DEVICE_LABEL_MAX);
};

const isUsableRelayUrl = (value) => {
  if (typeof value !== 'string' || !value) return false;
  try {
    buildRemoteWebSocketUrl(value, 'probe');
    return true;
  } catch {
    return false;
  }
};

const readErrorCode = async (response) => {
  try {
    const body = await response.json();
    return String(body?.error ?? body?.code ?? '').toLowerCase();
  } catch {
    return '';
  }
};

const reasonForStatus = (status, errorCode) => {
  if (/expire/.test(errorCode)) return 'code-expired';
  if (/used|claimed|consumed/.test(errorCode)) return 'code-used';
  if (status === 410) return 'code-expired';
  if (status === 409) return 'code-used';
  if ([400, 401, 403, 404, 422].includes(status)) return 'code-invalid';
  if (status === 429) return 'rate-limited';
  return 'server-error';
};

// POST {relayBase}/v1/pairings/claim. Resolves to
//   { ok: true, settings: { enabled, url, token, deviceId? } }
// or { ok: false, reason }. Never throws, never logs the response body.
export const claimPairing = async ({
  code,
  relayBase = DEFAULT_REMOTE_RELAY_URL,
  deviceLabel = buildDeviceLabel(),
  fetchImpl = globalThis.fetch,
  timeoutMs = PAIRING_TIMEOUT_MS,
} = {}) => {
  const normalized = normalizePairingCode(code);
  if (!normalized) return { ok: false, reason: 'invalid-format' };

  let endpoint;
  try {
    endpoint = new URL('v1/pairings/claim', String(relayBase).replace(/\/?$/, '/'));
  } catch {
    return { ok: false, reason: 'server-error' };
  }

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  let response;
  try {
    response = await fetchImpl(endpoint.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: normalized, deviceLabel }),
      signal: controller?.signal,
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch {
    return { ok: false, reason: 'network' };
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!response?.ok) {
    return {
      ok: false,
      reason: reasonForStatus(Number(response?.status), await readErrorCode(response)),
    };
  }

  let body;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: 'bad-response' };
  }

  const { deviceId, deviceToken, relayUrl } = body ?? {};
  if (typeof deviceToken !== 'string' || !deviceToken || !isUsableRelayUrl(relayUrl)) {
    return { ok: false, reason: 'bad-response' };
  }

  // paired marks a per-device token, which a relay revocation may discard.
  const settings = { enabled: true, url: relayUrl, token: deviceToken, paired: true };
  if (typeof deviceId === 'string' && deviceId) settings.deviceId = deviceId;
  return { ok: true, settings };
};

const PAIRING_ERRORS = {
  'invalid-format': '请输入 AI Studio 显示的 6 位数字配对码',
  'code-expired': '配对码已过期，请在 AI Studio 重新生成',
  'code-used': '配对码已被使用，请在 AI Studio 重新生成',
  'code-invalid': '配对码无效或已过期，请核对后重试，或在 AI Studio 重新生成',
  'rate-limited': '尝试次数过多，请稍后再试',
  network: '无法连接远程服务，请检查网络后重试',
  'bad-response': '远程服务返回异常，请稍后重试',
  'server-error': '远程服务暂时不可用，请稍后重试',
  'internal-error': '配对出错，请重试',
};

export const describePairingError = (reason) =>
  PAIRING_ERRORS[reason] ?? PAIRING_ERRORS['internal-error'];

// Popup-facing remote state, derived only from the token-free snapshot.
export const describeRemote = (snapshot) => {
  const remote = snapshot?.remoteRelay ?? {};
  const localConnected = snapshot?.localBridge?.state === 'connected';

  if (!remote.enabled) {
    return {
      state: 'off',
      // Offer pairing only when this machine has no local bridge to fall
      // back on; same-machine setups keep using localhost.
      // A bridge stuck cycling through "connecting" counts as absent.
      offerPairing: !localConnected,
      text: '',
    };
  }
  return {
    state: remote.connected ? 'connected' : 'connecting',
    offerPairing: false,
    text: remote.connected ? '远程已连接' : '远程连接中…',
  };
};
