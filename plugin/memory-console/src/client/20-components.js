// 客户端组件（由 scripts/build-client.mjs 注入 client.js）

function pct(part, total) {
  if (!total) return 0
  return Math.max(0, Math.min(100, (part / total) * 100))
}

const CATEGORY_META = [
  { key: 'system', label: '系统提示', color: c.dim },
  { key: 'user', label: '用户消息', color: c.accent },
  { key: 'assistant', label: '助手消息', color: '#a78bfa' },
  { key: 'tool', label: '工具结果', color: '#2dd4bf' },
  { key: 'injection', label: '注入/通知', color: '#f59e0b' },
  { key: 'folded', label: '已收起', color: c.success },
]

function categorySegments(categories) {
  return CATEGORY_META
    .map((meta) => ({ ...meta, value: Number(categories?.[meta.key] ?? 0) }))
    .filter((item) => item.value > 0)
}

function Donut({ segments, total, size, centerLabel, centerSub }) {
  const box = size ?? 76
  const stroke = 10
  const radius = (box - stroke) / 2
  const circumference = 2 * Math.PI * radius
  let offset = 0
  return h('div', { style: { position: 'relative', width: box, height: box, flex: 'none' } },
    h('svg', { width: box, height: box, viewBox: `0 0 ${box} ${box}`, style: { transform: 'rotate(-90deg)' } },
      h('circle', { cx: box / 2, cy: box / 2, r: radius, fill: 'none', stroke: c.layer2, strokeWidth: stroke }),
      segments.map((segment) => {
        const length = total > 0 ? (segment.value / total) * circumference : 0
        const dash = `${Math.max(0, length - 1.5)} ${circumference}`
        const element = h('circle', {
          key: segment.key,
          cx: box / 2,
          cy: box / 2,
          r: radius,
          fill: 'none',
          stroke: segment.color,
          strokeWidth: stroke,
          strokeDasharray: dash,
          strokeDashoffset: -offset,
          strokeLinecap: 'butt',
        })
        offset += length
        return element
      }),
    ),
    h('div', { style: { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 0 } },
      h('div', { style: { fontSize: 12, fontWeight: 600, color: c.text, lineHeight: 1.1 } }, centerLabel ?? fmt(total)),
      centerSub ? h('div', { style: { fontSize: 9, color: c.dim } }, centerSub) : null,
    ),
  )
}

function Legend({ segments, total }) {
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 3, flex: 1, minWidth: 0 } },
    segments.map((segment) => h('div', { key: segment.key, style: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: c.sub } },
      h('span', { style: { width: 7, height: 7, borderRadius: 2, background: segment.color, flex: 'none' } }),
      h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, segment.label),
      h('span', { style: { color: c.dim } }, fmt(segment.value) + ' · ' + Math.round(pct(segment.value, total)) + '%'),
    )),
  )
}

function PressureMeter({ pressure, reclaimable }) {
  const used = Number(pressure?.used ?? 0)
  const limit = Number(pressure?.limit ?? 1_048_576)
  const threshold = Number(pressure?.threshold ?? Math.floor(limit * 0.8))
  const reclaim = Math.max(0, Math.min(Number(reclaimable ?? 0), limit - used))
  const usedPct = pct(used, limit)
  const reclaimPct = pct(reclaim, limit)
  const thresholdPct = pct(threshold, limit)
  const gap = threshold - used
  return h('div', { style: { marginTop: 10 } },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 10, color: c.dim, marginBottom: 4 } },
      h('span', null, '上下文压力 · ' + Math.round(usedPct) + '%'),
      h('span', null, gap > 0 ? '距自动折叠线还差 ' + fmt(gap) : '已超过自动折叠线'),
    ),
    h('div', { style: { position: 'relative', height: 10, borderRadius: 5, background: c.layer2, overflow: 'hidden' } },
      h('div', { style: { position: 'absolute', left: 0, top: 0, bottom: 0, width: usedPct + '%', background: c.accent, opacity: 0.85 } }),
      h('div', { style: { position: 'absolute', left: usedPct + '%', top: 0, bottom: 0, width: reclaimPct + '%', background: c.warn, opacity: 0.35 } }),
      h('div', { title: '自动折叠线 ' + fmt(threshold), style: { position: 'absolute', left: thresholdPct + '%', top: -2, bottom: -2, width: 2, background: c.warn } }),
    ),
    h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 9, color: c.dim, marginTop: 3 } },
      h('span', null, fmt(used) + ' / ' + fmt(limit)),
      h('span', null, '自动折叠线 ≈' + fmt(threshold)),
    ),
  )
}

