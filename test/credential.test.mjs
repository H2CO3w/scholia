/**
 * credential.test.mjs — V1–V16 校验规则的验收测试
 *
 * 验收判据（task 定义 / docs/INTERFACES.md §4）：
 *   **每条规则至少一个「应当拒绝」用例 + 一个「应当通过」用例。**
 *
 * 纯测试，无网络、无 DSH、无 Lean。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  RULE,
  beliefBoundary,
  computeMetrics,
  countTextLength,
  stripNonProse,
  validateAnnotation,
  validateAnnotations,
} from '../src/core/credential.mjs'
import { ROLE, SEGMENT_KIND } from '../src/core/enums.mjs'

// ── 夹具 ──────────────────────────────────────────────────────────────

const SKELETON = {
  theorem: 'Mathlib.Algebra.Group.Even.add',
  root: 'n0',
  nodes: {
    n0: {
      id: 'n0',
      decl: 'Mathlib.Algebra.Group.Even.add',
      kind: 'theorem',
      signature: '∀ {α} [AddCommSemigroup α] {a b}, Even a → Even b → Even (a + b)',
      typeFingerprint: 'sha256:aaaa',
      hypotheses: ['ha', 'hb'],
      parent: null,
      lemmaRefs: ['Even.add'],
      source: 'lsv2',
      truncated: false,
    },
    n1: {
      id: 'n1',
      decl: null,
      kind: 'have',
      signature: 'Even b',
      typeFingerprint: 'sha256:bbbb',
      hypotheses: [],
      parent: 'n0',
      lemmaRefs: [],
      source: 'lsv2',
      truncated: false,
    },
  },
  coverage: {
    mode: 'tactic-multiline',
    haveCount: 1,
    nodeCount: 2,
    degraded: false,
    degradeReason: null,
  },
}

const PROVENANCE = { model: 'deepseek-flash', ts: '2026-10-07T22:00:00+08:00', run: 'test-01' }

/** 一个「应当通过」的步骤注解基线 */
function stepAnn(overrides = {}) {
  return {
    id: 'a1',
    node: 'n1',
    role: ROLE.STEP,
    valueType: 'technique',
    culture: 'problem',
    height: 'frog',
    evidence: 'formal',
    significance: 'main',
    presentation: 'paraphrase',
    audience: 'grad-math',
    segments: [{ kind: SEGMENT_KIND.REASONING, text: '把两个偶数直接相加，闭合性立刻得到。' }],
    anchors: [{ kind: 'goal', target: 'n1' }],
    refs: [],
    provenance: { ...PROVENANCE },
    ...overrides,
  }
}

/** 一个「应当通过」的定理级注解基线 */
function theoremAnn(overrides = {}) {
  return {
    id: 'a2',
    node: 'n0',
    role: ROLE.CORE_IDEA,
    height: 'bird',
    evidence: 'intuition',
    significance: 'supporting',
    presentation: 'paraphrase',
    audience: 'grad-math',
    segments: [{ kind: SEGMENT_KIND.REASONING, text: '偶数类对加法封闭。' }],
    anchors: [{ kind: 'goal', target: 'n0' }],
    refs: [],
    provenance: { ...PROVENANCE },
    ...overrides,
  }
}

/** 断言诊断中出现了某条规则 */
function assertRule(ann, rule, skeleton = SKELETON) {
  const r = validateAnnotation(ann, skeleton)
  const hit = r.diagnostics.filter((d) => d.rule === rule)
  assert.ok(
    hit.length > 0,
    `期望触发 ${rule}，实际诊断为 ${JSON.stringify(r.diagnostics.map((d) => d.rule))}`,
  )
  return hit
}

/** 断言完全通过 */
function assertClean(ann, skeleton = SKELETON) {
  const r = validateAnnotation(ann, skeleton)
  assert.deepEqual(
    r.diagnostics, [],
    `期望无诊断，实际为 ${JSON.stringify(r.diagnostics, null, 2)}`,
  )
  return r
}

// ── 基线：两条「应当通过」的注解 ──────────────────────────────────────

test('基线：合法的步骤注解无任何诊断', () => {
  const r = assertClean(stepAnn())
  assert.equal(r.ok, true)
  assert.equal(r.claimable, true, 'formal 凭证应当可作推理前提')
  assert.deepEqual(r.length, { used: r.length.used, limit: 150 })
})

test('基线：合法的定理级注解无任何诊断', () => {
  assertClean(theoremAnn())
})

// ── V1 ────────────────────────────────────────────────────────────────

