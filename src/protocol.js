export const DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:17373/events';

export const isTaskCompletedEvent = (value) => {
  if (!value || typeof value !== 'object') return false;
  if (value.type !== 'task.completed') return false;

  const sessionId = value.sessionId ?? value.taskId;
  return typeof sessionId === 'string' && sessionId.length > 0;
};

export const buildCompletionPrompt = (event) => {
  const id = event.sessionId ?? event.taskId;
  const title = event.title ? '「' + event.title + '」' : id;
  const project = event.project ? '，工程：' + event.project : '';

  return 'AI Studio 工人任务 ' + title + ' 已完成' + project +
    '。请查看该工人的 CLI 输出和代码改动，审查结果并继续处理下一步。任务/session ID：' + id;
};
