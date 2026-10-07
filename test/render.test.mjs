/**
 * render.test.mjs — 渲染层（src/render/**）与后三个工具的契约测试
 *
 * 覆盖：
 *   - 双向锚点 D5：节点 `#a4m-n-<id>` ⇄ 注解 `#a4m-a-<id>` 两个方向都有 <a href>
 *   - 文档内不存在悬空锚点（每个 href="#x" 都有对应 id）
 *   - SPEC §1.4 命名：类名 `a4m-` 前缀 + BEM、元素 id、data-a4m-* 属性齐全
 *   - V6 直觉层过滤由 CSS 属性选择器实现，页面不含 <script>
 *   - coverage.degraded 可见（H5）、指标 null ≠ 0（H2）、H4 未校准提示
 *   - 纯字符串 / 确定性 / 分层 L1（不 import fs、不碰 DOM）
 *   - 工具层静态契约：annotate_submit 复用 validateAnnotations（不写第二份校验）
 *
 * 运行：cd ai4math && node --test test/render.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  EVIDENCE,
  PRECISE_EVIDENCE,
  ROLE,
  ROLE_ORDER,
  SEGMENT_KIND,
  VALUE_TYPE,
  HEIGHT,
  SIGNIFICANCE,
  PRESENTATION,
  AUDIENCE,
  NODE_KIND,
} from '../src/core/enums.mjs'
import { resolvableLexiconNames } from '../src/io/lexicon-resolve.mjs'
import { CSS_FILENAME, KATEX_CSS_FILENAME, VENDOR_ASSETS, css, DISPLAY_LINE_BUDGET, LAYOUT } from '../src/render/assets.mjs'
import { renderAssets, renderLedgerHtml } from '../src/render/html.mjs'
import { insertBinderCommas, leanToLatex, renderMath, renderProse } from '../src/render/lean-math.mjs'

// ── 夹具 ─────────────────────────────────────────────────────────────

/** 验收要求的形状：1 个根节点 + 1 个 have 节点 + 2 条注解，其中一条 evidence=formal。 */
function fixture() {
  return {
    specVersion: '1.0.0',
    mathlibBaseline: 'v4.28.0-rc1',
    theorem: 'Mathlib.Algebra.Group.Even.add',
    skeleton: {
      theorem: 'Mathlib.Algebra.Group.Even.add',
      root: 'n0',
      nodes: {
        n0: {
          id: 'n0',
          decl: 'Mathlib.Algebra.Group.Even.add',
          kind: NODE_KIND.THEOREM,
          signature: 'Even a → Even b → Even (a + b)',
          typeFingerprint: 'sha256:aaa',
          hypotheses: ['ha : Even a', 'hb : Even b'],
          parent: null,
          lemmaRefs: ['Even.add'],
          source: 'lsv2',
          truncated: false,
        },
        n1: {
          id: 'n1',
          decl: null,
          kind: NODE_KIND.HAVE,
          signature: 'h : Even (a + b) := Even.add ha hb',
          typeFingerprint: 'sha256:bbb',
          hypotheses: [],
          parent: 'n0',
          lemmaRefs: ['Even.add'],
          source: 'lsv2',
          truncated: true,
        },
      },
      coverage: { mode: 'tactic-multiline', haveCount: 1, nodeCount: 2, degraded: false, degradeReason: null },
    },
    annotations: [
      {
        id: 'a1',
        node: 'n0',
        role: ROLE.CORE_IDEA,
        height: HEIGHT.BIRD,
        evidence: EVIDENCE.INTUITION,
        significance: SIGNIFICANCE.MAIN,
        presentation: PRESENTATION.PARAPHRASE,
        audience: AUDIENCE.GRAD_MATH,
        segments: [{ kind: SEGMENT_KIND.REASONING, text: '偶数集合对加法封闭，这就是全部内容。' }],
        anchors: [{ kind: 'goal', target: 'n0' }],
        refs: [],
        provenance: { model: 'deepseek-flash', ts: '2026-10-07T22:00:00+08:00', run: 'pilot-01' },
      },
      {
        id: 'a7',
        node: 'n1',
        role: ROLE.STEP,
        valueType: VALUE_TYPE.TECHNIQUE,
        culture: 'problem',
        height: HEIGHT.FROG,
        evidence: EVIDENCE.FORMAL,
        significance: SIGNIFICANCE.MAIN,
        presentation: PRESENTATION.PARAPHRASE,
        audience: AUDIENCE.GRAD_MATH,
        segments: [
          { kind: SEGMENT_KIND.CONCEPT, text: 'Even.add 直接给出闭包。', lexiconRef: 'Even.add' },
          { kind: SEGMENT_KIND.REASONING, text: '这一步是纯技术操作，一句话说完。' },
        ],
        anchors: [{ kind: 'goal', target: 'n1' }, { kind: 'decl', target: 'Mathlib.Algebra.Group.Even.add' }],
        refs: ['a1'],
        provenance: { model: 'deepseek-flash', ts: '2026-10-07T22:05:00+08:00', run: 'pilot-01' },
      },
    ],
    metrics: { nodeCount: 2, annotatedNodeCount: 2, mainCoverage: 1, anchorPrecision: 1, conceptCoverage: null },
    provenance: { run: 'pilot-01', created: '2026-10-07T22:10:00+08:00' },
  }
}

const HTML = renderLedgerHtml(fixture())

/** 取出某个 id 的顶层元素（渲染器不产生同名嵌套块）。 */
function elementById(html, id) {
  const pattern = new RegExp(`<(section|article)[^>]*id="${id}"[^>]*>[\\s\\S]*?</\\1>`)
  const match = pattern.exec(html)
  assert.ok(match, `HTML 中找不到 id="${id}" 的元素`)
  return match[0]
}

/** 只取**我们自己**的 class token：KaTeX 渲染出来的 `katex` / `mrel` 等是它的内部类，
 *  SPEC §1.5 的 a4m- 前缀约束管的是我们的标记，不是 vendored 库的输出。 */
function ownClassTokens(html) {
  const clean = html.replace(/<style>[\s\S]*?<\/style>/gi, '')
  const stack = []
  const tokens = []
  const voidTags = ['br', 'img', 'input', 'meta', 'link', 'hr']
  const tagPattern = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g
  let match
  while ((match = tagPattern.exec(clean)) !== null) {
    const tag = match[2].toLowerCase()
    if (match[1] === '/') {
      stack.pop()
      continue
    }
    const classes = /class="([^"]*)"/.exec(match[3] ?? '')?.[1] ?? ''
    const inKatex = /(^|\s)katex/.test(classes) || stack.some((ancestor) => /(^|\s)katex/.test(ancestor))
    if (!inKatex && classes !== '') tokens.push(...classes.split(/\s+/).filter(Boolean))
    if (!voidTags.includes(tag) && !/\/$/.test(match[3] ?? '')) stack.push(classes)
  }
  return tokens
}

function allClassTokens(html) {
  return [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean)
}

/**
 * 整页**可见文本**：跳过内联 `<style>`/`<script>`、KaTeX 隐藏的 MathML 与折叠的 Lean 源。
 * 断言「读者看得见什么」时必须用它——内联样式里的注释也是页面文本。
 */
function pageText(html) {
  // `<style>` / `<script>` 是原始文本块，先整块剥掉（里面的注释也算页面文本，
  // 但它们的 `<` 会让朴素扫描错位——例如 CSS 注释里写过 a4m-n-<id>）。
  const clean = html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '')
  let out = ''
  const stack = []
  const voidTags = ['br', 'img', 'input', 'meta', 'link', 'hr']
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>|([^<]+)/g
  let m
  while ((m = re.exec(clean)) !== null) {
    if (m[4] !== undefined) {
      const cls = stack.map((s) => s.cls).join(' ')
      if (!/katex-mathml/.test(cls) && !/a4m-lean__pre/.test(cls)) {
        out += m[4].replace(/[\u200b\u200c\u200d\ufeff]/g, '')
      }
      continue
    }
    if (m[1] === '/') { stack.pop(); continue }
    const tag = m[2].toLowerCase()
    if (voidTags.includes(tag)) continue
    stack.push({ tag, cls: /class="([^"]*)"/.exec(m[3] ?? '')?.[1] ?? '' })
  }
  return out
}

/** 取第 index 个 `a4m-equation__body` 的完整 HTML（配平扫描；懒惰正则会截断）。 */
function equationBody(html, index = 0) {
  const marker = '<span class="a4m-equation__body"'
  let at = -1
  for (let i = 0; i <= index; i += 1) at = html.indexOf(marker, at + 1)
  assert.ok(at >= 0, `找不到第 ${index} 个公式块`)
  const re = /<span\b[^>]*>|<\/span>/g
  re.lastIndex = at
  let depth = 0
  let m
  while ((m = re.exec(html)) !== null) {
    if (m[0] === '</span>') {
      depth -= 1
      if (depth === 0) return html.slice(at, re.lastIndex)
    } else depth += 1
  }
  throw new Error('公式块未配平')
}

/** 取该公式块内嵌的 TeX 原文（KaTeX 的 MathML annotation）。 */
function xTexOf(fragment) {
  const match = /<annotation encoding="application\/x-tex">([\s\S]*?)<\/annotation>/.exec(fragment)
  return match ? match[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : ''
}

/** 折了几行：KaTeX 在隐藏 MathML 里给每行一个 <mtr>（单行公式没有 mtable）。 */
function equationRows(fragment) {
  return (fragment.match(/<mtr>/g) ?? []).length
}

/** 取出覆盖率说明行的 class 与 data 属性（新版面里它是一行素净斜体说明）。 */
function coverageTag(html) {
  const match = /<p class="(a4m-coverage[^"]*)"([^>]*)>/.exec(html)
  assert.ok(match, 'HTML 中找不到覆盖率说明行')
  return { classes: match[1], attrs: match[2] }
}

// ── 基本形状 ─────────────────────────────────────────────────────────

test('render: 产出完整 HTML 文档，且不含任何脚本', () => {
  assert.ok(HTML.startsWith('<!DOCTYPE html>'))
  assert.match(HTML, /<html lang="zh-CN">/)
  assert.match(HTML, /<\/html>\s*$/)
  assert.match(HTML, /<meta charset="utf-8">/)
  assert.equal(/<script/i.test(HTML), false, '一期渲染不得包含脚本（V6 用 CSS 属性选择器）')
  assert.equal(/\son[a-z]+\s*=/i.test(HTML), false, '不得出现内联事件处理器')
  assert.equal(/javascript:/i.test(HTML), false)
})

test('render: 元素 id 与 data-a4m-* 均为 SPEC §1.4 形式', () => {
  assert.ok(HTML.includes('id="a4m-n-0"'), '节点 n0 的 id 应为 a4m-n-0')
  assert.ok(HTML.includes('id="a4m-n-1"'), '节点 n1 的 id 应为 a4m-n-1')
  assert.ok(HTML.includes('id="a4m-a-1"'), '注解 a1 的 id 应为 a4m-a-1')
  assert.ok(HTML.includes('id="a4m-a-7"'), '注解 a7 的 id 应为 a4m-a-7')
  assert.ok(HTML.includes('data-a4m-node="n0"'))
  assert.ok(HTML.includes('data-a4m-anno="a1"'))
  assert.ok(HTML.includes('data-a4m-anno="a7"'))
  assert.match(HTML, /data-a4m-layer="[a-z-]+"/)
})

