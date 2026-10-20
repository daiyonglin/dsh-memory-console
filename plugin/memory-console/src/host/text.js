// 纯展示/估算工具：不依赖 Cordis 服务，便于单测。
export const SUMMARY_MIN_TOKENS = 200
export const SUMMARY_MAX_TOKENS = 1600
export const SUMMARY_RATIO = 0.04

export function fmt(value) {
  const n = Number(value) || 0
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export function pad(text, width) {
  const value = String(text ?? '')
  if (value.length >= width) return value.slice(0, width)
  return value + ' '.repeat(width - value.length)
}

export function titleOf(message) {
  if (message === null || message === undefined) return '(用户消息)'
  const content = Array.isArray(message.content) ? message.content : []
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim() !== '') {
      return part.text.replace(/\s+/g, ' ').trim().slice(0, 42)
    }
  }
  return '(用户消息)'
}

export function summaryBudget(tokens) {
  return Math.min(SUMMARY_MAX_TOKENS, Math.max(SUMMARY_MIN_TOKENS, Math.round(tokens * SUMMARY_RATIO)))
}

export function renderFoldSummary(phase) {
  const lines = [`【已收起】${phase.title}`]
  lines.push(
    `此前任务阶段：${phase.nodes.length} 条记录（工具 ${phase.tools} / 回复 ${phase.assistants} / 通知 ${phase.notices ?? 0}），约 ${fmt(phase.tokens)} tokens。`,
  )
  const highlights = Array.isArray(phase.highlights) ? phase.highlights.filter(Boolean) : []
  if (highlights.length > 0) {
    lines.push('用户请求：')
    for (const item of highlights) lines.push(`· ${item}`)
  }
  const decisions = Array.isArray(phase.decisions) ? phase.decisions.filter(Boolean) : []
  if (decisions.length > 0) {
    lines.push('关键决定/约束：')
    for (const item of decisions.slice(0, 2)) lines.push(`· ${item}`)
  }
  const files = Array.isArray(phase.files) ? phase.files.filter(Boolean) : []
  if (files.length > 0) lines.push(`涉及文件：${files.slice(0, 4).join('、')}`)
  const commands = Array.isArray(phase.commands) ? phase.commands.filter(Boolean) : []
  if (commands.length > 0) lines.push(`运行命令：${commands.join('；')}`)
  const toolNames = Object.entries(phase.toolNames ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
  if (toolNames.length > 0) lines.push(`工具使用：${toolNames.map(([name, count]) => `${name}×${count}`).join('、')}`)
  lines.push('细节已从模型上下文移出；需要时可在记忆控制台恢复原文。')
  return lines.join('\n')
}

export function renderRemovePlaceholder(phase) {
  return `【已移出】任务阶段「${phase.title}」的 ${phase.nodes.length} 条记录已被用户移出模型上下文。`
}

export function frameSummary(summary) {
  const preamble =
    'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. ' +
    'Treat the captured context as established background and build on it without restating it. ' +
    'Continue the task directly from the messages that follow, without acknowledging this checkpoint.'
  return [preamble, '', '<compacted-summary>', summary, '</compacted-summary>'].join('\n')
}

export function approxTextTokens(text) {
  const value = String(text ?? '')
  const cjk = (value.match(/[\u4e00-\u9fff]/g) ?? []).length
  return Math.max(1, Math.round((value.length - cjk) / 4 + cjk * 0.6))
}

export function deriveMessage(session, event) {
  try {
    const message = session.deriveEventMessage(event)
    return message === undefined ? null : message
  } catch {
    return null
  }
}

export function estimate(ctx, message) {
  try {
    return Number(ctx.tokenMeter.estimateMessage(message)) || 0
  } catch {
    return 0
  }
}

export function estimateText(ctx, text) {
  try {
    if (typeof ctx.tokenMeter.measureContent === 'function') {
      return Number(ctx.tokenMeter.measureContent([{ type: 'text', text }])) || approxTextTokens(text)
    }
    return approxTextTokens(text)
  } catch {
    return approxTextTokens(text)
  }
}

export function randomId() {
  try {
    return globalThis.crypto.randomUUID()
  } catch {
    return `mc-${Date.now()}-${Math.random().toString(16).slice(2)}`
  }
}

export function ok(text) {
  return { kind: 'success', text }
}

export function err(text) {
  return { kind: 'error', text }
}
