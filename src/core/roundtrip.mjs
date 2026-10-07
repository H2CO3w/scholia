/**
 * roundtrip.mjs — K 路判别式往返判据（纯函数，无 DSH / 无网络 / 无 LLM）
 *
 * 设计依据: plan-v1.0.md §5
 *
 * v0.1 的「生成式重建 + 逐字比对」经实测证伪: 7.9% 记录共享同一 signature，
 * 最粗碰撞组 979 条。生成式会把「公式本身未指定的部分」误判为「注解丢失信息」。
 *
 * 本模块实现判别式:
 *   K0 = 碰撞组内选择   ← 实测发现的最难、最干净来源
 *   K1 = 随机干扰项
 *   K2 = 近邻干扰项（由调用方按 distance 传入）
 *   K4 = 扰动生成（由调用方传入，需人工核）
 */

/** 确定性伪随机（可复现，不依赖 Math.random） */
export function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Fisher–Yates，使用注入的 rng 保证可复现 */
export function shuffle(arr, rng) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/**
 * 按 signature 分组，返回碰撞组（size > 1）。
 * @param {{name: string, signature: string, [k: string]: any}[]} records
 * @param {number} [maxGroupSize] 过大的组（如 979 条）不适合直接出题，默认保留
 */
export function buildCollisionGroups(records, maxGroupSize = Number.POSITIVE_INFINITY) {
  const bySig = new Map()
  for (const r of records) {
    const sig = String(r.signature ?? '').trim()
    if (!sig) continue
    if (!bySig.has(sig)) bySig.set(sig, [])
    bySig.get(sig).push(r)
  }
  const groups = []
  for (const [signature, members] of bySig) {
    if (members.length < 2 || members.length > maxGroupSize) continue
    groups.push({ signature, members })
  }
  groups.sort((a, b) => b.members.length - a.members.length)
  return groups
}

/**
 * 构造一条判别任务。
 * @param {object} spec
 * @param {string} spec.id
 * @param {string} spec.target      正确答案的声明名
 * @param {string} spec.question    题面（通常是注解层文本）
 * @param {{decl: string, signature: string, informal_name?: string}[]} spec.candidates
 * @param {'K0'|'K1'|'K2'|'K4'} spec.level
 * @param {number} [spec.seed]
 */
export function buildTask(spec) {
  const rng = mulberry32(spec.seed ?? 12345)
  const unique = []
  const seen = new Set()
  for (const c of spec.candidates) {
    if (seen.has(c.decl)) continue
    seen.add(c.decl)
    unique.push(c)
  }
  if (!seen.has(spec.target)) throw new Error(`候选集不含目标: ${spec.target}`)
  const shuffled = shuffle(unique, rng)
  return {
    id: spec.id,
    level: spec.level,
    question: spec.question,
    candidates: shuffled.map((c, i) => ({ index: i, decl: c.decl, signature: c.signature, informal_name: c.informal_name ?? null })),
    answerIndex: shuffled.findIndex((c) => c.decl === spec.target),
    target: spec.target,
    ambiguityClass:
      unique.filter((c) => (c.signature ?? '').trim() === (shuffled.find((x) => x.decl === spec.target)?.signature ?? '').trim()).length,
  }
}

/** 从碰撞组生成 K0 任务 */
export function tasksFromCollisionGroup(group, opts = {}) {
  const { questionFn, seed = 7, maxTasks = Number.POSITIVE_INFINITY } = opts
  const tasks = []
  const members = group.members
  for (let i = 0; i < members.length && tasks.length < maxTasks; i++) {
    const target = members[i]
    const targetName = (target.name ?? []).join('.')
    const others = members.filter((_, j) => j !== i)
    const candidates = [target, ...others].map((r) => ({
      decl: (r.name ?? []).join('.'),
      signature: r.signature ?? '',
      informal_name: r.informal_name ?? null,
    }))
    tasks.push(
      buildTask({
        id: `K0-${tasks.length}`,
        target: targetName,
        question: questionFn ? questionFn(target) : String(target.informal_description ?? ''),
        candidates,
        level: 'K0',
        seed: seed + tasks.length,
      }),
    )
  }
  return tasks
}

