/**
 * annotation-check.mjs — 工具 `annotation_check`（SPEC §6.1 / §4.1，INTERFACES §2.11）
 *
 * 职责：把一批**契约形态（snake_case）**的注解读入 -> 转成 core 的 camelCase -> 连同该定理
 * **账本里已提交的注解**一起交给 `core/credential.mjs` 的 `validateAnnotations`（V1–V16 唯一实现）
 * -> 只把**本批**的诊断回给模型。
 *
 * ★ dry-run 必须与真提交同判（修复：跨批次引用被误报 V5）
 *   `annotate_submit` 校验的是「账本已有 + 本批」的合并集合，所以 `refs: ["c1"]` 指向先前
 *   批次已提交的注解时，提交是通过的。`annotation_check` 若只校验本批，就会对同一份输入报
 *   `V5_REF_UNKNOWN`——用户会去修一个不存在的问题，或删掉一条合法引用。这里用「合并校验、
 *   按批过滤报告」做到同判：`ok/total/passed/failed/diagnostics` 只讲本批。
 *
 * ★ V10 的解析性检查必须接线，否则红线是空的（修复）
 *   概念段的 `lexicon_ref` 只有传入 `lexiconNames` 才会检查「能否在词典里解析到」；
 *   不传就退化成只查非空（core 里的弱化模式）。所以本工具只解析**本批实际用到**的 ref
 *   （不把 310,579 条词典塞进去），本批没有 concept 段就传 null 省掉一次查库；
 *   **词典不可用时直接报错，绝不静默降级成弱化模式**——那会让「引理语义只来自词典」形同虚设。
 *
 * ★「哪些 ref 可解析」的判定**不在本文件**（INTERFACES §2.5b，v1.2）
 *   该判定曾在 annotation_check 与 annotate_submit 各写一份，结果两次分叉（dry-run 误报 V5；
 *   submit 被首尾空格的伪造 ref 绕过）。现在统一走 `io/lexicon-resolve.mjs` 的
 *   `resolvableLexiconNames(dbPath, refs)`，单一实现。本工具只做两件事：
 *   收集本批概念段的原始 ref（纯收集，无判定）、确保索引存在并把「建索引失败」翻译成带修复动作的错误。
 *
 * 不写注解产物（账本由 annotate_submit 写）；首次调用可能顺带构建本地词典索引缓存。
 *
 * 工具定义遵循 SPEC §6.2：
 *   T1 输出有界（诊断条数超 maxDiagnostics 时截断，并给出总数与下一步动作）
 *   T3 参数规则写在该参数的 description 里
 *   T4 工具描述只讲行为与返回
 *   T6 只读工具声明 isConcurrencySafe
 *   T8 错误消息带修复动作
 */

import path from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'

import { validateAnnotations } from '../core/credential.mjs'
import { SEGMENT_KIND } from '../core/enums.mjs'
import { readLedger, readSkeleton } from '../io/artifacts.mjs'
import { toCamel, toSnake } from '../io/contract.mjs'
import { ensureLexiconIndex } from '../io/index-db.mjs'
import { resolvableLexiconNames } from '../io/lexicon-resolve.mjs'

/** 词典索引文件名（SPEC §2.6：cache/lexicon.db） */
const INDEX_FILENAME = 'lexicon.db'

/** Config 被裁剪/未校验时的兜底（正常路径由 Config 默认值 50 提供） */
const DEFAULT_MAX_DIAGNOSTICS = 50

/**
 * 读取骨架产物；失败时抛出**带修复动作**的错误（SPEC T8）。
 * @param {string} outputDir
 * @param {string} theoremName
 * @param {AbortSignal} signal
 */
async function loadSkeleton(outputDir, theoremName, signal) {
  try {
    return await readSkeleton(outputDir, theoremName, { signal })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(
      `读不到 "${theoremName}" 的骨架产物（输出目录 ${outputDir}）：${reason}。`
      + `修复动作：先调用 skeleton_extract(theorem_name="${theoremName}") 生成骨架；`
      + '若骨架已生成在别处，请把 Config.outputDir 改到该目录后重试。',
    )
  }
}

