# 初始架构（ARCHITECTURE）

> **文档地位**：**描述性文档（descriptive）**。本文说明系统**如何组织**；字段、命名、校验规则以 [SPEC.md](./SPEC.md) 为准。
> **版本**：对应 `spec_version = 1.0.0`
> **日期**：2026-10-07
> **配套**：[SPEC.md](./SPEC.md)（规范）、[README.md](./README.md)（文档地图）、[plan-v1.0.md](../plan-v1.0.md)（判据推导）

---

## 1. 架构总览

### 1.1 一句话

**形式化对象原样不动，注解挂在旁边，每条注解带锚点与可信度标记。** 判据（`RD@K`）与校验器（V1–V16）独立于 DSH、独立于网络、独立于 Lean；插件只是让这套方法在 DSH 里可用的**薄适配器**。

### 1.2 分层图

```
                        ┌──────────────────────────────────────────┐
   DSH / Agent  ────────▶│  src/tools/     DSH 绑定层（薄壳）        │
   （模型可见的工具面）    │  annotation_check  skeleton_extract  …   │
                        └───────┬──────────┬──────────┬────────────┘
                                │          │          │
              ┌─────────────────▼──┐  ┌────▼──────┐  ┌▼─────────────┐
              │ src/io/            │  │ src/net/  │  │ src/render/  │
              │ 语料流式读          │  │ Loogle    │  │ Ledger→HTML  │
              │ SQLite 词典索引     │  │ LeanSearch│  │ （纯字符串）  │
              │ 产物落盘            │  └────┬──────┘  └┬─────────────┘
              └─────────────────┬──┘       │          │
                                └──────────┴──────────┘
                                           │
                              ┌────────────▼─────────────────┐
                              │ src/core/   ★ 零依赖纯逻辑     │
                              │ skeleton  anchor  credential  │
                              │ roundtrip  lexicon            │
                              └───────────────────────────────┘
                                    无 DSH / 无网络 / 无 LLM / 无 fs
```

**依赖方向单向向下，不允许反向或跨层**（SPEC §5）。

### 1.3 与 DSH 的边界

| DSH 侧概念 | 本项目的用法 |
|---|---|
| Cordis 插件 | 一个 Host-only bundle，`export function apply(ctx, config)` |
| `ctx.tools.register` | 注册 8 个一期工具的唯一入口 |
| `Config` | 语料路径、工作目录、各类上限；由 patch 层覆盖 |
| Session log | **不写**。注解账本是文件产物（SPEC §7.3） |
| Client slot | **一期不用**。二期坐 `sidebar.right.tab.document` |
| `systemPrompt.section()` | **一期不用**（SPEC T5）。唯一例外见 §8.3 |

---

## 2. 目录结构

```
ai4math/
├── package.json              ← bundle 清单（dsh.bundle.patch）
├── cordis.patch.yml          ← 插入插件行
├── index.js                  ← apply(ctx, config)：注册工具
├── locale/{en,zh}.json       ← 插件卡片显示文案
│
├── docs/                     ← 本目录：SPEC / ARCHITECTURE / README
├── plan-v1.0.md              ← 研究记录（判据推导）
├── decisions.md              ← 已拍板决策 D1–D8
│
├── data/
│   └── lsv2.jsonl            ← ✅ 已下载 332 MB / 310,579 条
├── cache/
│   └── lexicon.db            ← SQLite 索引（node:sqlite，惰性构建）
├── out/                      ← 全部产物（不入包）
│   ├── skeleton/  ledger/  render/  report/
│
├── src/
│   ├── core/                 ← ★ 纯函数，零依赖
│   │   ├── skeleton.mjs      ← 证明体 → SkeletonTree（含 coverage）
│   │   ├── anchor.mjs        ← 锚点解析 + V4/V12 校验
│   │   ├── credential.mjs    ← 三轴模型 + V1–V16 全部规则
│   │   ├── roundtrip.mjs     ← K 路题构造 + RD@K 评分
│   │   ├── lexicon.mjs       ← 词典条目的纯逻辑（查找、归一化）
│   │   └── enums.mjs         ← ★ 枚举闭集唯一来源（SPEC §3）
│   ├── io/
│   │   ├── corpus.mjs        ← 流式读 lsv2.jsonl（不全量载入）
│   │   ├── index-db.mjs      ← node:sqlite 索引构建与查询
│   │   ├── artifacts.mjs     ← out/** 落盘与读取
│   │   └── contract.mjs      ← ★ snake_case ⇔ camelCase 唯一转换点
│   ├── net/
│   │   └── search.mjs        ← Loogle / LeanSearch 适配
│   ├── render/
│   │   ├── html.mjs          ← Ledger → 并排 HTML（双向锚点）
│   │   └── assets.mjs        ← a4m.css 内联生成
│   └── tools/                ← DSH 绑定层，工具定义在这里
│       ├── annotation-check.mjs
│       ├── concept-lookup.mjs
│       ├── skeleton-extract.mjs
│       ├── annotate-prepare.mjs
│       ├── annotate-submit.mjs
│       ├── roundtrip-eval.mjs
│       ├── ledger-export.mjs
│       └── mathlib-search.mjs
│
└── test/                     ← node --test
    ├── core.test.mjs
    ├── credential.test.mjs   ← V1–V16 每条一个用例
    ├── contract.test.mjs
    └── layers.test.mjs       ← ★ 强制 L1–L5（SPEC §5.2）
```

### 2.1 为什么包根是 `ai4math/` 而不是 `ai4math/annotator/`

- plan-v1.0 §8.2 已经把目录定在这里，改动会与既有代码冲突。
- 依赖方向是 `src/tools → src/core`，跨目录会逼出 `../` 形式的跨包 import。
- `install_bundle` 按绝对路径链接目录，不复制文件，所以 `data/` 的 332 MB 不会进包。
- `package.json` 必须声明 `files` 白名单，保证 `npm pack` 结果干净：

```jsonc
"files": ["index.js", "src/**", "cordis.patch.yml", "locale/**", "README.md"]
```

> 若 `install_bundle` 因目录内 `data/` 体量或结构报错，退路是拆出 `ai4math/annotator/`，并把 `src/core` 作为 `file:` 依赖声明。**先按单目录试，报错再拆。**

---

## 3. 插件打包与生效

