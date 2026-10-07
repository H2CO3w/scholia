/**
 * graph-io.test.mjs — `src/io/lean-imports.mjs`（INTERFACES 附录 G.2）的行为测试
 *
 * 全部用**自造的极小夹具树**（不依赖 .probe-nse）；唯一一个真实树用例在 `.probe-nse`
 * 不存在时自动 skip——那是临时数据源，不进仓库。
 *
 * 覆盖：模块名口径 / internal vs external / 注释与字符串里的幻影 import / 行尾注释 /
 * 循环 import / 自己 import 自己 / 重复 import 去重 / 一行多模块 / `import all` /
 * 空目录 / 无 import 文件 / 跳过 .lake·build·node_modules·点目录 / 确定性 / 取消 / 错误路径。
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { scanLeanImports } from '../src/io/lean-imports.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const NSE = join(ROOT, '.probe-nse')
const HAS_NSE = existsSync(NSE)

async function tempDir(t, prefix = 'a4m-graph-') {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** 按 `{ 'A.lean': '源码' }` 建一棵树（自动建中间目录）。 */
async function makeTree(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const file = join(dir, rel)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, content, 'utf8')
  }
  return dir
}

const edgeKey = (e) => `${e.from}->${e.to}:${e.external ? 'ext' : 'int'}`

test('scanLeanImports：模块名 / internal / external / 去重 / 循环 / 自引用', async (t) => {
  const dir = await tempDir(t)
  await makeTree(dir, {
    'A.lean': [
      'import B',
      'import Mathlib.Data.Nat',
      'import B', // 重复 import → 只算一条边
      'import Baz -- 行尾注释不是模块名',
      '',
    ].join('\n'),
    'B.lean': 'import A\n', // 循环 A→B→A
    'B/C.lean': 'import A\nimport B.C\n', // 自己 import 自己
    'D.lean': 'def nothing := 1\n', // 无 import
    'E.lean': [
      'public import A',
      '',
      '-- import Zzz.Commented',
      '/- import Yyy.Block -/',
      '/- 跨行块注释',
      '   import Www.Multiline',
      '   嵌套 /- 内层 import Vvv.Nested -/ 仍在注释里',
      '   import Uuu.StillCommented -/',
      'import Ttt.AfterBlock -- 块注释结束后的真 import',
      'def s := "import Qqq.String"',
      '',
    ].join('\n'),
    'F.lean': 'import A B\n', // 一行多模块
    'G.lean': 'import all A\n', // import all：all 不是模块名
  })

  const graph = await scanLeanImports(dir)

  assert.deepEqual(graph.modules, ['A', 'B', 'B.C', 'D', 'E', 'F', 'G'], '模块名 = 相对路径去 .lean、/ 换 .，且排序')
  assert.deepEqual(
    graph.edges.map(edgeKey),
    [
      'A->B:int',
      'A->Baz:ext',
      'A->Mathlib.Data.Nat:ext',
      'B->A:int',
      'B.C->A:int',
      'B.C->B.C:int',
      'E->A:int',
      'E->Ttt.AfterBlock:ext',
      'F->A:int',
      'F->B:int',
      'G->A:int',
    ],
    '边必须逐条正确、排序、且注释/字符串里的 import 不得出现',
  )
  assert.deepEqual(graph.stats, { fileCount: 7, internalEdges: 8, externalEdges: 3 })
  // 幻影边（注释 / 字符串里的 import）一条都不许有
  for (const phantom of ['Zzz.Commented', 'Yyy.Block', 'Qqq.String', 'all', 'Www.Multiline', 'Vvv.Nested', 'Uuu.StillCommented']) {
    assert.equal(graph.edges.some((e) => e.to === phantom), false, `${phantom} 是幻影边`)
  }
})

