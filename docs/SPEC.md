# 规范（SPEC）

> **文档地位**：**规范性文档（normative）**。命名、数据契约、校验规则、分层约束以本文为准；与本文冲突的其他文档以本文为准。
> **版本**：`spec_version = 1.4.0`
> **日期**：2026-10-07
> **上游依据**：[plan-v1.0.md](../plan-v1.0.md)（数据模型与三轴可信度）、[decisions.md](../decisions.md)（D1–D8 已拍板）、[../ai4math-annotator-dev-plan-v2.md](../notes/ai4math-annotator-dev-plan-v2.md)（注解类型学）
> **配套**：[ARCHITECTURE.md](./ARCHITECTURE.md)（架构）、[README.md](./README.md)（文档地图）

---

## 0. 适用范围与冲突消解

### 0.1 三份文档的分工

| 文档 | 性质 | 谁说了算 |
|---|---|---|
| **SPEC.md（本文）** | 规范 | 命名 / 字段 / 枚举 / 校验规则 / 分层约束 |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 描述 | 模块划分 / 数据流 / 打包 / 扩展点 |
| [plan-v1.0.md](../plan-v1.0.md) | 背景与研究记录 | 判据（`RD@K`）的推导与实测 |
| [dev-plan-v2.md](../notes/ai4math-annotator-dev-plan-v2.md) | 背景与设计依据 | 注解类型学的文献依据 |

### 0.2 两条设计谱系的合并

工作区存在两条已经各自成熟的设计线，**本项目取二者并集，不取其一**：

| 来源 | 提供 | 在本文的落点 |
|---|---|---|
| v0.1 → plan-v1.0 → decisions.md | `SkeletonTree` / `Anchor` / 三轴可信度 / 校验规则 C1–C6 / 判据 `RD@K` / 方法优先（D1） | §2 数据契约、§4 校验规则、§5 分层约束 |
| dev-plan-v2.1 | 注解角色类型学（`role`）/ 价值类型 / 文化取向 / 认知高度 / 四种形态 / 长度上限 | §2.4 字段、§3 枚举 |

**两者不冲突的部分**：v1.0 的"三轴"描述**一条注解的可信度属性**，v2.1 的"类型学"描述**一条注解在阅读中的作用**。二者正交，可同时挂在 `Annotation` 上。

### 0.3 三处命名冲突的消解（**这是本文档存在的首要理由**）

| 冲突 | 消解 | 理由 |
|---|---|---|
| `significance` 的枚举值 `step` 与 `role` 的枚举值 `step` 同名 | `significance` 的取值改为 **`main` / `supporting` / `context`**（原 `step` → `supporting`） | 两者含义不同（"多重要" vs "干什么活"），同名会让所有代码和提示词产生歧义。**这是 breaking change，写进 §8 迁移表** |
| v2.1 的 `role = none` 与本文的 `value_type = none` 重复 | **取消 `role = none`**，改用 `role = step` + `value_type = none` | `role` 回答"这条注解是干什么的"，`value_type` 回答"这一步有没有可提炼的东西"。合并后 `role` 枚举保持闭集，且 §7.4 第 4 条的硬约束变成必填字段（见 V7） |
| `certainty: "构造的"`（v2.1 §5.2）与三轴模型冲突 | **取消 `certainty` 字段**，其职能由 `evidence` + `segments[].kind` 承担 | 一个对所有注解都取同一值的字段不携带信息。见 V11 |

---

## 1. 命名法总则

### 1.1 按层选命名法（**唯一权威表**）

| 层 | 命名法 | 示例 | 理由 |
|---|---|---|---|
| npm 包名 / bundle 名 / Cordis 行 id | `kebab-case` | `dsh-scholia` | 跟随 `dsh-tavern` 的既有先例 |
| 工具名（模型可见） | `snake_case`，**无前缀** | `annotation_check` | 与 DSH 内置工具一致（`read` / `web_search` / `todo_write`）；工具名在会话里全局可见，前缀是纯 token 开销 |
| 工具参数键（模型可见） | `snake_case` | `theorem_name` / `node_id` | 与内置工具参数一致（`file_path` / `old_string`） |
| 工具输出 JSON 字段（模型可见） | `snake_case` | `anchor_precision` / `ledger_path` | 与落盘契约同构，避免双重命名 |
| 落盘数据契约字段 | `snake_case` | `type_fingerprint` / `value_type` | 沿用 plan-v1.0 §4 的既有写法 |
| `Config` 字段（patch 层可见） | `camelCase` | `corpusPath` / `maxNodes` | 与 DSH 既有插件一致（`toolName` / `maxResultChars`） |
| JS/TS 内部标识符 | `camelCase` | `buildLexiconIndex` / `validateAnnotation` | 语言惯例 |
| 模块文件名 | `kebab-case`（单词可省连字符） | `annotation-check.mjs` / `skeleton.mjs` | 与 plan-v1.0 §8.2 一致 |
| 产物文件名 | `kebab-case` + 原样业务 id | `Nat.add_comm.json` | 见 §2.6 |
| SQL 表名与列名 | `snake_case` | `lemma` / `informal_description` | 与契约字段同构 |
| CSS 类名 | `a4m-` 前缀 + BEM | `a4m-anno__seg--concept` | 见 §1.4 |
| HTML 元素 id | `a4m-` 前缀 + 类型 + id | `a4m-n-3` / `a4m-a-7` | 见 §1.4 |

> **契约字段一律 `snake_case`，JS 内部变量一律 `camelCase`，转换只允许发生在一个地方**（`src/io/contract.mjs` 的 `toCamel` / `toSnake`）。禁止在业务逻辑里手写字段名映射。

### 1.2 项目与包标识

