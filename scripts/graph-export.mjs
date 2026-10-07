#!/usr/bin/env node
/**
 * graph-export.mjs — 依赖图谱导出：扫描 Lean 源码树 → 建图 → 渲染 → 落盘
 *
 * 用法（`--root` **必需**，且必须是「论文结果所在的模块」）：
 *   node scripts/graph-export.mjs --src .probe-nse --root Euler.Solution --root NavierStokes.ComparatorSolution
 *   node scripts/graph-export.mjs --src .probe-nse --root Euler.Solution --cone-depth 13 --name Euler.Solution.depth13
 *   node scripts/graph-export.mjs --src .probe-nse --root Euler.Solution --cone-depth 13 --layering bfs --name Euler.Solution.bfs
 *   node scripts/graph-export.mjs --src .probe-nse --root Euler.Solution --no-collapse   # 折叠前对照
 *   node scripts/graph-export.mjs --src .probe-nse --root Euler.Solution --chain-min 5 --small-lines 50
 *   node scripts/graph-export.mjs --src .probe-nse --root Euler.Solution --outline-out out/outline --merge-below 5
 *
 * ⚠️ 顶层聚合文件 `Euler` / `NavierStokes` 只有一行 import，**不是正确的根**：
 *    拿它当根会得到语义错误的产物（而且它会掩盖真正的定理所在模块）。
 *    正确的根取自 formalization.yaml 的 `main_results[].file` / `alignment.statements[].module`。
 *
 * 产物（附录 G.5）：
 *   out/graph/<root>.svg    自包含 SVG（零脚本，浏览器直接打开）
 *   out/graph/<root>.html   极简包装：标题 + 图例 + 内联 SVG（零脚本）
 *
 * 扫描由 core-io 的 `src/io/lean-imports.mjs` 负责（附录 G.2 冻结签名）——本脚本**不自己实现扫描**。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { buildDepGraph, collapseGraph, mainLine, stationMembers } from '../src/core/depgraph.mjs'
import { renderDepGraphSvg, renderGraphHtml } from '../src/render/graph.mjs'
import { renderOutlineHtml, renderOutlinePointer, renderOutlineReadme, renderStationPage, stationFileName } from '../src/render/outline.mjs'

/** 解析 CLI：`--key value`（可重复）与 `--flag`。 */
function parseArgs(argv) {
  const out = { root: [], name: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    const value = next === undefined || next.startsWith('--') ? true : next
    if (value !== true) i += 1
    if (key === 'root') out.root.push(String(value))
    else if (key === 'name') out.name.push(String(value))
    else out[key] = value
  }
  return out
}

/**
 * 解析根参数：**必须显式给出**。
 *
 * 为什么必需：脚本原先默认 `--root Euler`，于是任何一次无参运行都会重新生成
 * 「顶层 import 聚合文件」的产物——那个根语义是错的（`Euler.lean` 只有一行 import，
 * 真正的定理在 `Euler/Solution.lean`）。默认值会把错误静默地固化下来，所以改成必需。
 *
 * @param {{root?: string[]}} args `parseArgs` 的结果
 * @returns {string[]} 至少一个非空根名
 */
export function requireRoots(args) {
  const roots = Array.isArray(args?.root) ? args.root.filter((root) => typeof root === 'string' && root.trim() !== '') : []
  if (roots.length === 0) {
    throw new Error(
      [
        '必须显式指定 --root。根应当是「论文结果所在的模块」，取自 formalization.yaml 的',
        'main_results[].file / alignment.statements[].module，例如：',
        '  --root Euler.Solution',
        '  --root NavierStokes.ComparatorSolution',
        '（顶层聚合文件 Euler / NavierStokes 只有一行 import，不是正确的根。）',
      ].join('\n'),
    )
  }
  return roots
}

/**
 * 「这个根看起来像一行的纯 import 聚合文件吗」——只警告、不阻断
 * （万一有人就是想看它）。判据：没有作者说明，且声明数为 0。
 *
 * @param {{lines?: number, decls?: number}|undefined} stats 该根的 `readModuleSizes` 结果
 * @param {string|undefined} docstring 该根的模块说明
 * @returns {string|null} 警告文字（不警告则为 null）
 */
export function aggregatorWarning(stats, docstring) {
  const decls = stats?.decls ?? 0
  const hasDoc = typeof docstring === 'string' && docstring.trim() !== ''
  if (decls > 0 || hasDoc) return null
  return '这个根没有任何声明、也没有作者说明，看起来是**一行的 import 聚合文件**；'
    + '真正的根应当是论文结果所在的模块（例如 --root Euler.Solution）。仍按你的要求继续。'
}

