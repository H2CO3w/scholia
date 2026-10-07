/**
 * depgraph.mjs — 模块级依赖图谱：建图 / 分层 / 定序 / 折叠（**纯函数**，不碰 I/O、不碰 DOM）
 *
 * 依据：INTERFACES 附录 G.3（建图）与 G.4b（折叠）。图谱视图与论文视图互不影响：
 * 论文视图仍是一页一个声明的零脚本产物，这里是「整棵证明树」那张图。
 *
 * 三条性质：
 *   1. **确定性**：同一输入两次调用逐字段相同——不许随机数、排序一律给全序（并列时按 id 字典序收尾）。
 *   2. **分层用最长路径**：`layer(v)` = root 到 v 的**最长**路径长度（让边同向、跨层少）；
 *      可选 `layering: 'bfs'` 只作对照（BFS 分层下 36% 的边会逆向，画出来是噪音）。
 *   3. **截断如实报告（H5）**：`maxDepth` / `maxNodes` / 环 / `coneDepth`，任何一处截了都要说清截了什么。
 *
 * 「external」的口径：图谱节点一律来自 `modules`（项目内模块），所以节点的 `external` 表示
 * **它是否伸到项目边界之外**（有至少一条指向 Mathlib 等外部模块的 import 边）——这正是图例里的
 * 「Mathlib 边界」。外部模块**不建节点**：Mathlib 有成千上万个模块，建进来会把依赖锥淹没。
 *
 * 折叠（G.4b）：**先链收缩（精确、按度），再聚类（启发式）**。反过来聚类会改变度、破坏链判定。
 * 折叠只改变「怎么画」，不改变可达性——每个折叠节点都带完整成员表。
 */

/** 默认层内重心法迭代轮数（固定值 ⇒ 输出确定）。 */
const BARYCENTER_PASSES = 4

/**
 * 分层口径：
 *   - `'longest'`（默认，附录 G.3 冻结口径）：`layer(v)` = root 到 v 的最长路径。
 *     代价是列数多（Euler 全锥 94 列），收益是**每条边都严格跨一列、全部朝右**——画出来才干净。
 *   - `'bfs'`：`layer(v)` = root 到 v 的 BFS 深度。列数少得多，但实测同一个锥里 36% 的边
 *     同层或逆向——静态图上会向左回勾。保留它只为对照，默认不用。
 */
const LAYERING = Object.freeze({ LONGEST: 'longest', BFS: 'bfs' })

/** 命名族后缀（G.4b 第 3 条；实测 `Bounds|Budget|Estimate` 结尾占 12.6%）。 */
export const NAME_FAMILIES = Object.freeze([
  'Bounds',
  'Budget',
  'Estimate',
  'Data',
  'Defs',
  'Guards',
  'Coherence',
  'Regularity',
  'NoOptions',
])

/** 稳定排序：先按 key，再按 id（给全序，杜绝实现相关的顺序差异）。 */
function sortStable(items, keyOf) {
  return [...items].sort((left, right) => {
    const a = keyOf(left)
    const b = keyOf(right)
    if (a < b) return -1
    if (a > b) return 1
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })
}