test('V1 拒绝：significance=main 但只有 weak 锚点', () => {
  const hit = assertRule(
    stepAnn({ significance: 'main', anchors: [{ kind: 'hyp', target: 'ha' }] }),
    RULE.V1,
  )
  assert.match(hit[0].message, /强锚点|decl\/goal/)
})

test('V1 通过：significance=main 且有 goal 锚点', () => {
  assertClean(stepAnn({ significance: 'main' }))
})

test('V1 通过：significance=supporting 无需强锚点', () => {
  // 用 unfolding 而非 formal，避免同时触发 V3（V3 才是管 formal 必须有强锚点的规则）
  assertClean(stepAnn({
    significance: 'supporting',
    evidence: 'unfolding',
    anchors: [{ kind: 'hyp', target: 'ha' }],
  }))
})

test('V1/V14 通过：仅挂 hyp 锚点的步骤注解合法（hyp 的 target 是假设名，不是节点 id）', () => {
  const r = validateAnnotation(
    stepAnn({ significance: 'supporting', evidence: 'unfolding', anchors: [{ kind: 'hyp', target: 'ha' }] }),
    SKELETON,
  )
  assert.deepEqual(r.diagnostics, [])
})

// ── V2 ────────────────────────────────────────────────────────────────

test('V2 拒绝：metaphor 配 formal 凭证', () => {
  const hit = assertRule(stepAnn({ presentation: 'metaphor', evidence: 'formal' }), RULE.V2)
  assert.match(hit[0].message, /analogy|intuition/)
})

test('V2 通过：metaphor 配 analogy 凭证', () => {
  const r = validateAnnotation(
    stepAnn({ presentation: 'metaphor', evidence: 'analogy', significance: 'supporting' }),
    SKELETON,
  )
  assert.equal(r.diagnostics.filter((d) => d.rule === RULE.V2).length, 0)
})

// ── V3 ────────────────────────────────────────────────────────────────

test('V3 拒绝：evidence=formal 但没有 decl/goal 锚点', () => {
  const hit = assertRule(
    stepAnn({ evidence: 'formal', significance: 'supporting', anchors: [{ kind: 'hyp', target: 'ha' }] }),
    RULE.V3,
  )
  assert.match(hit[0].message, /unfolding|analogy|intuition/)
})

test('V3 通过：evidence=formal 配 goal 锚点', () => {
  const r = validateAnnotation(stepAnn({ evidence: 'formal' }), SKELETON)
  assert.equal(r.diagnostics.filter((d) => d.rule === RULE.V3).length, 0)
})

// ── V4 ────────────────────────────────────────────────────────────────

test('V4 拒绝：使用 display（行号）锚点', () => {
  const hit = assertRule(
    stepAnn({ significance: 'supporting', anchors: [{ kind: 'display', target: 'L120' }] }),
    RULE.V4,
  )
  assert.match(hit[0].message, /行号|decl \/ goal \/ hyp/)
})

test('V4 通过：不使用 display 锚点', () => {
  const r = validateAnnotation(stepAnn(), SKELETON)
  assert.equal(r.diagnostics.filter((d) => d.rule === RULE.V4).length, 0)
})

// ── V5 ────────────────────────────────────────────────────────────────

test('V5 拒绝：refs 指向不存在的注解', () => {
  const hit = assertRule(stepAnn({ refs: ['aX'] }), RULE.V5)
  assert.match(hit[0].message, /aX/)
})

test('V5 通过：refs 指向已存在的注解', () => {
  const ann = stepAnn({ refs: ['a9'] })
  const r = validateAnnotation(ann, SKELETON, new Set(['a9']))
  assert.equal(r.diagnostics.filter((d) => d.rule === RULE.V5).length, 0)
})

// ── V6（视图过滤，不是拒绝）──────────────────────────────────────────

test('V6：精确凭证不进入直觉层，且不被判为错误', () => {
  const anns = [
    stepAnn({ id: 'a1', evidence: 'formal' }),
    stepAnn({ id: 'a2', evidence: 'intuition', presentation: 'paraphrase', significance: 'supporting' }),
  ]
  const b = beliefBoundary(anns, SKELETON)
  assert.deepEqual(b.invalid, [], 'V6 是视图过滤，不应产生 invalid')
  assert.ok(b.claimable.includes(0), 'formal 应可作推理前提')
  assert.ok(b.nonClaimable.includes(1), 'intuition 应落入直觉层')
})

// ── V7 ────────────────────────────────────────────────────────────────