| 用途 | 取值 | 状态 |
|---|---|---|
| 方法 / 项目代号 | `faithful-loss` | **建议值，待拍板（原 D8）** |
| 可安装包名 | `dsh-scholia` | **锁定**——安装标识不随品牌调整而 churn |
| bundle 名 | `dsh-scholia` | 锁定 |
| Cordis 行 id | `dsh-scholia` | 锁定 |
| 目录 | `ai4math/` | 锁定（plan-v1.0 §8.2） |
| 插件显示名（卡片） | 见 `locale/*.json` 的 `meta.title` | —— |

> D8 未拍板不阻塞开工：包名与行 id 已锁定，代号只影响文档措辞。

### 1.3 后端命名

- **工具名**：`<对象>_<动作>` 或既有的 `<对象>_<动作>` 习惯，全小写 `snake_case`。动词用祈使式：`check` / `lookup` / `extract` / `prepare` / `submit` / `export`。
- **内部导出函数**：动词开头 `camelCase`：`extractSkeleton` / `validateAnnotations` / `renderLedgerHtml`。
- **纯谓词**：`is` / `has` 开头：`isTruncated` / `hasResolvableAnchor`。
- **常量与枚举**：`SCREAMING_SNAKE_CASE`，且必须从 §4 的枚举闭集表生成，禁止在业务代码里内联字符串字面量。

```js
// ✅ 唯一来源
export const ROLE = Object.freeze({
  CORE_IDEA: 'core_idea', QUESTION: 'question', BIRDVIEW: 'birdview',
  STEP: 'step', COMMENTARY: 'commentary', NEGATIVE_SPACE: 'negative_space',
})
// ❌ 禁止
if (a.role === 'core_idea') { … }
```

- **错误码**：`SCREAMING_SNAKE_CASE`，与校验规则编号对齐：`V7_VALUE_TYPE_REQUIRED`。
- **测试文件**：`<被测模块>.test.mjs`，与被测文件同目录层级放在 `test/`。

### 1.4 前端命名

一期与二期的前端是**两个东西**，但**共用同一套类名、id 与数据属性前缀**，以保证二期是重渲染而非重写。

**(a) 一期：静态 HTML 渲染器（必做）**

| 对象 | 规则 | 示例 |
|---|---|---|
| 渲染模块 | `src/render/*.mjs`，纯字符串生成，不碰 DOM、不碰 fs | `render/html.mjs` |
| 产物 | `out/render/<decl-slug>.html` | `out/render/Mathlib.Algebra.Group.Even.add.html` |
| 样式 | `out/render/assets/a4m.css`，**仅用主题变量或中性色** | —— |
| 类名前缀 | `a4m-`，BEM：`a4m-<block>__<element>--<modifier>` | `a4m-anno__seg--concept` |
| 节点 id | `a4m-n-<node_id>` | `a4m-n-3` |
| 注解 id | `a4m-a-<annotation_id>` | `a4m-a-7` |
| 数据属性 | `data-a4m-<字段>`，值取自契约枚举 | `data-a4m-role="step"`、`data-a4m-evidence="formal"` |

**双向锚点是硬要求**（D5）：每条注解必须能跳到它锚定的节点，每个节点必须能跳到锚定它的注解。用 `data-a4m-node` / `data-a4m-anno` 建立映射，由渲染器同时生成两个方向的 `<a href="#…">`。

**(b) 二期：DSH 客户端插件（不在本期）**

| 对象 | 规则 | 值（已由实时 slot 检查确认存在） |
|---|---|---|
| 客户端入口 | 包内 `client.js`，`package.json` 的 `exports["./client"]` | —— |
| 主视图 seat | `sidebar.right.tab.document`（keyed） | key = `dsh-scholia.ledger` |
| 面板入口 | `sidebar.panellist`（list，需 `id`） | id = `a4m-ledger` |
| 工具结果卡 | `tool.call.toolview`（keyed，按工具名分发） | key = `annotation_check` |
| 设置页 | `settings.section`（list，需 `id`） | id = `a4m-settings` |
| 客户端注册 id | 一律 `a4m-` 前缀 + `kebab-case` | `a4m-ledger` |

> ⚠️ 二期开工前必须重新执行一次 slot 检查确认 key 与注册参数；上表来自 `spec_version 1.0.0` 时的实时拓扑。客户端的类名前缀、数据属性、主题 token 用法与一期**完全一致**。

### 1.5 保留与禁止

- **禁止** 使用 `a4m` 以外的短前缀；**禁止** 无前缀的通用类名（`.row` / `.card` / `.title`）出现在产物 HTML 中。
- **禁止** 在工具名里使用 `lean_` 前缀（一期不装 Lean，`lean_skeleton` / `lean_typecheck` 属二期，见 §6.1）。
- **禁止** 与 DSH 内置工具同名的工具名：`read` / `write` / `edit` / `bash` / `glob` / `grep` / `present` / `skill` / `workflow` / `subagent` 等。
- **禁止** 新增 session event 类型（见 §7.3）。
- **禁止** 在 `src/core/**` 与 `src/render/**` 中出现 `node:fs` / `node:net` / `fetch` / `@deepseek-ai/*` 的 import（由 §6.2 的测试强制）。
- **保留字段名**：`role` 在 HTML 里仅以 `data-a4m-role` 出现，不得作为裸 class 名。

---

## 2. 数据契约

所有契约字段为 `snake_case`。契约版本由顶层 `spec_version` 声明。

### 2.1 `SkeletonNode`