test('scanLeanImports：空目录 / 只有非 .lean 文件的目录', async (t) => {
  const empty = await tempDir(t)
  assert.deepEqual(await scanLeanImports(empty), {
    modules: [],
    edges: [],
    stats: { fileCount: 0, internalEdges: 0, externalEdges: 0 },
    docstrings: {},
  })

  const docs = await tempDir(t)
  await makeTree(docs, { 'README.md': '# x\n', 'lakefile.toml': 'name = "x"\n', 'a/b.txt': 'import Foo\n' })
  const graph = await scanLeanImports(docs)
  assert.deepEqual(graph.modules, [])
  assert.equal(graph.stats.fileCount, 0)
  assert.deepEqual(graph.docstrings, {})
})

test('docstrings：多行折叠 / Markdown 标题保留 / 无说明键缺省 / 空块是空串', async (t) => {
  const dir = await tempDir(t)
  await makeTree(dir, {
    // 真实形态：import 之后才是 `/-!` 块（实测 1838/1839 都不在第 1 行）
    'Packet.lean': [
      'import Mathlib.Data.Nat',
      '',
      '/-!',
      '# Packet bounds',
      '',
      'Each surviving grade of the literal packet residual',
      '      has a fixed-radius estimate.',
      '-/',
      '',
      'noncomputable section',
      '',
    ].join('\n'),
    'NoDoc.lean': 'def x := 1\n',
    'EmptyDoc.lean': '/-! -/\ndef y := 2\n',
    'OnlyLaterBlock.lean': [
      'def z := 3',
      '',
      '/-! 这是文件里唯一的说明块（不在最顶上，但仍是第一个） -/',
      '',
    ].join('\n'),
  })

  const graph = await scanLeanImports(dir)

  assert.equal(
    graph.docstrings['Packet'],
    '# Packet bounds Each surviving grade of the literal packet residual has a fixed-radius estimate.',
    '多行折叠成单行、连续空白压成一个空格、Markdown 标题原样保留',
  )
  assert.equal('NoDoc' in graph.docstrings, false, '没有说明的模块必须**键缺省**（不是空串）')
  assert.equal(graph.docstrings['EmptyDoc'], '', '块存在但内容为空 → 键在、值为空串（与「没说明」可区分）')
  assert.equal(graph.docstrings['OnlyLaterBlock'], '这是文件里唯一的说明块（不在最顶上，但仍是第一个）')
  assert.equal(
    Object.values(graph.docstrings).some((d) => d.includes('-/') || d.includes('/-!')),
    false,
    '说明里不得残留注释定界符',
  )
  assert.equal(Object.values(graph.docstrings).some((d) => /\n|\s\s/.test(d)), false, '说明必须已折叠成单行')
  // 说明里的 import 字样不得变成依赖
  assert.deepEqual(graph.edges.map((e) => `${e.from}->${e.to}`), ['Packet->Mathlib.Data.Nat'])
})

test('docstrings：嵌套注释正确配对 + 只取第一个块 + 只认顶层 `/-!`', async (t) => {
  const dir = await tempDir(t)
  await makeTree(dir, {
    // 真嵌套：内层 `/- … -/` 完整包含在外层块内，只有**配对到最外层**的 `-/` 才结束说明。
    // 若实现截断在内部那个 `-/`，后面的「之后仍在块内 / 仍然属于外层」就会丢。
    'Nested.lean': [
      '/-! 外层说明',
      '   内层嵌套 /- 内层注释 -/ 之后仍在块内',
      '   仍然属于外层 -/',
      '',
      '/-! 第二个块（必须被忽略） -/',
      '',
    ].join('\n'),
    'NotTopLevel.lean': ['/- 普通块注释里写 /-! 这不算模块说明 -/', 'def a := 1', ''].join('\n'),
  })

  const graph = await scanLeanImports(dir)

  assert.equal(
    graph.docstrings['Nested'],
    '外层说明 内层嵌套 /- 内层注释 -/ 之后仍在块内 仍然属于外层',
    '嵌套注释要配对到最外层：内层 `-/` 之后的内容必须仍在说明里（此处的 `/-`/`-/` 是嵌套注释的真实内容，不是残留）',
  )
  assert.ok(graph.docstrings['Nested'].includes('之后仍在块内'), '内层 `-/` 之后的内容不得丢失')
  assert.equal('NotTopLevel' in graph.docstrings, false, '别的注释里嵌的 `/-!` 不算模块说明')
})

