# dsh-memory-console

Per-task context management for DeepSeek Harness — inspect token usage by task phase, then **fold**, **remove**, or **restore** a phase through the official compaction protocol.

> 按任务阶段查看并管理 DSH 会话上下文：收起 / 移出 / 恢复，只改模型视图，日志永远保留。

- Full documentation, screenshots and design notes: **https://github.com/daiyonglin/dsh-memory-console**
- License: MIT

## Install

```bash
dsh plugin --profile desktop add dsh-memory-console
```

Then open the **记忆 / Memory** tab in the session's right sidebar. A full-page **记忆中心 / Memory Center** is available from the sidebar panel list.

## What it does

- Split a session into readable **task phases** (system injections, skill catalogs and subagent notices are grouped automatically).
- Show what the context is made of: composition ring, pressure meter vs. the auto-compaction line, and a growth chart.
- Preview exactly what the model will see before folding a phase.
- Write the official compaction transaction (`start → summary → replacement → end`), with preflight validation, failure closing and restore support.
- Batch select phases, inspect folded summaries, restore originals.

## Commands

`/mem report`, `/mem dryrun <n>`, `/mem fold <n> --yes`, `/mem remove <n> --yes`, `/mem restore <id>`, `/mem status`, `/mem diag`.

## Development

```bash
node scripts/build-client.mjs
npm test
```

MIT © 2026 daiyonglin
