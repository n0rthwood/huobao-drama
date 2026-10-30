<template>
  <div class="prod-content kf-step">
    <div class="kf-bar">
      <span class="dim" style="font-size:12px">{{ t('episode.prod.keyframes') }}</span>
      <span class="tag mono">{{ t('episode.kf.confirmedCount', { done: confirmedCount, total: storyboards.length }) }}</span>
      <div class="ml-auto flex gap-1">
        <button class="btn btn-sm" :disabled="agentBusy" @click="emit('break')">
          <Loader2 v-if="breaking" :size="11" class="animate-spin" />
          <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
          {{ storyboards.length ? t('episode.sb.rebreak') : t('episode.sb.startBreak') }}
        </button>
        <button class="btn btn-sm" :disabled="promptBatch.running || !storyboards.length" @click="batchPrompts">
          <Loader2 v-if="promptBatch.running" :size="11" class="animate-spin" />
          <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
          {{ promptBatch.running
            ? t('episode.kf.promptProgress', { done: promptBatch.completed, total: promptBatch.total })
            : (selectMode && selectedIds.length ? t('episode.kf.promptSelected', { n: selectedIds.length }) : t('episode.kf.batchPrompts')) }}
        </button>
        <button class="btn btn-sm" :class="{ 'is-on': selectMode }" :disabled="!storyboards.length" @click="toggleSelectMode">
          {{ selectMode ? t('episode.vid.selectDone', { n: selectedIds.length }) : t('episode.vid.select') }}
        </button>
        <button
          class="btn btn-sm"
          :disabled="!storyboards.length || batchRunning"
          :title="batchRunning ? t('episode.kf.batchAlreadyRunning') : undefined"
          @click="openBatchConfirm"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
          {{ selectMode && selectedIds.length ? t('episode.kf.batchGenerateSelected', { n: selectedIds.length }) : t('episode.kf.batchGenerate') }}
        </button>
      </div>
    </div>

    <div v-if="batchVisible" :class="['kf-batch-banner', { 'is-running': batchRunning }]">
      <div class="kf-batch-line">
        <span class="kf-batch-state">{{ t('episode.kf.batchBannerTitle') }} · {{ batchStatusLabel }}</span>
        <span class="kf-batch-sep">·</span>
        <span>{{ t('episode.kf.batchProgress', { done: batchCounts.completed, total: batchItems.length }) }}</span>
        <template v-if="batchCounts.queued">
          <span class="kf-batch-sep">·</span>
          <span>{{ t('episode.kf.batchCountQueued', { n: batchCounts.queued }) }}</span>
        </template>
        <template v-if="batchCounts.running">
          <span class="kf-batch-sep">·</span>
          <span>{{ t('episode.kf.batchCountRunning', { n: batchCounts.running }) }}</span>
        </template>
        <template v-if="batchCounts.failed">
          <span class="kf-batch-sep">·</span>
          <span class="kf-batch-issue">{{ t('episode.kf.batchFailedCount', { n: batchCounts.failed }) }}</span>
        </template>
        <template v-if="batchCounts.cancelled">
          <span class="kf-batch-sep">·</span>
          <span class="kf-batch-issue">{{ t('episode.kf.batchCountCancelled', { n: batchCounts.cancelled }) }}</span>
        </template>
        <template v-if="batchCounts.skipped">
          <span class="kf-batch-sep">·</span>
          <span class="kf-batch-issue">{{ t('episode.kf.batchSkippedCount', { n: batchCounts.skipped }) }}</span>
        </template>
        <template v-if="batchEtaText">
          <span class="kf-batch-sep">·</span>
          <span class="kf-batch-eta">{{ batchEtaText }}</span>
        </template>
        <div class="ml-auto flex gap-1">
          <button v-if="batchRetryableCount" class="btn btn-sm" :disabled="batchRetrying" @click="retryFailedBatch">
            <Loader2 v-if="batchRetrying" :size="11" class="animate-spin" />
            {{ t('episode.kf.batchRetryFailed') }}
          </button>
          <button v-if="batchRunning" class="btn btn-sm" :disabled="batchStopping" @click="cancelConfirm = true">{{ t('episode.kf.batchStop') }}</button>
        </div>
      </div>
      <div class="kf-batch-progress" role="progressbar" :aria-valuenow="batchPercent" aria-valuemin="0" aria-valuemax="100">
        <span class="kf-batch-progress-fill" :style="{ width: batchPercent + '%' }" />
        <span class="kf-batch-progress-text">{{ batchPercent }}%</span>
      </div>
      <div v-if="batchIssues.length" class="kf-batch-issues">
        <span v-for="item in batchIssues" :key="`${item.storyboard_id}-${item.slot}`" :title="item.error || ''">
          {{ t('episode.kf.batchIssueItem', {
            n: item.storyboard_number,
            slot: slotLabel(item.slot),
            state: item.state === 'failed' ? t('episode.kf.batchItemFailed') : (item.state === 'cancelled' ? t('episode.kf.batchItemCancelled') : t('episode.kf.batchItemSkipped')),
            msg: mapError(item.error) || t('episode.kf.batchNoReason'),
          }) }}
        </span>
      </div>
    </div>

    <div v-if="!storyboards.length" class="kf-empty">
      <div class="kf-empty-visual">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><rect x="2" y="2" width="20" height="20" rx="2.5"/><line x1="7" y1="8" x2="7" y2="16"/><line x1="10" y1="8" x2="10" y2="16"/><line x1="13" y1="8" x2="13" y2="16"/></svg>
      </div>
      <div class="kf-empty-title">{{ t('episode.sb.emptyTitle') }}</div>
      <div class="kf-empty-desc">{{ t('episode.sb.emptyDesc') }}</div>
      <button class="btn btn-primary" :disabled="agentBusy" @click="emit('break')">
        <Loader2 v-if="breaking" :size="13" class="animate-spin" />
        <svg v-else width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
        {{ t('episode.sb.startBreak') }}
      </button>
    </div>

    <div v-else class="kf-workbench">
      <section class="kf-list">
        <div class="kf-list-head">
          <div class="kf-list-title">{{ t('episode.kf.listTitle') }}</div>
          <div class="kf-list-meta">{{ t('episode.kf.listMeta', { n: storyboards.length }) }}</div>
        </div>
        <div v-if="selectMode" class="kf-quick-actions">
          <button class="kf-quick-btn" @click="toggleSelectAll">{{ t('episode.sb.selectAll') }}</button>
          <button class="kf-quick-btn" @click="selectUnconfirmed">{{ t('episode.kf.selectUnconfirmed') }}</button>
          <button class="kf-quick-btn" @click="selectedIds = []">{{ t('episode.sb.clear') }}</button>
        </div>
        <div class="kf-list-body">
          <div
            v-for="(sb, index) in storyboards"
            :key="sb.id"
            :class="['kf-row', { active: !selectMode && selectedId === sb.id, 'is-selected': selectMode && selectedIds.includes(sb.id) }]"
            role="button"
            tabindex="0"
            @click="onRowClick(sb)"
            @keydown.enter.prevent="onRowClick(sb)"
            @keydown.space.prevent="onRowClick(sb)"
          >
            <div class="kf-row-head">
              <span v-if="selectMode" class="kf-check" :class="{ on: selectedIds.includes(sb.id) }">
                <svg v-if="selectedIds.includes(sb.id)" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              </span>
              <span class="kf-row-index">#{{ String(index + 1).padStart(2, '0') }}</span>
              <span class="kf-row-title truncate">{{ sb.description || t('episode.sb.noDescription') }}</span>
            </div>
            <div class="kf-row-thumbs">
              <div
                v-for="slot in SLOT_KEYS"
                :key="slot"
                :class="['kf-thumb', { empty: !slotImage(sb, slot), pending: isSlotPending(sb, slot) }]"
                :title="slotLabel(slot)"
              >
                <img v-if="slotImage(sb, slot)" :src="thumbOf(imgSrc(slotImage(sb, slot)))" loading="lazy" @error="onThumbError($event, slotImage(sb, slot))" />
                <span v-else-if="!slotRing(sb, slot)" class="kf-thumb-empty">{{ slotShort(slot) }}</span>
                <!-- 重生成时旧图还在，进度环叠在图上 -->
                <ProgressRing v-if="slotRing(sb, slot)" v-bind="slotRing(sb, slot)" compact :size="22" class="kf-thumb-ring" />
                <span class="kf-thumb-tag">{{ slotShort(slot) }}</span>
              </div>
            </div>
            <div class="kf-row-meta">
              <span :class="['kf-state', 'is-' + shotState(sb)]">{{ shotStateLabel(sb) }}</span>
              <span v-if="kf(sb).inheritsFirst" class="kf-inherit-tag" :title="t('episode.kf.inheritTip')">{{ t('episode.kf.inherit') }}</span>
              <span
                v-if="issuesOf(sb).length"
                :class="['kf-ref-issue-count', issuesOf(sb).some(i => i.severity === 'block') ? 'is-block' : 'is-warn']"
                :title="issuesOf(sb).map(i => i.message).join(t('common.listJoin'))"
              >{{ t('episode.ref.issueCount', { n: issuesOf(sb).length }) }}</span>
              <span class="kf-row-dur">{{ sb.duration || 10 }}s</span>
            </div>
          </div>
        </div>
      </section>

      <div v-if="selected" class="kf-editor">
        <div class="kf-editor-head">
          <div class="kf-editor-title">{{ t('episode.kf.editorTitle', { n: String(selectedIndex + 1).padStart(2, '0') }) }}</div>
          <span :class="['kf-state', 'is-' + shotState(selected)]">{{ shotStateLabel(selected) }}</span>
        </div>

        <div class="kf-editor-body">
          <section class="kf-section">
            <span class="kf-section-label">{{ t('episode.sb.descSection') }}</span>
            <label class="kf-field">
              <span class="kf-field-label">
                {{ t('episode.sb.descLabel') }} <span class="dim">({{ t('episode.sb.descHint') }})</span>
                <FieldSaveStatus class="kf-field-save" v-bind="fieldSaveOf('description')" />
              </span>
              <textarea
                :value="selected.description || ''"
                class="textarea"
                rows="6"
                :placeholder="t('episode.sb.descPlaceholder')"
                @input="emit('field-dirty', selected, 'description', $event.target.value)"
                @blur="emit('update-field', selected, 'description', $event.target.value)"
              />
            </label>
            <label class="kf-field">
              <span class="kf-field-label">
                {{ t('episode.sb.atmosphere') }}
                <FieldSaveStatus class="kf-field-save" v-bind="fieldSaveOf('atmosphere')" />
              </span>
              <textarea
                :value="selected.atmosphere || ''"
                class="textarea"
                rows="2"
                :placeholder="t('episode.sb.atmospherePlaceholder')"
                @input="emit('field-dirty', selected, 'atmosphere', $event.target.value)"
                @blur="emit('update-field', selected, 'atmosphere', $event.target.value)"
              />
            </label>
          </section>

          <section class="kf-section">
            <div class="kf-section-head">
              <span class="kf-section-label">{{ t('episode.kf.boundary') }}</span>
              <span class="dim" style="font-size:11px">{{ previousOf(selected) ? t('episode.kf.boundaryHint') : t('episode.kf.boundaryFirstShot') }}</span>
            </div>
            <div class="kf-boundary">
              <button
                type="button"
                class="btn btn-sm"
                :class="{ 'is-on': boundaryOf(selected) === 'continue' }"
                :disabled="!previousOf(selected)"
                @click="setBoundary(selected, 'continue')"
              >{{ t('episode.kf.boundaryContinue') }}</button>
              <button
                type="button"
                class="btn btn-sm"
                :class="{ 'is-on': boundaryOf(selected) === 'cut' }"
                :disabled="!previousOf(selected)"
                @click="setBoundary(selected, 'cut')"
              >{{ t('episode.kf.boundaryCut') }}</button>
            </div>
          </section>

          <section class="kf-section">
            <div class="kf-section-head">
              <span class="kf-section-label">{{ t('episode.ref.poolTitle') }}</span>
              <span class="tag mono">{{ t('episode.ref.boundCount', { bound: assets.filter(a => a.bound).length, total: assets.length }) }}</span>
              <span v-if="refIssues.length" :class="['kf-ref-issue-count', hasBlockingIssue ? 'is-block' : 'is-warn']">
                {{ t('episode.ref.issueCount', { n: refIssues.length }) }}
              </span>
            </div>
            <p class="kf-ref-pool-hint">{{ t('episode.ref.poolCopy') }}</p>
            <RefIssueList :issues="refIssues" />
            <div class="kf-ref-list">
              <template v-for="g in refKinds" :key="g.kind">
                <div v-if="assets.filter(a => a.kind === g.kind).length" class="kf-ref-group">
                  <div class="kf-ref-group-label">{{ g.label }}</div>
                  <div class="kf-pool-grid">
                    <div
                      v-for="asset in assets.filter(a => a.kind === g.kind)"
                      :key="asset.key"
                      :class="['kf-pool-card', { bound: asset.bound }]"
                      role="button"
                      tabindex="0"
                      :title="t('episode.ref.cardOpenDetail')"
                      @click="emit('open-asset', asset)"
                      @keydown.enter.prevent="emit('open-asset', asset)"
                      @keydown.space.prevent="emit('open-asset', asset)"
                    >
                      <div class="kf-pool-media">
                        <img
                          v-if="asset.ready"
                          :src="thumbOf(imgSrc(asset.imageUrl))"
                          loading="lazy"
                          :alt="asset.name"
                          @error="onThumbError($event, asset.imageUrl)"
                        />
                        <span v-else class="kf-pool-media-empty">
                          {{ asset.kind === 'scene' ? t('episode.ref.shortScene') : asset.kind === 'prop' ? t('episode.ref.shortProp') : t('episode.ref.shortChar') }}
                        </span>
                        <button
                          type="button"
                          class="kf-pool-check"
                          :aria-pressed="asset.bound ? 'true' : 'false'"
                          :aria-label="asset.bound ? t('episode.ref.clickRemove') : t('episode.ref.clickAdd')"
                          :title="asset.bound ? t('episode.ref.clickRemove') : t('episode.ref.clickAdd')"
                          @click.stop="emit('toggle-bind', selected, asset)"
                        >
                          <svg v-if="asset.bound" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                        </button>
                      </div>
                      <div class="kf-pool-body">
                        <span class="kf-pool-name" :title="asset.name">{{ asset.name }}</span>
                        <span class="kf-pool-meta">{{ asset.typeLabel }} · {{ asset.meta }}</span>
                        <span class="kf-pool-foot">
                          <span :class="['kf-ref-state', asset.bound && asset.ready ? 'is-ready' : '']">
                            {{ asset.bound ? (asset.ready ? t('episode.ref.usable') : t('episode.ref.notReady')) : t('episode.ref.unbound') }}
                          </span>
                          <button v-if="asset.bound && !asset.ready" type="button" class="kf-ref-goto" @click.stop="emit('goto-assets')">{{ t('episode.ref.gotoGenerate') }}</button>
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </template>
              <div v-if="!assets.length" class="kf-ref-empty">{{ t('episode.ref.empty') }}</div>
            </div>
          </section>

          <section v-for="slot in SLOT_KEYS" :key="slot" class="kf-section kf-slot-card">
            <div class="kf-section-head">
              <span class="kf-section-label">{{ slotLabel(slot) }}</span>
              <span v-if="slot === 'first' && kf(selected).inheritsFirst" class="kf-inherit-tag">{{ t('episode.kf.inheritedFirst', { n: shotNumberOf(previousOf(selected)) }) }}</span>
              <span v-if="slot === 'mid' && !slotPrompt(selected, 'mid').trim()" class="dim" style="font-size:11px">{{ t('episode.kf.midOptional') }}</span>
              <span class="ml-auto" />
              <button
                type="button"
                class="btn btn-sm"
                :disabled="isSlotPending(selected, slot) || batchRunning || slotBlocked(selected, slot)"
                :title="slotBlocked(selected, slot) ? slotBlockReason(selected, slot) : undefined"
                @click="generateSlot(selected, slot)"
              >
                {{ isSlotPending(selected, slot)
                  ? t('episode.kf.generating')
                  : (slotBlocked(selected, slot)
                    ? t('episode.ref.blockedGenerate')
                    : (slot === 'first' && kf(selected).inheritsFirst ? t('episode.kf.generateOwnFirst') : (slotImage(selected, slot) ? t('episode.kf.regenerate') : t('episode.kf.generate')))) }}
              </button>
            </div>

            <div class="kf-slot-body">
              <div class="kf-slot-media">
                <button
                  type="button"
                  :class="['kf-preview', { empty: !slotImage(selected, slot) }]"
                  :style="{ aspectRatio: previewAspect }"
                  :disabled="!slotImage(selected, slot)"
                  @click="emit('preview', imgSrc(slotImage(selected, slot)), `${t('episode.kf.editorTitle', { n: String(selectedIndex + 1).padStart(2, '0') })} · ${slotLabel(slot)}`)"
                >
                  <img v-if="slotImage(selected, slot)" :src="thumbOf(imgSrc(slotImage(selected, slot)))" loading="lazy" @error="onThumbError($event, slotImage(selected, slot))" />
                  <span v-else class="kf-preview-empty">
                    <template v-if="isSlotPending(selected, slot)">{{ t('episode.kf.generating') }}</template>
                    <template v-else>{{ t('episode.kf.slotEmpty') }}</template>
                  </span>
                </button>
                <MediaTime class="kf-preview-time" :at="slotTimeOf(selected, slot)" />

                <div class="kf-slot-row kf-slot-version-row">
                  <span class="kf-slot-row-label">{{ t('episode.kf.version') }}</span>
                  <select
                    v-if="versions[slot] && versions[slot].length"
                    class="input kf-version-select"
                    :value="slotOwnImage(selected, slot) || ''"
                    :aria-label="t('episode.kf.version')"
                    @change="selectVersion(selected, slot, $event.target.value)"
                  >
                    <option v-if="!slotOwnImage(selected, slot)" value="">{{ t('episode.kf.versionUnset') }}</option>
                    <option v-for="v in versions[slot]" :key="v.id ?? v.image" :value="v.image">{{ versionLabel(v) }}</option>
                  </select>
                  <span v-else class="dim" style="font-size:11px">{{ t('episode.kf.noVersions') }}</span>
                </div>
                <button
                  v-if="slot === 'first' && previousOf(selected) && (selected.continuity_boundary || selected.continuityBoundary) === 'continue' && !kf(selected).inheritsFirst"
                  type="button"
                  class="btn btn-sm kf-slot-inherit-btn"
                  @click="useInherit(selected)"
                >{{ t('episode.kf.backToInherit') }}</button>
              </div>

              <div class="kf-slot-main">
                <div v-if="slotRing(selected, slot)" class="kf-slot-task">
                  <ProgressRing
                    v-bind="slotRing(selected, slot)"
                    :size="42"
                    :cancellable="slotCancellable(selected, slot)"
                    retryable
                    @cancel="cancelSlot(selected, slot)"
                    @retry="generateSlot(selected, slot)"
                  />
                </div>
                <label class="kf-field kf-prompt-field">
                  <span class="kf-field-label">
                    {{ t('episode.kf.promptLabel', { slot: slotLabel(slot) }) }}
                    <FieldSaveStatus class="kf-field-save" v-bind="fieldSaveOf(SLOT_PROMPT_FIELD[slot])" />
                  </span>
                  <MentionTextarea
                    :model-value="slotPrompt(selected, slot)"
                    :options="mentions"
                    :rows="4"
                    autogrow
                    input-class="textarea kf-prompt"
                    :placeholder="t('episode.kf.promptPlaceholder')"
                    @update:model-value="v => emit('field-dirty', selected, SLOT_PROMPT_FIELD[slot], v)"
                    @commit="v => emit('update-field', selected, SLOT_PROMPT_FIELD[slot], v)"
                  />
                </label>
                <RefIssueList :issues="slotIssues(selected, slot)" />

                <div v-if="slot === 'mid'" class="kf-slot-row">
                  <span class="kf-slot-row-label">{{ t('episode.kf.midTime') }}</span>
                  <input
                    :value="midTime(selected) ?? ''"
                    type="number"
                    step="0.1"
                    min="0.5"
                    class="input kf-mid-time"
                    :placeholder="t('episode.kf.midTimeAuto')"
                    @input="emit('field-dirty', selected, 'mid_frame_time', $event.target.value === '' ? null : Number($event.target.value))"
                    @change="onMidTimeChange(selected, $event)"
                  />
                  <span class="kf-slot-row-unit">{{ t('episode.kf.midTimeUnit') }}</span>
                  <span class="dim" style="font-size:11px">{{ t('episode.kf.midTimeRange', { max: midTimeMax(selected) }) }}</span>
                  <FieldSaveStatus class="ml-auto" v-bind="fieldSaveOf('mid_frame_time')" />
                </div>
              </div>
            </div>

            <div class="kf-slot-refs">
              <div class="kf-slot-refs-head">
                <span class="kf-slot-row-label">{{ t('episode.ref.targetTitle') }}</span>
                <span class="tag mono">{{ targetAssets(selected, slot).length }}</span>
              </div>
              <TargetAssetList
                :items="targetAssets(selected, slot)"
                :versions-for="assetVersionsFor"
                :busy="targetVersionBusy"
                @preview="(src, title) => emit('preview', src, title)"
                @select-version="(item, image) => onSelectTargetVersion(selected, slot, item, image)"
              />
            </div>
          </section>
        </div>

        <div class="kf-editor-foot">
          <span class="kf-foot-hint">{{ kf(selected).ready ? t('episode.kf.readyHint') : t('episode.kf.notReadyHint', { slots: missingSlotLabels(selected) }) }}</span>
          <button
            class="btn btn-primary"
            :disabled="!kf(selected).ready && !kf(selected).confirmed"
            @click="toggleConfirm(selected)"
          >{{ kf(selected).confirmed ? t('episode.kf.unconfirm') : t('episode.kf.confirm') }}</button>
        </div>
      </div>
      <div v-else class="kf-editor kf-editor-empty">{{ t('episode.kf.selectShot') }}</div>
    </div>

    <div v-if="batchConfirm.open" class="overlay" @click.self="batchConfirm.open = false">
      <div class="dialog kf-batch-dialog">
        <header class="dialog-head">
          <h2 class="dialog-title">{{ t('episode.kf.batchTitle') }}</h2>
          <button class="btn btn-ghost btn-icon" @click="batchConfirm.open = false">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </header>
        <div class="dialog-body kf-batch-body">
          <div v-if="batchConfirm.loading" class="kf-batch-loading">{{ t('episode.kf.batchPreviewLoading') }}</div>
          <template v-else>
            <div class="kf-batch-row"><span>{{ t('episode.kf.batchCount') }}</span><strong>{{ t('episode.kf.batchCountValue', { n: checkedItems.length }) }}</strong></div>
            <div class="kf-batch-row">
              <span>{{ t('episode.kf.batchEta') }}</span>
              <strong>{{ batchEstimateText }}</strong>
            </div>
            <div v-if="batchEstimateNote" class="kf-batch-row kf-batch-row-note"><span /><span class="dim">{{ batchEstimateNote }}</span></div>
            <div class="kf-batch-row"><span>{{ t('episode.kf.batchModel') }}</span><strong>{{ imageModelLabel || t('episode.vid.defaultModel') }}</strong></div>
            <div class="kf-batch-actions">
              <span class="dim">{{ batchConfirm.scoped ? t('episode.kf.batchScopeSelected', { n: batchConfirm.ids.length }) : t('episode.kf.batchScopeAll') }}</span>
              <button type="button" class="kf-quick-btn ml-auto" @click="setAllChecked(true)">{{ t('episode.sb.selectAll') }}</button>
              <button type="button" class="kf-quick-btn" @click="setAllChecked(false)">{{ t('episode.sb.clear') }}</button>
            </div>
            <div class="kf-batch-list">
              <div v-for="group in previewGroups" :key="group.storyboard_id" class="kf-batch-group">
                <div class="kf-batch-group-head">#{{ String(group.storyboard_number).padStart(2, '0') }}</div>
                <label
                  v-for="item in group.items"
                  :key="item.slot"
                  :class="['kf-batch-item', 'is-' + item.status, { disabled: item.status === 'blocked' || item.status === 'skipped' }]"
                >
                  <input
                    type="checkbox"
                    :checked="item.checked"
                    :disabled="item.status === 'blocked' || item.status === 'skipped'"
                    @change="item.checked = $event.target.checked"
                  />
                  <span class="kf-batch-item-slot">{{ slotLabel(item.slot) }}</span>
                  <span class="kf-batch-item-status">{{ previewStatusLabel(item) }}</span>
                  <span v-if="item.reason" class="kf-batch-item-reason">{{ item.reason }}</span>
                  <span v-else-if="blockReasonOf(item)" class="kf-batch-item-reason">{{ blockReasonOf(item) }}</span>
                </label>
              </div>
              <div v-if="!previewGroups.length" class="kf-batch-empty">{{ t('episode.kf.batchNothing') }}</div>
            </div>
            <p class="kf-batch-note">{{ t('episode.kf.batchNote') }}</p>
          </template>
        </div>
        <footer class="dialog-foot">
          <button class="btn" @click="batchConfirm.open = false">{{ t('common.cancel') }}</button>
          <button class="btn btn-primary" :disabled="batchConfirm.loading || !checkedItems.length" @click="startBatch">{{ t('episode.kf.batchStart', { n: checkedItems.length }) }}</button>
        </footer>
      </div>
    </div>

    <ConfirmDialog
      :open="cancelConfirm"
      :title="t('episode.kf.batchStop')"
      :message="t('episode.kf.batchStopConfirm')"
      :confirm-text="t('episode.kf.batchStop')"
      :loading-text="t('episode.kf.batchStateStopping')"
      :loading="batchStopping"
      @cancel="cancelConfirm = false"
      @confirm="cancelBatch"
    />
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { toast } from 'vue-sonner'
import { useI18n } from 'vue-i18n'
import { Loader2 } from 'lucide-vue-next'
import { episodeAPI, storyboardAPI, taskAPI, imageQueueAPI } from '~/composables/useApi'
import { toastError, toastServerMessage, mapError } from '~/composables/useToast'
import MentionTextarea from '~/components/MentionTextarea.vue'
import ProgressRing from '~/components/ProgressRing.vue'
import ConfirmDialog from '~/components/ConfirmDialog.vue'
import FieldSaveStatus from '~/components/FieldSaveStatus.vue'
import RefIssueList from '~/components/RefIssueList.vue'
import MediaTime from '~/components/MediaTime.vue'
import TargetAssetList from '~/components/TargetAssetList.vue'
import { mediaTimeLabel, mediaTimeOfPath } from '~/utils/mediaTime'
import {
  useNowTicker,
  ringPropsFromTask,
  ringPropsFromBatchItem,
  isActiveTaskStatus,
  isActiveBatchItemState,
  formatSeconds,
} from '~/composables/useTaskProgress'
import { useTasks } from '~/composables/useTasks'

