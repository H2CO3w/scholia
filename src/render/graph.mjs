/**
 * graph.mjs — 依赖图谱 → **单文件自包含 SVG**（纯字符串生成，不碰 DOM、不写文件）
 *
 * 依据：INTERFACES 附录 G.4（v1.4）。
 * 与论文视图的关系：论文视图（html.mjs / assets.mjs）仍是零脚本的一页一声明；这里是「整棵树」那张图。
 * **本期图谱同样是零脚本的静态 SVG**——平移缩放与点击下钻是下一期的事，本期只把钩子留好：
 *   - 每个节点 `<g data-a4m-mod="<模块名>">`（将来「点节点 → 打开该模块的论文页」直接用它）
 *   - 节点 `<title>` 给全名（零脚本也有的原生悬停交互：标签截断了也看得到全名）
 *
 * 视觉语言与论文视图一致：同一套衬线字体栈与配色变量，**不是深色主题**——
 * 这是论文项目的图谱，不是游戏引擎皮肤。图谱场景允许描边/填充（论文正文不许）。
 */

import { escapeHtml } from './lean-math.mjs'

/** 与 assets.mjs 的 `:root` 逐字一致（那边是论文视图的基线，不许改；测试会把两者钉在一起）。 */
export const GRAPH_PALETTE = Object.freeze({
  fg: '#000',
  muted: '#555',
  serif: 'Georgia, "Times New Roman", "Songti SC", "Source Han Serif SC", serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
})

/** 图谱样式表文件名（内嵌进 SVG，也由 renderGraphAssets 交付）。 */
export const GRAPH_CSS_FILENAME = 'a4m-graph.css'

const COLUMN_GAP = 28
const ROW_GAP = 8
const MARGIN_LEFT = 24
const MARGIN_RIGHT = 24
const MARGIN_TOP = 76
const MARGIN_BOTTOM = 104
const LABEL_PAD = 7

/** id 片段：模块名里 `.` / 非法字符统一换成 `-`，保证 `id` 可预期且唯一。 */
function slugOf(raw) {
  return String(raw).replace(/[^A-Za-z0-9_-]/g, '-')
}

/** 标签截断：按字符数（不按字节），超长给省略号；全名永远在 `<title>` 里。 */
function truncateLabel(raw, maxChars) {
  const text = String(raw)
  if (maxChars <= 0 || text.length <= maxChars) return text
  return `${text.slice(0, Math.max(1, maxChars - 1))}…`
}

function css() {
  return `/*! ${GRAPH_CSS_FILENAME} — dependency graph (static SVG, no script; palette shared with the paper view)
 *  Three node classes follow the Appendix G.4 legend: project module / Mathlib boundary (an edge leaves the project) / outside the dependency cone.
 */
.a4m-graph { font-family: ${GRAPH_PALETTE.serif}; background: #fff; }
.a4m-graph__title { fill: ${GRAPH_PALETTE.fg}; font-size: 15px; font-weight: 700; }
.a4m-graph__stat { fill: ${GRAPH_PALETTE.muted}; font-size: 11px; }
.a4m-graph__colhead { fill: ${GRAPH_PALETTE.muted}; font-size: 10px; letter-spacing: .08em; }
/* group container: a hook for the next phase (pan/zoom/click per group); carries no visuals itself */
.a4m-graph__columns { }
.a4m-graph__edges { }
.a4m-graph__nodes { }
.a4m-graph__legend { }
.a4m-graph__legend-item { }
.a4m-graph__bg { fill: #fff; }
.a4m-graph__edge { fill: none; stroke: ${GRAPH_PALETTE.muted}; stroke-width: .7; }
.a4m-graph__edge--external { stroke-dasharray: 3 3; }
.a4m-graph__node .a4m-graph__box { fill: #fff; stroke: ${GRAPH_PALETTE.fg}; stroke-width: .9; }
.a4m-graph__node .a4m-graph__label { fill: ${GRAPH_PALETTE.fg}; font-size: 10.5px; }
.a4m-graph__node--external .a4m-graph__box { fill: #ededed; }
.a4m-graph__node--outside .a4m-graph__box { stroke: ${GRAPH_PALETTE.muted}; stroke-dasharray: 3 3; }
.a4m-graph__node--outside .a4m-graph__label { fill: ${GRAPH_PALETTE.muted}; }
/* collapsed node: double stroke + light fill — visibly not a single module but a bundle */
.a4m-graph__node--collapsed .a4m-graph__box { fill: #f4f4f4; stroke-width: 1.6; }
.a4m-graph__node--collapsed .a4m-graph__box-inner { fill: none; stroke: ${GRAPH_PALETTE.muted}; stroke-width: .7; }
.a4m-graph__node--collapsed .a4m-graph__label { font-style: italic; }
.a4m-graph__node--root .a4m-graph__box { stroke-width: 2; fill: ${GRAPH_PALETTE.fg}; }
.a4m-graph__node--root .a4m-graph__label { fill: #fff; font-weight: 700; }
.a4m-graph__legend-box { fill: #fff; stroke: ${GRAPH_PALETTE.fg}; stroke-width: .9; }
.a4m-graph__legend-box--external { fill: #ededed; }
.a4m-graph__legend-box--outside { stroke: ${GRAPH_PALETTE.muted}; stroke-dasharray: 3 3; }
.a4m-graph__legend-box--root { fill: ${GRAPH_PALETTE.fg}; stroke-width: 2; }
.a4m-graph__legend-box--collapsed { fill: #f4f4f4; stroke-width: 1.6; }
.a4m-graph__legend-label { fill: ${GRAPH_PALETTE.fg}; font-size: 11px; }
.a4m-graph__legend-note { fill: ${GRAPH_PALETTE.muted}; font-size: 10.5px; }
`
}

