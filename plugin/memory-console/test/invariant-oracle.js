// 忠实移植自 .recovery/src/dsh/node_modules/@deepseek-ai/dsh-compaction/lib/types/invariant.js
// 的 seed() replay 校验逻辑（单测 oracle，非插件运行时依赖）。
//
// 移植原因：插件运行时不需要、也不应依赖 @deepseek-ai/dsh-compaction 的内部实现，
// 但单测必须能在“没有任何第三方依赖”的前提下证明：插件产出的日志可以被官方 replay 规则接受。
// 规则逐条对应 invariant.js：validateCompactionEvent / validateOwner / validateTurnBoundary /
// validateShadowedSeqs / validateCheckpoint / inheritedOrphanStartSeqs。
import { foldSurfaceEvent } from './surface-fold.js'

function fail(message) {
  throw new Error(message)
}

function validateId(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string`)
}

function validateSeq(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    fail(`${label} must be a non-negative safe integer event seq`)
  }
  return value
}

function isCompactCheckpointSource(source) {
  return source?.kind === 'compact-checkpoint'
}

function isReplacementSurfaceEvent(event) {
  return event.surfaceOp !== undefined && event.surfaceOp !== 'append'
}

/** invariant.js 的 validateShadowedSeqs。 */
function validateShadowedSeqs(state, event) {
  const eventType = event.type
  const data = event.data ?? {}
  if (data.shadowedRange === null || typeof data.shadowedRange !== 'object') {
    fail(`${eventType} shadowedRange must be an object`)
  }
  const start = validateSeq(data.shadowedRange.start, `${eventType} shadowedRange.start`)
  const end = validateSeq(data.shadowedRange.end, `${eventType} shadowedRange.end`)
  if (!Array.isArray(data.shadowedSeqs)) fail(`${eventType} shadowedSeqs must be an array`)
  const seqs = data.shadowedSeqs.map((seq, index) => validateSeq(seq, `${eventType} shadowedSeqs[${index}]`))
  if (seqs.length === 0) fail(`${eventType} shadowedSeqs must be non-empty`)
  if (seqs[0] !== start || seqs[seqs.length - 1] !== end) {
    fail(`${eventType} shadowedRange must match the first and last shadowedSeqs`)
  }
  const surface = state.nodes
  const startIndex = surface.indexOf(start)
  const endIndex = surface.indexOf(end)
  if (startIndex < 0 || endIndex < startIndex) {
    fail(`${eventType} shadowed seqs must name an earlier current surface span`)
  }
  const expected = surface.slice(startIndex, endIndex + 1)
  if (expected.length !== seqs.length || expected.some((seq, index) => seq !== seqs[index])) {
    fail(`${eventType} shadowedSeqs must list every node in the current surface span`)
  }
}

/** invariant.js 的 validateSourceCommandId。 */
function validateSourceCommandId(eventType, value, expected) {
  if (value !== undefined) validateId(value, `${eventType} sourceCommandId`)
  if (value !== expected) {
    fail(`${eventType} sourceCommandId ${String(value)} does not match compaction/start sourceCommandId ${String(expected)}`)
  }
}

/** invariant.js 的 validateCheckpoint（compact-checkpoint user/message）。 */
function validateCheckpoint(state, source) {
  validateId(source.compactionId, 'compaction checkpoint compactionId')
  if (source.sourceCommandId !== undefined) {
    validateId(source.sourceCommandId, 'compaction checkpoint sourceCommandId')
  }
  const open = state.compaction
  if (open === undefined) fail('compaction checkpoint has no matching compaction/start')
  if (source.compactionId !== open.compactionId) {
    fail(`compaction checkpoint id ${source.compactionId} does not match compaction/start id ${open.compactionId}`)
  }
  validateSourceCommandId('compaction checkpoint', source.sourceCommandId, open.sourceCommandId)
}

/** invariant.js 的 inheritedOrphanStartSeqs。 */
function inheritedOrphanStartSeqs(events) {
  const stale = new Set()
  let openStartSeq
  for (const event of events) {
    if (event.type === 'compaction/start') {
      openStartSeq = event.seq
    } else if (event.type === 'compaction/end') {
      openStartSeq = undefined
    } else if (event.type === 'session/end-seed') {
      if (openStartSeq !== undefined) stale.add(openStartSeq)
      openStartSeq = undefined
    }
  }
  return stale
}

/** invariant.js 的 validateOwner。 */
function validateOwner(owner, openTurn, eventType) {
  if (owner === null) {
    if (openTurn !== null) fail(`${eventType} is standalone but turn ${openTurn} is open`)
    return
  }
  if (openTurn === null) fail(`${eventType} for turn ${owner} appended outside any open turn`)
  if (owner !== openTurn) fail(`${eventType} names turn ${owner} but open turn is ${openTurn}`)
}

/** invariant.js 的 validateTurnBoundary。 */
function validateTurnBoundary(state, event) {
  if ((event.type !== 'turn/start' && event.type !== 'turn/end') || state.compaction === undefined) return
  const owner = state.compaction.turn === null ? 'standalone compaction' : `compaction for turn ${state.compaction.turn}`
  fail(`${event.type} cannot cross an open ${owner}`)
}

/** invariant.js 的 applyTurnBoundary。 */
function applyTurnBoundary(state, event) {
  if (event.type === 'turn/start') {
    state.openTurn = event.data.turn
    return true
  }
  if (event.type === 'turn/end') {
    state.openTurn = null
    return true
  }
  return false
}

/** invariant.js 的 validateCompactionEvent（返回 transition 或 undefined）。 */
function validateCompactionEvent(state, event) {
  if (event.type === 'session/end-seed') return { kind: 'end-seed' }

  if (event.type === 'compaction/prune') {
    validateShadowedSeqs(state, event)
    return undefined
  }

  if (event.type === 'user/message' && isReplacementSurfaceEvent(event) && isCompactCheckpointSource(event.data?.source)) {
    validateCheckpoint(state, event.data.source)
    return undefined
  }

  if (event.type !== 'compaction/start' && event.type !== 'compaction/summary' && event.type !== 'compaction/end') {
    return undefined
  }

  const open = state.compaction
  const data = event.data ?? {}
  if (event.type === 'compaction/start') {
    validateId(data.compactionId, 'compaction/start compactionId')
    if (data.sourceCommandId !== undefined) validateId(data.sourceCommandId, 'compaction/start sourceCommandId')
    if (open !== undefined) {
      const owner = open.turn === null ? 'standalone compaction' : `turn ${open.turn}`
      fail(`compaction/start while ${owner} is still compacting`)
    }
    validateOwner(data.turn, state.openTurn, event.type)
    return {
      kind: 'start',
      compactionId: data.compactionId,
      sourceCommandId: data.sourceCommandId,
      startSeq: event.seq,
      turn: data.turn,
    }
  }

  if (event.type === 'compaction/summary') {
    validateId(data.compactionId, 'compaction/summary compactionId')
    if (data.sourceCommandId !== undefined) validateId(data.sourceCommandId, 'compaction/summary sourceCommandId')
    if (open === undefined) fail('compaction/summary has no matching compaction/start')
    if (data.compactionId !== open.compactionId) {
      fail(`compaction/summary id ${data.compactionId} does not match compaction/start id ${open.compactionId}`)
    }
    validateSourceCommandId('compaction/summary', data.sourceCommandId, open.sourceCommandId)
    validateOwner(open.turn, state.openTurn, event.type)
    if (open.summarized) fail('compaction/summary repeated within one compaction')
    validateShadowedSeqs(state, event)
    if (!Number.isSafeInteger(data.shadowedTokenCount) || data.shadowedTokenCount < 0) {
      fail('compaction/summary shadowedTokenCount must be a non-negative safe integer')
    }
    return {
      kind: 'summary',
      compactionId: open.compactionId,
      sourceCommandId: open.sourceCommandId,
      startSeq: open.startSeq,
      turn: open.turn,
    }
  }

  validateId(data.compactionId, 'compaction/end compactionId')
  if (data.sourceCommandId !== undefined) validateId(data.sourceCommandId, 'compaction/end sourceCommandId')
  if (open === undefined) fail('compaction/end has no matching compaction/start')
  if (data.compactionId !== open.compactionId) {
    fail(`compaction/end id ${data.compactionId} does not match compaction/start id ${open.compactionId}`)
  }
  validateSourceCommandId('compaction/end', data.sourceCommandId, open.sourceCommandId)
  if (data.turn !== open.turn) {
    fail(`compaction/end owner ${String(data.turn)} does not match compaction/start owner ${String(open.turn)}`)
  }
  validateOwner(open.turn, state.openTurn, event.type)
  if (data.error === undefined && !open.summarized) fail('successful compaction/end requires one compaction/summary')
  return { kind: 'end' }
}

/** invariant.js 的 applyCompactionTransition。 */
function applyCompactionTransition(transition) {
  if (transition.kind === 'start') {
    return {
      compactionId: transition.compactionId,
      sourceCommandId: transition.sourceCommandId,
      startSeq: transition.startSeq,
      turn: transition.turn,
      summarized: false,
    }
  }
  if (transition.kind === 'summary') {
    return {
      compactionId: transition.compactionId,
      sourceCommandId: transition.sourceCommandId,
      startSeq: transition.startSeq,
      turn: transition.turn,
      summarized: true,
    }
  }
  return undefined
}

/**
 * 按 invariant.js seed() 的顺序 replay 一整份事件日志。
 * @param {any[]} events - 连续 seq 的完整日志
 * @returns {{openTurn: number|null, compaction: any, nodes: number[]}} 结束状态
 * @throws 当 replay 不变量被违反时，错误消息与线上加载期报错同源。
 */
export function replayCompactionInvariants(events) {
  const state = { openTurn: null, compaction: undefined, nodes: [] }
  const staleOrphanStartSeqs = inheritedOrphanStartSeqs(events)

  for (const event of events) {
    // 与 seed() 一致：陈旧孤儿 start 不再 veto 其后的 turn 边界。
    if (state.compaction === undefined || !staleOrphanStartSeqs.has(state.compaction.startSeq)) {
      validateTurnBoundary(state, event)
    }
    const transition = validateCompactionEvent(state, event)
    if (transition !== undefined) state.compaction = applyCompactionTransition(transition)
    applyTurnBoundary(state, event)
    // SurfaceManager 的折叠（含 replace 校验）：用移植版 surface-fold。
    state.nodes = foldSurfaceEvent(state.nodes, event, (seq) => events[seq])
  }

  return state
}

/**
 * replay + 断言事务已闭合（memcon 每次写入都必须留下闭合括号）。
 * @param {any[]} events
 * @returns {{openTurn: number|null, compaction: any, nodes: number[]}}
 */
export function assertReplayClosed(events) {
  const state = replayCompactionInvariants(events)
  if (state.compaction !== undefined) {
    fail(`compaction/start at seq ${state.compaction.startSeq} has no matching compaction/end`)
  }
  return state
}
