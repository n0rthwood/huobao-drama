<script setup>
/**
 * 视频与成品（纪录片 final 步 / 剧情 videos 页签）：视频提示词、生成、任务列表、片段卡与合成成品
 *
 * Issue #54：本组件是该步骤的稳定挂载点。内容由 `episode.vue` 原样搬入（能力不丢），
 * 状态与方法通过 `provide/inject` 的工作台上下文取得——episode.vue 仍是单一数据源，
 * 后续 Issue 只改本文件内部，不再回 episode.vue 改 markup。
 */
import { inject } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronRight, Loader2 } from 'lucide-vue-next'
import FieldSaveStatus from '~/components/FieldSaveStatus.vue'
import MediaTime from '~/components/MediaTime.vue'
import MentionTextarea from '~/components/MentionTextarea.vue'
import NarrationBlock from '~/components/NarrationBlock.vue'
import ProgressRing from '~/components/ProgressRing.vue'
import RefIssueList from '~/components/RefIssueList.vue'
import ShotFusionPanel from '~/components/ShotFusionPanel.vue'
import TargetAssetList from '~/components/TargetAssetList.vue'
import DocumentaryFinalPanel from '~/components/DocumentaryFinalPanel.vue'
import VideoQueueBar from '~/components/VideoQueueBar.vue'
import { mediaUrl } from '~/utils/url'
import { posterOf } from '~/composables/useMedia'
import { WORKBENCH_CTX } from '~/utils/workbenchSteps'

const { t } = useI18n()
const ctx = inject(WORKBENCH_CTX)
const {
  KEYFRAME_SLOTS,
  VIDEO_COL_DEFAULTS,
  allKeyframesConfirmed,
  allVideoTaskRows,
  assetImageSrc,
  batchVideoPrompts,
  batchVideos,
  cancelVideoBatch,
  composeBatchRunning,
  composeReasonOf,
  composeStateOf,
  composeStatusLabel,
  composeStatusOf,
  composeTask,
  dramaAspectRatio,
  effectiveVideoDuration,
  effectiveVideoModelLabel,
  episode,
  episodeAudioMixMode,
  episodeFitDefault,
  episodeNarrationNormalize,
  episodeResolutionShort,
  episodeSubtitleTiming,
  fieldSaveInfo,
  footerOpen,
  genTransition,
  genVid,
  genVideoPrompt,
  getVideoUrl,
  gotoShotProduction,
  hasVid,
  historyElapsedTook,
  inspectorOpen,
  isCurrentVideo,
  isDocumentaryProject,
  isShotConfirmed,
  isVideoSbSelected,
  keyframesConfirmedCount,
  mainPlayerUrl,
  markFieldDirty,
  mediaTimeOf,
  mentionOptions,
  narrationBatch,
  narrationEnabledOf,
  onShotComposed,
  onVideoDurationChange,
  onVideoTaskRowClick,
  openComposeDialog,
  openImageViewer,
  pendingVideoIds,
  playerSource,
  prevShotOf,
  previewHistoryVideo,
  previewVideoUrl,
  prodTab,
  promptHeadVideoActionLabel,
  refresh,
  removeHistoryVideo,
  retryFailedVideos,
  sbVideoHistory,
  sbs,
  selectMissingVideos,
  selectedFusionStale,
  selectedFusionUrl,
  selectedSb,
  selectedVideoSbIds,
  selectedVideoTaskNumber,
  setAsMainVideo,
  setPlayerSource,
  setTargetAssetVersion,
  setTransitionEnabled,
  shotInheritsFirst,
  shotKeyframeImage,
  shotKeyframePlaceholder,
  shotPlaceLabel,
  shotVideoRefCount,
  startVideoColDrag,
  targetAssetVersions,
  targetVersionSaving,
  taskGeneratedAt,
  taskVideoPath,
  toggleSelectAllVideos,
  toggleVideoFilter,
  toggleVideoSelectMode,
  totalDuration,
  transitionDurationHint,
  transitionEnabledOf,
  transitionGeneratingIds,
  transitionIssues,
  transitionReviewOf,
  transitionStaleOf,
  transitionVerdictLabel,
  updateField,
  videoBatchCurrentNumber,
  videoBatchDoneCount,
  videoBatchFailedItems,
  videoBatchIssues,
  videoBatchItems,
  videoBatchRunning,
  videoBatchSkippedItems,
  videoBatchStatusLabel,
  videoBatchStopping,
  videoBatchVisible,
  videoBlockIssues,
  videoBlockReason,
  videoEtaLine,
  videoLeftW,
  videoListFilter,
  videoModerationHint,
  videoPromptBatch,
  videoPromptGeneratingIds,
  videoPromptIssues,
  videoRightW,
  videoRing,
  isVideoCancellable,
  cancelVideoTask,
  activeVideoTasks,
  selectedVideoConfig,
  videoSelectMode,
  videoTargetAssets,
  videoTargetLead,
  videoTaskActionLabel,
  videoTaskDoneCount,
  videoTaskFailedCount,
  videoTaskRows,
  videoTaskState,
  videoTaskStatusLabel,
} = ctx

/** 本镜是否有图层段（A/C/D 组合）：视频页只给「去分镜制作」入口，不再在此渲染图层段 */
function hasLayerSegment(sb) {
  const combo = sb?.combo ?? null
  return combo === 'A' || combo === 'C' || combo === 'D'
}
</script>

