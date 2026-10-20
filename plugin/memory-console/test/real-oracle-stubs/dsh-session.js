// 真实 replay oracle 的裸模块 stub：@deepseek-ai/dsh-session 里 invariant.js 用到的两个导出。
// 实现与官方 dsh-session/lib/types 中的对应函数一致（不依赖其它包）。
/** Brand a validated session seq; throws on non non-negative safe integers. */
export function SessionSeq(value) {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new TypeError(`SessionSeq must be a non-negative safe integer, got ${String(value)}`)
  }
  return value
}

/** Whether an event is a positional surface replacement (surface.js 同款判定). */
export function isReplacementSurfaceEvent(event) {
  return event.surfaceOp !== undefined && event.surfaceOp !== 'append'
}
