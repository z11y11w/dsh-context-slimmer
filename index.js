/**
 * dsh-context-slimmer —— 主代理工具裁剪（三级配置：全局 / 工作区 / 窗口）
 * ============================================================================
 * 解决的问题：主代理能看到的工具是「全局层 + 祖先层 + 自己这层」的并集，
 * 装了几个 bundle 之后就是几十上百个工具，每轮都要为它们付 prefix token，
 * 而绝大多数工具在绝大多数回合里用不到。
 *
 * 做法：把全局工具按名字分组（通配符），按配置**收起**其中一部分；模型需要时
 * 调 `tool_groups` 把某一组/某个工具放出来。
 *
 * ── 三级配置，按工具名累积覆盖 ───────────────────────────────────────────
 *
 *   优先级（高 → 低）：窗口 > 工作区 > 全局
 *
 *   每一级都可以声明：
 *     close: [...]  收起这些（组名、工具名或通配符）
 *     open:  [...]  放出来这些（覆盖前面级的 close）
 *
 *   合并规则：从低到高依次应用 close（加入隐藏集）与 open（移出隐藏集）。
 *   例：
 *     全局 close {a,b,c}      → a、b、c 收
 *     工作区 open {b}          → b 放出来
 *     窗口 close {d} open {c}  → d 收、c 放出来
 *     最终可见：b、c 可见；a、d 不可见
 *
 *   若某一级没有写 `close`，全局层默认收纳所有已定义的组（保持 1.0 的行为）。
 *
 * ── 三级配置分别放在哪 ────────────────────────────────────────────────────
 *
 *   全局    profile 的 cordis.patch.yml（本插件的 config）
 *   工作区  同一份 config 里的 workspaces: { "<cwd>": { close, open } }
 *   窗口    <DSH_HOME>/context-slimmer/sessions.json（由 tool_groups 写入）
 *           —— 刻意落盘而不是存内存：一个窗口通常整个任务期间一致，而任务期间
 *              可能重启，存内存会把窗口级选择丢掉。
 *
 * ── 只作用于主代理 ────────────────────────────────────────────────────────
 * 子代理（session.header.origin === 'subagent'）默认不管，它们归
 * dsh-subagent-tool-guard。配置 includeSubagents: true 可以让本插件也处理它们。
 *
 * ── 为什么用 deny 而不是 allow ───────────────────────────────────────────
 * 放出一个工具 = 把它从"隐藏集合"里去掉。deny 集合可以逐次重算；allow 是
 * "只保留这些"，每放一个就得重算全量名单。所以恒定用 deny，且每次状态变化就
 * dispose 旧 restriction、按当前三级合并结果重建一条。
 * ============================================================================
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'context-slimmer'

export const inject = ['tools']

/** 急救开关：设成 1 则完全不生效（工具全部可见）。 */
const OFF_ENV = 'DSH_CONTEXT_SLIMMER_OFF'

/** 控制工具名。它自己永远不能被任何组/规则收走。 */
const CONTROL_TOOL = 'tool_groups'

/** 窗口级配置的落盘文件名。 */
const SESSION_FILE = 'sessions.json'

const TAG = '[context-slimmer]'

const DEFAULTS = {
  enabled: true,
  /** [{ name, patterns: ["dsh_browser_*"] }] */
  groups: [],
  /** 全局收起；undefined = 未指定（默认收起所有已定义的组，保持 1.0 行为） */
  close: undefined,
  /** 全局放出；覆盖本级的 close */
  open: [],
  /** { "<cwd>": { close?: [], open?: [] } } */
  workspaces: {},
  /** 是否也作用于子代理（默认 false，子代理归 subagent-tool-guard 管） */
  includeSubagents: false,
  /** 每个 agent 打一行日志 */
  verbose: false,
}

const pickBool = (value, fallback) => (typeof value === 'boolean' ? value : fallback)

/** 只接受字符串数组。 */
function pickStringArray(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) if (typeof item === 'string' && item.length > 0) out.push(item)
  return out
}

