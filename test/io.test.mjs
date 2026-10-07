/**
 * io.test.mjs — io 层测试：流式语料读 / SQLite 词典索引 / 产物落盘。
 *
 * 三个硬要求各有一组用例：
 *   R2/R5  流式读不得全量载入内存 —— 结构断言 + **限堆子进程**跑 64 MB 合成语料；
 *   T2     未命中必须显式返回 —— lookupLemma.missing 与 shapeEntries.missing 都有断言；
 *   L5/§7.1 转换只在 contract.mjs、零 npm 依赖 —— 对 src/io 源码做静态断言。
 *
 * 真实语料相关用例在 data/lsv2.jsonl 不存在时自动 skip（`A4M_REAL_CORPUS=1` 时额外跑全量建索引）。
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'

import { artifactPath, readLedger, readSkeleton, writeLedger, writeRender, writeSkeleton } from '../src/io/artifacts.mjs'
import { toCamel } from '../src/io/contract.mjs'
import { findRecord, streamRecords } from '../src/io/corpus.mjs'
import { ensureLexiconIndex, lookupLemma } from '../src/io/index-db.mjs'
import { resolvableLexiconNames } from '../src/io/lexicon-resolve.mjs'
import { shapeEntries } from '../src/core/lexicon.mjs'
import { SPEC_VERSION } from '../src/core/enums.mjs'

const execFileAsync = promisify(execFile)
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CORPUS = join(ROOT, 'data', 'lsv2.jsonl')
const HAS_REAL_CORPUS = existsSync(CORPUS)
const REAL = { skip: HAS_REAL_CORPUS ? false : 'data/lsv2.jsonl 不存在' }

async function tempDir(t, prefix = 'a4m-io-') {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

const FIXTURE = [
  {
    name: ['AbsConvex'],
    module_name: ['Mathlib', 'Analysis', 'LocallyConvex', 'AbsConvex'],
    kind: 'definition',
    signature: '(s : Set E) : Prop',
    informal_name: 'Absolutely Convex Set',
    informal_description: 'A set s is absolutely convex if it is both balanced and convex.',
  },
  {
    name: ['Even', 'add'],
    module_name: ['Mathlib', 'Algebra', 'Group', 'Even'],
    kind: 'theorem',
    signature: 'Even a → Even b → Even (a + b)',
    informal_name: 'Sum of even numbers',
    informal_description: 'The sum of two even numbers is even.',
  },
  {
    name: ['term_/ₚ_'],
    module_name: ['Mathlib'],
    kind: 'definition',
    signature: '',
    informal_name: '',
    informal_description: '',
  },
]

async function writeCorpus(dir, records = FIXTURE, name = 'corpus.jsonl') {
  const file = join(dir, name)
  await writeFile(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
  return file
}

function isAbort(err) {
  return err?.name === 'AbortError'
}

// ── corpus.mjs：流式读 ─────────────────────────────────────────────────

test('streamRecords：逐行产出，跳过空行，忽略末尾换行', async (t) => {
  const dir = await tempDir(t)
  const file = join(dir, 'corpus.jsonl')
  await writeFile(file, `${JSON.stringify(FIXTURE[0])}\n\n${JSON.stringify(FIXTURE[1])}\n`, 'utf8')

  const got = []
  for await (const record of streamRecords(file)) got.push(record)
  assert.equal(got.length, 2)
  assert.deepEqual(got[0].name, ['AbsConvex'])
  assert.deepEqual(got[1].name, ['Even', 'add'])
  assert.equal(got[0].informal_name, 'Absolutely Convex Set')
})

test('streamRecords：CRLF 行尾也能解析', async (t) => {
  const dir = await tempDir(t)
  const file = join(dir, 'crlf.jsonl')
  await writeFile(file, `${JSON.stringify(FIXTURE[0])}\r\n${JSON.stringify(FIXTURE[1])}\r\n`, 'utf8')
  const got = []
  for await (const record of streamRecords(file)) got.push(record)
  assert.equal(got.length, 2)
})

test('streamRecords：坏 JSON 报出**行号**与修复动作，不静默跳过', async (t) => {
  const dir = await tempDir(t)
  const file = join(dir, 'broken.jsonl')
  await writeFile(file, `${JSON.stringify(FIXTURE[0])}\n{not json}\n`, 'utf8')
  await assert.rejects(
    async () => {
      for await (const _ of streamRecords(file)) void _
    },
    (err) => /第 2 行/.test(err.message) && /不是合法 JSON/.test(err.message) && /lsv2\.jsonl/.test(err.message),
  )
})

test('streamRecords：非对象行（数组/标量）报错', async (t) => {
  const dir = await tempDir(t)
  const file = join(dir, 'array.jsonl')
  await writeFile(file, '[1,2,3]\n', 'utf8')
  await assert.rejects(
    async () => {
      for await (const _ of streamRecords(file)) void _
    },
    /不是 JSON 对象/,
  )
})

test('streamRecords：文件不存在时给出 corpusPath 修复动作', async () => {
  const missing = join(tmpdir(), 'a4m-definitely-missing-9f3.jsonl')
  await assert.rejects(
    async () => {
      for await (const _ of streamRecords(missing)) void _
    },
    (err) => err.code === 'ENOENT' && /语料文件不存在/.test(err.message) && /corpusPath/.test(err.message),
  )
})

test('streamRecords：空路径 / 非法 signal 抛 TypeError', async () => {
  await assert.rejects(
    async () => {
      for await (const _ of streamRecords('')) void _
    },
    /corpusPath/,
  )
  await assert.rejects(
    async () => {
      for await (const _ of streamRecords('x.jsonl', { signal: {} })) void _
    },
    /AbortSignal/,
  )
})

test('streamRecords：取消时抛 AbortError（已取消 / 迭代之间 / 挂在 yield 上）', async (t) => {
  const dir = await tempDir(t)
  const many = Array.from({ length: 200 }, (_, i) => ({ ...FIXTURE[0], name: [`L${i}`] }))
  const file = await writeCorpus(dir, many)

  // 1) 调用前就已取消
  const pre = new AbortController()
  pre.abort()
  await assert.rejects(
    async () => {
      for await (const _ of streamRecords(file, { signal: pre.signal })) void _
    },
    isAbort,
  )

  // 2) 迭代之间取消
  const mid = new AbortController()
  let seen = 0
  await assert.rejects(
    async () => {
      for await (const _ of streamRecords(file, { signal: mid.signal })) {
        seen += 1
        if (seen === 3) mid.abort()
      }
    },
    isAbort,
  )
  assert.equal(seen, 3, '取消后不得继续产出记录')

  // 3) 生成器挂在 yield 上时取消，下一次 next() 必须抛 AbortError
  const late = new AbortController()
  const iterator = streamRecords(file, { signal: late.signal })[Symbol.asyncIterator]()
  const first = await iterator.next()
  assert.equal(first.done, false)
  late.abort()
  await assert.rejects(() => iterator.next(), isAbort)

  // 4) 自定义取消原因原样抛出
  const custom = new AbortController()
  custom.abort(new Error('用户中止'))
  await assert.rejects(
    async () => {
      for await (const _ of streamRecords(file, { signal: custom.signal })) void _
    },
    /用户中止/,
  )
})

test('findRecord：命中即停 / 未命中返回 null / 入参校验', async (t) => {
  const dir = await tempDir(t)
  const file = await writeCorpus(dir)
  const hit = await findRecord(file, 'Even.add')
  assert.deepEqual(hit.name, ['Even', 'add'])
  assert.equal(await findRecord(file, 'Not.There'), null)
  assert.deepEqual((await findRecord(file, 'term_/ₚ_')).name, ['term_/ₚ_'])
  await assert.rejects(() => findRecord(file, '   '), /非空的声明名/)
})

test('findRecord：真实语料查到 AbsConvex', REAL, async () => {
  const record = await findRecord(CORPUS, 'AbsConvex')
  assert.ok(record, 'AbsConvex 应当存在于 lsv2.jsonl')
  assert.deepEqual(record.name, ['AbsConvex'])
  assert.equal(record.informal_name, 'Absolutely Convex Set')
  assert.match(record.informal_description, /absolutely convex/i)
})

test('真实语料：流式读过前 5,000 条，堆增长远小于全量载入', REAL, async () => {
  const before = process.memoryUsage().heapUsed
  let seen = 0
  for await (const _ of streamRecords(CORPUS)) {
    seen += 1
    if (seen === 5000) break
  }
  const after = process.memoryUsage().heapUsed
  assert.equal(seen, 5000)
  const deltaMb = (after - before) / 1048576
  assert.ok(deltaMb < 64, `流式读 5,000 条的堆增长应远小于 332 MB 语料，实测 ${deltaMb.toFixed(1)} MB`)
})

test('流式硬约束：限堆子进程读 64 MB 语料不得 OOM（R2/R5）', async (t) => {
  const dir = await tempDir(t)
  const file = join(dir, 'big.jsonl')
  const line = `${JSON.stringify({
    name: ['X'.repeat(900)],
    module_name: ['Mathlib'],
    kind: 'definition',
    signature: 's'.repeat(60),
    informal_name: 'n',
    informal_description: 'd'.repeat(20),
  })}\n`
  const LINES = 64_000 // ≈ 64 MB
  const handle = await import('node:fs').then(({ createWriteStream }) => createWriteStream(file))
  await new Promise((resolve, reject) => {
    handle.on('error', reject)
    let i = 0
    const pump = () => {
      while (i < LINES) {
        i += 1
        if (!handle.write(line)) {
          handle.once('drain', pump)
          return
        }
      }
      handle.end(resolve)
    }
    pump()
  })

  const script = `
    import(${JSON.stringify(new URL('../src/io/corpus.mjs', import.meta.url).href)}).then(async ({ streamRecords }) => {
      let n = 0
      for await (const _ of streamRecords(${JSON.stringify(file)})) n += 1
      console.log(JSON.stringify({ n, heapMb: +(process.memoryUsage().heapUsed / 1048576).toFixed(1) }))
    })
  `
  // 48 MB 堆上限：一旦实现变成全量 readFile+split，这里必然 OOM（已实测），流式实现只需要十几 MB
  const { stdout } = await execFileAsync(process.execPath, ['--max-old-space-size=48', '-e', script], {
    timeout: 60_000,
  })
  const { n, heapMb } = JSON.parse(stdout.trim())
  assert.equal(n, LINES)
  assert.ok(heapMb < 48, `流式读 64 MB 语料的堆占用应当在十几 MB 量级，实测 ${heapMb} MB`)
})

test('流式硬约束：corpus.mjs 源码里不出现整文件读 API', async () => {
  const source = readFileSync(join(ROOT, 'src', 'io', 'corpus.mjs'), 'utf8')
  assert.ok(!/readFileSync/.test(source), 'corpus.mjs 不得使用 readFileSync')
  assert.ok(!/\breadFile\s*\(/.test(source), 'corpus.mjs 不得使用 readFile')
  assert.match(source, /createInterface|cursor|stream/i, 'corpus.mjs 应当是流式实现')
})

// ── index-db.mjs：SQLite 索引 ──────────────────────────────────────────

test('ensureLexiconIndex：建索引 / 惰性复用 / rebuild，表结构冻结', async (t) => {
  const dir = await tempDir(t)
  const corpus = await writeCorpus(dir)
  const dbPath = join(dir, 'cache', 'lexicon.db')

  const first = await ensureLexiconIndex({ corpusPath: corpus, dbPath })
  assert.deepEqual(first, { count: 3, built: true })
  assert.ok(existsSync(dbPath), '索引应落在 dbPath')

  const second = await ensureLexiconIndex({ corpusPath: corpus, dbPath })
  assert.deepEqual(second, { count: 3, built: false }, '已存在且非 rebuild 时直接复用')

  const rebuilt = await ensureLexiconIndex({ corpusPath: corpus, dbPath, rebuild: true })
  assert.deepEqual(rebuilt, { count: 3, built: true })

  // 表结构逐列对照 INTERFACES §2.8
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const columns = db
      .prepare('PRAGMA table_info(lemma)')
      .all()
      .map((r) => `${r.name}:${r.type}`)
    assert.deepEqual(columns, [
      'name:TEXT',
      'module:TEXT',
      'kind:TEXT',
      'signature:TEXT',
      'informal_name:TEXT',
      'informal_description:TEXT',
    ])
    const pk = db
      .prepare('PRAGMA table_info(lemma)')
      .all()
      .filter((r) => r.pk > 0)
      .map((r) => r.name)
    assert.deepEqual(pk, ['name'])
  } finally {
    db.close()
  }
})

test('lookupLemma：命中行是契约原始行（snake_case），未命中显式列出（T2）', async (t) => {
  const dir = await tempDir(t)
  const corpus = await writeCorpus(dir)
  const dbPath = join(dir, 'lexicon.db')
  await ensureLexiconIndex({ corpusPath: corpus, dbPath })

  const { found, missing } = lookupLemma(dbPath, ['Even.add', 'Nope.x', 'AbsConvex', 'Even.add'])
  assert.deepEqual(missing, ['Nope.x'])
  assert.deepEqual(
    found.map((r) => r.name),
    ['Even.add', 'AbsConvex'],
  )
  const row = found[1]
  assert.equal(row.module, 'Mathlib.Analysis.LocallyConvex.AbsConvex')
  assert.equal(row.kind, 'definition')
  assert.equal(row.informal_name, 'Absolutely Convex Set')
  assert.ok(Object.hasOwn(row, 'informal_description'), '行的键就是 DB 列名（snake_case 契约）')
  assert.ok(!Object.hasOwn(row, 'informalName'), 'lookupLemma 不做转换——转换归 contract.mjs')

  // io → core 的组合：toCamel 之后再 shapeEntries（这正是工具层要走的路径）
  const shaped = shapeEntries({ found: found.map((r) => toCamel(r)), missing }, {
    maxEntries: 8,
    descriptionChars: 600,
  })
  assert.equal(shaped.entries[1].informalName, 'Absolutely Convex Set')
  assert.deepEqual(shaped.missing, ['Nope.x'])
  assert.equal(shaped.entries[1].descriptionTruncated, false)
})

test('lookupLemma：名字先按原样精确查，再按归一化名字补查；不做模糊匹配', async (t) => {
  const dir = await tempDir(t)
  const corpus = await writeCorpus(dir)
  const dbPath = join(dir, 'lexicon.db')
  await ensureLexiconIndex({ corpusPath: corpus, dbPath })

  assert.equal(lookupLemma(dbPath, ['@Even.add']).found.length, 1)
  assert.equal(lookupLemma(dbPath, ['  Even.add  ']).found.length, 1)
  assert.equal(lookupLemma(dbPath, ['even.add']).found.length, 0, '大小写不折叠')
  assert.deepEqual(lookupLemma(dbPath, ['term_/ₚ_']).found.map((r) => r.name), ['term_/ₚ_'])
  assert.deepEqual(lookupLemma(dbPath, ['']).missing, [''], '空名字也要如实上报')
})

test('lookupLemma：索引不存在 / names 非法时抛错并给出修复动作', async (t) => {
  const dir = await tempDir(t)
  const dbPath = join(dir, 'nope.db')
  assert.throws(() => lookupLemma(dbPath, ['A']), /ensureLexiconIndex/)
  await assert.rejects(
    (async () => {
      const corpus = await writeCorpus(dir)
      await ensureLexiconIndex({ corpusPath: corpus, dbPath })
      lookupLemma(dbPath, 'Even.add')
    })(),
    /必须是字符串数组/,
  )
})

test('resolvableLexiconNames：伪造名（无空格 / 首尾空格 / 纯空白）都不进集合 —— V10 的那个洞', async (t) => {
  const dir = await tempDir(t)
  const corpus = await writeCorpus(dir)
  const dbPath = join(dir, 'lexicon.db')
  await ensureLexiconIndex({ corpusPath: corpus, dbPath })

  const names = resolvableLexiconNames(dbPath, [
    'Totally.Made.Up.Lemma',
    ' Totally.Made.Up.Lemma ',
    '   ',
  ])
  assert.ok(names instanceof Set, '有 ref 时必须返回 Set（而不是 null/弱化模式）')
  assert.equal(names.has('Totally.Made.Up.Lemma'), false)
  assert.equal(names.has(' Totally.Made.Up.Lemma '), false, '★ 首尾空格的伪造名必须被拦下（今天出洞的那一格）')
  assert.equal(names.has('   '), false)
  assert.equal(names.size, 0)
})

test('resolvableLexiconNames：真实名的四种写法都在集合里（放原始串，core 用原样 has）', async (t) => {
  const dir = await tempDir(t)
  const corpus = await writeCorpus(dir)
  const dbPath = join(dir, 'lexicon.db')
  await ensureLexiconIndex({ corpusPath: corpus, dbPath })

  const refs = ['Even.add', ' Even.add ', '_root_.Even.add', '`Even.add`', 'AbsConvex']
  const names = resolvableLexiconNames(dbPath, refs)
  for (const ref of refs) {
    assert.equal(names.has(ref), true, `${JSON.stringify(ref)} 应当可解析`)
  }
  // 契约名也在集合里（兼容归一化写法；第二遍校验会用到规范名）
  assert.equal(names.has('Even.add'), true)
  assert.equal(names.has('AbsConvex'), true)
  assert.equal(names.size, 5, '五种原始写法 + 两个契约名（去重后共 5 个不同串）')

  // 模拟 core/credential.mjs:210 的匹配方式：原样 has(seg.lexiconRef)
  assert.equal(names.has(' Even.add '), true)
  assert.equal(names.has('Totally.Made.Up.Lemma'), false)
})

test('resolvableLexiconNames：契约名入集合 —— 第二遍校验仍能解析账本里的规范名', async (t) => {
  const dir = await tempDir(t)
  const corpus = await writeCorpus(dir)
  const dbPath = join(dir, 'lexicon.db')
  await ensureLexiconIndex({ corpusPath: corpus, dbPath })

  const onlyNormalized = resolvableLexiconNames(dbPath, ['_root_.Even.add'])
  assert.equal(onlyNormalized.has('_root_.Even.add'), true)
  assert.equal(onlyNormalized.has('Even.add'), true, '规范名必须在集合里，否则第二遍校验会误报 V10')
})

test('resolvableLexiconNames：refs 为空 → null（跳过查库；索引用不着时不碰它）', async () => {
  const bogus = join(tmpdir(), 'a4m-no-such-lexicon-77c.db')
  assert.equal(resolvableLexiconNames(bogus, []), null)
  assert.equal(resolvableLexiconNames(bogus, null), null)
  assert.equal(resolvableLexiconNames(bogus, undefined), null)
})

test('resolvableLexiconNames：索引不可用 → 抛错且带修复动作，绝不降级成空集合/弱化模式', async (t) => {
  const dir = await tempDir(t)
  const corpus = await writeCorpus(dir)

  // 1) 索引文件不存在
  assert.throws(
    () => resolvableLexiconNames(join(dir, 'missing.db'), ['Even.add']),
    (err) =>
      /ensureLexiconIndex|concept_lookup/.test(err.message) &&
      /词典索引不存在|词典索引不可用/.test(err.message) &&
      /V10/.test(err.message),
    '索引缺失必须抛错并给出构建动作',
  )

  // 2) 索引文件损坏（sqlite 打不开）——同样是抛错，不是空集合
  const corrupt = join(dir, 'corrupt.db')
  await writeFile(corrupt, 'this is not a sqlite database\n', 'utf8')
  assert.throws(
    () => resolvableLexiconNames(corrupt, ['Even.add']),
    (err) => /修复动作/.test(err.message) && /concept_lookup\(rebuild=true\)/.test(err.message),
    '损坏索引也必须抛错并给出重建动作',
  )

  // 3) 入参非法：TypeError（不是静默返回 null）
  const dbPath = join(dir, 'lexicon.db')
  await ensureLexiconIndex({ corpusPath: corpus, dbPath })
  assert.throws(() => resolvableLexiconNames(dbPath, 'Even.add'), /必须是字符串数组/)
  assert.throws(() => resolvableLexiconNames(dbPath, ['Even.add', 42]), /refs\[1\]/)
})

test('ensureLexiconIndex：坏索引文件自动重建，不把坏库当可用缓存', async (t) => {
  const dir = await tempDir(t)
  const corpus = await writeCorpus(dir)
  const dbPath = join(dir, 'lexicon.db')
  await writeFile(dbPath, 'this is not a sqlite database\n', 'utf8')
  const result = await ensureLexiconIndex({ corpusPath: corpus, dbPath })
  assert.deepEqual(result, { count: 3, built: true })
  assert.deepEqual(lookupLemma(dbPath, ['AbsConvex']).found.map((r) => r.name), ['AbsConvex'])
})

test('ensureLexiconIndex：rebuild 时语料缺失 —— 报错且不动现有索引', async (t) => {
  const dir = await tempDir(t)
  const corpus = await writeCorpus(dir)
  const dbPath = join(dir, 'lexicon.db')
  await ensureLexiconIndex({ corpusPath: corpus, dbPath })
  await assert.rejects(
    ensureLexiconIndex({ corpusPath: join(dir, 'gone.jsonl'), dbPath, rebuild: true }),
    /语料文件不存在：.*索引无法重建/s,
  )
  assert.deepEqual(lookupLemma(dbPath, ['AbsConvex']).found.map((r) => r.name), ['AbsConvex'], '旧索引必须仍可用')
})

test('ensureLexiconIndex：取消时抛 AbortError 且不留半个索引', async (t) => {
  const dir = await tempDir(t)
  const many = Array.from({ length: 5000 }, (_, i) => ({ ...FIXTURE[0], name: [`L${i}`] }))
  const corpus = await writeCorpus(dir, many, 'many.jsonl')
  const dbPath = join(dir, 'cache', 'lexicon.db')

  const ac = new AbortController()
  setTimeout(() => ac.abort(), 0)
  await assert.rejects(ensureLexiconIndex({ corpusPath: corpus, dbPath, signal: ac.signal }), isAbort)

  assert.ok(!existsSync(dbPath), '取消后不得留下可用索引')
  const leftovers = readdirSync(join(dir, 'cache')).filter((f) => f.includes('.building-'))
  assert.deepEqual(leftovers, [], '临时构建文件必须清理')
})

test('ensureLexiconIndex：入参校验', async () => {
  await assert.rejects(ensureLexiconIndex({ dbPath: 'x.db' }), /corpusPath/)
  await assert.rejects(ensureLexiconIndex({ corpusPath: 'x.jsonl' }), /dbPath/)
})

test('真实语料：建索引并查到 AbsConvex 的 informal_name', { ...REAL, skip: process.env.A4M_REAL_CORPUS ? false : '默认跳过（A4M_REAL_CORPUS=1 时跑）' }, async (t) => {
  const dir = await tempDir(t)
  const dbPath = join(dir, 'lexicon.db')
  const started = process.hrtime.bigint()
  const { count, built } = await ensureLexiconIndex({ corpusPath: CORPUS, dbPath })
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  assert.equal(built, true)
  assert.equal(count, 310_579)
  const { found, missing } = lookupLemma(dbPath, ['AbsConvex'])
  assert.deepEqual(missing, [])
  assert.equal(found[0].informal_name, 'Absolutely Convex Set')
  assert.ok(ms > 0)
  console.log(`      [real] 建索引 ${count} 条，用时 ${ms.toFixed(0)} ms，db 体积 ${(statSync(dbPath).size / 1048576).toFixed(1)} MB`)
})

// ── artifacts.mjs：产物落盘 ────────────────────────────────────────────

const SKELETON = {
  theorem: 'Mathlib.Algebra.Group.Even.add',
  root: 'n0',
  nodes: {
    n0: {
      id: 'n0',
      decl: 'Mathlib.Algebra.Group.Even.add',
      kind: 'theorem',
      signature: 'Even a → Even b → Even (a + b)',
      typeFingerprint: 'sha256:abc',
      hypotheses: ['ha : Even a'],
      parent: null,
      lemmaRefs: ['Even.add'],
      source: 'lsv2',
      truncated: false,
    },
  },
  coverage: { mode: 'tactic-single', haveCount: 0, nodeCount: 1, degraded: true, degradeReason: '只有根节点' },
}

test('artifactPath：skeleton / ledger / render 三条路径 + slug 规则', () => {
  assert.equal(artifactPath('out', 'skeleton', 'Mathlib.Algebra.Group.Even.add'), 'out/skeleton/Mathlib.Algebra.Group.Even.add.json')
  assert.equal(artifactPath('out', 'ledger', 'Mathlib.Algebra.Group.Even.add'), 'out/ledger/Mathlib.Algebra.Group.Even.add.json')
  assert.equal(artifactPath('out', 'render', 'Mathlib.Algebra.Group.Even.add'), 'out/render/Mathlib.Algebra.Group.Even.add.html')
  assert.equal(artifactPath('out', 'skeleton', 'A/B/C'), 'out/skeleton/A_B_C.json')
  assert.equal(artifactPath('/tmp/out', 'ledger', 'Dioph/term_D/_'), '/tmp/out/ledger/Dioph_term_D__.json')
})

test('artifactPath：未知 kind / 空 outputDir 抛错并给出可用值', () => {
  assert.throws(() => artifactPath('out', 'report', 'X.y'), /未知的产物类型.*"skeleton"/s)
  assert.throws(() => artifactPath('', 'skeleton', 'X.y'), /outputDir/)
  assert.throws(() => artifactPath('out', 'skeleton', ''), /空声明名/)
})

test('writeSkeleton / readSkeleton：落盘是 snake_case 契约，读回是 camelCase', async (t) => {
  const dir = await tempDir(t)
  const path = await writeSkeleton(dir, SKELETON.theorem, SKELETON)
  assert.equal(path, join(dir, 'skeleton', 'Mathlib.Algebra.Group.Even.add.json'))

  const onDisk = JSON.parse(await readFile(path, 'utf8'))
  assert.ok(Object.hasOwn(onDisk.nodes.n0, 'type_fingerprint'), '磁盘上必须是 snake_case')
  assert.equal(onDisk.nodes.n0.type_fingerprint, 'sha256:abc')
  assert.equal(onDisk.coverage.degrade_reason, '只有根节点')
  assert.equal(onDisk.spec_version, SPEC_VERSION, '★ 落盘必须盖当前契约版本戳')

  const back = await readSkeleton(dir, SKELETON.theorem)
  assert.deepEqual(back, { ...SKELETON, specVersion: SPEC_VERSION }, '读回必须与写入的 camelCase 对象一致（多一个版本戳）')
})

test('readSkeleton：文件不存在时抛错并指向 skeleton_extract', async (t) => {
  const dir = await tempDir(t)
  await assert.rejects(readSkeleton(dir, 'No.Such.Theorem'), /骨架文件不存在.*skeleton_extract/s)
})

test('readSkeleton：坏 JSON / 缺 coverage 的文件必须报错', async (t) => {
  const dir = await tempDir(t)
  const file = artifactPath(dir, 'skeleton', 'A.b')
  await import('node:fs/promises').then(({ mkdir }) => mkdir(join(dir, 'skeleton'), { recursive: true }))
  await writeFile(file, '{oops', 'utf8')
  await assert.rejects(readSkeleton(dir, 'A.b'), /不是合法 JSON/)
  await writeFile(file, JSON.stringify({ spec_version: SPEC_VERSION, theorem: 'A.b', root: 'n0', nodes: {} }), 'utf8')
  await assert.rejects(readSkeleton(dir, 'A.b'), /缺 nodes \/ coverage/)
})

test('陈旧产物（缺 spec_version）不得被静默消费：skeleton / ledger 都拦下', async (t) => {
  const dir = await tempDir(t)
  await import('node:fs/promises').then(({ mkdir }) =>
    Promise.all([mkdir(join(dir, 'skeleton'), { recursive: true }), mkdir(join(dir, 'ledger'), { recursive: true })]),
  )
  // 模拟 22:57 用旧代码写的骨架：形态合法（nodes/coverage 都在），但没有 spec_version
  const stale = {
    theorem: 'A.b',
    root: 'n0',
    nodes: { n0: { id: 'n0', decl: 'A.b', kind: 'theorem', signature: 's', parent: null } },
    coverage: { mode: 'tactic-multiline', have_count: 5, node_count: 6, degraded: true, degrade_reason: '证明体疑似被数据集截断' },
  }
  await writeFile(artifactPath(dir, 'skeleton', 'A.b'), JSON.stringify(stale), 'utf8')
  await assert.rejects(
    readSkeleton(dir, 'A.b'),
    (err) =>
      /spec_version/.test(err.message) &&
      /skeleton_extract\("A\.b"\)/.test(err.message) &&
      /coverage\.truncated/.test(err.message),
    '旧骨架必须报错，且消息要给出重新生成的动作',
  )

  await writeFile(artifactPath(dir, 'ledger', 'A.b'), JSON.stringify({ theorem: 'A.b', annotations: [] }), 'utf8')
  await assert.rejects(
    readLedger(dir, 'A.b'),
    (err) => /spec_version/.test(err.message) && /annotate_submit\("A\.b"/.test(err.message),
  )
})

test('主版本不匹配的产物必须报错；同主版本的旧次版本仍可读', async (t) => {
  const dir = await tempDir(t)
  await import('node:fs/promises').then(({ mkdir }) => mkdir(join(dir, 'skeleton'), { recursive: true }))
  const tree = { theorem: 'A.b', root: 'n0', nodes: { n0: {} }, coverage: { mode: 'term', have_count: 0, node_count: 1, degraded: true, degrade_reason: null } }

  await writeFile(artifactPath(dir, 'skeleton', 'A.b'), JSON.stringify({ ...tree, spec_version: '2.0.0' }), 'utf8')
  await assert.rejects(
    readSkeleton(dir, 'A.b'),
    (err) => /主版本不一致/.test(err.message) && /2\.0\.0/.test(err.message) && /skeleton_extract/.test(err.message),
  )

  await writeFile(artifactPath(dir, 'skeleton', 'A.b'), JSON.stringify({ ...tree, spec_version: '1.0.0' }), 'utf8')
  const back = await readSkeleton(dir, 'A.b')
  assert.equal(back.specVersion, '1.0.0', '同主版本视为可读（本次只拦主版本跃迁与缺戳）')

  await writeFile(artifactPath(dir, 'skeleton', 'A.b'), JSON.stringify({ ...tree, spec_version: 'not-a-version' }), 'utf8')
  await assert.rejects(readSkeleton(dir, 'A.b'), /缺少可识别的 spec_version/)
})

test('readLedger：不存在返回 null；写入后读回（含输出有界字段的往返）', async (t) => {
  const dir = await tempDir(t)
  assert.equal(await readLedger(dir, 'A.b'), null)

  const ledger = {
    specVersion: SPEC_VERSION,
    mathlibBaseline: 'v4.28.0-rc1',
    theorem: 'A.b',
    skeleton: SKELETON,
    annotations: [
      {
        id: 'a7',
        node: 'n0',
        role: 'core_idea',
        height: 'bird',
        evidence: 'formal',
        significance: 'main',
        presentation: 'paraphrase',
        audience: 'grad-math',
        segments: [{ kind: 'reasoning', text: '…' }],
        anchors: [{ kind: 'goal', target: 'n0' }],
        refs: [],
        provenance: { model: 'deepseek-flash', ts: '2026-10-07T22:00:00+08:00', run: 'pilot-01' },
      },
    ],
    metrics: { nodeCount: 1, annotatedNodeCount: 1, mainCoverage: 1, anchorPrecision: 1, conceptCoverage: null },
    provenance: { run: 'pilot-01', created: '2026-10-07T22:00:00+08:00' },
  }
  const path = await writeLedger(dir, 'A.b', ledger)
  assert.equal(path, join(dir, 'ledger', 'A.b.json'))

  const onDisk = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(onDisk.spec_version, SPEC_VERSION)
  assert.equal(onDisk.annotations[0].segments[0].kind, 'reasoning', '枚举值必须原样保留')
  assert.equal(onDisk.metrics.concept_coverage, null, 'null 与 0 语义不同（H2）')

  assert.deepEqual(await readLedger(dir, 'A.b'), ledger)
})

test('writeLedger：覆盖写是原子替换，读到的永远是完整 JSON', async (t) => {
  const dir = await tempDir(t)
  const ledger = { specVersion: SPEC_VERSION, theorem: 'A.b', annotations: [] }
  await writeLedger(dir, 'A.b', ledger)
  await writeLedger(dir, 'A.b', { ...ledger, annotations: [{ id: 'a1' }] })
  const back = await readLedger(dir, 'A.b')
  assert.deepEqual(back.annotations, [{ id: 'a1' }])
  const leftovers = readdirSync(join(dir, 'ledger')).filter((f) => f.includes('.tmp-'))
  assert.deepEqual(leftovers, [], '临时文件必须被 rename 掉')
  await assert.rejects(writeLedger(dir, 'A.b', null), /需要 Ledger 对象/)
})

test('writeSkeleton：入参必须是对象', async (t) => {
  const dir = await tempDir(t)
  await assert.rejects(writeSkeleton(dir, 'A.b', null), /需要 SkeletonTree 对象/)
})

test('写出的产物一律盖当前 spec_version（调用方给旧版本号也被覆盖，写出去就一定能读回来）', async (t) => {
  const dir = await tempDir(t)
  const skPath = await writeSkeleton(dir, 'A.b', {
    ...{ theorem: 'A.b', root: 'n0', nodes: { n0: {} }, coverage: { mode: 'term' } },
    specVersion: '0.9.0',
  })
  assert.equal(JSON.parse(await readFile(skPath, 'utf8')).spec_version, SPEC_VERSION)
  assert.equal((await readSkeleton(dir, 'A.b')).specVersion, SPEC_VERSION)

  const lgPath = await writeLedger(dir, 'B.c', { specVersion: '0.9.0', theorem: 'B.c', annotations: [] })
  assert.equal(JSON.parse(await readFile(lgPath, 'utf8')).spec_version, SPEC_VERSION)
  assert.equal((await readLedger(dir, 'B.c')).specVersion, SPEC_VERSION, '不得写出一个自己读不回来的文件')
})

test('writeRender：render 路径 / 原子覆盖写 / 非字符串入参报错', async (t) => {
  const dir = await tempDir(t)
  const decl = 'Mathlib.Algebra.Group.Even.add'

  const path = await writeRender(dir, decl, '<html>v1</html>')
  assert.equal(path, join(dir, 'render', 'Mathlib.Algebra.Group.Even.add.html'))
  assert.equal(await readFile(path, 'utf8'), '<html>v1</html>')

  // 覆盖写：内容整体替换，且不留临时文件
  await writeRender(dir, decl, '<html>v2</html>')
  assert.equal(await readFile(path, 'utf8'), '<html>v2</html>')
  assert.deepEqual(
    readdirSync(join(dir, 'render')).filter((f) => f.includes('.tmp-')),
    [],
  )

  // 非字符串入参：带修复动作的 TypeError，不得 String() 强转，也不得写出文件
  await assert.rejects(
    writeRender(dir, 'A.b', null),
    (err) => err instanceof TypeError && /html 字符串/.test(err.message) && /renderLedgerHtml/.test(err.message),
  )
  await assert.rejects(writeRender(dir, 'A.b', { html: '<p>' }), TypeError)
  assert.ok(!existsSync(join(dir, 'render', 'A.b.html')), '入参非法时不得留下产物')
})

// ── §7.1 零依赖 / L5 转换点（静态自检；权威检查在 test/layers.test.mjs）──

test('§7.1：src/io 只 import node: 内建与相对路径，不得出现 DSH / npm 依赖', async () => {
  const files = readdirSync(join(ROOT, 'src', 'io')).filter((f) => f.endsWith('.mjs'))
  assert.ok(files.length >= 6)
  for (const file of files) {
    const source = readFileSync(join(ROOT, 'src', 'io', file), 'utf8')
    // 只扫 import 说明符（静态 + 动态），不看注释——注释里提到包名不算依赖
    const specs = [
      ...[...source.matchAll(/(?:^|\n)\s*import[^\n]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]),
      ...[...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]),
    ]
    for (const spec of specs) {
      assert.ok(
        spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../'),
        `${file} 不允许 import ${spec}（零运行时依赖 / L3：只有 src/tools 可以用 DSH 包）`,
      )
    }
  }
})

test('L5：snake/camel 转换实现只出现在 src/io/contract.mjs', () => {
  const files = readdirSync(join(ROOT, 'src', 'io')).filter((f) => f.endsWith('.mjs'))
  for (const file of files) {
    if (file === 'contract.mjs') continue
    const source = readFileSync(join(ROOT, 'src', 'io', file), 'utf8')
    assert.ok(!/function\s+toCamel|function\s+toSnake/.test(source), `${file} 不得再实现一份转换`)
    assert.ok(!/replace\(\/_\+|_\(\[a-z\]\)/.test(source), `${file} 不得内联键名转换正则`)
  }
})
