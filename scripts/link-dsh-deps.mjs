#!/usr/bin/env node
/**
 * link-dsh-deps.mjs — 让工作区里的 dsh-scholia 能解析 `@deepseek-ai/*`
 *
 * 为什么需要这个脚本（ARCHITECTURE §3.5，真机实测）：
 *   pnpm 以 `link:` 把插件装进 profile 时，Node 解析 import 会还原到插件的**真实路径**
 *   （…/default-workspace/ai4math），向上逐级找 node_modules 永远到不了 profile 的
 *   node_modules；而 `@deepseek-ai/dsh-tools` 只存在于 DSH 安装目录。于是
 *   `install_bundle` 报 `failed to import`。本脚本在插件目录下补出这两个包。
 *
 * 幂等：重复运行只会重建同样的链接。
 * 用法：node scripts/link-dsh-deps.mjs [--check]
 *   --check  只报告状态，不写文件；缺失时以退出码 1 结束（可用于 CI / 安装前自检）
 */

import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

/** 需要链接进插件目录的包（导入它们的地方见 src/tools/**、index.js） */
const NEEDED = ['dsh-tools', 'schemastery']

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TARGET_DIR = join(PKG_ROOT, 'node_modules', '@deepseek-ai')

/**
 * 发现 DSH 安装目录下的 node_modules。
 * 依次尝试：
 *   1) 环境变量 DSH_INSTALL_NODE_MODULES（显式覆盖）
 *   2) `dsh` 可执行文件的真实路径 → 其同级/上级 node_modules
 *   3) 本机常见全局安装位置（nvm / 系统 node）
 * 找不到就报错退出，不猜一个不存在的路径。
 */
function discoverDshNodeModules() {
  const tried = []

  const explicit = process.env.DSH_INSTALL_NODE_MODULES
  if (explicit) {
    tried.push(explicit)
    if (existsSync(join(explicit, '@deepseek-ai', 'dsh-tools'))) return explicit
  }

  // `which dsh` → realpath → <prefix>/lib/node_modules/@deepseek-ai/dsh/node_modules
  try {
    const bin = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['dsh'], {
      encoding: 'utf8',
    }).trim().split('\n')[0].trim()
    if (bin) {
      const real = execFileSync('node', ['-e', `console.log(require('fs').realpathSync(${JSON.stringify(bin)}))`], {
        encoding: 'utf8',
      }).trim()
      // <prefix>/bin/dsh  →  <prefix>/lib/node_modules/@deepseek-ai/dsh/node_modules
      const prefix = resolve(dirname(real), '..')
      for (const candidate of [
        join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'),
        join(prefix, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'),
      ]) {
        tried.push(candidate)
        if (existsSync(join(candidate, '@deepseek-ai', 'dsh-tools'))) return candidate
      }
    }
  } catch {
    // `dsh` 不在 PATH 上，继续尝试其它位置
  }

  // 常见全局安装位置
  const execDir = dirname(process.execPath)
  for (const candidate of [
    join(execDir, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'),
    join(execDir, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'),
  ]) {
    tried.push(candidate)
    if (existsSync(join(candidate, '@deepseek-ai', 'dsh-tools'))) return candidate
  }

  throw new Error(
    '找不到 DSH 安装目录下的 node_modules（需要其中含 @deepseek-ai/dsh-tools）。\n'
    + '已尝试：\n  ' + tried.join('\n  ')
    + '\n请显式指定：DSH_INSTALL_NODE_MODULES=<…/@deepseek-ai/dsh/node_modules> node scripts/link-dsh-deps.mjs',
  )
}

function linkState(linkPath) {
  try {
    const st = lstatSync(linkPath)
    if (st.isSymbolicLink()) return 'symlink'
    return 'other'
  } catch {
    return 'missing'
  }
}

const checkOnly = process.argv.includes('--check')

let source
try {
  source = discoverDshNodeModules()
} catch (err) {
  console.error(`[link-dsh-deps] ${err.message}`)
  process.exit(2)
}

console.log(`[link-dsh-deps] DSH 包来源: ${source}`)
console.log(`[link-dsh-deps] 目标目录   : ${TARGET_DIR}`)

if (!checkOnly) mkdirSync(TARGET_DIR, { recursive: true })

let missing = 0
for (const name of NEEDED) {
  const from = join(source, '@deepseek-ai', name)
  const to = join(TARGET_DIR, name)

  if (!existsSync(from)) {
    console.error(`[link-dsh-deps] ✗ 源包不存在: ${from}`)
    missing += 1
    continue
  }

  const state = linkState(to)
  if (checkOnly) {
    console.log(`[link-dsh-deps] ${state === 'symlink' ? '✓' : '✗'} ${name}: ${state}`)
    if (state !== 'symlink') missing += 1
    continue
  }

  if (state !== 'missing') rmSync(to, { recursive: true, force: true })
  symlinkSync(from, to, 'dir')
  console.log(`[link-dsh-deps] ✓ 链接 ${name} → ${from}`)
}

if (missing > 0) {
  console.error(`[link-dsh-deps] 有 ${missing} 项缺失；插件将无法 import @deepseek-ai/*`)
  process.exit(1)
}
console.log(`[link-dsh-deps] 完成${checkOnly ? '（check 模式，未改动）' : ''}`)
