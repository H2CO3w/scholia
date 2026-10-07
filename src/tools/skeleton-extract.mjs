/**
 * skeleton-extract.mjs — 工具 `skeleton_extract`（SPEC §6.1，INTERFACES §2.11）
 *
 * 职责：`theorem_name` -> 从语料流式取该条记录 -> `core/skeleton.mjs` 建树 -> 写
 * `out/skeleton/<slug>.json` -> 返回根节点、覆盖率与节点摘要。
 *
 * 逐节点调用（ARCHITECTURE §5.1(b)）是这套方法的关键：节点 id 由 DFS 前序决定，
 * 跨调用稳定，所以 `annotate_prepare` 可以把 node_id 当**输入**，从结构上排除锚点错位。
 *
 * 输出有界（SPEC T1）：内联节点数不超过 Config.maxNodes，完整树在 full_path。
 * 树退化（degraded）**不是错误**而是常态（SPEC §2.2 / H5），必须原样上报而不是静默降级。
 *
 * 工具定义遵循 SPEC §6.2：T1/T3/T4/T8。本工具写产物，不是只读工具，故不声明 isConcurrencySafe。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import { SOURCE } from '../core/enums.mjs'
import { recordToSkeleton } from '../core/skeleton.mjs'
import { writeSkeleton } from '../io/artifacts.mjs'
import { findRecord } from '../io/corpus.mjs'
import { toSnake } from '../io/contract.mjs'

/**
 * 节点摘要里 signature 的内联字符上限。
 * Config 形状已冻结（INTERFACES §2.13 只有 7 个字段），故此处用模块常量；
 * 完整 signature 始终在 full_path 指向的产物里。
 */
const NODE_SUMMARY_CHARS = 200

/**
 * 节点 id 排序：`n0, n1, n2, …, n10`（按数字，不按字典序）。
 * 非 `n<数字>` 形状的 id 回退到字符串排序，保证确定性。
 * @param {string} a
 * @param {string} b
 */
function compareNodeIds(a, b) {
  const na = Number.parseInt(String(a).slice(1), 10)
  const nb = Number.parseInt(String(b).slice(1), 10)
  if (Number.isInteger(na) && Number.isInteger(nb) && na !== nb) return na - nb
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0
}

/**
 * 一个节点的内联摘要。字段与 SkeletonNode（SPEC §2.1）同名，便于对照 full_path 里的完整树。
 * @param {object} node
 */
function summarizeNode(node) {
  const signature = typeof node?.signature === 'string' ? node.signature : ''
  const clipped = signature.length > NODE_SUMMARY_CHARS
  return {
    id: node?.id ?? null,
    parent: node?.parent ?? null,
    kind: node?.kind ?? null,
    decl: node?.decl ?? null,
    signature: clipped ? `${signature.slice(0, NODE_SUMMARY_CHARS)}…` : signature,
    signature_clipped: clipped,
    hypotheses: Array.isArray(node?.hypotheses) ? node.hypotheses : [],
    lemma_refs: Array.isArray(node?.lemmaRefs) ? node.lemmaRefs : [],
    truncated: node?.truncated === true,
  }
}

/**
 * 组装有界的工具返回值（snake_case 契约字段）。
 * @param {object} skeleton - SkeletonTree（camelCase，core 侧形状）
 * @param {{ theoremName: string, fullPath: string, maxNodes: number }} opts
 */
function buildResult(skeleton, opts) {
  const nodes = skeleton?.nodes ?? {}
  const ids = Object.keys(nodes).sort(compareNodeIds)
  const limit = Number.isInteger(opts.maxNodes) && opts.maxNodes > 0 ? opts.maxNodes : ids.length
  const inline = ids.slice(0, limit).map((id) => summarizeNode(nodes[id]))
  const rootNode = skeleton?.root ? nodes[skeleton.root] : undefined

  return {
    theorem: skeleton?.theorem ?? opts.theoremName,
    root: skeleton?.root ?? null,
    coverage: skeleton?.coverage ?? {},
    // SPEC §2.1：truncated 是「数据集记录是否被 500 字符截断」；H3 要求样本准入必须检查它
    record_truncated: rootNode?.truncated === true,
    nodes: inline,
    node_count: ids.length,
    returned_node_count: inline.length,
    omitted_node_count: Math.max(0, ids.length - inline.length),
    truncated: ids.length > inline.length,
    full_path: opts.fullPath,
  }
}

