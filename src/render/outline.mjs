/**
 * outline.mjs — 主线大纲 → **竖向单栏 HTML**（纯字符串生成，不碰 DOM、不写文件）
 *
 * 依据：INTERFACES 附录 G.6（v1.4）。这一页回答的是「方便理解的结构」：
 * 前面几轮做的是**图**（20728×1252、折叠到 867 仍然不可读），这一页改做**目录**——
 * 一站一行，从上往下读就是主线的顺序，`+N` 说明这一站带来了多少细节。
 *
 * 三条性质：
 *   1. **零 `<script>`**（本期；交互是下一期）。
 *   2. **不编**：模块说明缺了就如实写「（无模块说明）」。
 *   3. 视觉沿用论文项目的衬线 + 配色（与图谱视图同源，最终与论文视图的 `:root` 对齐），不是深色主题。
 *
 * 「每站带来多少」的语义由 core 侧保证（望远镜求和，Σ = 锥内模块总数）——这一页只负责把它读出来。
 */

import { escapeHtml } from './lean-math.mjs'
import { GRAPH_PALETTE } from './graph.mjs'

/**
 * 多分节文件（一个文件里塞了很多命名空间）的判定。
 *
 * **为什么不能用固定的「声明数 ≥ N」**：实测两棵树的体量分布完全不同——
 * Euler.Solution 锥里中位数约 10 条声明，`EulerProof` 1227 条，断崖清晰；
 * 但 NavierStokes.ComparatorSolution 的文件**系统性偏大**（`CorrectionStep` 560 条、
 * `CorrectionInitialization` 393 条…），「声明 ≥ 60」在那边会命中 **214 个**模块——
 * 展开变成常态，等于没判。
 *
 * 所以两条判据都**相对于本树的分布**：
 *   1. **展开成容器**：命名空间 ≥ 8。展开出来的是命名空间清单，只有「一个文件里塞了多节」
 *      才值得展开；单命名空间的模块展开成一行是纯噪音。
 *   2. **提示说明可能过时**：声明数 ≥ 5 × 本树主线站点的声明数中位数（或已展开）。
 *      `EulerProof` 就是典型：21k 行、1227 条声明，说明却写于早期版本。
 */
/** Member families: families smaller than this merge into an "Other" family placed last (long-tail dilution). */
export const FAMILY_MIN_SIZE = 3

export const MONOLITH = Object.freeze({
  /** 命名空间数达到这个数才展开成容器。 */
  minNamespaces: 8,
  /** 声明数超过「中位数 × 这个倍数」时提示说明可能过时。 */
  declsMedianFactor: 5,
  /** How many namespace sections to show when expanding (the rest fold into one line). */
  topNamespaces: 6,
})

/** Should this module expand into a container (many sections inside one file)? */
function shouldExpand(stats) {
  if (stats === undefined || stats === null) return false
  return (stats.namespaces?.length ?? 0) >= MONOLITH.minNamespaces
}

/** 该不该提示「模块说明可能未随文件更新」（体量远超本树的同类）。 */
function isOversized(stats, medianDecls) {
  if (stats === undefined || stats === null) return false
  if (shouldExpand(stats)) return true
  return (stats.decls ?? 0) >= MONOLITH.declsMedianFactor * Math.max(1, medianDecls)
}

