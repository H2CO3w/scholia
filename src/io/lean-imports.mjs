/**
 * lean-imports.mjs — 扫描 Lean 源码树，抽出**模块级依赖图**（INTERFACES 附录 G.2，v1.4）
 *
 * 为什么是 import 而不是证明体：`import` 是**显式且完整**的，而 lsv2 语料里的证明体被砍在
 * 500 字符（平均出度 2.02，CHSH 的依赖锥只有 3 个节点）。要画「完整证明」，只有真实源码可用。
 *
 * 口径（附录 G.2 冻结）：
 *   - 模块名 = 相对 `rootDir` 的路径去掉 `.lean`、`/` 换成 `.`
 *     （`.probe-nse/Euler/BaseEulerParity.lean` → `Euler.BaseEulerParity`）
 *   - `import X.Y.Z` 且 `X.Y.Z` 在本树内 → `external: false`；否则 `external: true`
 *   - **只读**：不写、不改源码树
 *   - 输出确定：`modules` 与 `edges` 都排序（同输入必得同输出，SPEC §7.5）
 *
 * 实现要点（都是真实源码树上会踩到的）：
 *   - **先屏蔽注释与字符串再找 import**：被注释掉的 `import Foo` 是幻影边，
 *     而 `import Foo -- 说明` 的行尾注释不能被当成模块名。Lean 的块注释**可嵌套、可跨行**
 *     （跨行状态在行间传递），字符串不跨行。屏蔽按**行**做，避免隐式持有整份源码。
 *   - 支持 `public import X`（Lean 4.10+）与一行多个模块 `import A B`；
 *     `import all X` 里的 `all` 是关键字，不作为模块名。
 *   - 跳过 `.lake/`、`build/`、`node_modules/` 与所有点目录（`.git` 等）；
 *     不跟随符号链接目录（防环）。
 *   - 同一文件里对同一模块重复 import 只算一条边（图不建重边）；**自己 import 自己**如实保留。
 *
 * io 层模块：允许 `node:fs`；不 import DSH 包（L3）、不联网。
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

import { assertSignal, throwIfAborted } from './abort.mjs'

/** 一律跳过的目录名：lake 的依赖/构建目录、npm；点目录单独按前缀跳过。 */
const SKIP_DIR_NAMES = new Set(['.lake', 'build', 'node_modules'])

/** `import X.Y.Z` / `public import X.Y.Z`（用于匹配**已屏蔽**的行）。 */
const IMPORT_LINE_RE = /^\s*(?:public\s+)?import\s+(.*)$/

/** 快路径：这一行**可能**含 import 的粗筛（在原始行上跑，不构造屏蔽串）。 */
const MAYBE_IMPORT_RE = /^\s*(?:public\s+)?import\s/

/** 目录是否跳过。 */
function shouldSkipDir(name) {
  return name.startsWith('.') || SKIP_DIR_NAMES.has(name)
}

/**
 * 屏蔽**一行**里的注释与字符串（替换成等长空格），返回屏蔽后的行。
 * `state.depth` 在行间传递：Lean 的块注释 `/- … -/` 可嵌套、可跨行；
 * 行注释 `-- …` 到行尾；字符串字面量不跨行，故不需要跨行状态。
 *
 * ★ 这里刻意**按行**而不是按整文件屏蔽：整文件屏蔽会让 `split` 出来的模块名变成
 *   V8 的 sliced string，从而隐式持有整份源码（实测 GC 后仍留 ~64 MB）。按行屏蔽后，
 *   每个 token 至多持有它那一行，持有量与树大小无关。
 */
function maskLine(line, state) {
  let out = ''
  let plain = 0 // 尚未拷贝的普通代码起点
  let i = 0
  const mask = (from, to) => {
    out += line.slice(plain, from) + ' '.repeat(to - from)
    plain = to
  }
  while (i < line.length) {
    // 仍在上一行开始的块注释里：找到它在这一行结束的位置
    if (state.depth > 0) {
      const start = i
      while (i < line.length && state.depth > 0) {
        if (line[i] === '/' && line[i + 1] === '-') {
          state.depth += 1
          i += 2
        } else if (line[i] === '-' && line[i + 1] === '/') {
          state.depth -= 1
          i += 2
        } else {
          i += 1
        }
      }
      mask(start, i)
      continue
    }
    const c = line[i]
    // 块注释起点（可嵌套、可能跨行）
    if (c === '/' && line[i + 1] === '-') {
      const start = i
      let depth = 1
      i += 2
      while (i < line.length && depth > 0) {
        if (line[i] === '/' && line[i + 1] === '-') {
          depth += 1
          i += 2
        } else if (line[i] === '-' && line[i + 1] === '/') {
          depth -= 1
          i += 2
        } else {
          i += 1
        }
      }
      if (depth > 0) state.depth = depth // 本行未闭合，交给下一行
      mask(start, i)
      continue
    }
    // 行注释 `-- …` 到行尾
    if (c === '-' && line[i + 1] === '-') {
      mask(i, line.length)
      i = line.length
      continue
    }
    // 字符串字面量（不跨行；`\"` 转义）
    if (c === '"') {
      const start = i
      i += 1
      while (i < line.length) {
        if (line[i] === '\\') {
          i += 2
          continue
        }
        if (line[i] === '"') {
          i += 1
          break
        }
        i += 1
      }
      mask(start, i)
      continue
    }
    i += 1
  }
  out += line.slice(plain)
  return out
}

