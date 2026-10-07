/**
 * annotate-prepare.mjs — `annotate_prepare`：产出一个节点的**结构化工作单**
 *
 * 依据：SPEC §6.3（核心接口）、§7.4（提示词六条）；ARCHITECTURE §5.1(c)（三段式）。
 *
 * ★ 工具内部**绝不调用 LLM**（对 v2.1 原设计的刻意推翻，理由见 ARCHITECTURE §4/§5.1(c)）：
 *   工具内调 LLM 会让中间产物进不了会话日志、成本不可见、无法复现。
 *   本工具只做机械的事：读骨架 + 查词典 + 组装工作单。生成注解是 agent 自己的活。
 *
 * ★ 逐节点调用：`node_id` 是**输入**而不是模型的输出，从结构上排除锚点错位。
 *
 * 输出为 snake_case（SPEC §1.1：工具输出字段与落盘契约同构），
 * 由 src/io/contract.mjs 的 toSnake 在边界处一次性转换（L5）。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import {
  ANCHOR_KIND,
  AUDIENCE_VALUES,
  CULTURE,
  EVIDENCE_VALUES,
  FORM,
  FORM_VALUES,
  LENGTH_LIMIT,
  NODE_KIND,
  PRESENTATION_VALUES,
  ROLE,
  ROLE_DEFAULT_HEIGHT,
  ROLE_ORDER,
  ROLE_VALUES,
  SEGMENT_KIND,
  SEGMENT_KIND_VALUES,
  SIGNIFICANCE_VALUES,
  SPEC_VERSION,
  THEOREM_LEVEL_ROLES,
  VALUE_TYPE,
  allowedHint,
} from '../core/enums.mjs'
import { shapeEntries } from '../core/lexicon.mjs'
import { readSkeleton } from '../io/artifacts.mjs'
import { toCamel, toSnake } from '../io/contract.mjs'
import { ensureLexiconIndex, lookupLemma } from '../io/index-db.mjs'
import path from 'node:path'

/** scope 取值：`theorem`（定理级，锚点指向 root）/ `step`（单节点步骤注解）。 */
const SCOPE = Object.freeze({ THEOREM: NODE_KIND.THEOREM, STEP: ROLE.STEP })
const SCOPE_VALUES = Object.freeze([SCOPE.THEOREM, SCOPE.STEP])

/** 工作单里 statement.source_excerpt 的最大长度（骨架不保存原始证明体，见下方说明）。 */
const EXCERPT_CHARS = 400

/**
 * SPEC §7.4 六条硬约束（原文；仅去掉 markdown 记号，枚举值从 enums.mjs 插值以免内联字面量）。
 * 第 1–6 条是 SPEC §7.4 的六条；第 7 条是渲染层要求（见下方注释）。
 * 第 4 条是防编造的唯一有效手段，任何一版实现都必须保留。
 */
const CONSTRAINTS = Object.freeze([
  '1. 引导模型回答「读者读完这句，脑子里多出什么可以拿到别处用的东西？」；只复述「把 X 变成 Y」的要求重写。',
  '2. 引理语义只允许使用 lexicon 段给出的内容，禁止臆造；missing 里的名字说明词典未命中，不许替它编含义。',
  `3. 必须标注 value_type；纯技术操作标 ${VALUE_TYPE.TECHNICAL} 并一句话说完。`,
  `4. 明确允许 value_type = ${JSON.stringify(VALUE_TYPE.NONE)}（「这一步没有可提炼的思路」）——不许编。`,
  '5. 遵守 length_limit，超限重写而不是截断（V9 会拒绝超限提交）。',
  '6. 只在 style_examples 命中时注入风格范例；为 null 时不要硬套。',
  // 第 7 条（渲染层要求）：KaTeX 只在 $…$ / $$…$$ 标记处排版；渲染器不猜散文里
  // 哪一段是数学（猜错的代价更大），所以靠这条引导模型把标记写出来。
  '7. 注解正文里的行内数学请写成 $…$（独立成行的公式用 $$…$$），例如 $P * P = 4 * P$；'
    + '没有标记的片段会按散文原样显示，数学符号不会被排版。',
])

