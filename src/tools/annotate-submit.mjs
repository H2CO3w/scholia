/**
 * annotate-submit.mjs — `annotate_submit`：校验 + 合并进 Ledger + 写盘
 *
 * 依据：SPEC §2.5（Ledger）、§4（V1–V16）、§4.1（逐条返回 + 修复动作）、§6.2（T1/T2/T8）、§7.6（H2/H3）。
 * 生成流程见 ARCHITECTURE §5.1(c)：prepare → agent 生成 → submit →（被拒则重写后再 submit）。
 *
 * ★ 校验**只复用** src/core/credential.mjs 的 `validateAnnotations`（含 V16 的批内重复检测）
 *   与 `computeMetrics`，本文件不写第二份规则实现。
 *   （SPEC §4.1：「V1–V16 全部实现在 core/credential.mjs，由 annotation_check 与 annotate_submit 共用同一个实例」。）
 *
 * ★ V16 的**覆盖**语义由本工具落实：同一 `(node, role)` 重复提交 ⇒ 覆盖旧条目并报告，不是报错。
 *
 * 关键设计：
 *   - 校验对象是「合并后」的完整注解集（既有账本中未被覆盖的条目 + 本次提交），
 *     这样跨批次的 `refs` 引用（V5）才能正确解析；诊断索引再映射回提交下标。
 *   - 任一条提交不通过 ⇒ **整体不写盘**（`written: false`），避免半份账本。
 *   - 工具输出是 snake_case（SPEC §1.1），转换只发生在 io/contract.mjs（L5）。
 */

import path from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'

import { RULE, computeMetrics, validateAnnotations } from '../core/credential.mjs'
import { MATHLIB_BASELINE, SEGMENT_KIND, SPEC_VERSION } from '../core/enums.mjs'
import { readLedger, readSkeleton, writeLedger } from '../io/artifacts.mjs'
import { toCamel, toSnake } from '../io/contract.mjs'
import { ensureLexiconIndex } from '../io/index-db.mjs'
import { resolvableLexiconNames } from '../io/lexicon-resolve.mjs'

const DEFAULT_MAX_DIAGNOSTICS = 50

/** 参数/环境错误：消息必须带修复动作（T8）。 */
function fail(message) {
  throw new Error(message)
}

/** V16 的覆盖键：`(node, role)`。 */
function overwriteKey(annotation) {
  const node = annotation?.node
  const role = annotation?.role
  if (typeof node !== 'string' || node === '' || typeof role !== 'string' || role === '') return null
  return `${node}\u0000${role}`
}

/** 现有账本里的注解（readLedger 按 §2.9 返回 camelCase）。 */
function existingAnnotations(ledger) {
  return Array.isArray(ledger?.annotations) ? ledger.annotations.filter((a) => a && typeof a === 'object') : []
}

/**
 * 收集 concept 段的 `lexicon_ref`（保留模型实际写的**原始串**，去重）。
 *
 * 这里只做「抽出字符串」，**不做任何可解析性判定**——那件事的唯一实现是
 * `src/io/lexicon-resolve.mjs` 的 `resolvableLexiconNames`（INTERFACES §2.5b）。
 * 之前本工具自己实现过一份，与 `annotation_check` 分叉了两次（dry-run 误报 V5、
 * 首尾空格绕过 V10），所以现在判定只允许有一个来源。
 *
 * @param {object[]} annotations
 * @returns {string[]}
 */
function conceptLexiconRefs(annotations) {
  const refs = []
  for (const annotation of annotations) {
    for (const segment of Array.isArray(annotation?.segments) ? annotation.segments : []) {
      const ref = segment?.kind === SEGMENT_KIND.CONCEPT ? segment.lexiconRef : null
      if (typeof ref === 'string' && ref.trim() !== '' && !refs.includes(ref)) refs.push(ref)
    }
  }
  return refs
}

/**
 * 解析出 V10 需要的「词典中可命中」名字集合；词典不可用时**直接失败**，
 * 绝不静默退化成「只检查非空」的弱化模式（那等于红线没接线）。
 *
 * 判定本身调用 io 层的唯一实现；本函数只负责查库前置与错误包装（T8 修复动作）。
 *
 * @param {object} config
 * @param {object[]} annotations 将参与校验的注解
 * @param {AbortSignal|undefined} signal
 * @returns {Promise<{names: Set<string>|null, checked: number}>}
 */
