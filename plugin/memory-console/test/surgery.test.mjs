// memory-console 单测：compaction 括号写入序列 + 加载期 replay 不变量。
//
// 运行：node test/surgery.test.mjs  （或 pnpm test / npm test）
// 不依赖任何第三方包；FakeSession 复刻真实 Session 的 append 原子性 + surface replace 校验。
// 另外，如果工作区里存在 .recovery（DSH 解包源码），会额外用“真实的”官方
// dsh-compaction invariant replay 校验产出的日志（见 test/real-oracle.mjs）。
import assert from 'node:assert/strict'

import { FakeSession, eventTypes, eventsOfType } from './fake-session.js'
import { replayCompactionInvariants, assertReplayClosed } from './invariant-oracle.js'
import { foldSurface } from './surface-fold.js'
import { runRealInvariantOracle } from './real-oracle.mjs'
import { auditCompactionLog } from '../src/host/compaction.js'
import { run as runCommand } from '../src/host/commands.js'
import { findBlocks, isBlockOnSurface, restore, surgery } from '../src/host/surgery.js'

// ---------------------------------------------------------------------------
// 测试脚手架
// ---------------------------------------------------------------------------

function makeCtx() {
  const estimate = (value) => Math.max(1, Math.ceil(JSON.stringify(value).length / 4))
  return {
    tokenMeter: {
      estimateMessage(message) {
        return estimate(message?.content ?? message)
      },
      measureContent(blocks) {
        const text = (Array.isArray(blocks) ? blocks : []).map((block) => block?.text ?? '').join('\n')
        return Math.max(1, Math.ceil(text.length / 4))
      },
    },
  }
}

function makeAgent(session) {
  return {
    session,
    runMaintenance: async (fn) => fn({ aborted: false, throwIfAborted() {} }),
  }
}

let idCounter = 0
const nextId = (prefix) => `${prefix}-${++idCounter}`

function textContent(text) {
  return [{ type: 'text', text }]
}

function systemEvent(text) {
  return {
    type: 'system/message',
    data: { message: { id: nextId('system'), role: 'system', content: textContent(text), source: { kind: 'system-prompt' } } },
    surfaceOp: 'append',
  }
}

function userEvent(text, sourceKind = 'user') {
  return {
    type: 'user/message',
    data: { id: nextId('user'), role: 'user', content: textContent(text), source: { kind: sourceKind } },
    surfaceOp: 'append',
  }
}

function assistantEvent(text) {
  return {
    type: 'assistant/message',
    data: {
      message: {
        id: nextId('assistant'),
        role: 'assistant',
        content: textContent(text),
        source: { kind: 'model', provider: 'fake-provider', model: 'fake-model' },
      },
      turn: 0,
      step: 0,
      stream: [],
    },
    surfaceOp: 'append',
  }
}

function toolResultEvent(text, callId = 'call-1') {
  return {
    type: 'tool/result',
    data: {
      message: {
        id: nextId('tool'),
        role: 'tool',
        content: textContent(text),
        source: { kind: 'tool', callId },
        toolCallId: callId,
      },
    },
    surfaceOp: 'append',
  }
}

/**
 * 构造一段会话：system 头 + 一个可收起的大任务阶段（seq 1..3）+ 一个短任务阶段（seq 4）。
 * 阶段 2 的 token 量远超 MIN_FOLD_TOKENS，摘要必然更小，所以 fold/remove 会通过体积检查。
 */
function buildSession() {
  return new FakeSession({
    events: [
      systemEvent('You are a helpful assistant.'),
      userEvent(`TASK ONE ${'A'.repeat(6000)}`),
      assistantEvent('step one done'),
      toolResultEvent(`TOOL OUTPUT ${'R'.repeat(4000)}`),
      userEvent('TASK TWO short'),
    ],
  })
}

