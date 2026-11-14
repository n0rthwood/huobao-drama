<template>
  <section class="ms">
    <header class="ms-head">
      <strong>{{ t('mapStudio.settings.title') }}</strong>
      <span class="dim">{{ t('mapStudio.settings.hint') }}</span>
      <button type="button" class="ms-tool" :disabled="loading" @click="load">
        <Loader2 v-if="loading" :size="11" class="animate-spin" />
        {{ t('mapStudio.panel.refresh') }}
      </button>
    </header>

    <p v-if="error" class="ms-error">{{ error }}</p>

    <section class="ms-block">
      <strong class="ms-sub">{{ t('mapStudio.settings.researchKeys') }}</strong>
      <p class="ms-note dim">{{ t('mapStudio.settings.researchKeysHint') }}</p>
      <ul class="ms-keys">
        <li v-for="key in settings?.research_keys ?? []" :key="key.id" class="ms-key">
          <span class="ms-key-label">{{ key.label }}</span>
          <span :class="['ms-chip', key.configured ? 'is-on' : 'is-off']">
            {{ key.configured ? t('mapStudio.settings.keyConfigured', { last4: key.last4 ?? '••••' }) : t('mapStudio.settings.keyMissing') }}
          </span>
          <input
            v-model="keyDrafts[key.id]"
            class="input ms-key-input"
            type="password"
            autocomplete="off"
            :disabled="saving"
            :placeholder="t('mapStudio.settings.keyPlaceholder')"
          />
          <button type="button" class="ms-tool" :disabled="saving || !keyDrafts[key.id]" @click="saveKey(key.id)">
            {{ t('mapStudio.settings.saveKey') }}
          </button>
          <button type="button" class="ms-tool" :disabled="saving || !key.configured" @click="clearKey(key.id)">
            {{ t('mapStudio.settings.clearKey') }}
          </button>
        </li>
      </ul>
      <p v-if="keySaved" class="ms-ok">{{ t('mapStudio.settings.keySaved') }}</p>
    </section>

    <section class="ms-block">
      <strong class="ms-sub">{{ t('mapStudio.styles.defaultTitle') }}</strong>
      <p class="ms-note dim">{{ t('mapStudio.styles.defaultHint') }}</p>
      <MapStylePicker :model-value="styleDraft" :allow-default="false" :disabled="saving || loading" @update:model-value="styleDraft = $event ?? styleDraft" />
      <button type="button" class="btn btn-sm btn-primary" :disabled="saving || !styleDraft || styleDraft === settings?.default_style" @click="saveStyle">{{ t('mapStudio.styles.saveDefault') }}</button>
    </section>

    <section class="ms-block">
      <strong class="ms-sub">{{ t('mapStudio.settings.models') }}</strong>
      <p class="ms-note dim">{{ t('mapStudio.settings.modelsHint') }}</p>
      <MapModelPicker
        :options="modelOptions"
        :text-config-id="modelDraft.textConfigId"
        :image-config-id="modelDraft.imageConfigId"
        :image-model="modelDraft.imageModel"
        :disabled="saving || loading"
        @update="Object.assign(modelDraft, $event)"
      />
      <div class="ms-actions">
        <button type="button" class="btn btn-sm btn-primary" :disabled="saving || !modelsDirty" @click="saveModels">
          <Loader2 v-if="saving" :size="11" class="animate-spin" />
          {{ t('mapStudio.settings.saveModels') }}
        </button>
        <span v-if="modelsDirty" class="ms-warn">{{ t('mapStudio.settings.modelsDirty') }}</span>
      </div>
      <p v-if="modelsSaved" class="ms-ok">{{ t('mapStudio.settings.modelsSaved') }}</p>
    </section>
  </section>
</template>

<script setup lang="ts">
/**
 * 模块设置（Issue #99）：资料检索 key 与默认模型。
 *
 * 检索 key 只写不读：接口永不返回完整 key，配置后只显示末 4 位；输入框是掩码输入，
 * 保存成功后立刻清空草稿，避免把 key 留在页面里。
 * 默认模型是模块自己的设置，运行面板可以临时换（下次运行生效），这里改的是长期默认。
 */
import { Loader2 } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import {
  mapStudioAPI,
  type MapStudioModelOptions,
  type MapStudioSettings,
  type ResearchKeyId,
} from '~/map-studio/api'
import MapModelPicker from '~/map-studio/components/MapModelPicker.vue'
import MapStylePicker from '~/map-studio/components/MapStylePicker.vue'

const { t } = useI18n()

const emit = defineEmits<{ (e: 'loaded'): void }>()

const settings = ref<MapStudioSettings | null>(null)
const modelOptions = ref<MapStudioModelOptions>({ text: [], image: [] })
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const keySaved = ref(false)
const modelsSaved = ref(false)
const styleDraft = ref('')
const keyDrafts = reactive<Record<string, string>>({})
const modelDraft = reactive({ textConfigId: 0, imageConfigId: null as number | null, imageModel: null as string | null })
let stopped = false

const serverModels = ref(JSON.stringify({ textConfigId: 0, imageConfigId: null, imageModel: null }))
const modelsDirty = computed(() => JSON.stringify({
  textConfigId: modelDraft.textConfigId,
  imageConfigId: modelDraft.imageConfigId,
  imageModel: modelDraft.imageModel,
}) !== serverModels.value)

