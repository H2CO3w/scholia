/**
 * skeleton.mjs — 证明体 → SkeletonTree（纯函数；无 DSH / 无网络 / 无 LLM / 无 fs）
 *
 * 设计依据: docs/SPEC.md §2.1/§2.2、docs/INTERFACES.md §2.3、docs/ARCHITECTURE.md §5.1(b)
 *
 * 三条硬约束:
 *   1. **节点 id 跨调用稳定**（SPEC §2.1）：n0 是根，其余按证明体的 DFS 前序编号 n1,n2,…
 *      锚点直接依赖这条性质（V12），所以 id 只能由「结构位置」决定，不能由出现顺序、
 *      时间戳或哈希决定。嵌套 have 的 parent 是**紧邻的外层 have**（缩进栈），不是恒为 root。
 *   2. **coverage 必须存在且诚实**（SPEC §2.2 / H5）：树退化是常态而不是错误，但绝不静默降级。
 *      两种「不完整」必须分开（task-5 / Q1）：`degraded` 只说结构（没解析出任何中间节点，
 *      树只剩根节点），`truncated` 只说证明体被数据集截断（已找到的步骤照常可用）。
 *      混成一个布尔会让 annotate_prepare 对着结构完好的树误判为「无法做步骤注解」。
 *   3. **declIndex / hypothesisIndex 不再挂在树上**（INTERFACES §2.4）：需要时由 anchor.mjs
 *      遍历 skeleton.nodes 现算，避免两处索引与 nodes 不同步。
 *   4. **陈述未知必须外显**（SPEC §2.1b，v1.3）：`have h := 项` 无法恢复类型，签名保持空串，
 *      用 signatureUnknown / rawText / typeFingerprint=null / coverage.signatureMissingCount 标出来。
 *      `fingerprint('')` 是常数，会让所有空签名节点共享同一指纹、使防漂移机制完全失效。
 *
 * 分层约束: L1（只允许 node:crypto，纯计算）、L4（枚举一律取自 enums.mjs）。
 *
 * 诚实性说明 —— 这是**启发式结构提示**，不是 Lean 解析器:
 *   - 语料 value 字段硬截断在 500 字符，且可能被简化；它只用来提示结构，不是真值源。
 *   - have 的类型与作用域用「缩进栈 + 括号深度」推断；极端排版（同一行叠多个声明、
 *     tab 与空格混用、`«带空格的标识符»`）会退化，退化结果一定反映在
 *     coverage.degraded / degradeReason 与 node.truncated 上，而不是装作成功。
 */

import { createHash } from 'node:crypto'

import {
  NODE_KIND,
  NODE_KIND_VALUES,
  PROOF_MODE,
  SOURCE,
  SOURCE_VALUES,
  allowedHint,
  isEnumValue,
} from './enums.mjs'

// ── 常量 ──────────────────────────────────────────────────────────────

/** SPEC §2.1：数据集 value 字段的截断长度 */
export const VALUE_TRUNCATION_LIMIT = 500

/** 留出余量：长度达到此值即视为「疑似被截断」（SPEC H3 / ARCHITECTURE §5.1(b)） */
export const TRUNCATION_SUSPECT_THRESHOLD = 490

/** 末尾省略号也算截断（数据集在切点后补三个点） */
const TRAILING_ELLIPSIS_RE = /(?:\.\.\.|⋯)\s*$/

/**
 * 一条 have 声明的类型/赋值最多跨几行去找。超过即认为排版异常，
 * 退化为「取第一行剩余部分」而不是继续吞掉后面的证明体。
 */
const MAX_DECL_LOOKAHEAD_LINES = 6

// ── 字符类（Lean 标识符的近似）────────────────────────────────────────

const IDENT_START = 'A-Za-z_\\u00C0-\\u024F\\u0370-\\u03FF\\u1F00-\\u1FFF'
const IDENT_PART = `${IDENT_START}\\w'!?\\u2080-\\u2089`

