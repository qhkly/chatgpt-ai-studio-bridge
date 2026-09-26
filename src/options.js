import { DEFAULT_REMOTE_RELAY_URL } from './protocol.js';

const REMOTE_SETTINGS_KEY = 'remoteRelay';

const enabled = document.querySelector('#enabled');
const url = document.querySelector('#url');
const token = document.querySelector('#token');
const save = document.querySelector('#save');
const status = document.querySelector('#status');

let loaded = {};

const load = async () => {
  const stored = await chrome.storage.local.get(REMOTE_SETTINGS_KEY);
  const settings = stored[REMOTE_SETTINGS_KEY] ?? {};
  loaded = settings;

  enabled.checked = settings.enabled ?? false;
  url.value = settings.url || DEFAULT_REMOTE_RELAY_URL;
  token.value = settings.token || '';
};

save.addEventListener('click', async () => {
  const settings = {
    enabled: enabled.checked,
    url: url.value.trim() || DEFAULT_REMOTE_RELAY_URL,
    token: token.value.trim(),
  };
  // Keep the paired device id while the paired token is left untouched.
  if (settings.token && settings.token === loaded.token) {
    if (loaded.deviceId) settings.deviceId = loaded.deviceId;
    if (loaded.paired) settings.paired = true;
  }

  await chrome.storage.local.set({ [REMOTE_SETTINGS_KEY]: settings });
  loaded = settings;
  status.textContent = '已保存';
  setTimeout(() => {
    status.textContent = '';
  }, 1500);
});

load().catch((error) => {
  console.error('[AI Studio Bridge] Failed to load options', error);
  status.textContent = '读取设置失败';
});
