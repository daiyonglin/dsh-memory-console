// DSH compaction 事务（“括号”）写入器 + 写入前自检。
//
// 权威规则书（会话加载期 replay 会逐条校验，违反后整个会话永久无法加载）：
//   @deepseek-ai/dsh-compaction 的加载期 invariant 校验（随 DSH 安装提供）
// 官方写入顺序（dsh-compaction-basic/lib/index.js 的 compactSurfaceRegion / commitCompactionBody）：
//   compaction/start → compaction/summary → user/message(surfaceOp=replace) → compaction/end
// 必须满足（invariant.js / surface.js）：
//   1. compaction/start 最先写，compaction/summary 必须落在 start…end 之间；
//   2. 三个事件的 data.compactionId 必须一致（sourceCommandId 若出现也必须一致）；
//   3. compaction/summary.shadowedSeqs 必须逐条等于“写入那一刻 surface 上的连续片段”，
//      shadowedRange.start/end 必须等于其首尾；shadowedTokenCount 必须是非负安全整数；
//   4. 成功收尾的 compaction/end 必须已经写过一次 compaction/summary（失败收尾必须带 data.error）；
//   5. 未闭合的 compaction 括号不能跨 turn/start、turn/end；
//      standalone 事务（data.turn === null）只能写在 turn 之外；
//   6. compact-checkpoint 的 user/message 必须落在匹配的 start…end 之间，且 compactionId 一致；
//   7. surface replace 的 sourceEventSeqs 必须引用更早事件、不能重复、并覆盖全部被替换节点。
//
// 另外注意：start→summary→message→end 这一串 append 必须同步完成（中间不得 await），
// 否则别的 append（例如 turn/start）可能插进括号里，把日志写坏。
//
// 本模块的防御策略：
//   - 写之前先做完整 preflight：括号计划自洽 + 现有日志没有结构问题 → 否则一个事件都不写；
//   - 写入后对返回的四个事件再自检一遍顺序 / 类型 / compactionId / seq；
//   - 写到一半失败时，按官方的失败收尾方式补一个带 error 的 compaction/end，
//     保证日志仍是 replay-valid（append-only 日志无法真正回滚已写入的事件）。

const SURFACE_EVENT_TYPES = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