const IDENT_AT = new RegExp(`[${IDENT_START}][${IDENT_PART}]*`, 'y')
/** 整段就是一个标识符 */
const IDENT_ONLY_RE = new RegExp(`^[${IDENT_START}][${IDENT_PART}]*$`)
/** 行首的 have 关键字（排除 haveI / haveThis 之类的其他关键字） */
const HAVE_LINE_RE = new RegExp(`^have(?![${IDENT_PART}])`)
/** 证明体是不是 tactic 模式：`by …` 或 `:= by …`（排除 by_cases 这类名字） */
const TACTIC_BODY_RE = new RegExp(`^(?::=\\s*)?by(?![${IDENT_PART}])`)

const OPEN_BRACKETS = new Set(['(', '[', '{', '⟨', '⦃'])
const CLOSE_BRACKETS = new Set([')', ']', '}', '⟩', '⦄'])

/** 限定名（至少一段点号）。用于 lemma_refs：概念查询的输入。 */
const QUALIFIED_NAME_RE = new RegExp(
  `(?<![\\w'.])(?:_root_\\.)?`
  + `([${IDENT_START}][${IDENT_PART}]*(?:\\.[${IDENT_START}][${IDENT_PART}]*)+)`,
  'g',
)

/**
 * iff 方向投影的后缀段。真实语料里 `Asymptotics.isBigO_iff.mp` 指的是引理
 * `Asymptotics.isBigO_iff` 的 `.mp` 字段，词典里只有前者；不做这一步规整，
 * 每条这样的引用都会变成一次注定失败的查询。
 * 只对 **3 段及以上**的名字生效，因此 `Iff.mp` 这类本身就是环境里全名的两段式
 * 引用不会被误改。
 */
const PROJECTION_TAIL = new Set(['mp', 'mpr'])

function canonicalLemmaName(name) {
  const parts = name.split('.')
  if (parts.length >= 3 && PROJECTION_TAIL.has(parts[parts.length - 1])) {
    return parts.slice(0, -1).join('.')
  }
  return name
}

// ── 基础工具 ──────────────────────────────────────────────────────────

function asString(value) {
  return value === null || value === undefined ? '' : String(value)
}

/** 归一化后哈希：跨 Mathlib 版本比对锚点漂移（SPEC §8.1） */
export function fingerprint(text) {
  const normalized = asString(text).replace(/\s+/g, ' ').trim()
  return `sha256:${createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16)}`
}

/**
 * 证明体是否被数据集截断（长度达标或结尾省略号）。
 * 阈值 490 < VALUE_TRUNCATION_LIMIT(500)，所以「长度到过数据集切点」必然已被覆盖；
 * 留 10 字符余量是刻意保守：宁可疑心截断，也不要让残缺的证明体看起来完整（H3/H5）。
 */
function isTruncatedValue(value) {
  const text = asString(value)
  return text.length >= TRUNCATION_SUSPECT_THRESHOLD || TRAILING_ELLIPSIS_RE.test(text)
}

function readIdentAt(text, index) {
  IDENT_AT.lastIndex = index
  const match = IDENT_AT.exec(text)
  if (!match) return null
  return { name: match[0], end: index + match[0].length }
}

function measureIndent(line) {
  let i = 0
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i += 1
  return i
}

/**
 * 把注释与字符串字面量替换成等长空格（保留换行与全部偏移）。
 *
 * 为什么要掩码而不是删除：偏移必须与原串一一对应 —— 结构判定在掩码串上做，
 * 签名文本仍然从原串按同一偏移切出来，这样 `have h : s = "abc" := …` 的
 * 签名不会因为掩码而丢内容。
 *
 * 已知近似：`'` 在 Lean 里既可能是字符字面量也可能是标识符的一部分（如 idem'），
 * 因此只掩码双引号字符串，不碰单引号。
 */
