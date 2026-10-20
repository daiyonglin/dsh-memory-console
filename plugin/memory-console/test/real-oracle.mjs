// 用 .recovery 下解包的“真实 DSH 源码”跑加载期 replay（可选增强 oracle）。
//
// 加载链：真实 dsh-compaction/lib/types/invariant.js
//   → resolve hooks 把 '@deepseek-ai/dsh-session' 换成最小 stub
//   → '@deepseek-ai/dsh-session/surface' 用真实的 surface.js（含真实 SurfaceManager 折叠）
//   → 真实 surface.js 依赖的 '@deepseek-ai/dsh-brand' 换成最小 stub
// 这样可以直接调用官方 apply(ctx)，让它按线上同款 seed() 规则校验我们产出的日志。
// 若 .recovery 不存在（插件独立分发场景），返回 { available: false } 并由测试打印跳过原因。
import { existsSync } from 'node:fs'
import { register } from 'node:module'
import { fileURLToPath } from 'node:url'

const invariantUrl = new URL(
  '../../../.recovery/src/dsh/node_modules/@deepseek-ai/dsh-compaction/lib/types/invariant.js',
  import.meta.url,
)

let loadPromise

/** 动态加载官方 invariant 模块（失败时返回 null，不影响主测试）。 */
export function loadRealInvariant() {
  if (!existsSync(fileURLToPath(invariantUrl))) return Promise.resolve(null)
  loadPromise ??= (async () => {
    register(new URL('./real-oracle-hooks.mjs', import.meta.url).href)
    return import(invariantUrl.href)
  })()
  return loadPromise
}

/**
 * 让官方 invariant 插件对本会话日志做一次完整 seed() replay。
 * @param {any} session - 需要 snapshotEvents()（可用 FakeSession）
 * @returns {Promise<{available:boolean, ok:boolean|null, error:string|null}>}
 */
export async function runRealInvariantOracle(session) {
  let mod
  try {
    mod = await loadRealInvariant()
  } catch (error) {
    return { available: false, ok: null, error: `真实 oracle 加载失败：${String(error?.message ?? error)}` }
  }
  if (mod === null) return { available: false, ok: null, error: null }

  const fail = (message) => {
    throw new Error(message)
  }
  const ctx = {
    invariants: {
      // 真实 invariant 的 apply() 会把 install(ctx, fail) 交给注册中心；这里直接调用。
      register: (_name, install) => {
        install(ctx, fail)
      },
    },
    sessions: { list: () => [session], messageProjections: [] },
    on: () => {},
  }
  try {
    await mod.apply(ctx)
    return { available: true, ok: true, error: null }
  } catch (error) {
    return { available: true, ok: false, error: String(error?.message ?? error) }
  }
}
