// Status model shared by the background worker (which owns the real state)
// and the popup (which only renders it). Everything here is pure so the
// snapshot contract can be tested without a browser.
//
// The snapshot is an explicit whitelist: it is built field by field and never
// spreads stored settings, so the remote relay token cannot leak into the
// popup or the copied diagnostics.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DETAIL_MAX = 200;

const isChatGptUrl = (url = '') =>
  typeof url === 'string' && url.startsWith('https://chatgpt.com/');

const routeIdOrNull = (value) =>
  typeof value === 'string' && UUID_RE.test(value) ? value.toLowerCase() : null;

const timestampOrNull = (value) =>
  Number.isFinite(value) && value > 0 ? value : null;

// Query strings and fragments are dropped: diagnostics only need to know
// which conversation, not whatever state the page stuffed into the URL.
export const sanitizeUrl = (url) => {
  if (typeof url !== 'string' || !url) return '';
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  } catch {
    return '';
  }
};

// Exact lookup: the binding must point at this tab AND at the URL the tab is
// showing now. A route left over from a conversation this tab navigated away
// from does not count as "bound".
export const findTabRouteBinding = (bindings, tab, now, ttlMs) => {
  if (!bindings || !Number.isInteger(tab?.id) || !tab.url) return null;

  let best = null;
  for (const [routeId, value] of Object.entries(bindings)) {
    if (!value || value.tabId !== tab.id || value.url !== tab.url) continue;
    const at = Number(value.at || 0);
    if (now - at > ttlMs) continue;
    if (!best || at > best.at) best = { routeId, at };
  }
  return best;
};

// Normalizes a content-script injection report into the record the
// background keeps per tab.
export const normalizeInjectionOutcome = (message, tabUrl, now) => {
  const ok = message?.ok === true;
  const detail = ok
    ? null
    : String(message?.detail ?? 'unknown').slice(0, DETAIL_MAX);

  return {
    ok,
    routeId: routeIdOrNull(message?.routeId),
    detail,
    at: timestampOrNull(message?.at) ?? now,
    url: sanitizeUrl(tabUrl || message?.url),
    source: message?.source === 'probe' ? 'probe' : 'send',
  };
};

// Result of the popup's "重新检测当前页面", kept per tab. `status` is the probe
// status when registration succeeded (ok / failed / skipped / unsupported),
// or `error` with the failure reason as detail when it did not.
const REDETECT_STATUSES = ['ok', 'failed', 'skipped', 'unsupported', 'error'];

export const normalizeRedetectResult = (result, routeId, tabUrl, now) => {
  let status;
  let detail;
  if (result?.ok !== true) {
    status = 'error';
    detail = result?.reason ?? 'internal-error';
  } else {
    status = REDETECT_STATUSES.includes(result.probe?.status)
      ? result.probe.status
      : 'unsupported';
    detail = status === 'ok' ? null : result.probe?.detail ?? null;
  }

  return {
    status,
    detail: detail == null ? null : String(detail).slice(0, DETAIL_MAX),
    routeId: routeIdOrNull(routeId),
    at: now,
    url: sanitizeUrl(tabUrl),
  };
};

export const buildStatusSnapshot = ({
  version,
  now,
  localBridge,
  remoteRelay,
  tab,
  routeBinding,
  injection,
  lastDelivery,
  lastRedetect,
  badge,
}) => {
  const onChatGpt = isChatGptUrl(tab?.url);

  let route;
  if (!onChatGpt) route = { state: 'not-chatgpt', routeId: null, at: null };
  else if (routeBinding) {
    route = {
      state: 'bound',
      routeId: routeIdOrNull(routeBinding.routeId),
      at: timestampOrNull(routeBinding.at),
    };
  } else route = { state: 'unbound', routeId: null, at: null };

  let injectionState;
  if (!onChatGpt) injectionState = { state: 'not-chatgpt' };
  else if (!injection) injectionState = { state: 'unverified' };
  else {
    injectionState = {
      state: injection.ok === true ? 'ok' : 'failed',
      routeId: routeIdOrNull(injection.routeId),
      detail: injection.ok === true ? null : String(injection.detail ?? 'unknown'),
      at: timestampOrNull(injection.at),
      url: sanitizeUrl(injection.url),
      source: injection.source === 'probe' ? 'probe' : 'send',
    };
  }

  return {
    version: String(version ?? ''),
    generatedAt: now,
    localBridge: {
      state: ['connected', 'connecting'].includes(localBridge?.state)
        ? localBridge.state
        : 'disconnected',
      since: timestampOrNull(localBridge?.since),
    },
    remoteRelay: {
      enabled: remoteRelay?.enabled === true,
      connected: remoteRelay?.connected === true,
    },
    tab: {
      id: Number.isInteger(tab?.id) ? tab.id : null,
      url: sanitizeUrl(tab?.url),
      isChatGpt: onChatGpt,
    },
    route,
    injection: injectionState,
    // Route-scoped: a delivery for any other route (an old conversation,
    // another tab) is not this page's delivery and must not show as one.
    lastDelivery: lastDelivery && route.routeId &&
      routeIdOrNull(lastDelivery.routeId) === route.routeId
      ? {
          outcome: String(lastDelivery.outcome),
          routeId: route.routeId,
          at: timestampOrNull(lastDelivery.at),
        }
      : null,
    // Only a re-detect of the conversation this tab is showing now.
    lastRedetect: onChatGpt && lastRedetect &&
      sanitizeUrl(lastRedetect.url) === sanitizeUrl(tab.url)
      ? {
          status: REDETECT_STATUSES.includes(lastRedetect.status)
            ? lastRedetect.status
            : 'unsupported',
          detail: lastRedetect.detail == null
            ? null
            : String(lastRedetect.detail).slice(0, DETAIL_MAX),
          routeId: routeIdOrNull(lastRedetect.routeId),
          at: timestampOrNull(lastRedetect.at),
        }
      : null,
    badge: typeof badge === 'string' ? badge : '',
  };
};