function maskComments(text) {
  const src = asString(text)
  if (src === '') return ''
  const out = src.split('')
  let i = 0
  while (i < out.length) {
    const c = out[i]
    // 行注释
    if (c === '-' && out[i + 1] === '-') {
      while (i < out.length && out[i] !== '\n') {
        out[i] = ' '
        i += 1
      }
      continue
    }
    // 块注释（Lean 允许嵌套）
    if (c === '/' && out[i + 1] === '-') {
      let depth = 0
      while (i < out.length) {
        if (out[i] === '/' && out[i + 1] === '-') {
          depth += 1
          out[i] = ' '
          out[i + 1] = ' '
          i += 2
          continue
        }
        if (out[i] === '-' && out[i + 1] === '/') {
          depth -= 1
          out[i] = ' '
          out[i + 1] = ' '
          i += 2
          if (depth <= 0) break
          continue
        }
        if (out[i] !== '\n') out[i] = ' '
        i += 1
      }
      continue
    }
    // 双引号字符串
    if (c === '"') {
      out[i] = ' '
      i += 1
      while (i < out.length) {
        if (out[i] === '\\') {
          out[i] = ' '
          i += 1
          if (i < out.length) {
            out[i] = ' '
            i += 1
          }
          continue
        }
        if (out[i] === '"') {
          out[i] = ' '
          i += 1
          break
        }
        if (out[i] !== '\n') out[i] = ' '
        i += 1
      }
      continue
    }
    i += 1
  }
  return out.join('')
}

/**
 * 从 from 起在**括号深度 0** 处寻找 token（':' 或 ':='）。
 * @returns {number|null} 命中的下标；越界或超过行数上限则返回 null
 */
function findTopLevel(text, from, token, maxLines) {
  let depth = 0
  let lines = 0
  for (let i = from; i < text.length; i += 1) {
    const c = text[i]
    if (c === '\n') {
      lines += 1
      if (maxLines !== null && lines > maxLines) return null
      continue
    }
    if (OPEN_BRACKETS.has(c)) {
      depth += 1
      continue
    }
    if (CLOSE_BRACKETS.has(c)) {
      if (depth > 0) depth -= 1
      continue
    }
    if (depth === 0 && text.startsWith(token, i)) return i
  }
  return null
}

// ── 假设名 ────────────────────────────────────────────────────────────

/**
 * 从 signature 提取局部假设/变量名（SPEC §2.1 的 hypotheses）。
 *
 * 三段式与既有实现一致（圆括号绑定 → 花括号隐式绑定 → 方括号实例绑定），
 * 返回数组（INTERFACES §2.3 的冻结签名），顺序 = 三段扫描顺序，去重。
 *
 * @param {string} signature
 * @returns {string[]}
 */
export function extractHypotheses(signature) {
  const out = new Set()
  const sig = asString(signature)
  const isName = (token) => IDENT_ONLY_RE.test(token)
  const addAll = (body, skipFirst) => {
    const tokens = body.trim().split(/\s+/).filter(Boolean)
    for (const token of skipFirst ? tokens.slice(1) : tokens) {
      if (isName(token)) out.add(token)
    }
  }
  for (const m of sig.matchAll(/\(([^()]*?)\s*:\s*[^()]*?\)/g)) addAll(m[1], false)
  for (const m of sig.matchAll(/\{([^{}]*?)\s*:\s*[^{}]*?\}/g)) addAll(m[1], false)
  for (const m of sig.matchAll(/\[([^\][]+)\]/g)) addAll(m[1], true)
  return [...out]
}

// ── 证明体形态 ────────────────────────────────────────────────────────

function isTacticBody(masked) {
  return TACTIC_BODY_RE.test(masked.trimStart())
}

/**
 * 文本里是否存在**顶层**（括号深度 0）的冒号。
 * 用于判断 have 是否写了类型标注：`(s : ℝ) := e` 的冒号在括号里，属于绑定，不是类型分隔符。
 */
function hasTopLevelColon(text) {
  let depth = 0
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    if (OPEN_BRACKETS.has(c)) depth += 1
    else if (CLOSE_BRACKETS.has(c)) { if (depth > 0) depth -= 1 }
    else if (c === ':' && depth === 0) return true
  }
  return false
}

/** offset 所在行的行尾（不含换行符） */
function endOfLineAt(text, offset) {
  const nl = text.indexOf('\n', offset)
  return nl < 0 ? text.length : nl
}

