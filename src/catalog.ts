/**
 * 音频 catalog:turn → 音频文件的持久、可重建索引(纯 node 逻辑,不 import cordis)。
 *
 * 真相源是磁盘音频文件(`<root>/<sessionId>/turn-<n>[-<i>].<format>`);每根目录一个
 * `catalog.json`(formatVersion=1)是派生索引,可全量重建。定位某 turn 的音频 =
 * `lookup(catalog, sessionId, turn)` → `files[]`。写盘时用内存字节直接算 `durationMs`
 * (WAV/AIFF 容器头可解析,其余记 null);`rebuild` 从磁盘读头部字节回填。
 * @module dsh-voice-tts/catalog
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** catalog 文件格式版本。 */
export const CATALOG_VERSION = 1

/** catalog 文件名(每根目录一个)。 */
export const CATALOG_FILE = 'catalog.json'

/** 一个 turn 的一段音频(catalog 内索引)。 */
export interface CatalogFile {
  /** 相对写根目录的音频路径(如 `session-…/turn-3-0.aiff`)。 */
  readonly file: string
  /** 音频格式(扩展名,决定 Content-Type 与解析方式)。 */
  readonly format: string
  /** 文件字节数。 */
  readonly bytes: number
  /** 时长毫秒;容器头可解析时为数值,否则 null。 */
  readonly durationMs: number | null
}

/** 一个 turn 的 catalog 条目。 */
export interface CatalogEntry {
  readonly sessionId: string
  readonly turn: number
  readonly files: readonly CatalogFile[]
  readonly createdAt: number
  readonly provider: string
  readonly delivery: string
}

/** 一根目录的派生索引。 */
export interface Catalog {
  readonly formatVersion: number
  readonly entries: readonly CatalogEntry[]
}

/** 空 catalog(缺失/损坏时回退)。 */
export function emptyCatalog(): Catalog {
  return { formatVersion: CATALOG_VERSION, entries: [] }
}

/**
 * 把一个任意解析出的值净化为合法 {@link Catalog}:丢弃缺字段/错类型的条目与分段。
 * catalog.json 是派生索引、可重建,故「丢弃异常行」安全(rebuild 可恢复),且保证
 * 用户手动改动/损坏 catalog 后,`lookup` 不会因 `entry.files[i]`/`file.file` 畸形而抛错。
 * @param parsed - `JSON.parse(catalog.json)` 的结果。
 * @returns 净化的 catalog。
 */
function sanitizeCatalog(parsed: unknown): Catalog {
  if (parsed === null || typeof parsed !== 'object') return emptyCatalog()
  const entriesRaw = (parsed as { entries?: unknown }).entries
  if (!Array.isArray(entriesRaw)) return emptyCatalog()
  const entries: CatalogEntry[] = []
  for (const entryRaw of entriesRaw) {
    if (entryRaw === null || typeof entryRaw !== 'object') continue
    const e = entryRaw as Record<string, unknown>
    if (typeof e.sessionId !== 'string' || typeof e.turn !== 'number' || !Array.isArray(e.files)) continue
    const files: CatalogFile[] = []
    for (const fileRaw of e.files) {
      if (fileRaw === null || typeof fileRaw !== 'object') continue
      const f = fileRaw as Record<string, unknown>
      if (typeof f.file !== 'string' || typeof f.format !== 'string') continue
      files.push({
        file: f.file,
        format: f.format,
        bytes: typeof f.bytes === 'number' ? f.bytes : 0,
        durationMs: typeof f.durationMs === 'number' ? f.durationMs : null,
      })
    }
    entries.push({
      sessionId: e.sessionId,
      turn: e.turn,
      files,
      createdAt: typeof e.createdAt === 'number' ? e.createdAt : 0,
      provider: typeof e.provider === 'string' ? e.provider : '',
      delivery: typeof e.delivery === 'string' ? e.delivery : '',
    })
  }
  return { formatVersion: CATALOG_VERSION, entries }
}

/** 读一根目录的 catalog;缺失/损坏/畸形回退空表,不抛。 */
export function loadCatalog(root: string): Catalog {
  const file = join(root, CATALOG_FILE)
  if (!existsSync(file)) return emptyCatalog()
  try {
    return sanitizeCatalog(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return emptyCatalog()
  }
}

/** 把 catalog 原子写回根目录(写临时文件后 rename)。 */
export function saveCatalog(root: string, catalog: Catalog): void {
  mkdirSync(root, { recursive: true })
  const file = join(root, CATALOG_FILE)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(catalog))
  renameSync(tmp, file)
}