const { t } = useI18n()

const props = defineProps({
  episodeId: { type: Number, default: 0 },
  // 本集分镜（按分镜号升序），字段与 /episodes/:id/storyboards 返回一致
  storyboards: { type: Array, default: () => [] },
  // (sb) => 可绑定资产列表；由工作台提供，避免资产状态在两处各算一遍
  // Function 类型的 default 就是默认值本身（不会被当作工厂调用）
  bindableAssets: { type: Function, default: () => [] },
  // (sb, target) => 该目标（first|mid|last|video）实际发送的参考图（后端 target_assets）
  targetAssetsFor: { type: Function, default: () => [] },
  // (targetAsset) => 该资产的候选图版本列表
  assetVersionsFor: { type: Function, default: () => [] },
  // (sb, target, targetAsset, image|null) => Promise：目标级选版（null = 恢复默认）
  setTargetVersion: { type: Function, default: async () => {} },
  // (sb) => MentionTextarea 的 @引用候选
  mentionOptionsFor: { type: Function, default: () => [] },
  refKinds: { type: Array, default: () => [] },
  imageModel: { type: String, default: '' },
  imageConfigId: { type: Number, default: 0 },
  imageModelLabel: { type: String, default: '' },
  chatModel: { type: String, default: '' },
  chatConfigId: { type: Number, default: 0 },
  // 剧集画幅，用于向 /image-queue/estimate 询问该尺寸的实测单张耗时
  aspectRatio: { type: String, default: '16:9' },
  breaking: { type: Boolean, default: false },
  agentBusy: { type: Boolean, default: false },
  // (sb, field) => { status, at }；字段级保存状态由工作台（episode.vue）统一维护
  fieldSave: { type: Function, default: () => ({ status: 'idle', at: 0 }) },
})
const emit = defineEmits(['break', 'refresh', 'preview', 'goto-assets', 'toggle-bind', 'open-asset', 'update-field', 'field-dirty'])

