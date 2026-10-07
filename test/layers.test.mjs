/**
 * layers.test.mjs — 分层约束 L1–L5 的静态执行者 + 出厂面（装配）检查（SPEC §5.2，ARCHITECTURE §7）
 *
 * 这五个约束是 decisions.md D1 的工程前提：`src/core` 是方法本体，第三方必须能在
 * 不装 DSH、不联网、不装 Lean 的环境下独立复现它。所以它们必须由**测试**强制，
 * 不能只写在文档里。
 *
 * ★ 扫描范围（口径，SPEC §5.2 已同步）：
 *   L1–L5 的扫描范围是 `src/**`（出厂源码，即 `package.json` 的 `files` 白名单所打包的部分）。
 *   **`test/**` 不在约束范围内**：测试夹具中的枚举值属**数据**而非枚举使用；
 *   且测试**允许** import `@deepseek-ai/dsh-tools` 以做注册期验证。
 *
 * 三条实现纪律（避免"狼来了"）：
 *   1. 扫描前先剥掉注释 —— 文档里写「禁止 import node:fs」不是违规，代码里写才是；
 *   2. 只在**整段字符串字面量恰好等于枚举值且在"当枚举用"的位置**时判 L4 违规 ——
 *      `[data-a4m-layer="intuition"]` 这类选择器、HTML 片段、显示标签不算内联枚举；
 *   3. 装配检查在缺少 `@deepseek-ai/*`（干净 checkout，未跑 link-dsh-deps）时 **skip 而不是 fail**
 *      —— 那是环境问题不是代码问题，假红会训练人忽略红灯（见文件末尾的装配 test）。
 *
 * 对"文件还没写完"宽容：不存在的目录/文件跳过。
 * 对"文件存在"严格：只要在 `src/**` 里，就必须满足它所在的层的约束。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const SRC = join(ROOT, 'src')

/** 工作区相对路径（POSIX 分隔符，报错信息里好读） */
function relOf(file) {
  return relative(ROOT, file).split(sep).join('/')
}

/** 递归列出目录下的 `.mjs` 文件；目录不存在时返回空数组（并行开发期宽容）。 */
async function listFiles(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return []
    throw error
  }
  const files = []
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await listFiles(full)))
    else if (entry.isFile() && entry.name.endsWith('.mjs')) files.push(full)
  }
  return files
}

/**
 * 判断 `/` 是否开启一个正则字面量（而非除法）。
 * 只看前一个有意义字符：`)`/`]`/标识符/数字/字符串收尾之后是除法，其余位置当正则。
 * 判断错了也不会失控——正则不允许跨行，扫不到收尾 `/` 就按普通字符处理。
 * @param {string|undefined} prev
 */
function isRegexPosition(prev) {
  if (prev === undefined) return true
  return !/[A-Za-z0-9_$)\]"'`]/.test(prev)
}

/** 从 `source[start] === '/'` 起扫描正则字面量；返回结束下标，跨行或未闭合返回 -1。 */
function scanRegexLiteral(source, start) {
  let j = start + 1
  let inClass = false
  while (j < source.length) {
    const ch = source[j]
    if (ch === '\\') { j += 2; continue }
    if (ch === '\n') return -1
    if (inClass) {
      if (ch === ']') inClass = false
      j++
      continue
    }
    if (ch === '[') { inClass = true; j++; continue }
    if (ch === '/') return j + 1
    j++
  }
  return -1
}

/**
 * 单趟扫描源码：剥掉注释，同时**只**收集真正的字符串字面量。
 *
 * 为什么要自己扫而不是正则：
 *   - `// ...` 注释里的示例（"禁止写 'step'"）不是代码；
 *   - 模板串的**文本**部分（HTML/CSS 片段，如 `[data-a4m-layer="intuition"]`）是产物内容，
 *     不是内联枚举；但模板串 `${...}` 里的表达式仍是代码，其中的字面量要照常检查；
 *   - 正则字面量里可以有引号与反引号（如 `.replace(/```[\\s\\S]*?```/g, ' ')`），
 *     必须整体跳过，否则扫描状态会错位。
 *
 * 返回：
 *   code     —— 注释已被移除的源码（保留换行，行号可用；字符串与正则原样保留，便于 L1/L3/L5 扫描）
 *   literals —— 代码位置上的字符串字面量 `{ value, index }`（index 指向上面的 code）
 * @param {string} source
 */