/** 千分位分组（自己实现，不用 toLocaleString——那是 locale 相关的，会破坏确定性）。 */
function groupDigits(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** 模块短名：去掉命名空间前缀，留最后一段（目录里读得动）。 */
function shortName(moduleId) {
  const parts = String(moduleId).split('.')
  return parts[parts.length - 1]
}

/**
 * 合并相邻的「小平站」：`addedCount ≤ mergeBelow` 的站并进上一条。
 * 目的是让目录的**行数**与目录的**信息量**匹配——82 行里有一半只带来个位数模块。
 */
function mergeStations(stations, mergeBelow) {
  if (!Number.isFinite(mergeBelow) || mergeBelow <= 0) {
    return stations.map((station) => ({ ...station, merged: 1, mergedFrom: [station.id] }))
  }
  const rows = []
  let pending = null
  for (const station of stations) {
    if (pending === null) {
      pending = { ...station, merged: 1, mergedFrom: [station.id] }
      continue
    }
    if (station.addedCount <= mergeBelow) {
      pending.merged += 1
      pending.mergedFrom.push(station.id)
      pending.addedCount += station.addedCount
      pending.subtreeSize = Math.max(pending.subtreeSize, station.subtreeSize)
      continue
    }
    rows.push(pending)
    pending = { ...station, merged: 1, mergedFrom: [station.id] }
  }
  if (pending !== null) rows.push(pending)
  return rows
}

/**
 * 主线大纲 → 单文件 HTML（零脚本）。
 *
 * @param {{stations: {id: string, index: number, subtreeSize: number, addedCount: number}[],
 *          totalModules: number, coveredModules: number}} outline `mainLine` 的输出
 * 顺序：`mainLine` 给的是**依赖序**（定理在前、逐层往下钻）。渲染层默认翻成**论文序**
 * （`order: 'reading'`）——最基础的在前、定理在最后，与论文"先建工具再给结论"一致。
 * `+N` 的数值与顺序无关（它是站点的属性）：在论文序里读作「走到这一步，比上一步**额外需要** N 个模块」。
 *
 * **多分节文件**（一个文件里塞了几十条声明、上百个命名空间）不显示成一行，而是展开成容器：
 * 顶部一行给出「模块 / 行数 / 声明数 / 命名空间数」，下面是按行数降序的命名空间子项。
 * 这样「先建基础」的第一行就不会是「带来 1 个模块」那种荒谬读法。
 *
 * @param {{docstrings?: Record<string, string>,
 *          moduleStats?: Record<string, {lines?: number, decls?: number,
 *                                         namespaces?: {name: string, lines: number, decls: number}[]}>,
 *          mergeBelow?: number, title?: string,
 *          rootId?: string, docstringSource?: string, order?: 'reading'|'dependency',
 *          tieBreak?: 'lines'|'id'}} [opts]
 * @returns {string}
 */
export function renderOutlineHtml(outline, opts = {}) {
  const stations = Array.isArray(outline?.stations) ? outline.stations : []
  const docstrings = opts.docstrings && typeof opts.docstrings === 'object' ? opts.docstrings : {}
  const mergeBelow = Number.isFinite(opts.mergeBelow) ? opts.mergeBelow : 0
  const title = opts.title ?? '主线大纲'
  const totalModules = outline?.totalModules ?? 0
  const coveredModules = outline?.coveredModules ?? 0
  // 依赖序 → 论文序：整条线反过来（最深的前置在前、定理在最后）。
  // 合并必须在**目标顺序**上做：合并规则是「并进上一行」，两个方向得到的分组不同。
  const order = opts.order === 'dependency' ? 'dependency' : 'reading'
  const readingStations = order === 'reading' ? [...stations].reverse() : stations
  const rows = mergeStations(readingStations, mergeBelow)
  const moduleStats = opts.moduleStats && typeof opts.moduleStats === 'object' ? opts.moduleStats : {}
  const linesOf = (id) => moduleStats[id]?.lines ?? null
  /** 这一行的「本站体量」：单站就是它自己；合并行是各成员之和（不然合并行的行数会只算第一站）。 */
  const rowLines = (row) => {
    const known = row.mergedFrom.map((id) => moduleStats[id]?.lines).filter((value) => Number.isFinite(value))
    return known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0)
  }
  /** 一行里分节最多的成员：合并行也可能吞掉一个多分节文件（它的 addedCount 可能只有 1）。 */
  // 本树主线站点的声明数中位数：判定必须相对于本树的分布（两棵树的体量差一个量级）
  const declSamples = stations
    .map((station) => moduleStats[station.id]?.decls)
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b)
  const medianDecls = declSamples.length === 0 ? 0 : declSamples[Math.floor(declSamples.length / 2)]
  const heaviestMember = (row) =>
    [...row.mergedFrom].sort((a, b) => (moduleStats[b]?.decls ?? 0) - (moduleStats[a]?.decls ?? 0) || (a < b ? -1 : 1))[0]

  // 阅读序里每个站点 id → 显示序号（合并行里要逐个给出链接）
  const rowIndex = new Map()
  {
    let at = 0
    for (const row of rows) for (const id of row.mergedFrom) rowIndex.set(id, (at += 1))
  }
  let shown = 0
  const body = rows
    .map((row) => {
      shown += 1
      const displayIndex = shown
      const doc = typeof docstrings[row.id] === 'string' && docstrings[row.id].trim() !== '' ? docstrings[row.id].trim() : null
      // 页面只放数学：序号 · 模块短名 + 作者说明（+ 单体的分节名）。
      // 计数、增量、行数、中位数、"说明可能过时" 全部搬进 out/outline/README.md——
      // 那些是形式化的记账，数学家读证明大纲时不关心（用户的原话）。
      const selfLines = rowLines(row)
      const stats = moduleStats[heaviestMember(row)]
      const manySections = shouldExpand(stats)
      const names = manySections ? (stats.namespaces ?? []).slice(0, MONOLITH.topNamespaces) : []
      const restCount = manySections ? Math.max(0, (stats.namespaces?.length ?? 0) - names.length) : 0
      const hrefOf = typeof opts.stationHref === 'function' ? opts.stationHref : null
      // 站名一律是**静态 `<a href>`**：不依赖脚本注入，无 JS 也能到达任何站点页。
      // 合并行把**每个**成员的短名都做成链接（1 次点击就能到），细节说明放 <details> 里。
      const headLink = (id, index) => {
        const href = hrefOf === null ? null : hrefOf(index)
        const text = escapeHtml(shortName(id))
        return href === null ? text : `<a class="a4m-outline__link" href="${escapeHtml(href)}" data-a4m-page="${escapeHtml(href)}">${text}</a>`
      }
      // 行的显示编号 = 它第一个成员在**阅读序**里的序号（与站点页文件名 NN.html 一致）；
      // 合并行因此显示首站的号，展开后能看到它覆盖的连续几站。
      const firstIndex = rowIndex.get(row.mergedFrom[0]) ?? displayIndex
      const title =
        row.merged > 1
          ? row.mergedFrom.map((id) => headLink(id, rowIndex.get(id) ?? displayIndex)).join('、')
          : headLink(row.id, rowIndex.get(row.id) ?? displayIndex)
      // 展开体：合并行 → 它合并掉的各站（小标题 + 该站作者说明 + 站点页链接）；
      //         多分节文件 → 命名空间分节（只有短名，没有作者说明，不编）
      const mergedEntries =
        row.merged > 1
          ? row.mergedFrom
              .map((id) => {
                const index = rowIndex.get(id) ?? displayIndex
                const text = typeof docstrings[id] === 'string' && docstrings[id].trim() !== '' ? docstrings[id].trim() : null
                return `  <li class="a4m-outline__station" data-a4m-station="${escapeHtml(id)}"><p class="a4m-outline__station-head"><span class="a4m-outline__index">${index}</span><span class="a4m-outline__sep">·</span>${headLink(id, index)}</p><p class="a4m-outline__station-path">${escapeHtml(id)}</p><p class="a4m-outline__station-doc">${text === null ? '(no module description)' : escapeHtml(text)}</p></li>`
              })
              .join('\n')
          : ''
      // 每个分节一个条目：正文只给短名（命名空间没有作者说明，不编），计数只进属性
      const namespaceEntries =
        names.length === 0
          ? ''
          : names
              .map(
                (item) =>
                  `  <li class="a4m-outline__sub-item" data-a4m-namespace="${escapeHtml(item.name)}" data-a4m-lines="${item.lines}" data-a4m-decls="${item.decls}">${escapeHtml(shortName(item.name))}</li>`,
              )
              .join('\n') + (restCount > 0 ? `\n  <li class="a4m-outline__sub-item a4m-outline__sub-item--rest" data-a4m-namespaces-rest="${restCount}">… (${restCount} more sections in this file)</li>` : '')
      // 合并行里可能藏着多分节文件（它的 addedCount 可能很小）：两者都要能展开
      const expandable = mergedEntries !== '' || namespaceEntries !== ''
      const summaryText =
        row.merged > 1
          ? `Expand: ${row.merged} steps${namespaceEntries === '' ? '' : ' (includes sections of a multi-section file)'}`
          : manySections
            ? `Expand sections`
            : ''
      const subList = expandable
        ? `<details class="a4m-outline__details" data-a4m-expand="${[mergedEntries === '' ? '' : 'merged', namespaceEntries === '' ? '' : 'namespaces'].filter(Boolean).join(' ')}"${row.merged > 1 ? ` data-a4m-expand-count="${row.merged}"` : ''}>
<summary class="a4m-outline__summary">${escapeHtml(summaryText)}</summary>
<ol class="a4m-outline__sub">
${mergedEntries}${namespaceEntries}
</ol>
</details>`
        : ''
      return `<li class="a4m-outline__row"${manySections ? ` data-a4m-sections="${stats?.namespaces?.length ?? 0}"` : ''}${row.merged > 1 ? ' data-a4m-merged="true"' : ''} data-a4m-station="${escapeHtml(row.id)}" data-a4m-added="${row.addedCount}" data-a4m-index="${displayIndex}" data-a4m-dep-index="${row.index}"${row.merged > 1 ? ` data-a4m-stations="${row.merged}"` : ''}${selfLines === null ? '' : ` data-a4m-lines="${selfLines}"`}${stats === undefined ? '' : ` data-a4m-decls="${stats.decls ?? 0}"`}>
<p class="a4m-outline__head"><span class="a4m-outline__index">${firstIndex}</span><span class="a4m-outline__sep">·</span><span class="a4m-outline__name">${title}</span></p>
<p class="a4m-outline__module">${escapeHtml(row.id)}</p>
<p class="a4m-outline__doc">${doc === null ? '(no module description)' : escapeHtml(doc)}</p>
${subList}</li>`
    })
    .join('\n')

  // JS 增强：只在 <details> 做不到的地方出手（全部展开/收起、记住展开状态）。
  // 自包含、不联网、不引任何外部资源；整段包在 try/catch 里——脚本挂掉，目录照样读。
  const enhanceScript =
    opts.enhance === true
      ? `<script>
(function () {
  try {
    var root = document.querySelector('.a4m-outline');
    if (root === null) return;
    var all = root.querySelectorAll('details');
    if (all.length === 0) return;
    var bar = document.createElement('div');
    bar.className = 'a4m-outline__enhance';
    var openAll = document.createElement('button');
    openAll.type = 'button';
    openAll.textContent = '全部展开';
    var closeAll = document.createElement('button');
    closeAll.type = 'button';
    closeAll.textContent = '全部收起';
    var apply = function (open) {
      for (var i = 0; i < all.length; i += 1) all[i].open = open;
    };
    openAll.addEventListener('click', function () { apply(true); });
    closeAll.addEventListener('click', function () { apply(false); });
    bar.appendChild(openAll);
    bar.appendChild(closeAll);
    root.insertBefore(bar, root.firstChild);
    // 记住展开状态（同源、纯本地；失败就静默放弃）
    var key = 'a4m-outline-open:' + location.pathname;
    try {
      var saved = localStorage.getItem(key);
      if (saved === '1') apply(true);
      for (var j = 0; j < all.length; j += 1) {
        all[j].addEventListener('toggle', function () {
          var anyOpen = false;
          for (var k = 0; k < all.length; k += 1) if (all[k].open) anyOpen = true;
          try { localStorage.setItem(key, anyOpen ? '1' : '0'); } catch (e) {}
        });
      }
    } catch (e) {}
  } catch (e) {
    /* progressive enhancement: if this fails the page still works (details is native) */
  }
})();
</script>
`
      : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · ai4math main line</title>
