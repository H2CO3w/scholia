/**
 * html.mjs — Ledger → **论文式**静态 HTML（纯字符串生成，不碰 DOM、不写文件）
 *
 * 依据：SPEC §1.4（命名）/ §2.5（Ledger）/ §7.6（诚实性），ARCHITECTURE §6.1，INTERFACES §2.10。
 * 版面语言对齐标准 LaTeX 论文（用户给的参考：OpenAI《Finite time blowup for the Euler equation》）：
 * **只有字号、字重、斜体、小型大写、居中/缩进、留白**——零色块、零边框、零圆角、零图标。
 *
 *   标题（全大写居中）
 *   副行（居中小型大写）· 元信息行 · 覆盖率斜体小字（有退化/截断时）
 *   摘要.        ← role=core_idea，两侧缩进
 *   目录          ← 章标题 + 章下注解条目（承担原内联角标的导航职责）
 *   1. 问题 / 2. 背景        ← 章标题居中小型大写带编号
 *   3. 定理与证明
 *        定理 3.1.  + 居中公式 + 折叠的 LEAN 源 + 参见（D5 的节点→注解链接）
 *        证明.
 *            居中公式 + 右对齐编号 (3.1) ← 编号本身是到注解的锚点
 *            注 3.1（引出词，粗体 run-in）. 正文（两端对齐、首行缩进）
 *            ∎
 *   4. 评注 / 5. 负空间
 *   页脚：指标 + provenance + 诚实性提示
 *
 * 硬性质（本轮一律不动）：
 *   - 零 `<script>`；V6 直觉层过滤仍是**纯 CSS 属性选择器**；
 *   - KaTeX 服务端渲染 + 回退（`data-a4m-math="fallback"`）；
 *   - `data-a4m-*` 属性全集；`id="a4m-n-*"` / `id="a4m-a-*"` 双向锚点存在于 DOM；
 *   - 退化/截断**必须可见**（改成一行素净斜体说明，不静默）；
 *   - 门面：`a4m-` 前缀 + BEM；枚举字面量只来自 enums.mjs（L4）。
 */

import {
  ANCHOR_KIND,
  ROLE_ORDER,
  AUDIENCE,
  CULTURE,
  EVIDENCE,
  EVIDENCE_VALUES,
  HEIGHT,
  NODE_KIND,
  PRECISE_EVIDENCE,
  PRESENTATION,
  ROLE,
  ROLE_DEFAULT_HEIGHT,
  SEGMENT_KIND,
  SIGNIFICANCE,
  VALUE_TYPE,
} from '../core/enums.mjs'
import { CSS_FILENAME, DISPLAY_LINE_BUDGET, KATEX_CSS_FILENAME, LAYER_TOGGLE_ID, VIEW_LAYER, css } from './assets.mjs'
import { escapeHtml, leanToLatex, renderMath, renderProse } from './lean-math.mjs'

// ── 显示标签（键一律取自枚举，L4）──────────────────────────────────────

const NODE_KIND_LABEL = Object.freeze({
  [NODE_KIND.THEOREM]: '定理',
  [NODE_KIND.LEMMA]: '引理',
  [NODE_KIND.DEFINITION]: '定义',
  [NODE_KIND.INSTANCE]: '实例',
  [NODE_KIND.HAVE]: NODE_KIND.HAVE,
  [NODE_KIND.LET]: NODE_KIND.LET,
  [NODE_KIND.GOAL]: '目标',
  [NODE_KIND.INDUCTIVE]: '归纳类型',
  [NODE_KIND.ABBREV]: '缩写',
  [NODE_KIND.OPAQUE]: '不透明定义',
  [NODE_KIND.CLASS_INDUCTIVE]: '类归纳类型',
  [NODE_KIND.CONSTRUCTOR]: '构造子',
  [NODE_KIND.RECURSOR]: '递归子',
})

/** 定理级注解在「参见」行里的简称。 */
const ROLE_SHORT_LABEL = Object.freeze({
  [ROLE.CORE_IDEA]: '摘要',
  [ROLE.QUESTION]: '问题',
  [ROLE.BIRDVIEW]: '背景',
  [ROLE.STEP]: '注',
  [ROLE.COMMENTARY]: '评注',
  [ROLE.NEGATIVE_SPACE]: '负空间',
})

/** `value_type` → 引出词括注里的措辞（Tao 式注意力路由：一句「可跳过」比色块有用）。 */
const VALUE_TYPE_HINT = Object.freeze({
  [VALUE_TYPE.TECHNIQUE]: '技巧',
  [VALUE_TYPE.CONCEPT]: '概念推进',
  [VALUE_TYPE.TECHNICAL]: '技术操作，可跳过',
  [VALUE_TYPE.STRUCTURAL]: '结构说明',
  [VALUE_TYPE.NONE]: '无可提炼的思路',
})

const EVIDENCE_LABEL = Object.freeze({
  [EVIDENCE.FORMAL]: '形式化',
  [EVIDENCE.LITERATURE]: '文献',
  [EVIDENCE.UNFOLDING]: '展开',
  [EVIDENCE.ANALOGY]: '类比',
  [EVIDENCE.INTUITION]: '直觉',
})

