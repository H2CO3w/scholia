/**
 * skeleton.test.mjs — src/core/skeleton.mjs 的验收测试
 *
 * 覆盖 SPEC §2.1/§2.2 的硬要求、INTERFACES §2.3 的冻结签名、H3/H5 的诚实性约束。
 * 纯测试：无网络、无 DSH、无 Lean、无语料文件依赖（真实语料由手工自查脚本验证）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  TRUNCATION_SUSPECT_THRESHOLD,
  VALUE_TRUNCATION_LIMIT,
  classifyProof,
  extractHaveBindings,
  extractHypotheses,
  extractLemmaRefs,
  fingerprint,
  isEvaluationSafe,
  recordToSkeleton,
} from '../src/core/skeleton.mjs'
import { NODE_KIND, PROOF_MODE, SOURCE } from '../src/core/enums.mjs'

// ── 夹具（取自真实语料 data/lsv2.jsonl 的排版）──────────────────────────

const NESTED_VALUE = [
  ':= by',
  '  have i₁ : 0 ≤ P := by',
  '    have idem : P * P = 4 * P := CHSH_id T.A₀_inv',
  "    have idem' : P = (1 / 4 : ℝ) • (P * P) :=",
  '      by',
  '      have h : 4 * P = (4 : ℝ) • P := by simp [map_ofNat]',
  '      rw [idem, h, ← Algebra.smul_def, Nat.mul_comm]',
  '    have sa : star P = P := by',
  '      dsimp [P]',
  '  have h₂ : P + 1 = 2 := by simp',
  '  exact h₂',
].join('\n')

const RECORD = {
  name: ['Mathlib.Algebra.Group.Even.add'],
  module_name: ['Mathlib', 'Algebra', 'Group', 'Even'],
  kind: NODE_KIND.THEOREM,
  signature: '∀ {α} [AddCommSemigroup α] {a b : α}, Even a → Even b → Even (a + b)',
  value: NESTED_VALUE,
  informal_name: 'Sum of even numbers',
  informal_description: '两个偶数之和仍是偶数。',
}

function idsOf(tree) {
  return Object.keys(tree.nodes)
}

// ── 语料外真实 Lean 夹具（test/fixtures/lean/）─────────────────────────
//
// 为什么要有这一段：此前 test/ 里**没有任何语料外用例**，三个静默缺陷
// （空签名 / 丢绑定前缀 / 丢 localName）才能藏一整轮 —— 因为测试测的是校验器，
// 从没测过提取器的产出质量。夹具取自 openai/NavierStokesAndEuler（Apache-2.0），
// 每个文件头写明来源与许可。

const FIXTURE_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'lean')

/** 从 .lean 文件里取第一个 theorem/lemma 的 tactic 证明体（做法见 ARCHITECTURE §11.1c） */
function fixtureProofBody(fileName) {
  const lines = readFileSync(join(FIXTURE_DIR, fileName), 'utf8').split('\n')
  const start = lines.findIndex((line) => /^(theorem|lemma)\s/.test(line))
  assert.ok(start >= 0, `${fileName} 里应当有一个 theorem/lemma`)
  const baseIndent = lines[start].match(/^\s*/)[0].length
  let i = start
  while (i < lines.length && !/:= by\s*$/.test(lines[i])) i += 1
  assert.ok(i < lines.length, `${fileName} 的证明应当以 := by 结尾`)
  const body = [':= by']
  for (i += 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() !== '' && line.match(/^\s*/)[0].length <= baseIndent) break
    body.push(line)
  }
  while (body.length > 1 && body[body.length - 1].trim() === '') body.pop()
  return { name: fileName.replace(/\.lean$/, ''), value: body.join('\n') }
}

/** have 行真值：行首（可带聚焦子弹）的 have 声明数 */
function haveLineTruth(body) {
  return body.split('\n').filter((line) => /^\s*(?:·+\s*)?have\s/.test(line)).length
}

function fixtureTree(fileName) {
  const { name, value } = fixtureProofBody(fileName)
  // 语料记录总是带 signature 字段，夹具也照此构造：根节点有陈述，signatureMissingCount 只数 have
  return recordToSkeleton({ name: [`Fixture.${name}`], kind: NODE_KIND.THEOREM, signature: 'True', value })
}

/** 六种形态的夹具清单：文件、真值 have 数、以及这一形态要守的性质 */
const FIXTURES = [
  { file: '01-typed-have.lean', haves: 3, note: '有类型标注（基线）' },
  { file: '02-untyped-have.lean', haves: 2, note: '无类型标注（缺陷 A）' },
  { file: '03-binder-have.lean', haves: 2, note: '带绑定前缀（缺陷 B）' },
  { file: '04-nested-have.lean', haves: 3, note: '嵌套 have' },
  { file: '05-bullet-have.lean', haves: 3, note: '聚焦子弹 have' },
  { file: '06-term-have.lean', haves: 4, note: '项模式 have' },
]

