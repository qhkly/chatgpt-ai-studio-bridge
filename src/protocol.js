export const DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:17373/events';
export const DEFAULT_REMOTE_RELAY_URL = 'https://notify.qhkly.com';


const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const routeIdFromRequestId = (value) => {
  if (typeof value !== 'string') return null;
  const prefix = value.trim().split('/', 1)[0];
  if (!UUID_RE.test(prefix)) return null;
  return prefix.toLowerCase();
};

export const routeIdFromHeaders = (headers = []) => {
  const normalized = headers ?? [];
  for (const wanted of ['x-request-id', 'x-client-request-id', 'x-openai-request-id']) {
    for (const header of normalized) {
      if (String(header?.name ?? '').toLowerCase() !== wanted) continue;
      const routeId = routeIdFromRequestId(header?.value);
      if (routeId) return routeId;
    }
  }
  return null;
};

export const isTaskCompletedEvent = (value) => {
  if (!value || typeof value !== 'object') return false;
  if (value.type !== 'task.completed') return false;

  const sessionId = value.sessionId ?? value.taskId;
  return typeof sessionId === 'string' && sessionId.length > 0;
};

export const eventKey = (event) => {
  if (typeof event?.eventId === 'string' && event.eventId.length > 0) {
    return event.eventId;
  }

  const id = event?.sessionId ?? event?.taskId ?? 'unknown';
  return id + ':' + String(event?.finishedAt ?? '');
};

export const buildCompletionPrompt = (event) => {
  const id = event.sessionId ?? event.taskId;
  const title = event.title ? '「' + event.title + '」' : id;
  const project = event.project ? '，工程：' + event.project : '';

  return 'AI Studio 工人任务 ' + title + ' 已完成' + project +
    '。请查看该工人的 CLI 输出和代码改动，审查结果并继续处理下一步。任务/session ID：' + id;
};

export const buildRemoteWebSocketUrl = (relayUrl, token) => {
  const url = new URL(relayUrl || DEFAULT_REMOTE_RELAY_URL);

  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (!['ws:', 'wss:'].includes(url.protocol)) {
    throw new Error('Relay URL must use http, https, ws, or wss');
  }

  url.pathname = url.pathname.replace(/\/$/, '') + '/ws';
  url.search = '';
  url.searchParams.set('token', token);
  return url.toString();
};
