import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCompletionPrompt,
  isTaskCompletedEvent,
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
