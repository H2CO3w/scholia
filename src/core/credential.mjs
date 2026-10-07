/**
 * credential.mjs — 三轴可信度模型 + 硬校验规则 V1–V16（纯函数，无 DSH / 无网络 / 无 LLM / 无 I/O）
 *
 * 设计依据: docs/SPEC.md §3（枚举）、§4（校验规则）、§3.2（长度上限）
 *          plan-v1.0.md §3（三轴模型的由来）
 *
 * 为什么校验器必须是代码而不是提示词:
 *   plan-v1.0 §8.1 —— 整套方法的验证器就是它。如果 agent 写的注解过不了 validator，
 *   整个可信度设计是空的。用 systemPrompt 表达 V1–V16，等于把机械约束退回成祈求。
 *
 * 三轴（一条注解的**可信度属性**，与 role 类型学正交）:
 *   轴 E  evidence      由什么支撑   → 决定怎么被反驳
 *   轴 C  significance  覆盖哪一层   → 决定值不值得争
 *   轴 P  presentation  以什么形式   → 决定能不能当推理前提
 *
 * 规则码说明: 诊断的 `rule` 字段取值是 'V1'…'V16' 或 'SCHEMA'。
 *   'SCHEMA' 是形状/枚举合法性检查的归集码（SPEC §4 未单独编号），例如 role 缺失或取值非法。
 *   这样 V 编号保持与 SPEC 一一对应，不挪用。
 */

import { validateAnchors } from './anchor.mjs'
import {
  ANCHOR_KIND,
  AUDIENCE_VALUES,
  CULTURE_VALUES,
  EVIDENCE,
  EVIDENCE_RANK,
  EVIDENCE_VALUES,
  HEIGHT_VALUES,
  LENGTH_LIMIT,
  METAPHOR_ALLOWED_EVIDENCE,
  PRECISE_EVIDENCE,
  PRESENTATION,
  PRESENTATION_VALUES,
  ROLE,
  ROLE_VALUES,
  SEGMENT_KIND,
  SEGMENT_KIND_VALUES,
  SIGNIFICANCE,
  SIGNIFICANCE_RANK,
  SIGNIFICANCE_VALUES,
  STRONG_ANCHOR_KINDS,
  THEOREM_LEVEL_ROLES,
  VALUE_TYPE_VALUES,
  allowedHint,
  isEnumValue,
} from './enums.mjs'

// ── 规则码 ────────────────────────────────────────────────────────────

/** SPEC §4 的规则编号。diagnostic.rule 取此值。 */
export const RULE = Object.freeze({
  V1: 'V1', V2: 'V2', V3: 'V3', V4: 'V4', V5: 'V5', V6: 'V6', V7: 'V7', V8: 'V8',
  V9: 'V9', V10: 'V10', V11: 'V11', V12: 'V12', V13: 'V13', V14: 'V14',
  V15: 'V15', V16: 'V16',
  /** 形状与枚举合法性（SPEC §4 未编号） */
  SCHEMA: 'SCHEMA',
})

const PRECISE = new Set(PRECISE_EVIDENCE)
const METAPHOR_OK = new Set(METAPHOR_ALLOWED_EVIDENCE)
const STRONG = new Set(STRONG_ANCHOR_KINDS)
const THEOREM_LEVEL = new Set(THEOREM_LEVEL_ROLES)

// ── 长度计量（SPEC §3.2）─────────────────────────────────────────────

/** 剥掉代码与公式：围栏代码块、行内代码、$…$ / $$…$$ / \(…\) / \[…\] */
export function stripNonProse(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/\$[^$]*\$/g, ' ')
    .replace(/\\\([\s\S]*?\\\)/g, ' ')
    .replace(/\\\[[\s\S]*?\\\]/g, ' ')
}

/**
 * 计长：正文汉字数，公式与代码不计（SPEC §3.2）。
 * 单位定义：一个 CJK 字符计 1；一段连续的拉丁字母/数字计 1（即"一个词"）。
 * 这样中英混写的注解有可比的量纲。
 * @param {{text?: string}[]} segments
 * @returns {number}
 */