/** 事务写入失败。phase 说明失败时日志处于什么状态，供命令层给出准确提示。 */
export class CompactionBracketError extends Error {
  /**
   * @param {'preflight' | 'none' | 'closed' | 'unclosed'} phase
   *   preflight=什么都没写；none=首个事件就没写成；closed=已收尾（日志仍合法）；
   *   unclosed=事务可能留下未闭合的 compaction/start（最坏情况）。
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(phase, message, options = undefined) {
    super(message, options)
    this.name = 'CompactionBracketError'
    this.phase = phase
  }
}

/** 把错误转成可安全写入日志的 JSON 值（官方用 errorChain，这里保留最小可读信息）。 */
function describeError(error) {
  const name = typeof error?.name === 'string' ? error.name : 'Error'
  const message = typeof error?.message === 'string' ? error.message : String(error)
  return { name, message }
}

function failPreflight(message) {
  throw new CompactionBracketError('preflight', message)
}

function isSeq(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

function isSafeCount(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

function check(condition, message) {
  if (!condition) throw new Error(message)
}

/** 取当前日志快照，拿不到时返回空数组（让后续检查把问题报出来）。 */
function snapshotEvents(session) {
  try {
    const events = session.snapshotEvents()
    return Array.isArray(events) ? events : []
  } catch {
    return []
  }
}

/** 下一事件 seq：正常 Session 有 .seq getter；退化时用日志长度。 */
function nextEventSeq(session, events) {
  const value = session?.seq
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)) return value
  return events.length
}

/**
 * 只读体检：找出当前日志里会让 replay 失败、或让 compaction 事务卡死的结构问题。
 * 这是 invariant.js seed() 的“轻量版”，只覆盖括号结构（不做 surface span 逐条核对）。
 * @param {unknown[]} events
 * @returns {string[]} 人类可读的问题列表，空数组表示括号结构健康。
 */
export function auditCompactionEvents(events) {
  const issues = []
  /** @type {any} */
  let open
  let openSummarized = false
  for (const event of Array.isArray(events) ? events : []) {
    if (event === null || typeof event !== 'object') continue
    const data = event.data ?? {}
    switch (event.type) {
      case 'session/end-seed':
        // invariant.js：seed 边界会让更早的未闭合 start 变成“上一生命周期”的陈旧状态。
        open = undefined
        openSummarized = false
        break
      case 'compaction/start': {
        if (open !== undefined) {
          issues.push(`seq ${open.seq} 的 compaction/start 未闭合，又遇到 seq ${event.seq} 的 compaction/start`)
        }
        if (!isNonEmptyString(data.compactionId)) issues.push(`seq ${event.seq} 的 compaction/start 缺少非空 compactionId`)
        open = event
        openSummarized = false
        break
      }
      case 'compaction/summary': {
        if (open === undefined) {
          issues.push(
            `seq ${event.seq} 的 compaction/summary 没有匹配的 compaction/start（加载期会报 "compaction/summary has no matching compaction/start"）`,
          )
          break
        }
        if (open.data?.compactionId !== data.compactionId) {
          issues.push(`seq ${event.seq} 的 compaction/summary 的 compactionId 与 seq ${open.seq} 的 compaction/start 不一致`)
        }
        if ((data.sourceCommandId ?? undefined) !== (open.data?.sourceCommandId ?? undefined)) {
          issues.push(`seq ${event.seq} 的 compaction/summary 的 sourceCommandId 与 compaction/start 不一致`)
        }
        if (openSummarized) issues.push(`seq ${event.seq} 的 compaction/summary 在同一事务里重复出现`)
        openSummarized = true
        break
      }
      case 'compaction/end': {
        if (open === undefined) {
          issues.push(`seq ${event.seq} 的 compaction/end 没有匹配的 compaction/start`)
          break
        }
        if (open.data?.compactionId !== data.compactionId) {
          issues.push(`seq ${event.seq} 的 compaction/end 的 compactionId 与 seq ${open.seq} 的 compaction/start 不一致`)
        }
        if (data.turn !== open.data?.turn) {
          issues.push(`seq ${event.seq} 的 compaction/end 的 turn 与 compaction/start 不一致`)
        }
        if (data.error === undefined && !openSummarized) {
          issues.push(`seq ${event.seq} 的成功 compaction/end 之前缺少 compaction/summary`)
        }
        open = undefined
        openSummarized = false
        break
      }
      case 'turn/start':
      case 'turn/end': {
        if (open !== undefined) {
          issues.push(`seq ${event.seq} 的 ${event.type} 跨越了 seq ${open.seq} 未闭合的 compaction（replay 会失败）`)
        }
        break
      }
      case 'user/message': {
        const source = data.source
        if (source?.kind !== 'compact-checkpoint') break
        if (open === undefined) {
          issues.push(`seq ${event.seq} 的 compact-checkpoint user/message 没有匹配的 compaction/start`)
          break
        }
        if (open.data?.compactionId !== source.compactionId) {
          issues.push(`seq ${event.seq} 的 compact-checkpoint 的 compactionId 与 seq ${open.seq} 的 compaction/start 不一致`)
        }
        if ((source.sourceCommandId ?? undefined) !== (open.data?.sourceCommandId ?? undefined)) {
          issues.push(`seq ${event.seq} 的 compact-checkpoint 的 sourceCommandId 与 compaction/start 不一致`)
        }
        break
      }
      default:
        break
    }
  }
  if (open !== undefined) {
    issues.push(`seq ${open.seq} 的 compaction/start 没有 compaction/end（事务未闭合；再次 compaction 会被锁住）`)
  }
  return issues
}

/**
 * 只读体检：当前会话日志的 compaction 括号结构是否健康。
 * @returns {string[]} 问题列表；空数组表示健康。
 */
export function auditCompactionLog(session) {
  return auditCompactionEvents(snapshotEvents(session))
}

/**
 * 当前是否有未结束的 turn（与 invariant.js 的 openTurn 游标一致）。
 * @param {unknown[]} events
 * @returns {number | undefined | null} 打开的 turn 号；null 表示处于 turn 之外。
 */
export function openTurnOf(events) {
  for (let index = (Array.isArray(events) ? events.length : 0) - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'turn/start') return event.data?.turn
    if (event?.type === 'turn/end') return null
  }
  return null
}