/**
 * 图谱样式表（附录 G.4 的 `renderGraphAssets`）：`{ 'a4m-graph.css': <文本> }`。
 * 内容与 `renderDepGraphSvg` 内嵌的 `<style>` 完全一致——单文件 SVG 与外部样式两种用法同源。
 *
 * @returns {Record<string, string>}
 */
export function renderGraphAssets() {
  return { [GRAPH_CSS_FILENAME]: css() }
}

/** 图例里的一类节点：小色块 + 说明（用独立类，不复用节点类，免得被当成节点）。 */
function legendSwatch(x, y, modifier, label) {
  return `<g class="a4m-graph__legend-item">
<rect class="a4m-graph__legend-box${modifier === '' ? '' : ` a4m-graph__legend-box--${modifier}`}" x="${x}" y="${y - 9}" width="22" height="13" rx="3"/>
<text class="a4m-graph__legend-label" x="${x + 30}" y="${y + 1}">${escapeHtml(label)}</text>
</g>`
}

/**
 * 依赖图谱 → 自包含 SVG 字符串。
 *
 * 版面：**层为列，左 → 右 = 依赖方向**；节点圆角矩形；边三次贝塞尔。
 * 输出里不含任何外部引用（无 `http`、无 `url(`、无 `<image>`），也不含 `<script>`。
 *
 * @param {{
 *   nodes: {id: string, layer: number, order: number, inCone: boolean, external: boolean}[],
 *   edges: {from: string, to: string}[],
 *   layerWidths: number[],
 *   stats: {nodeCount: number, edgeCount: number, maxWidth: number, truncated: boolean, truncatedReason: string|null},
 * }} graph
 * @param {{nodeHeight?: number, columnWidth?: number, maxLabelChars?: number, title?: string, rootId?: string}} [opts]
 * @returns {string}
 */