const HEIGHT_LABEL = Object.freeze({
  [HEIGHT.BIRD]: '鸟瞰',
  [HEIGHT.BOTH]: '两者',
  [HEIGHT.FROG]: '蛙眼',
})

/** 不可作推理前提的凭证（V6 的警示面）。 */
const NON_CLAIMABLE_EVIDENCE = Object.freeze(EVIDENCE_VALUES.filter((value) => !PRECISE_EVIDENCE.includes(value)))

/**
 * 章计划（顺序即呈现序；`proof` 是「定理与证明」章）。
 * 空章不渲染；章号对实际出现的章连续编（摘要不编号）。
 */
const SECTION_PLAN = Object.freeze([
  Object.freeze({ kind: 'role', role: ROLE.QUESTION, title: '问题' }),
  Object.freeze({ kind: 'role', role: ROLE.BIRDVIEW, title: '背景' }),
  Object.freeze({ kind: 'proof', role: ROLE.STEP, title: '定理与证明' }),
  Object.freeze({ kind: 'role', role: ROLE.COMMENTARY, title: '评注' }),
  Object.freeze({ kind: 'role', role: ROLE.NEGATIVE_SPACE, title: '负空间' }),
])

// ── 字符串工具 ───────────────────────────────────────────────────────

/** HTML 文本/属性转义（核心转义与 lean-math 共用一份实现）。 */
function esc(value) {
  return escapeHtml(String(value)).replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** 拼 ` key="value"`；空值不输出该属性。 */
function attr(name, value) {
  if (value === null || value === undefined || value === '') return ''
  return ` ${name}="${esc(value)}"`
}

function dataAttr(field, value) {
  return attr(`data-a4m-${field}`, value)
}

function idFragment(raw) {
  return String(raw).replace(/[^A-Za-z0-9_.:-]/g, '-')
}

/** 元素 id：SPEC §1.4 的 `a4m-n-<id>` / `a4m-a-<id>`（节点 n3 → `a4m-n-3`）。 */
function nodeDomId(nodeId) {
  const raw = String(nodeId)
  const match = /^n(.+)$/.exec(raw)
  return `a4m-n-${idFragment(match ? match[1] : raw)}`
}
function annoDomId(annoId) {
  const raw = String(annoId)
  const match = /^a(.+)$/.exec(raw)
  return `a4m-a-${idFragment(match ? match[1] : raw)}`
}

function classFragment(raw) {
  const s = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
  return s === '' ? 'unknown' : s
}

// ── 数学片段（KaTeX 服务端渲染 + 回退）───────────────────────────────

/**
 * 顶层可断处：断在关系符**之后**。
 * 另外两处也允许断：源里的换行（Lean 打印器已经选好的断点，必须尊重）、
 * 以及绑定组之间（`)]}` 之后紧跟 `([{`——类型类 binder 列表正是论文会断的地方）。
 */
const DISPLAY_BREAK_CHARS = Object.freeze(['→', '↔', '⟶', '=', '≤', '≥', '≠', '≈', '≡', ',', ':'])
/**
 * 目标行宽（Lean 源字符数）：由 assets.mjs 的版面度量推导（栏宽 + 公式外扩 ÷ 公式缩放），
 * 这里**不要再写魔数**——改栏宽请改 assets.mjs 的 LAYOUT。
 */
const DISPLAY_LINE_WIDTH = DISPLAY_LINE_BUDGET
/** 超过这个长度才考虑折行。 */
const DISPLAY_WRAP_MIN_CHARS = 60

/**
 * 把 Lean 陈述切成「到断点为止」的原子块。
 * `hard: true` 表示源里本来就有换行——那是 Lean 打印器按宽度与语法边界选的断点。
 * @returns {{text: string, hard: boolean}[]}
 */
function leanAtoms(source) {
  const atoms = []
  let current = ''
  let depth = 0
  let previous = ''
  const flush = (hard) => {
    if (current.trim() !== '') atoms.push({ text: current, hard })
    current = ''
  }
  for (const ch of source) {
    if (ch === '\n') {
      flush(true)
      previous = ''
      continue
    }
    if (depth === 0 && '([{'.includes(ch) && ')]}'.includes(previous)) flush(false)
    current += ch
    if ('([{'.includes(ch)) depth += 1
    else if (')]}'.includes(ch)) depth = Math.max(0, depth - 1)
    if (ch.trim() !== '') previous = ch
    if (depth === 0 && DISPLAY_BREAK_CHARS.includes(ch)) {
      flush(false)
      previous = ''
    }
  }
  flush(false)
  return atoms
}

/**
 * 贪心装箱：**反复折行直到每行都在目标宽度内**（不是「找到一处断点就收工」）。
 * 源里的换行是**优先断点**而不是硬约束：下一段装得下就接着排，装不下才在断点处换行——
 * Lean 打印器的断行有依据，但没必要为了它把本来放得下的内容拆成两行。
 * @returns {string[]}
 */
function packAtoms(atoms, width) {
  const lines = []
  let current = ''
  const flush = () => {
    const text = current.trim()
    if (text !== '') lines.push(text)
    current = ''
  }
  for (let i = 0; i < atoms.length; i += 1) {
    const atom = atoms[i]
    if (current !== '' && (current + atom.text).trim().length > width) flush()
    current += atom.text
    if (atom.hard) {
      const next = atoms[i + 1]
      const room = width - current.trim().length
      if (next === undefined || next.text.trim().length > room) flush()
      else current += ' '
    }
  }
  flush()
  return lines
}

/**
 * Lean 陈述 → 居中 display 公式片段。
 * 长了就按论文习惯折行（`aligned`）：先在源换行处断，再按宽度贪心折，**不横向裁切**。
 * 只有整条公式连一个断点都没有、单块就超过栏宽时才退化（由调用方给出可见提示）。
 * 渲染失败一律回退成**等宽原文**：宁可露出原文，也不要显示渲染错误的公式。
 * @returns {{html: string, kind: 'katex'|'fallback', wide: boolean}|null}
 */
function displayMathFragment(lean) {
  if (typeof lean !== 'string' || lean.trim() === '') return null
  const tooLong = lean.replace(/\s+/g, ' ').trim().length > DISPLAY_WRAP_MIN_CHARS
  const lines = tooLong ? packAtoms(leanAtoms(lean), DISPLAY_LINE_WIDTH) : [lean]
  // `&` 给每行同一个对齐点，续行左边界一致（aligned 第一列为空、其后左对齐）；
  // 连接处**不留任何空白**——`\\` 前后的空格在数学模式里是真的水平空白，会排成阶梯。
  const wrapped =
    tooLong && lines.length > 1
      ? `\\begin{aligned}${lines.map((line) => `&${leanToLatex(line)}`).join('\\\\')}\\end{aligned}`
      : null
  for (const candidate of [wrapped, leanToLatex(lean)]) {
    if (candidate === null) continue
    const result = renderMath(candidate, { display: true })
    // 只有「装不下、又断不开」的单行才需要横向滚动兜底；
    // 单行但本来就在预算内 = 正常排得下，不该给出可滚动提示。
    if (result.ok) return { html: result.html, kind: 'katex', wide: tooLong && lines.length === 1 && lines[0].length > DISPLAY_LINE_WIDTH }
  }
  return { html: `<code class="a4m-math-fallback">${esc(lean)}</code>`, kind: 'fallback', wide: false }
}

/**
 * 编号公式：居中 display 公式 + 右对齐编号 `(3.1)`。
 * 编号本身是锚点——论文引用公式就是这么做的，零额外视觉成本。
 * 公式过宽且无法折行时给 `--wide`（可横向滚动）**并加一行可见提示**，不让读者以为公式就到这里。
 */
function renderEquation(lean, options = {}) {
  const fragment = displayMathFragment(lean)
  if (fragment === null) return ''
  const number = options.number ?? null
  const target = options.targetAnnotationId ?? null
  const numberHtml =
    number === null
      ? ''
      : `<span class="a4m-equation__no">${
          target === null
            ? esc(number)
            : `<a class="a4m-equation__ref" href="#${annoDomId(target)}"${dataAttr('target', target)}>${esc(number)}</a>`
        }</span>`
  const classes = fragment.wide ? 'a4m-equation a4m-equation--wide' : 'a4m-equation'
  const hint = fragment.wide ? '<p class="a4m-note">公式较宽，本行可横向滚动查看完整内容。</p>' : ''
  return `<div class="${classes}"><span class="a4m-equation__body"${dataAttr('math', fragment.kind)}>${fragment.html}</span>${numberHtml}</div>
${hint}`
}

// ── 骨架排序（DFS 前序 + 层级编号）────────────────────────────────────

function compareNodeIds(a, b) {
  const ma = /^n(\d+)$/.exec(a)
  const mb = /^n(\d+)$/.exec(b)
  if (ma && mb) return Number(ma[1]) - Number(mb[1])
  return a < b ? -1 : a > b ? 1 : 0
}

/** 由 parent 关系还原层级，按 DFS 前序输出（父缺失/成环的节点照常渲染并标注）。 */
function orderNodes(skeleton, nodes) {
  const ids = Object.keys(nodes)
  const parentOf = new Map()
  for (const id of ids) {
    const parent = nodes[id]?.parent
    parentOf.set(id, typeof parent === 'string' && parent !== id && Object.hasOwn(nodes, parent) ? parent : null)
  }
  const children = new Map(ids.map((id) => [id, []]))
  const roots = []
  for (const id of ids) {
    const parent = parentOf.get(id)
    if (parent === null) roots.push(id)
    else children.get(parent).push(id)
  }
  roots.sort(compareNodeIds)
  for (const list of children.values()) list.sort(compareNodeIds)

  const out = []
  const seen = new Set()
  const visit = (id, depth) => {
    if (seen.has(id)) return
    seen.add(id)
    out.push({ id, node: nodes[id] ?? {}, depth, unreachable: false })
    for (const child of children.get(id) ?? []) visit(child, depth + 1)
  }

  const root = typeof skeleton.root === 'string' && Object.hasOwn(nodes, skeleton.root) ? skeleton.root : null
  if (root !== null) visit(root, 0)
  for (const id of roots) visit(id, 0)
  for (const id of [...ids].sort(compareNodeIds)) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ id, node: nodes[id] ?? {}, depth: 0, unreachable: true })
  }
  return out
}

