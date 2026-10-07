/**
 * concept-lookup.mjs — 工具 `concept_lookup`（SPEC §6.1 / R3，INTERFACES §2.11）
 *
 * 职责：本地词典查询。**这是引理语义的唯一来源**——模型编造引理含义是本项目最大的可信度风险，
 * 因此未命中的名字必须显式返回 `missing[]`（SPEC T2），绝不静默省略。
 *
 * 索引在首次调用时惰性构建（ARCHITECTURE §5.1(a)），之后只读；语料更新后用 rebuild 参数重建。
 * 不联网。
 *
 * 工具定义遵循 SPEC §6.2：T1 输出有界 / T2 显式 missing / T3 参数规则在参数上 /
 * T4 描述只讲行为 / T6 只读声明 isConcurrencySafe / T8 错误带修复动作。
 */

import path from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'

import { shapeEntries } from '../core/lexicon.mjs'
import { ensureLexiconIndex, lookupLemma } from '../io/index-db.mjs'
import { toCamel, toSnake } from '../io/contract.mjs'

/** 词典索引文件名（SPEC §2.6：cache/lexicon.db） */
const INDEX_FILENAME = 'lexicon.db'

/**
 * 合并两处 missing：索引里没有的名字 + 有行但无法成型（缺 informal_description）的名字。
 * 两处都算「本地词典没有可用语义」，都必须显式告诉模型。
 * @param {string[]|undefined} fromLookup
 * @param {string[]|undefined} fromShape
 * @returns {string[]}
 */
function mergeMissing(fromLookup, fromShape) {
  const merged = new Set()
  for (const name of fromLookup ?? []) merged.add(name)
  for (const name of fromShape ?? []) merged.add(name)
  return [...merged]
}

/**
 * 注册 `concept_lookup`。
 * @param {object} ctx - Cordis 上下文，需已注入 `tools`
 * @param {object} config - 见 index.js 的 Config
 * @returns {() => void} 注销函数
 */
export function registerConceptLookup(ctx, config) {
  return ctx.tools.register(defineTool({
    name: 'concept_lookup',
    description:
      '查询本地语料词典中若干引理的全限定名与通俗说明。返回命中的条目、未命中的名字，以及完整索引的位置；'
      + '不联网。写注解时引理的语义只允许来自本工具的返回，命中的条目超出上限时只内联前若干条。',
    parameters: {
      names: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description:
          '要查询的全限定引理名，如 "Even.add" / "Nat.add_comm"；大小写与命名空间必须与语料一致。'
          + '一次把要用的名字全部给出，比逐个查询更省调用，也更容易发现未命中。',
      },
      rebuild: {
        type: 'boolean',
        description:
          '默认 false：索引不存在时才构建。语料更新、或怀疑索引过期时设为 true 强制重建；'
          + '重建会流式扫描整个语料，耗时较长。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: true,
              description:
                '词典条目：name / module / kind / signature / informal_name / informal_description / '
                + 'description_truncated',
            },
          },
          missing: {
            type: 'array',
            required: true,
            items: { type: 'string' },
            description: '本地词典中没有可用语义的名字；这些名字的含义不可臆造，请改用 reasoning 段或换名字',
          },
          truncated: {
            type: 'boolean',
            required: true,
            description: '命中条目超过上限、只内联了前若干条时为 true；单条描述是否被截短看该条的 description_truncated',
          },
          index_path: { type: 'string', required: true, description: '本地词典索引文件路径' },
          index_count: { type: 'integer', required: true, description: '索引当前收录的条目总数' },
          index_built: { type: 'boolean', required: true, description: '本次调用是否触发了索引构建' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    // 只读查询可并行；rebuild=true 会写索引，故该次调用独占（SPEC T6）
    isConcurrencySafe: (args) => args.rebuild !== true,
    async execute(args, exec) {
      const dbPath = path.join(config.cacheDir, INDEX_FILENAME)
      let index
      let found
      let missingFromLookup
      try {
        index = await ensureLexiconIndex({
          corpusPath: config.corpusPath,
          dbPath,
          rebuild: args.rebuild === true,
          signal: exec.signal,
        })
        const result = lookupLemma(dbPath, args.names)
        found = result.found
        missingFromLookup = result.missing
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        throw new Error(
          `本地词典索引不可用（语料 ${config.corpusPath}，索引 ${dbPath}）：${reason}。`
          + '修复动作：确认 Config.corpusPath 指向存在的 data/lsv2.jsonl、Config.cacheDir 可写，'
          + '然后带 rebuild=true 重试一次。',
        )
      }

      // 边界：契约 snake_case 行 -> core camelCase 条目（L5：转换只在 contract.mjs）
      const shaped = shapeEntries(
        (found ?? []).map((row) => toCamel(row)),
        { maxEntries: config.maxEntries, descriptionChars: config.descriptionChars },
      )

      return toSnake({
        entries: shaped.entries,
        missing: mergeMissing(missingFromLookup, shaped.missing),
        truncated: shaped.truncated,
        indexPath: dbPath,
        indexCount: index?.count ?? (found ?? []).length,
        indexBuilt: index?.built === true,
      })
    },
  }))
}