test('docstrings：说明里的 import 字样不得被当成依赖', async (t) => {
  const dir = await tempDir(t)
  await makeTree(dir, {
    'A.lean': '/-! 本文件依赖 import Mathlib.Fake.Module 提供的东西（这只是说明文字） -/\nimport Real.Dep\n',
    'Real.lean': '',
  })
  const graph = await scanLeanImports(dir)
  assert.deepEqual(graph.edges.map((e) => `${e.from}->${e.to}:${e.external ? 'ext' : 'int'}`), ['A->Real.Dep:ext'])
  assert.equal(graph.docstrings['A'], '本文件依赖 import Mathlib.Fake.Module 提供的东西（这只是说明文字）')
})

test('scanLeanImports：跳过 .lake / build / node_modules / 点目录', async (t) => {
  const dir = await tempDir(t)
  await makeTree(dir, {
    'Keep.lean': 'import Foo.Bar\n',
    '.lake/packages/mathlib/Mathlib/Dep.lean': 'import Foo.Bar\n',
    'build/lib/Built.lean': 'import Foo.Bar\n',
    'node_modules/pkg/Node.lean': 'import Foo.Bar\n',
    '.git/hooks/Git.lean': 'import Foo.Bar\n',
    '.hidden/Hidden.lean': 'import Foo.Bar\n',
  })
  const graph = await scanLeanImports(dir)
  assert.deepEqual(graph.modules, ['Keep'])
  assert.equal(graph.stats.fileCount, 1)
  assert.deepEqual(graph.edges.map(edgeKey), ['Keep->Foo.Bar:ext'])
})

test('scanLeanImports：确定性（同输入两次结果完全一致）', async (t) => {
  const dir = await tempDir(t)
  await makeTree(dir, {
    'Z.lean': 'import A\nimport B\n',
    'A.lean': 'import B\n',
    'B.lean': 'import A\n',
    'm/N.lean': 'import A\n',
    'm/O.lean': 'import N\n',
  })
  const first = await scanLeanImports(dir)
  const second = await scanLeanImports(dir)
  assert.deepEqual(second, first)
  // 排序是可断言的强性质：modules 升序、edges 按 (from, to) 升序
  assert.deepEqual(first.modules, [...first.modules].sort())
  const sorted = [...first.edges].sort((a, b) => (a.from === b.from ? (a.to < b.to ? -1 : a.to > b.to ? 1 : 0) : a.from < b.from ? -1 : 1))
  assert.deepEqual(first.edges, sorted)
})

test('scanLeanImports：取消（已取消 / 扫描途中）', async (t) => {
  const dir = await tempDir(t)
  await makeTree(dir, { 'A.lean': 'import B\n', 'B.lean': 'import A\n' })

  const pre = new AbortController()
  pre.abort()
  await assert.rejects(scanLeanImports(dir, { signal: pre.signal }), (err) => err.name === 'AbortError')

  // 扫描途中取消：用一个「第一次读 aborted 之后即为 true」的桩信号，保证时序确定
  let reads = 0
  const stub = {
    get aborted() {
      reads += 1
      return reads > 1
    },
    addEventListener() {},
    removeEventListener() {},
    reason: undefined,
  }
  await assert.rejects(scanLeanImports(dir, { signal: stub }), (err) => err.name === 'AbortError')
})

