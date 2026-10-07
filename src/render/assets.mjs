/**
 * assets.mjs — 静态渲染的样式资产（纯字符串生成）
 *
 * 职责（INTERFACES §2.10）：
 *   - `CSS_FILENAME`：产物文件名，out/render/assets/a4m.css
 *   - `css()`：返回完整样式表文本
 *
 * 版面：**单栏论文式**（正文 72ch 居中、衬线字体栈、注解像书里的 Remark）。
 * 约束：
 *   - 分层 L1：不 import I/O 模块（文件系统 / 网络 / SQLite）、不做网络请求、不 import DSH 包
 *   - 分层 L4：枚举字面量只能来自 src/core/enums.mjs
 *   - 不碰 DOM、不写文件（落盘是 src/io/artifacts.mjs 与工具层的事）
 *
 * SPEC §1.4 命名：类名一律 `a4m-` 前缀 + BEM；元素 id `a4m-n-<id>` / `a4m-a-<id>`；
 * 数据属性 `data-a4m-<字段>`。二期 React 复用同一套类名与属性，因此这里不做任何
 * 「一期专用」的命名妥协。
 */

import { EVIDENCE, PRECISE_EVIDENCE, SEGMENT_KIND } from '../core/enums.mjs'

/** 样式表文件名（SPEC §2.6：out/render/assets/a4m.css） */
export const CSS_FILENAME = 'a4m.css'

/** KaTeX 样式表文件名（vendored，见 SPEC §7.1.1）；与本文件同落在 out/render/assets/。 */
export const KATEX_CSS_FILENAME = 'katex.min.css'

/**
 * vendor 资产清单（**供工具层复制**；src/render 自己不做 I/O，L1）。
 *
 * 落点约定（assets 目录 = out/render/assets/）：
 *   vendor/katex/katex.min.css  → assets/katex.min.css
 *   vendor/katex/fonts/*.woff2  → assets/fonts/*.woff2  ← **必须保持 fonts/ 这一层**，
 *                                 katex.min.css 内部就是按 url(fonts/…) 相对引用的
 *   vendor/katex/LICENSE        → 不复制，但必须留在仓库里（MIT 版权合规）
 */
export const VENDOR_ASSETS = Object.freeze({
  /** vendor/katex 目录（URL，相对本模块解析；工具层用 fileURLToPath 取本地路径） */
  dirUrl: new URL('../../vendor/katex/', import.meta.url),
  /** 直接复制到 assets/ 根下的文件 */
  cssFiles: Object.freeze(['katex.min.css']),
  /** 子目录映射：源子目录 → 目标子目录（相对 assets/） */
  subdirs: Object.freeze({ fonts: 'fonts' }),
  /** 只取这些扩展名（ttf/woff 未 vendored；woff2 在 @font-face 里排第一，够用） */
  extensions: Object.freeze(['.woff2']),
  /** 不复制但必须保留在仓库中（版权合规） */
  keepInRepo: Object.freeze(['LICENSE']),
  /** 复制失败时的修复动作（T8） */
  howToFix: 'vendor/katex 缺失或不可读；请检查仓库完整性（SPEC §7.1.1 的 vendored 依赖），不要改为在线加载。',
})

/**
 * `data-a4m-layer` 的取值（视图层标识）。
 *
 * 注意：enums.mjs 没有 LAYER 枚举，且已冻结不可增补。「直觉层」的视图名与
 * E-EVIDENCE 的 `intuition` 同字面量，故直接复用枚举值，避免在 render 层内联字面量（L4）。
 */
export const VIEW_LAYER = Object.freeze({
  /** 默认视图：全量展示 */
  PROOF: 'proof',
  /** 直觉层视图：隐藏 evidence ∈ {formal, literature, unfolding} 的注解（V6） */
  INTUITION: EVIDENCE.INTUITION,
})

/**
 * 一期无脚本切换控件的 id。
 * 勾选它等价于把容器切到直觉层视图；二期由 React 状态直接设置 `data-a4m-layer`。
 */
export const LAYER_TOGGLE_ID = 'a4m-layer-intuition'

/**
 * 版面度量：**CSS 与折行预算共用这一份数**。
 * 改栏宽 / 公式缩放时只改这里；折行预算 `DISPLAY_LINE_BUDGET` 由下面推导，
 * 渲染层（html.mjs）直接读它，不再各写一个魔数。改动会被 `排版: 栏宽与折行预算同源` 用例钉住。
 */
