// 客户端核心：常量、格式化、RPC 封装（由 scripts/build-client.mjs 注入 client.js）
const CHANNEL = '/memory-console'
const TAB_ID = 'memory-console-tab'
const TAB_KIND = 'memory-console'

const c = {
  text: 'var(--dsw-alias-label-primary, #e5e5e5)',
  sub: 'var(--dsw-alias-label-secondary, #a1a1aa)',
  dim: 'var(--dsw-alias-label-tertiary, #71717a)',
  border: 'var(--dsw-alias-border-l1, rgba(255,255,255,.08))',
  layer: 'var(--dsw-alias-bg-layer-1, #18181b)',
  layer2: 'var(--dsw-alias-bg-layer-2, #202024)',
  hover: 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.06))',
  accent: 'var(--dsw-alias-accent, #4f8cff)',
  warn: 'var(--dsw-alias-state-warn-primary, #f59e0b)',
  success: 'var(--dsw-alias-state-success-primary, #22c55e)',
  btn: 'var(--dsw-alias-button-info-fill, #2563eb)',
  btnText: 'var(--dsw-alias-button-info-label, #ffffff)',
}

function fmt(value) {
  const n = Number(value) || 0
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return String(n)
}

function createApi(getRpc) {
  // 面板数据走 Host 的 POST 路由（与 dsh-context 相同），不依赖 WebSocket RPC。
  return {
    async call(endpoint, payload) {
      let response
      try {
        response = await fetch('/api/memory-console', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint, payload }),
        })
      } catch (failure) {
        throw new Error('无法连接 Host：' + String(failure?.message ?? failure))
      }
      if (response.status === 404) throw new Error('Host 未注册记忆控制台路由（插件可能未启用）')
      if (!response.ok) throw new Error('HTTP ' + response.status)
      const data = await response.json()
      if (data === null || data === undefined || data.ok !== true) throw new Error(data?.error?.message ?? ('调用 ' + endpoint + ' 失败'))
      return data.value
    },
  }
}
