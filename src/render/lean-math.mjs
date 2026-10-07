/**
 * lean-math.mjs — Lean 文本 → LaTeX → KaTeX HTML（**服务端渲染的纯字符串**）
 *
 * 依据：SPEC §7.1.1（KaTeX 例外条款）、ARCHITECTURE §6.1。
 * 分层 L1：不 import I/O 模块、不做网络请求、不 import DSH 包；只依赖 vendored 的 KaTeX。
 * 输出页面仍然零 `<script>`：KaTeX 只在服务端把公式渲染成 HTML 字符串。
 *
 * 两条设计原则：
 *   1. **保守转换**：`leanToLatex` 只替换能确定的符号，认不出来的一律原样保留；
 *   2. **失败不伪装**：`renderMath` 用 `throwOnError: true`，抛错就返回 `{ ok: false }`，
 *      由调用方回退成等宽原文。**不用** `throwOnError: false`——那会让 KaTeX 把错误
 *      渲染成红色公式，把失败伪装成成功。
 */

import katex from '../../vendor/katex/katex.mjs'

// ── 符号表（Unicode → LaTeX）─────────────────────────────────────────

/**
 * Lean 文本 → LaTeX。
 *
 * **这是排版层，不是字符串替换层**：Lean 的证明体原样丢进 KaTeX 会读错——
 *   1. 多字母标识符会被当成变量相乘（`CommRing` → 斜体 *C o m m R i n g*，8 个 `<mi>`）；
 *   2. 数学模式吞空格，`CommRing R` 粘成 `CommRingR`；
 *   3. `[` `]` `{` `}` 在 LaTeX 里是语法字符。
 * 所以按 token 处理，四条规则（其余一律保守保留）：
 *   A. 纯字母 token 长度 ≥ 2 → `\mathrm{…}`（Lean 的乘积一定写 `*`，相邻字母必是名字）；
 *      长度 1 → 保持斜体变量；
 *   B. 不紧邻**自间距运算符**的空白 → `\ `（紧邻的交给 LaTeX 自动间距，避免 `A₀\ \cdot\ B₀` 松掉）；
 *   C. `{` `}` → `\{` `\}`（`[` `]` 在数学模式下就是定界符，原样）；
 *   D. 认不出来的字符原样保留，出错就由调用方回退成等宽原文。
 *
 * @param {string} lean
 * @returns {string}
 */
/** 绑定组的括号对（含 Lean 的 ⦃ ⦄）。 */
const BINDER_PAIRS = new Map([
  ['(', ')'],
  ['{', '}'],
  ['[', ']'],
  ['⦃', '⦄'],
])
const BINDER_OPENERS = new Set(BINDER_PAIRS.keys())
const BINDER_CLOSERS = new Set(BINDER_PAIRS.values())