### 3.1 bundle 清单

```jsonc
// ai4math/package.json
{
  "name": "dsh-scholia",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./index.js",
    "./locale/*.json": "./locale/*.json",
    "./package.json": "./package.json"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "files": ["index.js", "src/**", "cordis.patch.yml", "locale/**", "README.md"]
}
```

**注意三点**（相对 v2.1 §8.1 与前置文档 §2.1 的简化）：

1. **无 `main`**——Host-only bundle 直接以 `exports["."]` 指向源码，不需要 `lib/` 构建产物。
2. **无构建脚本、无 install script、无 dependencies**（SPEC §7.1）。
3. **无 `dsh.client`**——一期不做客户端，因此不引入前端构建链（前置文档 §2.5、v2.1 §8.5）。

### 3.2 补丁层

```yaml
# ai4math/cordis.patch.yml
- insert:
    - id: dsh-scholia
      name: 'dsh-scholia'
      config:
        corpusPath: /home/shiro/文档/deepseek-harness/default-workspace/ai4math/data/lsv2.jsonl
        cacheDir:   /home/shiro/文档/deepseek-harness/default-workspace/ai4math/cache
        outputDir:  /home/shiro/文档/deepseek-harness/default-workspace/ai4math/out
```

**绝对路径写在 patch 层，不写在代码里**——用户的 patch 层跨升级存活（SPEC §7.2）。

### 3.3 生效链路（**两步，不是四步**）

```
① plugin_manager install_bundle(target = /…/ai4math 的绝对路径)
      ↓ 一步完成：包安装 + bundle 加入 profile
② 确认返回的 application 字段
```

**不要**手改 profile 的 `package.json`、**不要**手改 `dsh.profile.bundles`、**不要**在 profile 目录跑 pnpm——`install_bundle` 会做这些，手做既需要单独审批，又会被后续安装覆盖。v2.1 §8.4 与前置文档 §2.4 描述的四步链路已不是当前机制。

`application: applied` 才算生效；`restart-required` 表示没生效；替换已安装包必须重启才能加载新的 JS 模块。

### 3.4 验证

安装后用 `cordis_inspect_query`（`provider: Tool`, `method: listTools`）确认工具已出现在模型可见的工具集中——它不需要审批，比翻 `list_plugins` 直接。然后**实际调用一次** `annotation_check`。

### 3.5 ★ 已知集成约束：工作区 link 插件无法解析 `@deepseek-ai/*`（真机实测）

**这是本项目在真机上第一个卡住安装的问题，必须知道。**

症状：`install_bundle` 返回 `application: "failed"`，诊断只有一句 `dsh-scholia: failed to import`，看不到真实原因。在 profile 目录里直接 `import('dsh-scholia')` 才拿到真错误：

```
Cannot find package '@deepseek-ai/schemastery' imported from /…/ai4math/index.js
```

根因（两层）：

1. pnpm 把插件以 **`link:`** 装进 profile，Node 解析 import 时**还原到真实路径**（`/…/ai4math`），向上逐级找 `node_modules` 永远到不了 profile 的 `node_modules`。
2. 即使到了 profile 的 `node_modules` 也没用：**`@deepseek-ai/dsh-tools` 只存在于 DSH 安装目录**，profile 的 `node_modules/@deepseek-ai` 下只有 `cosmokit` 与 `schemastery`。

旁证：`dsh-tavern` 是工作区里另一个 link 安装的插件，但它**从不 `register` 工具、也不 import 任何 `@deepseek-ai/*`**，所以这条路径此前从未被走过——**没有先例可抄**。

解法：让插件目录自己有 `node_modules`。运行

```bash
node scripts/link-dsh-deps.mjs
```

它在 `ai4math/node_modules/@deepseek-ai/` 下建立指向 DSH 安装目录的符号链接（自动发现安装位置，不写死路径）。该目录**是集成必需项，不要删除**；`install_bundle` 重跑后如被 pnpm 清掉，重跑一次脚本即可。

> 每次改完 `package.json` 或重新 `install_bundle` 之后，若工具没有出现，**先检查这两个软链是否还在**。

#### 3.5.1 ★ 改完插件代码后，**必须重启 Harness 进程**才生效（真机实测）

**这是第二个会让人误判"改动没起作用"的坑，而且是静默的**（工具照样能调用，只是跑的是旧代码）。

实测结论：在 link 安装的插件目录里改 JS 之后——

| 操作 | 是否加载新代码 |
|---|---|
| 直接编辑 `src/**` 文件 | ❌ 否 |
| `set_bundle` 关掉再打开 | ❌ 否（只重跑 `apply()`，模块不重新 import） |
| `remove_bundle` + 重新 `install_bundle`（会重跑 pnpm） | ❌ 否 |
| **重启 Harness 进程** | ✅ 是 |

判定方法（不靠猜）：把「磁盘上直接 import 该模块得到的输出」与「通过工具调用得到的输出」对比。实测 `skeleton_extract("Even.add")` 在磁盘代码已产出 7 字段 `coverage` 之后，工具仍返回旧的 5 字段——**返回值不同即证明进程持有旧模块代**。

> 实践含义：**验收必须在重启后的进程里做一次**。安装成功 ≠ 你看到的工具是新代码。这条与 host-plugin.md 的「替换已安装包需要重启才能加载新的 JS 模块代」一致，对 link 安装的目录同样成立。

### 3.6 ★ 已知集成坑：`output.schema` 的 object 节点必须显式 `additionalProperties`

`defineTool` 在**注册期**校验 schema。写成 `{ type: 'object' }` 会让 `apply()` 直接抛错，**整个 bundle 起不来**（表现与 3.5 一模一样，都是 `failed to import`，很容易误诊）。

正确写法：`{ type: 'object', additionalProperties: true }`。本文档 §4.1 的示例早期版本就是错的，已订正——它曾导致三个工具整体注册失败。

---

## 4. 工具面

### 4.1 工具注册形态