/**
 * 四种注解形态的风格范例（E-FORM，SPEC §3.3）。
 * 形态只影响**风格与组织方式**，不改变任何字段的必填性；范例是文体样本，不是数学内容。
 */
const STYLE_EXAMPLES = Object.freeze({
  [FORM.THE_BOOK]: Object.freeze([
    Object.freeze({ label: '最优呈现', exemplar: '把这一步写成「读完之后你手里多出的那件工具」，而不是「先做 A 再做 B」。', note: 'The Book：假设证明已是同类中最优，注解负责说明它为何是。' }),
  ]),
  [FORM.CONRAD]: Object.freeze([
    Object.freeze({ label: '技术动机', exemplar: '先点明「为什么必须在这里引入这个对象」，再给出它做了什么。', note: 'Conrad：强调定义与构造的动机链条。' }),
  ]),
  [FORM.ZAGIER]: Object.freeze([
    Object.freeze({ label: '一句话证明', exemplar: '用一句话说清这一步的枢纽，其余交给公式。', note: 'Zagier：凝练到只剩必要信息。' }),
  ]),
  [FORM.THURSTON]: Object.freeze([
    Object.freeze({ label: '心智模型', exemplar: '先给读者一个可以携带到别处的图像，再落到这一步的具体操作。', note: 'Thurston：优先安装直觉模型，形式细节次之。' }),
  ]),
})

/** 文化取向的弱代理（A2：module_name 覆盖率有限，只作为 hint，不作为字段默认值）。 */
const CULTURE_MODULE_HINTS = Object.freeze({
  [CULTURE.THEORY]: ['CategoryTheory', 'Logic', 'ModelTheory', 'SetTheory', 'Algebra', 'Order', 'GroupTheory', 'RingTheory', 'FieldTheory', 'LinearAlgebra', 'RepresentationTheory'],
  [CULTURE.PROBLEM]: ['NumberTheory', 'Combinatorics', 'Analysis', 'Topology', 'MeasureTheory', 'Probability', 'Geometry', 'Dynamics', 'GraphTheory'],
})

/** 一个工作单能内联的词典条数上限（超出不内联，指向 concept_lookup）。 */
const DEFAULT_MAX_LEXICON_ENTRIES = 6
/** 单条词典描述的截断长度。 */
const DEFAULT_DESCRIPTION_CHARS = 600

/** 参数错误：消息必须带修复动作（T8 / SPEC §4.1）。 */
function fail(message) {
  throw new Error(message)
}

/** 校验 theorem_name：非空字符串。 */
function requireTheoremName(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail('theorem_name 必须是非空的 Lean 全限定名，例如 "Mathlib.Algebra.Group.Even.add"；请填写声明名后重试。')
  }
  return value.trim()
}

/** 由词典条目的 module 判定文化取向 hint（弱代理，未命中返回 null）。 */
function cultureHint(entries) {
  for (const entry of entries) {
    const module = entry?.module
    if (typeof module !== 'string' || module === '') continue
    for (const [culture, keywords] of Object.entries(CULTURE_MODULE_HINTS)) {
      if (keywords.some((keyword) => module.includes(keyword))) {
        return { culture, module, basis: 'module_name 关键词匹配（覆盖率有限，见 ARCHITECTURE A2）' }
      }
    }
  }
  return null
}

/** 从目标节点沿 parent 上溯到 root（不含自身），顺序为 root → 父节点。 */
function parentChain(skeleton, nodeId) {
  const nodes = skeleton.nodes ?? {}
  const chain = []
  const seen = new Set([nodeId])
  let cursor = nodes[nodeId]?.parent
  while (typeof cursor === 'string' && nodes[cursor] && !seen.has(cursor)) {
    seen.add(cursor)
    chain.push({ id: cursor, kind: nodes[cursor].kind ?? null, signature: nodes[cursor].signature ?? null })
    cursor = nodes[cursor].parent
  }
  return chain.reverse()
}

