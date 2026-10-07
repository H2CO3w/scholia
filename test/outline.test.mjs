/**
 * outline.test.mjs — 主线大纲（附录 G.6）：望远镜划分 + 大纲渲染
 *
 * 这一页是整个「方便理解的结构」的落点：如果 `Σ addedCount` 不再等于锥内模块总数，
 * 这套设计就垮了——所以划分性质是本文件的第一等公民。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildDepGraph, mainLine } from '../src/core/depgraph.mjs'
import { renderOutlineHtml, renderOutlinePointer, renderOutlineReadme, renderStationPage, stationFileName } from '../src/render/outline.mjs'

/**
 * 造一张有「重支 / 轻支」的图：
 *   r → a（重支：a 下面挂 4 个）  r → b（轻支：b 下面挂 1 个）
 *   a → c、a → d、c → e、d → e；b → f
 */
function forkGraph() {
  const edges = [
    ['r', 'a'],
    ['r', 'b'],
    ['a', 'c'],
    ['a', 'd'],
    ['c', 'e'],
    ['d', 'e'],
    ['b', 'f'],
  ].map(([from, to]) => ({ from, to, external: false }))
  return buildDepGraph({ modules: ['r', 'a', 'b', 'c', 'd', 'e', 'f'], edges }, { rootId: 'r' })
}

test('主线: 每步选子树最大的依赖（重支优先），且是一条真实的路径', () => {
  const graph = forkGraph()
  const outline = mainLine(graph, { rootId: 'r' })
  assert.deepEqual(outline.stations.map((station) => station.id), ['r', 'a', 'c', 'e'], 'r→a 比 r→b 重；a→c 与 a→d 并列时按 id')
  // subtree(r)={r,a,b,c,d,e,f}=7；subtree(a)={a,c,d,e}=4；subtree(c)={c,e}=2；subtree(e)={e}=1
  assert.deepEqual(outline.stations.map((station) => station.subtreeSize), [7, 4, 2, 1], '子树大小要单调不增')
})

test('主线: 望远镜求和 === 锥内模块总数（这是整套设计的立足点）', () => {
  const graph = forkGraph()
  const outline = mainLine(graph, { rootId: 'r' })
  const sum = outline.stations.reduce((total, station) => total + station.addedCount, 0)
  assert.equal(outline.coveredModules, outline.totalModules)
  assert.equal(sum, outline.totalModules, 'Σ addedCount 必须等于总数')
  assert.equal(outline.totalModules, 7)
  assert.equal(outline.stations.filter((station) => station.addedCount === 0).length, 0, '不许有零站')
})

test('主线: 同一条主线上的子树是包含关系（望远镜恒等式的前提）', () => {
  const graph = forkGraph()
  const outline = mainLine(graph, { rootId: 'r' })
  for (let i = 1; i < outline.stations.length; i += 1) {
    assert.ok(
      outline.stations[i].subtreeSize <= outline.stations[i - 1].subtreeSize,
      '后继的子树必须不大于前驱（否则差集不构成划分）',
    )
  }
})

test('主线: mode=longest 作对照，如实说明它把图压在第 0 站', () => {
  const graph = forkGraph()
  const longest = mainLine(graph, { rootId: 'r', mode: 'longest' })
  const heaviest = mainLine(graph, { rootId: 'r', mode: 'heaviest' })
  // 两种模式都必须满足望远镜恒等式（它们都是路径），差别在信息量
  assert.equal(longest.coveredModules, longest.totalModules)
  assert.equal(heaviest.coveredModules, heaviest.totalModules)
  // 最长路径走的是最深的那支：r→a→c→e 与 r→a→d→e 等深，heaviest 已按子树选
  assert.ok(longest.stations.length <= heaviest.stations.length + 1)
})

test('主线: 空图不炸', () => {
  const empty = mainLine({ nodes: [], edges: [] }, { rootId: 'r' })
  assert.deepEqual(empty, { stations: [], totalModules: 0, coveredModules: 0, tieBreak: 'id' })
})

