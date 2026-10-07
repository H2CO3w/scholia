# 模块接口冻结表（INTERFACES）

> **性质**：**冻结**。本表在实现期间不得单方面修改。需要变更时通知 Lead，由 Lead 更新本表并广播。
> **依据**：[SPEC.md](./SPEC.md)（契约与规则）、[ARCHITECTURE.md](./ARCHITECTURE.md)（分层与目录）
> **版本**：`spec_version = 1.0.0`

---

## 0. 全局规则

### 0.1 命名：契约 snake_case ⇄ JS camelCase

| 位置 | 命名法 |
|---|---|
| 落盘 JSON、工具参数、工具输出 | `snake_case` |
| `src/core/**`、`src/io/**`、`src/render/**` 内部的 JS 对象字段与函数 | `camelCase` |

**转换只允许出现在 `src/io/contract.mjs` 的 `toCamel` / `toSnake`**（规则 L5，有测试强制）。
**枚举的「值」是数据不是键**，两侧都是 `snake_case` 字符串（`'core_idea'`、`'tactic-multiline'`），不参与转换。

### 0.2 分层

```
src/tools/  →  { src/io/, src/net/, src/render/ }  →  src/core/
```

`src/core/**` 与 `src/render/**` 禁止 import `node:fs` / `node:net` / `node:sqlite` / `fetch` / `@deepseek-ai/*`（L1）。
`node:crypto` **允许**（纯计算，确定性）。
只有 `src/tools/**` 可以 import `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/schemastery`（L3）。

### 0.3 枚举

一律从 [`src/core/enums.mjs`](../src/core/enums.mjs) 取值（L4）。**禁止任何模块内联枚举字面量。**

---

## 1. 核心数据形状（JS 侧 camelCase）

```jsonc
// SkeletonNode（SPEC §2.1）
{ "id": "n0", "decl": "Mathlib.…", "kind": "have", "signature": "…",
  "typeFingerprint": "sha256:…", "hypotheses": ["a"], "parent": null,
  "lemmaRefs": ["Even.add"], "source": "lsv2", "truncated": false }

// SkeletonTree（SPEC §2.2，coverage 7 字段 @ v1.1）
{ "theorem": "Mathlib.…", "root": "n0", "nodes": { "n0": {…} },
  "coverage": { "mode": "tactic-multiline", "haveCount": 2, "nodeCount": 3,
                "truncated": false,  "truncateReason": null,   // 记录被 500 字符截断
                "degraded": false,   "degradeReason": null } } // degraded ⇔ haveCount === 0
// SkeletonNode 条件字段（只在适用时出现，不适用则**整个键缺省**）：
//   kindUnknown?: true       声明种类未知/缺失
//   signatureUnknown?: true  ★ v1.3 类型标注在源码中省略（`have h := 项`），签名无法恢复
//                           此时 signature === "" 且 typeFingerprint === null
//   rawText?: string         ★ v1.3 该项的逐字原文（如 `have h := foo a b`），供下游在陈述未知时使用
//   localName?: string       ★ v1.3 have/let 的局部名（如 "h"），使 hyp 锚点可指到它
// coverage 第 8 个字段（v1.3）：
//   signatureMissingCount: number   本树中 signatureUnknown 的节点数（诚实计数，可观测规模）

// Anchor（SPEC §2.3）
{ "kind": "goal", "target": "n3", "fingerprint": "sha256:…" }

// Annotation（SPEC §2.4）
{ "id": "a7", "node": "n3", "role": "step",
  "valueType": "technique",        // 仅 role=step；必填，none 合法
  "culture": "problem",            // 仅 role=step；未命中时**整个键缺省**
  "height": "frog",
  "evidence": "formal", "significance": "main", "presentation": "paraphrase",
  "audience": "grad-math",
  "segments": [ { "kind": "concept", "text": "…", "lexiconRef": "Even.add" },
                { "kind": "reasoning", "text": "…" } ],
  "anchors": [ { "kind": "goal", "target": "n3" } ],
  "refs": ["a5"],
  "provenance": { "model": "deepseek-flash", "ts": "2026-10-07T…", "run": "pilot-01" } }

// Ledger（SPEC §2.5）
{ "specVersion": "1.0.0", "mathlibBaseline": "v4.28.0-rc1", "theorem": "Mathlib.…",
  "skeleton": {…}, "annotations": [ {…} ],
  "metrics": { "nodeCount": 4, "annotatedNodeCount": 3, "mainCoverage": 0.75,
               "anchorPrecision": 1.0, "conceptCoverage": null },
  "provenance": { "run": "pilot-01", "created": "2026-10-07T…" } }

// Diagnostic（SPEC §4.1）
{ "index": 2, "annotationId": "a7", "rule": "V7",
  "code": "V7_VALUE_TYPE_REQUIRED", "field": "valueType",
  "message": "role=step 必须显式给出 value_type；若这一步没有可提炼的思路，请填 \"none\"" }

// ValidationReport
{ "ok": false, "total": 5, "passed": 4, "failed": 1,
  "diagnostics": [ Diagnostic ], "truncated": false }
```