<style>
/* main-line outline: single column. Serif + paper palette (same source as the graph view); no dark theme. */
:root { --a4m-fg: ${GRAPH_PALETTE.fg}; --a4m-muted: ${GRAPH_PALETTE.muted}; --a4m-serif: ${GRAPH_PALETTE.serif}; --a4m-mono: ${GRAPH_PALETTE.mono}; }
html, body { margin: 0; background: #fff; color: var(--a4m-fg); }
body { font-family: var(--a4m-serif); line-height: 1.55; }
.a4m-outline { max-width: 78ch; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }
.a4m-outline__title { margin: 0 0 .35rem; font-size: 1.15rem; text-align: center; }
.a4m-outline__list { list-style: none; margin: 0; padding: 0; }
.a4m-outline__row { margin: 0 0 1.05rem; }
.a4m-outline__head { margin: 0; display: flex; align-items: baseline; gap: .5em; font-size: .95rem; }
.a4m-outline__index { color: var(--a4m-muted); font-family: var(--a4m-mono); font-size: .78rem; min-width: 2.2em; text-align: right; }
.a4m-outline__sep { color: var(--a4m-muted); }
.a4m-outline__name { font-weight: 700; }
.a4m-outline__link { color: var(--a4m-fg); text-decoration: none; }
.a4m-outline__link:hover { text-decoration: underline; }
/* in-page expansion: native <details> does the work without any script; JS only adds expand-all/collapse-all and remembers the state */
.a4m-outline__details { margin: .3rem 0 0 3.2em; }
.a4m-outline__summary { cursor: pointer; color: var(--a4m-muted); font-size: .78rem; }
.a4m-outline__station { margin: .8rem 0 0; }
.a4m-outline__station-head { margin: 0; font-size: .9rem; }
.a4m-outline__station-path { margin: .05rem 0 0; color: var(--a4m-muted); font-family: var(--a4m-mono); font-size: .7rem; }
.a4m-outline__station-doc { margin: .15rem 0 0; font-size: .85rem; text-align: justify; }
.a4m-outline__enhance { margin: 0 0 1.25rem; display: flex; gap: 1em; font-size: .78rem; }
.a4m-outline__enhance button { font: inherit; cursor: pointer; }
.a4m-outline__module { margin: .1rem 0 0 3.2em; color: var(--a4m-muted); font-family: var(--a4m-mono); font-size: .72rem; }
.a4m-outline__doc { margin: .25rem 0 0 3.2em; font-size: .87rem; text-align: justify; }
/* multi-section file: container + namespace sub-items (indented, no border or fill) */
.a4m-outline__sub { list-style: none; margin: .35rem 0 0 3.2em; padding: 0; }
.a4m-outline__sub-item--rest { font-style: italic; }
.a4m-outline__sub-item { font-size: .82rem; padding: .05rem 0; color: var(--a4m-muted); }
</style>
</head>
<body>
${enhanceScript}<main class="a4m-outline" data-a4m-outline="mainline" data-a4m-order="${order}" data-a4m-total="${totalModules}" data-a4m-covered="${coveredModules}" data-a4m-merged-below="${mergeBelow}">
<h1 class="a4m-outline__title">${escapeHtml(title)}</h1>
<ol class="a4m-outline__list">
${body}
</ol>

</main>
</body>
</html>
`
}

/**
 * 大纲的 **README**：把从页面上搬走的记账与口径收在一处（H5：披露只搬家、不删除）。
 * 页面只放数学（序号 · 模块短名 + 作者说明 + 单体的分节名），这里放读者/维护者需要的其余信息。
 *
 * @param {Array<{root: string, outline: object, mergedRows?: number, mergeBelow?: number}>} entries
 * @param {{generatedBy?: string}} [meta]
 * @returns {string} Markdown
 */
export function renderOutlineReadme(entries, meta = {}) {
  const list = Array.isArray(entries) ? entries : []
  const primary = list[0]
  const stat = (entry) => {
    const outline = entry.outline ?? { stations: [], totalModules: 0, coveredModules: 0, tieBreak: 'id' }
    const added = outline.stations.map((station) => station.addedCount)
    const sorted = [...added].sort((a, b) => a - b)
    const monotone = outline.stations.every((station, index) => index === 0 || station.subtreeSize <= outline.stations[index - 1].subtreeSize)
    return {
      stations: outline.stations.length,
      total: outline.totalModules,
      covered: outline.coveredModules,
      ok: outline.totalModules === outline.coveredModules,
      median: sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)],
      max: added.length === 0 ? 0 : Math.max(...added),
      maxStation: added.length === 0 ? '—' : outline.stations[added.indexOf(Math.max(...added))].id,
      over10: added.filter((value) => value > 10).length,
      zero: added.filter((value) => value === 0).length,
      monotone,
      tieBreak: outline.tieBreak,
    }
  }
  const table = list
    .map((entry) => {
      const s = stat(entry)
      return `| \`${entry.root}\` | ${s.stations} | ${s.total} | ${s.ok ? '✅' : '⚠️ 不相等'} | ${s.median} | ${s.max}（\`${s.maxStation}\`） | ${s.over10} | ${s.zero} | ${s.tieBreak} |`
    })
    .join('\n')
  const p = stat(primary ?? {})
  // §2 的那几个数**必须从数据里算**，不许拿「最大增量」当定理那一站的增量——
  // 曾经就是这么写错的（正文写 Solution 增量 224，而表格里 224 是另一个模块）。
  const stations = primary?.outline?.stations ?? []
  const stats = primary?.moduleStats ?? {}
  const linesOfStation = (id) => stats[id]?.lines ?? null
  const rootStation = stations[0] ?? null // 依赖序里 index 0 就是根（定理那一站）
  const biggestAdded = stations.reduce((best, station) => (best === null || station.addedCount > best.addedCount ? station : best), null)
  const heaviest = stations.reduce((best, station) => {
    const lines = linesOfStation(station.id)
    if (lines === null) return best
    return best === null || lines > best.lines ? { id: station.id, lines } : best
  }, null)
  const fmt = (value) => (value === null || value === undefined ? '—' : groupDigits(value))
  const exampleBiggest = biggestAdded === null ? '(no data)' : `the largest increment in the whole cone is **${biggestAdded.addedCount}** (\`${biggestAdded.id}\`)`
  const exampleHeaviest =
    heaviest === null
      ? ''
      : `\`${heaviest.id}\`: an increment of **${stations.find((station) => station.id === heaviest.id)?.addedCount ?? '?'}**, yet the module itself is **${fmt(heaviest.lines)} lines** — it sits at the bottom of the chain with the fewest dependencies, and is still the heaviest step`
  const exampleRoot =
    rootStation === null
      ? ''
      : `\`${rootStation.id}\` (the theorem): an increment of **${rootStation.addedCount}**${linesOfStation(rootStation.id) === null ? '' : `, own size ${fmt(linesOfStation(rootStation.id))} lines`} — at the other end of the chain`
  const merged = (list[0]?.mergedRows ?? null) === null ? '（未生成）' : `${list[0].mergedRows} 行（mergeBelow=${list[0].mergeBelow}）`

  return `# Main-line outline (dependency-graph subsystem, INTERFACES Appendix G.6)

> This file carries everything that is **deliberately absent from the pages**: how to read them, notation,
> statistics, known limitations, method, reproduction commands, and the glossary.
> The pages (\`out/outline/**\`) carry mathematics only: **step number · module short name + the author's description**
> (for a file that holds many namespaces, its section names are listed as well).
> Spec: \`docs/INTERFACES.md\` Appendix G.6.${meta.generatedBy ? `\n> Generated by: ${meta.generatedBy}` : ''}

## 1. How to read the outline

**It is in reading order**: foundations first, the theorem last — the same direction as the paper's narrative.

The main line itself is computed **backwards from the theorem** (each step picks its heaviest dependency);
the renderer reverses that chain, so the first step on the page sits at the bottom of the chain and the last one
is the theorem (\`${primary?.root ?? 'Euler.Solution'}\`). For the un-reversed view see section 6.

## 2. Notation

| Symbol | Meaning |
|---|---|
| **+N modules** | **increment**: how many modules this step needs *beyond* the previous step (telescoping sum; pairwise disjoint, no gaps) |
| **M lines (this step)** | the **size of this module itself** (for a combined row: the sum over its steps) |
| Step number | position in reading order, starting at 1; the dependency-order index is kept in \`data-a4m-dep-index\` |

**A small increment does not mean a small step.** This is the easiest thing to misread
(every number below can be recomputed from the artifacts — see the table in section 3):

- the largest increment in the whole cone is **${p.max}** (\`${p.maxStation}\`);
- ${exampleHeaviest};
- ${exampleRoot}.

(Source of each number: increment = \`data-a4m-added\`; own size = \`data-a4m-lines\`. The three examples are
"step with the largest increment", "step with the largest own size", and "dependency-order step 0 (root / theorem)".)

## 3. Statistics and known limitations

| Root | Steps | Modules in cone | Σ === cone | median increment | largest increment | steps with increment > 10 | steps with increment 0 | tie-break |
|---|---|---|---|---|---|---|---|---|
${table}

- Combined rows: ${merged} (threshold = median increment − 1, folding flat steps below the median into the row above).
- **The author's description of a large file may be out of date.** \`Euler.EulerProof\` holds 1,227 declarations
  across 94 namespace sections and 20,756 lines, while its description still speaks of "factorial majorants"
  (written for an early version). The page shows that description **verbatim** and additionally lists the file's
  real section names; where the two disagree, trust the sections.
- **The expansion rule uses thresholds relative to each tree**, not absolute ones: a fixed "declarations ≥ 60"
  would select 1 module in \`Euler.Solution\` but **214** in \`NavierStokes.ComparatorSolution\` — the two trees
  differ by an order of magnitude in size distribution. Current rule: expand a step into a container when the file
  has **≥ 8 namespace sections**; flag the description as possibly out of date when the declaration count is
  **≥ 5 × the median declaration count of this tree's main-line steps**.
- Combining rows does not change \`Σ\`: a combined row's increment is the sum over its members.

## 4. Method

1. **Main line**: starting from the root, each step picks the dependency with the **largest subtree** (reachable module count).
2. **Increment per step** = telescoping difference: \`added(p_i) = |sub(p_i)| − |sub(p_{i+1})|\`.
   Because the successor's reachable set is a subset of its predecessor's, these differences are **pairwise disjoint**
   and their union is the whole cone — that is *why* \`Σ added = modules in cone\` is an identity (asserted in tests,
   and carried on the page as \`data-a4m-total/covered\`). A longest path is *not* used as the main line: a root
   usually has several direct dependencies, and a longest path walks only one of them.
3. **Root** comes from \`formalization.yaml\` (\`main_results[].file\` / \`alignment.statements[].module\`):
   \`Euler.Solution\` (where Theorem 1.1 lives) and \`NavierStokes.ComparatorSolution\`.
   Note that \`Euler\` / \`NavierStokes\` are only top-level import aggregators, not semantic roots.
4. **Tie-break (three levels, fully deterministic)**: subtree **module count** ↓, then subtree **total lines** ↓,
   then module **id** ↑. Level 2 is not optional: counting modules alone treats a 20,000-line module and a 50-line
   module as equally heavy. Without line data the walk degrades to "module count → id" and reports \`tieBreak: 'id'\`.
5. **Reading order = the reverse of dependency order** (done in the renderer). \`+N\` values are independent of order.
6. **In-page expansion**: the outline home page is the **combined** view (42 / 34 rows). A combined row expands
   **in place** via native \`<details>/<summary>\` into one sub-heading per step (step number · short name + that
   step's author description + a link to \`NN.html\`); a multi-section file additionally expands into its section names.
   **Every step page is linked from static HTML**, so every page is reachable without JavaScript.
   JS does only what \`<details>\` cannot: an "expand all / collapse all" pair plus remembering the state in
   \`localStorage\`; it is inline, self-contained, never touches the network, and is wrapped in \`try/catch\`.
   **Step pages and the comparison artifacts stay script-free.**
7. **Member families on a step page**: members are grouped by naming family (the leading camel-case word of the short
   name); families with **< 3 members merge into an "Other" family placed last** (only when real majority families
   exist — otherwise the whole page would become "Other"); members are sorted by short name inside a family.
   A multi-section file (≥ 8 namespaces) lists its **namespace sections** instead (short names only — namespaces
   carry no author description, and none is invented).

## 5. Reproduce

\`\`\`bash
# reading order (default) + dependency-order comparison + per-step pages + graphs, all in one run
node scripts/graph-export.mjs --src .probe-nse \\
  --root Euler.Solution --root NavierStokes.ComparatorSolution \\
  --out out/graph --outline-out out/outline

# dependency order only (no reversal); the comparison artifact stays script-free
node scripts/graph-export.mjs --src .probe-nse --root Euler.Solution \\
  --outline-out out/outline --order dependency

# override the combination threshold (default = median increment − 1)
node scripts/graph-export.mjs --src .probe-nse --root Euler.Solution \\
  --outline-out out/outline --merge-below 8
\`\`\`

## 6. Artifacts

| File | Content |
|---|---|
| \`out/outline/<root>/index.html\` | **reading order + combined**: expand in place, one page per step (with JS enhancement) |
| \`out/outline/<root>/NN.html\` | one page per step (script-free): this step's description + member list grouped by family |
| \`out/outline/<root>/README.md\` | this file, for that root |
| \`out/outline/<root>.html\` | **pointer page** → \`<root>/index.html\` (old paths stay reachable) |
| \`out/outline/<root>.dependency.html\` | dependency-order comparison (script-free) |
| \`out/outline/<root>.merged.html\` | **pointer page** → \`<root>/index.html\` (the combined view is the home page now) |

Page properties: single column, serif + paper-view palette, no external resources;
each row carries \`data-a4m-station / added / index / dep-index / lines\` (a multi-section file also carries
\`data-a4m-decls / data-a4m-sections\`, and its sections carry \`data-a4m-namespace\`) — **attributes are for machines,
not for mathematicians**, which is why the page prose never shows these numbers.

## 7. Glossary

| Term on the pages | Meaning |
|---|---|
| **step** (a *main-line step*) | one station of the main line: a module the chain passes through, and the modules it brings with it |
| **Expand: N steps** | the \`<summary>\` of a combined row; expanding shows one sub-heading per step |
| **Sections** | the namespace sections of a file that holds several namespaces |
| **Other** | the family that collects member families smaller than 3 |
| **reading order** / **dependency order** | foundations-first / theorem-first; the page is reversed into reading order |
| **Back to outline** / **Previous** / **Next** | navigation between a step page and the outline |
| **Legend** / **Project module** / **Mathlib boundary** / **Outside the cone** / **Root module** | graph-view legend entries |
| **Euler · 4 modules · technical estimates** | a collapsed graph node: root · member count · kind of grouping |

> **Disambiguation:** \`step\` here means a **main-line step**, *not* the annotation role \`step\` of the paper view
> (a single \`have\` inside a proof). Where both appear in one document, write **main-line step** for this one.
`
}

