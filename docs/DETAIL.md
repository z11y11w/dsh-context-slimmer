# 主代理工具裁剪（dsh-context-slimmer）

## 它做什么

主代理能看到的工具 = 全局层 + 祖先层 + 自己这层的并集。装了几个 bundle 之后，光工具定义就占掉一大截 prefix token，而其中大多数在大多数回合里都用不到。

本插件把这些工具按名字**分组收起**，只留核心工具在列表里；需要时调一次 `tool_groups` 把某一组/某个工具放出来，**下一 step 生效**。

- 主代理：按配置收起
- 子代理：**不管**（默认不碰）
- 能力一个都不删：收起的工具只是不在列表里，放出来就回来了

## 安装

1. 插件页面 → 添加插件 → 选本仓库根目录
2. 在插件详情页或 `cordis.patch.yml` 里配置分组
3. 重启 DSH

## 配置：三级，按工具名累积覆盖

优先级 **窗口 > 工作区 > 全局**。

```yaml
- id: context-slimmer
  name: dsh-context-slimmer
  config:
    enabled: true

    groups:                       # 只描述"哪些工具归哪一组"
      - name: browser
        patterns: ["dsh_browser_*"]

    close: ["browser"]            # 全局收起哪些（组名 / 工具名 / 通配符）
    open: []                      # 全局放出哪些，覆盖本级 close

    workspaces:                   # 工作区层，按会话 cwd 匹配（最长前缀优先）
      "E:/working":
        open: ["browser"]

    includeSubagents: false
    verbose: false
```

**合并规则**：从低到高依次应用 `close`（加入隐藏集）与 `open`（移出隐藏集）。

```
全局   close {a,b,c}        → 收起 a、b、c
工作区 open  {b}            → 放出 b
窗口   close {d} open {c}   → 收起 d、放出 c
最终可见：b、c；不可见：a、d
```

- 不写 `close` = 收起所有已定义的组（1.0 的行为）
- 同一级里同一项同时在 `close` 和 `open`，以 `open` 为准
- 一个条目可以是组名（展开整组）、工具名或通配符

## 窗口级怎么设

不改配置文件，直接在那个会话里调工具：

| 调用 | 作用 |
|---|---|
| `tool_groups({ action: "list" })` | 有哪些组、三级配置分别是什么、合并后每组多少被收起 |
| `tool_groups({ action: "open", target: "browser" })` | 本窗口放出，下一 step 起可用 |
| `tool_groups({ action: "close", target: "github" })` | 本窗口收起 |

窗口级选择落在 `<DSH_HOME>/context-slimmer/sessions.json`，**重启后保留**——一个窗口通常整个任务期间配置一致，而任务期间可能重启。

`tool_groups` 自己**永远不会**被任何组收走。

## 限制与边界

- **只影响主代理**。子代理不在本插件的处理范围内。
- **全局与工作区配置改完即生效**（热加载），窗口级配置由工具写入文件。
- **只匹配全局层工具名**。preset 自己注册的工具不会被本插件收走（那是插件自己声明的，不属于"省 token"的处理范围）。本插件也不改变会话使用的预设。
- **空 `groups` 时不生效**：装了但没配置，工具一个都不会少。
- 插件重新加载会**补扫已存在的 agent**，所以改配置会对当前已经开着的会话生效。

## 急救

设环境变量 `DSH_CONTEXT_SLIMMER_OFF=1` 后重启，本插件完全不生效（工具全部可见）。