test('主线: 并列规则三档——模块数 → 子树行数 → 模块名', () => {
  // x、y 的子树模块数相同（都 2），但 y 那支的总行数大得多 → 应选 y
  const edges = [
    ['r', 'x'],
    ['r', 'y'],
    ['x', 'p'],
    ['y', 'q'],
  ].map(([from, to]) => ({ from, to, external: false }))
  const graph = buildDepGraph({ modules: ['r', 'x', 'y', 'p', 'q'], edges }, { rootId: 'r' })
  const sizes = { r: { lines: 10 }, x: { lines: 10 }, y: { lines: 10 }, p: { lines: 20 }, q: { lines: 5000 } }
  const withLines = mainLine(graph, { rootId: 'r', sizes })
  assert.equal(withLines.tieBreak, 'lines')
  assert.deepEqual(withLines.stations.map((station) => station.id), ['r', 'y', 'q'], '行数重的支优先')
  // subtree(r) = r,x,y,p,q = 10+10+10+20+5000 = 5050；subtree(y) = y,q = 5010
  assert.equal(withLines.stations[0].subtreeLines, 5050, '子树总行数要如实报出来')
  assert.equal(withLines.stations[1].subtreeLines, 5010)
  // 不给 sizes：退化成「模块数 → 模块名」，并如实标注 tieBreak
  const noSizes = mainLine(graph, { rootId: 'r' })
  assert.equal(noSizes.tieBreak, 'id')
  assert.deepEqual(noSizes.stations.map((station) => station.id), ['r', 'x', 'p'], '并列时按 id 字典序')
  assert.equal(noSizes.stations[0].subtreeLines, 0)
  // 两种走法都必须满足望远镜恒等式
  for (const outline of [withLines, noSizes]) {
    assert.equal(outline.coveredModules, outline.totalModules)
  }
})

// ── 渲染 ────────────────────────────────────────────────────────────

const OUTLINE = mainLine(forkGraph(), { rootId: 'r' })
const HTML = renderOutlineHtml(OUTLINE, { title: '测试大纲', docstrings: { a: '作者对 a 的说明。' } })