test('V7 拒绝：role=step 未给 value_type', () => {
  const ann = stepAnn()
  delete ann.valueType
  const hit = assertRule(ann, RULE.V7)
  assert.match(hit[0].message, /"none"/, '错误消息必须给出修复动作（填 none）')
})

test('V7 通过：role=step 显式填 value_type=none', () => {
  assertClean(stepAnn({ valueType: 'none' }))
})

// ── V8 ────────────────────────────────────────────────────────────────

test('V8 拒绝：role≠step 却给了 value_type', () => {
  const hit = assertRule(theoremAnn({ valueType: 'concept' }), RULE.V8)
  assert.match(hit[0].message, /仅对 role=step 有效/)
})

test('V8 拒绝：role≠step 却给了 culture', () => {
  const hit = assertRule(theoremAnn({ culture: 'theory' }), RULE.V8)
  assert.match(hit[0].message, /culture/)
})

test('V8 通过：role=step 同时给 value_type 与 culture', () => {
  assertClean(stepAnn({ valueType: 'structural', culture: 'theory' }))
})

test('V8 通过：culture 缺省（未命中文化取向时不填）', () => {
  const ann = stepAnn()
  delete ann.culture
  assertClean(ann)
})

// ── V9 ────────────────────────────────────────────────────────────────

test('V9 拒绝：core_idea 超过 40 字上限，且提示重写而非截断', () => {
  const long = '偶数之和对加法封闭这件事本身并不稀奇，真正值得记住的是它把一个代数性质变成了一个可判定的谓词，从而让后续所有关于整除与同余的论证都能复用同一个结构。'
  const hit = assertRule(
    theoremAnn({ segments: [{ kind: SEGMENT_KIND.REASONING, text: long }] }),
    RULE.V9,
  )
  assert.match(hit[0].message, /重写/)
})

test('V9 通过：正文在上限内', () => {
  const r = assertClean(theoremAnn())
  assert.ok(r.length.used <= 40, `实际 ${r.length.used} 应 ≤ 40`)
})

// ── V10 ───────────────────────────────────────────────────────────────

test('V10 拒绝：kind=concept 的段缺少 lexicon_ref', () => {
  const hit = assertRule(
    stepAnn({ segments: [{ kind: SEGMENT_KIND.CONCEPT, text: 'Even 指的是能被 2 整除。' }] }),
    RULE.V10,
  )
  assert.match(hit[0].message, /词典|concept_lookup/)
})

test('V10 通过：kind=concept 的段带 lexicon_ref', () => {
  assertClean(stepAnn({
    segments: [
      { kind: SEGMENT_KIND.CONCEPT, text: 'Even 指的是能被 2 整除。', lexiconRef: 'Even' },
      { kind: SEGMENT_KIND.REASONING, text: '两者相加仍是偶数。' },
    ],
  }))
})

test('V10 拒绝：lexicon_ref 在词典中查不到（伪造引理语义）', () => {
  const ann = stepAnn({
    segments: [{ kind: SEGMENT_KIND.CONCEPT, text: '编的。', lexiconRef: 'Totally.Made.Up.Lemma' }],
  })
  const r = validateAnnotation(ann, SKELETON, null, new Set(['Even', 'Even.add']))
  const hit = r.diagnostics.filter((d) => d.rule === RULE.V10)
  assert.equal(hit.length, 1)
  assert.equal(hit[0].code, 'V10_LEXICON_REF_UNRESOLVED')
  assert.match(hit[0].message, /concept_lookup/, '错误消息必须给出修复动作')
})

test('V10 通过：lexicon_ref 能在词典中解析', () => {
  const ann = stepAnn({
    segments: [{ kind: SEGMENT_KIND.CONCEPT, text: '偶数定义。', lexiconRef: 'Even' }],
  })
  const r = validateAnnotation(ann, SKELETON, null, new Set(['Even', 'Even.add']))
  assert.deepEqual(r.diagnostics, [])
})

test('V10 弱化模式：未传 lexiconNames 时只检查非空', () => {
  // 把已知的弱化行为钉住：防止有人误以为解析检查默认生效。
  // 工具层（annotation_check / annotate_submit）必须传 lexiconNames。
  const ann = stepAnn({
    segments: [{ kind: SEGMENT_KIND.CONCEPT, text: '编的。', lexiconRef: 'Totally.Made.Up.Lemma' }],
  })
  assert.deepEqual(validateAnnotation(ann, SKELETON).diagnostics, [])
})

// ── V11 ───────────────────────────────────────────────────────────────