```jsonc
{
  "id": "n3",                                  // 稳定 id，锚点依赖它
  "decl": "Mathlib.Algebra.Group.Even.add",    // 全限定名（稳定），have/let 节点为 null
  "kind": "have",                              // 见枚举 E-KIND
  "signature": "Even a → Even b → Even (a+b)", // 人类可读陈述
  "type_fingerprint": "sha256:…",              // ppExpr 归一化后的哈希，防版本漂移
  "hypotheses": ["ha : Even a"],               // 可为空数组
  "parent": "n1",                              // 根节点为 null
  "lemma_refs": ["Even.add"],                  // 节点体内出现的引理名，概念查询的输入
  "source": "lsv2",                            // 见枚举 E-SOURCE
  "truncated": false                           // ★ 数据集记录是否被 500 字符截断
}
```

**`id` 稳定性要求（硬）**：同一 `(theorem, source)` 在任意次 `skeleton_extract` 调用中必须产出相同的 `id` 集合。实现方式：`id` 由"该节点在 DFS 中的路径序号"决定，不由出现顺序决定。**锚点依赖这条性质**，见 V12。

### 2.1b 节点条件字段与「陈述未知」（v1.3）

Lean 允许省略 `have` 的类型标注，由项推断：

```lean
have h  := exists_global_inviscid_gevrey_PDE period hq T hT ...
have hs := hp t ht
```

我们**无法**恢复这种 `have` 的类型。实测规模：lsv2 全量 17,829 个 `have` 中 **4,959 个（27.8%）** 是这个形态——**不是边角情况**。

> **全量实测（310,579 条）**：11,583 条记录含 `have`，共 **17,829 个 `have` 节点**，其中 **4,959 个（27.8%）** 无类型标注。
>
> ⚠️ **口径提醒**：此前文档里出现过 `8,033 / 2,048 / 25.5%` 这组数——那是**只扫了含 `:= by` 的前 40,000 条记录**得到的子集值（全语料有 85,227 条含 `:= by`），**不是全量**。以本节的 17,829 / 4,959 为准。教训：**报告规模数字时必须写清扫描范围**，否则部分扫描会被读成全量。

**处理口径**（不得编造类型）：

| 字段 | 值 |
|---|---|
| `signature` | `""`（确实不知道） |
| `signature_unknown` | `true`（条件字段，仅此时出现） |
| `type_fingerprint` | **`null`**（**不得**用 `fingerprint("")` 那个常数） |
| `raw_text` | 该项的逐字原文，供下游在陈述未知时仍有材料可用 |
| `coverage.signature_missing_count` | 本树的计数 |
| `local_name` | ★ have/let 的局部名（如 `h`）。**有了它 `hyp` 锚点才能指到 `have` 的局部名**——在此之前 `have h : P` 只能用 `goal:<节点 id>` 锚定，Q4 因此挂了很久。匿名 `have` 无此字段（语料里 10,093 带名 / 7,736 匿名） |

> **为什么 `type_fingerprint` 必须是 `null` 而不是空串的哈希**：`fingerprint("")` 是一个**常数**，会让所有空签名节点共享同一个指纹，**使防版本漂移机制对它们完全失效**——升级后无法判断哪个锚点坏了，因为它们本来就长得一样。`null` 表示"无法校验"，是诚实的；常数是谎言。两个消费方（`anchor.mjs`、`annotate_prepare`）已容忍 `null`。

**另一处相邻缺陷**：`have hd (s : ℝ) : T` 这种**带绑定**的形式，绑定前缀曾被丢弃，命题从 `∀ s, T` 退化成 `T`——**被削弱却看着正常**。签名必须取名字与顶层 `:=` 之间的**原文**（含绑定前缀），不做 `∀` 合成、也不丢东西。

### 2.2 `SkeletonTree`

```jsonc
{
  "theorem": "Mathlib.Algebra.Group.Even.add",
  "root": "n0",
  "nodes": { "n0": { … }, "n3": { … } },       // 以 id 为键的 map，非数组
  "coverage": {                                 // ★ 必须存在
    "mode": "tactic-multiline",                 // 见枚举 E-MODE
    "have_count": 2,
    "node_count": 4,
    "truncated": false,                         // 记录是否被数据集 500 字符截断
    "truncate_reason": null,                    // truncated=true 时必填
    "degraded": false,                          // ★ 只表示**结构性退化**
    "degrade_reason": null                      // degraded=true 时必填
  }
}
```

**`degraded` 与 `truncated` 必须分开**（v1.1）。二者是**不同性质**的不完整，`annotate_prepare` 对它们的应对策略不同：

| 标志 | 含义 | 应对策略 |
|---|---|---|
| `degraded = true` | **结构性退化**：`have_count === 0`，即没有解析出任何中间节点 | 降级为对**陈述本身**的说明，不要假装看到了步骤结构 |
| `truncated = true` | 证明体被数据集截断（≥490 字符或结尾省略号） | 已解析出的步骤**照常做步骤级注解**，只是不得声称覆盖完整 |

> 早先版本把截断也计入 `degraded`，导致 45.4% 结构完好的树被标为退化（实测 11,583 条含 `have` 的树中 5,259 条如此、真正结构退化 0 条），使该信号失去决策价值。**H5 要求的是"不得静默降级"，不是"把两种不完整混成一个布尔"。**
>
> **判据是 `have_count === 0`，不是 `mode` 的取值列表。** 二者在「多行 tactic 但没有 `have`」上分叉：这类记录 `mode = tactic-multiline` 但树同样只剩根节点（实测 39,970 条），**必须算作 degraded**，否则会出现「树只有根节点却 `degraded = false`」的假覆盖率。`mode` 是**形态**信号，`degraded` 是**结果**信号，不要互相替代。
>
> v1.1 实测分布（全量 310,579）：`degraded=true` 298,996 ｜ `truncated=true` 11,925（其中截断但结构完好 5,259 —— 正是被误判的那批）｜含 `have` 的树 11,583 条现在**全部** `degraded=false`。