test('语料外夹具：六种 have 形态的节点计数与 have 行真值完全一致', () => {
  for (const { file, haves, note } of FIXTURES) {
    const { value } = fixtureProofBody(file)
    const tree = fixtureTree(file)
    assert.equal(tree.coverage.haveCount, haves, `${file}（${note}）的 have 真值应为 ${haves}`)
    assert.equal(
      tree.coverage.haveCount, haveLineTruth(value),
      `${file}：节点数必须等于 have 行真值（计数是 100% 准确的，不能弄坏）`,
    )
    assert.deepEqual(
      idsOf(tree), Array.from({ length: haves + 1 }, (_, i) => `n${i}`),
      `${file}：id 必须是 n0..n${haves} 的 DFS 前序`,
    )
    for (const id of idsOf(tree)) {
      const node = tree.nodes[id]
      assert.ok(Array.isArray(node.hypotheses), `${file}/${id} 必须带 hypotheses`)
      assert.equal(node.truncated, false, `${file}/${id} 夹具不应被判为截断`)
    }
  }
})

test('语料外夹具 02：无类型 have → signatureUnknown + 指纹 null + rawText（缺陷 A）', () => {
  const tree = fixtureTree('02-untyped-have.lean')
  const untyped = idsOf(tree).filter((id) => tree.nodes[id].signatureUnknown === true)
  assert.equal(untyped.length, 2, 'have h := … 与 have hs := … 都要标出来')
  assert.equal(tree.coverage.signatureMissingCount, 2, '规模必须在 coverage 里可见')
  for (const id of untyped) {
    const node = tree.nodes[id]
    assert.equal(node.signature, '', '不知道类型就不许编，签名为空串')
    assert.equal(node.typeFingerprint, null, '★ 不得是 fingerprint("") 那个常数')
    assert.notEqual(node.typeFingerprint, fingerprint(''))
    assert.match(node.rawText, /^have /, 'rawText 保留逐字原文，供下游在陈述未知时使用')
    assert.ok(node.rawText.includes(':= '), 'rawText 要包含证明项本身')
  }
  const named = untyped.map((id) => tree.nodes[id].localName)
  assert.deepEqual(named, ['h', 'hs'])
})

test('语料外夹具 03：带绑定 have 的签名保留绑定前缀（缺陷 B：丢量词）', () => {
  const tree = fixtureTree('03-binder-have.lean')
  const hd = idsOf(tree).map((id) => tree.nodes[id]).find((n) => n.localName === 'hd')
  assert.ok(hd, 'have hd 必须建节点')
  assert.ok(hd.signature.startsWith('(s : ℝ) :'), `绑定前缀必须保留，实际为 ${JSON.stringify(hd.signature)}`)
  assert.match(hd.signature, /HasDerivAt/)
  assert.equal(hd.signatureUnknown, undefined, '有类型标注的不算未知')
  assert.equal(hd.typeFingerprint, fingerprint(hd.signature))
  assert.notEqual(hd.typeFingerprint, null)
})

test('语料外夹具 04：嵌套 have 的 parent 是紧邻外层 have', () => {
  const tree = fixtureTree('04-nested-have.lean')
  const byLocal = (name) => idsOf(tree).find((id) => tree.nodes[id].localName === name)
  const hzero = byLocal('hzero')
  const hp = byLocal('hp')
  assert.ok(hzero && hp)
  assert.equal(tree.nodes[hp].parent, hzero, '内层 have 挂在 hzero 上，不是 root')
  assert.equal(tree.nodes[hzero].parent, tree.root)
  assert.equal(tree.nodes[hp].signatureUnknown, true, 'have hp := … 也是无类型形态')
  assert.equal(tree.nodes[hp].typeFingerprint, null)
})

test('语料外夹具 05：聚焦子弹后的 have 与嵌套都建对', () => {
  const tree = fixtureTree('05-bullet-have.lean')
  const locals = idsOf(tree).filter((id) => id !== tree.root).map((id) => tree.nodes[id].localName)
  assert.deepEqual(locals, ['hh', 'hr', 'hh'])
  const hr = idsOf(tree).find((id) => tree.nodes[id].localName === 'hr')
  const nestedHh = idsOf(tree).filter((id) => id !== hr).find((id) => tree.nodes[id].localName === 'hh' && tree.nodes[id].parent === hr)
  assert.ok(nestedHh, 'hr 的 by 块里的 have hh 必须挂在 hr 上')
  assert.equal(tree.nodes[hr].signatureUnknown, undefined, 'hr 有类型标注')
  assert.equal(tree.nodes[hr].typeFingerprint, fingerprint(tree.nodes[hr].signature))
})

test('语料外夹具 06：项模式 have（值不是 by 块）签名与指纹照常', () => {
  const tree = fixtureTree('06-term-have.lean')
  assert.equal(tree.coverage.signatureMissingCount, 0)
  for (const id of idsOf(tree)) {
    const node = tree.nodes[id]
    assert.notEqual(node.signature, '', `${id} 有类型标注，签名不应为空`)
    assert.equal(node.typeFingerprint, fingerprint(node.signature))
  }
  assert.ok(
    idsOf(tree).some((id) => tree.nodes[id].signature.startsWith('Continuous (fun s =>')),
    '多行项模式 have 的签名也要完整',
  )
})