/** 从源码里抽出 import 目标，按出现顺序；可能重复，由调用方去重。 */
function importTargetsOf(source) {
  const targets = []
  const state = { depth: 0 }
  for (const line of source.split('\n')) {
    // 快路径：只有**可能含 import** 或**可能改变块注释状态**（`/-` / `-/`）的行才需要屏蔽。
    // 整棵树里 99% 的行（普通证明代码）直接跳过，连屏蔽串都不构造。
    // ★ 两者缺一不可：漏掉「开启块注释」的行，后面的 `import` 就会被当成真 import（幻影边）。
    if (state.depth === 0 && !MAYBE_IMPORT_RE.test(line) && !line.includes('/-') && !line.includes('-/')) {
      continue
    }
    const match = IMPORT_LINE_RE.exec(maskLine(line, state))
    if (match === null) continue
    const tokens = match[1].trim().split(/\s+/).filter((token) => token !== '')
    // `import all Foo`：`all` 是关键字（Lean 4.9+），不是模块名
    if (tokens.length > 0 && tokens[0] === 'all') tokens.shift()
    for (const token of tokens) targets.push(token)
  }
  return targets
}

/** 路径 → 模块名（附录 G.2：相对 rootDir、去 `.lean`、`/` 换 `.`）。 */
function moduleNameOf(rootDir, file) {
  const rel = relative(rootDir, file).split(sep).join('/')
  return rel.replace(/\.lean$/, '').replaceAll('/', '.')
}

/**
 * 取文件里**第一个** `/-! … -/` 块的内容（模块说明），折叠成单行。
 *
 * 实测形态：该块在 import 块之后、第一条命令之前，例如
 * ```lean
 * import Euler.PacketTailLinearBounds
 *
 * /-! Each surviving grade of the literal packet residual has a fixed-radius estimate. -/
 * ```
 * 所以「文件头」在这份语料里等于「第一个 `/-!` 块」（实测 Euler/ 1838/1839 命中）。
 *
 * 规则：
 *   - 折叠：块内换行与连续空白 → 单空格，首尾去空白（多行说明变一行）；
 *   - Markdown 标题（`# …`）**原样保留**，渲染层决定怎么处理；
 *   - 嵌套注释正确配对（`/-! 外层 /- 内层 -/ 仍在 -/` 不会截断在内部的 `-/`）；
 *   - 只有**顶层**的 `/-!` 才算（别的注释里嵌的 `/-!` 只是文本）；
 *   - 结果里不会残留 `-/` 或 `/-!`。
 *
 * @param {string} source
 * @returns {string|null} 没有 `/-!` 块 → `null`（调用方据此**缺省键**，而不是写空串）；
 *                        块存在但内容为空 → `''`（"没说明"与"说明是空的"要能区分）
 */
function headDocstringOf(source) {
  let i = 0
  let depth = 0 // 块注释嵌套深度
  let captureFrom = -1 // 正在捕获的 `/-!` 内容起点
  while (i < source.length) {
    if (depth > 0) {
      if (source[i] === '/' && source[i + 1] === '-') {
        depth += 1
        i += 2
        continue
      }
      if (source[i] === '-' && source[i + 1] === '/') {
        depth -= 1
        i += 2
        if (depth === 0 && captureFrom >= 0) {
          return source.slice(captureFrom, i - 2).replace(/\s+/g, ' ').trim()
        }
        continue
      }
      i += 1
      continue
    }
    if (source[i] === '/' && source[i + 1] === '-') {
      const isDoc = source[i + 2] === '!'
      if (isDoc) captureFrom = i + 3
      depth = 1
      i += isDoc ? 3 : 2
      continue
    }
    // 行注释 `-- …` 到行尾
    if (source[i] === '-' && source[i + 1] === '-') {
      const nl = source.indexOf('\n', i)
      i = nl === -1 ? source.length : nl
      continue
    }
    // 字符串字面量（不跨行）：里面的 `/-` 不是注释
    if (source[i] === '"') {
      i += 1
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2
          continue
        }
        if (source[i] === '"') {
          i += 1
          break
        }
        if (source[i] === '\n') break
        i += 1
      }
      continue
    }
    i += 1
  }
  return null
}

