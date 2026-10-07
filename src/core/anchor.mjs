/**
 * anchor.mjs — 锚点解析与解析（纯函数；无 DSH / 无网络 / 无 LLM / 无 fs）
 *
 * 设计依据: docs/SPEC.md §2.3（Anchor）、§4（V1/V3/V4/V12）、docs/INTERFACES.md §2.4
 *
 * 核心纪律: **行号不是锚点**。锚点必须落在语义标识上:
 *   - decl    全限定声明名（稳定，跨版本可比对）
 *   - goal    骨架树节点 id（指向 have / let 子目标）
 *   - hyp     局部假设名
 *   - display 仅用于显示，**永不 ok**（V4 据此拒绝）
 *
 * 数据来源: SkeletonTree 不再携带 declIndex / hypothesisIndex（INTERFACES §2.4），
 * 因此这里的所有解析都是**遍历 skeleton.nodes 现算** —— 单一数据源，不会出现
 * 「索引与 nodes 不同步」导致的假通过。
 *
 * 两种输入形式都必须接受（这是 credential.mjs 的硬依赖）:
 *   1. Anchor 对象（SPEC §2.3 的权威形式）: {kind, target, fingerprint?}
 *   2. 遗留字符串形式: 'goal:n1' / 'decl:Mathlib.…' / 'hyp:ha' / 'display:L120'
 */

import {
  ANCHOR_KIND,
  ANCHOR_KIND_VALUES,
  STRONG_ANCHOR_KINDS,
  isEnumValue,
} from './enums.mjs'

const STRONG = new Set(STRONG_ANCHOR_KINDS)

/**
 * 全限定 Lean 名：点号分隔，每段为标识符；允许 `_root_.` 前缀。
 * 允许 Lean 的 `_`、`'`、数字、Unicode 字母与下标数字。
 */
const FQN_RE = /^(?:_root_\.)?[A-Za-z_\u00C0-\u024F\u0370-\u03FF\u1F00-\u1FFF][\w'\u00C0-\u024F\u0370-\u03FF\u2080-\u2089]*(?:\.[A-Za-z_\u00C0-\u024F\u0370-\u03FF\u1F00-\u1FFF][\w'\u00C0-\u024F\u0370-\u03FF\u2080-\u2089]*)*$/