test('V11 拒绝：segments 为空数组', () => {
  const hit = assertRule(stepAnn({ segments: [] }), RULE.V11)
  assert.match(hit[0].message, /至少含 1 段|reasoning/)
})

test('V11 拒绝：segment.kind 取值非法', () => {
  assertRule(stepAnn({ segments: [{ kind: 'story', text: 'x' }] }), RULE.V11)
})

test('V11 通过：单段 reasoning', () => {
  assertClean(stepAnn({ segments: [{ kind: SEGMENT_KIND.REASONING, text: '直接相加。' }] }))
})

// ── V12 ───────────────────────────────────────────────────────────────

test('V12 拒绝：锚点悬空（指向不存在的节点）', () => {
  const hit = assertRule(
    stepAnn({ node: 'n1', anchors: [{ kind: 'goal', target: 'n999' }] }),
    RULE.V12,
  )
  assert.match(hit[0].message, /skeleton_extract/)
})

test('V12 拒绝：node 不在骨架树中', () => {
  assertRule(stepAnn({ node: 'n777', anchors: [{ kind: 'goal', target: 'n1' }] }), RULE.V12)
})

test('V12 通过：锚点解析到真实节点', () => {
  const r = validateAnnotation(stepAnn(), SKELETON)
  assert.equal(r.diagnostics.filter((d) => d.rule === RULE.V12).length, 0)
  assert.equal(r.anchorChecked, true)
})

test('V12 通过：decl 锚点解析到全限定名', () => {
  assertClean(theoremAnn({
    anchors: [{ kind: 'decl', target: 'Mathlib.Algebra.Group.Even.add' }],
    node: 'n0',
  }))
})

// ── V13 ───────────────────────────────────────────────────────────────

test('V13 拒绝：定理级 role 锚在子节点上', () => {
  const hit = assertRule(
    theoremAnn({ role: ROLE.BIRDVIEW, node: 'n1', anchors: [{ kind: 'goal', target: 'n1' }] }),
    RULE.V13,
  )
  assert.match(hit[0].message, /step/)
})

test('V13 通过：定理级 role 锚在 root', () => {
  for (const role of [ROLE.CORE_IDEA, ROLE.QUESTION, ROLE.BIRDVIEW, ROLE.COMMENTARY, ROLE.NEGATIVE_SPACE]) {
    const r = validateAnnotation(theoremAnn({ role }), SKELETON)
    assert.equal(
      r.diagnostics.filter((d) => d.rule === RULE.V13).length, 0,
      `${role} 锚在 root 时不应触发 V13`,
    )
  }
})

test('V13 通过：role=step 可以锚在子节点', () => {
  const r = validateAnnotation(stepAnn(), SKELETON)
  assert.equal(r.diagnostics.filter((d) => d.rule === RULE.V13).length, 0)
})

// ── V14 ───────────────────────────────────────────────────────────────

test('V14 拒绝：node 与主锚点 target 不一致', () => {
  const hit = assertRule(
    stepAnn({ node: 'n1', anchors: [{ kind: 'goal', target: 'n0' }] }),
    RULE.V14,
  )
  assert.match(hit[0].message, /同一个节点/)
})

test('V14 通过：node 与主锚点一致', () => {
  const r = validateAnnotation(stepAnn(), SKELETON)
  assert.equal(r.diagnostics.filter((d) => d.rule === RULE.V14).length, 0)
})

// ── V15 ───────────────────────────────────────────────────────────────

test('V15 拒绝：缺少 provenance', () => {
  const ann = stepAnn()
  delete ann.provenance
  assertRule(ann, RULE.V15)
})

test('V15 拒绝：provenance 缺字段', () => {
  assertRule(stepAnn({ provenance: { model: 'x', ts: 'y' } }), RULE.V15)
})

test('V15 通过：provenance 三字段齐全', () => {
  const r = validateAnnotation(stepAnn(), SKELETON)
  assert.equal(r.diagnostics.filter((d) => d.rule === RULE.V15).length, 0)
})

// ── V16 ───────────────────────────────────────────────────────────────

test('V16：同一 (node, role) 重复提交 ⇒ 覆盖并报告，不算失败', () => {
  const anns = [
    stepAnn({ id: 'a1' }),
    stepAnn({ id: 'a2', valueType: 'concept' }),
  ]
  const r = validateAnnotations(anns, SKELETON)
  assert.equal(r.ok, true, 'V16 是覆盖不是拒绝')
  assert.equal(r.duplicates.length, 1)
  assert.equal(r.duplicates[0].index, 1)
  assert.equal(r.duplicates[0].overwritesIndex, 0)
  assert.equal(r.duplicates[0].node, 'n1')
})