/* ------------------------------------------------------------------ *
 * 评分与基线
 *
 * 判别式判据必须先证明「任务不是无解的」。因此这里提供两个**免费基线**:
 *   - random  : 随机猜
 *   - nameLex : 仅用「候选名最后一段的词是否出现在注解文本里」
 *   - tfidf   : IDF 加权的词重叠
 * 判据只有在注解层**显著**超过这些基线时才有意义（plan-v1.0.md §5.2）。
 * ------------------------------------------------------------------ */

const STOP = new Set(['a', 'an', 'the', 'of', 'is', 'in', 'for', 'and', 'to', 'that', 'it', 'on', 'by', 'with', 'as', 'be', 'are', 'set', 's', 'x', 'y'])

export function tokenize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/\\[a-zA-Z]+/g, ' ')
    .split(/[^a-z0-9_\u0370-\u03FF]+/u)
    .filter((t) => t.length > 2 && !STOP.has(t))
}

/** 语料级 IDF，避免对高频词过度计分 */
export function buildIdf(docs) {
  const df = new Map()
  for (const d of docs) for (const t of new Set(tokenize(d))) df.set(t, (df.get(t) ?? 0) + 1)
  const N = Math.max(docs.length, 1)
  const idf = new Map()
  for (const [t, n] of df) idf.set(t, Math.log((N + 1) / (n + 1)) + 1)
  return idf
}

function idfScore(questionTokens, docTokens, idf) {
  const q = new Set(questionTokens)
  const d = new Set(docTokens)
  let s = 0
  for (const t of d) if (q.has(t)) s += idf.get(t) ?? 1
  return s
}

/**
 * 评测一组任务。
 * @param {object[]} tasks
 * @param {{choose: (task: object) => number|Promise<number>}} agent 受测者
 * @param {{idf?: Map<string, number>}} [opts]
 */
export async function evaluateTasks(tasks, agent, opts = {}) {
  const idf = opts.idf ?? new Map()
  const rows = []
  for (const task of tasks) {
    const picked = await agent.choose(task)
    const correct = picked === task.answerIndex
    rows.push({ id: task.id, level: task.level, picked, answerIndex: task.answerIndex, correct, ambiguityClass: task.ambiguityClass })
  }
  const n = rows.length
  const correctCount = rows.filter((r) => r.correct).length
  return {
    n,
    correct: correctCount,
    accuracy: n === 0 ? 0 : correctCount / n,
    rows,
    idf,
  }
}

export const baselines = {
  /** 随机猜 */
  random(seed = 99) {
    const rng = mulberry32(seed)
    return { name: 'random', choose: (task) => Math.floor(rng() * task.candidates.length) }
  },
  /** 候选名最后一段是否出现在题面 */
  nameLex() {
    return {
      name: 'nameLex',
      choose: (task) => {
        const q = String(task.question ?? '').toLowerCase()
        // 未命中任何候选名时，明确弃权（返回 -1 计为错），
        // 否则会静默偏向 index 0，产生**低于随机**的假象（v1 的 bug）
        let best = -1
        let bestScore = 0
        task.candidates.forEach((c) => {
          const short = c.decl.split('.').at(-1).toLowerCase()
          const score = q.includes(short) ? short.length : 0
          if (score > bestScore) {
            bestScore = score
            best = c.index
          }
        })
        return best
      },
    }
  },
  /** IDF 加权词重叠（题面 vs 候选 informal_name） */
  tfidfName() {
    return {
      name: 'tfidfName',
      choose: (task) => {
        // 用候选的 informal_name 作为该候选的文档
        const docs = task.candidates.map((c) => c.informal_name ?? c.decl)
        const idf = buildIdf(docs)
        const q = tokenize(task.question)
        let best = 0
        let bestScore = -1
        task.candidates.forEach((c) => {
          const score = idfScore(q, tokenize(c.informal_name ?? c.decl), idf)
          if (score > bestScore) {
            bestScore = score
            best = c.index
          }
        })
        return best
      },
    }
  },
}