/** 依 sessionId + turn 查 catalog 条目;未命中返回 undefined。 */
export function lookup(catalog: Catalog, sessionId: string, turn: number): CatalogEntry | undefined {
  return catalog.entries.find(entry => entry.sessionId === sessionId && entry.turn === turn)
}

/** 依 sessionId + turn 查某段音频的落盘路径与格式;未命中返回 undefined。 */
export function lookupFile(root: string, catalog: Catalog, sessionId: string, turn: number, index: number): { path: string; format: string } | undefined {
  const entry = lookup(catalog, sessionId, turn)
  const file = entry?.files[index]
  if (entry === undefined || file === undefined) return undefined
  return { path: join(root, file.file), format: file.format }
}

/**
 * 解析某 turn 的全部音频分段(catalog 优先,缺失时回退磁盘扫描该 session 子目录)。
 * 抗异常:即便 `catalog.json` 被删/损坏,也能从 `<root>/<sessionId>/turn-<n>*.{ext}`
 * 直接定位,保证播放不因 catalog 丢失而失效(目标里的「用户可能移动/修改配置」)。
 * @param root - 写根目录。
 * @param sessionId - 会话 id。
 * @param turn - turn 号。
 * @returns 该 turn 的分段列表(路径 + 格式 + 时长);无音频返回空数组。
 */
export function resolveTurnSegments(root: string, sessionId: string, turn: number): { path: string; format: string; durationMs: number | null }[] {
  const catalog = loadCatalog(root)
  const entry = lookup(catalog, sessionId, turn)
  if (entry !== undefined) {
    return entry.files.map(file => ({
      path: join(root, file.file),
      format: file.format,
      durationMs: file.durationMs,
    }))
  }
  const dir = join(root, sessionId)
  if (!existsSync(dir)) return []
  const prefix = `turn-${turn}`
  const result: { path: string; format: string; durationMs: number | null }[] = []
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (!name.isFile()) continue
    const match = new RegExp(`^${prefix}(?:-(\\d+))?\\.([a-z0-9]+)$`).exec(name.name)
    if (match === null) continue
    const ext = match[2]!.toLowerCase()
    if (!AUDIO_EXTENSIONS.has(ext)) continue
    const path = join(dir, name.name)
    result.push({ path, format: ext, durationMs: headerDurationMs(path, ext) })
  }
  result.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return result
}

/** upsert 一个条目(sessionId+turn 相同时替换,否则追加),返回新 catalog。 */
export function upsert(catalog: Catalog, entry: CatalogEntry): Catalog {
  const rest = catalog.entries.filter(existing => !(existing.sessionId === entry.sessionId && existing.turn === entry.turn))
  const entries = [...rest, entry].sort((a, b) =>
    a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : a.turn - b.turn)
  return { formatVersion: CATALOG_VERSION, entries }
}

/** 读取音频容器头,解析时长毫秒;不可解析的格式返回 null。 */
export function audioDurationMs(bytes: Uint8Array, format: string): number | null {
  if (format === 'wav') return wavDurationMs(bytes)
  if (format === 'aiff' || format === 'aifc') return aiffDurationMs(bytes)
  return null
}

// ---- WAV / AIFF 头解析(纯函数,可单测) ----

/** 小端读一个 32 位无符号整数。 */
function u32le(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)
}