test('render: 契约要求的 data-a4m-* 属性齐全', () => {
  const article = elementById(HTML, 'a4m-a-7')
  for (const expected of [
    'data-a4m-role="step"',
    'data-a4m-evidence="formal"',
    'data-a4m-value-type="technique"',
    'data-a4m-height="frog"',
    'data-a4m-significance="main"',
    'data-a4m-presentation="paraphrase"',
    'data-a4m-audience="grad-math"',
    'data-a4m-culture="problem"',
  ]) {
    assert.ok(article.includes(expected), `注解 a7 缺 ${expected}`)
  }
  const conceptSeg = /<p class="a4m-anno__seg a4m-anno__seg--concept"[^>]*data-a4m-lexicon="Even\.add"[^>]*>/.exec(HTML)
  assert.ok(conceptSeg, 'concept 段必须带 data-a4m-lexicon')
  assert.ok(HTML.includes('data-a4m-seg-kind="reasoning"'))
  assert.ok(HTML.includes('data-a4m-kind="have"'))
})

test('render: concept 段的 lexicon_ref 可辨识；缺 lexicon_ref 时显式告警（V10）', () => {
  assert.ok(HTML.includes('a4m-anno__seg--concept'))
  assert.ok(HTML.includes('a4m-anno__lex'))
  assert.match(HTML, /词典：Even\.add/)

  const broken = fixture()
  broken.annotations[1].segments[0].lexiconRef = undefined
  const html = renderLedgerHtml(broken)
  assert.ok(html.includes('a4m-anno__lex--missing'), '缺 lexicon_ref 必须显式标注，不得静默')
})

// ── 双向锚点（D5 硬要求）─────────────────────────────────────────────

test('D5: 步骤用公式编号跳到注解；定理级注解的导航由目录承担', () => {
  const n1 = elementById(HTML, 'a4m-n-1')
  assert.match(n1, /<a class="a4m-equation__ref" href="#a4m-a-7"/, '公式编号本身就是到注解的锚点')
  // 「参见」行已按裁定删除：目录条目直接指向该章的注解，所以 n0 的注解仍在导航里
  assert.equal(HTML.includes('参见'), false, '页面不该再有「参见」行')
  assert.match(HTML, /<a class="a4m-contents__link" href="#a4m-a-1"/, '目录必须直接指向摘要（核心想法）那条注解')
  // 反方向：章节标题链回它注解的节点（夹具本身没有章节级注解，补一条问题注解来验）
  const withChapter = fixture()
  withChapter.annotations = [
    ...withChapter.annotations,
    { ...withChapter.annotations[0], id: 'q1', role: ROLE.QUESTION, segments: [{ kind: SEGMENT_KIND.REASONING, text: '问什么？' }] },
  ]
  assert.match(renderLedgerHtml(withChapter), /<a class="a4m-section__ref" href="#a4m-n-0"/, '章节标题即注解→节点的回指')
})

test('D5: 每条注解都能跳回它锚定的节点（引出词即链接）', () => {
  const a1 = elementById(HTML, 'a4m-a-1')
  const a7 = elementById(HTML, 'a4m-a-7')
  assert.match(a1, /<a class="a4m-anno__lead" href="#a4m-n-0"[^>]*>摘要/, '摘要的引出词必须链接回定理')
  assert.match(a7, /<a class="a4m-anno__lead" href="#a4m-n-1"[^>]*>注 1\.1/, '注的引出词必须链接回它的公式')
})

test('D5: 文档内不存在悬空锚点', () => {
  const ids = new Set([...HTML.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))
  const hrefs = [...HTML.matchAll(/href="#([^"]+)"/g)].map((m) => m[1])
  assert.ok(hrefs.length >= 4, `至少应有 4 条内部链接，实际 ${hrefs.length}`)
  for (const href of hrefs) assert.ok(ids.has(href), `悬空锚点 #${href}`)
})

test('D5: 主锚点解析不出来时，decl 锚点兜底（V12 不静默丢弃）', () => {
  const ledger = fixture()
  const a7 = ledger.annotations.find((ann) => ann.id === 'a7')
  a7.node = 'n-不存在'
  a7.anchors = [
    { kind: 'goal', target: 'n-不存在' },
    { kind: 'decl', target: ledger.skeleton.nodes.n0.decl },
  ]
  const html = renderLedgerHtml(ledger)
  const a7Html = elementById(html, 'a4m-a-7')
  assert.equal(a7Html.includes('a4m-anno--orphan'), false, '有 decl 锚点兜底就不该标成 orphan')
  assert.match(a7Html, /<a class="a4m-anno__lead" href="#a4m-n-0"/, '回指目标应为 decl 解析出的 n0')
})

test('D5: 挂不到节点上的注解降级渲染，绝不静默丢弃', () => {
  const ledger = fixture()
  const a7 = ledger.annotations.find((ann) => ann.id === 'a7')
  a7.node = 'n-不存在'
  a7.anchors = []
  const html = renderLedgerHtml(ledger)
  const a7Html = elementById(html, 'a4m-a-7')
  assert.ok(a7Html.includes('a4m-anno--orphan'), '解析不出目标就标 orphan')
  assert.match(a7Html, /<span class="a4m-anno__lead">/, 'orphan 不产生悬空链接')
  assert.match(html, /其它注解/, '降级到「其它注解」章节照常渲染')
})

