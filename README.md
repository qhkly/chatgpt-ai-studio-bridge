# ChatGPT AI Studio Bridge

一个最小 Chrome MV3 扩展：WebCode AI Studio 的 worker 完成后，把“任务已完成，请继续审查”的消息自动发到你绑定的 ChatGPT 对话。

## 使用

1. 在 Chrome 打开 chrome://extensions，开启开发者模式。
2. 选择“加载已解压的扩展程序”，目录选择本项目。
3. 打开需要接收通知的 ChatGPT 对话。
4. 页面加载后会自动注册 route，角标显示 ON 表示当前对话已绑定（扩展安装/更新时也会自动注入已打开的 ChatGPT 标签页）。
5. AI Studio 通过 ws://127.0.0.1:17373/events 发出 task.completed 后，扩展会自动把继续处理消息发到这个对话。

## 设计

- 不调用 OpenAI API，不产生额外 API token 费用。
- 不 hook ChatGPT React 内部对象，也不调用 ChatGPT 私有接口。
- 插件仅操作 chatgpt.com 输入框和发送按钮。
- AI Studio 只向 loopback WebSocket 发布事件。
- Chrome 116+。后台每 20 秒发送一次 ping，维持 MV3 service worker WebSocket 活跃。

## 角标语义

- **ON**：当前对话的 route 已在后台注册成功。这只代表注册，不代表消息一定带上了 route marker。
- **!**：发送链路出现异常——route marker 注入输入框后读回校验失败（消息可能没带 marker），或完成事件无法投递到匹配的对话。注入失败会持续显示，直到下一次注入成功才恢复 ON。

发送前的注入闭环：插件在 pointerdown / Enter / click / submit / 自动回填各路径上，都会把 route marker 写入输入框后**读回验证**（必须恰好一个 marker 且 UUID 正确）。验证失败时自动发送会被阻止（不点发送按钮），手动发送则如实上报角标异常，不会把“route 已注册”伪装成“marker 已随消息发送”。

## 状态面板

点击扩展图标打开一个小面板，直接显示真实状态（不从角标反推）：

- **AI Studio**：本地桥 `ws://127.0.0.1:17373` 已连接 / 连接中 / 未连接。
- **当前页面**：当前活动 ChatGPT 标签页的 route 是否已绑定（按 tab + 当前 URL 精确匹配 routeBindings）。
- **发送注入**：该标签页最近一次 route marker 注入成功 / 失败（附简短原因和时间）/ 尚未验证。
- **插件版本**：manifest 版本。

若角标 `!` 来自完成事件投递失败（而非注入失败），面板下方会单独说明。

按钮：

- **重新检测当前页面**：替代原来的“点击图标重新注册”。重新注册当前 tab 的 route；若输入框为空，会做一次注入能力检测（写入 marker → 读回校验 → 同一任务内清空），不会留下 marker。输入框里有内容时不做检测，注入状态保持原样（可能为“尚未验证”），不会伪造成功。最近一次检测结果（ok / failed / skipped + 原因 / unsupported / error）按 tab 记在后台 session 状态里，只对当前会话 URL 有效。
- **复制诊断信息**：复制纯文本诊断（版本、本地桥/远程中继连接状态、当前 tab URL（去掉 query）、route、最近注入/投递结果、最近一次重新检测结果）。投递结果只显示当前页面 route 的记录，其他/旧 route 的投递不会显示。不包含 relay token 或 relay 地址。

## 输入框识别（composer resolver）

兼容 ChatGPT 各代输入框：旧版 `#prompt-textarea`、Lexical，以及当前的 ProseMirror（`div.ProseMirror[contenteditable][role=textbox][data-composer-markdown]`，外层 `data-composer-*`）。先在 composer 容器（`form[data-chatgpt-composer]` / `[data-composer-body]` / `[data-composer-input-layout]` / `[data-rich-text-layout]`）内找候选，精确选择器才会全页面兜底；泛化选择器（`[contenteditable][role=textbox]`、`textarea`）只在容器内使用，不会全页面盲选。每个候选须 connected、非 hidden/aria-hidden、可编辑、宽高 > 0，多个候选按“在容器内 / data-composer-markdown / ProseMirror / role=textbox / aria-label”打分。发送按钮优先在输入框附近（同一 form）查找，停止按钮（“停止”/Stop）不算发送。找不到时 `composer-not-found:` 后附一段不含正文的摘要（如 `hidden-only;scopes=3;candidates=1;hidden=1;readonly=0`）。

## 发布（Release）

普通 push 到 main 只跑 `npm test`（CI），**不会**生成 ZIP、不会更新 version.json、不会创建 Release。

只有推送 `v*.*.*` Tag（如 `v0.4.4`）才会发布：

1. Tag 去掉前缀 `v` 后必须与 `manifest.json` 的 `version` 完全一致，否则构建直接失败。
2. 先跑 `npm test`，再由 `scripts/release/package.mjs` 打包运行时必需文件为 `chatgpt-ai-studio-bridge.zip`（ZIP 根目录直接包含 `manifest.json`），计算 SHA256 并生成 `version.json`（最小字段：`version` / `downloadUrl` / `sha256` / `tag`，不做任何 commit 追踪）。
3. 在该 Tag 对应的 GitHub Release 上传 ZIP 和 version.json。不维护固定的 `latest` Tag 或 `latest/version.json` 资产——获取最新版本请用 GitHub Releases 的 latest API（`/releases/latest`），下载地址取 Release 中的 `chatgpt-ai-studio-bridge.zip`，校验用同目录的 `version.json`。

## 连接远程 AI Studio（配对）

AI Studio 不在本机时（本地桥未连接且未配置远程中继），弹窗会显示 **连接远程 AI Studio**：

1. 在 AI Studio 设备页生成 6 位配对码（一次性，5 分钟有效）。
2. 在弹窗输入配对码（可带空格）点“连接”。扩展后台向 `https://notify.qhkly.com/v1/pairings/claim` 提交 `{code, deviceLabel}`，换取该浏览器专属的 `deviceToken` 和 `relayUrl`，写入 `chrome.storage.local` 并立即连接远程中继；弹窗显示“远程已连接”。
3. 配对码过期/已使用/无效、格式错误、网络失败都会给出明确提示，不会改动现有设置。

同机的 localhost 桥仍然优先；远程可同时在线，同一事件按 eventId 去重只发送一次。`deviceToken` 只存在于后台和本地存储，不会出现在弹窗、诊断信息或 console 中。

**断开远程连接** 只清除本机保存的 token，不会在服务端吊销设备；吊销请在 AI Studio 设备列表中操作。

在 AI Studio 设备列表吊销后，中继会发送 `{"type":"device.revoked"}` 控制帧或以 close code `4003` 断开：扩展立即关闭远程连接并停止重连；配对得到的 token 会从本机清除，弹窗回到“连接远程 AI Studio”。手工填写的 token 不会被清除，但在修改前不再重试。普通网络断开仍按原逻辑自动重连。

手工填写 relay 地址 / token 仍可在扩展选项页（高级设置）完成。

## Remote relay

The extension always keeps the localhost bridge as the fast path. When remote relay is enabled in Extension Options it also connects to the Cloudflare relay. eventId deduplication prevents the local and remote copies from sending the same ChatGPT message twice. Remote events are ACKed only after the ChatGPT page confirms the message was sent.

The composer is never overwritten: if the user is typing, the notification waits until the composer is empty.
