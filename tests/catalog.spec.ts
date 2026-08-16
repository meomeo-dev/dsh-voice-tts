import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  audioDurationMs, emptyCatalog, loadCatalog, lookup, lookupFile, rebuildCatalog, saveCatalog, upsert,
} from '../src/catalog.ts'
import type { CatalogEntry } from '../src/catalog.ts'

/** 小端写 32 位。 */
function u32le(b: number[], v: number): void {
  b.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff)
}

/** 大端写 32 位。 */
function u32be(b: number[], v: number): void {
  b.push((v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff)
}

/** 大端写 16 位。 */
function u16be(b: number[], v: number): void {
  b.push((v >> 8) & 0xff, v & 0xff)
}

/** 构造一段 1 秒(byteRate=16000, dataSize=16000)的单声道 8kHz 16bit WAV。 */
function wav1s(): Uint8Array {
  const b: number[] = []
  b.push(...[...'RIFF'].map(c => c.charCodeAt(0)))
  u32le(b, 36 + 16000) // riff size
  b.push(...[...'WAVE'].map(c => c.charCodeAt(0)))
  b.push(...[...'fmt '].map(c => c.charCodeAt(0)))
  u32le(b, 16) // fmt size
  u16be(b, 1) // audioFormat = PCM(1)，little-endian 写成 01 00 —— 此处仅测试路径，fmt 字段不参与时长
  b.push(1, 0) // channels = 1 (LE)
  u32le(b, 8000) // sampleRate
  u32le(b, 16000) // byteRate
  b.push(2, 0) // blockAlign = 2
  b.push(16, 0) // bitsPerSample = 16
  b.push(...[...'data'].map(c => c.charCodeAt(0)))
  u32le(b, 16000) // data size
  return new Uint8Array(b)
}

/** 构造一段 1 秒(8000 帧 @ 8000Hz)的 AIFF。 */
function aiff1s(): Uint8Array {
  const b: number[] = []
  b.push(...[...'FORM'].map(c => c.charCodeAt(0)))
  u32be(b, 46)
  b.push(...[...'AIFF'].map(c => c.charCodeAt(0)))
  b.push(...[...'COMM'].map(c => c.charCodeAt(0)))
  u32be(b, 18) // COMM size
  u16be(b, 1) // numChannels
  u32be(b, 8000) // numSampleFrames
  u16be(b, 16) // sampleSize
  b.push(0x40, 0x0b, 0xfa, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00) // sampleRate = 8000 (80-bit ext)
  b.push(...[...'SSND'].map(c => c.charCodeAt(0)))
  u32be(b, 8)
  b.push(0, 0, 0, 0, 0, 0, 0, 0)
  return new Uint8Array(b)
}

describe('audioDurationMs', () => {
  it('parses WAV duration from byteRate + dataSize', () => {
    expect(audioDurationMs(wav1s(), 'wav')).toBe(1000)
  })

  it('parses AIFF duration from frames + sampleRate', () => {
    expect(audioDurationMs(aiff1s(), 'aiff')).toBe(1000)
  })

  it('returns null for unsupported formats', () => {
    expect(audioDurationMs(new Uint8Array(4), 'mp3')).toBeNull()
    expect(audioDurationMs(new Uint8Array(4), 'pcm')).toBeNull()
  })

  it('returns null for malformed/too-short headers', () => {
    expect(audioDurationMs(new Uint8Array(4), 'wav')).toBeNull()
    expect(audioDurationMs(new Uint8Array(4), 'aiff')).toBeNull()
  })
})

describe('catalog upsert/lookup', () => {
  const entry: CatalogEntry = {
    sessionId: 's1', turn: 3, files: [{ file: 's1/turn-3.aiff', format: 'aiff', bytes: 10, durationMs: 1000 }],
    createdAt: 100, provider: 'host', delivery: 'file',
  }

  it('lookup finds by sessionId+turn', () => {
    const catalog = upsert(emptyCatalog(), entry)
    expect(lookup(catalog, 's1', 3)?.files).toHaveLength(1)
    expect(lookup(catalog, 's1', 4)).toBeUndefined()
    expect(lookup(catalog, 's2', 3)).toBeUndefined()
  })

  it('upsert replaces an existing sessionId+turn entry', () => {
    const catalog = upsert(upsert(emptyCatalog(), entry), { ...entry, files: [] })
    expect(lookup(catalog, 's1', 3)?.files).toHaveLength(0)
    expect(catalog.entries).toHaveLength(1)
  })

  it('lookupFile resolves absolute path under root', () => {
    const catalog = upsert(emptyCatalog(), entry)
    expect(lookupFile('/root', catalog, 's1', 3, 0)).toEqual({ path: '/root/s1/turn-3.aiff', format: 'aiff' })
    expect(lookupFile('/root', catalog, 's1', 3, 1)).toBeUndefined()
  })
})

describe('catalog save/load/rebuild', () => {
  it('round-trips through saveCatalog/loadCatalog', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-voice-tts-cat-'))
    const catalog = upsert(emptyCatalog(), {
      sessionId: 's1', turn: 1, files: [{ file: 's1/turn-1.aiff', format: 'aiff', bytes: 3, durationMs: null }],
      createdAt: 1, provider: 'host', delivery: 'file',
    })
    saveCatalog(root, catalog)
    const loaded = loadCatalog(root)
    expect(loaded.entries).toHaveLength(1)
    expect(lookup(loaded, 's1', 1)?.files[0]?.format).toBe('aiff')
  })

  it('loadCatalog returns empty on missing/corrupt file', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-voice-tts-bad-'))
    expect(loadCatalog(root).entries).toHaveLength(0)
    writeFileSync(join(root, 'catalog.json'), 'not json')
    expect(loadCatalog(root).entries).toHaveLength(0)
  })

  it('loadCatalog drops malformed entries/files instead of throwing', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-voice-tts-malformed-'))
    const json = JSON.stringify({
      formatVersion: 1,
      entries: [
        { sessionId: 's1', turn: 1, files: [{ file: 's1/turn-1.aiff', format: 'aiff', bytes: 3, durationMs: 100 }] },
        { sessionId: 123, turn: 'x', files: 'nope' }, // 畸形：整条丢弃
        { sessionId: 's2', turn: 2, files: [{ file: 42, format: 'aiff' }, { file: 's2/turn-2.wav', format: 'wav', bytes: 5, durationMs: null }] }, // 分段 1 畸形丢弃，分段 2 保留
        'not-an-object',
      ],
    })
    writeFileSync(join(root, 'catalog.json'), json)
    const catalog = loadCatalog(root)
    expect(catalog.entries).toHaveLength(2)
    expect(lookup(catalog, 's1', 1)?.files).toHaveLength(1)
    expect(lookup(catalog, 's2', 2)?.files).toHaveLength(1)
    expect(lookup(catalog, 's2', 2)?.files[0]?.format).toBe('wav')
  })

  it('rebuildCatalog scans turn files and groups by sessionId+turn', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-voice-tts-rebuild-'))
    const s1 = join(root, 'session-a')
    mkdirSync(s1, { recursive: true })
    writeFileSync(join(s1, 'turn-2-0.aiff'), aiff1s())
    writeFileSync(join(s1, 'turn-2-1.aiff'), aiff1s())
    writeFileSync(join(s1, 'turn-5.wav'), wav1s())
    const catalog = rebuildCatalog(root, 'host', 'file')
    expect(catalog.entries).toHaveLength(2)
    const turn2 = lookup(catalog, 'session-a', 2)
    expect(turn2?.files).toHaveLength(2)
    expect(turn2?.files[0]?.durationMs).toBe(1000)
    const turn5 = lookup(catalog, 'session-a', 5)
    expect(turn5?.files[0]?.format).toBe('wav')
    expect(turn5?.files[0]?.durationMs).toBe(1000)
  })
})
