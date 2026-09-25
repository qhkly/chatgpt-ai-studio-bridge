import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCompletionPrompt,
  buildRemoteWebSocketUrl,
  eventKey,
  isTaskCompletedEvent,
  routeIdFromHeaders,
  routeIdFromRequestId,
} from '../src/protocol.js';

test('accepts a valid task.completed event', () => {
  assert.equal(
    isTaskCompletedEvent({
      type: 'task.completed',
      sessionId: 'session-1',
    }),
    true,
  );
});

test('rejects unrelated or malformed events', () => {
  assert.equal(isTaskCompletedEvent({ type: 'task.started', sessionId: 'session-1' }), false);
  assert.equal(isTaskCompletedEvent({ type: 'task.completed' }), false);
  assert.equal(isTaskCompletedEvent(null), false);
});

test('builds a continuation prompt with task identity', () => {
  const prompt = buildCompletionPrompt({
    type: 'task.completed',
    sessionId: 'session-1',
    title: '修复通知桥',
    project: 'webcode-ai-studio',
  });

  assert.match(prompt, /修复通知桥/);
  assert.match(prompt, /webcode-ai-studio/);
  assert.match(prompt, /session-1/);
});

test('uses eventId for cross-channel deduplication', () => {
  assert.equal(
    eventKey({
      eventId: 'evt-1',
      sessionId: 'session-1',
      finishedAt: 123,
    }),
    'evt-1',
  );
  assert.equal(
    eventKey({
      sessionId: 'session-1',
      finishedAt: 123,
    }),
    'session-1:123',
  );
});

test('builds authenticated remote websocket URL', () => {
  assert.equal(
    buildRemoteWebSocketUrl('https://notify.qhkly.com', 'secret'),
    'wss://notify.qhkly.com/ws?token=secret',
  );
});


test('normalizes the stable UUID prefix from request ids', () => {
  assert.equal(
    routeIdFromRequestId('B72B6F8F-20CE-4C89-A54F-7CB52C9D0F42/1i20'),
    'b72b6f8f-20ce-4c89-a54f-7cb52c9d0f42',
  );
  assert.equal(routeIdFromRequestId('not-a-route/1i20'), null);
  assert.equal(routeIdFromRequestId(''), null);
});

test('prefers X-Request-Id over fallback request id headers', () => {
  assert.equal(
    routeIdFromHeaders([
      { name: 'X-Client-Request-Id', value: '11111111-1111-1111-1111-111111111111/a' },
      { name: 'X-Request-Id', value: '22222222-2222-2222-2222-222222222222/b' },
    ]),
    '22222222-2222-2222-2222-222222222222',
  );
});

test('extracts a route id from request or response headers', () => {
  assert.equal(
    routeIdFromHeaders([
      { name: 'content-type', value: 'application/json' },
      { name: 'X-Request-Id', value: 'e7313570-0894-43db-81cd-def75c48c6a1/abcd' },
    ]),
    'e7313570-0894-43db-81cd-def75c48c6a1',
  );
  assert.equal(routeIdFromHeaders([{ name: 'x-request-id', value: 'bad' }]), null);
});