test('D5: 无注解的步骤照常渲染（不显示注解块，也不产生链接）', () => {
  const broken = fixture()
  broken.annotations = broken.annotations.filter((a) => a.node !== 'n1')
  const html = renderLedgerHtml(broken)
  const n1 = elementById(html, 'a4m-n-1')
  assert.equal(/class="a4m-anno/.test(n1), false, '没有注解就不该有注解块')
  assert.equal(/href="#a4m-a-/.test(n1), false, '也不该有指向注解的链接')
  assert.match(n1, /a4m-equation/, '公式本身照常渲染')
})

// ── 命名与版面 ───────────────────────────────────────────────────────

test('命名: 每个 class token 都是 a4m- 前缀且都在 CSS 中有定义', () => {
  const tokens = ownClassTokens(HTML)
  const katexOnly = allClassTokens(HTML).filter((t) => !tokens.includes(t))
  assert.ok(katexOnly.every((t) => t.startsWith('katex') || /^(m|vlist|pstrut|sizing|strut|base|accent|delimsizing|op|math)/.test(t)), '非 a4m 类只能来自 KaTeX 输出')
  assert.ok(tokens.length > 20)
  for (const token of tokens) assert.ok(token.startsWith('a4m-'), `类名缺 a4m- 前缀: ${token}`)
  const defined = new Set([...css().matchAll(/\.(a4m-[A-Za-z0-9_-]+)/g)].map((m) => m[1]))
  const missing = [...new Set(tokens)].filter((t) => !defined.has(t))
  assert.deepEqual(missing, [], `HTML 用到但 CSS 未定义的类名: ${missing.join(', ')}`)
})

test('命名: CSS 选择器只用 a4m- 前缀的类，不出现通用类名（SPEC §1.5）', () => {
  const stripped = css().replace(/\/\*[\s\S]*?\*\//g, '') // 注释里出现 `.css` 等文件名，不算选择器
  const selectors = [...stripped.matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/g)].map((m) => m[1])
  const offenders = [...new Set(selectors)].filter((s) => !s.startsWith('a4m-'))
  assert.deepEqual(offenders, [], `CSS 出现非 a4m- 类名: ${offenders.join(', ')}`)
})

test('版面: 单栏论文式（72ch 居中 + 衬线字体栈 + 无两栏）', () => {
  assert.match(HTML, /<article class="a4m-paper">/)
  const stylesheet = css()
  assert.match(
    stylesheet,
    new RegExp(`\\.a4m-paper\\s*\\{[^}]*max-width:\\s*${LAYOUT.COLUMN_CH}ch`),
    `正文容器必须与 LAYOUT.COLUMN_CH 一致（${LAYOUT.COLUMN_CH}ch）`,
  )
  assert.match(stylesheet, /Georgia/, '正文衬线字体栈缺 Georgia')
  assert.match(stylesheet, /Songti SC/, '中文需能落到宋体/思源宋体')
  assert.match(stylesheet, /line-height:\s*1\.7/, '正文行高 ~1.7')
  assert.equal(/grid-template-columns/.test(stylesheet), false, '论文版面是单栏，不得出现两栏网格')
  assert.match(stylesheet, /--a4m-mono/, 'Lean 陈述用等宽')
  // 论文学派：注解靠粗体 run-in 引出词 + 略小字号，不靠竖线/底色
  assert.match(stylesheet, /\.a4m-anno__lead\s*\{[^}]*font-weight:\s*700/, '引出词必须粗体')
  assert.match(stylesheet, /\.a4m-anno__seg\s*\{[^}]*font-size:\s*\.9\d*em/, '注解正文比正文小半号')
})

test('版面: 注解紧跟它所注解的陈述之后（不分组到别处）', () => {
  const n1 = elementById(HTML, 'a4m-n-1')
  const stmtIdx = n1.indexOf('a4m-equation__body')
  const annoIdx = n1.indexOf('id="a4m-a-7"')
  assert.ok(stmtIdx > 0 && annoIdx > 0, '公式与注解都要在同一块里')
  assert.ok(stmtIdx < annoIdx, '注解必须在公式之后')
  // 不该出现在别的小节里：全页只有一处 a7 的 id
  assert.equal((HTML.match(/id="a4m-a-7"/g) ?? []).length, 1)
  // 定理级 core_idea 进摘要，步骤注解进证明节
  const abstract = /<section class="a4m-abstract"[^>]*>[\s\S]*?<\/section>/.exec(HTML)?.[0] ?? ''
  assert.match(abstract, /id="a4m-a-1"/, 'core_idea 必须在摘要里')
})

test('版面: 章节按论文顺序渲染、编号连续，空小节不渲染', () => {
  const ledger = fixture()
  ledger.annotations = [
    ...ledger.annotations,
    { ...ledger.annotations[0], id: 'q1', role: ROLE.QUESTION, segments: [{ kind: SEGMENT_KIND.REASONING, text: '问什么？' }] },
    { ...ledger.annotations[0], id: 'b1', role: ROLE.BIRDVIEW, segments: [{ kind: SEGMENT_KIND.REASONING, text: '背景。' }] },
    { ...ledger.annotations[0], id: 'm1', role: ROLE.COMMENTARY, segments: [{ kind: SEGMENT_KIND.REASONING, text: '评注。' }] },
    { ...ledger.annotations[0], id: 'n1x', role: ROLE.NEGATIVE_SPACE, segments: [{ kind: SEGMENT_KIND.REASONING, text: '负空间。' }] },
  ]
  const html = renderLedgerHtml(ledger)
  assert.match(html, /<section class="a4m-abstract" id="a4m-sec-abstract"/, 'core_idea 进摘要（两侧缩进、无框）')
  assert.match(html, /<a class="a4m-anno__lead" href="#a4m-n-0"[^>]*>摘要（直觉，不可作推理前提）\.<\/a>/, '摘要靠 run-in 引出词')
  const ordered = [...html.matchAll(/data-a4m-section="([a-z_]+)">\s*<h2 class="a4m-section__title">(?:<a[^>]*>)?(\d+)\. ([^<（]+)/g)].map((m) => [m[1], m[2], m[3]])
  assert.deepEqual(ordered, [
    [ROLE.QUESTION, '1', '问题'],
    [ROLE.BIRDVIEW, '2', '背景'],
    [ROLE.STEP, '3', '定理与证明'],
    [ROLE.COMMENTARY, '4', '评注'],
    [ROLE.NEGATIVE_SPACE, '5', '负空间'],
  ])

  // 空小节不渲染：只有 core_idea 时，页面上没有「问题」小节
  const minimal = renderLedgerHtml(fixture())
  assert.equal(minimal.includes('问题</h2>'), false)
  assert.match(minimal, /<h2 class="a4m-section__title">1\. 定理与证明<\/h2>/, '空章不占编号')
})

test('版面: 步骤编号体现树的层级（公式编号 (1.1) / (1.1.2) / (1.1.2.1)）', () => {
  const ledger = fixture()
  // 造出 CHSH 的形状：n1 有子 n2/n3/n5，n3 有子 n4
  ledger.skeleton.nodes.n0 = { ...ledger.skeleton.nodes.n0 }
  ledger.skeleton.nodes.n1 = { ...ledger.skeleton.nodes.n1, parent: 'n0' }
  const mk = (id, parent, signature) => ({
    id, decl: null, kind: NODE_KIND.HAVE, signature, typeFingerprint: `sha256:${id}`,
    hypotheses: [], parent, lemmaRefs: [], source: 'lsv2', truncated: false,
  })
  ledger.skeleton.nodes.n2 = mk('n2', 'n1', '子目标 A')
  ledger.skeleton.nodes.n3 = mk('n3', 'n1', '子目标 B')
  ledger.skeleton.nodes.n4 = mk('n4', 'n3', '子目标 B.1')
  ledger.skeleton.nodes.n5 = mk('n5', 'n1', '子目标 C')
  ledger.skeleton.coverage.nodeCount = 6
  const steps = [...renderLedgerHtml(ledger).matchAll(/class="a4m-equation__no">(?:<a[^>]*>)?\(([^)]+)\)/g)].map((m) => m[1])
  assert.deepEqual(steps, ['1.1', '1.1.1', '1.1.2', '1.1.2.1', '1.1.3'], '嵌套层级体现在公式编号里')
  // 嵌套层级同时体现在缩进变量上
  const html = renderLedgerHtml(ledger)
  assert.match(html, /id="a4m-n-4"[^>]*data-a4m-depth="3"/, 'n4 在 n3 之下，深度应为 3')
})

test('版面: 正文按 segments[].kind 分段渲染', () => {
  const article = elementById(HTML, 'a4m-a-7')
  const segs = [...article.matchAll(/<p class="a4m-anno__seg a4m-anno__seg--([a-z-]+)"/g)].map((m) => m[1])
  assert.deepEqual(segs, [SEGMENT_KIND.CONCEPT, SEGMENT_KIND.REASONING])
})

// ── 显示规则：chip 太吵的三条修正 ────────────────────────────────────

test('括注: 不再有 chip 元素，恒定轴（presentation / audience）不进引出词', () => {
  assert.equal(HTML.includes('a4m-anno__tag'), false, 'chip 容器应当已被删除')
  assert.equal(HTML.includes('转述'), false)
  assert.equal(HTML.includes('数学研究生'), false)
  // 数据属性仍在（只改显示，不动契约）
  assert.ok(HTML.includes('data-a4m-presentation="paraphrase"'))
  assert.ok(HTML.includes('data-a4m-audience="grad-math"'))
  assert.ok(HTML.includes('data-a4m-significance="main"'))

  // 多值也不做成色块：presentation / audience 变成多值后仍不进括注
  const multi = fixture()
  multi.annotations[1].presentation = PRESENTATION.EXACT
  multi.annotations[0].audience = AUDIENCE.HIGHSCHOOL_STRONG
  const html = renderLedgerHtml(multi)
  assert.equal(html.includes('a4m-anno__tag'), false)
  assert.equal(/（[^）]*(原样|高中有基础者)/.test(html), false, '恒定/多值轴都不进引出词')
  assert.ok(html.includes('data-a4m-presentation="exact"'), '数据属性照常保留')
})

test('括注: evidence 只在不可作推理前提时出现，height 只在偏离默认值时出现', () => {
  // 夹具：a1 是 intuition（不可作推理前提）→ 警示；a7 是 formal（常态）→ 不出现
  assert.match(elementById(HTML, 'a4m-a-1'), /摘要（直觉，不可作推理前提）\./, 'intuition 必须给出警示括注')
  assert.equal(/（[^）]*形式化/.test(elementById(HTML, 'a4m-a-7')), false, 'formal 是常态，不进引出词')
  assert.equal(/鸟瞰|蛙眼/.test(HTML), false, 'height 与 role 默认值一致，不出现')
  assert.match(elementById(HTML, 'a4m-a-7'), /注 1\.1（技巧）\./, 'value_type 在步骤注解上始终出现')

  // 偏离默认值：给 step 写鸟瞰级注解（ROLE_DEFAULT_HEIGHT[step]=frog）→ 括注出现
  const ledger = fixture()
  ledger.annotations[1].height = HEIGHT.BIRD
  const html = renderLedgerHtml(ledger)
  assert.match(html, /注 1\.1（技巧，鸟瞰）\./)
  assert.ok(html.includes('data-a4m-height="bird"'), '数据属性照常保留')
})

test('页脚: 只有一行出处（run + Mathlib 基线），无指标 / 无本地路径 / 无 spec_version', () => {
  const html = renderLedgerHtml(fixture())
  const foot = /<footer class="a4m-paper__foot">([\s\S]*?)<\/footer>/.exec(html)?.[0] ?? ''
  const text = foot.replace(/<[^>]+>/g, '').trim()
  assert.equal(text.split('\n').filter((line) => line.trim() !== '').length, 1, `页脚应只有一行，实际 ${JSON.stringify(text)}`)
  assert.match(text, /^由 dsh-scholia 生成 · run=pilot-01 · Mathlib v4\.28\.0-rc1$/, `页脚可见文本，实际 ${JSON.stringify(text)}`)
  // 判据数据、本地路径、机器契约都不给读者看
  for (const forbidden of ['main 覆盖率', 'out/ledger', 'spec_version', '锚点有效率', '节点数']) {
    assert.equal(html.includes(forbidden), false, `页面不该出现「${forbidden}」`)
  }
})

// ── v1.3 陈述未知（`have h := 项` 类型标注被省略，SPEC §2.1b）──────────

/** 造一个含「无类型 have」的账本：n1 未知、n2 正常，便于对照。 */
function unknownSignatureFixture() {
  const ledger = fixture()
  ledger.specVersion = '1.3.0'
  ledger.skeleton.coverage.signatureMissingCount = 1
  ledger.skeleton.nodes.n1 = {
    ...ledger.skeleton.nodes.n1,
    signature: '',
    signatureUnknown: true,
    rawText: 'have h := exists_global_inviscid_gevrey_PDE period hq T hT',
    localName: 'h',
    typeFingerprint: null,
  }
  ledger.skeleton.nodes.n2 = {
    id: 'n2', decl: null, kind: NODE_KIND.HAVE,
    signature: 'h2 : Even (a + b) := Even.add ha hb',
    typeFingerprint: 'sha256:ccc',
    hypotheses: [], parent: 'n0', lemmaRefs: [], source: 'lsv2', truncated: false,
  }
  ledger.annotations = [
    ledger.annotations[0],
    { ...ledger.annotations[1], id: 's1', node: 'n1', valueType: VALUE_TYPE.NONE },
    { ...ledger.annotations[1], id: 's2', node: 'n2', valueType: VALUE_TYPE.STRUCTURAL },
  ]
  return ledger
}

test('v1.3: 陈述未知的步骤不编号、不空白，原文照 Lean 源块款式呈现', () => {
  const ledger = unknownSignatureFixture()
  const html = renderLedgerHtml(ledger)
  const n1 = elementById(html, 'a4m-n-1')
  assert.match(n1, /data-a4m-signature-unknown="true"/, '机器可读标记')
  assert.equal(n1.includes('a4m-equation__no'), false, '没有公式可编号，就不该出现编号')
  assert.match(n1, /本步的陈述在形式化源码中省略（由 Lean 推断），这里只呈现其定义：/, '给读者一句话，不是空白')
  assert.match(n1, /<pre class="a4m-unknown__raw">have h := exists_global_inviscid_gevrey_PDE period hq T hT<\/pre>/, '原文原样呈现')
  const text = pageText(n1)
  assert.ok(text.includes('本步的陈述在形式化源码中省略'), '可见文本里有说明')
  assert.ok(text.includes('have h := exists_global'), '可见文本里有原文')
  assert.match(n1, /<a class="a4m-anno__lead" href="#a4m-n-1"[^>]*>注（无可提炼的思路）\.<\/a>/, '引出词不带编号但仍回指该步')
})

test('v1.3: 有陈述的步骤照旧编号（未回归），且不误标 signature-unknown', () => {
  const html = renderLedgerHtml(unknownSignatureFixture())
  const n2 = elementById(html, 'a4m-n-2')
  assert.match(n2, /a4m-equation__no/, '正常步骤仍有公式编号')
  assert.match(n2, /注 1\.2（结构说明）\./, '正常步骤的引出词仍带编号')
  assert.equal(/data-a4m-signature-unknown/.test(n2), false, '正常步骤不该带未知标记')
})

test('v1.3: 目录里未知步骤用「陈述省略」，不引用不存在的公式号', () => {
  const html = renderLedgerHtml(unknownSignatureFixture())
  assert.match(html, /href="#a4m-a-s1"><span class="a4m-contents__label">注 h<\/span><span class="a4m-contents__page">陈述省略</, '未知步：给局部名 + 陈述省略')
  assert.match(html, /href="#a4m-a-s2"><span class="a4m-contents__label">注 1\.2<\/span><span class="a4m-contents__page">式 \(1\.2\)</, '正常步照旧')
})

test('v1.3: 原文缺失时也如实说明（不假装、不空着）', () => {
  const ledger = unknownSignatureFixture()
  ledger.skeleton.nodes.n1.rawText = null
  const n1 = elementById(renderLedgerHtml(ledger), 'a4m-n-1')
  assert.match(n1, /本步的陈述在形式化源码中省略/)
  assert.match(n1, /（该项原文未随骨架提供。）/)
})

test('v1.3: 定理陈述本身未知时同样处理（不渲染空公式）', () => {
  const ledger = unknownSignatureFixture()
  ledger.skeleton.nodes.n0.signature = ''
  ledger.skeleton.nodes.n0.signatureUnknown = true
  ledger.skeleton.nodes.n0.rawText = 'theorem demo : True := trivial'
  const html = renderLedgerHtml(ledger)
  const n0 = elementById(html, 'a4m-n-0')
  assert.match(n0, /data-a4m-signature-unknown="true"/)
  assert.match(n0, /<pre class="a4m-unknown__raw">theorem demo : True := trivial<\/pre>/)
  assert.equal(/<details class="a4m-lean">/.test(n0), false, '没有签名就没有 Lean 源块可折叠')
})

// ── 读者页面 vs 模型诊断 / 论文排印细节 ──────────────────────────────

test('P1-a: 退化/截断说明只写给读者，模型向诊断不进可见文本', () => {
  const ledger = fixture()
  ledger.skeleton.nodes.n0.truncated = true
  ledger.skeleton.nodes.n1.truncated = true
  ledger.skeleton.coverage = {
    mode: 'failed', haveCount: 0, nodeCount: 2,
    degraded: true,
    degradeReason: '证明体为空，无法建树（definition / inductive 等记录通常没有 value）；请改用能提供证明体的定理记录',
    truncated: true, truncateReason: 'value 长度达到 500 字符上限',
  }
  const html = renderLedgerHtml(ledger)
  const text = pageText(html)
  assert.match(text, /本定理没有可解析的证明步骤，下面只给出定理陈述与整体注解。/, '退化只给一句面向读者的话')
  assert.match(text, /记录截断（数据集 500 字符上限）：以下步骤来自已解析出的部分，覆盖可能不完整。/)
  for (const forbidden of ['have_count', 'mode=', 'degradeReason', 'truncateReason', '请改用', 'value）']) {
    assert.equal(text.includes(forbidden), false, `可见文本不该出现「${forbidden}」`)
  }
  // 诊断没有丢：留在 data 属性里（机器可读），只是不给读者看
  assert.ok(html.includes('data-a4m-degrade-reason="证明体为空'), '退化原因仍在 data 属性')
  assert.ok(html.includes('data-a4m-mode="failed"'), 'mode 仍是机器可读属性')
})

test('P1-b: 不再单独列「前提」一行（定理陈述已经完整）', () => {
  assert.equal(pageText(HTML).includes('前提：'), false, '页面上不该出现「前提：」')
  assert.equal(HTML.includes('a4m-theorem__hyps'), false, '前提行已删除')
})

test('P1-c: 没有渲染出步骤就不印 ∎；有步骤才印', () => {
  const rootOnly = fixture()
  rootOnly.skeleton.nodes = { n0: rootOnly.skeleton.nodes.n0 }
  rootOnly.annotations = rootOnly.annotations.filter((ann) => ann.node === 'n0')
  const noSteps = renderLedgerHtml(rootOnly)
  assert.equal(pageText(noSteps).includes('∎'), false, '没有证明就不该有「证明结束」的断言')
  assert.equal(pageText(noSteps).includes('证明.'), false, '也不该有证明引导词')
  assert.equal(pageText(HTML).includes('∎'), true, '有步骤时 ∎ 仍在')
  assert.equal((pageText(HTML).match(/∎/g) ?? []).length, 1, '整篇只有一个证毕符号')
})

test('排版: 栏宽 / 公式缩放 / 折行预算同源（改一个数三处一起变）', () => {
  const stylesheet = css()
  assert.match(stylesheet, new RegExp(`max-width:\\s*${LAYOUT.COLUMN_CH}ch`), '栏宽用 LAYOUT.COLUMN_CH')
  assert.match(
    stylesheet,
    new RegExp(`\\.a4m-equation__body\\s*\\{[^}]*font-size:\\s*${LAYOUT.FORMULA_SCALE}em`),
    '独立公式缩放用 LAYOUT.FORMULA_SCALE',
  )
  assert.match(stylesheet, new RegExp(`margin-inline:\\s*-${LAYOUT.FORMULA_BLEED_CH}ch`), '公式外扩用 LAYOUT.FORMULA_BLEED_CH')
  // 折行预算必须是这三个数推出来的（不是手写魔数）
  const expected = Math.floor(
    ((LAYOUT.COLUMN_CH + 2 * LAYOUT.FORMULA_BLEED_CH) * LAYOUT.BODY_CH_EM) / (LAYOUT.MATH_CHAR_EM * LAYOUT.FORMULA_SCALE),
  )
  assert.equal(DISPLAY_LINE_BUDGET, expected, `折行预算应由 LAYOUT 推出，实际 ${DISPLAY_LINE_BUDGET}，应为 ${expected}`)
  // 行内公式不缩放：`.a4m-math`（renderProse 用）不得有 font-size
  assert.equal(/\.a4m-math\s*\{[^}]*font-size/.test(stylesheet), false, '行内公式不得缩放，否则与正文基线打架')
})

test('P2: 长公式折行（行首无空白、有 & 对齐点），结尾不丢', () => {
  const ledger = fixture()
  ledger.skeleton.nodes.n0.signature =
    '[CommRing R] [PartialOrder R] [StarRing R] [StarOrderedRing R] [Algebra ℝ R] [IsOrderedModule ℝ R] (A₀ A₁ B₀ B₁ : R)\n  (T : IsCHSHTuple A₀ A₁ B₀ B₁) : A₀ * B₀ + A₀ * B₁ + A₁ * B₀ - A₁ * B₁ ≤ 2'
  const html = renderLedgerHtml(ledger)
  const body = html.slice(html.indexOf('<body'))
  const stmt = equationBody(body)
  const rows = equationRows(stmt)
  assert.ok(rows >= 2, `长公式应折成多行（aligned），实际 ${rows} 行`)
  const tex = xTexOf(stmt)
  for (const line of tex.split('\\\\')) {
    assert.equal(/^\s/.test(line.replace(/^\\begin\{aligned\}/, '')), false, `每行行首不得有空白: ${JSON.stringify(line.slice(0, 30))}`)
  }
  assert.match(tex, /\\begin\{aligned\}&/, '每行要有 & 对齐点，续行才在同一左边界')
  assert.equal(body.includes('class="a4m-equation a4m-equation--wide"'), false, '应当折得下，不许退化成横向滚动')
  const text = visualLayer(stmt).text
  assert.ok(/≤\s*2$/.test(text), `结尾不得被裁掉，实际 ${JSON.stringify(text.slice(-20))}`)
})

test('P2: 中等长度的公式装得下就不折（Even.add 形状 → 单行）', () => {
  const ledger = fixture()
  ledger.skeleton.nodes.n1.signature = '∀ {α : Type u_2} [inst : AddCommSemigroup α] {a b : α}, Even a → Even b → Even (a + b)'
  const html = renderLedgerHtml(ledger)
  const body = html.slice(html.indexOf('<body'))
  const stmt = equationBody(body)
  assert.equal(equationRows(stmt), 0, '装得下就不该出现 aligned 多行结构')
  const text = visualLayer(stmt).text
  assert.ok(text.endsWith('Even (a+b)'), `单行也要完整，实际 ${JSON.stringify(text.slice(-20))}`)
})

test('P2: 源里带换行的长签名照样折行，不得退化成横向滚动（CHSH 实签名）', () => {
  // 这条签名本身就带 Lean 打印器选好的换行——那是正确的断点，不能被吃掉
  const ledger = fixture()
  ledger.skeleton.nodes.n0.signature =
    '[CommRing R] [PartialOrder R] [StarRing R] [StarOrderedRing R] [Algebra ℝ R] [IsOrderedModule ℝ R] (A₀ A₁ B₀ B₁ : R)\n  (T : IsCHSHTuple A₀ A₁ B₀ B₁) : A₀ * B₀ + A₀ * B₁ + A₁ * B₀ - A₁ * B₁ ≤ 2'
  const html = renderLedgerHtml(ledger)
  const body = html.slice(html.indexOf('<body'))
  const stmt = equationBody(body)
  assert.ok(equationRows(stmt) >= 2, `长公式必须折行，实际 ${equationRows(stmt)} 行`)
  assert.equal(body.includes('class="a4m-equation a4m-equation--wide"'), false, '这条应当折得下，不许退化成横向滚动')
  assert.equal(body.includes('公式较宽'), false)
  const text = visualLayer(stmt).text
  assert.ok(text.includes('≤'), '内容不得丢')
  assert.ok(/≤\s*2$/.test(text), `结尾应落在 ≤ 2，实际 ${JSON.stringify(text.slice(-20))}`)
})

test('Lean 源: 给读者一句可复制提示（黑板体字形复制会失真）', () => {
  const html = renderLedgerHtml(fixture())
  assert.match(
    html,
    /<summary class="a4m-lean__summary"><span class="a4m-lean__label">Lean 源<\/span>（可直接复制；[^）]*黑板体/,
    '展开前就能看到「可直接复制」',
  )
  assert.match(html, /复制会丢失黑板体/)
  // 素净：提示不引入任何装饰（全表零 border/background/radius/shadow 已由减法测试钉住）
  assert.equal(/class="a4m-lean__summary"[^>]*(style|border|background)=/.test(html), false)
})

test('P2: 没有断点的超宽公式才退化成横向滚动，并给可见提示', () => {
  const ledger = fixture()
  // 一个断点都没有、单块就超过折行预算的超长标识符（> DISPLAY_LINE_BUDGET 个源字符）
  ledger.skeleton.nodes.n0.signature = `SomeVeryLongIdentifierWithoutAnyRelationSymbolAtAll${'JustLetters'.repeat(9)}`
  const html = renderLedgerHtml(ledger)
  const body = html.slice(html.indexOf('<body'))
  assert.match(body, /class="a4m-equation a4m-equation--wide"/, '折不了才允许滚动')
  assert.match(pageText(html), /公式较宽，本行可横向滚动查看完整内容。/, '必须给可见提示，不能让读者以为公式就到这里')
})

test('P3: 定理引出词与声明名之间有真实空格', () => {
  const html = renderLedgerHtml(fixture())
  assert.match(
    html,
    /<span class="a4m-theorem__label">定理 1\.1\.<\/span> <span class="a4m-theorem__decl">/,
    '两者之间必须是真实的空格字符，不是只靠 CSS 间距',
  )
  assert.ok(pageText(html).includes('定理 1.1. Mathlib.Algebra.Group.Even.add'), '复制出来不该粘在一起')
})

// ── 版面减法：论文只允许字号/字重/斜体/小型大写/居中缩进/留白 ──────────

test('减法: 样式表里零 border / background / border-radius / box-shadow', () => {
  const stylesheet = css()
  for (const device of ['border', 'background', 'border-radius', 'box-shadow']) {
    assert.equal(stylesheet.includes(device), false, `论文版面不得出现 ${device}`)
  }
  // 视觉手段仍在：全大写标题、小型大写副行/章标题、斜体、粗体引出词、居中
  assert.match(stylesheet, /\.a4m-paper__title\s*\{[^}]*text-transform:\s*uppercase/)
  assert.match(stylesheet, /font-variant:\s*small-caps/)
  assert.match(stylesheet, /\.a4m-proof-lead\s*\{[^}]*font-style:\s*italic/)
  assert.match(stylesheet, /\.a4m-section__title\s*\{[^}]*text-align:\s*center/)
})

test('减法: 页面里没有角标 / 跳转按钮 / chip 元素', () => {
  assert.equal(HTML.includes('a4m-node__mark'), false, '导航角标已删除（改由目录承担）')
  assert.equal(HTML.includes('a4m-anno__jump'), false, '↩ 跳转按钮已删除')
  assert.equal(HTML.includes('a4m-anno__tag'), false, 'chip 容器已删除')
  assert.equal(HTML.includes('a4m-anno--inline'), false, '卡片式注解容器已删除')
  assert.equal(HTML.includes('a4m-anno__back'), false, '回指按钮已删除（回指改由引出词承担）')
})

test('目录: 列章标题与注解条目，条目可点跳转', () => {
  const html = renderLedgerHtml(fixture())
  assert.match(html, /<nav class="a4m-contents" id="a4m-contents">/)
  assert.match(html, /<h2 class="a4m-contents__title">目录<\/h2>/)
  const links = [...html.matchAll(/<a class="a4m-contents__link" href="#([^"]+)"/g)].map((m) => m[1])
  assert.ok(links.length >= 3, `目录条目应覆盖摘要 / 章 / 注，实际 ${links.length}`)
  assert.ok(links.includes('a4m-a-1'), '摘要条目直接指向摘要那条注解')
  assert.ok(links.includes('a4m-sec-step'), '证明章条目')
  assert.ok(links.includes('a4m-a-7'), '步骤注解条目（可跳到那条注）')
  // 目录里的目标都是页面里真实存在的 id
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))
  for (const link of links) assert.ok(ids.has(link), `目录指向不存在的 id: ${link}`)
})

