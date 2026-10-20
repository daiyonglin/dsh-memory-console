import { collectPhases, isCheckpointEvent, isFoldable, isSystemPhase, LONG_TOOL_RESULT_TOKENS } from './phases.js'
import { auditCompactionLog } from './compaction.js'
import { dryrunText, findBlocks, isBlockOnSurface, restore, surgery } from './surgery.js'
import { err, fmt, ok, pad } from './text.js'

const MAX_ROWS = 20

export function run(ctx, invocation) {
  const parts = String(invocation.rawInput ?? '').trim().split(/\s+/).filter(Boolean)
  const sub = (parts[0] ?? '').toLowerCase()
  try {
    if (sub === '' || sub === 'report') return ok(report(ctx, invocation.agent))
    if (sub === 'help') return ok(helpText())
    if (sub === 'diag') return ok(diag(invocation.agent))
    if (sub === 'dryrun') return ok(dryrunText(ctx, invocation.agent, parts[1]))
    if (sub === 'fold') return surgery(ctx, invocation.agent, parts[1], 'fold', parts.includes('--yes'))
    if (sub === 'remove') return surgery(ctx, invocation.agent, parts[1], 'remove', parts.includes('--yes'))
    if (sub === 'restore') return restore(ctx, invocation.agent, parts[1])
    if (sub === 'status') return ok(status(invocation.agent))
    return err(`未知子命令：${sub}\n\n${helpText()}`)
  } catch (error) {
    return err(`记忆控制台执行失败：${String(error?.message ?? error)}`)
  }
}

export function report(ctx, agent) {
  const session = agent?.session
  if (session === undefined || session === null) return '当前没有可读取的会话。'
  const { nodes, phases, totalTokens } = collectPhases(ctx, session)
  if (nodes.length === 0) {
    return ['记忆控制台 · 只读报告', '这个会话还没有任何上下文节点（新会话请先聊几句）。'].join('\n')
  }

  const candidates = phases.filter(isFoldable)
  const candidateTokens = candidates.reduce((sum, phase) => sum + phase.tokens, 0)
  let longToolPhases = 0
  for (const phase of phases) if (phase.toolTokens >= LONG_TOOL_RESULT_TOKENS) longToolPhases += 1

  const sessionId = String(session.id ?? '')
  const shortId = sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId
  const lines = [
    '记忆控制台 · 上下文报告',
    `会话 ${shortId} · 模型视图 ≈${fmt(totalTokens)} tokens（${nodes.length} 条记录）· 可收起 ≈${fmt(candidateTokens)}（${candidates.length} 段）`,
  ]
  if (longToolPhases > 0) lines.push(`其中 ${longToolPhases} 段含超长工具结果（≥${fmt(LONG_TOOL_RESULT_TOKENS)} tokens）`)
  lines.push('', '  #   阶段                          tokens    占比', '  ──────────────────────────────────────────────────')
  for (const phase of phases.slice(0, MAX_ROWS)) {
    const mark = isFoldable(phase) ? '  ✅' : phase.isCheckpoint ? '  📦' : ''
    const share = totalTokens > 0 ? Math.round((phase.tokens / totalTokens) * 100) : 0
    lines.push(
      `  ${String(phase.index).padStart(2)}   ${pad(phase.title, 26)}  ${fmt(phase.tokens).padStart(8)}  ${String(share).padStart(3)}%${mark}`,
    )
  }
  if (phases.length > MAX_ROWS) lines.push(`  … 还有 ${phases.length - MAX_ROWS} 段未显示`)
  lines.push('', '操作：右侧栏「记忆控制台」点按钮；或 /mem fold <号> --yes。详情：/mem help。')
  return lines.join('\n')
}

export function status(agent) {
  const session = agent?.session
  if (session === undefined || session === null) return '当前没有可读取的会话。'
  const blocks = findBlocks(session)
  if (blocks.length === 0) return '本会话还没有由记忆控制台做过的收起/移出记录。'
  const lines = [`记忆控制台 · 操作记录（${blocks.length}）`]
  for (const block of blocks.slice(-20)) {
    const active = isBlockOnSurface(session, block.compactionId)
    lines.push(`${active ? '●' : '○'} ${active ? '生效中' : '已恢复'}  ${fmt(block.shadowedTokenCount)} tokens  ${block.compactionId}`)
  }
  lines.push('', '恢复：/mem restore <id>')
  return lines.join('\n')
}

export function diag(agent) {
  const session = agent?.session
  const nodes = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : []
  const types = new Map()
  for (const seq of nodes) {
    const event = session.eventAt(seq)
    const key = event?.type ?? 'unknown'
    types.set(key, (types.get(key) ?? 0) + 1)
  }
  const issues = session === undefined || session === null ? [] : auditCompactionLog(session)
  const lines = [
    '记忆控制台 · 诊断',
    `会话 ${String(session?.id ?? '')}`,
    `surface 节点：${nodes.length}`,
    `节点类型：${[...types.entries()].map(([key, value]) => `${key}×${value}`).join(', ') || '(空)'}`,
    `runMaintenance：${typeof agent?.runMaintenance === 'function' ? 'ok' : 'missing'}`,
    `本插件操作记录：${findBlocks(session).length} 条`,
    `compaction 事务：${issues.length === 0 ? 'ok（括号结构完整）' : `${issues.length} 个问题`}`,
  ]
  for (const issue of issues.slice(0, 5)) lines.push(`  ⚠ ${issue}`)
  if (issues.length > 5) lines.push(`  … 还有 ${issues.length - 5} 个问题`)
  return lines.join('\n')
}

export function helpText() {
  return [
    '记忆控制台（命令只是快捷方式，日常请在右侧栏面板操作）',
    '  /mem report                按任务阶段查看上下文占用（只读）',
    '  /mem dryrun <阶段号>        预览收起方案（只读）',
    '  /mem fold <阶段号> --yes    收起（写入，可恢复）',
    '  /mem remove <阶段号> --yes  移出模型视图（写入，可恢复）',
    '  /mem restore <id>          恢复原文',
    '  /mem status                查看操作记录',
    '  /mem diag                  诊断',
    '',
    '收起/移出只改“模型视图”；聊天记录与日志永远保留。',
  ].join('\n')
}
