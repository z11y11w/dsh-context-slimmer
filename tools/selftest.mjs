/**
 * tools/selftest.mjs —— 用假 ctx 跑 context-slimmer 的关键路径
 * ============================================================================
 * 不接触真实 DSH。验证：
 *   主代理装上分组 / 子代理不动 / list·open·close 正确重算 deny /
 *   空配置不生效 / 环境变量开关 / includeSubagents / 匹配不到的组告警 / 补扫
 *
 * 运行：
 *   $env:ELECTRON_RUN_AS_NODE = '1'
 *   & $env:DSH_NODE_EXECUTABLE tools\selftest.mjs
 * ============================================================================
 */
import { apply } from '../index.js'

let failures = 0
const check = (label, condition, detail) => {
  if (condition) console.log(`  ✅ ${label}`)
  else { failures += 1; console.log(`  ❌ ${label}${detail === undefined ? '' : ` → ${detail}`}`) }
}

const GLOBAL_TOOLS = [
  'read', 'write', 'pwsh', 'web_search',
  'dsh_browser_open', 'dsh_browser_snapshot', 'dsh_browser_click',
  'taskboard_list', 'taskboard_create',
  'bili_scan', 'bili_search',
]

function makeWorld(options = {}) {
  const logs = []
  const registered = []
  const restrictions = []
  const listeners = new Map()
  const toolDef = (name) => ({ name, description: name, parameters: { type: 'object', properties: {} } })

  const tools = {
    definitions(scope) {
      if (scope === undefined) return GLOBAL_TOOLS.map(toolDef)
      return GLOBAL_TOOLS.map(toolDef)
    },
    restrict(filter) {
      const rec = { filter, disposed: false }
      restrictions.push(rec)
      return () => { rec.disposed = true }
    },
    register(definition) { registered.push(definition); return () => {} },
  }

  const agents = { existing: [], list() { return this.existing } }
  const services = { tools, agents }

  const ctx = {
    logger: {
      info: (message) => logs.push(String(message)),
      warn: (message) => logs.push(`WARN ${String(message)}`),
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
      return () => {}
    },
    effect(callback) { const d = callback(); ctx.__cleanups.push(d); return d },
    get(name) { return services[name] },
    inject(_deps, callback) { callback(ctx); return () => {} },
    tools,
    __cleanups: [],
    __emit(event, payload) {
      return Promise.all((listeners.get(event) ?? []).map(h => h(payload)))
    },
  }

  return { ctx, tools, agents, logs, registered, restrictions }
}

const makeAgent = (id, options = {}) => ({
  id,
  session: { header: options.origin === undefined ? {} : { origin: options.origin } },
  // 真实的 agent.ctx 上有 tools 服务（服务注入），所以 mock 也要给
  ctx: {
    tools: options.tools,
    get: (name) => (name === 'tools' ? options.tools : undefined),
  },
})

/** 取最后一条仍然生效的 restriction。 */
const liveRestriction = (restrictions) => {
  for (let i = restrictions.length - 1; i >= 0; i -= 1) {
    if (!restrictions[i].disposed) return restrictions[i]
  }
  return undefined
}

const BROWSER_GROUP = { name: 'browser', patterns: ['dsh_browser_*'] }
const TASKBOARD_GROUP = { name: 'taskboard', patterns: ['taskboard_*'] }

async function scenario(name, config, body) {
  console.log(`\n▶ ${name}`)
  const world = makeWorld()
  try {
    apply(world.ctx, config)
    await body(world)
  } finally {
    delete process.env.DSH_CONTEXT_SLIMMER_OFF
  }
}

// ── 1. 主代理：分组被收起，核心工具不动 ────────────────────────────────────
await scenario('主代理按组收起', { groups: [BROWSER_GROUP, TASKBOARD_GROUP] }, async (world) => {
  const agent = makeAgent('main-1', { tools: world.tools })
  await world.ctx.__emit('agent/created', { agent })

  const live = liveRestriction(world.restrictions)
  check('产生了 restriction', live !== undefined)
  const deny = live?.filter?.deny ?? []
  check('浏览器工具被收起', deny.includes('dsh_browser_open') && deny.includes('dsh_browser_click'), JSON.stringify(deny))
  check('taskboard 工具被收起', deny.includes('taskboard_list'))
  check('核心工具 read/write/pwsh 没被收', !deny.includes('read') && !deny.includes('write') && !deny.includes('pwsh'))
  check('控制工具 tool_groups 没被收', !deny.includes('tool_groups'))
})

// ── 2. 子代理默认不动 ─────────────────────────────────────────────────────
await scenario('子代理默认不动', { groups: [BROWSER_GROUP] }, async (world) => {
  const agent = makeAgent('sub-1', { origin: 'subagent', tools: world.tools })
  await world.ctx.__emit('agent/created', { agent })
  check('没有产生 restriction', world.restrictions.length === 0, `实际 ${world.restrictions.length}`)
})

// ── 3. includeSubagents: true 时子代理也管 ────────────────────────────────
await scenario('includeSubagents 生效', { groups: [BROWSER_GROUP], includeSubagents: true }, async (world) => {
  const agent = makeAgent('sub-2', { origin: 'subagent', tools: world.tools })
  await world.ctx.__emit('agent/created', { agent })
  check('产生了 restriction', world.restrictions.length === 1)
})