**`null` 与 `0` 语义不同**（SPEC H2）：指标"没算"必须是 `null`。

---

## 2. 模块清单与签名

### 2.1 `src/core/enums.mjs` — ❄️ 已冻结（Lead）

```js
export const NODE_KIND, SOURCE, PROOF_MODE, ROLE, VALUE_TYPE, CULTURE, HEIGHT,
             EVIDENCE, SIGNIFICANCE, PRESENTATION, AUDIENCE, SEGMENT_KIND,
             ANCHOR_KIND, FORM                       // 冻结对象，用 ROLE.STEP 取值
export const NODE_KIND_VALUES, ROLE_VALUES, …        // 对应的值数组
export const ROLE_ORDER                               // 呈现顺序
export const THEOREM_LEVEL_ROLES                      // 锚点必须指向 root 的 role
export const LENGTH_LIMIT                             // role → 字数上限
export const ROLE_DEFAULT_HEIGHT                      // role → 默认 height
export const EVIDENCE_RANK, SIGNIFICANCE_RANK
export const PRECISE_EVIDENCE, METAPHOR_ALLOWED_EVIDENCE, STRONG_ANCHOR_KINDS
export function isEnumValue(values, value): boolean
export function allowedHint(values): string           // 错误消息用
export const SPEC_VERSION, MATHLIB_BASELINE
```

### 2.2 `src/core/credential.mjs` — Lead

```js
/** V1–V16 规则码 */
export const RULE   // { V1:'V1', …, V16:'V16' }

/** 单条注解校验（V1–V16 中与该条相关的全部） */
export function validateAnnotation(ann, skeleton, knownAnnotationIds?: Set<string>): {
  ok: boolean,
  diagnostics: Diagnostic[],      // index 由调用方补
  claimable: boolean,             // V6：可否作推理前提
  evidenceRank: number,
  significanceRank: number,
  length: { used: number, limit: number },   // V9
}

/** 批量校验（规范入口；工具层用这个） */
export function validateAnnotations(annotations, skeleton, opts?: { maxDiagnostics?: number }): ValidationReport

/** 「不信开关」的可机械判定 */
export function beliefBoundary(annotations, skeleton): {
  claimable: string[], nonClaimable: string[], invalid: string[]
}

/** SPEC §3.2 的计长：正文汉字数，公式与代码不计 */
export function countTextLength(segments): number
```

### 2.3 `src/core/skeleton.mjs` — skeleton 负责人

```js
export const VALUE_TRUNCATION_LIMIT = 500
export const TRUNCATION_SUSPECT_THRESHOLD = 490

export function fingerprint(text): string                       // 'sha256:…'
export function classifyProof(value): {
  mode: string,           // PROOF_MODE 之一
  degraded: boolean,
  degradeReason: string|null,
  haveCount: number,
}
export function extractHypotheses(signature): string[]
/**
 * ★ 输入必须是「以 `:= by` 或 `by` 开头的 tactic 证明体」，**不是整个 .lean 文件**。
 *   喂错东西**不抛错**，而是返回 { supported: false, reason: 'not-tactic-body' | 'empty-input', bindings: [] }。
 *   ⚠️ 这个前提曾把测量搞乱（同一份语料反复得出 0 / 42 / 0 三个矛盾结论）——`reason` 就是为区分
 *   「喂错了」与「真是空的」而加的（v1.3）。
 */
export function extractHaveBindings(proofText): {
  supported: boolean,
  reason: 'empty-input' | 'not-tactic-body' | null,   // null = 确是 tactic 体但没有 have
  bindings: {
    localName: string,
    signature: string,
    depth: number,
    signatureUnknown: boolean,   // v1.3：该项类型标注被省略（`have h := 项`）
  }[],
}
export function extractLemmaRefs(nodeBody): string[]
export function recordToSkeleton(record, opts?: { origin?: string }): SkeletonTree
export function isEvaluationSafe(record): boolean
```

