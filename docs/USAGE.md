# 使用指南（USAGE）

> 面向使用者。规范见 [SPEC.md](./SPEC.md)，架构见 [ARCHITECTURE.md](./ARCHITECTURE.md)。
> **版本**：`spec_version 1.1.0` ｜ 2026-10-07

---

## 0. 一句话

**给一个 Mathlib 定理名，拿回一份「证明 + 注解」的可读 HTML。**
形式化对象原样不动，注解挂在旁边，每条注解带锚点、带可信度分档、可被"不信"。

---

## 1. 你只需要说一句话

最省事的用法是**直接在对话里说**，不需要自己逐个调工具：

> 给 `Even.add` 写一份带注解的可读材料

agent 会自己走完下面的链路。原因：**注解正文本来就是模型生成的**，这六个工具的作用是给模型**结构化输入**（骨架、父节点链、词典条目、长度上限、硬约束），而不是替它写。

---

## 2. 完整链路（七步）

```
① concept_lookup ──→ 引理的全限定名 → 人话解释        ┐ 可选，但概念段必须用它的结果
② skeleton_extract ─→ 定理名 → 骨架树 + coverage      ┘
③ annotate_prepare ─→ 取「工作单」：父链/词典/长度上限/六条约束/输出模板
④ （agent 生成注解正文）
⑤ annotation_check ─→ 先校验，不写盘（dry-run，可反复试）
⑥ annotate_submit ──→ 校验通过 → 合并进账本 out/ledger/<slug>.json
⑦ ledger_export ────→ 渲染 out/render/<slug>.html（双向锚点，浏览器直接打开）
```

**为什么 ③ 和 ⑥ 是分开的两个工具**：工具内部不调用 LLM。这样每一步都进会话日志（可复现、可回溯）、成本完全可见、锚点不会错位——`node_id` 是**输入**而不是模型的输出。

---

## 3. 可复制的完整例子

### 3.1 先看骨架

```
skeleton_extract(theorem_name = "CHSH_inequality_of_comm")
```

返回（节选）：

```jsonc
{
  "theorem": "CHSH_inequality_of_comm",
  "root": "n0",
  "coverage": {
    "mode": "tactic-multiline", "have_count": 5, "node_count": 6,
    "truncated": true,          // 证明体被语料截断
    "degraded": false,          // 但结构完好 —— 两者是正交信号
    "degrade_reason": null,
    "truncate_reason": "证明体被数据集截断…已解析出的 5 个步骤照常做步骤级注解，但不要声称覆盖完整"
  },
  "nodes": [
    {"id":"n0","parent":null,"kind":"theorem","decl":"CHSH_inequality_of_comm", …},
    {"id":"n1","parent":"n0","kind":"have","signature":"0 ≤ P","lemma_refs":["Algebra.smul_def"]},
    {"id":"n2","parent":"n1","kind":"have","signature":"P * P = 4 * P"},
    {"id":"n3","parent":"n1","kind":"have","signature":"P = (1 / 4 : ℝ) • (P * P)"},
    …
  ]
}
```

### 3.2 取工作单（一次一个节点）

```
annotate_prepare(theorem_name = "CHSH_inequality_of_comm", scope = "step", node_id = "n1")
```

工具会给你：`parent_chain`（父节点链）、`statement`、`lexicon`（该节点引理的词典条目）、
`length_limit`（本 role 的字数上限）、`constraints`（六条硬约束）、`output_shape`（该交什么形状）。

**定理级注解**（核心想法 / 问题 / 鸟瞰 / 评注 / 负空间）这样取：

```
annotate_prepare(theorem_name = "…", scope = "theorem")   // 省略 role → 一次拿到全部定理级 role 的模板
```

### 3.3 生成后先校验

```
annotation_check(theorem_name = "…", annotations = [ … ])
```

拒绝时会**逐条**给你字段定位 + 规则码 + **修复动作**：

```jsonc
{"index":1,"annotation_id":"a2","rule":"V7","code":"V7_VALUE_TYPE_REQUIRED","field":"valueType",
 "message":"role=step 必须显式给出 value_type；若这一步没有可提炼的思路，请填 \"none\""}
```

### 3.4 提交 + 渲染

```
annotate_submit(theorem_name = "…", annotations = [ … ], run = "my-run")
ledger_export(theorem_name = "…")
```

产物：

| 产物 | 路径 |
|---|---|
| 骨架树 | `out/skeleton/<decl-slug>.json` |
| 注解账本 | `out/ledger/<decl-slug>.json` |
| 可读材料 | `out/render/<decl-slug>.html` + `out/render/assets/a4m.css` |
| 词典索引 | `cache/lexicon.db`（208 MB，首次查询自动建，之后 3 ms 复用） |

---

## 4. 输入约定（最容易踩的一条）

**定理名必须是语料里真实存在的写法**，不接受只写短名、也不接受大小写不符。

```
✅ "Even.add"                          ← 语料里的原始写法
❌ "Mathlib.Algebra.Group.Even.add"    ← 会被如实报为未命中
```

**怎么找一个定理名**：目前没有「按自然语言搜定理」的工具（`mathlib_search` 尚未实现，见 §7）。临时办法是直接在语料里搜：

```bash
cd ai4math
grep -m5 -o '"name":\["[^"]*gcd[^"]*"\]' data/lsv2.jsonl    # 按名字片段找
```

或者先用 `concept_lookup(names=[…])` 试探——它会把**未命中的名字显式列在 `missing` 里**，这是它刻意保留的行为（不许静默省略）。

---

## 5. 会被拒绝的注解（V1–V16 摘要）

写注解时最容易踩的五条：