async function resolveLexiconNames(config, annotations, signal) {
  const refs = conceptLexiconRefs(annotations)
  if (refs.length === 0) return { names: null, checked: 0 } // 本批无 concept 段：不查库

  const dbPath = path.join(config.cacheDir, 'lexicon.db')
  try {
    await ensureLexiconIndex({ corpusPath: config.corpusPath, dbPath, signal })
    return { names: resolvableLexiconNames(dbPath, refs), checked: refs.length }
  } catch (error) {
    fail(
      `无法校验 lexicon_ref 的解析性（词典索引不可用：${error instanceof Error ? error.message : String(error)}）；` +
        '请先调用 concept_lookup 建好索引后重试。账本未被修改——引理语义不能在没有词典的情况下写进去。',
    )
  }
}

/**
 * 注册 `annotate_submit`。
 * @param {object} ctx
 * @param {object} config
 * @returns {() => void} disposer
 */
export function registerAnnotateSubmit(ctx, config) {
  return ctx.tools.register(
    defineTool({
      name: 'annotate_submit',
      description:
        '提交一批注解：先按 V1–V16 逐条校验，全部通过才合并进 out/ledger/<decl-slug>.json 并重算指标；有任一条不通过则整体不写盘，逐条返回带修复动作的诊断。同一 (node, role) 重复提交会覆盖旧条目并在结果中报告。',
      parameters: {
        theorem_name: {
          type: 'string',
          required: true,
          description:
            'Lean 全限定声明名。对应 out/ledger/<decl-slug>.json；必须已有 out/skeleton/<decl-slug>.json（否则先 skeleton_extract）。',
        },
        annotations: {
          type: 'array',
          required: true,
          // 注解对象字段由 annotate_prepare 的 output_shape 描述；DSL 要求 object 节点显式声明 additionalProperties。
          items: { type: 'object', additionalProperties: true },
          description:
            '待提交的注解数组，字段同 annotate_prepare 的 output_shape（snake_case）。`id` 可省略，由本工具分配并在 assigned_ids 中回传；segment.kind=concept 时必须带 lexicon_ref，且该名字必须能在本地词典中命中（查不到会按 V10 拒绝整批）。',
        },
        run: {
          type: 'string',
          description: '本次注解的 run 标识，写入 provenance.run（V15）。省略时沿用账本已有 run；仍缺则要求每条注解自带 provenance.run。',
        },
        model: {
          type: 'string',
          description: '生成注解的模型名，写入 provenance.model（V15）。省略时沿用账本已有 model；仍缺则要求每条注解自带 provenance.model。',
        },
      },
      output: {
        // 值 schema DSL 要求每个 object 节点显式声明 additionalProperties（true/false 均可）。
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const theoremName = args?.theorem_name
        if (typeof theoremName !== 'string' || theoremName.trim() === '') {
          fail('theorem_name 必须是非空的 Lean 全限定名；请填写声明名后重试。')
        }
        const theorem = theoremName.trim()
        if (!Array.isArray(args?.annotations) || args.annotations.length === 0) {
          fail('annotations 必须是非空数组；请按 annotate_prepare 的 output_shape 写出至少一条注解后重试。')
        }

        let skeleton
        try {
          skeleton = await readSkeleton(config.outputDir, theorem, { signal: exec.signal })
        } catch (error) {
          fail(
            `读不到 out/skeleton 下 "${theorem}" 的骨架（${error instanceof Error ? error.message : String(error)}）；请先调用 skeleton_extract(theorem_name="${theorem}")。`,
          )
        }

        let rawLedger = null
        try {
          rawLedger = await readLedger(config.outputDir, theorem, { signal: exec.signal })
        } catch (error) {
          fail(`读取 out/ledger 下 "${theorem}" 的账本失败（${error instanceof Error ? error.message : String(error)}）；请检查 outputDir 配置后重试。`)
        }
        const storedLedger = rawLedger
        const existing = existingAnnotations(rawLedger)

        // ── 1. 归一化提交内容：provenance 默认值（V15 是必填，缺了会被校验器拒绝）────────
        const nowIso = new Date().toISOString()
        const fallbackRun = typeof args?.run === 'string' && args.run !== '' ? args.run : (storedLedger?.provenance?.run ?? null)
        const fallbackModel = typeof args?.model === 'string' && args.model !== '' ? args.model : (storedLedger?.provenance?.model ?? null)
        const submitted = args.annotations.map((raw) => {
          const annotation = toCamel(raw)
          const provenance = annotation.provenance && typeof annotation.provenance === 'object' ? { ...annotation.provenance } : {}
          if (!provenance.model && fallbackModel) provenance.model = fallbackModel
          if (!provenance.run && fallbackRun) provenance.run = fallbackRun
          if (!provenance.ts) provenance.ts = nowIso
          return { ...annotation, provenance }
        })

        // ── 2. 覆盖既有条目：被本次提交覆盖的旧条目退出最终集（V16 的覆盖语义）──────────
        const existingByKey = new Map()
        for (const annotation of existing) {
          const key = overwriteKey(annotation)
          if (key !== null && !existingByKey.has(key)) existingByKey.set(key, annotation)
        }
        const submittedKeys = new Set(submitted.map((annotation) => overwriteKey(annotation)).filter((key) => key !== null))
        const base = existing.filter((annotation) => {
          const key = overwriteKey(annotation)
          return key === null || !submittedKeys.has(key)
        })

        // ── 2.5 V10 的解析性检查：解析本批用到的全部 lexicon_ref（两遍校验共用同一份）──
        const lexicon = await resolveLexiconNames(config, [...base, ...submitted], exec.signal)

        // ── 3. 批内重复（V16）：检测交给 core/credential.mjs，这里只做索引映射 ──────────
        //    第 3 步这一遍只为拿 duplicates（覆盖并报告）；第 5 步再校验真正要写入的集合，
        //    保证「校验过的就是写进去的」（validated == written）。
        //    ★ 两遍必须传同一份 lexiconNames，否则两遍对 V10 的判定会不一致。
        const preReport = validateAnnotations([...base, ...submitted], skeleton, { lexiconNames: lexicon.names })
        if (!Array.isArray(preReport?.duplicates)) {
          fail('校验器没有返回 duplicates 数组；请把这次调用反馈给维护者（annotate_submit 不自行兜底规则）。')
        }
        const duplicatesInSubmission = preReport.duplicates
          .filter((duplicate) => typeof duplicate?.index === 'number' && duplicate.index >= base.length)
          .map((duplicate) => ({
            index: duplicate.index - base.length,
            droppedIndex: typeof duplicate.overwritesIndex === 'number' ? duplicate.overwritesIndex - base.length : null,
            node: duplicate.node ?? null,
            role: duplicate.role ?? null,
            message: duplicate.message ?? null,
          }))
        const droppedSubmission = new Set(
          preReport.duplicates
            .map((duplicate) => duplicate?.overwritesIndex)
            .filter((index) => typeof index === 'number' && index >= base.length)
            .map((index) => index - base.length),
        )
        const kept = submitted
          .map((annotation, index) => ({ annotation, index }))
          .filter(({ index }) => !droppedSubmission.has(index))

        const overwritten = []
        for (const { annotation } of kept) {
          const key = overwriteKey(annotation)
          const replaced = key !== null ? existingByKey.get(key) : undefined
          if (replaced !== undefined) {
            overwritten.push({
              node: annotation.node ?? null,
              role: annotation.role ?? null,
              replacedId: replaced.id ?? null,
              id: null, // 分配后回填
            })
          }
        }

        // ── 4. 分配 id：覆盖沿用旧 id（保持 refs 有效），否则取下一个空位（确定性）──────
        const usedIds = new Set(base.map((annotation) => annotation.id).filter((id) => typeof id === 'string' && id !== ''))
        let cursor = 1
        for (const id of usedIds) {
          const match = /^a(\d+)$/.exec(id)
          if (match) cursor = Math.max(cursor, Number(match[1]) + 1)
        }
        const allocateId = () => {
          while (usedIds.has(`a${cursor}`)) cursor += 1
          const id = `a${cursor}`
          usedIds.add(id)
          cursor += 1
          return id
        }
        const idRemapped = []
        const assignedIds = []
        kept.forEach(({ annotation, index }) => {
          const key = overwriteKey(annotation)
          const replaced = key !== null ? existingByKey.get(key) : undefined
          const providedId = typeof annotation.id === 'string' && annotation.id !== '' ? annotation.id : null
          let id
          if (providedId !== null && replaced?.id === providedId) {
            id = providedId
          } else if (providedId !== null && !usedIds.has(providedId)) {
            id = providedId
            usedIds.add(id)
          } else if (providedId === null && typeof replaced?.id === 'string' && replaced.id !== '') {
            id = replaced.id
          } else {
            id = allocateId()
            if (providedId !== null) idRemapped.push({ submittedId: providedId, assignedId: id, reason: 'id 与既有注解冲突，已重新分配' })
          }
          annotation.id = id
          const recorded = overwritten.find((item) => item.node === (annotation.node ?? null) && item.role === (annotation.role ?? null))
          if (recorded !== undefined) recorded.id = id
          assignedIds.push({ index, node: annotation.node ?? null, role: annotation.role ?? null, id })
        })

        // ── 5. 校验**将要写入的集合**：复用 core/credential.mjs 的 validateAnnotations ──
        const finalAnnotations = [...base, ...kept.map(({ annotation }) => annotation)]
        const report = validateAnnotations(finalAnnotations, skeleton, {
          maxDiagnostics: config.maxDiagnostics ?? DEFAULT_MAX_DIAGNOSTICS,
          lexiconNames: lexicon.names,
        })
        if (!Array.isArray(report?.diagnostics)) {
          fail('校验器没有返回 diagnostics 数组；请把这次调用反馈给维护者（annotate_submit 不自行兜底校验）。')
        }
        // 诊断索引相对于 finalAnnotations；只有 index < base.length 的属于既有账本，其余属于本次提交。
        const submissionDiagnostics = report.diagnostics
          .filter((diagnostic) => typeof diagnostic?.index !== 'number' || diagnostic.index >= base.length)
          .map((diagnostic) => ({
            ...diagnostic,
            index: typeof diagnostic?.index === 'number' ? diagnostic.index - base.length : null,
          }))
        const existingDiagnostics = report.diagnostics.filter(
          (diagnostic) => typeof diagnostic?.index === 'number' && diagnostic.index < base.length,
        )
        const blocked = submissionDiagnostics.length > 0

        // ── 6. 通过则合并写盘；否则原样返回诊断（不写盘）──────────────────────────────
        const metrics = computeMetrics(finalAnnotations, skeleton)
        const created = storedLedger?.provenance?.created ?? nowIso
        const run = fallbackRun ?? submitted[0]?.provenance?.run ?? null
        let ledgerPath = null
        let writtenMetrics = storedLedger?.metrics ?? null
        if (!blocked) {
          const ledger = {
            specVersion: storedLedger?.specVersion ?? SPEC_VERSION,
            mathlibBaseline: storedLedger?.mathlibBaseline ?? MATHLIB_BASELINE,
            theorem,
            skeleton,
            annotations: finalAnnotations,
            metrics,
            provenance: { run, created },
          }
          try {
            // writeLedger 接收 camelCase 的 Ledger，落盘时自己转 snake_case（INTERFACES §2.9）。
            ledgerPath = await writeLedger(config.outputDir, theorem, ledger)
          } catch (error) {
            fail(`账本写盘失败（${error instanceof Error ? error.message : String(error)}）；请检查 outputDir 是否可写后重试。`)
          }
          writtenMetrics = metrics
        }

        const response = {
          ok: !blocked,
          theorem,
          submitted: submitted.length,
          accepted: blocked ? 0 : kept.length,
          rejected: blocked ? kept.length : 0,
          written: !blocked,
          ledgerPath,
          assignedIds,
          overwritten,
          duplicatesInSubmission,
          idRemapped,
          diagnostics: submissionDiagnostics,
          existingDiagnostics,
          validation: {
            mergedTotal: report.total ?? null,
            mergedPassed: report.passed ?? null,
            mergedFailed: report.failed ?? null,
            truncated: report.truncated === true,
          },
          // V10 的解析性检查是否真的执行了：0 表示本批没有 concept 段（无需查词典）
          lexiconNamesChecked: lexicon.checked,
          metrics: writtenMetrics,
          provenance: { run, created },
          provenanceHint:
            submissionDiagnostics.some(
              (diagnostic) => diagnostic?.rule === RULE.V15 || String(diagnostic?.field ?? '').startsWith('provenance'),
            )
              ? 'provenance 的 model / run 可由本工具的 run、model 参数统一填充，ts 缺失时自动补当前时间；也可以让每条注解自带 provenance（V15）。'
              : null,
          instruction: blocked
            ? '有注解未通过校验：请按 diagnostics 里每条 message 的修复动作改写后再次提交；账本未被修改。'
            : '已写入账本。需要用 annotate_prepare 继续写其它节点，或用 ledger_export 渲染 HTML。',
        }
        if (!blocked && overwritten.length > 0) {
          response.instruction = `已覆盖 ${overwritten.length} 条同 (node, role) 的旧注解（V16）：${overwritten.map((item) => `${item.node}/${item.role}→${item.id}`).join(', ')}。`
        }
        // 工具输出 ⇒ snake_case（SPEC §1.1）；ROLE/SIGNIFICANCE 等枚举值原样保留。
        return toSnake(response)
      },
    }),
  )
}
