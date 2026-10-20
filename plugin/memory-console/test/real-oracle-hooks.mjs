// 真实 replay oracle 的 ESM resolve hooks：
// 把官方 invariant.js 的裸包导入映射到 .recovery 下的真实源码 / 最小 stub。
const recovery = new URL('../../../.recovery/src/dsh/node_modules/@deepseek-ai/', import.meta.url)
const stubs = new URL('./real-oracle-stubs/', import.meta.url)

const mapping = {
  '@deepseek-ai/dsh-session': new URL('dsh-session.js', stubs),
  '@deepseek-ai/dsh-session/surface': new URL('dsh-session/lib/types/surface.js', recovery),
  '@deepseek-ai/dsh-brand': new URL('dsh-brand.js', stubs),
}

export async function resolve(specifier, context, nextResolve) {
  const target = Object.hasOwn(mapping, specifier) ? mapping[specifier] : undefined
  if (target !== undefined) return { url: target.href, shortCircuit: true }
  return nextResolve(specifier, context)
}
