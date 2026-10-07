/**
 * graph-render.test.mjs — 依赖图谱的 render 侧（附录 G.4）：自包含、零脚本、钩子齐全
 *
 * 「零脚本」是本期的硬约束：图谱视图破例带 JS 是**下一期**的事，这一期的产物里
 * `<script>` 必须是 0；论文视图（html.mjs / assets.mjs）这一轮完全没动，那些性质另有测试守住。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildDepGraph, collapseGraph } from '../src/core/depgraph.mjs'
import { GRAPH_CSS_FILENAME, GRAPH_PALETTE, renderDepGraphSvg, renderGraphAssets, renderGraphHtml } from '../src/render/graph.mjs'
import { css as paperCss } from '../src/render/assets.mjs'

/** 一张小图：r → a、r → b、a → c（c 在第 2 层），外加一条外部边。 */
function sampleGraph() {
  return buildDepGraph(
    {
      modules: ['r', 'a', 'b', 'c', 'a-very-long-module-name-that-must-be-truncated'],
      edges: [
        { from: 'r', to: 'a', external: false },
        { from: 'r', to: 'b', external: false },
        { from: 'a', to: 'c', external: false },
        { from: 'a', to: 'a-very-long-module-name-that-must-be-truncated', external: false },
        { from: 'a', to: 'Mathlib.Order.Basic', external: true },
      ],
    },
    { rootId: 'r' },
  )
}

const SVG = renderDepGraphSvg(sampleGraph(), { rootId: 'r', maxLabelChars: 12 })

test('图谱: 零 <script>（本期图谱仍是静态图；带 JS 是下一期）', () => {
  assert.equal((SVG.match(/<script/gi) ?? []).length, 0)
  assert.equal((renderGraphHtml(SVG, { title: 't' }).match(/<script/gi) ?? []).length, 0)
})

test('图谱: 自包含——无外部引用、无 <link>/<image>，样式内嵌', () => {
  assert.ok(SVG.includes('<style>'), '样式必须内嵌')
  assert.equal(/<link\b/.test(SVG), false)
  assert.equal(/<image\b/.test(SVG), false)
  assert.equal(/url\(/.test(SVG), false, '不得有 url( 引用')
  // xmlns 是 SVG 的命名空间声明，不是网络请求；除此之外不许出现 http(s)
  const withoutNamespace = SVG.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, '')
  assert.equal(/https?:/.test(withoutNamespace), false, '除命名空间外不得有外链')
})

test('图谱: 每个节点都有 data-a4m-mod 与 <title>（下一期点击下钻的钩子）', () => {
  const graph = sampleGraph()
  const mods = [...SVG.matchAll(/data-a4m-mod="([^"]+)"/g)].map((match) => match[1])
  assert.equal(mods.length, graph.nodes.length, '每个节点一个钩子')
  for (const node of graph.nodes) assert.ok(mods.includes(node.id), `缺 ${node.id} 的钩子`)
  // 每个节点元素里都要有自己的 <title>（悬停看全名）
  for (const block of SVG.split('<g class="a4m-graph__node').slice(1)) {
    if (!block.includes('data-a4m-mod')) continue // Legend的色块不是节点
    assert.match(block, /<title>[^<]+<\/title>/, '每个节点都要有 title')
  }
})

test('图谱: 标签截断但 <title> 保留全名', () => {
  const long = 'a-very-long-module-name-that-must-be-truncated'
  assert.ok(SVG.includes(`<title>${long}</title>`), 'title 必须是全名')
  assert.equal(SVG.includes(`>${long}</text>`), false, '标签本身要截断')
  assert.match(SVG, />a-very-long…<\/text>/, '截断处给省略号')
})