function TrendChart({ history }) {
  const points = Array.isArray(history) ? history : []
  if (points.length < 2) return null
  const width = 300
  const height = 54
  const maxValue = Math.max(1, ...points.map((point) => point.cumulative))
  const stepX = width / (points.length - 1)
  const coords = points.map((point, index) => [index * stepX, height - (point.cumulative / maxValue) * (height - 4) - 2])
  const line = coords.map((pair) => pair[0].toFixed(1) + ',' + pair[1].toFixed(1)).join(' ')
  const area = `0,${height} ` + line + ` ${width},${height}`
  return h('div', { style: { marginTop: 10 } },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 10, color: c.dim, marginBottom: 2 } },
      h('span', null, '上下文增长（按任务阶段累计）'),
      h('span', null, '峰值 ' + fmt(maxValue)),
    ),
    h('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height: 54, preserveAspectRatio: 'none' },
      h('polygon', { points: area, fill: c.accent, opacity: 0.12 }),
      h('polyline', { points: line, fill: 'none', stroke: c.accent, strokeWidth: 1.4 }),
      points.filter((point) => point.kind === 'checkpoint').map((point) => {
        const index = points.indexOf(point)
        const [x, y] = coords[index]
        return h('circle', { key: 'cp-' + point.index, cx: x, cy: y, r: 2.4, fill: c.success })
      }),
    ),
  )
}

const CATEGORY_DESC = {
  system: '系统提示与工具定义，基本固定成本',
  user: '你输入的消息与命令',
  assistant: '模型回复与推理文本',
  tool: '工具输出，通常是可裁剪的大头',
  injection: '运行时注入、技能目录与子代理通知',
  folded: '已收起摘要与折叠记录',
}

