// 客户端应用：右侧栏面板 Body 与注册逻辑（由 scripts/build-client.mjs 注入 client.js）

function Body(props) {
  const sessionId = props?.sessionId
  // api 必须在 apply 里创建一次并作为稳定 prop 传入；
  // 若在 render 里按内联 getter 创建，useCallback/useEffect 每帧变化会形成刷新死循环（面板会整块空白）。
  const api = props?.api ?? createApi()
  const [snapshot, setSnapshot] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [pending, setPending] = React.useState(null)
  const [result, setResult] = React.useState(null)
  const [selected, setSelected] = React.useState(() => new Set())

  const refresh = React.useCallback(async () => {
    if (sessionId === undefined || sessionId === null) return
    try {
      const value = await api.call('snapshot', { sessionId })
      setSnapshot(value)
      setError(null)
    } catch (failure) {
      setError(String(failure?.message ?? failure))
    }
  }, [api, sessionId])

  React.useEffect(() => {
    void refresh()
    const timer = setInterval(() => { void refresh() }, 2500)
    return () => clearInterval(timer)
  }, [refresh])

  const onAction = async ({ action, phaseIndex }) => {
    setResult(null)
    setBusy(true)
    try {
      const value = await api.call('act', { sessionId, action, phaseIndex, confirm: false })
      setPending({ action, phaseIndex, preview: value?.preview ?? '' })
    } catch (failure) {
      setError(String(failure?.message ?? failure))
    } finally { setBusy(false) }
  }

  const onConfirm = async () => {
    if (pending === null) return
    setBusy(true)
    try {
      if (pending.action === 'foldMany') {
        const value = await api.call('act', { sessionId, action: 'foldMany', phaseIndexes: pending.phaseIndexes, confirm: true })
        setResult(value?.text ?? '完成')
        setSelected(new Set())
      } else {
        const value = await api.call('act', { sessionId, action: pending.action, phaseIndex: pending.phaseIndex, confirm: true })
        setResult(value?.text ?? '完成')
      }
      setPending(null)
      await refresh()
    } catch (failure) {
      setError(String(failure?.message ?? failure))
    } finally { setBusy(false) }
  }

  const onRestore = async (compactionId) => {
    setBusy(true)
    setError(null)
    try {
      const value = await api.call('act', { sessionId, action: 'restore', compactionId })
      setResult(value?.text ?? '已恢复')
      await refresh()
    } catch (failure) {
      setError(String(failure?.message ?? failure))
    } finally { setBusy(false) }
  }

  if (sessionId === undefined || sessionId === null) {
    return h('div', { style: { padding: 14, color: c.dim, fontSize: 12 } }, '请在会话中打开此面板。')
  }

  const phases = snapshot?.phases ?? []
  const blocks = snapshot?.blocks ?? []
  const maxTokens = phases.reduce((max, phase) => Math.max(max, phase.tokens), 1)
  const suggestions = snapshot?.suggestions ?? []
  const selectedPhases = phases.filter((phase) => selected.has(phase.index))
  const selectedTokens = selectedPhases.reduce((sum, phase) => sum + phase.tokens, 0)

  const toggleSelected = (index) => {
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }
  const selectSuggestions = () => setSelected(new Set(suggestions.map((item) => item.phaseIndex)))
  const openBatchPreview = () => {
    if (selectedPhases.length === 0) return
    setPending({
      action: 'foldMany',
      phaseIndexes: selectedPhases.map((phase) => phase.index),
      preview: [
        `将收起 ${selectedPhases.length} 个任务阶段，合计约 ${fmt(selectedTokens)} tokens。`,
        '每段会独立写入一条官方 compaction 事务（聊天里会出现对应数量的“上下文已压缩”折叠行）。',
        '原文全部保留在会话日志，可逐段恢复。',
      ].join('\n'),
    })
  }

  return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: c.layer, color: c.text } },
    h(Header, { snapshot, busy, error, onRefresh: () => { void refresh() } }),
    suggestions.length > 0 && selected.size === 0
      ? h('div', {
          style: { padding: '8px 14px', borderBottom: '1px solid ' + c.border, display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: c.sub },
        },
          h('span', { style: { flex: 1 } }, `⚡ ${suggestions.length} 段建议收起（共 ${fmt(suggestions.reduce((sum, item) => sum + item.tokens, 0))} tokens）`),
          h('button', {
            type: 'button', disabled: busy, onClick: selectSuggestions,
            style: { background: 'transparent', border: '1px solid ' + c.border, color: c.accent, borderRadius: 5, padding: '1px 8px', fontSize: 11, cursor: 'pointer' },
          }, '一键选择'),
        )
      : null,
    result !== null
      ? h('div', { style: { padding: '8px 14px', color: c.success, fontSize: 12, borderBottom: '1px solid ' + c.border } }, String(result))
      : null,
    pending !== null
      ? h(Preview, { pending, busy, onCancel: () => setPending(null), onConfirm: () => { void onConfirm() } })
      : null,
    h('div', { style: { flex: 1, minHeight: 0, overflowY: 'auto' } },
      h('div', { style: { padding: '8px 14px 4px', fontSize: 11, color: c.dim, textTransform: 'uppercase', letterSpacing: 1 } }, '任务阶段'),
      phases.length === 0
        ? h('div', { style: { padding: '10px 14px', fontSize: 12, color: c.dim } }, '还没有可显示的阶段。')
        : phases.map((phase) => h(PhaseRow, {
            key: phase.index,
            phase,
            maxTokens,
            onAction,
            onRestore,
            onToggle: toggleSelected,
            selected: selected.has(phase.index),
            disabled: busy,
          })),
      blocks.length > 0
        ? h('div', { style: { padding: '12px 14px 4px', fontSize: 11, color: c.dim, textTransform: 'uppercase', letterSpacing: 1 } }, '已收起 / 已移出')
        : null,
      blocks.map((block) => h(BlockRow, { key: block.id, block, onRestore, disabled: busy })),
    ),
    selected.size > 0
      ? h('div', {
          style: { padding: '8px 14px', borderTop: '1px solid ' + c.border, display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: c.sub },
        },
          h('span', { style: { flex: 1 } }, `已选 ${selectedPhases.length} 段 · 合计 ${fmt(selectedTokens)} tokens`),
          h('button', {
            type: 'button', disabled: busy, onClick: openBatchPreview,
            style: { background: c.btn, color: c.btnText, border: 'none', borderRadius: 5, padding: '3px 10px', fontSize: 11, cursor: 'pointer' },
          }, '收起所选'),
          h('button', {
            type: 'button', disabled: busy, onClick: () => setSelected(new Set()),
            style: { background: 'transparent', border: '1px solid ' + c.border, color: c.dim, borderRadius: 5, padding: '3px 8px', fontSize: 11, cursor: 'pointer' },
          }, '清空'),
        )
      : null,
    h('div', { style: { padding: '8px 14px', borderTop: '1px solid ' + c.border, fontSize: 11, color: c.dim } },
      '只改模型视图；聊天记录与日志永远保留。'),
  )
}