/** 名字必须是标识符形状；拿不准（含算符、括号等）就整组不动——保守优先。 */
const BINDER_NAME = /^[\p{L}\p{N}_'′!?ₐ-ₜ₀-₉]+$/u

/** 找到与 `start` 处开括号配对的位置；不配对返回 -1。 */
function matchBracket(text, start) {
  let depth = 0
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (BINDER_OPENERS.has(ch)) depth += 1
    else if (BINDER_CLOSERS.has(ch)) {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/** 组内**顶层**的绑定冒号位置（跳过 `:=`，跳过嵌套括号里的冒号）；没有返回 -1。 */
function topLevelBinderColon(inner) {
  let depth = 0
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]
    if (BINDER_OPENERS.has(ch)) depth += 1
    else if (BINDER_CLOSERS.has(ch)) depth -= 1
    else if (ch === ':' && depth === 0) {
      if (inner[i + 1] === '=') {
        i += 1
        continue
      }
      return i
    }
  }
  return -1
}

/** 名字列表：≥2 个标识符才加逗号；单个名字（`{α : Type u_2}` / `[inst : C α]`）原样。 */
function rewriteBinderNames(namesPart) {
  if (/[(){}\[\]⦃⦄]/.test(namesPart)) return namesPart
  const names = namesPart.trim().split(/\s+/).filter((name) => name !== '')
  if (names.length < 2) return namesPart
  if (!names.every((name) => BINDER_NAME.test(name))) return namesPart
  return names.join(', ')
}

/**
 * 绑定组内 ≥2 个名字时插入逗号：`(A₀ A₁ : R)` → `(A₀, A₁ : R)`，读者看到 `A₀, A₁ : R`。
 *
 * 边界划死，只做这一件事：
 *   - 只在**带绑定冒号的括号组**里做（`(` `{` `[` `⦃`）；`:` 之后的类型部分一律不动；
 *   - **函数应用不动**（`IsCHSHTuple A₀ A₁ B₀ B₁`）：`f (g a) b` 与 `f g a b` 在源里同形，
 *     不知道 arity 就无法决定逗号放哪。这条歧义是有意保留的，别当 bug 修；
 *   - `[CommRing R]` 这类实例隐式组没有绑定冒号，原样保留（翻成「设 R 是交换环」属于注解层）；
 *   - `:=` 不是绑定冒号；括号不配对、名字不像标识符、嵌套组各自处理（不是遇到第一个冒号就停）。
 */
export function insertBinderCommas(lean) {
  const walk = (text) => {
    let out = ''
    let i = 0
    while (i < text.length) {
      const ch = text[i]
      if (!BINDER_OPENERS.has(ch)) {
        out += ch
        i += 1
        continue
      }
      const end = matchBracket(text, i)
      if (end === -1) {
        out += ch
        i += 1
        continue
      }
      out += ch + rewriteGroup(text.slice(i + 1, end)) + text[end]
      i = end + 1
    }
    return out
  }
  const rewriteGroup = (inner) => {
    const colon = topLevelBinderColon(inner)
    if (colon === -1) return walk(inner)
    return rewriteBinderNames(inner.slice(0, colon)) + ':' + walk(inner.slice(colon + 1))
  }
  return walk(String(lean ?? ''))
}

export function leanToLatex(lean) {
  if (typeof lean !== 'string' || lean === '') return ''
  // 先补绑定组的逗号（保守规则见 insertBinderCommas），再逐 token 转 LaTeX
  return renderTokens(tokenize(insertBinderCommas(lean)))
}

// ── token 化 ─────────────────────────────────────────────────────────

/** 单字符 → LaTeX（运算符、定界符、希腊字母、黑板体；不含字母/数字）。 */
const SYMBOL_TO_LATEX = Object.freeze({
  '≤': '\\le', '≥': '\\ge', '≠': '\\ne', '≈': '\\approx', '≡': '\\equiv',
  '≃': '\\simeq', '≅': '\\cong', '→': '\\to', '←': '\\leftarrow', '↔': '\\leftrightarrow',
  '↦': '\\mapsto', '∈': '\\in', '∉': '\\notin', '⊆': '\\subseteq', '⊂': '\\subset',
  '⊇': '\\supseteq', '⊃': '\\supset', '∪': '\\cup', '∩': '\\cap', '∅': '\\emptyset',
  '∀': '\\forall', '∃': '\\exists', '∧': '\\wedge', '∨': '\\vee', '¬': '\\neg',
  '⊤': '\\top', '⊥': '\\bot',
  '⟨': '\\langle', '⟩': '\\rangle', '∑': '\\sum', '∏': '\\prod',
  '√': '\\surd', '∞': '\\infty', '∂': '\\partial', '∫': '\\int',
  '•': '\\cdot', '·': '\\cdot', '×': '\\times', '∘': '\\circ',
  'ℝ': '\\mathbb{R}', 'ℕ': '\\mathbb{N}', 'ℤ': '\\mathbb{Z}',
  'ℚ': '\\mathbb{Q}', 'ℂ': '\\mathbb{C}', '𝕜': '\\mathbb{k}',
  '𝔽': '\\mathbb{F}', 'ℍ': '\\mathbb{H}', 'ℙ': '\\mathbb{P}',
  'α': '\\alpha', 'β': '\\beta', 'γ': '\\gamma', 'δ': '\\delta', 'ε': '\\epsilon',
  'ζ': '\\zeta', 'η': '\\eta', 'θ': '\\theta', 'ι': '\\iota', 'κ': '\\kappa',
  'λ': '\\lambda', 'μ': '\\mu', 'ν': '\\nu', 'ξ': '\\xi', 'π': '\\pi',
  'ρ': '\\rho', 'σ': '\\sigma', 'τ': '\\tau', 'υ': '\\upsilon', 'φ': '\\varphi',
  'ϕ': '\\phi', 'χ': '\\chi', 'ψ': '\\psi', 'ω': '\\omega',
  'Γ': '\\Gamma', 'Δ': '\\Delta', 'Θ': '\\Theta', 'Λ': '\\Lambda', 'Ξ': '\\Xi',
  'Π': '\\Pi', 'Σ': '\\Sigma', 'Υ': '\\Upsilon', 'Φ': '\\Phi', 'Ψ': '\\Psi',
  'Ω': '\\Omega',
  // LaTeX 里有语法含义的字符：必须转义，否则 KaTeX 抛错或吞内容
  '{': '\\{', '}': '\\}', '&': '\\&', '%': '\\%', '$': '\\$', '#': '\\#',
  '_': '\\_', '\\': '\\backslash', '~': '\\sim', '"': '\\text{"}',
  '*': '\\cdot', '±': '\\pm', '∓': '\\mp', '≔': ':=', '⟶': '\\longrightarrow',
})

/** 自间距运算符（TeX 的 Bin / Rel / Punct 类）：紧邻它的空白交给 LaTeX，不再补 `\ `。 */
const SELF_SPACING = new Set([
  '\\cdot', '\\times', '\\circ', '\\pm', '\\mp', '\\cup', '\\cap', '\\wedge', '\\vee',
  '\\le', '\\ge', '\\ne', '\\approx', '\\equiv', '\\simeq', '\\cong', '\\to', '\\leftarrow',
  '\\leftrightarrow', '\\mapsto', '\\longrightarrow', '\\in', '\\notin', '\\subseteq', '\\subset',
  '\\supseteq', '\\supset',
  // `,` 故意不在这里：标点后该留一个真实空格（KaTeX 的标点间距太窄），
  // 也让绑定组的 `A₀, A₁` 读起来像列表
  '+', '-', '=', '<', '>', '/', ':', ';', ':=',
])

/** Unicode 上下标（标识符内部使用，如 `A₀`、`x⁻¹`）。 */
const SUBSCRIPT_DIGIT = Object.freeze({ '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9' })
const SUPERSCRIPT_CHAR = Object.freeze({ '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁻': '-' })

const IDENT_START = /[A-Za-z]/
const IDENT_CHAR = /[A-Za-z0-9_'!?.]/

/** 名字怎么排：单字母是变量（斜体），其余一律正体（`\mathrm`）。 */
function mathrmName(name) {
  if (name === '') return ''
  if (/^[A-Za-z]$/.test(name)) return name
  if (/^[0-9]+$/.test(name)) return name
  return `\\mathrm{${name}}`
}

/**
 * 标识符 token → LaTeX：拆基名 + 上下标 + 撇号，基名按 `mathrmName` 判定。
 * `CommRing` → `\mathrm{CommRing}`；`R` → `R`；`A₀` → `A_{0}`；`u_2` → `u_{2}`；`h'` → `h'`。
 */
function renderIdent(text) {
  const primeMatch = /'+$/.exec(text)
  const primes = primeMatch ? primeMatch[0] : ''
  const body = primes === '' ? text : text.slice(0, -primes.length)
  let main = ''
  let scripts = ''
  let i = 0
  while (i < body.length) {
    const ch = body[i]
    if (Object.hasOwn(SUBSCRIPT_DIGIT, ch)) {
      scripts += `_{${SUBSCRIPT_DIGIT[ch]}}`
      i += 1
      continue
    }
    if (Object.hasOwn(SUPERSCRIPT_CHAR, ch)) {
      let digits = ''
      while (i < body.length && Object.hasOwn(SUPERSCRIPT_CHAR, body[i])) {
        digits += SUPERSCRIPT_CHAR[body[i]]
        i += 1
      }
      scripts += `^{${digits}}`
      continue
    }
    if ((ch === '_' || ch === '^') && main !== '') {
      let j = i + 1
      let sub = ''
      while (j < body.length && IDENT_CHAR.test(body[j]) && body[j] !== '.') {
        sub += body[j]
        j += 1
      }
      if (sub === '') {
        main += ch
        i += 1
        continue
      }
      scripts += ch === '_' ? `_{${mathrmName(sub)}}` : `^{${mathrmName(sub)}}`
      i = j
      continue
    }
    main += ch
    i += 1
  }
  return `${mathrmName(main)}${scripts}${primes}`
}

/** Lean 文本 → token 序列（空白 / 标识符 / 数字 / 运算符）。 */
function tokenize(lean) {
  const tokens = []
  let i = 0
  while (i < lean.length) {
    const ch = lean[i]
    if (/\s/.test(ch)) {
      let j = i
      while (j < lean.length && /\s/.test(lean[j])) j += 1
      tokens.push({ type: 'space' })
      i = j
      continue
    }
    if (IDENT_START.test(ch)) {
      let j = i
      while (j < lean.length && (IDENT_CHAR.test(lean[j]) || Object.hasOwn(SUBSCRIPT_DIGIT, lean[j]) || Object.hasOwn(SUPERSCRIPT_CHAR, lean[j]))) j += 1
      // 结尾的点属于句号而不是名字（Lean 名字里的点只在中间）
      let text = lean.slice(i, j)
      while (text.endsWith('.') && text.length > 1) text = text.slice(0, -1)
      tokens.push({ type: 'ident', latex: renderIdent(text) })
      i += text.length
      continue
    }
    if (/[0-9]/.test(ch)) {
      let j = i
      while (j < lean.length && /[0-9.]/.test(lean[j])) j += 1
      tokens.push({ type: 'ident', latex: lean.slice(i, j) })
      i = j
      continue
    }
    if (ch === '^') {
      // Lean 的幂：`^` 后跟数字或名字 → 真正的上标
      let j = i + 1
      while (j < lean.length && /\s/.test(lean[j])) j += 1
      const number = /^[0-9]+/.exec(lean.slice(j))
      if (number !== null) {
        tokens.push({ type: 'op', latex: `^{${number[0]}}` })
        i = j + number[0].length
        continue
      }
      const name = /^[A-Za-z][A-Za-z0-9_']*/.exec(lean.slice(j))
      if (name !== null) {
        tokens.push({ type: 'op', latex: `^{${renderIdent(name[0])}}` })
        i = j + name[0].length
        continue
      }
      tokens.push({ type: 'op', latex: '\\^{}' })
      i += 1
      continue
    }
    if (Object.hasOwn(SYMBOL_TO_LATEX, ch)) {
      tokens.push({ type: 'op', latex: SYMBOL_TO_LATEX[ch] })
      i += 1
      continue
    }
    tokens.push({ type: 'op', latex: ch })
    i += 1
  }
  return tokens
}

/** 拼回 LaTeX：规则 B 的空白处理 + 控制词后补一个会被吞掉的分隔空格。 */
function renderTokens(tokens) {
  let out = ''
  for (let k = 0; k < tokens.length; k += 1) {
    const token = tokens[k]
    if (token.type === 'space') {
      const prev = tokens[k - 1]
      const next = tokens[k + 1]
      if (prev === undefined || next === undefined) continue
      // 自间距运算符，以及上/下标（必须紧贴前一个原子，`P ^ 2` 不能排成 `P ²`）
      const tight = (t) =>
        t.type === 'op' && (SELF_SPACING.has(t.latex) || t.latex.startsWith('^') || t.latex.startsWith('_'))
      if (tight(prev) || tight(next)) continue
      out += '\\ '
      continue
    }
    // 控制词（\neg 之类）后面必须留一个分隔空格，否则会与下一个 token 粘成未知命令；
    // 这个空格会被 LaTeX 当分隔符吞掉，不产生视觉间距。
    if (/\\[A-Za-z]+$/.test(out) && !token.latex.startsWith(' ')) out += ' '
    out += token.latex
  }
  return out
}

// ── KaTeX 渲染 ───────────────────────────────────────────────────────

/**
 * 渲染一段 LaTeX。
 *
 * **失败不伪装**：`throwOnError: true`，抛错就返回 `{ ok: false }`，
 * 调用方据此回退成等宽原文（见 html.mjs 的 renderLeanMath / renderProse）。
 *
 * @param {string} tex
 * @param {{display?: boolean}} [opts]
 * @returns {{html: string, ok: boolean, error?: string}}
 */
export function renderMath(tex, opts = {}) {
  const display = opts?.display === true
  if (typeof tex !== 'string' || tex.trim() === '') return { html: '', ok: false, error: 'empty tex' }
  try {
    const html = katex.renderToString(tex, { displayMode: display, throwOnError: true })
    return { html, ok: true }
  } catch (error) {
    return { html: '', ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// ── 正文（含 `$…$` / `$$…$$` 数学段）────────────────────────────────

/** 文本节点转义（`&` / `<` / `>`）。 */
export function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * 把一段正文里的 `$…$`（行内）与 `$$…$$`（独立行）交给 KaTeX，其余部分转义后原样输出。
 *
 * 标记里的内容有两种来源，必须分开处理：
 *   - **词典**给的 `informal_description` 本身就是 LaTeX（`$ f : \alpha \to \beta $`），
 *     含反斜杠命令，**原样**交给 KaTeX（再走 Lean 转换会把 `\in` 拆坏）；
 *   - **模型**按 constraints 第 7 条写的行内数学是 Lean 记号（`$P * P = 4 * P$`、`$0 ≤ P$`），
 *     没有反斜杠，先过 `leanToLatex`（`*` → `\cdot`、`≤` → `\le`）再渲染。
 * 判据就是「有没有反斜杠」——真 LaTeX 一定用命令，纯 Lean 记号不会有。
 *
 * 数学无法渲染时回退成**等宽原文**并标 `data-a4m-math="fallback"`：
 * 宁可露出原文，也不要显示渲染错误的公式。
 *
 * @param {string} text
 * @returns {string} HTML 片段
 */
export function renderProse(text) {
  if (typeof text !== 'string' || text === '') return ''
  const out = []
  const pattern = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g
  let last = 0
  let match
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) out.push(escapeHtml(text.slice(last, match.index)))
    const display = match[1] !== undefined
    const raw = (display ? match[1] : match[2]).trim()
    const tex = raw.includes('\\') ? raw : leanToLatex(raw)
    const result = renderMath(tex, { display })
    if (result.ok) {
      const modifier = display ? ' a4m-math--display' : ''
      out.push(`<span class="a4m-math${modifier}" data-a4m-math="katex">${result.html}</span>`)
    } else {
      out.push(`<code class="a4m-math-fallback" data-a4m-math="fallback">${escapeHtml(match[0])}</code>`)
    }
    last = pattern.lastIndex
  }
  if (last < text.length) out.push(escapeHtml(text.slice(last)))
  return out.join('')
}
