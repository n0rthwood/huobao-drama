<template>
  <section class="img" :class="{ 'is-compact': compact }">
    <header class="img-head">
      <strong>{{ t('mapStudio.image.title') }}</strong>
      <span class="img-badge" :class="`is-${labelKind}`">{{ labelText }}</span>
      <button type="button" class="img-tool" :disabled="!selected" @click="emit('preview', selected)">
        <Maximize2 :size="11" />
        {{ t('mapStudio.image.expand') }}
      </button>
      <button type="button" class="img-tool" :disabled="!selected" @click="emit('openLayers')">
        <Layers :size="11" />
        {{ t('mapStudio.layers.title') }}
      </button>
    </header>

    <p v-if="staleText" class="img-stale">{{ staleText }}</p>

    <div v-if="selected" class="img-body">
      <button type="button" class="img-thumb" @click="emit('preview', selected)">
        <img :src="selected.url" :alt="labelText" loading="lazy" />
      </button>
      <dl class="img-facts">
        <div class="img-fact">
          <dt>{{ t('mapStudio.image.snapshotId') }}</dt>
          <dd><code>{{ selected.snapshotId }}</code></dd>
        </div>
        <div class="img-fact">
          <dt>{{ t('mapStudio.image.revision') }}</dt>
          <dd>{{ selected.publishedRevision === null ? t('mapStudio.image.notRecorded') : t('mapStudio.image.revisionValue', { n: selected.publishedRevision }) }}</dd>
        </div>
        <div class="img-fact">
          <dt>{{ t('mapStudio.image.run') }}</dt>
          <dd>{{ selected.runId === null ? t('mapStudio.image.notRecorded') : t('mapStudio.agentProcess.runLabel', { id: selected.runId }) }}</dd>
        </div>
        <div class="img-fact">
          <dt>{{ t('mapStudio.image.source') }}</dt>
          <dd>{{ selected.source || t('mapStudio.image.notRecorded') }}</dd>
        </div>
        <div class="img-fact">
          <dt>{{ t('mapStudio.image.sha') }}</dt>
          <dd>{{ t('mapStudio.image.shaUnrecorded') }}</dd>
        </div>
        <div class="img-fact">
          <dt>{{ t('mapStudio.image.size') }}</dt>
          <dd>{{ t('mapStudio.results.size', { w: selected.width, h: selected.height }) }}</dd>
        </div>
      </dl>
      <p v-if="selected.publishedRevision === null" class="img-incomplete">{{ t('mapStudio.image.identityIncomplete') }}</p>
    </div>
    <p v-else class="img-empty dim">{{ t('mapStudio.empty.image') }}</p>

    <div v-if="state.versions.length > 1" class="img-versions">
      <span class="img-versions-label">{{ t('mapStudio.image.versions') }}</span>
      <button
        v-for="version in state.versions"
        :key="version.snapshotId"
        type="button"
        class="img-version"
        :class="{ 'is-on': version.snapshotId === selected?.snapshotId }"
        :aria-pressed="version.snapshotId === selected?.snapshotId"
        @click="emit('select', version.snapshotId)"
      >
        {{ versionLabel(version) }}
      </button>
    </div>

    <ul v-if="deliveredVersions.length" class="img-delivered">
      <li>{{ t('mapStudio.image.deliveredVersions', { ids: deliveredVersions.join(', ') }) }}</li>
    </ul>
  </section>
</template>

<script setup lang="ts">
/**
 * ② 当前成图（Issue #126 设计 01 §6）：图片 + 身份 + 上一版标识。
 *
 * 只展示可证明的事实：发布 revision 来自 history 记录；sha 未记录就写「未记录」。
 * 选定历史版本后不因轮询抢回选择（选择归属页面 controller），这里只渲染与发事件。
 */
import { Layers, Maximize2 } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import type { MapStudioDetail } from '~/map-studio/api'
import type { MapImageState, MapImageVersion } from '~/map-studio/utils/mapSnapshot'

const { t } = useI18n()

const props = defineProps<{
  detail: MapStudioDetail
  state: MapImageState
  selectedId: string | null
  /** 图与当前输入是否不一致：geometry / options / brief（来自服务端 issues 的既有口径） */
  stale: 'geometry' | 'options' | 'brief' | null
  compact?: boolean
}>()

const emit = defineEmits<{
  (e: 'select', snapshotId: string): void
  (e: 'preview', version: MapImageVersion | null): void
  (e: 'openLayers'): void
}>()

const selected = computed<MapImageVersion | null>(() => {
  const base = props.state.base
  if (base && props.selectedId === base.snapshotId) return base
  return props.state.versions.find(version => version.snapshotId === props.selectedId) ?? props.state.versions[0] ?? null
})