test('scanLeanImports：错误路径（不存在的树 / 指向文件 / 非法入参 / 非法 signal）', async (t) => {
  const dir = await tempDir(t)
  await assert.rejects(
    scanLeanImports(join(dir, 'no-such-tree')),
    (err) => err.code === 'ENOENT' && /Lean 源码树不存在/.test(err.message) && /路径/.test(err.message),
  )
  await makeTree(dir, { 'A.lean': 'import B\n' })
  await assert.rejects(scanLeanImports(join(dir, 'A.lean')), /不是目录/)
  await assert.rejects(scanLeanImports(''), /需要源码树根目录/)
  await assert.rejects(scanLeanImports(null), /需要源码树根目录/)
  await assert.rejects(scanLeanImports(dir, { signal: {} }), /AbortSignal/)
})

test('scanLeanImports：只读（扫描后源码树逐字节不变）', async (t) => {
  const dir = await tempDir(t)
  const source = 'import B\nimport Mathlib.Data.Nat\n'
  await makeTree(dir, { 'A.lean': source, 'B.lean': 'import A\n' })
  const before = await import('node:fs/promises').then(({ readFile }) => readFile(join(dir, 'A.lean'), 'utf8'))
  await scanLeanImports(dir)
  const after = await import('node:fs/promises').then(({ readFile }) => readFile(join(dir, 'A.lean'), 'utf8'))
  assert.equal(after, before)
  assert.equal(after, source)
})

test(
  '真实 Lean 树 .probe-nse/Euler：1839 个文件 / 1838 个有说明（与 Lead 独立测量一致）',
  { skip: HAS_NSE ? false : '.probe-nse 不存在（临时数据源，不进仓库）' },
  async () => {
    const graph = await scanLeanImports(join(NSE, 'Euler'))
    assert.equal(graph.stats.fileCount, 1839, 'Euler/ 下的 .lean 文件数')
    assert.equal(graph.modules.length, 1839)
    assert.equal(Object.keys(graph.docstrings).length, 1838, '有说明的模块数')
    assert.deepEqual(
      graph.modules.filter((m) => !(m in graph.docstrings)),
      ['CurlMatrixSymmetry'],
      '唯一没有 `/-!` 说明的模块（键必须缺省，不是空串）',
    )
    for (const [module, doc] of Object.entries(graph.docstrings)) {
      assert.equal(/\n|\s\s/.test(doc), false, `${module} 的说明没有折叠成单行`)
      assert.equal(doc.includes('-/') || doc.includes('/-!'), false, `${module} 的说明残留注释定界符`)
      assert.equal(doc, doc.trim(), `${module} 的说明首尾未去空白`)
    }
    // 抽查：图上没人看得懂的名字 → 作者写的人话
    assert.equal(
      graph.docstrings['PacketTailGradeBounds'],
      'Each surviving grade of the literal packet residual has a fixed-radius estimate.',
    )
  },
)

test(
  '真实 Lean 树 .probe-nse：与 Lead 的独立测量逐项一致',
  { skip: HAS_NSE ? false : '.probe-nse 不存在（临时数据源，不进仓库）' },
  async () => {
    const graph = await scanLeanImports(NSE)
    assert.equal(graph.stats.fileCount, 2659, '.lean 文件数')
    assert.equal(graph.stats.internalEdges, 6105, '项目内 import 边')
    assert.equal(new Set(graph.edges.filter((e) => !e.external).map((e) => e.from)).size, 2584, '有出边（项目内）的模块数')
    assert.equal(graph.stats.externalEdges + graph.stats.internalEdges, graph.edges.length)
    assert.equal(graph.modules.length, 2659)
    assert.ok(graph.modules.includes('Euler') && graph.modules.includes('NavierStokes'), '任务要画的根模块必须在图里')
    for (const edge of graph.edges) {
      assert.equal(edge.external, !graph.modules.includes(edge.to), `external 标记必须等于「目标是否在本树内」：${edge.to}`)
    }
  },
)
