/**
 * anchor.test.mjs — src/core/anchor.mjs 的验收测试
 *
 * 覆盖 SPEC §2.3/§4（V1/V3/V4/V12 的落点）与 INTERFACES §2.4 的冻结签名。
 * 重点：锚点解析必须**现算**（SkeletonTree 不再有 declIndex / hypothesisIndex），
 * 且 parseAnchor 必须同时接受 Anchor 对象与遗留字符串两种输入。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  formatAnchor,
  parseAnchor,
  resolveAnchor,
  validateAnchors,
} from '../src/core/anchor.mjs'
import { ANCHOR_KIND } from '../src/core/enums.mjs'
import { recordToSkeleton } from '../src/core/skeleton.mjs'

// ── 夹具 ──────────────────────────────────────────────────────────────

const VALUE = [
  ':= by',
  '  have h₁ : Even a := by simp',
  '  exact h₁',
].join('\n')

const RECORD = {
  name: ['Mathlib.Algebra.Group.Even.add'],
  kind: 'theorem',
  signature: '∀ {α} [AddCommSemigroup α] (a b : α), Even a → Even b → Even (a + b)',
  value: VALUE,
}

/** 手工骨架：没有 declIndex / hypothesisIndex，只有 nodes（新契约） */
const SKELETON = recordToSkeleton(RECORD)

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

// ── parseAnchor ───────────────────────────────────────────────────────

test('parseAnchor：Anchor 对象（SPEC §2.3 权威形式）', () => {
  assert.deepEqual(parseAnchor({ kind: ANCHOR_KIND.GOAL, target: 'n1' }), {
    kind: ANCHOR_KIND.GOAL,
    target: 'n1',
  })
  assert.deepEqual(
    parseAnchor({ kind: ANCHOR_KIND.DECL, target: 'Mathlib.X', fingerprint: 'sha256:aa' }),
    { kind: ANCHOR_KIND.DECL, target: 'Mathlib.X', fingerprint: 'sha256:aa' },
  )
  assert.deepEqual(
    parseAnchor({ kind: ANCHOR_KIND.HYP, target: ' ha ' }),
    { kind: ANCHOR_KIND.HYP, target: 'ha' },
    '两侧空白要去掉',
  )
})

test('parseAnchor：遗留字符串形式', () => {
  assert.deepEqual(parseAnchor('goal:n1'), { kind: ANCHOR_KIND.GOAL, target: 'n1' })
  assert.deepEqual(parseAnchor(' decl : Mathlib.X '), { kind: ANCHOR_KIND.DECL, target: 'Mathlib.X' })
  assert.deepEqual(parseAnchor('display:L120'), { kind: ANCHOR_KIND.DISPLAY, target: 'L120' })
})

test('parseAnchor：无法解析时返回 null（不抛异常）', () => {
  for (const bad of [
    null, undefined, 42, [], {},
    { kind: ANCHOR_KIND.GOAL },              // 缺 target
    { target: 'n1' },                        // 缺 kind
    { kind: 'nope', target: 'n1' },          // kind 不在闭集
    { kind: ANCHOR_KIND.GOAL, target: '' },  // target 为空
    '', '   ', 'n1', ':n1', 'goal:', 'nope:n1',
  ]) {
    assert.equal(parseAnchor(bad), null, `${JSON.stringify(bad)} 应解析失败`)
  }
})

test('formatAnchor：两种输入都能渲染成可读文本（诊断消息用）', () => {
  assert.equal(formatAnchor({ kind: ANCHOR_KIND.GOAL, target: 'n1' }), 'goal:n1')
  assert.equal(formatAnchor('decl:Mathlib.X'), 'decl:Mathlib.X')
  assert.equal(formatAnchor({ kind: 'nope', target: 'x' }), 'nope:x')
  assert.equal(formatAnchor(null), 'null')
})

// ── resolveAnchor：四种 kind 的语义 ──────────────────────────────────

test('resolveAnchor：goal → nodes 里存在该 id 才算 ok', () => {
  assert.deepEqual(
    resolveAnchor({ kind: ANCHOR_KIND.GOAL, target: 'n1' }, SKELETON),
    { ok: true, kind: ANCHOR_KIND.GOAL, target: 'n1', reason: null, fingerprintOk: null },
  )
  const miss = resolveAnchor({ kind: ANCHOR_KIND.GOAL, target: 'n99' }, SKELETON)
  assert.equal(miss.ok, false)
  assert.equal(miss.kind, ANCHOR_KIND.GOAL)
  assert.equal(miss.target, 'n99')
  assert.equal(miss.reason, 'unknown-goal-node')
})

