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