/** 命名族键：取短名的首个驼峰词（`MeanPacketData` → `Mean`，`BasePacketLowBounds` → `Base`）。 */
export function familyKeyOf(shortName) {
  const match = /^[A-Z][A-Za-z0-9]*?(?=[A-Z]|$)/.exec(shortName)
  return match === null || match[0] === '' ? '其他' : match[0]
}

/** 两位页码（与序号一致）：1 → `01`。 */
export function stationFileName(index) {
  return `${String(index).padStart(2, '0')}.html`
}

/**
 * 一个站点的**成员页**（附录 G.6b）——「这一部分关联哪些证明」的答案。
 *
 * 成员集合由 `stationMembers` 给出（望远镜差），本页只负责把它读成一份**按主题组织的清单**：
 * 标题 = 序号 · 模块短名；正文 = 本站的作者说明 + 成员清单（每条 = 短名 + 该模块自己的作者说明）。
 * 排序：**按命名族分组**（组内按短名字典序），组间按成员数降序——主导族排在前面，读起来像主题。
 *
 * 与大纲同一原则：**正文不出现计数**（成员数只进 `data-a4m-*`）；说明缺失就如实写「（无模块说明）」。
 * 零脚本：上一站 / 下一站 / 返回大纲都是普通 `<a href>`。
 *
 * @param {{stations: object[]}} outline `mainLine` 的输出
 * @param {{stationId: string, index: number, members: string[], totalMembers: number}} station
 * @param {{docstrings?: Record<string, string>, prev?: {index: number, id: string, file: string}|null,
 *          next?: {index: number, id: string, file: string}|null, outlineHref?: string,
 *          displayIndex?: number, title?: string}} [opts]
 * @returns {string}
 */
