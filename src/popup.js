import {
  describeDeliveryIssue,
  describeRedetect,
  describeSnapshot,
  formatDiagnostics,
} from './status.js';

const REFRESH_MS = 1000;

const rowsEl = document.querySelector('#rows');
const deliveryEl = document.querySelector('#delivery');
const messageEl = document.querySelector('#message');
const redetectButton = document.querySelector('#redetect');
const copyButton = document.querySelector('#copy');

let activeTabId = null;
let lastSnapshot = null;

const showMessage = (text, tone = 'muted') => {
  messageEl.textContent = text;
  messageEl.className = 'note' + (tone === 'bad' ? ' bad' : '');
  messageEl.hidden = !text;
};

const renderRow = ({ key, label, tone, text, detail }) => {
  const li = document.createElement('li');
  li.dataset.key = key;

  const dot = document.createElement('span');
  dot.className = 'dot ' + tone;
  const labelEl = document.createElement('span');
  labelEl.className = 'label';
  labelEl.textContent = label;
  const value = document.createElement('span');
  value.className = 'value' + (tone === 'bad' ? ' bad' : '');
  value.textContent = text;

  li.append(dot, labelEl, value);
  if (detail) {
    const detailEl = document.createElement('span');
    detailEl.className = 'detail';
    detailEl.textContent = detail;
    li.append(detailEl);
  }
  return li;
};

const render = (snapshot) => {
  rowsEl.replaceChildren(...describeSnapshot(snapshot).map(renderRow));

  const delivery = describeDeliveryIssue(snapshot);
  deliveryEl.textContent = delivery ? '角标 !：' + delivery : '';
  deliveryEl.className = 'note bad';
  deliveryEl.hidden = !delivery;
};

const refresh = async () => {
  const snapshot = await chrome.runtime.sendMessage({
    type: 'aiStudio.popup.getStatus',
    tabId: activeTabId,
  });
  if (!snapshot) return;
  lastSnapshot = snapshot;
  render(snapshot);
};

const copyText = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
};

redetectButton.addEventListener('click', async () => {
  redetectButton.disabled = true;
  showMessage('检测中…');
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'aiStudio.popup.redetect',
      tabId: activeTabId,
    });
    const { tone, text } = describeRedetect(result);
    showMessage(text, tone);
    await refresh();
  } catch (error) {
    console.error('[AI Studio Bridge] Re-detection failed', error);
    showMessage('检测出错', 'bad');
  } finally {
    redetectButton.disabled = false;
  }
});

copyButton.addEventListener('click', async () => {
  try {
    await refresh();
  } catch {
    // Copy whatever was last shown.
  }
  if (!lastSnapshot) {
    showMessage('还没有状态可复制', 'bad');
    return;
  }
  const ok = await copyText(formatDiagnostics(lastSnapshot));
  showMessage(ok ? '诊断信息已复制' : '复制失败', ok ? 'muted' : 'bad');
});

const start = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id ?? null;
  await refresh();
  setInterval(() => {
    refresh().catch(() => {});
  }, REFRESH_MS);
};

start().catch((error) => {
  console.error('[AI Studio Bridge] Failed to load status', error);
  showMessage('读取状态失败', 'bad');
});
