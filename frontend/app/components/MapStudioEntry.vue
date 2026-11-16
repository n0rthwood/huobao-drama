<template>
  <section class="map-entry">
    <p>{{ briefSummary || t('mapStudio.entry.noBrief') }}</p>
    <p>{{ t('mapStudio.stagePanel.featureCounts', counts) }}</p>
    <!-- 画中画（Issue #107）：这是全览还是某个细节图、属于哪张全览；用法说明由后端写入，原文展示 -->
    <p v-if="pipBadge" class="map-entry-pip">{{ pipBadge }}</p>
    <details v-if="pipUsage" class="map-entry-usage">
      <summary>{{ t('mapStudio.pip.usageTitle') }}</summary>
      <pre>{{ pipUsage }}</pre>
    </details>
    <p v-if="latest">{{ t('mapStudio.entry.latest', { id: latest.id }) }}</p>
    <button type="button" class="btn btn-sm btn-primary" :disabled="opening" @click="open">
      {{ t('mapStudio.entry.open') }}
    </button>
    <p v-if="error" class="error">{{ error }}</p>
  </section>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { propAPI } from '~/composables/useApi'
import { pipBadgeOf, pipBadgeText } from '~/map-studio/utils/mapPip'
const { t } = useI18n()
const router = useRouter()
const props = defineProps<{ asset: Record<string, any> }>()
const opening = ref(false)
const error = ref('')
const pipBadge = computed(() => pipBadgeText(props.asset.map_pip, (key, params) => t(key, params ?? {})))
const pipUsage = computed(() => pipBadgeOf(props.asset.map_pip)?.usage ?? '')
const briefSummary = computed(() => {
  const brief = props.asset.map_brief
  return brief && typeof brief === 'object' ? [brief.subject, brief.era, brief.location, brief.purpose].filter(Boolean).join(' · ') : ''
})
const counts = computed(() => {
  // 道具列表接口里 semantics 是原样 JSON 字符串（serializeProp 不解析），这里解析后计数
  let semantics = props.asset.semantics
  if (typeof semantics === 'string') {
    try { semantics = JSON.parse(semantics) } catch { semantics = null }
  }
  return { places: semantics?.points?.length ?? 0, routes: semantics?.lines?.length ?? 0, regions: semantics?.regions?.length ?? 0 }
})
const latest = computed(() => (props.asset.image_versions ?? props.asset.imageVersions ?? []).find((row: any) => row.provider === 'map-workflow'))
async function open() {
  if (opening.value) return
  opening.value = true
  error.value = ''
  try {
    const result = await propAPI.openMapStudio(Number(props.asset.id))
    await router.push(result.path)
  } catch (err) { error.value = err instanceof Error ? err.message : String(err) }
  finally { opening.value = false }
}
</script>

<style scoped>
.map-entry { display:flex; flex-direction:column; align-items:flex-start; gap:8px; font-size:12px; }
.map-entry p { margin:0; color:var(--text-2); }
.map-entry p.map-entry-pip { color:var(--accent-text); font-weight:600; }
.map-entry-usage { font-size:11px; color:var(--text-2); }
.map-entry-usage summary { cursor:pointer; font-weight:600; color:var(--text-1); }
.map-entry-usage pre { margin:6px 0 0; white-space:pre-wrap; word-break:break-word; font:11px/1.6 var(--font-body); }
.map-entry .error { color:var(--action-danger); }
</style>
