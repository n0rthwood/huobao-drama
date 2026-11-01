<template>
  <div class="cite" @click.stop>
    <div class="cite-head">
      <span class="cite-label">{{ t('components.citations.label') }}</span>
      <span class="cite-count dim">{{ usable.length }}</span>
      <button class="cite-reload" type="button" :disabled="loading" @click.stop="load">
        <Loader2 v-if="loading" :size="10" class="animate-spin" />
        {{ t('components.citations.refresh') }}
      </button>
    </div>

    <p v-if="loading && !rows.length" class="cite-empty dim">{{ t('components.citations.loading') }}</p>
    <p v-else-if="error" class="cite-empty dim">{{ t('components.citations.loadFailed') }}</p>
    <template v-else>
      <p v-if="searchUnavailable" class="cite-warn">{{ t('components.citations.unavailable') }}</p>
      <p v-if="!usable.length && !searchUnavailable" class="cite-empty dim">{{ t('components.citations.empty') }}</p>
    </template>

    <ul v-if="usable.length" class="cite-list">
      <li v-for="row in usable" :key="row.id" class="cite-item">
        <div class="cite-row">
          <span class="cite-tool">{{ row.tool }}</span>
          <a v-if="row.source_url" class="cite-title" :href="row.source_url" target="_blank" rel="noopener noreferrer">{{ row.title || row.source_url }}</a>
          <span v-else class="cite-title">{{ row.title || t('components.citations.untitled') }}</span>
          <span v-if="row.lang" class="cite-lang">{{ row.lang }}</span>
          <span class="cite-time dim">{{ localTime(row.retrieved_at) }}</span>
        </div>
        <p v-if="row.snippet" class="cite-snippet" :title="row.snippet">{{ truncate(row.snippet) }}</p>
      </li>
    </ul>
  </div>
</template>

<script setup>
/**
 * 资产「资料来源」列表（Issue #32）。
 *
 * 展示提取/提示词 Agent 实际引用过的检索条目。status='failed' 的记录表示那次检索不可用，
 * 该资产只用了剧本原文——这件事必须显式告诉用户，否则会误以为内容有史料支撑。
 */
import { Loader2 } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { researchAPI } from '~/composables/useApi'

const { t } = useI18n()

const props = defineProps({
  // character / scene / prop
  assetKind: { type: String, required: true },
  assetId: { type: [Number, String], required: true },
  snippetMax: { type: Number, default: 160 },
})

const rows = ref([])
const loading = ref(false)
const error = ref(false)

const usable = computed(() => rows.value.filter(row => row.status !== 'failed'))
// 最新一条检索失败（或只剩失败记录）→ 这次没检索成功，内容只来自剧本原文，必须明说
const searchUnavailable = computed(() => {
  const failed = rows.value.filter(row => row.status === 'failed')
  if (!failed.length) return false
  if (!usable.value.length) return true
  const newest = [...rows.value].sort((a, b) => Date.parse(b.retrieved_at || '') - Date.parse(a.retrieved_at || ''))[0]
  return newest?.status === 'failed'
})

function localTime(iso) {
  const ms = Date.parse(iso || '')
  return Number.isFinite(ms) ? new Date(ms).toLocaleString() : ''
}

function truncate(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  return value.length > props.snippetMax ? `${value.slice(0, props.snippetMax)}…` : value
}

async function load() {
  if (!props.assetId || loading.value) return
  loading.value = true
  error.value = false
  try {
    const res = await researchAPI.citations(props.assetKind, Number(props.assetId))
    rows.value = Array.isArray(res) ? res : []
  } catch {
    rows.value = []
    error.value = true
  } finally {
    loading.value = false
  }
}

watch(() => [props.assetKind, props.assetId], load, { immediate: true })

defineExpose({ reload: load })
</script>

<style scoped>
.cite {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 0 2px;
  border-top: 1px dashed var(--border);
}
.cite-head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.cite-label {
  font: 600 11px var(--font-body);
  color: var(--text-1);
}
.cite-count { font-size: 10.5px; }
.cite-reload {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 7px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  background: transparent;
  color: var(--text-2);
  font: 600 10.5px var(--font-body);
  cursor: pointer;
}
.cite-reload:hover:not(:disabled) { color: var(--accent-text); border-color: var(--accent-text); }
.cite-reload:disabled { opacity: 0.5; cursor: not-allowed; }
.cite-warn {
  margin: 0;
  padding: 4px 8px;
  border-radius: 6px;
  background: var(--warn-bg);
  border: 1px solid var(--warn-border);
  color: var(--warn-text);
  font: 600 10.5px var(--font-body);
}
.cite-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.cite-item {
  padding: 5px 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-soft);
}
.cite-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 3px 8px;
  min-width: 0;
}
.cite-tool {
  flex: none;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--accent-bg);
  color: var(--accent-text);
  font: 600 9.5px var(--font-body);
}
.cite-title {
  font: 600 11px var(--font-body);
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
a.cite-title { color: var(--accent-text); text-decoration: underline; }
.cite-lang {
  flex: none;
  font-size: 9.5px;
  color: var(--text-3);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 0 3px;
}
.cite-time { font-size: 10px; margin-left: auto; }
.cite-snippet {
  margin: 3px 0 0;
  font-size: 10.5px;
  color: var(--text-2);
  line-height: 1.45;
}
.cite-empty { font-size: 10.5px; margin: 0; }
</style>