/**
 * 注册 `skeleton_extract`。
 * @param {object} ctx - Cordis 上下文，需已注入 `tools`
 * @param {object} config - 见 index.js 的 Config
 * @returns {() => void} 注销函数
 */
export function registerSkeletonExtract(ctx, config) {
  return ctx.tools.register(defineTool({
    name: 'skeleton_extract',
    description:
      '从本地语料提取一条定理的证明骨架树，写入产物文件，并返回根节点、覆盖率（含 degrade 原因）与节点摘要。'
      + '节点数超过上限时只内联前若干个，完整树在 full_path；该定理不在语料中时直接失败并说明改怎么查。',
    parameters: {
      theorem_name: {
        type: 'string',
        required: true,
        description:
          '全限定 Lean 声明名，如 "Mathlib.Algebra.Group.Even.add"；'
          + '必须与语料中的写法完全一致（含命名空间与大小写），不接受只写短名。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          theorem: { type: 'string', required: true, description: '骨架对应的全限定声明名' },
          root: {
            required: true,
            oneOf: [{ type: 'string' }, { type: 'null' }],
            description: '根节点 id（通常为 "n0"）；锚点与定理级注解都指向它',
          },
          coverage: {
            type: 'object',
            additionalProperties: true,
            required: true,
            description:
              '树覆盖率（SPEC §2.2，v1.1 起为 7 字段）：mode / have_count / node_count / '
              + 'truncated / truncate_reason / degraded / degrade_reason。'
              + 'degraded=true ⇔ have_count=0（没解析出任何中间节点，树只剩根）——'
              + '所以「多行 tactic 但没有 have」也算 degraded；truncated=true 只说证明体被语料截断'
              + '（此时已解析出的步骤照常可用，但不得声称完整）。二者正交：'
              + '截断看 truncate_reason，结构退化看 degrade_reason。',
          },
          record_truncated: {
            type: 'boolean',
            required: true,
            description:
              'root 节点的 truncated 标志（SPEC §2.1）：语料记录被 500 字符截断时为 true。'
              + '样本池准入要检查它（SPEC H3）；截断原因见 coverage.truncate_reason，'
              + '它与结构退化 coverage.degraded 不是同一件事。',
          },
          nodes: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: true,
              description:
                '节点摘要：id / parent / kind / decl / signature / signature_clipped / hypotheses / lemma_refs / truncated，'
                + '按 id 的 DFS 前序排列（长度受 maxNodes 限制）',
            },
          },
          node_count: { type: 'integer', required: true, description: '骨架树的节点总数' },
          returned_node_count: { type: 'integer', required: true, description: '本次内联的节点数' },
          omitted_node_count: { type: 'integer', required: true, description: '未内联的节点数；完整树见 full_path' },
          truncated: { type: 'boolean', required: true, description: '节点被截断（未全部内联）时为 true' },
          full_path: { type: 'string', required: true, description: '完整骨架树 JSON 的路径，可直接读取或交给后续工具' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const record = await findRecord(config.corpusPath, args.theorem_name, { signal: exec.signal })
      if (!record) {
        throw new Error(
          `语料 ${config.corpusPath} 里没有 "${args.theorem_name}"。`
          + '修复动作：核对全限定名（命名空间、大小写、是否含 Unicode 下标）与语料中的 name 完全一致；'
          + '或先用 concept_lookup 确认名字；若语料文件位置变了，请修正 Config.corpusPath。',
        )
      }

      const skeleton = recordToSkeleton(record, { origin: SOURCE.LSV2 })
      const fullPath = await writeSkeleton(config.outputDir, args.theorem_name, skeleton)
      return toSnake(buildResult(skeleton, {
        theoremName: args.theorem_name,
        fullPath,
        maxNodes: config.maxNodes,
      }))
    },
  }))
}