**`id` 稳定性（硬要求）**：`n0` 为根；其余按证明体中出现的 **DFS 前序**编号 `n1, n2, …`。同一 `(theorem, value)` 任意次调用必须产出相同 id 集合。嵌套 `have` 的 `parent` 是**紧邻的外层 have**（缩进栈），不是恒为 root。

### 2.4 `src/core/anchor.mjs` — skeleton 负责人

```js
/**
 * 规范化一个锚点。
 * ★ 必须同时接受两种输入（这是 SPEC §2.3 的落点，也是 credential.mjs 的硬依赖）：
 *     1. Anchor **对象**（权威形式，SPEC §2.3）：{ kind: 'decl'|'goal'|'hyp'|'display', target: string, fingerprint?: string }
 *     2. 遗留字符串形式：'goal:n1' / 'decl:Mathlib.…' / 'hyp:ha' / 'display:L120'
 *   返回规范化后的内部锚点，或 null（无法解析）。**禁止只接受字符串形式。**
 */
export function parseAnchor(input): object | null

export function resolveAnchor(parsed, skeleton): {
  ok: boolean, kind: string|null, target: string|null, reason: string|null,
}

/** 解析语义（credential 的 V1/V3/V4/V12 全部依赖它）：
 *    decl → 某节点的 decl 等于 target
 *    goal → skeleton.nodes 中存在 target 这个节点 id
 *    hyp  → 某节点的 hypotheses 含 target
 *    display → **永不 ok**（行号不可作锚点，V4 据此拒绝）
 */
export function validateAnchors(anchors, skeleton): {
  results: { raw: any, ok: boolean, kind: string|null, target: string|null,
             reason: string|null, strong: boolean }[],
  hasStrong: boolean,
  total: number, validCount: number, strongCount: number, allValid: boolean,
}
```

`hasStrong` 与每个 result 的 `strong` 依据 `STRONG_ANCHOR_KINDS`（decl/goal）判定。

`SkeletonTree` 不再携带 `declIndex` / `hypothesisIndex`；需要时由 `resolveAnchor` 遍历 `skeleton.nodes` 现算。

### 2.5 `src/core/lexicon.mjs` — core-io 负责人

```js
export function normalizeLemmaName(name): string
export function shapeEntries(entries, opts: { maxEntries: number, descriptionChars: number }): {
  entries: { name: string, module: string|null, kind: string|null, signature: string,
             informalName: string|null, informalDescription: string|null,
             descriptionTruncated: boolean }[],
  missing: string[],          // ★ 未命中必须显式列出（SPEC T2）
  truncated: boolean,
}
```

### 2.5b `src/io/lexicon-resolve.mjs` — core-io 负责人（★ v1.2 新增，单一实现）

**背景**：`annotation_check` 与 `annotate_submit` 曾各自实现一份「哪些 `lexicon_ref` 可解析」，结果**两次分叉**（第一次 dry-run 严于 submit，第二次 submit 被首尾空格绕过）。同一个判定存在两份实现必然漂移——这与 SPEC §4.1「禁止第二份校验逻辑」是同一条纪律。

```js
/**
 * 返回 `refs` 中**可解析**的原始串集合，供 `validateAnnotations(..., { lexiconNames })` 使用。
 * ★ 集合里放的是**原始串**（core 用 `has()` 原样匹配），判定用的是 **trim 后**的名字。
 * ★ 单一实现：两个工具都必须调它，禁止各自再写一份。
 *
 * @param {string} dbPath  cache/lexicon.db
 * @param {string[]} refs  本批注解里所有 segment.kind==='concept' 的 lexicon_ref（可含重复）
 * @returns {Set<string>|null}  refs 为空 → null（调用方据此跳过查库）
 * @throws 索引不可用时抛错（**禁止降级成弱化模式**：那会让 SPEC V10 的红线静默失效）
 */
export function resolvableLexiconNames(dbPath, refs): Set<string> | null
```

判定规则（必须同时满足才放进集合）：
1. `name.trim()` 不在 `lookupLemma(...).missing` 里 —— **必须先 trim 再比对**（`lookupLemma` 内部 trim 后查询，`missing` 里存的是 trim 后的名字；用原始串比对会让 `" X "` 这种带空格的伪造名漏网）；
2. 另把 `found` 里的**契约名**也放进集合，兼容 `_root_.X` / `` `X` `` 这类归一化写法。

