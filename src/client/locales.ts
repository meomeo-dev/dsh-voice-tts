/** browser half 的 locale 字典（zh / en）。选项标签按需求保持英文。 */

/** 本插件的 locale 命名空间。 */
export const NS = 'voice-tts-slot'

const en = {
  'trigger.aria': 'Voice TTS settings',
  'menu.setTts': 'Set voice tts',
  'menu.toggle.off': 'Turn on voice tts',
  'menu.toggle.on': 'Turn off voice tts',
  'menu.toggle.sub.off': 'Current: off · click to turn on',
  'menu.toggle.sub.on': 'Current: on · click to turn off',
  'menu.stop': 'Stop Current Host Play',
  'menu.stop.sub.playing': 'Playing',
  'menu.stop.sub.idle': 'Not playing',
  'dialog.title': 'Set voice tts',
  'dialog.unavailable': 'The standalone panel is not available (web mode + panel dist required).',
  'player.play': 'Play this turn speech',
  'player.pause': 'Pause playback',
  'player.resume': 'Resume playback',
  'player.stop': 'Stop playback',
  'player.regenerate.title': 'Regenerate speech',
  'player.regenerate.prompt': 'No cached speech for this turn. Regenerate TTS now?',
  'player.regenerate.confirm': 'Regenerate',
  'player.regenerate.cancel': 'Cancel',
  'player.regenerate.failed': 'Regeneration produced no audio.',
} as const

export type VoiceTtsSlotKey = keyof typeof en

const zh: Record<VoiceTtsSlotKey, string> = {
  'trigger.aria': '语音合成设置',
  'menu.setTts': 'Set voice tts',
  'menu.toggle.off': 'Turn on voice tts',
  'menu.toggle.on': 'Turn off voice tts',
  'menu.toggle.sub.off': '当前状态: 关闭, 点击后开启',
  'menu.toggle.sub.on': '当前状态: 开启, 点击后关闭',
  'menu.stop': 'Stop Current Host Play',
  'menu.stop.sub.playing': '播放中',
  'menu.stop.sub.idle': '未播放',
  'dialog.title': 'Set voice tts',
  'dialog.unavailable': '独立面板不可用（需 web 模式且已构建 panel dist）。',
  'player.play': '播放本 turn 语音',
  'player.pause': '暂停播放',
  'player.resume': '恢复播放',
  'player.stop': '停止播放',
  'player.regenerate.title': '重新生成语音',
  'player.regenerate.prompt': '该 turn 没有缓存的语音，是否重新生成 TTS？',
  'player.regenerate.confirm': '重新生成',
  'player.regenerate.cancel': '取消',
  'player.regenerate.failed': '重新生成未产出音频。',
}

export { en, zh }