// --- Presentation -----------------------------------------------------------

// composer-not-found may carry a content-free resolver summary after a colon,
// e.g. "composer-not-found:hidden-only;scopes=1;candidates=2;hidden=2;readonly=0".
const detailKey = (detail) => String(detail ?? '').split(':')[0];

const COMPOSER_MISS_TEXT = {
  'selectors-missed': '页面结构未识别',
  'hidden-only': '输入框不可见',
  'readonly-only': '输入框不可编辑',
  rejected: '候选输入框均不可用',
};

const composerMissSuffix = (detail) => {
  const reason = String(detail ?? '').split(':')[1]?.split(';')[0];
  const text = reason ? COMPOSER_MISS_TEXT[reason] : null;
  return text ? '（' + text + '）' : '';
};

const INJECTION_REASONS = [
  [/^composer-not-found(?::|$)/, '找不到 ChatGPT 输入框'],
  [/^settled-readback-mismatch$/, 'marker 写入后被页面还原'],
  [/^pre-send-readback-mismatch$/, '发送前最终校验未通过'],
  [/^probe-cleanup-failed$/, '检测后无法清理输入框'],
  [/readback-mismatch/, 'marker 写入后读回不一致'],
];

export const explainInjectionDetail = (detail) => {
  if (!detail) return '';
  const hit = INJECTION_REASONS.find(([pattern]) => pattern.test(detail));
  if (!hit) return '未知原因';
  return detailKey(detail) === 'composer-not-found' ? hit[1] + composerMissSuffix(detail) : hit[1];
};

const DELIVERY_TEXT = {
  unmatched: '完成事件找不到匹配 route 的 ChatGPT 标签页',
  'content-script-unavailable': '无法连接 ChatGPT 页面脚本',
  failed: '完成事件未能发送到 ChatGPT',
};

const formatClock = (at) => {
  if (!at) return '';
  const date = new Date(at);
  const pad = (value) => String(value).padStart(2, '0');
  return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
};

const shortId = (routeId) => (routeId ? routeId.slice(0, 8) : '');

const LAST_REDETECT_TEXT = {
  'composer-has-text': '输入框有内容，未做注入检测',
  'composer-not-found': '未找到输入框，未做注入检测',
  unsupported: '页面脚本版本过旧，未做注入检测',
  error: '检测未完成',
};

// Why an unverified injection has no probe outcome, if a re-detect ran.
const describeLastRedetect = (redetect) => {
  if (!redetect || redetect.status === 'ok' || redetect.status === 'failed') return '';
  const key = redetect.status === 'skipped' ? detailKey(redetect.detail) : redetect.status;
  const suffix = key === 'composer-not-found' ? composerMissSuffix(redetect.detail) : '';
  return '最近检测：' + (LAST_REDETECT_TEXT[key] ?? LAST_REDETECT_TEXT.unsupported) + suffix +
    ' · ' + formatClock(redetect.at);
};

// Four rows, each with a tone the popup maps to a colored dot.
export const describeSnapshot = (snapshot) => {
  const rows = [];

  const bridge = snapshot.localBridge.state;
  rows.push({
    key: 'bridge',
    label: 'AI Studio',
    tone: bridge === 'connected' ? 'ok' : bridge === 'connecting' ? 'warn' : 'bad',
    text: bridge === 'connected'
      ? '本地桥已连接'
      : bridge === 'connecting' ? '本地桥连接中…' : '本地桥未连接',
    detail: bridge === 'disconnected' ? '确认 AI Studio 正在运行' : '',
  });

  const route = snapshot.route;
  rows.push({
    key: 'route',
    label: '当前页面',
    tone: route.state === 'bound' ? 'ok' : route.state === 'unbound' ? 'bad' : 'muted',
    text: route.state === 'bound'
      ? 'route 已绑定'
      : route.state === 'unbound' ? 'route 未绑定' : '不是 ChatGPT 页面',
    detail: route.state === 'bound'
      ? 'route ' + shortId(route.routeId)
      : route.state === 'unbound' ? '点击“重新检测当前页面”' : '',
  });

  const injection = snapshot.injection;
  let injectionRow;
  if (injection.state === 'ok') {
    injectionRow = {
      tone: 'ok',
      text: '最近一次成功',
      detail: formatClock(injection.at) + (injection.source === 'probe' ? ' · 检测' : ' · 发送'),
    };
  } else if (injection.state === 'failed') {
    injectionRow = {
      tone: 'bad',
      text: '最近一次失败',
      detail: explainInjectionDetail(injection.detail) + ' · ' + formatClock(injection.at),
    };
  } else if (injection.state === 'unverified') {
    injectionRow = {
      tone: 'muted',
      text: '尚未验证',
      detail: describeLastRedetect(snapshot.lastRedetect),
    };
  } else {
    injectionRow = { tone: 'muted', text: '—', detail: '' };
  }
  rows.push({ key: 'injection', label: '发送注入', ...injectionRow });

  rows.push({
    key: 'version',
    label: '插件版本',
    tone: 'muted',
    text: snapshot.version,
    detail: '',
  });

  return rows;
};