| 规则 | 要求 |
|---|---|
| **V7** | `role = "step"` 时 `value_type` **必填**。**没有可提炼的思路就填 `"none"`** —— 这是明确允许的，而且必须表态 |
| **V8** | `value_type` / `culture` **只对 `role = "step"` 有效**；定理级注解带这两个字段会被拒 |
| **V9** | 长度上限：`core_idea` 40 字 / `question` 120 / `birdview` 150 / `step` 150 / `commentary` 250 / `negative_space` 200。**超限要求重写，不是截断**（长度是"有没有吃透"的探针） |
| **V10** | `segments` 里 `kind = "concept"` 的段**必须带 `lexicon_ref`**，且该名字要能在词典里解析。引理语义只能来自 `concept_lookup` |
| **V13** | 定理级 role 的锚点必须指向**根节点**（`n0`）；`role = "step"` 才锚子节点 |

还有：`presentation = "metaphor"` 时 `evidence` 只能是 `analogy`/`intuition`（V2）；`evidence = "formal"` 必须有 `decl`/`goal` 锚点（V3）；**行号不能当锚点**（V4）；`provenance` 三字段必填（V15）。

> 完整的 V1–V16 见 [SPEC.md](./SPEC.md) §4。

---

## 6. 三种"不完整"，应对方式不同

`coverage` 会把它们**分开报告**（v1.1 起），不要混为一谈：

| 情况 | 标志 | 你该怎么做 |
|---|---|---|
| 正常 | `degraded=false, truncated=false` | 逐节点做步骤注解 |
| **结构性退化** | `degraded=true`（`have_count=0`，树只剩根） | 降级为对**陈述本身**的说明。实测 298,996/310,579 条属此类（`by simp`、单行、term-mode 都算） |
| **被截断** | `truncated=true` | 已解析出的步骤**照常注解**，但不要声称覆盖完整 |
| **某步的陈述未知** | 该节点 `signature_unknown=true`（节点级，不是整棵树） | 见下 |

> 常见误解：`degraded=false` 不等于"树完整"，也不等于"证明没被截断"——看 `truncated`。二者正交。

**第四种：某个步骤的陈述无法恢复（v1.3）。** Lean 允许省略 `have` 的类型标注、由项推断：

```lean
have h  := exists_global_inviscid_gevrey_PDE period hq T hT ...
have hs := hp t ht
```

我们**无法**恢复这种 `have` 的类型。这不是边角情况——**lsv2 全量 17,829 个 `have` 里有 4,959 个（27.8%）是这个形态**。

处理方式：该节点的 `signature` 是空串，但带 `signature_unknown=true`，并附上该项的**逐字原文**（`raw_text`）。页面上不会渲染成一个空的编号公式，而是明确写出"本步陈述由 Lean 推断"并给出定义原文。

> 对写注解的人（agent）：`annotate_prepare` 会把 `signature_unknown` 和原文一并给你。**若无法从项本身提炼出可复用的思路，请如实填 `value_type: "none"`** —— 这一格存在的意义就是这个。

### 6.1 ⚠️ 升级/重启后：先重新 `skeleton_extract`

**产物不会因为契约升级而失效，但读取方不会知道它过期了。** 实测：重启后 `annotate_prepare` 读了重启前写的 `out/skeleton/*.json`，返回了一份**自相矛盾**的工作单——`have_count: 5` 却说 `degraded: true`，`truncate_reason` 也丢了。

工作单是喂给模型生成注解的输入，模型会照着这个错误的"结构退化"把本来完好的步骤注解降级掉。**这是静默的错误，比报错更糟。**

**实践规则**：跨版本、或改过插件代码之后，对每个要用的定理**重新跑一次 `skeleton_extract`**（会覆盖旧产物），再 `annotate_prepare`。

> **修复状态**：产物现已嵌入 `spec_version`，读取时缺戳或主版本不一致会**直接报错并提示重新 extract**，不再静默消费（`206 tests / 205 pass`）。
>
> ⚠️ 但**该修复同样要重启 Harness 才生效**。在你重启之前，请仍按上面的规则手动重跑 `skeleton_extract`。
> 重启后若读到旧产物，会看到明确报错而不是错误数据——那是预期行为，照提示重跑一次即可（约 1 秒，**不需要重做注解**，账本是同主版本、仍可读）。

---

## 7. 尚未实现 / 已知限制

| 项 | 状态 |
|---|---|
| `mathlib_search`（Loogle / LeanSearch 联网检索） | ⛔ 未实现。**目前无法按自然语言找定理名** |
| `roundtrip_eval`（`RD@K` 判据） | ⛔ 未实现。core 里已有 `roundtrip.mjs`，未接成工具 |
| 一期不做 | 验证/评测、装 Lean、微调、客户端 UI |
| 骨架覆盖率 | 含 `have` 的证明仅 **3.8%**（11,583/310,579）。`calc`/`rw` 链解析是后续项 |
| 文化取向（`culture`） | 用 `module_name` 关键词匹配，**覆盖率仅 21.4%**，未命中就不填（不要硬套） |

**改完插件代码要重启 Harness 进程**才生效——编辑文件、开关 bundle、甚至重装都不会重新加载 JS 模块（详见 ARCHITECTURE §3.5.1）。

---

## 8. 一分钟自检

```bash
cd ai4math
node --test                    # 期望 203 tests / 202 pass / 0 fail / 1 skipped
node scripts/link-dsh-deps.mjs --check   # 期望 exit 0（插件能 import @deepseek-ai/* 的前提）
```

若工具在对话里不出现：先跑上面第二条，再重启 Harness。