/** 通配符 → 正则（支持 `*` 与 `?`）。 */
function globToRegExp(pattern) {
  let source = ''
  for (const ch of pattern) {
    if (ch === '*') source += '.*'
    else if (ch === '?') source += '.'
    else source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

/** 读一层 close/open 配置；两者都没有就是未声明。 */
function readLayer(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const close = pickStringArray(raw.close)
  const open = pickStringArray(raw.open)
  if (!Array.isArray(raw.close) && !Array.isArray(raw.open)) return undefined
  return {
    close: Array.isArray(raw.close) ? close : undefined,
    open,
  }
}

/** 把不可信的 config 压成确定形状。 */
function readConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULTS, groups: [], workspaces: {} }
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

  const workspaces = {}
  if (raw.workspaces !== null && typeof raw.workspaces === 'object' && !Array.isArray(raw.workspaces)) {
    for (const [dir, value] of Object.entries(raw.workspaces)) {
      const layer = readLayer(value)
      if (layer !== undefined) workspaces[String(dir)] = layer
    }
  }

  const globalLayer = readLayer(raw)

  return {
    enabled: pickBool(raw.enabled, DEFAULTS.enabled),
    groups,
    close: globalLayer === undefined ? undefined : globalLayer.close,
    open: globalLayer === undefined ? [] : globalLayer.open,
    workspaces,
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

/** 按最长前缀匹配工作区配置。 */
function workspaceLayerFor(workspaces, cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return undefined
  const normalized = cwd.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
  let best
  for (const [dir, layer] of Object.entries(workspaces)) {
    const key = dir.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
    if (key.length === 0) continue
    if (normalized === key || normalized.startsWith(`${key}/`)) {
      if (best === undefined || key.length > best.key.length) best = { key, layer }
    }
  }
  return best?.layer
}

/**
 * 把一层里的名字解析成具体工具名。
 * 一个条目可以精确匹配组名（展开整组），否则按通配符匹配工具名。
 */
function resolveNames(list, groups, allToolNames) {
  const out = new Set()
  for (const item of list ?? []) {
    const group = groups.find(candidate => candidate.name === item)
    if (group !== undefined) {
      for (const toolName of group.tools) out.add(toolName)
      continue
    }
    const matcher = globToRegExp(item)
    for (const toolName of allToolNames) {
      if (matcher.test(toolName)) out.add(toolName)
    }
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
          hidden: { type: 'integer' },
        },
        required: ['name', 'tools', 'hidden'],
      },
    },
    levels: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          level: { type: 'string' },
          close: { type: 'array', items: { type: 'string' } },
          open: { type: 'array', items: { type: 'string' } },
        },
        required: ['level', 'close', 'open'],
      },
    },
  },
  required: ['ok', 'message', 'hiddenCount', 'groups', 'levels'],
}

/** 窗口级配置落盘的位置。 */
function sessionFilePath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'context-slimmer', SESSION_FILE)
}

/** 读窗口级配置；读不到就当空。 */
function loadSessionState() {
  try {
    const file = sessionFilePath()
    if (!existsSync(file)) return {}
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out = {}
    for (const [sessionId, value] of Object.entries(parsed)) {
      const layer = readLayer(value)
      if (layer !== undefined) out[sessionId] = layer
    }
    return out
  } catch {
    return {}
  }
}

