# Changelog

## 0.1.0 — 2026-11-15（首个测试版）

首个版本。

- 按通配符把主代理的全局工具分组，默认收起；配置 `groups` 才生效。
- 提供 `tool_groups` 工具：`list` / `open` / `close`，模型可自己展开某一组，下一 step 生效。
- 只作用于主代理（`session.header.origin !== 'subagent'`），子代理不在处理范围内。
- 状态纯内存，重启回到 `openByDefault`。
- 补扫已存在的 agent（插件晚于会话加载时也能生效）。
- 急救开关：`DSH_CONTEXT_SLIMMER_OFF=1`。