test('resolveAnchor：decl → 某个节点的 decl 等于 target 才算 ok', () => {
  const ok = resolveAnchor('decl:Mathlib.Algebra.Group.Even.add', SKELETON)
  assert.equal(ok.ok, true)
  assert.equal(ok.reason, null)
  const miss = resolveAnchor('decl:Mathlib.Not.There', SKELETON)
  assert.equal(miss.ok, false)
  assert.equal(miss.reason, 'unknown-decl')
})

test('resolveAnchor：decl 解析不依赖根节点（非根节点带 decl 时也要命中）', () => {
  const custom = clone(SKELETON)
  custom.nodes.n1.decl = 'Mathlib.Other.lemma'
  assert.equal(resolveAnchor('decl:Mathlib.Other.lemma', custom).ok, true)
})

test('resolveAnchor：hyp → 某个节点的 hypotheses 含 target 才算 ok', () => {
  assert.equal(resolveAnchor({ kind: ANCHOR_KIND.HYP, target: 'a' }, SKELETON).ok, true)
  assert.equal(resolveAnchor('hyp:b', SKELETON).ok, true)
  const miss = resolveAnchor('hyp:zzz', SKELETON)
  assert.equal(miss.ok, false)
  assert.equal(miss.reason, 'unknown-hypothesis')
})

test('resolveAnchor：hyp 也能指到 have 的局部名 localName（v1.3，修掉 Q4）', () => {
  const haveNode = Object.values(SKELETON.nodes).find((n) => n.kind === 'have')
  assert.ok(haveNode, '夹具里应当有一个 have 节点')
  assert.equal(haveNode.localName, 'h₁', 'have 节点必须带 localName（缺陷 C）')
  assert.ok(
    !haveNode.hypotheses.includes('h₁'),
    'localName 不是 hypotheses 的成员：命中只能来自 localName 这条新路径',
  )
  const hit = resolveAnchor({ kind: ANCHOR_KIND.HYP, target: 'h₁' }, SKELETON)
  assert.equal(hit.ok, true)
  assert.equal(hit.reason, null)
  assert.equal(hit.target, 'h₁')

  // 没有 localName 的节点不能靠它命中
  const stripped = clone(SKELETON)
  for (const id of Object.keys(stripped.nodes)) delete stripped.nodes[id].localName
  assert.equal(resolveAnchor('hyp:h₁', stripped).ok, false)
  assert.equal(resolveAnchor('hyp:h₁', stripped).reason, 'unknown-hypothesis')
})

test('resolveAnchor：display 永不 ok（行号不可作锚点，V4 依赖 kind 保留）', () => {
  for (const input of ['display:L120', { kind: ANCHOR_KIND.DISPLAY, target: 'L120' }]) {
    const r = resolveAnchor(input, SKELETON)
    assert.equal(r.ok, false)
    assert.equal(r.kind, ANCHOR_KIND.DISPLAY, 'kind 必须保留，否则 V4 抓不到')
    assert.equal(r.target, 'L120')
    assert.equal(r.reason, 'display-anchor-not-verifiable')
  }
})

test('resolveAnchor：形状非法时报 malformed-*，而不是静默通过', () => {
  assert.equal(resolveAnchor('goal:1bad', SKELETON).reason, 'malformed-goal-id')
  assert.equal(resolveAnchor('decl:not a name', SKELETON).reason, 'malformed-decl-name')
  assert.equal(resolveAnchor('hyp:1ha', SKELETON).reason, 'malformed-hyp-name')
  assert.equal(resolveAnchor(null, SKELETON).reason, 'unparsable-anchor')
  assert.equal(resolveAnchor('goal:n1', null).reason, 'skeleton-has-no-nodes')
  assert.equal(resolveAnchor('goal:n1', { root: 'n0' }).reason, 'skeleton-has-no-nodes')
})

test('resolveAnchor：_root_. 前缀的 decl 也认', () => {
  const custom = clone(SKELETON)
  custom.nodes.n0.decl = '_root_.Foo.bar'
  assert.equal(resolveAnchor('decl:_root_.Foo.bar', custom).ok, true)
})

test('resolveAnchor：指纹只作漂移信号，不改变 ok（V12 管落地，不管漂移）', () => {
  const node = SKELETON.nodes.n1
  assert.equal(
    resolveAnchor({ kind: ANCHOR_KIND.GOAL, target: 'n1', fingerprint: node.typeFingerprint }, SKELETON).fingerprintOk,
    true,
  )
  const drift = resolveAnchor({ kind: ANCHOR_KIND.GOAL, target: 'n1', fingerprint: 'sha256:deadbeef' }, SKELETON)
  assert.equal(drift.ok, true, '指纹不匹配仍 ok：这是版本漂移信号，不是悬空断言')
  assert.equal(drift.fingerprintOk, false)
  assert.equal(resolveAnchor('goal:n1', SKELETON).fingerprintOk, null, '没带指纹就不表态')
})

