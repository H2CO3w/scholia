/**
 * spike-ambiguity.mjs — 检验「往返重建不能用生成式」这一主张是否成立。
 *
 * 主张：形式陈述的精确类型不能被非形式化文本唯一重建（欠定），
 *      因此生成式比对会把「自然欠定」误判为信息损失。
 *
 * 可测代理：统计「不同声明共享同一 signature / 同一 informal_name」的规模。
 * 若碰撞显著，则「给定非形式文本 → 唯一形式陈述」本身不成立。
 *
 * 用法: node spike-ambiguity.mjs [data/lsv2.jsonl]
 */
import fs from 'node:fs'
import readline from 'node:readline'

const path = process.argv[2] ?? 'data/lsv2.jsonl'

const bySig = new Map()
const byInformalName = new Map()
const byShortName = new Map()

let n = 0
let completeTactic = 0
const t0 = Date.now()

const rl = readline.createInterface({
  input: fs.createReadStream(path, { encoding: 'utf8' }),
  crlfDelay: Infinity,
})

for await (const line of rl) {
  const s = line.trim()
  if (!s) continue
  let d
  try { d = JSON.parse(s) } catch { continue }
  n++

  const sig = (d.signature ?? '').trim()
  if (sig) {
    const arr = bySig.get(sig) ?? []
    arr.push((d.name ?? []).join('.'))
    bySig.set(sig, arr)
  }

  const iname = (d.informal_name ?? '').trim().toLowerCase()
  if (iname) {
    const arr = byInformalName.get(iname) ?? []
    arr.push((d.name ?? []).join('.'))
    byInformalName.set(iname, arr)
  }

  const short = (d.name ?? []).at(-1)
  if (short) byShortName.set(short, (byShortName.get(short) ?? 0) + 1)

  const v = (d.value ?? '').trim()
  if (d.kind === 'theorem' && v.startsWith(':= by') && v.length < 490 && v.includes('have')) {
    completeTactic++
  }
}

function report(label, map) {
  const groups = map.size
  let singletons = 0
  let inCollision = 0
  let maxSize = 0
  let maxKey = null
  for (const [k, v] of map) {
    if (v.length === 1) singletons++
    else inCollision += v.length
    if (v.length > maxSize) { maxSize = v.length; maxKey = k }
  }
  const total = singletons + inCollision
  console.log(`\n[${label}]`)
  console.log(`  唯一键数            : ${groups}`)
  console.log(`  单例键（可唯一确定）: ${singletons}  (${(100 * singletons / groups).toFixed(1)}% of keys)`)
  console.log(`  处于碰撞中的记录    : ${inCollision}  (${(100 * inCollision / total).toFixed(1)}% of records)`)
  console.log(`  最大碰撞组大小      : ${maxSize}`)
  console.log(`  最大组键（截断）    : ${String(maxKey).slice(0, 120).replace(/\n/g, ' ')}`)

  // 抽样展示一个碰撞组，看它们是否数学上真不同
  for (const [k, v] of map) {
    if (v.length >= 3 && v.length <= 6) {
      console.log(`  样例碰撞组 (size=${v.length}):`)
      for (const x of v) console.log(`      - ${x}`)
      console.log(`      共享 signature: ${String(k).slice(0, 150).replace(/\n/g, ' ')}`)
      break
    }
  }
}

console.log(`扫描记录数: ${n}   (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
report('按 signature（精确形式陈述）分组', bySig)
report('按 informal_name（人类非形式化标题）分组', byInformalName)

// 短名碰撞：文件内不同命名空间重名
let dupShort = 0
for (const c of byShortName.values()) if (c > 1) dupShort += c
console.log(`\n[按短名分组]`)
console.log(`  短名被复用（含跨命名空间）的记录: ${dupShort} (${(100 * dupShort / n).toFixed(1)}%)`)

console.log(`\n[一期样本池]`)
console.log(`  完整 tactic 证明且含嵌套 have: ${completeTactic}`)

console.log(`\n结论:`)
const sigCollisionPct = 100 * [...bySig.values()].filter(a => a.length > 1).reduce((s, a) => s + a.length, 0) / n
console.log(`  signature 碰撞率 ${sigCollisionPct.toFixed(1)}%`)
if (sigCollisionPct > 2) {
  console.log('  → 主张成立：同一形式陈述对应多个声明/命名，生成式重建无法唯一确定。')
  console.log('     必须改用判别式（K 路强制选择）作为往返判据。')
} else {
  console.log('  → 主张不成立：形式陈述基本唯一，生成式比对或可行。需重审 §5.1。')
}