/**
 * 账本里已提交的注解（camelCase，与 core 的形状一致）；账本不存在时是空数组。
 *
 * `readLedger` 的契约（INTERFACES §2.9）：文件不存在返回 null；
 * **存在但缺 spec_version / 主版本不符 → 抛错**（陈旧产物防护）。后者**必须原样带出去**，
 * 不许吞掉——吞掉会让校验基于一份来路不明的旧账本给出结论。
 *
 * @param {string} outputDir
 * @param {string} theoremName
 * @param {AbortSignal} signal
 * @returns {Promise<object[]>}
 */
async function loadLedgerAnnotations(outputDir, theoremName, signal) {
  const ledger = await readLedger(outputDir, theoremName, { signal })
  return Array.isArray(ledger?.annotations) ? ledger.annotations : []
}

/**
 * 本批概念段用到的 `lexicon_ref` **原始串**（含空格、含 `_root_.` 等写法；只做完全相同去重）。
 * 这里**不做任何可解析性判定**——判定归 `io/lexicon-resolve.mjs` 的单一实现。
 * @param {object[]} annotations - camelCase 注解
 * @returns {string[]}
 */
function conceptRefsOf(annotations) {
  const refs = new Set()
  for (const ann of annotations) {
    const segments = Array.isArray(ann?.segments) ? ann.segments : []
    for (const seg of segments) {
      if (seg?.kind !== SEGMENT_KIND.CONCEPT) continue
      if (typeof seg.lexiconRef !== 'string') continue
      refs.add(seg.lexiconRef)
    }
  }
  return [...refs]
}

/**
 * 把本批 ref 解析成「可命中集合」，交给 core 的 V10 解析性检查。
 *
 * 本函数只负责**编排与错误翻译**：确保索引存在（必要时构建），再调共享判定
 * `resolvableLexiconNames`（INTERFACES §2.5b）。判定本身、以及"索引不可读"的处理都在那边，
 * 本文件不再保留第二份。
 *
 * 返回语义：`null` = 本批没有 concept 段（跳过查库）；`Set`（可空）= 可命中的原始串；
 * 抛错 = 词典不可用，**不降级**（静默降级会让 V10 红线失效，SPEC R3）。
 *
 * @param {string[]} refs - `conceptRefsOf` 的结果
 * @param {object} config
 * @param {AbortSignal} signal
 * @returns {Promise<Set<string>|null>}
 */
async function resolveLexiconNames(refs, config, signal) {
  if (refs.length === 0) return null // 空 refs 不建索引（空 → null 的判定同样在共享模块里）
  const dbPath = path.join(config.cacheDir, INDEX_FILENAME)
  try {
    await ensureLexiconIndex({ corpusPath: config.corpusPath, dbPath, signal })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(
      `无法校验 lexicon_ref 的解析性：本地词典索引不可用（语料 ${config.corpusPath}，索引 ${dbPath}）：${reason}。`
      + '修复动作：确认 Config.corpusPath 指向存在的 data/lsv2.jsonl、Config.cacheDir 可写，然后重试。'
      + '不要跳过这一步——没有词典就无法保证「引理语义只来自词典」（SPEC V10 / R3）。',
    )
  }
  // 判定与它自己的错误处理都在 io/lexicon-resolve.mjs（单一实现），这里原样传递。
  return resolvableLexiconNames(dbPath, refs)
}

/**
 * 注册 `annotation_check`。
 * @param {object} ctx - Cordis 上下文，需已注入 `tools`
 * @param {object} config - 见 index.js 的 Config
 * @returns {() => void} 注销函数（由 index.js 的 ctx.effect 统一持有）
 */
