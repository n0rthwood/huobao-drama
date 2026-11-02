import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const appRoot = new URL('../app/', import.meta.url)
const readApp = (path) => readFileSync(new URL(path, appRoot), 'utf8')

const narrationBlock = readApp('components/NarrationBlock.vue')
const fitPanel = readApp('components/NarrationFitPanel.vue')
const breakdownDialog = readApp('components/BreakdownNarrationDialog.vue')
const keyframes = readApp('components/StoryboardKeyframes.vue')
const episodeView = readApp('views/drama/episode.vue')
const settingsPage = readApp('pages/settings.vue')
const useApi = readApp('composables/useApi.ts')

const LOCALES = ['zh', 'en', 'ja', 'ko']
const localeJson = (lang) => JSON.parse(readApp(`locales/${lang}.json`))

function keyPaths(value, prefix = '') {
  const out = new Set()
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key
    out.add(path)
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      for (const nested of keyPaths(child, path)) out.add(nested)
    }
  }
  return out
}

test('breakdown asks for narration before running the breakdown agent', () => {
  assert.match(breakdownDialog, /episode\.breakdown\.withNarration/)
  assert.match(breakdownDialog, /episode\.breakdown\.withoutNarration/)
  assert.match(breakdownDialog, /episode\.breakdown\.chain/)
  assert.match(breakdownDialog, /episode\.breakdown\.destructive/)
  // 工作台把按钮接到对话框上，确认后先落库开关再跑拆分 Agent，并串联旁白写作
  assert.match(episodeView, /<BreakdownNarrationDialog/)
  assert.match(episodeView, /function doBreakdown\(\)\s*\{\s*breakdownDialog\.value = true/)
  assert.match(episodeView, /confirmBreakdown[\s\S]{0,600}narration_enabled: narrationEnabled[\s\S]{0,400}runBreakdownAgent\(\)/)
  assert.match(episodeView, /onBreakdownDone[\s\S]{0,400}narrationEnabledOf\.value\) await batchNarration\(\)/)
})

test('narration review block is shared by the keyframe and video surfaces', () => {
  assert.match(keyframes, /<NarrationBlock/)
  assert.match(keyframes, /v-if="narrationEnabled"/)
  assert.match(keyframes, /episode\.narration\.batchScript/)
  assert.match(keyframes, /episode\.narration\.batchVoice/)
  assert.match(episodeView, /<NarrationBlock[\s\S]{0,600}show-compose/)
  assert.match(episodeView, /episode\.compose\.batch/)
  assert.match(episodeView, /SAVE_STATUS_FIELDS = \[[^\]]*'narration_text'/)
})

