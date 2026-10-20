import { collectPhases, isFoldable, isSystemPhase, MIN_FOLD_TOKENS } from './phases.js'
import { dryrunText, findBlocks, isBlockOnSurface, restore, surgery, surgeryMany } from './surgery.js'
import { fmt } from './text.js'

export const RPC_ROUTE = '/api/memory-console'

/**
 * 面板数据通道：注册一个 POST HTTP 路由（与 dsh-context 相同做法）。
 * 请求体 { endpoint, payload }；响应 { ok, value } | { ok:false, error }。
 */
export function registerRpc(ctx) {
  ctx.inject(['connection'], (c) => {
    const connection = c.get('connection')
    const register = connection?.fetch?.register
    if (typeof register !== 'function') {
      console.warn('memory-console: 当前宿主没有 connection.fetch，右侧栏面板不可用（命令仍可用）')
      return
    }
    const bound = register.bind(connection.fetch)
    const handler = async (request) => {
      let body
      try {
        body = await request.json()
      } catch {
        return reply({ ok: false, error: { code: 'bad-request', message: 'body 不是 JSON', details: {} } })
      }
      const endpoint = typeof body?.endpoint === 'string' ? body.endpoint : ''
      const payload = body?.payload !== null && typeof body?.payload === 'object' ? body.payload : {}
      return reply(await handleRpc(ctx, endpoint, payload))
    }
    c.effect(
      () => bound({ path: RPC_ROUTE, methods: ['POST'], requestBody: 'buffered', fetch: handler }),
      'memory-console: panel route',
    )
  })
}

function reply(value) {
  return Response.json(value, { headers: { 'cache-control': 'no-store' } })
}

async function handleRpc(ctx, endpoint, payload) {
  try {
    const sessionId = String(payload.sessionId ?? '')
    if (endpoint === 'sessions') return { ok: true, value: await listSessions(ctx) }
    if (endpoint === 'snapshot') return { ok: true, value: snapshotFor(ctx, sessionId) }
    if (endpoint === 'act') {
      const agent = ctx.agents.get(sessionId)
      if (agent === undefined || agent === null) return rpcFail('no-agent', '会话未打开，无法执行操作')
      const action = String(payload.action ?? '')
      if (action === 'fold' || action === 'remove') {
        if (payload.confirm !== true) return { ok: true, value: { preview: dryrunText(ctx, agent, payload.phaseIndex) } }
        const result = await surgery(ctx, agent, payload.phaseIndex, action, true)
        return result.kind === 'success' ? { ok: true, value: { text: result.text } } : rpcFail('action-failed', result.text)
      }
      if (action === 'restore') {
        const result = await restore(ctx, agent, String(payload.compactionId ?? ''))
        return result.kind === 'success' ? { ok: true, value: { text: result.text } } : rpcFail('action-failed', result.text)
      }
      if (action === 'foldMany') {
        if (payload.confirm !== true) return rpcFail('confirm-required', '批量收起需要确认')
        const result = await surgeryMany(ctx, agent, payload.phaseIndexes, 'fold')
        return result.kind === 'success' ? { ok: true, value: { text: result.text } } : rpcFail('action-failed', result.text)
      }
      return rpcFail('bad-action', `unknown action ${action}`)
    }
    return rpcFail('unknown-endpoint', `unknown endpoint ${endpoint}`)
  } catch (error) {
    return rpcFail('error', String(error?.message ?? error))
  }
}

function rpcFail(code, message) {
  return { ok: false, error: { code, message, details: {} } }
}

function sessionTitle(session) {
  try {
    const events = session.snapshotEvents()
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type !== 'session/title') continue
      const title = event.data?.title
      if (typeof title === 'string' && title.trim() !== '') return title.trim()
    }
  } catch {
    /* 标题只是展示信息，失败时回退到 cwd */
  }
  const cwd = session.header?.cwd
  if (typeof cwd === 'string' && cwd !== '') {
    const parts = cwd.split(/[\\/]/).filter(Boolean)
    if (parts.length > 0) return parts[parts.length - 1]
  }
  return String(session.id).slice(0, 8)
}

function fallbackTitle(header) {
  const cwd = header?.cwd
  if (typeof cwd === 'string' && cwd !== '') {
    const parts = cwd.split(/[\\/]/).filter(Boolean)
    if (parts.length > 0) return parts[parts.length - 1]
  }
  return String(header?.id ?? '').slice(0, 8)
}

function isSubagentHeader(header) {
  return header?.origin === 'subagent' || (header?.parentSession !== undefined && header?.parentSession !== null)
}