// 槽位预览图按剧集画幅完整显示（CSS aspect-ratio 语法用 /）
const previewAspect = computed(() => String(props.aspectRatio || '16:9').replace(':', ' / ') || '16 / 9')

// ===== 目标级参考图（按槽位，只读；绑定由该槽位提示词的 @ 决定） =====
const targetVersionBusy = ref(false)
function targetAssets(sb, target) {
  const list = props.targetAssetsFor(sb, target)
  return Array.isArray(list) ? list : []
}
async function onSelectTargetVersion(sb, target, item, image) {
  if (targetVersionBusy.value) return
  targetVersionBusy.value = true
  try {
    await props.setTargetVersion(sb, target, item, image)
  } finally {
    targetVersionBusy.value = false
  }
}

const SLOT_KEYS = ['first', 'mid', 'last']
const SLOT_PROMPT_FIELD = { first: 'first_frame_prompt', mid: 'mid_frame_prompt', last: 'last_frame_prompt' }
// 关键帧出图尺寸：与后端 storyboard-keyframes.ts 的 KEYFRAME_SIZES 一致，
// 仅用于提交前向任务服务询问该分辨率的实测耗时
const KEYFRAME_SIZES = {
  '16:9': '1344x768',
  '9:16': '768x1344',
  '4:3': '1152x864',
  '3:4': '864x1152',
  '1:1': '1024x1024',
}

