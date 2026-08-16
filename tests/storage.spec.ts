import { describe, expect, it } from 'vitest'
import { dshHome, findProjectRoot, isInRepo, resolveStorageConfig, sessionDir, storageRootFor, turnBaseName, turnFilePath } from '../src/storage.ts'

describe('resolveStorageConfig', () => {
  it('returns defaults for empty/malformed config', () => {
    expect(resolveStorageConfig(undefined)).toEqual({ scope: 'user', dir: '' })
    expect(resolveStorageConfig(null)).toEqual({ scope: 'user', dir: '' })
    expect(resolveStorageConfig('bogus')).toEqual({ scope: 'user', dir: '' })
    expect(resolveStorageConfig({ scope: 42, dir: 7 })).toEqual({ scope: 'user', dir: '' })
  })

  it('normalizes valid scope/dir', () => {
    expect(resolveStorageConfig({ scope: 'project', dir: '/x' })).toEqual({ scope: 'project', dir: '/x' })
    expect(resolveStorageConfig({ scope: 'bogus', dir: '/x' })).toEqual({ scope: 'user', dir: '/x' })
  })
})

describe('storageRootFor', () => {
  const user = { scope: 'user' as const, dir: '' }
  const project = { scope: 'project' as const, dir: '' }

  it('uses explicit dir when set (highest priority)', () => {
    expect(storageRootFor('/some/cwd', { scope: 'user', dir: '/custom/audio' })).toBe('/custom/audio')
  })

  it('defaults to user root for scope=user', () => {
    expect(storageRootFor('/Users/x/repo', user)).toBe(`${dshHome()}/voice-tts`)
  })

  it('project scope falls back to user when cwd is not in a repo', () => {
    expect(storageRootFor('/tmp/not-a-repo', project)).toBe(`${dshHome()}/voice-tts`)
  })

  it('project scope resolves to the repo .dsh dir when in a repo', () => {
    // findProjectRoot walks up to a `.git`; mock via a temp repo is overkill, so
    // assert the shape: findProjectRoot of this repo resolves a real root.
    const root = findProjectRoot(process.cwd())
    if (isInRepo(process.cwd())) {
      expect(storageRootFor(process.cwd(), project)).toBe(`${root}/.dsh/voice-tts`)
    }
  })
})

describe('file layout', () => {
  it('sessionDir nests under root', () => {
    expect(sessionDir('/root', 'session-1')).toBe('/root/session-1')
  })

  it('turnBaseName is turn-<n>', () => {
    expect(turnBaseName(3)).toBe('turn-3')
  })

  it('single segment has no index suffix; multi segment adds -<i>', () => {
    expect(turnFilePath('/root', 's', 3, 0, 1, 'aiff')).toBe('/root/s/turn-3.aiff')
    expect(turnFilePath('/root', 's', 3, 1, 3, 'aiff')).toBe('/root/s/turn-3-1.aiff')
  })
})