/**
 * 把骨架覆盖率拆成「工作单里的 coverage 段」+「给模型的应对说明」。
 *
 * task-5 把两种「不完整」分开了，处置策略不同，不能混成一句话：
 *   - `degraded`（have_count=0，树只剩根节点）⇒ 没有步骤结构可注：降级为对陈述本身的说明；
 *   - `truncated`（数据集 500 字符截断）⇒ 已解析出的步骤照常做步骤注解，只是不得声称覆盖完整。
 * 两者可以同时为真（截断的记录也可能没有 have）。
 *
 * @param {object|null|undefined} coverage
 * @returns {{section: object|null, note: string|null}}
 */
function coverageBlock(coverage) {
  if (coverage === null || coverage === undefined || typeof coverage !== 'object') {
    return { section: null, note: null }
  }
  const section = {
    mode: coverage.mode ?? null,
    haveCount: coverage.haveCount ?? null,
    nodeCount: coverage.nodeCount ?? null,
    degraded: coverage.degraded === true,
    degradeReason: coverage.degradeReason ?? null,
    truncated: coverage.truncated === true,
    truncateReason: coverage.truncateReason ?? null,
  }
  const notes = []
  if (section.degraded) {
    notes.push(
      `骨架结构退化（have_count=0，mode=${section.mode ?? '?'}，原因：${section.degradeReason ?? '未给出'}）：没有解析出中间节点，请把注解降级为对陈述本身的说明，不要假装看到了不存在的步骤结构。`,
    )
  }
  if (section.truncated) {
    notes.push(
      `证明体被数据集截断（500 字符上限${section.truncateReason ? `，${section.truncateReason}` : ''}）：已解析出的步骤照常做步骤注解，但不得声称覆盖完整；只注解已见到的内容。`,
    )
  }
  return { section, note: notes.length > 0 ? notes.join(' ') : null }
}

/** 陈述未知时给模型的一句说明（SPEC §2.1b：类型标注被省略，不得编造）。 */
const SIGNATURE_UNKNOWN_NOTE =
  '本步的类型标注在源码中省略（Lean 由项推断），我们无法恢复其陈述；lexicon 与 raw 文本是仅有的依据。'
  + `若无法从项本身提炼可复用的思路，请如实填 value_type: ${JSON.stringify(VALUE_TYPE.NONE)}。`
  + '这不是错误：节点是真实结构，只是信息不全，不要因此失败，也不要假装看到了陈述。'

/**
 * 节点陈述（骨架未保存原始证明体，source_excerpt 以签名/假设为源并显式标注来源）。
 *
 * v1.3 条件字段（SPEC §2.1b / INTERFACES §1）：类型标注被省略的 `have h := 项` 节点
 * 带 `signatureUnknown`，此时 signature 为空串、typeFingerprint 为 null，只有 `rawText` 是原文。
 * 这类节点约占 lsv2 语料 have 的 25.5%，必须让模型知道「陈述未知、材料只有原文」。
 */
function statementOf(node, declSlug) {
  const signature = node.signature ?? ''
  const signatureUnknown = node.signatureUnknown === true || signature.trim() === ''
  const rawText = typeof node.rawText === 'string' && node.rawText !== '' ? node.rawText : null
  const excerpt = signature.length > EXCERPT_CHARS ? `${signature.slice(0, EXCERPT_CHARS)}…` : signature
  const section = {
    signature: signature === '' ? null : signature,
    source_excerpt: excerpt === '' ? null : excerpt,
    source_excerpt_from: `out/skeleton/${declSlug}.json → node.signature`,
    source_excerpt_truncated: signature.length > EXCERPT_CHARS,
    hypotheses: Array.isArray(node.hypotheses) ? node.hypotheses : [],
    type_fingerprint: node.typeFingerprint ?? null,
    truncated: node.truncated === true,
  }
  if (signatureUnknown) {
    section.signature_unknown = true
    section.raw_text = rawText
    section.local_name = node.localName ?? null
    section.note = SIGNATURE_UNKNOWN_NOTE
  }
  return section
}

