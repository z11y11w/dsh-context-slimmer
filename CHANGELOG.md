# Changelog

## 1.1.0 — 2026-11-15

- **三级配置**：全局 / 工作区（按会话 cwd）/ 窗口（按 session），按工具名累积覆盖，优先级窗口 > 工作区 > 全局。
- **窗口级选择落盘**到 `<DSH_HOME>/context-slimmer/sessions.json`，重启后保留。
- `tool_groups` 的 `open` / `close` 改为写窗口级配置；参数由 `group` 改为 `target`（组名 / 工具名 / 通配符）。
- `list` 现在同时报告三级配置与合并结果。
- 移除 `openByDefault`：用全局 `open` 表达同样的意思；不写 `close` 时仍默认收起所有已定义的组，保持 1.0 的行为。

## 1.0.0 — 2026-11-15

首个正式版本。相对 0.1.0（测试期）：

- 在真实 DSH 0.2.2-rc.3 环境完成端到端验证：
  - 主代理的工具按组收起，`open` / `close` 行为符合预期
  - 子代理不受影响
- 明确适用边界：本插件不改变会话使用的预设，只调整工具"看不看得到"；preset 自己注册的工具不会被收走。

## 0.1.0 — 2026-11-15（测试期）

首个版本。

- 按通配符把主代理的全局工具分组，默认收起；配置 `groups` 才生效。
- 提供 `tool_groups` 工具：`list` / `open` / `close`，模型可自己展开某一组，下一 step 生效。
- 只作用于主代理（`session.header.origin !== 'subagent'`），子代理不在处理范围内。
- 状态纯内存，重启回到 `openByDefault`。
- 补扫已存在的 agent（插件晚于会话加载时也能生效）。
- 急救开关：`DSH_CONTEXT_SLIMMER_OFF=1`。
