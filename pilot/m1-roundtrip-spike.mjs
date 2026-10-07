/**
 * m1-roundtrip-spike.mjs — M1 判据可行性实验
 *
 * 回答四个问题:
 *   Q1 K0（碰撞组内选择）任务能否大规模构造？              → 题量是否足够
 *   Q2 任务的可解性与难度如何随**碰撞组大小**变化？          → 难度旋钮在哪
 *   Q3 人类撰写的 informal_description 能否解 K0？          → 任务是否**可解**（不是无解题）
 *   Q4 朴素词汇基线能否解 K0？                              → 任务是否**太容易**（否则判据无意义）
 *
 * 用法: node pilot/m1-roundtrip-spike.mjs [data/lsv2.jsonl] [--json]
 *
 * ★ 教训（v1 的 bug）: 必须按 K 分层报告。size=2 的碰撞组随机基线就是 50%，
 *   把它和 size=8 混在一起平均，会得出「随机基线 49%」这种无意义结论。
 */

import fs from 'node:fs'
import readline from 'node:readline'
import {
  buildCollisionGroups,
  tasksFromCollisionGroup,
  evaluateTasks,
  baselines,
} from '../src/core/roundtrip.mjs'
import { isEvaluationSafe } from '../src/core/skeleton.mjs'

const args = process.argv.slice(2)
const path = args.find((a) => !a.startsWith('--')) ?? 'data/lsv2.jsonl'
const asJson = args.includes('--json')

/** 难度旋钮：碰撞组大小 = 候选数量 K */
const MIN_GROUP_SIZE = Number(process.env.MIN_GROUP ?? 3)
const MAX_GROUP_SIZE = Number(process.env.MAX_GROUP ?? 12)

