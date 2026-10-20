import {
  deriveMessage,
  err,
  estimate,
  estimateText,
  frameSummary,
  fmt,
  ok,
  randomId,
  renderFoldSummary,
  renderRemovePlaceholder,
  summaryBudget,
} from './text.js'
import { collectPhases, hasToolCalls, isCheckpointEvent, isFoldable, MIN_FOLD_TOKENS, phaseByNumber } from './phases.js'
import { auditCompactionLog, describeBracketFailure, writeCompactionBracket } from './compaction.js'

export const ID_PREFIX = 'memory-console-'
const RESTORE_MAX_CHARS = 200_000

export function findBlocks(session) {
  try {
    return session
      .snapshotEvents()
      .filter((event) => event.type === 'compaction/summary' && String(event.data?.compactionId ?? '').startsWith(ID_PREFIX))
      .map((event) => ({ ...event.data, seq: event.seq }))
  } catch {
    return []
  }
}

export function isBlockOnSurface(session, compactionId) {
  const nodes = session.surface?.nodes ?? []
  return nodes.some((seq) => {
    const event = session.eventAt(seq)
    return isCheckpointEvent(event) && event.data?.source?.compactionId === compactionId
  })
}

export function reconstruct(session, seqs) {
  const parts = []
  for (const seq of Array.isArray(seqs) ? seqs : []) {
    const event = session.eventAt(seq)
    if (event === null || event === undefined) continue
    const message = deriveMessage(session, event)
    if (message === null) continue
    const text = message.content
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n')
    if (text.trim() !== '') parts.push(text)
  }
  return parts.join('\n\n---\n\n')
}

export async function surgery(ctx, agent, raw, mode, confirmed) {
  const plan = phaseByNumber(ctx, agent, raw)
  if (!confirmed) {
    return err(`这是写入操作，需要显式确认。\n\n${dryrunText(ctx, agent, raw)}\n\n确认后运行：/mem ${mode} ${plan.phase.index} --yes`)
  }
  if (!plan.phase.isCheckpoint && plan.phase.tokens < MIN_FOLD_TOKENS) {
    return err(
      `这一阶段只有 ≈${fmt(plan.phase.tokens)} tokens，太小：收起摘要（≈${fmt(summaryBudget(plan.phase.tokens))} tokens）反而可能比原文更大。\n` +
        `请选择 ≥${fmt(MIN_FOLD_TOKENS)} tokens 的阶段（/mem report 里 token 数大的那些）。`,
    )
  }
  if (typeof agent.runMaintenance !== 'function') return err('当前 agent 不支持空闲预约（runMaintenance），已放弃。')

  try {
    return await agent.runMaintenance(async () => foldNow(ctx, agent, raw, mode))
  } catch (error) {
    return err(`收起失败：${String(error?.message ?? error)}`)
  }
}

/**
 * 多选批量收起：逐段（从后往前）各自写一次独立的 compaction 事务。
 * 每段仍然满足与单段收起相同的 preflight / 括号 / 收尾约束。
 */
export async function surgeryMany(ctx, agent, indexes, mode = 'fold') {
  const list = [...new Set(
    (Array.isArray(indexes) ? indexes : [])
      .map((value) => Number.parseInt(String(value), 10))
      .filter((value) => Number.isFinite(value)),
  )]
  if (list.length === 0) return err('没有选择任何阶段。')
  const session = agent?.session
  if (session === undefined || session === null) return err('当前没有可读取的会话。')
  const { phases } = collectPhases(ctx, session)
  const chosen = []
  for (const index of list) {
    const phase = phases.find((item) => item.index === index)
    if (phase === undefined) return err(`没有第 ${index} 阶段。`)
    if (!isFoldable(phase)) {
      return err(
        `阶段 ${index}「${phase.title}」不可收起（${phase.kind !== 'task' ? '不是任务阶段' : `只有 ${fmt(phase.tokens)} tokens，太小`}）。`,
      )
    }
    chosen.push(phase)
  }
  const total = chosen.reduce((sum, phase) => sum + phase.tokens, 0)
  if (typeof agent.runMaintenance !== 'function') return err('当前 agent 不支持空闲预约（runMaintenance），已放弃。')
  return agent.runMaintenance(async () => {
    let done = 0
    // 从后往前收起：先处理靠后的阶段，前面的阶段号不会因 surface 变化而失效。
    for (const phase of [...chosen].sort((a, b) => b.index - a.index)) {
      const result = foldNow(ctx, agent, String(phase.index), mode)
      if (result.kind !== 'success') {
        return err(`批量收起中途停止：第 ${phase.index} 段失败（已完成 ${done} 段）。\n${result.text}`)
      }
      done += 1
    }
    return ok(
      `✅ 已收起 ${done} 个任务阶段（合计约 ${fmt(total)} tokens → 摘要）。\n聊天里会出现 ${done} 条“上下文已压缩”折叠行；原文均可恢复。`,
    )
  })
}

