// 轻量 fake Session：只实现 memory-console 用到的接口，
// 但 append 语义与真实 dsh-session 一致——先校验（message 形状 + surface 规则）、后提交，
// 校验失败不会写入日志。用于单测 surgery()/restore() 的写入序列与失败收尾。
import { foldSurfaceEvent, isSeq } from './surface-fold.js'

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

/** 与 session.deriveEventMessage 一致的消息投影规则。 */
export function deriveEventMessage(event) {
  switch (event?.type) {
    case 'user/message':
      return event.data
    case 'system/message':
    case 'developer/message':
    case 'assistant/message':
      return event.data?.message?.content?.length > 0 ? event.data.message : null
    case 'tool/result':
      return event.data?.message ?? null
    default:
      return null
  }
}

let sessionCount = 0

export class FakeSession {
  /**
   * @param {{ id?: string, events?: any[], header?: any }} [options]
   */
  constructor(options = {}) {
    this.id = options.id ?? `fake-session-${++sessionCount}`
    this.header = clone(options.header ?? { config: { provider: 'fake-provider', model: 'fake-model' } })
    this.log = []
    this._nodes = []
    this.clock = 1_700_000_000_000
    /** append 尝试记录（失败也会记录，用于断言“没有写入”时看 attempts）。 */
    this.attempts = []
    /** 已提交事件（真正的日志）。 */
    this.failures = []
    this.afterAppend = null
    for (const event of options.events ?? []) this.seed(event)
  }

  /** 追加一条 seed 事件（仅测试构造用，等价于加载一条已有日志）。 */
  seed(partial) {
    const event = {
      type: partial.type,
      seq: this.log.length,
      time: partial.time ?? this.clock++,
      data: clone(partial.data),
      ...(partial.surfaceOp === undefined ? {} : { surfaceOp: clone(partial.surfaceOp) }),
      ...(partial.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: clone(partial.sourceEventSeqs) }),
    }
    const nodes = foldSurfaceEvent(this._nodes, event, (seq) => this.log[seq])
    this.log.push(event)
    this._nodes = nodes
    return event
  }

  get seq() {
    return this.log.length
  }

  get surface() {
    return { nodes: [...this._nodes], replaceGeneration: 0 }
  }

  snapshotEvents() {
    return this.log.slice()
  }

  eventAt(seq) {
    return this.log[seq]
  }

  requestHeader() {
    return this.header
  }

  deriveEventMessage(event) {
    return deriveEventMessage(event)
  }

  /** 让下一次指定类型的 append 抛错（模拟写入中途失败）。 */
  failNext(type, message = `fake session: forced ${type} failure`) {
    this.failures.push({ type, message })
  }

  append(type, data, options = {}) {
    const attempt = { type, data: clone(data), options: clone(options) }
    this.attempts.push(attempt)

    const index = this.failures.findIndex((item) => item.type === type)
    if (index >= 0) {
      const [failure] = this.failures.splice(index, 1)
      throw new Error(failure.message)
    }

    const event = {
      type,
      seq: this.log.length,
      time: this.clock++,
      data: clone(data),
      ...(options.surfaceOp === undefined ? {} : { surfaceOp: clone(options.surfaceOp) }),
      ...(options.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: clone(options.sourceEventSeqs) }),
    }
    const nodes = foldSurfaceEvent(this._nodes, event, (seq) => this.log[seq])
    if (!isSeq(event.seq)) throw new Error('fake session: invalid seq')
    this.log.push(event)
    this._nodes = nodes
    if (typeof this.afterAppend === 'function') this.afterAppend(event, this)
    return event
  }
}

/** 断言用：取已提交事件的 type 序列。 */
export function eventTypes(session) {
  return session.log.map((event) => event.type)
}

/** 断言用：取某个 type 的已提交事件。 */
export function eventsOfType(session, type) {
  return session.log.filter((event) => event.type === type)
}