/** 层级步骤编号：根不编号；顶层 1、2、…；嵌套 1.2、1.2.1、…（公式号 `(3.1.2)` 由它加章号得到）。 */
function stepNumbers(orderedNodes, rootId) {
  const numbers = new Map()
  const siblingIndex = new Map()
  for (const entry of orderedNodes) {
    if (entry.id === rootId) {
      numbers.set(entry.id, null)
      continue
    }
    const parent = typeof entry.node.parent === 'string' ? entry.node.parent : null
    const parentNumber = parent !== null && numbers.has(parent) ? numbers.get(parent) : null
    const key = parent ?? '(root)'
    const index = (siblingIndex.get(key) ?? 0) + 1
    siblingIndex.set(key, index)
    numbers.set(entry.id, parentNumber === null || parentNumber === undefined ? String(index) : `${parentNumber}.${index}`)
  }
  return numbers
}

// ── 双向锚点映射 ─────────────────────────────────────────────────────

function nodeByDecl(nodes, target) {
  if (typeof target !== 'string' || target === '') return null
  for (const [id, node] of Object.entries(nodes)) {
    if (node?.decl === target) return id
  }
  return null
}

/** 一条注解能跳到的骨架节点（主锚点 + 可解析的 goal/hyp 锚点 + 能对上 decl 的锚点）。 */
function annotationTargets(ann, nodes) {
  const out = []
  const push = (target) => {
    if (typeof target === 'string' && Object.hasOwn(nodes, target) && !out.includes(target)) out.push(target)
  }
  push(ann.node)
  for (const anchor of Array.isArray(ann.anchors) ? ann.anchors : []) {
    if (!anchor || typeof anchor !== 'object') continue
    if (anchor.kind === ANCHOR_KIND.DECL) {
      const resolved = nodeByDecl(nodes, anchor.target)
      if (resolved !== null) push(resolved)
      continue
    }
    push(anchor.target)
  }
  return out
}