export function renderDepGraphSvg(graph, opts = {}) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  const edges = Array.isArray(graph?.edges) ? graph.edges : []
  const layerWidths = Array.isArray(graph?.layerWidths) ? graph.layerWidths : []
  const stats = graph?.stats ?? { nodeCount: nodes.length, edgeCount: edges.length, maxWidth: 0, truncated: false, truncatedReason: null }
  const nodeHeight = opts.nodeHeight ?? 22
  const columnWidth = opts.columnWidth ?? 220
  const maxLabelChars = opts.maxLabelChars ?? 28
  const rootId = opts.rootId ?? nodes.find((node) => node.layer === 0)?.id ?? null
  const title = opts.title ?? (rootId === null ? 'Dependency graph' : `dependency cone of ${rootId}`)
  const nodeWidth = Math.max(40, columnWidth - 2 * COLUMN_GAP)
  const rowPitch = nodeHeight + ROW_GAP
  const layerCount = layerWidths.length
  const rows = layerWidths.length === 0 ? 0 : Math.max(...layerWidths)

  const width = MARGIN_LEFT + Math.max(1, layerCount) * columnWidth + MARGIN_RIGHT
  const height = MARGIN_TOP + Math.max(1, rows) * rowPitch - ROW_GAP + MARGIN_BOTTOM

  const positionOf = (node) => ({
    x: MARGIN_LEFT + node.layer * columnWidth + COLUMN_GAP,
    y: MARGIN_TOP + node.order * rowPitch,
  })
  const byId = new Map(nodes.map((node) => [node.id, node]))

  const columnHeads = layerWidths
    .map((count, layer) => {
      const x = MARGIN_LEFT + layer * columnWidth + COLUMN_GAP
      return `<text class="a4m-graph__colhead" x="${x}" y="${MARGIN_TOP - 10}">层 ${layer} · ${count}</text>`
    })
    .join('\n')

  const edgeMarkup = edges
    .map((edge) => {
      const from = byId.get(edge.from)
      const to = byId.get(edge.to)
      if (from === undefined || to === undefined) return ''
      const a = positionOf(from)
      const b = positionOf(to)
      const y1 = a.y + nodeHeight / 2
      const y2 = b.y + nodeHeight / 2
      const x1 = a.x + nodeWidth
      const x2 = b.x
      const bend = Math.max(18, Math.abs(x2 - x1) / 2)
      return `<path class="a4m-graph__edge" d="M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}"/>`
    })
    .filter(Boolean)
    .join('\n')

  const nodeMarkup = nodes
    .map((node) => {
      const at = positionOf(node)
      const group = node.group
      const classes = [
        'a4m-graph__node',
        node.inCone ? '' : 'a4m-graph__node--outside',
        node.external ? 'a4m-graph__node--external' : '',
        group === undefined ? '' : 'a4m-graph__node--collapsed',
        node.id === rootId ? 'a4m-graph__node--root' : '',
      ]
        .filter(Boolean)
        .join(' ')
      const label = truncateLabel(node.label ?? node.id, maxLabelChars)
      // 折叠节点：成员全名进 <title>（本期不做展开，名字只能留在这里）；普通节点 title 就是模块名
      const tooltip =
        group === undefined
          ? escapeHtml(node.id)
          : `${escapeHtml(node.group.label ?? node.id)}\n— ${group.count} modules (${group.kind === 'chain' ? 'dependency chain' : group.kind === 'family' ? 'name family' : 'small-module cluster'})${group.lines > 0 ? `, about ${group.lines} lines in total` : ''} —\n${group.members.map((member) => escapeHtml(member)).join('\n')}`
      const groupAttrs =
        group === undefined
          ? ` data-a4m-mod="${escapeHtml(node.id)}"`
          : ` data-a4m-collapsed="${escapeHtml(group.kind)}" data-a4m-members="${group.count}" data-a4m-group-id="${escapeHtml(group.id ?? '')}"`
      const inner =
        group === undefined
          ? ''
          : `<rect class="a4m-graph__box-inner" x="2.5" y="2.5" width="${nodeWidth - 5}" height="${nodeHeight - 5}" rx="2"/>`
      return `<g class="${classes}" id="a4m-g-${slugOf(group?.id ?? node.id)}"${groupAttrs} data-a4m-layer="${node.layer}" data-a4m-order="${node.order}" data-a4m-in-cone="${node.inCone ? 'true' : 'false'}" data-a4m-external="${node.external ? 'true' : 'false'}"${node.id === rootId ? ' data-a4m-root="true"' : ''} transform="translate(${at.x},${at.y})">
<title>${tooltip}</title>
<rect class="a4m-graph__box" width="${nodeWidth}" height="${nodeHeight}" rx="3"/>
${inner}<text class="a4m-graph__label" x="${LABEL_PAD}" y="${nodeHeight / 2 + 3.6}">${escapeHtml(label)}</text>
</g>`
    })
    .join('\n')

  const statLine = [
    `${stats.nodeCount} modules`,
    `${layerCount} columns (layers)`,
    `${stats.edgeCount} dependency edges`,
    `widest layer ${stats.maxWidth}`,
    stats.truncated ? 'truncated — see the note below' : 'not truncated',
  ].join(' · ')
  const truncationNote = stats.truncated
    ? `Truncation note (H5): ${stats.truncatedReason ?? 'no reason given, which is itself a defect'}`
    : 'This graph is the complete dependency cone, with no truncation.'

  const legendY = height - MARGIN_BOTTOM + 34
  const legend = `<g class="a4m-graph__legend">
<text class="a4m-graph__legend-label" x="${MARGIN_LEFT}" y="${legendY - 18}">Legend</text>
${legendSwatch(MARGIN_LEFT, legendY, '', 'Project module')}
${legendSwatch(MARGIN_LEFT + 170, legendY, 'external', 'Mathlib boundary (an edge leaves the project)')}
${legendSwatch(MARGIN_LEFT + 470, legendY, 'outside', 'Outside the cone (not in this graph)')}
${legendSwatch(MARGIN_LEFT + 700, legendY, 'root', 'Root module')}
${legendSwatch(MARGIN_LEFT + 850, legendY, 'collapsed', 'Collapsed node (chain / cluster)')}
<text class="a4m-graph__legend-note" x="${MARGIN_LEFT}" y="${legendY + 28}">${escapeHtml(truncationNote)}</text>
<text class="a4m-graph__legend-note" x="${MARGIN_LEFT}" y="${legendY + 46}">A collapsed node is a bundle of modules: member names are in the hover tooltip, and the graph never invents a module name for it. Clicking a node to open its paper page comes next phase (hooks are in place). This phase is a static graph; the page runs no script.</text>
</g>`

  return `<svg xmlns="http://www.w3.org/2000/svg" class="a4m-graph" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" data-a4m-graph="dep" data-a4m-root="${escapeHtml(rootId ?? '')}" data-a4m-node-count="${stats.nodeCount}" data-a4m-edge-count="${stats.edgeCount}" data-a4m-layer-count="${layerCount}" data-a4m-max-width="${stats.maxWidth}" data-a4m-truncated="${stats.truncated ? 'true' : 'false'}">
<title>${escapeHtml(title)}</title>
<style>
${css()}</style>
<rect class="a4m-graph__bg" x="0" y="0" width="${width}" height="${height}" fill="#fff"/>
<text class="a4m-graph__title" x="${MARGIN_LEFT}" y="30">${escapeHtml(title)}</text>
<text class="a4m-graph__stat" x="${MARGIN_LEFT}" y="50">${escapeHtml(statLine)}</text>
<text class="a4m-graph__stat" x="${MARGIN_LEFT}" y="66">left → right = dependency direction (a module imports the modules to its right)</text>
<g class="a4m-graph__columns">
${columnHeads}
</g>
<g class="a4m-graph__edges">
${edgeMarkup}
</g>
<g class="a4m-graph__nodes">
${nodeMarkup}
</g>
${legend}
</svg>
`
}

