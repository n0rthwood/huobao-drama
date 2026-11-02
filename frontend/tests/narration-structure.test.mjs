import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const appRoot = new URL('../app/', import.meta.url)
const readApp = (path) => readFileSync(new URL(path, appRoot), 'utf8')

const narrationBlock = readApp('components/NarrationBlock.vue')
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
  assert.match(episodeView, /<NarrationBlock[\s\S]{0,400}show-compose/)
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
  // 音色不做挑选 UI：只读回显后端固定下来的值
  assert.doesNotMatch(settingsPage, /v-model="cfgForm\.tts_voice"/)
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

test('locale strings escape literal @ for vue-i18n', () => {
  for (const lang of LOCALES) {
    const raw = readApp(`locales/${lang}.json`)
    const unescaped = raw.split('\n').filter(line => /[^{']@/.test(line))
    assert.deepEqual(unescaped, [], `${lang}.json has an unescaped @`)
  }
})