export function renderStationPage(outline, station, opts = {}) {
  void outline
  const docstrings = opts.docstrings && typeof opts.docstrings === 'object' ? opts.docstrings : {}
  const members = Array.isArray(station?.members) ? [...station.members] : []
  const displayIndex = Number.isInteger(opts.displayIndex) ? opts.displayIndex : (station?.index ?? 0) + 1
  const stationId = String(station?.stationId ?? '')
  const name = shortName(stationId)
  const doc = typeof docstrings[stationId] === 'string' && docstrings[stationId].trim() !== '' ? docstrings[stationId].trim() : null

  // 按命名族分组：组间按成员数降序（主导族在前），组内按短名字典序。
  // **成员数 < FAMILY_MIN_SIZE 的族并入「其余」族放最后**——治长尾稀释主题感；
  // 只有当「多数族」确实存在时才算（否则整个清单都变成"其余"，反而更差）。
  const groups = new Map()
  for (const member of members) {
    const key = familyKeyOf(shortName(member))
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(member)
  }
  const bySize = (a, b) => b.members.length - a.members.length || (a.key < b.key ? -1 : 1)
  const sortInGroup = (list) => [...list].sort((a, b) => (shortName(a) < shortName(b) ? -1 : shortName(a) > shortName(b) ? 1 : a < b ? -1 : 1))
  let orderedGroups = [...groups.entries()]
    .map(([key, list]) => ({ key, members: sortInGroup(list) }))
    .sort(bySize)
  const smallGroups = orderedGroups.filter((group) => group.members.length < FAMILY_MIN_SIZE)
  const bigGroups = orderedGroups.filter((group) => group.members.length >= FAMILY_MIN_SIZE)
  if (bigGroups.length > 0 && smallGroups.length >= 2) {
    orderedGroups = [...bigGroups, { key: 'Other', members: sortInGroup(smallGroups.flatMap((group) => group.members)), mergedFamilies: smallGroups.length }]
  }

  const nav = [
    opts.prev ? `<a class="a4m-station__nav-link" href="${escapeHtml(opts.prev.file)}" data-a4m-nav="prev">← Previous ${opts.prev.index} · ${escapeHtml(shortName(opts.prev.id))}</a>` : '',
    opts.outlineHref === undefined ? '' : `<a class="a4m-station__nav-link" href="${escapeHtml(opts.outlineHref)}" data-a4m-nav="outline">Back to outline</a>`,
    opts.next ? `<a class="a4m-station__nav-link" href="${escapeHtml(opts.next.file)}" data-a4m-nav="next">Next ${opts.next.index} · ${escapeHtml(shortName(opts.next.id))} →</a>` : '',
  ]
    .filter(Boolean)
    .join('\n')

  // 多分节文件：它的「成员」往往只有它自己——那种清单没有信息量。
  // 改成列该文件真实的**命名空间分节**（只有短名；命名空间没有作者说明，不编）。
  const stationStats = opts.moduleStats?.[stationId]
  const namespaceNames = shouldExpand(stationStats)
    ? (stationStats.namespaces ?? []).map((item) => ({ name: item.name, lines: item.lines, decls: item.decls }))
    : []
  if (namespaceNames.length > 0 && members.length <= 1) {
    const sections = namespaceNames
      .map(
        (item) =>
          `  <li class="a4m-station__section" data-a4m-section="${escapeHtml(item.name)}" data-a4m-lines="${item.lines}" data-a4m-decls="${item.decls}">${escapeHtml(shortName(item.name))}</li>`,
      )
      .join('\n')
    return stationPageShell({
      displayIndex,
      name,
      stationId,
      doc,
      memberCount: members.length,
      sectionCount: namespaceNames.length,
      body: `<h2 class="a4m-station__family">Sections</h2>\n<ul class="a4m-station__sections">\n${sections}\n</ul>`,
      nav,
    })
  }

  const memberList = orderedGroups
    .map(
      (group) => `<section class="a4m-station__group" data-a4m-family="${escapeHtml(group.key)}">
<h2 class="a4m-station__family">${escapeHtml(group.key)}</h2>
<ul class="a4m-station__members">
${group.members
  .map((member) => {
    const text = typeof docstrings[member] === 'string' && docstrings[member].trim() !== '' ? docstrings[member].trim() : null
    return `  <li class="a4m-station__member" data-a4m-member="${escapeHtml(member)}"><span class="a4m-station__member-name">${escapeHtml(shortName(member))}</span><span class="a4m-station__member-path">${escapeHtml(member)}</span><p class="a4m-station__member-doc">${text === null ? '(no module description)' : escapeHtml(text)}</p></li>`
  })
  .join('\n')}
</ul>
</section>`,
    )
    .join('\n')

  return stationPageShell({
    displayIndex,
    name,
    stationId,
    doc,
    memberCount: members.length,
    body: memberList,
    nav,
  })
}