/** 复刻旧版插件的致命写法：只写 summary + checkpoint，不写 start/end。 */
function buildLegacyBrokenSession(compactionId = 'memory-console-fold-legacy') {
  // 用“两个大任务阶段”的会话：坏记录收起第一个任务，第二个任务仍可被 /mem fold 选中，
  // 这样能验证 surgery 在写入前就被结构性体检拦下（而不是先被体积检查拦下）。
  const session = new FakeSession({
    events: [
      systemEvent('You are a helpful assistant.'),
      userEvent(`TASK ONE ${'A'.repeat(6000)}`),
      assistantEvent('step one done'),
      toolResultEvent(`TOOL OUTPUT ${'R'.repeat(4000)}`, 'call-1'),
      userEvent(`TASK TWO ${'B'.repeat(6000)}`),
      assistantEvent('step two done'),
      toolResultEvent(`TOOL OUTPUT TWO ${'S'.repeat(4000)}`, 'call-2'),
    ],
  })
  const shadowedSeqs = [1, 2, 3]
  const summaryEvent = session.append('compaction/summary', {
    compactionId,
    summary: [{ type: 'text', text: 'legacy summary' }],
    shadowedRange: { start: 1, end: 3 },
    shadowedSeqs,
    shadowedTokenCount: 10,
    provider: 'legacy',
    model: 'legacy',
  })
  session.append(
    'user/message',
    {
      id: 'legacy-checkpoint',
      role: 'user',
      content: textContent('legacy checkpoint'),
      source: { kind: 'compact-checkpoint', compactionId },
    },
    { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 3 }, sourceEventSeqs: [summaryEvent.seq, ...shadowedSeqs] },
  )
  return { session, compactionId }
}

let realOracleRuns = 0
let realOracleSkipped = 0

/** 本地移植版 replay oracle：任何产出都必须 PASS 且事务闭合。 */
function assertLocalReplayOk(session) {
  return assertReplayClosed(session.snapshotEvents())
}

/** 真实官方 invariant replay（可选）：有 .recovery 时必须是 PASS。 */
async function assertRealReplayOk(session) {
  const result = await runRealInvariantOracle(session)
  if (!result.available) {
    realOracleSkipped += 1
    return
  }
  realOracleRuns += 1
  assert.equal(result.ok, true, `真实 invariant replay 失败：${result.error}`)
}