const now = useNowTicker()
const { latestKeyframeTask, registerTask, refreshTasks, onTaskFinished } = useTasks()

function slotLabel(slot) {
  if (slot === 'first') return t('episode.kf.slotFirst')
  if (slot === 'mid') return t('episode.kf.slotMid')
  if (slot === 'last') return t('episode.kf.slotLast')
  return ''
}
function slotShort(slot) {
  if (slot === 'first') return t('episode.kf.shortFirst')
  if (slot === 'mid') return t('episode.kf.shortMid')
  return t('episode.kf.shortLast')
}

function imgSrc(raw) {
  return mediaUrl(raw)
}
function onThumbError(e, raw) {
  const full = imgSrc(raw)
  if (full && e.target.src !== new URL(full, window.location.origin).href) e.target.src = full
}
// 关键帧版本带版本号（按创建时间从 1 编号，服务端给出）；资产版本没有版本号，只显示引擎/模型/时间
function versionLabel(version) {
  const no = Number(version?.version_no ?? version?.versionNo)
  const prefix = Number.isFinite(no) && no > 0 ? `${t('episode.kf.versionNo', { n: no })} · ` : ''
  const engine = version?.provider || t('episode.asset.unknownEngine')
  const model = version?.model ? ` · ${version.model}` : ''
  const time = mediaTimeLabel(version?.generated_at ?? version?.generatedAt, t, now.value)
  return `${prefix}${engine}${model}${time ? ` · ${time}` : ''}`
}

// ===== 参考图 ↔ 提示词一致性问题（后端 ref_issues，message 可直接展示） =====
function issuesOf(sb) {
  const list = sb?.ref_issues || sb?.refIssues
  return Array.isArray(list) ? list : []
}
/** 某槽位的问题：该槽位提示词字段上的问题 + 绑定级问题（fields 为空） */
function slotIssues(sb, slot) {
  const field = SLOT_PROMPT_FIELD[slot]
  return issuesOf(sb).filter(issue => {
    const fields = Array.isArray(issue?.fields) ? issue.fields : []
    return !fields.length || fields.includes(field)
  })
}
function slotBlocked(sb, slot) {
  return slotIssues(sb, slot).some(issue => issue.severity === 'block')
}
function slotBlockReason(sb, slot) {
  return slotIssues(sb, slot).filter(i => i.severity === 'block').map(i => i.message).join(t('common.listJoin'))
}

/** 字段保存状态：由工作台按（分镜, 字段）维护 */
function fieldSaveOf(field) {
  const info = selected.value ? props.fieldSave(selected.value, field) : null
  return { status: info?.status || 'idle', at: Number(info?.at || 0) }
}

// ===== 分镜关键帧状态：规则由后端计算，随分镜 JSON 的 keyframes 字段返回 =====
function kf(sb) {
  const k = sb?.keyframes || {}
  return {
    inheritsFirst: Boolean(k.inherits_first ?? k.inheritsFirst),
    first: k.first_image ?? k.firstImage ?? null,
    mid: k.mid_image ?? k.midImage ?? null,
    last: k.last_image ?? k.lastImage ?? null,
    midRequired: Boolean(k.mid_required ?? k.midRequired),
    ready: Boolean(k.ready),
    confirmed: Boolean(k.confirmed),
  }
}
function slotImage(sb, slot) {
  const k = kf(sb)
  return slot === 'first' ? k.first : slot === 'mid' ? k.mid : k.last
}
/** 该槽位生效关键帧的生成时间（unix 秒）；反查不到 → null，不显示 */
function slotTimeOf(sb, slot) {
  return mediaTimeOfPath(sb, slotImage(sb, slot))
}
// 槽位自有选定图（首帧承接时为空），版本下拉以此为当前值
function slotOwnImage(sb, slot) {
  if (slot === 'first') return sb?.first_frame_image ?? sb?.firstFrameImage ?? ''
  if (slot === 'mid') return sb?.mid_frame_image ?? sb?.midFrameImage ?? ''
  return sb?.last_frame_image ?? sb?.lastFrameImage ?? ''
}
function slotPrompt(sb, slot) {
  if (slot === 'first') return sb?.first_frame_prompt ?? sb?.firstFramePrompt ?? ''
  if (slot === 'mid') return sb?.mid_frame_prompt ?? sb?.midFramePrompt ?? ''
  return sb?.last_frame_prompt ?? sb?.lastFramePrompt ?? ''
}
function midTime(sb) {
  const v = sb?.mid_frame_time ?? sb?.midFrameTime
  return v === null || v === undefined || v === '' ? null : Number(v)
}
function midTimeMax(sb) {
  return Math.max(0.5, Number(sb?.duration || 10) - 0.5).toFixed(1)
}
function boundaryOf(sb) {
  return sb?.continuity_boundary ?? sb?.continuityBoundary ?? null
}
function shotNumberOf(sb) {
  const i = props.storyboards.findIndex(s => s.id === sb?.id)
  return i >= 0 ? i + 1 : 0
}
function previousOf(sb) {
  const i = props.storyboards.findIndex(s => s.id === sb?.id)
  return i > 0 ? props.storyboards[i - 1] : null
}
function shotState(sb) {
  const k = kf(sb)
  if (k.confirmed) return 'confirmed'
  return k.ready ? 'ready' : 'missing'
}
function shotStateLabel(sb) {
  const state = shotState(sb)
  if (state === 'confirmed') return t('episode.kf.stateConfirmed')
  return state === 'ready' ? t('episode.kf.stateReady') : t('episode.kf.stateMissing')
}
function missingSlotLabels(sb) {
  const k = kf(sb)
  const missing = []
  if (!k.first) missing.push(slotLabel('first'))
  if (k.midRequired && !k.mid) missing.push(slotLabel('mid'))
  if (!k.last) missing.push(slotLabel('last'))
  return missing.join(t('common.listJoin'))
}
const confirmedCount = computed(() => props.storyboards.filter(sb => kf(sb).confirmed).length)

// ===== 选中分镜 =====
const selectedId = ref(0)
const selected = computed(() => props.storyboards.find(sb => sb.id === selectedId.value) || null)
const selectedIndex = computed(() => props.storyboards.findIndex(sb => sb.id === selectedId.value))
const assets = computed(() => (selected.value ? props.bindableAssets(selected.value) : []))
const mentions = computed(() => (selected.value ? props.mentionOptionsFor(selected.value) : []))
const refIssues = computed(() => (selected.value ? issuesOf(selected.value) : []))
const hasBlockingIssue = computed(() => refIssues.value.some(issue => issue.severity === 'block'))

