import { deriveMessage, estimate, titleOf } from './text.js'

// 低于这个体积的任务阶段不值得收起（摘要 + 官方 preamble 本身就有一两百 token）。
export const MIN_FOLD_TOKENS = 1200
export const LONG_TOOL_RESULT_TOKENS = 8000

// 系统注入的 user 消息：它们不是“任务”，应归入当前任务。
const INJECTION_KINDS = new Set(['runtime-context', 'skill-catalog', 'time-context', 'repeat-tool-reminder'])
// 编队/子代理通知：归入当前任务，但单独计数。
const NOTICE_KINDS = new Set(['agent-message', 'subagent-settled'])

export function sourceKind(message) {
  const kind = message?.source?.kind
  return typeof kind === 'string' ? kind : ''
}

export function isCheckpointEvent(event) {
  return event?.type === 'user/message' && event.data?.source?.kind === 'compact-checkpoint'
}

export function hasToolCalls(message) {
  if (message === null || message === undefined) return false
  const content = Array.isArray(message.content) ? message.content : []
  return content.some((part) => part?.type === 'tool-call')
}

export function isSystemPhase(phase) {
  return phase.kind === 'system'
}

export function isFoldable(phase) {
  return phase.kind === 'task' && phase.tokens >= MIN_FOLD_TOKENS
}

const FILE_PATTERN = /[A-Za-z0-9_./\\-]+\.(?:tsx?|jsx?|mjs|cjs|json|jsonl|md|py|css|html|ya?ml|toml|rs|go|java|sh|ps1)\b/g

function textsOf(message) {
  if (message === null || message === undefined) return []
  const content = Array.isArray(message.content) ? message.content : []
  return content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text)
}

const DECISION_PATTERN = /(必须|不要|别再|禁止|改用|采用|决定|约定|约束|注意|记住|保留|要求|优先)/

function rememberHighlights(phase, kind, message) {
  for (const text of textsOf(message)) {
    if (kind === 'user') {
      if (phase.highlights.length < 2) {
        const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 100)
        if (snippet !== '') phase.highlights.push(snippet)
      }
      if (phase.decisions.length < 2) {
        for (const sentence of text.split(/[。！？；;\n]/)) {
          const trimmed = sentence.replace(/\s+/g, ' ').trim()
          if (trimmed.length >= 6 && trimmed.length <= 110 && DECISION_PATTERN.test(trimmed)) {
            phase.decisions.push(trimmed)
            break
          }
        }
      }
    }
    for (const match of text.matchAll(FILE_PATTERN)) {
      const file = match[0]
      if (phase.files.length < 6 && !phase.files.includes(file)) phase.files.push(file)
    }
  }
}

/** 从 tool/call 事件补充：工具使用次数、改动文件、运行命令（按阶段 seq 区间归属）。 */
function annotateToolCalls(session, phases) {
  let events = []
  try {
    events = session.snapshotEvents()
  } catch {
    return
  }
  const intervals = phases
    .map((phase) => {
      const seqs = phase.nodes
      if (seqs.length === 0) return null
      return { phase, lo: Math.min(...seqs), hi: Math.max(...seqs) }
    })
    .filter(Boolean)
  for (const event of events) {
    if (event?.type !== 'tool/call') continue
    let target = null
    for (let index = intervals.length - 1; index >= 0; index -= 1) {
      const interval = intervals[index]
      if (event.seq >= interval.lo && event.seq <= interval.hi) {
        target = interval.phase
        break
      }
    }
    if (target === null) continue
    const name = String(event.data?.name ?? 'tool')
    target.toolNames[name] = (target.toolNames[name] ?? 0) + 1
    if ((name === 'edit' || name === 'write') && target.edits < 99) target.edits += 1
    let args = null
    try {
      args = JSON.parse(String(event.data?.arguments ?? '{}'))
    } catch {
      args = null
    }
    if (args === null || typeof args !== 'object') continue
    const path = args.file_path ?? args.filePath ?? args.path
    if (typeof path === 'string' && path !== '' && target.files.length < 6 && !target.files.includes(path)) {
      target.files.push(path)
    }
    const command = args.command ?? args.cmd
    if (typeof command === 'string' && command.trim() !== '' && target.commands.length < 3) {
      target.commands.push(command.trim().split(/\r?\n/)[0].slice(0, 80))
    }
  }
}