function CompositionCard({ categories, total }) {
  const segments = categorySegments(categories)
  const [hover, setHover] = React.useState(null)
  const box = 78
  const stroke = 10
  const radius = (box - 16) / 2
  const circumference = 2 * Math.PI * radius
  let offset = 0
  const arcs = segments.map((segment) => {
    const length = total > 0 ? (segment.value / total) * circumference : 0
    const arc = { segment, dash: Math.max(0, length - 1.4) + ' ' + circumference, offset: -offset }
    offset += length
    return arc
  })
  const active = segments.find((segment) => segment.key === hover)
  return h('div', { style: { marginTop: 8 } },
    h('div', { style: { display: 'flex', gap: 4, alignItems: 'center' } },
      h('div', { style: { position: 'relative', width: box, height: box, flex: 'none' } },
        h('svg', { width: box, height: box, viewBox: `0 0 ${box} ${box}`, style: { transform: 'rotate(-90deg)' } },
          h('circle', { cx: box / 2, cy: box / 2, r: radius, fill: 'none', stroke: c.layer2, strokeWidth: stroke }),
          arcs.map((arc) => h('circle', {
            key: arc.segment.key,
            cx: box / 2,
            cy: box / 2,
            r: radius,
            fill: 'none',
            stroke: arc.segment.color,
            strokeWidth: hover === arc.segment.key ? 14 : stroke,
            strokeDasharray: arc.dash,
            strokeDashoffset: arc.offset,
            strokeLinecap: 'butt',
            opacity: hover !== null && hover !== arc.segment.key ? 0.22 : 1,
            style: { cursor: 'pointer', transition: 'stroke-width .12s, opacity .12s' },
            onMouseEnter: () => setHover(arc.segment.key),
            onMouseLeave: () => setHover(null),
          })),
        ),
        h('div', { style: { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' } },
          h('div', { style: { fontSize: active ? 13 : 12, fontWeight: 600, color: c.text, lineHeight: 1.1 } },
            active ? Math.round(pct(active.value, total)) + '%' : fmt(total)),
          h('div', { style: { fontSize: 9, color: c.dim, maxWidth: 62, textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            active ? active.label : 'tokens'),
        ),
      ),
      h('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 } },
        segments.map((segment) => h('div', {
          key: segment.key,
          onMouseEnter: () => setHover(segment.key),
          onMouseLeave: () => setHover(null),
          style: {
            display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: c.sub,
            padding: '1px 4px', borderRadius: 4, cursor: 'pointer',
            background: hover === segment.key ? c.hover : 'transparent',
            opacity: hover !== null && hover !== segment.key ? 0.45 : 1,
            transition: 'opacity .12s, background .12s',
          },
        },
          h('span', { style: { width: 7, height: 7, borderRadius: 2, background: segment.color, flex: 'none' } }),
          h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, segment.label),
          h('span', { style: { color: c.dim } }, fmt(segment.value) + ' · ' + Math.round(pct(segment.value, total)) + '%'),
        )),
      ),
    ),
    h('div', { style: { marginTop: 4, fontSize: 10, color: active !== undefined ? c.sub : c.dim, minHeight: 14, lineHeight: '14px' } },
      active !== undefined
        ? `${active.label}：${fmt(active.value)} tokens · ${Math.round(pct(active.value, total))}% —— ${CATEGORY_DESC[active.key] ?? ''}`
        : '悬停环或图例可查看每类内容的说明'),
  )
}

function PressureMeterLive({ pressure, reclaimable }) {
  const [hint, setHint] = React.useState(null)
  const used = Number(pressure?.used ?? 0)
  const limit = Number(pressure?.limit ?? 1_048_576)
  const threshold = Number(pressure?.threshold ?? Math.floor(limit * 0.8))
  const reclaim = Math.max(0, Math.min(Number(reclaimable ?? 0), limit - used))
  const usedPct = pct(used, limit)
  const reclaimPct = pct(reclaim, limit)
  const thresholdPct = pct(threshold, limit)
  const gap = threshold - used
  const hoverProps = (text) => ({
    onMouseEnter: () => setHint(text),
    onMouseLeave: () => setHint(null),
    style: { cursor: 'pointer' },
  })
  return h('div', { style: { marginTop: 10 } },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 10, color: c.dim, marginBottom: 4 } },
      h('span', null, '上下文压力 · ' + Math.round(usedPct) + '%'),
      h('span', null, gap > 0 ? '距自动折叠线还差 ' + fmt(gap) : '已超过自动折叠线'),
    ),
    h('div', { style: { position: 'relative', height: 11, borderRadius: 5.5, background: c.layer2, overflow: 'hidden' } },
      h('div', { ...hoverProps(`已用 ${fmt(used)} tokens（${Math.round(usedPct)}%）`), style: { position: 'absolute', left: 0, top: 0, bottom: 0, width: usedPct + '%', background: c.accent, opacity: 0.85, cursor: 'pointer' } }),
      h('div', {
        ...hoverProps(`可收起 ${fmt(reclaim)} tokens；收起后约 ${fmt(Math.max(0, used - reclaim))}`),
        style: { position: 'absolute', left: usedPct + '%', top: 0, bottom: 0, width: reclaimPct + '%', background: c.warn, opacity: 0.4, cursor: 'pointer' },
      }),
      h('div', {
        ...hoverProps(`自动折叠线 ≈${fmt(threshold)}：超过后官方会自动压缩早期历史`),
        style: { position: 'absolute', left: thresholdPct + '%', top: -2, bottom: -2, width: 2, background: c.warn, cursor: 'pointer' },
      }),
    ),
    h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 9, color: c.dim, marginTop: 3 } },
      h('span', null, fmt(used) + ' / ' + fmt(limit)),
      h('span', null, '自动折叠线 ≈' + fmt(threshold)),
    ),
    h('div', { style: { fontSize: 10, color: c.dim, marginTop: 3, minHeight: 13 } }, hint ?? '悬停色段或竖线查看说明'),
  )
}