<template>
<DocumentaryFinalPanel v-if="isDocumentaryProject" />
<div v-else class="prod-content">
  <div class="prod-section-bar">
    <span class="dim" style="font-size:12px">{{ t('episode.prod.videos') }}</span>
    <span class="tag mono">{{ t('episode.sb.segmentStat', { n: sbs.length, dur: totalDuration }) }}</span>
    <span class="tag mono" :title="t('episode.vid.aspectRatio')">{{ dramaAspectRatio }}</span>
    <div class="ml-auto flex gap-1">
      <button class="btn btn-sm" :disabled="videoPromptBatch.running || !sbs.length" @click="batchVideoPrompts">
        <Loader2 v-if="videoPromptBatch.running" :size="11" class="animate-spin" />
        <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
        {{ videoPromptBatch.running ? t('episode.sb.promptProgress', { done: videoPromptBatch.completed, total: videoPromptBatch.total }) : (videoSelectMode && selectedVideoSbIds.length ? t('episode.sb.promptSelected', { n: selectedVideoSbIds.length }) : t('episode.sb.batchPrompts')) }}
      </button>
      <button v-if="videoTaskFailedCount" class="btn btn-sm video-retry-failed" :disabled="videoBatchRunning" @click="retryFailedVideos">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
        {{ t('episode.vid.retryFailed', { n: videoTaskFailedCount }) }}
      </button>
      <button class="btn btn-sm" :class="{ 'is-on': videoSelectMode }" @click="toggleVideoSelectMode">
        {{ videoSelectMode ? t('episode.vid.selectDone', { n: selectedVideoSbIds.length }) : t('episode.vid.select') }}
      </button>
      <button
        class="btn btn-sm"
        :disabled="!sbs.length || videoBatchRunning"
        :title="videoBatchRunning ? t('episode.vid.batchAlreadyRunning') : undefined"
        @click="batchVideos"
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
        {{ videoSelectMode && selectedVideoSbIds.length ? t('episode.vid.batchSelected', { n: selectedVideoSbIds.length }) : t('episode.vid.batchVideos') }}
      </button>
      <button
        v-if="narrationEnabledOf"
        class="btn btn-sm"
        :disabled="!sbs.length"
        :title="composeBatchRunning ? t('episode.composeBatch.runningHint') : undefined"
        @click="openComposeDialog(videoSelectMode && selectedVideoSbIds.length ? selectedVideoSbIds : undefined)"
      >
        <Loader2 v-if="composeBatchRunning" :size="11" class="animate-spin" />
        {{ composeBatchRunning
          ? t('episode.compose.batchProgress', { done: composeTask?.completed || 0, total: composeTask?.total || 0 })
          : (videoSelectMode && selectedVideoSbIds.length ? t('episode.compose.batchSelected', { n: selectedVideoSbIds.length }) : t('episode.compose.batch')) }}
      </button>
    </div>
  </div>
  <div v-if="sbs.length && !allKeyframesConfirmed" class="video-keyframe-gate">
    <span>{{ t('episode.kf.gateBanner', { done: keyframesConfirmedCount, total: sbs.length }) }}</span>
    <button class="btn btn-sm ml-auto" @click="prodTab = isDocumentaryProject ? 'production' : 'keyframes'">{{ t('episode.kf.gateGoto') }}</button>
  </div>
  <VideoQueueBar :tasks="activeVideoTasks" :config-id="selectedVideoConfig?.id ?? null" />
  <div v-if="videoBatchVisible" :class="['video-batch-banner', { 'is-running': videoBatchRunning }]">
    <span class="video-batch-state">{{ t('episode.vid.batchBannerTitle') }} · {{ videoBatchStatusLabel }}</span>
    <span class="video-batch-sep">·</span>
    <span>{{ t('episode.vid.batchProgress', { done: videoBatchDoneCount, total: videoBatchItems.length }) }}</span>
    <template v-if="videoBatchRunning && videoBatchCurrentNumber">
      <span class="video-batch-sep">·</span>
      <span>{{ t('episode.vid.batchCurrent', { n: videoBatchCurrentNumber }) }}</span>
    </template>
    <template v-if="videoBatchFailedItems.length">
      <span class="video-batch-sep">·</span>
      <span class="video-batch-issue">{{ t('episode.vid.batchFailedCount', { n: videoBatchFailedItems.length }) }}</span>
    </template>
    <template v-if="videoBatchSkippedItems.length">
      <span class="video-batch-sep">·</span>
      <span class="video-batch-issue">{{ t('episode.vid.batchSkippedCount', { n: videoBatchSkippedItems.length }) }}</span>
    </template>
    <button v-if="videoBatchRunning" class="btn btn-sm ml-auto" :disabled="videoBatchStopping" @click="cancelVideoBatch">{{ t('episode.vid.batchStop') }}</button>
    <div v-if="videoBatchIssues.length" class="video-batch-issues">
      <span v-for="item in videoBatchIssues" :key="item.storyboard_id" :title="item.error || ''">
        {{ t('episode.vid.batchIssueItem', {
          n: item.storyboard_number,
          state: item.state === 'failed' ? t('episode.vid.batchItemFailed') : t('episode.vid.batchItemSkipped'),
          msg: mapError(item.error) || t('episode.vid.batchNoReason'),
        }) }}
      </span>
    </div>
  </div>
  <div v-if="!sbs.length" class="step-empty video-task-empty-state">
    <div class="empty-visual">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><rect x="2" y="2" width="20" height="20" rx="2.5"/><line x1="7" y1="8" x2="7" y2="16"/><line x1="10" y1="8" x2="10" y2="16"/><line x1="13" y1="8" x2="13" y2="16"/></svg>
    </div>
    <div class="empty-title">{{ t('episode.vid.emptyTitle') }}</div>
    <div class="empty-desc">{{ t('episode.vid.emptyDesc') }}</div>
    <div class="locked-config-banner">{{ t('episode.vid.lockedModel') }}{{ effectiveVideoModelLabel }}</div>
    <button class="btn btn-primary" @click="prodTab = isDocumentaryProject ? 'production' : 'keyframes'">{{ t('episode.kf.gateGoto') }}</button>
  </div>
  <div v-else class="video-task-workbench has-player" :style="{ '--vleft': videoLeftW + 'px', '--vright': videoRightW + 'px' }">
    <section class="video-task-list">
      <div class="video-task-head">
      <div>
        <div class="video-task-title">{{ t('episode.vid.listTitle') }}</div>
        <div class="video-task-meta">{{ videoListFilter ? t('episode.vid.listMetaFiltered', { n: videoTaskRows.length, total: allVideoTaskRows.length }) : t('episode.vid.listMeta', { n: videoTaskRows.length }) }}</div>
      </div>
      <div class="video-task-metrics">
        <button type="button" class="video-task-metric is-pending" :class="{ on: videoListFilter === 'pending' }" @click="toggleVideoFilter('pending')">{{ t('episode.vid.metricPending', { n: pendingVideoIds.length }) }}</button>
        <button type="button" class="video-task-metric is-done" :class="{ on: videoListFilter === 'done' }" @click="toggleVideoFilter('done')">{{ t('episode.vid.metricDone', { n: videoTaskDoneCount }) }}</button>
        <button type="button" class="video-task-metric is-failed" :class="{ on: videoListFilter === 'failed' }" @click="toggleVideoFilter('failed')">{{ t('episode.vid.metricFailed', { n: videoTaskFailedCount }) }}</button>
      </div>
      </div>
      <div v-if="videoSelectMode" class="shot-quick-actions video-quick-actions">
        <button class="shot-quick-btn" @click="toggleSelectAllVideos">{{ t('episode.sb.selectAll') }}</button>
        <button class="shot-quick-btn" @click="selectMissingVideos">{{ t('episode.vid.selectMissing') }}</button>
        <button class="shot-quick-btn" @click="selectedVideoSbIds = []">{{ t('episode.sb.clear') }}</button>
      </div>
      <div class="video-task-table">
      <div
        v-for="task in videoTaskRows"
        :key="task.id"
        :class="['video-task-row', 'is-' + videoTaskState(task.storyboard), { active: !videoSelectMode && selectedSb?.id === task.storyboard.id, 'is-selected': videoSelectMode && isVideoSbSelected(task.id) }]"
        role="button"
        tabindex="0"
        @click="onVideoTaskRowClick(task.storyboard)"
        @keydown.enter.prevent="onVideoTaskRowClick(task.storyboard)"
        @keydown.space.prevent="onVideoTaskRowClick(task.storyboard)"
      >
        <div class="video-task-preview">
          <span
            v-if="videoSelectMode"
            class="shot-check video-task-check"
            :class="{ on: isVideoSbSelected(task.id) }"
          >
            <svg v-if="isVideoSbSelected(task.id)" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          </span>
          <video
            v-if="hasVid(task.storyboard)"
            :src="mediaUrl(getVideoUrl(task.storyboard))"
            :poster="posterOf(mediaUrl(getVideoUrl(task.storyboard))) || undefined"
            preload="none"
            playsinline
            muted
            tabindex="-1"
          />
          <div v-else class="video-task-empty">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
          </div>
          <ProgressRing v-if="videoRing(task.storyboard)" v-bind="videoRing(task.storyboard)" class="video-task-ring" compact detailed :size="22" />
          <span class="video-task-index">#{{ String(task.index + 1).padStart(2, '0') }}</span>
        </div>
        <div class="video-task-main">
          <div class="video-task-line">
            <strong class="video-task-name">{{ task.title }}</strong>
          </div>
          <div class="video-task-meta-line">
            <span :class="['video-task-state', 'is-' + videoTaskState(task.storyboard)]">
              <i :class="['dot', videoTaskState(task.storyboard) === 'done' && 'ok', videoTaskState(task.storyboard) === 'pending' && 'pending']" />{{ videoTaskStatusLabel(task.storyboard) }}
            </span>
            <span class="video-task-sep">·</span>
            <span>{{ task.duration }}s</span>
            <template v-if="task.meta">
              <span class="video-task-sep">·</span>
              <span class="video-task-loc truncate">{{ task.meta }}</span>
            </template>
            <template v-if="!isShotConfirmed(task.storyboard)">
              <span class="video-task-sep">·</span>
              <span class="video-task-unconfirmed" :title="t('episode.kf.gateShotUnconfirmed')">{{ t('episode.kf.stateUnconfirmed') }}</span>
            </template>
            <template v-if="videoBlockIssues(task.storyboard).length">
              <span class="video-task-sep">·</span>
              <span class="video-task-unconfirmed" :title="videoBlockReason(task.storyboard)">{{ t('episode.ref.issueCount', { n: videoBlockIssues(task.storyboard).length }) }}</span>
            </template>
          </div>
          <!-- 视频状态与融合状态是两件事：融合独占一行，窄列表也不会被截成半个词 -->
          <div
            v-if="narrationEnabledOf"
            :class="['video-task-fusion', 'is-' + composeStatusOf(task.storyboard)]"
            :title="composeReasonOf(task.storyboard) || composeStatusLabel(task.storyboard)"
          >
            {{ t('episode.compose.listPrefix') }}{{ composeStatusLabel(task.storyboard) }}
          </div>
          <div v-if="task.error" class="video-task-error" :title="task.error">
            {{ mapError(task.error) }}
            <div v-if="videoModerationHint(task.error)" class="video-task-error-hint">{{ videoModerationHint(task.error) }}</div>
          </div>
        </div>
        <button
          v-if="hasLayerSegment(task.storyboard)"
          class="btn btn-icon btn-sm video-task-action"
          :title="t('episode.production.gotoShotProduction')"
          @click.stop="gotoShotProduction(task.storyboard)"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg>
        </button>
        <button
          v-else
          class="btn btn-icon btn-sm video-task-action"
          :title="videoBlockIssues(task.storyboard).length
            ? t('episode.ref.videoBlocked', { reason: videoBlockReason(task.storyboard) })
            : (isShotConfirmed(task.storyboard) ? videoTaskActionLabel(task.storyboard) : t('episode.kf.gateShotUnconfirmed'))"
          :disabled="videoTaskState(task.storyboard) === 'pending' || videoBatchRunning || !isShotConfirmed(task.storyboard) || videoBlockIssues(task.storyboard).length > 0"
          @click.stop="genVid(task.storyboard)"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
        </button>
      </div>
      </div>
    </section>

    <div v-if="selectedSb" class="video-task-side">
      <!-- 中列（#28 Q1）：播放器 + 视频历史条 + 绑定素材 + 关键帧缩略图 -->
      <div class="video-main-col">
        <aside class="video-task-player">
          <div class="video-player-head">
            <div class="video-player-head-info">
              <div class="video-player-title">{{ t('episode.vid.playerTitle', { n: String(selectedVideoTaskNumber).padStart(2, '0') }) }}</div>
              <span :class="['video-task-status', 'is-' + videoTaskState(selectedSb)]">
                <span :class="['dot', videoTaskState(selectedSb) === 'done' && 'ok', videoTaskState(selectedSb) === 'pending' && 'pending']" />
                {{ videoTaskStatusLabel(selectedSb) }}
              </span>
              <span v-if="selectedSb.duration" class="video-player-sub">{{ selectedSb.duration }}s</span>
              <MediaTime :at="mediaTimeOf(selectedSb, mainPlayerUrl)" />
            </div>
            <!-- 原片 / 融合成片两个页签（#42）：成片不是「另一个小播放器」，就在主播放器里 -->
            <div v-if="narrationEnabledOf" class="video-source-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                :aria-selected="playerSource === 'original' || !!previewVideoUrl"
                :class="['video-source-tab', { on: playerSource === 'original' || !!previewVideoUrl }]"
                @click="setPlayerSource('original')"
              >
                {{ t('episode.compose.sourceOriginal') }}
              </button>
              <button
                type="button"
                role="tab"
                :aria-selected="playerSource === 'fusion' && !previewVideoUrl"
                :class="['video-source-tab', { on: playerSource === 'fusion' && !previewVideoUrl }]"
                :disabled="!selectedFusionUrl"
                :title="selectedFusionUrl ? undefined : t('episode.compose.none')"
                @click="setPlayerSource('fusion')"
              >
                {{ t('episode.compose.sourceFusion') }}
              </button>
            </div>
            <button
              v-if="previewVideoUrl"
              class="btn btn-sm btn-primary"
              @click="setAsMainVideo"
            >
              {{ t('episode.vid.setMain') }}
            </button>
            <a
              v-if="mainPlayerUrl"
              :href="mediaUrl(mainPlayerUrl)"
              download
              class="btn btn-sm"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              {{ t('common.download') }}
            </a>
          </div>
          <div
            v-if="playerSource === 'fusion' && !previewVideoUrl && selectedFusionStale"
            class="video-fusion-warn"
          >
            {{ t('episode.compose.staleWarn', { reason: composeReasonOf(selectedSb) || composeStatusLabel(selectedSb) }) }}
          </div>
          <div class="video-player-stage">
            <video
              v-if="mainPlayerUrl"
              :key="mainPlayerUrl"
              :src="mediaUrl(mainPlayerUrl)"
              :poster="posterOf(mediaUrl(mainPlayerUrl)) || undefined"
              controls
              preload="metadata"
              playsinline
              class="video-player-video"
            />
            <div v-else class="video-player-empty">
              <ProgressRing v-if="videoRing(selectedSb)" v-bind="videoRing(selectedSb)" compact detailed :size="42" />
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
              <div class="video-player-empty-copy">
                <div class="video-player-empty-title">{{ videoTaskState(selectedSb) === 'pending' ? t('episode.vid.emptyGenerating') : t('episode.vid.emptyNoVideo') }}</div>
                <div class="video-player-empty-desc">{{ videoTaskState(selectedSb) === 'pending' ? t('episode.vid.emptyGeneratingDesc') : t('episode.vid.emptyNoVideoDesc') }}</div>
              </div>
              <button
                v-if="hasLayerSegment(selectedSb)"
                class="btn btn-primary btn-sm video-player-empty-action"
                @click="gotoShotProduction(selectedSb)"
              >{{ t('episode.production.gotoShotProduction') }}</button>
              <button
                v-else-if="videoTaskState(selectedSb) !== 'pending'"
                class="btn btn-primary btn-sm video-player-empty-action"
                :disabled="!isShotConfirmed(selectedSb) || videoBlockIssues(selectedSb).length > 0"
                :title="videoBlockIssues(selectedSb).length
                  ? t('episode.ref.videoBlocked', { reason: videoBlockReason(selectedSb) })
                  : (isShotConfirmed(selectedSb) ? undefined : t('episode.kf.gateShotUnconfirmed'))"
                @click="genVid(selectedSb)"
              >
                {{ t('episode.vid.generateVideo') }}
              </button>
            </div>
          </div>
        </aside>

        <div v-if="sbVideoHistory.length" class="video-player-history">
          <div class="video-player-history-head">
            <span>{{ t('episode.vid.history') }}</span>
            <span class="video-player-history-count">{{ sbVideoHistory.length }}</span>
          </div>
          <div class="video-player-history-list">
            <div
              v-for="h in sbVideoHistory"
              :key="h.id"
              :class="['video-history-item', { current: isCurrentVideo(h), viewing: !!previewVideoUrl && previewVideoUrl === taskVideoPath(h) }]"
              role="button"
              tabindex="0"
              @click="previewHistoryVideo(h)"
              @keydown.enter.prevent="previewHistoryVideo(h)"
            >
              <video :src="mediaUrl(taskVideoPath(h))" :poster="posterOf(mediaUrl(taskVideoPath(h))) || undefined" preload="none" muted playsinline tabindex="-1" />
              <MediaTime class="video-history-time" :at="taskGeneratedAt(h)" />
              <span v-if="historyElapsedTook(h)" class="video-history-took">{{ t('episode.vid.elapsedTook', { time: historyElapsedTook(h) }) }}</span>
              <span class="video-history-engine">{{ h.provider || t('episode.vid.unknownEngine') }}<template v-if="h.model"> · {{ h.model }}</template></span>
              <span v-if="isCurrentVideo(h)" class="video-history-badge">{{ t('episode.vid.current') }}</span>
              <button v-else type="button" class="video-history-del" :title="t('episode.vid.deleteRecord')" @click.stop="removeHistoryVideo(h)">×</button>
            </div>
          </div>
        </div>

        <div class="video-inspector-body">
          <section class="video-inspector-section">
            <div class="video-inspector-prompt-head">
              <span class="video-inspector-label">{{ t('episode.inspector.boundRefs') }}</span>
              <span class="tag mono">{{ shotVideoRefCount(selectedSb) }}</span>
            </div>
            <TargetAssetList
              :items="videoTargetAssets"
              :versions-for="targetAssetVersions"
              :lead="videoTargetLead"
              :busy="targetVersionSaving"
              @preview="openImageViewer"
              @select-version="(item, image) => setTargetAssetVersion(selectedSb, 'video', item, image)"
            />
          </section>
          <section class="video-inspector-section">
            <div class="video-inspector-prompt-head">
              <span class="video-inspector-label">{{ t('episode.kf.videoRefTitle') }}</span>
              <span :class="['video-keyframe-state', isShotConfirmed(selectedSb) ? 'is-confirmed' : 'is-unconfirmed']">
                {{ isShotConfirmed(selectedSb) ? t('episode.kf.stateConfirmed') : t('episode.kf.stateUnconfirmed') }}
              </span>
            </div>
            <div class="video-keyframe-thumbs">
              <button
                v-for="slot in KEYFRAME_SLOTS"
                :key="slot.slot"
                type="button"
                class="video-keyframe-thumb"
                :disabled="!shotKeyframeImage(selectedSb, slot.slot)"
                :title="shotKeyframeImage(selectedSb, slot.slot) ? slot.label : shotKeyframePlaceholder(selectedSb, slot.slot)"
                @click="openImageViewer(assetImageSrc({ imageUrl: shotKeyframeImage(selectedSb, slot.slot) }), slot.label)"
              >
                <img
                  v-if="shotKeyframeImage(selectedSb, slot.slot)"
                  :src="thumbOf(assetImageSrc({ imageUrl: shotKeyframeImage(selectedSb, slot.slot) }))"
                  :alt="slot.label"
                  loading="lazy"
                  @error="thumbFallback($event, assetImageSrc({ imageUrl: shotKeyframeImage(selectedSb, slot.slot) }))"
                />
                <span v-else class="video-keyframe-thumb-empty">{{ shotKeyframePlaceholder(selectedSb, slot.slot) }}</span>
                <small>{{ slot.label }}</small>
                <MediaTime :at="mediaTimeOf(selectedSb, shotKeyframeImage(selectedSb, slot.slot))" />
              </button>
            </div>
            <div v-if="!isShotConfirmed(selectedSb)" class="video-keyframe-hint">{{ t('episode.kf.gateShotUnconfirmed') }}</div>
          </section>
        </div>
      </div>

      <!-- 右栏检查器（#28 Q1）：转场 + 视频提示词编辑，时长/生效配置/生成常驻底部 -->
      <aside class="video-task-inspector">
        <div class="video-inspector-body video-inspector-prompts">
          <!-- 融合首屏（#42）：状态 / 输入就绪 / 唯一的融合 CTA，不用滚到底才看得见 -->
          <ShotFusionPanel
            :storyboard="selectedSb"
            :compose-state="composeStateOf(selectedSb)"
            :narration-enabled="narrationEnabledOf"
            :narration-save="fieldSaveInfo(selectedSb, 'narration_text')"
            :episode-fit-default="episodeFitDefault"
            :episode-mix-mode="episodeAudioMixMode"
            :batch-running="composeBatchRunning"
            @composed="onShotComposed"
            @refresh="refresh"
            @open-batch="openComposeDialog()"
            @preview-fusion="setPlayerSource('fusion')"
          />
          <section v-if="shotInheritsFirst(selectedSb)" class="video-inspector-section transition-section">
            <div class="video-inspector-prompt-head">
              <button
                type="button"
                class="video-section-toggle"
                :aria-expanded="inspectorOpen.transition"
                @click="inspectorOpen.transition = !inspectorOpen.transition"
              >
                <ChevronRight :size="12" :class="['video-section-caret', { open: inspectorOpen.transition }]" />
                <span class="video-inspector-label video-inspector-label-hero">{{ t('episode.trans.section') }}</span>
              </button>
              <FieldSaveStatus
                :status="fieldSaveInfo(selectedSb, 'transition_prompt').status"
                :at="fieldSaveInfo(selectedSb, 'transition_prompt').at"
              />
              <span class="ml-auto" />
              <label class="transition-send">
                <input
                  type="checkbox"
                  :checked="transitionEnabledOf(selectedSb)"
                  @change="e => setTransitionEnabled(selectedSb, e.target.checked)"
                >
                {{ t('episode.trans.send') }}
              </label>
              <button
                type="button"
                class="btn btn-sm"
                :disabled="transitionGeneratingIds.includes(selectedSb?.id)"
                @click="genTransition(selectedSb)"
              >
                <Loader2 v-if="transitionGeneratingIds.includes(selectedSb?.id)" :size="11" class="animate-spin" />
                {{ t('episode.trans.generate') }}
              </button>
            </div>
            <template v-if="inspectorOpen.transition">
            <div class="transition-summary">
              <span>{{ t('episode.trans.summary', {
                n: prevShotOf(selectedSb) ? sbs.indexOf(prevShotOf(selectedSb)) + 1 : '-',
                from: prevShotOf(selectedSb) ? shotPlaceLabel(prevShotOf(selectedSb)) : '—',
                to: shotPlaceLabel(selectedSb),
              }) }}</span>
              <span class="transition-verdict">{{ transitionVerdictLabel(selectedSb) }}</span>
              <span v-if="transitionReviewOf(selectedSb)?.technique" class="tag mono">{{ transitionReviewOf(selectedSb).technique }}</span>
              <span v-if="transitionReviewOf(selectedSb)?.edited_manually" class="transition-manual">
                {{ t('episode.trans.manual', { verdict: transitionVerdictLabel(selectedSb) }) }}
              </span>
            </div>
            <div v-if="transitionStaleOf(selectedSb)" class="transition-stale">{{ t('episode.trans.stale') }}</div>
            <MentionTextarea
              :model-value="selectedSb.transition_prompt || selectedSb.transitionPrompt || ''"
              :options="mentionOptions"
              :rows="5"
              input-class="textarea video-inspector-prompt"
              :placeholder="t('episode.trans.placeholder')"
              @update:model-value="v => markFieldDirty(selectedSb, 'transition_prompt', v)"
              @commit="v => updateField(selectedSb, 'transition_prompt', v)"
            />
            <RefIssueList :issues="transitionIssues(selectedSb)" />
            <div class="transition-duration">{{ transitionDurationHint(selectedSb) }}</div>
            </template>
          </section>
          <!-- 旁白编辑（#30 C.3）：融合参数与 CTA 已上移到首屏，这里只留文本/配音/字幕 -->
          <section v-if="narrationEnabledOf" class="video-inspector-section">
            <div class="video-inspector-prompt-head">
              <button
                type="button"
                class="video-section-toggle"
                :aria-expanded="inspectorOpen.narration"
                @click="inspectorOpen.narration = !inspectorOpen.narration"
              >
                <ChevronRight :size="12" :class="['video-section-caret', { open: inspectorOpen.narration }]" />
                <span class="video-inspector-label video-inspector-label-hero">{{ t('episode.narration.section') }}</span>
              </button>
            </div>
            <NarrationBlock
              v-show="inspectorOpen.narration"
              :storyboard="selectedSb"
              :field-save="fieldSaveInfo(selectedSb, 'narration_text')"
              :episode-timing="episodeSubtitleTiming"
              :episode-mix-mode="episodeAudioMixMode"
              :episode-fit-default="episodeFitDefault"
              :episode-normalize="episodeNarrationNormalize"
              :narration-batch="narrationBatch"
              :show-fit="false"
              @update-field="updateField"
              @field-dirty="markFieldDirty"
              @refresh="refresh"
            />
          </section>
          <section class="video-inspector-section">
            <div class="video-inspector-prompt-head">
              <button
                type="button"
                class="video-section-toggle"
                :aria-expanded="inspectorOpen.prompt"
                @click="inspectorOpen.prompt = !inspectorOpen.prompt"
              >
                <ChevronRight :size="12" :class="['video-section-caret', { open: inspectorOpen.prompt }]" />
                <span class="video-inspector-label video-inspector-label-hero">{{ t('episode.sb.videoPromptSection') }}</span>
              </button>
              <FieldSaveStatus
                :status="fieldSaveInfo(selectedSb, 'video_prompt').status"
                :at="fieldSaveInfo(selectedSb, 'video_prompt').at"
              />
              <span class="ml-auto" />
              <button
                type="button"
                class="btn btn-sm"
                :disabled="videoPromptGeneratingIds.includes(selectedSb?.id) || videoPromptBatch.running"
                @click="genVideoPrompt(selectedSb)"
              >
                <Loader2 v-if="videoPromptGeneratingIds.includes(selectedSb?.id)" :size="11" class="animate-spin" />
                {{ (selectedSb.video_prompt || selectedSb.videoPrompt) ? t('episode.sb.regenVideoPrompt') : t('episode.sb.aiGenerateVideoPrompt') }}
              </button>
              <button
                type="button"
                class="btn btn-sm"
                :disabled="videoTaskState(selectedSb) === 'pending' || !isShotConfirmed(selectedSb)"
                :title="!isShotConfirmed(selectedSb) ? t('episode.kf.gateShotUnconfirmed') : undefined"
                @click="genVid(selectedSb)"
              >
                {{ promptHeadVideoActionLabel(selectedSb) }}
              </button>
            </div>
            <template v-if="inspectorOpen.prompt">
              <MentionTextarea
                :model-value="selectedSb.video_prompt || selectedSb.videoPrompt || ''"
                :options="mentionOptions"
                :rows="14"
                input-class="textarea video-inspector-prompt"
                :placeholder="t('episode.inspector.videoPromptPlaceholder')"
                @update:model-value="v => markFieldDirty(selectedSb, 'video_prompt', v)"
                @commit="v => updateField(selectedSb, 'video_prompt', v)"
              />
              <RefIssueList :issues="videoPromptIssues(selectedSb)" />
            </template>
          </section>
        </div>

        <!-- 视频重绘参数常驻底部：可折叠成一行，长内容仍能滚动到底不被遮挡（#42） -->
        <div :class="['video-inspector-footer', { 'is-collapsed': !footerOpen }]">
          <div class="video-footer-bar">
            <button
              type="button"
              class="video-section-toggle"
              :aria-expanded="footerOpen"
              @click="footerOpen = !footerOpen"
            >
              <ChevronRight :size="12" :class="['video-section-caret', { open: footerOpen }]" />
              <span class="video-inspector-label">{{ t('episode.inspector.videoFooterTitle') }}</span>
            </button>
            <span class="ml-auto video-footer-summary">
              {{ t('episode.inspector.effective', { model: effectiveVideoModelLabel || t('episode.vid.defaultModel'), res: episodeResolutionShort, dur: effectiveVideoDuration }) }}
            </span>
          </div>
          <template v-if="footerOpen">
            <section class="video-inspector-section video-params-card">
              <div class="video-param-row">
                <span class="video-param-name">{{ t('episode.inspector.duration') }}</span>
                <span class="video-param-control">
                  <input
                    :value="selectedSb.duration || 10"
                    type="number"
                    min="2"
                    max="30"
                    class="input video-duration-input"
                    @change="onVideoDurationChange"
                  />
                  <span class="video-param-unit">{{ t('episode.inspector.durationUnit') }}</span>
                </span>
              </div>
              <div class="video-param-hint">{{ t('episode.inspector.durationHint') }}</div>
              <div v-if="narrationEnabledOf" class="video-param-hint">{{ t('episode.compose.durationNote') }}</div>
            </section>
            <ProgressRing
              v-if="videoRing(selectedSb)"
              v-bind="videoRing(selectedSb)"
              class="video-footer-ring"
              detailed
              :size="28"
              :cancellable="isVideoCancellable(selectedSb)"
              @cancel="cancelVideoTask(selectedSb)"
            />
            <div class="video-eta-line" :title="videoEtaLine">{{ videoEtaLine }}</div>
          </template>
          <button
            class="btn btn-primary video-inspector-action"
            :disabled="videoTaskState(selectedSb) === 'pending' || !isShotConfirmed(selectedSb)"
            @click="genVid(selectedSb)"
          >
            {{ videoTaskActionLabel(selectedSb) }}
          </button>
        </div>
      </aside>
    </div>
    <div
      class="video-col-divider is-left"
      role="separator"
      aria-orientation="vertical"
      @pointerdown="startVideoColDrag('left', $event)"
      @dblclick="videoLeftW = VIDEO_COL_DEFAULTS.left"
    ></div>
    <div
      class="video-col-divider is-right"
      role="separator"
      aria-orientation="vertical"
      @pointerdown="startVideoColDrag('right', $event)"
      @dblclick="videoRightW = VIDEO_COL_DEFAULTS.right"
    ></div>
  </div>