function MemoryCenterPage(props) {
  const api = props?.api
  const [sessions, setSessions] = React.useState([])
  const [selected, setSelected] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [loading, setLoading] = React.useState(false)

  const refresh = React.useCallback(async () => {
    if (api === undefined) return
    setLoading(true)
    try {
      const value = await api.call('sessions', {})
      const list = Array.isArray(value) ? value : []
      setSessions(list)
      setSelected((previous) => (previous !== null && list.some((item) => item.id === previous) ? previous : list[0]?.id ?? null))
      setError(null)
    } catch (failure) {
      setError(String(failure?.message ?? failure))
    } finally {
      setLoading(false)
    }
  }, [api])

  React.useEffect(() => { void refresh() }, [refresh])

  const selectedItem = sessions.find((item) => item.id === selected) ?? null

  return h('div', { style: { display: 'flex', height: '100%', minHeight: 0, background: c.layer, color: c.text } },
    h('div', { style: { width: 240, flex: 'none', borderRight: '1px solid ' + c.border, display: 'flex', flexDirection: 'column', minHeight: 0 } },
      h('div', { style: { padding: '12px 12px 8px', borderBottom: '1px solid ' + c.border } },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
          h('div', { style: { fontSize: 14, fontWeight: 600 } }, '记忆中心'),
          h('button', {
            type: 'button', disabled: loading, onClick: () => { void refresh() },
            style: { background: 'transparent', border: '1px solid ' + c.border, color: c.sub, borderRadius: 5, padding: '1px 7px', fontSize: 11, cursor: 'pointer' },
          }, loading ? '刷新中' : '刷新'),
        ),
        h('div', { style: { marginTop: 4, fontSize: 10, color: c.dim } }, '仅显示主会话（子代理/编队会话已隐藏）'),
      ),
      h('div', { style: { flex: 1, minHeight: 0, overflowY: 'auto' } },
        sessions.length === 0
          ? h('div', { style: { padding: 12, fontSize: 11, color: c.dim } }, '没有可见会话。先在会话中打开右侧栏「记忆」面板，再回到这里。')
          : sessions.map((session) => h('div', {
              key: session.id,
              onClick: () => setSelected(session.id),
              style: {
                padding: '8px 12px', borderBottom: '1px solid ' + c.border, cursor: 'pointer',
                background: selected === session.id ? c.hover : 'transparent',
                opacity: session.live === false ? 0.62 : 1,
              },
            },
              h('div', { style: { fontSize: 12, color: c.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, session.title),
              h('div', { style: { marginTop: 2, fontSize: 9, color: c.dim } },
                (session.live === false ? '未打开' : fmt(session.tokens) + ' tokens') +
                  ' · ' +
                  (session.live === false ? '历史会话' : session.phases + ' 段') +
                  (session.origin === 'subagent' ? ' · 子代理' : '')),
            )),
      ),
      error !== null ? h('div', { style: { padding: 8, fontSize: 10, color: c.warn } }, String(error)) : null,
    ),
    h('div', { style: { flex: 1, minWidth: 0, height: '100%' } },
      selected === null
        ? h('div', { style: { padding: 24, fontSize: 12, color: c.dim } }, '选择左侧会话，查看并管理它的上下文。')
        : selectedItem !== null && selectedItem.live === false
          ? h('div', { style: { padding: 24, fontSize: 12, color: c.dim, lineHeight: 1.8 } },
              '「' + selectedItem.title + '」尚未打开。',
              h('div', { style: { marginTop: 6 } }, '冷会话无法直接改写上下文：请先在主界面打开它（或在右侧栏「记忆」面板里打开一次），再回到记忆中心管理。'))
          : h(PanelBoundary, null, h(Body, { sessionId: selected, api })),
    ),
  )
}

class PanelBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error) {
    return { error }
  }
  componentDidCatch(error) {
    console.error('memory-console: 面板渲染失败', error)
  }
  render() {
    if (this.state.error !== null) {
      return h('div', { style: { padding: 14, color: c.warn, fontSize: 12, lineHeight: 1.6 } },
        '记忆控制台渲染失败：' + String(this.state.error?.message ?? this.state.error))
    }
    return this.props.children
  }
}