**`coverage` 是必需字段，不是可选诊断。** 实测（全量 310,579）：含 `have` 的 tactic 证明仅 11,735 条（3.8%），单行 tactic 证明 31,910 条（39.5%），term-mode 141,769 条（45.6%）。树退化是**常态**，模型必须能看到它，才能据此降级注解策略而不是硬编。

### 2.3 `Anchor`

```jsonc
{"kind": "decl", "target": "Mathlib.Algebra.Group.Even.add"}
{"kind": "goal", "target": "n3", "fingerprint": "sha256:…"}
{"kind": "hyp",  "target": "ha"}
{"kind": "display", "target": "L120"}   // ✗ 仅显示，不参与校验，出现即触发 V4
```

### 2.4 `Annotation`

```jsonc
{
  "id": "a7",
  "node": "n3",                    // 主锚点节点；定理级注解指向 root
  "role": "step",                  // 轴 R（v2.1）：这条注解干什么活
  "value_type": "technique",       // 轴 V：仅 role=step 有效；none 合法且是必填表态
  "culture": "problem",            // 轴 G：仅 role=step 有效；**未命中时字段缺省**
  "height": "frog",                // 轴 D：内容类型，非位置约束
  "evidence": "formal",            // 轴 E（v1.0）
  "significance": "main",          // 轴 C（v1.0，已消解 step→supporting）
  "presentation": "paraphrase",    // 轴 P（v1.0）
  "audience": "grad-math",         // 见枚举 E-AUDIENCE
  "segments": [                    // ★ 权威正文；替代 plan-v1.0 的 text 字段
    {"kind": "reasoning", "text": "…"}
  ],
  "anchors": [{"kind": "goal", "target": "n3"}],
  "refs": ["a5"],                  // annotation → annotation 引用
  "provenance": {
    "model": "deepseek-flash",
    "ts": "2026-10-07T22:00:00+08:00",
    "run": "pilot-01"
  }
}
```

**关于 `segments` 取代 `text`（**breaking change**）**：v1.0 的单一 `text` 无法表达"这句话里哪部分来自词典、哪部分是我的构造"。而"引理语义只允许来自词典"如果不落到结构上，就只是提示词里的祈求。分段后：

- `kind = "concept"` ⇒ **必须**带 `lexicon_ref`（V10），渲染时可加下划线并可点击弹出词典原文。
- `kind = "reasoning"` ⇒ 模型自由发挥，受 V9 长度与 §7.4 第 1/4 条约束。
- 简单注解（如 40 字的 `core_idea`）就是**只有一个 `reasoning` 段的数组**。数组长度 ≥1。

### 2.5 `Ledger`（顶层产物）

```jsonc
{
  "spec_version": "1.0.0",
  "mathlib_baseline": "v4.28.0-rc1",
  "theorem": "Mathlib.Algebra.Group.Even.add",
  "skeleton": { … },
  "annotations": [ … ],
  "metrics": {
    "node_count": 4,
    "annotated_node_count": 3,
    "main_coverage": 0.75,        // C_skel：有 ≥1 条 significance=main 的节点 / 总节点
    "anchor_precision": 1.0,      // P_skel：指向真节点的 main 注解 / main 注解总数
    "concept_coverage": null      // C_concept：需检索层，缺省为 null 而非 0
  },
  "provenance": {"run": "pilot-01", "created": "2026-10-07T22:00:00+08:00"}
}
```

**`null` 与 `0` 语义不同**：指标"没算"必须是 `null`，"算出来是零"才是 `0`。报告层必须区分二者。

### 2.6 文件产物与目录

| 产物 | 路径 | 内容 |
|---|---|---|
| 骨架树 | `out/skeleton/<decl-slug>.json` | `SkeletonTree` |
| 注解账本 | `out/ledger/<decl-slug>.json` | `Ledger` |
| 渲染材料 | `out/render/<decl-slug>.html` + `out/render/assets/a4m.css` | 静态 HTML |
| 评测报告 | `out/report/<run-id>/roundtrip.json` | `RD@K` 结果 |
| **依赖图谱** | `out/graph/<root-module>.svg` + `.html` | 模块级依赖 DAG（v1.4，见 INTERFACES 附录 G） |
| 词典索引 | `cache/lexicon.db` | SQLite（`node:sqlite`） |

`<decl-slug>` = 全限定名原样保留点号（`Mathlib.Algebra.Group.Even.add`）；出现 `/` 时替换为 `_`。**不哈希、不截断**——文件名必须能被人读懂，这是"下钻回原文"的一部分。

---

## 3. 枚举闭集

**所有枚举值在代码里只能出现一次**（§1.3 的 `SCREAMING_SNAKE_CASE` 常量对象）。新增枚举值属于契约变更，必须升 `spec_version`。

| 枚举 | 取值 | 来源 |
|---|---|---|
| `E-KIND`（节点类型） | `theorem` `lemma` `definition` `instance` `have` `let` `goal` `inductive` `abbrev` `opaque` `class_inductive` `constructor` `recursor` | plan-v1.0 §4.1 ＋ v1.1 按语料实测补齐 |
| `E-SOURCE` | `lsv2` `lean4export` `manual` | plan-v1.0 §4.1 |
| `E-MODE`（骨架模式） | `tactic-multiline` `tactic-single` `term` `failed` | 本文（对应实测的四种形态） |
| `E-ROLE` | `core_idea` `question` `birdview` `step` `commentary` `negative_space` | v2.1 §4 |
| `E-VALUE-TYPE` | `technique` `concept` `technical` `structural` `none` | v2.1 §3 轴1 + 本文加 `none` |
| `E-CULTURE` | `theory` `problem` | v2.1 §3 轴2 |
| `E-HEIGHT` | `bird` `frog` `both` | v2.1 §3 轴3（语义已改为内容类型） |
| `E-EVIDENCE` | `formal` `literature` `unfolding` `analogy` `intuition` | plan-v1.0 §3.1 |
| `E-SIGNIFICANCE` | `main` `supporting` `context` | plan-v1.0 §3.2（`step`→`supporting`） |
| `E-PRESENTATION` | `exact` `paraphrase` `metaphor` | plan-v1.0 §3.3 |
| `E-AUDIENCE` | `grad-math` `highschool-strong` | decisions.md D5 |
| `E-SEGMENT-KIND` | `concept` `reasoning` | 本文（§2.4） |
| `E-ANCHOR-KIND` | `decl` `goal` `hyp` `display` | plan-v1.0 §4.2 |
| `E-FORM`（注解形态） | `the_book` `conrad` `zagier` `thurston` | v2.1 §7.5 |