function scanSource(source) {
  let code = ''
  let prev = undefined
  const push = (text) => {
    code += text
    for (let k = text.length - 1; k >= 0; k--) {
      if (!/\s/.test(text[k])) { prev = text[k]; break }
    }
  }
  const literals = []
  const stack = [{ kind: 'code' }]
  const top = () => stack[stack.length - 1]
  for (let i = 0; i < source.length;) {
    const c = source[i]
    const next = source[i + 1]
    const state = top()

    if (state.kind === 'template') {
      if (c === '\\') { push(c + (next ?? '')); i += 2; continue }
      if (c === '`') { stack.pop(); push(c); i++; continue }
      if (c === '$' && next === '{') { stack.push({ kind: 'expr', depth: 0 }); push('${'); i += 2; continue }
      push(c)
      i++
      continue
    }

    // state.kind === 'code' | 'expr'
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++
      continue
    }
    if (c === '/' && next === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') push('\n')
        i++
      }
      i += 2
      continue
    }
    if (c === '/' && isRegexPosition(prev)) {
      const end = scanRegexLiteral(source, i)
      if (end > 0) { push(source.slice(i, end)); i = end; continue }
    }
    if (c === "'" || c === '"') {
      const index = code.length
      let value = ''
      i++
      while (i < source.length && source[i] !== c) {
        if (source[i] === '\\') { value += source[i] + (source[i + 1] ?? ''); i += 2; continue }
        value += source[i]
        i++
      }
      i++ // 收尾引号
      push(c + value + c)
      literals.push({ value, index })
      continue
    }
    if (c === '`') { stack.push({ kind: 'template' }); push(c); i++; continue }
    if (state.kind === 'expr') {
      if (c === '{') state.depth++
      else if (c === '}') {
        if (state.depth === 0) { stack.pop(); push(c); i++; continue }
        state.depth--
      }
    }
    push(c)
    i++
  }
  return { code, literals }
}

/** 1 基行号（索引针对 `scanSource` 返回的 code） */
function lineOf(code, index) {
  let line = 1
  for (let i = 0; i < index && i < code.length; i++) if (code[i] === '\n') line++
  return line
}