export function countTextLength(segments) {
  const list = Array.isArray(segments) ? segments : []
  let total = 0
  for (const seg of list) {
    const prose = stripNonProse(seg?.text)
    const cjk = prose.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/g)
    total += cjk ? cjk.length : 0
    const latin = prose.match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g)
    total += latin ? latin.length : 0
  }
  return total
}

// ── 内部工具 ──────────────────────────────────────────────────────────

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * 选主锚点：第一个可解析且非 display 的锚点；若没有，退回首锚点。
 * V13 / V14 都以主锚点为准。
 */
function pickMainAnchor(results) {
  if (!Array.isArray(results) || results.length === 0) return null
  return results.find((r) => r.ok && r.kind !== ANCHOR_KIND.DISPLAY) ?? results[0]
}

function makeDiag(rule, code, field, message) {
  return { rule, code, field, message }
}

// ── 单条注解校验 ──────────────────────────────────────────────────────

/**
 * 校验单条注解（SPEC §4 的 V1–V16 中与该条相关的全部）。
 * **不抛异常**：输入残缺时产出诊断而不是崩溃。
 *
 * @param {object} ann  注解（camelCase，见 INTERFACES §1）
 * @param {object|null} skeleton  SkeletonTree；为 null 时跳过锚点解析类规则
 * @param {Set<string>|null} [knownAnnotationIds]  用于 V5
 * @param {Set<string>|null} [lexiconNames]  词典中**可解析**的名字集合，用于 V10 的解析检查；
 *   为 null 时 V10 只检查非空（弱化模式，工具层应始终传入）
 * @returns {{
 *   ok: boolean, diagnostics: object[], claimable: boolean,
 *   evidenceRank: number, significanceRank: number,
 *   length: {used: number, limit: number|null}, anchorChecked: boolean,
 *   mainAnchorTarget: string|null, role: string|null,
 * }}
 */