export function registerAnnotationCheck(ctx, config) {
  return ctx.tools.register(defineTool({
    name: 'annotation_check',
    description:
      '按规范 V1–V16 逐条校验一批注解，返回通过/失败统计与每条问题的字段定位、规则码和修复动作。'
      + '校验会连同该定理账本里已提交的注解一起判（所以 refs 指向先前批次的注解不算悬空），'
      + '但报告只讲本批。不写注解产物；诊断条数超过上限时只返回前若干条，总数在 diagnostics_total。',
    parameters: {
      theorem_name: {
        type: 'string',
        required: true,
        description:
          '全限定 Lean 声明名，如 "Mathlib.Algebra.Group.Even.add"；'
          + '精确匹配，不含空格。该定理的骨架必须已经存在，否则先调用 skeleton_extract。',
      },
      annotations: {
        type: 'array',
        required: true,
        items: { type: 'object', additionalProperties: true },
        description:
          '待校验的注解数组，字段用契约 snake_case（role / value_type / culture / height / evidence / '
          + 'significance / presentation / audience / segments / anchors / refs / provenance）。'
          + '一次传多条比逐条传更省调用；返回的 diagnostics[].index 就是本数组的下标。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true, description: '本批是否全部通过（failed=0 时为 true）' },
          total: { type: 'integer', required: true, description: '本批注解条数' },
          passed: { type: 'integer', required: true, description: '本批通过的注解条数' },
          failed: { type: 'integer', required: true, description: '本批被拒的注解条数' },
          diagnostics_total: { type: 'integer', required: true, description: '本批全部诊断条数（截断前）' },
          truncated: { type: 'boolean', required: true, description: '诊断被截断时为 true' },
          diagnostics: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: true,
              description: '一条诊断：index / annotation_id / rule / code / field / message（message 自带修复动作）',
            },
          },
          duplicates: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: true,
              description:
                '同一 (node, role) 重复提交的条目：重复项会覆盖先提交的那条。'
                + '覆盖的是账本里已提交的条目时，给出 overwrites_ledger_annotation_id',
            },
          },
          hint: {
            type: 'string',
            description: '诊断被截断时给出的下一步动作；未截断时该键不出现',
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    // 只读校验可并行：校验本身无副作用，词典索引构建走临时文件 + rename（原子），并发安全（SPEC T6）
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const skeleton = await loadSkeleton(config.outputDir, args.theorem_name, exec.signal)
      const batch = toCamel(args.annotations)
      const ledgerAnnotations = await loadLedgerAnnotations(config.outputDir, args.theorem_name, exec.signal)
      const lexiconNames = await resolveLexiconNames(conceptRefsOf(batch), config, exec.signal)

      // 与 annotate_submit 同判：校验「账本已有 + 本批」的合并集合（V5 的已知 id 因此包含旧批次），
      // 再把报告按 index 裁到本批——offset 之后才是本批。
      const merged = [...ledgerAnnotations, ...batch]
      const offset = ledgerAnnotations.length
      const report = validateAnnotations(merged, skeleton, { lexiconNames })

      const diagnostics = report.diagnostics
        .filter((diag) => diag.index >= offset)
        .map((diag) => ({ ...diag, index: diag.index - offset }))

      const duplicates = (report.duplicates ?? [])
        .filter((dup) => dup.index >= offset)
        .map((dup) => {
          const batchIndex = dup.overwritesIndex >= offset ? dup.overwritesIndex - offset : null
          return {
            ...dup,
            index: dup.index - offset,
            overwritesIndex: batchIndex,
            overwritesLedgerAnnotationId: batchIndex === null
              ? (ledgerAnnotations[dup.overwritesIndex]?.id ?? null)
              : null,
          }
        })

      const failed = report.perAnnotation.slice(offset).filter((entry) => !entry.ok).length
      const maxDiagnostics = Number.isInteger(config.maxDiagnostics) && config.maxDiagnostics > 0
        ? config.maxDiagnostics
        : DEFAULT_MAX_DIAGNOSTICS
      const diagnosticsTotal = diagnostics.length
      const truncated = diagnosticsTotal > maxDiagnostics

      const result = {
        ok: failed === 0,
        total: batch.length,
        passed: batch.length - failed,
        failed,
        diagnosticsTotal,
        truncated,
        diagnostics: truncated ? diagnostics.slice(0, maxDiagnostics) : diagnostics,
        duplicates,
      }
      // T1：截断时不给路径（本工具不写盘），但必须给出"怎么拿到完整结果"的动作，
      // 否则模型会以为问题只有返回的这几条。
      if (truncated) {
        result.hint =
          `诊断已截断：本批共 ${diagnosticsTotal} 条，这里只返回了前 ${result.diagnostics.length} 条。`
          + '把 annotations 拆成更小的批次（例如每次 5 条）重新调用，即可拿到全部诊断。'
      }
      return toSnake(result)
    },
  }))
}