/** 大端读一个 32 位无符号整数。 */
function u32be(b: Uint8Array, o: number): number {
  return (b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!
}

/** 80 位 IEEE 754 扩展浮点(AIFF COMM 的 sampleRate)转 number。 */
function f80(b: Uint8Array, o: number): number {
  const sign = (b[o]! & 0x80) !== 0 ? -1 : 1
  const exp = ((b[o]! & 0x7f) << 8) | b[o + 1]!
  let mantissa = 0
  for (let i = 0; i < 8; i++) mantissa = mantissa * 256 + b[o + 2 + i]!
  if (exp === 0 && mantissa === 0) return 0
  return sign * mantissa * Math.pow(2, exp - 16383 - 63)
}

/** 从 WAV(RIFF)字节解析时长毫秒;头不完整/畸形返回 null。 */
function wavDurationMs(b: Uint8Array): number | null {
  if (b.length < 12 || String.fromCharCode(b[0], b[1], b[2], b[3]) !== 'RIFF') return null
  let offset = 12
  let byteRate = 0
  let dataSize = 0
  while (offset + 8 <= b.length) {
    const id = String.fromCharCode(b[offset], b[offset + 1], b[offset + 2], b[offset + 3])
    const size = u32le(b, offset + 4)
    const body = offset + 8
    if (id === 'fmt ' && body + 16 <= b.length) {
      byteRate = u32le(b, body + 8)
    } else if (id === 'data') {
      dataSize = size
    }
    offset = body + size + (size % 2)
  }
  if (byteRate <= 0 || dataSize <= 0) return null
  return Math.round((dataSize / byteRate) * 1000)
}

/** 从 AIFF/AIFC(FORM)字节解析时长毫秒;头不完整/畸形返回 null。 */
function aiffDurationMs(b: Uint8Array): number | null {
  if (b.length < 12 || String.fromCharCode(b[0], b[1], b[2], b[3]) !== 'FORM') return null
  let offset = 12
  while (offset + 8 <= b.length) {
    const id = String.fromCharCode(b[offset], b[offset + 1], b[offset + 2], b[offset + 3])
    const size = u32be(b, offset + 4)
    const body = offset + 8
    if (id === 'COMM' && body + 18 <= b.length) {
      const frames = u32be(b, body + 2)
      const rate = f80(b, body + 8)
      if (rate > 0) return Math.round((frames / rate) * 1000)
    }
    offset = body + size + (size % 2)
  }
  return null
}

/** 从磁盘读一个音频文件头部(最多 64KB)并解析时长。 */
function headerDurationMs(path: string, format: string): number | null {
  try {
    const fd = openSync(path, 'r')
    const buf = Buffer.alloc(64 * 1024)
    const n = readSync(fd, buf, 0, buf.length, 0)
    closeSync(fd)
    return audioDurationMs(new Uint8Array(buf.subarray(0, n)), format)
  } catch {
    return null
  }
}

/** 音频扩展名集合(rebuild 扫描用)。 */
const AUDIO_EXTENSIONS = new Set(['wav', 'aiff', 'aifc', 'mp3', 'opus', 'pcm'])

/**
 * 从磁盘重建一根目录的 catalog:扫描 `<root>/<sessionId>/turn-*.{ext}`,按文件名
 * 回填 sessionId(子目录名)/ turn / 分段序号,group 成条目。未命中任何音频返回空表。
 * @param root - 写根目录。
 * @param provider - 归属 provider(重建时统一标记;无法从文件名还原)。
 * @param delivery - 归属 delivery(同上)。
 * @returns 重建后的 catalog。
 */
export function rebuildCatalog(root: string, provider = '', delivery = ''): Catalog {
  if (!existsSync(root)) return emptyCatalog()
  const filesByKey = new Map<string, CatalogFile[]>()
  const createdByKey = new Map<string, number>()
  for (const dirName of readdirSync(root, { withFileTypes: true })) {
    if (!dirName.isDirectory()) continue
    const sessionId = dirName.name
    const sessionPath = join(root, sessionId)
    for (const fileName of readdirSync(sessionPath, { withFileTypes: true })) {
      if (!fileName.isFile()) continue
      const match = /^turn-(\d+)(?:-(\d+))?\.([a-z0-9]+)$/.exec(fileName.name)
      if (match === null) continue
      const turn = Number(match[1])
      const ext = match[3]!.toLowerCase()
      if (!AUDIO_EXTENSIONS.has(ext)) continue
      const path = join(sessionPath, fileName.name)
      const stat = statSync(path)
      const key = `${sessionId}:${turn}`
      const files = filesByKey.get(key) ?? []
      files.push({
        file: `${sessionId}/${fileName.name}`,
        format: ext,
        bytes: stat.size,
        durationMs: headerDurationMs(path, ext),
      })
      filesByKey.set(key, files)
      if (createdByKey.get(key) === undefined) createdByKey.set(key, stat.mtimeMs)
    }
  }
  const entries: CatalogEntry[] = []
  for (const [key, files] of filesByKey) {
    const [sessionId, turnStr] = key.split(':')
    const turn = Number(turnStr)
    files.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
    entries.push({ sessionId: sessionId!, turn, files, createdAt: createdByKey.get(key) ?? 0, provider, delivery })
  }
  entries.sort((a, b) =>
    a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : a.turn - b.turn)
  return { formatVersion: CATALOG_VERSION, entries }
}