/**
 * 解析一条 have 声明：`have <名字>? <绑定…>? : <类型> := <证明>`
 * 也接受 `have : <类型> := …`（匿名）与 `have <名字> := …`（类型省略）。
 *
 * **签名口径（SPEC §2.1b，v1.3）**：取「名字与顶层 `:=` 之间的原文」，因此
 *   `have hd (s : ℝ) : HasDerivAt f x := by …` 的签名是 `(s : ℝ) : HasDerivAt f x` ——
 * 绑定前缀必须保留，否则命题从 `∀ s, …` 退化成 `…`，**被削弱却看着完全正常**。
 * 不做 `∀` 合成，只保证不丢东西。
 *
 * **类型省略**（`have h := 项`）：签名保持空串，置 signatureUnknown=true，
 * 逐字原文放进 rawText（供下游在陈述未知时仍有材料）。**不猜类型**。
 *
 * @returns {{localName: string, signature: string, signatureUnknown: boolean,
 *            rawText: string, declEnd: number}|null}
 */
function parseHaveAt(source, masked, haveStart, firstLineEnd) {
  let i = haveStart + 4 // 跳过 have 关键字本身（4 个字符）
  while (i < masked.length && (masked[i] === ' ' || masked[i] === '\t')) i += 1

  let localName = ''
  const ident = readIdentAt(masked, i)
  if (ident) {
    localName = ident.name
    i = ident.end
  }

  const assign = findTopLevel(masked, i, ':=', MAX_DECL_LOOKAHEAD_LINES)
  let declText
  let declEnd
  let rawEnd
  if (assign !== null) {
    declText = asString(source.slice(i, assign))
    declEnd = assign + 2
    rawEnd = endOfLineAt(source, assign)
  } else {
    // 兜底：窗口内没有顶层 `:=`（多半是记录被 500 字符截断）。
    // 同一行还有顶层冒号时按残缺声明收下；完全没有冒号说明这不是一条可解析的声明，
    // 维持「跳过」语义，避免凭空多出节点。
    if (findTopLevel(masked, i, ':', 0) === null) return null
    declText = asString(source.slice(i, firstLineEnd))
    declEnd = firstLineEnd
    rawEnd = firstLineEnd
  }

  const normalized = declText.replace(/\s+/g, ' ').trim()
  // 有绑定前缀时原文形如 `(s : ℝ) : T`；没有绑定时形如 `: T` —— 去掉开头这个分隔冒号，
  // 两种情形都保留「名字与 := 之间的全部内容」。
  const signature = normalized.startsWith(':') ? normalized.slice(1).trim() : normalized
  const signatureUnknown = !hasTopLevelColon(normalized) || signature === ''

  return {
    localName,
    signature: signatureUnknown ? '' : signature,
    signatureUnknown,
    rawText: asString(source.slice(haveStart, rawEnd)).trim(),
    declEnd,
  }
}

/**
 * 内部：解析证明体里全部 have 声明，并给出 parent 与 depth。
 *
 * 嵌套判定用**所有非空行**的缩进栈（不是只拿 have 行比大小）：
 * 任何缩进更深的行都会开一个新作用域层，这样
 *   `have h₁ := by simp` 结束后，后续同样缩进或更浅的 have 会正确回到外层，
 * 而只有真正落在某个 have 作用域内的 have 才会认它当 parent。
 *
 * @returns {{supported: boolean, decls: object[]}}
 */