async function loadRecords(path) {
  const all = []
  const safe = []
  const rl = readline.createInterface({
    input: fs.createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  for await (const line of rl) {
    const s = line.trim()
    if (!s) continue
    let d
    try {
      d = JSON.parse(s)
    } catch {
      continue
    }
    const rec = {
      name: d.name ?? [],
      module_name: d.module_name ?? [],
      signature: d.signature ?? '',
      type: d.type ?? '',
      kind: d.kind,
      value: d.value ?? '',
      informal_name: d.informal_name ?? null,
      informal_description: d.informal_description ?? '',
    }
    all.push(rec)
    if (isEvaluationSafe(d)) safe.push(rec)
  }
  return { all, safe }
}

function makeTasks(records) {
  const groups = buildCollisionGroups(records, MAX_GROUP_SIZE).filter((g) => g.members.length >= MIN_GROUP_SIZE)
  const tasks = []
  for (const g of groups) {
    tasks.push(
      ...tasksFromCollisionGroup(g, {
        // ★ 题面 = 人类撰写的非形式化描述（现有最强注解代理）
        questionFn: (r) => String(r.informal_description ?? ''),
        maxTasks: 12,
        seed: 7,
      }),
    )
  }
  return { groups, tasks }
}

/** 按 K（候选数）分层评测 */
async function evaluateByK(tasks) {
  const byK = new Map()
  for (const t of tasks) {
    const k = t.candidates.length
    if (!byK.has(k)) byK.set(k, [])
    byK.get(k).push(t)
  }
  const layers = []
  for (const k of [...byK.keys()].sort((a, b) => a - b)) {
    const layerTasks = byK.get(k)
    const row = { K: k, n: layerTasks.length, chance: 1 / k, baselines: {} }
    for (const [name, mk] of [
      ['random', () => baselines.random(99)],
      ['nameLex', () => baselines.nameLex()],
      ['tfidfName', () => baselines.tfidfName()],
    ]) {
      const r = await evaluateTasks(layerTasks, mk())
      row.baselines[name] = { accuracy: r.accuracy, correct: r.correct }
    }
    layers.push(row)
  }
  // 聚合（按任务数加权）
  const totals = { n: tasks.length, baselines: {} }
  for (const name of ['random', 'nameLex', 'tfidfName']) {
    let c = 0
    for (const l of layers) c += l.baselines[name].correct
    totals.baselines[name] = { accuracy: tasks.length ? c / tasks.length : 0, correct: c }
  }
  return { layers, totals }
}

const { all, safe } = await loadRecords(path)

const suites = [
  { title: 'A. 全语料碰撞组', data: all },
  { title: 'B. 评测安全池（完整 tactic 证明）碰撞组', data: safe },
]

const output = {
  generatedAt: new Date().toISOString(),
  source: path,
  minGroupSize: MIN_GROUP_SIZE,
  maxGroupSize: MAX_GROUP_SIZE,
  suites: [],
}

for (const suite of suites) {
  const { groups, tasks } = makeTasks(suite.data)
  const { layers, totals } = await evaluateByK(tasks)
  output.suites.push({
    title: suite.title,
    records: suite.data.length,
    groups: groups.length,
    tasks: tasks.length,
    layers,
    totals,
    sampleTasks: tasks
      .filter((t) => t.candidates.length >= 4)
      .slice(0, 2)
      .map((t) => ({
        id: t.id,
        K: t.candidates.length,
        candidates: t.candidates.map((c) => ({ decl: c.decl, informal_name: c.informal_name, signature: c.signature })),
        answerIndex: t.answerIndex,
        question: t.question.slice(0, 320),
      })),
  })
}

if (asJson) {
  console.log(JSON.stringify(output, null, 2))
  process.exit(0)
}

const pct = (x) => (100 * x).toFixed(1).padStart(5) + '%'

console.log('='.repeat(78))
console.log(`M1 判据可行性实验 —— K0 碰撞组判别   (组大小 ${MIN_GROUP_SIZE}–${MAX_GROUP_SIZE})`)
console.log('='.repeat(78))
for (const s of output.suites) {
  console.log(`\n【${s.title}】`)
  console.log(`  语料记录 ${s.records} ｜ 碰撞组 ${s.groups} ｜ K0 任务 ${s.tasks}`)
  if (s.tasks === 0) {
    console.log('  （无满足条件的碰撞组）')
    continue
  }
  console.log('  ┌──────┬──────┬────────┬──────────┬──────────┬───────────┐')
  console.log('  │  K   │  n   │ 随机   │ nameLex  │ tfidfName│  随机基准 │')
  console.log('  ├──────┼──────┼────────┼──────────┼──────────┼───────────┤')
  for (const l of s.layers) {
    console.log(
      `  │ ${String(l.K).padStart(4)} │ ${String(l.n).padStart(4)} │ ${pct(l.baselines.random.accuracy)} │ ${pct(
        l.baselines.nameLex.accuracy,
      )} │ ${pct(l.baselines.tfidfName.accuracy)} │ ${pct(l.chance).padStart(9)} │`,
    )
  }
  console.log('  └──────┴──────┴────────┴──────────┴──────────┴───────────┘')
  console.log(
    `  加权总计: random ${pct(s.totals.baselines.random.accuracy)} ｜ nameLex ${pct(
      s.totals.baselines.nameLex.accuracy,
    )} ｜ tfidfName ${pct(s.totals.baselines.tfidfName.accuracy)}`,
  )
  for (const t of s.sampleTasks) {
    console.log(`\n  样例 [${t.id}] K=${t.K}`)
    t.candidates.forEach((c, i) => {
      console.log(`    ${i === t.answerIndex ? '→' : ' '} ${i}. ${c.decl}  «${String(c.informal_name).slice(0, 70)}»`)
    })
    console.log(`    题面: ${t.question.slice(0, 190).replace(/\n/g, ' ')}`)
  }
}
console.log('\n' + '='.repeat(78))
console.log('判读准则:')
console.log('  · nameLex / tfidfName 远高于随机 → K0 对朴素方法**太容易**（如 K=2 时题面几乎自动可解）')
console.log('  · nameLex / tfidfName 接近随机   → K0 对朴素方法**不可解**，必须真实注解层才能解')
console.log('  · 关键列是 K≥4：K=2 的信息量极低，不应作为主指标')
console.log('='.repeat(78))