test('★ 全树指纹不变量：null ⇔ 签名未知；非 null 指纹与其签名一一对应', () => {
  for (const { file } of FIXTURES) {
    const tree = fixtureTree(file)
    const byFingerprint = new Map()
    for (const id of idsOf(tree)) {
      const node = tree.nodes[id]
      assert.equal(
        node.typeFingerprint === null, node.signature === '',
        `${file}/${id}: typeFingerprint 必须 null ⇔ 签名为空（防漂移机制的底线）`,
      )
      if (node.typeFingerprint === null) continue
      if (byFingerprint.has(node.typeFingerprint)) {
        assert.equal(
          byFingerprint.get(node.typeFingerprint), node.signature,
          `${file}/${id}: 同一指纹必须来自同一签名`,
        )
      } else {
        byFingerprint.set(node.typeFingerprint, node.signature)
      }
    }
  }
})

test('★ 空签名不再共享常数指纹：两个无类型 have 的指纹都是 null，而不是同一个哈希', () => {
  const tree = fixtureTree('02-untyped-have.lean')
  const untyped = Object.values(tree.nodes).filter((n) => n.signatureUnknown === true)
  assert.equal(untyped.length, 2)
  assert.deepEqual(untyped.map((n) => n.typeFingerprint), [null, null])
  assert.notEqual(untyped[0].typeFingerprint, fingerprint(''))
  assert.equal(fingerprint(''), 'sha256:e3b0c44298fc1c14', '这就是那个「看起来像指纹」的常数')
})

test('根节点签名缺失同样按「陈述未知」处理（不许用常数指纹）', () => {
  const tree = recordToSkeleton({ name: ['Foo.bar'], kind: NODE_KIND.THEOREM, value: ':= by simp' })
  assert.equal(tree.nodes.n0.signature, '')
  assert.equal(tree.nodes.n0.signatureUnknown, true)
  assert.equal(tree.nodes.n0.typeFingerprint, null)
  assert.equal(tree.coverage.signatureMissingCount, 1, 'coverage 要数所有 signatureUnknown 节点（含根）')
})

// ── fingerprint ───────────────────────────────────────────────────────

test('fingerprint：前缀、长度、空白归一化、确定性', () => {
  const a = fingerprint('Even a →   Even b')
  assert.match(a, /^sha256:[0-9a-f]{16}$/)
  assert.equal(a, fingerprint('Even a →\n\t  Even b'), '空白差异必须归一化到同一指纹')
  assert.equal(a, fingerprint('  Even a →   Even b  '), '首尾空白必须归一化')
  assert.notEqual(a, fingerprint('Even b → Even a'))
  assert.equal(fingerprint(undefined), fingerprint(''))
})

// ── extractHypotheses ─────────────────────────────────────────────────

test('extractHypotheses：圆括号/花括号/方括号绑定都取到名字，返回数组', () => {
  const hyps = extractHypotheses('∀ {α : Type} [CommRing R] (a b : R) (h : Even a), P a b')
  assert.ok(Array.isArray(hyps), 'INTERFACES §2.3 冻结为 string[]')
  assert.deepEqual(hyps, ['a', 'b', 'h', 'α', 'R'])
  assert.deepEqual(extractHypotheses(''), [])
  assert.deepEqual(extractHypotheses(null), [])
})

// ── extractHaveBindings ───────────────────────────────────────────────

test('extractHaveBindings：tactic 体里逐个 have，名字/签名/depth 正确', () => {
  const r = extractHaveBindings(NESTED_VALUE)
  assert.equal(r.supported, true)
  assert.deepEqual(
    r.bindings.map((b) => b.localName),
    ['i₁', 'idem', "idem'", 'h', 'sa', 'h₂'],
  )
  assert.deepEqual(
    r.bindings.map((b) => b.depth),
    [0, 1, 1, 2, 1, 0],
    'depth = 外层 have 的层数',
  )
  assert.equal(r.bindings[0].signature, '0 ≤ P')
  assert.equal(r.bindings[2].signature, 'P = (1 / 4 : ℝ) • (P * P)')
  assert.equal(r.bindings[5].signature, 'P + 1 = 2')
})

test('extractHaveBindings：名字后带绑定子（{n : ℕ} (hn : …)）也能取到类型', () => {
  const value = ':= by\n  have hF {n : ℕ} (hn : n ≠ 0) : F n = f n := if_neg hn\n  exact hF'
  const r = extractHaveBindings(value)
  assert.equal(r.bindings.length, 1)
  assert.equal(r.bindings[0].localName, 'hF')
  assert.equal(
    r.bindings[0].signature,
    '{n : ℕ} (hn : n ≠ 0) : F n = f n',
    '绑定前缀丢了，命题就从 ∀ n, … 被削弱成 …，且看着完全正常',
  )
  assert.equal(r.bindings[0].signatureUnknown, false)
})

