/**
 * lexicon-resolve.mjs — 「哪些 `lexicon_ref` 可解析」的**单一实现**（INTERFACES §2.5b，★ v1.2）
 *
 * 背景：这个判定曾在 `annotation_check` 与 `annotate_submit` 里各写了一份，结果**两次分叉**——
 *   第一次 dry-run 严于 submit，合法的跨批次 `refs` 被误报 V5；
 *   第二次 submit 被 `lexicon_ref: " Totally.Made.Up.Lemma "`（首尾空格）绕过，伪造的引理语义写进了账本。
 * 同一判定有两份实现必然漂移，这与 SPEC §4.1「禁止第二份校验逻辑」是同一条纪律。
 * **两个工具都必须调本函数，禁止各自再写一份。**
 *
 * 判定规则（两条都要）：
 *   1. `ref.trim()` 不在 `lookupLemma(...).missing` 里 —— lookupLemma 内部先 trim 再查、
 *      `missing` 里存的也是 trim 后的名字；若用原始串比对，`" X "` 这种带空格的伪造名就会漏网；
 *   2. 再把 `found` 里的**契约名**放进去，兼容 `_root_.X` / `` `X` `` 这类归一化写法
 *      （第二遍校验时账本里的规范名仍要能解析）。
 *
 * ★ 集合里放的是**原始串**：`core/credential.mjs` 用的是 `lexiconNames.has(seg.lexiconRef)`
 *   原样匹配，所以这里必须放模型实际写的串，而不是归一化后的版本。
 * ★ 索引不可用 → 抛错，**禁止降级成弱化模式**：那会让 SPEC V10 的红线静默失效（R3 编造引理语义）。
 *   构建索引仍由调用方负责（本函数是同步的，签名里也没有 corpusPath）。
 *
 * io 层模块：只做本地查询，不 import DSH 包（L3），不 import node:net / fetch。
 * （注：本行刻意不写出 DSH 包的字面量——源码级静态检查会扫描整个 src/io，注释里的包名也算违规。）
 */

import { lookupLemma } from './index-db.mjs'

/**
 * 返回 `refs` 中**可解析**的原始串集合，供 `validateAnnotations(..., { lexiconNames })` 使用。
 *
 * @param {string} dbPath `cache/lexicon.db`
 * @param {string[]|null|undefined} refs 本批注解里所有概念段的 `lexicon_ref` 原始串（可含重复、可含空格）
 * @returns {Set<string>|null} refs 为空 → `null`（调用方据此跳过查库）
 * @throws {TypeError} refs 不是字符串数组
 * @throws {Error} 索引不可用（消息带修复动作，**不降级**）
 */
export function resolvableLexiconNames(dbPath, refs) {
  if (refs === null || refs === undefined) return null
  if (!Array.isArray(refs)) {
    throw new TypeError(
      `resolvableLexiconNames 的 refs 必须是字符串数组，收到 ${typeof refs}。` +
        '请传入本批所有概念段的 lexicon_ref 原始串；本批没有概念段时传 null 或空数组。',
    )
  }
  if (refs.length === 0) return null
  for (let i = 0; i < refs.length; i += 1) {
    if (typeof refs[i] !== 'string') {
      throw new TypeError(
        `resolvableLexiconNames 的 refs[${i}] 不是字符串（收到 ${typeof refs[i]}）。` +
          '请只传概念段的 lexicon_ref 原始串；缺字段的段应先被过滤掉。',
      )
    }
  }

  let found
  let missing
  try {
    // lookupLemma：先按 trim 后的原样查，再按 normalizeLemmaName 查一次；
    // 两步都不命中才进 missing（存的也是 trim 后的名字）。
    const result = lookupLemma(dbPath, refs)
    found = result.found
    missing = result.missing
  } catch (error) {
    if (error instanceof TypeError) throw error // 入参问题：原样抛，消息里已有修复动作
    throw new Error(
      `无法判定 lexicon_ref 是否可解析：本地词典索引不可用（${dbPath}）：${error.message}。` +
        '修复动作：先构建索引 —— 调用 concept_lookup(rebuild=true)，' +
        '或 ensureLexiconIndex({ corpusPath, dbPath, rebuild: true })。' +
        '不要跳过这一步：没有词典就无法保证「引理语义只来自词典」（SPEC V10 / R3）。',
      { cause: error },
    )
  }

  const missingNames = new Set(missing)
  const resolvable = new Set()
  for (const ref of refs) {
    // ★ 必须先用 trim 后的名字比对：missing 里存的是 trim 后的键，
    //   用原始串比对会让 `" Totally.Made.Up.Lemma "` 漏网（今天出洞的那一格）。
    if (missingNames.has(ref.trim())) continue
    // ★ 放原始串：core 做的是原样 has(seg.lexiconRef)
    resolvable.add(ref)
  }
  // ★ 契约名也放进集合：归一化写法（_root_.X / `X`）解析成功时，
  //   后续用规范名再校验一次（如 annotate_submit 的第二遍）仍能命中。
  for (const row of found) resolvable.add(row.name)
  return resolvable
}