export const LAYOUT = Object.freeze({
  /** 正文栏宽（ch）：`.a4m-paper` 的 max-width。88ch 对应 A4 单栏 10pt 的实测测度（≈90 字符）。 */
  COLUMN_CH: 88,
  /** 公式块两侧各外扩的 ch 数（`.a4m-equation` 的负外边距，宽屏才生效）。 */
  FORMULA_BLEED_CH: 4,
  /** 独立公式相对正文的字号缩放（`.katex-display`）；行内公式不缩放。 */
  FORMULA_SCALE: 0.95,
  /** 窄屏（不外扩）时的公式缩放：与 (COLUMN_CH + 2×BLEED) × FORMULA_SCALE 等效，保证同一预算成立。 */
  NARROW_FORMULA_SCALE: 0.86,
  /** 兜底的可横向滚动公式再降一档。 */
  WIDE_FORMULA_SCALE: 0.9,
  /** 正文 1 个 `ch` 的宽度（em）：衬线体数字宽约半个 em。 */
  BODY_CH_EM: 0.5,
  /** 数学模式下一个源字符的平均占宽（em，按公式字号计）：标识符≈0.5、算符≈0.78、括号≈0.28，取 0.5。 */
  MATH_CHAR_EM: 0.5,
})

/** 公式盒宽度（ch）= 栏宽 + 两侧外扩。 */
export const FORMULA_BOX_CH = LAYOUT.COLUMN_CH + 2 * LAYOUT.FORMULA_BLEED_CH

/**
 * 折行预算（Lean 源字符/行）= 公式盒宽 × 每 ch 的 em ÷ (每源字符的 em × 公式缩放)。
 * 以默认值为例：96ch × 0.5em ÷ (0.5em × 0.95) ≈ 101 个源字符/行。
 */
export const DISPLAY_LINE_BUDGET = Math.floor(
  (FORMULA_BOX_CH * LAYOUT.BODY_CH_EM) / (LAYOUT.MATH_CHAR_EM * LAYOUT.FORMULA_SCALE),
)

/** V6 过滤用到的精确凭证集合（顺序稳定 ⇒ 输出确定，SPEC §7.5） */
const V6_HIDDEN_EVIDENCE = PRECISE_EVIDENCE

/** 生成 V6 直觉层规则：每条精确凭证一条属性选择器，不使用脚本。 */
function v6Rules() {
  const contract = V6_HIDDEN_EVIDENCE.map(
    (ev) => `[data-a4m-layer="${VIEW_LAYER.INTUITION}"] .a4m-anno[data-a4m-evidence="${ev}"] { display: none; }`,
  )
  const toggle = V6_HIDDEN_EVIDENCE.map(
    (ev) => `body:has(#${LAYER_TOGGLE_ID}:checked) .a4m-anno[data-a4m-evidence="${ev}"] { display: none; }`,
  )
  return { contract: contract.join('\n'), toggle: toggle.join('\n') }
}

/**
 * 完整样式表。
 *
 * 论文式版面 = 只有字号 / 字重 / 斜体 / 小型大写 / 居中缩进 / 留白：
 * **零 border、零 background、零 border-radius、零 box-shadow、零图标**（对齐参考论文的视觉手段）。
 * 唯一的例外是 V6 直觉层过滤用的 `display: none` 属性选择器——那条必须是 CSS。
 *
 * @returns {string}
 */