test('V16 通过：不同 role 的注解不算重复', () => {
  const anns = [
    stepAnn({ id: 'a1' }),
    stepAnn({ id: 'a2', role: ROLE.COMMENTARY, node: 'n0', anchors: [{ kind: 'goal', target: 'n0' }], valueType: undefined }),
  ]
  const r = validateAnnotations(anns, SKELETON)
  assert.equal(r.duplicates.length, 0)
})

// ── 批量与指标 ────────────────────────────────────────────────────────

test('validateAnnotations：逐条返回诊断且带 index', () => {
  const anns = [stepAnn({ id: 'ok' }), stepAnn({ id: 'bad', valueType: undefined })]
  const r = validateAnnotations(anns, SKELETON)
  assert.equal(r.total, 2)
  assert.equal(r.passed, 1)
  assert.equal(r.failed, 1)
  assert.equal(r.ok, false)
  const d = r.diagnostics.find((x) => x.rule === RULE.V7)
  assert.equal(d.index, 1)
  assert.equal(d.annotationId, 'bad')
  assert.equal(d.code, 'V7_VALUE_TYPE_REQUIRED')
  assert.equal(d.field, 'valueType')
})

test('validateAnnotations：maxDiagnostics 截断但报告总数', () => {
  const anns = Array.from({ length: 5 }, (_, i) => stepAnn({ id: `a${i}`, valueType: undefined }))
  const r = validateAnnotations(anns, SKELETON, { maxDiagnostics: 2 })
  assert.equal(r.truncated, true)
  assert.equal(r.diagnostics.length, 2)
  assert.ok(r.diagnosticsTotal >= 5)
})

test('validateAnnotation：输入不是对象时产出诊断而不是抛异常', () => {
  const r = validateAnnotation(null, SKELETON)
  assert.equal(r.ok, false)
  assert.equal(r.diagnostics[0].rule, RULE.SCHEMA)
})

test('SCHEMA：role 取值非法时给出合法值清单', () => {
  const hit = assertRule(stepAnn({ role: 'intro' }), RULE.SCHEMA)
  assert.ok(hit.some((d) => d.code === 'SCHEMA_ROLE_INVALID'))
  assert.ok(hit.some((d) => /core_idea/.test(d.message)), '错误消息应列出合法取值')
})

test('computeMetrics：mainCoverage 只统计 significance=main 的注解', () => {
  const m = computeMetrics([stepAnn({ significance: 'main' })], SKELETON)
  assert.equal(m.nodeCount, 2)
  assert.equal(m.annotatedNodeCount, 1, '只有 n1 被 main 注解覆盖')
  assert.equal(m.mainCoverage, 0.5)
  assert.equal(m.anchorPrecision, 1)
  assert.equal(m.conceptCoverage, null, '没算必须是 null，不是 0')
})

test('computeMetrics：没有 main 注解时 anchorPrecision 为 null 而非 0', () => {
  const m = computeMetrics([stepAnn({ significance: 'supporting' })], SKELETON)
  assert.equal(m.anchorPrecision, null)
  assert.equal(m.annotatedNodeCount, 0, '算出来是零时用 0')
})

// ── 长度计量 ──────────────────────────────────────────────────────────

test('stripNonProse 剥掉公式与代码，保留正文', () => {
  const s = stripNonProse('由 $a + b = b + a$ 得 `Even.add` 成立。\n```\ncode\n```')
  assert.ok(!s.includes('a + b'), '行内公式应被剥掉')
  assert.ok(!s.includes('Even.add'), '行内代码应被剥掉')
  assert.ok(!s.includes('code'), '围栏代码块应被剥掉')
  assert.ok(s.includes('由') && s.includes('成立'))
})

test('countTextLength：汉字按字计，拉丁按词计，公式不计', () => {
  assert.equal(countTextLength([{ text: '偶数相加' }]), 4)
  assert.equal(countTextLength([{ text: 'even plus even' }]), 3)
  assert.equal(countTextLength([{ text: '$x^2 + y^2$' }]), 0)
  assert.equal(countTextLength([]), 0)
  assert.equal(countTextLength(null), 0)
})

test('countTextLength：长公式不占用注解字数配额', () => {
  const withFormula = '$\\sum_{i=1}^{n} a_i b_i \\le \\sqrt{\\sum a_i^2} \\sqrt{\\sum b_i^2}$'
  assert.equal(countTextLength([{ text: withFormula }]), 0)
})
