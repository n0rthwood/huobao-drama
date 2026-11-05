<script setup>
/**
 * 导出步骤：镜头清单 / 片头开关 / 拼接按钮 / 成片历史
 *
 * Issue #54：本组件是该步骤的稳定挂载点。内容由 `episode.vue` 原样搬入（能力不丢），
 * 状态与方法通过 `provide/inject` 的工作台上下文取得——episode.vue 仍是单一数据源，
 * 后续 Issue 只改本文件内部，不再回 episode.vue 改 markup。
 */
import { inject } from 'vue'
import { useI18n } from 'vue-i18n'
import { Trash2 } from 'lucide-vue-next'
import MediaTime from '~/components/MediaTime.vue'
import { mapError } from '~/composables/useToast'
import { mediaUrl } from '~/utils/url'
import { posterOf } from '~/composables/useMedia'
import { WORKBENCH_CTX } from '~/utils/workbenchSteps'

const { t } = useI18n()
const ctx = inject(WORKBENCH_CTX)
const {
  activeMerge,
  askDeleteMerge,
  askMerge,
  composeReasonOf,
  composeStatusLabel,
  composeStatusOf,
  deletingMergeId,
  episode,
  exportBlockedSelected,
  exportComposeReadyIds,
  exportDone,
  exportMerges,
  exportPosterDuration,
  exportPosterEnabled,
  exportPosterVersionId,
  exportReadyIds,
  exportRepairIds,
  exportSelectedReadyIds,
  exportSourceLabel,
  getVideoUrl,
  hasUsableVideo,
  hasVid,
  isExportSelected,
  isMergeInProgress,
  loadExportMerges,
  mediaTimeOf,
  mergeBlocked,
  mergeSkipped,
  narrationEnabledOf,
  openComposeDialog,
  panel,
  posterPreviewUrl,
  posterVersionOptions,
  previewShot,
  refresh,
  sbs,
  selectExportReadyOnly,
  shotVidCount,
  toggleExportDone,
  toggleExportSelect,
  toggleSelectAllExport,
} = ctx
</script>

