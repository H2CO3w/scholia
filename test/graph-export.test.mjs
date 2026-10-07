/**
 * graph-export CLI 的两道闸（真跑子进程，不用 mock）：
 *   ① 没给 `--root` 必须在**扫描之前**报错退出，一个文件都不许落盘；
 *   ② 根看起来是一行的纯 import 聚合文件时要警告（但不阻断）。
 *
 * 背景：脚本原先默认 `--root Euler`（顶层聚合文件），于是任何一次无参运行都会
 * 重新生成语义错误的产物——默认值会把错误静默固化，所以改成必需 + 显式警告。
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

const run = promisify(execFile)
const SCRIPT = path.resolve('scripts/graph-export.mjs')

/** 跑 CLI，返回 {code, stdout, stderr}（不抛错，退出码自己看）。 */
async function runCli(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [SCRIPT, ...args], { cwd: path.resolve('.') })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

test('CLI: 没给 --root 必须报错退出，且指路到正确的根', async () => {
  const before = await readdir('out/graph')
  const result = await runCli([])
  assert.notEqual(result.code, 0, '无 --root 必须非零退出')
  assert.match(result.stderr, /必须显式指定 --root/)
  assert.match(result.stderr, /--root Euler\.Solution/)
  assert.match(result.stderr, /--root NavierStokes\.ComparatorSolution/)
  assert.match(result.stderr, /不是正确的根/, '要点明顶层聚合文件为什么不行')
  assert.equal(/at .*graph-export\.mjs/.test(result.stderr), false, '不许把堆栈甩给用户')
  const after = await readdir('out/graph')
  assert.deepEqual(after, before, '失败时一个文件都不许动 out/graph')
})

test('CLI: 根是一行的 import 聚合文件时警告（不阻断）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'a4m-export-'))
  const out = await mkdtemp(path.join(os.tmpdir(), 'a4m-out-'))
  try {
    // 一个最小的 Lean 树：顶层聚合文件只有 import，真正的模块才有声明
    await writeFile(path.join(dir, 'Agg.lean'), 'import Agg.Real\n', 'utf8')
    await mkdir(path.join(dir, 'Agg'), { recursive: true })
    await writeFile(path.join(dir, 'Agg', 'Real.lean'), '/-! 真正的模块说明。 -/\ntheorem foo : True := trivial\n', 'utf8')
    const result = await runCli(['--src', dir, '--root', 'Agg', '--out', out])
    assert.equal(result.code, 0, '警告不阻断：仍然正常退出')
    assert.match(result.stdout, /看起来是\*\*一行的 import 聚合文件\*\*/, '要明确警告可能是错的根')
    assert.match(result.stdout, /--root Euler\.Solution/, '警告里给正确例子')
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(out, { recursive: true, force: true })
  }
})

test('CLI: 正常的根不触发聚合文件警告', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'a4m-export-'))
  const out = await mkdtemp(path.join(os.tmpdir(), 'a4m-out-'))
  try {
    await writeFile(path.join(dir, 'Root.lean'), '/-! 有说明也有声明。 -/\ntheorem bar : True := trivial\n', 'utf8')
    await writeFile(path.join(dir, 'Dep.lean'), 'theorem baz : True := trivial\n', 'utf8')
    const result = await runCli(['--src', dir, '--root', 'Root', '--out', out])
    assert.equal(result.code, 0)
    assert.equal(/聚合文件/.test(result.stdout), false, '正常根不许误报')
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(out, { recursive: true, force: true })
  }
})
