/**
 * artifacts.mjs — 产物落盘与读取（SPEC §2.6；INTERFACES §2.9）
 *
 * 目录约定（`<outputDir>` 默认 `out/`）：
 *   out/skeleton/<slug>.json   SkeletonTree
 *   out/ledger/<slug>.json     Ledger
 *   out/render/<slug>.html     静态 HTML（writeRender；内容由 render 负责人生成，本模块只负责路径与落盘）
 *
 * `<slug>` = 全限定名原样保留点号，`/` → `_`（不哈希、不截断，见 SPEC §2.6）。
 *
 * ★ 本模块是**落盘边界**：文件里是 snake_case 契约，内存里是 camelCase（INTERFACES §0.1）。
 *   转换调用 `contract.mjs` 的 toCamel / toSnake——转换实现只有那一份（L5），这里只是使用者。
 * ★ 写入一律「临时文件 + rename」原子替换：读到的产物要么是旧的完整版本，要么是新的完整版本。
 * ★ 契约版本戳（2026-10-07 增补）：写盘时盖 `spec_version = SPEC_VERSION`，读盘时校验——
 *   **缺戳或主版本不符即抛错**。磁盘上的文件不会因为契约升级而失效，但读取方必须自己发现，
 *   否则旧产物里缺失的字段会静默变成假值（例：旧 skeleton 无 `coverage.truncated` →
 *   `truncated` 假报 false、`degraded` 假报 true），产出一份「看起来正常、实际在说谎」的工作单。
 *   读函数**不自动重建**（无副作用；重建还需要 corpusPath）。
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { SPEC_VERSION } from '../core/enums.mjs'
import { throwIfAborted } from './abort.mjs'
import { slugify, toCamel, toSnake } from './contract.mjs'

/**
 * 契约版本（唯一来源 enums.mjs，L4）。io 是落盘边界，所以由它盖戳与验戳：
 * 磁盘上的旧产物不会因为契约升级而自动失效，**读取方必须自己发现**（H1/H5 诚实性）。
 */
const CURRENT_MAJOR = contractMajor(SPEC_VERSION)
if (CURRENT_MAJOR === null) {
  // 否则下面会把「所有产物都判成陈旧」这种全局误伤伪装成正常行为
  throw new Error(
    `src/core/enums.mjs 的 SPEC_VERSION 不是可解析的版本串：${JSON.stringify(SPEC_VERSION)}。` +
      '请把它修成 "主.次.修订" 形式（如 "1.1.0"）。',
  )
}

/** 取版本串的主版本号；无法识别返回 null。 */
function contractMajor(version) {
  if (typeof version !== 'string') return null
  const match = /^\s*(\d+)\.(\d+)(?:\.(\d+))?/.exec(version)
  return match === null ? null : Number(match[1])
}

/** 落盘前盖当前契约版本戳。以写盘方为准：调用方即便带了旧版本号也会被覆盖。 */
function stampSpecVersion(value) {
  const stamped = { ...value }
  stamped.specVersion = SPEC_VERSION
  return stamped
}

/**
 * 读盘后验戳：**缺 spec_version 或主版本不一致 → 抛错**（不自动重建：读函数无副作用，
 * 且重建需要 corpusPath，read 层拿不到）。
 *
 * 为什么是硬错而不是警告：陈旧产物里的字段缺失（如旧 skeleton 没有 `coverage.truncated`）
 * 经过 `=== true` 之类的判断会静默变成假值，产出一份「看起来正常、实际在说谎」的工作单——
 * 而它正是喂给模型生成注解的输入。报错比静默降级诚实（SPEC §7.6）。
 */
function assertReadableContract(parsed, { file, label, staleFix }) {
  const version = parsed?.specVersion
  const major = contractMajor(version)
  if (major === null) {
    throw new Error(
      `${label}缺少可识别的 spec_version（${version === undefined ? '字段不存在' : JSON.stringify(version)}）：${file}。` +
        `这是 v${SPEC_VERSION} 之前写的旧产物，可能缺少 coverage.truncated / truncate_reason 等字段，` +
        '继续消费会得到「看起来正常、实际在说谎」的结果。' +
        `${staleFix}（本函数不会自动重建：读操作无副作用。）`,
    )
  }
  if (major !== CURRENT_MAJOR) {
    throw new Error(
      `${label}的 spec_version=${version} 与当前契约 ${SPEC_VERSION} 主版本不一致：${file}。` +
        '跨主版本的字段语义可能已经变化，不能按当前契约消费。' +
        `${staleFix}`,
    )
  }
  return parsed
}