function parseHaveDecls(proofText) {
  const source = asString(proofText)
  const masked = maskComments(source)
  if (!isTacticBody(masked)) return { supported: false, decls: [] }

  const decls = []
  const scope = [] // { indent, declIndex|null, depth|null }
  const lines = masked.split('\n')
  let lineStart = 0
  for (let li = 0; li < lines.length; li += 1) {
    const maskedLine = lines[li]
    const start = lineStart
    lineStart += maskedLine.length + 1
    if (maskedLine.trim().length === 0) continue

    const indent = measureIndent(maskedLine)
    const content = maskedLine.slice(indent)
    while (scope.length > 0 && scope[scope.length - 1].indent >= indent) scope.pop()

    // 聚焦子弹 `· have h : …` 是 Mathlib 里常见的写法，子弹后面的声明本身没变
    const bullet = /^(?:·+\s*)/.exec(content)
    const bulletLen = bullet ? bullet[0].length : 0
    if (HAVE_LINE_RE.test(content.slice(bulletLen))) {
      const decl = parseHaveAt(source, masked, start + indent + bulletLen, start + maskedLine.length)
      if (decl !== null) {
        let parentScope = -1
        for (let s = scope.length - 1; s >= 0; s -= 1) {
          if (scope[s].declIndex !== null) {
            parentScope = s
            break
          }
        }
        decls.push({
          ...decl,
          line: li,
          lineStart: start,
          indent,
          parentIndex: parentScope >= 0 ? scope[parentScope].declIndex : null,
          depth: parentScope >= 0 ? scope[parentScope].depth + 1 : 0,
        })
        scope.push({ indent, declIndex: decls.length - 1, depth: decls[decls.length - 1].depth })
        continue
      }
    }
    scope.push({ indent, declIndex: null, depth: null })
  }
  return { supported: true, decls }
}

/**
 * 从 tactic 证明体提取 have 子目标（SPEC §2.1 的 have 节点来源）。
 *
 * ★ **隐含前提（v1.3 写进文档）**：输入必须是**以 `:= by` 或 `by` 开头的证明体**，
 *   不是整个 .lean 文件、也不是定理签名。喂进别的东西**不会**抛错，而是返回
 *   `supported: false` —— 上一轮就是因为它静默返回空结果，测量时反复得出
 *   0 / 42 / 0 三个互相矛盾的结论。现在用 `reason` 明确区分：
 *     - `reason: 'empty-input'`   输入为空/全空白
 *     - `reason: 'not-tactic-body'` 非空，但不以 `:= by` / `by` 开头（多半喂错了东西）
 *     - `reason: null`            确实是 tactic 体；此时 `bindings` 为空是**真实结论**
 *       （这个证明体里没有 have），不是失败。
 *
 * - 匿名 have 的 `localName` 是空字符串：不发明源码里不存在的标识符。
 * - `signatureUnknown=true` 表示源码省略了类型标注（`have h := 项`），此时 `signature` 为
 *   空串（SPEC §2.1b：不猜类型），节点上另有 rawText 保存逐字原文。
 * - `signature` 保留绑定前缀（`(s : ℝ) : T`），见 parseHaveAt。
 * - `depth` = 外层 have 的层数（最外层为 0），可用于展示层级。
 *
 * @param {string} proofText 以 `:= by` / `by` 开头的 tactic 证明体
 * @returns {{supported: boolean, reason: string|null,
 *            bindings: {localName: string, signature: string, depth: number,
 *                       signatureUnknown: boolean}[]}}
 */
export function extractHaveBindings(proofText) {
  const text = asString(proofText)
  const { supported, decls } = parseHaveDecls(text)
  const reason = supported ? null : (text.trim() === '' ? 'empty-input' : 'not-tactic-body')
  return {
    supported,
    reason,
    bindings: decls.map((d) => ({
      localName: d.localName,
      signature: d.signature,
      depth: d.depth,
      signatureUnknown: d.signatureUnknown,
    })),
  }
}

/**
 * 判定证明体形态并给出**诚实**的退化说明（SPEC §2.2 / H5）。
 *
 * ★ 两个正交信号（task-5 / Q1 的裁定）：
 *   - `degraded` 只表示**结构性退化**：一个中间节点都没解析出来（haveCount === 0）。
 *     failed / term / 单行 tactic / 多行但无 have 都属于这一类，此时树只剩根节点。
 *   - `truncated` 表示证明体被数据集截断：已解析出的步骤照常可用，只是不能声称完整。
 *     截断**不再**单独置 degraded —— 否则结构完好的树会被 annotate_prepare 误判为
 *     「无法做步骤注解」，覆盖率信号就失去决策价值了。
 *   两者可以同时为真（例如被截断的单行 tactic）。
 *
 * `degradeReason` 仅在 degraded=true 时非空；截断的说明在 `truncateReason`（truncated=true 时非空）。
 * 每个 reason 都带「模型该怎么办」，而不是裸原因。
 *
 * @param {string} value 语料记录的 value 字段（含前导 `:=`）
 * @returns {{mode: string, degraded: boolean, degradeReason: string|null, haveCount: number,
 *            truncated: boolean, truncateReason: string|null, signatureMissingCount: number}}
 */