### 2.6 `src/io/contract.mjs` — core-io 负责人

```js
export function toCamel(value): any     // 深转换，snake_case 键 → camelCase
export function toSnake(value): any     // 深转换，camelCase 键 → snake_case
export function slugify(decl: string): string   // 'Mathlib.Algebra.Group.Even.add' → 同名；'/' → '_'
```

### 2.7 `src/io/corpus.mjs` — core-io 负责人

```js
/** 流式逐行读，**不得全量载入内存**（R5） */
export async function * streamRecords(corpusPath, opts?: { signal?: AbortSignal }): AsyncGenerator<object>

/** 按 name.join('.') 精确查找第一条匹配 */
export async function findRecord(corpusPath, declName, opts?: { signal?: AbortSignal }): Promise<object|null>
```

### 2.8 `src/io/index-db.mjs` — core-io 负责人

```js
/** 惰性建索引；已存在且非 rebuild 时直接返回 */
export async function ensureLexiconIndex(opts: {
  corpusPath: string, dbPath: string, rebuild?: boolean, signal?: AbortSignal,
}): Promise<{ count: number, built: boolean }>

export function lookupLemma(dbPath, names: string[]): {
  found: object[],            // 原始行
  missing: string[],
}
```

SQLite 用 `node:sqlite` 的 `DatabaseSync`。表 `lemma(name TEXT PRIMARY KEY, module TEXT, kind TEXT, signature TEXT, informal_name TEXT, informal_description TEXT)`。

### 2.9 `src/io/artifacts.mjs` — core-io 负责人

```js
export function artifactPath(outputDir, kind: 'skeleton'|'ledger'|'render', declName): string
export async function readSkeleton(outputDir, declName, opts?: { signal? }): Promise<SkeletonTree>  // 不存在则抛错
export async function writeSkeleton(outputDir, declName, skeleton): Promise<string>                 // 返回写入路径
export async function readLedger(outputDir, declName, opts?: { signal? }): Promise<Ledger|null>     // 不存在返回 null
export async function writeLedger(outputDir, declName, ledger): Promise<string>
export async function writeRender(outputDir, declName, html): Promise<string>   // out/render/<slug>.html；html 非字符串抛 TypeError
```

**`writeRender` 说明**（2026-10-07 增量，原 5 个签名未动）：路径必须走 `artifactPath(outputDir,'render',declName)`，**io 层保留唯一路径决定权**；tmp + rename 原子写；HTML 不是契约 JSON，**不做** snake/camel 转换（L5 只管契约键）。加它的理由：此前 `ledger_export` 在工具层自己 mkdir/writeFile 拼路径，属分层泄漏，改目录约定时会漏改。

### 2.10 `src/render/html.mjs` + `assets.mjs` — render 负责人

```js
// assets.mjs
export const CSS_FILENAME = 'a4m.css'
export function css(): string

// html.mjs
export function renderLedgerHtml(ledger): string       // 完整 HTML 文档
export function renderAssets(): { [CSS_FILENAME]: string }
```

**硬要求**：双向锚点（`#a4m-n-<id>` ⇄ `#a4m-a-<id>`）、类名 `a4m-` 前缀、`data-a4m-*` 属性、V6 用 CSS 属性选择器做直觉层过滤、**纯字符串生成不碰 DOM**。

### 2.11 `src/tools/*.mjs` — shell 负责人（前三个）/ render 负责人（后三个）

每个模块导出**一个**注册函数，返回 `ctx.tools.register` 的 disposer：

```js
export function registerAnnotationCheck(ctx, config): () => void
export function registerConceptLookup(ctx, config): () => void
export function registerSkeletonExtract(ctx, config): () => void
export function registerAnnotatePrepare(ctx, config): () => void   // render 负责人
export function registerAnnotateSubmit(ctx, config): () => void    // render 负责人
export function registerLedgerExport(ctx, config): () => void      // render 负责人
```

### 2.12 `index.js` — shell 负责人

```js
export const name = 'dsh-scholia'
export const inject = ['tools']
export const Config = z.object({ … })          // 见 §3
export function apply(ctx, config)             // 全部注册包在 ctx.effect 内
```

### 2.13 `Config` 形状（冻结）

