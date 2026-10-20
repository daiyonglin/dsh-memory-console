# CHANGELOG

## 0.0.2 — 2026-10-20

### 修复：会话永久无法加载（致命）

`src/host/surgery.js` 的 `surgery()` 以前只写：

- `compaction/summary`
- 带 `source.kind = 'compact-checkpoint'`、`surfaceOp = { op: 'replace' }` 的 `user/message`

**却从不写 `compaction/start` / `compaction/end`。** DSH 运行时（内存态）不校验这些不变量，
所以当场看起来成功；重启后加载会话时 replay 会抛
`compaction/summary has no matching compaction/start`，整个会话永久无法加载。

现在改为严格按官方 compaction 引擎
（`@deepseek-ai/dsh-compaction-basic` 的 `compactSurfaceRegion` / `commitCompactionBody`）写入完整括号：

```text
compaction/start          data: { compactionId, turn: null }        ← 新增
compaction/summary        data: { compactionId, summary, shadowedRange, shadowedSeqs,
                                  shadowedTokenCount, provider, model }
user/message (surfaceOp=replace, source.kind='compact-checkpoint')
compaction/end            data: { compactionId, turn: null }        ← 新增
```

要点（对应 `@deepseek-ai/dsh-compaction/lib/types/invariant.js` 的校验规则）：

- 顺序固定 `start → summary → 替换消息 → end`，四个事件在**同一个同步块**里写完（中间不允许 await，
  否则 turn 边界可能插进括号里）；
- 三个 compaction 事件的 `compactionId` 一致；`turn` 为 `null`（runMaintenance 空闲期 = standalone 事务）；
- `compaction/summary.shadowedSeqs` 必须逐条等于“写入那一刻 surface 上的连续片段”，
  `shadowedRange` 等于其首尾，`shadowedTokenCount` 为非负安全整数；
- 替换消息的 `sourceEventSeqs` 为 `[start.seq, summary.seq, ...shadowedSeqs]`（官方同款，覆盖全部被替换节点）。

### 新增：写入前自检 + 失败收尾（`src/host/compaction.js`）

- **preflight（一个事件都不写）**：校验括号计划自洽（compactionId、turn、shadowedSeqs 与当前 surface
  连续片段一致、token 计数、replace 的 sourceEventSeqs 覆盖/去重/只引用更早事件、不能覆盖系统头）；
  同时体检**现有日志**——发现旧的 `summary`/`checkpoint` 没有 `start`、未闭合 `start`、跨 turn 的未闭合
  compaction 等结构问题时直接拒绝继续写入（避免在坏日志上再叠坏记录）；日志里有打开的 turn 时也拒绝。
- **中途失败收尾**：按官方的失败收尾方式补一个带 `error` 的 `compaction/end`，日志仍然是 replay-valid；
  如果连收尾都失败，会明确告知“可能留下未闭合的 compaction/start”，不再静默。
- **写入后自检**：核对四个返回事件的类型 / seq / compactionId / turn / surfaceOp / sourceEventSeqs。

### 修复：`remove` 模式写出的 checkpoint 无法恢复

`remove` 以前把替换消息写成普通 `user/message`（`source.kind = 'user'`），`restore()` 找不到 checkpoint
节点，等于“移出后不可恢复”。现在两种模式统一使用官方 `compact-checkpoint` source（合法：它就在本事务
`start…end` 之间），`/mem restore` 对 fold 与 remove 都可用。

### 检查结论：`restore()` 本身不产生 compaction 不变量违规

`restore()` 只用一次 `surfaceOp=replace` 把 checkpoint 节点换成原文 `user/message`，不会新开 compaction 事务：

- 旧的 `compaction/start…end` 早已闭合，替换 checkpoint 节点不改变已提交历史的 replay 校验结果
  （`compaction/summary` 的 shadow span 只在它自己写入的位置被校验一次）；
- 它不在 `compact-checkpoint` 分支里（`source.kind='user'`），不会触发 checkpoint 的 start 配对检查；
- 但新增了防御：日志有 compaction 结构问题（未闭合事务）时拒绝恢复；拒绝改写节点 0 的系统头；
  append 异常会被捕获并返回明确错误（以前会变成未处理的 Promise rejection）。

### 其他

- `/mem diag` 增加 `compaction 事务` 体检结果（发现的括号结构问题逐条列出）。
- `src/host/surgery.js` 的写入逻辑抽成 `foldNow()`，`runMaintenance` 的 rejection 也会转成用户可读错误。
- 新测试（无第三方依赖）：
  - `npm test`：fake Session（复刻真实 append 的“先校验后提交”和 surface replace 规则）单测写入序列、
    compactionId/turn、失败收尾、preflight 拒绝、restore、diag；并用真实官方 invariant 源码
    （若 `.recovery` 存在）对模拟日志做加载期 replay 校验；
  - `npm run test:harness`：把插件真实写入的结果（基于真实已知完好日志 + 真实 `Session.fromRestore`）
    交给 `.recovery/harness/validate.js` 做 format/schema/surface/compaction 四层校验。
- `scripts/build-client.mjs` 重新构建过，`client.js` 与源码一致（本次未改 client 源码，产物哈希不变）。
