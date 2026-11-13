<template>
  <section class="md">
    <header class="md-head">
      <strong>{{ t('mapStudio.deliveries.title') }}</strong>
      <span class="dim">{{ t('mapStudio.deliveries.hint') }}</span>
      <button
        type="button"
        class="md-tool"
        :disabled="busy || !canDeliver"
        :title="canDeliver ? t('mapStudio.deliveries.redeliver') : t('mapStudio.deliveries.redeliverBlocked')"
        @click="emit('deliver')"
      >
        <Loader2 v-if="delivering" :size="11" class="animate-spin" />
        {{ t('mapStudio.deliveries.redeliver') }}
      </button>
    </header>

    <p v-if="error" class="md-error">{{ error }}</p>

    <ul class="md-downloads">
      <li v-for="kind in downloadKinds" :key="kind">
        <a class="md-link" :href="downloadUrl(kind)" download>{{ t('mapStudio.deliveries.download.' + kind) }}</a>
      </li>
    </ul>

    <p v-if="!deliveries.length" class="md-empty dim">{{ t('mapStudio.deliveries.empty') }}</p>
    <ul v-else class="md-list">
      <li v-for="row in deliveries" :key="row.id" class="md-row">
        <span class="md-rev">#{{ row.id }}</span>
        <span class="dim">{{ fmtAt(row.at) }}</span>
        <span v-if="row.run_id" class="dim">{{ t('mapStudio.agentProcess.runLabel', { id: row.run_id }) }}</span>
        <span v-if="row.version_ids.length" class="md-chips">
          {{ t('mapStudio.deliveries.versions', { n: row.version_ids.length }) }} · {{ row.version_ids.join(', ') }}
        </span>
        <code class="md-sha">{{ row.final_sha256.slice(0, 12) }}</code>
        <span v-if="row.message" class="dim">{{ row.message }}</span>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
/**
 * 交付记录（Issue #99）。
 *
 * 宿主任务在「交付」阶段写入版本；同一成图（同一 sha256）重复交付不会重复登记，这里只显示服务端记录。
 * 下载直接走文件流端点：独立任务用它取走成图 / 语义 / KMZ / 可编辑源，宿主任务用来核对同一个文件。
 */
import { Loader2 } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { mapStudioAPI, type MapStudioDeliveryRow, type MapStudioDownloadKind, type MapStudioOutputs } from '~/map-studio/api'

const { t } = useI18n()

const props = defineProps<{
  taskId: number
  deliveries: MapStudioDeliveryRow[]
  outputs: MapStudioOutputs
  /** 交付按钮只在宿主任务、非执行中、且已经有成图时可用 */
  canDeliver: boolean
  busy: boolean
  delivering: boolean
  error: string
}>()

const emit = defineEmits<{ (e: 'deliver'): void }>()

/** 只给真实存在的产物出链接，避免点开是 400 download_unavailable */
const downloadKinds = computed<MapStudioDownloadKind[]>(() => {
  const list: MapStudioDownloadKind[] = []
  if (props.outputs.final_image) list.push('final', 'semantics')
  if (props.outputs.kmz) list.push('kmz')
  if (props.outputs.final_image && props.outputs.layer_doc) list.push('source')
  return list
})

function downloadUrl(kind: MapStudioDownloadKind): string {
  return mapStudioAPI.downloadUrl(props.taskId, kind)
}

function fmtAt(iso: string): string {
  const parsed = Date.parse(iso)
  if (!Number.isFinite(parsed)) return iso || ''
  return new Date(parsed).toLocaleString()
}
</script>

<style scoped>
.md { display: flex; flex-direction: column; gap: 6px; }
.md-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 11px; color: var(--text-1); }
.md-head strong { font: 600 12px var(--font-body); }
.md-tool {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-left: auto;
  padding: 2px 9px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  background: transparent;
  color: var(--text-2);
  font: 600 10.5px var(--font-body);
  cursor: pointer;
}
.md-tool:hover:not(:disabled) { color: var(--accent-text); border-color: var(--accent-text); }
.md-tool:disabled { opacity: 0.5; cursor: not-allowed; }
.md-error { margin: 0; font-size: 10.5px; color: var(--action-danger); }
.md-empty { margin: 0; font-size: 10.5px; }
.md-downloads { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 10px; font-size: 10.5px; }
.md-link { color: var(--accent-text); text-decoration: none; }
.md-link:hover { text-decoration: underline; }
.md-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.md-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 3px 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 10.5px;
  color: var(--text-2);
}
.md-rev { font-weight: 600; color: var(--text-1); }
.md-chips { padding: 0 6px; border-radius: 999px; border: 1px solid var(--border-strong); font-weight: 600; }
.md-sha { font-family: var(--font-mono, monospace); color: var(--text-2); }
</style>