watch(() => props.storyboards, (list) => {
  if (!list.length) { selectedId.value = 0; return }
  if (!list.some(sb => sb.id === selectedId.value)) selectedId.value = list[0].id
}, { immediate: true, deep: false })

// ===== 关键帧版本：选中分镜的三个槽位各自列出历史生成（最新在前） =====
const versions = ref({ first: [], mid: [], last: [] })
async function loadVersions() {
  const sb = selected.value
  versions.value = { first: [], mid: [], last: [] }
  if (!sb?.id) return
  const id = sb.id
  for (const slot of SLOT_KEYS) {
    try {
      const rows = await storyboardAPI.keyframeVersions(id, slot)
      if (selected.value?.id !== id) return
      // 服务端已按最新在前返回，这里再排一次兜底（时间相同按 id 倒序）
      const list = (Array.isArray(rows) ? rows : []).slice().sort((a, b) => {
        const ta = String(a?.created_at || a?.createdAt || '')
        const tb = String(b?.created_at || b?.createdAt || '')
        return tb.localeCompare(ta) || (Number(b?.id || 0) - Number(a?.id || 0))
      })
      versions.value = { ...versions.value, [slot]: list }
    } catch { /* 静默：版本列表失败不影响生成 */ }
  }
}
watch(selectedId, () => { loadVersions() }, { immediate: true })

// ===== 选择模式（批量重生成用） =====
const selectMode = ref(false)
const selectedIds = ref([])
function toggleSelectMode() {
  selectMode.value = !selectMode.value
  if (!selectMode.value) selectedIds.value = []
}
function onRowClick(sb) {
  if (selectMode.value) {
    selectedIds.value = selectedIds.value.includes(sb.id)
      ? selectedIds.value.filter(id => id !== sb.id)
      : [...selectedIds.value, sb.id]
  } else {
    selectedId.value = sb.id
  }
}
function toggleSelectAll() {
  selectedIds.value = selectedIds.value.length === props.storyboards.length ? [] : props.storyboards.map(sb => sb.id)
}
function selectUnconfirmed() {
  selectedIds.value = props.storyboards.filter(sb => !kf(sb).confirmed).map(sb => sb.id)
}
watch(() => props.storyboards, (list) => {
  selectedIds.value = selectedIds.value.filter(id => list.some(sb => sb.id === id))
})

// ===== 单张关键帧生成：状态来自全局任务 store =====
// 槽位归属取 sys_task.params.frameType（后端同时透出 frame_type），
// 轮询与完成联动都在 store 里，组件卸载/切页/刷新后进度环自动恢复。
const FRAME_TYPE = { first: 'first_frame', mid: 'mid_frame', last: 'last_frame' }
const SLOT_BY_FRAME_TYPE = { first_frame: 'first', mid_frame: 'mid', last_frame: 'last' }
const submittingSlots = ref([])

function slotKey(sbId, slot) { return `${sbId}:${slot}` }
function slotTaskOf(sb, slot) {
  return sb?.id ? latestKeyframeTask(sb.id, FRAME_TYPE[slot]) : null
}

function isSlotPending(sb, slot) {
  if (submittingSlots.value.includes(slotKey(sb?.id, slot))) return true
  if (isActiveTaskStatus(slotTaskOf(sb, slot)?.status)) return true
  const item = batchItemOf(sb?.id, slot)
  return item ? isActiveBatchItemState(item.state) : false
}

/**
 * 单张任务是否比批次项更新：活跃任务、批次项没有任务、或任务 id/created_at 更新。
 * 单张重试会新建 sys_task，旧批次项仍停在 failed/cancelled，必须让新任务盖过它。
 */
function slotTaskIsNewer(task, item) {
  if (!task) return false
  if (!item || item.task_id == null) return true
  if (isActiveTaskStatus(task.status)) return true
  const a = Number(task.id)
  const b = Number(item.task_id)
  if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return a > b
  if (a === b) return false // 同一个任务：用批次项（含排队位次等更全的信息）
  return String(task.created_at || task.createdAt || '') > String(item.created_at || '')
}

/** 槽位的进度环属性：最新的那次生成优先（单张重试盖过旧批次项），否则用批次项 */
function slotRing(sb, slot) {
  const key = slotKey(sb?.id, slot)
  const item = batchItemOf(sb?.id, slot)
  // 正在提交单张重试：先显示“排队中”，不要停留在旧批次项的失败态
  if (submittingSlots.value.includes(key)) return ringPropsFromTask({ status: 'queued' }, now.value)
  const task = slotTaskOf(sb, slot)
  if (slotTaskIsNewer(task, item)) {
    // 更新的任务已完成：清掉旧批次项留下的失败/取消蒙层
    return task.status === 'completed' ? null : ringPropsFromTask(task, now.value)
  }
  // 批次项更新（或与任务同源）：以批次项为准；都不适用就不显示环，
  // 旧的终态任务不得盖在更新的批次结果上
  if (item && item.state !== 'skipped' && item.state !== 'completed') {
    const ring = ringPropsFromBatchItem(item)
    if (ring.status) return ring
  }
  return null
}
function slotCancellable(sb, slot) {
  const task = slotTaskOf(sb, slot)
  return Boolean(task?.cancellable) && isActiveTaskStatus(task?.status)
}

async function generateSlot(sb, slot) {
  if (!sb || isSlotPending(sb, slot)) return
  if (batchRunning.value) { toast.info(t('episode.kf.batchAlreadyRunning')); return }
  const prompt = slotPrompt(sb, slot).trim()
  if (!prompt) { toast.warning(t('episode.kf.promptRequired')); return }
  // 参考图与提示词不一致（缺图/未绑定/场景冲突/未知引用）时拦截，后端同样会 400
  if (slotBlocked(sb, slot)) {
    toast.error(t('episode.ref.slotBlocked', { slot: slotLabel(slot), reason: slotBlockReason(sb, slot) }), { duration: 7000 })
    return
  }
  const key = slotKey(sb.id, slot)
  submittingSlots.value = [...submittingSlots.value, key]
  try {
    // 重试即新建任务：新任务 id 更大，slotRing 自然盖掉上一次的失败/取消记录
    const task = await storyboardAPI.generateKeyframe(sb.id, slot, {
      prompt,
      model: props.imageModel || undefined,
      config_id: props.imageConfigId || undefined,
    })
    registerTask(task)
    toast.success(t('episode.kf.genStarted', { slot: slotLabel(slot) }))
    emit('refresh')
  } catch (e) {
    toastServerMessage(e, { fallback: 'episode.kf.genFailed' })
  } finally {
    submittingSlots.value = submittingSlots.value.filter(k => k !== key)
  }
}

// 完成联动：store 发现任务转为终态时通知，这里只刷新数据与版本列表（不再自己轮询）
onTaskFinished((task) => {
  if (task.type !== 'image' || !task.storyboard_id) return
  const slot = SLOT_BY_FRAME_TYPE[String(task.frame_type || task.params?.frameType || '')]
  if (!slot) return
  if (!props.storyboards.some(sb => sb.id === task.storyboard_id)) return
  // 批次子任务由批次轮询统一提示，避免重复 toast
  if (!batchItems.value.some(item => Number(item.task_id) === Number(task.id))) {
    if (task.status === 'completed') toast.success(t('episode.kf.genDone', { slot: slotLabel(slot) }))
    else if (task.status === 'failed') toastError(task.error_msg, { fallback: 'episode.kf.genFailed' })
    else if (task.status === 'cancelled') toast.info(t('episode.kf.genCancelled', { slot: slotLabel(slot) }))
  }
  emit('refresh')
  if (selected.value?.id === task.storyboard_id) void loadVersions()
})

async function cancelSlot(sb, slot) {
  const task = slotTaskOf(sb, slot)
  if (!task?.id) return
  try {
    const res = await taskAPI.cancel(task.id)
    registerTask(res)
    toast.success(t('episode.kf.slotCancelRequested'))
    await refreshTasks()
  } catch (e) {
    toastError(e, { fallback: 'common.ring.cancelFailed' })
  }
}

