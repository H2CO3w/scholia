/**
 * ledger-export.mjs — `ledger_export`：Ledger → 静态 HTML 产物
 *
 * 依据：SPEC §2.6（产物路径）、§1.4（前端命名）；ARCHITECTURE §6.1（一期静态渲染）。
 *
 * 职责边界：
 *   - 渲染是 src/render/html.mjs 的纯函数（不碰 DOM / 不写文件）
 *   - HTML 落盘走 io 层的 `writeRender`（INTERFACES §2.9，原子写）；样式资产
 *     `out/render/assets/**`（我们的 a4m.css + vendored KaTeX）目前没有对应的 io 入口，
 *     由本工具按 `src/render/assets.mjs` 导出的 VENDOR_ASSETS 清单复制
 *   - 输出**有界**（T1）：只返回路径与计数，不返回 HTML 正文
 */

import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineTool } from '@deepseek-ai/dsh-tools'

import { PRECISE_EVIDENCE } from '../core/enums.mjs'
import { readLedger, writeRender } from '../io/artifacts.mjs'
import { CSS_FILENAME, KATEX_CSS_FILENAME, VENDOR_ASSETS } from '../render/assets.mjs'
import { renderAssets, renderLedgerHtml } from '../render/html.mjs'

/** 参数/环境错误：消息必须带修复动作（T8）。 */
function fail(message) {
  throw new Error(message)
}

/**
 * 注册 `ledger_export`。
 * @param {object} ctx
 * @param {object} config
 * @returns {() => void} disposer
 */
export function registerLedgerExport(ctx, config) {
  return ctx.tools.register(
    defineTool({
      name: 'ledger_export',
      description:
        '把一份注解账本渲染成并排的静态 HTML（左栏证明骨架、右栏按 role 分组的注解，节点与注解之间双向可跳转），写入 out/render/ 并返回产物路径与计数。',
      parameters: {
        theorem_name: {
          type: 'string',
          required: true,
          description:
            'Lean 全限定声明名，对应 out/ledger/<decl-slug>.json。账本不存在时请先用 annotate_submit 提交至少一条注解。',
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

        let rawLedger = null
        try {
          rawLedger = await readLedger(config.outputDir, theorem, { signal: exec.signal })
        } catch (error) {
          fail(`读取 out/ledger 下 "${theorem}" 的账本失败（${error instanceof Error ? error.message : String(error)}）；请检查 outputDir 配置后重试。`)
        }
        if (rawLedger === null || rawLedger === undefined) {
          fail(`out/ledger 下还没有 "${theorem}" 的账本；请先调用 annotate_submit(theorem_name="${theorem}", annotations=[…])。`)
        }

        const ledger = rawLedger // readLedger 按 INTERFACES §2.9 返回 camelCase 的 Ledger
        const html = renderLedgerHtml(ledger)
        const assets = renderAssets()
        // HTML 落盘走 io 层（INTERFACES §2.9）：路径由 artifactPath 在 io 层决定，工具层不拼路径。
        let htmlPath
        try {
          htmlPath = await writeRender(config.outputDir, theorem, html)
        } catch (error) {
          fail(`渲染产物写盘失败（${error instanceof Error ? error.message : String(error)}）；请检查 outputDir 是否可写后重试。`)
        }
        // 样式资产（我们的 a4m.css + vendored KaTeX）按 render 层的清单复制到 assets/。
        const assetDir = path.join(path.dirname(htmlPath), 'assets')
        const fontDir = path.join(assetDir, VENDOR_ASSETS.subdirs.fonts)
        let fontCount = 0
        let katexCssPath = null
        try {
          await mkdir(fontDir, { recursive: true })
          for (const [filename, text] of Object.entries(assets)) {
            await writeFile(path.join(assetDir, filename), text, 'utf8')
          }
          const vendorDir = fileURLToPath(VENDOR_ASSETS.dirUrl)
          for (const filename of VENDOR_ASSETS.cssFiles) {
            const target = path.join(assetDir, filename)
            await copyFile(path.join(vendorDir, filename), target)
            if (filename === KATEX_CSS_FILENAME) katexCssPath = target
          }
          for (const [source, target] of Object.entries(VENDOR_ASSETS.subdirs)) {
            const sourceDir = path.join(vendorDir, source)
            const entries = await readdir(sourceDir, { withFileTypes: true })
            for (const entry of entries) {
              if (!entry.isFile()) continue
              if (!VENDOR_ASSETS.extensions.some((ext) => entry.name.endsWith(ext))) continue
              await copyFile(path.join(sourceDir, entry.name), path.join(assetDir, target, entry.name))
              fontCount += 1
            }
          }
        } catch (error) {
          fail(
            `样式资产写盘失败（${error instanceof Error ? error.message : String(error)}）；` +
              `${VENDOR_ASSETS.howToFix} 账本未被修改。`,
          )
        }

        const annotations = Array.isArray(ledger?.annotations) ? ledger.annotations : []
        const nodes = ledger?.skeleton?.nodes && typeof ledger.skeleton.nodes === 'object' ? ledger.skeleton.nodes : {}
        const hiddenInIntuitionLayer = annotations.filter((annotation) => PRECISE_EVIDENCE.includes(annotation?.evidence)).length

        return {
          ok: true,
          theorem,
          html_path: htmlPath,
          css_path: path.join(assetDir, CSS_FILENAME),
          katex_css_path: katexCssPath,
          font_dir: fontDir,
          font_count: fontCount,
          html_bytes: Buffer.byteLength(html, 'utf8'),
          node_count: Object.keys(nodes).length,
          annotation_count: annotations.length,
          coverage_mode: ledger?.skeleton?.coverage?.mode ?? null,
          degraded: ledger?.skeleton?.coverage?.degraded === true,
          hidden_in_intuition_layer: hiddenInIntuitionLayer,
          metrics: ledger?.metrics ?? null,
          instruction:
            '用浏览器打开 html_path 即可阅读；直觉层视图由页面上的复选框切换（纯 CSS，属性选择器实现 V6 过滤）。',
        }
      },
    }),
  )
}