/** 产物类型 → 子目录与扩展名。 */
const ARTIFACT_KINDS = Object.freeze({
  skeleton: Object.freeze({ dir: 'skeleton', ext: '.json' }),
  ledger: Object.freeze({ dir: 'ledger', ext: '.json' }),
  render: Object.freeze({ dir: 'render', ext: '.html' }),
})

const KIND_LIST = Object.keys(ARTIFACT_KINDS)

function assertOutputDir(outputDir) {
  if (typeof outputDir !== 'string' || outputDir.trim() === '') {
    throw new TypeError(
      `需要 outputDir（产物根目录，如 "out"），收到 ${JSON.stringify(outputDir)}。` +
        '请检查插件 Config 的 outputDir。',
    )
  }
}

/**
 * 产物路径（不创建目录、不检查存在）。
 *
 * @param {string} outputDir 产物根目录，如 `'out'`
 * @param {'skeleton'|'ledger'|'render'} kind
 * @param {string} declName 全限定名
 * @returns {string}
 */
export function artifactPath(outputDir, kind, declName) {
  assertOutputDir(outputDir)
  const entry = ARTIFACT_KINDS[kind]
  if (entry === undefined) {
    throw new TypeError(
      `未知的产物类型 ${JSON.stringify(kind)}。可用值：${KIND_LIST.map((k) => JSON.stringify(k)).join(' / ')}。` +
        '请检查调用处传入的 kind。',
    )
  }
  const slug = slugify(declName)
  const file = join(outputDir, entry.dir, slug + entry.ext)
  // slugify 已把 '/' 换成 '_'，这里再确认一次：产物路径必须落在 outputDir 内，不接受路径穿越
  const root = resolve(outputDir)
  const full = resolve(file)
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error(
      `声明名 ${JSON.stringify(declName)} 生成的产物路径越出了 outputDir（${file}）。` +
        '请检查该名字是否包含路径分隔符。',
    )
  }
  return file
}

/** 原子写文本：临时文件 + rename，避免半个文件被后续读取。 */
let writeSeq = 0
async function writeTextAtomic(file, text) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${(writeSeq += 1)}`
  try {
    await writeFile(tmp, text, 'utf8')
    await rename(tmp, file)
  } catch (err) {
    try {
      await rm(tmp, { force: true })
    } catch {
      /* 清理失败不掩盖原始错误 */
    }
    throw err
  }
  return file
}

/** 原子写 JSON 契约（2 空格缩进 + 末尾换行，人可读）。 */
async function writeJsonAtomic(file, value) {
  return writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`)
}

/** 读 JSON：不存在时按 `missingIsNull` 决定返回 null 还是带修复动作地抛错；读到后验契约版本戳。 */
async function readJson(file, { missingIsNull, label, howToCreate, staleFix, signal }) {
  throwIfAborted(signal)
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (err) {
    if (err?.code === 'ENOENT') {
      if (missingIsNull) return null
      throw new Error(`${label}不存在：${file}。${howToCreate}`, { cause: err })
    }
    throw err
  }
  throwIfAborted(signal)
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new Error(
      `${label}不是合法 JSON：${file}（${err.message}）。` +
        '请重新生成该产物：删除该文件后重跑对应工具。',
      { cause: err },
    )
  }
  const camel = toCamel(parsed)
  // ★ 陈旧产物（契约升级前写的）在这里被拦下，不让它静默流进模型输入
  return assertReadableContract(camel, { file, label, staleFix })
}

function assertSkeletonShape(tree, file) {
  const bad =
    tree === null ||
    typeof tree !== 'object' ||
    Array.isArray(tree) ||
    tree.nodes === null ||
    typeof tree.nodes !== 'object' ||
    Array.isArray(tree.nodes) ||
    tree.coverage === null ||
    typeof tree.coverage !== 'object' ||
    Array.isArray(tree.coverage)
  if (bad) {
    throw new Error(
      `骨架文件不是 SkeletonTree（缺 nodes / coverage）：${file}。` +
        '请重跑 skeleton_extract 重新生成（骨架必须有 coverage，SPEC §2.2）。',
    )
  }
  return tree
}

/**
 * 读骨架树；不存在则抛错（骨架是后续所有步骤的前提，静默返回 null 会让错误推迟到更远的地方）。
 *
 * @param {string} outputDir
 * @param {string} declName
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<object>} camelCase 的 SkeletonTree
 */