async function selectVersion(sb, slot, image) {
  if (!sb || !image || image === slotOwnImage(sb, slot)) return
  try {
    await storyboardAPI.selectKeyframe(sb.id, slot, { image })
    toast.success(t('episode.kf.versionSelected'))
    emit('refresh')
  } catch (e) {
    toastError(e)
  }
}
async function useInherit(sb) {
  if (!sb || !previousOf(sb)) return
  try {
    await storyboardAPI.selectKeyframe(sb.id, 'first', { inherit: true })
    toast.success(t('episode.kf.inheritSwitched'))
    emit('refresh')
    await loadVersions()
  } catch (e) {
    toastError(e)
  }
}
async function setBoundary(sb, value) {
  if (!sb || !previousOf(sb) || boundaryOf(sb) === value) return
  try {
    await storyboardAPI.update(sb.id, { continuity_boundary: value })
    emit('refresh')
  } catch (e) {
    toastError(e)
  }
}
function onMidTimeChange(sb, e) {
  const raw = String(e.target.value ?? '').trim()
  if (!raw) {
    emit('update-field', sb, 'mid_frame_time', null)
    return
  }
  const value = Math.round(Number(raw) * 10) / 10
  const max = Number(midTimeMax(sb))
  if (!Number.isFinite(value) || value <= 0.5 || value >= max) {
    toast.warning(t('episode.kf.midTimeInvalid', { max: midTimeMax(sb) }))
    e.target.value = midTime(sb) ?? ''
    return
  }
  e.target.value = value
  emit('update-field', sb, 'mid_frame_time', value)
}
async function toggleConfirm(sb) {
  if (!sb) return
  const next = !kf(sb).confirmed
  if (next && !kf(sb).ready) {
    toast.warning(t('episode.kf.notReadyHint', { slots: missingSlotLabels(sb) }))
    return
  }
  try {
    await storyboardAPI.confirmKeyframes(sb.id, next)
    toast.success(t(next ? 'episode.kf.confirmedToast' : 'episode.kf.unconfirmedToast'))
    emit('refresh')
  } catch (e) {
    toastError(e)
  }
}

// ===== 批量补齐关键帧提示词：后端异步逐分镜生成，前端轮询进度 =====
const promptBatch = ref({ running: false, total: 0, completed: 0 })
async function batchPrompts() {
  if (promptBatch.value.running || !props.episodeId) return
  if (!props.storyboards.length) { toast.warning(t('episode.sb.breakFirst')); return }
  const ids = selectMode.value && selectedIds.value.length ? [...selectedIds.value] : undefined
  try {
    const res = await episodeAPI.generateKeyframePrompts(props.episodeId, {
      storyboard_ids: ids,
      model: props.chatModel || undefined,
      config_id: props.chatConfigId || undefined,
    })
    if (!res?.total) {
      if (res?.already_running) {
        promptBatch.value = { running: true, total: 0, completed: 0 }
        pollPromptBatch()
      } else toast.info(t('episode.kf.promptsAllFilled'))
      return
    }
    promptBatch.value = { running: true, total: res.total, completed: 0 }
    toast.info(t('episode.kf.promptBatchStarted', { n: res.total }))
    pollPromptBatch()
  } catch (e) {
    toastError(e)
  }
}
function pollPromptBatch(attempts = 240) {
  const tick = async (left) => {
    try {
      const st = await episodeAPI.keyframePromptsStatus(props.episodeId)
      if (st && st.status !== 'running') {
        promptBatch.value = { running: false, total: 0, completed: 0 }
        emit('refresh')
        if (st.status === 'done') {
          toast.success(st.failed ? t('episode.kf.promptBatchDoneFailed', { n: st.failed }) : t('episode.kf.promptBatchDone'))
        } else {
          toastError(st.error, { fallback: 'episode.kf.promptBatchFailed' })
        }
        return
      }
      if (st) {
        const prev = promptBatch.value.completed
        promptBatch.value = { running: true, total: st.total || 0, completed: st.completed || 0 }
        if ((st.completed || 0) !== prev) emit('refresh')
      }
    } catch { /* 静默：轮询失败继续重试 */ }
    if (left > 0) setTimeout(() => tick(left - 1), 2500)
    else promptBatch.value = { running: false, total: 0, completed: 0 }
  }
  setTimeout(() => tick(attempts), 2500)
}

// ===== 集级关键帧批量：全部任务一次性提交到服务端队列，进度/估计由服务端给出 =====
const batch = ref(null)
const batchItems = computed(() => batch.value?.items || [])
const batchRunning = computed(() => batch.value?.status === 'running')
const batchFailedItems = computed(() => batchItems.value.filter(i => i.state === 'failed'))
const batchCancelledItems = computed(() => batchItems.value.filter(i => i.state === 'cancelled'))
const batchSkippedItems = computed(() => batchItems.value.filter(i => i.state === 'skipped'))
const batchIssues = computed(() => [...batchFailedItems.value, ...batchCancelledItems.value, ...batchSkippedItems.value])
// counts 由服务端给出；老批次（没有 counts）按 items 兜底统计
const batchCounts = computed(() => {
  const given = batch.value?.counts
  if (given) {
    return {
      pending: given.pending || 0,
      queued: (given.queued || 0) + (given.pending || 0),
      running: given.running || 0,
      completed: given.completed || 0,
      failed: given.failed || 0,
      cancelled: given.cancelled || 0,
      skipped: given.skipped || 0,
    }
  }
  const count = state => batchItems.value.filter(i => i.state === state).length
  return {
    pending: count('pending'),
    queued: count('queued') + count('pending'),
    running: count('running'),
    completed: count('completed'),
    failed: count('failed'),
    cancelled: count('cancelled'),
    skipped: count('skipped'),
  }
})
const batchPercent = computed(() => {
  const given = Number(batch.value?.progress)
  if (Number.isFinite(given)) return Math.round(Math.min(1, Math.max(0, given)) * 100)
  const total = batchItems.value.length
  return total ? Math.round((batchCounts.value.completed / total) * 100) : 0
})
const batchEtaText = computed(() => {
  if (!batchRunning.value) return ''
  const eta = Number(batch.value?.eta_seconds ?? batch.value?.etaSeconds)
  if (!Number.isFinite(eta)) return ''
  return t('episode.kf.batchRemaining', { time: formatSeconds(t, eta) })
})
const batchRetryableCount = computed(() => batchCounts.value.failed + batchCounts.value.cancelled)
const batchStopping = computed(() => batchRunning.value && Boolean(batch.value?.cancel_requested ?? batch.value?.cancelRequested))
const batchStatusLabel = computed(() => {
  const status = batch.value?.status
  if (status === 'running') return t(batchStopping.value ? 'episode.kf.batchStateStopping' : 'episode.kf.batchStateRunning')
  if (status === 'cancelled') return t('episode.kf.batchStateCancelled')
  return t('episode.kf.batchStateDone')
})
const batchVisible = computed(() => Boolean(batch.value) && (batchRunning.value || batchIssues.value.length > 0))
// 批次项（含已结束的失败/取消项）驱动槽位进度环与重试入口
function batchItemOf(sbId, slot) {
  if (!batch.value) return null
  return batchItems.value.find(i => i.storyboard_id === sbId && i.slot === slot) || null
}
const cancelConfirm = ref(false)
const batchRetrying = ref(false)
async function retryFailedBatch() {
  if (batchRetrying.value) return
  const n = batchRetryableCount.value
  if (!n) { toast.info(t('episode.kf.batchRetryFailedNothing')); return }
  batchRetrying.value = true
  try {
    applyBatch(await episodeAPI.retryFailedKeyframeBatch(props.episodeId))
    startPolling()
    toast.success(t('episode.kf.batchRetryFailedDone', { n }))
  } catch (e) {
    toastError(e, { fallback: 'episode.kf.genFailed' })
  } finally {
    batchRetrying.value = false
  }
}

