/**
 * depgraph.test.mjs — 依赖图谱的 core 侧（附录 G.3）：分层 / 定序 / 锥 / 截断
 *
 * 这里只用**自己造的极小图**（真实语料是 .probe-nse，属临时数据源，不进测试）。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildDepGraph, collapseGraph, coneOf, mainLine, stationMembers } from '../src/core/depgraph.mjs'

/** 造一个小模块集 + 边表（默认全部是项目内边）。 */
function fixture({ modules, internal = [], external = [] }) {
  return {
    modules,
    edges: [
      ...internal.map(([from, to]) => ({ from, to, external: false })),
      ...external.map(([from, to]) => ({ from, to, external: true })),
    ],
  }
}

test('分层: 用最长路径（菱形里 c 落到第 2 层，不是最短路径的第 1 层）', () => {
  // root → a → c
  //   └→ b ──┘      ← c 有两条路径：长度 1 与 2；最长路径口径下 c 在第 2 层
  const graph = buildDepGraph(fixture({ modules: ['root', 'a', 'b', 'c'], internal: [['root', 'a'], ['root', 'b'], ['a', 'c'], ['b', 'c']] }), { rootId: 'root' })
  const layerOf = new Map(graph.nodes.map((node) => [node.id, node.layer]))
  assert.equal(layerOf.get('root'), 0)
  assert.equal(layerOf.get('a'), 1)
  assert.equal(layerOf.get('b'), 1)
  assert.equal(layerOf.get('c'), 2, '最长路径：c 必须在第 2 层')
  // 分层的第一性质：每条边严格跨一层、全部朝右
  for (const edge of graph.edges) {
    assert.ok(layerOf.get(edge.from) < layerOf.get(edge.to), `边 ${edge.from}→${edge.to} 必须朝右跨层`)
  }
})

test('分层: 链 A→B→C→D 逐层 +1，层宽都是 1', () => {
  const graph = buildDepGraph(fixture({ modules: ['A', 'B', 'C', 'D'], internal: [['A', 'B'], ['B', 'C'], ['C', 'D']] }), { rootId: 'A' })
  assert.deepEqual(graph.layerWidths, [1, 1, 1, 1])
  assert.deepEqual(graph.nodes.map((node) => node.id), ['A', 'B', 'C', 'D'])
})

test('确定性: 同一输入两次调用逐字段相同（不许随机、不许依赖隐式顺序）', () => {
  const input = fixture({
    modules: ['r', 'x1', 'x2', 'x3', 'y1', 'y2', 'z'],
    internal: [['r', 'x1'], ['r', 'x2'], ['r', 'x3'], ['x1', 'y1'], ['x2', 'y1'], ['x3', 'y2'], ['y1', 'z'], ['y2', 'z']],
  })
  const first = buildDepGraph(input, { rootId: 'r' })
  const second = buildDepGraph(input, { rootId: 'r' })
  assert.deepEqual(second, first)
})

test('定序: 重心法把前驱接近的节点排到一起，且仍确定', () => {
  // p1 → c2 ; p2 → c1 ; p3 → c3（初始按 id 排序是 c1,c2,c3；重心法后应按 p1,p2,p3 的顺序重排）
  const graph = buildDepGraph(
    fixture({ modules: ['r', 'p1', 'p2', 'p3', 'c1', 'c2', 'c3'], internal: [['r', 'p1'], ['r', 'p2'], ['r', 'p3'], ['p1', 'c2'], ['p2', 'c1'], ['p3', 'c3']] }),
    { rootId: 'r' },
  )
  const layer1 = graph.nodes.filter((node) => node.layer === 1).map((node) => node.id)
  const layer2 = graph.nodes.filter((node) => node.layer === 2).map((node) => node.id)
  assert.deepEqual(layer1, ['p1', 'p2', 'p3'])
  assert.deepEqual(layer2, ['c2', 'c1', 'c3'], '按上层邻居的 order 排（重心法）')
})

test('环: 不抛错、打破back edge并如实报告（H5）', () => {
  const graph = buildDepGraph(fixture({ modules: ['A', 'B', 'C'], internal: [['A', 'B'], ['B', 'A'], ['B', 'C']] }), { rootId: 'A' })
  assert.equal(graph.stats.truncated, true, '有环必须如实报告')
  assert.match(graph.stats.truncatedReason, /import cycle detected/)
  assert.equal(graph.stats.nodeCount, 3, '环里的节点照样呈现，不丢')
})

