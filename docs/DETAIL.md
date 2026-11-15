# 主代理工具裁剪（dsh-context-slimmer）

## 它做什么

主代理能看到的工具 = 全局层 + 祖先层 + 自己这层的并集。装了几个 bundle 之后，光工具定义就占掉一大截 prefix token，而其中大多数在大多数回合里都用不到。

本插件把这些工具按名字**分组收起**，只留核心工具在列表里；模型需要时调一次 `tool_groups` 把某一组打开，**下一 step 生效**；用完可以再收起。

- 主代理：按配置收起分组
- 子代理：**不管**（默认不碰）
- 能力一个都不删：收起的工具只是不在列表里，展开就回来了

## 安装

1. 插件页面 → 添加插件 → 选本仓库根目录
2. 在插件详情页或 `cordis.patch.yml` 里配置分组
3. 重启 DSH

## 配置

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
| `groups` | 分组规则。`patterns` 用 `*` / `?` 通配**全局层**的工具名。空数组 = 什么都不收（安全默认，装了也不起作用） |
| `openByDefault` | 开局就展开的组 |
| `includeSubagents` | 是否也管子代理，默认 `false` |
| `verbose` | 每个 agent 打一行日志 |

同一个工具可以落进多个组：**只要有一组展开，它就可见**。

## 模型怎么用

主代理看到的是一个 `tool_groups` 工具：

- `tool_groups({ action: "list" })` → 有哪些组、每组几个工具、现在展开没展开
- `tool_groups({ action: "open", group: "browser" })` → 展开，下一 step 起可用
- `tool_groups({ action: "close", group: "browser" })` → 收起，省 context

`tool_groups` 自己**永远不会**被任何组收走。

## 限制与边界

- **只影响主代理**。子代理不在本插件的处理范围内。
- **状态不持久化**：重启后回到 `openByDefault`。这是刻意的——省 token 是每轮的事，把"上次展开了什么"存下来只会让行为更难预测。
- **只匹配全局层工具名**。preset 自己注册的工具不会被本插件收走（那是插件自己声明的，不属于"省 token"的处理范围）。
- **空 `groups` 时不生效**：装了但没配置，工具一个都不会少。

## 急救

设环境变量 `DSH_CONTEXT_SLIMMER_OFF=1` 后重启，本插件完全不生效（工具全部可见）。