test('公式编号: 编号是到注解的锚点，注的引出词回指公式（零额外视觉成本）', () => {
  const n1 = elementById(HTML, 'a4m-n-1')
  assert.match(n1, /<span class="a4m-equation__no"><a class="a4m-equation__ref" href="#a4m-a-7"/, '编号即锚点')
  assert.match(elementById(HTML, 'a4m-a-7'), /<a class="a4m-anno__lead" href="#a4m-n-1"/, '注的引出词回指公式')
  // 公式居中 + 编号右对齐（论文的公式编号排版）
  const stylesheet = css()
  assert.match(stylesheet, /\.a4m-equation\s*\{[^}]*text-align:\s*center/)
  assert.match(stylesheet, /\.a4m-equation__no\s*\{[^}]*position:\s*absolute[^}]*right:\s*0/)
})

// ── 诚实性与退化（这些性质与版面无关，必须一直成立）───────────────────

test('H5: 退化骨架必须可见并给出 degrade_reason（素净斜体说明，不是色块）', () => {
  const broken = fixture()
  broken.skeleton.coverage = { mode: 'term', haveCount: 0, nodeCount: 1, degraded: true, degradeReason: 'term-mode 证明体无 have 结构', truncated: false, truncateReason: null }
  const html = renderLedgerHtml(broken)
  assert.ok(html.includes('data-a4m-degraded="true"'))
  assert.match(html, /本定理没有可解析的证明步骤，下面只给出定理陈述与整体注解。/, '读者看到一句面向读者的话')
  assert.ok(html.includes('data-a4m-degrade-reason="term-mode 证明体无 have 结构"'), '技术诊断留在 data 属性里，不静默丢弃')
  assert.equal(html.includes('a4m-coverage--degraded'), false, '退化改用素净说明，不再有修饰类')
})

