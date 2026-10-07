/**
 * enums.mjs — 枚举闭集唯一来源（SPEC §3）
 *
 * ★ 本文件是全项目**唯一**允许出现枚举字面量的地方（分层约束 L4，由 test/layers.test.mjs 强制）。
 *   业务代码一律 `import { ROLE } from './enums.mjs'` 后用 `ROLE.STEP`，禁止写 `'step'`。
 *
 * 纯函数模块：无 DSH / 无网络 / 无 LLM / 无 fs（分层约束 L1）。
 */

/** 冻结一个「常量名 → 值」对象。 */
function closed(pairs) {
  return Object.freeze({ ...pairs })
}

// ── 骨架（SPEC §2.1 / §2.2）────────────────────────────────────────────

/**
 * E-KIND 节点类型
 *
 * 后 6 项（INDUCTIVE…RECURSOR）来自 `data/lsv2.jsonl` 全量 310,579 条的 `kind` 实测取值
 * （theorem 218,365 / definition 52,792 / instance 24,680 / constructor 4,508 /
 *  recursor 3,597 / inductive 3,591 / abbrev 2,822 / opaque 218 / classInductive 6）。
 * 数据集里的 `classInductive` 是 camelCase，进入枚举闭集时按 SPEC §1.1 统一为 snake_case；
 * 原始值 → 枚举值的归一化映射在 src/core/skeleton.mjs，这里只定义闭集本身。
 */
export const NODE_KIND = closed({
  THEOREM: 'theorem',
  LEMMA: 'lemma',
  DEFINITION: 'definition',
  INSTANCE: 'instance',
  HAVE: 'have',
  LET: 'let',
  GOAL: 'goal',
  INDUCTIVE: 'inductive',
  ABBREV: 'abbrev',
  OPAQUE: 'opaque',
  CLASS_INDUCTIVE: 'class_inductive',
  CONSTRUCTOR: 'constructor',
  RECURSOR: 'recursor',
})

/** E-SOURCE 骨架来源 */
export const SOURCE = closed({
  LSV2: 'lsv2',
  LEAN4EXPORT: 'lean4export',
  MANUAL: 'manual',
})

/** E-MODE 证明体形态（决定骨架是否退化） */
export const PROOF_MODE = closed({
  TACTIC_MULTILINE: 'tactic-multiline',
  TACTIC_SINGLE: 'tactic-single',
  TERM: 'term',
  FAILED: 'failed',
})

// ── 注解（SPEC §2.4 / §3）─────────────────────────────────────────────

/** E-ROLE 轴 R：这条注解干什么活 */
export const ROLE = closed({
  CORE_IDEA: 'core_idea',
  QUESTION: 'question',
  BIRDVIEW: 'birdview',
  STEP: 'step',
  COMMENTARY: 'commentary',
  NEGATIVE_SPACE: 'negative_space',
})

/** E-VALUE-TYPE 轴 V：仅 role=step 有效；`none` 是合法且必须显式表态的取值 */
export const VALUE_TYPE = closed({
  TECHNIQUE: 'technique',
  CONCEPT: 'concept',
  TECHNICAL: 'technical',
  STRUCTURAL: 'structural',
  NONE: 'none',
})

/** E-CULTURE 轴 G：仅 role=step 有效；**未命中时字段缺省**，不要填默认值 */
export const CULTURE = closed({
  THEORY: 'theory',
  PROBLEM: 'problem',
})

/** E-HEIGHT 轴 D：内容类型，非位置约束（SPEC §3.1） */
export const HEIGHT = closed({
  BIRD: 'bird',
  FROG: 'frog',
  BOTH: 'both',
})

/** E-EVIDENCE 轴 E（plan-v1.0 §3.1） */
export const EVIDENCE = closed({
  FORMAL: 'formal',
  LITERATURE: 'literature',
  UNFOLDING: 'unfolding',
  ANALOGY: 'analogy',
  INTUITION: 'intuition',
})

/** E-SIGNIFICANCE 轴 C（plan-v1.0 §3.2；`step` 已更名为 `supporting`，见 SPEC §0.3） */
export const SIGNIFICANCE = closed({
  MAIN: 'main',
  SUPPORTING: 'supporting',
  CONTEXT: 'context',
})

/** E-PRESENTATION 轴 P（plan-v1.0 §3.3） */
export const PRESENTATION = closed({
  EXACT: 'exact',
  PARAPHRASE: 'paraphrase',
  METAPHOR: 'metaphor',
})

/** E-AUDIENCE 读者档位（decisions.md D5） */
export const AUDIENCE = closed({
  GRAD_MATH: 'grad-math',
  HIGHSCHOOL_STRONG: 'highschool-strong',
})

/** E-SEGMENT-KIND 正文分段来源（SPEC §2.4） */
export const SEGMENT_KIND = closed({
  CONCEPT: 'concept',
  REASONING: 'reasoning',
})

/** E-ANCHOR-KIND 锚点类型（plan-v1.0 §4.2） */
export const ANCHOR_KIND = closed({
  DECL: 'decl',
  GOAL: 'goal',
  HYP: 'hyp',
  DISPLAY: 'display',
})

/** E-FORM 注解形态（v2.1 §7.5） */
export const FORM = closed({
  THE_BOOK: 'the_book',
  CONRAD: 'conrad',
  ZAGIER: 'zagier',
  THURSTON: 'thurston',
})