```js
// src/tools/annotation-check.mjs
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { validateAnnotations } from '../core/credential.mjs'
import { readSkeleton, toCamel } from '../io/contract.mjs'

export function registerAnnotationCheck(ctx, config) {
  return ctx.tools.register(defineTool({
    name: 'annotation_check',
    description: '校验一批注解是否满足规范 V1–V16，返回逐条诊断。不写盘。',
    parameters: {
      theorem_name: { type: 'string', required: true, description: '全限定 Lean 声明名' },
      annotations:  { type: 'array', required: true, items: { type: 'object' },
                      description: '待校验的注解数组，字段见 SPEC §2.4' },
    },
    output: {
      // ★ object 节点必须显式 additionalProperties：否则 defineTool 在**注册期抛错**，
      //   整个 bundle 起不来（真机踩坑，见 §3.6）。
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const skeleton = await readSkeleton(config.outputDir, args.theorem_name, exec.signal)
      return validateAnnotations(toCamel(args.annotations), skeleton)
    },
  }))
}
```

`Config` 只在 `index.js` 声明一次，工具模块只接收 `config` 对象。

### 4.2 工具职责与依赖

| 工具 | 层依赖 | 读取 | 写入 | 确定性 |
|---|---|---|---|---|
| `annotation_check` | core, io | `out/skeleton/*.json` | — | 完全确定 |
| `concept_lookup` | core, io | `cache/lexicon.db` | 首次触发建索引 | 完全确定 |
| `skeleton_extract` | core, io | `data/lsv2.jsonl` | `out/skeleton/*.json` | 完全确定 |
| `annotate_prepare` | core, io | `out/skeleton`、`cache/lexicon.db` | — | 完全确定 |
| `annotate_submit` | core, io | `out/skeleton`、`out/ledger` | `out/ledger/*.json` | 确定（输入相同时） |
| `roundtrip_eval` | core, io, net | `out/ledger`、`cache/lexicon.db` | `out/report/**` | 确定（固定种子） |
| `ledger_export` | render, io | `out/ledger`、`out/skeleton` | `out/render/**` | 完全确定 |
| `mathlib_search` | net | — | 可选缓存 | 依赖外部服务 |

### 4.3 输出有界的具体做法

| 工具 | 界限 | 超限行为 |
|---|---|---|
| `concept_lookup` | `maxEntries`（默认 8）、`descriptionChars`（默认 600） | 截断描述，返回 `missing[]` 与索引路径 |
| `skeleton_extract` | `maxNodes`（默认 40） | 返回根 + 摘要 + `full_path` |
| `annotate_prepare` | `maxLexiconEntries`（默认 6） | 超出不内联，返回 `concept_lookup` 提示 |
| `annotation_check` | 诊断条数上限 | 返回前 N 条 + `truncated: true` + 总数 |

---

## 5. 数据流

### 5.1 三条主流程

**(a) 词典构建（一次性，惰性触发）**

```
data/lsv2.jsonl  流式逐行读（不全量载入，R5 15GB 内存约束）
    ↓ 抽 {name, module, kind, signature, informal_name, informal_description}
cache/lexicon.db   SQLite 建表写入（node:sqlite）
    ↓
concept_lookup 按 name 精确查询
```

索引在首次 `concept_lookup` 调用时构建，之后只读。语料更新后由 `rebuild: true` 参数重建。

**(b) 骨架提取**

```
theorem_name
    ↓ 从 lsv2 取该条记录
    ↓ 检查 truncated（≥490 字符视为截断，H3）
core/skeleton.mjs  parseProofBody(value)
    ├─ tactic 多行 + have  → 缩进栈建树         → mode: tactic-multiline
    ├─ tactic 单行          → 只有根节点          → mode: tactic-single, degraded
    ├─ calc / rw 链         → 链式节点（二期扩展） → mode: tactic-multiline
    └─ term-mode            → 只有根节点          → mode: term, degraded
    ↓ 节点 id 由 DFS 路径序号决定（跨调用稳定，SPEC §2.1）
    ↓ 每个节点抽 lemma_refs（供概念查询）
out/skeleton/<slug>.json
```

**退化不是错误，是常态**（SPEC §2.2 / H5）。`coverage.degraded = true` 必须一路上传到 `annotate_prepare`，让模型据此把注解降级为对陈述本身的说明。

**(c) 注解生成（三段式，无隐藏 LLM 调用）**

```
① annotate_prepare(scope=theorem)   → 工作单：定理级
   agent 生成 ①核心想法 ②问题 ③鸟瞰 ⑤评注 ⑥负空间
② annotate_prepare(scope=step, node_id=n3)
   agent 生成该节点的 ④步骤注解（带 value_type / culture / height）
③ annotate_submit(theorem, annotations)
   → V1–V16 逐条校验 → 通过则合并进 out/ledger/<slug>.json
   → 被拒的条目返回修复动作，agent 重写后再次 submit
```

**逐节点调用**（v2.1 §7.3）：一次性输出全部注解会拖长输出、降低后段质量，且锚点极易错位。本架构用 `node_id` 作为**输入**从结构上排除了错位。

**生成序与呈现序分离**（推翻 v2.1 §7.3 第 1 轮的做法）：

| 序 | 顺序 |
|---|---|
| **生成序** | 先逐节点（②）→ 再定理级（①），最后写核心想法 |
| **呈现序** | 核心想法最前 → 问题 → 鸟瞰 → 步骤 → 评注 → 负空间 |

理由：核心想法若先生成，会成为后续所有注解的锚定（anchoring），把"每一步各自的价值"压成"服务于那句话的解释"，违反 A1。生成序上最后写它，此时最有把握概括；呈现序上仍放最前（Zagier 的要求是呈现序）。

### 5.2 判据回路（不依赖 Lean）

```
样本池（完整未截断的 tactic 证明）
    ↓ 构造 K 路判别题（K0 碰撞组 / K2 LeanSearch 近邻）
    ↓ agent 只读注解层作答
roundtrip_eval → RD@K + C_concept + 锚点有效率
    ↓ 与人类 informal_description 基线对比（tfidfName 50.4%，必须超越）
out/report/<run>/roundtrip.json
```

**按 K 分层报告是强制的**，禁止混合平均——混合平均会同时掩盖"任务太容易"和"基线实现有 bug"两类问题（pilot/report-m1.md §1 的实测教训）。

---

## 6. 前端架构

### 6.1 一期：静态 HTML 渲染器（服务端生成）

```
out/ledger/<slug>.json  +  out/skeleton/<slug>.json
    ↓ src/render/html.mjs（纯字符串，不碰 DOM）
out/render/<slug>.html  +  out/render/assets/a4m.css
```