function applySettings(next: MapStudioSettings, adoptModels = true) {
  settings.value = next
  if (!adoptModels) return
  styleDraft.value = next.default_style
  modelDraft.textConfigId = next.models.text_config_id ?? 0
  modelDraft.imageConfigId = next.models.image_config_id ?? null
  modelDraft.imageModel = next.models.image_model ?? null
  serverModels.value = JSON.stringify({
    textConfigId: modelDraft.textConfigId,
    imageConfigId: modelDraft.imageConfigId,
    imageModel: modelDraft.imageModel,
  })
}

async function load() {
  if (loading.value) return
  loading.value = true
  error.value = ''
  try {
    const [next, options] = await Promise.all([mapStudioAPI.settings(), mapStudioAPI.modelOptions()])
    if (stopped) return
    applySettings(next)
    modelOptions.value = options
    emit('loaded')
  } catch (err) {
    if (!stopped) error.value = err instanceof Error && err.message ? err.message : t('mapStudio.settings.loadFailed')
  } finally {
    if (!stopped) loading.value = false
  }
}

async function saveKey(id: ResearchKeyId) {
  const value = keyDrafts[id]
  if (!value || saving.value) return
  saving.value = true
  error.value = ''
  keySaved.value = false
  try {
    const next = await mapStudioAPI.saveSettings({ research_keys: { [id]: value } })
    if (stopped) return
    applySettings(next, false)
    keyDrafts[id] = ''
    keySaved.value = true
    toast.success(t('mapStudio.settings.keySaved'))
  } catch (err) {
    if (!stopped) {
      error.value = err instanceof Error && err.message ? err.message : t('mapStudio.settings.saveFailed')
      toast.error(error.value)
    }
  } finally {
    if (!stopped) saving.value = false
  }
}

async function clearKey(id: ResearchKeyId) {
  if (saving.value) return
  saving.value = true
  error.value = ''
  keySaved.value = false
  try {
    const next = await mapStudioAPI.saveSettings({ research_keys: { [id]: null } })
    if (stopped) return
    applySettings(next, false)
    toast.success(t('mapStudio.settings.keyCleared'))
  } catch (err) {
    if (!stopped) {
      error.value = err instanceof Error && err.message ? err.message : t('mapStudio.settings.saveFailed')
      toast.error(error.value)
    }
  } finally {
    if (!stopped) saving.value = false
  }
}

async function saveStyle() {
  if (saving.value || !styleDraft.value) return
  saving.value = true
  error.value = ''
  try {
    const next = await mapStudioAPI.saveSettings({ default_style: styleDraft.value })
    if (stopped) return
    settings.value = next
    toast.success(t('mapStudio.styles.defaultSaved'))
    emit('loaded')
  } catch (err) {
    if (!stopped) error.value = err instanceof Error ? err.message : t('mapStudio.settings.saveFailed')
  } finally { if (!stopped) saving.value = false }
}

async function saveModels() {
  if (saving.value || !modelsDirty.value) return
  saving.value = true
  error.value = ''
  modelsSaved.value = false
  try {
    const next = await mapStudioAPI.saveSettings({
      models: {
        text_config_id: modelDraft.textConfigId || null,
        image_config_id: modelDraft.imageConfigId,
        image_model: modelDraft.imageModel,
      },
    })
    if (stopped) return
    applySettings(next)
    modelsSaved.value = true
    toast.success(t('mapStudio.settings.modelsSaved'))
  } catch (err) {
    if (!stopped) {
      error.value = err instanceof Error && err.message ? err.message : t('mapStudio.settings.saveFailed')
      toast.error(error.value)
    }
  } finally {
    if (!stopped) saving.value = false
  }
}

onMounted(() => { void load() })
onBeforeUnmount(() => { stopped = true })
</script>

<style scoped>
.ms { display: flex; flex-direction: column; gap: 10px; }
.ms-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 11px; color: var(--text-1); }
.ms-head strong { font: 600 13px var(--font-body); }
.ms-tool {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 9px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  background: transparent;
  color: var(--text-2);
  font: 600 10.5px var(--font-body);
  cursor: pointer;
}
.ms-tool:hover:not(:disabled) { color: var(--accent-text); border-color: var(--accent-text); }
.ms-tool:disabled { opacity: 0.5; cursor: not-allowed; }
.ms-error { margin: 0; font-size: 10.5px; color: var(--action-danger); }
.ms-ok { margin: 0; font-size: 10.5px; color: var(--accent-text); }
.ms-warn { font-size: 10.5px; color: var(--warn-text); }
.ms-block { display: flex; flex-direction: column; gap: 5px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-soft); }
.ms-sub { font: 600 11px var(--font-body); color: var(--text-1); }
.ms-note { margin: 0; font-size: 10.5px; }
.ms-keys { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
.ms-key { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 10.5px; color: var(--text-2); }
.ms-key-label { font: 600 10.5px var(--font-body); color: var(--text-1); min-width: 110px; }
.ms-key-input { width: 220px; }
.ms-chip {
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  font: 600 10px var(--font-body);
}
.ms-chip.is-on { color: var(--accent-text); border-color: var(--accent-text); }
.ms-chip.is-off { color: var(--warn-text); background: var(--warn-bg); border-color: var(--warn-border); }
.ms-actions { display: flex; align-items: center; gap: 8px; }
</style>