const tests = []
function test(name, fn) {
  tests.push({ name, fn })
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

test('fold：写入完整括号 start → summary → user/message → end，且 replay 通过', async () => {
  const session = buildSession()
  const ctx = makeCtx()
  const agent = makeAgent(session)
  const before = session.log.length

  const result = await surgery(ctx, agent, '2', 'fold', true)
  assert.equal(result.kind, 'success', result.text)

  const appended = session.log.slice(before)
  assert.deepEqual(
    appended.map((event) => event.type),
    ['compaction/start', 'compaction/summary', 'user/message', 'compaction/end'],
  )
  const [startEvent, summaryEvent, messageEvent, endEvent] = appended
  assert.ok(startEvent.seq < summaryEvent.seq && summaryEvent.seq < messageEvent.seq && messageEvent.seq < endEvent.seq)

  // 三个 compaction 事件的 compactionId 必须一致；turn 必须是 standalone null。
  assert.equal(startEvent.data.compactionId, summaryEvent.data.compactionId)
  assert.equal(startEvent.data.compactionId, endEvent.data.compactionId)
  assert.equal(startEvent.data.compactionId, messageEvent.data.source.compactionId)
  assert.equal(startEvent.data.turn, null)
  assert.equal(endEvent.data.turn, null)

  // summary 的 shadowed 字段必须精确描述被替换区间。
  assert.deepEqual(summaryEvent.data.shadowedRange, { start: 1, end: 3 })
  assert.deepEqual(summaryEvent.data.shadowedSeqs, [1, 2, 3])
  assert.ok(Number.isSafeInteger(summaryEvent.data.shadowedTokenCount))
  assert.ok(summaryEvent.data.shadowedTokenCount > 0)

  // 替换消息：官方 checkpoint source + surface replace + 完整 sourceEventSeqs（含 start/summary）。
  assert.equal(messageEvent.data.source.kind, 'compact-checkpoint')
  assert.deepEqual(messageEvent.surfaceOp, { op: 'replace', startSeq: 1, endSeq: 3 })
  assert.deepEqual(messageEvent.sourceEventSeqs, [startEvent.seq, summaryEvent.seq, 1, 2, 3])

  // surface 折叠后：被收起的 1..3 只剩一个 checkpoint 节点。
  assert.deepEqual(foldSurface(session.snapshotEvents()), [0, messageEvent.seq, 4])

  // replay oracle：本地移植版 + 真实官方 invariant。
  const state = assertLocalReplayOk(session)
  assert.equal(state.compaction, undefined)
  await assertRealReplayOk(session)

  // 插件自身状态。
  assert.equal(findBlocks(session).length, 1)
  assert.equal(isBlockOnSurface(session, startEvent.data.compactionId), true)
  assert.deepEqual(auditCompactionLog(session), [])
})

test('remove：同样写完整括号，且替换节点可被 restore 识别（不再写成普通 user 消息）', async () => {
  const session = buildSession()
  const ctx = makeCtx()
  const agent = makeAgent(session)
  const before = session.log.length

  const result = await surgery(ctx, agent, '2', 'remove', true)
  assert.equal(result.kind, 'success', result.text)

  const appended = session.log.slice(before)
  assert.deepEqual(
    appended.map((event) => event.type),
    ['compaction/start', 'compaction/summary', 'user/message', 'compaction/end'],
  )
  const [startEvent, , messageEvent] = appended
  assert.equal(messageEvent.data.source.kind, 'compact-checkpoint')
  assert.equal(messageEvent.data.source.compactionId, startEvent.data.compactionId)

  assertLocalReplayOk(session)
  await assertRealReplayOk(session)

  const compactionId = startEvent.data.compactionId
  assert.equal(isBlockOnSurface(session, compactionId), true)
  const restored = await restore(ctx, agent, compactionId)
  assert.equal(restored.kind, 'success', restored.text)
  assert.equal(isBlockOnSurface(session, compactionId), false)
  assertLocalReplayOk(session)
  await assertRealReplayOk(session)
})

test('旧版坏日志：本地 oracle 与真实官方 oracle 都会报 "compaction/summary has no matching compaction/start"', async () => {
  const { session } = buildLegacyBrokenSession()

  assert.throws(
    () => replayCompactionInvariants(session.snapshotEvents()),
    /compaction\/summary has no matching compaction\/start/,
  )

  const real = await runRealInvariantOracle(session)
  if (real.available) {
    realOracleRuns += 1
    assert.equal(real.ok, false)
    assert.match(real.error, /compaction\/summary has no matching compaction\/start/)
  } else {
    realOracleSkipped += 1
  }
})

test('防御：日志里已有未闭合 compaction/start 时，surgery 一个事件都不写', async () => {
  const session = buildSession()
  const ctx = makeCtx()
  const agent = makeAgent(session)
  session.append('compaction/start', { compactionId: 'memory-console-orphan', turn: null })
  const before = session.log.length
  const attemptsBefore = session.attempts.length

  const result = await surgery(ctx, agent, '2', 'fold', true)
  assert.equal(result.kind, 'error')
  assert.match(result.text, /已有 compaction 结构问题/)
  assert.match(result.text, /compaction\/start/)
  assert.equal(session.log.length, before, 'preflight 失败后不应写入任何事件')
  assert.equal(session.attempts.length, attemptsBefore, 'preflight 失败后不应尝试 append')
})

test('防御：turn 未结束时拒绝写 standalone 事务，且不写入', async () => {
  const session = buildSession()
  const ctx = makeCtx()
  const agent = makeAgent(session)
  session.append('turn/start', { turn: 0 })
  const before = session.log.length
  const attemptsBefore = session.attempts.length

  const result = await surgery(ctx, agent, '2', 'fold', true)
  assert.equal(result.kind, 'error')
  assert.match(result.text, /turn 0/)
  assert.equal(session.log.length, before)
  assert.equal(session.attempts.length, attemptsBefore)
})

test('防御：写到一半失败时补写带 error 的 compaction/end 收尾，日志仍合法', async () => {
  const session = buildSession()
  const ctx = makeCtx()
  const agent = makeAgent(session)
  const before = session.log.length
  session.failNext('user/message', 'forced surface replace failure')

  const result = await surgery(ctx, agent, '2', 'fold', true)
  assert.equal(result.kind, 'error')
  assert.match(result.text, /已补写带 error 的 compaction\/end 收尾/)
  assert.match(result.text, /forced surface replace failure/)

  const appended = session.log.slice(before)
  assert.deepEqual(
    appended.map((event) => event.type),
    ['compaction/start', 'compaction/summary', 'compaction/end'],
  )
  const endEvent = appended.at(-1)
  assert.notEqual(endEvent.data.error, undefined)
  assert.equal(endEvent.data.turn, null)

  // replay 通过（官方允许“失败收尾”：end 带 error 时不需要 summary 也能闭合，
  // 本例 summary 已写入，因此更严格的条件也满足）。
  assertLocalReplayOk(session)
  await assertRealReplayOk(session)
  assert.deepEqual(auditCompactionLog(session), [])
})

test('最坏情况：收尾也失败时，明确告知可能留下未闭合 start', async () => {
  const session = buildSession()
  const ctx = makeCtx()
  const agent = makeAgent(session)
  session.failNext('user/message', 'forced replace failure')
  session.failNext('compaction/end', 'forced close failure')

  const result = await surgery(ctx, agent, '2', 'fold', true)
  assert.equal(result.kind, 'error')
  assert.match(result.text, /严重/)
  assert.match(result.text, /未闭合/)
  // 日志确实留下未闭合 start：replay 不会因此失败（加载允许尾部未闭合），但 audit 必须报出来。
  assert.doesNotThrow(() => replayCompactionInvariants(session.snapshotEvents()))
  assert.ok(auditCompactionLog(session).length > 0)
})

test('旧版坏日志上禁止继续操作：surgery / restore 都拒绝且不写', async () => {
  const { session, compactionId } = buildLegacyBrokenSession()
  const ctx = makeCtx()
  const agent = makeAgent(session)
  const before = session.log.length
  const attemptsBefore = session.attempts.length

  // 坏记录收起了第一个任务；第二个任务阶段（phase 3）仍然可被 fold 选中。
  const foldResult = await surgery(ctx, agent, '3', 'fold', true)
  assert.equal(foldResult.kind, 'error', foldResult.text)
  assert.match(foldResult.text, /compaction\/summary 没有匹配的 compaction\/start/)

  const restoreResult = await restore(ctx, agent, compactionId)
  assert.equal(restoreResult.kind, 'error')
  assert.match(restoreResult.text, /compaction 结构问题/)

  assert.equal(session.log.length, before)
  assert.equal(session.attempts.length, attemptsBefore)
})

test('restore：只做一次 surface replace，不改 compaction 结构；重复恢复被拒绝', async () => {
  const session = buildSession()
  const ctx = makeCtx()
  const agent = makeAgent(session)
  const folded = await surgery(ctx, agent, '2', 'fold', true)
  assert.equal(folded.kind, 'success', folded.text)
  const compactionId = eventsOfType(session, 'compaction/summary').at(-1).data.compactionId
  const checkpointSeq = session.surface.nodes.find((seq) => {
    const event = session.eventAt(seq)
    return event?.data?.source?.kind === 'compact-checkpoint' && event.data.source.compactionId === compactionId
  })
  assert.ok(Number.isSafeInteger(checkpointSeq))

  const before = session.log.length
  const restored = await restore(ctx, agent, compactionId)
  assert.equal(restored.kind, 'success', restored.text)

  const appended = session.log.slice(before)
  assert.equal(appended.length, 1, 'restore 不应写入 compaction 括号，只写一个替换消息')
  const event = appended[0]
  assert.equal(event.type, 'user/message')
  assert.equal(event.data.source.kind, 'user')
  assert.deepEqual(event.surfaceOp, { op: 'replace', startSeq: checkpointSeq, endSeq: checkpointSeq })
  assert.deepEqual(event.sourceEventSeqs, [checkpointSeq])
  assert.match(event.data.content[0].text, /TASK ONE/)
  assert.ok(event.data.content[0].text.length > 1000, '恢复出来的应是原文（影子区间重建）')

  // 已闭合的 compaction 结构不被破坏；真实 replay 依旧 PASS。
  assertLocalReplayOk(session)
  await assertRealReplayOk(session)
  assert.equal(isBlockOnSurface(session, compactionId), false)

  const again = await restore(ctx, agent, compactionId)
  assert.equal(again.kind, 'error')
  assert.match(again.text, /无法重复恢复/)
})

test('diag：健康会话显示 ok，坏日志显示具体问题', () => {
  const healthy = buildSession()
  const healthyDiag = runCommand(makeCtx(), { rawInput: 'diag', agent: makeAgent(healthy) })
  assert.equal(healthyDiag.kind, 'success')
  assert.match(healthyDiag.text, /compaction 事务：ok/)

  const { session: broken } = buildLegacyBrokenSession()
  const brokenDiag = runCommand(makeCtx(), { rawInput: 'diag', agent: makeAgent(broken) })
  assert.equal(brokenDiag.kind, 'success')
  // summary 与 compact-checkpoint 各一条“没有匹配的 start”。
  assert.match(brokenDiag.text, /compaction 事务：2 个问题/)
  assert.match(brokenDiag.text, /compaction\/summary 没有匹配的 compaction\/start/)
})

// ---------------------------------------------------------------------------
// 运行
// ---------------------------------------------------------------------------

let passed = 0
let failed = 0
for (const item of tests) {
  try {
    await item.fn()
    console.log(`ok ${++passed} - ${item.name}`)
  } catch (error) {
    failed += 1
    console.error(`not ok ${failed} - ${item.name}`)
    console.error(String(error?.stack ?? error).replace(/^/gm, '    '))
  }
}

console.log(
  `\n${passed}/${tests.length} passed${failed === 0 ? '' : `, ${failed} failed`}` +
    `（真实官方 replay oracle：调用 ${realOracleRuns} 次，跳过 ${realOracleSkipped} 次）`,
)
if (failed > 0) process.exitCode = 1