test('task-5: 截断与结构退化分开说明，截断不误报为退化', () => {
  const truncatedOnly = fixture()
  truncatedOnly.skeleton.coverage = {
    mode: 'tactic-multiline', haveCount: 1, nodeCount: 2,
    degraded: false, degradeReason: null,
    truncated: true, truncateReason: 'value 长度达到 500 字符上限',
  }
  const html = renderLedgerHtml(truncatedOnly)
  const banner = coverageTag(html)
  assert.match(banner.attrs, /data-a4m-truncated="true"/, '截断必须显式可见')
  assert.match(banner.attrs, /data-a4m-degraded="false"/, '只截断时 degraded 必须仍是 false')
  assert.match(html, /覆盖可能不完整/)

  const both = fixture()
  both.skeleton.coverage = { mode: 'term', haveCount: 0, nodeCount: 1, degraded: true, degradeReason: 'r', truncated: true, truncateReason: 't' }
  const bothHtml = renderLedgerHtml(both)
  assert.match(bothHtml, /本定理没有可解析的证明步骤/)
  assert.match(bothHtml, /记录截断/)
})

test('task-5: E-KIND 新增种类仍被识别（引导词用中文，节点带 data-a4m-kind）', () => {
  const ledger = fixture()
  ledger.skeleton.nodes.n1.kind = NODE_KIND.CLASS_INDUCTIVE
  ledger.skeleton.nodes.n0.kind = NODE_KIND.RECURSOR
  const html = renderLedgerHtml(ledger)
  assert.match(elementById(html, 'a4m-n-0'), /递归子 1\.1\./, '定理引导词用中文标签，不回落英文原值')
  assert.match(elementById(html, 'a4m-n-1'), /data-a4m-kind="class_inductive"/, '步骤块仍带枚举 kind')
})

test('H4: 页面显式声明注解未经真人校准（在页眉，页脚只留一行出处）', () => {
  assert.match(HTML, /未经真人校准/)
  assert.equal(/未做真人校准/.test(HTML), false)
})

test('H3: 记录被截断时页面显式标注（整条记录一次，不在每步重复）', () => {
  const ledger = fixture()
  ledger.skeleton.coverage = { ...ledger.skeleton.coverage, truncated: true, truncateReason: '数据集 500 字符上限' }
  ledger.skeleton.nodes.n0.truncated = true
  ledger.skeleton.nodes.n1.truncated = true
  const html = renderLedgerHtml(ledger)
  assert.match(html, /记录截断（数据集 500 字符上限）：以下步骤来自已解析出的部分，覆盖可能不完整/)
  assert.equal((html.match(/记录截断/g) ?? []).length, 1, '截断是整条记录的属性，只标注一次')
  assert.equal(/记录截断/.test(elementById(html, 'a4m-n-1')), false, '与定理级一致的步骤不再重复标注')
})

test('H2: 指标不上读者页面（null 与 0 都由账本 JSON 承担）', () => {
  const withNull = fixture()
  withNull.metrics = { nodeCount: 2, annotatedNodeCount: 2, mainCoverage: 1, anchorPrecision: 1, conceptCoverage: null }
  const withZero = fixture()
  withZero.metrics = { nodeCount: 0, annotatedNodeCount: 0, mainCoverage: 0, anchorPrecision: 0, conceptCoverage: 0 }
  for (const html of [renderLedgerHtml(withNull), renderLedgerHtml(withZero)]) {
    assert.equal(html.includes('未计算'), false, '页面上不该有指标读数')
    assert.equal(html.includes('main 覆盖率'), false)
    assert.equal(html.includes('锚点有效率'), false)
    assert.equal(html.includes('a4m-metrics'), false, '指标区块已从页面移除')
  }
})

test('退化情形: 只有根节点时版面仍成立（Even.add 形状）', () => {
  const rootOnly = {
    specVersion: '1.0.0', mathlibBaseline: 'v4.28.0-rc1', theorem: 'Even.add',
    skeleton: {
      theorem: 'Even.add', root: 'n0',
      nodes: { n0: { id: 'n0', decl: 'Even.add', kind: NODE_KIND.THEOREM, signature: '∀ {α : Type} [inst : AddCommSemigroup α], Even a → Even b → Even (a + b)', typeFingerprint: 'sha256:x', hypotheses: ['α', 'a', 'b'], parent: null, lemmaRefs: [], source: 'lsv2', truncated: false } },
      coverage: { mode: 'failed', haveCount: 0, nodeCount: 1, degraded: true, degradeReason: '证明体为空，无法建树', truncated: false, truncateReason: null },
    },
    annotations: [{ id: 'a1', node: 'n0', role: ROLE.CORE_IDEA, height: HEIGHT.BIRD, evidence: EVIDENCE.UNFOLDING, significance: SIGNIFICANCE.MAIN, presentation: PRESENTATION.EXACT, audience: AUDIENCE.GRAD_MATH, segments: [{ kind: SEGMENT_KIND.REASONING, text: '偶性是可加的谓词。' }], anchors: [{ kind: 'goal', target: 'n0' }], refs: [], provenance: { model: 'deepseek-flash', ts: 't', run: 'r' } }],
    metrics: { nodeCount: 1, annotatedNodeCount: 1, mainCoverage: 1, anchorPrecision: 1, conceptCoverage: null },
    provenance: { run: 'r', created: 't' },
  }
  const html = renderLedgerHtml(rootOnly)
  assert.match(html, /<h1 class="a4m-paper__title">Even\.add<\/h1>/, '标题是定理名')
  assert.match(css(), /\.a4m-paper__title\s*\{[^}]*text-transform:\s*uppercase/, '论文标题靠 CSS 全大写')
  assert.equal(/class="a4m-step"/.test(html), false, '没有中间节点就不该有步骤')
  assert.match(html, /a4m-note/, '退化必须在证明章里说明')
  assert.equal(pageText(html).includes('∎'), false, '没有步骤就不印证毕符号（P1-c）')
  assert.match(html, /data-a4m-degraded="true"/)
  assert.match(html, /id="a4m-n-0"/)
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))
  for (const m of html.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.has(m[1]), `悬空锚点 #${m[1]}`)
})

test('噪音: 截断/退化注记全页只出现一次（不每步重复）', () => {
  const countOf = (hay, needle) => hay.split(needle).length - 1

  // CHSH 形状：整条记录都被截断 → 只在定理级说一次
  const shared = fixture()
  shared.skeleton.nodes.n0.truncated = true
  shared.skeleton.nodes.n1.truncated = true
  shared.skeleton.coverage = { mode: 'tactic-multiline', haveCount: 1, nodeCount: 2, degraded: false, degradeReason: null, truncated: true, truncateReason: '数据集 500 字符上限' }
  const sharedHtml = renderLedgerHtml(shared)
  assert.equal(countOf(sharedHtml, '记录截断'), 1, '整条记录的截断属性只该说一次')
  assert.equal(countOf(sharedHtml, '<p class="a4m-coverage a4m-coverage--step'), 0, '与定理级一致的步骤不单独标注')

  // 某一步与定理级不一致 → 只有那一步单独标注
  const mixed = fixture()
  mixed.skeleton.nodes.n0.truncated = false
  mixed.skeleton.nodes.n1.truncated = true
  const mixedHtml = renderLedgerHtml(mixed)
  assert.equal(countOf(mixedHtml, '<p class="a4m-coverage a4m-coverage--step'), 1, '不一致的步骤才单独标注')
  assert.match(mixedHtml, /本步记录截断状态与定理级不一致/)

  // 退化：Even.add 形状 → 全页一次
  const rootOnly = fixture()
  rootOnly.skeleton.nodes = { n0: { ...rootOnly.skeleton.nodes.n0 } }
  rootOnly.skeleton.coverage = { mode: 'failed', haveCount: 0, nodeCount: 1, degraded: true, degradeReason: '证明体为空', truncated: false, truncateReason: null }
  rootOnly.annotations = rootOnly.annotations.filter((a) => a.node === 'n0')
  const rootHtml = renderLedgerHtml(rootOnly)
  assert.equal(countOf(rootHtml, '本定理没有可解析的证明步骤'), 1, '退化说明也只该说一次')
  assert.ok(rootHtml.includes('本定理没有可解析的证明步骤，下面只给出定理陈述与整体注解。'), '那一次要讲清影响范围')
})

// ── V6 直觉层（纯 CSS 属性选择器）────────────────────────────────────

