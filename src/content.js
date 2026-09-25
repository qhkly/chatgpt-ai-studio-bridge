const SEND_TIMEOUT_MS = 60000;
const RETRY_MS = 300;

const findComposer = () =>
  document.querySelector('#prompt-textarea') ||
  document.querySelector('[contenteditable="true"][data-lexical-editor="true"]');

const findSendButton = () =>
  document.querySelector('[data-testid="send-button"]') ||
  document.querySelector('button[aria-label="Send prompt"]') ||
  document.querySelector('button[aria-label="发送提示"]');

const setTextareaValue = (element, text) => {
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  );

  descriptor?.set?.call(element, text);
  element.dispatchEvent(new Event('input', { bubbles: true }));
};

const setEditableValue = (element, text) => {
  element.focus();

  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(element);
  selection?.removeAllRanges();
  selection?.addRange(range);

  document.execCommand('insertText', false, text);
  element.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: text,
    }),
  );
};

const writePrompt = (element, text) => {
  if (element instanceof HTMLTextAreaElement) {
    setTextareaValue(element, text);
    return;
  }

  setEditableValue(element, text);
};

const sleep = async (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const sendPrompt = async (prompt) => {
  const deadline = Date.now() + SEND_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const composer = findComposer();

    if (composer) {
      writePrompt(composer, prompt);
      await sleep(100);

      const sendButton = findSendButton();
      if (sendButton && !sendButton.disabled) {
        sendButton.click();
        return true;
      }
    }

    await sleep(RETRY_MS);
  }

  return false;
};

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'aiStudio.taskCompleted') return;

  sendPrompt(message.prompt).catch((error) => {
    console.error('[AI Studio Bridge] Failed to send prompt', error);
  });
});