</div>
</template>

<style scoped>
/* 视频列表选择模式快捷操作：复用分段芯片样式，去掉顶部虚线分隔 */
.video-quick-actions { margin: 0 12px 10px; padding-top: 0; border-top: none; }
.locked-config-banner {
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--text-2);
}
/* 分镜勾选：选择后批量生成视频提示词 */
.shot-check {
  flex: none;
  width: 14px;
  height: 14px;
  border-radius: 4px;
  border: 1.5px solid var(--surface-outline-strong);
  background: transparent;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--on-accent);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
.shot-check:hover { border-color: var(--accent); }
.shot-quick-btn {
  border: none;
  background: transparent;
  color: var(--accent-text);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  padding: 0;
  white-space: nowrap;
}
.shot-quick-btn:hover { text-decoration: underline; }
/* 多选模式：头部快捷操作独立一行，分段芯片样式 */
.shot-quick-actions {
  display: flex;
  gap: 6px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--surface-outline);
}
.shot-quick-actions .shot-quick-btn {
  flex: 1;
  padding: 5px 0;
  border-radius: 6px;
  background: var(--bg-2);
  color: var(--text-2);
  text-align: center;
  transition: background 0.15s, color 0.15s;
}
.shot-quick-actions .shot-quick-btn:hover {
  background: var(--accent-bg);
  color: var(--accent-text);
  text-decoration: none;
}
/* Video tasks */
.video-task-workbench {
  position: relative;
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(460px, 55%);
  overflow: hidden;
  border: 1px solid var(--surface-outline);
  border-radius: var(--radius-lg);
  background: var(--surface-raised);
}
.video-task-workbench.has-player {
  grid-template-columns: var(--vleft, 236px) minmax(0, 1fr);
}
.video-task-side {
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) var(--vright, 420px);
  border-left: 1px solid var(--border);
  background: var(--surface-muted);
}
/* 三栏拖拽分隔条：透明热区覆盖分界，悬停/拖动时亮起 */
.video-col-divider {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 9px;
  z-index: 6;
  cursor: col-resize;
  touch-action: none;
}
.video-col-divider.is-left { left: calc(var(--vleft, 236px) - 4px); }
.video-col-divider.is-right { right: calc(var(--vright, 420px) - 4px); }
.video-col-divider::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 4px;
  width: 1px;
  background: transparent;
  transition: background 0.15s, box-shadow 0.15s;
}
.video-col-divider:hover::after,
.video-col-divider:active::after {
  background: var(--accent);
  box-shadow: 0 0 6px var(--accent-glow);
}
/* 中列：播放器 + 历史条 + 绑定素材/关键帧（提示词移入右栏检查器），顶部媒体区固定、下方滚动 */
.video-main-col {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--surface-raised);
}
.video-player-history {
  min-height: 0;
  padding: 8px 12px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-raised);
}
.video-player-history-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 7px;
  font-size: 11px;
  font-weight: 700;
  color: var(--text-2);
}
.video-player-history-count {
  padding: 0 6px;
  border-radius: 999px;
  background: var(--overlay-track);
  color: var(--text-3);
  font-size: 10px;
  font-weight: 750;
}
.video-player-history-list {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding-bottom: 2px;
}
.video-history-item {
  position: relative;
  flex: 0 0 auto;
  width: 96px;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  border: 1.5px solid var(--surface-outline);
  border-radius: var(--radius);
  background: var(--media-surface);
  cursor: pointer;
  transition: border-color 0.16s var(--ease-out), box-shadow 0.16s var(--ease-out);
}
.video-history-item:hover { border-color: var(--border-strong); }
.video-history-item video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.video-history-item.viewing {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-glow);
}
.video-history-time {
  position: absolute;
  left: 4px;
  bottom: 4px;
  padding: 1px 4px;
  border-radius: 3px;
  background: rgba(0,0,0,0.6);
  color: #fff;
  font-family: var(--font-mono);
  font-size: 9px;
}
/* 历史条每条的实测总耗时（elapsed_ms 缺失时隐藏） */
.video-history-took {
  position: absolute;
  right: 4px;
  bottom: 4px;
  padding: 1px 4px;
  border-radius: 3px;
  background: rgba(0,0,0,0.6);
  color: #fff;
  font-family: var(--font-mono);
  font-size: 9px;
}
.video-history-engine {
  position: absolute;
  left: 4px;
  right: 4px;
  top: 4px;
  overflow: hidden;
  padding: 1px 4px;
  border-radius: 3px;
  background: rgba(0,0,0,0.62);
  color: #fff;
  font-size: 8px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.video-history-badge {
  position: absolute;
  right: 4px;
  top: 4px;
  padding: 1px 5px;
  border-radius: 999px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 9px;
  font-weight: 700;
}
.video-history-del {
  position: absolute;
  right: 3px;
  top: 3px;
  width: 16px;
  height: 16px;
  display: none;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 50%;
  background: rgba(0,0,0,0.62);
  color: #fff;
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
}
.video-history-item:hover .video-history-del { display: flex; }
.video-task-player {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-bottom: 1px solid var(--border);
  background: var(--surface-raised);
}
.video-player-head {
  min-height: 44px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 6px 12px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--surface-outline);
}
.video-player-head-info {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}
.video-player-title { color: var(--text-0); font-size: 13px; font-weight: 700; white-space: nowrap; }
.video-player-sub { color: var(--text-3); font-size: 11px; white-space: nowrap; }
.video-player-stage {
  flex: none;
  aspect-ratio: 16 / 9;
  max-height: 300px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--media-surface);
}
.video-player-video {
  width: 100%;
  height: 100%;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  display: block;
}
/* 空态：保留 16:9 播放框，内容居中（图标 + 文案 + 生成按钮） */
.video-player-empty {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 6px;
  padding: 14px 16px;
  color: var(--text-3);
}
.video-player-empty-copy { display: flex; flex-direction: column; align-items: center; }
.video-player-empty-title { color: var(--text-1); font-size: 12.5px; font-weight: 700; }
.video-player-empty-desc { margin-top: 2px; font-size: 11px; line-height: 1.5; }
.video-player-empty-action { flex-shrink: 0; margin-top: 4px; }
.video-task-list {
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  border: 0;
  border-radius: 0;
  background: var(--surface-raised);
}
.video-task-head {
  min-height: 48px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 12px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--surface-outline);
}
.video-task-title {
  font-size: 13px;
  line-height: 1.2;
  font-weight: 850;
  color: var(--text-0);
}
.video-task-meta {
  margin-top: 3px;
  font-size: 11px;
  line-height: 1.35;
  color: var(--text-3);
}
.video-task-metrics {
  margin-left: auto;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  flex-wrap: wrap;
}
.video-task-metric,
.video-task-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 22px;
  padding: 0 8px;
  border: 1px solid var(--surface-outline);
  border-radius: 999px;
  background: var(--overlay-track);
  color: var(--text-2);
  font-size: 11px;
  font-weight: 750;
  white-space: nowrap;
}
.video-task-metric.is-done,
.video-task-status.is-done {
  color: var(--success);
  border-color: var(--success-bg);
  background: var(--success-bg);
}
.video-task-metric.is-failed,
.video-task-status.is-failed,
.video-task-status.is-blocked {
  color: var(--warning);
  border-color: var(--warning-bg);
  background: var(--warning-bg);
}
.video-task-table {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
/* 统计徽章兼作筛选器 */
button.video-task-metric { cursor: pointer; font-family: inherit; transition: box-shadow 0.15s; }
button.video-task-metric:hover { box-shadow: 0 0 0 2px var(--sel-glow); }
.video-retry-failed { color: var(--warning); border-color: var(--warning-bg); }
.video-task-row.is-selected { background: var(--sel-bg); box-shadow: inset 0 0 0 1.5px var(--sel); }
.video-task-check {
  position: absolute;
  top: 5px;
  right: 5px;
  z-index: 2;
  background: rgba(0,0,0,0.45);
  border-color: rgba(255,255,255,0.55);
}
/* footer 预估/已用耗时行：与生效配置小结同款式 */
.video-eta-line {
  padding: 3px 8px;
  border-radius: var(--radius);
  background: var(--overlay-track);
  color: var(--text-2);
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1.4;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 生成参数：强调卡片，时长是当前分镜生成的核心参数 */
.video-params-card {
  padding: 7px 10px;
  border: 1px solid var(--accent-glow);
  border-radius: var(--radius-lg);
  background: var(--accent-bg);
}
/* 审核失败引导 */
.video-task-error-hint {
  margin-top: 3px;
  color: var(--accent-text);
  font-weight: 600;
}
.video-task-row {
  display: grid;
  grid-template-columns: 56px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-top: 1px solid var(--surface-outline);
  transition: background 0.16s var(--ease-out), border-color 0.16s var(--ease-out);
  cursor: pointer;
}
.video-task-row:first-child {
  border-top: 0;
}
.video-task-row.is-failed {
  background: var(--error-bg);
}
.video-task-row:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.video-task-preview {
  position: relative;
  width: 56px;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  border: 1px solid var(--surface-outline);
  border-radius: var(--radius-sm);
  background: var(--bg-2);
}
.video-task-preview video,
.video-task-preview img {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
}
.video-task-empty {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
}
/* 缩略图上的进行中进度环：旧视频/空态两种卡片都叠加 */
.video-task-ring {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.38);
}
.video-task-index {
  position: absolute;
  left: 3px;
  top: 3px;
  padding: 0 4px;
  border-radius: 3px;
  background: rgba(0,0,0,0.56);
  color: #fff;
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 800;
}
.video-task-main {
  min-width: 0;
}
.video-task-line {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}
.video-task-name {
  min-width: 0;
  font-size: 12px;
  line-height: 1.35;
  color: var(--text-0);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.video-task-meta-line {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 2px;
  font-size: 10.5px;
  color: var(--text-3);
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
}
.video-task-loc {
  color: var(--text-2);
}
.video-task-sep { color: var(--text-3); opacity: 0.5; }
.video-task-error {
  margin-top: 5px;
  font-size: 11px;
  line-height: 1.45;
  color: var(--error);
}
.video-task-error-hint {
  margin-top: 3px;
  color: var(--accent-text, var(--accent));
  font-weight: 600;
}
.video-task-status {
  justify-self: end;
  align-self: center;
}
/* 行内紧凑状态（窄列表用）：小圆点 + 文字 */
.video-task-state {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3);
  white-space: nowrap;
}
.video-task-state.is-done { color: var(--success); }
.video-task-state.is-failed { color: var(--warning); }
/* 融合状态（#42）：与视频状态并列显示，二者含义不同不能混用一个标记 */
.video-task-fusion {
  margin-top: 2px;
  font-size: 11px;
  color: var(--text-3);
  white-space: nowrap;
}
.video-task-fusion.is-unchanged { color: var(--tag-success-text); }
.video-task-fusion.is-missing,
.video-task-fusion.is-changed { color: var(--accent-text); }
.video-task-fusion.is-unknown,
.video-task-fusion.is-skipped { color: var(--tag-warning-text); }
.video-task-fusion.is-blocked { color: var(--action-danger); }
/* 主播放器的原片 / 成片页签 */
.video-source-tabs {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border-radius: 999px;
  background: var(--surface-muted);
}
.video-source-tab {
  border: none;
  background: none;
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3);
  cursor: pointer;
}
.video-source-tab:disabled { opacity: 0.5; cursor: not-allowed; }
.video-fusion-warn {
  padding: 5px 12px;
  font-size: 11px;
  color: var(--tag-warning-text);
  background: var(--surface-muted);
  border-bottom: 1px solid var(--border);
}
/* 右栏分区折叠头 */
.video-section-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: none;
  background: none;
  padding: 0;
  cursor: pointer;
  color: var(--text-1);
}
.video-section-caret { transition: transform 0.15s; color: var(--text-3); }
.video-section-caret.open { transform: rotate(90deg); }
.video-footer-bar { display: flex; align-items: center; gap: 6px; }
.video-footer-summary {
  font-size: 11px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.video-inspector-footer.is-collapsed { gap: 6px; }
.video-task-action {
  justify-self: end;
  align-self: center;
  min-width: 0;
  width: 24px;
  height: 24px;
  padding: 0;
}
.video-task-inspector {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--border);
  background: var(--surface-muted);
}
.video-main-col .video-task-player,
.video-main-col .video-player-history {
  flex: none;
}
.video-inspector-body { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 16px; padding: 16px 18px 18px; }
/* 时长参数 + 生成操作常驻底部：不随检查器滚动 */
.video-inspector-footer {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 9px 14px 11px;
  border-top: 1px solid var(--border);
  background: var(--surface-muted);
}
.video-inspector-section { display: flex; flex-direction: column; gap: 7px; }
/* 中列素材卡：中列比旧检查器宽，卡片放宽到 160–240px */
.video-inspector-section :deep(.target-assets) {
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
}
.video-inspector-section :deep(.target-asset) { max-width: 240px; }
.video-inspector-label { color: var(--text-0); font-size: 12px; font-weight: 700; }
.video-inspector-label-hero {
  color: var(--accent);
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.video-inspector-label-hero::before {
  content: '';
  width: 3px;
  height: 13px;
  border-radius: 2px;
  background: var(--accent);
}
.video-inspector-prompt-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
/* 开场转场区（承接镜头，#11） */
.transition-section { padding-bottom: 10px; border-bottom: 1px solid var(--line-1); }
.transition-section :deep(.video-inspector-prompt) { min-height: 88px; }
.transition-summary { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 12px; color: var(--text-2); }
.transition-verdict { color: var(--text-1); font-weight: 600; }
.transition-manual { color: var(--text-3); }
.transition-stale { font-size: 12px; color: var(--warning, #c58b1b); }
.transition-duration { font-size: 12px; color: var(--text-3); }
.transition-send { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--text-2); cursor: pointer; }
/* MentionTextarea 内部元素需 :deep 穿透（scoped 样式默认到不了子组件内部） */
:deep(.video-inspector-prompt) {
  min-height: 176px;
  font-size: 13px;
  line-height: 1.6;
}
.video-inspector-action { width: 100%; min-height: 32px; height: 32px; padding: 0 12px; font-size: 12.5px; }
.video-param-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 12px; white-space: nowrap; }
.video-param-name { color: var(--text-1); font-weight: 600; flex-shrink: 0; }
.video-param-control { display: inline-flex; align-items: center; gap: 6px; }
.video-param-unit { font-size: 11px; color: var(--text-2); }
.video-task-unconfirmed {
  padding: 0 5px;
  border: 1px solid var(--surface-outline);
  border-radius: 999px;
  background: var(--warning-bg);
  color: var(--tag-warning-text);
  font-size: 9.5px;
  line-height: 15px;
}
/* 关键帧门槛：本集分镜未全部确认时批量视频不可用 */
.video-keyframe-gate {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  padding: 8px 10px;
  border: 1px solid var(--surface-outline);
  border-radius: var(--radius);
  background: var(--warning-bg);
  color: var(--tag-warning-text);
  font-size: 11px;
}
.video-keyframe-state { font-size: 10px; padding: 0 6px; border-radius: 999px; }
.video-keyframe-state.is-confirmed { background: var(--success-bg); color: var(--tag-success-text); }
.video-keyframe-state.is-unconfirmed { background: var(--warning-bg); color: var(--tag-warning-text); }
.video-keyframe-thumbs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
.video-keyframe-thumb {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 0;
  border: 1px solid var(--surface-outline);
  border-radius: var(--radius-sm);
  background: var(--bg-2);
  overflow: hidden;
  color: var(--text-3);
  cursor: zoom-in;
}
.video-keyframe-thumb:disabled { cursor: default; }
.video-keyframe-thumb img { width: 100%; aspect-ratio: 16 / 9; object-fit: cover; display: block; }
.video-keyframe-thumb-empty { display: flex; align-items: center; justify-content: center; aspect-ratio: 16 / 9; font-size: 10px; }
.video-keyframe-thumb small { padding: 0 4px 3px; font-size: 10px; color: var(--text-2); }
.video-keyframe-hint { font-size: 10.5px; color: var(--tag-warning-text); line-height: 1.5; }
.video-batch-banner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  padding: 8px 10px;
  border: 1px solid var(--surface-outline);
  border-radius: var(--radius);
  background: var(--surface-2);
  font-size: 11px;
}
.video-batch-state { font-weight: 700; }
.video-batch-sep { color: var(--text-3); }
.video-batch-issue { color: var(--text-2); }
.video-batch-issues { flex-basis: 100%; display: flex; flex-direction: column; gap: 2px; color: var(--text-3); font-size: 9.5px; line-height: 1.4; }
.video-duration-input { width: 56px; height: 24px; padding: 2px 6px; font-size: 12px; font-weight: 700; font-family: var(--font-mono); text-align: center; }
.merge-card-pending.is-failed { color: var(--error); background: var(--error-bg); }
.studio-topbar .btn {
  height: 26px;
  padding: 0 9px;
  font-size: 10.5px;
  white-space: nowrap;
}
.pipe-section.is-done .pipe-section-state {
  background: var(--success-bg); color: var(--success);
  border: 1px solid var(--success-bg);
}
.pipe-item.active {
  background: var(--sel-bg);
  color: var(--sel-text);
  border-color: transparent;
  box-shadow: none;
}
/* ChatFire 签名：激活步骤左侧 3px 品牌色圆角指示条 */
.pipe-item.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 9px;
  bottom: 9px;
  width: 3px;
  border-radius: 999px;
  background: var(--accent);
}
.pipe-item.done { color: var(--text-2); }
.pipe-item.active .pipe-icon { background: var(--sel); border-color: var(--sel); color: var(--surface-raised); }
.pipe-item.done .pipe-icon { background: var(--success-bg); border-color: var(--success-bg); color: var(--success); }
.pipe-item.active.done .pipe-icon { background: var(--sel); border-color: var(--sel); color: var(--surface-raised); }
.pipe-item.active.done .icon-done { background: var(--sel) !important; border-color: var(--sel) !important; color: var(--surface-raised) !important; }
.sidebar-progress-seg.done { background: var(--success); }
.sidebar-progress-seg.current { background: var(--accent-bg); }
/* 跑马灯流动光：当前段内的渐变高光持续滑动 */
.sidebar-progress-seg.current .sidebar-progress-seg-fill {
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg,
    var(--accent) 0%,
    color-mix(in srgb, var(--accent) 30%, #fff 70%) 50%,
    var(--accent) 100%);
  background-size: 220% 100%;
  animation: seg-marquee 1.5s linear infinite;
}
.sidebar-progress-seg:not(.current) .sidebar-progress-seg-fill { display: none; }
.sidebar-progress-labels span.done { color: var(--success); }
.sidebar-progress-labels span.on {
  color: var(--accent-text);
  font-weight: 700;
}
.stage-subnav-item.active {
  background: var(--seg-active-bg);
  color: var(--text-0);
  box-shadow: 0 1px 4px rgba(0,0,0,0.12);
}
.stage-subnav-item.done {
  color: var(--text-1);
}
.stage-subnav-item.active.done {
  color: var(--text-0);
}
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
.prod-tab.active { background: var(--accent-bg); color: var(--accent-text); font-weight: 650; border-color: var(--accent-glow); box-shadow: none; }
.prod-tab.active .prod-tab-badge { background: var(--accent-bg); color: var(--accent-text); }
/* Production content */
.prod-content { flex: 1; overflow-y: auto; padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 10px; }
.prod-section-bar { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.shot-check.on { background: var(--accent); border-color: var(--accent); }
.afp-text.dim { color: var(--text-3); }
.asset-cover-badge.is-pending {
  box-shadow: var(--shadow-xs), inset 0 0 0 1px var(--accent);
  color: var(--accent-text);
}
.frame-row.active {
  background: var(--bg-0);
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-glow);
}
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--bg-3); flex-shrink: 0; }
.dot.ok { background: var(--success); }
.dot.pending {
  background: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-glow);
}
.video-history-item.current {
  border-color: var(--accent);
}
.video-task-metric.is-pending,
.video-task-status.is-pending,
.video-task-status.is-ready {
  color: var(--accent-text);
  border-color: var(--accent-glow);
  background: var(--accent-bg);
}
button.video-task-metric.on { box-shadow: 0 0 0 2px var(--accent); }
/* 批量视频：选择模式 */
.btn.is-on { border-color: var(--accent); color: var(--accent-text); background: var(--accent-bg); }
.video-task-check.on { background: var(--accent); border-color: var(--accent); }
.video-task-row:hover,
.video-task-row.is-pending {
  background: var(--bg-hover);
}
.video-task-row.active {
  background: var(--sel-bg);
  box-shadow: inset 0 0 0 1.5px var(--sel), 0 0 0 3px var(--sel-glow);
}
.video-task-state.is-pending { color: var(--accent-text); }
.video-source-tab.on { background: var(--surface-raised); color: var(--accent); }
.video-batch-banner.is-running { border-color: var(--accent-glow); }
.asset-batch-banner.is-running { border-color: var(--accent-glow); }
.prod-actions .btn { flex: 1; justify-content: center; }
.asset-detail-section-title .dim {
  font-size: 11px;
  font-weight: 560;
  letter-spacing: 0;
  text-align: right;
}
.asset-version-card.current { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-glow); }
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