test('V6: 直觉层过滤由 CSS 属性选择器实现，覆盖全部精确凭证', () => {
  const stylesheet = css()
  for (const evidence of PRECISE_EVIDENCE) {
    const rule = `[data-a4m-layer="intuition"] .a4m-anno[data-a4m-evidence="${evidence}"]`
    assert.ok(stylesheet.includes(rule), `CSS 缺 V6 规则: ${rule}`)
    const normalized = stylesheet.replace(/\s+/g, '')
    assert.ok(normalized.includes(`${rule.replace(/\s+/g, '')}{display:none;}`), `V6 规则必须是 display:none: ${rule}`)
  }
  assert.ok(stylesheet.includes('body:has(#a4m-layer-intuition:checked)'), '应提供无脚本开关')
  assert.ok(HTML.includes('[data-a4m-layer="intuition"] .a4m-anno[data-a4m-evidence="formal"]'), 'HTML 内联样式须含 V6 规则')
  assert.match(HTML, /<body data-a4m-layer="proof"/)
})

// ── 纯函数性质 ───────────────────────────────────────────────────────

test('render: 确定性（同一 Ledger 两次渲染完全相同）', () => {
  const ledger = fixture()
  assert.equal(renderLedgerHtml(ledger), renderLedgerHtml(ledger))
  assert.equal(css(), css())
})

test('render: 转义 HTML 特殊字符，不产生注入', () => {
  const evil = fixture()
  evil.theorem = '<img src=x onerror=alert(1)>'
  evil.annotations[0].segments = [{ kind: SEGMENT_KIND.REASONING, text: '<script>alert(1)</script> & "quotes"' }]
  const html = renderLedgerHtml(evil)
  assert.equal(html.includes('<img src=x'), false)
  assert.equal(html.includes('<script>alert(1)</script>'), false)
  assert.ok(html.includes('&lt;script&gt;'))
  assert.ok(html.includes('&amp;'))
})

test('render: 非 Ledger 输入抛出带修复动作的错误（T8）', () => {
  assert.throws(() => renderLedgerHtml(null), /annotate_submit/)
  assert.throws(() => renderLedgerHtml('x'), TypeError)
})

test('renderAssets: 返回 { a4m.css: <样式表> }', () => {
  const assets = renderAssets()
  assert.deepEqual(Object.keys(assets), [CSS_FILENAME])
  assert.equal(assets[CSS_FILENAME], css())
  assert.ok(assets[CSS_FILENAME].length > 1000)
})

test('math: leanToLatex 规则 A/B/C（多字母正体、空白保留、括号转义、单字母斜体）', () => {
  assert.equal(leanToLatex('CommRing R'), '\\mathrm{CommRing}\\ R')
  assert.equal(leanToLatex('Even'), '\\mathrm{Even}')
  assert.equal(leanToLatex('IsCHSHTuple'), '\\mathrm{IsCHSHTuple}')
  assert.equal(leanToLatex('R'), 'R')
  assert.equal(leanToLatex('a'), 'a')
  assert.equal(leanToLatex('A₀ * B₀ ≤ 2'), 'A_{0}\\cdot B_{0}\\le 2')
  assert.equal(leanToLatex('P • (P * P)'), 'P\\cdot (P\\cdot P)')
  assert.equal(leanToLatex('P ^ 2'), 'P^{2}')
  assert.equal(leanToLatex('{a b : α}'), '\\{a,\\ b:\\alpha \\}')  // 绑定组补逗号见下
  assert.equal(leanToLatex('[CommRing R]'), '[\\mathrm{CommRing}\\ R]')
  assert.equal(leanToLatex('ℝ → ℕ ≠ ∅'), '\\mathbb{R}\\to \\mathbb{N}\\ne \\emptyset')
  assert.equal(leanToLatex('x⁻¹'), 'x^{-1}')
  assert.equal(leanToLatex(''), '')
  assert.equal(leanToLatex(null), '')
})

// ── 视觉层断言：「读得对」，不是「用了 KaTeX」─────────────────────────

/**
 * 取 KaTeX 的**视觉层**（`katex-html`，页面上真正可见的那部分）纯文本与结构。
 * 之前的测试只断言 `class="katex"` 存在，所以「CommRing 被拆成 8 个斜体字母」这类
 * 排版错误一路漏到了成品——断言必须落在可见文本与可见结构上。
 */
