/**
 * index.js — dsh-scholia 插件入口（Host-only bundle，无客户端、无构建产物）
 *
 * 职责（SPEC §7.2 / INTERFACES §2.12）：
 *   1. 声明 `name` / `inject = ['tools']` / `Config`；
 *   2. `apply(ctx, config)` 把 6 个工具注册包在 **一个** `ctx.effect` 内，并返回清理函数。
 *
 * 为什么全部注册必须包在 `ctx.effect` 内：注册是 context 拥有的 effect。
 * 否则热重载 / 卸载后旧注册残留，模型会看到两份同名工具。
 *
 * Config 字段一律 camelCase（patch 层可见，SPEC §1.1），形状由 INTERFACES §2.13 冻结。
 * 可调值只在这里声明一次；工具模块只接收 `config` 对象（不重复声明 schema）。
 */

import z from '@deepseek-ai/schemastery'

import { registerAnnotationCheck } from './src/tools/annotation-check.mjs'
import { registerConceptLookup } from './src/tools/concept-lookup.mjs'
import { registerSkeletonExtract } from './src/tools/skeleton-extract.mjs'
import { registerAnnotatePrepare } from './src/tools/annotate-prepare.mjs'
import { registerAnnotateSubmit } from './src/tools/annotate-submit.mjs'
import { registerLedgerExport } from './src/tools/ledger-export.mjs'

/** bundle 名 / Cordis 行 id（SPEC §1.2，已锁定） */
export const name = 'dsh-scholia'

/** `ctx.tools` 是硬依赖：缺了就不激活，而不是抛错（SPEC §7.2） */
export const inject = ['tools']

/** 冻结形状见 INTERFACES §2.13。绝对路径由 patch 层给出，不写死在代码里。 */
export const Config = z.object({
  corpusPath: z.string(),
  cacheDir: z.string(),
  outputDir: z.string(),
  maxEntries: z.natural().default(8),
  descriptionChars: z.natural().default(600),
  maxNodes: z.natural().default(40),
  maxDiagnostics: z.natural().default(50),
})

/**
 * 注册全部一期工具。
 * @param ctx - 已注入 `tools` 服务的 Cordis 上下文（Host 侧）
 * @param config - 已按 `Config` 校验的插件配置
 */
export function apply(ctx, config) {
  ctx.effect(() => {
    const disposers = [
      registerAnnotationCheck(ctx, config),
      registerConceptLookup(ctx, config),
      registerSkeletonExtract(ctx, config),
      registerAnnotatePrepare(ctx, config),
      registerAnnotateSubmit(ctx, config),
      registerLedgerExport(ctx, config),
    ]
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-scholia: tools')
}