test('extractHaveBindings：reason 区分「喂错东西」与「真的没有 have」（v1.3）', () => {
  const wholeFile = 'theorem foo : P := by\n  have h : P := by simp\n  exact h'
  const wrong = extractHaveBindings(wholeFile)
  assert.equal(wrong.supported, false)
  assert.equal(wrong.reason, 'not-tactic-body', '喂整个文件必须明说，而不是静默返回空数组')
  assert.deepEqual(wrong.bindings, [])

  const empty = extractHaveBindings('   \n ')
  assert.equal(empty.supported, false)
  assert.equal(empty.reason, 'empty-input')

  const reallyEmpty = extractHaveBindings(':= by\n  simp')
  assert.equal(reallyEmpty.supported, true, '确实是 tactic 体但没有 have：这是真实结论')
  assert.equal(reallyEmpty.reason, null)
  assert.deepEqual(reallyEmpty.bindings, [])
})

test('extractHaveBindings：匿名 have 不发明标识符（localName 为空串）', () => {
  const r = extractHaveBindings(':= by\n  have : P := by simp\n  exact this')
  assert.equal(r.bindings.length, 1)
  assert.equal(r.bindings[0].localName, '')
  assert.equal(r.bindings[0].signature, 'P')
})

test('extractHaveBindings：项模式不支持（supported=false），不假装成功', () => {
  const r = extractHaveBindings(':= AddCommGrpCat')
  assert.equal(r.supported, false)
  assert.deepEqual(r.bindings, [])
})

test('extractHaveBindings：注释里的 have 不算节点（行注释与块注释都要掩掉）', () => {
  const value = [
    ':= by',
    '  -- have ghost : P := by simp',
    '  /- have ghost2 : Q := by simp -/',
    '  have real : P := by simp',
    '  exact real',
  ].join('\n')
  const r = extractHaveBindings(value)
  assert.deepEqual(r.bindings.map((b) => b.localName), ['real'])
})

test('extractHaveBindings：have 结束后回到外层（缩进栈按所有非空行维护）', () => {
  const value = [
    ':= by',
    '  have outer : P := by simp',
    '  refine ⟨?_, ?_⟩',
    '  ·',
    '    have inner : Q := by simp',
    '    exact inner',
    '  · simp',
  ].join('\n')
  const r = extractHaveBindings(value)
  assert.deepEqual(r.bindings.map((b) => b.depth), [0, 0], 'inner 不在 outer 的作用域内，depth 应为 0')
})

test('extractHaveBindings：聚焦子弹后的 have 也算（Mathlib 常见写法）', () => {
  const value = [
    ':= by',
    '  rcases h with h | h',
    '  · have hss : Ioc a t₀ ⊆ Ioo a b := Ioc_subset_Ioo_right ht.2',
    '    exact foo hss',
    '  · have : 0 < x :=',
    '      by',
    '      linarith',
  ].join('\n')
  const r = extractHaveBindings(value)
  assert.deepEqual(r.bindings.map((b) => b.localName), ['hss', ''])
  assert.equal(r.bindings[0].signature, 'Ioc a t₀ ⊆ Ioo a b')
  assert.equal(r.bindings[1].signature, '0 < x')
  assert.deepEqual(r.bindings.map((b) => b.depth), [0, 0], '两个分支的 have 都直接挂在根上')
})

// ── classifyProof ─────────────────────────────────────────────────────

test('classifyProof：四种 mode 都认得（枚举取自 enums.mjs）', () => {
  assert.equal(classifyProof(NESTED_VALUE).mode, PROOF_MODE.TACTIC_MULTILINE)
  assert.equal(classifyProof(':= by simp').mode, PROOF_MODE.TACTIC_SINGLE)
  assert.equal(classifyProof(':= AddCommGrpCat').mode, PROOF_MODE.TERM)
  assert.equal(classifyProof('').mode, PROOF_MODE.FAILED)
  assert.equal(classifyProof('   \n ').mode, PROOF_MODE.FAILED)
})

test('classifyProof：退化必置 degraded=true 且 degradeReason 非空（H5：绝不静默降级）', () => {
  for (const value of ['', ':= AddCommGrpCat', ':= by simp', ':= by\n  simp\n  rfl']) {
    const c = classifyProof(value)
    assert.equal(c.degraded, true, `${JSON.stringify(value)} 应标记退化`)
    assert.equal(typeof c.degradeReason, 'string')
    assert.ok(c.degradeReason.length > 0, 'degradeReason 必须能读')
    const reason = c.degradeReason
    assert.match(reason, /请|不要|标注/, `degradeReason 必须带修复动作: ${reason}`)
  }
})

test('classifyProof：多行 tactic + have ⇒ 不退化，degradeReason 为 null', () => {
  const c = classifyProof(NESTED_VALUE)
  assert.equal(c.mode, PROOF_MODE.TACTIC_MULTILINE)
  assert.equal(c.haveCount, 6)
  assert.equal(c.degraded, false)
  assert.equal(c.degradeReason, null)
})