export function validateAnnotation(ann, skeleton, knownAnnotationIds = null, lexiconNames = null) {
  const d = []
  const add = (rule, code, field, message) => d.push(makeDiag(rule, code, field, message))

  // ── 形状检查 ──────────────────────────────────────────────────────
  if (!isObj(ann)) {
    add(RULE.SCHEMA, 'SCHEMA_NOT_OBJECT', null, '注解必须是对象；请检查提交的 JSON 结构')
    return finish(d, ann, null, null, false)
  }

  if (typeof ann.id !== 'string' || ann.id.length === 0) {
    add(RULE.SCHEMA, 'SCHEMA_ID_REQUIRED', 'id', '缺少注解 id；请给每条注解一个稳定 id（如 "a1"）')
  }

  const role = ann.role
  const roleOk = isEnumValue(ROLE_VALUES, role)
  if (!roleOk) {
    add(RULE.SCHEMA, 'SCHEMA_ROLE_INVALID', 'role',
      `role 取值非法: ${JSON.stringify(role)}；合法值为 ${allowedHint(ROLE_VALUES)}`)
  }

  for (const [field, values] of [
    ['height', HEIGHT_VALUES],
    ['evidence', EVIDENCE_VALUES],
    ['significance', SIGNIFICANCE_VALUES],
    ['presentation', PRESENTATION_VALUES],
    ['audience', AUDIENCE_VALUES],
  ]) {
    if (!isEnumValue(values, ann[field])) {
      add(RULE.SCHEMA, `SCHEMA_${field.toUpperCase()}_INVALID`, field,
        `${field} 取值非法: ${JSON.stringify(ann[field])}；合法值为 ${allowedHint(values)}`)
    }
  }

  if (!isObj(ann.provenance)) {
    add(RULE.V15, 'V15_PROVENANCE_REQUIRED', 'provenance',
      '缺少 provenance；请补 {"model": …, "ts": …, "run": …}（诚实性要求，报告要能追溯来源）')
  } else {
    for (const key of ['model', 'ts', 'run']) {
      const v = ann.provenance[key]
      if (typeof v !== 'string' || v.length === 0) {
        add(RULE.V15, 'V15_PROVENANCE_INCOMPLETE', `provenance.${key}`,
          `provenance.${key} 缺失或为空；请补上（用于追溯这条注解是谁在什么时候生成的）`)
      }
    }
  }

  // ── V11 正文分段 ──────────────────────────────────────────────────
  const segments = Array.isArray(ann.segments) ? ann.segments : null
  if (!segments || segments.length < 1) {
    add(RULE.V11, 'V11_SEGMENTS_REQUIRED', 'segments',
      'segments 必须是至少含 1 段的数组；请把正文写成一个 {"kind":"reasoning","text":"…"} 段')
  } else {
    segments.forEach((seg, i) => {
      if (!isObj(seg)) {
        add(RULE.V11, 'V11_SEGMENT_NOT_OBJECT', `segments[${i}]`, `segments[${i}] 必须是对象`)
        return
      }
      if (!isEnumValue(SEGMENT_KIND_VALUES, seg.kind)) {
        add(RULE.V11, 'V11_SEGMENT_KIND_INVALID', `segments[${i}].kind`,
          `segments[${i}].kind 取值非法: ${JSON.stringify(seg.kind)}；合法值为 ${allowedHint(SEGMENT_KIND_VALUES)}`)
      }
      if (typeof seg.text !== 'string' || seg.text.trim().length === 0) {
        add(RULE.V11, 'V11_SEGMENT_TEXT_EMPTY', `segments[${i}].text`,
          `segments[${i}].text 为空；请写入正文，或删除该段`)
      }
      // V10：概念段必须带**可解析的**词典引用
      // 词典在 io 层（core 不许碰 I/O，L1），所以可解析名字集合由调用方经
      // opts.lexiconNames 传入。**未传入时只能检查非空**——那是个已知的弱化模式，
      // 工具层必须传，否则「引理语义只来自词典」这条红线形同虚设。
      if (seg.kind === SEGMENT_KIND.CONCEPT) {
        if (typeof seg.lexiconRef !== 'string' || seg.lexiconRef.trim().length === 0) {
          add(RULE.V10, 'V10_LEXICON_REF_REQUIRED', `segments[${i}].lexiconRef`,
            'kind=concept 的段必须带 lexicon_ref；引理语义只能来自词典（concept_lookup）。'
            + '若这句话不是词典里的概念，请改成 kind="reasoning"')
        } else if (lexiconNames instanceof Set && !lexiconNames.has(seg.lexiconRef)) {
          add(RULE.V10, 'V10_LEXICON_REF_UNRESOLVED', `segments[${i}].lexiconRef`,
            `lexicon_ref=${JSON.stringify(seg.lexiconRef)} 在词典中查不到；引理语义只能来自词典。`
            + '请先用 concept_lookup 确认该名字能命中，或把这一段改成 kind="reasoning"'
            + '（不要为了过校验而换一个相近但不相关的名字）')
        }
      }
    })
  }

  // ── V7 / V8 轴 R 与轴 V / 轴 G 的耦合 ─────────────────────────────
  const isStep = role === ROLE.STEP
  const hasValueType = ann.valueType !== undefined && ann.valueType !== null
  const hasCulture = ann.culture !== undefined && ann.culture !== null

  if (isStep && !hasValueType) {
    add(RULE.V7, 'V7_VALUE_TYPE_REQUIRED', 'valueType',
      'role=step 必须显式给出 value_type；若这一步没有可提炼的思路，请填 "none"')
  }
  if (!isStep && hasValueType) {
    add(RULE.V8, 'V8_VALUE_TYPE_NOT_ALLOWED', 'valueType',
      `value_type 仅对 role=step 有效，但 role=${JSON.stringify(role)}；请删除该字段`)
  }
  if (hasValueType && !isEnumValue(VALUE_TYPE_VALUES, ann.valueType)) {
    add(RULE.V8, 'V8_VALUE_TYPE_INVALID', 'valueType',
      `value_type 取值非法: ${JSON.stringify(ann.valueType)}；合法值为 ${allowedHint(VALUE_TYPE_VALUES)}`)
  }
  if (hasCulture) {
    if (!isStep) {
      add(RULE.V8, 'V8_CULTURE_NOT_ALLOWED', 'culture',
        `culture 仅对 role=step 有效，但 role=${JSON.stringify(role)}；请删除该字段`)
    } else if (!isEnumValue(CULTURE_VALUES, ann.culture)) {
      add(RULE.V8, 'V8_CULTURE_INVALID', 'culture',
        `culture 取值非法: ${JSON.stringify(ann.culture)}；合法值为 ${allowedHint(CULTURE_VALUES)}`)
    }
  }

  // ── V2 隐喻不得冒充精确凭证 ───────────────────────────────────────
  if (ann.presentation === PRESENTATION.METAPHOR && !METAPHOR_OK.has(ann.evidence)) {
    add(RULE.V2, 'V2_METAPHOR_EVIDENCE', 'evidence',
      `presentation=metaphor 时 evidence 只能是 ${allowedHint(METAPHOR_ALLOWED_EVIDENCE)}，`
      + `当前为 ${JSON.stringify(ann.evidence)}；请改 evidence 或改 presentation`)
  }

  // ── V9 长度上限：超限拒绝并要求重写，不截断 ───────────────────────
  const limit = roleOk ? (LENGTH_LIMIT[role] ?? null) : null
  const used = segments ? countTextLength(segments) : 0
  if (limit !== null && used > limit) {
    add(RULE.V9, 'V9_TOO_LONG', 'segments',
      `正文 ${used} 字，超过 role=${role} 的上限 ${limit} 字。`
      + `请**重写**而不是截断——长度上限是「有没有吃透」的探针 (Zagier/Conrad)`)
  }

  // ── 锚点类规则 ────────────────────────────────────────────────────
  let mainAnchorTarget = null
  let anchorChecked = false
  if (isObj(skeleton) && isObj(skeleton.nodes)) {
    anchorChecked = true
    const anchors = Array.isArray(ann.anchors) ? ann.anchors : []
    if (anchors.length === 0) {
      add(RULE.SCHEMA, 'SCHEMA_ANCHORS_REQUIRED', 'anchors',
        '缺少 anchors；每条注解至少要有一个锚点（V1/V12 依赖它）')
    }

    const report = validateAnchors(anchors, skeleton)
    const results = report.results ?? []

    // V4：display 锚点不可校验，禁止使用
    const displayUsed = results.filter((r) => r.kind === ANCHOR_KIND.DISPLAY)
    if (displayUsed.length > 0) {
      add(RULE.V4, 'V4_DISPLAY_ANCHOR_FORBIDDEN', 'anchors',
        `使用了 display 锚点（行号不可作锚点，改一行注释就会静默失效）: `
        + `${displayUsed.map((r) => r.raw).join(', ')}；请改用 decl / goal / hyp 锚点`)
    }

    // V12：悬空断言
    const dangling = results.filter((r) => !r.ok && r.kind !== ANCHOR_KIND.DISPLAY)
    if (dangling.length > 0) {
      add(RULE.V12, 'V12_DANGLING_ANCHOR', 'anchors',
        `锚点无法解析到骨架中的节点: ${dangling.map((r) => `${r.raw}(${r.reason})`).join(', ')}；`
        + `请先用 skeleton_extract 确认节点 id`)
    }

    const main = pickMainAnchor(results)
    mainAnchorTarget = main?.target ?? null

    // V1：main 级必须有可解析的强锚点
    if (ann.significance === SIGNIFICANCE.MAIN && !report.hasStrong) {
      add(RULE.V1, 'V1_MAIN_NEEDS_STRONG_ANCHOR', 'anchors',
        `significance=main 但无有效的 decl/goal 锚点。现有: ${JSON.stringify(anchors)}；`
        + `请补一个强锚点，或把 significance 降为 supporting/context`)
    }

    // V3：formal 凭证必须有 decl/goal 支撑
    if (ann.evidence === EVIDENCE.FORMAL) {
      const formalOk = results.some((r) => r.ok && STRONG.has(r.kind))
      if (!formalOk) {
        add(RULE.V3, 'V3_FORMAL_NEEDS_DECL_ANCHOR', 'evidence',
          'evidence=formal 但没有有效的 decl/goal 锚点；请补强锚点，或把 evidence 降为 unfolding/analogy/intuition')
      }
    }

    // V13：定理级 role 必须锚在 root
    if (roleOk && THEOREM_LEVEL.has(role) && main) {
      const rootId = skeleton.root
      const rootNode = skeleton.nodes[rootId]
      const rootDecl = rootNode?.decl ?? null
      if (main.target !== rootId && main.target !== rootDecl) {
        add(RULE.V13, 'V13_THEOREM_LEVEL_NEEDS_ROOT', 'anchors',
          `role=${role} 是定理级注解，主锚点必须指向根节点 ${JSON.stringify(rootId)}`
          + `${rootDecl ? `（或 ${JSON.stringify(rootDecl)}）` : ''}，当前指向 ${JSON.stringify(main.target)}；`
          + `若这是针对某一步的注解，请把 role 改为 "step"`)
      }
    }

    // V14：role=step 时 ann.node 必须等于主锚点 target
    // V14：只有当注解给出了 goal 锚点时才存在「node 声称」可比对。
    // hyp 锚点的 target 是假设名（如 "ha"）而不是节点 id，不能拿它跟 node 比——
    // 一条只挂 hyp 锚点的步骤注解是合法的（goal 锚点缺失由 V1/V3 按 significance/evidence 管）。
    const goalAnchor = results.find((r) => r.ok && r.kind === ANCHOR_KIND.GOAL)
    if (isStep && goalAnchor && ann.node !== goalAnchor.target) {
      add(RULE.V14, 'V14_NODE_ANCHOR_MISMATCH', 'node',
        `node=${JSON.stringify(ann.node)} 与 goal 锚点 target=${JSON.stringify(goalAnchor.target)} 不一致；`
        + `请让两者指向同一个节点`)
    }

    // 节点必须存在（V12 的 node 侧对应物）
    if (typeof ann.node === 'string' && !Object.prototype.hasOwnProperty.call(skeleton.nodes, ann.node)) {
      add(RULE.V12, 'V12_NODE_UNKNOWN', 'node',
        `node=${JSON.stringify(ann.node)} 不在骨架树中；请先用 skeleton_extract 取得真实节点 id`)
    }
  }

  // ── V5 交叉引用 ───────────────────────────────────────────────────
  const refs = Array.isArray(ann.refs) ? ann.refs : []
  if (refs.length > 0) {
    const known = knownAnnotationIds ?? new Set()
    const missing = refs.filter((r) => !known.has(r) && r !== ann.id)
    if (missing.length > 0) {
      add(RULE.V5, 'V5_REF_UNKNOWN', 'refs',
        `refs 指向不存在的注解: ${missing.join(', ')}；请删除这些引用或先提交被引用的注解`)
    }
  }

  return finish(d, ann, used, limit, anchorChecked, mainAnchorTarget)
}