### 3.1 `role` 与 `height` 的默认对应（**默认值，不是校验规则**）

| `role` | 默认 `height` |
|---|---|
| `core_idea` / `birdview` / `commentary` / `negative_space` / `question` | `bird` |
| `step` | `frog` |

**`height` 不得被位置锁定。** Dyson 说的是两种**认知模式**，不是"根节点只能鸟瞰"。允许 `role=step` + `height=bird`（例如"这一步引入 Yoneda，证明重心在此转移"），校验器不得拒绝。此条明确推翻 v2.1 §3 轴 3 的"只挂根/只挂子"表述。

### 3.2 长度上限（按 `role`，单位：正文汉字数，公式与代码不计）

| `role` | 上限 |
|---|---|
| `core_idea` | 40 |
| `question` | 120 |
| `birdview` | 150 |
| `step` | 150 |
| `commentary` | 250 |
| `negative_space` | 200 |

**超限的处理是拒绝并要求重写，不是截断**（V9）。理由见 v2.1 §7.6：长度是"有没有吃透"的探针。

### 3.3 形态（`E-FORM`）授权范围

形态只影响**风格范例注入与组织方式**，**不改变任何字段的必填性**。四种形态的定义见 v2.1 §7.5。

---

## 4. 校验规则

**必须实现为代码，不得只写进提示词。** 编号即错误码来源（`V7_VALUE_TYPE_REQUIRED`）。

| # | 规则 | 违反 | 来源 |
|---|---|---|---|
| **V1** | `significance = main` ⇒ ≥1 个可解析锚点 | 拒绝 | C1 |
| **V2** | `presentation = metaphor` ⇒ `evidence ∈ {analogy, intuition}` | 拒绝 | C2 |
| **V3** | `evidence = formal` ⇒ `anchor.kind ∈ {decl, goal}` | 拒绝 | C3 |
| **V4** | `anchor.kind = display` ⇒ 校验失败（禁止把行号当锚点） | 拒绝 | C4 |
| **V5** | 所有 `refs` ⇒ 指向已存在的 `annotation.id` | 拒绝 | C5 |
| **V6** | `evidence ∈ {formal, literature, unfolding}` ⇒ 不得进入"直觉层"视图 | 视图过滤 | C6 |
| **V7** | `role = step` ⇒ `value_type` **必填**（`none` 合法） | 拒绝 | ★ v2.1 §7.4 第4条，落为字段 |
| **V8** | `value_type` 存在 ⇔ `role = step`；`culture` 存在 ⇒ `role = step` | 拒绝 | v2.1 §5.2 |
| **V9** | Σ `segments[].text` ≤ §3.2 上限 | **拒绝并提示重写** | v2.1 §7.6 |
| **V10** | `segment.kind = concept` ⇒ `lexicon_ref` 非空且可在词典中解析 | 拒绝 | 本文（补 v2.1 §7.2 缺口） |
| **V11** | `segments` 长度 ≥1，且每个 `segment.kind` ∈ E-SEGMENT-KIND | 拒绝 | 本文（替代 `certainty`） |
| **V12** | 每个 `anchors[]` 必须解析到骨架中真实存在的节点 id 或 `decl` 全限定名 | 拒绝（悬空断言） | plan-v1.0 §4.4 `P_skel` |
| **V13** | `role ∈ {core_idea, question, birdview, commentary, negative_space}` ⇒ 主锚点必须指向 `root` | 拒绝 | v2.1 §4 |
| **V14** | `annotation.node` 必须等于其 **`goal` 锚点** 的 `target`（`role = step` 时）。仅挂 `hyp` 锚点时本规则不适用（`hyp` 的 target 是假设名，不是节点 id） | 拒绝 | 本文 |
| **V15** | `provenance.model` / `.ts` / `.run` 三者必填 | 拒绝 | 本文（诚实性） |
| **V16** | 同一 `(node, role)` 重复提交 ⇒ 覆盖而非报错，但必须在结果里报告 | 覆盖并报告 | 原则 3（多解性是特性） |

### 4.1 规则的实现位置与边界

- **V1–V16 全部实现在 `src/core/credential.mjs`**（纯函数，无 I/O），由 `annotation_check` 与 `annotate_submit` 共用**同一个实例**。禁止出现两份校验逻辑。
- **`annotation_check` 是第一个必须交付的工具**（plan-v1.0 §8.1）：整套方法的验证器就是它。如果 agent 写的注解过不了 validator，可信度设计就是空的。
- 校验结果必须**逐条**返回，不得只返回第一个失败：

```jsonc
{
  "ok": false,
  "diagnostics": [
    {"index": 2, "annotation_id": "a7", "rule": "V7",
     "code": "V7_VALUE_TYPE_REQUIRED", "field": "value_type",
     "message": "role=step 必须显式给出 value_type；若这一步没有可提炼的思路，请填 \"none\""}
  ]
}
```

**每条消息必须带修复动作**（"请填 none"而不是"缺少字段"）。