test('图谱: 层为列（左→右依赖方向），每列有列首与计数', () => {
  const graph = sampleGraph()
  assert.equal(graph.layerWidths.length, 3)
  for (let layer = 0; layer < graph.layerWidths.length; layer += 1) {
    assert.match(SVG, new RegExp(`层 ${layer} · ${graph.layerWidths[layer]}`), `缺层 ${layer} 的列首`)
  }
  // 同一层的节点 x 相同、不同层 x 递增
  const xOf = new Map()
  for (const match of SVG.matchAll(/data-a4m-layer="(\d+)"[^>]*transform="translate\((\d+),/g)) {
    xOf.set(Number(match[1]), Number(match[2]))
  }
  const layers = [...xOf.keys()].sort((a, b) => a - b)
  for (let i = 1; i < layers.length; i += 1) {
    assert.ok(xOf.get(layers[i]) > xOf.get(layers[i - 1]), '层号越大 x 越大（左→右 = 依赖方向）')
  }
})

test('图谱: 边是三次贝塞尔，且条数与图一致', () => {
  const graph = sampleGraph()
  const paths = [...SVG.matchAll(/<path class="a4m-graph__edge" d="M [^"]+ C [^"]+"\/>/g)]
  assert.equal(paths.length, graph.edges.length)
})

test('图谱: legend distinguishes project / Mathlib boundary / outside the cone / root', () => {
  assert.match(SVG, /Legend/)
  assert.match(SVG, /Project module/)
  assert.match(SVG, /Mathlib boundary/)
  assert.match(SVG, /Outside the cone/)
  assert.match(SVG, /data-a4m-external="true"/, 'Mathlib boundary类别要真的被用上')
})

test('图谱: truncation is stated on the graph (H5), including the not-truncated case', () => {
  const truncated = buildDepGraph(
    { modules: ['r', 'a', 'b'], edges: [{ from: 'r', to: 'a' }, { from: 'a', to: 'b' }] },
    { rootId: 'r', maxNodes: 2 },
  )
  const svg = renderDepGraphSvg(truncated, { rootId: 'r' })
  assert.match(svg, /data-a4m-truncated="true"/)
  assert.match(svg, /Truncation note \(H5\): /)
  assert.match(svg, /maxNodes=2/)
  assert.match(SVG, /This graph is the complete dependency cone, with no truncation/)
})

test('图谱: 确定性（同一图两次渲染逐字节相同）', () => {
  assert.equal(renderDepGraphSvg(sampleGraph(), { rootId: 'r' }), renderDepGraphSvg(sampleGraph(), { rootId: 'r' }))
  assert.equal(renderGraphAssets()[GRAPH_CSS_FILENAME], renderGraphAssets()[GRAPH_CSS_FILENAME])
})

test('图谱: renderGraphAssets 交付内联样式，且与 SVG 内嵌的<style>同源', () => {
  const assets = renderGraphAssets()
  assert.deepEqual(Object.keys(assets), [GRAPH_CSS_FILENAME])
  assert.ok(SVG.includes(assets[GRAPH_CSS_FILENAME]), 'SVG 内嵌的样式必须与交付的样式表一致')
})

test('图谱: 配色与论文视图同源（不引入深色主题）', () => {
  // 论文视图 :root 里的变量值必须与图谱用的一致——两边不许各写一套颜色
  const paper = paperCss()
  assert.ok(paper.includes(`--a4m-fg: ${GRAPH_PALETTE.fg}`), '前景色要与论文视图一致')
  assert.ok(paper.includes(`--a4m-muted: ${GRAPH_PALETTE.muted}`), '次要色要与论文视图一致')
  assert.ok(paper.includes(`--a4m-serif: ${GRAPH_PALETTE.serif}`), '衬线字体栈要与论文视图一致')
  assert.ok(paper.includes(`--a4m-mono: ${GRAPH_PALETTE.mono}`))
  // 不得出现深色底
  assert.equal(/background:\s*#(0|1|2|3)[0-9a-f]{2}/i.test(SVG), false, '不得是深色主题')
  assert.match(SVG, /fill="#fff"/)
})

test('图谱: 类名都在样式表里有定义（命名规矩同论文视图：a4m- 前缀 + BEM）', () => {
  const stylesheet = renderGraphAssets()[GRAPH_CSS_FILENAME]
  const tokens = new Set(
    [...SVG.matchAll(/class="([^"]+)"/g)].flatMap((match) => match[1].split(/\s+/)).filter(Boolean),
  )
  for (const token of tokens) {
    assert.ok(token.startsWith('a4m-'), `类名必须 a4m- 前缀：${token}`)
    assert.ok(stylesheet.includes(`.${token}`), `样式表缺 .${token}`)
  }
})

test('图谱: HTML 包装能把截断说明摆到页面上（样本不许伪装成主产物）', () => {
  const truncated = buildDepGraph(
    { modules: ['r', 'a', 'b'], edges: [{ from: 'r', to: 'a' }, { from: 'a', to: 'b' }] },
    { rootId: 'r', coneDepth: 1 },
  )
  const svg = renderDepGraphSvg(truncated, { rootId: 'r' })
  const html = renderGraphHtml(svg, { title: 'r 的依赖锥（截断样本）', truncationNote: `本图是截断样本（H5）：${truncated.stats.truncatedReason}` })
  assert.match(html, /截断样本/)
  assert.match(html, /coneDepth=1/)
  assert.equal((html.match(/<script/gi) ?? []).length, 0)
})

test('图谱: HTML 包装极简且零脚本，内联 SVG', () => {
  const html = renderGraphHtml(SVG, { title: 'Euler 的依赖锥', subtitle: '790 个模块' })
  assert.ok(html.includes(SVG))
  assert.equal((html.match(/<script/gi) ?? []).length, 0)
  assert.equal(/<link\b/.test(html), false, '包装页也不引外部资源')
  assert.match(html, /Euler 的依赖锥/)
})

// ── Collapsed node的渲染（附录 G.4b）──────────────────────────────────────

/** after folding的图：r 分出两支，其中一支是 a → p → q → b 这条链（收缩成一个节点）。 */
function foldedSample() {
  const graph = buildDepGraph(
    {
      modules: ['r', 'a', 'p', 'q', 'b', 'c', 'z'],
      edges: [
        { from: 'r', to: 'a', external: false },
        { from: 'a', to: 'p', external: false },
        { from: 'p', to: 'q', external: false },
        { from: 'q', to: 'b', external: false },
        { from: 'b', to: 'c', external: false },
        { from: 'r', to: 'z', external: false },
        { from: 'z', to: 'c', external: false },
      ],
    },
    { rootId: 'r' },
  )
  return collapseGraph(graph, { collapseSmall: false, clusterFamilies: false })
}

test('图谱折叠: Collapsed node一眼可辨（类 + data 属性 + 双层描边）', () => {
  const svg = renderDepGraphSvg(foldedSample(), { rootId: 'r' })
  assert.match(svg, /data-a4m-collapsed="chain"/, 'H5：必须自报是Collapsed node')
  assert.match(svg, /data-a4m-members="4"/, '成员数')
  assert.match(svg, /a4m-graph__node--collapsed/, '视觉上要区分（双层描边）')
  assert.match(svg, /class="a4m-graph__box-inner"/, '内层描边')
  assert.match(svg, /a → … → b \(4 modules\)/, '标签自报数量')
})

test('图谱折叠: 成员全名留在 <title> 里（本期不展开，名字只能在这里）', () => {
  const svg = renderDepGraphSvg(foldedSample(), { rootId: 'r' })
  const block = svg.split('<g class="a4m-graph__node a4m-graph__node--collapsed"')[1] ?? ''
  const title = /<title>([\s\S]*?)<\/title>/.exec(block)?.[1] ?? ''
  for (const member of ['a', 'p', 'q', 'b']) assert.ok(title.includes(member), `title 里要有 ${member}`)
})

test('图谱折叠: 折叠时边仍然画得出来（id 与边表必须对得上）', () => {
  const graph = foldedSample()
  const svg = renderDepGraphSvg(graph, { rootId: 'r' })
  const paths = (svg.match(/<path class="a4m-graph__edge"/g) ?? []).length
  assert.equal(paths, graph.edges.length, 'after folding的每条边都要画出来（曾因 id 用标签而全部丢失）')
  assert.ok(graph.edges.length >= 2)
})

test('图谱折叠: Legend多了「Collapsed node」一类', () => {
  const svg = renderDepGraphSvg(foldedSample(), { rootId: 'r' })
  assert.match(svg, /Collapsed node/)
  assert.match(svg, /a4m-graph__legend-box--collapsed/)
})

test('图谱呈现: 按固有尺寸（不得 max-width: 100%），页面出滚动条 + sticky 标题', () => {
  const html = renderGraphHtml('<svg/>', { title: 't' })
  assert.equal(/max-width:\s*100%/.test(html), false, '附录 G.5：压到窗口宽会把 20728px 的图缩成 8%，字全不可辨')
  assert.match(html, /\.a4m-graph-page \{[^}]*width: max-content/, '页面按固有尺寸铺开，出滚动条')
  assert.match(html, /position: sticky/, '横向滚动时标题吸附')
  assert.match(html, /\.a4m-graph-page svg \{[^}]*display: block/, 'SVG 按固有尺寸呈现')
  assert.equal(/svg \{[^}]*max-width:\s*\d+%/.test(html), false, 'svh 不得设百分比最大宽度')
})