/**
 * 把一个阶段拆成“任务阶段”：
 * - 人类用户消息（source.kind === 'user'）开启新任务；
 * - 系统注入（runtime-context / skill-catalog / time-context …）与编队通知（agent-message / subagent-settled）
 *   都归入当前任务，只计数、不单独成段；
 * - 已收起 checkpoint 单独成段（带 compactionId，可恢复）。
 */
export function collectPhases(ctx, session) {
  const nodes = Array.isArray(session.surface?.nodes) ? session.surface.nodes : []
  const phases = []
  let current = null
  let totalTokens = 0

  const startPhase = (seq, kind, title, message) => {
    const phase = {
      index: phases.length + 1,
      kind,
      title,
      startSeq: seq,
      endSeq: seq,
      nodes: [],
      tools: 0,
      assistants: 0,
      notices: 0,
      injections: 0,
      tokens: 0,
      toolTokens: 0,
      cat: { system: 0, user: 0, assistant: 0, tool: 0, injection: 0, folded: 0 },
      highlights: [],
      decisions: [],
      files: [],
      commands: [],
      toolNames: {},
      edits: 0,
      isCheckpoint: kind === 'checkpoint',
      compactionId: kind === 'checkpoint' ? String(message?.source?.compactionId ?? '') : '',
    }
    phases.push(phase)
    return phase
  }

  for (const seq of nodes) {
    const event = session.eventAt(seq)
    if (event === undefined || event === null) continue
    const message = deriveMessage(session, event)
    const tokens = message === null ? 0 : estimate(ctx, message)
    const kind = sourceKind(message)

    if (event.type === 'user/message' && kind === 'compact-checkpoint') {
      current = startPhase(seq, 'checkpoint', '已收起的历史（可恢复）', message)
    } else if (event.type === 'user/message' && kind === 'user') {
      current = startPhase(seq, 'task', titleOf(message), message)
    } else if (current === null) {
      current = startPhase(seq, 'system', '系统提示与自动上下文', message)
    }

    current.endSeq = seq
    current.nodes.push(seq)
    current.tokens += tokens
    totalTokens += tokens
    if (event.type === 'tool/result') {
      current.tools += 1
      current.toolTokens += tokens
    }
    if (event.type === 'assistant/message') current.assistants += 1
    if (NOTICE_KINDS.has(kind)) current.notices += 1
    if (INJECTION_KINDS.has(kind)) current.injections += 1
    const category =
      event.type === 'system/message'
        ? 'system'
        : event.type === 'assistant/message'
          ? 'assistant'
          : event.type === 'tool/result'
            ? 'tool'
            : event.type === 'user/message'
              ? kind === 'compact-checkpoint'
                ? 'folded'
                : kind === 'user'
                  ? 'user'
                  : 'injection'
              : null
    if (category !== null) current.cat[category] += tokens
    rememberHighlights(current, kind, message)
  }

  annotateToolCalls(session, phases)
  return { nodes, phases, totalTokens }
}

export function phaseByNumber(ctx, agent, raw) {
  const session = agent?.session
  if (session === undefined || session === null) throw new Error('当前没有可读取的会话')
  const phaseNumber = Number.parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(phaseNumber))
    throw new Error('缺少阶段号。先运行 /mem report 查看阶段列表，例如 /mem dryrun 2')
  const { nodes, phases } = collectPhases(ctx, session)
  const phase = phases.find((item) => item.index === phaseNumber)
  if (phase === undefined) throw new Error(`没有第 ${phaseNumber} 阶段（共 ${phases.length} 段）`)
  const startIndex = nodes.indexOf(phase.startSeq)
  const endIndex = nodes.indexOf(phase.endSeq)
  if (startIndex < 0 || endIndex < startIndex) throw new Error(`第 ${phaseNumber} 阶段的区间不在当前 surface 上`)
  return { session, nodes, phase, startIndex, endIndex }
}