export async function readSkeleton(outputDir, declName, opts = {}) {
  const file = artifactPath(outputDir, 'skeleton', declName)
  const tree = await readJson(file, {
    missingIsNull: false,
    label: '骨架文件',
    howToCreate: '请先运行 skeleton_extract 生成它。',
    staleFix: `请重新运行 skeleton_extract(${JSON.stringify(declName)}) 覆盖它。`,
    signal: opts?.signal,
  })
  return assertSkeletonShape(tree, file)
}

/**
 * 写骨架树（自动建目录）；返回写入路径。
 * 写入内容为 snake_case 契约，并**盖当前 `SPEC_VERSION` 戳**（读侧据此拒绝陈旧产物）。
 * 读回的树会带 `specVersion` 字段（骨架本体字段不变，只是多一个版本标记）。
 *
 * @param {string} outputDir
 * @param {string} declName
 * @param {object} skeleton camelCase 的 SkeletonTree
 * @returns {Promise<string>}
 */
export async function writeSkeleton(outputDir, declName, skeleton) {
  const file = artifactPath(outputDir, 'skeleton', declName)
  if (skeleton === null || typeof skeleton !== 'object' || Array.isArray(skeleton)) {
    throw new TypeError(
      `writeSkeleton 需要 SkeletonTree 对象，收到 ${JSON.stringify(skeleton)}。` +
        '请检查调用处是否漏传了骨架（先用 core/skeleton.mjs 的 recordToSkeleton 生成）。',
    )
  }
  return writeJsonAtomic(file, toSnake(stampSpecVersion(skeleton)))
}

/**
 * 读注解账本；不存在返回 `null`（账本是「还没开始写」的正常状态）；
 * 存在但缺 `spec_version` / 主版本不符 → 抛错（陈旧产物不得静默消费）。
 *
 * @param {string} outputDir
 * @param {string} declName
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<object|null>} camelCase 的 Ledger，或 null
 */
export async function readLedger(outputDir, declName, opts = {}) {
  const file = artifactPath(outputDir, 'ledger', declName)
  return readJson(file, {
    missingIsNull: true,
    label: '账本文件',
    howToCreate: '',
    staleFix: `请重新运行 annotate_submit(${JSON.stringify(declName)}, annotations=[…]) 覆盖它。`,
    signal: opts?.signal,
  })
}

/**
 * 写注解账本（自动建目录）；返回写入路径。
 * 写入内容为 snake_case 契约，并**盖当前 `SPEC_VERSION` 戳**（覆盖调用方传入的版本号：
 * 落盘格式由写它的这版代码决定，否则可能写出一个自己读不回来的文件）。
 *
 * @param {string} outputDir
 * @param {string} declName
 * @param {object} ledger camelCase 的 Ledger
 * @returns {Promise<string>}
 */
export async function writeLedger(outputDir, declName, ledger) {
  const file = artifactPath(outputDir, 'ledger', declName)
  if (ledger === null || typeof ledger !== 'object' || Array.isArray(ledger)) {
    throw new TypeError(
      `writeLedger 需要 Ledger 对象，收到 ${JSON.stringify(ledger)}。` +
        '请检查调用处是否漏传账本。',
    )
  }
  return writeJsonAtomic(file, toSnake(stampSpecVersion(ledger)))
}

/**
 * 写渲染产物（HTML，SPEC §2.6：`out/render/<slug>.html`）；返回写入路径。
 *
 * ★ 路径由本层唯一决定（`artifactPath(outputDir, 'render', declName)`）：
 *   工具层不得自己拼目录，否则改目录约定时会漏改（INTERFACES §2.9 增补说明）。
 * ★ 与 writeSkeleton / writeLedger 同一套 tmp + rename 原子写保证：覆盖写时读者只会看到
 *   完整的旧版本或完整的新版本。
 * ★ HTML **不是契约 JSON**，故不做 snake/camel 转换（L5 只管契约字段键）。
 *
 * @param {string} outputDir
 * @param {string} declName
 * @param {string} html 渲染层（`src/render/html.mjs` 的 renderLedgerHtml）返回的完整文档
 * @returns {Promise<string>}
 */
export async function writeRender(outputDir, declName, html) {
  const file = artifactPath(outputDir, 'render', declName)
  if (typeof html !== 'string') {
    throw new TypeError(
      `writeRender 需要 html 字符串，收到 ${html === null ? 'null' : typeof html}。` +
        '请把 src/render/html.mjs 的 renderLedgerHtml(ledger) 返回值原样传入；本函数不做 String() 强转。',
    )
  }
  return writeTextAtomic(file, html)
}
