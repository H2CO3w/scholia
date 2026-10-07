/**
 * lexicon.mjs — 词典条目的**纯逻辑**（SPEC §2 / §6.2 T2；分层约束 L1：无 I/O）
 *
 * 这里只有两件事：
 *   1. `normalizeLemmaName` —— 把证据里抽出来的引理名归一化成查询键；
 *   2. `shapeEntries`       —— 把「查到的行 + 没查到的名字」整形为有界、**未命中不静默省略**的输出。
 *
 * ★ T2：模型必须知道「词典里没有」。所以 `missing` 是返回值的必需字段，永远显式列出，
 *   本函数不做「查不到就当没问过」的处理（那正是 R3 编造引理语义的入口）。
 *
 * 本文件禁止 import node:fs / node:net / node:sqlite / fetch / @deepseek-ai/*（L1），
 * 因此它不 import 任何东西；SQLite 查询在 src/io/index-db.mjs。
 * 字段名一律 camelCase（INTERFACES §0.1）；转化由 src/io/contract.mjs 的 toCamel 完成。
 */

/** 一个条目里承载「确实查到了东西」的 camelCase 字段（用于识别 miss 占位与未转换的原始行）。 */
const PAYLOAD_FIELDS = Object.freeze([
  'module',
  'kind',
  'signature',
  'informalName',
  'informalDescription',
])

/** 只接受字符串；其它类型（含 null / undefined）一律归为 null。 */
function asStringOrNull(value) {
  return typeof value === 'string' ? value : null
}

/**
 * 引理名归一化。只做**可逆且无歧义**的处理，不做模糊匹配：
 *   - 去掉首尾空白；
 *   - 去掉 Lean 的显式参数前缀 `@`（`@Even.add` → `Even.add`）；
 *   - 去掉 `_root_.` 前缀；
 *   - 去掉首尾包裹的反引号（`` `Even.add` `` / ``` ``Even.add`` ```）。
 *
 * 找不到可归一化的内容（非字符串、空白、只剩前缀）时返回 `''`；
 * 调用方必须把 `''` 计为未命中（不得静默省略）。
 * 不做模糊匹配、不做大小写折叠：查不到就是查不到，交给 `missing` 如实上报（T2 / §7.6）。
 *
 * @param {unknown} name
 * @returns {string}
 */
export function normalizeLemmaName(name) {
  if (typeof name !== 'string') return ''
  let s = name.trim()
  for (let i = 0; i < 4; i++) {
    const before = s
    if (s.length >= 2 && s.startsWith('`') && s.endsWith('`')) s = s.slice(1, -1).trim()
    while (s.startsWith('@')) s = s.slice(1).trim()
    if (s.startsWith('_root_.')) s = s.slice('_root_.'.length).trim()
    if (s === before) break
  }
  return s
}

/**
 * 把一个元素解析为 `{ kind: 'found' | 'miss' | 'skip', name, row }`。
 *
 * 允许三种写法（这样调用方无论怎么拼都不会把 miss 丢掉）：
 *   - 裸字符串          → 未命中（T2 的主要表达方式）
 *   - `{ name }` 单键对象 → 未命中
 *   - 带 camelCase 载荷字段的对象（index-db 的行经 toCamel 之后）→ 命中
 *
 * 防御：只要对象的**键**里出现下划线，就说明它是没做 toCamel 的契约原始行（sqlite 列名）。
 * 此时宁可抛错也不静默返回 `informalName: null`——那会让模型以为词典里没有这条语义，
 * 正是 R3（编造引理含义）的入口。
 */
function classifyEntry(element) {
  if (element === null || element === undefined) return { kind: 'skip' }
  if (typeof element === 'string' || typeof element === 'number') {
    return { kind: 'miss', name: String(element) }
  }
  if (typeof element !== 'object' || Array.isArray(element)) {
    throw new TypeError(
      `入口 ${JSON.stringify(element)} 不是「词典条目 / 未命中名字」两种允许的形态。` +
        '请传对象（命中行）或字符串（未命中的名字）。',
    )
  }
  const keys = Object.keys(element)
  if (!Object.hasOwn(element, 'name')) {
    throw new TypeError(
      `入口 ${JSON.stringify(element).slice(0, 120)} 缺少 name 字段。` +
        '命中的行必须带 name；未命中请直接传名字字符串。',
    )
  }
  const snakeKey = keys.find((k) => k.includes('_'))
  if (snakeKey !== undefined) {
    throw new TypeError(
      `条目 ${JSON.stringify(element.name)} 带 snake_case 键 ${JSON.stringify(snakeKey)}，` +
        '说明它是未转换的契约原始行。请先用 src/io/contract.mjs 的 toCamel(row) 转换，再交给 shapeEntries。',
    )
  }
  const hasPayload = PAYLOAD_FIELDS.some((k) => Object.hasOwn(element, k))
  if (!hasPayload) {
    if (keys.length === 1) return { kind: 'miss', name: String(element.name) }
    throw new TypeError(
      `条目 ${JSON.stringify(element.name)} 既没有 camelCase 载荷字段，也不是只带 name 的未命中占位。` +
        '命中行请带 module/kind/signature/informalName/informalDescription 中的至少一个；' +
        '未命中请直接传名字字符串。',
    )
  }
  return { kind: 'found', name: String(element.name), row: element }
}