export function classifyProof(value) {
  return classifyParsed(asString(value), parseHaveDecls(value))
}

function classifyParsed(text, parsed) {
  const haveCount = parsed.supported ? parsed.decls.length : 0
  const truncated = text.length > 0 && isTruncatedValue(text)
  let mode
  let degradeReason = null

  if (text.trim() === '') {
    mode = PROOF_MODE.FAILED
    degradeReason = '证明体为空，无法建树（definition / inductive 等记录通常没有 value）；'
      + '请改用能提供证明体的定理记录'
  } else if (!parsed.supported) {
    mode = PROOF_MODE.TERM
    degradeReason = '项模式证明体：一期只解析 tactic 模式，树退化为根节点；'
      + '请只做陈述级注解，不要假装它有步骤结构'
  } else if (haveCount > 0) {
    mode = PROOF_MODE.TACTIC_MULTILINE
  } else if (text.includes('\n')) {
    mode = PROOF_MODE.TACTIC_MULTILINE
    degradeReason = '多行 tactic 证明体中没有 have 子目标，树退化为根节点；'
      + '请把注解降级为对陈述本身的说明'
  } else {
    mode = PROOF_MODE.TACTIC_SINGLE
    degradeReason = '单行 tactic 证明体没有 have 子目标，树退化为根节点；'
      + '请把注解降级为对陈述本身的说明'
  }

  // 结构性退化 = 一个中间节点都没有（上面每条分支的 haveCount 都是 0）
  const degraded = haveCount === 0
  if (degraded && degradeReason === null) {
    degradeReason = '树退化为根节点；请把注解降级为对陈述本身的说明'
  }

  const truncateReason = truncated
    ? `证明体被数据集截断（长度 ${text.length}，或结尾省略号），have 子目标可能不完整；`
      + (haveCount > 0
        ? `已解析出的 ${haveCount} 个步骤照常做步骤级注解，但不要声称覆盖完整`
        : '请只对根节点做陈述级注解')
    : null

  // 类型标注被省略的 have 数（SPEC §2.1b）。它们签名恒为空、指纹为 null，
  // 规模必须可见，否则「约四分之一节点没有陈述」这件事没人知道。
  const signatureMissingCount = parsed.decls.filter((d) => d.signatureUnknown).length

  return { mode, degraded, degradeReason, haveCount, truncated, truncateReason, signatureMissingCount }
}

// ── 引理引用 ──────────────────────────────────────────────────────────

/**
 * 从节点体内抽取限定引理名（SPEC §2.1 的 lemma_refs，概念查询的输入）。
 *
 * 只取**至少一段点号**的限定名：词典按全限定名索引，非限定名（simp、exact 之类）
 * 无法可靠查询，收进来只会污染 missing[]。
 * 首段长度 ≥3 用于剔掉字段投影（`T.A₀_inv`、`hx.mp` 这类变量上的访问），
 * 这是启发式：宁可漏，不要把变量名当引理去查（T2 要求未命中显式返回，
 * 所以误报不会静默，但会白占配额）。
 *
 * @param {string} nodeBody
 * @returns {string[]} 首次出现顺序，去重
 */
