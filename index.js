/**
 * dsh-context-slimmer —— 主代理工具裁剪（分组 + 按需展开）
 * ============================================================================
 * 解决的问题：主代理能看到的工具是「全局层 + 祖先层 + 自己这层」的并集，
 * 装了几个 bundle 之后就是四五十个工具，每轮都要为它们付 prefix token，
 * 而绝大多数工具在绝大多数回合里用不到。
 *
 * 做法：把全局工具按名字分组（通配符），**默认只露核心工具**；模型需要时
 * 调 `tool_groups` 把某一组打开，下一 step 生效；不用了关掉。
 *
 * 与安全类插件的分工很清楚：**本插件只负责"收起来"，不负责"禁止"**。
 * 工具只是暂时不在列表里，模型随时可以展开；能不能用某个工具，
 * 由别的机制（preset 声明、scope 限制）决定。
 *
 * 只作用于**主代理**（`session.header.origin !== 'subagent'`）。子代理不在本插件的处理范围内。
 *
 * ── 为什么用 deny 而不是 allow ───────────────────────────────────────────
 * 展开一组 = 把该组工具从"隐藏集合"里去掉。deny 集合是可以逐次重算的；
 * 而 allow 是"只保留这些"，每加一组就得重算全量名单，且核心工具在不在名单里
 * 很难表达。所以：`deny = 所有未展开组里的工具`，核心工具从不进任何组，
 * 因而永远可见。
 *
 * ── 状态存在哪 ───────────────────────────────────────────────────────────
 * 纯内存（每个 agent 一个 Set）。重启后回到默认（全部收起）——这恰好是想要的：
 * 省 token 是每轮的事，不该把"上次展开了什么"持久化成一个更难预测的状态。
 * ============================================================================
 */

export const name = 'context-slimmer'

export const inject = ['tools']

/** 急救开关：设成 1 则完全不生效（工具全部可见）。 */
const OFF_ENV = 'DSH_CONTEXT_SLIMMER_OFF'

/** 控制工具名。它自己永远不能被某个组收走，否则模型就没有"开锁的钥匙"了。 */
const CONTROL_TOOL = 'tool_groups'

const TAG = '[context-slimmer]'

const DEFAULTS = {
  enabled: true,
  /** [{ name, patterns: ["dsh_browser_*"] }] —— 空数组 = 什么都不收（安全默认） */
  groups: [],
  /** 初始就展开的组名 */
  openByDefault: [],
  /** 是否也作用于子代理（默认 false：本插件只为主代理设计） */
  includeSubagents: false,
  /** 每个 agent 打一行日志 */
  verbose: false,
}

/** 只接受布尔。 */
const pickBool = (value, fallback) => (typeof value === 'boolean' ? value : fallback)

/** 只接受字符串数组。 */
function pickStringArray(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) if (typeof item === 'string' && item.length > 0) out.push(item)
  return out
}

/**
 * 通配符 → 正则。
 * 支持 `*`（任意串）和 `?`（单字符）；其余字符按字面量处理。
 */
function globToRegExp(pattern) {
  let source = ''
  for (const ch of pattern) {
    if (ch === '*') source += '.*'
    else if (ch === '?') source += '.'
    else source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

/** 把不可信的 config 压成确定形状。 */
function readConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULTS, groups: [] }
  }
  const groups = []
  if (Array.isArray(raw.groups)) {
    for (const item of raw.groups) {
      if (item === null || typeof item !== 'object') continue
      const groupName = typeof item.name === 'string' ? item.name.trim() : ''
      const patterns = pickStringArray(item.patterns)
      if (groupName.length === 0 || patterns.length === 0) continue
      groups.push({ name: groupName, matchers: patterns.map(globToRegExp) })
    }
  }
  return {
    enabled: pickBool(raw.enabled, DEFAULTS.enabled),
    groups,
    openByDefault: pickStringArray(raw.openByDefault),
    includeSubagents: pickBool(raw.includeSubagents, DEFAULTS.includeSubagents),
    verbose: pickBool(raw.verbose, DEFAULTS.verbose),
  }
}

/** 工具定义列表 → 名字数组。 */
function namesOf(definitions) {
  const out = []
  if (!Array.isArray(definitions)) return out
  for (const definition of definitions) {
    const toolName = definition?.name
    if (typeof toolName === 'string' && toolName.length > 0) out.push(toolName)
  }
  return out
}

const REPORT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    message: { type: 'string' },
    hiddenCount: { type: 'integer' },
    groups: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          tools: { type: 'integer' },
          open: { type: 'boolean' },
        },
        required: ['name', 'tools', 'open'],
      },
    },
  },
  required: ['ok', 'message', 'hiddenCount', 'groups'],
}

