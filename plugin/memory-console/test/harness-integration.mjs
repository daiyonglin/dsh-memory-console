// 端到端集成校验（可选）：把“插件真实写入”的结果交给 .recovery/harness 的真实加载期 oracle。
//
// 流程：
//   1. 取一份已知完好的真实会话日志（默认 D:\DSH-Data 下的 session-2e0436f7…），用 zstd 解压；
//   2. 用 .recovery/harness/node_modules 里的“真实 DSH 包” Session.fromRestore 还原成内存 Session；
//   3. 对真实 Session 调用本插件的 surgery()（fold）与 restore()；
//   4. 把变化后的日志写回 JSONL，交给 .recovery/harness/validate.js 做完整四层校验
//      （format / schema / surface / compaction），要求全 PASS。
//
// 运行：node test/harness-integration.mjs
// 依赖缺失（.recovery/harness、zstd、D:\DSH-Data 日志）时自动 SKIP，退出码 0；
// 校验失败退出码 1。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKSPACE = resolve(HERE, '../../..')
const HARNESS = join(WORKSPACE, '.recovery/harness/validate.js')
const HARNESS_MODULES = join(WORKSPACE, '.recovery/harness/node_modules/@deepseek-ai')
const ZSTD = process.env.DSH_ZSTD ?? 'D:\\Program Files\\MinGW\\bin\\zstd.exe'
// 默认取一份较早的、静态的已知完好会话（避免读到正在写入的活跃会话；可用环境变量覆盖）。
const SOURCE_LOG =
  process.env.MEMCON_SOURCE_LOG ??
  'D:\\DSH-Data\\.dsh\\sessions\\--E-DSH-WORKINGSPACE-RWKV-PLGUIN--\\5c91998d-b0e6-480f-ba0e-d75274606766\\session.v4.jsonl.zstd'
const TMP = join(HERE, 'tmp')

const skip = (reason) => {
  console.log(`skip harness-integration: ${reason}`)
  process.exit(0)
}

if (!existsSync(HARNESS)) skip('没有 .recovery/harness/validate.js（oracle 还没就绪）')
if (!existsSync(HARNESS_MODULES)) skip('没有 .recovery/harness/node_modules（真实 DSH 包未解包）')
if (!existsSync(ZSTD)) skip(`没有 zstd：${ZSTD}`)
if (!existsSync(SOURCE_LOG)) skip(`没有已知完好的会话日志：${SOURCE_LOG}`)

mkdirSync(TMP, { recursive: true })
const basePath = join(TMP, 'base-session.jsonl')
const decompress = spawnSync(ZSTD, ['-d', '-f', SOURCE_LOG, '-o', basePath], { encoding: 'utf8' })
if (decompress.status !== 0) {
  console.error(`zstd 解压失败：${(decompress.stderr || decompress.error?.message || '').trim()}`)
  process.exit(1)
}

// ── 用真实 DSH 包还原内存 Session ──────────────────────────────────────────
const { Session, SessionId, SessionLogOffset, interruptedTurnClosers } = await import(
  pathToFileURL(join(HARNESS_MODULES, 'dsh-session/lib/index.js')).href
)
const { collectPhases, isFoldable } = await import('../src/host/phases.js')
const { findBlocks, isBlockOnSurface, restore, surgery } = await import('../src/host/surgery.js')

const lines = readFileSync(basePath, 'utf8').split('\n')
if (lines.at(-1) === '') lines.pop()
const header = JSON.parse(lines[0])
if (header.isSeeded === true) skip('示例日志是 seeded 会话，未覆盖（请换一份 isSeeded=false 的日志）')
const storedEvents = []
for (const line of lines.slice(1)) {
  try {
    storedEvents.push(JSON.parse(line))
  } catch {
    // 读到的可能是仍在写入的会话的 torn tail：与线上 readStoredLog 一样忽略未完成尾行。
    break
  }
}
const closers = interruptedTurnClosers(storedEvents)
const meta = {
  version: 4,
  id: header.id,
  createdAt: header.createdAt,
  isSeeded: header.isSeeded,
  delegationDepth: header.delegationDepth,
  ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
  ...(header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset }),
}
const session = Session.fromRestore(
  SessionId(meta.id),
  [...storedEvents, ...closers],
  meta,
  SessionLogOffset(0),
  'detached',
  [],
)

// ── 与生产同款的最小 ctx / agent ────────────────────────────────────────────
const ctx = {
  tokenMeter: {
    estimateMessage(message) {
      return Math.max(1, Math.ceil(JSON.stringify(message?.content ?? message).length / 4))
    },
    measureContent(blocks) {
      const text = (Array.isArray(blocks) ? blocks : []).map((block) => block?.text ?? '').join('\n')
      return Math.max(1, Math.ceil(text.length / 4))
    },
  },
}
const agent = {
  session,
  runMaintenance: async (fn) => fn({ aborted: false, throwIfAborted() {} }),
}

const { phases } = collectPhases(ctx, session)
const candidates = phases.filter(isFoldable).sort((a, b) => b.tokens - a.tokens)
if (candidates.length === 0) skip('示例日志里没有可收起的大任务阶段（MIN_FOLD_TOKENS 以上）')
const target = candidates[0]

function dumpLog(path) {
  const out = [JSON.stringify(header), ...session.snapshotEvents().map((event) => JSON.stringify(event))].join('\n') + '\n'
  writeFileSync(path, out, 'utf8')
  return path
}

function runHarness(path, label) {
  const result = spawnSync(process.execPath, [HARNESS, path, '--json', `--session-id=${meta.id}`], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  let report
  try {
    report = JSON.parse(result.stdout)
  } catch {
    console.error(`harness ${label} 输出无法解析：\n${result.stdout}\n${result.stderr}`)
    process.exit(1)
  }
  const summary = report.layers.map((layer) => `${layer.name}=${layer.status}`).join(' ')
  console.log(`${label}: ${report.result}（${summary}；events=${report.eventCount}）`)
  if (report.result !== 'PASS') {
    console.error(JSON.stringify(report.layers.filter((layer) => layer.status === 'FAIL'), null, 2))
    process.exitCode = 1
    return false
  }
  return true
}

// ── 1) fold 写入完整括号 → 真实四层校验 ────────────────────────────────────
const foldResult = await surgery(ctx, agent, String(target.index), 'fold', true)
if (foldResult.kind !== 'success') {
  console.error(`surgery fold 失败：${foldResult.text}`)
  process.exit(1)
}
const block = findBlocks(session).at(-1)
const foldLog = dumpLog(join(TMP, 'memcon-after-fold.jsonl'))
const foldOk = runHarness(foldLog, '插件 fold 后的日志')
if (!foldOk) {
  console.error(`日志保留在 ${foldLog}`)
  process.exit(1)
}

// ── 2) restore（surface replace checkpoint）→ 真实四层校验 ──────────────────
const restoreResult = await restore(ctx, agent, block.compactionId)
if (restoreResult.kind !== 'success') {
  console.error(`restore 失败：${restoreResult.text}`)
  process.exit(1)
}
if (isBlockOnSurface(session, block.compactionId)) {
  console.error('restore 后 block 仍然在 surface 上，不符合预期')
  process.exit(1)
}
const restoreLog = dumpLog(join(TMP, 'memcon-after-restore.jsonl'))
const restoreOk = runHarness(restoreLog, '插件 restore 后的日志')

if (foldOk && restoreOk) {
  console.log('\nPASS：插件 fold / restore 产出的日志均通过真实加载期四层校验。')
  for (const path of [basePath, foldLog, restoreLog]) rmSync(path, { force: true })
} else {
  process.exitCode = 1
}