// ── 注解（论文的 remark：run-in 引出词 + 正文，无框无底色无缩进块）─────

/**
 * 引出词后的括注：只放「怎么读这条注解」的信号——
 * `value_type`（步骤注解上始终给）、不可作推理前提的凭证（警示）、偏离 role 默认值的 height。
 * 恒定的 presentation / audience 与结构性的 significance 不进括注：那是噪音，不是信息。
 */
function hintOf(ann) {
  const parts = []
  const valueHint = VALUE_TYPE_HINT[ann.valueType]
  if (valueHint !== undefined) parts.push(valueHint)
  if (NON_CLAIMABLE_EVIDENCE.includes(ann.evidence)) parts.push(`${EVIDENCE_LABEL[ann.evidence]}，不可作推理前提`)
  const defaultHeight = ROLE_DEFAULT_HEIGHT[ann.role]
  if (defaultHeight !== undefined && ann.height !== undefined && ann.height !== defaultHeight) {
    parts.push(HEIGHT_LABEL[ann.height])
  }
  return parts.length === 0 ? '' : `（${parts.join('，')}）`
}

/**
 * 注解块：`<article id="a4m-a-…">` 里就是若干段落，**没有额外包裹层**。
 * `options.lead` 给出时才写 run-in 引出词（粗体、可点，指回它注解的公式/节点）：
 *   步骤注解 → `注 3.1（技术操作，可跳过）.`；摘要 → `摘要.`。
 * 章节级注解**不给引出词**（章节标题就是它的标签，标题后面带可操作信号的括注），
 * 所以 `lead: null` 时正文直接开始。
 */
function renderAnnotation(ann, nodes, options = {}) {
  const id = String(ann.id ?? '')
  const targets = annotationTargets(ann, nodes)
  const primary = targets[0] ?? null
  const classes = ['a4m-anno', primary === null ? 'a4m-anno--orphan' : ''].filter(Boolean).join(' ')
  const attrs = [
    attr('id', annoDomId(id)),
    dataAttr('anno', id),
    dataAttr('role', ann.role),
    dataAttr('evidence', ann.evidence),
    ann.valueType === null || ann.valueType === undefined ? '' : dataAttr('value-type', ann.valueType),
    dataAttr('height', ann.height),
    dataAttr('significance', ann.significance),
    dataAttr('presentation', ann.presentation),
    dataAttr('audience', ann.audience),
    ann.culture === null || ann.culture === undefined ? '' : dataAttr('culture', ann.culture),
  ].join('')

  const leadText = options.lead === null || options.lead === undefined ? null : `${options.lead}${hintOf(ann)}.`
  const lead =
    leadText === null
      ? ''
      : primary === null
        ? `<span class="a4m-anno__lead">${esc(leadText)}</span>`
        : `<a class="a4m-anno__lead" href="#${nodeDomId(primary)}"${dataAttr('target', primary)}>${esc(leadText)}</a>`

  const segments = Array.isArray(ann.segments) ? ann.segments : []
  const body =
    segments.length === 0
      ? [`<p class="a4m-anno__seg">${lead} （无 segments：违反 V11）</p>`]
      : segments.map((seg, index) => {
          const isConcept = seg?.kind === SEGMENT_KIND.CONCEPT
          const lexiconRef = isConcept ? seg.lexiconRef : null
          const segAttrs = [dataAttr('seg-kind', seg?.kind), isConcept ? dataAttr('lexicon', lexiconRef) : ''].join('')
          const lexiconNote = isConcept
            ? lexiconRef
              ? `<span class="a4m-anno__lex">（词典：${esc(lexiconRef)}）</span>`
              : '<span class="a4m-anno__lex a4m-anno__lex--missing">（缺 lexicon_ref：违反 V10）</span>'
            : ''
          const text = renderProse(seg?.text ?? '')
          const head = index === 0 && lead !== '' ? `${lead} ` : ''
          return `<p class="a4m-anno__seg a4m-anno__seg--${classFragment(seg?.kind)}"${segAttrs}>${head}${text}${lexiconNote}</p>`
        })

  return `<article class="${classes}"${attrs}>
${body.join('\n')}
</article>`
}

