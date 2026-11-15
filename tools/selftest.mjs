/**
 * tools/selftest.mjs —— 用假 ctx 跑 context-slimmer 的关键路径
 * ============================================================================
 * 不接触真实 DSH。覆盖：
 *   · 主代理按组收起 / 子代理不动 / includeSubagents
 *   · list / open / close（窗口级，落盘）
 *   · 三级合并（全局 close → 工作区 open → 窗口 close/open）
 *   · 空配置 / 环境变量开关 / 匹配不到的组告警 / 补扫 / disposed 回收
 *
 * 运行：
 *   $env:ELECTRON_RUN_AS_NODE = '1'
 *   & $env:DSH_NODE_EXECUTABLE tools\selftest.mjs
 * ============================================================================
 */
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// 让窗口级配置落到临时目录，别碰真实的 ~/.dsh
const TMP_HOME = 'E:/working/_slimmer_test_home'
process.env.DSH_HOME = TMP_HOME
if (existsSync(TMP_HOME)) rmSync(TMP_HOME, { recursive: true, force: true })
mkdirSync(TMP_HOME, { recursive: true })

const SESSION_FILE = join(TMP_HOME, 'context-slimmer', 'sessions.json')

const { apply } = await import('../index.js')

let failures = 0
const check = (label, condition, detail) => {
  if (condition) console.log(`  ✅ ${label}`)
  else { failures += 1; console.log(`  ❌ ${label}${detail === undefined ? '' : ` → ${detail}`}`) }
}

const GLOBAL_TOOLS = [
  'read', 'write', 'pwsh', 'web_search',
  'dsh_browser_open', 'dsh_browser_snapshot', 'dsh_browser_click',
  'taskboard_list', 'taskboard_create',
  'search_topic', 'search_queries',
]