**版面**：左栏证明骨架（节点按层级缩进），右栏注解（按 `role` 分组）。**双向锚点**：

```html
<!-- 节点侧：跳到锚定它的注解 -->
<section id="a4m-n-3" data-a4m-node="n3">
  <pre class="a4m-node__stmt">…</pre>
  <a class="a4m-node__jump" href="#a4m-a-7">注解 ↓</a>
</section>

<!-- 注解侧：跳回锚定节点 -->
<article id="a4m-a-7" data-a4m-anno="a7"
         data-a4m-role="step" data-a4m-evidence="formal"
         data-a4m-value-type="technique" data-a4m-height="frog">
  <p class="a4m-anno__seg a4m-anno__seg--concept" data-a4m-lexicon="Even.add">…</p>
  <p class="a4m-anno__seg a4m-anno__seg--reasoning">…</p>
  <a class="a4m-anno__jump" href="#a4m-n-3">证明 ↑</a>
</article>
```

**视图过滤（V6）**：`evidence ∈ {formal, literature, unfolding}` 的条目在 `data-a4m-layer="intuition"` 视图下隐藏。用 CSS 属性选择器实现，不写脚本：

```css
[data-a4m-layer="intuition"] .a4m-anno[data-a4m-evidence="formal"] { display: none; }
```

**为什么一期用静态 HTML 而不是 Markdown**：v2.1 的 D5 要求"阅读下钻入口"，而 **Markdown 做不了双向跳转**。静态 HTML 同时是二期的渲染蓝本——二期把同一份 `html.mjs` 的输出结构搬进 React 组件即可，类名、id、data 属性完全复用（SPEC §1.4）。

### 6.2 二期：DSH 客户端插件（不在本期）

| 项 | 取值 |
|---|---|
| 入口 | `client.js`，`exports["./client"]` |
| 清单 | `dsh.client = { platform: "web", inject: ["@deepseek-ai/dsh-client-ui-conversation"], immediately: false }` |
| 主视图 seat | `sidebar.right.tab.document`，key = `dsh-scholia.ledger` |
| 面板入口 | `sidebar.panellist`，id = `a4m-ledger` |
| 工具结果卡 | `tool.call.toolview`，key = `annotation_check` |

**约束**（沿用 SPEC §1.4 同一套前缀）：

1. **不 import 任何 Harness Client 包**（含 `@deepseek-ai/dsh-client-ui-primitives`）。`dsh.client.inject` 的条目只用于激活排序。
2. **样式只用主题 token** `--dsw-alias-*`；类名沿用 `a4m-` 前缀。
3. **不写 DOM**，不 append 到 `document.body`；一切通过 slot 组件。
4. `sidebar.right.tab.document` 是 keyed slot，注册 key 用 SPEC §1.4 的固定值。

> ⚠️ 二期开工前**必须重新执行一次 client slot 检查**确认 key 与注册参数——上表来自 `spec_version 1.0.0` 时的实时拓扑。

### 6.3 一期与二期的兼容承诺

| 承诺 | 内容 |
|---|---|
| 数据不变 | 二期读同一份 `out/ledger/*.json`，不新增中间格式 |
| 命名不变 | 类名、元素 id、data 属性一期即按二期规则写（SPEC §1.4） |
| 不变量 | 一期渲染器的 `html.mjs` 是纯函数——二期可把它当作"输出结构参考"，但不是运行时依赖 |

---

## 7. 分层强制的实现

`test/layers.test.mjs` 静态扫描源码，逐条断言 SPEC §5.2：

```js
const FORBIDDEN_IN_CORE = [/node:fs/, /node:net/, /node:sqlite/, /\bfetch\s*\(/, /@deepseek-ai\//]
const FORBIDDEN_IN_RENDER = [/node:fs/, /node:net/, /\bfetch\s*\(/, /@deepseek-ai\//]

test('L1: core 与 render 零外部依赖', async () => {
  for (const dir of ['src/core', 'src/render'])
    for (const file of await glob(`${dir}/**/*.mjs`)) {
      const src = await readFile(file, 'utf8')
      for (const re of FORBIDDEN_IN_CORE) assert.ok(!re.test(src), `${file} 违反 L1: ${re}`)
    }
})

test('L3: 只有 src/tools 可以 import dsh-tools', async () => { /* … */ })
test('L4: 枚举字面量只在 enums.mjs 出现', async () => { /* … */ })
test('L5: snake/camel 转换只在 io/contract.mjs', async () => { /* … */ })
```

**L1/L2 是 decisions.md D1 的工程前提**：`src/core` 是方法本体，第三方必须能在不装 DSH、不联网、不装 Lean 的环境下独立复现它。这条约束一旦破，项目就从"方法"退化成"插件"。

---

## 8. 扩展点选择的依据

### 8.1 为什么用 `ctx.tools.register` 而不是更"强"的机制

DSH 的扩展点按强度递增：`restrict` < `guard` < waterfall 监听 < `systemPrompt/assemble`。**用最弱的、够用的那个**：

| 需求 | 选择 | 不用什么 |
|---|---|---|
| 暴露能力给模型 | `ctx.tools.register` | —— |
| 约束注解格式 | **工具内部校验**（V1–V16） | ❌ 不用 `systemPrompt`——提示词不是校验器 |
| 限制危险操作 | 一期无危险操作 | ❌ 不用 `guard` |
| 每个 agent 不同行为 | 一期不需要 | ❌ 不用 `agent.ctx` |

**"校验器必须是代码不是提示词"是本项目的方法论核心**（plan-v1.0 §8.1）。用 `systemPrompt` 表达 V1–V16 等于把机械约束退回成祈求。

### 8.2 为什么一期不做客户端 UI

客户端插件的改动只有在 `pnpm run dev:web` 同时运行时才能免刷新生效，会引入整条前端构建链（前置文档 §2.5、v2.1 §8.5）。一期的交付物是**文件**（JSON + HTML），不是 GUI 页面。

### 8.3 `systemPrompt.section()` 的唯一用例

SPEC T5 要求"每条事实只说一次"。一期**不使用** `systemPrompt.section()`，**唯一例外**是将来需要声明一条跨工具的全局红线（"引理语义只能来自 `concept_lookup`"）。此时只加**一段一句话**，其余全部留在工具描述里。`dsh-tool-workflow` 有先例：它把用法指引注册为该工具自己的 prompt section。

