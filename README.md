# ChatGPT AI Studio Bridge

一个最小 Chrome MV3 扩展：WebCode AI Studio 的 worker 完成后，把“任务已完成，请继续审查”的消息自动发到你绑定的 ChatGPT 对话。

## 使用

1. 在 Chrome 打开 chrome://extensions，开启开发者模式。
2. 选择“加载已解压的扩展程序”，目录选择本项目。
3. 打开需要接收通知的 ChatGPT 对话。
4. 点击扩展图标一次，角标显示 ON，表示当前对话已绑定。
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

## 发布（Release）

普通 push 到 main 只跑 `npm test`（CI），**不会**生成 ZIP、不会更新 version.json、不会创建 Release。

只有推送 `v*.*.*` Tag（如 `v0.4.4`）才会发布：

1. Tag 去掉前缀 `v` 后必须与 `manifest.json` 的 `version` 完全一致，否则构建直接失败。
2. 先跑 `npm test`，再由 `scripts/release/package.mjs` 打包运行时必需文件为 `chatgpt-ai-studio-bridge.zip`（ZIP 根目录直接包含 `manifest.json`），计算 SHA256 并生成 `version.json`（最小字段：`version` / `downloadUrl` / `sha256` / `tag`，不做任何 commit 追踪）。
3. 在该 Tag 对应的 GitHub Release 上传 ZIP 和 version.json。不维护固定的 `latest` Tag 或 `latest/version.json` 资产——获取最新版本请用 GitHub Releases 的 latest API（`/releases/latest`），下载地址取 Release 中的 `chatgpt-ai-studio-bridge.zip`，校验用同目录的 `version.json`。

## Remote relay

The extension always keeps the localhost bridge as the fast path. When remote relay is enabled in Extension Options it also connects to the Cloudflare relay. eventId deduplication prevents the local and remote copies from sending the same ChatGPT message twice. Remote events are ACKed only after the ChatGPT page confirms the message was sent.

The composer is never overwritten: if the user is typing, the notification waits until the composer is empty.