/** 校验 user/message 的最基本形状（与 dsh-session 的 assertMessageEventShape 对齐）。 */
function validateReplacementMessage(replacement, compactionId, sourceCommandId) {
  if (replacement === null || typeof replacement !== 'object') failPreflight('替换消息 data 必须是对象')
  if (!isNonEmptyString(replacement.id)) failPreflight('替换消息缺少非空 id')
  if (replacement.role !== 'user') failPreflight('替换消息 role 必须是 "user"')
  if (!Array.isArray(replacement.content)) failPreflight('替换消息 content 必须是数组')
  const source = replacement.source
  if (source === null || typeof source !== 'object') failPreflight('替换消息缺少 source')
  if (!isNonEmptyString(source.kind)) failPreflight('替换消息 source.kind 必须是非空字符串')
  if (source.kind !== 'compact-checkpoint') return
  if (source.compactionId !== compactionId) {
    failPreflight('替换消息 source.compactionId 必须与本次事务的 compactionId 一致')
  }
  if ((source.sourceCommandId ?? undefined) !== (sourceCommandId ?? undefined)) {
    failPreflight('替换消息 source.sourceCommandId 必须与本次事务一致')
  }
}

/**
 * 写入前自检 + 计算计划中的 4 个事件 seq。
 * 任何一项不满足都抛 CompactionBracketError('preflight')，调用方据此“一个事件都不写”。
 * @param {any} session
 * @param {object} input - 见 writeCompactionBracket。
 * @returns {{startSeq:number,endSeq:number,shadowedSeqs:number[],sourceEventSeqs:number[],seqs:{start:number,summary:number,message:number,end:number}}}
 */
export function planCompactionBracket(session, input) {
  const {
    compactionId,
    shadowedSeqs,
    startSeq,
    endSeq,
    shadowedTokenCount,
    turn,
    replacement,
    sourceCommandId,
  } = input ?? {}

  if (session === null || session === undefined) failPreflight('当前没有可写入的会话')
  if (!isNonEmptyString(compactionId)) failPreflight('compactionId 必须是非空字符串')
  if (turn !== null) failPreflight('本插件只在空闲期（turn 之外）写入 standalone 事务，turn 必须是 null')
  if (sourceCommandId !== undefined && !isNonEmptyString(sourceCommandId)) {
    failPreflight('sourceCommandId 若存在必须是非空字符串')
  }
  if (!Array.isArray(shadowedSeqs) || shadowedSeqs.length === 0) failPreflight('shadowedSeqs 不能为空')
  shadowedSeqs.forEach((seq, index) => {
    if (!isSeq(seq)) failPreflight(`shadowedSeqs[${index}] 必须是合法的非负安全整数 seq`)
  })
  if (new Set(shadowedSeqs).size !== shadowedSeqs.length) failPreflight('shadowedSeqs 不允许重复')
  if (!isSeq(startSeq) || !isSeq(endSeq)) failPreflight('shadowedRange 的 start/end 必须是合法的非负安全整数 seq')
  if (shadowedSeqs[0] !== startSeq || shadowedSeqs[shadowedSeqs.length - 1] !== endSeq) {
    failPreflight('shadowedRange 必须等于 shadowedSeqs 的首尾')
  }
  if (!isSafeCount(shadowedTokenCount)) failPreflight('shadowedTokenCount 必须是非负安全整数')
  validateReplacementMessage(replacement, compactionId, sourceCommandId)

  // 现有日志必须没有结构问题（例如旧版本插件写下的 summary-without-start），否则继续写只会更糟。
  const issues = auditCompactionLog(session)
  if (issues.length > 0) {
    const shown = issues.slice(0, 5).map((issue) => `- ${issue}`).join('\n')
    const more = issues.length > 5 ? `\n- …共 ${issues.length} 项` : ''
    failPreflight(`会话日志已有 compaction 结构问题，拒绝继续写入（请先修复日志）：\n${shown}${more}`)
  }

  // standalone 事务只能写在 turn 之外：runMaintenance 空闲期正常为 null；否则保守拒绝。
  const openTurn = openTurnOf(snapshotEvents(session))
  if (openTurn !== null) {
    failPreflight(`当前 turn ${openTurn} 仍未结束；本插件只写 standalone（turn:null）事务，已取消。`)
  }

  // 被替换区间必须是“当前 surface 上的连续片段”，且不能覆盖受保护的系统头（surface.js 规则）。
  const nodes = Array.isArray(session.surface?.nodes) ? session.surface.nodes : []
  const startIndex = nodes.indexOf(startSeq)
  const endIndex = nodes.indexOf(endSeq)
  if (startIndex < 0 || endIndex < startIndex) {
    failPreflight(`被替换区间不在当前 surface 上（start=${startSeq}, end=${endSeq}）`)
  }
  if (endIndex - startIndex + 1 !== shadowedSeqs.length) {
    failPreflight('shadowedSeqs 必须正好覆盖 surface 上的连续区间')
  }
  for (let index = 0; index < shadowedSeqs.length; index += 1) {
    if (nodes[startIndex + index] !== shadowedSeqs[index]) {
      failPreflight('shadowedSeqs 必须逐条等于当前 surface 上的连续片段')
    }
  }
  if (startIndex === 0) {
    const head = session.eventAt(startSeq)
    if (head?.type === 'system/message') {
      failPreflight('surface 节点 0 是受保护的系统提示，不能被压缩区间覆盖')
    }
  }

  // 计划中的四个事件 seq（append 是同步的，preflight 到写入之间没有 await，不会被插队）。
  const events = snapshotEvents(session)
  const base = nextEventSeq(session, events)
  const seqs = { start: base, summary: base + 1, message: base + 2, end: base + 3 }
  const sourceEventSeqs = [seqs.start, seqs.summary, ...shadowedSeqs]
  if (sourceEventSeqs.some((seq) => seq >= seqs.message)) {
    failPreflight('surface replace 的 sourceEventSeqs 必须全部引用更早的事件')
  }
  if (new Set(sourceEventSeqs).size !== sourceEventSeqs.length) {
    failPreflight('surface replace 的 sourceEventSeqs 不允许重复')
  }

  return {
    startSeq,
    endSeq,
    shadowedSeqs: [...shadowedSeqs],
    sourceEventSeqs,
    seqs,
  }
}

