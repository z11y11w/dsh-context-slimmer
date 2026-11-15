# dsh-context-slimmer

> **1.1.0**：三级配置（全局 / 工作区 / 窗口），窗口级选择落盘、重启后保留。已在真实 DSH 0.2.2-rc.3 环境验证。

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

三级配置，按工具名**累积覆盖**，优先级 **窗口 > 工作区 > 全局**：

```yaml
- id: context-slimmer
  name: dsh-context-slimmer
  config:
    enabled: true

    # 只描述"哪些工具归哪一组"，不决定收不收
    groups:
      - name: browser
        patterns: ["dsh_browser_*"]
      - name: github
        patterns: ["gh_*", "github_api"]

    # 全局层
    close: ["browser"]      # 收起哪些（组名 / 工具名 / 通配符）
    open: []                # 放出哪些（覆盖本级的 close）

    # 工作区层：按会话 cwd 覆盖，最长前缀优先
    workspaces:
      "E:/working":
        close: []
        open: ["browser"]

    includeSubagents: false
    verbose: false
```

| 键 | 说明 |
|---|---|
| `groups` | 分组规则。`patterns` 用 `*` / `?` 通配**全局层**工具名 |
| `close` | 收起列表。**不写这项** = 收起所有已定义的组（1.0 的行为） |
| `open` | 放出列表，覆盖本级的 `close` |
| `workspaces` | `{ "<cwd>": { close?, open? } }`，按会话的工作目录匹配 |
| `includeSubagents` | 是否也管子代理，默认 `false` |
| `verbose` | 每个 agent 打一行日志 |

**合并规则**：从低到高依次应用 `close`（加入隐藏集）与 `open`（移出隐藏集）。例如：

```
全局   close {a,b,c}        → 收起 a、b、c
工作区 open  {b}            → 放出 b
窗口   close {d} open {c}   → 收起 d、放出 c
最终可见：b、c；不可见：a、d
```

同一级里同一项同时出现在 `close` 和 `open`，以 `open` 为准。一个条目可以是**组名**（展开整组）、**工具名**或**通配符**。

## 窗口级怎么设

不用改配置文件——直接在那个会话里让模型调工具：

```
tool_groups({ action: "close", target: "github" })   // 本窗口收起 github 相关工具
tool_groups({ action: "open",  target: "browser" })  // 本窗口放出浏览器
tool_groups({ action: "list" })                      // 看当前三级配置与合并结果
```

窗口级选择落在 `<DSH_HOME>/context-slimmer/sessions.json`，**重启后保留**——一个窗口通常整个任务期间配置一致，而任务期间可能重启。

## 模型怎么用

| 调用 | 作用 |
|---|---|
| `tool_groups({ action: "list" })` | 有哪些组、各级配置、每组多少工具被收起 |
| `tool_groups({ action: "open", target: "browser" })` | 本窗口放出，下一 step 起可用 |
| `tool_groups({ action: "close", target: "browser" })` | 本窗口收起 |

`tool_groups` 自己永远不会被任何组收走——否则模型就没有开锁的钥匙了。

## 限制与边界

- **窗口级选择持久化**：存在 `<DSH_HOME>/context-slimmer/sessions.json`，重启后保留；全局与工作区配置在 profile 里。
- **只匹配全局层工具名**。preset 自己注册的工具不会被收走——本插件不改变会话使用的预设，只调整"看不看得到"。
- **空 `groups` 时不生效**：装了但没配置，工具一个都不会少。
- 插件重新加载会**补扫已存在的 agent**，所以改配置会对当前已经开着的会话生效。

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

期望最后一行是 `✅ 全部通过`。覆盖 10 个场景：分组收起、核心工具不动、子代理不动、`includeSubagents`、窗口级 open/close、三级合并、空配置、环境变量开关、匹配不到的组告警、补扫、disposed 回收。

源码里的 `dsh-*` 路径引用按 DSH **0.2.2-rc.3** 的随包源码核对过行号；换版本后行号可能漂移。

## 相关插件

- **[dsh-subagent-tool-guard](https://github.com/z11y11w/dsh-subagent-tool-guard)** —— 管**子代理**的工具白名单：子代理只能看见它自己 preset 声明的工具，从全局层继承来的一律移除。两个插件各管一边（这个管主代理，那个管子代理），可以同时装。

## 许可

[MIT](LICENSE)