export function css() {
  const v6 = v6Rules()
  return `/*! ${CSS_FILENAME} — dsh-scholia 静态渲染样式（论文式版面，零装饰）
 *  命名：SPEC §1.4（a4m- 前缀 + BEM；节点 id a4m-n-…、注解 id a4m-a-…、data-a4m-… 属性）
 *  过滤：V6 直觉层用属性选择器实现，页面不含任何脚本。
 *  视觉手段只有：字号 / 字重 / 斜体 / 小型大写 / 居中缩进 / 留白。
 */
:root {
  --a4m-fg: #000;
  --a4m-muted: #555;
  --a4m-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  --a4m-serif: Georgia, "Times New Roman", "Songti SC", "Source Han Serif SC", serif;
}

body {
  margin: 0;
  color: var(--a4m-fg);
  font-family: var(--a4m-serif);
  font-size: 17px;
  line-height: 1.7;
}

/* ── 论文容器：单栏 72ch 居中 ───────────────────────────────────── */

.a4m-paper { max-width: ${LAYOUT.COLUMN_CH}ch; margin: 0 auto; padding: 3rem 1.25rem 4rem; }

/* ── 标题区 ─────────────────────────────────────────────────────── */

.a4m-paper__head { margin-bottom: 1.6rem; }
.a4m-paper__title {
  margin: 0 0 .5rem;
  text-align: center;
  text-transform: uppercase;
  letter-spacing: .03em;
  font-size: 1.3rem;
  font-weight: 700;
}
.a4m-paper__subtitle { margin: 0; text-align: center; font-variant: small-caps; font-size: .95rem; color: var(--a4m-muted); }

/* 数据质量说明：一行素净斜体（退化 / 截断必须可见，但不能是色块） */
.a4m-coverage { margin: .6rem 0 0; font-size: .82rem; font-style: italic; color: var(--a4m-muted); text-align: justify; }
.a4m-coverage--step { font-size: .78rem; }

/* 直觉层开关（V6 的无脚本入口；素色小字，不是按钮） */
.a4m-layer-toggle { display: block; margin-top: .6rem; text-align: center; font-size: .78rem; color: var(--a4m-muted); cursor: pointer; }
.a4m-layer-toggle__input { margin: 0 .4em 0 0; }
.a4m-layer-toggle__label { color: var(--a4m-muted); }

/* ── 摘要（两侧缩进的 abstract）─────────────────────────────────── */

.a4m-abstract { margin: 1.8rem 2.5em 0; }
.a4m-abstract .a4m-anno__seg { text-align: justify; text-indent: 1.5em; }

/* ── 目录 ───────────────────────────────────────────────────────── */

.a4m-contents { margin: 2.4rem auto; max-width: 34rem; }
.a4m-contents__title { margin: 0 0 .8rem; text-align: center; font-variant: small-caps; letter-spacing: .25em; font-size: .95rem; font-weight: 700; }
.a4m-contents__list { list-style: none; margin: 0; padding: 0; }
.a4m-contents__link { display: flex; gap: .6em; align-items: baseline; color: inherit; text-decoration: none; font-size: .88rem; line-height: 1.7; }
.a4m-contents__page { margin-left: auto; color: var(--a4m-muted); font-size: .8rem; white-space: nowrap; }
.a4m-contents__item { }
.a4m-contents__label { }
.a4m-contents__item--sub .a4m-contents__link { padding-left: 2em; font-size: .82rem; color: var(--a4m-muted); }

/* ── 章标题（居中、小型大写、带编号）────────────────────────────── */

.a4m-section { margin-top: 2.6rem; }
.a4m-section__title { margin: 0 0 1.1rem; text-align: center; font-variant: small-caps; letter-spacing: .08em; font-size: 1.05rem; font-weight: 700; }
.a4m-section__ref { color: inherit; text-decoration: none; }

/* ── 定理块 ─────────────────────────────────────────────────────── */

.a4m-theorem { margin: 0 0 1.2rem; }
.a4m-theorem__head { margin: 0; font-size: .95rem; font-weight: 700; }
.a4m-theorem__decl { margin-left: .6em; font-family: var(--a4m-mono); font-size: .74rem; font-weight: 400; color: var(--a4m-muted); }
.a4m-theorem__label { }
.a4m-theorem__refs { margin: .25rem 0 0; font-size: .8rem; font-style: italic; color: var(--a4m-muted); }
.a4m-theorem__ref { color: inherit; }

/* LEAN 源：默认折叠（原生 details，零 JS），小号小型大写、无边框底色 */
.a4m-lean { margin: .3rem 0 0; }
.a4m-lean__summary { font-size: .72rem; color: var(--a4m-muted); cursor: pointer; }
/* 字距在最后一个字后面也留一份空隙，用负边距抵消：标签与全角括号之间不该有空格 */
.a4m-lean__label { font-variant: small-caps; text-transform: uppercase; letter-spacing: .1em; margin-right: -.1em; }
.a4m-lean__pre { margin: .45rem 0 0; font-family: var(--a4m-mono); font-size: .74rem; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }

/* ── 编号公式：居中公式 + 右对齐编号 ────────────────────────────── */

/* 公式块比正文宽一档：公式重的页面里，给公式更多横向空间比把正文拉成超长行、
   或把公式缩成脚注都更合适。窄屏不外扩，同时把公式字号降一档，
   使 (栏宽+外扩)×0.95 与 栏宽×0.86 的每行容量一致——同一套折行预算在两种宽度下都成立。 */
.a4m-equation { position: relative; margin: 1.1rem 0; text-align: center; }
@media (min-width: 62rem) { .a4m-equation { margin-inline: -${LAYOUT.FORMULA_BLEED_CH}ch; } }
/* 字号挂在我们自己的容器上（KaTeX 的 katex-display 类不属于 a4m- 命名，不直接选它）：
   公式内部一律用 em，缩放容器即可整体缩放，行内公式不受影响（那是 .a4m-math）。 */
.a4m-equation--wide .a4m-equation__body { font-size: ${LAYOUT.WIDE_FORMULA_SCALE}em; }
@media (max-width: 62rem) { .a4m-equation__body { font-size: ${LAYOUT.NARROW_FORMULA_SCALE}em; } }
/* 折行优先：公式在顶层关系符处折成 aligned（见 html.mjs），这里不做横向裁切。
   只有实在没有断点的超宽公式才允许滚动，且渲染层会给一行可见提示。 */
.a4m-equation__body { display: inline-block; max-width: 100%; font-size: ${LAYOUT.FORMULA_SCALE}em; }
.a4m-equation--wide .a4m-equation__body { overflow-x: auto; }
.a4m-equation__no { position: absolute; right: 0; top: 50%; transform: translateY(-50%); font-size: .85rem; white-space: nowrap; }
.a4m-equation__ref { color: inherit; text-decoration: none; }
.a4m-step { margin: 0 0 .8rem; }

/* ── 证明环境（斜体引导词 + 右对齐的证毕符号）───────────────────── */

.a4m-proof-lead { margin: 1rem 0 .2rem; font-style: italic; }
.a4m-qed { margin: 1.2rem 0 0; text-align: right; }
.a4m-note { margin: .5rem 0; font-size: .85rem; font-style: italic; color: var(--a4m-muted); }

/* ── 注解 = 论文的 remark：粗体 run-in 引出词 + 正文（无框、无底色、无缩进块）── */

.a4m-anno { margin: .55rem 0 0; }
.a4m-anno__seg { margin: 0 0 .3rem; font-size: .93em; text-align: justify; text-indent: 1.5em; }
.a4m-anno__seg--concept { }
.a4m-anno__seg--reasoning { }
.a4m-anno__lex { font-style: italic; color: var(--a4m-muted); }
.a4m-anno__lex--missing { font-style: italic; color: var(--a4m-muted); }
.a4m-anno__lead { font-weight: 700; color: inherit; text-decoration: none; }
.a4m-anno--orphan .a4m-anno__lead { font-style: italic; }

/* ── 陈述未知（v1.3 的 signatureUnknown）：说明一行 + 原文块 ─────────
 * 原文块与 Lean 源块同款式（等宽小字），但独立命名——改 Lean 块不会误伤它。 */

.a4m-unknown { }
.a4m-unknown__raw { margin: .4rem 0 0; font-family: var(--a4m-mono); font-size: .74rem; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }

/* ── 数学：KaTeX 服务端渲染 + 等宽回退 ──────────────────────────── */

.a4m-math { }
.a4m-math--display { display: block; margin: .4rem 0; text-align: center; }
.a4m-math-fallback { font-family: var(--a4m-mono); font-size: .88em; white-space: pre-wrap; word-break: break-word; }

/* ── 页脚：一行出处 ─────────────────────────────────────────────── */

.a4m-paper__foot { margin-top: 3rem; font-size: .75rem; color: var(--a4m-muted); }
.a4m-paper__prov { margin: 0; font-family: var(--a4m-mono); font-size: .72rem; }
.a4m-paper__note { margin: .3rem 0 0; font-size: .75rem; }

/* ── V6：直觉层过滤（属性选择器，不写脚本）───────────────────────
 * 二期只需给容器加 data-a4m-layer="${VIEW_LAYER.INTUITION}" 即可复用同一套规则；
 * 一期用下面的 :has() + checkbox 提供等价的无脚本开关。 */

${v6.contract}

${v6.toggle}
`
}