/** 写入后自检一个事件：类型 / seq / compactionId / turn。 */
function assertAppendedEvent(event, expected) {
  const { type, seq, compactionId, turn, checkTurn } = expected
  if (event === null || typeof event !== 'object') throw new Error(`${type} append 没有返回事件对象`)
  if (event.type !== type) throw new Error(`${type} append 返回了 ${String(event.type)} 事件`)
  if (event.seq !== seq) throw new Error(`${type} 实际 seq ${String(event.seq)} 与计划 ${seq} 不一致`)
  if (type === 'user/message') {
    // checkpoint 才带事务身份；普通 user 消息（非本插件路径）只核对 seq。
    if (event.data?.source?.kind === 'compact-checkpoint' && event.data.source.compactionId !== compactionId) {
      throw new Error(`user/message 返回的 compactionId 与事务不一致（${String(event.data?.source?.compactionId)}）`)
    }
  } else if (event.data?.compactionId !== compactionId) {
    throw new Error(`${type} 返回的 compactionId 与事务不一致（${String(event.data?.compactionId)}）`)
  }
  if (checkTurn && event.data?.turn !== turn) {
    throw new Error(`${type} 返回的 turn ${String(event.data?.turn)} 与事务 ${String(turn)} 不一致`)
  }
}

/** 写入后自检替换消息：surfaceOp / sourceEventSeqs / checkpoint source。 */
function assertReplacementAppended(event, plan, compactionId) {
  if (event.data?.source?.kind === 'compact-checkpoint') {
    if (event.data.source.compactionId !== compactionId) {
      throw new Error('compact-checkpoint 的 compactionId 与事务不一致')
    }
  }
  const op = event.surfaceOp
  if (op === null || typeof op !== 'object' || op.op !== 'replace') {
    throw new Error('替换消息没有带 surfaceOp=replace')
  }
  if (op.startSeq !== plan.startSeq || op.endSeq !== plan.endSeq) {
    throw new Error('替换消息的 surfaceOp 区间与计划不一致')
  }
  const sources = Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : []
  for (const seq of plan.shadowedSeqs) {
    if (!sources.includes(seq)) throw new Error(`sourceEventSeqs 漏掉了被替换节点 ${seq}`)
  }
  for (const seq of sources) {
    if (!isSeq(seq) || seq >= event.seq) throw new Error(`sourceEventSeqs 中的 ${String(seq)} 不是更早的事件`)
  }
  if (new Set(sources).size !== sources.length) throw new Error('sourceEventSeqs 出现重复')
}

/**
 * 按官方顺序写入完整 compaction 括号（start → summary → 替换消息 → end），并做失败收尾。
 *
 * @param {any} session - 真实 Session（需要 append / surface / eventAt / snapshotEvents / seq）。
 * @param {object} input
 * @param {string} input.compactionId
 * @param {Array<{type:'text',text:string}>} input.summary - compaction/summary.data.summary
 * @param {number[]} input.shadowedSeqs - 被替换的 surface 节点（连续、有序）
 * @param {number} input.startSeq
 * @param {number} input.endSeq
 * @param {number} input.shadowedTokenCount
 * @param {string} input.provider
 * @param {string} input.model
 * @param {object} input.replacement - 替换用的 user/message data（checkpoint 时 source.kind='compact-checkpoint'）
 * @param {string} [input.sourceCommandId] - 可选；出现时四个事件必须一致
 * @returns {{compactionId:string,startEvent:any,summaryEvent:any,messageEvent:any,endEvent:any}}
 */