<template>
<div class="content-panel">
  <div v-if="!sbs.length" class="step-empty" style="flex:1">
    <div class="empty-visual">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
    </div>
    <div class="empty-title">{{ t('episode.prod.notReady') }}</div>
    <div class="empty-desc">{{ t('episode.export.notReadyDesc') }}</div>
    <button class="btn btn-primary" @click="panel = 'script'">{{ t('episode.export.gotoScript') }}</button>
  </div>
  <div v-else class="export-split">
    <div class="export-main">
      <!-- 上方:成片列表 -->
      <div class="export-section">
        <div class="export-section-head">
          <span class="export-section-title">{{ t('episode.export.filmList') }}</span>
          <span class="dim" style="font-size:11px">{{ t('episode.export.countN', { n: exportMerges.length }) }}</span>
          <button
            :class="['btn btn-sm ml-auto export-done-btn', { on: exportDone }]"
            :title="t('episode.export.markDoneTitle')"
            @click="toggleExportDone"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            {{ exportDone ? t('episode.export.markedDone') : t('episode.export.markDone') }}
          </button>
          <button class="btn btn-sm" @click="loadExportMerges">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
            {{ t('common.refresh') }}
          </button>
        </div>
        <div v-if="exportMerges.length" class="export-merge-strip">
          <div
            v-for="m in exportMerges"
            :key="m.id"
            :class="['merge-card', m.status === 'completed' && m.merged_url && 'playable']"
            :role="m.status === 'completed' && m.merged_url ? 'button' : undefined"
            :tabindex="m.status === 'completed' && m.merged_url ? 0 : undefined"
            @click="m.status === 'completed' && m.merged_url && (activeMerge = m)"
            @keydown.enter.prevent="m.status === 'completed' && m.merged_url && (activeMerge = m)"
          >
            <div class="merge-card-thumb">
              <video
                v-if="m.status === 'completed' && m.merged_url"
                :src="mediaUrl(m.merged_url)"
                :poster="posterOf(mediaUrl(m.merged_url)) || undefined"
                preload="none"
                muted
                playsinline
                tabindex="-1"
              />
              <div v-else :class="['merge-card-pending', m.status === 'failed' && 'is-failed']" :title="m.status === 'failed' ? m.error_msg : null">
                {{ m.status === 'failed' ? mapError(m.error_msg, { fallback: 'episode.export.mergeFailed' }) : t('episode.export.merging') }}
              </div>
              <span v-if="m.status === 'completed' && m.merged_url" class="merge-card-play">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 3 20 12 6 21 6 3"/></svg>
              </span>
            </div>
            <div class="merge-card-meta">
              <MediaTime :at="m.generated_at || m.created_at_unix" />
              <span v-if="m.duration">· {{ m.duration }}s</span>
              <a
                v-if="m.status === 'completed' && m.merged_url"
                :href="mediaUrl(m.merged_url)"
                download
                class="btn btn-sm"
                @click.stop
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                {{ t('common.download') }}
              </a>
              <button
                type="button"
                class="btn btn-sm merge-card-del"
                :disabled="isMergeInProgress(m) || deletingMergeId === m.id"
                :title="isMergeInProgress(m) ? t('episode.export.deleteMergeBusy') : t('episode.export.deleteMerge')"
                @click.stop="askDeleteMerge(m)"
              >
                <Trash2 :size="11" />
                {{ t('common.delete') }}
              </button>
            </div>
          </div>
        </div>
        <div v-else class="export-merge-empty">{{ t('episode.export.empty') }}</div>
      </div>

      <!-- Poster 片头（Issue #39，可选）：静态海报 + 展示秒数，插在所选镜头之前 -->
      <div class="export-section export-poster-section">
        <div class="export-section-head">
          <span class="export-section-title">{{ t('episode.export.posterTitle') }}</span>
          <span class="dim" style="font-size:11px">{{ t('episode.export.posterHint') }}</span>
        </div>
        <div v-if="posterVersionOptions.length" class="export-poster-row">
          <label class="export-poster-check">
            <input type="checkbox" v-model="exportPosterEnabled" />
            {{ t('episode.export.posterEnable') }}
          </label>
          <select v-model="exportPosterVersionId" class="input export-poster-select" :disabled="!exportPosterEnabled">
            <option v-for="version in posterVersionOptions" :key="version.id" :value="version.id">
              {{ t('episode.export.posterVersion', { n: version.id }) }}
            </option>
          </select>
          <label class="export-poster-duration">
            {{ t('episode.export.posterDuration') }}
            <input
              v-model.number="exportPosterDuration"
              type="number"
              min="0.5"
              max="10"
              step="0.5"
              class="input export-poster-seconds"
              :disabled="!exportPosterEnabled"
            />
            {{ t('episode.export.posterSeconds') }}
          </label>
          <img v-if="exportPosterEnabled && posterPreviewUrl" :src="posterPreviewUrl" alt="" class="export-poster-preview" />
        </div>
        <div v-else class="export-merge-empty">{{ t('episode.export.posterNone') }}</div>
      </div>

      <!-- 下方:镜头素材(可勾选) -->
      <div class="export-section export-section-grow">
        <div class="export-section-head">
          <span class="export-section-title">{{ t('episode.export.shotAssets') }}</span>
          <span class="dim" style="font-size:11px">{{ t('episode.export.shotStat', { done: shotVidCount, total: sbs.length, selected: exportSelectedReadyIds.length }) }}</span>
          <div class="ml-auto flex gap-1">
            <button class="btn btn-sm" :disabled="!exportReadyIds.length" @click="toggleSelectAllExport">
              {{ exportSelectedReadyIds.length === exportReadyIds.length && exportReadyIds.length ? t('episode.export.clearSelection') : t('episode.export.selectAllReady') }}
            </button>
            <button
              class="btn btn-sm"
              :disabled="!exportComposeReadyIds.length || exportComposeReadyIds.length === exportSelectedReadyIds.length"
              :title="t('episode.export.selectReadyOnlyTitle')"
              @click="selectExportReadyOnly"
            >
              {{ t('episode.export.selectReadyOnly', { n: exportComposeReadyIds.length }) }}
            </button>
            <button
              v-if="narrationEnabledOf && exportRepairIds.length"
              class="btn btn-sm"
              @click="openComposeDialog(exportRepairIds)"
            >
              {{ t('episode.export.repairFusion', { n: exportRepairIds.length }) }}
            </button>
            <button
              class="btn btn-sm btn-primary"
              :disabled="!exportSelectedReadyIds.length"
              @click="askMerge"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
              {{ t('episode.export.mergeSelected', { n: exportSelectedReadyIds.length }) }}
            </button>
          </div>
        </div>
        <!-- 拼接来源与就绪情况：先说清用的是融合成片还是原视频，再说差多少（#42） -->
        <div class="export-ready-bar">
          <span class="export-ready-source">{{ t('episode.export.sourceLine', { source: exportSourceLabel }) }}</span>
          <span class="export-ready-ok">{{ t('episode.export.readyCount', { n: exportComposeReadyIds.length, total: exportSelectedReadyIds.length }) }}</span>
          <span v-if="exportBlockedSelected.length" class="export-ready-bad">
            {{ t('episode.export.notReadyCount', { n: exportBlockedSelected.length }) }}
          </span>
        </div>
        <div v-if="exportBlockedSelected.length" class="export-compose-warn">
          <div class="export-compose-skipped-title">{{ t('episode.export.notReadyTitle') }}</div>
          <span v-for="item in exportBlockedSelected" :key="item.id">
            {{ t('episode.compose.skippedItem', { n: item.number, reason: item.reason || item.label }) }}
          </span>
        </div>
        <div v-if="mergeBlocked.length" class="export-compose-skipped">
          <div class="export-compose-skipped-title">{{ t('episode.export.blockedTitle') }}</div>
          <span v-for="item in mergeBlocked" :key="item.storyboard_id">
            {{ t('episode.compose.skippedItem', { n: item.storyboard_number, reason: item.reason }) }}
          </span>
        </div>
        <div v-if="mergeSkipped.length" class="export-compose-skipped">
          <div class="export-compose-skipped-title">{{ t('episode.compose.skippedTitle') }}</div>
          <span v-for="item in mergeSkipped" :key="item.storyboard_number">
            {{ t('episode.compose.skippedItem', { n: item.storyboard_number, reason: mapError(item.reason) || item.reason }) }}
          </span>
        </div>
        <div class="export-grid">
          <div
            v-for="(sb, i) in sbs"
            :key="sb.id"
            :class="['exp-card', { selected: isExportSelected(sb.id), playable: hasUsableVideo(sb) }]"
            :role="hasUsableVideo(sb) ? 'button' : undefined"
            :tabindex="hasUsableVideo(sb) ? 0 : undefined"
            :aria-pressed="hasUsableVideo(sb) ? isExportSelected(sb.id) : undefined"
            @click="toggleExportSelect(sb)"
            @keydown.enter.prevent="toggleExportSelect(sb)"
            @keydown.space.prevent="toggleExportSelect(sb)"
          >
            <div class="exp-thumb">
              <video
                v-if="hasVid(sb)"
                :src="mediaUrl(getVideoUrl(sb))"
                :poster="posterOf(mediaUrl(getVideoUrl(sb))) || undefined"
                preload="none"
                muted
                playsinline
                tabindex="-1"
              />
              <div v-else class="exp-thumb-empty">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
              </div>
              <span class="exp-thumb-index">#{{ String(i+1).padStart(2,'0') }}</span>
              <span v-if="sb.duration" class="exp-thumb-duration">{{ sb.duration }}s</span>
              <span
                v-if="hasVid(sb)"
                class="exp-play"
                :title="t('episode.export.previewShot')"
                @click.stop="previewShot = sb"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 3 20 12 6 21 6 3"/></svg>
              </span>
              <span v-if="hasUsableVideo(sb)" :class="['exp-check', isExportSelected(sb.id) && 'on']">
                <svg v-if="isExportSelected(sb.id)" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              </span>
            </div>
            <div class="exp-row-line">
              <span class="truncate" style="flex:1;font-size:11px">{{ sb.description || sb.title || '—' }}</span>
              <MediaTime v-if="hasVid(sb)" :at="mediaTimeOf(sb, getVideoUrl(sb))" />
              <span :class="['dot', hasVid(sb) && 'ok']" />
              <span
                v-if="narrationEnabledOf"
                :class="['exp-compose-state', 'is-' + composeStatusOf(sb)]"
                :title="composeReasonOf(sb) || composeStatusLabel(sb)"
              >
                {{ composeStatusLabel(sb) }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
</template>

<style scoped>
.video-task-metric.is-failed,
.video-task-status.is-failed,
.video-task-status.is-blocked {
  color: var(--warning);
  border-color: var(--warning-bg);
  background: var(--warning-bg);
}
.video-task-row.is-failed {
  background: var(--error-bg);
}
.video-task-state.is-failed { color: var(--warning); }
/* Export */
.export-split { flex: 1; display: flex; min-height: 0; }
.export-main { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; align-items: stretch; gap: 18px; padding: 16px 20px 24px; }
.export-section { display: flex; flex-direction: column; min-height: 0; }
.export-section-grow { flex: 1; }
.export-section-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.export-section-title { font-size: 13px; font-weight: 800; color: var(--text-0); }
.export-poster-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.export-poster-check { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-1); }
.export-poster-select { min-width: 160px; }
.export-poster-duration { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-2); }
.export-poster-seconds { width: 68px; }
.export-poster-preview { width: 96px; aspect-ratio: 16 / 9; object-fit: cover; border-radius: 6px; border: 1px solid var(--border); }
.export-merge-strip { display: flex; gap: 12px; overflow-x: auto; padding-bottom: 4px; }
.merge-card {
  flex: 0 0 auto;
  width: 260px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border-radius: var(--radius);
  background: var(--surface-raised);
  border: 1px solid var(--border);
}
.merge-card video {
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: 6px;
  background: var(--media-surface);
  display: block;
}
.merge-card-pending {
  width: 100%;
  aspect-ratio: 16 / 9;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 12px;
  border-radius: 6px;
  background: var(--surface-muted);
  color: var(--text-3);
  font-size: 11px;
  text-align: center;
}
.merge-card-pending.is-failed { color: var(--error); background: var(--error-bg); }
.merge-card-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; font-size: 11px; color: var(--text-3); min-width: 0; }
.merge-card-meta > span { white-space: nowrap; }
.merge-card.playable { cursor: pointer; }
.merge-card.playable:hover { border-color: var(--border-strong); box-shadow: var(--shadow-card); }
.merge-card-thumb { position: relative; }
.merge-card-play {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  background: rgba(0,0,0,0.28);
  color: #fff;
  opacity: 0;
  transition: opacity 0.15s var(--ease-out);
  pointer-events: none;
}
.merge-card.playable:hover .merge-card-play { opacity: 1; }
.export-merge-empty {
  padding: 14px;
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  color: var(--text-3);
  font-size: 12px;
  text-align: center;
}
.export-grid {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  align-content: start;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 12px;
}
.exp-card { display: flex; flex-direction: column; align-items: stretch; gap: 6px; padding: 8px; border-radius: var(--radius); background: var(--surface-raised); border: 1px solid var(--border); }
.exp-card:hover { border-color: var(--border-strong); box-shadow: var(--shadow-card); }
.exp-card.playable { cursor: pointer; }
.exp-card.selected { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-glow); }
.exp-check {
  position: absolute;
  right: 6px;
  top: 6px;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  border: 1.5px solid rgba(255,255,255,0.9);
  background: rgba(0,0,0,0.35);
  color: #fff;
}
.exp-thumb {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  border: 1px solid var(--surface-outline);
  border-radius: 6px;
  background: var(--media-surface);
}
.exp-thumb video { width: 100%; height: 100%; object-fit: cover; display: block; }
.exp-thumb-empty { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: var(--text-3); }
.exp-thumb-index {
  position: absolute;
  left: 5px;
  top: 5px;
  padding: 1px 5px;
  border-radius: 4px;
  background: rgba(0,0,0,0.56);
  color: #fff;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 800;
}
.exp-thumb-duration {
  position: absolute;
  right: 5px;
  bottom: 5px;
  padding: 1px 4px;
  border-radius: 3px;
  background: rgba(0,0,0,0.6);
  color: #fff;
  font-family: var(--font-mono);
  font-size: 9px;
}
/* 镜头预览：悬停浮现的居中播放钮，点击打开预览弹窗（不影响卡片勾选） */
.exp-play {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%) scale(0.9);
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: rgba(0,0,0,0.62);
  color: #fff;
  opacity: 0;
  cursor: pointer;
  transition: opacity 0.15s, transform 0.15s, background 0.15s;
}
.exp-card:hover .exp-play { opacity: 1; transform: translate(-50%, -50%) scale(1); }
.exp-play:hover { background: var(--accent); }
.exp-row-line { display: flex; align-items: center; gap: 8px; min-width: 0; }
/* 旁白开关打开时的导出页提示（#30 C.5），#42 起也承载「所选未就绪」逐镜原因 */
.export-compose-warn {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 10px;
  border: 1px solid var(--tag-warning-text);
  border-radius: 6px;
  color: var(--tag-warning-text);
  font-size: 11px;
}
.export-compose-skipped {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 11px;
  color: var(--text-2);
}
.export-compose-skipped-title {
  width: 100%;
  font-weight: 600;
  color: var(--text-1);
}
/* 导出就绪条（#42）：来源 + 可拼接/未就绪计数 */
.export-ready-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 11px;
  color: var(--text-2);
}
.export-ready-source { font-weight: 600; color: var(--text-1); }
.export-ready-ok { color: var(--tag-success-text); }
.export-ready-bad { color: var(--action-danger); }
.exp-compose-state {
  font-size: 11px;
  white-space: nowrap;
}
.exp-compose-state.is-unchanged { color: var(--tag-success-text); }
.exp-compose-state.is-missing,
.exp-compose-state.is-changed { color: var(--accent-text); }
.exp-compose-state.is-unknown,
.exp-compose-state.is-skipped { color: var(--tag-warning-text); }
.exp-compose-state.is-blocked { color: var(--action-danger); }
.exp-compose-state.is-disabled { color: var(--text-3); }
.studio-topbar .btn {
  height: 26px;
  padding: 0 9px;
  font-size: 10.5px;
  white-space: nowrap;
}
.sidebar-progress-labels span.on {
  color: var(--accent-text);
  font-weight: 700;
}
.content-panel { flex: 1; display: flex; flex-direction: column; overflow: hidden; position: relative; min-height: 0; }
/* Step Empty State */
.step-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  flex: 1; min-height: 300px; gap: 10px; padding: 46px;
  animation: fadeIn 0.3s var(--ease-out);
}
.empty-visual {
  width: 72px; height: 72px; border-radius: 22px;
  background: var(--bg-1); color: var(--accent);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-sm);
  display: flex; align-items: center; justify-content: center;
  margin-bottom: 8px;
}
.empty-title { font-size: 22px; font-weight: 700; font-family: var(--font-display); color: var(--text-0); }
.empty-desc { font-size: 13px; color: var(--text-2); max-width: 420px; text-align: center; line-height: 1.8; }
.shot-check.on { background: var(--accent); border-color: var(--accent); }
.afp-text.dim { color: var(--text-3); }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--bg-3); flex-shrink: 0; }
.dot.ok { background: var(--success); }
.dot.pending {
  background: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-glow);
}
button.video-task-metric.on { box-shadow: 0 0 0 2px var(--accent); }
/* 批量视频：选择模式 */
.btn.is-on { border-color: var(--accent); color: var(--accent-text); background: var(--accent-bg); }
.video-task-check.on { background: var(--accent); border-color: var(--accent); }
.video-source-tab.on { background: var(--surface-raised); color: var(--accent); }
.prod-actions .btn { flex: 1; justify-content: center; }
.asset-detail-section-title .dim {
  font-size: 11px;
  font-weight: 560;
  letter-spacing: 0;
  text-align: right;
}
.asset-detail-readonly p.dim {
  color: var(--text-3);
}
.merge-card-meta .btn { margin-left: auto; }
.merge-card-meta .btn + .btn { margin-left: 0; }
.exp-check.on { background: var(--accent); border-color: var(--accent); }
/* 导出完成手动标记按钮 */
.export-done-btn.on {
  background: var(--success-bg, var(--accent-bg));
  color: var(--success, var(--accent-text));
  border-color: transparent;
  font-weight: 600;
}
/* Shared */
.dim { color: var(--text-3); }
</style>