function finish(diagnostics, ann, used, limit, anchorChecked, mainAnchorTarget = null) {
  const claimable = PRECISE.has(ann?.evidence) // V6：可否作推理前提
  return {
    ok: diagnostics.length === 0,
    diagnostics,
    claimable,
    evidenceRank: EVIDENCE_RANK[ann?.evidence] ?? 0,
    significanceRank: SIGNIFICANCE_RANK[ann?.significance] ?? 0,
    role: isEnumValue(ROLE_VALUES, ann?.role) ? ann.role : null,
    length: { used, limit },
    anchorChecked,
    mainAnchorTarget,
  }
}

// ── 批量校验 ──────────────────────────────────────────────────────────

/**
 * 批量校验（工具层入口）。
 *
 * V16 不是「拒绝」而是「覆盖并报告」，因此重复项进 `duplicates` 而不是 `diagnostics`。
 *
 * @param {object[]} annotations
 * @param {object|null} skeleton
 * @param {{maxDiagnostics?: number}} [opts]
 */
export function validateAnnotations(annotations, skeleton, opts = {}) {
  const maxDiagnostics = Number.isInteger(opts.maxDiagnostics) && opts.maxDiagnostics > 0
    ? opts.maxDiagnostics
    : Number.POSITIVE_INFINITY
  const list = Array.isArray(annotations) ? annotations : []
  const ids = new Set(list.map((a) => a?.id).filter((v) => typeof v === 'string'))

  const perAnnotation = []
  const all = []
  const duplicates = []
  const seen = new Map() // `${node}\u0000${role}` → index

  list.forEach((ann, index) => {
    const r = validateAnnotation(ann, skeleton, ids, opts.lexiconNames ?? null)
    perAnnotation.push({ index, ...r })
    for (const diag of r.diagnostics) all.push({ index, annotationId: ann?.id ?? null, ...diag })

    // V16：同一 (node, role) 重复提交 ⇒ 覆盖并报告
    const key = `${ann?.node ?? ''}\u0000${ann?.role ?? ''}`
    if (ann?.node && ann?.role) {
      if (seen.has(key)) {
        duplicates.push({
          index,
          annotationId: ann?.id ?? null,
          node: ann.node,
          role: ann.role,
          overwritesIndex: seen.get(key),
          message: `(${ann.node}, ${ann.role}) 已有注解，本条将覆盖前一条；`
            + `若两条都要保留，请给它们不同的 role`,
        })
      } else {
        seen.set(key, index)
      }
    }
  })

  const failed = perAnnotation.filter((r) => !r.ok).length
  const truncated = all.length > maxDiagnostics

  return {
    ok: failed === 0,
    total: perAnnotation.length,
    passed: perAnnotation.length - failed,
    failed,
    diagnostics: truncated ? all.slice(0, maxDiagnostics) : all,
    diagnosticsTotal: all.length,
    truncated,
    duplicates,
    perAnnotation,
    // V6 视图分组（便利字段；beliefBoundary 亦提供）
    claimable: perAnnotation.filter((r) => r.ok && r.claimable).map((r) => r.index),
    nonClaimable: perAnnotation.filter((r) => r.ok && !r.claimable).map((r) => r.index),
  }
}