### 4.2 被明确排除的规则

| 不做的校验 | 理由 |
|---|---|
| 注解文本与 `informal_description` 的相似度 | 注解的目标是安装心智模型，不是复述（A1）。相似度低是**预期**，不是错误 |
| 术语密度 / 句长 / 可读性分数 | prerequisites 原则 5：通俗是 `(文本, 读者)` 的属性，文本性判据一律无效 |
| 检查注解是否"忠实于作者意图" | prerequisites 原则 3：论证的是"该证明能容纳的理由"，AI 证明没有作者意图可恢复 |

---

## 5. 分层与依赖约束

### 5.1 五层

```
src/tools/   ← DSH 绑定层：唯一 import @deepseek-ai/dsh-tools / schemastery 的地方
src/io/      ← 本地 I/O：语料流式读、SQLite 索引、产物落盘
src/net/     ← 网络适配：Loogle / LeanSearch
src/render/  ← 纯渲染：Ledger → HTML / Markdown 字符串
src/core/    ← 纯逻辑：骨架、锚点、校验、判据。零依赖
```

**依赖方向单向向下**：

```
tools ──┬──> io ──> core
        ├──> net ──> core
        ├──> render ──> core
        └──> core
```

### 5.2 硬约束（由测试强制，见 ARCHITECTURE.md §7）

| # | 约束 | 检查方式 |
|---|---|---|
| **L1** | `src/core/**` 与 `src/render/**` 不得 import `node:fs`、`node:net`、`node:sqlite`、`fetch`、`@deepseek-ai/*` | 静态扫描测试 |
| **L2** | `src/core/**` 必须能在无网络、无 DSH、无 LLM 的环境下单测通过 | `node --test` |
| **L3** | 只有 `src/tools/**` 可以 import `@deepseek-ai/dsh-tools` | 静态扫描测试 |
| **L4** | 枚举字面量只能出现在枚举定义模块中 | 静态扫描测试 |
| **L5** | 契约字段名的 snake/camel 转换只允许出现在 `src/io/contract.mjs` | 静态扫描测试 |

### 5.3 分层约束的作用域

**L1–L5 的扫描范围是 `src/**`**——即出厂源码，也就是 `package.json` 的 `files` 白名单所打包的部分。**`test/**` 不在约束范围内**，理由：

1. 这些规则约束的是**出厂源码**的分层。第三方复现 `src/core` 时拿到的是打包产物，不含我们的测试。
2. L4 若覆盖 `test/` 会自相矛盾：测试夹具里必然出现 `role: 'step'` / `kind: 'concept'` 这类字面量，那是**数据**不是**枚举使用**，全量扫描会把几十条测试判为违规，规则就退化成噪音。
3. 测试**允许** import `@deepseek-ai/dsh-tools`，用于做**注册期校验**的回归测试——这正是能抓到「`output.schema` / `parameters.items` 写法违规 → `defineTool` 注册期抛错 → 整个 bundle 起不来」那一类只在安装时才爆炸的问题的手段（见 ARCHITECTURE §3.6）。禁止它，等于只能靠一次性探针，无法留档。

> 该回归测试在 `ai4math/node_modules/@deepseek-ai/*` 缺失时必须 **skip 而非 fail**：干净 checkout 未跑 `scripts/link-dsh-deps.mjs` 时失败属环境问题，让它红会训练人忽略红灯。

**L1/L2 是 decisions.md D1 的工程前提**：`src/core` 是方法本体，必须能被第三方在不装 DSH、不联网、不装 Lean 的情况下独立复现。

---

## 6. 工具面契约

### 6.1 工具清单（一期）

| 工具 | 阶段 | 依赖 | 作用 |
|---|---|---|---|
| `annotation_check` | **M2（第一个）** | `core` | 校验 V1–V16，不写盘 |
| `concept_lookup` | M3 | `io` + `core` | 词典查询（本地索引），**防编造的唯一来源** |
| `skeleton_extract` | M3 | `io` + `core` | 证明体 → `SkeletonTree`（含 `coverage`） |
| `annotate_prepare` | M4 | `core` + `io` | 产出**结构化工作单**（见 §6.3） |
| `annotate_submit` | M4 | `core` + `io` | 校验 + 合并进 `Ledger` + 写盘 |
| `roundtrip_eval` | M4 | `io` + `core` | 跑 `RD@K`，产出报告 |
| `ledger_export` | M4 | `render` + `io` | 渲染并排 HTML |
| `mathlib_search` | M4（可选） | `net` | Loogle / LeanSearch 检索 |
| `lean_skeleton` / `lean_typecheck` | **二期** | Lean | ⛔ 本期不做 |

### 6.2 工具定义约束

| # | 约束 | 依据 |
|---|---|---|
| T1 | 每个工具的输出必须**有界**：条目数或字符数超限时截断，并返回完整结果的**文件路径** | agent-experience「bounded outputs」「locality」 |
| T2 | 未命中必须**显式返回**（如 `missing: ["Foo.bar"]`），不得静默省略 | 模型需要知道"词典里没有"，才能不自由发挥 |
| T3 | 参数规则写在该参数的 `description` 里，不写在工具描述里 | agent-experience「put parameter rules on the parameter」 |
| T4 | 工具描述只讲**行为与返回**，不讲内部机制 | agent-experience「describe behavior, not implementation」 |
| T5 | 每条事实只说一次；不得在 `systemPrompt` 里重复工具定义 | agent-experience「say each fact once」 |
| T6 | 只读工具声明 `isConcurrencySafe: () => true` | 允许模型并行批量查询 |
| T7 | 联网工具设置 `timeoutMs` | 网络不可控 |
| T8 | 错误结果必须带**修复动作**，不是裸原因 | §4.1 |

