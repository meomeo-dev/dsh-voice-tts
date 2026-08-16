import { writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  buildSayArgs,
  DEFAULT_HOST_COMMAND,
  DEFAULT_HOST_RATE,
  parseSayVoices,
  resolveHostConfig,
  synthesizeSay,
} from '../src/host.ts'
import type { TtsVoice } from '../src/types.ts'

describe('resolveHostConfig', () => {
  it('returns defaults for empty config', () => {
    expect(resolveHostConfig({})).toEqual({ command: DEFAULT_HOST_COMMAND, voice_type: '', rate: DEFAULT_HOST_RATE })
  })

  it('reads command / voice_type / rate', () => {
    expect(resolveHostConfig({ command: '/opt/say', voice_type: 'Alex', rate: 200 })).toEqual({
      command: '/opt/say', voice_type: 'Alex', rate: 200,
    })
  })

  it('falls back on malformed fields', () => {
    expect(resolveHostConfig({ command: '', voice_type: 42, rate: 'fast' })).toEqual({
      command: DEFAULT_HOST_COMMAND, voice_type: '', rate: DEFAULT_HOST_RATE,
    })
  })
})

describe('buildSayArgs', () => {
  it('omits -v for empty voice, always sets -r and -o', () => {
    expect(buildSayArgs({ command: DEFAULT_HOST_COMMAND, voice_type: '', rate: 175 }, '/tmp/x.aiff')).toEqual([
      '-r', '175', '-o', '/tmp/x.aiff',
    ])
  })

  it('includes -v when voice set', () => {
    expect(buildSayArgs({ command: DEFAULT_HOST_COMMAND, voice_type: 'Alex', rate: 200 }, '/tmp/x.aiff')).toEqual([
      '-v', 'Alex', '-r', '200', '-o', '/tmp/x.aiff',
    ])
  })
})

describe('parseSayVoices', () => {
  it('parses name / locale / comment, including space-separated names', () => {
    const text = [
      'Albert              en_US    # Hello! My name is Albert.',
      'Bad News            en_US    # Hello! My name is Bad News.',
      'Tingting            zh_CN    # 你好, 我是婷婷。',
      '',
    ].join('\n')
    const voices = parseSayVoices(text)
    expect(voices).toEqual([
      { voice_type: 'Albert', name: 'Albert', scene: '本地语音', lang: 'en_US', ability: 'Hello! My name is Albert.', group: 'standard' },
      { voice_type: 'Bad News', name: 'Bad News', scene: '本地语音', lang: 'en_US', ability: 'Hello! My name is Bad News.', group: 'standard' },
      { voice_type: 'Tingting', name: 'Tingting', scene: '本地语音', lang: 'zh_CN', ability: '你好, 我是婷婷。', group: 'standard' },
    ] as TtsVoice[])
  })

  it('ignores non-voice lines', () => {
    expect(parseSayVoices('no voices here\n')).toEqual([])
  })
})

describe('synthesizeSay', () => {
  it('spawns say with stdin text and reads back the output file', async () => {
    const captured: { args: string[]; text: string } = { args: [], text: '' }
    const fakeSpawn = ((_command: string, args: string[], _options: unknown) => {
      captured.args = [...args]
      const outIndex = args.indexOf('-o')
      const out = outIndex >= 0 ? args[outIndex + 1]! : undefined
      const child = {
        stdin: {
          on: (_event: string, _fn: () => void) => {},
          end: (text: string) => { captured.text = text },
        },
        stderr: { on: (_event: string, _fn: (chunk: unknown) => void) => {} },
        on: (event: string, fn: (...a: unknown[]) => void) => {
          if (event === 'exit') queueMicrotask(() => {
            if (out !== undefined) writeFileSync(out, Buffer.from([0x46, 0x4f, 0x52, 0x4d]))
            fn(0, null)
          })
        },
      }
      return child
    }) as never

    const result = await synthesizeSay({ command: '/usr/bin/say', voice_type: 'Alex', rate: 180 }, 'hello there', fakeSpawn)
    expect(captured.args.slice(0, 4)).toEqual(['-v', 'Alex', '-r', '180'])
    expect(captured.args[4]).toBe('-o')
    expect(captured.text).toBe('hello there')
    expect(result.format).toBe('aiff')
    expect(result.textWords).toBe(0)
    expect([...result.audio.slice(0, 4)]).toEqual([0x46, 0x4f, 0x52, 0x4d])
  })
})