---

## 9. 里程碑与验收

对应 plan-v1.0 §9，并纳入 v2.1 的注解类型学。

| # | 里程碑 | 产出 | 验收标准（可判定） | 状态 |
|---|---|---|---|---|
| **M0** | 事实收口 | `plan-v1.0.md` §1 实测表 | ✅ 已完成 | ✅ |
| **M1** | 判据立住 | `core/roundtrip.mjs`、`pilot/report-m1.md` | ✅ K0 可构造（5,427 题）、可解（50.4% > 随机 25.6%）、不送分（nameLex 12.7%）。**剩余**：用真实 agent 注解层跑一次，须 > 50.4% | 🟡 部分 |
| **M2** | **validator 立住** | `core/credential.mjs` + `core/enums.mjs` + `annotation_check` | V1–V16 每条有测试；**故意注入的违规注解 100% 被抓** | ⬜ |
| **M3** | 插件可见 | `index.js` + `cordis.patch.yml` + `concept_lookup` + `skeleton_extract` | `install_bundle` 返回 `application: applied`；`listTools` 能看到工具；**实际调用成功一次** | ⬜ |
| **M4** | 端到端切片 | `annotate_prepare` / `annotate_submit` / `roundtrip_eval` / `ledger_export` | 20 条定理产出 `Ledger`；`main_coverage`、锚点有效率、`RD@K` 全部产出；报告标注哪些结论未做真人校准 | ⬜ |
| **M5** | Lean 接入（二期） | `lean_skeleton` / `lean_typecheck` | 真 Lean 项目抽骨架成功；指纹漂移检测有效 | ⛔ |

**验收标准的改动（相对 v2.1 §9）**：

- M2（原 M2 骨架提取）的验收从"**20 个样本的节点树人工看过，可用**"改成**二元指标**：`(覆盖率, 准确率)`。理由：实测含 `have` 的 tactic 证明只占 3.8%，"挑 20 个能建树的样本人工看"必然通过，但证明不了任何覆盖率。覆盖率必须在**随机抽样**上测。
- 新增 M3 的"**实际调用成功一次**"：仅安装成功不等于模型能用。

**M1 优先于 M3 的理由**（decisions.md D1）：判据是方法的验证器。**先证明能测，再证明能写。**

---

## 10. 风险与缓解（架构视角）

| # | 风险 | 架构层的缓解 |
|---|---|---|
| R1 | **骨架覆盖率低**——含 `have` 的 tactic 证明仅 3.8%，term-mode 45.6% 结构未定义 | `coverage.degraded` 一路上传；M2 验收用二元指标；二期补 `calc`/`rw` 链解析 |
| R2 | 语料 332 MB 超内存（本机 15 GB） | `io/corpus.mjs` 流式逐行读；索引落 `node:sqlite`，不全量载入 |
| R3 | 模型编造引理含义 | `concept_lookup` 是唯一来源；V10 强制概念段带 `lexicon_ref`；未命中显式返回 `missing[]` |
| R4 | 模型编造不存在的"思路" | `value_type = none` 是**必填表态**（V7），不是可选项；§7.4 第 4 条保留在 `constraints` 输出里 |
| R5 | 可信度传染 | 三轴 + V1–V16 机械校验；`null` 与 `0` 区分（H2）；一期静态 HTML 用属性做视图隔离（V6） |
| R6 | 锚点在版本升级后静默失效 | `type_fingerprint` + **行号永不作为锚点**（V4）；`id` 由 DFS 路径决定，跨调用稳定 |
| R7 | 客户端需 `dev:web` | 一期只做服务端 |
| R8 | LLM 调用成本 | `annotate_prepare` 一次一个节点 → 每次调用 = 一个 tool call，成本完全可见可估 |
| R9 | 风格路由覆盖不足 | `culture` **可缺省**（未命中就不标）；`style_examples: null` + `reason`，不硬套 |
| R10 | 注解层无人工校准 | 报告必须标注未校准项（H4）；多标注者一致性纳入 M4 |

---

## 11. 未决与后续

| # | 事项 | 归属 |
|---|---|---|
| A1 | `calc` / `rw` 链解析，把可建树比例从 3.8% 拉高 | M2 之后 |
| A2 | 文化取向分类改用 `informal_description` 特征，替代 21.4% 覆盖率的 `module_name` | M4 之后 |
| A3 | 语义检索（LeanSearch 公开接口）接入 `concept_lookup` | 二期 |
| A4 | 对齐 Palomar 提交口径 | decisions.md D7：一期不对齐，M4 报告附映射关系 |
| A5 | 客户端 slot 形态复核 | 二期开工前 |
| ~~A6~~ | ~~`have` 局部名锚定（Q4）~~ ✅ **v1.3 已关闭**：`SkeletonNode.localName` 落地，`anchor.mjs` 的 `hyp` 按 `hypotheses ∪ localName` 命中 | 已完成（task-6） |
| A7 | `concept_lookup` 对 `X.mp` / `X.mpr` 的两段式回退 | 需由词典判定，不能在 core 里猜（`Iff.mp` 本身就是真名） |
| A9 | `readLedger` 校验**内嵌** `ledger.skeleton.specVersion`：ledger 自身的 `spec_version` 只保护文档格式，不保护内嵌骨架内容。**已裁定本次不改**——账本不是喂给模型的工作单输入（危害低于骨架），且下次 `annotate_submit` 会用新骨架自然覆盖（自愈） | 二期或账本开始跨版本流通时 |
| A8 | `writeRenderAssets(outputDir, assets)`：`out/render/assets/a4m.css` 目前由工具层拼 `'assets'` 目录并**非原子写**（SPEC §2.6 列为产物但 INTERFACES §2.9 无入口）。**已裁定本次不改**：一期只有一个 CSS、每次导出覆写，收益小于改动面 | 二期或 CSS 增多时 |

### 11.1 口径勘误：5,691 作废，67,175 为唯一权威

plan-v1.0.md §2.1 的「完整且含嵌套 have 的 tactic 证明 = **5,691**」在实现完成后**无法复现**：用「含 have 字样」= 5,288、「解析出 have」= 5,220、「≥2 个 have」= 1,087、「存在嵌套 have」= 66，最接近的候选也只有 5,570。该数字应来自更早的分析口径或更早的语料快照。