/**
 * 陈述未知：v1.3 条件字段 `signatureUnknown`（`have h := 项` 类型标注被省略）。
 * 空签名也按未知处理——渲染出「编号公式 + 一片空白」对读者是纯粹的困惑。
 */
function isSignatureUnknown(node) {
  if (node === null || typeof node !== 'object') return false
  if (node.signatureUnknown === true) return true
  return typeof node.signature !== 'string' || node.signature.trim() === ''
}

/**
 * 未知陈述**不编号**（没有公式可编号）：给一句读者能懂的话，随后原样呈现该项原文。
 * 原文照 Lean 源块的款式（等宽小字、不折叠）——它是读者在这里唯一的材料。
 */
function renderUnknownStatement(node) {
  const raw = typeof node.rawText === 'string' && node.rawText.trim() !== '' ? node.rawText : null
  const localName = typeof node.localName === 'string' && node.localName !== '' ? node.localName : null
  return `<div class="a4m-unknown"${dataAttr('signature-unknown', 'true')}${dataAttr('local-name', localName)}>
<p class="a4m-note">本步的陈述在形式化源码中省略（由 Lean 推断），这里只呈现其定义：</p>
${raw === null ? '<p class="a4m-note">（该项原文未随骨架提供。）</p>' : `<pre class="a4m-unknown__raw">${esc(raw)}</pre>`}
</div>`
}

// ── 定理块 / 步骤（编号公式）─────────────────────────────────────────

/**
 * 定理环境（照 amsthm）：`定理 3.1.` 粗体引出 + 居中公式 + 折叠的 LEAN 源。
 * 不再有「参见」行：导航交给目录（章 + 注解条目），章节标题负责注解→节点方向；
 * `a4m-n-*` / `a4m-a-*` 的 id 仍全在 DOM 里（D5 的机器可读锚点不受影响）。
 */
function renderTheorem(entry, sectionNumber) {
  const { id, node } = entry
  const label = NODE_KIND_LABEL[node.kind] ?? node.kind ?? '定理'
  const parts = [
    `<h3 class="a4m-theorem__head"><span class="a4m-theorem__label">${esc(label)} ${esc(sectionNumber)}.1.</span> ${
      node.decl ? `<span class="a4m-theorem__decl">${esc(node.decl)}</span>` : ''
    }</h3>`,
    isSignatureUnknown(node) ? renderUnknownStatement(node) : renderEquation(node.signature),
    node.signature
      ? `<details class="a4m-lean"><summary class="a4m-lean__summary"><span class="a4m-lean__label">Lean 源</span>（可直接复制；上方排版后的公式便于阅读，但复制会丢失黑板体 ℝ/ℕ/ℤ 等字形）</summary><pre class="a4m-lean__pre">${esc(node.signature)}</pre></details>`
      : '',
  ]
  return `<section class="a4m-theorem"${attr('id', nodeDomId(id))}${dataAttr('node', id)}${dataAttr('kind', node.kind)}${isSignatureUnknown(node) ? dataAttr('signature-unknown', 'true') : ''}>
${parts.filter(Boolean).join('\n')}
</section>`
}

function renderStep(entry, equationNumber, annotations, nodes, rootTruncated) {
  const { id, node, depth, unreachable } = entry
  const unknown = isSignatureUnknown(node)
  const equation = unknown
    ? renderUnknownStatement(node)
    : renderEquation(node.signature, {
        number: `(${equationNumber})`,
        targetAnnotationId: annotations[0]?.id ?? null,
      })
  // 截断状态与定理级一致就不重复（整条记录的属性，不是每一步的属性）；
  // 只有不一致时才单独说明，而且**另起一行**，不贴在公式编号上。
  const nodeTruncated = node.truncated === true
  const notes = [
    nodeTruncated === rootTruncated
      ? ''
      : `<p class="a4m-coverage a4m-coverage--step a4m-note">本步记录截断状态与定理级不一致（本步 truncated=${nodeTruncated ? 'true' : 'false'}，定理级 truncated=${rootTruncated ? 'true' : 'false'}）。</p>`,
    unreachable ? '<p class="a4m-note">该节点的 parent 不可达，已按根级渲染。</p>' : '',
  ].filter(Boolean)
  // 陈述未知的步骤没有公式编号可用，引出词就不带编号
  const remarks = annotations
    .map((ann) => renderAnnotation(ann, nodes, { lead: unknown ? '注' : `注 ${equationNumber}` }))
    .join('\n')
  return `<section class="a4m-step"${attr('id', nodeDomId(id))}${dataAttr('node', id)}${dataAttr('kind', node.kind)}${dataAttr('depth', depth)}${unknown ? dataAttr('signature-unknown', 'true') : ''}>
${equation}
${notes.join('\n')}
${remarks}
</section>`
}