const args = parseArgs(process.argv.slice(2))
// `--root` 是第一道闸：缺了就在**扫描之前**退出，绝不落盘、也绝不留下半成品
let roots
try {
  roots = requireRoots(args)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
const srcDir = path.resolve(String(args.src ?? '.probe-nse'))
const outDir = path.resolve(String(args.out ?? 'out/graph'))
const coneDepth = args['cone-depth'] === undefined ? null : Number(args['cone-depth'])
const maxNodes = args['max-nodes'] === undefined ? null : Number(args['max-nodes'])
const layering = args.layering === 'bfs' ? 'bfs' : 'longest'
const collapse = args.collapse !== false && args['no-collapse'] !== true // 默认开启折叠（G.4b）
const chainMin = args['chain-min'] === undefined ? undefined : Number(args['chain-min'])
const smallLines = args['small-lines'] === undefined ? undefined : Number(args['small-lines'])
const clusterFamilies = args['no-families'] !== true

/**
 * 读每个模块的**作者说明**（模块文档注释 `/-- … -/`，取文件里第一段）。
 * 这是 scripts/ 的职责（core 是纯函数不做 I/O）。若 `scanLeanImports` 已经返回 `docstrings`
 * （task-11），优先用它的——那时这里就只是回退路径。
 */
async function readModuleDocstrings(rootDir, modules) {
  const docstrings = {}
  for (const module of modules) {
    const file = path.join(rootDir, `${module.split('.').join(path.sep)}.lean`)
    try {
      const text = await readFile(file, 'utf8')
      const match = /\/--([\s\S]*?)-\//.exec(text)
      if (match) docstrings[module] = match[1].replace(/\s+/g, ' ').trim()
    } catch {
      // 读不到就当作「没有说明」——渲染层会如实写「（无模块说明）」，不许编
    }
  }
  return docstrings
}

/**
 * 读每个模块的行数与声明数（附录 G.4b：`opts.sizes` 由调用方注入，core 不做 I/O）。
 * 这是 scripts/ 的职责，不受 L1–L5 约束。
 */
async function readModuleSizes(rootDir, modules) {
  const sizes = {}
  for (const module of modules) {
    const file = path.join(rootDir, `${module.split('.').join(path.sep)}.lean`)
    try {
      const text = await readFile(file, 'utf8')
      sizes[module] = { lines: text.split('\n').length, decls: countDecls(text), namespaces: namespaceSpans(text) }
    } catch {
      // 读不到就不注入：折叠会把这个模块当成「行数未知」，不参与小模块聚类
    }
  }
  return sizes
}

const DECL_RE = /^(?:@\[[^\]]*\]\s*)?(?:private\s+|protected\s+|noncomputable\s+|partial\s+|unsafe\s+)*(theorem|lemma|def|structure|instance|abbrev|opaque|inductive|class)\b/gm

function countDecls(text) {
  return (text.match(DECL_RE) ?? []).length
}

/**
 * 按 `namespace X … end X`（含嵌套）统计每个命名空间占的行数与声明数。
 * 单体巨石文件靠这个展开成「容器 + 子项」——**行数与声明数都在文件里，不需要额外 I/O**。
 */
