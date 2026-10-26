import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const settingsPage = readFileSync(new URL('../app/pages/settings.vue', import.meta.url), 'utf8')
const useApi = readFileSync(new URL('../app/composables/useApi.ts', import.meta.url), 'utf8')

function providerPresetBlock(serviceType) {
  const presetsStart = settingsPage.indexOf('const providerPresets = {')
  assert.notEqual(presetsStart, -1, 'missing providerPresets')
  const marker = `  ${serviceType}: {`
  const start = settingsPage.indexOf(marker, presetsStart)
  assert.notEqual(start, -1, `missing ${serviceType} provider presets`)
  const end = settingsPage.indexOf('\n  },', start)
  assert.notEqual(end, -1, `unterminated ${serviceType} provider presets`)
  return settingsPage.slice(start, end)
}

test('settings page exposes official provider templates only', () => {
  assert.doesNotMatch(settingsPage, /provider:\s*'chatfire'/i)
  assert.doesNotMatch(settingsPage, /openrouter/i)
  assert.doesNotMatch(settingsPage, /huobaoPreset/i)
  assert.doesNotMatch(settingsPage, /applyHuobaoPreset/i)
  assert.doesNotMatch(settingsPage, /\/huobao-preset/)
  assert.doesNotMatch(useApi, /api\.firemux\.com/i)
  assert.doesNotMatch(useApi, /applyHuobaoPreset/i)
  assert.doesNotMatch(useApi, /openrouter/i)
  assert.doesNotMatch(useApi, /huobaoPreset/i)
  assert.doesNotMatch(useApi, /\/huobao-preset/)

  assert.match(settingsPage, /const providers = \['gemini', 'openai', 'volcengine', 'minimax', 'comfyui'\]/)
  assert.match(settingsPage, /https:\/\/generativelanguage\.googleapis\.com/)
  assert.match(settingsPage, /https:\/\/api\.openai\.com/)
  assert.match(settingsPage, /https:\/\/ark\.cn-beijing\.volces\.com/)
  assert.doesNotMatch(settingsPage, /https:\/\/\{WorkspaceId\}\.cn-beijing\.maas\.aliyuncs\.com/)
  assert.doesNotMatch(settingsPage, /https:\/\/api\.deepseek\.com/)
  assert.doesNotMatch(settingsPage, /https:\/\/dashscope\.aliyuncs\.com/)
  assert.doesNotMatch(settingsPage, /https:\/\/api\.vidu\.com/)
  assert.doesNotMatch(settingsPage, /\['ali'|'ali',|, 'ali'\]/)
  assert.doesNotMatch(settingsPage, /https:\/\/api\.minimax\.io/)
})


test('only text service configs expose the connection test button', () => {
  assert.match(settingsPage, /v-if="st\.type === 'text'" class="btn btn-ghost btn-sm" @click="testExistingCfg\(c\)">\{\{ t\('settings\.ai\.test'\) \}\}/)
})

test('settings page offers the supported official provider presets', () => {
  assert.match(providerPresetBlock('text'), /deepseek-v4-pro/)
  assert.doesNotMatch(providerPresetBlock('text'), /minimax/i)
  assert.doesNotMatch(providerPresetBlock('image'), /'ali'|minimax/i)
  assert.match(providerPresetBlock('video'), /volcengine/)
  assert.match(providerPresetBlock('video'), /minimax/)
  assert.doesNotMatch(providerPresetBlock('video'), /aliyun/)
  assert.doesNotMatch(providerPresetBlock('video'), /'vidu'/i)
  assert.doesNotMatch(settingsPage, /audio:\s*\{/)
})