/** L1：core 与 render 的禁止项（SPEC §5.2） */
const FORBIDDEN_IN_PURE_LAYERS = [
  ['node:fs', /node:fs/],
  ['node:net', /node:net/],
  ['node:sqlite', /node:sqlite/],
  ['fetch(', /\bfetch\s*\(/],
  ['@deepseek-ai/', /@deepseek-ai\//],
]

/** L3：只有 src/tools 可以 import 的 DSH 包 */
const DSH_IMPORT = /['"]@deepseek-ai\/(?:dsh-tools|schemastery)['"]/

/** L5：snake ⇄ camel 转换的机械特征（定义 + 键名重写正则） */
const CONVERSION_DEFINITION = /(?:export\s+)?(?:async\s+)?function\s+(toCamel|toSnake)\b|(?:const|let|var)\s+(toCamel|toSnake)\s*=/
const CONVERSION_REWRITES = [
  ['snake→camel 键名重写', /\.replace\(\s*\/[^/\n]*_\(/],
  ['camel→snake 键名重写', /\.replace\(\s*\/[^/\n]*\[A-Z\]/],
]

test('L1: src/core 与 src/render 零外部依赖（无 fs / net / sqlite / fetch / DSH）', async () => {
  const targets = [
    ...(await listFiles(join(SRC, 'core'))),
    ...(await listFiles(join(SRC, 'render'))),
  ]
  for (const file of targets) {
    const { code } = scanSource(await readFile(file, 'utf8'))
    for (const [label, pattern] of FORBIDDEN_IN_PURE_LAYERS) {
      const match = pattern.exec(code)
      assert.equal(
        match, null,
        `${relOf(file)}:${match ? lineOf(code, match.index) : '?'} 违反 L1：命中 ${label}。`
        + 'src/core 与 src/render 必须零外部依赖（SPEC §5.2 L1 / decisions.md D1）。',
      )
    }
  }
})

test('L2: src/core 的每个模块都能被独立加载（无 DSH / 无网络 / 无 LLM）', async () => {
  for (const file of await listFiles(join(SRC, 'core'))) {
    await assert.doesNotReject(
      () => import(pathToFileURL(file).href),
      `${relOf(file)} 无法独立加载；src/core 必须能在不装 DSH、不联网的环境下运行（SPEC §5.2 L2）。`,
    )
  }
})

test('L3: 只有 src/tools 可以 import @deepseek-ai/dsh-tools / schemastery', async () => {
  for (const file of await listFiles(SRC)) {
    if (relOf(file).startsWith('src/tools/')) continue
    const { code } = scanSource(await readFile(file, 'utf8'))
    const match = DSH_IMPORT.exec(code)
    assert.equal(
      match, null,
      `${relOf(file)}:${match ? lineOf(code, match.index) : '?'} 违反 L3：非工具层 import 了 ${match?.[0]}。`
      + 'DSH 绑定只允许出现在 src/tools（SPEC §5.2 L3）；请在工具层包一层，而不是让核心逻辑依赖 DSH。',
    )
  }
})

test('L4: 枚举字面量只出现在 src/core/enums.mjs', async () => {
  const enumsPath = join(SRC, 'core', 'enums.mjs')
  const files = await listFiles(SRC)
  if (!files.includes(enumsPath)) return // enums 尚未落盘：宽容跳过

  const enums = await import(pathToFileURL(enumsPath).href)
  const byEnum = {
    NODE_KIND: enums.NODE_KIND_VALUES,
    SOURCE: enums.SOURCE_VALUES,
    PROOF_MODE: enums.PROOF_MODE_VALUES,
    ROLE: enums.ROLE_VALUES,
    VALUE_TYPE: enums.VALUE_TYPE_VALUES,
    CULTURE: enums.CULTURE_VALUES,
    HEIGHT: enums.HEIGHT_VALUES,
    EVIDENCE: enums.EVIDENCE_VALUES,
    SIGNIFICANCE: enums.SIGNIFICANCE_VALUES,
    PRESENTATION: enums.PRESENTATION_VALUES,
    AUDIENCE: enums.AUDIENCE_VALUES,
    SEGMENT_KIND: enums.SEGMENT_KIND_VALUES,
    ANCHOR_KIND: enums.ANCHOR_KIND_VALUES,
    FORM: enums.FORM_VALUES,
  }
  const total = new Set(Object.values(byEnum).flat().filter((v) => typeof v === 'string'))
  assert.ok(
    total.size >= 40,
    `从 ${relOf(enumsPath)} 读到的枚举值只有 ${total.size} 个，取值数组不完整，L4 无法有效执行。`,
  )

  const violations = []
  for (const file of files) {
    if (file === enumsPath) continue
    const source = await readFile(file, 'utf8')
    const { code, literals } = scanSource(source)

    for (const literal of literals) {
      if (!total.has(literal.value)) continue
      const before = code.slice(0, literal.index)
      const where = `${relOf(file)}:${lineOf(code, literal.index)}`
      const hit = (why) => violations.push(`${where} 以枚举字面量 ${JSON.stringify(literal.value)} 参与 ${why}`)

      // (1) 比较 / switch 分支：SPEC §1.3 的 ❌ 例子就是这种
      if (/(?:===|!==|==|!=|\bcase)\s*$/.test(before)) hit('比较或 case 分支')
      // (2) 成员判定：arr.includes('x') / set.has('x')
      else if (/(?:includes|has|add|delete)\s*\(\s*$/.test(before)) hit('成员判定')
      // (3) 作为契约枚举字段的值：{ role: 'step' } / { kind: 'have' }
      else if (/(?:^|[\s{,(])(?:role|kind|mode|source|form|culture|height|evidence|significance|presentation|audience|valueType|value_type|anchorKind|anchor_kind|segmentKind|segment_kind)\s*:\s*$/.test(before)) {
        hit('枚举字段的取值')
      }
    }

    // (4) 全由同一枚举取值构成的字符串数组：new Set(['decl','goal','hyp','display'])
    for (const match of code.matchAll(/\[[^[\]{}()\n]*\]/g)) {
      const inside = [...match[0].matchAll(/'([^'\\\n]*)'|"([^"\\\n]*)"/g)]
        .map((m) => m[1] ?? m[2])
        .filter((v) => v !== undefined)
      if (inside.length < 2 || !inside.every((v) => total.has(v))) continue
      const commonEnums = Object.entries(byEnum)
        .filter(([, list]) => inside.every((v) => list.includes(v)))
        .map(([name]) => name)
      if (commonEnums.length === 0) continue
      violations.push(
        `${relOf(file)}:${lineOf(code, match.index)} 用字面量数组表达 ${commonEnums.join('/')} 枚举`
        + `（${inside.map((v) => JSON.stringify(v)).join(', ')}）`,
      )
    }
  }
  assert.deepEqual(
    violations, [],
    '违反 L4：枚举字面量只能出现在 src/core/enums.mjs（SPEC §5.2 L4）。\n'
    + '改法：import { ROLE } from \'…/core/enums.mjs\' 后用 ROLE.STEP，不要写 \'step\'。\n'
    + '（本检查只判定"字面量在当枚举用"的四种位置；恰好等于枚举值的说明文字、HTML 属性名、\n'
    + '   CSS 选择器片段不算违规——那些是数据，不是枚举使用。）\n'
    + violations.join('\n'),
  )
})

test('L5: snake_case ⇄ camelCase 的转换只出现在 src/io/contract.mjs', async () => {
  const contractPath = join(SRC, 'io', 'contract.mjs')
  const contract = relOf(contractPath)
  const files = await listFiles(SRC)

  // 正向对照：contract.mjs 存在时，它必须真的定义这两个转换（否则本测试的空词表没有意义）
  if (files.includes(contractPath)) {
    const { code } = scanSource(await readFile(contractPath, 'utf8'))
    for (const fn of ['toCamel', 'toSnake']) {
      assert.ok(
        new RegExp(`function\\s+${fn}\\b|(?:const|let|var)\\s+${fn}\\s*=`).test(code),
        `${contract} 必须导出 ${fn}（INTERFACES §2.6）。`,
      )
    }
  }

  const violations = []
  for (const file of files) {
    if (file === contractPath) continue
    const { code } = scanSource(await readFile(file, 'utf8'))
    const definition = CONVERSION_DEFINITION.exec(code)
    if (definition) {
      violations.push(
        `${relOf(file)}:${lineOf(code, definition.index)} 自己定义了 ${definition[1] ?? definition[2]}`,
      )
    }
    for (const [label, pattern] of CONVERSION_REWRITES) {
      const match = pattern.exec(code)
      if (match) violations.push(`${relOf(file)}:${lineOf(code, match.index)} ${label}`)
    }
  }
  assert.deepEqual(
    violations, [],
    '违反 L5：契约字段名的 snake/camel 转换只允许出现在 src/io/contract.mjs（SPEC §5.2 L5）。\n'
    + '改法：import { toCamel, toSnake } from \'…/io/contract.mjs\'，不要在业务逻辑里手写字段名映射。\n'
    + violations.join('\n'),
  )
})

// ── 出厂面（装配）检查 ────────────────────────────────────────────────
//
// 这一条管的是"整个 bundle 能不能起来"，而不是"层有没有串"：
// `defineTool` 在**注册期**就把参数 schema 与 output schema 编译成受约束的 JSON Schema 子集，
// 任何不合法的节点（最典型：`{ type: 'object' }` 未显式声明 `additionalProperties`）
// 都会在这里抛错，导致 `apply` 中断 → `install_bundle` 报 failed to import，
// 而且前面已注册的工具会留下**半注册状态**。安装期才发现这类问题代价最高，所以在测试里挡住。

/** 真实 registry 的 `ctx.tools.register` 替身：记录注册与注销，不依赖 Cordis。 */
function makeRegistryContext() {
  const registered = []
  const disposed = []
  let cleanup = null
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition)
        return () => { disposed.push(definition.name) }
      },
    },
    effect(body) {
      cleanup = body()
      return cleanup
    },
  }
  return { ctx, registered, disposed, getCleanup: () => cleanup }
}

/** 递归收集编译后 schema 里的 object 节点（只用于 output.schema 的不变量断言）。 */
function collectObjectNodes(schema, path, out) {
  if (schema === null || typeof schema !== 'object') return
  if (Array.isArray(schema)) {
    schema.forEach((node, index) => collectObjectNodes(node, `${path}[${index}]`, out))
    return
  }
  if (schema.type === 'object') out.push([path, schema])
  if (Array.isArray(schema.oneOf)) {
    schema.oneOf.forEach((node, index) => collectObjectNodes(node, `${path}.oneOf[${index}]`, out))
  }
  if (schema.properties !== undefined) {
    for (const [key, node] of Object.entries(schema.properties)) {
      collectObjectNodes(node, `${path}.properties.${key}`, out)
    }
  }
  if (schema.items !== undefined) collectObjectNodes(schema.items, `${path}.items`, out)
}

test('装配面：index.js 注册期校验（6 个工具全部可注册、schema 可编译、effect 可注销）', async (t) => {
  // 缺少 @deepseek-ai/* 时跳过而不是失败：干净 checkout 上没跑 scripts/link-dsh-deps.mjs
  // 是环境问题，不是代码问题；让它 fail 会训练人忽略红灯。
  const missing = ['@deepseek-ai/dsh-tools', '@deepseek-ai/schemastery'].find((specifier) => {
    try {
      import.meta.resolve(specifier)
      return false
    } catch {
      return true
    }
  })
  if (missing !== undefined) {
    return t.skip(
      `缺少 ${missing}（本地开发请先跑 scripts/link-dsh-deps.mjs 生成 ai4math/node_modules 软链；`
      + '干净 checkout 下本用例跳过）',
    )
  }

  const index = await import(pathToFileURL(join(ROOT, 'index.js')).href)

  assert.equal(index.name, 'dsh-scholia', 'bundle 名必须是 dsh-scholia（SPEC §1.2）')
  assert.deepEqual(index.inject, ['tools'], 'inject 必须是 [\'tools\']（SPEC §7.2）')
  assert.equal(typeof index.apply, 'function', 'index.js 必须导出 apply(ctx, config)')

  const { ctx, registered, disposed, getCleanup } = makeRegistryContext()
  // 注册期 schema 编译发生在这里：任何非法 schema 都会抛，测试随之失败
  index.apply(ctx, { corpusPath: 'corpus.jsonl', cacheDir: 'cache', outputDir: 'out' })

  const EXPECTED = [
    'annotation_check', 'concept_lookup', 'skeleton_extract',
    'annotate_prepare', 'annotate_submit', 'ledger_export',
  ]
  assert.deepEqual(
    registered.map((definition) => definition.name).sort(), [...EXPECTED].sort(),
    'apply 必须注册一期全部 6 个工具，且不多不少（INTERFACES §2.11）。',
  )
  assert.equal(new Set(registered.map((d) => d.name)).size, registered.length, '工具名不得重复。')

  for (const definition of registered) {
    const schema = definition.output?.schema
    assert.ok(
      schema !== null && typeof schema === 'object' && (schema.type !== undefined || schema.oneOf !== undefined),
      `${definition.name}: output.schema 必须是 defineTool 编译后的合法 schema（注册期 DSL 校验通过）。`,
    )
    assert.equal(typeof definition.output.render, 'function', `${definition.name}: 缺少 output.render。`)
    assert.equal(typeof definition.execute, 'function', `${definition.name}: 缺少 execute。`)

    // 编译后每个 object 节点都必须显式声明 additionalProperties：
    // 这正是 `{ type: 'object' }` 在注册期炸掉整个 bundle 的那条不变量。
    const objectNodes = []
    collectObjectNodes(schema, `${definition.name}.output.schema`, objectNodes)
    for (const [path, node] of objectNodes) {
      assert.equal(
        typeof node.additionalProperties, 'boolean',
        `${path} 的 additionalProperties 必须显式为 true/false（value schema DSL 的硬要求）。`,
      )
    }
  }

  // ctx.effect 的所有权：注册必须在 effect 内，且其清理函数能注销全部 6 个（SPEC §7.2）
  const cleanup = getCleanup()
  assert.equal(
    typeof cleanup, 'function',
    'apply 必须把注册包在 ctx.effect 内并返回清理函数，否则改代码后旧注册会残留（SPEC §7.2）。',
  )
  cleanup()
  assert.deepEqual(
    disposed.slice().sort(), [...EXPECTED].sort(),
    'effect 的清理函数必须注销全部 6 个工具，一个不少、一个不多。',
  )
})