/**
 * 覆盖率说明：**整条记录只出现一次**（放在定理块之后，属于定理级）。
 * 截断/退化是整条记录（乃至整棵树）的属性，不是每一步的属性——每步挂一遍是纯重复噪音，
 * 所以这里把「是什么 + 影响范围」一次说清；只有与定理级**不一致**的步骤才另行标注（见 renderStep）。
 */
function renderCoverageNote(coverage) {
  const c = coverage && typeof coverage === 'object' ? coverage : {}
  const degraded = c.degraded === true
  const truncated = c.truncated === true
  const sentences = []
  if (degraded) {
    // 只写给读者的话：内部字段名（have_count / mode / value）与「请改用…」这类
    // 面向挑定理者的操作建议都不该出现在读者页面上；技术诊断留在 data 属性与 annotate_prepare。
    sentences.push('本定理没有可解析的证明步骤，下面只给出定理陈述与整体注解。')
  }
  if (truncated) {
    sentences.push(
      '记录截断（数据集 500 字符上限）：以下步骤来自已解析出的部分，覆盖可能不完整。',
    )
  }
  if (sentences.length === 0) return '' // 没有退化/截断就不说：没有信息就不占版面
  const text = sentences.join('')
  // 原因细节留在 data 属性里供机器读；可见文本保持一句话，避免自己重复自己
  return `<p class="a4m-coverage a4m-note"${dataAttr('degraded', degraded ? 'true' : 'false')}${dataAttr('truncated', truncated ? 'true' : 'false')}${dataAttr('mode', c.mode)}${dataAttr('have-count', c.haveCount)}${dataAttr('node-count', c.nodeCount)}${dataAttr('degrade-reason', c.degradeReason)}${dataAttr('truncate-reason', c.truncateReason)}>${esc(text)}</p>`
}

/**
 * 章节标题后的括注：把「怎么读这一节」的信号从注解正文挪到标题上
 * （章节级注解不再有引出词，标题即标签）。多个注解时按出现序去重合并。
 */
function hintOfSection(annotations) {
  const parts = []
  for (const ann of annotations) {
    const hint = hintOf(ann)
    if (hint === '') continue
    for (const part of hint.slice(1, -1).split('，')) {
      if (!parts.includes(part)) parts.push(part)
    }
  }
  return parts.length === 0 ? '' : `（${parts.join('，')}）`
}

/** 目录：章 + 章下注解条目；承担原内联角标的导航职责。 */
function renderContents(entries) {
  const items = entries
    .map(
      (entry) =>
        `<li class="a4m-contents__item${entry.sub === true ? ' a4m-contents__item--sub' : ''}"><a class="a4m-contents__link" href="#${entry.id}"><span class="a4m-contents__label">${esc(entry.label)}</span><span class="a4m-contents__page">${esc(entry.page)}</span></a></li>`,
    )
    .join('\n')
  return `<nav class="a4m-contents" id="a4m-contents">
<h2 class="a4m-contents__title">目录</h2>
<ul class="a4m-contents__list">
${items}
</ul>
</nav>`
}