function makeWorld(options = {}) {
  const logs = []
  const registered = []
  const restrictions = []
  const listeners = new Map()
  const toolDef = (name) => ({ name, description: name, parameters: { type: 'object', properties: {} } })
  const toolsList = options.tools ?? GLOBAL_TOOLS

  const tools = {
    definitions(scope) {
      if (scope === undefined) return toolsList.map(toolDef)
      return toolsList.map(toolDef)
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
  session: {
    id,
    header: {
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    },
  },
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

const denyOf = (restrictions) => liveRestriction(restrictions)?.filter?.deny ?? []
const sorted = (list) => [...list].sort().join(',')

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

// ── 1. 主代理：定义了组就收起（1.0 行为保持）──────────────────────────────
await scenario('主代理按组收起', { groups: [BROWSER_GROUP, TASKBOARD_GROUP] }, async (world) => {
  const agent = makeAgent('main-1', { tools: world.tools })
  await world.ctx.__emit('agent/created', { agent })
  const deny = denyOf(world.restrictions)
  check('浏览器工具被收起', deny.includes('dsh_browser_open') && deny.includes('dsh_browser_click'), sorted(deny))
  check('taskboard 工具被收起', deny.includes('taskboard_list'))
  check('核心工具没被收', !deny.includes('read') && !deny.includes('pwsh'))
  check('控制工具没被收', !deny.includes('tool_groups'))
})

// ── 2. 子代理默认不动 ─────────────────────────────────────────────────────
await scenario('子代理默认不动', { groups: [BROWSER_GROUP] }, async (world) => {
  const agent = makeAgent('sub-1', { origin: 'subagent', tools: world.tools })
  await world.ctx.__emit('agent/created', { agent })
  check('没有产生 restriction', world.restrictions.length === 0, `实际 ${world.restrictions.length}`)
})

// ── 3. includeSubagents ───────────────────────────────────────────────────
await scenario('includeSubagents 生效', { groups: [BROWSER_GROUP], includeSubagents: true }, async (world) => {
  const agent = makeAgent('sub-2', { origin: 'subagent', tools: world.tools })
  await world.ctx.__emit('agent/created', { agent })
  check('产生了 restriction', world.restrictions.length === 1)
})

// ── 4. 窗口级 open / close（落盘）─────────────────────────────────────────
await scenario('窗口级 open / close', { groups: [BROWSER_GROUP, TASKBOARD_GROUP] }, async (world) => {
  const agent = makeAgent('main-2', { cwd: 'E:/ws-a', tools: world.tools })
  await world.ctx.__emit('agent/created', { agent })

  const control = world.registered.find(tool => tool.name === 'tool_groups')
  check('注册了 tool_groups', control !== undefined)
  if (control === undefined) return

  const listed = await control.execute({ action: 'list' }, { agent })
  check('list 返回两组', listed.groups.length === 2, JSON.stringify(listed.groups))
  check('list 返回三级配置', listed.levels.length === 3, JSON.stringify(listed.levels))

  const opened = await control.execute({ action: 'open', target: 'browser' }, { agent })
  check('open 成功', opened.ok === true, opened.message)
  check('展开后浏览器工具不再被 deny', !denyOf(world.restrictions).includes('dsh_browser_open'), sorted(denyOf(world.restrictions)))
  check('taskboard 仍被收着', denyOf(world.restrictions).includes('taskboard_list'))

  check('窗口级配置已落盘', existsSync(SESSION_FILE), SESSION_FILE)
  if (existsSync(SESSION_FILE)) {
    const saved = JSON.parse(readFileSync(SESSION_FILE, 'utf8'))
    check('落盘内容包含该会话的 open', JSON.stringify(saved['main-2']?.open ?? []) === JSON.stringify(['browser']), JSON.stringify(saved))
  }

  const closed = await control.execute({ action: 'close', target: 'browser' }, { agent })
  check('close 成功', closed.ok === true)
  check('收起后又 deny', denyOf(world.restrictions).includes('dsh_browser_open'))
})

// ── 5. 三级合并（用户给的例子）────────────────────────────────────────────
{
  console.log('\n▶ 三级合并：全局 close{a,b,c} → 工作区 open{b} → 窗口 close{d} open{c}')
  // 窗口级配置先落盘
  mkdirSync(join(TMP_HOME, 'context-slimmer'), { recursive: true })
  writeFileSync(SESSION_FILE, JSON.stringify({ 'main-3': { close: ['d'], open: ['c'] } }, null, 2), 'utf8')

  const world = makeWorld({ tools: ['a', 'b', 'c', 'd', 'e'] })
  apply(world.ctx, {
    groups: [{ name: 'all', patterns: ['*'] }],
    close: ['a', 'b', 'c'],
    workspaces: { 'E:/ws-b': { open: ['b'] } },
  })
  const agent = makeAgent('main-3', { cwd: 'E:/ws-b', tools: world.tools })
  await world.ctx.__emit('agent/created', { agent })

  const deny = denyOf(world.restrictions)
  check('a 被收起（全局 close）', deny.includes('a'), sorted(deny))
  check('b 可见（工作区 open 覆盖全局 close）', !deny.includes('b'), sorted(deny))
  check('c 可见（窗口 open 覆盖全局 close）', !deny.includes('c'), sorted(deny))
  check('d 被收起（窗口 close）', deny.includes('d'), sorted(deny))
  check('e 可见（三级都没提）', !deny.includes('e'), sorted(deny))
  check('最终只有 a、d 被收起', sorted(deny) === 'a,d', sorted(deny))
}

// ── 6. 空 groups 不生效 ───────────────────────────────────────────────────
await scenario('空 groups 不生效', {}, async (world) => {
  const agent = makeAgent('main-4', { tools: world.tools })
  await world.ctx.__emit('agent/created', { agent })
  check('没有产生 restriction', world.restrictions.length === 0)
  check('日志提示没配置分组', world.logs.some(line => line.includes('没有配置任何 groups')))
})

// ── 7. 环境变量开关 ───────────────────────────────────────────────────────
{
  console.log('\n▶ 急救开关 DSH_CONTEXT_SLIMMER_OFF=1')
  process.env.DSH_CONTEXT_SLIMMER_OFF = '1'
  const world = makeWorld()
  try {
    apply(world.ctx, { groups: [BROWSER_GROUP] })
    const agent = makeAgent('main-5', { tools: world.tools })
    await world.ctx.__emit('agent/created', { agent })
    check('没有施加 restriction', world.restrictions.length === 0)
    check('没有注册 tool_groups', world.registered.length === 0)
  } finally {
    delete process.env.DSH_CONTEXT_SLIMMER_OFF
  }
}

// ── 8. 匹配不到的组告警 ───────────────────────────────────────────────────
await scenario('匹配不到的组告警', { groups: [{ name: 'ghost', patterns: ['no_such_tool_*'] }] }, async (world) => {
  const agent = makeAgent('main-6', { tools: world.tools })
  await world.ctx.__emit('agent/created', { agent })
  check('日志里有告警', world.logs.some(line => line.includes('没有匹配到任何全局工具')))
  check('不产生空 deny 的 restriction', world.restrictions.length === 0)
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

// ── 收尾 ─────────────────────────────────────────────────────────────────
rmSync(TMP_HOME, { recursive: true, force: true })
console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
