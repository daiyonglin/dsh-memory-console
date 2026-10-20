// 忠实复刻 dsh-session/lib/types/surface.js 的 surface 折叠与校验（单测用，非插件运行时依赖）。
//
// 只实现 memory-console 会产生的 surface 形态（user/assistant/system 消息 + replace），
// 校验项与官方一致：surfaceOp marker 合法性、replace 区间存在且有序、
// sourceEventSeqs 必须引用更早事件 / 不重复 / 覆盖全部被替换节点、节点 0 系统头保护。
// 这样 fake Session 的 append 与真实 Session 一样“先校验、后提交”，写入非法事件会当场失败。

export const SURFACE_EVENT_TYPES = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

export function isSeq(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

function fail(message) {
  throw new Error(message)
}

function validateMessageShape(event) {
  const type = event.type
  const data = event.data
  const message = type === 'user/message' ? data : data?.message
  const roleByType = {
    'system/message': 'system',
    'developer/message': 'developer',
    'user/message': 'user',
    'assistant/message': 'assistant',
    'tool/result': 'tool',
  }
  if (message === null || typeof message !== 'object') fail(`session event "${type}" lacks an identified message`)
  if (typeof message.id !== 'string' || message.id === '') fail(`session event "${type}" lacks an identified message`)
  if (message.role !== roleByType[type]) fail(`session event "${type}" message must have role "${roleByType[type]}"`)
  const source = message.source
  if (source === null || typeof source !== 'object') fail(`session event "${type}" message has invalid source`)
  if (typeof source.kind !== 'string' || source.kind === '') fail(`session event "${type}" message has invalid source`)
  if (!Array.isArray(message.content)) fail(`session event "${type}" message has invalid content`)
}

function validateSourceEventSeqs(event, shadowedSeqs) {
  const raw = event.sourceEventSeqs
  if (event.type === 'assistant/message' && raw !== undefined) {
    fail('assistant/message embeds its source stream and cannot carry sourceEventSeqs')
  }
  const sources = new Set()
  if (raw !== undefined) {
    if (!Array.isArray(raw)) fail(`sourceEventSeqs on event at seq ${event.seq} must be an array when present`)
    if (raw.length === 0) fail('sourceEventSeqs must not be empty')
    for (const source of raw) {
      if (!isSeq(source)) fail(`session event "${event.type}" sourceEventSeqs must densely contain non-negative safe integers`)
      if (source >= event.seq) fail(`sourceEventSeqs must reference earlier events: ${source} >= current seq ${event.seq}`)
      sources.add(source)
    }
    if (sources.size !== raw.length) fail('sourceEventSeqs must not contain duplicates')
  }
  for (const seq of shadowedSeqs) {
    if (!sources.has(seq)) fail(`surface replace: sourceEventSeqs must include every shadowed surface node; missing ${seq}`)
  }
}

/**
 * 把一个事件折叠进 surface 节点列表，返回新列表（不修改入参）。
 * @param {number[]} nodes - 折叠前的当前 surface 节点 seq
 * @param {any} event - 完整事件（含 seq / type / data / surfaceOp / sourceEventSeqs）
 * @param {(seq:number)=>any} eventAt - 读取日志中更早事件
 * @returns {number[]}
 */
export function foldSurfaceEvent(nodes, event, eventAt) {
  if (event === null || typeof event !== 'object') fail('surface fold: event must be an object')
  if (!isSeq(event.seq)) fail(`surface fold: event seq ${String(event.seq)} is invalid`)
  const eligible = SURFACE_EVENT_TYPES.has(event.type)
  const op = event.surfaceOp
  const sources = event.sourceEventSeqs

  if (!eligible) {
    if (op !== undefined) fail(`session event "${event.type}" is not surface-eligible and cannot carry surfaceOp`)
    if (sources !== undefined) fail(`session event "${event.type}" is not surface-eligible and cannot carry sourceEventSeqs`)
    return nodes
  }

  validateMessageShape(event)
  if (op === undefined) fail(`session event "${event.type}" is surface-eligible and requires a surfaceOp marker`)

  if (op === 'append') {
    validateSourceEventSeqs(event, [])
    return [...nodes, event.seq]
  }

  if (op === null || typeof op !== 'object' || Array.isArray(op)) {
    fail(`session event "${event.type}" carries an invalid surfaceOp`)
  }
  const keys = Object.keys(op).sort()
  if (keys.length !== 3 || keys[0] !== 'endSeq' || keys[1] !== 'op' || keys[2] !== 'startSeq' || op.op !== 'replace') {
    fail(`session event "${event.type}" carries an invalid replace surfaceOp`)
  }
  if (!isSeq(op.startSeq) || !isSeq(op.endSeq)) {
    fail(`session event "${event.type}" carries an invalid replace surfaceOp`)
  }
  if (op.startSeq >= event.seq || op.endSeq >= event.seq) {
    fail(`surface replace at seq ${event.seq}: startSeq and endSeq must reference earlier events`)
  }
  const startIndex = nodes.indexOf(op.startSeq)
  const endIndex = nodes.indexOf(op.endSeq)
  if (startIndex === -1) fail(`surface replace: start seq ${op.startSeq} not found in surface`)
  if (endIndex === -1) fail(`surface replace: end seq ${op.endSeq} not found in surface`)
  if (startIndex > endIndex) {
    fail(`surface replace: start seq ${op.startSeq} (index ${startIndex}) is after end seq ${op.endSeq} (index ${endIndex})`)
  }
  const shadowedSeqs = nodes.slice(startIndex, endIndex + 1)
  validateSourceEventSeqs(event, shadowedSeqs)

  // 节点 0 若是 system/message，只允许被恰好覆盖它的 system/message 改写。
  if (startIndex === 0) {
    const head = eventAt(nodes[0])
    if (head?.type === 'system/message') {
      if (event.type !== 'system/message' || shadowedSeqs.length !== 1) {
        fail('surface replace: node 0 holds the system prompt and may be rewritten only by a system/message over exactly that node')
      }
    }
  }

  const next = [...nodes]
  next.splice(startIndex, endIndex - startIndex + 1, event.seq)
  return next
}

/**
 * 从完整事件日志重建最终 surface 节点（用于测试断言）。
 * @param {any[]} events
 * @returns {number[]}
 */
export function foldSurface(events) {
  let nodes = []
  for (const event of events) {
    nodes = foldSurfaceEvent(nodes, event, (seq) => events[seq])
  }
  return nodes
}