export function writeCompactionBracket(session, input) {
  const plan = planCompactionBracket(session, input)
  const { compactionId, sourceCommandId, turn } = input
  const lifecycle = sourceCommandId === undefined
    ? { compactionId, turn }
    : { compactionId, sourceCommandId, turn }

  let startEvent
  try {
    startEvent = session.append('compaction/start', lifecycle)
  } catch (failure) {
    throw new CompactionBracketError('none', `compaction/start 写入失败（未写入任何事件）：${describeError(failure).message}`, {
      cause: failure,
    })
  }

  let closing = false
  let closed = false
  try {
    assertAppendedEvent(startEvent, {
      type: 'compaction/start',
      seq: plan.seqs.start,
      compactionId,
      turn,
      checkTurn: true,
    })

    const summaryEvent = session.append('compaction/summary', {
      compactionId,
      ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
      summary: input.summary,
      shadowedRange: { start: plan.startSeq, end: plan.endSeq },
      shadowedSeqs: [...plan.shadowedSeqs],
      shadowedTokenCount: input.shadowedTokenCount,
      provider: input.provider,
      model: input.model,
    })
    assertAppendedEvent(summaryEvent, {
      type: 'compaction/summary',
      seq: plan.seqs.summary,
      compactionId,
      checkTurn: false,
    })
    if (summaryEvent.data?.shadowedTokenCount !== input.shadowedTokenCount) {
      throw new Error('compaction/summary 返回的 shadowedTokenCount 与计划不一致')
    }

    const messageEvent = session.append('user/message', input.replacement, {
      surfaceOp: { op: 'replace', startSeq: plan.startSeq, endSeq: plan.endSeq },
      sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...plan.shadowedSeqs],
    })
    assertAppendedEvent(messageEvent, {
      type: 'user/message',
      seq: plan.seqs.message,
      compactionId,
      checkTurn: false,
    })
    assertReplacementAppended(messageEvent, plan, compactionId)

    // 与官方一致：end 写入前先把 closing 标记置位——end 自身失败时不再尝试第二次收尾。
    closing = true
    const endEvent = session.append('compaction/end', lifecycle)
    closed = true
    assertAppendedEvent(endEvent, {
      type: 'compaction/end',
      seq: plan.seqs.end,
      compactionId,
      turn,
      checkTurn: true,
    })

    return { compactionId, startEvent, summaryEvent, messageEvent, endEvent }
  } catch (failure) {
    const detail = describeError(failure).message
    if (!closing) {
      // 事务写到一半：按官方失败收尾方式补一个带 error 的 end，避免留下未闭合的 start。
      try {
        session.append('compaction/end', { ...lifecycle, error: describeError(failure) })
        closed = true
      } catch (closeFailure) {
        throw new CompactionBracketError(
          'unclosed',
          `compaction 事务写到一半失败，且收尾的 compaction/end 也写入失败：seq ${String(startEvent?.seq)} 的 compaction/start 可能仍未闭合。\n原因：${detail}；收尾失败：${describeError(closeFailure).message}`,
          { cause: failure },
        )
      }
      throw new CompactionBracketError(
        'closed',
        `compaction 事务写到一半失败，已补写带 error 的 compaction/end 收尾，日志仍可正常加载。\n原因：${detail}`,
        { cause: failure },
      )
    }
    throw new CompactionBracketError(
      closed ? 'closed' : 'unclosed',
      closed
        ? `事务已闭合，但写入后自检失败：${detail}（日志结构应仍合法，请用 /mem status 核对）`
        : `compaction/end 写入失败，事务可能未闭合：${detail}`,
      { cause: failure },
    )
  }
}

/** 把写入失败翻译成给用户看的说明。 */
export function describeBracketFailure(error) {
  if (error instanceof CompactionBracketError) {
    switch (error.phase) {
      case 'preflight':
        return `已取消，未写入任何事件。\n${error.message}`
      case 'none':
        return error.message
      case 'closed':
        return error.message
      case 'unclosed':
        return `严重：${error.message}\n请立即重启会话验证能否加载，并用 /mem diag 检查；不要继续写入。`
      default:
        break
    }
  }
  return `写入失败：${String(error?.message ?? error)}`
}