test('截断: maxDepth 与 maxNodes 都必须有理由（不得静默）', () => {
  const input = fixture({ modules: ['r', 'a', 'b', 'c'], internal: [['r', 'a'], ['a', 'b'], ['b', 'c']] })
  const byDepth = buildDepGraph(input, { rootId: 'r', maxDepth: 1 })
  assert.equal(byDepth.stats.truncated, true)
  assert.match(byDepth.stats.truncatedReason, /maxDepth=1/)
  assert.deepEqual(byDepth.nodes.map((node) => node.id), ['r', 'a'])

  const byNodes = buildDepGraph(input, { rootId: 'r', maxNodes: 2 })
  assert.equal(byNodes.stats.truncated, true)
  assert.match(byNodes.stats.truncatedReason, /maxNodes=2/)
  assert.equal(byNodes.stats.nodeCount, 2)
  assert.match(byNodes.stats.truncatedReason, /层 2 丢 1/, '要说清是哪一层丢了多少')

  const clean = buildDepGraph(input, { rootId: 'r' })
  assert.equal(clean.stats.truncated, false)
  assert.equal(clean.stats.truncatedReason, null)
})

test('截断: 截断后剩下的边不悬空（两端都还在）', () => {
  const graph = buildDepGraph(
    fixture({ modules: ['r', 'a', 'b', 'c'], internal: [['r', 'a'], ['a', 'b'], ['b', 'c']] }),
    { rootId: 'r', maxNodes: 3 },
  )
  const ids = new Set(graph.nodes.map((node) => node.id))
  for (const edge of graph.edges) {
    assert.ok(ids.has(edge.from) && ids.has(edge.to), `边 ${edge.from}→${edge.to} 的两端都必须在图里`)
  }
})

test('依赖锥: coneOf 给可达集合，maxDepth 按 BFS 深度截', () => {
  const edges = [
    { from: 'r', to: 'a' },
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
  ]
  assert.deepEqual([...coneOf({ edges }, 'r')].sort(), ['a', 'b', 'c', 'r'])
  assert.deepEqual([...coneOf({ edges }, 'r', { maxDepth: 1 })].sort(), ['a', 'r'])
})

test('依赖锥: coneDepth 按 BFS 深度切节点集，与 maxDepth（按层号切）是两件事', () => {
  // c 既能由 root 直达（BFS 深度 1），又有一条更长的路径 root→a→c（层号 2）
  const input = fixture({ modules: ['root', 'a', 'c'], internal: [['root', 'a'], ['a', 'c'], ['root', 'c']] })
  const byCone = buildDepGraph(input, { rootId: 'root', coneDepth: 1 })
  assert.equal(byCone.stats.nodeCount, 3, 'c 的 BFS 深度是 1，coneDepth=1 不该切掉它')
  const byLayer = buildDepGraph(input, { rootId: 'root', maxDepth: 1 })
  assert.equal(byLayer.stats.nodeCount, 2, 'c 的层号是 2，maxDepth=1 会切掉它')
  const deep = buildDepGraph(fixture({ modules: ['r', 'a', 'b', 'c'], internal: [['r', 'a'], ['a', 'b'], ['b', 'c']] }), { rootId: 'r', coneDepth: 1 })
  assert.equal(deep.stats.nodeCount, 2, 'BFS 深度 ≤1 只有 r 与 a')
  assert.match(deep.stats.truncatedReason, /coneDepth=1 dropped 2 nodes beyond that BFS depth/)
})

test('分层口径: bfs 选项列数更少（对照用），默认仍是 longest', () => {
  const input = fixture({ modules: ['r', 'a', 'c'], internal: [['r', 'a'], ['a', 'c'], ['r', 'c']] })
  const longest = buildDepGraph(input, { rootId: 'r' })
  const bfs = buildDepGraph(input, { rootId: 'r', layering: 'bfs' })
  assert.equal(longest.layerWidths.length, 3, '最长路径：r / a / c 三列')
  assert.equal(bfs.layerWidths.length, 2, 'c 的 BFS 深度是 1，只有 2 列')
  assert.equal(buildDepGraph(input, { rootId: 'r', layering: '瞎写' }).layerWidths.length, 3, '未知口径回落到默认 longest')
})