// ── 值数组（校验用；顺序即渲染顺序）──────────────────────────────────

export const NODE_KIND_VALUES = Object.freeze(Object.values(NODE_KIND))
export const SOURCE_VALUES = Object.freeze(Object.values(SOURCE))
export const PROOF_MODE_VALUES = Object.freeze(Object.values(PROOF_MODE))
export const ROLE_VALUES = Object.freeze(Object.values(ROLE))
export const VALUE_TYPE_VALUES = Object.freeze(Object.values(VALUE_TYPE))
export const CULTURE_VALUES = Object.freeze(Object.values(CULTURE))
export const HEIGHT_VALUES = Object.freeze(Object.values(HEIGHT))
export const EVIDENCE_VALUES = Object.freeze(Object.values(EVIDENCE))
export const SIGNIFICANCE_VALUES = Object.freeze(Object.values(SIGNIFICANCE))
export const PRESENTATION_VALUES = Object.freeze(Object.values(PRESENTATION))
export const AUDIENCE_VALUES = Object.freeze(Object.values(AUDIENCE))
export const SEGMENT_KIND_VALUES = Object.freeze(Object.values(SEGMENT_KIND))
export const ANCHOR_KIND_VALUES = Object.freeze(Object.values(ANCHOR_KIND))
export const FORM_VALUES = Object.freeze(Object.values(FORM))

/** 渲染/展示顺序：定理级在前，步骤在后（SPEC §2.4 的呈现序） */
export const ROLE_ORDER = Object.freeze([
  ROLE.CORE_IDEA,
  ROLE.QUESTION,
  ROLE.BIRDVIEW,
  ROLE.STEP,
  ROLE.COMMENTARY,
  ROLE.NEGATIVE_SPACE,
])

/** 定理级 role：锚点必须指向 root（规则 V13） */
export const THEOREM_LEVEL_ROLES = Object.freeze([
  ROLE.CORE_IDEA,
  ROLE.QUESTION,
  ROLE.BIRDVIEW,
  ROLE.COMMENTARY,
  ROLE.NEGATIVE_SPACE,
])

// ── 派生表 ───────────────────────────────────────────────────────────

/** SPEC §3.2 长度上限（正文汉字数；公式与代码不计） */
export const LENGTH_LIMIT = Object.freeze({
  [ROLE.CORE_IDEA]: 40,
  [ROLE.QUESTION]: 120,
  [ROLE.BIRDVIEW]: 150,
  [ROLE.STEP]: 150,
  [ROLE.COMMENTARY]: 250,
  [ROLE.NEGATIVE_SPACE]: 200,
})

/** SPEC §3.1 默认 height（**默认值，不是校验规则**；校验器不得据此拒绝 `step` + `bird`） */
export const ROLE_DEFAULT_HEIGHT = Object.freeze({
  [ROLE.CORE_IDEA]: HEIGHT.BIRD,
  [ROLE.QUESTION]: HEIGHT.BIRD,
  [ROLE.BIRDVIEW]: HEIGHT.BIRD,
  [ROLE.COMMENTARY]: HEIGHT.BIRD,
  [ROLE.NEGATIVE_SPACE]: HEIGHT.BIRD,
  [ROLE.STEP]: HEIGHT.FROG,
})

/** 仅供排序/分档，不参与正确性判定 */
export const EVIDENCE_RANK = Object.freeze({
  [EVIDENCE.FORMAL]: 5,
  [EVIDENCE.LITERATURE]: 4,
  [EVIDENCE.UNFOLDING]: 3,
  [EVIDENCE.ANALOGY]: 2,
  [EVIDENCE.INTUITION]: 1,
})

export const SIGNIFICANCE_RANK = Object.freeze({
  [SIGNIFICANCE.MAIN]: 3,
  [SIGNIFICANCE.SUPPORTING]: 2,
  [SIGNIFICANCE.CONTEXT]: 1,
})

/** 可作为推理前提的凭证（规则 V6 的视图过滤依据） */
export const PRECISE_EVIDENCE = Object.freeze([
  EVIDENCE.FORMAL,
  EVIDENCE.LITERATURE,
  EVIDENCE.UNFOLDING,
])

/** 隐喻只允许来自这两类（规则 V2） */
export const METAPHOR_ALLOWED_EVIDENCE = Object.freeze([
  EVIDENCE.ANALOGY,
  EVIDENCE.INTUITION,
])

/** 强锚点类型（规则 V3） */
export const STRONG_ANCHOR_KINDS = Object.freeze([
  ANCHOR_KIND.DECL,
  ANCHOR_KIND.GOAL,
])

// ── 断言工具 ─────────────────────────────────────────────────────────

/**
 * 枚举成员判定。
 * @param {readonly string[]} values
 * @param {unknown} value
 * @returns {boolean}
 */
export function isEnumValue(values, value) {
  return typeof value === 'string' && values.includes(value)
}

/**
 * 给出枚举的合法取值清单，用于错误消息（必须带修复动作，SPEC §4.1）。
 * @param {readonly string[]} values
 * @returns {string}
 */
export function allowedHint(values) {
  return values.map((v) => JSON.stringify(v)).join(' / ')
}

/** 契约版本（SPEC §8.1）；枚举增删必须同步升版 */
export const SPEC_VERSION = '1.4.0'

/** 数据集固定的 Mathlib 版本（SPEC §8.1） */
export const MATHLIB_BASELINE = 'v4.28.0-rc1'