```js
import z from '@deepseek-ai/schemastery'
export const Config = z.object({
  corpusPath:       z.string(),
  cacheDir:         z.string(),
  outputDir:        z.string(),
  maxEntries:       z.natural().default(8),     // concept_lookup 单次返回上限
  descriptionChars: z.natural().default(600),   // 单条描述截断长度
  maxNodes:         z.natural().default(40),    // skeleton_extract 返回节点上限
  maxDiagnostics:   z.natural().default(50),    // annotation_check 诊断上限
})
```

---

## 3. 文件所有权（写作用域，互不重叠）

| 负责人 | 独占写入路径 |
|---|---|
| **Lead** | `src/core/enums.mjs`（已冻结）、`src/core/credential.mjs`、`test/credential.test.mjs`、`docs/INTERFACES.md`、最终集成 |
| **skeleton** | `src/core/skeleton.mjs`、`src/core/anchor.mjs`、`test/skeleton.test.mjs`、`test/anchor.test.mjs` |
| **core-io** | `src/io/**`、`src/core/lexicon.mjs`、`test/contract.test.mjs`、`test/io.test.mjs` |
| **shell** | `package.json`、`cordis.patch.yml`、`index.js`、`locale/**`、`src/tools/annotation-check.mjs`、`src/tools/concept-lookup.mjs`、`src/tools/skeleton-extract.mjs`、`test/layers.test.mjs` |
| **render** | `src/render/**`、`src/tools/annotate-prepare.mjs`、`src/tools/annotate-submit.mjs`、`src/tools/ledger-export.mjs`、`test/render.test.mjs` |

**不修改他人文件。** 发现他人文件有 bug → 用 `send_message` 通知所有者或 Lead，不要直接改。

---

## 4. 完成判据

| 层 | 判据 |
|---|---|
| 全部 | `cd ai4math && node --test`（自动发现）全绿 |
| `core` / `render` | `test/layers.test.mjs` 的 L1–L5 全过 |
| `credential` | V1–V16 **每条至少一个「应当拒绝」用例 + 一个「应当通过」用例** |
| `io` | 对真实 `data/lsv2.jsonl` 跑通：流式读不超内存、索引可查、产物可回读 |
| `tools` | `install_bundle` 返回 `application: applied`；`cordis_inspect_query` 的 `Tool.listTools` 能看到工具；实际调用 `annotation_check` 成功 |

---

## 附录 G：依赖图谱子系统（v1.4，新增）