// One-line explanation of a "!" badge caused by delivery rather than
// injection, so the popup can say which of the two it was.
export const describeDeliveryIssue = (snapshot) => {
  const delivery = snapshot.lastDelivery;
  if (!delivery || delivery.outcome === 'delivered') return '';
  return (DELIVERY_TEXT[delivery.outcome] ?? '投递异常') + ' · ' + formatClock(delivery.at);
};

const iso = (at) => (at ? new Date(at).toISOString() : '-');

export const formatDiagnostics = (snapshot) => {
  const { localBridge, remoteRelay, tab, route, injection, lastDelivery, lastRedetect } = snapshot;
  const lines = [
    'AI Studio → ChatGPT Bridge 诊断',
    'generated: ' + iso(snapshot.generatedAt),
    'version: ' + snapshot.version,
    'local bridge: ' + localBridge.state + ' (since ' + iso(localBridge.since) + ')',
    'remote relay: ' + (remoteRelay.enabled ? 'enabled' : 'disabled') +
      ', ' + (remoteRelay.connected ? 'connected' : 'not connected'),
    'tab: ' + (tab.url || '-') + (tab.isChatGpt ? '' : ' (not ChatGPT)'),
    'route: ' + route.state +
      (route.routeId ? ' routeId=' + route.routeId : '') +
      (route.at ? ' registered=' + iso(route.at) : ''),
  ];

  if (injection.state === 'ok' || injection.state === 'failed') {
    lines.push(
      'injection: ' + injection.state +
      ' at=' + iso(injection.at) +
      ' source=' + injection.source +
      ' routeId=' + (injection.routeId ?? '-') +
      (injection.url ? ' url=' + injection.url : '') +
      (injection.detail ? ' error=' + injection.detail : ''),
    );
  } else {
    lines.push('injection: ' + injection.state);
  }

  lines.push(
    'last delivery: ' + (lastDelivery
      ? lastDelivery.outcome + ' at=' + iso(lastDelivery.at) +
        ' routeId=' + (lastDelivery.routeId ?? '-')
      : '-'),
  );
  lines.push(
    'last redetect: ' + (lastRedetect
      ? lastRedetect.status +
        (lastRedetect.detail ? ' detail=' + lastRedetect.detail : '') +
        ' at=' + iso(lastRedetect.at)
      : '-'),
  );
  lines.push('badge: ' + (snapshot.badge || '(empty)'));
  return lines.join('\n');
};

const REDETECT_FAILURES = {
  'tab-not-found': '找不到当前标签页',
  'not-chatgpt': '当前标签页不是 ChatGPT，无需检测',
  'content-script-unavailable': '无法连接页面脚本，请刷新 ChatGPT 页面',
  'registration-request-failed': '页面脚本没有响应，请刷新 ChatGPT 页面',
  'registration-failed': 'route 注册失败',
  'internal-error': '检测出错',
};

const PROBE_TEXT = {
  ok: '注入检测通过',
  'composer-has-text': '输入框里有内容，未做注入检测（不改动你的输入）',
  'composer-not-found': '未找到输入框，未做注入检测',
  unsupported: '页面脚本版本过旧，未做注入检测',
};

// Result line under the buttons after "重新检测当前页面".
export const describeRedetect = (result) => {
  if (!result?.ok) {
    return {
      tone: 'bad',
      text: REDETECT_FAILURES[result?.reason] ?? REDETECT_FAILURES['internal-error'],
    };
  }

  const probe = result.probe ?? { status: 'unsupported' };
  if (probe.status === 'ok') {
    return { tone: 'ok', text: 'route 已重新注册；' + PROBE_TEXT.ok };
  }
  if (probe.status === 'failed') {
    return {
      tone: 'bad',
      text: 'route 已重新注册；注入检测失败：' + explainInjectionDetail(probe.detail),
    };
  }
  const key = probe.status === 'skipped' ? detailKey(probe.detail) : 'unsupported';
  const suffix = key === 'composer-not-found' ? composerMissSuffix(probe.detail) : '';
  return {
    tone: 'muted',
    text: 'route 已重新注册；' + (PROBE_TEXT[key] ?? PROBE_TEXT.unsupported) + suffix,
  };
};