### 6.3 `annotate_prepare` 的输出契约（核心接口）

**一次调用产出一个节点的完整工作单，工具内部不调用 LLM。**

```jsonc
{
  "theorem": "…",
  "scope": "step",
  "node_id": "n3",
  "role": "step",
  "form": "zagier",
  "parent_chain": [{"id": "n0", "signature": "…"}, {"id": "n1", "signature": "…"}],
  "statement": {"signature": "…", "source_excerpt": "…"},
  "lexicon": [{"name": "Even.add", "informal_name": "…", "informal_description": "…"}],
  "style_examples": null,          // 未命中文化取向时为 null，并给 reason
  "style_examples_reason": "module_name 无法判定文化取向，未注入范例",
  "length_limit": 150,
  "constraints": ["…"],
  "output_shape": { … }            // 供 annotate_submit 校验的期望形状
}
```

**为什么不是单一 `annotate_proof` 工具**（推翻 v2.1 §6.3）：

1. **可复现**——DSH 的硬规则是「session log 是唯一真源」。工具内部调用 LLM 的中间产物进不了会话日志，无法 fork / resume / replay。
2. **成本可见**——R6 要求估成本；成本发生在工具内部就无法估。
3. **模型即 LLM**——与 prerequisites §5 的分层映射一致（`[3][4]` 交给 agent 自身）。
4. **锚点不错位**——`node_id` 是**输入**而不是模型的输出，从结构上排除了 v2.1 §7.3 担心的错位。
5. **D4 可插拔**——将来微调模型藏在工具后面时，它是一个独立的 `annotate_draft` 工具，不改管线。

---

## 7. 工程约束

### 7.1 依赖策略：零 npm 运行时依赖 ＋ vendored 前端库

**一期不引入任何 npm 运行时依赖。** 需要的能力用 Node v24 内建：

| 需求 | 方案 | 已验证 |
|---|---|---|
| 词典索引（数十万条） | `node:sqlite` 的 `DatabaseSync` | ✅ 本机 Node v24.21.0 实测可用 |
| `Config` schema | `@deepseek-ai/schemastery`（DSH 已随附） | ✅ 随 dsh 解析 |
| 工具定义 | `@deepseek-ai/dsh-tools`（DSH 已随附） | ✅ |
| 测试 | `node --test` | ✅ |

理由：Host-only bundle 声明零依赖则无 install script、无构建步骤、无版本冲突，安装面最小。

#### 7.1.1 例外：`vendor/**` 的第三方前端库（v1.2）

数学排版需要 KaTeX。**不声明为 npm 依赖，而是把产物 vendored 进仓库**：

```
vendor/katex/          928 KB / 24 文件
├── katex.mjs          588 KB  自包含 ESM（零 import，实测）
├── katex.min.css       24 KB
├── fonts/*.woff2      296 KB  20 个（只取 woff2，现代浏览器全覆盖）
├── LICENSE             MIT，必须随附（版权合规）
└── PROVENANCE.json     来源与版本钉定（0.16.47）
```

**为什么不声明为 npm 依赖**：
1. **link 安装的插件解析不到自己声明的依赖**——`install_bundle` 把它链接进 profile，Node 从**真实路径**解析 import，找不到 `ai4math/node_modules`（与 §3.5 的 `@deepseek-ai/*` 是同一个机制）。要靠依赖就得在插件目录里再跑一次包管理，引入额外安装步骤。
2. **版本漂移**：依赖会随 profile 的解析结果变化，而 vendored 是钉死的。排版结果必须可复现。
3. **离线与自包含**：`src/core` 的第三方可复现性（D1）要求整棵树自带所需的一切。

**约束**：
- `src/render/**` 只能以**相对路径** import `vendor/**`（如 `../../vendor/katex/katex.mjs`）；这仍然满足 L1（无 `node:fs` / `node:net` / `@deepseek-ai/*`）。
- vendored 库必须随附 LICENSE 与来源版本；升级时同步更新 `PROVENANCE.json`。
- **KaTeX 只在服务端渲染**（`katex.renderToString`），产出纯 HTML 字符串——**输出页仍然零 `<script>`**。禁止引入客户端 KaTeX。

### 7.2 注册与生命周期

```js
export function apply(ctx, config) {
  ctx.effect(() => {
    const disposers = [ /* 每个工具的 register 返回值 */ ]
    return () => { for (const d of disposers) d() }
  })
}
```

| 约束 | 依据 |
|---|---|
| 全部注册包在 `ctx.effect()` 内，并返回清理函数 | 注册是 context 拥有的 effect；**否则改代码后旧注册残留** |
| `inject = ['tools']` | `ctx.tools` 是硬依赖；缺了就应不激活而不是抛错 |
| 可调值一律进 `Config`，不写死在代码里 | 用户的 patch 层能跨升级存活 |
| 不订阅会话事件、不轮询 | 一期工具是纯请求-响应，无状态 |

### 7.2b 零脚本性质的适用范围（v1.4）

**论文视图** `out/render/*.html` **必须保持零 `<script>`**：自包含、可邮件、无 XSS 面、输出确定、无服务器也能看。V6 的直觉层过滤用**纯 CSS 属性选择器**实现，不用脚本——这条不变。

**图谱视图** `out/graph/*` 与**大纲视图** `out/outline/*` **允许带脚本**（自包含、不联网、不引 CDN）。理由是平移/缩放/点击下钻、以及展开/收起在纯静态 HTML 里做不到（`<details>` 能覆盖一部分）。

> 边界一句话：**读的东西零脚本，找的东西可以有脚本。** 论文视图（`out/render/*`）与**站点页**（`out/outline/<root>/NN.html`）必须保持零 `<script>`；任何把脚本引入它们的改动都需要先改这一条。