export function apply(ctx, config) {
  const log = (message) => { try { ctx.logger?.info?.(`${TAG} ${message}`) } catch { /* ignore */ } }
  const warn = (message) => { try { ctx.logger?.warn?.(`${TAG} ${message}`) } catch { /* ignore */ } }

  let offByEnv = false
  try { offByEnv = process.env[OFF_ENV] === '1' } catch { /* ignore */ }
  if (offByEnv) {
    warn(`已通过环境变量 ${OFF_ENV}=1 关闭，本次不收起任何工具`)
    return
  }

  const cfg = readConfig(config)
  if (!cfg.enabled) {
    log('配置 enabled=false，不收起任何工具')
    return
  }
  if (cfg.groups.length === 0) {
    warn('没有配置任何 groups —— 本插件不会收起任何工具。'
      + '要生效请在插件配置里写至少一组，例如 groups: [{ name: browser, patterns: ["dsh_browser_*"] }]')
  }

  /** agent → { opened:Set<string>, groups:[{name,tools}], hidden:string[], dispose? } */
  const states = new Map()
  /** 正在处理中的 agent，防止并发重入 */
  const busy = new WeakSet()

  const isSubagent = (agent) => {
    try { return agent?.session?.header?.origin === 'subagent' } catch { return false }
  }

  /**
   * 把配置里的组，解析成「具体的工具名」。
   * 只在**全局层**的工具名里匹配（不碰 preset 自己注册的），并且永远排除控制工具本身。
   */
  function resolveGroups(tools) {
    const candidates = namesOf(tools.definitions()).filter(n => n !== CONTROL_TOOL)
    return cfg.groups.map(group => ({
      name: group.name,
      tools: candidates.filter(n => group.matchers.some(matcher => matcher.test(n))),
    }))
  }

  /** 当前应该隐藏的工具 = 所有「没展开」的组里的工具。 */
  function computeHidden(groups, opened) {
    const hidden = new Set()
    for (const group of groups) {
      if (opened.has(group.name)) continue
      for (const toolName of group.tools) hidden.add(toolName)
    }
    return [...hidden]
  }

  /** 重算并替换这个 agent 的 restriction。 */
  function reapply(agent, state) {
    try { state.dispose?.() } catch { /* 旧 disposer 失效也无妨 */ }
    state.dispose = undefined
    const hidden = computeHidden(state.groups, state.opened)
    state.hidden = hidden
    if (hidden.length === 0) return hidden
    state.dispose = agent.ctx.tools.restrict({ deny: hidden })
    return hidden
  }

  /** 给一个 agent 装上分组与初始 restriction。 */
  function install(agent) {
    if (states.has(agent) || busy.has(agent)) return
    if (!agent) return
    if (!cfg.includeSubagents && isSubagent(agent)) return

    busy.add(agent)
    try {
      const tools = agent.ctx?.get?.('tools')
      if (!tools || typeof tools.restrict !== 'function' || typeof tools.definitions !== 'function') {
        warn(`${agent.id}: agent.ctx.tools 不可用，跳过`)
        return
      }

      const groups = resolveGroups(tools)

      // 匹配不到任何工具的组直接丢掉，避免配置写错却静默生效
      const usable = []
      for (const group of groups) {
        if (group.tools.length === 0) {
          warn(`组 "${group.name}" 没有匹配到任何全局工具（可能名字写错了，或那个 bundle 没装）`)
          continue
        }
        usable.push(group)
      }

      const known = new Set(usable.map(group => group.name))
      const opened = new Set()
      for (const groupName of cfg.openByDefault) {
        if (known.has(groupName)) opened.add(groupName)
        else warn(`openByDefault 里的 "${groupName}" 不是已配置的组，忽略`)
      }

      const state = { opened, groups: usable, hidden: [], dispose: undefined }
      const hidden = reapply(agent, state)
      states.set(agent, state)

      if (cfg.verbose || hidden.length > 0) {
        const summary = usable.map(group => `${group.name}${opened.has(group.name) ? '(展开)' : ''}:${group.tools.length}`).join(' ')
        log(`${agent.id}: 收起 ${hidden.length} 个工具 [${summary}]`)
      }
    } catch (error) {
      warn(`${agent.id}: 装配失败，该 agent 不收工具：${safeMessage(error)}`)
    } finally {
      busy.delete(agent)
    }
  }

  /** agent 走了：撤限制、清状态。 */
  function release(agent) {
    const state = states.get(agent)
    if (state === undefined) return
    states.delete(agent)
    try { state.dispose?.() } catch { /* ignore */ }
  }

  /** 补扫已存在的 agent（插件晚于会话加载）。 */
  function installExisting() {
    const agents = safeGet(() => ctx.get('agents'))
    if (typeof agents?.list !== 'function') return
    let existing
    try { existing = agents.list() } catch { return }
    for (const agent of existing ?? []) install(agent)
  }

  // ── 控制工具 ─────────────────────────────────────────────────────────────
  ctx.tools.register({
    name: CONTROL_TOOL,
    description:
      '管理当前会话的工具分组：列出有哪些组、现在展开了哪些；把某一组展开（下一 step 起可用）或收起（省 context）。'
      + '只影响你这个会话，不影响其他会话。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'open', 'close'] },
        group: { type: 'string', description: 'open / close 时要操作的组名' },
      },
      required: ['action'],
    },
    output: {
      schema: REPORT_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: formatReport(value) }],
    },
    async execute(args, exec) {
      const caller = exec?.agent
      const state = caller === undefined ? undefined : states.get(caller)
      if (state === undefined) {
        return {
          ok: false,
          message: '这个会话没有被 context-slimmer 管理（可能是子代理，或者配置里没有启用任何组）。',
          hiddenCount: 0,
          groups: [],
        }
      }

      const action = typeof args?.action === 'string' ? args.action : 'list'
      const groupName = typeof args?.group === 'string' ? args.group : ''

      if (action === 'open' || action === 'close') {
        const target = state.groups.find(group => group.name === groupName)
        if (target === undefined) {
          return {
            ok: false,
            message: `没有叫 "${groupName}" 的组。可用组：${state.groups.map(group => group.name).join(', ') || '(无)'}`,
            hiddenCount: state.hidden.length,
            groups: describe(state),
          }
        }
        if (action === 'open') state.opened.add(groupName)
        else state.opened.delete(groupName)
        const hidden = reapply(caller, state)
        return {
          ok: true,
          message: action === 'open'
            ? `已展开 "${groupName}"（${target.tools.length} 个工具），从下一 step 起可用。`
            : `已收起 "${groupName}"（${target.tools.length} 个工具）。`,
          hiddenCount: hidden.length,
          groups: describe(state),
        }
      }

      return {
        ok: true,
        message: `当前收起 ${state.hidden.length} 个工具。`,
        hiddenCount: state.hidden.length,
        groups: describe(state),
      }
    },
  })

  // ── 生命周期 ─────────────────────────────────────────────────────────────
  ctx.on('agent/created', ({ agent }) => { install(agent) })
  ctx.on('agent/disposed', ({ agent }) => { release(agent) })

  ctx.effect(() => () => {
    for (const state of states.values()) {
      try { state?.dispose?.() } catch { /* ignore */ }
    }
    states.clear()
  }, 'context-slimmer.cleanup')

  installExisting()
  try { ctx.inject(['agents'], () => { installExisting() }) } catch { /* 老内核没有 inject */ }

  const totalTools = cfg.groups.length === 0 ? 0 : cfg.groups.length
  log(`已启动（${totalTools} 组配置，急救开关 ${OFF_ENV}=1 可关闭）`)
}