function namespaceSpans(text) {
  const lines = text.split('\n')
  const stack = []
  const spans = new Map()
  let current = null
  for (const line of lines) {
    const open = /^\s*namespace\s+([A-Za-z0-9_.'«»]+)\s*$/.exec(line)
    if (open) {
      const name = current === null ? open[1] : `${current.name}.${open[1]}`
      const node = { name, lines: 0, decls: 0, parent: current }
      stack.push(node)
      current = node
      if (!spans.has(name)) spans.set(name, node)
      continue
    }
    if (/^\s*end(\s+[A-Za-z0-9_.'«»]+)?\s*$/.test(line) && stack.length > 0) {
      stack.pop()
      current = stack.length > 0 ? stack[stack.length - 1] : null
      continue
    }
    if (current !== null) {
      current.lines += 1
      if (DECL_RE.test(line)) {
        DECL_RE.lastIndex = 0
        current.decls += 1
      }
    }
  }
  return [...spans.values()]
    .map((node) => ({ name: node.name, lines: node.lines, decls: node.decls }))
    .sort((a, b) => b.lines - a.lines || (a.name < b.name ? -1 : 1))
}
const names = args.name
const outlineEnabled = args.outline === true || args['outline-out'] !== undefined
const outlineOut = args['outline-out'] === undefined ? 'out/outline' : String(args['outline-out'])
const mergeBelow = args['merge-below'] === undefined ? 0 : Number(args['merge-below'])
// 大纲阅读方向：reading = 论文序（默认，最基础的在前、定理在最后）；dependency = 依赖序（定理在前）
const outlineOrder = args.order === 'dependency' ? 'dependency' : 'reading'

let scanLeanImports
try {
  // 静态 import 在模块缺失时报错很难懂，这里给一句能照着做的提示
  ;({ scanLeanImports } = await import('../src/io/lean-imports.mjs'))
} catch (error) {
  if (error?.code === 'ERR_MODULE_NOT_FOUND') {
    console.error(
      '[graph-export] 缺少 src/io/lean-imports.mjs（附录 G.2 的 scanLeanImports，由 core-io 的 task-8 交付）。\n'
        + '等它落盘后本脚本即可直接运行；在那之前可用 out/verify/graph/scan-harness.mjs 的口径做对照。',
    )
    process.exit(2)
  }
  throw error
}

const scanned = await scanLeanImports(srcDir)
console.log(
  `[graph-export] 扫描 ${srcDir}：${scanned.stats.fileCount} 个 .lean，`
    + `项目内边 ${scanned.stats.internalEdges}，外部边 ${scanned.stats.externalEdges}`,
)

const sizes = collapse ? await readModuleSizes(srcDir, scanned.modules) : {}
// 防线：根看起来像一行的纯 import 聚合文件时警告（不阻断——万一有人就是想看它）
for (const root of roots) {
  const warning = aggregatorWarning(sizes[root], scanned.docstrings?.[root])
  if (warning !== null) console.log(`[graph-export] ⚠️  ${root}：${warning}`)
}
const outlineEntries = []
// 模块说明：task-11 落盘后优先用 scanLeanImports 的 docstrings，否则本地读模块文档注释
const docstrings = scanned.docstrings && typeof scanned.docstrings === 'object'
  ? scanned.docstrings
  : await readModuleDocstrings(srcDir, scanned.modules)
const knownLines = Object.keys(sizes).length
if (collapse) console.log(`[graph-export] 行数已读：${knownLines} 个模块（用于小模块聚类；core 侧是纯函数，不做 I/O）`)

await mkdir(outDir, { recursive: true })
for (const [index, root] of roots.entries()) {
  const raw = buildDepGraph(scanned, {
    rootId: root,
    ...(coneDepth === null ? {} : { coneDepth }),
    ...(maxNodes === null ? {} : { maxNodes }),
    layering,
  })
  const folded = collapse
    ? collapseGraph(raw, {
        sizes,
        ...(chainMin === undefined ? {} : { chainMinLength: chainMin }),
        ...(smallLines === undefined ? {} : { smallLineThreshold: smallLines }),
        clusterFamilies,
      })
    : null
  const graph = folded ?? raw
  if (folded) {
    console.log(
      `[graph-export] 折叠：${raw.stats.nodeCount} → ${folded.stats.nodeCount} 节点`
        + `（折叠节点 ${folded.stats.collapsedNodeCount} / 吸收 ${folded.stats.absorbedNodeCount}）｜`
        + `链 ${folded.foldStats.chainCount} 条（最长 ${folded.foldStats.longestChain}，平均 ${folded.foldStats.averageChainLength.toFixed(2)}）｜`
        + `聚类 ${folded.foldStats.clusteredNodeCount} 组（吸收 ${folded.foldStats.clusteredMemberCount} 模块）`,
    )
  }
  const base = names[index] ?? root
  // 截断样本必须在标题里说清楚自己是样本，不能看起来像主产物
  const title = graph.stats.truncated ? `dependency cone of ${root} (truncated sample)` : `dependency cone of ${root}`
  const subtitle = `${graph.stats.nodeCount} modules · ${graph.layerWidths.length} columns · ${graph.stats.edgeCount} dependency edges`
  const truncationNote = graph.stats.truncated ? `本图是截断样本（H5）：${graph.stats.truncatedReason}` : ''
  const svg = renderDepGraphSvg(graph, { rootId: root, title })
  const html = renderGraphHtml(svg, { title, subtitle, ...(truncationNote === '' ? {} : { truncationNote }) })
  const svgPath = path.join(outDir, `${base}.svg`)
  const htmlPath = path.join(outDir, `${base}.html`)
  await writeFile(svgPath, svg)
  await writeFile(htmlPath, html)
  console.log(
    `[graph-export] ${root}：${graph.stats.nodeCount} 节点 / ${graph.layerWidths.length} 列 / `
      + `${graph.stats.edgeCount} 边 / 最大列宽 ${graph.stats.maxWidth}`
      + `${graph.stats.truncated ? `｜已截断：${graph.stats.truncatedReason}` : '｜未截断'}`,
  )
  console.log(`[graph-export]   → ${svgPath}（${svg.length} B）`)
  console.log(`[graph-export]   → ${htmlPath}（${html.length} B）`)

  // ── 主线大纲（附录 G.6）：一站一行，从上往下读就是主线顺序 ──
  if (outlineEnabled) {
    const outline = mainLine(raw, { rootId: root, sizes })
    outlineEntries.push({ root, outline, moduleStats: sizes })
    const outlineHtml = renderOutlineHtml(outline, {
      docstrings,
      mergeBelow: 0,
      title: `${root} — main-line outline${outlineOrder === 'reading' ? ' (reading order)' : ' (dependency order)'}`,
      docstringSource: scanned.docstrings ? 'scanLeanImports 的 docstrings' : '模块文档注释（/-- … -/）',
      tieBreak: outline.tieBreak,
      order: outlineOrder,
      moduleStats: sizes,
      stationHref: (displayIndex) => stationFileName(displayIndex),
      enhance: true, // 只有大纲主页带 JS 增强；依赖序/合并版对照与站点页保持零脚本
    })
    await mkdir(path.resolve(outlineOut), { recursive: true })
    // ── 每站一页（附录 G.6b）：out/outline/<root>/{index.html, NN.html, README.md} ──
    const rootDir = path.join(path.resolve(outlineOut), base)
    await mkdir(rootDir, { recursive: true })
    const perStation = stationMembers(raw, outline)
    const reading = outlineOrder === 'reading' ? [...outline.stations].reverse() : [...outline.stations]
    for (const [at, entry] of reading.entries()) {
      const displayIndex = at + 1
      const data = perStation.find((item) => item.stationId === entry.id)
      const page = renderStationPage(outline, data ?? { stationId: entry.id, index: entry.index, members: [], totalMembers: 0 }, {
        docstrings,
        displayIndex,
        outlineHref: 'index.html',
        moduleStats: sizes,
        prev: at > 0 ? { index: at, id: reading[at - 1].id, file: stationFileName(at) } : null,
        next: at + 1 < reading.length ? { index: at + 2, id: reading[at + 1].id, file: stationFileName(at + 2) } : null,
      })
      await writeFile(path.join(rootDir, stationFileName(displayIndex)), page)
    }
    const totalMemberSum = perStation.reduce((sum, item) => sum + item.totalMembers, 0)
    console.log(
      `[graph-export] 站点页：${reading.length} 页｜Σ 成员 ${totalMemberSum} === 锥 ${outline.totalModules}：`
        + `${totalMemberSum === outline.totalModules}｜互不重复：${new Set(perStation.flatMap((item) => item.members)).size === totalMemberSum}`,
    )

    // index.html = **合并版**大纲：合并行用原生 <details> 展开出「每站一个小标题」，
    // 每个小标题链到它自己的 NN.html；JS 只加「全部展开/收起」与记忆状态。
    const added = outline.stations.map((station) => station.addedCount)
    const sorted = [...added].sort((a, b) => a - b)
    const medianAdded = sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)]
    const indexMerge = mergeBelow > 0 ? mergeBelow : Math.max(0, medianAdded - 1)
    const indexHtml = renderOutlineHtml(outline, {
      docstrings,
      mergeBelow: indexMerge,
      title: `${root} — main-line outline`,
      docstringSource: scanned.docstrings ? 'scanLeanImports 的 docstrings' : '模块文档注释（/-- … -/）',
      tieBreak: outline.tieBreak,
      order: outlineOrder,
      moduleStats: sizes,
      stationHref: (displayIndex) => stationFileName(displayIndex),
      enhance: true, // 只有它带 JS 增强；站点页与对照产物保持零脚本
    })
    await writeFile(path.join(rootDir, 'index.html'), indexHtml)
    const indexEntry = outlineEntries[outlineEntries.length - 1]
    if (indexEntry !== undefined) {
      indexEntry.mergedRows = (indexHtml.match(/class="a4m-outline__row"/g) ?? []).length
      indexEntry.mergeBelow = indexMerge
    }
    // 该 root 自己的 README（附录 G.6b 的布局要求：披露与口径跟产物在一起）
    await writeFile(
      path.join(rootDir, 'README.md'),
      renderOutlineReadme([outlineEntries[outlineEntries.length - 1]], { generatedBy: `见 out/outline/README.md（本目录 ${base}/ 的产物）` }),
    )
    console.log(
      `[graph-export] 主线：${outline.stations.length} 站｜中位数 ${medianAdded}`
        + `｜最大 ${Math.max(...added)}（${outline.stations[added.indexOf(Math.max(...added))].id}）`
        + `｜为 0 的站 ${added.filter((value) => value === 0).length}`
        + `｜Σ ${outline.coveredModules} === 总数 ${outline.totalModules}：${outline.coveredModules === outline.totalModules}`
        + `｜并列规则 ${outline.tieBreak}`,
    )
    console.log(`[graph-export]   → ${path.join(rootDir, 'index.html')}（合并版 mergeBelow=${indexMerge}：${(indexHtml.match(/class="a4m-outline__row"/g) ?? []).length} 行，${indexHtml.length} B，原生 details + JS 增强）`)
    console.log(`[graph-export]   → ${path.join(rootDir, 'NN.html')} × ${reading.length}（每站一页，零脚本）`)

    // 平铺文件保留为**指针页**：不复制内容（两份会漂移），老路径照样可达
    const pointer = renderOutlinePointer(
      `${root} 主线大纲`,
      `${base}/index.html`,
      `Moved into ${base}/: index.html (expand combined rows in place, open one page per step) + NN.html (one page per step) + README.md.`,
    )
    await writeFile(path.join(path.resolve(outlineOut), `${base}.html`), pointer)
    console.log(`[graph-export]   → ${path.join(path.resolve(outlineOut), `${base}.html`)}（指针页 → ${base}/index.html，${pointer.length} B）`)
    const mergedPointer = renderOutlinePointer(
      `${root} 主线大纲（合并版）`,
      `${base}/index.html`,
      `The combined view is now ${base}/index.html (combined rows expand into their steps in place).`,
    )
    await writeFile(path.join(path.resolve(outlineOut), `${base}.merged.html`), mergedPointer)
    console.log(`[graph-export]   → ${path.join(path.resolve(outlineOut), `${base}.merged.html`)}（指针页 → ${base}/index.html，${mergedPointer.length} B）`)

    // 另一方向也出一份，供对照（默认产物是论文序）
    const otherOrder = outlineOrder === 'reading' ? 'dependency' : 'reading'
    const otherHtml = renderOutlineHtml(outline, {
      docstrings,
      mergeBelow: 0,
      title: `${root} — main-line outline (${otherOrder === 'reading' ? 'reading order' : 'dependency order'})`,
      docstringSource: scanned.docstrings ? 'scanLeanImports 的 docstrings' : '模块文档注释（/-- … -/）',
      tieBreak: outline.tieBreak,
      order: otherOrder,
      moduleStats: sizes,
    })
    await writeFile(path.join(path.resolve(outlineOut), `${base}.${otherOrder}.html`), otherHtml)
    console.log(`[graph-export]   → ${path.join(path.resolve(outlineOut), `${base}.${otherOrder}.html`)}（对照：${otherOrder === 'reading' ? '论文序' : '依赖序'}，零脚本，${otherHtml.length} B）`)
  }

  // 折叠时另出一份**未折叠**对照（附录 G.4b 验收：折叠前 / 折叠后各一份）
  if (folded) {
    const rawTitle = `${root} 的依赖锥（未折叠对照）`
    const rawSvg = renderDepGraphSvg(raw, { rootId: root, title: rawTitle })
    const rawHtml = renderGraphHtml(rawSvg, {
      title: rawTitle,
      subtitle: `${raw.stats.nodeCount} modules · ${raw.layerWidths.length} columns · ${raw.stats.edgeCount} dependency edges`,
    })
    await writeFile(path.join(outDir, `${base}.unfolded.svg`), rawSvg)
    await writeFile(path.join(outDir, `${base}.unfolded.html`), rawHtml)
    console.log(`[graph-export]   → ${path.join(outDir, `${base}.unfolded.svg`)}（折叠前对照，${rawSvg.length} B）`)
  }
}

// ── README：把页面上的记账搬到 out/outline/README.md（H5：披露只搬家，不删除）──
if (outlineEnabled && outlineEntries.length > 0) {
  const readme = renderOutlineReadme(outlineEntries, {
    generatedBy: `node scripts/graph-export.mjs --src ${path.relative(process.cwd(), srcDir)} --root ${outlineEntries.map((entry) => entry.root).join(' --root ')} --outline-out ${path.relative(process.cwd(), path.resolve(outlineOut))}`,
  })
  const readmePath = path.join(path.resolve(outlineOut), 'README.md')
  await writeFile(readmePath, readme)
  console.log(`[graph-export]   → ${readmePath}（${readme.length} B，口径与统计）`)
}
