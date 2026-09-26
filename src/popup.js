import {
  describePairingError,
  describeRemote,
  normalizePairingCode,
} from './pairing.js';
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
const statusView = document.querySelector('#status-view');
const remoteEl = document.querySelector('#remote');
const remoteDot = document.querySelector('#remote-dot');
const remoteText = document.querySelector('#remote-text');
const disconnectButton = document.querySelector('#disconnect-remote');
const pairButton = document.querySelector('#pair');
const pairView = document.querySelector('#pair-view');
const pairCode = document.querySelector('#pair-code');
const pairSubmit = document.querySelector('#pair-submit');
const pairMessage = document.querySelector('#pair-message');
const pairBack = document.querySelector('#pair-back');
const openOptions = document.querySelector('#open-options');

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

  // The snapshot only says enabled/connected; the device token never
  // reaches the popup.
  const remote = describeRemote(snapshot);
  remoteEl.hidden = remote.state === 'off';
  remoteDot.className = 'dot ' + (remote.state === 'connected' ? 'ok' : 'warn');
  remoteText.textContent = remote.text;
  pairButton.hidden = !remote.offerPairing;
};

const showPairMessage = (text, tone = 'muted') => {
  pairMessage.textContent = text;
  pairMessage.className = 'note' + (tone === 'bad' ? ' bad' : '');
  pairMessage.hidden = !text;
};

const showPairView = (visible) => {
  statusView.hidden = visible;
  pairView.hidden = !visible;
  if (visible) {
    showPairMessage('');
    pairCode.value = '';
    pairCode.focus();
  }
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

pairButton.addEventListener('click', () => showPairView(true));
pairBack.addEventListener('click', () => showPairView(false));
openOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());

pairView.addEventListener('submit', async (event) => {
  event.preventDefault();
  const code = normalizePairingCode(pairCode.value);
  if (!code) {
    showPairMessage(describePairingError('invalid-format'), 'bad');
    pairCode.focus();
    return;
  }

  pairSubmit.disabled = true;
  pairCode.disabled = true;
  showPairMessage('连接中…');
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'aiStudio.popup.pairRemote',
      code,
    });
    if (result?.ok) {
      showPairView(false);
      showMessage('配对成功');
      await refresh();
    } else {
      showPairMessage(describePairingError(result?.reason), 'bad');
    }
  } catch {
    showPairMessage(describePairingError('internal-error'), 'bad');
  } finally {
    pairSubmit.disabled = false;
    pairCode.disabled = false;
  }
});

disconnectButton.addEventListener('click', async () => {
  disconnectButton.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'aiStudio.popup.disconnectRemote',
    });
    showMessage(
      result?.ok
        ? '已在本机断开远程连接；如需吊销该设备，请在 AI Studio 设备列表中操作'
        : '断开失败',
      result?.ok ? 'muted' : 'bad',
    );
    await refresh();
  } catch {
    showMessage('断开失败', 'bad');
  } finally {
    disconnectButton.disabled = false;
  }
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
