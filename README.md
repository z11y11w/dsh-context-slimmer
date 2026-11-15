# dsh-context-slimmer

> **测试版（0.1.x）**：仍在验证阶段，行为可能随版本变化。正式使用前请先在一个测试会话里试。

你的 DSH 主代理每轮对话都要把手上几十个工具的说明书重新发一遍给模型——哪怕这一轮根本用不到浏览器、用不到任务看板。

这个插件把那些工具按组收起来，列表里只留常用的。模型真需要的时候，调一次 `tool_groups` 说「我要用浏览器」，下一轮它们就回来了。

**不删任何能力。** 收起的工具只是不在列表里，展开就回来。

## 安装

Host-only bundle，没有构建步骤、没有运行时依赖、不联网。

1. 打开 DSH 的 **插件** 页面
2. **添加插件** → 选本地目录 → 选本仓库根目录
3. 确认插件行出现且为启用状态
4. 重启 DSH
5. **配置分组**（不配等于没装，见下一节）

## 配置

在插件详情页改，或写进 profile 的 `cordis.patch.yml`：

```yaml
- id: context-slimmer
  name: dsh-context-slimmer
  config:
    enabled: true
    groups:
      - name: browser
        patterns: ["dsh_browser_*"]
      - name: taskboard
        patterns: ["taskboard_*"]
    openByDefault: []
    includeSubagents: false
    verbose: false
```

| 键 | 说明 |
|---|---|
| `groups` | 分组规则。`patterns` 用 `*` / `?` 通配**全局层**的工具名。空数组 = 什么都不收（安全默认） |
| `openByDefault` | 开局就展开的组 |
| `includeSubagents` | 是否也管子代理，默认 `false`（本插件只为主代理设计） |
| `verbose` | 每个 agent 打一行日志，排查用 |

同一个工具可以落进多个组：**只要有一组展开，它就可见**。

搞不清工具叫什么名字的话，先看一眼主代理的工具列表，按前缀配就行（`dsh_browser_*`、`taskboard_*` 这类）。

## 模型怎么用

主代理看到的是一个 `tool_groups` 工具：

| 调用 | 作用 |
|---|---|
| `tool_groups({ action: "list" })` | 有哪些组、每组几个工具、现在展开没展开 |
| `tool_groups({ action: "open", group: "browser" })` | 展开，**下一 step 起可用** |
| `tool_groups({ action: "close", group: "browser" })` | 收起，把 context 还回去 |

`tool_groups` 自己永远不会被任何组收走——否则模型就没有开锁的钥匙了。

## 限制与边界

- **状态不持久化**：重启后回到 `openByDefault`。这是刻意的——省 token 是每轮的事，把「上次展开了什么」存下来只会让行为更难预测。
- **只匹配全局层工具名**。preset 自己注册的工具不会被收走。
- **空 `groups` 时不生效**：装了但没配置，工具一个都不会少。
- 展开的组在下一次 `open` / `close` 或会话结束前一直可见，不会自动收起。

## 急救

```powershell
[Environment]::SetEnvironmentVariable('DSH_CONTEXT_SLIMMER_OFF', '1', 'User')
```

重启后插件完全不生效，所有工具可见。环境变量在进程启动时读取，改完必须重启。

## 开发

自测是纯 mock 的，不需要装进 DSH：

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& $env:DSH_NODE_EXECUTABLE tools\selftest.mjs
```

期望最后一行是 `✅ 全部通过`。覆盖 10 个场景：分组收起、核心工具不动、子代理不动、`includeSubagents`、`list`/`open`/`close`、空配置、环境变量开关、匹配不到的组告警、`openByDefault`、disposed 回收、补扫已存在 agent。

源码里的 `dsh-*` 路径引用按 DSH **0.2.2-rc.3** 的随包源码核对过行号；换版本后行号可能漂移。

## 相关插件

- **[dsh-subagent-tool-guard](https://github.com/z11y11w/dsh-subagent-tool-guard)** —— 管**子代理**的工具白名单：子代理只能看见它自己 preset 声明的工具，从全局层继承来的一律移除。两个插件各管一边（这个管主代理，那个管子代理），可以同时装。

## 许可

[MIT](LICENSE)