/**
 * 在 runMaintenance 的空闲窗口里执行一次收起/移出。
 * 注意：本函数必须保持同步（内部不能 await）——compaction 括号必须在同一个同步块里写完，
 * 否则 turn/start 等事件可能插进 start…end 之间。
 * @param {any} ctx
 * @param {any} agent
 * @param {string} raw - 阶段号
 * @param {'fold' | 'remove'} mode
 * @returns {{kind:'success'|'error', text:string}}
 */
function foldNow(ctx, agent, raw, mode) {
  const fresh = phaseByNumber(ctx, agent, raw)
  const { session, nodes, phase } = fresh
  const startSeq = nodes[fresh.startIndex]
  const endSeq = nodes[fresh.endIndex]
  const startEvent = session.eventAt(startSeq)
  const endEvent = session.eventAt(endSeq)

  if (startEvent?.type !== 'user/message')
    return err('拒绝对“系统提示”或非用户消息开头的区间做手术（system 头不能被折叠）。')
  if (endEvent?.type === 'assistant/message') {
    const message = deriveMessage(session, endEvent)
    if (hasToolCalls(message)) return err('区间尾部是未完成的工具调用，已放弃（避免切开 tool-call/result 配对）。')
  }

  const shadowedSeqs = nodes.slice(fresh.startIndex, fresh.endIndex + 1)
  let shadowedTokenCount = 0
  for (const seq of shadowedSeqs) {
    const event = session.eventAt(seq)
    if (event === null || event === undefined) continue
    const message = deriveMessage(session, event)
    if (message !== null) shadowedTokenCount += estimate(ctx, message)
  }
  // invariant.js 要求 shadowedTokenCount 是非负安全整数。
  shadowedTokenCount = Math.max(0, Math.round(shadowedTokenCount))

  const text = mode === 'fold' ? renderFoldSummary(phase) : renderRemovePlaceholder(phase)
  const summaryTokens = estimateText(ctx, text)
  if (summaryTokens >= shadowedTokenCount)
    return err(`摘要（${fmt(summaryTokens)}）不小于被替换内容（${fmt(shadowedTokenCount)}），已放弃。请选择更大的阶段。`)

  const header = session.requestHeader?.()
  const compactionId = `${ID_PREFIX}${mode}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  // 两种模式都用官方 compact-checkpoint source：replay 时它必须落在本事务 start…end 之间，
  // 同时 /mem restore 也靠它认出“这段历史被哪个 compaction 替换了”。
  const message = {
    id: randomId(),
    role: 'user',
    content: [{ type: 'text', text: mode === 'fold' ? frameSummary(text) : text }],
    source: { kind: 'compact-checkpoint', compactionId },
  }

  try {
    // 官方顺序（dsh-compaction-basic commitCompactionBody）：
    //   compaction/start → compaction/summary → 替换消息 → compaction/end。
    writeCompactionBracket(session, {
      compactionId,
      summary: [{ type: 'text', text }],
      shadowedSeqs,
      startSeq,
      endSeq,
      shadowedTokenCount,
      // runMaintenance 是空闲期（turn 之外）的独占窗口，因此这是 standalone 事务。
      // 写入前 compaction.js 还会核对日志里确实没有打开的 turn，否则拒绝写入。
      turn: null,
      provider: header?.config?.provider ?? 'unknown',
      model: header?.config?.model ?? 'unknown',
      replacement: message,
    })
  } catch (error) {
    return err(describeBracketFailure(error))
  }

  return ok(
    [
      `${mode === 'fold' ? '✅ 已收起' : '✅ 已移出'} · 阶段 ${phase.index}「${phase.title}」`,
      `${fmt(shadowedTokenCount)} → ${fmt(summaryTokens)} tokens（省 ${fmt(Math.max(0, shadowedTokenCount - summaryTokens))}）`,
      mode === 'fold' ? '聊天里会出现官方“上下文已压缩”折叠行；原文仍保留。' : '模型已看不到原文；聊天记录仍保留。',
      `恢复：/mem restore ${compactionId}`,
    ].join('\n'),
  )
}

export async function restore(ctx, agent, compactionId) {
  if (!compactionId || !String(compactionId).startsWith(ID_PREFIX)) {
    const ids = findBlocks(agent?.session).slice(-5).map((block) => block.compactionId)
    return err(
      `用法：/mem restore <id>（id 以 ${ID_PREFIX} 开头）` + (ids.length > 0 ? `\n最近记录：\n${ids.join('\n')}` : ''),
    )
  }
  if (typeof agent.runMaintenance !== 'function') return err('当前 agent 不支持空闲预约（runMaintenance），已放弃。')
  try {
    return await agent.runMaintenance(async () => {
      try {
        return restoreNow(agent.session, compactionId)
      } catch (error) {
        return err(`恢复失败，未改动模型视图：${String(error?.message ?? error)}`)
      }
    })
  } catch (error) {
    return err(`恢复失败：${String(error?.message ?? error)}`)
  }
}

/**
 * 恢复只做一次 surface replace（checkpoint 节点 → 原文 user/message），不新开 compaction 事务。
 * 对加载期 replay 而言这是合法的：compaction/start…end 早已闭合，替换 checkpoint 节点不改变
 * 已提交的历史校验结果；但绝不能落在未闭合的事务里，也不能覆盖受保护的系统头。
 * @param {any} session
 * @param {string} compactionId
 * @returns {{kind:'success'|'error', text:string}}
 */
function restoreNow(session, compactionId) {
  const block = findBlocks(session).find((item) => item.compactionId === compactionId)
  if (block === undefined) return err(`没有找到记录 ${compactionId}`)

  const issues = auditCompactionLog(session)
  if (issues.length > 0) {
    const shown = issues.slice(0, 5).map((issue) => `- ${issue}`).join('\n')
    return err(`会话日志已有 compaction 结构问题，拒绝继续写入（请先修复日志）：\n${shown}`)
  }

  const nodes = Array.isArray(session.surface?.nodes) ? session.surface.nodes : []
  const checkpointIndex = nodes.findIndex((seq) => {
    const event = session.eventAt(seq)
    return isCheckpointEvent(event) && event.data?.source?.compactionId === compactionId
  })
  if (checkpointIndex < 0) return err('这段已经不在当前 surface 上（可能已恢复或被再次折叠），无法重复恢复。')
  const checkpointSeq = nodes[checkpointIndex]

  // surface.js：节点 0 若是 system/message 只允许被 system/message 改写。
  // checkpoint 本身不可能是 system 消息，这里保留防御性检查，避免将来改动踩到系统头。
  if (checkpointIndex === 0 && session.eventAt(checkpointSeq)?.type === 'system/message') {
    return err('不能改写受保护的系统提示节点，已放弃。')
  }

  const text = reconstruct(session, block.shadowedSeqs)
  if (text.trim() === '') return err('原文无法重建，已放弃。')
  const payload = text.slice(0, RESTORE_MAX_CHARS)

  const event = session.append(
    'user/message',
    { id: randomId(), role: 'user', content: [{ type: 'text', text: payload }], source: { kind: 'user' } },
    {
      surfaceOp: { op: 'replace', startSeq: checkpointSeq, endSeq: checkpointSeq },
      sourceEventSeqs: [checkpointSeq],
    },
  )
  if (event === null || typeof event !== 'object' || event.seq === undefined) {
    return err('恢复消息没有成功写入，已放弃。')
  }
  return ok(
    [
      '已恢复。',
      `记录 ${compactionId} 的原文已重新放回模型视图（${fmt(text.length)} 字符${text.length > RESTORE_MAX_CHARS ? '，已截断' : ''}）。`,
      '注意：恢复后上下文会明显变大。',
    ].join('\n'),
  )
}

// 供命令与 RPC 共用：只读的收起预览文本。
function dryrunText(ctx, agent, raw) {
  const { phase, nodes, startIndex, endIndex } = phaseByNumber(ctx, agent, raw)
  const shadowed = nodes.slice(startIndex, endIndex + 1)
  const summaryTokens = summaryBudget(phase.tokens)
  const saved = Math.max(0, phase.tokens - summaryTokens)
  const summary = renderFoldSummary(phase)
  return [
    `收起预览 · 阶段 ${phase.index}「${phase.title}」`,
    `占用 ${fmt(phase.tokens)} tokens（${shadowed.length} 条记录：工具 ${phase.tools} / 回复 ${phase.assistants} / 通知 ${phase.notices}）`,
    `收起后约 ${fmt(summaryTokens)} tokens，省 ${fmt(saved)}（${phase.tokens > 0 ? Math.round((saved / phase.tokens) * 100) : 0}%）`,
    '',
    '模型之后看到的摘要：',
    summary
      .split('\n')
      .map((line) => '  ' + line)
      .join('\n'),
    '',
    '原文保留在会话日志，可随时恢复。',
    `确认：/mem fold ${phase.index} --yes`,
  ].join('\n')
}

export { dryrunText }