function apply(ctx) {
  const api = createApi(() => ctx.get('connection')?.rpc)
  const BodyWithApi = (props) => h(PanelBoundary, null, h(Body, { ...props, api }))
  const disposers = []

  ctx.inject(['sidebarRightTabs'], (scope) => {
    try {
      disposers.push(scope.sidebarRightTabs.register({
        id: TAB_ID,
        kind: TAB_KIND,
        title: () => '记忆',
        guide: [{
          order: 40,
          title: () => '记忆控制台',
          description: () => '按任务阶段查看并管理模型上下文',
          icon: TabIcon,
        }],
      }))
      disposers.push(scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
        name: 'sidebar.right.pane.tab',
        key: TAB_ID,
      }, BodyWithApi)))
      disposers.push(scope.slots.inject('sidebar.right.pane.tab.title', () => scope.slots.register({
        name: 'sidebar.right.pane.tab.title',
        key: TAB_ID,
      }, TabTitle)))
      disposers.push(scope.slots.inject('main', () => scope.slots.register({
        name: 'main',
        key: 'memory-center',
      }, (pageProps) => h(PanelBoundary, null, h(MemoryCenterPage, { ...pageProps, api })))))
      disposers.push(scope.slots.inject('sidebar.panellist', () => scope.slots.register({
        name: 'sidebar.panellist',
        id: 'memory-center',
        order: 45,
        label: () => '记忆中心',
      }, (entryProps) => h(TabIcon, { size: entryProps?.size ?? 18 }))))
    } catch (failure) {
      console.error('memory-console: 注册右栏面板失败', failure)
      for (const dispose of disposers) { try { dispose() } catch { /* ignore */ } }
    }
  })

  ctx.effect(() => () => {
    for (const dispose of disposers) { try { dispose() } catch { /* ignore */ } }
  }, 'memory-console: client cleanup')
}