/** 深度优先收集 `.lean` 文件（迭代实现，不受目录深度限制）。 */
async function collectLeanFiles(rootDir, signal) {
  const files = []
  const stack = [rootDir]
  while (stack.length > 0) {
    throwIfAborted(signal)
    const dir = stack.pop()
    const entries = await readdir(dir, { withFileTypes: true })
    const subdirs = []
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!shouldSkipDir(entry.name)) subdirs.push(join(dir, entry.name))
      } else if (entry.isFile() && entry.name.endsWith('.lean')) {
        files.push(join(dir, entry.name))
      }
      // 符号链接一律不跟随：链接目录可能成环，链接文件在 find 口径下也不保证存在
    }
    subdirs.sort()
    for (let i = subdirs.length - 1; i >= 0; i -= 1) stack.push(subdirs[i])
  }
  return files
}

/**
 * 扫描 Lean 源码树，产出模块级依赖图。
 *
 * @param {string} rootDir 源码树根目录（模块名的基准），如 `ai4math/.probe-nse`
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{
 *   modules: string[],
 *   edges: { from: string, to: string, external: boolean }[],
 *   stats: { fileCount: number, internalEdges: number, externalEdges: number },
 *   docstrings: Record<string, string>,
 * }>}  `docstrings`：模块名 → 该文件第一个 `/-! … -/` 说明（空白已折叠成单空格）；
 *      没有说明的模块**键缺省**（不写空串），块存在但为空则是 `''`
 */
export async function scanLeanImports(rootDir, opts = {}) {
  if (typeof rootDir !== 'string' || rootDir.trim() === '') {
    throw new TypeError(
      `scanLeanImports 需要源码树根目录，收到 ${JSON.stringify(rootDir)}。` +
        '请传入 Lean 仓库根目录（例如 "ai4math/.probe-nse"）。',
    )
  }
  const signal = opts?.signal
  assertSignal(signal, 'scanLeanImports')
  throwIfAborted(signal)

  let info
  try {
    info = await stat(rootDir)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const wrapped = new Error(
        `Lean 源码树不存在：${rootDir}。请检查路径是否拼错，或该目录是否已被清理。`,
        { cause: error },
      )
      wrapped.code = 'ENOENT'
      throw wrapped
    }
    throw error
  }
  if (!info.isDirectory()) {
    throw new Error(
      `${rootDir} 不是目录（模块名以它为基准，必须是源码树根）。` +
        '请把 rootDir 指向仓库根目录，而不是某个 .lean 文件。',
    )
  }

  const files = await collectLeanFiles(rootDir, signal)
  throwIfAborted(signal)

  const modules = [...new Set(files.map((file) => moduleNameOf(rootDir, file)))].sort()
  const moduleSet = new Set(modules)

  const edgeKeys = new Set()
  const edges = []
  const docByModule = new Map() // 只有**有** `/-!` 块的模块才进这张表
  let internalEdges = 0
  let externalEdges = 0
  for (const file of files) {
    throwIfAborted(signal)
    const from = moduleNameOf(rootDir, file)
    const source = await readFile(file, 'utf8')
    const docstring = headDocstringOf(source)
    if (docstring !== null) docByModule.set(from, docstring)
    for (const to of importTargetsOf(source)) {
      const key = `${from}\u0000${to}`
      if (edgeKeys.has(key)) continue // 同一文件重复 import 同一模块只算一条边
      edgeKeys.add(key)
      const external = !moduleSet.has(to)
      if (external) externalEdges += 1
      else internalEdges += 1
      edges.push({ from, to, external })
    }
  }
  throwIfAborted(signal)

  edges.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0))

  // 按 modules 的（排序）顺序装配，保证 docstrings 的键序也是确定的
  const docstrings = {}
  for (const name of modules) {
    const docstring = docByModule.get(name)
    if (docstring !== undefined) docstrings[name] = docstring
  }

  return {
    modules,
    edges,
    stats: { fileCount: files.length, internalEdges, externalEdges },
    docstrings,
  }
}
