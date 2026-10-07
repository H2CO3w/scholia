/**
 * corpus.mjs — 语料流式读（SPEC §7.1 / ARCHITECTURE §5.1(a)；风险 R2/R5）
 *
 * ★ 硬要求：**不得全量载入内存**。本机 15 GB 内存，语料 332 MB / 310,579 行；
 *   实现用 `node:readline` 逐行 yield，常驻内存与文件大小无关。
 * ★ 支持 `AbortSignal` 取消：取消时抛 `AbortError`，并保证文件句柄被释放（finally 里 close/destroy）。
 *
 * 返回的是**契约原始行**（snake_case，字段同 lsv2.jsonl）。要交给 core/render，
 * 由调用方用 `src/io/contract.mjs` 的 `toCamel` 转换（分层约束 L5）。
 */

import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

import { abortError, assertSignal, throwIfAborted } from './abort.mjs'

/**
 * 逐行流式读语料，产出解析后的记录。
 * 空行跳过；某行不是合法 JSON 时抛错（带行号与修复动作），不静默跳过——
 * 静默跳行会让「查不到」和「语料缺行」混为一谈。
 *
 * @param {string} corpusPath 语料路径（如 `data/lsv2.jsonl`）
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {AsyncGenerator<object>}
 */
export async function* streamRecords(corpusPath, opts = {}) {
  if (typeof corpusPath !== 'string' || corpusPath.trim() === '') {
    throw new TypeError(
      `streamRecords 需要语料文件路径，收到 ${JSON.stringify(corpusPath)}。` +
        '请检查插件 Config 的 corpusPath（如 "data/lsv2.jsonl"）。',
    )
  }
  const signal = opts?.signal
  assertSignal(signal, 'streamRecords')
  throwIfAborted(signal)

  const stream = createReadStream(corpusPath, { encoding: 'utf8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  // 取消时先关掉 readline 再打断底层流：挂在 `next()` 上的迭代会立刻以 done 结束
  // （不依赖 stream.destroy 的错误传播），随后由 catch 里的 throwIfAborted 统一抛 AbortError。
  const onAbort = () => {
    rl.close()
    stream.destroy()
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  let lineNo = 0
  try {
    for await (const line of rl) {
      throwIfAborted(signal)
      lineNo += 1 // 行号含空行，便于人工定位
      if (line.trim() === '') continue
      let record
      try {
        record = JSON.parse(line)
      } catch (err) {
        throw new Error(
          `语料 ${corpusPath} 第 ${lineNo} 行不是合法 JSON（${err.message}）。` +
            '请确认文件已完整下载（lsv2.jsonl 应为 332 MB / 310,579 行），必要时重新获取。',
          { cause: err },
        )
      }
      if (record === null || typeof record !== 'object' || Array.isArray(record)) {
        throw new Error(
          `语料 ${corpusPath} 第 ${lineNo} 行不是 JSON 对象（收到 ${Array.isArray(record) ? 'array' : typeof record}）。` +
            '请确认 corpusPath 指向 lsv2.jsonl 这类「一行一条记录」的语料。',
        )
      }
      yield record
    }
    throwIfAborted(signal)
  } catch (err) {
    if (signal?.aborted) throw abortError(signal)
    if (err?.code === 'ENOENT') {
      const wrapped = new Error(
        `语料文件不存在：${corpusPath}。请检查插件 Config 的 corpusPath，` +
          '或把 data/lsv2.jsonl 放到该路径（332 MB）。',
        { cause: err },
      )
      wrapped.code = 'ENOENT'
      throw wrapped
    }
    throw err
  } finally {
    signal?.removeEventListener('abort', onAbort)
    rl.close()
    stream.destroy()
  }
}

/**
 * 按 `name.join('.')` 精确查找第一条匹配（INTERFACES §2.7）。
 * 找到即停：不会读完整个文件；找不到返回 `null`（调用方必须把它当成「没有」并显式上报）。
 *
 * @param {string} corpusPath
 * @param {string} declName 全限定名，如 `'AbsConvex'`
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<object|null>}
 */
export async function findRecord(corpusPath, declName, opts = {}) {
  if (typeof declName !== 'string' || declName.trim() === '') {
    throw new TypeError(
      `findRecord 需要非空的声明名，收到 ${JSON.stringify(declName)}。` +
        '请传入全限定名（如 "Mathlib.Algebra.Group.Even.add"）。',
    )
  }
  const target = declName.trim()
  for await (const record of streamRecords(corpusPath, opts)) {
    if (Array.isArray(record.name) && record.name.join('.') === target) return record
  }
  return null
}