function TrendChartLive({ history }) {
  const points = Array.isArray(history) ? history : []
  const [hover, setHover] = React.useState(null)
  if (points.length < 2) return null
  const width = 300
  const height = 64
  const padTop = 4
  const padBottom = 4
  const innerH = height - padTop - padBottom
  const maxValue = Math.max(1, ...points.map((point) => point.cumulative))
  const stepX = width / (points.length - 1)
  const coords = points.map((point, index) => ({
    x: index * stepX,
    y: padTop + innerH - (point.cumulative / maxValue) * innerH,
  }))
  const line = coords.map((pair) => pair.x.toFixed(1) + ',' + pair.y.toFixed(1)).join(' ')
  const area = `0,${padTop + innerH} ` + line + ` ${width},${padTop + innerH}`
  const gridYs = [padTop, padTop + innerH / 2, padTop + innerH]
  const hoverPoint = hover !== null ? points[hover] : null
  return h('div', { style: { marginTop: 10 } },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 10, color: c.dim, marginBottom: 2 } },
      h('span', null, '上下文增长（按任务阶段累计）'),
      h('span', null, '峰值 ' + fmt(maxValue)),
    ),
    h('div', { style: { display: 'flex', gap: 4, alignItems: 'stretch' } },
      h('div', {
        style: {
          width: 34, flex: 'none', height: 64, display: 'flex', flexDirection: 'column',
          justifyContent: 'space-between', alignItems: 'flex-end', fontSize: 8, color: c.dim, lineHeight: 1,
        },
      },
        h('span', null, fmt(maxValue)),
        h('span', null, fmt(Math.round(maxValue / 2))),
        h('span', null, '0'),
      ),
      h('div', { style: { flex: 1, minWidth: 0 } },
        h('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height: 64, preserveAspectRatio: 'none', style: { display: 'block' } },
          gridYs.map((y, index) => h('line', {
            key: 'grid-' + index, x1: 0, x2: width, y1: y, y2: y,
            stroke: c.border, strokeWidth: 0.6, strokeDasharray: '2 3',
          })),
          h('line', { x1: 0, x2: 0, y1: padTop, y2: padTop + innerH, stroke: c.border, strokeWidth: 0.6 }),
          h('line', { x1: 0, x2: width, y1: padTop + innerH, y2: padTop + innerH, stroke: c.border, strokeWidth: 0.6 }),
          h('polygon', { points: area, fill: c.accent, opacity: 0.12 }),
          h('polyline', { points: line, fill: 'none', stroke: c.accent, strokeWidth: 1.4 }),
          points.filter((point) => point.kind === 'checkpoint').map((point) => {
            const index = points.indexOf(point)
            return h('circle', { key: 'cp-' + point.index, cx: coords[index].x, cy: coords[index].y, r: 2.2, fill: c.success })
          }),
          hover !== null
            ? h('g', null,
                h('line', { x1: coords[hover].x, x2: coords[hover].x, y1: padTop, y2: padTop + innerH, stroke: c.sub, strokeWidth: 0.8, strokeDasharray: '2 2' }),
                h('circle', { cx: coords[hover].x, cy: coords[hover].y, r: 3, fill: c.text, stroke: c.layer, strokeWidth: 1 }),
              )
            : null,
          points.map((point, index) => h('rect', {
            key: 'hit-' + point.index,
            x: Math.max(0, index * stepX - stepX / 2),
            y: 0,
            width: Math.max(2, stepX),
            height,
            fill: 'transparent',
            style: { cursor: 'crosshair' },
            onMouseEnter: () => setHover(index),
            onMouseLeave: () => setHover(null),
          })),
        ),
        h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 8, color: c.dim, marginTop: 2 } },
          h('span', null, '#' + points[0].index),
          h('span', null, '#' + points[Math.floor(points.length / 2)].index),
          h('span', null, '#' + points[points.length - 1].index),
        ),
      ),
    ),
    h('div', { style: { fontSize: 10, color: c.dim, marginTop: 2, minHeight: 13 } },
      hoverPoint !== null
        ? `阶段 #${hoverPoint.index}：本段 ${fmt(hoverPoint.tokens)} · 累计 ${fmt(hoverPoint.cumulative)}${hoverPoint.kind === 'checkpoint' ? ' · 已收起' : ''}`
        : '横轴：任务阶段序号；纵轴：累计 tokens；绿点 = 收起发生的阶段'),
  )
}

function MiniStack({ cat, total, foldable }) {
  const segments = categorySegments(cat)
  const sum = total || segments.reduce((acc, item) => acc + item.value, 0)
  return h('div', { style: { marginLeft: 30, marginTop: 5, height: 5, borderRadius: 2.5, background: c.layer2, overflow: 'hidden', display: 'flex' } },
    segments.map((segment) => h('div', {
      key: segment.key,
      title: segment.label + ' ' + fmt(segment.value),
      style: { width: pct(segment.value, sum) + '%', height: '100%', background: segment.color, opacity: foldable === false ? 0.45 : 0.8 },
    })),
  )
}