/** 局部标识符：节点 id（n3）与假设名（ha）都是单段标识符 */
const LOCAL_RE = /^[A-Za-z_\u0370-\u03FF\u00C0-\u024F][\w'\u0370-\u03FF\u00C0-\u024F\u2080-\u2089]*$/

function isObj(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nodeMap(skeleton) {
  return isObj(skeleton) && isObj(skeleton.nodes) ? skeleton.nodes : null
}

/**
 * 规范化锚点。接受 Anchor 对象与遗留字符串两种输入，无法解析时返回 null。
 *
 * @param {object|string} input
 * @returns {{kind: string, target: string, fingerprint?: string}|null}
 */
export function parseAnchor(input) {
  if (isObj(input)) {
    const kind = typeof input.kind === 'string' ? input.kind.trim().toLowerCase() : ''
    const target = typeof input.target === 'string' ? input.target.trim() : ''
    if (!isEnumValue(ANCHOR_KIND_VALUES, kind)) return null
    if (target === '') return null
    const anchor = { kind, target }
    if (typeof input.fingerprint === 'string' && input.fingerprint !== '') {
      anchor.fingerprint = input.fingerprint
    }
    return anchor
  }
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  if (trimmed === '') return null
  const sep = trimmed.indexOf(':')
  if (sep < 0) return null
  const kind = trimmed.slice(0, sep).trim().toLowerCase()
  const target = trimmed.slice(sep + 1).trim()
  if (!isEnumValue(ANCHOR_KIND_VALUES, kind)) return null
  if (target === '') return null
  return { kind, target }
}

/**
 * 把锚点渲染成 'kind:target'，用于诊断消息。
 * 对象形式与字符串形式在这里统一，模型看到的错误里不会出现 `[object Object]`。
 */
export function formatAnchor(input) {
  const parsed = parseAnchor(input)
  if (parsed) return `${parsed.kind}:${parsed.target}`
  if (typeof input === 'string') return input
  if (input === null || input === undefined) return String(input)
  if (isObj(input)) {
    const kind = typeof input.kind === 'string' ? input.kind : '?'
    const target = typeof input.target === 'string' ? input.target : '?'
    return `${kind}:${target}`
  }
  return String(input)
}

/**
 * 解析锚点目标，判断它是否真的落在骨架树上（抓 V12 的「悬空断言」）。
 *
 * @param {object|string} anchor Anchor 对象或遗留字符串（或已规范化的锚点）
 * @param {object|null} skeleton SkeletonTree
 * @returns {{ok: boolean, kind: string|null, target: string|null, reason: string|null,
 *            fingerprintOk?: boolean|null}}
 */
export function resolveAnchor(anchor, skeleton) {
  const parsed = parseAnchor(anchor)
  if (parsed === null) {
    return { ok: false, kind: null, target: null, reason: 'unparsable-anchor' }
  }
  const { kind, target } = parsed

  if (kind === ANCHOR_KIND.DISPLAY) {
    // 行号永不作为锚点：改一行注释就会静默失效，因此永不 ok（V4）
    return { ok: false, kind, target, reason: 'display-anchor-not-verifiable' }
  }

  const nodes = nodeMap(skeleton)

  if (kind === ANCHOR_KIND.DECL) {
    if (!FQN_RE.test(target)) return { ok: false, kind, target, reason: 'malformed-decl-name' }
    if (nodes === null) return { ok: false, kind, target, reason: 'skeleton-has-no-nodes' }
    const hit = Object.keys(nodes).find((id) => nodes[id]?.decl === target)
    if (hit === undefined) return { ok: false, kind, target, reason: 'unknown-decl' }
    return { ok: true, kind, target, reason: null, fingerprintOk: checkFingerprint(parsed, nodes[hit]) }
  }

  if (kind === ANCHOR_KIND.GOAL) {
    if (!LOCAL_RE.test(target)) return { ok: false, kind, target, reason: 'malformed-goal-id' }
    if (nodes === null) return { ok: false, kind, target, reason: 'skeleton-has-no-nodes' }
    if (!Object.prototype.hasOwnProperty.call(nodes, target)) {
      return { ok: false, kind, target, reason: 'unknown-goal-node' }
    }
    return {
      ok: true,
      kind,
      target,
      reason: null,
      fingerprintOk: checkFingerprint(parsed, nodes[target]),
    }
  }

  if (kind === ANCHOR_KIND.HYP) {
    if (!LOCAL_RE.test(target)) return { ok: false, kind, target, reason: 'malformed-hyp-name' }
    if (nodes === null) return { ok: false, kind, target, reason: 'skeleton-has-no-nodes' }
    // 两条命中路径（SPEC §2.1b v1.3）：
    //   1. 某个节点签名的局部假设名（hypotheses）
    //   2. have/let 节点自己的局部名（localName）—— 这样 `hyp:h₁` 能指到 `have h₁ : …` 那一步
    const hit = Object.keys(nodes).some((id) => {
      const node = nodes[id]
      const hyps = node?.hypotheses
      if (Array.isArray(hyps) && hyps.includes(target)) return true
      return node?.localName === target
    })
    if (!hit) return { ok: false, kind, target, reason: 'unknown-hypothesis' }
    return { ok: true, kind, target, reason: null }
  }

  return { ok: false, kind, target, reason: 'unhandled-anchor-kind' }
}

/**
 * 指纹只在锚点与节点**都**带的时候才对：用在版本漂移检测（SPEC §8.1 / R6）。
 * 不参与 ok 判定 —— V12 管的是「锚点是否落地」，漂移是另一类信号，
 * 因此以 fingerprintOk 单独报出，不伪造失败。
 */
function checkFingerprint(parsed, node) {
  if (typeof parsed.fingerprint !== 'string') return null
  if (typeof node?.typeFingerprint !== 'string') return null
  return parsed.fingerprint === node.typeFingerprint
}

/**
 * 解析 + 解析到树上。逐条返回，不因第一条失败而短路（SPEC §4.1）。
 *
 * `strong` 的定义：**可解析**的强锚点（decl / goal）。悬空的 goal 不算 strong，
 * 否则 V1（main 必须有可解析锚点）会被一个不存在的节点 id 骗过。
 *
 * @param {(object|string)[]} anchors
 * @param {object|null} skeleton
 * @returns {{results: object[], hasStrong: boolean, total: number, validCount: number,
 *            strongCount: number, allValid: boolean}}
 */
export function validateAnchors(anchors, skeleton) {
  const list = Array.isArray(anchors) ? anchors : []
  const results = list.map((raw) => {
    const parsed = parseAnchor(raw)
    const resolved = resolveAnchor(parsed, skeleton)
    return {
      raw: formatAnchor(raw),
      ok: resolved.ok,
      kind: resolved.kind,
      target: resolved.target,
      reason: resolved.reason,
      strong: resolved.ok && STRONG.has(resolved.kind),
      fingerprintOk: resolved.fingerprintOk ?? null,
    }
  })
  const valid = results.filter((r) => r.ok)
  return {
    results,
    total: results.length,
    validCount: valid.length,
    strongCount: valid.filter((r) => r.strong).length,
    hasStrong: valid.some((r) => r.strong),
    allValid: results.length > 0 && valid.length === results.length,
  }
}
