/**
 * contract.mjs — 契约命名转换的**唯一实现点**（分层约束 L5，SPEC §1.1 / §5.2）
 *
 * 规则（INTERFACES §0.1）：
 *   - 落盘 JSON、工具参数、工具输出 = `snake_case`
 *   - `src/core/**`、`src/io/**`、`src/render/**` 内部 = `camelCase`
 *   - 转换函数只允许定义在本文件；其它模块要用就 import 这里的 toCamel / toSnake
 *
 * ★ 枚举的「值」是数据不是键：`'core_idea'`、`'tactic-multiline'`、`'grad-math'` 一律原样保留。
 *   本文件只遍历**对象的键**，从不改写字符串值；并且在键上做了「数据键保护」：
 *   含 `.`、`/`、空格、非 ASCII 的键（如 `'Even.add'`、`'term_/ₚ_'`）视为数据键，原样保留。
 *
 * 幂等性（保证调用方可以放心重复转换）：
 *   toCamel(toCamel(x)) === toCamel(x)；toSnake(toSnake(x)) === toSnake(x)。
 * 已知不可逆点：连续大写缩写（`XMLHttpRequest` → `xml_http_request` → `xmlHttpRequest`）。
 *   本项目的契约键不含缩写串，故不影响 `snake → camel → snake` 往返。
 *
 * 纯逻辑：只用 JS 内建能力，无 fs / 网络 / DSH 依赖。
 */

/** 可作为「snake_case 键」参与转换的形状：可有前导下划线，其余是标识符字符。 */
const SNAKE_KEY_RE = /^_*[A-Za-z][A-Za-z0-9_]*$/

/** 可作为「camelCase 键」参与转换的形状：纯标识符，不含分隔符。 */
const CAMEL_KEY_RE = /^[A-Za-z][A-Za-z0-9]*$/

/**
 * 只把「字面量对象」当作容器递归；
 * 数组单独处理；Date / Map / Set / Buffer / 类实例一律原样返回（它们不是契约对象）。
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * `type_fingerprint` → `typeFingerprint`；已是 camelCase 的键原样返回（幂等）。
 * 前导下划线保留；不含分隔符的数据键（`Even.add` / `term_/ₚ_` / `n0`）原样保留。
 */
function camelKey(key) {
  if (!SNAKE_KEY_RE.test(key)) return key
  const lead = /^_*/.exec(key)[0]
  const body = key.slice(lead.length)
  if (!body.includes('_')) return key
  return lead + body.replace(/_+([A-Za-z0-9])/g, (_, c) => c.toUpperCase())
}

/**
 * `typeFingerprint` → `type_fingerprint`；已是 snake_case 的键原样返回（幂等）。
 * 含 `.` / `/` / 空格 / 非 ASCII 的数据键（`Even.add`、`term_/ₚ_`）原样保留。
 */
function snakeKey(key) {
  if (!CAMEL_KEY_RE.test(key)) return key
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
}

/** 深转换：数组逐项、纯对象逐值；键由 mapKey 决定。 */
function transform(value, mapKey) {
  if (Array.isArray(value)) {
    const out = new Array(value.length)
    for (let i = 0; i < value.length; i++) out[i] = transform(value[i], mapKey)
    return out
  }
  if (!isPlainObject(value)) return value
  const out = {}
  for (const [key, val] of Object.entries(value)) {
    const mapped = mapKey(key)
    if (Object.hasOwn(out, mapped)) {
      // 不静默吞字段：两个键映射到同一个名字时必须报错，而不是后者覆盖前者（SPEC §7.6 诚实性）
      throw new TypeError(
        `契约键冲突：${JSON.stringify(key)} 与已有键都映射到 ${JSON.stringify(mapped)}。` +
          '请检查输入对象是否同时含有 snake_case 与 camelCase 两种写法的同一个字段。',
      )
    }
    out[mapped] = transform(val, mapKey)
  }
  return out
}

/**
 * 深转换：snake_case 键 → camelCase。
 * @param {unknown} value
 * @returns {any}
 */
export function toCamel(value) {
  return transform(value, camelKey)
}

/**
 * 深转换：camelCase 键 → snake_case。
 * @param {unknown} value
 * @returns {any}
 */
export function toSnake(value) {
  return transform(value, snakeKey)
}

/**
 * 声明名的文件名 slug（SPEC §2.6）。
 * 全限定名**原样保留点号**，`/` 替换为 `_`；不哈希、不截断。
 *
 * @param {string} decl 全限定名，如 `'Mathlib.Algebra.Group.Even.add'`
 * @returns {string}
 */
export function slugify(decl) {
  if (typeof decl !== 'string') {
    throw new TypeError(
      `slugify 需要一个字符串声明名，收到 ${typeof decl}。` +
        '请传入全限定名，例如 "Mathlib.Algebra.Group.Even.add"。',
    )
  }
  const trimmed = decl.trim()
  if (trimmed === '') {
    throw new TypeError('slugify 收到空声明名。请检查语料中该记录的 name 字段，或传入全限定名。')
  }
  return trimmed.replaceAll('/', '_')
}