function Header({ snapshot, busy, error, onRefresh }) {
  const total = snapshot?.totalTokens ?? 0
  const reclaim = snapshot?.reclaimable ?? 0
  const phases = snapshot?.phases ?? []
  const foldedTokens = snapshot?.stats?.foldedTokens ?? 0
  const foldedCount = snapshot?.stats?.foldedCount ?? 0
  const originTotal = snapshot?.originTotal ?? total
  const categories = snapshot?.categories ?? {}
  const segments = categorySegments(categories)
  return h('div', { style: { padding: '12px 14px 10px', borderBottom: '1px solid ' + c.border } },
    h('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 } },
      h('div', { style: { fontSize: 14, fontWeight: 600, color: c.text } }, '记忆控制台'),
      h('button', {
        type: 'button', onClick: onRefresh, disabled: busy,
        style: { background: 'transparent', border: '1px solid ' + c.border, color: c.sub, borderRadius: 6, padding: '2px 8px', fontSize: 12, cursor: 'pointer' },
      }, busy ? '刷新中' : '刷新'),
    ),
    h('div', { style: { display: 'flex', gap: 12, marginTop: 8, fontSize: 12, color: c.sub, flexWrap: 'wrap' } },
      h('span', null, '模型视图 ', h('b', { style: { color: c.text } }, fmt(total))),
      h('span', null, '可收起 ', h('b', { style: { color: c.warn } }, fmt(reclaim))),
      h('span', { style: { color: c.dim } }, phases.length + ' 段'),
      foldedCount > 0
        ? h('span', { style: { color: c.success } }, '已收起 ' + foldedCount + ' 段 · 累计 ' + fmt(foldedTokens))
        : null,
    ),
    foldedTokens > 0
      ? h('div', { style: { marginTop: 6, fontSize: 10, color: c.dim } },
          '原始累计 ' + fmt(originTotal) + ' → 现在 ' + fmt(total) + '（已收起 ' + Math.round(pct(foldedTokens, Math.max(originTotal, 1))) + '%）')
      : null,
    h(CompositionCard, { categories, total }),
    h(PressureMeterLive, { pressure: snapshot?.pressure, reclaimable: reclaim }),
    h(TrendChartLive, { history: snapshot?.history }),
    error !== null
      ? h('div', { style: { marginTop: 8, fontSize: 11, color: c.warn } }, String(error))
      : null,
  )
}

function PhaseRow({ phase, maxTokens, onAction, onRestore, onToggle, selected, disabled }) {
  const [expanded, setExpanded] = React.useState(false)
  const canAct = phase.foldable === true
  const isCheckpoint = phase.checkpoint === true
  const isSystem = phase.kind === 'system'
  const color = isCheckpoint ? c.success : isSystem ? c.dim : c.accent
  const badge = isCheckpoint ? '已收起' : isSystem ? '系统' : ''
  return h('div', {
    style: { padding: '10px 14px', borderBottom: '1px solid ' + c.border },
    onMouseEnter: (event) => { event.currentTarget.style.background = c.hover },
    onMouseLeave: (event) => { event.currentTarget.style.background = 'transparent' },
  },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
      canAct
        ? h('input', {
            type: 'checkbox',
            checked: selected === true,
            disabled,
            onChange: () => onToggle(phase.index),
            'aria-label': '选择阶段 ' + phase.index,
            style: { width: 13, height: 13, accentColor: c.accent, cursor: 'pointer' },
          })
        : h('span', { style: { width: 13 } }),
      h('span', { style: { width: 22, color: c.dim, fontSize: 12 } }, '#' + phase.index),
      badge !== ''
        ? h('span', { style: { fontSize: 10, color, border: '1px solid ' + c.border, borderRadius: 4, padding: '0 4px' } }, badge)
        : null,
      h('span', {
        title: phase.title,
        style: { flex: 1, fontSize: 13, color: isCheckpoint ? c.sub : c.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      }, phase.title),
      h('span', { style: { fontSize: 11, color: isCheckpoint ? c.success : c.warn, whiteSpace: 'nowrap' } }, isCheckpoint ? '—' : fmt(phase.tokens)),
    ),
    h(MiniStack, { cat: phase.cat, total: phase.tokens, foldable: phase.foldable }),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 5, marginLeft: 30, fontSize: 11, color: c.dim, flexWrap: 'wrap' } },
      h('span', null, phase.nodes + ' 条'),
      h('span', null, '工具 ' + phase.tools),
      phase.notices > 0 ? h('span', null, '通知 ' + phase.notices) : null,
      h('span', null, fmt(phase.tokens) + ' tokens'),
      !canAct && phase.foldable === false && phase.reason !== '' && !isCheckpoint && phase.kind === 'task'
        ? h('span', null, '· ' + phase.reason)
        : null,
      isCheckpoint && phase.compactionId
        ? h('span', { style: { marginLeft: 'auto', display: 'flex', gap: 6 } },
            h('button', {
              type: 'button', onClick: () => setExpanded((value) => !value),
              style: { background: 'transparent', border: '1px solid ' + c.border, color: c.sub, borderRadius: 5, padding: '1px 8px', fontSize: 11, cursor: 'pointer' },
            }, expanded ? '收起摘要' : '查看摘要'),
            h('button', {
              type: 'button', disabled, onClick: () => onRestore(phase.compactionId),
              style: { background: 'transparent', border: '1px solid ' + c.border, color: c.accent, borderRadius: 5, padding: '1px 8px', fontSize: 11, cursor: 'pointer' },
            }, '恢复'),
          )
        : canAct
          ? h('span', { style: { marginLeft: 'auto', display: 'flex', gap: 6 } },
              h('button', {
                type: 'button', disabled,
                onClick: () => onAction({ action: 'fold', phaseIndex: phase.index }),
                style: { background: 'transparent', border: '1px solid ' + c.border, color: c.accent, borderRadius: 5, padding: '1px 8px', fontSize: 11, cursor: 'pointer' },
              }, '收起'),
              h('button', {
                type: 'button', disabled,
                onClick: () => onAction({ action: 'remove', phaseIndex: phase.index }),
                style: { background: 'transparent', border: '1px solid ' + c.border, color: c.dim, borderRadius: 5, padding: '1px 8px', fontSize: 11, cursor: 'pointer' },
              }, '移出'),
            )
          : null,
    ),
    expanded && isCheckpoint
      ? h('pre', {
          style: {
            margin: '8px 0 0 30px', padding: 10, borderRadius: 6, background: c.layer2,
            border: '1px solid ' + c.border, whiteSpace: 'pre-wrap', fontFamily: 'inherit',
            fontSize: 11, lineHeight: 1.6, color: c.sub, maxHeight: 260, overflowY: 'auto',
          },
        }, String(phase.summaryPreview ?? '（摘要为空）'))
      : null,
  )
}