/**
 * 站点页外壳（成员清单分支与命名空间分节分支共用）。**零脚本**：只需要 `<a>`。
 * @returns {string}
 */
function stationPageShell({ displayIndex, name, stationId, doc, memberCount, sectionCount, body, nav }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(`${displayIndex} · ${name}`)} · ai4math main line</title>
<style>
/* station page: same visual language as the outline (serif + paper palette), zero script, no counts in the prose */
:root { --a4m-fg: ${GRAPH_PALETTE.fg}; --a4m-muted: ${GRAPH_PALETTE.muted}; --a4m-serif: ${GRAPH_PALETTE.serif}; --a4m-mono: ${GRAPH_PALETTE.mono}; }
html, body { margin: 0; background: #fff; color: var(--a4m-fg); }
body { font-family: var(--a4m-serif); line-height: 1.55; }
.a4m-station { max-width: 78ch; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }
.a4m-station__title { margin: 0 0 .5rem; font-size: 1.1rem; }
.a4m-station__index { color: var(--a4m-muted); font-family: var(--a4m-mono); font-size: .8rem; margin-right: .5em; }
.a4m-station__module { margin: 0 0 1rem; color: var(--a4m-muted); font-family: var(--a4m-mono); font-size: .72rem; }
.a4m-station__doc { margin: 0 0 2rem; text-align: justify; }
.a4m-station__family { margin: 1.75rem 0 .35rem; font-size: .95rem; font-weight: 700; }
.a4m-station__members { list-style: none; margin: 0; padding: 0; }
.a4m-station__member { margin: 0 0 .9rem; }
.a4m-station__member-name { font-weight: 700; font-size: .9rem; margin-right: .5em; }
.a4m-station__member-path { color: var(--a4m-muted); font-family: var(--a4m-mono); font-size: .7rem; }
.a4m-station__member-doc { margin: .15rem 0 0; font-size: .87rem; text-align: justify; }
.a4m-station__sections { list-style: none; margin: 0; padding: 0; columns: 2; }
.a4m-station__section { font-family: var(--a4m-mono); font-size: .78rem; padding: .05rem 0; }
.a4m-station__nav { display: flex; gap: 1.5em; flex-wrap: wrap; margin: 2.5rem 0 0; font-size: .82rem; }
.a4m-station__nav-link { color: var(--a4m-fg); }
</style>
</head>
<body>
<main class="a4m-station" data-a4m-station="${escapeHtml(stationId)}" data-a4m-index="${displayIndex}" data-a4m-members="${memberCount}"${sectionCount === undefined ? '' : ` data-a4m-sections="${sectionCount}"`}>
<p class="a4m-station__nav">${nav}</p>
<h1 class="a4m-station__title"><span class="a4m-station__index">${displayIndex}</span>${escapeHtml(name)}</h1>
<p class="a4m-station__module">${escapeHtml(stationId)}</p>
<p class="a4m-station__doc">${doc === null ? '(no module description)' : escapeHtml(doc)}</p>
${body}
<p class="a4m-station__nav">${nav}</p>
</main>
</body>
</html>
`
}

/**
 * 旧路径的**指针页**：平铺的 `<root>.html` 现在指向 `<root>/index.html`。
 * 不复制大纲内容（两份会漂移），只留一个普通 `<a href>`——零脚本，老链接照样可达。
 */
export function renderOutlinePointer(title, href, note) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · moved to a subdirectory</title>
<style>
html, body { margin: 0; background: #fff; color: ${GRAPH_PALETTE.fg}; font-family: ${GRAPH_PALETTE.serif}; }
.a4m-pointer { max-width: 78ch; margin: 0 auto; padding: 3rem 1.25rem; }
.a4m-pointer__title { margin: 0 0 .5rem; font-size: 1.05rem; }
.a4m-pointer__note { color: ${GRAPH_PALETTE.muted}; font-size: .82rem; }
</style>
</head>
<body>
<main class="a4m-pointer">
<h1 class="a4m-pointer__title"><a href="${escapeHtml(href)}">${escapeHtml(title)}</a></h1>
<p class="a4m-pointer__note">${escapeHtml(note ?? 'This artifact now lives in the same-named subdirectory (outline + one page per step).')}</p>
</main>
</body>
</html>
`
}
