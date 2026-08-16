/**
 * 音频落盘目录的解析(纯 node 逻辑,不 import cordis)。
 *
 * 目录层级(优先级高 → 低,见 docs/audio-storage-and-playback.md §3):
 *   1. `storage.dir`(显式绝对路径,会话自定义)
 *   2. `storage.scope === 'project'` → `<repo>/.dsh/voice-tts`(每仓库独立)
 *   3. 默认 → `~/.dsh/voice-tts`(用户级)
 *
 * `~/.dsh` 解析支持 `DSH_HOME` 覆盖(与 dsh-memory `dshHome()` 同构)。文件布局 =
 * `<root>/<sessionId>/turn-<n>[-<i>].<format>`。
 * @module dsh-voice-tts/storage
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { StorageConfig } from './types.js'

/** dsh home 环境变量覆盖(默认 `~/.dsh`)。 */
const DSH_HOME_ENV = 'DSH_HOME'

/** 解析 dsh home。 */
export function dshHome(): string {
  const fromEnv = process.env[DSH_HOME_ENV]
  return resolve(fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), '.dsh'))
}

/** 从 cwd 向上找项目根(以 `.git` 为标记),找不到则回退 cwd 本身。 */
export function findProjectRoot(cwd: string): string {
  let current = resolve(cwd)
  while (true) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return resolve(cwd)
    current = parent
  }
}

/** 判断 cwd 是否在 git 仓库内(用于决定「仓库级」是否可用)。 */
export function isInRepo(cwd: string): boolean {
  return existsSync(join(findProjectRoot(cwd), '.git'))
}

/** 音频目录名(仓库内/用户根下的子目录)。 */
export const STORAGE_DIR_NAME = 'voice-tts'

/**
 * 把宽松的请求配置归一为已解析的存储配置(缺失/错类型回退默认)。用户可能手动改
 * settings.yaml 或删字段,此边界必须抗异常,不能因 `storage.scope` 非法而崩溃。
 * @param raw - 请求里的 storage 切片(可能缺字段/错类型)。
 * @returns 已解析配置。
 */
export function resolveStorageConfig(raw: unknown): StorageConfig {
  if (raw === null || typeof raw !== 'object') return { scope: 'user', dir: '' }
  const r = raw as Record<string, unknown>
  const scope = r.scope === 'project' ? 'project' : 'user'
  const dir = typeof r.dir === 'string' ? r.dir : ''
  return { scope, dir }
}

/** 解析某会话音频的写根目录。 */
export function storageRootFor(cwd: string | undefined, storage: StorageConfig): string {
  if (typeof storage.dir === 'string' && storage.dir.trim().length > 0) {
    return resolve(storage.dir.trim())
  }
  if (storage.scope === 'project' && cwd !== undefined && isInRepo(cwd)) {
    return join(findProjectRoot(cwd), '.dsh', STORAGE_DIR_NAME)
  }
  return join(dshHome(), STORAGE_DIR_NAME)
}

/** 某会话在写根下的子目录(`<root>/<sessionId>`)。 */
export function sessionDir(root: string, sessionId: string): string {
  return join(root, sessionId)
}

/** 一个 turn 音频文件的基名(不含扩展名与分段序号):`turn-<n>`。 */
export function turnBaseName(turn: number): string {
  return `turn-${turn}`
}

/** 一个 turn 某一分段音频文件的绝对路径。单段(segmentCount=1)不带序号。 */
export function turnFilePath(root: string, sessionId: string, turn: number, index: number, segmentCount: number, format: string): string {
  const suffix = segmentCount === 1 ? '' : `-${index}`
  return join(sessionDir(root, sessionId), `${turnBaseName(turn)}${suffix}.${format}`)
}