/** 写窗口级配置；失败只告警。 */
function saveSessionState(state, warn) {
  try {
    const file = sessionFilePath()
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  } catch (error) {
    warn(`写入窗口级配置失败：${safeMessage(error)}`)
  }
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

  /** 窗口级配置：sessionId → { close?, open } */
  const sessionState = loadSessionState()

  /** agent → { hidden: string[], dispose?, groups, allToolNames } */
  const states = new Map()
  const busy = new WeakSet()

  const isSubagent = (agent) => {
    try { return agent?.session?.header?.origin === 'subagent' } catch { return false }
  }

  /** 把配置里的组解析成具体工具名（只匹配全局层，排除控制工具）。 */
  function resolveGroups(tools) {
    const candidates = namesOf(tools.definitions()).filter(n => n !== CONTROL_TOOL)
    return {
      allToolNames: candidates,
      groups: cfg.groups.map(group => ({
        name: group.name,
        tools: candidates.filter(n => group.matchers.some(matcher => matcher.test(n))),
      })),
    }
  }

  /** 按三级配置算出这个 agent 应该隐藏哪些工具。 */
  function computeHidden(agent, resolved) {
    const sessionId = safeSessionId(agent)
    const cwd = safeCwd(agent)
    const hidden = new Set()

    // 全局层：未写 close 时，默认收起所有已定义的组（保持 1.0 行为）
    const globalClose = cfg.close === undefined ? resolved.groups.map(group => group.name) : cfg.close
    for (const toolName of resolveNames(globalClose, resolved.groups, resolved.allToolNames)) hidden.add(toolName)
    for (const toolName of resolveNames(cfg.open, resolved.groups, resolved.allToolNames)) hidden.delete(toolName)

    // 工作区层
    const workspaceLayer = workspaceLayerFor(cfg.workspaces, cwd)
    if (workspaceLayer !== undefined) {
      for (const toolName of resolveNames(workspaceLayer.close, resolved.groups, resolved.allToolNames)) hidden.add(toolName)
      for (const toolName of resolveNames(workspaceLayer.open, resolved.groups, resolved.allToolNames)) hidden.delete(toolName)
    }

    // 窗口层
    const sessionLayer = sessionId === undefined ? undefined : sessionState[sessionId]
    if (sessionLayer !== undefined) {
      for (const toolName of resolveNames(sessionLayer.close, resolved.groups, resolved.allToolNames)) hidden.add(toolName)
      for (const toolName of resolveNames(sessionLayer.open, resolved.groups, resolved.allToolNames)) hidden.delete(toolName)
    }

    return [...hidden]
  }

  /** 重算并替换这个 agent 的 restriction。 */
  function reapply(agent, state) {
    try { state.dispose?.() } catch { /* ignore */ }
    state.dispose = undefined
    const hidden = computeHidden(agent, state)
    state.hidden = hidden
    if (hidden.length === 0) return hidden
    state.dispose = agent.ctx.tools.restrict({ deny: hidden })
    return hidden
  }

  function install(agent) {
    if (states.has(agent) || busy.has(agent)) return
    if (!agent) return
    if (!cfg.includeSubagents && isSubagent(agent)) return

    busy.add(agent)
    try {
      const tools = agent.ctx?.tools
      if (!tools || typeof tools.restrict !== 'function' || typeof tools.definitions !== 'function') {
        warn(`${agent.id}: agent.ctx.tools 不可用，跳过`)
        return
      }

      const resolved = resolveGroups(tools)

      // 匹配不到任何工具的组直接丢掉并告警，避免配置写错却静默生效
      const usable = []
      for (const group of resolved.groups) {
        if (group.tools.length === 0) {
          warn(`组 "${group.name}" 没有匹配到任何全局工具（可能名字写错了，或那个 bundle 没装）`)
          continue
        }
        usable.push(group)
      }

      const state = {
        groups: usable,
        allToolNames: resolved.allToolNames,
        hidden: [],
        dispose: undefined,
      }
      const hidden = reapply(agent, state)
      states.set(agent, state)

      if (cfg.verbose || hidden.length > 0) {
        log(`${agent.id}: 收起 ${hidden.length} 个工具（cwd=${safeCwd(agent) ?? '?'}）`)
      }
    } catch (error) {
      warn(`${agent.id}: 装配失败，该 agent 不收工具：${safeMessage(error)}`)
    } finally {
      busy.delete(agent)
    }
  }

  function release(agent) {
    const state = states.get(agent)
    if (state === undefined) return
    states.delete(agent)
    try { state.dispose?.() } catch { /* ignore */ }
  }

  function installExisting() {
    const agents = safeGet(() => ctx.get('agents'))
    if (typeof agents?.list !== 'function') return
    let existing
    try { existing = agents.list() } catch { return }
    for (const agent of existing ?? []) install(agent)
  }

  /** 当前生效的三级配置（给输出用）。 */
  function describeLevels(agent) {
    const cwd = safeCwd(agent)
    const sessionId = safeSessionId(agent)
    const workspaceLayer = workspaceLayerFor(cfg.workspaces, cwd)
    const sessionLayer = sessionId === undefined ? undefined : sessionState[sessionId]
    return [
      {
        level: 'global',
        close: cfg.close === undefined ? cfg.groups.map(group => group.name) : cfg.close,
        open: cfg.open,
      },
      {
        level: 'workspace',
        close: workspaceLayer?.close ?? [],
        open: workspaceLayer?.open ?? [],
      },
      {
        level: 'session',
        close: sessionLayer?.close ?? [],
        open: sessionLayer?.open ?? [],
      },
    ]
  }

  /** 按当前视角描述每个组有多少工具、其中多少被收起。 */
  function describeGroups(state) {
    return state.groups.map(group => ({
      name: group.name,
      tools: group.tools.length,
      hidden: group.tools.filter(toolName => state.hidden.includes(toolName)).length,
    }))
  }

  ctx.tools.register({
    name: CONTROL_TOOL,
    description:
      '管理当前会话的工具分组：查看有哪些组、各级配置（全局/工作区/窗口）分别收起了什么；'
      + '把某一组或某个工具放出/收起（只影响当前窗口，会持久化）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'open', 'close'] },
        target: { type: 'string', description: 'open / close 时要操作的对象：组名、工具名或通配符' },
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
          levels: [],
        }
      }

      const action = typeof args?.action === 'string' ? args.action : 'list'
      const target = typeof args?.target === 'string' ? args.target.trim() : ''

      if (action === 'open' || action === 'close') {
        const sessionId = safeSessionId(caller)
        if (sessionId === undefined) {
          return {
            ok: false,
            message: '拿不到当前会话 id，无法记录窗口级配置。',
            hiddenCount: state.hidden.length,
            groups: describeGroups(state),
            levels: describeLevels(caller),
          }
        }
        if (target.length === 0) {
          return {
            ok: false,
            message: '需要指定 target（组名、工具名或通配符）。',
            hiddenCount: state.hidden.length,
            groups: describeGroups(state),
            levels: describeLevels(caller),
          }
        }

        const layer = sessionState[sessionId] ?? { close: [], open: [] }
        const closeList = [...(layer.close ?? [])]
        const openList = [...(layer.open ?? [])]

        const removeFrom = (list) => {
          const index = list.indexOf(target)
          if (index >= 0) list.splice(index, 1)
        }

        if (action === 'open') {
          removeFrom(closeList)
          if (!openList.includes(target)) openList.push(target)
        } else {
          removeFrom(openList)
          if (!closeList.includes(target)) closeList.push(target)
        }

        sessionState[sessionId] = { close: closeList, open: openList }
        saveSessionState(sessionState, warn)

        const hidden = reapply(caller, state)
        return {
          ok: true,
          message: action === 'open'
            ? `本窗口已放出 "${target}"，从下一 step 起可用。`
            : `本窗口已收起 "${target}"。`,
          hiddenCount: hidden.length,
          groups: describeGroups(state),
          levels: describeLevels(caller),
        }
      }

      return {
        ok: true,
        message: `当前收起 ${state.hidden.length} 个工具。`,
        hiddenCount: state.hidden.length,
        groups: describeGroups(state),
        levels: describeLevels(caller),
      }
    },
  })

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

  if (cfg.groups.length === 0) {
    warn('没有配置任何 groups —— 本插件不会收起任何工具。'
      + '要生效请在插件配置里写至少一组，例如 groups: [{ name: browser, patterns: ["dsh_browser_*"] }]')
  } else {
    log(`已启动（${cfg.groups.length} 组，${Object.keys(cfg.workspaces).length} 个工作区覆盖，`
      + `${Object.keys(sessionState).length} 个窗口覆盖，急救开关 ${OFF_ENV}=1 可关闭）`)
  }
}