/** 查询并整形词典条目；索引不可用时降级为 missing + 修复动作，不静默。 */
async function loadLexicon(config, names, signal) {
  if (names.length === 0) {
    return { entries: [], missing: [], truncated: false, index: null, error: null }
  }
  const dbPath = path.join(config.cacheDir, 'lexicon.db')
  const maxEntries = config.maxLexiconEntries ?? config.maxEntries ?? DEFAULT_MAX_LEXICON_ENTRIES
  const descriptionChars = config.descriptionChars ?? DEFAULT_DESCRIPTION_CHARS
  try {
    await ensureLexiconIndex({ corpusPath: config.corpusPath, dbPath, signal })
    const lookup = lookupLemma(dbPath, names)
    // lookupLemma 返回**契约原始行**（snake_case 键），shapeEntries 只吃 camelCase：
    // 边界转换必须走 io/contract.mjs（L5），且不能省——省了 shapeEntries 会直接抛错。
    const shaped = shapeEntries(
      { found: (lookup.found ?? []).map((row) => toCamel(row)), missing: lookup.missing ?? [] },
      { maxEntries, descriptionChars },
    )
    const missing = [...new Set([...(lookup.missing ?? []), ...(shaped.missing ?? [])])]
    return {
      entries: shaped.entries ?? [],
      missing,
      truncated: shaped.truncated === true || names.length > maxEntries,
      index: dbPath,
      error: null,
    }
  } catch (error) {
    return {
      entries: [],
      missing: names,
      truncated: false,
      index: dbPath,
      error: `词典索引不可用（${error instanceof Error ? error.message : String(error)}）；请先调用 concept_lookup 建索引后重试。`,
    }
  }
}

/** 计算本次工作单涉及的 role 列表。 */
function resolveRoles(scope, role) {
  if (typeof role === 'string' && role !== '') return [role]
  if (scope === SCOPE.STEP) return [ROLE.STEP]
  return THEOREM_LEVEL_ROLES.filter((item) => ROLE_ORDER.includes(item))
}

/** 供 annotate_submit 校验的期望形状。 */
function outputShape({ scope, nodeId, roles }) {
  return {
    scope,
    target_node: nodeId,
    roles,
    annotation_template: {
      id: '(可省略；由 annotate_submit 分配并回传)',
      node: nodeId ?? '(scope=theorem 时填 root 节点 id)',
      role: roles.length === 1 ? roles[0] : `(${roles.join(' / ')})`,
      value_type: `(${ROLE.STEP} 必填；${VALUE_TYPE.NONE} 合法且必须显式表态)`,
      culture: '(可选；未命中文化取向时整个键缺省，不要填默认值)',
      height: ROLE_DEFAULT_HEIGHT[roles[0]] ?? null,
      evidence: `(${EVIDENCE_VALUES.join(' / ')})`,
      significance: `(${SIGNIFICANCE_VALUES.join(' / ')})`,
      presentation: `(${PRESENTATION_VALUES.join(' / ')})`,
      audience: `(${AUDIENCE_VALUES.join(' / ')})`,
      segments: [{ kind: SEGMENT_KIND.CONCEPT, text: '…', lexicon_ref: '(concept 段必填，须在词典中命中)' }, { kind: SEGMENT_KIND.REASONING, text: '…' }],
      anchors: [{ kind: ANCHOR_KIND.GOAL, target: nodeId ?? 'root_id' }],
      refs: [],
      provenance: { model: '…', ts: '…', run: '…' },
    },
    required_fields: ['node', 'role', 'height', 'evidence', 'significance', 'presentation', 'audience', 'segments', 'anchors', 'provenance'],
    conditional_fields: {
      value_type: `role=${ROLE.STEP} 时必填，${VALUE_TYPE.NONE} 也合法（V7）`,
      culture: `role=${ROLE.STEP} 且命中文化取向时填写，否则整个键缺省（V8）`,
      lexicon_ref: `segment.kind=${SEGMENT_KIND.CONCEPT} 时必填，且必须能在词典中解析（V10）`,
    },
    segment_kinds: [...SEGMENT_KIND_VALUES],
    submit_with: 'annotate_submit(theorem_name, annotations)',
  }
}