/**
 * 整形词典查询结果：有界（T1）且未命中显式（T2）。
 *
 * @param {unknown} entries 命中行与未命中名字混排的数组（请求序），
 *                          或 `index-db.lookupLemma` 的 `{ found, missing }` 结果对象。
 *                          命中行的字段名必须是 camelCase。
 * @param {{ maxEntries: number, descriptionChars: number }} opts
 * @returns {{
 *   entries: { name: string, module: string|null, kind: string|null, signature: string,
 *              informalName: string|null, informalDescription: string|null,
 *              descriptionTruncated: boolean }[],
 *   missing: string[],
 *   truncated: boolean,
 * }}
 */
export function shapeEntries(entries, opts) {
  if (opts === null || typeof opts !== 'object') {
    throw new TypeError(
      'shapeEntries 需要 opts = { maxEntries, descriptionChars }（取自插件 Config）。' +
        `收到 ${JSON.stringify(opts)}，请检查调用处是否漏传配置。`,
    )
  }
  const maxEntries = opts.maxEntries
  const descriptionChars = opts.descriptionChars
  for (const [key, value] of [
    ['maxEntries', maxEntries],
    ['descriptionChars', descriptionChars],
  ]) {
    if (!Number.isInteger(value) || value < 0) {
      throw new TypeError(
        `shapeEntries 的 opts.${key} 必须是非负整数（当前 ${JSON.stringify(value)}）。` +
          '请检查插件 Config 中的对应字段。',
      )
    }
  }

  let list
  if (Array.isArray(entries)) {
    list = entries
  } else if (entries !== null && typeof entries === 'object') {
    // 容错：允许直接传 lookupLemma 的返回值 { found, missing }
    list = []
    if (Array.isArray(entries.found)) list.push(...entries.found)
    if (Array.isArray(entries.missing)) list.push(...entries.missing)
  } else {
    throw new TypeError(
      'entries 必须是数组（命中行与未命中名字混排），或 { found, missing } 结果对象。' +
        `收到 ${JSON.stringify(entries)}。`,
    )
  }

  const shaped = []
  const missing = []
  const seenNames = new Set()
  let entriesTruncated = false

  for (const element of list) {
    const item = classifyEntry(element)
    if (item.kind === 'skip') continue
    const name = normalizeLemmaName(item.name)
    if (name === '') continue // 归一化后为空：无从报告，也不参与去重
    if (seenNames.has(name)) continue // 同名重复请求只报一次，保留首次出现的顺序
    seenNames.add(name)

    if (item.kind === 'miss') {
      // ★ T2：未命中一律显式列出。missing 是短名字列表，其长度由调用方请求的名字数决定，
      //   不做 maxEntries 截断——把「词典里没有」截掉正是 R3 的入口。
      missing.push(name)
      continue
    }

    if (shaped.length >= maxEntries) {
      entriesTruncated = true
      continue
    }
    const row = item.row
    const rawDescription = asStringOrNull(row.informalDescription)
    const descriptionTruncated = rawDescription !== null && rawDescription.length > descriptionChars
    shaped.push({
      name,
      module: asStringOrNull(row.module),
      kind: asStringOrNull(row.kind),
      signature: asStringOrNull(row.signature) ?? '',
      informalName: asStringOrNull(row.informalName),
      informalDescription:
        rawDescription === null
          ? null
          : descriptionTruncated
            ? rawDescription.slice(0, descriptionChars)
            : rawDescription,
      descriptionTruncated,
    })
  }

  return { entries: shaped, missing, truncated: entriesTruncated }
}