**为什么需要**：现有产出的单位是**一个声明 = 一页**。而"完整证明"是一棵依赖树——实测 [openai/NavierStokesAndEuler](https://github.com/openai/NavierStokesAndEuler)：**2,659 个模块 / 6,105 条项目内 import 边**，从 `Euler` 出发的**完整可达锥是 1771 个节点**（BFS 深 27）。论文的 165 页对应的就是这棵树；我们只渲染了其中一个节点。

**数据源必须是真实 Lean 源码，不是 lsv2**：实测 lsv2 的证明体被砍在 500 字符，平均出度只有 **2.02**（p50=1），CHSH 的依赖锥只有 3 个节点。`import` 是显式的、完整的，所以**模块级图今天就能建**。

### G.1 分层与零脚本的例外

| 产物 | 脚本 | 用途 |
|---|---|---|
| **论文视图** `out/render/*.html` | **仍然零 `<script>`**（不变） | 读：一个声明的注解材料 |
| **图谱视图** `out/graph/*` | 允许带 JS（**本期仍是静态 SVG，零脚本**） | 找：整棵证明树的结构与导航 |

> **这是 SPEC §7.3「不新增 session event」之外，本项目第二处有意的性质放宽**：论文视图的零脚本、自包含、确定性**保持不变**；图谱视图允许带脚本（vendored、不联网），因为平移/缩放/点击下钻在静态 HTML 里做不到。**本期图谱仍是静态 SVG，所以零脚本暂时还没被破。**

### G.2 `src/io/lean-imports.mjs` — core-io 负责人

```js
/** 扫描 Lean 源码树，抽出模块级依赖图。纯 I/O，不做布局。 */
export async function scanLeanImports(rootDir, opts?: { signal?: AbortSignal }): Promise<{
  modules: string[],                                  // 全限定模块名，如 'Euler.BaseEulerParity'
  edges: { from: string, to: string, external: boolean }[],  // external = 指向项目外的模块（Mathlib 等）
  stats: { fileCount: number, internalEdges: number, externalEdges: number },
  docstrings: Record<string, string>,   // ★ v1.4：模块 → 文件头的 `/-! … -/` 说明（空白已折叠）
}>
```
- 模块名 = 相对 `rootDir` 的路径去掉 `.lean`、`/` 换 `.`
- `import X.Y.Z` 且 `X.Y.Z` 在本树内 → `external: false`；否则 `external: true`
- **只读，不改仓库**

### G.3 `src/core/depgraph.mjs` — render-tools 负责人（纯函数）

```js
/** 建图 + 分层 + 定序。输入输出都是纯数据。 */
export function buildDepGraph({ modules, edges }, opts?: {
  rootId?: string,        // 指定根；给了就只保留它的依赖锥
  maxDepth?: number,      // 层数上限
  maxNodes?: number,      // 节点上限（超了按层截断并如实报告）
}): {
  nodes: { id: string, layer: number, order: number, inCone: boolean, external: boolean }[],
  edges: { from: string, to: string }[],
  layerWidths: number[],
  stats: {
    nodeCount: number, edgeCount: number, maxWidth: number,
    truncated: boolean, truncatedReason: string|null,   // ★ 截断必须如实报告（H5）
  },
}

/** 依赖锥：从 root 可达的节点集合 */
export function coneOf(graph, rootId, opts?: { maxDepth?: number }): Set<string>
```

**分层**：`layer(v) = root 到 v 的最长路径长度`（最长路径让边尽量同向、跨层少）。
**定序**：层内用重心法（barycenter）减少交叉——上层邻居 `order` 的平均值排序，迭代几轮。

### G.4 `src/render/graph.mjs` — render-tools 负责人（纯字符串）

```js
export function renderDepGraphSvg(graph, opts?: {
  nodeHeight?: number, columnWidth?: number, maxLabelChars?: number,
}): string
export function renderGraphAssets(): Record<string, string>   // 内联 CSS，供 SVG 内嵌
```

**必须**：
- 输出**单文件自包含 SVG**（内嵌 `<style>`，不引外部资源）
- 层为**列**（左 → 右 = 依赖方向），节点为圆角矩形，边为三次贝塞尔
- **图例**：项目内 / Mathlib 边界 / 当前锥 三类节点的区分
- 节点标签过长时截断（`maxLabelChars`）并保留 `title`（悬停可见全名——**这是零脚本也能有的原生交互**）
- 样式复用论文视图的语言：同一套衬线/配色变量，**不引入深色主题**（这是论文项目的图谱，不是游戏引擎皮肤）
- 颜色只用已有变量 + 中性灰阶；仍**不得**用 border-radius 之外的装饰堆砌（图谱本身是例外场景，允许描边填充）

### G.4b `collapseGraph` — 折叠（v1.4，render-tools 负责人，纯函数）

**为什么折叠而不是删除**：实测 Euler 锥 1771 节点 / 3838 边——

| 维度 | 测量 | 说明 |
|---|---|---|
| 传递冗余边 | 297（**7.7%**） | 删掉不改变可达性 → **删边救不了** |
| 纯管道节点（入=1 出=1） | 242（**13.7%**） | 改名/转述 |
| ≤100 行的小模块 | 944（**53% 的节点，仅 32% 的行数**） | 技术引理的长尾 |
| `EulerProof` 单文件 | 20,756 行（**占总行数 10.1%**） | 论证本身 |

**结论：图论意义上的修剪最多省 20%，正确的操作是折叠（collapse）而非删除（prune）。**

```js
export function collapseGraph(graph, opts?: {
  sizes?: Record<string, { lines: number, decls: number }>,  // 由调用方提供（core 不做 I/O）
  collapseChains?: boolean,     // 默认 true
  chainMinLength?: number,      // 链长 ≥ N 才收缩，默认 3
  collapseSmall?: boolean,      // 默认 true
  smallLineThreshold?: number,  // 默认 100
  clusterFamilies?: boolean,    // 默认 true：按命名族聚类（Bounds/Budget/Estimate…）
}): {
  nodes: { id, layer, order, inCone, external,
           group?: { kind: 'chain'|'small'|'family', members: string[], count: number,
                     lines: number, label: string } }[],
  edges: { from, to }[],
  layerWidths: number[],
  stats: { nodeCount, edgeCount, maxWidth, collapsedNodeCount, absorbedNodeCount,
           truncated, truncatedReason },
}
```

**链收缩（series reduction）**：
- 找**极大路径** `v₁ → v₂ → … → vₖ`，其中 **v₂..v_{k-1} 的入度与出度都为 1**
- 整条路径收缩成**一个**节点；`v₁` 与 `vₖ` **并入该节点**（它们只在链上时才吸收）
- `chainMinLength = 3` 表示**只收缩长度 ≥3 的链**（即至少吸收 1 个中间节点），避免把普通的两跳也吞掉
- 标签形如 `A → … → Z（12 个模块）`；`title` 里给**完整模块序列**

**顺序：先链收缩（精确、按度），再小模块聚类（启发式）**。反过来的话聚类会改变度、影响链的判定。

**诚实披露（H5）**：每个折叠节点必须
- `group.count` / `group.members`（完整成员名，供 `title` 与将来的展开）
- `data-a4m-collapsed="<kind>"` 与 `data-a4m-members="<count>"`
- 页面上的标签必须**自报**（`94 个模块 · 技术估计`），不许看起来像一个普通模块
- 展开是下一期（交互）的事；**本期折叠后不提供展开**，所以成员名必须留在 `title` 里

### G.6 主线与大纲（v1.4）—— ★ 这一节才是「方便理解的结构」

**背景（实测）**：Euler 锥 1829 个模块。前面所有做法都失败：

| 做法 | 为什么不行 |
|---|---|
| 全图节点链 | 20728×1252，宽高比 24.7:1，任何缩放都不可读 |
| 折叠小模块 | 1771 → 867，**仍然不可读** |
| 最长路径当主线 | 根有 7 个直接依赖，最长路径只走一条，**另外六支 1599 个模块全挂第 0 站** |
| 把模块挂到主线某站 | 依赖**高度共享**，模块能绕过主线到达，**归属无从定义** |
| **每站「带来」多少** | **望远镜求和，天然是划分** ✅ |

**★ 根必须是「论文结果所在的模块」，不是顶层聚合文件。** 实测（这两个模块是**兄弟，互不包含**，所以选错了整张图都不同）：

| 根 | 锥 | heaviest 主线 | 根站有说明吗 |
|---|---|---|---|
| `Euler`（`Euler.lean`，一行的 `import` 聚合文件） | 1771 | 75 站 | **没有** ❌ |
| **`Euler.Solution`（`Euler/Solution.lean`，`euler_breakdown_R3` 在这里）** | **1829** | **82 站** | 有 ✅ |
| `NavierStokes`（聚合文件） | 753 | 57 站 | **没有** ❌ |
| **`NavierStokes.ComparatorSolution`** | 609 | — | 有 ✅ |

根取自 `formalization.yaml` 的 `main_results[].file` / `alignment.statements[].module`——**那是仓库自己对「论文结果在哪」的声明**，不要用顶层的 `Euler.lean`（它只是 `import Euler.EulerSingularity`，且没有模块说明，会把首站渲染成空标题）。

**主线的定义**：从根出发，**每步选子树（模块数）最大的依赖**（`heaviest`）。以 `Euler.Solution` 为根实测 **82 站**，子树 100% → 0.1% 单调下降。

**每站带来** = `|subtree(p_i)| − |subtree(p_{i+1})|`。实测 **1829 = Σ 各站带来，无重复无遗漏、无零站**（中位数 6，最大 224 = `Euler.PacketInitializedCorrectionData`）。

**`mode: 'longest'` 的更正**（我先前在任务书里写错了）：望远镜恒等式对**任何**路径都成立（后继子树是前驱子树的子集），所以它的问题**不是数学上不成立，而是分区退化**。实测以 `Euler.Solution` 为根的真最长路径 = **97 个节点**。

> ⚠️ **不要用「最大层号子节点」贪心实现 `longest`**——层号是最长入路径，沿边递增但**不保证走到最深**，会走进死胡同（实测只得到 16 站）。正确做法是贪心「**剩余高度**最大的子节点」，实测给出 94 / 97，与真最长路径**一致**。

```js
// src/core/depgraph.mjs
export function mainLine(graph, opts?: {
  rootId?: string,
  mode?: 'heaviest' | 'longest',   // 默认 'heaviest'
}): {
  stations: { id: string, index: number, subtreeSize: number, addedCount: number }[],
  totalModules: number,
  coveredModules: number,          // ★ 必须 === totalModules（望远镜划分的性质，要断言）
}
```

```js
// src/render/outline.mjs（新增）
export function renderOutlineHtml(outline, opts?: {
  docstrings?: Record<string, string>,
  mergeBelow?: number,      // 把「带来 ≤ N」的相邻站合并成一条（粒度旋钮，默认 0 = 不合并）
  title?: string,
}): string
```

**渲染要求**：
- **竖向单栏**，一站一行；每行 = `序号 · 模块短名` + **作者说明** + `+N 个模块`
- **零 `<script>`**（本期）；样式沿用论文视图的衬线与配色，**不要深色主题**
- `+N` 的相对大小用一个细横条表示（纯 CSS 宽度或内联 SVG），**一眼看出细节堆在哪几站**
- 附件明细本期**不展开**（下一期交互）；每行带 `data-a4m-station="<模块名>"`、`data-a4m-added="<N>"`
- 说明缺失时如实写「（无模块说明）」，**不得编**
- 合并模式下，合并后的行要标明它合并了几站、合计带来多少

### G.6b 每站成员页（v1.4）—— 「这一部分关联哪些证明」的答案

**`+N` 是集合的大小,不是集合。** 集合由望远镜差给出,而且是**完整分解**：

```js
members(p_i) = sub(p_i) \ sub(p_{i+1})      // 第 i 站需要、而它最重的依赖不需要的模块
```

| 性质 | 依据 |
|---|---|
| 良定义 | 集合差,不依赖遍历顺序 |
| 互不重复 | `sub(p_{i+1}) ⊂ sub(p_i)` |
| 无遗漏 | 并集 = 整个锥（**这正是 `Σ addedCount === totalModules` 恒等式成立的实质**） |

**实测这些集合是成组的**（47 个成员数 ≥5 的站）：主导命名族占比中位数 **60%**，**85% 的站 ≥30%**，**没有一站 <15%**。例：站 20 `BasePacketLowBounds`（+84）成员清一色是基础 Euler 解与流；站 53 `MeanPacketData`（+63）清一色 `Mean*`。

```js
// src/core/depgraph.mjs
export function stationMembers(graph, outline, opts?: { rootId?: string }): {
  stationId: string, index: number,
  members: string[],          // 完整模块名
  totalMembers: number,
}[]

// src/render/outline.mjs
export function renderStationPage(outline, station, opts?: {
  docstrings?: Record<string, string>,
  sizes?: Record<string, { lines: number, decls: number }>,
  prev?: { index: number, id: string } | null,
  next?: { index: number, id: string } | null,
  outlineHref?: string,
}): string
```

**页面内容（只放数学,与大纲同一原则）**：
- 标题：`序号 · 模块短名`
- **本站的作者说明**
- **成员清单**：每条 = 模块短名 + **该模块自己的作者说明**
- 排序：**按命名族分组,组内按短名字典序**（可预测,且读起来是一份按主题组织的清单）；排序规则写进 README
- 说明缺失 → 如实写「（无模块说明）」,**不得编**
- **上一站 / 下一站 / 返回大纲** 的链接（`<a href>`,零脚本即可跳转）
- **计数不上正文**（沿用「页面只放数学」）;成员数进 `data-a4m-*` 与 README

**产物布局**：
```
out/outline/<root>/index.html     大纲（= 现有大纲,内链到每站）
out/outline/<root>/NN.html        每站一页（NN 两位数,与序号一致）
out/outline/<root>/README.md      披露与口径（对应该 root）
```
大纲里每一站的名字变成指向 `NN.html` 的链接;每站页顶有返回大纲的链接。

**必须断言（这是本设计的立足点）**：
- `Σ 各页成员数 === totalModules === coveredModules`
- **没有任何模块出现在两页里**（互不重复）

### G.5 产物

```
out/graph/<root-module>.svg     ← 自包含 SVG，浏览器直接打开
out/graph/<root-module>.html    ← 极简包装：标题 + 图例 + 内联 SVG（零脚本）
```

**呈现方式（不要"优化"掉）**：SVG 按**固有尺寸**呈现，页面出滚动条；包装层的 `.a4m-graph-page` 用 `width: max-content`，标题块用 `position: sticky; left` 在横向滚动时吸附。

> ⚠️ **不要给 `.a4m-graph-page svg` 加 `max-width: 100%`。** 曾经这么写过，后果是 20728px 的图被压到窗口宽——**缩成约 8%，字全不可辨**，而且因为"装得下"连滚动条都不出现，用户第一反应就是"为啥不能放大"。**图谱是拿来逐节点看的，不是拿来看缩略图的。** 需要缩略图时应当另出一个显式的小图，而不是把主产物压小。
