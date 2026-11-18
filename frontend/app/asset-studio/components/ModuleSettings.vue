<template>
  <section class="as-settings">
    <h2>{{ t('assetStudio.settings') }}</h2><p class="dim">{{ t('assetStudio.settingsHint') }}</p>
    <StudioError :error="error" />
    <label v-for="key in researchKeys" :key="key" class="as-key">
      <span>{{ key }} · {{ settings[key] || t('assetStudio.notConfigured') }}</span>
      <input v-model="drafts[key]" class="input" type="password" autocomplete="off" :placeholder="t('assetStudio.keyPlaceholder')" />
      <button class="btn btn-sm" :disabled="saving || !drafts[key]" @click="saveKey(key, drafts[key] || '')">{{ t('assetStudio.save') }}</button>
      <button class="btn btn-sm" :disabled="saving || !settings[key]" @click="saveKey(key, '')">{{ t('assetStudio.clear') }}</button>
    </label>
    <label>{{ t('assetStudio.textModel') }}<select v-model="textConfigId" class="input"><option :value="null">{{ t('assetStudio.automatic') }}</option><option v-for="row in options.text" :key="`${row.config_id}:${row.model}`" :value="row.config_id">{{ row.config_name }} · {{ row.model }}</option></select></label>
    <label>{{ t('episode.documentary.pipeline.imageModelTitle') }}<select v-model="imageKey" class="input"><option value="">{{ t('assetStudio.automatic') }}</option><option v-for="row in options.image" :key="`${row.config_id}:${row.model}`" :value="`${row.config_id}:${row.model}`">{{ row.config_name }} · {{ row.model }}</option></select></label>
    <button class="btn btn-sm btn-primary" :disabled="saving" @click="saveModels">{{ t('assetStudio.save') }}</button>
    <span v-if="saved" role="status">{{ t('assetStudio.saved') }}</span>
  </section>
</template>
<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { assetStudioAPI, type ModelChoice } from '../api'
import StudioError from './StudioError.vue'
const { t } = useI18n()
const options = ref<{image: ModelChoice[]; text: ModelChoice[]}>({image: [], text: []})
const drafts = reactive<Record<string, string>>({})
const settings = ref<Record<string, string>>({})
const researchKeys = ['europeana', 'smithsonian', 'openalex']
const textConfigId = ref<number | null>(null)
const imageKey = ref('')
const error = ref('')
const saving = ref(false)
const saved = ref(false)
async function load() {
  const [value, choices] = await Promise.all([assetStudioAPI.settings(), assetStudioAPI.modelOptions()])
  settings.value = value.settings; options.value = choices
  textConfigId.value = Number(value.settings.text_config_id) || null
  imageKey.value = value.settings.image_config_id && value.settings.image_model ? `${value.settings.image_config_id}:${value.settings.image_model}` : ''
}
async function save(data: Record<string, string>) {
  saving.value = true; error.value = ''; saved.value = false
  try { await assetStudioAPI.saveSettings(data); await load(); saved.value = true }
  catch (err) { error.value = err instanceof Error ? err.message : t('assetStudio.loadFailed') }
  finally { saving.value = false }
}
async function saveKey(id: string, value: string) { await save({[id]: value}); drafts[id] = '' }
async function saveModels() {
  const image = options.value.image.find(row => `${row.config_id}:${row.model}` === imageKey.value)
  await save({text_config_id: String(textConfigId.value || ''), image_config_id: String(image?.config_id || ''), image_model: image?.model ?? ''})
}
onMounted(() => { void load().catch(err => { error.value = err instanceof Error ? err.message : t('assetStudio.loadFailed') }) })
</script>
<style scoped>
.as-settings { display: flex; flex-direction: column; gap: 12px; border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
h2 { margin: 0; font-size: 16px; } p { margin: 0; } label { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.as-key .input { flex: 1; min-width: 120px; }
</style>