/** 去重 + 给全序的边表（同一条边只保留一次；自环丢掉，由调用方决定是否报告）。 */
function normalizeEdges(edges) {
  const seen = new Set()
  const out = []
  for (const edge of edges) {
    if (typeof edge?.from !== 'string' || typeof edge?.to !== 'string' || edge.from === edge.to) continue
    const key = `${edge.from}\u0000${edge.to}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ from: edge.from, to: edge.to })
  }
  out.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0))
  return out
}

/**
 * 依赖锥：从 `rootId` 沿**项目内**边可达的节点集合（含 root 自己）。
 *
 * @param {{edges: {from: string, to: string}[], nodes?: {id: string}[]}} graph
 * @param {string} rootId
 * @param {{maxDepth?: number}} [opts]
 * @returns {Set<string>}
 */
export function coneOf(graph, rootId, opts = {}) {
  const edges = Array.isArray(graph?.edges) ? graph.edges : []
  const maxDepth = Number.isInteger(opts.maxDepth) && opts.maxDepth >= 0 ? opts.maxDepth : null
  const adjacency = new Map()
  for (const edge of edges) {
    if (typeof edge?.from !== 'string' || typeof edge?.to !== 'string') continue
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, [])
    adjacency.get(edge.from).push(edge.to)
  }
  for (const list of adjacency.values()) list.sort()

  const seen = new Set([rootId])
  const queue = [[rootId, 0]]
  while (queue.length > 0) {
    const [id, depth] = queue.shift()
    if (maxDepth !== null && depth >= maxDepth) continue
    for (const next of adjacency.get(id) ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      queue.push([next, depth + 1])
    }
  }
  return seen
}

/** 从 `ids` + `edges` 算出入度/出度/后继表（链收缩只按度判定）。 */
function degrees(ids, edges) {
  const inDegree = new Map(ids.map((id) => [id, 0]))
  const outDegree = new Map(ids.map((id) => [id, 0]))
  const outgoing = new Map(ids.map((id) => [id, []]))
  for (const edge of edges) {
    if (!inDegree.has(edge.from) || !inDegree.has(edge.to)) continue
    outDegree.set(edge.from, outDegree.get(edge.from) + 1)
    inDegree.set(edge.to, inDegree.get(edge.to) + 1)
    outgoing.get(edge.from).push(edge.to)
  }
  for (const list of outgoing.values()) list.sort()
  return { inDegree, outDegree, outgoing }
}

/**
 * 分层 + 层内定序（`buildDepGraph` 与 `collapseGraph` 共用**同一份**实现，不写第二份）。
 *
 * @param {{ids: string[], edges: {from: string, to: string}[], rootId: string|null,
 *          layering: string, maxLayer?: number|null, reasonParts: string[]}} params
 * @returns {{nodes: {id: string, layer: number, order: number}[], layerWidths: number[]}}
 */
function layoutDag({ ids, edges, rootId, layering, maxLayer = null, reasonParts }) {
  const idSet = new Set(ids)
  const dagEdges = edges.filter((edge) => idSet.has(edge.from) && idSet.has(edge.to))
  const { inDegree, outgoing } = degrees(ids, dagEdges)

  const layer = new Map()
  const roots = [...ids].sort().filter((id) => (inDegree.get(id) ?? 0) === 0)
  for (const id of roots) layer.set(id, 0)

  if (layering === LAYERING.BFS && rootId !== null) {
    layer.set(rootId, 0)
    let frontier = [rootId]
    let depth = 0
    while (frontier.length > 0) {
      const next = []
      for (const id of frontier) {
        for (const to of outgoing.get(id) ?? []) {
          if (layer.has(to)) continue
          layer.set(to, depth + 1)
          next.push(to)
        }
      }
      frontier = next
      depth += 1
    }
    for (const id of ids) if (!layer.has(id)) layer.set(id, 0)
  }

  // Kahn：入度归零才入队，队列里向前松弛出最长路径（只在这里减入度）
  const queue = layering === LAYERING.BFS ? [] : [...roots]
  const pending = new Map([...inDegree])
  const processed = layering === LAYERING.BFS ? new Set(ids) : new Set(roots)
  let cursor = 0
  while (cursor < queue.length) {
    const id = queue[cursor]
    cursor += 1
    for (const next of outgoing.get(id) ?? []) {
      const candidate = (layer.get(id) ?? 0) + 1
      if (candidate > (layer.get(next) ?? 0)) layer.set(next, candidate)
      pending.set(next, (pending.get(next) ?? 0) - 1)
      if ((pending.get(next) ?? 0) === 0 && !processed.has(next)) {
        processed.add(next)
        queue.push(next)
      }
    }
  }

  // 环：Lean 的 import 不该成环，真遇上了不能装作没看见——按 id 序打破并如实报告
  const unprocessed = [...ids].filter((id) => !processed.has(id)).sort()
  if (unprocessed.length > 0) {
    reasonParts.push(
      `import cycle detected (${unprocessed.length} modules in cycles: ${unprocessed.slice(0, 5).join(', ')}${unprocessed.length > 5 ? ', …' : ''}); back edges were broken in id order`,
    )
    for (const id of unprocessed) {
      let best = 0
      for (const edge of dagEdges) {
        if (edge.to !== id || !processed.has(edge.from)) continue
        best = Math.max(best, (layer.get(edge.from) ?? 0) + 1)
      }
      layer.set(id, best)
    }
  }

  // 层上限（maxDepth）
  let kept = [...ids]
  if (maxLayer !== null) {
    const before = kept.length
    kept = kept.filter((id) => (layer.get(id) ?? 0) <= maxLayer)
    const cut = before - kept.length
    if (cut > 0) reasonParts.push(`maxDepth=${maxLayer} dropped ${cut} deeper nodes`)
  }

  // 层内定序：重心法（上层邻居 order 的平均值），迭代固定轮数，并列按 id 收尾
  const byLayer = new Map()
  for (const id of kept) {
    const at = layer.get(id) ?? 0
    if (!byLayer.has(at)) byLayer.set(at, [])
    byLayer.get(at).push(id)
  }
  const layers = [...byLayer.keys()].sort((a, b) => a - b)
  const order = new Map()
  for (const at of layers) {
    const sorted = [...byLayer.get(at)].sort()
    sorted.forEach((id, index) => order.set(id, index))
    byLayer.set(at, sorted)
  }
  const predecessors = new Map(kept.map((id) => [id, []]))
  for (const edge of dagEdges) {
    if (!order.has(edge.from) || !order.has(edge.to)) continue
    predecessors.get(edge.to).push(edge.from)
  }
  for (let pass = 0; pass < BARYCENTER_PASSES; pass += 1) {
    for (const at of layers) {
      if (at === 0) continue
      const withKey = (byLayer.get(at) ?? []).map((id, index) => {
        const keys = (predecessors.get(id) ?? []).map((pred) => order.get(pred)).filter((value) => value !== undefined)
        return { id, barycenter: keys.length === 0 ? index : keys.reduce((sum, value) => sum + value, 0) / keys.length }
      })
      withKey.sort((a, b) => {
        if (a.barycenter !== b.barycenter) return a.barycenter - b.barycenter
        const orderA = order.get(a.id) ?? 0
        const orderB = order.get(b.id) ?? 0
        if (orderA !== orderB) return orderA - orderB
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      })
      withKey.forEach((item, index) => order.set(item.id, index))
      byLayer.set(at, withKey.map((item) => item.id))
    }
  }

  const usedLayers = layers.filter((at) => (byLayer.get(at) ?? []).length > 0)
  const renumbered = new Map(usedLayers.map((at, index) => [at, index]))
  const layerWidths = usedLayers.map((at) => byLayer.get(at).length)
  const nodes = usedLayers.flatMap((at) => byLayer.get(at).map((id, index) => ({ id, layer: renumbered.get(at), order: index })))

  const layerOf = new Map(nodes.map((node) => [node.id, node.layer]))
  const backEdges = dagEdges.filter(
    (edge) =>
      layerOf.has(edge.from) && layerOf.has(edge.to) && (layer.get(edge.from) ?? 0) >= (layer.get(edge.to) ?? 0),
  )
  return { nodes, layerWidths, backEdges, cycleDetected: unprocessed.length > 0 }
}

/**
 * 建图 + 分层 + 层内定序。输入输出都是纯数据（附录 G.3）。
 *
 * @param {{modules: string[], edges: {from: string, to: string, external?: boolean}[]}} input
 * @param {{rootId?: string, maxDepth?: number, maxNodes?: number, coneDepth?: number, layering?: 'longest'|'bfs'}} [opts]
 * @returns {{
 *   nodes: {id: string, layer: number, order: number, inCone: boolean, external: boolean}[],
 *   edges: {from: string, to: string}[],
 *   layerWidths: number[],
 *   stats: {nodeCount: number, edgeCount: number, maxWidth: number, truncated: boolean, truncatedReason: string|null},
 * }}
 */
export function buildDepGraph(input, opts = {}) {
  const modules = [...new Set((Array.isArray(input?.modules) ? input.modules : []).filter((m) => typeof m === 'string' && m !== ''))]
  modules.sort()
  const moduleSet = new Set(modules)

  const touchesExternal = new Set()
  const internalEdges = []
  const edgeKeys = new Set()
  const reasonParts = []
  for (const edge of Array.isArray(input?.edges) ? input.edges : []) {
    if (typeof edge?.from !== 'string' || typeof edge?.to !== 'string') continue
    if (!moduleSet.has(edge.from)) continue
    if (edge.external === true || !moduleSet.has(edge.to)) {
      touchesExternal.add(edge.from)
      continue
    }
    const key = `${edge.from}\u0000${edge.to}`
    if (edgeKeys.has(key)) continue
    edgeKeys.add(key)
    internalEdges.push({ from: edge.from, to: edge.to })
  }
  const sortedInternal = normalizeEdges(internalEdges)

  const rootId = typeof opts.rootId === 'string' && opts.rootId !== '' ? opts.rootId : null
  const layering = opts.layering === LAYERING.BFS ? LAYERING.BFS : LAYERING.LONGEST
  const coneDepth = Number.isInteger(opts.coneDepth) && opts.coneDepth >= 0 ? opts.coneDepth : null
  if (rootId !== null && modules.length > 0 && !moduleSet.has(rootId)) {
    throw new Error(
      `buildDepGraph: 根模块 ${JSON.stringify(rootId)} 不在 modules 里。请用模块全名（如 'Euler'），或先确认扫描的 rootDir 对不对。`,
    )
  }

  // 锥一律与 modules 求交：rootId 可能不在模块集里（空输入等），锥不该因此凭空多出一个节点
  const reachable =
    rootId === null
      ? new Set(modules)
      : new Set([...coneOf({ edges: sortedInternal }, rootId)].filter((id) => moduleSet.has(id)))
  let inCone = reachable
  if (rootId !== null && coneDepth !== null) {
    const shallow = new Set([...coneOf({ edges: sortedInternal }, rootId, { maxDepth: coneDepth })].filter((id) => moduleSet.has(id)))
    const dropped = reachable.size - shallow.size
    if (dropped > 0) reasonParts.push(`coneDepth=${coneDepth} dropped ${dropped} nodes beyond that BFS depth`)
    inCone = shallow
  }

  const ids = [...inCone].sort()
  const maxDepth = Number.isInteger(opts.maxDepth) && opts.maxDepth >= 0 ? opts.maxDepth : null
  const laid = layoutDag({ ids, edges: sortedInternal, rootId, layering, maxLayer: maxDepth, reasonParts })

  // maxNodes：按 (layer, order) 从后往前丢，并说清丢在哪层
  let capped = laid.nodes
  if (Number.isInteger(opts.maxNodes) && opts.maxNodes > 0 && laid.nodes.length > opts.maxNodes) {
    const dropped = laid.nodes.slice(opts.maxNodes)
    const perLayer = new Map()
    for (const node of dropped) perLayer.set(node.layer, (perLayer.get(node.layer) ?? 0) + 1)
    const detail = [...perLayer.entries()].sort((a, b) => a[0] - b[0]).map(([layer, count]) => `层 ${layer} 丢 ${count}`).join('，')
    reasonParts.push(`maxNodes=${opts.maxNodes} dropped ${dropped.length} nodes (removed from the last layer backwards: ${detail})`)
    capped = laid.nodes.slice(0, opts.maxNodes)
  }
  const keptSet = new Set(capped.map((node) => node.id))
  const layerOf = new Map(capped.map((node) => [node.id, node.layer]))

  const keptEdges = sortedInternal.filter((edge) => keptSet.has(edge.from) && keptSet.has(edge.to))
  const backEdges = keptEdges.filter((edge) => (layerOf.get(edge.from) ?? 0) >= (layerOf.get(edge.to) ?? 0))
  if (backEdges.length > 0 && layering === LAYERING.LONGEST && laid.cycleDetected !== true) {
    // 纯 DAG 在最长路径分层下每条边都必须严格跨一层；出现回边却查不到环，问题在实现
    throw new Error(
      `graph: 分层自检失败——边 ${backEdges[0].from} → ${backEdges[0].to} 没有跨层，但图里没有环。这是实现 bug，不是数据问题。`,
    )
  }
  if (backEdges.length > 0 && layering === LAYERING.LONGEST) {
    reasonParts.push(`a further ${backEdges.length} back edges (same layer or reversed, from import cycles) cannot be drawn left-to-right and are omitted from the graph`)
  }
  const edges = (layering === LAYERING.LONGEST ? keptEdges.filter((edge) => (layerOf.get(edge.from) ?? 0) < (layerOf.get(edge.to) ?? 0)) : keptEdges).map(
    (edge) => ({ from: edge.from, to: edge.to }),
  )

  const layerWidths = []
  for (const node of capped) layerWidths[node.layer] = (layerWidths[node.layer] ?? 0) + 1

  return {
    nodes: capped.map((node) => ({
      id: node.id,
      layer: node.layer,
      order: node.order,
      inCone: inCone.has(node.id),
      external: touchesExternal.has(node.id),
    })),
    edges,
    layerWidths,
    stats: {
      nodeCount: capped.length,
      edgeCount: edges.length,
      maxWidth: layerWidths.length === 0 ? 0 : Math.max(...layerWidths),
      truncated: reasonParts.length > 0,
      truncatedReason: reasonParts.length > 0 ? reasonParts.join('；') : null,
    },
  }
}

/** 是不是「纯管道」：恰一个前驱、恰一个后继（这种节点只做转述，本身不承载结构）。 */
function isPipe(id, inDegree, outDegree) {
  return (inDegree.get(id) ?? 0) === 1 && (outDegree.get(id) ?? 0) === 1
}

/**
 * 链收缩（series reduction，G.4b 第 1 条）。找**极大路径** v₁ → … → vₖ，
 * 其中 v₂..v_{k-1} 的入度与出度都是 1；整条收缩成一个节点（v₁、vₖ 一并吸收）。
 * `chainMinLength` 默认 3：只收缩至少吸收 1 个中间节点的链，免得把普通两跳也吞掉。
 */
function findChains(ids, edges, chainMinLength) {
  const { inDegree, outDegree, outgoing } = degrees(ids, edges)
  const assigned = new Map()
  const chains = []
  for (const start of ids.filter((id) => !isPipe(id, inDegree, outDegree))) {
    if (assigned.has(start)) continue
    const members = [start]
    let cursor = start
    while ((outDegree.get(cursor) ?? 0) === 1) {
      const next = outgoing.get(cursor)[0]
      if (next === undefined || assigned.has(next) || !isPipe(next, inDegree, outDegree)) break
      members.push(next)
      cursor = next
    }
    // 链尾 v_k：只有当这条链是它唯一的前驱时才吸收（否则它是多条链的汇合点，抢过来会破坏别的链）
    const tail = outgoing.get(cursor)?.[0]
    if (tail !== undefined && !assigned.has(tail) && (inDegree.get(tail) ?? 0) === 1) members.push(tail)
    if (members.length < chainMinLength) continue
    const id = `chain:${members[0]}…${members[members.length - 1]}`
    for (const member of members) assigned.set(member, id)
    chains.push({ id, members })
  }
  // 全是纯管道构成的环（Lean 不该有）：按 id 序兜底，保证不丢节点
  for (const id of ids) {
    if (assigned.has(id) || !isPipe(id, inDegree, outDegree)) continue
    const members = [id]
    let cursor = outgoing.get(id)[0]
    while (cursor !== undefined && cursor !== id && !assigned.has(cursor) && isPipe(cursor, inDegree, outDegree)) {
      members.push(cursor)
      cursor = outgoing.get(cursor)[0]
    }
    if (members.length >= chainMinLength) {
      const chainId = `chain:${members[0]}…${members[members.length - 1]}`
      for (const member of members) assigned.set(member, chainId)
      chains.push({ id: chainId, members })
    }
  }
  return { chains }
}

/** 命名族后缀：`Euler.FooBounds` → `Bounds`（G.4b 第 3 条）。取最长匹配。 */
function familyOf(moduleId) {
  const last = moduleId.split('.').pop() ?? ''
  const matches = NAME_FAMILIES.filter((family) => last !== family && last.endsWith(family))
  if (matches.length === 0) return null
  return matches.sort((a, b) => b.length - a.length)[0]
}

/**
 * 折叠：链收缩 → 小模块聚类 → 命名族聚类（G.4b）。
 *
 * **只改变「怎么画」，不改变可达性**：每个折叠节点都带完整成员表（`group.members`），
 * 渲染层把成员名放进 `title`——本期不做展开（交互是下一期），所以名字只能留在那里。
 *
 * @param {object} graph `buildDepGraph` 的输出
 * @param {{
 *   sizes?: Record<string, {lines: number, decls: number}>,
 *   collapseChains?: boolean, chainMinLength?: number,
 *   collapseSmall?: boolean, smallLineThreshold?: number,
 *   clusterFamilies?: boolean, minGroupSize?: number,
 * }} [opts]
 * @returns {{
 *   nodes: {id: string, layer: number, order: number, inCone: boolean, external: boolean,
 *           group?: {kind: 'chain'|'small'|'family', members: string[], count: number, lines: number, label: string}}[],
 *   edges: {from: string, to: string}[],
 *   layerWidths: number[],
 *   stats: {nodeCount: number, edgeCount: number, maxWidth: number, collapsedNodeCount: number,
 *           absorbedNodeCount: number, truncated: boolean, truncatedReason: string|null},
 *   foldStats: {chainCount: number, longestChain: number, averageChainLength: number,
 *               clusteredNodeCount: number, clusteredMemberCount: number},
 * }}
 */
export function collapseGraph(graph, opts = {}) {
  const inputNodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  const inputEdges = normalizeEdges(Array.isArray(graph?.edges) ? graph.edges : [])
  const sizes = opts.sizes && typeof opts.sizes === 'object' ? opts.sizes : {}
  const collapseChains = opts.collapseChains !== false
  const chainMinLength = Number.isInteger(opts.chainMinLength) && opts.chainMinLength >= 2 ? opts.chainMinLength : 3
  const collapseSmall = opts.collapseSmall !== false
  const smallLineThreshold = Number.isFinite(opts.smallLineThreshold) ? opts.smallLineThreshold : 100
  const clusterFamilies = opts.clusterFamilies !== false
  const minGroupSize = Number.isInteger(opts.minGroupSize) && opts.minGroupSize >= 2 ? opts.minGroupSize : 2

  const ids = inputNodes.map((node) => node.id)
  const metaOf = new Map(inputNodes.map((node) => [node.id, node]))
  const reasonParts = []
  const groups = new Map() // 折叠节点 id → group 描述
  const owner = new Map(ids.map((id) => [id, id])) // 原节点 → 折叠后节点 id

  // ── 1) 链收缩（先做：聚类会改变度，反过来链判定就废了）──
  const chainStats = { count: 0, longest: 0, totalMembers: 0 }
  if (collapseChains) {
    const { chains } = findChains(ids, inputEdges, chainMinLength)
    for (const chain of chains) {
      const first = chain.members[0]
      const last = chain.members[chain.members.length - 1]
      const lines = chain.members.reduce((sum, id) => sum + (sizes[id]?.lines ?? 0), 0)
      groups.set(chain.id, {
        id: chain.id,
        kind: 'chain',
        members: chain.members,
        count: chain.members.length,
        lines,
        label: `${first} → … → ${last} (${chain.members.length} modules)`,
      })
      for (const member of chain.members) owner.set(member, chain.id)
      chainStats.count += 1
      chainStats.longest = Math.max(chainStats.longest, chain.members.length)
      chainStats.totalMembers += chain.members.length
    }
  }

  // ── 2) 小模块聚类 + 3) 命名族聚类（都在链收缩之后）──
  //
  // 分组键里带**层号**是关键：最长路径分层保证同层节点之间没有边，所以「同层同族」的合并
  // **不丢任何边、也不可能造出环**（实测 Euler 锥：944 个小模块 → 80 组，组内边 0）。
  // 只按命名空间聚（不带层号）会把整个 `Euler.*` 吞成一个 943 模块的黑箱，图就没了。
  const remaining = ids.filter((id) => owner.get(id) === id)
  const layerOfInput = new Map(inputNodes.map((node) => [node.id, node.layer]))
  const parentOf = (id) => (id.includes('.') ? id.slice(0, id.lastIndexOf('.')) : '(根)')

  const bucketKey = (id, prefix) => `${prefix}:${layerOfInput.get(id) ?? 0}|`
  if (collapseSmall) {
    const buckets = new Map()
    for (const id of remaining) {
      const lines = sizes[id]?.lines
      if (!Number.isFinite(lines) || lines > smallLineThreshold) continue
      const key = `${bucketKey(id, 'small')}${parentOf(id)}`
      if (!buckets.has(key)) buckets.set(key, [])
      buckets.get(key).push(id)
    }
    for (const [key, members] of [...buckets.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (members.length < minGroupSize) continue
      const sorted = [...members].sort()
      // 组内若同属一个命名族，标签就用族名（对读者更有信息量）
      const families = new Set(sorted.map((id) => familyOf(id)).filter((family) => family !== null))
      const uniformFamily = families.size === 1 && sorted.every((id) => familyOf(id) !== null) ? [...families][0] : null
      groups.set(key, {
        id: key,
        kind: uniformFamily === null ? 'small' : 'family',
        family: uniformFamily,
        members: sorted,
        count: sorted.length,
        lines: sorted.reduce((sum, id) => sum + (sizes[id]?.lines ?? 0), 0),
        label:
          uniformFamily === null
            ? `${parentOf(sorted[0])} · ${sorted.length} modules · technical estimates`
            : `${parentOf(sorted[0])} · ${sorted.length} modules · name family ${uniformFamily}`,
      })
      for (const member of sorted) owner.set(member, key)
    }
  }

  // 3) 命名族聚类：给上一轮没被合并的小模块按族收尾（跨命名空间也收）
  if (clusterFamilies) {
    const buckets = new Map()
    for (const id of remaining) {
      if (owner.get(id) !== id) continue
      const family = familyOf(id)
      if (family === null) continue
      const key = `${bucketKey(id, 'family')}${family}`
      if (!buckets.has(key)) buckets.set(key, [])
      buckets.get(key).push(id)
    }
    for (const [key, members] of [...buckets.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (members.length < minGroupSize) continue
      const sorted = [...members].sort()
      const family = familyOf(sorted[0])
      groups.set(key, {
        id: key,
        kind: 'family',
        family,
        members: sorted,
        count: sorted.length,
        lines: sorted.reduce((sum, id) => sum + (sizes[id]?.lines ?? 0), 0),
        label: `${sorted.length} modules · name family ${family}`,
      })
      for (const member of sorted) owner.set(member, key)
    }
  }

  // ── 折叠后的边表 ──
  const foldedEdges = []
  let droppedSelfLoops = 0
  for (const edge of inputEdges) {
    const from = owner.get(edge.from)
    const to = owner.get(edge.to)
    if (from === undefined || to === undefined) continue
    if (from === to) {
      droppedSelfLoops += 1
      continue
    }
    foldedEdges.push({ from, to })
  }
  if (droppedSelfLoops > 0) {
    reasonParts.push(`after folding, ${droppedSelfLoops} edges fall inside a single collapsed node (self-loops) and are omitted from the graph`)
  }

  const rootOriginal = inputNodes.find((node) => node.layer === 0)?.id ?? null
  const laid = layoutDag({
    ids: [...new Set(ids.map((id) => owner.get(id)))].sort(),
    edges: normalizeEdges(foldedEdges),
    rootId: rootOriginal === null ? null : owner.get(rootOriginal),
    layering: LAYERING.LONGEST,
    reasonParts,
  })
  const keptIds = new Set(laid.nodes.map((node) => node.id))
  // 聚类是把节点合成组（商运算），**可能造出组与组之间的环**——这是折叠的正常后果，不是实现 bug：
  // 如实报告并丢掉画不出方向的边（其余边全部朝右）。
  const backEdgeSet = new Set(laid.backEdges.map((edge) => `${edge.from}\u0000${edge.to}`))
  if (laid.backEdges.length > 0) {
    reasonParts.push(
      `after folding, ${laid.backEdges.length} edges stay inside one group or run against the grouping direction (clustering turned an acyclic structure into cycles at group level) and are omitted from the graph`,
    )
  }
  const edges = normalizeEdges(foldedEdges).filter(
    (edge) => keptIds.has(edge.from) && keptIds.has(edge.to) && !backEdgeSet.has(`${edge.from}\u0000${edge.to}`),
  )

  const nodes = laid.nodes.map((node) => {
    const group = groups.get(node.id)
    if (group === undefined) {
      const meta = metaOf.get(node.id)
      return { id: node.id, layer: node.layer, order: node.order, inCone: meta?.inCone !== false, external: meta?.external === true }
    }
    return {
      // id 保持合成键（边表用的是它，改成人读标签会让边全部对不上号）；
      // 人读的标签放 group.label，渲染层优先显示它——页面上照样自报「我是折叠节点」
      id: node.id,
      label: group.label,
      layer: node.layer,
      order: node.order,
      inCone: group.members.some((member) => metaOf.get(member)?.inCone !== false),
      external: group.members.some((member) => metaOf.get(member)?.external === true),
      group: { ...group },
    }
  })
  const layerWidths = []
  for (const node of nodes) layerWidths[node.layer] = (layerWidths[node.layer] ?? 0) + 1
  const collapsedNodeCount = nodes.filter((node) => node.group !== undefined).length
  const absorbedNodeCount = nodes.reduce((sum, node) => sum + (node.group === undefined ? 0 : node.group.count - 1), 0)

  if (graph?.stats?.truncated === true) {
    reasonParts.push(`the input graph was already truncated and folding cannot bring back what was dropped: ${graph.stats.truncatedReason ?? 'no reason given'}`)
  }

  const clustered = [...groups.values()].filter((group) => group.kind !== 'chain')
  return {
    nodes,
    edges,
    layerWidths,
    stats: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      maxWidth: layerWidths.length === 0 ? 0 : Math.max(...layerWidths),
      collapsedNodeCount,
      absorbedNodeCount,
      truncated: reasonParts.length > 0,
      truncatedReason: reasonParts.length > 0 ? reasonParts.join('；') : null,
    },
    foldStats: {
      chainCount: chainStats.count,
      longestChain: chainStats.longest,
      averageChainLength: chainStats.count === 0 ? 0 : chainStats.totalMembers / chainStats.count,
      clusteredNodeCount: clustered.length,
      clusteredMemberCount: clustered.reduce((sum, group) => sum + group.count, 0),
    },
  }
}

/** 位图：`|reach(v)|` 要的是并集大小，不能用子树大小相加（依赖高度共享）。 */
function popcount(value) {
  let x = value - ((value >> 1) & 0x55555555)
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333)
  x = (x + (x >> 4)) & 0x0f0f0f0f
  return (x * 0x01010101) >> 24
}

/**
 * 可达集合的位图表示（`mainLine` 与 `stationMembers` 共用同一份实现）。
 * 1771 个节点、每个一份 1771 位 ≈ 400 KB，比 1771 个 Set 省得多；
 * 最长路径分层保证每条边从 layer i 到 i+1，所以按层号从大到小处理就是逆拓扑序。
 */
function reachabilityOf(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  const edges = normalizeEdges(Array.isArray(graph?.edges) ? graph.edges : [])
  const ids = nodes.map((node) => node.id)
  const index = new Map(ids.map((id, at) => [id, at]))
  const successors = new Map(ids.map((id) => [id, []]))
  for (const edge of edges) {
    if (!successors.has(edge.from) || !index.has(edge.to)) continue
    successors.get(edge.from).push(edge.to)
  }
  for (const list of successors.values()) list.sort()
  const words = Math.max(1, Math.ceil(ids.length / 32))
  const reach = new Map(ids.map((id) => [id, new Uint32Array(words)]))
  const order = [...nodes].sort((a, b) => b.layer - a.layer || a.order - b.order || (a.id < b.id ? -1 : 1))
  for (const node of order) {
    const bits = reach.get(node.id)
    bits[index.get(node.id) >> 5] |= 1 << (index.get(node.id) & 31)
    for (const next of successors.get(node.id) ?? []) {
      const child = reach.get(next)
      for (let w = 0; w < words; w += 1) bits[w] |= child[w]
    }
  }
  return { ids, index, words, reach, successors }
}

/** 位图里所有置位的下标（升序）。 */
function bitsToIndexes(bits, words) {
  const out = []
  for (let w = 0; w < words; w += 1) {
    let word = bits[w] >>> 0
    while (word !== 0) {
      const lowest = word & -word
      out.push((w << 5) + (31 - Math.clz32(lowest)))
      word ^= lowest
    }
  }
  return out
}

/**
 * 主线与「每站带来多少」（附录 G.6）。
 *
 * **主线**：从根出发，每步选**子树（可达模块数）最大**的依赖（`mode: 'heaviest'`，默认）。
 * 为什么不用最长路径当主线：根往往有多个直接依赖，最长路径只走其中一条，其余整支会全挂在第 0 站
 * （实测 Euler：另外六支 1599 个模块全压在第 0 站，等于没有分区）。
 *
 * **每站带来多少 = 望远镜求和**：`addedCount(p_i) = |subtree(p_i)| − |subtree(p_{i+1})|`（末站减去空集）。
 * 因为 p_{i+1} 是 p_i 的后继，`subtree(p_{i+1}) ⊆ subtree(p_i)`，所以这些差集**两两不交**，
 * 并起来正好是 `subtree(root)`——天然是一个划分。`coveredModules === totalModules` 是它的立足点，
 * 调用方与本模块都会断言它不被静默破坏。
 *
 * `mode: 'longest'` 只作对照：望远镜恒等式对它同样成立（它也是一条路径），
 * 但它把整张图压在第 0 站上，作为「目录」没有信息量。
 *
 * **并列规则（三档，全程确定性）**：
 *   1. 子树**模块数**（降序）——主序；
 *   2. 子树**总行数**（降序）——光数模块会把 20,000 行的模块和 50 行的当成一样重；
 *   3. 模块 **id 字典序**（升序）——最终兜底。
 * 第 2 档需要 `opts.sizes`（`{ [模块名]: { lines, decls } }`，与 `collapseGraph` 同一字段）。
 * 没给 `sizes` 就退化成「模块数 → id」，并在返回值里用 `tieBreak: 'id'` 如实标注，
 * 免得调用方以为行数判据生效了。
 *
 * @param {object} graph `buildDepGraph` 的输出
 * @param {{rootId?: string, mode?: 'heaviest'|'longest', sizes?: Record<string, {lines: number, decls: number}>}} [opts]
 * @returns {{stations: {id: string, index: number, subtreeSize: number, subtreeLines: number, addedCount: number}[],
 *            totalModules: number, coveredModules: number, tieBreak: 'lines'|'id'}}
 */
export function mainLine(graph, opts = {}) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  const { ids, index, words, reach, successors } = reachabilityOf(graph)

  const rootId = typeof opts.rootId === 'string' && opts.rootId !== '' ? opts.rootId : (nodes.find((node) => node.layer === 0)?.id ?? null)
  const mode = opts.mode === 'longest' ? 'longest' : 'heaviest'
  const sizes = opts.sizes && typeof opts.sizes === 'object' ? opts.sizes : null
  const tieBreak = sizes === null ? 'id' : 'lines'
  if (rootId === null || !index.has(rootId)) {
    return { stations: [], totalModules: 0, coveredModules: 0, tieBreak }
  }

  const sizeOf = (id) => {
    const bits = reach.get(id)
    let total = 0
    for (let w = 0; w < words; w += 1) total += popcount(bits[w])
    return total
  }
  /**
   * 剩余高度：从 v 往下的**最长距离**（节点数）。`longest` 模式必须贪心这个，
   * 不能贪心层号——层号是「root 到 v 的最长入路径」，沿边严格递增，但**不保证走到全局最深**，
   * 会提前拐进死胡同（实测 Euler 锥：按层号走只有 16 站，按剩余高度走是 94 站 = 真最长路径）。
   */
  const heightMemo = new Map()
  const heightOf = (id) => {
    if (heightMemo.has(id)) return heightMemo.get(id)
    const children = successors.get(id) ?? []
    const value = children.length === 0 ? 1 : 1 + Math.max(...children.map((child) => heightOf(child)))
    heightMemo.set(id, value)
    return value
  }

  // 子树总行数：位图里被置位的那些模块的行数之和（sizes 没给就是 0，此时第 2 档自动失效）
  const linesByIndex = ids.map((id) => (sizes === null ? 0 : (sizes[id]?.lines ?? 0)))
  const subtreeLinesOf = (id) => {
    if (sizes === null) return 0
    const bits = reach.get(id)
    let sum = 0
    for (let w = 0; w < words; w += 1) {
      let word = bits[w] >>> 0
      while (word !== 0) {
        // 取**最低**置位并清掉它（`31 - clz32(word)` 给的是最高位，配 `word & (word-1)`
        // 会读同一个下标 |subtree| 次——曾经因此把子树行数算成「节点数 × 某个模块的行数」）
        const lowest = word & -word
        sum += linesByIndex[(w << 5) + (31 - Math.clz32(lowest))] ?? 0
        word ^= lowest
      }
    }
    return sum
  }
  /** 三档并列规则：模块数 → 子树行数 → id。 */
  const byWeight = (a, b) => sizeOf(b) - sizeOf(a) || subtreeLinesOf(b) - subtreeLinesOf(a) || (a < b ? -1 : 1)

  // 走主线：heaviest 每步选子树最大的后继（并列取 id 字典序，保证确定）；longest 选层号最深的
  const stations = []
  const seen = new Set()
  let cursor = rootId
  while (cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor)
    const options = successors.get(cursor) ?? []
    let next
    if (options.length > 0) {
      if (mode === 'longest') {
        // 真最长路径：每步选剩余高度最大的后继（并列取 id 字典序）
        next = [...options].sort((a, b) => heightOf(b) - heightOf(a) || (a < b ? -1 : 1))[0]
      } else {
        next = [...options].sort(byWeight)[0]
      }
    }
    stations.push({
      id: cursor,
      index: stations.length,
      subtreeSize: sizeOf(cursor),
      subtreeLines: subtreeLinesOf(cursor),
      addedCount: 0,
    })
    cursor = next
  }
  for (let i = 0; i < stations.length; i += 1) {
    const nextSize = i + 1 < stations.length ? stations[i + 1].subtreeSize : 0
    stations[i].addedCount = stations[i].subtreeSize - nextSize
  }

  const totalModules = sizeOf(rootId)
  const coveredModules = stations.reduce((sum, station) => sum + station.addedCount, 0)
  return { stations, totalModules, coveredModules, tieBreak }
}

/**
 * 每站的**完整成员名单**（附录 G.6b）——「这一部分关联哪些证明」的答案。
 *
 * `members(p_i) = sub(p_i) \ sub(p_{i+1})`：第 i 站需要、而它最重的依赖不需要的模块。
 * 这正是页面上那个 `+N` 背后的**集合**（`+N` 只是它的基数）。
 *
 * 三条性质由构造保证，也是本设计的立足点：
 *   - **良定义**：集合差，与遍历顺序无关；
 *   - **互不重复**：`sub(p_{i+1}) ⊂ sub(p_i)`（后继是前驱的后继，可达集单调缩）；
 *   - **无遗漏**：并集 = 整个锥——这才是 `Σ addedCount === totalModules` 的实质。
 *
 * @param {object} graph `buildDepGraph` 的输出
 * @param {{stations: {id: string, index: number}[]}} outline `mainLine` 的输出
 * @param {{rootId?: string}} [opts] 目前只用于文档化调用意图（成员集合与根无关，由 outline 决定）
 * @returns {{stationId: string, index: number, members: string[], totalMembers: number}[]}
 */
export function stationMembers(graph, outline, opts = {}) {
  void opts
  const { ids, words, reach } = reachabilityOf(graph)
  const stations = Array.isArray(outline?.stations) ? outline.stations : []
  return stations.map((station, at) => {
    const own = reach.get(station.id)
    if (own === undefined) return { stationId: station.id, index: station.index ?? at, members: [], totalMembers: 0 }
    const nextId = at + 1 < stations.length ? stations[at + 1].id : null
    const nextBits = nextId === null ? null : reach.get(nextId)
    const members = []
    for (const bit of bitsToIndexes(own, words)) {
      // nextBits 里也置位的 → 属于下一站，不属于本站
      if (nextBits !== null && (nextBits[bit >> 5] & (1 << (bit & 31))) !== 0) continue
      members.push(ids[bit])
    }
    members.sort()
    return { stationId: station.id, index: station.index ?? at, members, totalMembers: members.length }
  })
}