test('classifyProof：截断与结构退化是两个正交信号（task-5 / Q1）', () => {
  const long = `:= by\n  have h : P := by simp\n  simp only [${'x'.repeat(TRUNCATION_SUSPECT_THRESHOLD)}]`
  assert.ok(long.length >= TRUNCATION_SUSPECT_THRESHOLD)

  const structured = classifyProof(long)
  assert.equal(structured.truncated, true, '截断必须外显')
  assert.match(structured.truncateReason, /截断/)
  assert.match(structured.truncateReason, /1 个步骤照常/, '要说清已找到的步骤仍然可用')
  assert.equal(structured.degraded, false, '结构完好（有 have）就不算退化，截断不单独置 degraded')
  assert.equal(structured.degradeReason, null, 'degradeReason 只在 degraded=true 时非空')

  const both = classifyProof(`${':= by simp'}${' '.repeat(TRUNCATION_SUSPECT_THRESHOLD)}`)
  assert.equal(both.degraded, true, '截断 + 无结构 ⇒ 两者同时为真')
  assert.equal(both.truncated, true)
  assert.ok(both.degradeReason.length > 0)
  assert.ok(both.truncateReason.length > 0)

  const ellipsis = classifyProof(`${NESTED_VALUE}\n  ...`)
  assert.equal(ellipsis.truncated, true, '结尾省略号也算截断')
  assert.equal(ellipsis.degraded, false)

  const clean = classifyProof(':= by simp')
  assert.equal(clean.truncated, false)
  assert.equal(clean.truncateReason, null)
  assert.equal(clean.degraded, true, '单行 tactic 是结构退化')
})

test('classifyProof：degraded ⇔ 没有任何中间节点（含多行但无 have 的情形）', () => {
  for (const value of ['', ':= AddCommGrpCat', ':= by simp', ':= by\n  simp\n  rfl']) {
    const c = classifyProof(value)
    assert.equal(c.haveCount, 0)
    assert.equal(c.degraded, true, `${JSON.stringify(value)} 应标记结构退化`)
    assert.equal(typeof c.degradeReason, 'string', 'degraded=true 必须有 degradeReason')
    assert.ok(c.degradeReason.length > 0, 'degradeReason 必须能读（H5 不得静默降级）')
  }
  const noHaveMulti = classifyProof(':= by\n  rfl')
  assert.equal(noHaveMulti.mode, PROOF_MODE.TACTIC_MULTILINE)
  assert.equal(noHaveMulti.degraded, true, 'mode 是多行 tactic 但没有中间节点，仍属结构退化')
})

test('classifyProof：haveCount 与 extractHaveBindings 一致', () => {
  for (const value of [NESTED_VALUE, ':= by simp', ':= 3', '', ':= by\n  have a : P := by simp']) {
    assert.equal(classifyProof(value).haveCount, extractHaveBindings(value).bindings.length)
  }
})

// ── extractLemmaRefs ──────────────────────────────────────────────────

test('extractLemmaRefs：取限定名、去重、剔掉变量上的字段投影', () => {
  const refs = extractLemmaRefs(
    'CHSH_id T.A₀_inv rw [Nat.add_comm, Even.add, Nat.add_comm] hx.mp List.map_sum',
  )
  assert.deepEqual(refs, ['Nat.add_comm', 'Even.add', 'List.map_sum'])
  assert.ok(!refs.includes('CHSH_id'), '非限定名不进 lemma_refs（词典按全限定名索引）')
  assert.ok(!refs.includes('T.A₀_inv'), '变量上的字段投影不是引理名')
  assert.ok(!refs.includes('hx.mp'), '两段式变量投影不是引理名')
  assert.deepEqual(extractLemmaRefs(''), [])
  assert.deepEqual(extractLemmaRefs('simp only [foo, bar]'), [], '非限定名不进 lemma_refs')
})

test('extractLemmaRefs：iff 方向投影归一到真实引理名，两段式全名不动', () => {
  assert.deepEqual(
    extractLemmaRefs('Asymptotics.isBigO_iff.mp hC  mem_insert.mpr hIff  Iff.mp hIff'),
    ['Asymptotics.isBigO_iff', 'mem_insert.mpr', 'Iff.mp'],
    '三段及以上的 .mp/.mpr 是投影；两段式可能是环境里真实存在的全名',
  )
})

// ── recordToSkeleton：形状 ────────────────────────────────────────────

test('SkeletonTree 形状：只有 theorem/root/nodes/coverage 四个键，没有旧索引', () => {
  const tree = recordToSkeleton(RECORD)
  assert.deepEqual(Object.keys(tree).sort(), ['coverage', 'nodes', 'root', 'theorem'])
  assert.equal(tree.theorem, 'Mathlib.Algebra.Group.Even.add')
  assert.equal(tree.root, 'n0')
  assert.equal(tree.declIndex, undefined, 'declIndex 必须从树上移除（INTERFACES §2.4）')
  assert.equal(tree.hypothesisIndex, undefined, 'hypothesisIndex 必须从树上移除')
  assert.equal(tree.meta, undefined, '旧 meta 段必须移除')
})