const labelKind = computed(() => {
  if (!selected.value) return 'empty'
  if (selected.value.kind === 'base') return 'base'
  if (selected.value.kind === 'previous') {
    if (props.detail.status === 'running') return 'previous-running'
    if (props.detail.status === 'failed') return 'previous-failed'
    return 'previous'
  }
  return props.detail.status === 'running' ? 'final-running' : 'final'
})

const labelText = computed(() => {
  const kind = labelKind.value
  if (kind === 'empty') return t('mapStudio.empty.image')
  if (kind === 'base') return t('mapStudio.image.baseOnly')
  if (kind === 'previous-running') return t('mapStudio.image.previousRendering')
  if (kind === 'previous-failed') return t('mapStudio.image.previousFailed')
  const suffix = selected.value?.publishedRevision === null || selected.value?.publishedRevision === undefined
    ? ''
    : ` · r${selected.value.publishedRevision}`
  if (kind === 'previous') return t('mapStudio.image.previous') + suffix
  if (kind === 'final-running') return t('mapStudio.image.syncing')
  return t('mapStudio.image.final') + suffix
})

const staleText = computed(() => {
  if (props.stale === 'geometry') return t('mapStudio.image.geometryMismatch')
  if (props.stale === 'options') return t('mapStudio.image.optionsChanged')
  if (props.stale === 'brief') return t('mapStudio.image.briefChanged')
  return ''
})

const deliveredVersions = computed(() => {
  const latest = props.detail.deliveries[0]
  return latest && latest.version_ids.length ? latest.version_ids : []
})

function versionLabel(version: MapImageVersion): string {
  const name = version.kind === 'previous' && version.snapshotId !== props.state.current?.snapshotId
    ? t('mapStudio.image.previous')
    : t('mapStudio.image.final')
  return version.publishedRevision === null ? `${name} · ${t('mapStudio.image.notRecorded')}` : `${name} · r${version.publishedRevision}`
}
</script>

<style scoped>
.img { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.img-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 11px; color: var(--text-1); }
.img-head strong { font: 600 11px var(--font-body); }
.img-badge { padding: 1px 8px; border-radius: 999px; border: 1px solid var(--border-strong); font: 600 10px var(--font-body); color: var(--text-2); }
.img-badge.is-final { color: var(--accent-text); border-color: var(--accent-text); }
.img-badge.is-final-running { color: var(--text-2); border-style: dashed; }
.img-badge.is-previous { color: var(--text-2); }
.img-badge.is-previous-running,
.img-badge.is-previous-failed { background: var(--warn-bg); border-color: var(--warn-border); color: var(--warn-text); }
.img-tool {
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
.img-tool:hover:not(:disabled) { color: var(--accent-text); border-color: var(--accent-text); }
.img-tool:disabled { opacity: .5; cursor: not-allowed; }
.img-stale {
  margin: 0;
  padding: 5px 8px;
  border-radius: 6px;
  background: var(--warn-bg);
  border: 1px solid var(--warn-border);
  color: var(--warn-text);
  font: 600 10.5px var(--font-body);
}
.img-body { display: grid; grid-template-columns: minmax(220px, 1fr) minmax(210px, 320px); gap: 10px; align-items: start; }
.img.is-compact .img-body { grid-template-columns: minmax(160px, 240px) minmax(200px, 300px); }
.img-thumb { padding: 0; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-2); cursor: zoom-in; overflow: hidden; }
.img.is-compact .img-thumb img { max-height: 180px; }
.img-thumb img { display: block; width: 100%; max-height: 420px; object-fit: contain; }
.img-facts { display: flex; flex-direction: column; gap: 3px; margin: 0; font-size: 10.5px; color: var(--text-2); }
.img-fact { display: flex; gap: 6px; align-items: baseline; }
.img-fact dt { font: 600 10px var(--font-body); color: var(--text-1); white-space: nowrap; }
.img-fact dd { margin: 0; word-break: break-all; }
.img-fact code { font-size: 10px; }
.img-incomplete { margin: 0; font-size: 10.5px; color: var(--warn-text); }
.img-empty { margin: 0; }
.img-versions { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; font-size: 10.5px; }
.img-versions-label { font: 600 10.5px var(--font-body); color: var(--text-1); }
.img-version {
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  background: transparent;
  color: var(--text-2);
  font: 600 10px var(--font-body);
  cursor: pointer;
}
.img-version.is-on { color: var(--accent-text); border-color: var(--accent-text); }
.img-delivered { list-style: none; margin: 0; padding: 0; font-size: 10.5px; color: var(--text-2); }
</style>