test('大纲: 竖向单栏，每站一行（本页允许带 JS 增强，见后两条用例）', () => {
  assert.equal((HTML.match(/<script/gi) ?? []).length, 0, '这个夹具没开 enhance，所以仍未脚本')
  assert.match(HTML, /\.a4m-outline \{ max-width: 78ch/)
  assert.equal((HTML.match(/class="a4m-outline__row"/g) ?? []).length, OUTLINE.stations.length)
  assert.match(HTML, /<ol class="a4m-outline__list">/)
})

test('大纲: 每行 = 序号 · 模块短名 + 作者说明（页面不放记账）', () => {
  // 默认论文序：第一条是最基础的前置（此夹具里是 e），最后一条是根 r
  assert.match(HTML, /<span class="a4m-outline__index">1<\/span>/)
  assert.match(HTML, /<span class="a4m-outline__name">e<\/span>/)
  assert.match(HTML, /<span class="a4m-outline__name">r<\/span>/)
  assert.match(HTML, /作者对 a 的说明。/)
  assert.match(HTML, /(no module description)/, '缺说明就如实写，不许编')
})

test('大纲: 页面上不得出现形式化记账（用户意见一）', () => {
  for (const forbidden of ['条声明', '个命名空间', '本站', '比上一步', '中位数', '未随文件更新', '怎么读这一页']) {
    assert.equal(HTML.includes(forbidden), false, `页面上不该出现「${forbidden}」`)
  }
  assert.equal(/a4m-outline__bar/.test(HTML), false, '细横条已移出页面')
  assert.equal(/a4m-outline__added/.test(HTML), false, '增量数字已移出页面')
  assert.equal(/a4m-outline__foot|a4m-outline__note/.test(HTML), false, '页脚与读法说明已移出页面')
  // 但机器要的信息仍在属性里
  assert.match(HTML, /data-a4m-added="\d+"/)
  assert.match(HTML, /data-a4m-total="7"/)
  assert.match(HTML, /data-a4m-covered="7"/)
})

test('大纲: 每行带 data-a4m-station / added / index / dep-index / lines（给机器读）', () => {
  const rows = [...HTML.matchAll(/<li class="a4m-outline__row"[^>]*>/g)].map((match) => match[0])
  assert.equal(rows.length, OUTLINE.stations.length)
  for (const [index, row] of rows.entries()) {
    assert.match(row, /data-a4m-station="[^"]+"/)
    assert.match(row, /data-a4m-added="\d+"/)
    assert.match(row, new RegExp(`data-a4m-index="${index + 1}"`), '显示编号从 1 起')
    assert.match(row, /data-a4m-dep-index="\d+"/, '依赖序的原始下标另存')
  }
})

test('大纲: 默认论文序（最基础在前、定理在最后），可切回依赖序', () => {
  const ids = (html) => [...html.matchAll(/data-a4m-station="([^"]+)"/g)].map((match) => match[1])
  const dependency = ids(renderOutlineHtml(OUTLINE, { title: 't', order: 'dependency' }))
  const reading = ids(HTML) // 默认
  assert.deepEqual(reading, [...dependency].reverse(), '论文序就是依赖序的反转')
  assert.deepEqual(dependency, OUTLINE.stations.map((station) => station.id))
  assert.equal(reading[reading.length - 1], 'r', '定理/根在最前的那一站最后出现')
  assert.equal(reading[0], 'e', '最基础的前置排第一（此夹具里是最深的 e）')
  // +N 是站点的属性，与顺序无关：两种顺序下每站的 added 必须一一对应
  const pairs = (html) => new Map([...html.matchAll(/data-a4m-station="([^"]+)" data-a4m-added="(\d+)"/g)].map((m) => [m[1], m[2]]))
  assert.deepEqual([...pairs(HTML).entries()].sort(), [...pairs(renderOutlineHtml(OUTLINE, { title: 't', order: 'dependency' })).entries()].sort())
  assert.equal(/data-a4m-order="reading"/.test(HTML), true)
})

test('大纲: mergeBelow 把小平站并成一条，并列出成员名（不写计数）', () => {
  const merged = renderOutlineHtml(OUTLINE, { title: '合并版', mergeBelow: 1 })
  const rows = (merged.match(/class="a4m-outline__row"/g) ?? []).length
  assert.ok(rows < OUTLINE.stations.length, `合并后行数应更少，实际 ${rows}`)
  assert.match(merged, /data-a4m-merged="true"/)
  assert.match(merged, /data-a4m-stations="\d+"/)
  assert.equal(/合并 \d+ 站/.test(merged), false, '页面上不写合并计数')
  // 合并不能改变总数：Σ 仍然是锥内模块数
  const mergedAdded = [...merged.matchAll(/data-a4m-added="(\d+)"/g)].map((match) => Number(match[1]))
  assert.equal(mergedAdded.reduce((sum, value) => sum + value, 0), OUTLINE.totalModules)
})

test('大纲: 合并行的 data-a4m-lines 是各成员之和（行为仍在，必须继续钉住）', () => {
  const outline = {
    stations: [
      { id: 'a', index: 0, subtreeSize: 2, subtreeLines: 200, addedCount: 1 },
      { id: 'b', index: 1, subtreeSize: 1, subtreeLines: 100, addedCount: 1 },
    ],
    totalModules: 2,
    coveredModules: 2,
    tieBreak: 'lines',
  }
  const html = renderOutlineHtml(outline, { title: 't', moduleStats: { a: { lines: 300, decls: 1 }, b: { lines: 500, decls: 1 } }, mergeBelow: 2 })
  assert.match(html, /data-a4m-lines="800"/, '合并行的行数是 300 + 500')
  assert.match(html, /data-a4m-stations="2"/)
  // 页面上用成员名代替计数
  const title = /<span class="a4m-outline__name">([^<]*)<\/span>/.exec(html)?.[1] ?? ''
  assert.equal(title, 'b、a', '合并行列出成员短名（论文序：先 b 后 a）')
})

test('大纲: 确定性（同一输入两次渲染逐字节相同）', () => {
  assert.equal(renderOutlineHtml(OUTLINE, { title: 'x' }), renderOutlineHtml(OUTLINE, { title: 'x' }))
})

// ── 巨石展开（单体文件不是一站，是一堆站挤在一个文件里）────────────────

/** 一个「巨石」模块的统计：94 个命名空间、1227 条声明、20756 行。 */
function monolithStats() {
  return {
    'big.module': {
      lines: 20756,
      decls: 1227,
      namespaces: [
        { name: 'PacketGrowth', lines: 1928, decls: 64 },
        { name: 'PacketRay', lines: 1013, decls: 37 },
        { name: 'PacketPerturbation', lines: 616, decls: 19 },
        { name: 'Scale', lines: 514, decls: 23 },
        { name: 'PacketFrameStability', lines: 508, decls: 16 },
        { name: 'MixedCylinderTransport', lines: 482, decls: 39 },
        { name: 'JetProductBounds', lines: 413, decls: 27 },
        { name: 'SmoothSobolev', lines: 409, decls: 39 },
      ],
    },
  }
}
const MONO_OUTLINE = {
  stations: [
    { id: 'big.module', index: 0, subtreeSize: 3, subtreeLines: 30000, addedCount: 1 },
    { id: 'other', index: 1, subtreeSize: 2, subtreeLines: 100, addedCount: 1 },
    { id: 'root', index: 2, subtreeSize: 1, subtreeLines: 20, addedCount: 1 },
  ],
  totalModules: 3,
  coveredModules: 3,
  tieBreak: 'lines',
}

test('巨石: 命名空间多的模块列出分节名（不带任何计数）', () => {
  const html = renderOutlineHtml(MONO_OUTLINE, { title: 't', moduleStats: monolithStats() })
  assert.match(html, /data-a4m-sections="8"/, '机器可读地标出这是多分节文件（中性事实名）')
  assert.match(html, /data-a4m-decls="1227"/)
  assert.equal(/monolith|巨石/.test(html), false, '不得再出现判断性标签')
  const subs = [...html.matchAll(/data-a4m-namespace="([^"]+)"/g)].map((m) => m[1])
  assert.deepEqual(subs, ['PacketGrowth', 'PacketRay', 'PacketPerturbation', 'Scale', 'PacketFrameStability', 'MixedCylinderTransport'])
  assert.match(html, /… \(2 more sections in this file\)/)
  for (const forbidden of ['条声明', '个命名空间', '本站', '比上一步', '中位数', '未随文件更新']) {
    assert.equal(html.includes(forbidden), false, `页面上不该出现「${forbidden}」`)
  }
})

test('巨石: 单命名空间的模块不展开（展开成一行是噪音）', () => {
  const stats = { 'fat.module': { lines: 1676, decls: 235, namespaces: [{ name: 'Only', lines: 1676, decls: 235 }] } }
  const outline = {
    stations: [{ id: 'fat.module', index: 0, subtreeSize: 1, subtreeLines: 1676, addedCount: 1 }],
    totalModules: 1,
    coveredModules: 1,
    tieBreak: 'lines',
  }
  const html = renderOutlineHtml(outline, { title: 't', moduleStats: stats })
  assert.equal(/data-a4m-sections=/.test(html), false, '不该展开')
  assert.equal(/data-a4m-namespace=/.test(html), false)
})

test('README: §2 正文的数字必须与 §3 表格一致，且都能从产物复算', () => {
  // 造一组「最大增量 ≠ 根站增量」的数据——曾经 README 正文把最大增量当成了定理那一站的增量
  const outline = {
    stations: [
      { id: 'theorem.mod', index: 0, subtreeSize: 12, subtreeLines: 1200, addedCount: 3 },
      { id: 'big.mod', index: 1, subtreeSize: 9, subtreeLines: 900, addedCount: 8 },
      { id: 'heavy.mod', index: 2, subtreeSize: 1, subtreeLines: 20000, addedCount: 1 },
    ],
    totalModules: 12,
    coveredModules: 12,
    tieBreak: 'lines',
  }
  const moduleStats = { 'theorem.mod': { lines: 60, decls: 2 }, 'big.mod': { lines: 300, decls: 9 }, 'heavy.mod': { lines: 20000, decls: 900 } }
  const readme = renderOutlineReadme([{ root: 'Demo', outline, moduleStats, mergedRows: 2, mergeBelow: 3 }], {})
  const table = readme.split('\n').find((line) => line.startsWith('| `Demo` |'))
  assert.ok(table, '表格行必须在')
  assert.match(table, /\| 12 \| ✅ \| 3 \| 8（`big\.mod`） \|/, `表格数字，实际 ${table}`)
  // 正文：最大增量归 big.mod（不是根站），根站的增量单独写，最重站的行数单独写
  assert.match(readme, /largest increment in the whole cone is \*\*8\*\* \(`big\.mod`\)/)
  assert.match(readme, /increment of \*\*3\*\*[^.]{0,80}60 lines|increment \*\*3\*\*[\s\S]{0,60}60 lines/)
  assert.match(readme, /`heavy\.mod`[\s\S]{0,120}increment of \*\*1\*\*[\s\S]{0,120}20,000 lines/)
  assert.equal(/\(theorem\): increment \*\*8\*\*/.test(readme), false, '不得再把最大增量安在定理站上')
})

test('README: 六项内容齐备（披露只搬家、不删除）', () => {
  const readme = renderOutlineReadme([{ root: 'Demo', outline: OUTLINE, mergedRows: 2, mergeBelow: 3 }], { generatedBy: 'node scripts/graph-export.mjs …' })
  for (const needed of ['How to read the outline', 'reading order', 'increment', 'M lines (this step)', 'does not mean a small step', 'known limitations', 'may be out of date', 'relative to each tree', 'telescoping', 'tieBreak', 'formalization.yaml', 'Reproduce', 'dependency.html', 'README.md', 'Glossary', 'main-line step']) {
    assert.ok(readme.includes(needed), `README 缺「${needed}」`)
  }
  assert.match(readme, /\| Steps \| Modules in cone \|/)
  assert.match(readme, /`Demo` \| 4 \| 7 \| ✅/)
  assert.equal(readme.includes('<script'), false)
})

// ── 每站成员页（附录 G.6b）──────────────────────────────────────────

const STATION = {
  stationId: 'Euler.MeanPacketData',
  index: 53,
  members: ['Euler.MeanBoundary', 'Euler.MeanCutoffCurl', 'Euler.PacketAlpha', 'Euler.PacketBeta', 'Euler.Zeta'],
  totalMembers: 5,
}
const STATION_HTML = renderStationPage(OUTLINE, STATION, {
  docstrings: { 'Euler.MeanPacketData': '本站的说明。', 'Euler.MeanBoundary': '边界均值。', 'Euler.PacketAlpha': 'α 包。' },
  displayIndex: 34,
  outlineHref: 'index.html',
  prev: { index: 33, id: 'Euler.PrevStation', file: '33.html' },
  next: { index: 35, id: 'Euler.NextStation', file: '35.html' },
})

test('站点页: 标题 = 序号 · 模块短名，正文有本站说明', () => {
  assert.match(STATION_HTML, /<span class="a4m-station__index">34<\/span>MeanPacketData/)
  assert.match(STATION_HTML, /本站的说明。/)
  assert.match(STATION_HTML, /data-a4m-station="Euler\.MeanPacketData"/)
  assert.match(STATION_HTML, /data-a4m-index="34"/)
})

test('站点页: 成员按命名族分组、组内按短名字典序；每条带该模块自己的说明', () => {
  const families = [...STATION_HTML.matchAll(/data-a4m-family="([^"]+)"/g)].map((m) => m[1])
  assert.deepEqual(families, ['Mean', 'Packet', 'Zeta'], '组间按成员数降序（主导族在前）')
  const names = [...STATION_HTML.matchAll(/data-a4m-member="([^"]+)"/g)].map((m) => m[1])
  assert.deepEqual(names, ['Euler.MeanBoundary', 'Euler.MeanCutoffCurl', 'Euler.PacketAlpha', 'Euler.PacketBeta', 'Euler.Zeta'])
  assert.match(STATION_HTML, /边界均值。/, '成员自己的说明要显示')
  assert.match(STATION_HTML, /α 包。/)
  assert.equal((STATION_HTML.match(/\(no module description\)/g) ?? []).length, 3, '5 个成员里 3 个没有说明 → 如实写，不许编')
})

test('站点页: 上一站 / 下一站 / 返回大纲都是普通 <a href>，零脚本', () => {
  assert.match(STATION_HTML, /<a class="a4m-station__nav-link" href="33\.html" data-a4m-nav="prev">← Previous 33/)
  assert.match(STATION_HTML, /<a class="a4m-station__nav-link" href="index\.html" data-a4m-nav="outline">Back to outline/)
  assert.match(STATION_HTML, /<a class="a4m-station__nav-link" href="35\.html" data-a4m-nav="next">Next 35/)
  assert.equal((STATION_HTML.match(/<script/gi) ?? []).length, 0)
})

test('大纲: enhance 打开时脚本自包含、可失败（渐进增强）', () => {
  const html = renderOutlineHtml(OUTLINE, { title: 't', enhance: true })
  const scripts = [...html.matchAll(/<script[\s\S]*?<\/script>/gi)].map((m) => m[0])
  assert.equal(scripts.length, 1, '只注入一段增强脚本')
  const js = scripts[0]
  assert.equal(/https?:|src=|cdn|fetch\(|import\(/i.test(js), false, '不许联网、不引 CDN、不动态加载')
  assert.match(js, /try\s*\{/, '整段包在 try 里')
  assert.match(js, /catch/, '有 catch：脚本挂了页面照样读')
  assert.match(js, /details/, '只增强 <details>')
  assert.ok(js.length < 3000, `脚本要小，实际 ${js.length} B`)
})

test('大纲: 无 JS 也能到达任何站点页（链接必须在静态 HTML 里）', () => {
  const html = renderOutlineHtml(OUTLINE, { title: 't', enhance: true, mergeBelow: 1, stationHref: (index) => `0${index}.html` })
  const stripped = html.replace(/<script[\s\S]*?<\/script>/gi, '')
  const links = [...stripped.matchAll(/href="(0\d\.html)"/g)].map((m) => m[1])
  assert.deepEqual([...new Set(links)].sort(), ['01.html', '02.html', '03.html', '04.html'], '每个站点页都要有静态链接')
  // 展开体是原生 <details>，不靠脚本
  assert.match(stripped, /<details class="a4m-outline__details"/)
  assert.match(stripped, /<summary class="a4m-outline__summary">/)
})

test('大纲: 合并行展开成「每站一个小标题」（序号 · 短名 + 说明 + 链接）', () => {
  const html = renderOutlineHtml(OUTLINE, {
    title: 't',
    mergeBelow: 10,
    stationHref: (index) => `0${index}.html`,
    docstrings: { r: '根站的说明。', a: 'a 的说明。' },
    mergeRows: true,
  })
  assert.match(html, /data-a4m-expand="merged"/)
  assert.match(html, /data-a4m-expand-count="4"/)
  assert.match(html, /class="a4m-outline__station"/)
  assert.match(html, /a 的说明。/, '小标题要带该站的作者说明')
  assert.match(html, /(no module description)/, '缺说明如实写')
  assert.match(html, /data-a4m-namespace-list="true"|data-a4m-station="r"/)
})

test('站点页: 正文不出现计数（沿用「页面只放数学」）', () => {
  for (const forbidden of ['declarations', 'namespace sections', 'lines (this step)', 'increment', 'median', 'out of date']) {
    assert.equal(STATION_HTML.includes(forbidden), false, `页面上不该出现「${forbidden}」`)
  }
  assert.match(STATION_HTML, /data-a4m-members="5"/, '成员数只进属性')
})

test('站点页: 文件名与序号一致（两位数）', () => {
  assert.equal(stationFileName(1), '01.html')
  assert.equal(stationFileName(34), '34.html')
  assert.equal(stationFileName(100), '100.html')
})

test('大纲: 有站点页时站名变成链接', () => {
  const html = renderOutlineHtml(OUTLINE, { title: 't', stationHref: (index) => `0${index}.html` })
  assert.match(html, /<a class="a4m-outline__link" href="01\.html" data-a4m-page="01\.html">/)
  assert.match(html, /href="03\.html"/)
  assert.equal((html.match(/<script/gi) ?? []).length, 0)
})

test('指针页: 旧路径只放一个链接，不复制大纲内容', () => {
  const pointer = renderOutlinePointer('Euler.Solution 主线大纲', 'Euler.Solution/index.html', '已移到子目录。')
  assert.match(pointer, /<a href="Euler\.Solution\/index\.html">Euler\.Solution 主线大纲<\/a>/)
  assert.equal((pointer.match(/<script/gi) ?? []).length, 0)
  assert.ok(pointer.length < 1500, '指针页必须很小（不复制内容，避免两份漂移）')
})