test('coverage 形状：八个字段齐全，计数自洽（截断 / 退化 / 陈述未知分开）', () => {
  const tree = recordToSkeleton(RECORD)
  assert.deepEqual(
    Object.keys(tree.coverage).sort(),
    ['degradeReason', 'degraded', 'haveCount', 'mode', 'nodeCount',
      'signatureMissingCount', 'truncateReason', 'truncated'],
  )
  assert.equal(tree.coverage.mode, PROOF_MODE.TACTIC_MULTILINE)
  assert.equal(tree.coverage.haveCount, 6)
  assert.equal(tree.coverage.nodeCount, Object.keys(tree.nodes).length)
  assert.equal(tree.coverage.truncated, false)
  assert.equal(tree.coverage.truncateReason, null)
  assert.equal(tree.coverage.degraded, false)
  assert.equal(tree.coverage.degradeReason, null)
  assert.equal(tree.coverage.signatureMissingCount, 0)

  const term = recordToSkeleton({ ...RECORD, value: ':= AddCommGrpCat' })
  assert.equal(term.coverage.mode, PROOF_MODE.TERM)
  assert.equal(term.coverage.haveCount, 0)
  assert.equal(term.coverage.nodeCount, 1)
  assert.equal(term.coverage.degraded, true)
  assert.ok(term.coverage.degradeReason.length > 0)
  assert.equal(term.coverage.truncated, false)

  // 截断但结构完好：degraded=false，truncated=true —— 这是 task-5 要分开的那一格
  const truncatedStructured = recordToSkeleton({
    ...RECORD,
    value: `${NESTED_VALUE}\n  ...`,
  })
  assert.equal(truncatedStructured.coverage.truncated, true)
  assert.equal(truncatedStructured.coverage.degraded, false)
  assert.equal(truncatedStructured.coverage.degradeReason, null)
  assert.match(truncatedStructured.coverage.truncateReason, /截断/)
  assert.equal(truncatedStructured.nodes.n0.truncated, true)
})

test('SkeletonNode 形状：必需字段与 SPEC §2.1 一致，条件字段只在适用时出现', () => {
  const tree = recordToSkeleton(RECORD)
  const required = [
    'decl', 'hypotheses', 'id', 'kind', 'lemmaRefs', 'parent',
    'signature', 'source', 'truncated', 'typeFingerprint',
  ]
  const conditional = ['kindUnknown', 'localName', 'signatureUnknown', 'rawText']
  for (const id of idsOf(tree)) {
    const keys = Object.keys(tree.nodes[id])
    for (const key of required) {
      assert.ok(keys.includes(key), `${id} 缺少必需字段 ${key}`)
    }
    for (const key of keys) {
      assert.ok(
        required.includes(key) || conditional.includes(key),
        `${id} 出现了契约外的字段 ${key}`,
      )
    }
  }
  assert.equal(tree.nodes.n0.decl, 'Mathlib.Algebra.Group.Even.add')
  assert.equal(tree.nodes.n0.parent, null)
  assert.equal(tree.nodes.n0.kind, NODE_KIND.THEOREM)
  assert.equal(tree.nodes.n0.kindUnknown, undefined, '已知种类不带 kindUnknown')
  assert.equal(tree.nodes.n0.signatureUnknown, undefined, '根节点有签名')
  assert.equal(tree.nodes.n0.typeFingerprint, fingerprint(RECORD.signature))
  assert.equal(tree.nodes.n0.source, SOURCE.LSV2)
  assert.equal(tree.nodes.n0.truncated, false)
  assert.ok(tree.nodes.n0.hypotheses.includes('a'))
  assert.ok(tree.nodes.n1.lemmaRefs.includes('Algebra.smul_def'), '节点作用域内的限定名要收进 lemma_refs')
  assert.ok(tree.nodes.n0.lemmaRefs.includes('Algebra.smul_def'), '根节点的 lemma_refs 覆盖整个证明体')
  for (const id of idsOf(tree)) {
    if (id === tree.root) continue
    assert.equal(tree.nodes[id].decl, null, 'have 节点没有全限定名')
  }
  // have 节点要带局部名（缺陷 C：抽出来了却没写进节点）
  assert.deepEqual(
    idsOf(tree).filter((id) => id !== tree.root).map((id) => tree.nodes[id].localName),
    ['i₁', 'idem', "idem'", 'h', 'sa', 'h₂'],
  )
  assert.equal(tree.nodes.n0.localName, undefined, 'root 是声明，不是 have/let，不带 localName')
})

// ── recordToSkeleton：树形状与 id 稳定性（硬要求）─────────────────────

test('嵌套 have 的 parent 是紧邻的外层 have，不是恒为 root', () => {
  const tree = recordToSkeleton(RECORD)
  assert.deepEqual(idsOf(tree), ['n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6'])
  const parentOf = (signature) => {
    const hit = idsOf(tree).find((id) => tree.nodes[id].signature === signature && id !== 'n0')
    return tree.nodes[hit].parent
  }
  assert.equal(parentOf('0 ≤ P'), 'n0', '最外层 have 挂在 root')
  assert.equal(parentOf('P * P = 4 * P'), 'n1', 'idem 的 parent 是 i₁，不是 root')
  assert.equal(parentOf('P = (1 / 4 : ℝ) • (P * P)'), 'n1')
  assert.equal(parentOf('4 * P = (4 : ℝ) • P'), 'n3', "h 的 parent 是 idem'")
  assert.equal(parentOf('star P = P'), 'n1')
  assert.equal(parentOf('P + 1 = 2'), 'n0', 'i₁ 作用域结束后回到 root')
})