test('narration media always goes through mediaUrl', () => {
  assert.match(narrationBlock, /<audio[\s\S]{0,200}:src="mediaUrl\(audioUrl\)"/)
  assert.match(narrationBlock, /<video[\s\S]{0,200}:src="mediaUrl\(composedUrl\)"/)
  assert.doesNotMatch(narrationBlock, /"\/static\//)
  assert.doesNotMatch(narrationBlock, /'\/api\/v1/)
})

test('narration block exposes per-shot switch, timing override and staleness', () => {
  assert.match(narrationBlock, /episode\.narration\.pureVisual/)
  assert.match(narrationBlock, /narration_enabled/)
  assert.match(narrationBlock, /subtitle_timing/)
  assert.match(narrationBlock, /episode\.narration\.timingSentence/)
  assert.match(narrationBlock, /episode\.narration\.timingChar/)
  assert.match(narrationBlock, /status === 'voice_stale'/)
  assert.match(narrationBlock, /status === 'compose_stale'/)
  assert.match(narrationBlock, /proportional_fallback/)
  assert.match(narrationBlock, /narration_too_long/)
})

test('export panel reports composed state and skipped shots', () => {
  assert.match(episodeView, /episode\.compose\.composed/)
  assert.match(episodeView, /episode\.compose\.notComposed/)
  assert.match(episodeView, /episode\.compose\.mergeWarnUncomposed/)
  assert.match(episodeView, /mergeSkipped\.value = Array\.isArray\(res\?\.skipped\)/)
  assert.match(episodeView, /episode\.compose\.skippedItem/)
})

test('api client exposes the narration, voice and compose endpoints', () => {
  assert.match(useApi, /generate-narration/)
  assert.match(useApi, /narration-status/)
  assert.match(useApi, /narration\/voice-batch/)
  assert.match(useApi, /compose-batch/)
  assert.match(useApi, /storyboards\/\$\{id\}\/narration\/voice/)
  assert.match(useApi, /storyboards\/\$\{id\}\/narration\/subtitle/)
  assert.match(useApi, /storyboards\/\$\{id\}\/compose/)
})

test('settings page offers the tts service type with the voxcpm provider only', () => {
  assert.match(settingsPage, /\{ type: 'tts', label: t\('common\.serviceType\.tts'\) \}/)
  assert.match(settingsPage, /const providers = \[[^\]]*'voxcpm'/)
  assert.match(settingsPage, /tts: \{\s*\n?\s*voxcpm:/)
  assert.match(settingsPage, /settings\.cfg\.ttsInstructions/)
  assert.match(settingsPage, /settings\.cfg\.ttsCfgValue/)
  assert.match(settingsPage, /settings\.cfg\.ttsTimesteps/)
  assert.match(settingsPage, /settings\.cfg\.ttsSeed/)
  assert.match(settingsPage, /tts_settings/)
  // 音色必须由人在设置页选定（#35）：程序不再自动取服务列表第一个
  assert.match(settingsPage, /v-model="cfgForm\.tts_voice"/)
  assert.match(settingsPage, /settings\.cfg\.ttsVoiceRefresh/)
  assert.match(settingsPage, /settings\.cfg\.ttsVoiceRequired/)
})

test('all four locales carry identical narration key sets', () => {
  const sets = LOCALES.map(lang => keyPaths(localeJson(lang)))
  const [base] = sets
  for (let i = 1; i < sets.length; i++) {
    assert.deepEqual([...sets[i]].sort(), [...base].sort(), `${LOCALES[i]} key set differs from zh`)
  }
  for (const key of ['episode.narration.section', 'episode.compose.section', 'episode.breakdown.title', 'common.serviceType.tts', 'settings.ai.meta.tts']) {
    assert.ok(base.has(key), `missing ${key}`)
  }
})

test('narration fit panel drives the #31 duration and audio-track match', () => {
  // 试听必须是纯前端变速（零请求）
  assert.match(fitPanel, /playbackRate/)
  assert.match(fitPanel, /preservesPitch/)
  assert.match(fitPanel, /mediaUrl\(audioUrl\.value\)/)
  // 两种匹配方式 + 留白位置 + 高级倍率 + 恢复自动
  assert.match(fitPanel, /episode\.fit\.modePad/)
  assert.match(fitPanel, /episode\.fit\.modeTempo/)
  assert.match(fitPanel, /episode\.fit\.padHead/)
  assert.match(fitPanel, /episode\.fit\.padTail/)
  assert.match(fitPanel, /tempo_override/)
  assert.match(fitPanel, /episode\.fit\.tempoAuto/)
  assert.match(fitPanel, /tempo_available/)
  // 继承与恢复继承
  assert.match(fitPanel, /clearNarrationFit/)
  assert.match(fitPanel, /episode\.fit\.inherited/)
  // 阻断按 block_reason 渲染，不解析中文 message
  assert.match(fitPanel, /episode\.fit\.blocked\.\$\{reason\}/)
  assert.match(fitPanel, /body\?\.block_reason/)
})

test('narration block mounts the fit panel next to the voice audio', () => {
  assert.match(narrationBlock, /import NarrationFitPanel from '~\/components\/NarrationFitPanel\.vue'/)
  assert.match(narrationBlock, /<NarrationFitPanel/)
  assert.match(narrationBlock, /:episode-fit-default="episodeFitDefault"/)
  assert.match(narrationBlock, /:episode-mix-mode="episodeMixMode"/)
})

// #35：这些集级设置从全局顶栏搬进了分镜拆分区的「音频旁白设置」面板
test('episode-level audio mix and default fit live in the narration settings panel', () => {
  const topbar = episodeView.slice(0, episodeView.indexOf('<div class="studio-actions">'))
  assert.doesNotMatch(topbar, /episode\.fit\.episodeMixLabel/)
  assert.doesNotMatch(topbar, /episodeAudioMixMode/)
  assert.match(episodeView, /<NarrationSettingsPanel/)
  assert.match(episodeView, /episodeAudioMixMode/)
  assert.match(episodeView, /audio_bed_gain_db/)
  assert.match(episodeView, /narration_fit_default/)
  const panel = readFileSync(new URL('../app/components/NarrationSettingsPanel.vue', import.meta.url), 'utf8')
  assert.match(panel, /episode\.fit\.episodeMixLabel/)
  assert.match(panel, /episode\.narration\.normalizeLabel/)
  assert.match(panel, /episode\.narration\.enableNarration/)
})

test('api client exposes the three narration-fit endpoints', () => {
  assert.match(useApi, /narrationFitPreview/)
  assert.match(useApi, /saveNarrationFit/)
  assert.match(useApi, /clearNarrationFit/)
  assert.match(useApi, /storyboards\/\$\{id\}\/narration-fit\/preview/)
  // 结构化 400 体必须保留给调用方
  assert.match(useApi, /apiErr\.body = json/)
})

test('all four locales carry identical episode.fit key sets', () => {
  const sets = LOCALES.map(lang => new Set([...keyPaths(localeJson(lang))].filter(k => k.startsWith('episode.fit.'))))
  const [base] = sets
  assert.ok(base.size > 0, 'episode.fit is missing from zh')
  for (let i = 1; i < sets.length; i++) {
    assert.deepEqual([...sets[i]].sort(), [...base].sort(), `${LOCALES[i]} episode.fit key set differs from zh`)
  }
  for (const key of ['episode.fit.section', 'episode.fit.blocked.narration_gap_too_large', 'episode.fit.blocked.narration_too_long']) {
    assert.ok(base.has(key), `missing ${key}`)
  }
})

test('locale strings escape literal @ for vue-i18n', () => {
  for (const lang of LOCALES) {
    const raw = readApp(`locales/${lang}.json`)
    const unescaped = raw.split('\n').filter(line => /[^{']@/.test(line))
    assert.deepEqual(unescaped, [], `${lang}.json has an unescaped @`)
  }
})
