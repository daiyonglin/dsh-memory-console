// 真实 replay oracle 的裸模块 stub：只补真实 DSH 源码缺失的包内依赖。
// 这些 stub 不参与插件运行时，只让单测能直接加载 .recovery 下解包的官方 invariant.js。
export function brandString(value) {
  return value
}

export function brandNumber(value) {
  return value
}