test('id 是 DFS 前序：n0 为根，子节点紧跟父节点', () => {
  const tree = recordToSkeleton(RECORD)
  assert.equal(tree.nodes.n1.parent, 'n0')
  assert.equal(tree.nodes.n2.parent, 'n1')
  assert.equal(tree.nodes.n3.parent, 'n1')
  assert.equal(tree.nodes.n4.parent, 'n3')
  assert.equal(tree.nodes.n5.parent, 'n1')
  assert.equal(tree.nodes.n6.parent, 'n0')
  const sig = (id) => tree.nodes[id].signature
  assert.deepEqual(
    idsOf(tree).map(sig),
    ['∀ {α} [AddCommSemigroup α] {a b : α}, Even a → Even b → Even (a + b)',
      '0 ≤ P', 'P * P = 4 * P', 'P = (1 / 4 : ℝ) • (P * P)',
      '4 * P = (4 : ℝ) • P', 'star P = P', 'P + 1 = 2'],
  )
})

test('★ id 稳定性：同一 (theorem, value) 两次调用产出完全相同的 id 集合与内容', () => {
  const first = recordToSkeleton(RECORD)
  const second = recordToSkeleton(JSON.parse(JSON.stringify(RECORD)))
  assert.deepEqual(Object.keys(second.nodes), Object.keys(first.nodes))
  assert.deepEqual(second, first, '同输入必须逐字节同输出（SPEC §7.5 确定性）')

  const third = recordToSkeleton({ ...RECORD })
  assert.deepEqual(Object.keys(third.nodes), ['n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6'])

  // id 集合不依赖调用顺序：穿插调用别的记录后重算仍然一致
  recordToSkeleton({ ...RECORD, name: ['Other.thm'], value: ':= by\n  have z : P := by simp' })
  const fourth = recordToSkeleton(RECORD)
  assert.deepEqual(fourth, first, '穿插其他调用不得影响 id 分配')
})

test('★ id 稳定性：不同证明体的 id 由结构位置决定（同前缀 → 同 id）', () => {
  const a = recordToSkeleton({ ...RECORD, value: ':= by\n  have x : P := by simp\n  exact x' })
  const b = recordToSkeleton({ ...RECORD, value: ':= by\n  have y : Q := by simp\n  exact y' })
  assert.deepEqual(Object.keys(a.nodes), ['n0', 'n1'])
  assert.deepEqual(Object.keys(b.nodes), ['n0', 'n1'], 'id 与 have 的名字/类型无关')
})

// ── 截断 ──────────────────────────────────────────────────────────────

test('截断判定：长度达到阈值或结尾有省略号（常量与 SPEC 一致）', () => {
  assert.equal(VALUE_TRUNCATION_LIMIT, 500)
  assert.equal(TRUNCATION_SUSPECT_THRESHOLD, 490)
  const short = recordToSkeleton({ ...RECORD, value: ':= by simp' })
  assert.equal(short.nodes.n0.truncated, false)
  assert.equal(short.coverage.truncated, false)

  const longValue = `:= by\n  have h : P := by simp\n  simp only [${'x'.repeat(TRUNCATION_SUSPECT_THRESHOLD)}]`
  const longTree = recordToSkeleton({ ...RECORD, value: longValue })
  assert.equal(longTree.nodes.n0.truncated, true)
  assert.equal(longTree.nodes.n1?.truncated, true, '截断是记录级属性，所有节点都要标')
  assert.equal(longTree.coverage.truncated, true, 'coverage 必须与节点标记一致')

  for (const tail of ['...', '⋯', '  ...  ']) {
    const tree = recordToSkeleton({ ...RECORD, value: `:= by simp${tail}` })
    assert.equal(tree.nodes.n0.truncated, true, `结尾 ${JSON.stringify(tail)} 应视为截断`)
    assert.equal(tree.coverage.truncated, true)
  }
})

// ── E-KIND 归一化（task-5 / Q6）────────────────────────────────────────

test('E-KIND 归一化：语料出现的 6 种声明种类不再回落成 theorem', () => {
  const cases = [
    ['inductive', NODE_KIND.INDUCTIVE],
    ['abbrev', NODE_KIND.ABBREV],
    ['opaque', NODE_KIND.OPAQUE],
    ['classInductive', NODE_KIND.CLASS_INDUCTIVE],
    ['constructor', NODE_KIND.CONSTRUCTOR],
    ['recursor', NODE_KIND.RECURSOR],
    ['theorem', NODE_KIND.THEOREM],
    ['definition', NODE_KIND.DEFINITION],
    ['instance', NODE_KIND.INSTANCE],
    ['lemma', NODE_KIND.LEMMA],
  ]
  for (const [raw, expected] of cases) {
    const tree = recordToSkeleton({ ...RECORD, kind: raw, value: ':= by simp' })
    assert.equal(tree.nodes.n0.kind, expected, `${raw} 应归一化为枚举值 ${expected}`)
    assert.equal(tree.nodes.n0.kindUnknown, undefined, `${raw} 是已知种类，不得带 kindUnknown`)
  }
  assert.ok(
    Object.values(NODE_KIND).every((v) => typeof v === 'string' && /^[a-z][a-z_]*$/.test(v)),
    'E-KIND 取值必须全部是 snake_case',
  )
})