/** 副行：module · kind · Mathlib 基线（module 只能从名字推，推不出就不显示——不编造）。 */
function subtitleOf(ledger, rootNode) {
  const theorem = String(ledger.theorem ?? '')
  const namespace = theorem.includes('.') ? theorem.slice(0, theorem.lastIndexOf('.')) : ''
  const module = namespace.includes('.') ? namespace : null
  return [
    module ? `module ${module}` : '',
    rootNode?.kind ? `${NODE_KIND_LABEL[rootNode.kind] ?? rootNode.kind}` : '',
    ledger.mathlibBaseline ? `Mathlib ${ledger.mathlibBaseline}` : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

/**
 * 页眉：标题 / 副行 / 直觉层开关 / 诚实性声明。
 * 不放 spec_version、run、created 之类的机器契约——那是账本 JSON 的事，
 * 露在读者面前（而且是写入时的旧值）只会误导；出处信息统一收在页脚一行。
 */
function renderHead(ledger, rootNode, coverageNote) {
  const theorem = ledger.theorem ?? '(未命名定理)'
  return `<header class="a4m-paper__head">
<h1 class="a4m-paper__title">${esc(theorem)}</h1>
<p class="a4m-paper__subtitle">${esc(subtitleOf(ledger, rootNode))}</p>
${coverageNote}
<label class="a4m-layer-toggle" for="${LAYER_TOGGLE_ID}"><input class="a4m-layer-toggle__input" type="checkbox" id="${LAYER_TOGGLE_ID}"><span class="a4m-layer-toggle__label">直觉层视图（隐藏形式化 / 文献 / 展开三种精确凭证的注解，V6，纯 CSS）</span></label>
<p class="a4m-paper__note">注解为模型生成，未经真人校准（H4）。引理语义仅以 concept 段的词典条目为准。</p>
</header>`
}

// ── 入口 ─────────────────────────────────────────────────────────────

/**
 * Ledger（JS 侧 camelCase，INTERFACES §1）→ 完整 HTML 文档字符串。
 *
 * @param {object} ledger
 * @returns {string}
 */
export function renderLedgerHtml(ledger) {
  if (ledger === null || typeof ledger !== 'object' || Array.isArray(ledger)) {
    throw new TypeError(
      'renderLedgerHtml(ledger) 需要 Ledger 对象；请先用 annotate_submit 生成 out/ledger/<slug>.json 并读取它',
    )
  }
  const skeleton = ledger.skeleton && typeof ledger.skeleton === 'object' ? ledger.skeleton : {}
  const nodes = skeleton.nodes && typeof skeleton.nodes === 'object' ? skeleton.nodes : {}
  const annotations = (Array.isArray(ledger.annotations) ? ledger.annotations : []).filter(
    (ann) => ann && typeof ann === 'object',
  )

  const orderedNodes = orderNodes(skeleton, nodes)
  const rootId =
    typeof skeleton.root === 'string' && Object.hasOwn(nodes, skeleton.root) ? skeleton.root : (orderedNodes[0]?.id ?? null)
  const numbers = stepNumbers(orderedNodes, rootId)

  // 注解归位：步骤注解跟在它的公式下面；定理级注解按 role 进各章；未知 role 进「其它」。
  const stepAnnotations = new Map()
  const roleBuckets = new Map()
  const unknown = []
  const knownRoles = new Set([...SECTION_PLAN.map((plan) => plan.role), ROLE.CORE_IDEA])
  for (const ann of annotations) {
    if (ann.role === ROLE.STEP) {
      const key = typeof ann.node === 'string' ? ann.node : ''
      // 步骤注解挂不到任何节点上时**不能静默丢弃**：降级到「其它注解」照常渲染
      if (Object.hasOwn(nodes, key)) {
        if (!stepAnnotations.has(key)) stepAnnotations.set(key, [])
        stepAnnotations.get(key).push(ann)
      } else {
        unknown.push(ann)
      }
      continue
    }
    if (knownRoles.has(ann.role)) {
      if (!roleBuckets.has(ann.role)) roleBuckets.set(ann.role, [])
      roleBuckets.get(ann.role).push(ann)
      continue
    }
    unknown.push(ann)
  }

  const roleSection = (role, lead) => {
    const items = roleBuckets.get(role) ?? []
    return items.length > 0 ? items.map((ann) => renderAnnotation(ann, nodes, { lead })).join('\n') : null
  }
  // 章节级注解没有引出词：标题即标签（见 hintOfSection / sections）
  const chapterSection = (role) => roleSection(role, null)

  // 章编号：只对实际渲染的章连续编（摘要不编号）；定理环境要印成 `定理 <章号>.1.`
  const plan = []
  let counter = 0
  for (const item of SECTION_PLAN) {
    const body = item.kind === 'proof' ? '' : chapterSection(item.role)
    if (item.kind !== 'proof' && (body === null || body === '')) continue
    counter += 1
    plan.push({ ...item, number: counter, body })
  }
  const proofSection = plan.find((item) => item.kind === 'proof') ?? null
  const chapterOf = (role) => plan.find((item) => item.role === role)?.number ?? 1

  // 摘要（core_idea，两侧缩进的 abstract）
  const abstractBody = roleSection(ROLE.CORE_IDEA, '摘要')
  const abstract =
    abstractBody === null
      ? ''
      : `<section class="a4m-abstract" id="a4m-sec-abstract"${dataAttr('section', ROLE.CORE_IDEA)}>
${abstractBody}
</section>`

  // 证明章：定理块 + 证明引导词 + 编号公式 + 注 + ∎
  const rootEntry = orderedNodes.find((entry) => entry.id === rootId) ?? null
  const proofNumber = proofSection?.number ?? 1
  const coverageNote = renderCoverageNote(skeleton.coverage)
  const rootTruncated = rootEntry?.node?.truncated === true
  const steps = orderedNodes
    .filter((entry) => entry.id !== rootId)
    .map((entry) =>
      renderStep(entry, `${proofNumber}.${numbers.get(entry.id) ?? '?'}`, stepAnnotations.get(entry.id) ?? [], nodes, rootTruncated),
    )
    .join('\n')
  const degraded = skeleton.coverage?.degraded === true
  // 退化本身已由覆盖率说明承担；这里只兜「只有根节点却没被标成退化」的边角情形
  const stepNote = orderedNodes.length <= 1 && degraded !== true ? '<p class="a4m-note">骨架中只有根节点。</p>' : ''
  const proofParts = [
    rootEntry ? renderTheorem(rootEntry, proofNumber) : '',
    rootEntry ? coverageNote : '', // 数据质量注记：整条记录一次，讲清影响范围
    steps === '' ? '' : '<p class="a4m-proof-lead">证明.</p>',
    stepNote,
    steps,
    // ∎ 是「证明结束」的断言：没有渲染出任何步骤就不该出现
    steps === '' ? '' : '<p class="a4m-qed">∎</p>',
  ]
    .filter(Boolean)
    .join('\n')

  const sections = plan.map((item) => {
    const body = item.kind === 'proof' ? proofParts : item.body
    const roleAnns = roleBuckets.get(item.role) ?? []
    const label = `${item.number}. ${item.title}${item.kind === 'proof' ? '' : hintOfSection(roleAnns)}`
    // 章节标题链回它注解的节点：章节级注解不再有引出词，注解→节点这个方向由标题承担
    const firstTarget = roleAnns.length > 0 ? annotationTargets(roleAnns[0], nodes)[0] ?? null : null
    const title =
      item.kind !== 'proof' && firstTarget !== null
        ? `<a class="a4m-section__ref" href="#${nodeDomId(firstTarget)}"${dataAttr('target', firstTarget)}>${esc(label)}</a>`
        : esc(label)
    return `<section class="a4m-section" id="a4m-sec-${classFragment(item.role)}"${dataAttr('section', item.role)}>
<h2 class="a4m-section__title">${title}</h2>
${body}
</section>`
  })

  if (unknown.length > 0) {
    counter += 1
    sections.push(`<section class="a4m-section a4m-section--unknown" id="a4m-sec-unknown"${dataAttr('section', 'unknown')}>
<h2 class="a4m-section__title">${counter}. 其它注解</h2>
${unknown.map((ann) => renderAnnotation(ann, nodes, { lead: '注' })).join('\n')}
</section>`)
  }

  // 目录：章标题 + 章下注解 / 公式条目
  const contents = []
  const anchorOf = (role, fallbackId) => {
    const first = (roleBuckets.get(role) ?? [])[0]
    return first === undefined ? fallbackId : annoDomId(first.id)
  }
  if (abstract !== '') {
    contents.push({ id: anchorOf(ROLE.CORE_IDEA, 'a4m-sec-abstract'), label: '摘要', page: `${(roleBuckets.get(ROLE.CORE_IDEA) ?? []).length} 条` })
  }
  for (const item of plan) {
    if (item.kind === 'proof') {
      const stepCount = orderedNodes.filter((entry) => entry.id !== rootId).length
      contents.push({ id: `a4m-sec-${classFragment(item.role)}`, label: `${item.number}. ${item.title}`, page: stepCount > 0 ? `${stepCount} 步` : '退化' })
      for (const entry of orderedNodes) {
        if (entry.id === rootId) continue
        const remarks = stepAnnotations.get(entry.id) ?? []
        const unknownStep = isSignatureUnknown(entry.node)
        const localName =
          typeof entry.node?.localName === 'string' && entry.node.localName !== '' ? entry.node.localName : null
        for (const ann of remarks) {
          contents.push({
            // 陈述未知的步骤没有公式编号可引用：目录里给它的原文位置，而不是一个不存在的 (3.x)
            id: annoDomId(ann.id),
            label: unknownStep ? `注${localName === null ? '' : ` ${localName}`}` : `注 ${proofNumber}.${numbers.get(entry.id) ?? '?'}`,
            page: unknownStep ? '陈述省略' : `式 (${proofNumber}.${numbers.get(entry.id) ?? '?'})`,
            sub: true,
          })
        }
      }
      continue
    }
    contents.push({
      id: anchorOf(item.role, `a4m-sec-${classFragment(item.role)}`),
      label: `${item.number}. ${item.title}`,
      page: `${(roleBuckets.get(item.role) ?? []).length} 条`,
    })
  }
  if (unknown.length > 0) contents.push({ id: 'a4m-sec-unknown', label: `${counter}. 其它注解`, page: `${unknown.length} 条` })

  const theorem = ledger.theorem ?? '(未命名定理)'
  // 页脚 = 一行出处：谁生成的、哪次运行、数学基线。
  // 指标（判据数据）、本地路径、spec_version 都不给读者看。
  const provLine = [
    '由 dsh-scholia 生成',
    ledger.provenance?.run ? `run=${ledger.provenance.run}` : '',
    ledger.mathlibBaseline ? `Mathlib ${ledger.mathlibBaseline}` : '',
  ]
    .filter(Boolean)
    .join(' · ')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(theorem)} · ai4math 注解账本</title>
<link rel="stylesheet" href="assets/${KATEX_CSS_FILENAME}">
<link rel="stylesheet" href="assets/${CSS_FILENAME}">
<!-- 内联我们自己的样式（不含外部字体引用）：单文件打开也可读；
     KaTeX 的样式必须走外链——它按相对路径 url(fonts/…) 引字体，内联会找错目录 -->
<style>
${css()}</style>
</head>
<body data-a4m-layer="${esc(VIEW_LAYER.PROOF)}"${dataAttr('name', theorem)}${dataAttr('spec-version', ledger.specVersion)}>
<article class="a4m-paper">
${renderHead(ledger, rootEntry?.node, rootEntry ? '' : coverageNote)}
${abstract}
${renderContents(contents)}
${sections.join('\n')}
<footer class="a4m-paper__foot">
<p class="a4m-paper__prov">${esc(provLine)}</p>
</footer>
</article>
</body>
</html>
`
}

/**
 * 渲染资产表（INTERFACES §2.10）：{ 'a4m.css': <样式表文本> }
 * @returns {Record<string, string>}
 */
export function renderAssets() {
  return { [CSS_FILENAME]: css() }
}