test('external: 出边到项目外的模块不建节点，但节点被标成 Mathlib 边界', () => {
  const graph = buildDepGraph(
    fixture({ modules: ['r', 'a'], internal: [['r', 'a']], external: [['a', 'Mathlib.Order.Basic'], ['r', 'Mathlib.Data.Nat']] }),
    { rootId: 'r' },
  )
  assert.deepEqual(graph.nodes.map((node) => node.id), ['r', 'a'], '外部模块不进图')
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  assert.equal(byId.get('a').external, true, 'a 伸到了项目外 → Mathlib 边界')
  assert.equal(byId.get('r').external, true)
  const clean = buildDepGraph(fixture({ modules: ['r', 'a'], internal: [['r', 'a']] }), { rootId: 'r' })
  assert.equal(clean.nodes.every((node) => node.external === false), true)
})

test('重复 import 只算一条边（图与统计必须一致）', () => {
  const graph = buildDepGraph(
    fixture({ modules: ['r', 'a'], internal: [['r', 'a'], ['r', 'a']] }),
    { rootId: 'r' },
  )
  assert.equal(graph.edges.length, 1)
  assert.equal(graph.stats.edgeCount, 1)
})

test('根不在模块集里时抛带修复动作的错误', () => {
  assert.throws(
    () => buildDepGraph(fixture({ modules: ['r', 'a'], internal: [['r', 'a']] }), { rootId: 'Nope' }),
    /不在 modules 里.*模块全名/,
  )
})

test('无 rootId: 全项目建图，inCone 全为 true', () => {
  const graph = buildDepGraph(fixture({ modules: ['r', 'a', 'b'], internal: [['r', 'a'], ['a', 'b']] }))
  assert.equal(graph.stats.nodeCount, 3)
  assert.equal(graph.nodes.every((node) => node.inCone === true), true)
})

test('空输入不炸：0 节点 0 边，且不声称截断', () => {
  const graph = buildDepGraph({ modules: [], edges: [] }, { rootId: 'r' })
  assert.equal(graph.stats.nodeCount, 0)
  assert.equal(graph.stats.edgeCount, 0)
  assert.equal(graph.stats.maxWidth, 0)
  assert.equal(graph.stats.truncated, false)
})

// ── 折叠（附录 G.4b）─────────────────────────────────────────────────