test('未知声明种类：保留原值 + kindUnknown，绝不静默回落（诚实性）', () => {
  const unknown = recordToSkeleton({ ...RECORD, kind: 'mysteryKind', value: ':= by simp' })
  assert.equal(unknown.nodes.n0.kind, 'mysteryKind', '未知种类必须原样保留')
  assert.equal(unknown.nodes.n0.kindUnknown, true, '口径缺口必须可观测')

  const missing = recordToSkeleton({ name: 'Foo.bar', value: ':= by simp' })
  assert.equal(missing.nodes.n0.kind, NODE_KIND.THEOREM, '记录没有 kind 时的回落值')
  assert.equal(missing.nodes.n0.kindUnknown, true, '回落必须带标记，不是静默')

  // have 节点永远是 E-KIND.HAVE，不参与声明种类归一化
  const tree = recordToSkeleton(RECORD)
  assert.equal(tree.nodes.n1.kind, NODE_KIND.HAVE)
  assert.equal(tree.nodes.n1.kindUnknown, undefined)
})

// ── source / 错误路径 ─────────────────────────────────────────────────

test('origin 决定 source；非法 origin 必须报错并给出合法取值', () => {
  const tree = recordToSkeleton(RECORD, { origin: SOURCE.MANUAL })
  for (const id of idsOf(tree)) assert.equal(tree.nodes[id].source, SOURCE.MANUAL)
  assert.throws(() => recordToSkeleton(RECORD, { origin: 'not-a-source' }), /合法值/)
})

test('record 缺少 name 时报错并带修复动作', () => {
  assert.throws(() => recordToSkeleton({ value: ':= by simp' }), /name/)
  assert.throws(() => recordToSkeleton({ name: [] }), /name/)
})

test('name 为字符串时也能用（语料外的手工记录）', () => {
  const tree = recordToSkeleton({ name: 'Foo.bar', kind: NODE_KIND.LEMMA, value: ':= by simp' })
  assert.equal(tree.theorem, 'Foo.bar')
  assert.equal(tree.nodes.n0.kind, NODE_KIND.LEMMA)
})

// ── isEvaluationSafe：语义冻结（pilot 数字可复现）─────────────────────

test('isEvaluationSafe：保持 pilot 语义（定理 + 非空 + 长度 < 490 + 以 := by 开头）', () => {
  assert.equal(isEvaluationSafe({ kind: NODE_KIND.THEOREM, value: ':= by simp' }), true)
  assert.equal(isEvaluationSafe({ kind: NODE_KIND.THEOREM, value: '  := by\n  simp' }), true)
  assert.equal(isEvaluationSafe({ kind: NODE_KIND.LEMMA, value: ':= by simp' }), false)
  assert.equal(isEvaluationSafe({ kind: NODE_KIND.THEOREM, value: '' }), false)
  assert.equal(isEvaluationSafe({ kind: NODE_KIND.THEOREM, value: '   ' }), false)
  assert.equal(isEvaluationSafe({ kind: NODE_KIND.THEOREM, value: ':= 3' }), false)
  assert.equal(isEvaluationSafe({ kind: NODE_KIND.THEOREM, value: ':= by simp ...' }), true,
    '结尾省略号不影响样本池判定（与 node.truncated 是两个判定）')
  const justUnder = `:= by\n  simp${' '.repeat(TRUNCATION_SUSPECT_THRESHOLD - 13)}`
  assert.equal(justUnder.trim().length >= TRUNCATION_SUSPECT_THRESHOLD, false)
  assert.equal(isEvaluationSafe({ kind: NODE_KIND.THEOREM, value: justUnder }), true)
  assert.equal(isEvaluationSafe({ kind: NODE_KIND.THEOREM, value: `${justUnder} ` }), false,
    '长度达到阈值即出局（pilot 的 67,175 条池子靠这条）')
})

// ── 分层约束（L1）自查 ────────────────────────────────────────────────

test('L1：core 模块不得 import node:fs / node:net / node:sqlite / fetch / @deepseek-ai/*', () => {
  const here = fileURLToPath(new URL('.', import.meta.url))
  const forbidden = [/node:fs/, /node:net/, /node:sqlite/, /\bfetch\s*\(/, /@deepseek-ai\//]
  for (const name of ['skeleton.mjs', 'anchor.mjs']) {
    const src = readFileSync(`${here}../src/core/${name}`, 'utf8')
    for (const re of forbidden) {
      assert.ok(!re.test(src), `${name} 违反 L1: ${re}`)
    }
  }
})

test('L1：core 模块只从 enums.mjs 取枚举（不内联枚举字面量）', () => {
  const here = fileURLToPath(new URL('.', import.meta.url))
  const src = readFileSync(`${here}../src/core/skeleton.mjs`, 'utf8')
  for (const value of Object.values(PROOF_MODE)) {
    assert.ok(!src.includes(`'${value}'`), `skeleton.mjs 内联了枚举字面量 ${value}`)
  }
  for (const value of Object.values(NODE_KIND)) {
    assert.ok(!src.includes(`'${value}'`), `skeleton.mjs 内联了枚举字面量 ${value}`)
  }
})