**渐进增强是硬要求**：大纲视图的核心展开用**原生 `<details>`**，JS 只做 `<details>` 做不到的增强。**不得出现"必须执行脚本才能到达某个页面"的情况**——所有站点链接必须在静态 HTML 里。给数学家读的目录，脚本挂掉不该读不了。

### 7.3 禁止新增 session event 类型

注解账本写**文件**，不写 session event。带新 `type` 的 event 会让 Session 无法重新打开（live append 无法设置 `ignorable` 标记）。

### 7.4 提示词硬约束（不得因实现简化而丢弃）

以下六条必须体现在 `annotate_prepare` 的 `constraints` 输出中（v2.1 §7.4）：

1. 引导模型回答"**读者读完这句，脑子里多出什么可以拿到别处用的东西？**"；只复述"把 X 变成 Y"的要求重写。
2. 引理语义只允许使用 `lexicon` 段给出的内容，禁止臆造。
3. 必须标注 `value_type`；纯技术操作标 `technical` 并一句话说完。
4. **明确允许** `value_type = "none"`（"这一步没有可提炼的思路"）。
5. 遵守 `length_limit`，**超限重写而不是截断**。
6. 注入与领域匹配的风格范例（仅在命中时）。

> **第 4 条是防编造的唯一有效手段，必须在每一版实现里保留。** 直觉：大量证明是 `by grind`、`by simp`、单行 `rfl`。如果模型不许说"这里没东西可提炼"，它一定会编；而编出来的"思路"恰恰最危险——**因为它读起来最顺**。

### 7.5 确定性

同一输入必须产出同一输出，**生成段除外**。因此：

- `skeleton_extract`、`concept_lookup`、`annotation_check`、`roundtrip_eval`、`ledger_export`：**必须完全确定**。
- 涉及 LLM 的只有 `segments[].text`。`provenance` 必须记录模型与时间。
- 随机数一律禁用固定种子（沿用 pilot 的 `mulberry32(99)` 约定）。

### 7.6 诚实性约束

| # | 约束 |
|---|---|
| H1 | `provenance` 三字段必填（V15） |
| H2 | 指标"没算"用 `null`，"算出来是零"用 `0`（§2.5） |
| H3 | 样本池准入必须检查 `truncated = false`（数据集 3.7% 记录被截断在 500 字符） |
| H4 | 报告中必须标注哪些结论**未做真人校准**（prerequisites §6 模式 D） |
| H5 | 树退化时必须置 `coverage.degraded = true` 并给出 `degrade_reason`，不得静默降级 |

---

## 8. 版本与兼容

### 8.1 三个版本号

| 字段 | 含义 | 变更时机 |
|---|---|---|
| `spec_version` | 本文档的契约版本，当前 **1.4.0** | 枚举增删、字段增删、校验规则变更 |
| `mathlib_baseline` | 数据集固定的 Mathlib 版本 | 当前 `v4.28.0-rc1` |
| `type_fingerprint` | 单节点的类型哈希 | 每次提取时计算 |

**`type_fingerprint` 是防漂移的关键**：Mathlib 版本变化时行号全变，但类型哈希可比对，能直接报出"哪些注解的锚点已失效"（plan-v1.0 §4.1）。**行号永不作为锚点**（V4）。

### 8.2 迁移表（相对 plan-v1.0）

| 变更 | 旧 | 新 | 类型 |
|---|---|---|---|
| `significance` 取值 | `main` `step` `context` | `main` **`supporting`** `context` | breaking |
| 注解正文 | `text: string` | `segments: [{kind, text, lexicon_ref?}]` | breaking |
| 可信度标记 | 无（v2.1 的 `certainty`） | 取消；由 `evidence` + `segments[].kind` 承担 | —— |
| 注解角色 | 无 | 新增 `role`（E-ROLE） | additive |
| 价值类型 | 无 | 新增 `value_type`（`role=step` 时必填） | additive |
| 文化取向 | 无 | 新增 `culture`（可缺省） | additive |
| 认知高度 | 无 | 新增 `height`（默认值语义，非硬约束） | additive |
| 骨架 | `SkeletonTree` | 增加 **必需** 的 `coverage` 段 | additive |
| 节点 | `SkeletonNode` | 增加 `lemma_refs` | additive |

---

## 9. 待拍板项

| # | 事项 | 建议 | 是否阻塞 |
|---|---|---|---|
| D8 | 项目代号 | `faithful-loss` | ❌ 不阻塞（包名已锁定为 `dsh-scholia`） |
| D9 | `significance` 与 `role` 是否保留两个维度 | **保留**——二者正交，合并会丢信息 | ❌（本文已按保留实现） |
| D10 | `segments` 是否强制分段 | **强制**（≥1 段） | ❌（本文已按强制实现） |
| D11 | 二期前端坐在 `sidebar.right.tab.document` 还是 `main` | **`sidebar.right.tab.document`**（与对话并排，符合"并排阅读"） | ❌ 二期事 |

---

## 附：规范的红线（一页）

```
1. 引理语义只能来自 lexicon；概念段必须带 lexicon_ref       (V10)
2. 允许并强制表态「这里没有可提炼的思路」= value_type:none  (V7)
3. 长度超限一律拒绝重写，绝不截断                            (V9)
4. 行号永不作锚点；锚点必须落在语义标识上                    (V4/V12)
5. 锚点 id 必须跨调用稳定                                    (§2.1)
6. core / render 层零外部依赖，可离线单测                    (L1/L2)
7. 契约字段 snake_case，JS 内部 camelCase，转换只有一处      (L5)
8. 不新增 session event 类型                                 (§7.3)
9. 工具输出有界，完整结果落盘给路径                          (T1)
10. 树退化是常态，必须显式暴露而不是静默降级                 (H5)
```