// ── 4. list / open / close ────────────────────────────────────────────────
await scenario('tool_groups 的 list / open / close', { groups: [BROWSER_GROUP, TASKBOARD_GROUP] }, async (world) => {
  const agent = makeAgent('main-2', { tools: world.tools })
  await world.ctx.__emit('agent/created', { agent })

  const control = world.registered.find(tool => tool.name === 'tool_groups')
  check('注册了 tool_groups', control !== undefined)
  if (control === undefined) return

  const listed = await control.execute({ action: 'list' }, { agent })
  check('list 返回两组', listed.groups.length === 2, JSON.stringify(listed.groups))
  check('list 时两组都未展开', listed.groups.every(g => g.open === false))
  check('list 的 hiddenCount 正确', listed.hiddenCount === 5, JSON.stringify(listed.hiddenCount))

  const opened = await control.execute({ action: 'open', group: 'browser' }, { agent })
  check('open 成功', opened.ok === true, opened.message)
  const afterOpen = (liveRestriction(world.restrictions)?.filter?.deny ?? [])
  check('展开后浏览器工具不再被 deny', !afterOpen.includes('dsh_browser_open'), JSON.stringify(afterOpen))
  check('展开后 taskboard 仍被收着', afterOpen.includes('taskboard_list'))
  check('hiddenCount 降到 2', opened.hiddenCount === 2, JSON.stringify(opened.hiddenCount))

  const closed = await control.execute({ action: 'close', group: 'browser' }, { agent })
  check('close 成功', closed.ok === true)
  const afterClose = (liveRestriction(world.restrictions)?.filter?.deny ?? [])
  check('收起后浏览器工具又被 deny', afterClose.includes('dsh_browser_open'))

  const bad = await control.execute({ action: 'open', group: 'nope' }, { agent })
  check('打开不存在的组返回 ok:false', bad.ok === false)
})

// ── 5. 空 groups 不生效 ───────────────────────────────────────────────────
await scenario('空 groups 不生效', {}, async (world) => {
  const agent = makeAgent('main-3', { tools: world.tools })
  await world.ctx.__emit('agent/created', { agent })
  check('没有产生 restriction', world.restrictions.length === 0)
  check('日志提示没配置分组', world.logs.some(line => line.includes('没有配置任何 groups')))
})

// ── 6. 环境变量开关 ───────────────────────────────────────────────────────
{
  console.log('\n▶ 急救开关 DSH_CONTEXT_SLIMMER_OFF=1')
  process.env.DSH_CONTEXT_SLIMMER_OFF = '1'
  const world = makeWorld()
  try {
    apply(world.ctx, { groups: [BROWSER_GROUP] })
    const agent = makeAgent('main-4', { tools: world.tools })
    await world.ctx.__emit('agent/created', { agent })
    check('没有施加 restriction', world.restrictions.length === 0)
    check('没有注册 tool_groups', world.registered.length === 0)
  } finally {
    delete process.env.DSH_CONTEXT_SLIMMER_OFF
  }
}

// ── 7. 匹配不到的组要告警 ─────────────────────────────────────────────────
await scenario('匹配不到的组告警', { groups: [{ name: 'ghost', patterns: ['no_such_tool_*'] }] }, async (world) => {
  const agent = makeAgent('main-5', { tools: world.tools })
  await world.ctx.__emit('agent/created', { agent })
  check('日志里有告警', world.logs.some(line => line.includes('没有匹配到任何全局工具')))
  check('不产生空 deny 的 restriction', world.restrictions.length === 0)
})

// ── 8. openByDefault ──────────────────────────────────────────────────────
await scenario('openByDefault 开局展开', { groups: [BROWSER_GROUP], openByDefault: ['browser'] }, async (world) => {
  const agent = makeAgent('main-6', { tools: world.tools })
  await world.ctx.__emit('agent/created', { agent })
  check('浏览器组开局就可见', world.restrictions.length === 0 || !(liveRestriction(world.restrictions)?.filter?.deny ?? []).includes('dsh_browser_open'))
})

// ── 9. 补扫已存在的 agent ─────────────────────────────────────────────────
console.log('\n▶ 补扫已存在的 agent')
{
  const world = makeWorld()
  const agent = makeAgent('main-old', { tools: world.tools })
  world.agents.existing.push(agent)
  apply(world.ctx, { groups: [BROWSER_GROUP] })
  check('补扫加上了 restriction', world.restrictions.length === 1, `实际 ${world.restrictions.length}`)
}

// ── 10. disposed 撤限制 ───────────────────────────────────────────────────
await scenario('disposed 撤限制', { groups: [BROWSER_GROUP] }, async (world) => {
  const agent = makeAgent('main-7', { tools: world.tools })
  await world.ctx.__emit('agent/created', { agent })
  check('先有 restriction', world.restrictions.length === 1)
  await world.ctx.__emit('agent/disposed', { agent })
  check('disposed 后撤销', world.restrictions[0]?.disposed === true)
})

console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