/**
 * 极简 HTML 包装：标题 + 内联 SVG（**零脚本**）。附录 G.5 的 `.html` 产物由它生成。
 *
 * @param {string} svg
 * @param {{title?: string, subtitle?: string, truncationNote?: string}} [meta]
 * @returns {string}
 */
export function renderGraphHtml(svg, meta = {}) {
  const title = meta.title ?? 'Dependency graph'
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · ai4math dependency graph</title>
<style>
/* minimal wrapper: only places the SVG on the page; all visuals live in the SVG's own style block */
body { margin: 0; background: #fff; color: ${GRAPH_PALETTE.fg}; font-family: ${GRAPH_PALETTE.serif}; }
/* the graph keeps its intrinsic size; the page scrolls.
   Never give the svg a percentage max-width: a 20728px graph would be squeezed to the window width (about 8%) and every label would be unreadable. A graph is meant to be read node by node, not as a thumbnail. */
.a4m-graph-page { padding: 1.25rem; width: max-content; }
/* keep the heading in view while scrolling horizontally */
.a4m-graph-page__head { position: sticky; left: 1.25rem; }
.a4m-graph-page__title { margin: 0 0 .25rem; font-size: 1.1rem; }
.a4m-graph-page__note { margin: 0 0 1rem; color: ${GRAPH_PALETTE.muted}; font-size: .82rem; }
.a4m-graph-page__warn { margin: 0 0 1rem; color: ${GRAPH_PALETTE.fg}; font-size: .82rem; font-style: italic; }
.a4m-graph-page svg { display: block; }
</style>
</head>
<body>
<main class="a4m-graph-page">
<div class="a4m-graph-page__head">
<h1 class="a4m-graph-page__title">${escapeHtml(title)}</h1>
<p class="a4m-graph-page__note">${escapeHtml(meta.subtitle ?? 'Static dependency graph (no script). Hover a node to see the module full name.')}  The graph is rendered at its intrinsic size; scroll or zoom the browser to read it.</p>
${meta.truncationNote ? `<p class="a4m-graph-page__warn">${escapeHtml(meta.truncationNote)}</p>\n` : ''}</div>${svg}</main>
</body>
</html>
`
}