function visualLayer(renderedHtml) {
  const match = /<span class="katex-html"[^>]*>([\s\S]*)<\/span><\/span>$/.exec(renderedHtml)
  const inner = match ? match[1] : renderedHtml
  // KaTeX 会留下零宽字符（U+200B，`\s` 不匹配它），断言「可见文本」时要一并去掉
  return { html: inner, text: inner.replace(/<[^>]+>/g, '').replace(/[\u200b\u200c\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim() }
}
/** Lean → 视觉层（渲染失败返回 null，让断言直接失败） */
function visualOfLean(lean) {
  const result = renderMath(leanToLatex(lean))
  return result.ok ? visualLayer(result.html) : null
}

test('排版: 多字母标识符排成正体，且与随后的变量不被粘住', () => {
  const v = visualOfLean('[CommRing R] [PartialOrder R] (A₀ A₁ B₀ B₁ : R) : A₀ * B₀ + A₁ * B₁ ≤ 2')
  assert.ok(v !== null, 'KaTeX 必须能渲染这条定理陈述')
  assert.ok(v.text.includes('CommRing R'), `可见文本应含 "CommRing R"，实际 ${JSON.stringify(v.text)}`)
  assert.equal(v.text.includes('[CommRingR]'), false, '标识符与变量不得粘住')
  assert.ok(v.text.includes('[PartialOrder R]'), `第二个结构名也要读得对，实际 ${JSON.stringify(v.text)}`)
  // 结构：CommRing 是**一个**正体组，而不是 8 个斜体字母
  assert.match(v.html, /class="mord mathrm"[^>]*>CommRing</, 'CommRing 必须是一个正体组')
  assert.equal(
    /class="mord mathnormal"[^>]*>C<\/span>[\s\S]{0,120}?class="mord mathnormal"[^>]*>o</.test(v.html),
    false,
    '不得把 CommRing 拆成逐字母斜体',
  )
})

test('排版: 花括号转义成字面量（不吞内容），单字母保持斜体变量', () => {
  const v = visualOfLean('∀ {α : Type u_2}, Even a → Even b')
  assert.ok(v !== null)
  assert.ok(v.text.includes('{α'), `花括号必须可见，实际 ${JSON.stringify(v.text)}`)
  assert.ok(v.text.includes('}'), '右花括号必须可见')
  // 反例：单字母不得被 \mathrm 化
  assert.equal(leanToLatex('R'), 'R')
  assert.equal(/\{R\}/.test(leanToLatex('CommRing R')), false, 'R 不得被包进正体')
  const single = visualOfLean('R')
  assert.match(single.html, /class="mord mathnormal"[^>]*>R</, '单字母 R 是斜体变量')
  assert.equal(/class="mord mathrm"[^>]*>R</.test(single.html), false, 'R 不得被排成正体')
  // 多字母与单字母同页时各自正确
  const mixed = visualOfLean('CommRing R')
  assert.match(mixed.html, /class="mord mathrm"[^>]*>CommRing</)
  assert.match(mixed.html, /class="mord mathnormal"[^>]*>R</)
})

test('排版: 步骤公式读得对（P⋅P=4⋅P，P 仍是斜体变量）', () => {
  const v = visualOfLean('P * P = 4 * P')
  assert.ok(v !== null)
  assert.equal(v.text.replace(/\s/g, ''), 'P⋅P=4⋅P', `实际 ${JSON.stringify(v.text)}`)
  assert.match(v.html, /class="mord mathnormal"[^>]*>P</, 'P 必须保持斜体变量')
  assert.equal(/class="mord mathrm"[^>]*>P</.test(v.html), false, 'P 不得被排成正体')
  const scaled = visualOfLean('P = (1 / 4 : ℝ) • (P * P)')
  assert.ok(scaled.text.includes('P=(1/4:'), `实际 ${JSON.stringify(scaled.text)}`)
  assert.match(scaled.html, /class="mord mathbb"[^>]*>R</, 'ℝ 用黑板体')
})

test('排版: 整页渲染后定理陈述与步骤的可见文本仍读得通', () => {
  const ledger = fixture()
  ledger.skeleton.nodes.n0.signature = '[CommRing R] (A₀ A₁ : R) : A₀ * A₁ ≤ 2'
  const html = renderLedgerHtml(ledger)
  const theorem = /<span class="a4m-equation__body" data-a4m-math="katex">([\s\S]*?)<\/span><\/div>/.exec(html)?.[1] ?? ''
  const v = visualLayer(theorem)
  assert.ok(v.text.includes('[CommRing R]'), `定理陈述的可见文本，实际 ${JSON.stringify(v.text)}`)
  assert.match(v.html, /class="mord mathrm"[^>]*>CommRing</)
  const step = /<span class="a4m-equation__body" data-a4m-math="katex">([\s\S]*?)<\/span><span class="a4m-equation__no">/.exec(html)?.[1] ?? ''
  const sv = visualLayer(step)
  assert.ok(sv.text.includes('Even (a+b)'), `步骤可见文本，实际 ${JSON.stringify(sv.text)}`)
  assert.ok(sv.text.includes('Even.add'), '限定名要读得出来')
  assert.equal((html.match(/<script/gi) ?? []).length, 0)
})

test('绑定组: 名字之间补逗号（≥2 个才加），类型部分不碰', () => {
  const cases = [
    ['(A₀ A₁ B₀ B₁ : R)', '(A_{0},\\ A_{1},\\ B_{0},\\ B_{1}:R)'],
    ['{a b : α}', '\\{a,\\ b:\\alpha \\}'],
    ['{α : Type u_2}', '\\{\\alpha :\\mathrm{Type}\\ u_{2}\\}'], // 单个名字：不动
    ['[inst : AddCommSemigroup α]', '[\\mathrm{inst}:\\mathrm{AddCommSemigroup}\\ \\alpha ]'], // 单个名字：不动
    ['(a b : α → β)', '(a,\\ b:\\alpha \\to \\beta )'], // `:` 之后不碰
    ['(f : (a b : α) → β)', '(f:(a,\\ b:\\alpha )\\to \\beta )'], // 嵌套：内层加、外层单名不加
  ]
  for (const [source, expected] of cases) {
    assert.equal(leanToLatex(source), expected, `输入 ${source}`)
  }
})

test('绑定组: 反例——应用 / := / 实例组都不得被加逗号', () => {
  // 应用：`IsCHSHTuple A₀ A₁ B₀ B₁` 的 arity 不可能从字符串判定，有意保持原样
  const applied = leanToLatex('(T : IsCHSHTuple A₀ A₁ B₀ B₁)')
  assert.equal(applied, '(T:\\mathrm{IsCHSHTuple}\\ A_{0}\\ A_{1}\\ B_{0}\\ B_{1})')
  assert.equal(applied.includes(','), false, '应用不加逗号（歧义有意保留）')
  for (const source of ['f a b', '{ x := 1 }', '(h : P) := by', '[CommRing R]', 'IsCHSHTuple A₀ A₁ B₀ B₁']) {
    assert.equal(leanToLatex(source).includes(','), false, `${source} 不该出现逗号`)
  }
  // `:=` 不是绑定冒号：结构体字面量里的字段不被当名字列表
  assert.equal(insertBinderCommas('{ x := 1, y := 2 }'), '{ x := 1, y := 2 }')
  assert.equal(insertBinderCommas('(h : P)'), '(h : P)')
  assert.equal(insertBinderCommas('(a b : α)'), '(a, b: α)')
})

test('绑定组: Lean 源折叠块保持逐字原样（读者永远能对照）', () => {
  const ledger = fixture()
  ledger.skeleton.nodes.n0.signature = '[CommRing R] (A₀ A₁ B₀ B₁ : R) (T : IsCHSHTuple A₀ A₁ B₀ B₁) : A₀ * B₀ ≤ 2'
  const html = renderLedgerHtml(ledger)
  const pre = /<pre class="a4m-lean__pre">([\s\S]*?)<\/pre>/.exec(html)?.[1] ?? ''
  assert.ok(pre.includes('(A₀ A₁ B₀ B₁ : R)'), '源码块必须是原文（无逗号）')
  assert.ok(pre.includes('(T : IsCHSHTuple A₀ A₁ B₀ B₁)'), '源码块逐字保留')
  assert.equal(pre.includes('A₀, A₁'), false, '渲染层的逗号不得写回源码块')
  // 而渲染出来的公式里有逗号
  assert.ok(xTexOf(equationBody(html.slice(html.indexOf('<body')))).includes('A_{0},\\ A_{1}'))
})

test('math: renderMath 失败不伪装（ok:false，不渲染成红色错误）', () => {
  const good = renderMath('0 \\le P')
  assert.equal(good.ok, true)
  assert.match(good.html, /class="katex"/)
  const display = renderMath('0 \\le P', { display: true })
  assert.equal(display.ok, true)
  assert.match(display.html, /katex-display/)
  const bad = renderMath('{')
  assert.equal(bad.ok, false, '不配对的括号必须 ok:false')
  assert.equal(bad.html, '', '失败时不得返回半成品 HTML')
  assert.ok(bad.error.length > 0)
  assert.equal(renderMath('   ').ok, false)
})

test('math: renderProse 渲染 $…$ 与 $$…$$，其余转义后原样输出', () => {
  const html = renderProse('设 $ r \\in R $ 是任意元素。')
  assert.match(html, /data-a4m-math="katex"/)
  assert.match(html, /class="katex"/)
  assert.ok(html.includes('设 '))
  assert.ok(html.includes('是任意元素。'))
  const display = renderProse('结论：$$\\frac{P}{4} = P$$')
  assert.match(display, /a4m-math--display/)
  // 词典来的是真 LaTeX（含命令），原样交给 KaTeX；模型写的是 Lean 记号（无反斜杠），先转换
  const latexProse = renderProse('设 $ r \\in R $ 任意')
  assert.match(latexProse, /data-a4m-math="katex"/)
  assert.ok(visualLayer(latexProse).text.includes('r∈R'), 'LaTeX 片段必须原样渲染（\in 不能被拆坏）')
  const leanProse = renderProse('验证 $0 ≤ P$ 与 $P * P = 4 * P$')
  assert.ok(visualLayer(leanProse).text.includes('0≤P'), 'Lean 记号要按 Lean 规则转换')
  assert.ok(visualLayer(leanProse).text.includes('P⋅P=4⋅P'), '`*` 必须排成 ⋅ 而不是裸星号')
  assert.equal(leanProse.includes('*'), false, '页面上不得留下裸 *')
  assert.equal(renderProse('普通文本 <b>').includes('<b>'), false, '非数学部分必须转义')
  assert.ok(renderProse('普通文本 <b>').includes('&lt;b&gt;'))
  // 数学坏掉时回退成等宽原文，不伪装
  const fallback = renderProse('坏公式 $ \\frac{ $ 结束')
  assert.match(fallback, /data-a4m-math="fallback"/)
  assert.match(fallback, /class="a4m-math-fallback"/)
})

test('math: 定理陈述与每个步骤都用 KaTeX 渲染（真实账本形状）', () => {
  const ledger = fixture()
  ledger.skeleton.nodes.n0.signature = '∀ {α : Type} [inst : AddCommSemigroup α], Even a → Even b → Even (a + b)'
  const html = renderLedgerHtml(ledger)
  assert.match(html, /<span class="a4m-equation__body" data-a4m-math="katex">\s*<span class="katex-display">/, '定理陈述用 display 模式 KaTeX')
  const n1 = elementById(html, 'a4m-n-1')
  assert.match(n1, /<span class="a4m-equation__body" data-a4m-math="katex">/, '步骤陈述用 KaTeX')
  assert.equal(/data-a4m-math="fallback"/.test(html), false, '正常输入不该回退')
  // 页面仍然零脚本
  assert.equal((html.match(/<script/gi) ?? []).length, 0)
})

test('math: 渲染不了时回退成等宽原文并标 data-a4m-math="fallback"', () => {
  // 原语层：真正非法的 LaTeX 一律 ok:false，不伪装成渲染成功
  assert.equal(renderMath('{').ok, false)
  assert.equal(renderMath('\\frac{').ok, false)

  // 集成层：模型写在评注里的行内数学出错（rule C 之后，Lean 签名里的花括号已被转义、
  // 不再是失败面；真实失败面是模型自己写的 $…$）
  const ledger = fixture()
  ledger.annotations[0].segments = [{ kind: SEGMENT_KIND.REASONING, text: '坏公式 $ \\frac{ $ 在这里。' }]
  const html = renderLedgerHtml(ledger)
  const a1 = elementById(html, 'a4m-a-1')
  assert.match(a1, /<code class="a4m-math-fallback" data-a4m-math="fallback">/, '回退成等宽原文')
  assert.equal(/data-a4m-math="katex"/.test(a1), false, '失败的那条不得同时出现 KaTeX 输出')
  // 一处失败不牵连同页其它位置（a7 是纯散文，不该被标成回退）
  assert.equal(/data-a4m-math="fallback"/.test(elementById(html, 'a4m-a-7')), false)
  assert.equal((html.match(/<script/gi) ?? []).length, 0)
})

test('math: Lean 源默认折叠（<details> 不带 open），并保留原文', () => {
  const html = renderLedgerHtml(fixture())
  const details = [...html.matchAll(/<details[^>]*>/g)].map((m) => m[0])
  assert.ok(details.length >= 1, '定理下应有 Lean 源折叠块')
  for (const tag of details) assert.equal(/\sopen[\s>]/.test(tag), false, '<details> 不得带 open')
  assert.match(html, /<summary class="a4m-lean__summary"><span class="a4m-lean__label">Lean 源<\/span>（可直接复制/)
  assert.match(html, /<pre class="a4m-lean__pre">Even a → Even b → Even \(a \+ b\)<\/pre>/, '折叠块里是原始 Lean')
})

test('math: KaTeX 资产清单指向 vendor 且字体保持 fonts/ 相对路径', () => {
  assert.equal(KATEX_CSS_FILENAME, 'katex.min.css')
  assert.ok(VENDOR_ASSETS.cssFiles.includes(KATEX_CSS_FILENAME))
  assert.equal(VENDOR_ASSETS.subdirs.fonts, 'fonts', 'katex.min.css 按 url(fonts/…) 相对引用')
  assert.deepEqual(VENDOR_ASSETS.extensions, ['.woff2'])
  assert.ok(VENDOR_ASSETS.keepInRepo.includes('LICENSE'), 'MIT 许可必须留在仓库里（不复制）')
  assert.equal(VENDOR_ASSETS.cssFiles.includes('LICENSE'), false, 'LICENSE 不复制到产物')
  assert.match(String(VENDOR_ASSETS.dirUrl), /vendor\/katex\/$/)
  // 页面外链 KaTeX 样式（内联会让 url(fonts/…) 找错目录）
  const html = renderLedgerHtml(fixture())
  assert.ok(html.includes(`href="assets/${KATEX_CSS_FILENAME}"`))
})

// ── 分层 L1 / 工具层静态契约 ─────────────────────────────────────────

const SRC = new URL('../src/', import.meta.url)
const TOOLS = new URL('../src/tools/', import.meta.url)

async function readSource(url) {
  return readFile(url, 'utf8')
}

test('L1: src/render/** 不 import fs/net/sqlite/fetch/@deepseek-ai，也不碰 DOM', async () => {
  for (const file of ['assets.mjs', 'html.mjs']) {
    const src = await readSource(new URL(`render/${file}`, SRC))
    assert.equal(/node:fs|node:net|node:sqlite|\bfetch\s*\(|@deepseek-ai\//.test(src), false, `${file} 违反 L1`)
    assert.equal(/\bdocument\b|\bwindow\b|HTMLElement|innerHTML/.test(src), false, `${file} 碰了 DOM`)
    assert.equal(/writeFile|mkdir|createWriteStream/.test(src), false, `${file} 做了 I/O`)
  }
})

test('L4: render 层的枚举值全部取自 src/core/enums.mjs', async () => {
  for (const file of ['assets.mjs', 'html.mjs']) {
    const src = await readSource(new URL(`render/${file}`, SRC))
    assert.match(src, /from '\.\.\/core\/enums\.mjs'/, `${file} 必须从 enums.mjs 取枚举`)
  }
})

test('tools: 三个注册函数按 INTERFACES §2.11 导出', async () => {
  const expected = [
    ['annotate-prepare.mjs', 'registerAnnotatePrepare'],
    ['annotate-submit.mjs', 'registerAnnotateSubmit'],
    ['ledger-export.mjs', 'registerLedgerExport'],
  ]
  for (const [file, fn] of expected) {
    const src = await readSource(new URL(file, TOOLS))
    assert.match(src, new RegExp(`export function ${fn}\\(ctx, config\\)`), `${file} 缺 ${fn}(ctx, config)`)
    assert.match(src, /ctx\.tools\.register\(/, `${file} 必须返回 ctx.tools.register 的 disposer`)
  }
})

test('tools: annotate_submit 复用 core/credential.mjs 的 validateAnnotations（禁止第二份校验）', async () => {
  const src = await readSource(new URL('annotate-submit.mjs', TOOLS))
  assert.match(src, /import\s*\{[^}]*validateAnnotations[^}]*\}\s*from\s*'\.\.\/core\/credential\.mjs'/)
  assert.equal(/function\s+validate(A|a)nnotations/.test(src), false, '不得自定义校验函数')
  assert.equal(/V\d+_[A-Z_]+\s*=/.test(src), false, '不得自定义规则码')
})

test('tools: annotate_submit 复用 io 层唯一的 V10 判定，且两遍校验共用同一份', async () => {
  const src = await readSource(new URL('annotate-submit.mjs', TOOLS))
  // 判定只有一个来源：io/lexicon-resolve.mjs（INTERFACES §2.5b）。工具里不得再有第二份。
  assert.match(src, /import\s*\{[^}]*resolvableLexiconNames[^}]*\}\s*from\s*'\.\.\/io\/lexicon-resolve\.mjs'/)
  assert.equal(/lookupLemma\s*\(/.test(src), false, '工具层不得自己查词典判定可解析性（判定归 io/lexicon-resolve.mjs）')
  assert.equal(/\bmissing\b/.test(src), false, '工具层不得自己比对 missing（判定归 io/lexicon-resolve.mjs）')
  assert.match(src, /SEGMENT_KIND\.CONCEPT/, '只收集 concept 段的 lexicon_ref')
  assert.match(src, /const lexicon = await resolveLexiconNames\(/, '解析结果必须复用给两遍校验')
  assert.equal(
    (src.match(/validateAnnotations\([^)]*lexiconNames: lexicon\.names/gs) ?? []).length,
    2,
    '第一遍（duplicates）与第二遍（将要写入的集合）都必须传同一份 lexiconNames',
  )
  assert.match(src, /词典索引不可用/, '词典不可用时必须失败，不得静默退化成弱化模式')
  assert.equal(/lexiconNames\s*[:=]\s*null\s*(,|\))/.test(src), false, '不得硬编码 null 绕过 V10 解析检查')
})

// ── V10 判定：行为测试（直接调 io 层唯一实现，不用源码正则挡形状）──────

/** 造一个只含一条 AbsConvex 的词典库（表结构与 index-db.mjs 的契约一致）。 */
async function lexiconFixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'a4m-lex-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const dbPath = path.join(dir, 'lexicon.db')
  const db = new DatabaseSync(dbPath)
  db.exec(
    'CREATE TABLE lemma(name TEXT PRIMARY KEY, module TEXT, kind TEXT, ' +
      'signature TEXT, informal_name TEXT, informal_description TEXT)',
  )
  db.prepare('INSERT INTO lemma VALUES (?,?,?,?,?,?)').run(
    'AbsConvex',
    'Mathlib.Analysis.Convex.Function',
    'def',
    'Convex s -> Convex (abs s)',
    'Absolutely Convex Set',
    '凸集的绝对值仍是凸集',
  )
  db.close()
  return { dbPath, dir }
}

test('V10 判定: 伪造 ref 必须不可解析（含首尾空格的绕过用例）', async (t) => {
  const { dbPath } = await lexiconFixture(t)
  const forged = resolvableLexiconNames(dbPath, ['Totally.Made.Up.Lemma'])
  assert.ok(forged instanceof Set)
  assert.equal(forged.has('Totally.Made.Up.Lemma'), false, '无空格伪造名不得被判为可解析')

  // 回归：lookupLemma 先 trim 再查、missing 存 trim 后的名字；
  // 若过滤时用原始串比对，" X " 会被当成命中 → core 的原样 has() 刚好放行 → V10 被绕过。
  const padded = resolvableLexiconNames(dbPath, [' Totally.Made.Up.Lemma '])
  assert.equal(padded.has(' Totally.Made.Up.Lemma '), false, '首尾空格的伪造名不得被判为可解析')
  assert.equal(padded.has('Totally.Made.Up.Lemma'), false)
  assert.equal(padded.size, 0)

  // 混合：伪造名不能因为同批里有真实名而被放过
  const mixed = resolvableLexiconNames(dbPath, ['AbsConvex', ' Totally.Made.Up.Lemma '])
  assert.equal(mixed.has('AbsConvex'), true)
  assert.equal(mixed.has(' Totally.Made.Up.Lemma '), false)
})

test('V10 判定: 真实 ref 的原始写法被保留（core 用原样 has() 匹配）', async (t) => {
  const { dbPath } = await lexiconFixture(t)
  for (const raw of ['AbsConvex', ' AbsConvex ', '_root_.AbsConvex', '`AbsConvex`']) {
    const names = resolvableLexiconNames(dbPath, [raw])
    assert.ok(names.has(raw), `${JSON.stringify(raw)} 应判为可解析（集合里保留原始串）`)
  }
})

test('V10 判定: 空 refs → null；索引不可用 → 抛错（不静默降级）', async (t) => {
  const { dbPath, dir } = await lexiconFixture(t)
  assert.equal(resolvableLexiconNames(dbPath, []), null, '空 refs 应返回 null，由调用方跳过查库')

  // 索引不存在：必须抛错，绝不能返回一个"什么都查不到/什么都能过"的集合
  assert.throws(
    () => resolvableLexiconNames(path.join(dir, 'no-such-lexicon.db'), ['AbsConvex']),
    (error) => error instanceof Error,
    '索引不可用时必须抛错',
  )
})

test('tools: annotate_prepare 把「陈述未知」如实交给模型（signature_unknown / raw_text / note）', async (t) => {
  const { registerAnnotatePrepare } = await import('../src/tools/annotate-prepare.mjs')
  const dir = await mkdtemp(path.join(os.tmpdir(), 'a4m-unknown-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(path.join(dir, 'skeleton'), { recursive: true })
  const rawText = 'have h := exists_global_inviscid_gevrey_PDE period hq T hT'
  const skeleton = {
    spec_version: '1.3.0',
    theorem: 'Demo.unknownHave',
    root: 'n0',
    nodes: {
      n0: { id: 'n0', decl: 'Demo.unknownHave', kind: NODE_KIND.THEOREM, signature: 'Demo : True', type_fingerprint: 'sha256:r', hypotheses: [], parent: null, lemma_refs: [], source: 'lsv2', truncated: false },
      n1: { id: 'n1', decl: null, kind: NODE_KIND.HAVE, signature: '', signature_unknown: true, raw_text: rawText, local_name: 'h', type_fingerprint: null, hypotheses: [], parent: 'n0', lemma_refs: [], source: 'lsv2', truncated: false },
    },
    coverage: { mode: 'tactic-multiline', have_count: 1, node_count: 2, truncated: false, truncate_reason: null, degraded: false, degrade_reason: null, signature_missing_count: 1 },
  }
  await writeFile(path.join(dir, 'skeleton', 'Demo.unknownHave.json'), JSON.stringify(skeleton))

  const registered = []
  const config = { corpusPath: path.join(dir, 'corpus.jsonl'), cacheDir: path.join(dir, 'cache'), outputDir: dir, maxEntries: 4, descriptionChars: 200, maxNodes: 20, maxDiagnostics: 10 }
  registerAnnotatePrepare({ tools: { register: (tool) => { registered.push(tool); return () => {} } } }, config)
  const out = await registered[0].execute({ theorem_name: 'Demo.unknownHave', scope: 'step', node_id: 'n1' }, { signal: AbortSignal.timeout(20000) })

  assert.equal(out.statement.signature_unknown, true, '必须把「陈述未知」告诉模型')
  assert.equal(out.statement.raw_text, rawText, '原文是陈述未知时唯一的材料')
  assert.equal(out.statement.local_name, 'h')
  assert.equal(out.statement.signature, null)
  assert.equal(out.statement.type_fingerprint, null, '类型指纹为 null，不是空串哈希')
  assert.match(out.statement.note, /类型标注在源码中省略/)
  assert.match(out.statement.note, /value_type: "none"/, '给模型「宁可如实填 none」的出路')
  assert.match(out.statement.note, /不要因此失败/, '不许因为信息不全就失败')

  // 有陈述的节点不带这些条件字段（条件字段按契约只在适用时出现）
  const normal = await registered[0].execute({ theorem_name: 'Demo.unknownHave', scope: 'theorem' }, { signal: AbortSignal.timeout(20000) })
  assert.equal('signature_unknown' in normal.statement, false, '陈述已知时整个键缺省')
  assert.equal('raw_text' in normal.statement, false)
  assert.equal('note' in normal.statement, false)
  assert.equal(normal.statement.signature, 'Demo : True')
  assert.equal(JSON.stringify(out.statement).includes('undefined'), false, '不得带 undefined 出门')
})

test('tools: annotate_prepare 内部绝不调用 LLM', async () => {
  const src = await readSource(new URL('annotate-prepare.mjs', TOOLS))
  assert.equal(/\bfetch\s*\(/.test(src), false)
  assert.equal(/@deepseek-ai\/(dsh-llm|dsh-agent)/.test(src), false)
  assert.equal(/chatCompletion|completions\.create|generateText/.test(src), false)
  assert.match(src, /constraints/, '必须输出 SPEC §7.4 六条约束')
})

test('tools: annotate_prepare 的长度上限取自 enums.LENGTH_LIMIT，工具输出有界（T1）', async () => {
  const src = await readSource(new URL('annotate-prepare.mjs', TOOLS))
  assert.ok(src.includes('LENGTH_LIMIT'), 'length_limit 必须取自 enums.LENGTH_LIMIT')
  assert.ok(src.includes('maxEntries') || src.includes('maxLexiconEntries'), 'lexicon 必须有上限（T1）')
})

test('tools: annotate_prepare 的 coverage 口径含 task-5 的 truncated / truncateReason', async () => {
  const src = await readSource(new URL('annotate-prepare.mjs', TOOLS))
  assert.match(src, /truncateReason/, 'coverage 段必须暴露 truncateReason')
  assert.match(src, /degradeReason/)
  assert.match(src, /不得声称覆盖完整/, '截断的应对说明必须落到 coverage_note')
})

test('tools: ledger_export 走 render 层与 io 层，不自己拼 HTML 也不自己拼路径', async () => {
  const src = await readSource(new URL('ledger-export.mjs', TOOLS))
  assert.match(src, /from '\.\.\/render\/html\.mjs'/)
  assert.match(src, /renderLedgerHtml/)
  assert.match(src, /from '\.\.\/io\/artifacts\.mjs'/)
  assert.match(src, /writeRender\(/, 'HTML 落盘必须走 io 层的 writeRender（INTERFACES §2.9）')
  assert.equal(/artifactPath\s*\(/.test(src), false, '路径由 io 层决定，工具层不再自己拼路径')
})

test('tools: 参数规则写在参数 description 里（T3）', async () => {
  for (const file of ['annotate-prepare.mjs', 'annotate-submit.mjs', 'ledger-export.mjs']) {
    const src = await readSource(new URL(file, TOOLS))
    const paramCount = (src.match(/description:\s*'/g) ?? []).length
    assert.ok(paramCount >= 2, `${file} 的参数应带 description`)
  }
})

test('tools: ledger_export 声明只读安全，annotate_submit 声明自身工具名', async () => {
  const exportSrc = await readSource(new URL('ledger-export.mjs', TOOLS))
  assert.match(exportSrc, /isConcurrencySafe/)
  const submitSrc = await readSource(new URL('annotate-submit.mjs', TOOLS))
  assert.match(submitSrc, /name:\s*'annotate_submit'/)
})

test('tools: 值 schema DSL 合规（每个 object 节点必须显式 additionalProperties）', async () => {
  for (const file of ['annotate-prepare.mjs', 'annotate-submit.mjs', 'ledger-export.mjs']) {
    const src = await readSource(new URL(file, TOOLS))
    assert.equal(
      /\{\s*type:\s*'object'\s*\}/.test(src),
      false,
      `${file} 有未声明 additionalProperties 的 object 节点：defineTool 会抛 JsonSchemaError（DSL 要求显式 true/false）`,
    )
    assert.match(src, /schema:\s*\{\s*type:\s*'object',\s*additionalProperties:\s*(true|false)\s*\}/)
  }
})

test('tools: 工具名与 SPEC §6.1 一致，且不使用 lean_ 前缀', async () => {
  const names = new Map([
    ['annotate-prepare.mjs', 'annotate_prepare'],
    ['annotate-submit.mjs', 'annotate_submit'],
    ['ledger-export.mjs', 'ledger_export'],
  ])
  for (const [file, toolName] of names) {
    const src = await readSource(new URL(file, TOOLS))
    assert.ok(src.includes(`name: '${toolName}'`), `${file} 的工具名应为 ${toolName}`)
    assert.equal(/lean_/.test(src), false, '一期禁用 lean_ 前缀')
  }
})