// ── validateAnchors ───────────────────────────────────────────────────

test('validateAnchors：逐条返回、顺序与输入对齐、不因首条失败短路', () => {
  const report = validateAnchors(
    [
      { kind: ANCHOR_KIND.GOAL, target: 'n1' },
      { kind: ANCHOR_KIND.DECL, target: 'Mathlib.Algebra.Group.Even.add' },
      { kind: ANCHOR_KIND.HYP, target: 'a' },
      { kind: ANCHOR_KIND.DISPLAY, target: 'L120' },
      { kind: ANCHOR_KIND.GOAL, target: 'n999' },
      'hyp:zzz',
      'garbage',
    ],
    SKELETON,
  )
  assert.equal(report.results.length, 7)
  assert.deepEqual(report.results.map((r) => r.ok), [true, true, true, false, false, false, false])
  assert.deepEqual(
    report.results.map((r) => r.kind),
    [ANCHOR_KIND.GOAL, ANCHOR_KIND.DECL, ANCHOR_KIND.HYP, ANCHOR_KIND.DISPLAY, ANCHOR_KIND.GOAL, ANCHOR_KIND.HYP, null],
  )
  assert.deepEqual(
    report.results.map((r) => r.raw),
    ['goal:n1', 'decl:Mathlib.Algebra.Group.Even.add', 'hyp:a', 'display:L120', 'goal:n999', 'hyp:zzz', 'garbage'],
  )
  assert.equal(report.results[4].reason, 'unknown-goal-node')
  assert.equal(report.results[5].reason, 'unknown-hypothesis')
  assert.equal(report.results[6].reason, 'unparsable-anchor')
  assert.equal(report.total, 7)
  assert.equal(report.validCount, 3)
  assert.equal(report.allValid, false)
})

test('validateAnchors：strong / hasStrong 依据 STRONG_ANCHOR_KINDS，且只认可解析的强锚点', () => {
  const ok = validateAnchors(
    [{ kind: ANCHOR_KIND.GOAL, target: 'n1' }, { kind: ANCHOR_KIND.HYP, target: 'a' }],
    SKELETON,
  )
  assert.deepEqual(ok.results.map((r) => r.strong), [true, false])
  assert.equal(ok.strongCount, 1)
  assert.equal(ok.hasStrong, true)
  assert.equal(ok.allValid, true, '两条都 ok 才 allValid')

  const dangling = validateAnchors([{ kind: ANCHOR_KIND.GOAL, target: 'n999' }], SKELETON)
  assert.equal(dangling.hasStrong, false, '悬空的 goal 不算强锚点，否则 V1 会被骗过')
  assert.equal(dangling.strongCount, 0)

  const decl = validateAnchors(['decl:Mathlib.Algebra.Group.Even.add'], SKELETON)
  assert.equal(decl.hasStrong, true, 'decl 也是强锚点')
})

test('validateAnchors：空输入与非法输入不炸', () => {
  for (const input of [[], null, undefined, 'goal:n1', 7]) {
    const report = validateAnchors(input, SKELETON)
    assert.equal(report.total, 0)
    assert.deepEqual(report.results, [])
    assert.equal(report.hasStrong, false)
    assert.equal(report.allValid, false)
  }
})

// ── 与骨架联调（真实路径：recordToSkeleton → resolveAnchor）─────────────

test('联调：骨架树上没有 declIndex/hypothesisIndex，锚点靠现算全部可解析', () => {
  const tree = recordToSkeleton(RECORD)
  assert.equal(tree.declIndex, undefined)
  assert.equal(tree.hypothesisIndex, undefined)
  const report = validateAnchors(
    [
      { kind: ANCHOR_KIND.DECL, target: tree.theorem },
      { kind: ANCHOR_KIND.GOAL, target: tree.root },
      { kind: ANCHOR_KIND.GOAL, target: 'n1' },
      { kind: ANCHOR_KIND.HYP, target: 'a' },
    ],
    tree,
  )
  assert.equal(report.allValid, true, JSON.stringify(report.results, null, 2))
  assert.equal(report.hasStrong, true)
})

test('联调：V12 场景 —— 指向已不存在节点的锚点必须报悬空', () => {
  const tree = recordToSkeleton(RECORD)
  const report = validateAnchors([{ kind: ANCHOR_KIND.GOAL, target: 'n7' }], tree)
  assert.equal(report.results[0].ok, false)
  assert.match(report.results[0].reason, /unknown-goal-node/)
})