export function extractLemmaRefs(nodeBody) {
  const out = []
  const seen = new Set()
  for (const m of asString(nodeBody).matchAll(QUALIFIED_NAME_RE)) {
    const name = canonicalLemmaName(m[1])
    if (name.split('.')[0].length < 3) continue
    if (seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

// ── 骨架树 ────────────────────────────────────────────────────────────

/** DFS 前序编号：n0 是根，其余 n1,n2,… */
function assignIds(decls) {
  const children = new Map()
  decls.forEach((d, i) => {
    const key = d.parentIndex
    const bucket = children.get(key)
    if (bucket) bucket.push(i)
    else children.set(key, [i])
  })
  const ids = new Array(decls.length).fill(null)
  const order = []
  let counter = 0
  const visit = (key) => {
    for (const index of children.get(key) ?? []) {
      counter += 1
      ids[index] = `n${counter}`
      order.push(index)
      visit(index)
    }
  }
  visit(null)
  return { ids, order }
}

/** 该 have 的作用域终点：下一个 depth 不大于它的声明行首，否则到证明体末尾 */
function scopeEnd(decls, index, total) {
  const d = decls[index]
  for (let j = index + 1; j < decls.length; j += 1) {
    if (decls[j].depth <= d.depth) return decls[j].lineStart
  }
  return total
}

/**
 * 数据集声明种类 → E-KIND 枚举值的**显式归一化表**。
 *
 * 来源：`data/lsv2.jsonl` 全量 310,579 条记录的 `kind` 实测取值 ——
 *   theorem 218,365 / definition 52,792 / instance 24,680 / constructor 4,508 /
 *   recursor 3,597 / inductive 3,591 / abbrev 2,822 / opaque 218 / classInductive 6
 * 除 `classInductive` 外全部与枚举值同名（枚举值统一 snake_case，SPEC §1.1），
 * 因此只有它需要一条别名；同名的那些靠 NODE_KIND_VALUES 判定，不在这里重复写字面量。
 *
 * 键是**数据集原值**（数据，不是枚举），值是枚举成员引用 —— 既保持 L4 干净，
 * 也让口径缺口一眼可见：表里没有、闭集里也没有的值不会被悄悄改写成 theorem。
 */
const DECL_KIND_ALIASES = Object.freeze({
  classInductive: NODE_KIND.CLASS_INDUCTIVE,
})

/** 记录完全没有 kind 字段时的回落值（**必须**配 kindUnknown 标记，见下） */
const MISSING_KIND_FALLBACK = NODE_KIND.THEOREM

/**
 * @param {unknown} raw 数据集原始 kind
 * @returns {{kind: string, unknown: boolean}} unknown=true 表示口径缺口，调用方必须外显
 */
function normalizeDeclKind(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { kind: MISSING_KIND_FALLBACK, unknown: true }
  }
  const value = raw.trim()
  if (Object.prototype.hasOwnProperty.call(DECL_KIND_ALIASES, value)) {
    return { kind: DECL_KIND_ALIASES[value], unknown: false }
  }
  if (isEnumValue(NODE_KIND_VALUES, value)) return { kind: value, unknown: false }
  // 未知种类：原样保留，不伪装成 theorem
  return { kind: value, unknown: true }
}

/**
 * 一条语料记录 → SkeletonTree（SPEC §2.2 形状，字段为 JS 侧 camelCase）。
 *
 * @param {object} record 语料记录（含 name / kind / signature / value）
 * @param {{origin?: string}} [opts] origin 取 E-SOURCE 之一，默认 lsv2
 * @returns {{theorem: string, root: string, nodes: object, coverage: object}}
 */
export function recordToSkeleton(record, opts = {}) {
  const rec = record ?? {}
  const names = Array.isArray(rec.name) ? rec.name : [rec.name]
  const theorem = names.filter((part) => typeof part === 'string' && part !== '').join('.')
  if (theorem === '') {
    throw new Error('record 缺少 name，无法构造骨架树；请确认语料记录的 name 字段（数组或字符串）非空')
  }

  const origin = opts.origin ?? SOURCE.LSV2
  if (!isEnumValue(SOURCE_VALUES, origin)) {
    throw new Error(`opts.origin 取值非法: ${JSON.stringify(origin)}；合法值为 ${allowedHint(SOURCE_VALUES)}`)
  }

  const signature = asString(rec.signature ?? rec.type)
  const value = asString(rec.value)
  const truncated = isTruncatedValue(value)
  const parsed = parseHaveDecls(value)
  const coverageInfo = classifyParsed(value, parsed)
  const declKind = normalizeDeclKind(rec.kind)

  const rootId = 'n0'
  const nodes = {}
  // 根节点的类型来自数据集 signature 字段；它为空时同样属于「陈述未知」，
  // 一律 fingerprint(null)（SPEC §2.1b），绝不用 fingerprint('') 这个常数。
  const rootSignatureUnknown = signature === ''
  nodes[rootId] = {
    id: rootId,
    decl: theorem,
    kind: declKind.kind,
    // 口径缺口外显：未知种类保留原值 + 这个标记，绝不静默改写成 theorem（诚实性约束）
    ...(declKind.unknown ? { kindUnknown: true } : {}),
    signature,
    ...(rootSignatureUnknown ? { signatureUnknown: true } : {}),
    typeFingerprint: rootSignatureUnknown ? null : fingerprint(signature),
    hypotheses: extractHypotheses(signature),
    parent: null,
    lemmaRefs: extractLemmaRefs(value),
    source: origin,
    truncated,
  }

  const { ids, order } = assignIds(parsed.decls)
  for (const index of order) {
    const decl = parsed.decls[index]
    const id = ids[index]
    nodes[id] = {
      id,
      decl: null,
      kind: NODE_KIND.HAVE,
      signature: decl.signature,
      // ★ 类型省略时指纹必须为 null：fingerprint('') 是常数，会让所有空签名节点
      //   共享同一指纹，防漂移机制对它们**完全失效**（SPEC §2.1b）。
      ...(decl.signatureUnknown ? { signatureUnknown: true, rawText: decl.rawText } : {}),
      typeFingerprint: decl.signatureUnknown ? null : fingerprint(decl.signature),
      hypotheses: extractHypotheses(decl.signature),
      // 局部名让 hyp 锚点能指到 have（anchor.mjs 的解析语义，v1.3）
      ...(decl.localName === '' ? {} : { localName: decl.localName }),
      parent: decl.parentIndex === null ? rootId : ids[decl.parentIndex],
      lemmaRefs: extractLemmaRefs(value.slice(decl.lineStart, scopeEnd(parsed.decls, index, value.length))),
      source: origin,
      truncated,
    }
  }

  const nodeCount = Object.keys(nodes).length
  const signatureMissingCount = Object.values(nodes)
    .filter((node) => node.signatureUnknown === true).length
  return {
    theorem,
    root: rootId,
    nodes,
    coverage: {
      mode: coverageInfo.mode,
      haveCount: parsed.decls.length,
      nodeCount,
      // 截断与结构退化是两个正交事实：前者说「证明体不完整」，后者说「树没结构」。
      // annotate_prepare 对二者的应对不同（截断→步骤照常注解但不声称完整；结构退化→降级为陈述说明）。
      truncated: coverageInfo.truncated,
      degraded: coverageInfo.degraded,
      degradeReason: coverageInfo.degradeReason,
      truncateReason: coverageInfo.truncateReason,
      // 第 8 个字段（v1.3）：签名未知的节点数，让「约四分之一节点没有陈述」可见
      signatureMissingCount,
    },
  }
}

/**
 * 往返评测的样本池准入（SPEC H3 / ARCHITECTURE §5.2）。
 *
 * ★ 判定语义**刻意保持不变**（pilot/report-m1.md 的 67,175 / 5,691 两个数字
 *   由它算出）：kind 为定理、value 非空、长度 < 490、且以 `:= by` 开头。
 *   注意它与 node.truncated 的判定**不是同一个**：后者还看结尾省略号，
 *   因为这关系到「树的结构是否可能缺失」，而样本池只关心证明体是否完整可读。
 *
 * @param {object} record
 * @returns {boolean}
 */
export function isEvaluationSafe(record) {
  const rec = record ?? {}
  if (rec.kind !== NODE_KIND.THEOREM) return false
  const value = asString(rec.value)
  const trimmed = value.trim()
  if (trimmed.length === 0) return false
  if (value.length >= TRUNCATION_SUSPECT_THRESHOLD) return false
  return trimmed.startsWith(':= by')
}