// ── 不信开关 ──────────────────────────────────────────────────────────

/**
 * 「不信开关」的可机械判定：给定注解层，哪些部分可以被当作推理前提。
 * SPEC V6：evidence ∈ {formal, literature, unfolding} 不得进入直觉层视图。
 *
 * @param {object[]} annotations
 * @param {object|null} skeleton
 */
export function beliefBoundary(annotations, skeleton) {
  const report = validateAnnotations(annotations, skeleton)
  return {
    claimable: report.perAnnotation.filter((r) => r.ok && r.claimable).map((r) => r.index),
    nonClaimable: report.perAnnotation.filter((r) => r.ok && !r.claimable).map((r) => r.index),
    invalid: report.perAnnotation.filter((r) => !r.ok).map((r) => r.index),
  }
}

// ── 指标（SPEC §2.5 / plan-v1.0 §4.4）────────────────────────────────

/**
 * 计算 Ledger 的结构完整性与锚点精度。
 *
 * ⚠️ `null` 与 `0` 语义不同（SPEC H2）："没算"必须是 null，"算出来是零"才是 0。
 *
 * @param {object[]} annotations
 * @param {object|null} skeleton
 */
export function computeMetrics(annotations, skeleton) {
  const list = Array.isArray(annotations) ? annotations : []
  const nodes = isObj(skeleton?.nodes) ? skeleton.nodes : null
  const nodeCount = nodes ? Object.keys(nodes).length : null

  const report = validateAnnotations(list, skeleton)
  const mainAnns = report.perAnnotation.filter(
    (r) => list[r.index]?.significance === SIGNIFICANCE.MAIN,
  )
  // C_skel（plan-v1.0 §4.4）：有 ≥1 条 significance=main 注解的节点 / 总节点数
  const annotatedNodes = new Set(
    mainAnns
      .filter((r) => r.ok)
      .map((r) => list[r.index]?.node)
      .filter(Boolean),
  )

  const mainCoverage = nodeCount ? annotatedNodes.size / nodeCount : null
  const anchorPrecision = mainAnns.length === 0
    ? null
    : mainAnns.filter((r) => r.ok).length / mainAnns.length

  return {
    nodeCount: nodeCount ?? 0,
    annotatedNodeCount: annotatedNodes.size,
    mainCoverage,
    anchorPrecision,
    conceptCoverage: null, // 需检索层，缺省为 null 而非 0
  }
}