// 批量确认框 = 服务端预览清单（分镜 × 槽位）+ 勾选；选择模式只缩小预览范围
const batchConfirm = ref({ open: false, loading: false, scoped: false, ids: [], items: [] })
const checkedItems = computed(() => batchConfirm.value.items.filter(item => item.checked))
const previewGroups = computed(() => {
  const groups = []
  for (const item of batchConfirm.value.items) {
    let group = groups.find(g => g.storyboard_id === item.storyboard_id)
    if (!group) {
      group = { storyboard_id: item.storyboard_id, storyboard_number: item.storyboard_number, items: [] }
      groups.push(group)
    }
    group.items.push(item)
  }
  return groups.sort((a, b) => (a.storyboard_number || 0) - (b.storyboard_number || 0))
})
// 批量确认框的耗时估计：来自任务服务的实测数据（GET /image-queue/estimate）
const batchEstimate = ref({ loading: false, data: null })
const batchEstimateText = computed(() => {
  const count = checkedItems.value.length
  if (!count) return '—'
  if (batchEstimate.value.loading) return t('episode.kf.batchEtaEstimating')
  const data = batchEstimate.value.data
  // 非 qwen-jobs 供应商没有服务端队列与实测数据，回落到粗略估计
  if (!data || data.supported === false) return t('episode.kf.batchEtaValue', { n: count * 3 })
  if (data.total_seconds === null || data.total_seconds === undefined) return t('episode.kf.batchEtaOffline')
  return t('episode.kf.batchEtaApiValue', {
    total: formatSeconds(t, data.total_seconds),
    per: formatSeconds(t, data.per_image_seconds),
  })
})
const batchEstimateNote = computed(() => {
  const data = batchEstimate.value.data
  if (batchEstimate.value.loading || !data || data.supported === false) return ''
  const parts = []
  if (Number(data.queue_wait_seconds) > 0) parts.push(t('episode.kf.batchEtaQueueWait', { time: formatSeconds(t, data.queue_wait_seconds) }))
  if (Number(data.online_workers) > 0) parts.push(t('episode.kf.batchEtaWorkers', { n: data.online_workers }))
  if (data.basis) parts.push(t('episode.kf.batchEtaBasis', { basis: data.basis }))
  return parts.join(' · ')
})
// 关键帧的参考图数量按本批（分镜 × 槽位）最多的一帧算，估计宁可偏保守
function maxTargetRefs(items) {
  let max = 0
  for (const item of items) {
    const sb = props.storyboards.find(s => s.id === item.storyboard_id)
    const count = targetAssets(sb, item.slot).length
    if (count > max) max = count
  }
  return max
}
async function loadBatchEstimate(items, count) {
  batchEstimate.value = { loading: true, data: null }
  try {
    const data = await imageQueueAPI.estimate({
      config_id: props.imageConfigId || undefined,
      size: KEYFRAME_SIZES[props.aspectRatio] || KEYFRAME_SIZES['16:9'],
      references: maxTargetRefs(items),
      count,
    })
    batchEstimate.value = { loading: false, data }
  } catch {
    batchEstimate.value = { loading: false, data: null } // 估计拿不到就回落到粗略文案
  }
}
function setAllChecked(value) {
  for (const item of batchConfirm.value.items) {
    if (item.status === 'blocked' || item.status === 'skipped') continue
    item.checked = value
  }
}
function previewStatusLabel(item) {
  if (item.status === 'missing') return t('episode.kf.previewMissing')
  if (item.status === 'changed') return t('episode.kf.previewChanged')
  if (item.status === 'unchanged') {
    const matched = Number(item.matched_version_no) || 0
    const current = Number(item.selected_version_no) || 0
    return current
      ? t('episode.kf.previewUnchanged', { n: matched, m: current })
      : t('episode.kf.previewUnchangedNoSelection', { n: matched })
  }
  if (item.status === 'blocked') return t('episode.kf.previewBlocked')
  return t('episode.kf.previewSkipped')
}
/** 被拦截项的原因：优先列出阻断问题，其次列出全部问题 */
function blockReasonOf(item) {
  const issues = Array.isArray(item?.issues) ? item.issues : []
  const blocking = issues.filter(i => i.severity === 'block')
  return (blocking.length ? blocking : issues).map(i => i.message).join(t('common.listJoin'))
}
async function openBatchConfirm() {
  if (batchRunning.value) { toast.info(t('episode.kf.batchAlreadyRunning')); return }
  const scoped = selectMode.value && selectedIds.value.length > 0
  const ids = scoped ? [...selectedIds.value] : []
  batchConfirm.value = { open: true, loading: true, scoped, ids, items: [] }
  batchEstimate.value = { loading: false, data: null }
  try {
    const res = await episodeAPI.keyframeBatchPreview(props.episodeId, {
      storyboard_ids: ids,
      model: props.imageModel || undefined,
      config_id: props.imageConfigId || undefined,
    })
    const items = (Array.isArray(res?.items) ? res.items : []).map(item => ({
      ...item,
      checked: Boolean(item.checked) && item.status !== 'blocked' && item.status !== 'skipped',
    }))
    if (!items.length) {
      batchConfirm.value = { open: false, loading: false, scoped: false, ids: [], items: [] }
      toast.info(t('episode.kf.batchNothing'))
      return
    }
    batchConfirm.value = { open: true, loading: false, scoped, ids, items }
  } catch (e) {
    batchConfirm.value = { open: false, loading: false, scoped: false, ids: [], items: [] }
    toastServerMessage(e, { fallback: 'episode.kf.genFailed' })
  }
}
// 勾选变化后重新问一次实测耗时（按勾选数），连续点选时合并成一次请求
let estimateTimer = null
watch(() => (batchConfirm.value.open ? checkedItems.value.length : 0), (count) => {
  if (estimateTimer) { clearTimeout(estimateTimer); estimateTimer = null }
  if (!batchConfirm.value.open || !count) {
    batchEstimate.value = { loading: false, data: null }
    return
  }
  batchEstimate.value = { loading: true, data: batchEstimate.value.data }
  estimateTimer = setTimeout(() => {
    void loadBatchEstimate([...checkedItems.value], count)
  }, 300)
})
async function startBatch() {
  const items = checkedItems.value.map(item => ({ storyboard_id: item.storyboard_id, slot: item.slot }))
  batchConfirm.value = { open: false, loading: false, scoped: false, ids: [], items: [] }
  if (!items.length) return
  try {
    applyBatch(await episodeAPI.startKeyframeBatch(props.episodeId, {
      items,
      model: props.imageModel || undefined,
      config_id: props.imageConfigId || undefined,
    }))
    startPolling()
    toast.success(t('episode.kf.batchStarted', { n: items.length }))
    if (selectMode.value) toggleSelectMode()
  } catch (e) {
    toastServerMessage(e, { fallback: 'episode.kf.genFailed' })
  }
}
async function cancelBatch() {
  cancelConfirm.value = false
  try {
    applyBatch(await episodeAPI.cancelKeyframeBatch(props.episodeId))
    toast.success(t('episode.kf.batchStopped'))
  } catch (e) {
    toastError(e)
  }
}
let batchTimer = null
let batchSettledCount = -1
function applyBatch(status) {
  batch.value = status && status.status ? status : null
  return batch.value
}
async function loadBatch() {
  if (!props.episodeId) return
  let current = null
  try { current = applyBatch(await episodeAPI.keyframeBatch(props.episodeId)) } catch { return }
  const settled = batchItems.value.filter(i => !isActiveBatchItemState(i.state)).length
  const wasPolling = Boolean(batchTimer)
  if (batchSettledCount >= 0 && settled !== batchSettledCount) {
    emit('refresh') // 每完成一张刷新，关键帧逐个出现
    if (selected.value) await loadVersions()
  }
  batchSettledCount = settled
  if (current?.status === 'running') {
    startPolling()
  } else {
    stopPolling()
    if (wasPolling) {
      emit('refresh')
      if (selected.value) await loadVersions()
      toast.success(current?.status === 'cancelled' ? t('episode.kf.batchCancelledToast') : t('episode.kf.batchDoneToast'))
    }
  }
}
function startPolling() {
  // 任务并发出图，3.5s 轮询让排队位置/剩余时间跟得上
  if (!batchTimer) batchTimer = setInterval(loadBatch, 3500)
}
function stopPolling() {
  if (batchTimer) { clearInterval(batchTimer); batchTimer = null }
}

// 页面加载后恢复仍在运行的提示词批量（与资产提取同一套恢复逻辑）
async function syncPromptBatch() {
  if (!props.episodeId) return
  try {
    const st = await episodeAPI.keyframePromptsStatus(props.episodeId)
    if (st?.status === 'running' && !promptBatch.value.running) {
      promptBatch.value = { running: true, total: st.total || 0, completed: st.completed || 0 }
      pollPromptBatch()
    }
  } catch { /* 静默 */ }
}

onMounted(() => {
  loadBatch()
  syncPromptBatch()
})
watch(() => props.episodeId, () => {
  batchSettledCount = -1
  loadBatch()
  syncPromptBatch()
})
onBeforeUnmount(() => {
  stopPolling()
  if (estimateTimer) { clearTimeout(estimateTimer); estimateTimer = null }
})
</script>

<style scoped>
.kf-step { min-height: 0; }
.kf-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
}
.kf-bar .is-on { border-color: var(--accent); color: var(--accent-text); }

/* ===== 批量进度条 ===== */
.kf-batch-banner {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-2);
  font-size: 12px;
  color: var(--text-2);
}
.kf-batch-banner.is-running { border-color: var(--accent); }
.kf-batch-state { font-weight: 600; color: var(--text-1); }
.kf-batch-sep { color: var(--text-3); }
.kf-batch-issue { color: var(--error); }
.kf-batch-issues {
  flex-basis: 100%;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 11px;
  color: var(--text-3);
}
.kf-batch-line {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.kf-batch-eta { color: var(--accent); font-weight: 600; }
.kf-batch-progress {
  position: relative;
  height: 14px;
  border-radius: 7px;
  background: var(--bg-3, var(--bg-1));
  overflow: hidden;
}
.kf-batch-progress-fill {
  display: block;
  height: 100%;
  background: var(--accent);
  border-radius: 7px;
  transition: width 0.6s linear;
}
.kf-batch-progress-text {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 600;
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
}
.kf-slot-task {
  display: flex;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-2);
}
.kf-batch-row-note { align-items: flex-start; }
.kf-thumb-ring {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  border-radius: inherit;
}

/* ===== 空状态 ===== */
.kf-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 40px 20px;
  text-align: center;
}
.kf-empty-visual { color: var(--text-3); }
.kf-empty-title { font-size: 20px; font-weight: 700; color: var(--text-0); }
.kf-empty-desc { font-size: 13px; color: var(--text-2); max-width: 420px; line-height: 1.8; }

