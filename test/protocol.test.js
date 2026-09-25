import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCompletionPrompt,
  buildRemoteWebSocketUrl,
  eventKey,
  isTaskCompletedEvent,
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


test('normalizes explicit route UUIDs', () => {
  assert.equal(
    routeIdFromRequestId('B72B6F8F-20CE-4C89-A54F-7CB52C9D0F42/1i20'),
    'b72b6f8f-20ce-4c89-a54f-7cb52c9d0f42',
  );
  assert.equal(routeIdFromRequestId('not-a-route/1i20'), null);
  assert.equal(routeIdFromRequestId(''), null);
});