/**
 * 注册 `annotate_prepare`。
 * @param {object} ctx - Cordis 上下文（ctx.tools）
 * @param {object} config - index.js 声明的 Config
 * @returns {() => void} disposer
 */
export function registerAnnotatePrepare(ctx, config) {
  return ctx.tools.register(
    defineTool({
      name: 'annotate_prepare',
      description:
        '为一个证明节点产出结构化工作单：父链、陈述、可用词典条目、风格范例、长度上限与六条硬约束。调用一次得到一个节点（或一轮定理级注解）的完整素材；注解正文由你生成，本工具不生成文本。',
      parameters: {
        theorem_name: {
          type: 'string',
          required: true,
          description:
            'Lean 全限定声明名，例如 "Mathlib.Algebra.Group.Even.add"。必须已有 out/skeleton/<decl-slug>.json（先调用 skeleton_extract 生成）。',
        },
        scope: {
          type: 'string',
          required: true,
          enum: [...SCOPE_VALUES],
          description:
            `theorem = 定理级注解（锚点必须指向 root 节点）；${SCOPE.STEP} = 单个节点的步骤注解（必须同时给 node_id）。`,
        },
        node_id: {
          type: 'string',
          description: `scope=${SCOPE.STEP} 时必填：out/skeleton 中真实存在的节点 id（如 n3）；scope=${SCOPE.THEOREM} 时不要传（定理级注解的锚点是 root）。`,
        },
        role: {
          type: 'string',
          enum: [...ROLE_VALUES],
          description: `本次要写的注解角色。省略时：scope=${SCOPE.STEP} 取 ${ROLE.STEP}；scope=${SCOPE.THEOREM} 返回全部定理级 role（${THEOREM_LEVEL_ROLES.join(' / ')}）的批量工作单。`,
        },
        form: {
          type: 'string',
          enum: [...FORM_VALUES],
          description: `注解形态（${allowedHint(FORM_VALUES)}），决定注入哪套风格范例；省略按 ${FORM.THE_BOOK} 处理。形态只影响风格与组织方式，不改变字段必填性。`,
        },
      },
      output: {
        // 值 schema DSL 要求每个 object 节点显式声明 additionalProperties（true/false 均可）。
        // 工作单字段由 output_shape 自描述，这里只声明「返回一个对象」，不逐字段收紧。
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const theoremName = requireTheoremName(args?.theorem_name)
        const scope = args?.scope
        if (!SCOPE_VALUES.includes(scope)) {
          fail(`scope 必须是 ${allowedHint(SCOPE_VALUES)} 之一；请按「整条定理」还是「单个节点」选择后重试。`)
        }
        const role = args?.role
        if (role !== undefined && role !== null && !ROLE_VALUES.includes(role)) {
          fail(`role 必须是 ${allowedHint(ROLE_VALUES)} 之一；请从工作单的 roles 中选一个。`)
        }
        const form = args?.form ?? FORM.THE_BOOK
        if (!FORM_VALUES.includes(form)) {
          fail(`form 必须是 ${allowedHint(FORM_VALUES)} 之一；请从注解形态里选一个，或省略它。`)
        }
        const requestedNodeId = args?.node_id
        if (scope === SCOPE.STEP && (typeof requestedNodeId !== 'string' || requestedNodeId.trim() === '')) {
          fail(`scope=${SCOPE.STEP} 必须给出 node_id；请先 skeleton_extract 再用返回的节点 id（如 n3）重试。`)
        }
        if (scope === SCOPE.THEOREM && typeof requestedNodeId === 'string' && requestedNodeId.trim() !== '') {
          fail(`scope=${SCOPE.THEOREM} 的锚点是 root，请不要传 node_id；若要为某个节点写注解，请改用 scope=${SCOPE.STEP}。`)
        }

        let skeleton
        try {
          skeleton = await readSkeleton(config.outputDir, theoremName, { signal: exec.signal })
        } catch (error) {
          fail(
            `读不到 out/skeleton 下 "${theoremName}" 的骨架（${error instanceof Error ? error.message : String(error)}）；请先调用 skeleton_extract(theorem_name="${theoremName}") 生成骨架。`,
          )
        }
        const nodes = skeleton?.nodes ?? {}
        const rootId = typeof skeleton?.root === 'string' ? skeleton.root : null
        const nodeId = scope === SCOPE.STEP ? requestedNodeId.trim() : rootId
        const node = nodeId !== null ? nodes[nodeId] : undefined
        if (node === undefined) {
          const available = Object.keys(nodes).slice(0, 20)
          fail(
            `节点 ${JSON.stringify(nodeId)} 不在骨架中；可用节点：${available.length > 0 ? available.join(', ') : '（骨架为空）'}。请用 annotation_check 或 skeleton_extract 返回的节点 id 重试。`,
          )
        }

        const roles = resolveRoles(scope, role)
        const invalidRole = roles.find((item) => !ROLE_VALUES.includes(item))
        if (invalidRole !== undefined) {
          fail(`role ${JSON.stringify(invalidRole)} 不是合法枚举；请从 ${allowedHint(ROLE_VALUES)} 中选一个。`)
        }
        if (scope === SCOPE.THEOREM && roles.some((item) => item === ROLE.STEP)) {
          fail(`scope=${SCOPE.THEOREM} 不能写 ${ROLE.STEP} 注解；请改为 scope=${SCOPE.STEP} 并提供 node_id。`)
        }
        if (scope === SCOPE.STEP && roles.some((item) => item !== ROLE.STEP)) {
          fail(`scope=${SCOPE.STEP} 的 role 只能是 ${ROLE.STEP}；定理级注解请用 scope=${SCOPE.THEOREM}。`)
        }

        const lemmaRefs = Array.isArray(node.lemmaRefs) ? node.lemmaRefs : []
        const lexicon = await loadLexicon(config, lemmaRefs, exec.signal)
        const coverage = coverageBlock(skeleton?.coverage)
        const declSlug = theoremName

        const lengthLimits = {}
        for (const item of roles) lengthLimits[item] = LENGTH_LIMIT[item] ?? null

        const culture = cultureHint(lexicon.entries)
        const workOrder = {
          theorem: theoremName,
          scope,
          nodeId,
          role: roles.length === 1 ? roles[0] : null,
          roles,
          form,
          lengthLimit: roles.length === 1 ? (LENGTH_LIMIT[roles[0]] ?? null) : null,
          lengthLimits,
          parentChain: parentChain(skeleton, nodeId),
          statement: statementOf(node, declSlug),
          node: {
            id: nodeId,
            kind: node.kind ?? null,
            decl: node.decl ?? null,
            lemmaRefs,
            truncated: node.truncated === true,
          },
          coverage: coverage.section,
          coverageNote: coverage.note,
          lexicon: lexicon.entries,
          lexiconMissing: lexicon.missing,
          lexiconTruncated: lexicon.truncated,
          lexiconIndex: lexicon.index,
          lexiconError: lexicon.error,
          lexiconHint:
            lexicon.missing.length > 0 || lexicon.truncated
              ? 'lexicon_missing 里的引理在本地词典中未命中；需要更多条目或重建索引时用 concept_lookup（禁止自行编造语义）。'
              : null,
          cultureHint: culture,
          styleExamples: STYLE_EXAMPLES[form] ?? null,
          styleExamplesReason:
            STYLE_EXAMPLES[form] !== undefined ? null : `形态 ${JSON.stringify(form)} 没有对应的风格范例（R9：不硬套）。`,
          constraints: [...CONSTRAINTS],
          outputShape: outputShape({ scope, nodeId, roles }),
          specVersion: SPEC_VERSION,
        }
        // 输出是工具输出 ⇒ snake_case（SPEC §1.1）；转换只发生在 io/contract.mjs（L5）。
        return toSnake(workOrder)
      },
    }),
  )
}
