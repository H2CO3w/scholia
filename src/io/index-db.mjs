/**
 * index-db.mjs — 词典索引（SQLite，`node:sqlite` 的 `DatabaseSync`；SPEC §7.1 零依赖）
 *
 * 流程见 ARCHITECTURE §5.1(a)：
 *   data/lsv2.jsonl ──流式逐行──▶ 抽 6 个字段 ──▶ cache/lexicon.db ──▶ concept_lookup 精确查询
 *
 * 表结构（INTERFACES §2.8，冻结）：
 *   lemma(name TEXT PRIMARY KEY, module TEXT, kind TEXT,
 *         signature TEXT, informal_name TEXT, informal_description TEXT)
 *
 * 建索引是**惰性**的：已存在且 count > 0 且未要求 rebuild 时直接返回；
 * `rebuild: true` 时在临时文件上重建，成功后 `rename` 原子替换（中途被杀不会留下半个索引）。
 * 取消（AbortSignal）时抛 `AbortError` 并删掉临时文件。
 */

import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { normalizeLemmaName } from '../core/lexicon.mjs'
import { throwIfAborted } from './abort.mjs'
import { streamRecords } from './corpus.mjs'

/** SELECT 的列顺序（同时决定 lookupLemma 返回行的键名 = 契约字段名）。 */
const COLUMNS = 'name, module, kind, signature, informal_name, informal_description'

/** 冻结的表结构，逐字对应 INTERFACES §2.8。 */
const CREATE_TABLE_SQL =
  'CREATE TABLE lemma(name TEXT PRIMARY KEY, module TEXT, kind TEXT, ' +
  'signature TEXT, informal_name TEXT, informal_description TEXT)'

/** 只把字符串写进库；其它类型（null/undefined/数字）一律记 NULL。 */
function asTextOrNull(value) {
  return typeof value === 'string' ? value : null
}

/** 读已有索引的行数；不存在 / 空文件 / 坏文件 → null（交给调用方重建）。 */
function existingCount(dbPath) {
  if (!existsSync(dbPath)) return null
  try {
    if (statSync(dbPath).size === 0) return null
  } catch {
    return null
  }
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    const row = db.prepare('SELECT COUNT(*) AS count FROM lemma').get()
    const count = Number(row?.count ?? 0)
    return Number.isFinite(count) && count > 0 ? count : null
  } catch {
    return null
  } finally {
    try {
      db?.close()
    } catch {
      /* 只读探测失败无需上报 */
    }
  }
}

/**
 * 惰性构建词典索引。已存在且非 rebuild 时直接返回 `built: false`。
 *
 * @param {{ corpusPath: string, dbPath: string, rebuild?: boolean, signal?: AbortSignal }} opts
 * @returns {Promise<{ count: number, built: boolean }>}
 */