function BlockRow({ block, onRestore, disabled }) {
  return h('div', { style: { padding: '8px 14px', borderBottom: '1px solid ' + c.border, fontSize: 11, color: c.sub } },
    h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
      h('span', { style: { color: block.onSurface ? c.success : c.dim } }, block.onSurface ? '生效中' : '已恢复'),
      h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, block.id),
      block.onSurface
        ? h('button', {
            type: 'button', disabled,
            onClick: () => onRestore(block.id),
            style: { background: 'transparent', border: '1px solid ' + c.border, color: c.accent, borderRadius: 5, padding: '1px 8px', fontSize: 11, cursor: 'pointer' },
          }, '恢复')
        : null,
    ),
    h('div', { style: { marginTop: 2, color: c.dim } }, fmt(block.tokens) + ' tokens'),
  )
}

function Preview({ pending, busy, onCancel, onConfirm }) {
  return h('div', { style: { padding: 14, background: c.layer2, borderTop: '1px solid ' + c.border, maxHeight: 340, overflowY: 'auto' } },
    h('div', { style: { fontSize: 13, fontWeight: 600, color: c.text, marginBottom: 8 } },
      pending.action === 'foldMany' ? '确认批量收起？' : pending.action === 'fold' ? '确认收起这一阶段？' : '确认移出这一阶段？'),
    h('pre', { style: { whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 11, lineHeight: 1.6, color: c.sub, margin: 0 } }, String(pending.preview ?? '')),
    h('div', { style: { display: 'flex', gap: 8, marginTop: 10 } },
      h('button', {
        type: 'button', disabled: busy, onClick: onConfirm,
        style: { background: c.btn, color: c.btnText, border: 'none', borderRadius: 6, padding: '5px 14px', fontSize: 12, cursor: 'pointer' },
      }, busy ? '执行中…' : '确认'),
      h('button', {
        type: 'button', disabled: busy, onClick: onCancel,
        style: { background: 'transparent', color: c.sub, border: '1px solid ' + c.border, borderRadius: 6, padding: '5px 14px', fontSize: 12, cursor: 'pointer' },
      }, '取消'),
    ),
  )
}

function TabTitle() {
  return h('span', null, '记忆')
}

function TabIcon({ size }) {
  const s = size ?? 18
  return h('svg', { viewBox: '0 0 24 24', width: s, height: s, 'aria-hidden': true, style: { display: 'block' } },
    h('rect', { x: 3, y: 5, width: 18, height: 14, rx: 2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }),
    h('path', { d: 'M6 9h8M6 12h12M6 15h9', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
  )
}