/** 安全读一个可能抛的 getter。 */
function safeGet(fn) {
  try { return fn() } catch { return undefined }
}

/** 把异常压成一行。 */
function safeMessage(error) {
  try {
    if (error === null || error === undefined) return String(error)
    if (typeof error === 'string') return error
    const message = error?.message
    return typeof message === 'string' ? message : String(error)
  } catch {
    return '(无法读取错误信息)'
  }
}

/** 组状态 → 输出结构。 */
function describe(state) {
  return state.groups.map(group => ({
    name: group.name,
    tools: group.tools.length,
    open: state.opened.has(group.name),
  }))
}

/** 输出 → 人读的文字。 */
function formatReport(value) {
  const lines = []
  lines.push(value?.message ?? '')
  const groups = Array.isArray(value?.groups) ? value.groups : []
  if (groups.length > 0) {
    lines.push('')
    for (const group of groups) {
      lines.push(`· ${group.name}：${group.tools} 个工具，${group.open ? '已展开' : '收起中'}`)
    }
  }
  if (typeof value?.hiddenCount === 'number' && value.hiddenCount > 0) {
    lines.push('')
    lines.push(`当前共收起 ${value.hiddenCount} 个工具（不在你的工具列表里）。`)
  }
  return lines.join('\n')
}
