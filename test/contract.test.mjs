/**
 * contract.test.mjs — 契约命名转换（src/io/contract.mjs）与词典纯逻辑（src/core/lexicon.mjs）
 *
 * 覆盖的分层约束：
 *   L5  snake_case ⇄ camelCase 的转换实现只在 src/io/contract.mjs（本文件是它的测试，故两种写法都出现）；
 *   L1  src/core/lexicon.mjs 不得 import node:fs / node:net / node:sqlite / fetch / @deepseek-ai/*。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { slugify, toCamel, toSnake } from '../src/io/contract.mjs'
import { normalizeLemmaName, shapeEntries } from '../src/core/lexicon.mjs'

const LEXICON_SOURCE = fileURLToPath(new URL('../src/core/lexicon.mjs', import.meta.url))

// ── toCamel ────────────────────────────────────────────────────────────

test('toCamel：深转换嵌套对象与数组', () => {
  const input = {
    spec_version: '1.0.0',
    type_fingerprint: 'sha256:abc',
    nodes: {
      n0: {
        lemma_refs: ['Even.add'],
        have_count: 2,
        coverage: { degrade_reason: null },
      },
    },
    annotations: [{ value_type: 'technique', lexicon_ref: 'Even.add' }],
  }
  assert.deepEqual(toCamel(input), {
    specVersion: '1.0.0',
    typeFingerprint: 'sha256:abc',
    nodes: {
      n0: {
        lemmaRefs: ['Even.add'],
        haveCount: 2,
        coverage: { degradeReason: null },
      },
    },
    annotations: [{ valueType: 'technique', lexiconRef: 'Even.add' }],
  })
})

test('toCamel：枚举「值」是数据不是键，必须原样保留', () => {
  const out = toCamel({
    role: 'core_idea',
    mode: 'tactic-multiline',
    audience: 'grad-math',
    evidence: 'formal',
    significance: 'supporting',
    segments: [{ kind: 'concept', text: 'x' }],
  })
  assert.equal(out.role, 'core_idea')
  assert.equal(out.mode, 'tactic-multiline')
  assert.equal(out.audience, 'grad-math')
  assert.equal(out.significance, 'supporting')
  assert.equal(out.segments[0].kind, 'concept')
})

test('toCamel：数据键（含点号/斜杠/非 ASCII）原样保留', () => {
  const out = toCamel({ Even: { 'Even.add': 1 }, '/tmp/x': 2, 'term_/ₚ_': 3, n0: [1] })
  assert.deepEqual(out, { Even: { 'Even.add': 1 }, '/tmp/x': 2, 'term_/ₚ_': 3, n0: [1] })
})

test('toCamel：幂等，且对 null / 原始值 / 数组安全', () => {
  const once = toCamel({ type_fingerprint: 'x', list: [{ value_type: null }], n: 3, s: 'core_idea' })
  assert.deepEqual(toCamel(once), once)
  assert.equal(toCamel(null), null)
  assert.equal(toCamel(42), 42)
  assert.equal(toCamel('core_idea'), 'core_idea')
  assert.deepEqual(toCamel([{ a_b: 1 }]), [{ aB: 1 }])
})

test('toCamel：非字面量对象（Date/Map）原样返回，不做键改写', () => {
  const date = new Date(0)
  const map = new Map([['a_b', 1]])
  const out = toCamel({ created_at: date, meta: map })
  assert.equal(out.createdAt, date)
  assert.equal(out.meta, map)
})

test('toCamel：两个键映射到同一名字时报错，不静默覆盖（§7.6 诚实性）', () => {
  assert.throws(() => toCamel({ type_fingerprint: 1, typeFingerprint: 2 }), /契约键冲突/)
})

// ── toSnake ────────────────────────────────────────────────────────────

test('toSnake：深转换 camelCase → snake_case（含数组与嵌套）', () => {
  const tree = {
    theorem: 'Mathlib.Algebra.Group.Even.add',
    root: 'n0',
    nodes: { n0: { typeFingerprint: 'sha256:x', lemmaRefs: ['Even.add'], parent: null } },
    coverage: { mode: 'tactic-multiline', haveCount: 2, nodeCount: 4, degraded: false, degradeReason: null },
  }
  assert.deepEqual(toSnake(tree), {
    theorem: 'Mathlib.Algebra.Group.Even.add',
    root: 'n0',
    nodes: { n0: { type_fingerprint: 'sha256:x', lemma_refs: ['Even.add'], parent: null } },
    coverage: { mode: 'tactic-multiline', have_count: 2, node_count: 4, degraded: false, degrade_reason: null },
  })
})

test('toSnake：已是 snake_case 的键不动，值不动，幂等', () => {
  const snake = { spec_version: '1.0.0', annotations: [{ value_type: 'technique' }] }
  assert.deepEqual(toSnake(snake), snake)
  assert.deepEqual(toSnake(toSnake(snake)), snake)
})

test('toSnake：节点 id 这类数据键不被改写', () => {
  const out = toSnake({ nodes: { n0: { id: 'n0' }, n12: { id: 'n12' } } })
  assert.deepEqual(Object.keys(out.nodes), ['n0', 'n12'])
})

test('snake → camel → snake 往返稳定（真实契约键全覆盖）', () => {
  const snake = {
    spec_version: '1.0.0',
    mathlib_baseline: 'v4.28.0-rc1',
    type_fingerprint: 'sha256:x',
    lemma_refs: ['Even.add'],
    have_count: 2,
    node_count: 4,
    degrade_reason: null,
    annotated_node_count: 3,
    main_coverage: 0.75,
    anchor_precision: 1,
    concept_coverage: null,
    value_type: 'technique',
    lexicon_ref: 'Even.add',
    informal_name: 'n',
    informal_description: 'd',
    description_truncated: false,
    style_examples_reason: 'module_name 无法判定文化取向',
    length_limit: 150,
    output_shape: { max_entries: 8 },
    parent_chain: [{ id: 'n0', signature: 's' }],
    node_id: 'n3',
    max_diagnostics: 50,
    corpus_path: 'data/lsv2.jsonl',
    cache_dir: 'cache',
    output_dir: 'out',
  }
  assert.deepEqual(toSnake(toCamel(snake)), snake)
})

test('camel → snake → camel 往返稳定（缩写串除外）', () => {
  const camel = {
    specVersion: '1.0.0',
    typeFingerprint: 'sha256:x',
    lemmaRefs: ['Even.add'],
    haveCount: 2,
    degradeReason: null,
    mainCoverage: 0.75,
    valueType: 'technique',
    informalDescription: 'd',
    styleExamplesReason: 'r',
    nodeId: 'n3',
    maxDiagnostics: 50,
    corpusPath: 'data/lsv2.jsonl',
  }
  assert.deepEqual(toCamel(toSnake(camel)), camel)
})

// ── slugify ────────────────────────────────────────────────────────────

test('slugify：保留点号，斜杠换下划线，不哈希不截断', () => {
  assert.equal(slugify('Mathlib.Algebra.Group.Even.add'), 'Mathlib.Algebra.Group.Even.add')
  assert.equal(slugify('Mathlib/Analysis/AbsConvex'), 'Mathlib_Analysis_AbsConvex')
  assert.equal(slugify('Dioph/term_D/_'), 'Dioph_term_D__')
  assert.equal(slugify('  AbsConvex  '), 'AbsConvex')
})

test('slugify：非字符串或空名字抛错并给出修复动作', () => {
  assert.throws(() => slugify(null), /全限定名/)
  assert.throws(() => slugify('   '), /空声明名/)
})

// ── normalizeLemmaName ─────────────────────────────────────────────────

test('normalizeLemmaName：去空白 / @ / _root_. / 反引号', () => {
  assert.equal(normalizeLemmaName('  Even.add  '), 'Even.add')
  assert.equal(normalizeLemmaName('@Even.add'), 'Even.add')
  assert.equal(normalizeLemmaName('_root_.Even.add'), 'Even.add')
  assert.equal(normalizeLemmaName('`Even.add`'), 'Even.add')
  assert.equal(normalizeLemmaName('@@_root_.`Even.add`'), 'Even.add')
  assert.equal(normalizeLemmaName('Even.add'), 'Even.add')
})

test('normalizeLemmaName：不做模糊匹配，无法归一化返回空串', () => {
  assert.equal(normalizeLemmaName(''), '')
  assert.equal(normalizeLemmaName('   '), '')
  assert.equal(normalizeLemmaName(null), '')
  assert.equal(normalizeLemmaName(42), '')
  assert.equal(normalizeLemmaName('@'), '')
  // 大小写不折叠、不做前缀补全——查不到就是查不到（T2）
  assert.equal(normalizeLemmaName('even.add'), 'even.add')
})

// ── shapeEntries ───────────────────────────────────────────────────────

const ROW = Object.freeze({
  name: 'AbsConvex',
  module: 'Mathlib.Analysis.LocallyConvex.AbsConvex',
  kind: 'definition',
  signature: '(s : Set E) : Prop',
  informalName: 'Absolutely Convex Set',
  informalDescription: 'A set s is absolutely convex if it is both balanced and convex.',
})

test('shapeEntries：命中条目整形 + 未命中显式列出（SPEC T2）', () => {
  const out = shapeEntries([ROW, 'NotInLexicon.foo'], { maxEntries: 8, descriptionChars: 600 })
  assert.equal(out.missing.length, 1)
  assert.deepEqual(out.missing, ['NotInLexicon.foo'])
  assert.equal(out.truncated, false)
  assert.deepEqual(out.entries, [
    {
      name: 'AbsConvex',
      module: 'Mathlib.Analysis.LocallyConvex.AbsConvex',
      kind: 'definition',
      signature: '(s : Set E) : Prop',
      informalName: 'Absolutely Convex Set',
      informalDescription: 'A set s is absolutely convex if it is both balanced and convex.',
      descriptionTruncated: false,
    },
  ])
})

test('shapeEntries：description 按 descriptionChars 截断并置 descriptionTruncated', () => {
  const long = { ...ROW, informalDescription: 'x'.repeat(100) }
  const out = shapeEntries([long], { maxEntries: 8, descriptionChars: 10 })
  assert.equal(out.entries[0].informalDescription.length, 10)
  assert.equal(out.entries[0].informalDescription, 'x'.repeat(10))
  assert.equal(out.entries[0].descriptionTruncated, true)
  // 恰好等长不算截断
  const exact = shapeEntries([{ ...ROW, informalDescription: 'y'.repeat(10) }], {
    maxEntries: 8,
    descriptionChars: 10,
  })
  assert.equal(exact.entries[0].descriptionTruncated, false)
})

test('shapeEntries：maxEntries 截断并置 truncated（T1 有界输出）', () => {
  const rows = [0, 1, 2].map((i) => ({ ...ROW, name: `L${i}` }))
  const out = shapeEntries(rows, { maxEntries: 2, descriptionChars: 600 })
  assert.equal(out.entries.length, 2)
  assert.equal(out.truncated, true)
  // missing 不随 maxEntries 截断：把「词典里没有」截掉正是 R3 的入口
  const withMissing = shapeEntries([...rows, 'a', 'b', 'c'], { maxEntries: 1, descriptionChars: 600 })
  assert.equal(withMissing.entries.length, 1)
  assert.deepEqual(withMissing.missing, ['a', 'b', 'c'])
})

test('shapeEntries：miss 的三种写法都算未命中，不静默省略', () => {
  const out = shapeEntries(['A.b', { name: 'C.d' }, null, undefined, ROW], {
    maxEntries: 8,
    descriptionChars: 600,
  })
  assert.deepEqual(out.missing, ['A.b', 'C.d'])
  assert.equal(out.entries.length, 1)
})

test('shapeEntries：去重保序', () => {
  const out = shapeEntries([ROW, ROW, 'X.y', 'X.y'], { maxEntries: 8, descriptionChars: 600 })
  assert.equal(out.entries.length, 1)
  assert.deepEqual(out.missing, ['X.y'])
})

test('shapeEntries：未做 toCamel 的原始行必须报错，而不是静默给出 null 语义', () => {
  const rawRow = {
    name: 'AbsConvex',
    module: 'Mathlib.Analysis.LocallyConvex.AbsConvex',
    kind: 'definition',
    signature: '(s : Set E) : Prop',
    informal_name: 'Absolutely Convex Set',
    informal_description: 'A set s is absolutely convex…',
  }
  assert.throws(() => shapeEntries([rawRow], { maxEntries: 8, descriptionChars: 600 }), /toCamel/)
  assert.throws(() => shapeEntries({ found: [rawRow], missing: [] }, { maxEntries: 8, descriptionChars: 600 }), /toCamel/)
})

test('shapeEntries：接受 lookupLemma 的 { found, missing } 结果对象', () => {
  const out = shapeEntries({ found: [ROW], missing: ['Nope.x'] }, { maxEntries: 8, descriptionChars: 600 })
  assert.equal(out.entries.length, 1)
  assert.deepEqual(out.missing, ['Nope.x'])
})

test('shapeEntries：null 缺失字段如实保留为 null（≠ 空字符串）', () => {
  const sparse = { name: 'X.y', module: null, kind: null, signature: null, informalName: null, informalDescription: null }
  const out = shapeEntries([sparse], { maxEntries: 8, descriptionChars: 600 })
  assert.equal(out.entries[0].module, null)
  assert.equal(out.entries[0].kind, null)
  assert.equal(out.entries[0].signature, '')
  assert.equal(out.entries[0].informalName, null)
  assert.equal(out.entries[0].informalDescription, null)
  assert.equal(out.entries[0].descriptionTruncated, false)
})

test('shapeEntries：缺 opts / 非法 opts 抛错并给出修复动作', () => {
  assert.throws(() => shapeEntries([ROW], undefined), /opts/)
  assert.throws(() => shapeEntries([ROW], { maxEntries: -1, descriptionChars: 10 }), /maxEntries/)
  assert.throws(() => shapeEntries([ROW], { maxEntries: 8, descriptionChars: 1.5 }), /descriptionChars/)
})

test('shapeEntries：返回的键名是 camelCase（core 侧契约，INTERFACES §0.1）', () => {
  const out = shapeEntries([ROW], { maxEntries: 8, descriptionChars: 600 })
  assert.deepEqual(Object.keys(out.entries[0]), [
    'name',
    'module',
    'kind',
    'signature',
    'informalName',
    'informalDescription',
    'descriptionTruncated',
  ])
})

// ── 分层约束（本地自检；权威检查在 test/layers.test.mjs）──────────────────

test('L1：src/core/lexicon.mjs 不 import node:*/fetch/@deepseek-ai', () => {
  const source = readFileSync(LEXICON_SOURCE, 'utf8')
  const imports = [...source.matchAll(/^\s*import\s[^\n]*from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1])
  assert.deepEqual(imports, [], `core/lexicon.mjs 不允许 import 任何模块，实际：${imports.join(', ')}`)
  assert.ok(!/\bfetch\s*\(/.test(source), 'core/lexicon.mjs 不允许调用 fetch')
})