/** 造一条链：r → a → p → q → b → c，其中 p、q 是纯管道（入=1 出=1），b 只被这条链指着。 */
function chainFixture() {
  return buildDepGraph(
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
}

test('折叠: 链收缩把「纯管道 + 两端」缩成一个节点，标签自报数量', () => {
  const folded = collapseGraph(chainFixture(), { collapseSmall: false, clusterFamilies: false })
  assert.equal(folded.foldStats.chainCount, 1)
  assert.equal(folded.foldStats.longestChain, 4)
  const group = folded.nodes.find((node) => node.group !== undefined)
  assert.ok(group, '应当出现一个折叠节点')
  assert.deepEqual(group.group.members, ['a', 'p', 'q', 'b'], 'p、q 是纯管道，a、b 是两端')
  assert.equal(group.group.kind, 'chain')
  assert.match(group.label, /a → … → b \(4 modules\)/, '标签必须自报「我是折叠节点、包了几个」')
  assert.equal(group.id.startsWith('chain:'), true, 'id 是合成键（边表用它），人读标签走 label')
  assert.equal(folded.stats.absorbedNodeCount, 3)
})

test('折叠: chainMinLength 决定多长的链才收缩', () => {
  const short = collapseGraph(chainFixture(), { collapseSmall: false, clusterFamilies: false, chainMinLength: 5 })
  assert.equal(short.foldStats.chainCount, 0, '长度 4 < 5 不收缩')
  const long = collapseGraph(chainFixture(), { collapseSmall: false, clusterFamilies: false, chainMinLength: 3 })
  assert.equal(long.foldStats.chainCount, 1)
  const off = collapseGraph(chainFixture(), { collapseChains: false, collapseSmall: false, clusterFamilies: false })
  assert.equal(off.stats.nodeCount, chainFixture().stats.nodeCount, '关掉链收缩就一个都不折')
})

test('折叠: 小模块按「同层 + 同命名空间」聚类（不跨层、不跨命名空间）', () => {
  const graph = buildDepGraph(
    {
      modules: ['R', 'A.x1', 'A.x2', 'A.x3', 'B.y1', 'B.y2', 'B.y3'],
      edges: [
        { from: 'R', to: 'A.x1', external: false },
        { from: 'R', to: 'A.x2', external: false },
        { from: 'R', to: 'A.x3', external: false },
        { from: 'A.x1', to: 'B.y1', external: false },
        { from: 'A.x2', to: 'B.y2', external: false },
        { from: 'A.x3', to: 'B.y3', external: false },
      ],
    },
    { rootId: 'R' },
  )
  const sizes = Object.fromEntries(['A.x1', 'A.x2', 'A.x3', 'B.y1', 'B.y2', 'B.y3'].map((id) => [id, { lines: 10, decls: 1 }]))
  const folded = collapseGraph(graph, { sizes, collapseChains: false })
  assert.equal(folded.foldStats.clusteredNodeCount, 2, '两个命名空间各成一组（同层）')
  const labels = folded.nodes.filter((node) => node.group !== undefined).map((node) => node.label).sort()
  assert.deepEqual(labels, ['A · 3 modules · technical estimates', 'B · 3 modules · technical estimates'])
  // 大模块不参与聚类
  const big = collapseGraph(graph, { sizes: { ...sizes, 'A.x1': { lines: 5000, decls: 1 } }, collapseChains: false, minGroupSize: 2 })
  assert.equal(big.nodes.some((node) => node.id === 'A.x1'), true, '超阈值的大模块保持原样')
})

test('折叠: name family聚类按后缀收（同层、跨命名空间）', () => {
  const graph = buildDepGraph(
    {
      modules: ['R', 'A.fooBounds', 'B.barBounds', 'C.bazBounds'],
      edges: [
        { from: 'R', to: 'A.fooBounds', external: false },
        { from: 'R', to: 'B.barBounds', external: false },
        { from: 'R', to: 'C.bazBounds', external: false },
      ],
    },
    { rootId: 'R' },
  )
  const folded = collapseGraph(graph, { sizes: {}, collapseChains: false })
  const group = folded.nodes.find((node) => node.group !== undefined)
  assert.ok(group, '三个 *Bounds 应当合成一组')
  assert.match(group.label, /name family Bounds/)
  assert.equal(group.group.kind, 'family')
  assert.equal(group.group.count, 3)
})

test('折叠: 可达性不变（折叠只改变怎么画，不改变谁能到达谁）', () => {
  const graph = chainFixture()
  const folded = collapseGraph(graph, { collapseSmall: false, clusterFamilies: false })
  const memberOf = new Map()
  for (const node of folded.nodes) {
    for (const member of node.group?.members ?? [node.id]) memberOf.set(member, node.id)
  }
  // 原图里从根可达的每个节点，其所属折叠节点在折叠图里也必须从根可达
  const reach = (nodes, edges, from) => {
    const adjacency = new Map()
    for (const edge of edges) {
      if (!adjacency.has(edge.from)) adjacency.set(edge.from, [])
      adjacency.get(edge.from).push(edge.to)
    }
    const seen = new Set([from])
    const queue = [from]
    while (queue.length > 0) {
      for (const next of adjacency.get(queue.shift()) ?? []) {
        if (!seen.has(next)) {
          seen.add(next)
          queue.push(next)
        }
      }
    }
    return seen
  }
  const rootBefore = graph.nodes.find((node) => node.layer === 0).id
  const rootAfter = memberOf.get(rootBefore)
  const reachBefore = reach(graph.nodes, graph.edges, rootBefore)
  const reachAfter = reach(folded.nodes, folded.edges, rootAfter)
  for (const id of reachBefore) {
    assert.ok(reachAfter.has(memberOf.get(id)), `${id} after folding仍然可达`)
  }
  assert.equal(folded.nodes.length, 4, 'r / z / c / 一条链（a,p,q,b）')
})

test('折叠: 折叠节点带完整成员表（H5：名字留着，本期不展开）', () => {
  const folded = collapseGraph(chainFixture(), { collapseSmall: false, clusterFamilies: false })
  for (const node of folded.nodes) {
    if (node.group === undefined) continue
    assert.equal(typeof node.group.kind, 'string')
    assert.equal(node.group.members.length, node.group.count, 'count 与 members 必须一致')
    assert.equal(typeof node.group.label, 'string')
    assert.ok(node.group.label.includes(String(node.group.count)), '标签里要有数量（自报）')
  }
})

test('折叠: 确定性 + 关掉聚类时不产生组节点', () => {
  const graph = chainFixture()
  assert.deepEqual(collapseGraph(graph, {}), collapseGraph(graph, {}))
  const noClusters = collapseGraph(graph, { collapseSmall: false, clusterFamilies: false })
  assert.equal(noClusters.nodes.filter((node) => node.group !== undefined).every((node) => node.group.kind === 'chain'), true)
})

test('折叠: 链内的跳边变成self-loop后丢掉，并如实报告（不静默）', () => {
  // a → q 是一条跳过 p 的边；a、p、q、b 收缩成一个节点后它就成了组内边
  const graph = buildDepGraph(
    {
      modules: ['r', 'a', 'p', 'q', 'b', 'c'],
      edges: [
        { from: 'r', to: 'a', external: false },
        { from: 'a', to: 'p', external: false },
        { from: 'p', to: 'q', external: false },
        { from: 'q', to: 'b', external: false },
        { from: 'b', to: 'c', external: false },
        { from: 'a', to: 'q', external: false },
      ],
    },
    { rootId: 'r' },
  )
  const folded = collapseGraph(graph, { collapseSmall: false, clusterFamilies: false })
  assert.equal(folded.stats.truncated, true)
  assert.match(folded.stats.truncatedReason, /inside a single collapsed node/)
  assert.equal(folded.edges.every((edge) => edge.from !== edge.to), true, 'self-loop不得留在边表里')
})

// ── 每站成员：望远镜差给出的**集合**（附录 G.6b）────────────────────

/** 造一条主线的数据：每步选最重的依赖，成员应逐站切分整个锥。 */
function memberFixture() {
  const edges = [
    ['r', 'a'],
    ['r', 'b'],
    ['a', 'c'],
    ['a', 'd'],
    ['c', 'e'],
    ['d', 'e'],
    ['b', 'f'],
  ].map(([from, to]) => ({ from, to, external: false }))
  const graph = buildDepGraph({ modules: ['r', 'a', 'b', 'c', 'd', 'e', 'f'], edges }, { rootId: 'r' })
  return { graph, outline: mainLine(graph, { rootId: 'r' }) }
}

test('成员: Σ 各站成员数 === totalModules === coveredModules（完整分解）', () => {
  const { graph, outline } = memberFixture()
  const per = stationMembers(graph, outline)
  const sum = per.reduce((total, item) => total + item.totalMembers, 0)
  assert.equal(sum, outline.totalModules)
  assert.equal(sum, outline.coveredModules)
  // 每站成员数就是页面上那个 +N
  assert.deepEqual(per.map((item) => item.totalMembers), outline.stations.map((station) => station.addedCount))
})

test('成员: 没有任何模块出现在两页里（互不重复）', () => {
  const { graph, outline } = memberFixture()
  const per = stationMembers(graph, outline)
  const all = per.flatMap((item) => item.members)
  assert.equal(all.length, new Set(all).size, '成员集合两两不交')
  // 且并集正好是整棵锥
  assert.deepEqual([...new Set(all)].sort(), ['a', 'b', 'c', 'd', 'e', 'f', 'r'])
})

test('成员: 成员集合与「只属于这一站」的语义一致', () => {
  const { graph, outline } = memberFixture()
  const per = stationMembers(graph, outline)
  const byId = new Map(per.map((item) => [item.stationId, item.members]))
  // r 的可达集是全部；它最重的依赖是 a（可达 a,c,d,e）→ r 的成员应是 {r, b, f}
  assert.deepEqual(byId.get('r'), ['b', 'f', 'r'])
  assert.deepEqual(byId.get('a'), ['a', 'd']) // a 的可达集 {a,c,d,e} 减去 c 的可达集 {c,e} → {a, d}
  assert.deepEqual(per.at(-1).members, ['e'], '末站（链尾）的成员就是它自己')
})

test('成员: 确定性（同输入两次结果相同）', () => {
  const { graph, outline } = memberFixture()
  assert.deepEqual(stationMembers(graph, outline), stationMembers(graph, outline))
})

test('成员: 空输入不炸', () => {
  assert.deepEqual(stationMembers({ nodes: [], edges: [] }, { stations: [] }), [])
})