async function listSessions(ctx) {
  const liveAgents = typeof ctx.agents?.list === 'function' ? ctx.agents.list() : []
  const liveIds = new Set()
  const items = []
  for (const agent of liveAgents.slice(0, 50)) {
    const session = agent.session
    const id = String(session.id)
    liveIds.add(id)
    // 编队/子代理会话不进入记忆中心（避免一次 team 跑出几十条会话）。
    if (isSubagentHeader(session.header)) continue
    let tokens = 0
    try {
      tokens = Number(ctx.tokenMeter.measure(session).totalTokens) || 0
    } catch {
      tokens = 0
    }
    let phaseCount = 0
    try {
      phaseCount = collectPhases(ctx, session).phases.length
    } catch {
      phaseCount = 0
    }
    items.push({
      id,
      title: sessionTitle(session),
      tokens,
      phases: phaseCount,
      cwd: session.header?.cwd ?? '',
      origin: session.header?.origin ?? 'user',
      parent: session.header?.parentSession ? String(session.header.parentSession) : '',
      live: true,
    })
  }

  // 冷会话：只列出，不打开；点击后由面板提示“会话未打开”。
  const query = typeof ctx.get === 'function' ? ctx.get('sessionQuery') : undefined
  if (query !== undefined && query !== null && typeof query.listSessions === 'function') {
    let records = []
    try {
      records = await query.listSessions()
    } catch {
      records = []
    }
    const extra = Array.isArray(records)
      ? records
          .filter((record) => !liveIds.has(String(record.header?.id)) && !isSubagentHeader(record.header))
          .slice(0, 20)
      : []
    if (extra.length > 0) {
      let titles = []
      if (typeof query.readTitleSnapshots === 'function') {
        try {
          titles = await query.readTitleSnapshots(extra.map((record) => record.header.id))
        } catch {
          titles = []
        }
      }
      const titleById = new Map(
        (Array.isArray(titles) ? titles : [])
          .filter((entry) => entry?.status === 'fulfilled')
          .map((entry) => [String(entry.sessionId), entry.value?.title?.title ?? '']),
      )
      for (const record of extra) {
        const id = String(record.header?.id ?? '')
        items.push({
          id,
          title: titleById.get(id) || fallbackTitle(record.header),
          tokens: 0,
          phases: 0,
          cwd: record.header?.cwd ?? '',
          origin: record.header?.origin ?? 'user',
          parent: record.header?.parentSession ? String(record.header.parentSession) : '',
          live: record.live === true,
        })
      }
    }
  }
  return items
}

function snapshotFor(ctx, sessionId) {
  const agent = ctx.agents.get(sessionId)
  if (agent === undefined || agent === null) throw new Error('会话未打开（冷会话不支持管理）')
  const session = agent.session
  const { nodes, phases, totalTokens } = collectPhases(ctx, session)
  const blocks = findBlocks(session).map((block) => {
    const summaryText = Array.isArray(block.summary)
      ? block.summary
          .filter((part) => part?.type === 'text' && typeof part.text === 'string')
          .map((part) => part.text)
          .join('\n')
      : ''
    return {
      id: block.compactionId,
      start: block.shadowedRange?.start,
      end: block.shadowedRange?.end,
      tokens: block.shadowedTokenCount,
      onSurface: isBlockOnSurface(session, block.compactionId),
      summary: summaryText.slice(0, 4000),
    }
  })
  const summaryById = new Map(blocks.map((block) => [block.id, block.summary]))
  const activeBlocks = blocks.filter((block) => block.onSurface)
  const stats = {
    foldedTokens: activeBlocks.reduce((sum, block) => sum + (Number(block.tokens) || 0), 0),
    foldedCount: activeBlocks.length,
    totalBlocks: blocks.length,
    taskCount: phases.filter((phase) => phase.kind === 'task').length,
    systemTokens: phases.filter((phase) => phase.kind === 'system').reduce((sum, phase) => sum + phase.tokens, 0),
  }
  const foldable = phases.filter(isFoldable)
  const reclaimable = foldable.reduce((sum, phase) => sum + phase.tokens, 0)
  const suggestions = foldable
    .filter((phase) => phase.index <= phases.length - 3)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 5)
    .map((phase) => ({
      phaseIndex: phase.index,
      title: phase.title,
      tokens: phase.tokens,
      reason: `较早（第 ${phase.index}/${phases.length} 段）· 占 ${Math.round((phase.tokens / Math.max(1, totalTokens)) * 100)}%`,
    }))
  const categories = phases.reduce(
    (acc, phase) => {
      for (const key of Object.keys(acc)) acc[key] += Number(phase.cat?.[key] ?? 0)
      return acc
    },
    { system: 0, user: 0, assistant: 0, tool: 0, injection: 0, folded: 0 },
  )
  let running = 0
  const history = phases.map((phase) => {
    running += phase.tokens
    return { index: phase.index, tokens: phase.tokens, cumulative: running, kind: phase.kind }
  })
  const originTotal = totalTokens + stats.foldedTokens
  const headerConfig = session.requestHeader?.()?.config ?? {}
  const limit = 1_048_576
  const outputReserve = Number(headerConfig.maxTokens) > 0 ? Number(headerConfig.maxTokens) : 256_000
  const headroom = 65_536
  const threshold = Math.max(1, Math.floor(Math.min(limit * 0.8, limit - outputReserve - headroom)))
  const pressure = { used: totalTokens, limit, outputReserve, headroom, threshold }

  return {
    sessionId,
    totalTokens,
    originTotal,
    nodeCount: nodes.length,
    reclaimable,
    minFoldTokens: MIN_FOLD_TOKENS,
    stats,
    suggestions,
    categories,
    history,
    pressure,
    phases: phases.map((phase) => ({
      index: phase.index,
      kind: phase.kind,
      title: phase.title,
      tokens: phase.tokens,
      cat: phase.cat,
      tools: phase.tools,
      assistants: phase.assistants,
      notices: phase.notices,
      injections: phase.injections,
      nodes: phase.nodes.length,
      checkpoint: phase.isCheckpoint,
      compactionId: phase.compactionId,
      summaryPreview: phase.isCheckpoint ? summaryById.get(phase.compactionId) ?? '' : '',
      foldable: isFoldable(phase),
      system: isSystemPhase(phase),
      reason: phase.isCheckpoint
        ? '已收起'
        : isSystemPhase(phase)
          ? '系统提示不可收起'
          : phase.kind !== 'task'
            ? '不是任务阶段'
            : phase.tokens < MIN_FOLD_TOKENS
              ? `太小（<${fmt(MIN_FOLD_TOKENS)}）`
              : '',
    })),
    blocks,
  }
}