/** 安全读一个可能抛的 getter。 */
function safeGet(fn) {
  try { return fn() } catch { return undefined }
}

function safeCwd(agent) {
  try {
    const cwd = agent?.session?.header?.cwd
    return typeof cwd === 'string' ? cwd : undefined
  } catch { return undefined }
}

function safeSessionId(agent) {
  try {
    const id = agent?.session?.id ?? agent?.id
    return typeof id === 'string' && id.length > 0 ? id : undefined
  } catch { return undefined }
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

/** 输出 → 人读的文字。 */
function formatReport(value) {
  const lines = []
  lines.push(value?.message ?? '')

  const levels = Array.isArray(value?.levels) ? value.levels : []
  if (levels.length > 0) {
    lines.push('')
    lines.push('各级配置（低 → 高）：')
    for (const level of levels) {
      const close = level.close.length > 0 ? `收起 [${level.close.join(', ')}]` : '收起 —'
      const open = level.open.length > 0 ? `放出 [${level.open.join(', ')}]` : ''
      lines.push(`· ${level.level}：${close}${open ? `，${open}` : ''}`)
    }
  }

  const groups = Array.isArray(value?.groups) ? value.groups : []
  if (groups.length > 0) {
    lines.push('')
    lines.push('分组：')
    for (const group of groups) {
      const state = group.hidden === 0 ? '全部可见' : `${group.hidden}/${group.tools} 收起`
      lines.push(`· ${group.name}：${group.tools} 个工具，${state}`)
    }
  }

  if (typeof value?.hiddenCount === 'number' && value.hiddenCount > 0) {
    lines.push('')
    lines.push(`当前共收起 ${value.hiddenCount} 个工具（不在你的工具列表里）。`)
  }
  return lines.join('\n')
}