export async function ensureLexiconIndex(opts) {
  const { corpusPath, dbPath, rebuild = false, signal } = opts ?? {}
  if (typeof corpusPath !== 'string' || corpusPath.trim() === '') {
    throw new TypeError(
      `ensureLexiconIndex 需要 corpusPath（语料路径），收到 ${JSON.stringify(corpusPath)}。` +
        '请检查插件 Config 的 corpusPath。',
    )
  }
  if (typeof dbPath !== 'string' || dbPath.trim() === '') {
    throw new TypeError(
      `ensureLexiconIndex 需要 dbPath（索引落盘路径），收到 ${JSON.stringify(dbPath)}。` +
        '请检查插件 Config 的 cacheDir（索引固定落在 <cacheDir>/lexicon.db）。',
    )
  }
  throwIfAborted(signal)

  if (!rebuild) {
    const count = existingCount(dbPath)
    if (count !== null) return { count, built: false }
  }
  // rebuild 时语料必须真的在：否则会先删掉可用索引再失败
  if (!existsSync(corpusPath)) {
    throw new Error(
      `语料文件不存在：${corpusPath}，索引无法重建（现有索引未被改动）。` +
        '请检查 corpusPath，或把 data/lsv2.jsonl 放到该路径后重试。',
    )
  }

  mkdirSync(dirname(dbPath), { recursive: true })
  const tmpPath = `${dbPath}.building-${process.pid}-${Date.now()}`

  let db
  let count = 0
  try {
    db = new DatabaseSync(tmpPath)
    // 索引是纯派生缓存，可随时重建：关掉 journal/sync 换取建索引速度
    db.exec('PRAGMA journal_mode = OFF')
    db.exec('PRAGMA synchronous = OFF')
    db.exec(CREATE_TABLE_SQL)
    const insert = db.prepare(`INSERT INTO lemma(${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`)

    db.exec('BEGIN')
    for await (const record of streamRecords(corpusPath, { signal })) {
      throwIfAborted(signal)
      const name = Array.isArray(record.name) ? record.name.join('.') : ''
      if (name === '') continue // 没有名字的行无法作为查询键；语料实测 310,579 条全部非空
      const moduleName = Array.isArray(record.module_name) ? record.module_name.join('.') : ''
      insert.run(
        name,
        moduleName === '' ? null : moduleName,
        asTextOrNull(record.kind),
        asTextOrNull(record.signature),
        asTextOrNull(record.informal_name),
        asTextOrNull(record.informal_description),
      )
      count += 1
    }
    db.exec('COMMIT')
    db.close()
    db = undefined
    throwIfAborted(signal)
    renameSync(tmpPath, dbPath) // 原子替换：读者要么看到旧索引，要么看到完整新索引
    return { count, built: true }
  } catch (err) {
    try {
      db?.close()
    } catch {
      /* 关闭失败时下面统一删临时文件 */
    }
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try {
        rmSync(`${tmpPath}${suffix}`, { force: true })
      } catch {
        /* 清理失败不掩盖原始错误 */
      }
    }
    if (signal?.aborted) throwIfAborted(signal)
    throw err
  }
}

/**
 * 按名字批量精确查询。**同步**（INTERFACES §2.8；`DatabaseSync` 是同步 API）。
 *
 * 返回的行是**契约原始行**（键为 snake_case 列名：name / module / kind /
 * signature / informal_name / informal_description），
 * 交给 core 之前请用 `src/io/contract.mjs` 的 `toCamel(row)` 转换（分层约束 L5）。
 *
 * `found` 与 `missing` 都保持请求顺序；未命中的名字**必须**由调用方继续上报（SPEC T2）。
 *
 * @param {string} dbPath
 * @param {string[]} names
 * @returns {{ found: object[], missing: string[] }}
 */
export function lookupLemma(dbPath, names) {
  if (typeof dbPath !== 'string' || dbPath.trim() === '') {
    throw new TypeError(
      `lookupLemma 需要 dbPath，收到 ${JSON.stringify(dbPath)}。` +
        '请检查插件 Config 的 cacheDir。',
    )
  }
  if (!Array.isArray(names)) {
    throw new TypeError(
      `lookupLemma 的 names 必须是字符串数组，收到 ${typeof names}。` +
        '请把引理名放进数组再查询（例如 ["Even.add"]）。',
    )
  }
  if (!existsSync(dbPath)) {
    throw new Error(
      `词典索引不存在：${dbPath}。` +
        '请先调用 ensureLexiconIndex({ corpusPath, dbPath }) 构建索引，或检查 cacheDir 配置。',
    )
  }

  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const stmt = db.prepare(`SELECT ${COLUMNS} FROM lemma WHERE name = ?`)
    const found = []
    const missing = []
    const seen = new Set()
    for (const rawName of names) {
      if (typeof rawName !== 'string') {
        throw new TypeError(
          `lookupLemma 的名字必须是字符串，收到 ${typeof rawName}（${JSON.stringify(rawName)}）。` +
            '请先把名字列表规整为字符串数组。',
        )
      }
      const name = rawName.trim()
      if (seen.has(name)) continue // 同名重复请求只查一次，保留首次出现的顺序
      seen.add(name)

      // 先按原样精确查（库里的键就是语料的 name.join('.')）；
      // 查不到再按归一化后的名字查一次（去掉 @ / _root_. / 反引号），两步都不命中才计 missing。
      let row = name === '' ? undefined : stmt.get(name)
      if (row === undefined) {
        const normalized = normalizeLemmaName(name)
        if (normalized !== '' && normalized !== name) row = stmt.get(normalized)
      }
      if (row === undefined) missing.push(name) // ★ 未命中如实上报（T2），不做模糊匹配兜底
      else found.push(row)
    }
    return { found, missing }
  } finally {
    db.close()
  }
}