**处置**（诚实性要求 H2/H4）：不改写 plan-v1.0（它是研究记录），就地加 ⚠️ 勘误标记；**样本池以 `isEvaluationSafe` 的评测安全池 67,175 为唯一权威数字**——该语义已冻结并有测试钉住，全量精确复现。

### 11.0 ★ 一页 vs 一棵树（v1.4 图谱子系统的由来）

**问题**：现有产出的单位是**一个声明 = 一页**。用户问"一个完整证明不应该有特别多页吗"——应该，而且差距是量出来的：

| 表示 | 单位 | 规模 |
|---|---|---|
| 论文 | 页 | 165 |
| Lean 形式化（[openai/NavierStokesAndEuler](https://github.com/openai/NavierStokesAndEuler)） | 模块（.lean 文件） | **2,659** |
| 同上 | 项目内 import 边 | **6,105** |
| 从 `Euler` 出发的依赖锥 | 节点 / 层 | **1771**（BFS 深 27；最长路径分层后 94 列） |
| 我们渲染 | 声明 | **1** |

**论文的 165 页不是"一个证明体有 165 页"，而是这棵 1771 节点依赖树的展开。** 我们只渲染了其中一个节点——**差额是 1770 : 1**。

> ⚠️ **勘误（同一类错误第二次）**：本节初稿写的是「`Euler` 锥 790 节点 / 13 层」——那是**探针里 `if len(lv)>12: break` 截断后**的 BFS 计数，不是完整锥。正确数字是 **1771 节点 / BFS 深 27**。这跟 §2.1b 那次「只扫前 40,000 条记录当成全量」是同一个毛病：**把截断过的测量当完整测量报**。render-tools 独立复现时发现节点数对得上、层数对不上，才把它挖出来——**独立复现的价值正在这里**。以后报规模数字，探针里凡有 `break`/`limit` 一律在结论里写明。

**数据源必须换**：实测 lsv2 当不了图的数据源——

```
有出边的节点 33.2% ｜ 平均出度 2.02（p50=1）｜ 证明体被砍在 500 字符
CHSH 的依赖锥只有 3 个节点（它的证明体正好 500 字符，被截断）
```

`import` 是显式且完整的，所以**模块级图从真实源码建**，不从语料挖。

**★ 结论：图不是终点，「主线大纲」才是。** 试过并失败的做法全部记在案：

| 做法 | 结果 |
|---|---|
| 全图节点链 | 20728×1252，宽高比 **24.7:1**，任何缩放都不可读 |
| 折叠小模块 | 1771 → 867，**仍不可读** |
| 命名分组 | 592 组（名字是编译单元的产物，不一致） |
| 图聚类（标签传播） | 2 个巨块吞掉 1436/1771（密集网格） |
| 支配点 | 968 个节点不受任何瓶颈支配 |
| 最长路径当主线 | 根有 7 个直接依赖，只走一条 |
| 给模块做挂载归属 | 依赖高度共享，**归属无定义** |
| **每站「带来」多少（望远镜求和）** | ✅ **天然是划分** |

**最终做法**：主线 = 从根出发每步选**子树最大**的依赖；每站带来 = `|subtree(p_i)| − |subtree(p_{i+1})|`。以 `Euler.Solution` 为根实测 **82 站，Σ = 1829 = 锥内全部模块，无重复无遗漏、无零站**。每站挂**作者自己写的模块说明**（`/-! … -/`，实测 1838/1839 = 100%），所以每行是数学而不是 `PacketTailGradeBounds`。

**三条教训**（都是踩出来的）：
1. **根必须是「论文结果所在的模块」**，不是顶层 `import` 聚合文件。`Euler` 与 `Euler.Solution` 是**兄弟、互不包含**（锥 1771 vs 1829），而 `Euler.lean` 只有一行 import、**没有模块说明** → 首站渲染成空标题。
2. **并列规则要有第二档（子树行数）**。实测 `PacketTerminalPrimaryBudget` 与 `PacketJoinedUniformProfiles` 模块数完全相同（637），行数差 1,781——**光数模块会把主线引到"站多但内容薄"的分支**，这一处分岔决定后面多走 4 站。
3. **这一页是依赖序，不是论文的阅读顺序**（定理在前、机器在后；论文相反）。必须写在页面上，否则读者会读反。

**★ 反转之后暴露的两个更深问题**（都是用户一句"为什么要倒叙"引出来的）：

**① 主线终点是单体巨石。** `Euler/EulerProof.lean`：**20,756 行 / 1,211 条声明 / 98 个命名空间 / 91 个 import（项目内 0 个）/ 被 32 个模块依赖**。它在项目图里是**叶子**（不依赖任何项目内模块），反向却是**枢纽**。所以主线一路走到它，把它显示成「+1 个模块」——一个占全锥行数 **10.1%**、装着 1,211 条声明的文件，在"先建基础"的第一行标着不起眼的小数字。

**处理**：站点按**命名空间**展开成容器（显示前 K 个 + 其余合计），并标注其模块说明。**注意：巨石的模块说明可能过时**——`EulerProof` 的说明写的是「factorial majorants 的显式数值估计」，实际装了 98 个命名空间。**「用作者说明当正文」这个方案对单体文件失效**，必须如实标注而不能假装那句话覆盖了全部。

**② 巨石判定的阈值必须是「相对本树分布」的，不能是固定值。** 我给的固定阈值（声明 ≥60 或命名空间 ≥8）在 `NavierStokes` 上**命中 214 个站点**（30/58 全成"巨石"）——因为 NS 的文件系统性偏大，中位数就比 Euler 高一个量级。固定阈值在一边断崖清晰、在另一边等于没判。改成相对分布后：**容器展开 = 命名空间 ≥ 8；说明过时提示 = 声明数 ≥ 5× 本树站点声明数中位数**。实测 Euler 展开 1 个（`EulerProof` 1227/98），NS 展开 2 个（`CorrectionStep` 560/9、`CorrectionInitialization` 393/16）。

> **教训**：**任何绝对阈值都要先看它在每棵树上的分布**。"明显的巨石"在 A 树里是 1,227 条声明，在 B 树里 50 条就算大——固定值会把 B 树整片判成异常。

**③ 页面只放数学，记账进 README。** 用户（数学家视角）一句话点破：*"巨石文件 1227 条声明 / 94 个命名空间 / 20756 行……这些我作为数学家并不会关注"*，以及 *"怎么读这一页应该在 readme"*。

我一直在**同时服务两个读者**，结果把形式化记账（声明数、命名空间数、行数、中位数对比、"说明可能过时"）摆在了给数学家看的页面上。**正确分工**：

| 载体 | 内容 |
|---|---|
| **页面** | 只有数学：序号 + 模块短名 + **作者的说明**（+ 单体文件的分节名）。页面里唯一的数字是序号。 |
| **README** | 怎么读、口径（增量 vs 体量）、统计、已知局限、方法、复现命令 |
| **`data-a4m-*` 属性** | 全部机器可读信息——**属性是给机器读的，不影响页面观感** |

**披露一条都没丢，只是换了载体**（H5 要求的是"不隐瞒"，不是"写在页面上"）。

> ⚠️ **代价：README 成了唯一的披露载体，它出错就等于披露出错。** 实测就出过一次事故——README §2 举的例（"`Euler.Solution` 增量 224 是全锥最大"）与**同一文档 §3 的表格**（224 属于 `Euler.PacketInitializedCorrectionData`）自相矛盾。
>
> **根因与对策**：正文里的数字是**手写的常量**，而表格是从数据生成的。对策是**让正文的数字也从产物数据算出来**，并加**机核用例**（故意造「最大增量 ≠ 根站增量」的数据，断言三句话各归其位）。这类"正文写死一个数"的隐患从此从机制上堵住。

**产物与边界（v1.4 扩展）**：现在有**三种**产物，脚本政策按"读 / 找"分：

| 产物 | 脚本 | 用途 |
|---|---|---|
| 论文视图 `out/render/*.html` | **零 `<script>`** | 读一个声明的注解 |
| 站点页 `out/outline/<root>/NN.html` | **零 `<script>`** | 读一站的成员（相关联的证明） |
| 图谱 `out/graph/*`、大纲 `out/outline/<root>/index.html` | 可带脚本（自包含、不联网） | 找结构、展开/收起 |

**渐进增强是硬要求**：大纲的核心展开用原生 `<details>`，**不得出现"必须执行脚本才能到达某个页面"**。给数学家读的目录，脚本挂掉不该读不了。

**产物与边界**：图谱视图与论文视图是**两个产物、两种用途**——论文视图是"读"（零脚本保持不变），图谱视图是"找"（允许带脚本）。下一期：每个节点可点开，点开就是这个节点的论文页。见 SPEC §7.2b 与 INTERFACES 附录 G。

### 11.1a ★ 语料外测试暴露的静默缺陷（v1.3 的由来）

**背景**：我们所有的骨架提取测试都跑在 lsv2 记录上。lsv2 是**被 500 字符截断**的语料，且以短证明为主——它不构成真实 Lean 代码的分布。用 [openai/NavierStokesAndEuler](https://github.com/openai/NavierStokesAndEuler)（钉 Lean v4.34.0-rc2）的 30 个真实文件做语料外测试，一次就暴露了三个**静默**缺陷。

**第一个结果是好消息**：`recordToSkeleton` 在真实 Lean 上不报错，**节点计数 23/23 完全准确**，多行签名、多行证明体、完整未截断的证明都能处理。提取器没有崩，是**产出质量**有问题。

**三个缺陷（都不报错、不标记）**：

| # | 形态 | 现在产出 | 危害 |
|---|---|---|---|
| **A** | `have h := 项`（类型标注省略） | `signature: ""`，`degraded: false`，无标记 | `fingerprint("")` 是常数 → 所有这类节点**共享同一指纹** → 防漂移机制失效 |
| **B** | `have hd (s : ℝ) : T`（带绑定） | 绑定前缀被丢弃 → 命题从 `∀ s, T` 退化成 `T` | **被削弱却看着完全正常**，比 A 更阴险 |
| **C** | 任意 `have` | `localName` 未写到节点上 | `hyp` 锚点无法指到 have 的局部名 |

**关键**：**A 不是语料外才有的问题。** 同口径实测 lsv2 全量：

```
全量记录 310,579 ｜ 含 have 的记录 11,583 ｜ have 节点 17,829 ｜ 签名空串 4,959（27.8%）
```

**4,959 个节点是空壳**（占全部步骤节点的 27.8%）——它一直存在，测试全绿，从未被发现。

**为什么测试没抓到**：现有测试测的是**校验器**（V1–V16 管"注解合不合规"），从未测过**提取器的产出质量**（"节点是不是空的"）。这是两个不同的被测对象，前者全绿不代表后者正确。

**v1.3 的口径**（SPEC §2.1b 已冻结）：`signature` 保持 `""`（不知道就不编）、新增条件字段 `signature_unknown`、`type_fingerprint` 置 **`null` 而非空串哈希**、保留 `raw_text` 供下游使用、`coverage` 加 `signature_missing_count`。

**修复过程中又发现 4 条被 v1.2 误判的节点**：全量空签名数从 4,963 降到 **4,959**，这 4 条不是口径变化，而是 v1.2 把**多行类型声明**误判成了无类型（`:=` 落在顶层冒号 6 行以外）。改后它们的真签名被恢复，例如 `ProbabilityTheory.rnDeriv_posterior_ae_prod`、`CategoryTheory.ObjectProperty.ind_iff_exists`。**修 A 的过程本身又修掉了 4 条误报**——这是"先把规模标出来"的附带收益：不标出来，这 4 条永远不会被看见。

**一并修好的还有 1,254 处绑定前缀**（缺陷 B）：这些节点的签名此前都丢了量词。

> **指纹性质的正确表述**：不是"全树指纹唯一"——**同一命题在两个分支各证一次**时，两个 `have` 的签名相同，指纹**本就该相同**（那是防漂移语义本身）。真正的底线是：**`type_fingerprint` 是 `signature` 的函数**——空签名不再共享那个常数，非 null 指纹与签名一一对应。

**方法论产出**：建立 `test/fixtures/lean/`，用**语料外的真实 Lean** 做夹具，覆盖六种 `have` 形态。在此之前 `test/` 里一个语料外用例都没有——这正是这类缺陷能藏一整轮的原因。

> **一句话教训**：**测试语料的分布决定测试能看见什么。** 当被测对象是"从真实代码里提结构"，那么只喂一种被截断过的语料，等于把测试的上限钉死在那份语料的形状上。

### 11.1b 标注轴的实测信息量（R8 收口）

原计划 R8：「三维标注可能过度设计，M4 出结果后看是否真有用，**可砍**」。用演示账本（`CHSH_inequality_of_comm`，n=10：定理级 5 + 步骤 5）实测各轴分布：

| 轴 | 实测分布 | 判定 |
|---|---|---|
| `value_type` | concept 1 / technical 2 / structural 1 / **none 1** | ✅ **最有信息量**——步骤上 4 个取值全用上，直接告诉读者"这步可跳过" |
| `evidence` | formal 4 / unfolding 3 / literature 2 / intuition 1 | ✅ 驱动 V2/V3/V6，是真判断 |
| `significance` | main 5 / supporting 2 / context 3 | ✅ 驱动 V1 与 `anchor_precision` 指标 |
| `height` | bird 5 / frog 5，**100% 由 `role` 决定，无一例外** | ❌ **冗余**：实践中退化成 `role` 的复述 |
| `presentation` | paraphrase **10/10** | ❌ **恒定**：只有 `metaphor` 真正干活（触发 V2，是"不信开关"），`exact/paraphrase` 退化 |
| `audience` | grad-math **10/10** | ❌ **设计上就恒定**（D5 已固定交付目标） |
| `culture` | 缺省 9 / theory 1 | ⚠️ 近恒定（与 21.4% 覆盖率一致，见 A2） |

**三条结论**：

1. **`audience` 是恒定字段**。D5 已把交付目标固定为 `grad-math`，所以它承载零信息。这与之前砍掉 `certification:"构造的"` 是同一条理由——**一个对所有条目取同一值的字段不携带信息**。它本质上是**运行级**属性，不该挂在每条注解上。
2. **`height` 与 `role` 完全相关**。SPEC §3.1 特意写了"位置只影响默认值，**不要锁死**"，但实测 10/10 都取了 `ROLE_DEFAULT_HEIGHT`。这说明 Dyson 那一轴在**当前实现下**没有独立贡献。**但不要删**：保留它才有能力表达"某一步具有鸟瞰价值"（如"这一步引入 Yoneda，重心在此转移"）。正确做法是**显示规则**：只在偏离 role 默认值时显示。
3. **渲染层不该无差别地印出所有轴**。三个轴恒定或冗余时，读者看到的是同一排 chip 重复 N 次——纯噪音。

**已实施的显示规则**（数据与契约不动，只改显示；见 `src/render/html.mjs`）：

| 规则 | 效果 |
|---|---|
| 单值轴不显示 | 某轴在本账本只有一个取值 → 不渲染该 chip |
| `evidence` 仅在**不可作推理前提**时显示（∈ {analogy, intuition}） | formal/literature/unfolding 是常态，不占版面；警示才出现 |
| `height` 仅在**偏离 `ROLE_DEFAULT_HEIGHT`** 时显示 | 把这一轴的真实用途留出来：一旦出现就必有意义 |
| `value_type` 在步骤注解上始终显示 | 它是可操作的那一个（"可跳过"） |

> **待用户拍板的契约级改动**：是否把 `audience` 从 `Annotation` 下移到 `Ledger` 级（它是运行属性而非注解属性）。属 `spec_version` 变更，本轮只改显示、未动契约。

### 11.1c 语料外测量的做法（可复用）

§11.1a 的发现来自一次**一次性探针**（`.probe-ns/`，已清理）。方法本身值得留下，因为它能复现出那类缺陷：

1. **取真实仓库、不小改**：`raw.githubusercontent.com/<owner>/<repo>/main/<path>` 直接拉 `.lean`；注意仓库钉的 Lean/Mathlib 版本（本例 v4.34.0-rc2 vs 我们语料 v4.28.0-rc1）。
2. **只取第一个声明的证明体**：按缩进取块——从 `theorem|lemma` 行到 `:= by` 行，再收集缩进更深的行。
3. **⚠️ 喂给 `extractHaveBindings` 时必须从 `:= by` 起**（见 INTERFACES §2.3）——否则它会静默返回空，你会得出"这个仓库没有 have"的错误结论。这个坑我踩了三次。
4. **真值对照**：数原文里 `^\s*have\s` 的行数，与 `bindings.length` 比对。
5. **归因**：对每个空签名，回原文找它来自哪一行——**归因才能确认形态**，光看比例说明不了问题。
6. **对照语料**：同一测量跑在 lsv2 上。若两边都中招，说明是**提取器**的问题而不是"语料外特例"。

> 第 6 步是这次的关键：**先假设是自己的语料也有问题**，再去测。如果只测外部仓库，很容易把它当成"外部代码风格不同"而放过。

### 11.2 失败模式备忘：schema 错误会导致「半注册」

`output.schema` 的 object 节点漏写 `additionalProperties` 时（见 §3.6），`defineTool` 在**注册期**抛 `JsonSchemaError`，`apply()` 中断。后果不是「一个工具坏掉」，而是 **`ctx.effect` 内已注册的工具留在了注册表上、后面的没注册**——出现半注册状态，且 `install_bundle` 只报一句 `failed to import`。

排查建议：工具数量对不上时，先 `cordis_inspect_query` 的 `Tool.listTools` 数一遍实际注册了几个，再逐个 `node --check` + 单独 import 每个工具模块，能直接定位到是哪个 `defineTool` 抛错。

---

## 附：一页速览

```
分层   tools → {io, net, render} → core（core/render 零依赖，测试强制）
打包   单目录 ai4math/ + Host-only bundle；install_bundle 一步生效
工具   8 个，annotation_check 第一个；输出有界，完整结果落盘给路径
数据   SkeletonTree（带 coverage）/ Anchor / Annotation（role+三轴+segments）/ Ledger
校验   V1–V16 全在 core/credential.mjs，逐条返回并带修复动作
生成   三段式 prepare → agent 生成 → submit；生成序与呈现序分离
前端   一期静态 HTML（a4m- 前缀，双向锚点）；二期 client slot 复用同一命名
红线   引理语义只来自词典；允许并强制表态 none；超限重写不截断；行号不作锚点
```