/* ===== 两栏工作区 ===== */
.kf-workbench {
  flex: 1;
  min-height: 0;
  display: grid;
  /* 分镜列表：有上下限的伸缩宽度，不写死 */
  grid-template-columns: clamp(260px, 18vw, 340px) minmax(0, 1fr);
  gap: 10px;
}
.kf-list {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-raised);
  overflow: hidden;
}
.kf-list-head { padding: 10px 12px; border-bottom: 1px solid var(--border); }
.kf-list-title { font-size: 13px; font-weight: 600; color: var(--text-0); }
.kf-list-meta { font-size: 11px; color: var(--text-3); margin-top: 2px; }
.kf-quick-actions { display: flex; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--border); }
.kf-quick-btn {
  font-size: 11px;
  color: var(--text-2);
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 2px 8px;
  cursor: pointer;
}
.kf-quick-btn:hover { border-color: var(--accent); color: var(--accent-text); }
.kf-list-body { flex: 1; overflow-y: auto; padding: 6px; display: flex; flex-direction: column; gap: 6px; }
.kf-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-2);
  cursor: pointer;
}
.kf-row:hover { border-color: var(--border-strong); }
.kf-row.active { border-color: var(--accent); box-shadow: 0 0 0 2px var(--button-focus); }
.kf-row.is-selected { border-color: var(--accent); background: var(--accent-bg); }
.kf-row-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.kf-row-index { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); }
.kf-row-title { font-size: 12px; color: var(--text-1); min-width: 0; }
.kf-check {
  width: 14px; height: 14px; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--border-strong); border-radius: 4px; color: var(--accent-text);
}
.kf-check.on { border-color: var(--accent); background: var(--accent-bg); }
.kf-row-thumbs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; }
.kf-thumb {
  position: relative;
  aspect-ratio: 16 / 9;
  border-radius: 6px;
  overflow: hidden;
  background: var(--bg-3);
  border: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
}
.kf-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.kf-thumb.empty { border-style: dashed; }
.kf-thumb.pending { border-color: var(--accent); }
.kf-thumb-empty { font-size: 11px; }
.kf-thumb-tag {
  position: absolute; left: 2px; bottom: 2px;
  font-size: 9px; line-height: 1.4; padding: 0 3px; border-radius: 3px;
  background: rgba(0, 0, 0, 0.55); color: #fff;
}
.kf-row-meta { display: flex; align-items: center; gap: 6px; font-size: 11px; }
.kf-row-dur { margin-left: auto; color: var(--text-3); font-family: var(--font-mono); }
.kf-state { padding: 1px 6px; border-radius: 999px; font-size: 11px; }
.kf-state.is-missing { background: var(--warning-bg); color: var(--tag-warning-text); }
.kf-state.is-ready { background: var(--info-bg); color: var(--tag-info-text); }
.kf-state.is-confirmed { background: var(--success-bg); color: var(--tag-success-text); }
.kf-inherit-tag {
  padding: 1px 6px; border-radius: 999px; font-size: 11px;
  background: var(--accent-bg); color: var(--accent-text);
}

/* ===== 右侧编辑区 ===== */
.kf-editor {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-raised);
  overflow: hidden;
}
.kf-editor-empty { align-items: center; justify-content: center; color: var(--text-3); font-size: 13px; }
.kf-editor-head {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 12px; border-bottom: 1px solid var(--border);
}
.kf-editor-title { font-size: 13px; font-weight: 600; color: var(--text-0); }
.kf-editor-body { flex: 1; overflow-y: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 10px; }
.kf-section {
  display: flex; flex-direction: column; gap: 8px;
  padding: 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-2);
}
.kf-section-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.kf-section-label { font-size: 12px; font-weight: 600; color: var(--text-1); }
.kf-field { display: flex; flex-direction: column; gap: 4px; }
.kf-field-label { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--text-2); }
.kf-boundary { display: flex; gap: 6px; }
.kf-boundary .is-on { border-color: var(--accent); color: var(--accent-text); }

/* 参考素材绑定（原视频步骤的绑定面板，迁移到关键帧步骤） */
.kf-ref-list { display: flex; flex-direction: column; gap: 10px; }
.kf-ref-group { display: flex; flex-direction: column; gap: 6px; }
.kf-ref-group-label { font-size: 11px; color: var(--text-3); }
/* 资产池卡片：流式网格，卡片 160–240px，空间变大时卡片保持最大尺寸、只增加列数；图片区占卡片高度 60% */
.kf-pool-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 240px));
  justify-content: start;
  gap: 8px;
}
.kf-pool-card {
  /* 固定卡片高度，让图片区稳定占 60%（百分比 flex-basis 需要确定高度） */
  display: flex; flex-direction: column; height: 216px; min-width: 0; max-width: 240px;
  border: 1px solid var(--border); border-radius: 9px; overflow: hidden;
  background: var(--surface-raised); cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.kf-pool-card:hover { border-color: var(--border-strong); }
.kf-pool-card.bound { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
.kf-pool-media {
  position: relative; flex: 0 0 60%; min-height: 0;
  display: flex; align-items: center; justify-content: center;
  background: var(--bg-2); color: var(--text-3); font-size: 12px;
}
.kf-pool-media img { width: 100%; height: 100%; object-fit: contain; display: block; }
.kf-pool-media-empty { font-size: 12px; }
.kf-pool-check {
  position: absolute; top: 6px; right: 6px;
  width: 22px; height: 22px; padding: 0;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--border-strong); border-radius: 6px;
  background: var(--surface-raised); color: var(--text-3); cursor: pointer;
}
.kf-pool-check[aria-pressed='true'] {
  border-color: var(--accent); background: var(--accent); color: var(--surface-raised);
}
.kf-pool-check:hover { border-color: var(--accent); }
.kf-pool-body { display: flex; flex-direction: column; gap: 2px; padding: 6px 8px 7px; min-width: 0; }
.kf-pool-name { font-size: 12px; font-weight: 600; color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kf-pool-meta { font-size: 11px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kf-pool-foot { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.kf-ref-state { font-size: 11px; color: var(--text-3); }
.kf-ref-state.is-ready { color: var(--success); }
.kf-ref-pool-hint { margin: 2px 0 0; font-size: 11px; color: var(--text-3); }
.kf-ref-goto { font-size: 11px; color: var(--accent-text); background: none; border: none; cursor: pointer; padding: 0; }
.kf-ref-empty { font-size: 12px; color: var(--text-3); }
.kf-slot-refs { display: flex; flex-direction: column; gap: 4px; }
.kf-slot-refs-head { display: flex; align-items: center; gap: 6px; }

/* 三个槽位卡片：左图片列随空间伸缩（最小 320 / 最大 640），右提示词列占满剩余宽度 */
.kf-slot-body { display: grid; grid-template-columns: clamp(320px, 30%, 640px) minmax(420px, 1fr); gap: 12px; align-items: start; }
.kf-slot-media { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.kf-preview {
  width: 100%;
  border: 1px solid var(--border); border-radius: 8px; overflow: hidden;
  background: var(--surface-raised); padding: 0; cursor: zoom-in;
  display: flex; align-items: center; justify-content: center;
}
.kf-preview.empty { border-style: dashed; cursor: default; }
.kf-preview img { width: 100%; height: 100%; object-fit: contain; display: block; }
.kf-preview-empty { font-size: 12px; color: var(--text-3); }
.kf-slot-version-row { gap: 6px; }
.kf-slot-inherit-btn { align-self: flex-start; }
.kf-slot-main { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.kf-prompt-field { flex: 1; min-width: 0; }
.kf-prompt { min-height: 96px; }
.kf-slot-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.kf-slot-row-label { font-size: 11px; color: var(--text-2); }
.kf-slot-row-unit { font-size: 11px; color: var(--text-3); }
.kf-mid-time { width: 92px; }
.kf-version-select { max-width: 280px; font-size: 12px; }

.kf-editor-foot {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 12px; border-top: 1px solid var(--border); background: var(--bg-2);
}
.kf-foot-hint { font-size: 12px; color: var(--text-2); flex: 1; min-width: 0; }

/* 批量确认弹窗 */
.kf-batch-dialog { width: min(620px, 94vw); }
.kf-batch-body { display: flex; flex-direction: column; gap: 8px; }
.kf-batch-row { display: flex; align-items: center; justify-content: space-between; font-size: 13px; color: var(--text-2); }
.kf-batch-note { font-size: 12px; color: var(--text-3); line-height: 1.7; margin: 0; }
.kf-batch-loading { font-size: 13px; color: var(--text-2); padding: 18px 0; text-align: center; }
.kf-batch-actions { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.kf-batch-list {
  display: flex; flex-direction: column; gap: 8px;
  max-height: 320px; overflow-y: auto;
  border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 8px;
}
.kf-batch-group { display: flex; flex-direction: column; gap: 2px; }
.kf-batch-group-head { font-size: 11px; font-weight: 600; color: var(--text-3); }
.kf-batch-item {
  display: flex; align-items: center; gap: 8px;
  padding: 4px 6px; border-radius: var(--radius-sm);
  font-size: 12px; color: var(--text-1); cursor: pointer;
}
.kf-batch-item:hover { background: var(--bg-hover); }
.kf-batch-item.disabled { cursor: default; color: var(--text-3); }
.kf-batch-item-slot { min-width: 48px; }
.kf-batch-item-status { color: var(--text-2); }
.kf-batch-item.is-blocked .kf-batch-item-status { color: var(--action-danger); }
.kf-batch-item.is-unchanged .kf-batch-item-status { color: var(--text-3); }
.kf-batch-item-reason { flex: 1; min-width: 0; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kf-batch-empty { font-size: 12px; color: var(--text-3); text-align: center; padding: 12px 0; }
/* 字段保存状态靠右跟在字段标签行尾 */
.kf-field-save { margin-left: auto; }
.kf-ref-issue-count { font-size: 11px; }
.kf-ref-issue-count.is-block { color: var(--action-danger); }
.kf-ref-issue-count.is-warn { color: var(--tag-warning-text); }
</style>
