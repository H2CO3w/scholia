# ai4math — faithful-loss 注解工程

> **一句话**：把 Lean 形式化证明转成「带注解的可读材料」——形式化对象原样不动，注解挂在旁边，每条注解带锚点、带可信度分档、可被"不信"。
>
> **本项目相对既有工作的差异**：Hattori/Ranta 在做「把形式变成好读的散文」；本项目在做「**让散文可以被机器钉回形式，并让读者知道该在哪一句不信**」。

---

## 文档地图

| 文档 | 性质 | 什么时候读 |
|---|---|---|
| **[SPEC.md](SPEC.md)** | **规范性** — 命名 / 数据契约 / 枚举 / 校验规则 V1–V16 / 分层约束 | 写任何代码之前；字段或命名有疑问时 |
| **[ARCHITECTURE.md](ARCHITECTURE.md)** | 描述性 — 分层 / 目录 / 工具面 / 数据流 / 打包 / 里程碑 | 想知道"东西放哪、怎么连起来"时 |
| [plan-v1.0.md](../plan-v1.0.md) | 研究记录 — 判据 `RD@K` 的推导与实测 | 想知道"为什么这样定"时 |
| [decisions.md](../decisions.md) | 决策记录 D1–D8 | 想知道"谁拍过板"时 |
| [pilot/report-m1.md](../pilot/report-m1.md) | 实验报告 — K0 判据可行性 | 想知道"判据成立吗"时 |
| [ai4math-annotator-prerequisites.md](../notes/ai4math-annotator-prerequisites.md) | 前置侦察 v0.1（背景，部分机制已过时） | 查环境事实与外部接口 |
| [ai4math-annotator-dev-plan-v2.md](../notes/ai4math-annotator-dev-plan-v2.md) | 设计依据 v2.1 — 注解类型学的文献来源 | 查 Thurston/Tao/Gowers/Dyson 那条线 |

**权威顺序**：`SPEC.md` > `ARCHITECTURE.md` > `plan-v1.0.md` > 其余（背景）。

---

## 三条不可破的红线

```
1. 引理语义只能来自词典；概念段必须带 lexicon_ref        (SPEC V10)
2. 允许并强制表态「这里没有可提炼的思路」= value_type:none (SPEC V7)
3. core / render 层零外部依赖，可离线单测                (SPEC L1/L2)
```

第 3 条是 decisions.md D1 的工程前提：**判据是方法本体，插件只是载体**。这条一破，项目就从"方法"退化成"插件"。

---

## 当前状态（2026-10-07）

| 项 | 状态 |
|---|---|
| 语料 | ✅ `data/lsv2.jsonl`，332 MB / 310,579 条（Mathlib v4.28.0-rc1） |
| 判据 `RD@K` | 🟡 可行性已验证（K0 可构造、可解、不送分）；**待用真实注解层跑一次** |
| `src/core/` | ✅ 已按 SPEC 对齐；`skeleton` / `anchor` / `credential` / `lexicon` / `roundtrip` |
| 契约版本 | `spec_version 1.3.0`（v1.3 = 未知签名的诚实处理，见 ARCHITECTURE §11.1a） |
| 依赖图谱 / 主线大纲 | ✅ `out/graph/`（模块级 DAG，静态 SVG）｜**`out/outline/`（主线大纲，一页读懂证明结构）** |
| 语料外回归夹具 | 🟡 `test/fixtures/lean/` 在建（六种 `have` 形态，来源 openai/NavierStokesAndEuler，Apache-2.0） |
| 插件骨架 | ⬜ 未建（M2/M3） |
| 客户端 UI | ⛔ 一期不做（需 `dev:web` 才免刷新生效） |
| Lean 工具链 | ⛔ 未安装，一期不需要 |

**关键路径**：`SPEC.md` → `core/enums.mjs` → `credential.mjs`（V1–V16）→ `annotation_check` → M3 可见。

---

## 目录速查

```
ai4math/
├── docs/          ← SPEC.md / ARCHITECTURE.md / README.md（本文）
├── data/          ← lsv2.jsonl（332 MB，不入包）
├── cache/         ← lexicon.db（SQLite 索引，惰性构建）
├── out/           ← skeleton/ ledger/ render/ report/
├── src/core/      ← ★ 零依赖纯逻辑（方法本体）
├── src/io/        ← 语料流式读、SQLite、产物落盘、契约转换
├── src/net/       ← Loogle / LeanSearch
├── src/render/    ← Ledger → HTML（双向锚点）
├── src/tools/     ← DSH 绑定层（唯一 import dsh-tools 的地方）
└── test/          ← node --test（含分层强制测试）
```

---

## 怎么开始

```bash
# 1. 分层与 core 单测（不需要插件、不需要网络）
node --test

# 2. ★ 建 @deepseek-ai/* 解析链接（安装前必做，否则 install_bundle 报 failed to import）
#    原因见 ARCHITECTURE §3.5：link 方式安装的工作区插件解析不到 DSH 安装目录里的包。
node scripts/link-dsh-deps.mjs          # 加 --check 只自检不写
```

```bash
# 3. 安装（一步，勿手改 profile）
#    plugin_manager: action=install_bundle, target=<ai4math 绝对路径>
#    用返回的 application 字段判断是否生效；注意它同时会跑一次 pnpm，
#    若之后工具没出现，先重跑第 2 步。

# 4. 确认工具对模型可见并实际调用一次
#    cordis_inspect_query: platform=host, provider=Tool, method=listTools
#    然后实际调用 concept_lookup / skeleton_extract / annotation_check
```

> ⚠️ **改完插件代码后必须重启 Harness 进程才生效**——编辑 `src/**`、`set_bundle` 开关、甚至 `remove_bundle` + 重新 `install_bundle` **都不会**重新加载 JS 模块代（工具照常可调，只是跑旧代码，静默）。判定方法：把「磁盘上直接 import 该模块的输出」与「工具调用的输出」对比，不同即为旧模块。详见 ARCHITECTURE §3.5.1。

**已验证的端到端链路**（2026-10-07 真机）：

```
skeleton_extract("Even.add")  → SkeletonTree + coverage（诚实报告 degraded）
concept_lookup([...])         → 命中条目 + 显式 missing[]
annotation_check([...])       → 1 通过 / 1 拒绝，4 条诊断各带修复动作
annotate_submit([...])        → 写入 out/ledger/Even.add.json + 指标
ledger_export("Even.add")     → out/render/Even.add.html（双向锚点 + V6 CSS 过滤）
```

---

## 未拍板项

| # | 事项 | 建议 | 阻塞开工？ |
|---|---|---|---|
| D8 | 项目代号 | `faithful-loss` | ❌ 包名已锁定 `dsh-scholia` |
| D9 | 是否保留 `significance` 与 `role` 两个维度 | 保留（正交） | ❌ |
| D10 | `segments` 是否强制分段 | 强制（≥1 段） | ❌ |
| D11 | 二期前端坐 `sidebar.right.tab.document` 还是 `main` | 前者 | ❌ 二期事 |
