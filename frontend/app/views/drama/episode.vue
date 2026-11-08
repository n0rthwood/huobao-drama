<template>
  <div class="studio" v-if="drama">
    <header class="studio-topbar">
      <div class="studio-topbar-main">
        <button class="back-btn topbar-back" @click="navigateTo(`/drama/${dramaId}`)">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
            <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
          </svg>
          {{ t('episode.topbar.back') }}
        </button>
        <div class="studio-identity">
          <h1 class="studio-title">{{ drama.title }}</h1>
          <span class="studio-episode-chip">{{ t('episode.topbar.episodeN', { n: episodeNumber }) }}</span>
          <div class="studio-meta-row">
            <span class="studio-meta-pill">{{ currentSubStageLabel }}</span>
            <span class="studio-meta-pill is-progress">{{ pipelineProgress }}/{{ pipelineTotal }}</span>
            <span class="studio-meta-inline">{{ t('episode.topbar.meta', { roles: chars.length, shots: sbs.length }) }}</span>
          </div>
        </div>
      </div>

      <div class="studio-topbar-side">
        <div class="studio-model-picks">
          <ModelSelect
            v-if="textModelOptions.length"
            v-model="chatModel"
            :label="t('common.serviceType.text')"
            :options="textModelOptions"
            :default-label="t('episode.model.defaultWith', { model: textModelOptions[0].model })"
            :show-config="textModelMultiCfg"
          />
          <ModelSelect
            v-if="imageModelOptions.length"
            v-model="imageModel"
            :label="t('common.serviceType.image')"
            :options="imageModelOptions"
            :default-label="t('episode.model.defaultWith', { model: imageModelOptions[0].model })"
            :show-config="imageModelMultiCfg"
          />
          <ModelSelect
            v-if="videoModelOptions.length"
            v-model="videoModel"
            :label="t('common.serviceType.video')"
            :options="videoModelOptions"
            :default-label="t('episode.model.defaultWith', { model: videoModelOptions[0].model })"
            :show-config="videoModelMultiCfg"
          />
          <ModelSelect
            v-model="episodeResolution"
            :label="t('episode.topbar.resolution')"
            :options="resolutionOptions"
            hide-default
          />
        </div>
        <div class="studio-actions">
          <LocaleSwitcher />
          <button class="btn btn-icon tour-help-btn" :title="t('tour.helpTitle')" @click="startTour('episode', EPISODE_TOUR, t)">
            <CircleHelp :size="14" :stroke-width="1.8" />
          </button>
          <button class="btn" @click="refresh">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
            {{ t('common.refresh') }}
          </button>
          <TaskCenterButton :episode-id="epId" :drama-id="dramaId" variant="topbar" />
        </div>
      </div>
    </header>

    <div class="studio-body">
    <!-- ========== LEFT SIDEBAR ========== -->
    <aside class="sidebar" :class="{ collapsed: sidebarCollapsed }">
      <nav class="pipeline">
        <div
          v-for="section in sidebarSections"
          :key="section.id"
          :class="['pipe-section', 'is-' + sectionState(section.id)]"
        >
          <div class="pipe-section-label">
            <span v-if="sectionState(section.id) !== 'none'" class="pipe-section-state">
              <svg v-if="sectionState(section.id) === 'done'" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>
              <span v-else-if="sectionState(section.id) === 'active'" class="pipe-section-pulse" />
              <span v-else class="pipe-section-dot" />
            </span>
            <span>{{ section.label }}</span>
            <span v-if="sectionState(section.id) === 'active'" class="pipe-section-tag">{{ t('episode.sidebar.inProgress') }}</span>
          </div>
          <button
            v-for="item in section.items"
            :key="item.key"
            :class="['pipe-item pipe-item-sub', {
              active: activeSubStepKey === item.key,
              done: sectionState(section.id) === 'done',
              doing: sectionState(section.id) === 'active',
              'is-locked': item.locked,
            }]"
            :title="item.locked
              ? `${t('episode.gate.locked')} · ${item.lockReason} · ${t('episode.gate.goFix')}`
              : (sidebarCollapsed ? item.label : undefined)"
            @click="goSubStep(item.key)"
          >
            <span class="pipe-icon" :class="sectionState(section.id) === 'done' ? 'icon-done' : activeSubStepKey === item.key ? 'icon-active' : ''">
              <!-- 收起态：始终显示步骤图标，进行中用右上角小脉冲点表达 -->
              <template v-if="sidebarCollapsed">
                <component :is="item.icon" :size="12" />
                <span v-if="sectionState(section.id) === 'active'" class="pipe-mini-pulse" />
              </template>
              <svg v-else-if="sectionState(section.id) === 'done'" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>
              <span v-else-if="sectionState(section.id) === 'active'" class="pipe-item-pulse" />
              <component v-else :is="item.icon" :size="11" />
            </span>
            <span class="pipe-copy">
              <span class="pipe-label">
                <Lock v-if="item.locked" :size="10" class="pipe-lock" />
                {{ item.label }}
                <span v-if="item.optional" class="pipe-optional">{{ t('episode.gate.optional') }}</span>
              </span>
              <span v-if="item.desc" class="pipe-sub">{{ item.desc }}</span>
            </span>
          </button>
        </div>
      </nav>

      <!-- Bottom: 收起/展开 + Stage marquee + Refresh -->
      <div class="sidebar-bottom">
        <button
          type="button"
          class="sidebar-toggle"
          :title="t(sidebarCollapsed ? 'episode.sidebar.expand' : 'episode.sidebar.collapse')"
          @click="toggleSidebar"
        >
          <svg class="sidebar-toggle-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          <span v-if="!sidebarCollapsed">{{ t('episode.sidebar.collapse') }}</span>
        </button>
        <!-- 步骤跑马灯：四段主流程进度，当前段流动光效，点击段可跳转 -->
        <div class="sidebar-progress">
          <div class="sidebar-progress-head">
            <span class="sidebar-progress-title">{{ currentStageLabel }}</span>
            <span class="sidebar-progress-count">{{ currentMainIdx + 1 }}/{{ mainProgressSteps.length }}</span>
          </div>
          <div class="sidebar-progress-track">
            <button
              v-for="(s, i) in mainProgressSteps"
              :key="s.id"
              type="button"
              :class="['sidebar-progress-seg', { done: i < currentMainIdx || mainStageDone(s.id), current: i === currentMainIdx, locked: s.locked }]"
              :title="s.locked ? `${s.label} · ${t('episode.gate.locked')}：${s.reason} · ${t('episode.gate.goFix')}` : s.label"
              @click="goMainStage(s.id)"
            ><span class="sidebar-progress-seg-fill" /></button>
          </div>
          <div class="sidebar-progress-labels">
            <span
              v-for="(s, i) in mainProgressSteps"
              :key="s.id"
              :class="{ on: i === currentMainIdx, done: i < currentMainIdx || mainStageDone(s.id), locked: s.locked }"
              :title="s.locked ? `${t('episode.gate.locked')}：${s.reason}` : undefined"
            ><Lock v-if="s.locked" :size="9" class="progress-lock" />{{ s.label }}</span>
          </div>
        </div>
        <button class="refresh-btn" @click="refresh">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          {{ t('episode.sidebar.refreshData') }}
        </button>
      </div>
    </aside>

    <!-- ========== MAIN CONTENT ========== -->
    <main class="main">
      <!-- ===== SCRIPT PANEL ===== -->
      <ScriptStepPanel v-if="panel === 'script'" />

      <!-- ===== PRODUCTION PANEL ===== -->
      <div v-else-if="panel === 'production'" class="content-panel">
        <!--
          门禁锁定（#54）：侧栏点击与 deeplink 直达都只给原因与出路，绝不渲染内容；
          门禁尚未判定（首屏未取到 /gates 或取数失败）时同样走这里，避免内容先闪一下。
          这道闸门必须排在「剧本未就绪」提示之前，否则锁定步骤会显示错误的阻断原因。
        -->
        <div v-if="stageLocked(prodTab)" class="step-empty" style="flex:1">
          <div class="empty-visual"><Lock :size="32" /></div>
          <div class="empty-title">{{ stageGateUnknown(prodTab) ? t('episode.gate.checking') : t('episode.gate.locked') }}</div>
          <div class="empty-desc">{{ stageLockReason(prodTab) }}</div>
          <button v-if="stageGateUnknown(prodTab)" class="btn" @click="refreshGates()">{{ t('episode.sidebar.refreshData') }}</button>
          <button v-else class="btn btn-primary" @click="goStageBlocker(prodTab)">{{ t('episode.gate.goFix') }}</button>
        </div>

        <!-- Guard: current production step prerequisites -->
        <div v-else-if="productionBlockMessage" class="step-empty" style="flex:1">
          <div class="empty-visual">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
          </div>
          <div class="empty-title">{{ t('episode.prod.notReady') }}</div>
          <div class="empty-desc">{{ productionBlockMessage }}</div>
          <button class="btn btn-primary" @click="goProductionBlockTarget">{{ productionBlockActionLabel }}</button>
        </div>

        <template v-else>
          <!-- 制作子步骤导航（资产/分镜拆分/视频生成）由左侧栏承担，顶部不再重复展示 -->
          <!-- 资产步两个子页签（#54）：资产卡 / 审核清单；剧情项目不渲染该页签 -->
          <div v-if="prodTab === 'assets' && isDocumentaryProject" class="asset-subtabs">
            <button
              v-for="sub in ASSET_SUB_TABS"
              :key="sub"
              :class="['btn btn-sm', { 'is-on': assetTab === sub }]"
              @click="assetTab = sub"
            >{{ sub === 'cards' ? t('episode.assets.tabCards') : t('episode.assets.tabReview') }}</button>
          </div>
          <AssetReviewPanel
            v-if="prodTab === 'assets' && assetTab === 'review' && isDocumentaryProject"
            :episode-id="epId"
            :review="gateState.assets"
            @update:status="refreshGates()"
            @open-asset="openAssetFromReview"
            @create-asset="openAssetCreateFromReview"
            @goto-design="prodTab = 'design'"
          />
          <!-- Sub: Assets -->
          <div v-if="prodTab === 'assets' && !(isDocumentaryProject && assetTab === 'review')" class="prod-content">
            <div class="prod-section-bar">
              <span class="dim" style="font-size:12px">{{ t('episode.prod.assets') }}</span>
              <span class="tag mono">{{ t('episode.prod.readyCount', { ready: assetReadyCount, total: assetTotalCount }) }}</span>
              <div class="seg asset-extract-filter" role="tablist" :aria-label="t('episode.prod.assets')">
                <button
                  v-for="et in [{ key: '', label: t('index.status.all') }, ...EXTRACT_TARGETS]"
                  :key="et.key || 'all'"
                  type="button"
                  class="seg-item"
                  role="tab"
                  :class="{ on: (extractTab || '') === et.key }"
                  :aria-selected="(extractTab || '') === et.key"
                  @click="extractTab = et.key || null"
                >{{ et.label }}</button>
              </div>
              <div class="ml-auto flex gap-1 asset-bar-actions">
                <button
                  v-for="et in EXTRACT_TARGETS"
                  :key="et.key"
                  class="btn btn-sm asset-btn-extract"
                  :disabled="isExtracting(et.key)"
                  @click="doExtract(et.key)"
                >
                  <Loader2 v-if="isExtracting(et.key)" :size="11" class="animate-spin" />
                  <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                  {{ (et.key === 'characters' ? chars.length : et.key === 'scenes' ? scenes.length : propItems.length) ? t('episode.prod.reextract', { type: et.label }) : t('episode.prod.extract', { type: et.label }) }}
                </button>
                <span class="asset-bar-divider" />
                <button v-if="isDocumentaryRuleset" class="btn btn-sm asset-btn-extract" @click="openRosterDialog">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M16 11a4 4 0 1 0-8 0"/><path d="M3 21v-2a5 5 0 0 1 5-5h8a5 5 0 0 1 5 5v2"/></svg>
                  {{ t('episode.roster.open') }}
                </button>
                <button class="btn btn-sm asset-btn-extract" @click="assetBrowserOpen = true">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 6h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2z"/></svg>
                  {{ t('components.assetBrowser.openEpisode') }}
                </button>
                <button
                  v-for="scope in ASSET_BATCH_SCOPES"
                  :key="scope"
                  class="btn btn-sm asset-btn-batch"
                  :disabled="assetBatchRunning"
                  :title="assetBatchRunning ? t('episode.assetBatch.alreadyRunning') : undefined"
                  @click="openAssetBatch(scope)"
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                  {{ t(`episode.prod.batch.${scope}`) }}
                </button>
              </div>
            </div>
            <div v-if="assetBatch.status" class="asset-batch-banner" :class="{ 'is-running': assetBatchRunning }">
              <span class="asset-batch-state">{{ t(`episode.prod.batch.${assetBatch.status.scope}`) }} · {{ t(`episode.assetBatch.status.${assetBatch.status.status}`) }}</span>
              <span class="asset-batch-sep">·</span>
              <span>{{ t('episode.assetBatch.progress', { done: assetBatchDone, total: assetBatchCounts?.total || 0 }) }}</span>
              <span class="asset-batch-sep">·</span>
              <span>{{ t('episode.assetBatch.promptProgress', {
                done: assetBatchCounts?.prompt.done || 0,
                failed: assetBatchCounts?.prompt.failed || 0,
              }) }}</span>
              <span class="asset-batch-sep">·</span>
              <span>{{ t('episode.assetBatch.imageProgress', {
                submitted: assetBatchCounts?.image.submitted || 0,
                done: assetBatchCounts?.image.done || 0,
                failed: assetBatchCounts?.image.failed || 0,
              }) }}</span>
              <template v-if="assetBatchCounts?.prompt.unchanged_after_rewrite">
                <span class="asset-batch-sep">·</span>
                <span>{{ t('episode.assetBatch.unchangedCount', { n: assetBatchCounts.prompt.unchanged_after_rewrite }) }}</span>
              </template>
              <button v-if="assetBatchRunning" class="btn btn-sm ml-auto" :disabled="assetBatch.stopping" @click="stopAssetBatch">
                {{ t('episode.assetBatch.stop') }}
              </button>
            </div>
            <div v-if="extractingTargets.length && !chars.length && !scenes.length && !propItems.length" class="step-loading">
              <Loader2 :size="24" class="animate-spin" style="color:var(--accent)" />
              <div class="loading-text">{{ t('episode.prod.extractingTypes', { types: extractingLabels }) }}</div>
            </div>
            <div v-else-if="!chars.length && !scenes.length && !propItems.length" class="step-empty asset-empty-state">
              <div class="empty-visual">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              </div>
              <div class="empty-title">{{ t('episode.prod.emptyTitle') }}</div>
              <div class="empty-desc">{{ t('episode.prod.emptyDesc') }}</div>
              <button class="btn btn-primary" :disabled="!!extractingTargets.length" @click="doExtractAll">
                <Loader2 v-if="extractingTargets.length" :size="13" class="animate-spin" />
                <svg v-else width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                {{ extractingTargets.length ? t('episode.prod.extractingTypesDots', { types: extractingLabels }) : t('episode.prod.startExtract') }}
              </button>
            </div>
            <template v-else>
            <div v-if="imageQueue.total" class="image-queue-bar">
              <span class="image-queue-title">{{ t('episode.image.queueTitle') }}</span>
              <span class="image-queue-sep">·</span>
              <span>{{ t('episode.image.queueSummary', { queued: imageQueue.queued, running: imageQueue.running }) }}</span>
              <template v-if="imageQueueEtaText">
                <span class="image-queue-sep">·</span>
                <span class="image-queue-eta">{{ imageQueueEtaText }}</span>
              </template>
              <div class="image-queue-progress" role="progressbar" :aria-valuenow="imageQueuePercent" aria-valuemin="0" aria-valuemax="100">
                <span class="image-queue-progress-fill" :style="{ width: imageQueuePercent + '%' }" />
              </div>
              <span class="image-queue-percent">{{ t('episode.image.queueProgress', { percent: imageQueuePercent }) }}</span>
            </div>
            <template v-if="!extractTab || extractTab === 'characters'">
            <div class="asset-section-title">
              {{ t('common.role') }}
              <button class="asset-add-btn" @click="openAssetCreate('character')"><Plus :size="11" /> {{ t('common.add') }}</button>
            </div>
            <template v-if="visualChars.length">
            <div class="character-asset-grid">
              <article
                v-for="c in visualChars"
                :key="c.id"
                class="card character-asset-card"
                tabindex="0"
                role="button"
                @click="openAssetDetail('character', c)"
                @keydown.enter.prevent="openAssetDetail('character', c)"
                @keydown.space.prevent="openAssetDetail('character', c)"
              >
                <button class="asset-del-btn" :title="t('episode.asset.delChar')" :aria-label="t('episode.asset.delChar')" @click.stop="askDeleteAsset('character', c)"><Trash2 :size="11" /><span>{{ t('common.delete') }}</span></button>
                <div class="character-asset-main">
                  <div class="character-asset-overview"><div class="character-portrait">
                      <img
                        v-if="c.image_url || c.imageUrl"
                        :src="thumbOf(assetImageSrc(c))"
                        class="previewable-image"
                        loading="lazy"
                        @error="thumbFallback($event, assetImageSrc(c))"
                        @click.stop="openImageViewer(assetImageSrc(c), t('episode.asset.charImageTitle', { name: c.name }))"
                      />
                      <div v-else class="character-portrait-empty">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                      </div>
                      <span class="asset-cover-badge" :class="(c.image_url || c.imageUrl) ? 'is-ready' : (isPendingCharImage(c.id) ? 'is-pending' : '')">
                        {{ (c.image_url || c.imageUrl) ? t('episode.asset.portraitReady') : (isPendingCharImage(c.id) ? t('episode.asset.portraitPending') : t('episode.asset.portraitTodo')) }}
                      </span>
                      <MediaTime v-if="c.image_generated_at" class="asset-cover-time" :at="c.image_generated_at" />
                    </div>

                    <div class="character-asset-head">
                      <div class="character-title-block">
                        <div class="character-name-row">
                          <strong class="character-name">{{ c.name }}</strong>
                          <span class="tag">{{ c.role || t('common.role') }}</span>
                        </div>
                        <div class="character-visual-summary" :title="characterVisualSummary(c)">
                          <span>{{ t('episode.asset.appearance') }}{{ characterAppearanceValue(c) }}</span>
                          <span>{{ t('episode.asset.styling') }}{{ characterStylingValue(c) }}</span>
                        </div>
                      </div>
                      <button class="btn btn-sm character-gen-btn" :disabled="isPendingCharImage(c.id)" @click.stop="genCharImg(c.id)">
                        <Loader2 v-if="isPendingCharImage(c.id)" :size="11" class="animate-spin" />
                        {{ (c.image_url || c.imageUrl) ? t('episode.asset.regen') : (isPendingCharImage(c.id) ? t('episode.asset.generating') : t('episode.asset.generate')) }}
                      </button>
                      <button class="btn btn-sm" :title="t('episode.asset.uploadCharImage')" :disabled="isUploadingAsset('character', c.id)" @click.stop="uploadAssetImage('character', c.id)">
                        <Loader2 v-if="isUploadingAsset('character', c.id)" :size="11" class="animate-spin" />
                        <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                        {{ t('episode.asset.upload') }}
                      </button>
                      <button class="btn btn-sm" :title="t('components.mediaLibrary.pickAsset')" :disabled="isUploadingAsset('character', c.id)" @click.stop="openAssetLibrary('character', c.id)">
                        <Images :size="11" />
                        {{ t('components.mediaLibrary.pick') }}
                      </button>
                    </div>
                  </div>
                  <div v-if="assetImageRing('character', c.id)" class="asset-task-ring" @click.stop>
                    <ProgressRing
                      v-bind="assetImageRing('character', c.id)"
                      :size="36"
                      :cancellable="isAssetImageCancellable('character', c.id)"
                      retryable
                      @cancel="cancelAssetImage('character', c.id)"
                      @retry="retryAssetImage('character', c.id)"
                    />
                  </div>
                  <div class="asset-final-prompt" :title="c.final_prompt || c.finalPrompt || ''">
                    <span class="afp-label">{{ t('episode.asset.finalPromptTurnaround') }}</span>
                    <span :class="['afp-text', !(c.final_prompt || c.finalPrompt) && 'dim']">{{ c.final_prompt || c.finalPrompt || t('episode.asset.finalPromptAutoTurnaround') }}</span>
                    <FinalPromptSourceBadge :source="c.final_prompt_source || ''" :final-prompt="c.final_prompt || c.finalPrompt || ''" :updated-at="c.final_prompt_updated_at || ''" rewritable :busy="isGeneratingPrompt('character', c.id)" @rewrite="rewriteAssetPrompt('character', c.id)" />
                  </div>
                  <div v-if="c.styling_version" class="asset-styling-version">
                    <img
                      v-if="c.styling_version.image_path"
                      :src="stylingVersionSrc(c)"
                      class="styling-version-thumb"
                      :alt="c.styling_version.name"
                      @click.stop="openImageViewer(stylingVersionSrc(c), `${c.name} · ${c.styling_version.name}`)"
                    />
                    <div class="styling-version-text">
                      <span class="afp-label">{{ t('episode.asset.stylingVersion') }}</span>
                      <span class="afp-text">{{ c.styling_version.name }}</span>
                    </div>
                    <button class="btn btn-sm ml-auto" :disabled="stylingVersionBusy.includes(c.id)" @click.stop="genStylingVersionImg(c.id)">
                      <Loader2 v-if="stylingVersionBusy.includes(c.id)" :size="11" class="animate-spin" />
                      {{ c.styling_version.image_path ? t('episode.asset.regen') : t('episode.asset.generate') }}
                    </button>
                  </div>
                  <ReferenceImageManager
                    asset-type="character"
                    :asset-id="c.id"
                    :references="c.reference_images ?? c.referenceImages"
                    :drama-id="dramaId"
                    @update="onAssetRefsUpdate(c, $event)"
                    @preview="openImageViewer"
                  />
                </div>
              </article>
            </div>
            </template>
            </template>
            <template v-if="!extractTab || extractTab === 'scenes'">

            <div class="asset-section-title">
              {{ t('common.scene') }}
              <button class="asset-add-btn" @click="openAssetCreate('scene')"><Plus :size="11" /> {{ t('common.add') }}</button>
            </div>
            <template v-if="scenes.length">
            <div class="asset-grid">
              <div
                v-for="s in scenes"
                :key="s.id"
                class="card asset-card asset-click-card"
                tabindex="0"
                role="button"
                @click="openAssetDetail('scene', s)"
                @keydown.enter.prevent="openAssetDetail('scene', s)"
                @keydown.space.prevent="openAssetDetail('scene', s)"
              >
                <button class="asset-del-btn" :title="t('episode.asset.delScene')" :aria-label="t('episode.asset.delScene')" @click.stop="askDeleteAsset('scene', s)"><Trash2 :size="11" /><span>{{ t('common.delete') }}</span></button>
                <div class="asset-cover wide">
                  <img
                    v-if="s.image_url || s.imageUrl"
                    :src="thumbOf(assetImageSrc(s))"
                    class="previewable-image"
                    loading="lazy"
                    @error="thumbFallback($event, assetImageSrc(s))"
                    @click.stop="openImageViewer(assetImageSrc(s), t('episode.asset.sceneImageTitle', { name: s.location }))"
                  />
                  <div v-else class="asset-cover-empty">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                  </div>
                  <span class="asset-cover-badge" :class="(s.image_url || s.imageUrl) ? 'is-ready' : (isPendingSceneImage(s.id) ? 'is-pending' : '')">{{ (s.image_url || s.imageUrl) ? t('episode.asset.ready') : (isPendingSceneImage(s.id) ? t('episode.asset.generating') : t('episode.asset.todo')) }}</span>
                  <MediaTime v-if="s.image_generated_at" class="asset-cover-time" :at="s.image_generated_at" />
                </div>
                <div class="asset-body">
                  <div class="asset-name" :title="s.location">{{ s.location }}</div>
                  <div class="asset-meta asset-desc dim" :title="sceneDescriptionValue(s)">{{ sceneDescriptionValue(s) }}</div>
                  <div v-if="sceneLightingValue(s)" class="asset-meta asset-light dim" :title="sceneLightingValue(s)">{{ t('episode.asset.lighting') }}{{ sceneLightingValue(s) }}</div>
                  <div class="asset-meta asset-final" :class="{ dim: !(s.final_prompt || s.finalPrompt) }" :title="s.final_prompt || s.finalPrompt || ''">
                    <span class="afp-label">{{ t('episode.asset.finalPromptFixed') }}</span>
                    {{ s.final_prompt || s.finalPrompt || t('episode.asset.finalPromptAutoFixed') }}
                    <FinalPromptSourceBadge :source="s.final_prompt_source || ''" :final-prompt="s.final_prompt || s.finalPrompt || ''" :updated-at="s.final_prompt_updated_at || ''" rewritable :busy="isGeneratingPrompt('scene', s.id)" @rewrite="rewriteAssetPrompt('scene', s.id)" />
                  </div>
                  <ReferenceImageManager
                    asset-type="scene"
                    :asset-id="s.id"
                    :references="s.reference_images ?? s.referenceImages"
                    :drama-id="dramaId"
                    @update="onAssetRefsUpdate(s, $event)"
                    @preview="openImageViewer"
                  />
                </div>
                <div v-if="assetImageRing('scene', s.id)" class="asset-task-ring" @click.stop>
                  <ProgressRing
                    v-bind="assetImageRing('scene', s.id)"
                    :size="36"
                    :cancellable="isAssetImageCancellable('scene', s.id)"
                    retryable
                    @cancel="cancelAssetImage('scene', s.id)"
                    @retry="retryAssetImage('scene', s.id)"
                  />
                </div>
                <div class="asset-foot">
                  <span :class="['dot', (s.image_url || s.imageUrl) && 'ok', isPendingSceneImage(s.id) && 'pending']" />
                  <button class="btn btn-sm ml-auto" :title="t('episode.asset.uploadSceneImage')" :disabled="isUploadingAsset('scene', s.id)" @click.stop="uploadAssetImage('scene', s.id)">
                    <Loader2 v-if="isUploadingAsset('scene', s.id)" :size="11" class="animate-spin" />
                    <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                    {{ t('episode.asset.upload') }}
                  </button>
                  <button class="btn btn-sm" :title="t('components.mediaLibrary.pickAsset')" :disabled="isUploadingAsset('scene', s.id)" @click.stop="openAssetLibrary('scene', s.id)">
                    <Images :size="11" />
                    {{ t('components.mediaLibrary.pick') }}
                  </button>
                  <button class="btn btn-sm" :disabled="isPendingSceneImage(s.id)" @click.stop="genSceneImg(s.id)">
                    <Loader2 v-if="isPendingSceneImage(s.id)" :size="11" class="animate-spin" />
                    {{ (s.image_url || s.imageUrl) ? t('episode.asset.regen') : (isPendingSceneImage(s.id) ? t('episode.asset.generating') : t('episode.asset.generate')) }}
                  </button>
                </div>
              </div>
            </div>
            </template>

            </template>
            <template v-if="!extractTab || extractTab === 'props'">
            <div class="asset-section-title">
              {{ t('common.prop') }}
              <button class="asset-add-btn" @click="openAssetCreate('prop')"><Plus :size="11" /> {{ t('common.add') }}</button>
            </div>
            <div v-if="propItems.length" class="asset-grid">
              <div
                v-for="p in propItems"
                :key="p.id"
                class="card asset-card asset-click-card prop-card"
                tabindex="0"
                role="button"
                @click="openAssetDetail('prop', p)"
                @keydown.enter.prevent="openAssetDetail('prop', p)"
                @keydown.space.prevent="openAssetDetail('prop', p)"
              >
                <button class="asset-del-btn" :title="t('episode.asset.delProp')" :aria-label="t('episode.asset.delProp')" @click.stop="askDeleteAsset('prop', p)"><Trash2 :size="11" /><span>{{ t('common.delete') }}</span></button>
                <div class="asset-cover wide">
                  <img
                    v-if="p.image_url || p.imageUrl"
                    :src="thumbOf(assetImageSrc(p))"
                    class="previewable-image"
                    loading="lazy"
                    @error="thumbFallback($event, assetImageSrc(p))"
                    @click.stop="openImageViewer(assetImageSrc(p), t('episode.asset.propImageTitle', { name: p.name }))"
                  />
                  <div v-else class="asset-cover-empty">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
                  </div>
                  <span class="asset-cover-badge" :class="(p.image_url || p.imageUrl) ? 'is-ready' : (isPendingPropImage(p.id) ? 'is-pending' : '')">{{ (p.image_url || p.imageUrl) ? t('episode.asset.ready') : (isPendingPropImage(p.id) ? t('episode.asset.generating') : t('episode.asset.todo')) }}</span>
                  <MediaTime v-if="p.image_generated_at" class="asset-cover-time" :at="p.image_generated_at" />
                </div>
                <div class="asset-body">
                  <div class="prop-name-row">
                    <span class="asset-name" :title="p.name">{{ p.name }}</span>
                    <span class="tag">{{ p.type || t('common.prop') }}</span>
                    <span v-if="p.faithful" class="tag asset-faithful-tag" :title="t('episode.asset.faithfulHint')">{{ t('episode.asset.faithfulBadge') }}</span>
                  </div>
                  <div class="asset-meta asset-desc dim" :title="p.description || ''">{{ p.description || t('episode.asset.noDescription') }}</div>
                  <div class="asset-meta asset-final" :class="{ dim: !(p.final_prompt || p.finalPrompt) }" :title="p.final_prompt || p.finalPrompt || ''">
                    <span class="afp-label">{{ t('episode.asset.finalPromptWhiteBg') }}</span>
                    {{ p.final_prompt || p.finalPrompt || t('episode.asset.finalPromptAutoWhiteBg') }}
                    <FinalPromptSourceBadge :source="p.final_prompt_source || ''" :final-prompt="p.final_prompt || p.finalPrompt || ''" :updated-at="p.final_prompt_updated_at || ''" :rewritable="!p.faithful" :busy="isGeneratingPrompt('prop', p.id)" @rewrite="rewriteAssetPrompt('prop', p.id)" />
                  </div>
                  <ReferenceImageManager
                    asset-type="prop"
                    :asset-id="p.id"
                    :references="p.reference_images ?? p.referenceImages"
                    :drama-id="dramaId"
                    @update="onAssetRefsUpdate(p, $event)"
                    @preview="openImageViewer"
                  />
                </div>
                <div v-if="assetImageRing('prop', p.id)" class="asset-task-ring" @click.stop>
                  <ProgressRing
                    v-bind="assetImageRing('prop', p.id)"
                    :size="36"
                    :cancellable="isAssetImageCancellable('prop', p.id)"
                    retryable
                    @cancel="cancelAssetImage('prop', p.id)"
                    @retry="retryAssetImage('prop', p.id)"
                  />
                </div>
                <div class="asset-foot">
                  <span :class="['dot', (p.image_url || p.imageUrl) && 'ok', isPendingPropImage(p.id) && 'pending']" />
                  <button class="btn btn-sm ml-auto" :title="t('episode.asset.uploadPropImage')" :disabled="isUploadingAsset('prop', p.id)" @click.stop="uploadAssetImage('prop', p.id)">
                    <Loader2 v-if="isUploadingAsset('prop', p.id)" :size="11" class="animate-spin" />
                    <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                    {{ t('episode.asset.upload') }}
                  </button>
                  <button class="btn btn-sm" :title="t('components.mediaLibrary.pickAsset')" :disabled="isUploadingAsset('prop', p.id)" @click.stop="openAssetLibrary('prop', p.id)">
                    <Images :size="11" />
                    {{ t('components.mediaLibrary.pick') }}
                  </button>
                  <button v-if="!p.faithful" class="btn btn-sm" :disabled="isPendingPropImage(p.id)" @click.stop="genPropImg(p.id)">
                    <Loader2 v-if="isPendingPropImage(p.id)" :size="11" class="animate-spin" />
                    {{ (p.image_url || p.imageUrl) ? t('episode.asset.regen') : (isPendingPropImage(p.id) ? t('episode.asset.generating') : t('episode.asset.generate')) }}
                  </button>
                </div>
              </div>
            </div>
            <div v-else class="asset-props-empty">{{ t('episode.asset.propsEmpty') }}</div>
            </template>
            </template>
          </div>

          <!-- Sub: Poster（资产后独立一步，可跳过；Issue #39） -->
          <div v-if="prodTab === 'poster'" class="prod-content">
            <PosterPanel
              :episode-id="epId"
              :aspect-ratio="drama?.aspect_ratio || '16:9'"
              :model="bareModelName(imageModel)"
              :config-id="ownerConfigId(imageModelOptions, imageModel)"
              :chat-model="chatModelOverride() || ''"
              :chat-config-id="chatConfigId() || 0"
            />
          </div>

          <!-- Sub: 分镜设计（纪录片 #54 起由 DesignCardPanel 承载；R4 用设计卡替换其内部） -->
          <DesignCardPanel
            v-if="prodTab === 'design'"
            :episode-id="epId"
            :storyboards="sbs"
            :chat-model="chatModelOverride() || ''"
            :chat-config-id="chatConfigId() || 0"
            :narration-voice-batch="narrationVoiceBatch"
            @refresh="refresh"
            @batch-narration-voice="batchNarrationVoice"
          />

          <!-- Sub: 分镜关键帧（剧情专用；纪录片走「分镜制作」步） -->
          <StoryboardKeyframes
            v-if="prodTab === 'keyframes' && !isDocumentaryProject"
            :episode-id="epId"
            :storyboards="sbs"
            :pool-candidates="shotPoolCandidates"
            :set-pool-asset="setShotPoolAsset"
            :target-assets-for="shotTargetAssets"
            :asset-versions-for="targetAssetVersions"
            :set-target-version="setTargetAssetVersion"
            :mention-options-for="shotMentionOptions"
            :ref-kinds="REF_KINDS"
            :image-model="bareModelName(imageModel)"
            :image-config-id="ownerConfigId(imageModelOptions, imageModel) || 0"
            :image-model-label="effectiveImageModelLabel"
            :chat-model="chatModelOverride() || ''"
            :chat-config-id="chatConfigId() || 0"
            :aspect-ratio="dramaAspectRatio"
            :breaking="rt === 'storyboard_breaker'"
            :agent-busy="rn"
            :field-save="fieldSaveInfo"
            :narration-enabled="narrationEnabledOf"
            :episode-timing="episodeSubtitleTiming"
            :episode-mix-mode="episodeAudioMixMode"
            :episode-fit-default="episodeFitDefault"
            :episode-normalize="episodeNarrationNormalize"
            :narration-batch="narrationBatch"
            :narration-voice-batch="narrationVoiceBatch"
            @break="doBreakdown"
            @refresh="refresh"
            @preview="openImageViewer"
            @goto-assets="prodTab = 'assets'"
            @open-asset="openPoolAssetDetail"
            @update-field="updateField"
            @field-dirty="markFieldDirty"
            @batch-narration="batchNarration"
            @batch-narration-voice="batchNarrationVoice"
            @open-narration-settings="narrationSettingsOpen = true"
          />

          <!-- Sub: 分镜制作（#58）：一镜 = ▣ 图层段 + ▶ 生成段；剧情项目的 videos 页签走同一工作区 -->
          <ShotProductionPanel
            v-if="prodTab === 'production'"
            :episode-id="Number(epId) || 0"
            :drama-id="Number(drama?.id) || 0"
            :focus-storyboard-id="productionFocusSbId"
            :storyboards="sbs"
            :pool-candidates="shotPoolCandidates"
            :set-pool-asset="setShotPoolAsset"
            :target-assets-for="shotTargetAssets"
            :asset-versions-for="targetAssetVersions"
            :set-target-version="setTargetAssetVersion"
            :mention-options-for="shotMentionOptions"
            :ref-kinds="REF_KINDS"
            :image-model="bareModelName(imageModel)"
            :image-config-id="ownerConfigId(imageModelOptions, imageModel) || 0"
            :image-model-label="effectiveImageModelLabel"
            :chat-model="chatModelOverride() || ''"
            :chat-config-id="chatConfigId() || 0"
            :aspect-ratio="dramaAspectRatio"
            :breaking="rt === 'storyboard_breaker'"
            :agent-busy="rn"
            :field-save="fieldSaveInfo"
            :narration-enabled="narrationEnabledOf"
            :episode-timing="episodeSubtitleTiming"
            :episode-mix-mode="episodeAudioMixMode"
            :episode-fit-default="episodeFitDefault"
            :episode-normalize="episodeNarrationNormalize"
            :narration-batch="narrationBatch"
            :narration-voice-batch="narrationVoiceBatch"
            @break="doBreakdown"
            @refresh="refresh"
            @preview="openImageViewer"
            @goto-assets="prodTab = 'assets'"
            @goto-design="prodTab = 'design'"
            @open-asset="openPoolAssetDetail"
            @update-field="updateField"
            @field-dirty="markFieldDirty"
            @batch-narration="batchNarration"
            @batch-narration-voice="batchNarrationVoice"
            @open-narration-settings="narrationSettingsOpen = true"
          />

          <!-- Sub: Video Production（视频提示词 + 视频生成，关键帧确认后可用） -->
          <!-- Sub: 视频与成品（#54 起由 VideoShotPanel 承载；剧情 videos 页签与纪录片 final 步共用） -->
          <VideoShotPanel v-if="prodTab === 'videos' || prodTab === 'final'" />

          <!-- Production Navigator -->
        </template>
      </div>

      <!-- ===== EXPORT PANEL ===== -->
      <!-- 门禁锁定（#54）：导出需要至少一镜成品最新；锁定或门禁未判定时都只给原因与出路 -->
      <div v-else-if="stageLocked('export')" class="content-panel">
        <div class="step-empty" style="flex:1">
          <div class="empty-visual"><Lock :size="32" /></div>
          <div class="empty-title">{{ stageGateUnknown('export') ? t('episode.gate.checking') : t('episode.gate.locked') }}</div>
          <div class="empty-desc">{{ stageLockReason('export') }}</div>
          <button v-if="stageGateUnknown('export')" class="btn" @click="refreshGates()">{{ t('episode.sidebar.refreshData') }}</button>
          <button v-else class="btn btn-primary" @click="goStageBlocker('export')">{{ t('episode.gate.goFix') }}</button>
        </div>
      </div>
      <ExportPanel v-else />

      <div v-if="assetDetail.open && assetDetail.item" class="overlay asset-detail-overlay" @click.self="closeAssetDetail">
        <section
          class="dialog asset-detail-dialog"
          role="dialog"
          aria-modal="true"
          :aria-label="t('episode.asset.detailTitle', { type: assetTypeLabel(assetDetail.type) })"
        >
          <header class="dialog-head asset-detail-head">
            <div class="asset-detail-title-block">
              <span class="asset-detail-kicker">{{ assetTypeLabel(assetDetail.type) }}</span>
              <h2 class="asset-detail-title">{{ assetDetailTitle(assetDetail) }}</h2>
            </div>
            <div class="asset-detail-head-actions">
              <span class="tag" v-if="assetDetail.type === 'character'">{{ assetDetail.item.role || t('common.role') }}</span>
              <span class="tag" v-else-if="assetDetail.type === 'prop'">{{ assetDetail.item.type || t('common.prop') }}</span>
              <span class="tag" v-else>{{ assetDetail.item.time || t('episode.asset.noTime') }}</span>
              <span v-if="assetDetailFaithful" class="tag asset-faithful-tag" :title="t('episode.asset.faithfulHint')">{{ t('episode.asset.faithfulBadge') }}</span>
              <button class="btn btn-ghost btn-icon" @click="closeAssetDetail">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
          </header>

          <div class="dialog-body asset-detail-body">
            <div class="asset-detail-shell">
              <aside class="asset-detail-preview-panel">
                <div class="asset-detail-section-title">
                  <span>{{ t('episode.asset.visualPreview') }}</span>
                  <span :class="['asset-detail-state', assetImageSrc(assetDetail.item) ? 'is-ready' : '']">
                    {{ assetImageSrc(assetDetail.item) ? t('episode.asset.ready') : t('episode.asset.todo') }}
                  </span>
                </div>

                <button
                  type="button"
                  class="asset-detail-media-frame"
                  :disabled="!assetImageSrc(assetDetail.item)"
                  @click.stop="openImageViewer(assetImageSrc(assetDetail.item), assetDetailImageTitle(assetDetail))"
                >
                  <img
                    v-if="assetImageSrc(assetDetail.item)"
                    :src="thumbOf(assetImageSrc(assetDetail.item))"
                    class="previewable-image"
                    @error="thumbFallback($event, assetImageSrc(assetDetail.item))"
                  />
                  <span v-else class="asset-detail-media-empty">
                    <svg v-if="assetDetail.type === 'character'" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                    <svg v-else-if="assetDetail.type === 'prop'" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
                    <svg v-else width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                  </span>
                </button>
                <MediaTime v-if="assetDetail.item?.image_generated_at" class="asset-detail-media-time" :at="assetDetail.item.image_generated_at" />

                <section v-if="assetVersions(assetDetail.item).length" class="asset-version-panel">
                  <div class="asset-version-head">
                    <strong>{{ t('episode.asset.versions') }}</strong>
                    <span>{{ t('episode.asset.versionCount', { n: assetVersions(assetDetail.item).length }) }}</span>
                  </div>
                  <div class="asset-version-list">
                    <button
                      v-for="version in assetVersions(assetDetail.item)"
                      :key="version.id ?? version.url"
                      type="button"
                      :class="['asset-version-card', { current: isCurrentAssetVersion(assetDetail.item, version) }]"
                      :title="isCurrentAssetVersion(assetDetail.item, version) ? t('episode.asset.currentVersion') : t('episode.asset.useVersion')"
                      :disabled="switchingAssetVersion"
                      @click="selectAssetVersion(version)"
                    >
                      <img :src="thumbOf(versionImageSrc(version))" loading="lazy" @error="thumbFallback($event, versionImageSrc(version))" />
                      <span class="asset-version-meta">{{ version.provider || t('episode.asset.unknownEngine') }}<template v-if="version.model"> · {{ version.model }}</template></span>
                      <MediaTime :at="version.generated_at" />
                      <span v-if="isCurrentAssetVersion(assetDetail.item, version)" class="asset-version-current">{{ t('episode.asset.currentVersion') }}</span>
                    </button>
                  </div>
                  <p class="asset-version-hint">{{ t('episode.asset.versionHint') }}</p>
                </section>

                <div class="asset-detail-meta-row">
                  <div class="asset-detail-meta-item">
                    <span>{{ t('episode.asset.kindLabel') }}</span>
                    <strong>{{ assetDetail.type === 'character' ? t('episode.asset.charPortrait') : assetDetail.type === 'prop' ? t('common.prop') : t('episode.asset.sceneImage') }}</strong>
                  </div>
                  <div class="asset-detail-meta-item">
                    <span>{{ assetDetail.type === 'character' ? t('episode.asset.roleLabel') : assetDetail.type === 'prop' ? t('episode.asset.propTypeLabel') : t('episode.asset.timeLabel') }}</span>
                    <strong>{{ assetDetail.type === 'character' ? (assetDetail.item.role || t('common.role')) : assetDetail.type === 'prop' ? (assetDetail.item.type || t('common.prop')) : (assetDetail.item.time || t('episode.asset.noTime')) }}</strong>
                  </div>
                </div>
              </aside>

              <section class="asset-detail-editor-panel">
                <div class="asset-detail-section-title">
                  <span>{{ t('episode.asset.editInfo') }}</span>
                  <span class="dim">{{ assetDetail.type === 'character' ? t('episode.asset.editHintChar') : assetDetail.type === 'prop' ? t('episode.asset.editHintProp') : t('episode.asset.editHintScene') }}</span>
                </div>

                <div v-if="assetDetail.type === 'scene'" class="asset-detail-time-row">
                  <span class="asset-detail-time-label">{{ t('episode.asset.timeLabel') }}</span>
                  <select
                    class="input asset-detail-time-select"
                    :value="TIME_PERIODS.includes(assetDetailDraft.time) ? assetDetailDraft.time : '__custom__'"
                    :aria-label="t('episode.asset.timeLabel')"
                    @change="onSceneTimePreset($event.target.value)"
                  >
                    <option v-for="period in TIME_PERIODS" :key="period" :value="period">{{ timePeriodLabel(period) }}</option>
                    <option value="__custom__">{{ t('episode.asset.timeCustom') }}</option>
                  </select>
                  <input
                    v-model="assetDetailDraft.time"
                    class="input asset-detail-time-input"
                    :placeholder="t('episode.asset.timePlaceholder')"
                    :aria-label="t('episode.asset.timeCustom')"
                  />
                  <span class="dim asset-detail-time-hint">{{ t('episode.asset.timeHint') }}</span>
                </div>

                <div v-if="assetDetail.type === 'prop'" class="asset-detail-edit-grid asset-detail-edit-grid--prop">
                  <label class="asset-detail-edit-field">
                    <span>{{ t('episode.asset.appearanceOfObject') }}</span>
                    <textarea
                      v-model="assetDetailDraft.description"
                      class="textarea asset-detail-textarea"
                      rows="6"
                      :placeholder="t('episode.asset.appearancePlaceholder')"
                    />
                  </label>
                </div>

                <div v-else :class="['asset-detail-edit-grid', `asset-detail-edit-grid--${assetDetail.type}`]">
                  <label v-if="assetDetail.type === 'character'" class="asset-detail-edit-field">
                    <span>{{ t('episode.asset.appearanceField') }}</span>
                    <textarea
                      v-model="assetDetailDraft.appearance"
                      class="textarea asset-detail-textarea"
                      rows="6"
                      :placeholder="t('episode.asset.appearanceFieldPlaceholder')"
                    />
                  </label>
                  <label v-if="assetDetail.type === 'character'" class="asset-detail-edit-field">
                    <span>{{ t('episode.asset.stylingField') }}</span>
                    <textarea
                      v-model="assetDetailDraft.styling"
                      class="textarea asset-detail-textarea"
                      rows="6"
                      :placeholder="t('episode.asset.stylingFieldPlaceholder')"
                    />
                  </label>
                  <label v-if="assetDetail.type === 'scene'" class="asset-detail-edit-field">
                    <span>{{ t('episode.asset.sceneDescField') }}</span>
                    <textarea
                      v-model="assetDetailDraft.prompt"
                      class="textarea asset-detail-textarea"
                      rows="5"
                      :placeholder="t('episode.asset.sceneDescPlaceholder')"
                    />
                  </label>
                  <label v-if="assetDetail.type === 'scene'" class="asset-detail-edit-field">
                    <span>{{ t('episode.asset.sceneLightField') }}</span>
                    <textarea
                      v-model="assetDetailDraft.lighting"
                      class="textarea asset-detail-textarea"
                      rows="5"
                      :placeholder="t('episode.asset.sceneLightPlaceholder')"
                    />
                  </label>
                </div>

              </section>
            </div>

            <section class="asset-detail-ref-panel">
              <div class="asset-detail-section-title">
                <span>{{ t('episode.asset.refSectionTitle') }}</span>
                <span class="dim">{{ t('episode.asset.refSectionHint') }}</span>
              </div>
              <ReferenceImageManager
                :key="`${assetDetail.type}-${assetDetail.item.id}`"
                :asset-type="assetDetail.type"
                :asset-id="assetDetail.item.id"
                :references="assetDetail.item.reference_images ?? assetDetail.item.referenceImages"
                :drama-id="dramaId"
                size="large"
                @update="onAssetRefsUpdate(assetDetail.item, $event)"
                @preview="openImageViewer"
              />
            </section>

            <section v-if="assetDetail.type === 'character'" class="asset-detail-ref-panel">
              <div class="asset-detail-section-title">
                <span>{{ t('episode.documentary.archivalSectionTitle') }}</span>
                <span class="dim">{{ t('episode.documentary.archivalSectionHint') }}</span>
              </div>
              <ArchivalImagePanel
                :key="`archival-${assetDetail.item.id}`"
                :character-id="assetDetail.item.id"
                :archival-images="assetDetail.item.archival_images ?? assetDetail.item.archivalImages"
                :episode-id="epId"
                @update="onAssetArchivalUpdate(assetDetail.item, $event)"
                @appearance="onAssetAppearanceFromPortrait(assetDetail.item, $event)"
                @preview="openImageViewer"
              />
            </section>

            <!-- 证据素材与语义标注（Issue #47）：忠实素材只做标注与底图切换，不走生图 -->
            <section v-if="assetDetail.type === 'prop'" class="asset-detail-ref-panel">
              <div class="asset-detail-section-title">
                <span>{{ t('episode.documentary.semantics.sectionTitle') }}</span>
                <span class="dim">{{ t('episode.documentary.semantics.sectionHint') }}</span>
              </div>
              <label class="asset-faithful-toggle">
                <input
                  type="checkbox"
                  :checked="!!assetDetail.item.faithful"
                  :disabled="faithfulSaving"
                  @change="onFaithfulToggle($event.target.checked)"
                />
                <span>{{ t('episode.asset.faithfulToggle') }}</span>
              </label>
              <p class="asset-faithful-hint dim">{{ t('episode.asset.faithfulHint') }}</p>
              <PropSemanticsPanel
                :key="`semantics-${assetDetail.item.id}`"
                :prop-id="assetDetail.item.id"
                :episode-id="epId"
                :faithful="assetDetail.item.faithful || 0"
                :faithful-source="assetDetail.item.faithful_source ?? null"
                :semantics="assetDetail.item.semantics ?? null"
                :image-versions="assetVersions(assetDetail.item)"
                :focus-semantic-id="focusSemanticId"
                @update="onAssetSemanticsUpdate(assetDetail.item, $event)"
                @preview="openImageViewer"
              />
              <button
                v-if="!assetDetail.item.map_spec && mapDraftAssetId !== assetDetail.item.id"
                class="btn btn-sm"
                type="button"
                @click="mapDraftAssetId = assetDetail.item.id"
              >
                {{ t('episode.documentary.map.create') }}
              </button>
              <MapSpecPanel
                v-if="assetDetail.item.map_spec || mapDraftAssetId === assetDetail.item.id"
                :key="`mapspec-${assetDetail.item.id}`"
                :prop-id="assetDetail.item.id"
                :episode-id="epId"
                :creating="!assetDetail.item.map_spec"
                @cancel="mapDraftAssetId = null"
                @update="onAssetMapSpecUpdate(assetDetail.item, $event)"
              />
            </section>

            <!-- 资产「精确→美化」流水线（Issue #56）：三类资产通用，闸门结论由后端计算 -->
            <section class="asset-detail-ref-panel">
              <div class="asset-detail-section-title">
                <span>{{ t('episode.documentary.pipeline.sectionTitle') }}</span>
                <span class="dim">{{ t('episode.documentary.pipeline.sectionHint') }}</span>
              </div>
              <AssetPipelinePanel
                :key="`pipeline-${assetDetail.type}-${assetDetail.item.id}`"
                :asset-kind="assetDetail.type"
                :asset-id="assetDetail.item.id"
                :episode-id="epId"
                :asset-name="assetDetail.item.name"
                :map-configured="assetDetail.type === 'prop' && !!assetDetail.item.map_spec"
                @preview="openImageViewer"
              />
            </section>

            <section class="asset-detail-ref-panel">
              <div class="asset-detail-section-title">
                <span>{{ t('episode.documentary.citationsSectionTitle') }}</span>
                <span class="dim">{{ t('episode.documentary.citationsSectionHint') }}</span>
              </div>
              <ResearchCitationList
                :key="`cite-${assetDetail.type}-${assetDetail.item.id}`"
                :asset-kind="assetDetail.type"
                :asset-id="assetDetail.item.id"
              />
            </section>

            <section class="asset-detail-prompt-panel">
              <div class="asset-detail-section-title">
                <span>{{ assetDetail.type === 'character' ? t('episode.asset.finalPromptTurnaround') : assetDetail.type === 'scene' ? t('episode.asset.finalPromptFixed') : t('episode.asset.finalPromptWhiteBg') }}</span>
                <div class="asset-detail-prompt-head-actions">
                  <button
                    v-if="!assetDetailFaithful"
                    class="btn btn-sm"
                    :disabled="isGeneratingPrompt(assetDetail.type, assetDetail.item.id) || isAssetImagePending(assetDetail.type, assetDetail.item.id)"
                    @click="genAssetFinalPrompt"
                  >
                    <Loader2 v-if="isGeneratingPrompt(assetDetail.type, assetDetail.item.id)" :size="11" class="animate-spin" />
                    {{ isGeneratingPrompt(assetDetail.type, assetDetail.item.id) ? t('episode.asset.generating') : (assetFinalPrompt ? t('episode.asset.regenPrompt') : t('episode.asset.genPrompt')) }}
                  </button>
                  <span :class="['asset-detail-state', assetFinalPrompt && 'is-ready']">
                    {{ assetFinalPrompt ? t('episode.asset.ready') : t('episode.asset.todo') }}
                  </span>
                  <span v-if="assetDetailFaithful" class="dim asset-faithful-hint">{{ t('episode.asset.faithfulNoGen') }}</span>
                  <FinalPromptSourceBadge
                    :source="assetDetail.item.final_prompt_source || ''"
                    :final-prompt="assetFinalPrompt"
                    :updated-at="assetDetail.item.final_prompt_updated_at || ''"
                    :rewritable="!assetDetailFaithful"
                    show-time
                    :busy="isGeneratingPrompt(assetDetail.type, assetDetail.item.id)"
                    @rewrite="genAssetFinalPrompt"
                  />
                  <button
                    v-if="assetPromptDraft"
                    class="btn btn-ghost btn-sm asset-detail-copy-btn"
                    @click="copyAssetFinalPrompt"
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                    {{ t('common.copy') }}
                  </button>
                </div>
              </div>
              <textarea
                :value="assetPromptDraft"
                @input="onAssetPromptInput"
                class="textarea asset-detail-prompt-textarea"
                rows="5"
                :placeholder="assetDetail.type === 'character'
                  ? t('episode.asset.promptPlaceholderChar')
                  : assetDetail.type === 'scene'
                    ? t('episode.asset.promptPlaceholderScene')
                    : t('episode.asset.promptPlaceholderProp')"
              />
              <p class="asset-detail-prompt-hint">
                {{ assetDetail.type === 'character'
                  ? t('episode.asset.promptHintChar')
                  : assetDetail.type === 'scene'
                    ? t('episode.asset.promptHintScene')
                    : t('episode.asset.promptHintProp') }}
              </p>
            </section>
          </div>

          <footer class="dialog-foot asset-detail-foot">
            <div class="asset-detail-secondary-actions">
              <button class="btn btn-danger" @click="askDeleteAsset(assetDetail.type, assetDetail.item)">{{ t('common.delete') }}</button>
              <button
                class="btn"
                :disabled="isReExtracting(assetDetail.type, assetDetail.item.id) || isExtracting(extractTargetOf(assetDetail.type))"
                :title="t('episode.documentary.reExtractHint')"
                @click="askReExtract"
              >
                <Loader2 v-if="isReExtracting(assetDetail.type, assetDetail.item.id) || isExtracting(extractTargetOf(assetDetail.type))" :size="11" class="animate-spin" />
                {{ t('episode.documentary.reExtract') }}
              </button>
              <button class="btn" @click="closeAssetDetail">{{ t('common.close') }}</button>
            </div>
            <div class="asset-detail-primary-actions">
              <button
                class="btn"
                :disabled="isUploadingAsset(assetDetail.type, assetDetail.item.id)"
                @click="uploadAssetImage(assetDetail.type, assetDetail.item.id)"
              >
                <Loader2 v-if="isUploadingAsset(assetDetail.type, assetDetail.item.id)" :size="11" class="animate-spin" />
                <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                {{ t('episode.asset.uploadImage') }}
              </button>
              <button
                class="btn"
                :disabled="isUploadingAsset(assetDetail.type, assetDetail.item.id)"
                @click="openAssetLibrary(assetDetail.type, assetDetail.item.id)"
              >
                <Images :size="11" />
                {{ t('components.mediaLibrary.pickAsset') }}
              </button>
              <button
                v-if="assetDetail.type === 'character'"
                class="btn"
                :disabled="isPendingCharImage(assetDetail.item.id)"
                @click="genCharImg(assetDetail.item.id)"
              >
                {{ assetImageSrc(assetDetail.item) ? t('episode.asset.regenPortrait') : (isPendingCharImage(assetDetail.item.id) ? t('episode.asset.generating') : t('episode.asset.genPortrait')) }}
              </button>
              <button
                v-else-if="assetDetail.type === 'scene'"
                class="btn"
                :disabled="isPendingSceneImage(assetDetail.item.id)"
                @click="genSceneImg(assetDetail.item.id)"
              >
                {{ assetImageSrc(assetDetail.item) ? t('episode.asset.regenScene') : (isPendingSceneImage(assetDetail.item.id) ? t('episode.asset.generating') : t('episode.asset.genScene')) }}
              </button>
              <button
                v-else-if="assetDetail.type === 'prop' && !assetDetailFaithful"
                class="btn"
                :disabled="isPendingPropImage(assetDetail.item.id)"
                @click="genPropImg(assetDetail.item.id)"
              >
                {{ assetImageSrc(assetDetail.item) ? t('episode.asset.regenProp') : (isPendingPropImage(assetDetail.item.id) ? t('episode.asset.generating') : t('episode.asset.genProp')) }}
              </button>
              <button class="btn btn-primary" :disabled="savingAssetDetail" @click="saveAssetDetail">
                <Loader2 v-if="savingAssetDetail" :size="12" class="animate-spin" />
                {{ t('episode.asset.saveChanges') }}
              </button>
            </div>
          </footer>
        </section>
      </div>

      <div v-if="imageViewer.open && imageViewer.src" class="overlay image-viewer-overlay" @click.self="closeImageViewer">
        <div class="dialog image-viewer-dialog">
          <div class="image-viewer-head">
            <div class="image-viewer-title">{{ imageViewer.title || t('episode.viewer.imagePreview') }}</div>
            <button class="btn btn-ghost btn-icon" @click="closeImageViewer">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <div class="image-viewer-body">
            <img :src="imageViewer.src" :alt="imageViewer.title || t('episode.viewer.imagePreview')" class="image-viewer-img" />
          </div>
        </div>
      </div>

      <div v-if="previewShot" class="overlay image-viewer-overlay" @click.self="previewShot = null">
        <div class="dialog image-viewer-dialog merge-viewer-dialog">
          <div class="image-viewer-head">
            <div class="image-viewer-title">{{ t('episode.export.shotPreview', { n: shotNumberOf(previewShot) }) }}</div>
            <span v-if="previewShot.duration" class="dim" style="font-size:11px">{{ previewShot.duration }}s</span>
            <a :href="mediaUrl(getVideoUrl(previewShot))" download class="btn btn-sm" style="margin-left:auto">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              {{ t('common.download') }}
            </a>
            <button class="btn btn-ghost btn-icon" @click="previewShot = null">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <div class="merge-viewer-body">
            <video
              :key="previewShot.id"
              :src="mediaUrl(getVideoUrl(previewShot))"
              controls
              autoplay
              playsinline
              class="merge-viewer-video"
            />
          </div>
        </div>
      </div>

      <div v-if="activeMerge" class="overlay image-viewer-overlay" @click.self="activeMerge = null">
        <div class="dialog image-viewer-dialog merge-viewer-dialog">
          <div class="image-viewer-head">
            <div class="image-viewer-title">{{ t('episode.viewer.filmPreview') }}</div>
            <span class="dim" style="font-size:11px"><MediaTime :at="activeMerge.generated_at || activeMerge.created_at_unix" /><template v-if="activeMerge.duration"> · {{ activeMerge.duration }}s</template></span>
            <a :href="mediaUrl(activeMerge.merged_url)" download class="btn btn-sm" style="margin-left:auto">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              {{ t('episode.viewer.downloadFilm') }}
            </a>
            <button class="btn btn-ghost btn-icon" @click="activeMerge = null">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <div class="merge-viewer-body">
            <video
              :key="activeMerge.id"
              :src="mediaUrl(activeMerge.merged_url)"
              controls
              autoplay
              playsinline
              class="merge-viewer-video"
            />
          </div>
        </div>
      </div>

      <div v-if="roster.open" class="overlay" @click.self="roster.open = false">
        <div class="dialog roster-dialog">
          <header class="dialog-head">
            <h2 class="dialog-title">{{ t('episode.roster.title') }}</h2>
            <button class="btn btn-ghost btn-icon" @click="roster.open = false">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </header>
          <div class="dialog-body roster-body">
            <div class="roster-status">
              <span v-if="!roster.exists" class="roster-badge roster-badge-none">{{ t('episode.roster.statusNone') }}</span>
              <span v-else-if="roster.status === 'approved'" class="roster-badge roster-badge-approved">{{ t('episode.roster.statusApproved') }}</span>
              <span v-else class="roster-badge roster-badge-draft">{{ t('episode.roster.statusDraft') }}</span>
              <span v-if="roster.stale" class="roster-badge roster-badge-stale">{{ t('episode.roster.statusStale') }}</span>
              <span v-if="roster.updated_at" class="dim roster-updated">{{ roster.updated_at }}</span>
            </div>
            <div class="roster-hint dim">{{ t('episode.roster.hint') }}</div>
            <div v-if="roster.loading" class="roster-empty">{{ t('common.loading') }}</div>
            <template v-else>
              <div v-if="!roster.cast.length" class="roster-empty">{{ t('episode.roster.empty') }}</div>
              <div v-for="(member, idx) in roster.cast" :key="idx" class="roster-row">
                <div class="roster-row-head">
                  <input v-model="member.name" class="input roster-name" :placeholder="t('episode.roster.namePlaceholder')" />
                  <span class="roster-source" :class="member.source === 'human' ? 'roster-source-human' : 'roster-source-agent'">
                    {{ member.source === 'human' ? t('episode.roster.sourceHuman') : t('episode.roster.sourceAgent') }}
                  </span>
                  <button class="btn btn-ghost btn-icon" :title="t('common.delete')" @click="roster.cast.splice(idx, 1)">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </button>
                </div>
                <input v-model="member.reason" class="input roster-reason" :placeholder="t('episode.roster.reasonPlaceholder')" />
                <textarea v-model="member.basis" class="textarea roster-basis" rows="2" :placeholder="t('episode.roster.basisPlaceholder')" />
              </div>
              <button class="btn btn-sm roster-add" @click="roster.cast.push({ name: '', basis: '', reason: '', source: 'human' })">
                <Plus :size="11" /> {{ t('episode.roster.add') }}
              </button>
            </template>
          </div>
          <footer class="dialog-foot">
            <button class="btn" @click="roster.open = false">{{ t('common.cancel') }}</button>
            <button class="btn" :disabled="roster.saving" @click="saveRoster('draft')">{{ t('episode.roster.saveDraft') }}</button>
            <button class="btn btn-primary" :disabled="roster.saving" @click="saveRoster('approved')">
              <Loader2 v-if="roster.saving" :size="12" class="animate-spin" />
              {{ t('episode.roster.confirm') }}
            </button>
          </footer>
        </div>
      </div>

      <div v-if="assetCreate.open" class="overlay" @click.self="assetCreate.open = false">
        <div class="dialog asset-create-dialog">
          <header class="dialog-head">
            <h2 class="dialog-title">{{ t('episode.create.title', { type: assetCreateTypeLabel }) }}</h2>
            <button class="btn btn-ghost btn-icon" @click="assetCreate.open = false">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </header>
          <div class="dialog-body asset-create-body">
            <template v-if="assetCreate.type === 'character'">
              <label class="field"><span class="field-label">{{ t('episode.create.name') }}</span><input v-model="assetCreateDraft.name" class="input" :placeholder="t('episode.create.namePlaceholderChar')" /></label>
              <label class="field"><span class="field-label">{{ t('episode.create.roleField') }}</span><input v-model="assetCreateDraft.role" class="input" :placeholder="t('episode.create.rolePlaceholder')" /></label>
              <label class="field"><span class="field-label">{{ t('episode.asset.appearanceField') }}</span><textarea v-model="assetCreateDraft.appearance" class="textarea" rows="3" :placeholder="t('episode.create.appearancePlaceholder')" /></label>
              <label class="field"><span class="field-label">{{ t('episode.asset.stylingField') }}</span><textarea v-model="assetCreateDraft.styling" class="textarea" rows="2" :placeholder="t('episode.create.stylingPlaceholder')" /></label>
            </template>
            <template v-else-if="assetCreate.type === 'scene'">
              <label class="field"><span class="field-label">{{ t('episode.create.location') }}</span><input v-model="assetCreateDraft.location" class="input" :placeholder="t('episode.create.locationPlaceholder')" /></label>
              <label class="field"><span class="field-label">{{ t('episode.create.time') }}</span><input v-model="assetCreateDraft.time" class="input" :placeholder="t('episode.create.timePlaceholder')" /></label>
              <label class="field"><span class="field-label">{{ t('episode.asset.sceneDescField') }}</span><textarea v-model="assetCreateDraft.prompt" class="textarea" rows="3" :placeholder="t('episode.create.sceneDescPlaceholder')" /></label>
              <label class="field"><span class="field-label">{{ t('episode.asset.sceneLightField') }}</span><input v-model="assetCreateDraft.lighting" class="input" :placeholder="t('episode.create.lightPlaceholder')" /></label>
            </template>
            <template v-else>
              <label class="field"><span class="field-label">{{ t('episode.create.name') }}</span><input v-model="assetCreateDraft.name" class="input" :placeholder="t('episode.create.namePlaceholderProp')" /></label>
              <label class="field"><span class="field-label">{{ t('episode.create.typeField') }}</span><input v-model="assetCreateDraft.type" class="input" :placeholder="t('episode.create.typePlaceholder')" /></label>
              <label class="field"><span class="field-label">{{ t('episode.asset.appearanceOfObject') }}</span><textarea v-model="assetCreateDraft.description" class="textarea" rows="3" :placeholder="t('episode.create.appearanceOnlyPlaceholder')" /></label>
            </template>
          </div>
          <footer class="dialog-foot">
            <button class="btn" @click="assetCreate.open = false">{{ t('common.cancel') }}</button>
            <button class="btn btn-primary" :disabled="assetCreate.saving" @click="saveAssetCreate">
              <Loader2 v-if="assetCreate.saving" :size="12" class="animate-spin" />
              {{ t('common.add') }}
            </button>
          </footer>
        </div>
      </div>

      <div v-if="batchVideoConfirm.open" class="overlay" @click.self="batchVideoConfirm.open = false">
        <div class="dialog batch-video-dialog">
          <header class="dialog-head">
            <h2 class="dialog-title">{{ t('episode.vid.confirmTitle') }}</h2>
            <button class="btn btn-ghost btn-icon" @click="batchVideoConfirm.open = false">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </header>
          <div class="dialog-body batch-video-body">
            <div v-if="batchVideoConfirm.loading" class="batch-video-loading">{{ t('episode.vid.previewLoading') }}</div>
            <template v-else>
              <div class="batch-video-row"><span>{{ t('episode.vid.confirmShots') }}</span><strong>{{ t('episode.vid.confirmShotsValue', { n: checkedVideoItems.length }) }}</strong></div>
              <div class="batch-video-row"><span>{{ t('episode.vid.confirmTotal') }}</span><strong>{{ t('episode.vid.confirmApprox', { n: batchVideoTotalDuration }) }}</strong></div>
              <div class="batch-video-row"><span>{{ t('episode.vid.confirmModel') }}</span><strong>{{ effectiveVideoModelLabel || t('episode.vid.defaultModel') }}</strong></div>
              <div class="batch-video-row"><span>{{ t('episode.vid.confirmResolution') }}</span><strong>{{ episodeResolutionLabel }}</strong></div>
              <div class="batch-video-actions">
                <span class="dim">{{ batchVideoConfirm.scoped ? t('episode.kf.batchScopeSelected', { n: batchVideoConfirm.ids.length }) : t('episode.kf.batchScopeAll') }}</span>
                <button type="button" class="btn btn-sm ml-auto" @click="setAllVideoChecked(true)">{{ t('episode.sb.selectAll') }}</button>
                <button type="button" class="btn btn-sm" @click="setAllVideoChecked(false)">{{ t('episode.sb.clear') }}</button>
              </div>
              <div class="batch-video-list">
                <label
                  v-for="item in batchVideoConfirm.items"
                  :key="item.storyboard_id"
                  :class="['batch-video-item', 'is-' + item.status, { disabled: !item.selectable }]"
                >
                  <input
                    type="checkbox"
                    :checked="item.checked"
                    :disabled="!item.selectable"
                    @change="item.checked = $event.target.checked"
                  />
                  <span class="batch-video-item-shot">#{{ String(item.storyboard_number).padStart(2, '0') }}</span>
                  <span class="batch-video-item-status">{{ videoPreviewStatusLabel(item) }}</span>
                  <span v-if="videoPreviewReason(item)" class="batch-video-item-reason">{{ videoPreviewReason(item) }}</span>
                </label>
                <div v-if="!batchVideoConfirm.items.length" class="batch-video-empty">{{ t('episode.vid.previewNothing') }}</div>
              </div>
              <p class="batch-video-note">{{ t('episode.vid.confirmSerialNote') }}</p>
              <p v-if="!videoProviderSupportsMidFrame" class="batch-video-note">{{ t('episode.kf.videoNoMidSupport') }}</p>
              <p class="batch-video-note">{{ t('episode.vid.confirmNote') }}</p>
            </template>
          </div>
          <footer class="dialog-foot">
            <button class="btn" @click="batchVideoConfirm.open = false">{{ t('common.cancel') }}</button>
            <button class="btn btn-primary" :disabled="batchVideoConfirm.loading || !checkedVideoItems.length" @click="confirmBatchVideos">{{ t('episode.vid.confirmStart', { n: checkedVideoItems.length }) }}</button>
          </footer>
        </div>
      </div>

      <!-- 批量融合（#42）：视频制作页与导出页共用，先预览分类再按显式勾选执行 -->
      <ComposeBatchDialog
        :open="composeDialog.open"
        :episode-id="Number(epId)"
        :scope-ids="composeDialog.scopeIds"
        :status="composeTask"
        :submitting="composeDialog.submitting"
        @cancel="composeDialog.open = false"
        @submit="submitComposeBatch"
        @update:scope-ids="ids => { composeDialog.scopeIds = ids }"
      />

      <!-- 拼接确认（#42）：纳入/排除镜号与数量必须在确认前看得见 -->
      <div v-if="mergeConfirm.open" class="overlay" @click.self="closeMergeConfirm">
        <div
          ref="mergeConfirmEl"
          class="dialog merge-confirm-dialog"
          role="dialog"
          aria-modal="true"
          tabindex="-1"
          :aria-label="t('episode.export.confirmTitle')"
          @keydown.esc.stop.prevent="closeMergeConfirm"
          @keydown.tab="onMergeConfirmTab"
        >
          <header class="dialog-head">
            <h2 class="dialog-title">{{ t('episode.export.confirmTitle') }}</h2>
            <button class="btn btn-ghost btn-icon" :aria-label="t('common.cancel')" @click="closeMergeConfirm">
              <X :size="14" />
            </button>
          </header>
          <div class="dialog-body merge-confirm-body">
            <p class="merge-confirm-line">{{ t('episode.export.sourceLine', { source: exportSourceLabel }) }}</p>
            <div class="merge-confirm-group">
              <span class="merge-confirm-label">{{ t('episode.export.confirmIncluded', { n: mergeConfirm.included.length }) }}</span>
              <span class="merge-confirm-shots">{{ mergeConfirm.included.map(shotNumberLabel).join(t('common.listJoin')) || t('episode.export.confirmNone') }}</span>
            </div>
            <div class="merge-confirm-group">
              <span class="merge-confirm-label">{{ t('episode.export.confirmExcluded', { n: mergeConfirm.excluded.length }) }}</span>
              <span class="merge-confirm-shots">{{ mergeConfirm.excluded.map(shotNumberLabel).join(t('common.listJoin')) || t('episode.export.confirmNone') }}</span>
            </div>
            <p class="merge-confirm-note">{{ t('episode.export.confirmNote') }}</p>
          </div>
          <footer class="dialog-foot">
            <button class="btn" :disabled="mergeConfirm.loading" @click="closeMergeConfirm">{{ t('common.cancel') }}</button>
            <button class="btn btn-primary" :disabled="mergeConfirm.loading || !mergeConfirm.ids.length" @click="confirmMerge">
              <Loader2 v-if="mergeConfirm.loading" :size="12" class="animate-spin" />
              {{ t('episode.export.confirmStart', { n: mergeConfirm.included.length }) }}
            </button>
          </footer>
        </div>
      </div>

      <ConfirmDialog
        :open="assetDelete.open"
        :title="t('episode.delete.title', { type: assetDeleteTypeLabel })"
        :message="t('episode.delete.message', { type: assetDeleteTypeLabel, name: assetDeleteName })"
        :loading="assetDelete.loading"
        @confirm="confirmDeleteAsset"
        @cancel="assetDelete.open = false"
      />

      <ConfirmDialog
        :open="faithfulConfirm.open"
        :title="t('episode.asset.faithfulOffTitle')"
        :message="t('episode.asset.faithfulOffMessage', { name: faithfulConfirm.name })"
        :loading="faithfulSaving"
        @confirm="confirmUnfaithful"
        @cancel="faithfulConfirm.open = false"
      />

      <ConfirmDialog
        :open="reExtract.open"
        :title="t('episode.documentary.reExtractTitle')"
        :message="t('episode.documentary.reExtractMessage', { type: assetTypeLabel(reExtract.type), name: reExtract.name, fields: reExtractFieldsLabel })"
        :confirm-text="t('episode.documentary.reExtract')"
        :loading="reExtract.loading"
        @confirm="confirmReExtract"
        @cancel="reExtract.open = false"
      />

      <ConfirmDialog
        :open="mergeDelete.open"
        :title="t('episode.export.deleteMergeTitle')"
        :message="t('episode.export.deleteMergeMessage')"
        :loading="mergeDelete.loading"
        @confirm="confirmDeleteMerge"
        @cancel="mergeDelete.open = false"
      />

      <BreakdownNarrationDialog
        :open="breakdownDialog"
        :default-enabled="narrationEnabledOf"
        :has-narration-data="hasNarrationContent"
        :has-storyboards="Boolean(sbs.length)"
        @cancel="breakdownDialog = false"
        @confirm="confirmBreakdown"
      />

      <!-- 批量配音参数（#37）：确定后只配「缺失 + 已变化」 -->
      <NarrationVoiceDialog
        :open="voiceBatchDialog.open"
        mode="batch"
        :episode-id="Number(epId)"
        :storyboard-ids="voiceBatchDialog.storyboardIds"
        :submitting="voiceBatchDialog.submitting"
        @cancel="voiceBatchDialog.open = false"
        @confirm="confirmNarrationVoiceBatch"
      />

      <!-- 音频旁白设置（#35）：入口在分镜拆分区，顶栏不再放这些设置 -->
      <NarrationSettingsPanel
        :open="narrationSettingsOpen"
        :narration-enabled="narrationEnabledOf"
        :narration-normalize="episodeNarrationNormalize"
        :spine="episodeNarrationSpine"
        :subtitle-timing="episodeSubtitleTiming"
        :timing-options="subtitleTimingOptions"
        :audio-mix-mode="episodeAudioMixMode"
        :mix-mode-options="audioMixModeOptions"
        :bed-gain-db="episodeBedGainDb"
        :fit-mode="episodeFitMode"
        :fit-mode-options="fitModeOptions"
        :fit-pad-seconds="episodeFitPadSeconds"
        :fit-pad-position="episodeFitPadPosition"
        :fit-position-options="fitPositionOptions"
        :max-pad-seconds="MAX_PAD_SECONDS"
        @close="narrationSettingsOpen = false"
        @update:narration-enabled="setNarrationEnabled"
        @update:narration-normalize="setNarrationNormalize"
        @update:spine="setNarrationSpine"
        @update:subtitle-timing="v => { episodeSubtitleTiming = v }"
        @update:audio-mix-mode="v => { episodeAudioMixMode = v }"
        @update:bed-gain-db="v => { episodeBedGainDb = v }"
        @update:fit-mode="v => { episodeFitMode = v }"
        @update:fit-pad-seconds="v => { episodeFitPadSeconds = v }"
        @update:fit-pad-position="v => { episodeFitPadPosition = v }"
      />

      <ConfirmDialog
        :open="subtitleRegenConfirm"
        :title="t('episode.narration.regenAllTitle')"
        :message="t('episode.narration.regenAllMessage')"
        :confirm-text="t('episode.narration.regenSubtitle')"
        :loading="subtitleRegenRunning"
        @confirm="regenerateAllSubtitles"
        @cancel="subtitleRegenConfirm = false"
      />

      <AssetBrowserDialog
        v-if="assetBrowserOpen && episode"
        :drama-id="dramaId"
        :episode-id="episode.id"
        @close="assetBrowserOpen = false"
        @done="refresh"
      />

      <AssetBatchDialog
        :open="assetBatch.open"
        :drama-id="dramaId"
        :episode-id="epId || 0"
        :scope="assetBatch.scope"
        :image-model="bareModelName(imageModel) || ''"
        :image-config-id="ownerConfigId(imageModelOptions, imageModel) || 0"
        :text-model="chatModelOverride() || ''"
        :text-config-id="chatConfigId() || 0"
        @close="assetBatch.open = false"
        @started="onAssetBatchStarted"
      />

      <MediaLibraryDialog
        :open="assetLibrary.open"
        :drama-id="dramaId"
        :submitting="assetLibrary.loading"
        :title="t('components.mediaLibrary.pickAsset')"
        @close="assetLibrary.open = false"
        @pick="applyAssetImageFromLibrary"
      />
    </main>
    </div>
  </div>
</template>

<script setup>
import { toast } from 'vue-sonner'
import { useI18n } from 'vue-i18n'
import {
  Users, FileText, FolderKanban, Clapperboard, Download, Loader2, Images,
  Image as ImageIcon, Plus, X, Trash2, CircleHelp, ChevronRight, Layers, Lightbulb, Lock,
} from 'lucide-vue-next'
import { api, dramaAPI, episodeAPI, storyboardAPI, characterAPI, sceneAPI, propAPI, taskAPI, mergeAPI, posterAPI, aiConfigAPI, uploadAPI, mediaLibraryAPI, videoQueueAPI, assetBatchAPI } from '~/composables/useApi'
import { startTour, autoTour } from '~/composables/useTour'
import { useAgent } from '~/composables/useAgent'
import { toastError, mapError, toastServerMessage, MODERATION_RE } from '~/composables/useToast'
import LocaleSwitcher from '~/components/LocaleSwitcher.vue'
import ReferenceImageManager from '~/components/ReferenceImageManager.vue'
import ArchivalImagePanel from '~/components/ArchivalImagePanel.vue'
import PropSemanticsPanel from '~/components/PropSemanticsPanel.vue'
import AssetPipelinePanel from '~/components/AssetPipelinePanel.vue'
import MapSpecPanel from '~/components/MapSpecPanel.vue'
import ResearchCitationList from '~/components/ResearchCitationList.vue'
import FinalPromptSourceBadge from '~/components/FinalPromptSourceBadge.vue'
import MediaLibraryDialog from '~/components/MediaLibraryDialog.vue'
import PosterPanel from '~/components/PosterPanel.vue'
import StoryboardKeyframes from '~/components/StoryboardKeyframes.vue'
import ProgressRing from '~/components/ProgressRing.vue'
import TaskCenterButton from '~/components/TaskCenterButton.vue'
import MediaTime from '~/components/MediaTime.vue'
import AssetBrowserDialog from '~/components/AssetBrowserDialog.vue'
import BreakdownNarrationDialog from '~/components/BreakdownNarrationDialog.vue'
import NarrationSettingsPanel from '~/components/NarrationSettingsPanel.vue'
import NarrationVoiceDialog from '~/components/NarrationVoiceDialog.vue'
import AssetBatchDialog from '~/components/AssetBatchDialog.vue'
import ComposeBatchDialog from '~/components/ComposeBatchDialog.vue'
// 每步一个稳定挂载组件（Issue #54）：后续 Issue 只改这些组件内部，不再回 episode.vue 改 markup
import ScriptStepPanel from '~/components/ScriptStepPanel.vue'
import AssetReviewPanel from '~/components/AssetReviewPanel.vue'
import DesignCardPanel from '~/components/DesignCardPanel.vue'
import ShotProductionPanel from '~/components/ShotProductionPanel.vue'
import VideoShotPanel from '~/components/VideoShotPanel.vue'
import ExportPanel from '~/components/ExportPanel.vue'
import { ASSET_SUB_TABS, PROD_TAB_KEYS, WORKBENCH_CTX, isStageGateUnknown, isStageLocked, remapAssetTab, remapProdTab } from '~/utils/workbenchSteps'
import { useWorkflowGates } from '~/composables/useWorkflowGates'
import { mediaTimeOfPath } from '~/utils/mediaTime'
import {
  useNowTicker,
  ringPropsFromTask,
  isActiveTaskStatus,
  summarizeTasks,
  formatSeconds,
} from '~/composables/useTaskProgress'
import { useTasks, latestActiveVideoTask } from '~/composables/useTasks'

definePageMeta({ layout: 'studio' })

const { t } = useI18n()

const route = useRoute()
const dramaId = Number(route.params.id)
const episodeNumber = Number(route.params.episodeNumber)

const drama = ref(null), episode = ref(null), chars = ref([]), scenes = ref([]), propItems = ref([]), sbs = ref([]), mergeData = ref(null)
// 资产管理器（#9）：本项目资产关联到本集 / 其他项目资产全量复制导入并关联
const assetBrowserOpen = ref(false)
// 纪录片选角名册（Issue #32）：谁该建卡的契约。首轮由提取 Agent 生成草稿（待复核），
// 人在这里增删后点「确认名册」锁定；之后每次提取都照同一份名册执行，剧本改动则标记过期。
// 内容规则集口径（#54 改名）：只驱动「内容规则」类能力（当前唯一用处 = 选角名册按钮），
// 严禁用它判断工作流结构——drama 3 是 project_type='drama' + documentary_rules，仍走剧情 6 步。
const isDocumentaryRuleset = computed(() => drama.value?.genre_ruleset === 'documentary')
// 项目类型（Issue #45 / #54）：工作流结构的唯一口径——步骤集合、页签、侧栏、
// 进度条、门禁、Poster 位置、挂载点选择全部只看它。
const isDocumentaryProject = computed(() => drama.value?.project_type === 'documentary')
const roster = ref({ open: false, loading: false, saving: false, exists: false, status: null, stale: false, updated_at: null, current_hash: '', cast: [] })

async function openRosterDialog() {
  roster.value.open = true
  roster.value.loading = true
  try {
    const data = await episodeAPI.characterRoster(epId.value)
    roster.value.exists = !!data?.exists
    roster.value.status = data?.status || null
    roster.value.stale = !!data?.stale
    roster.value.updated_at = data?.updated_at || null
    // 打开时的剧本指纹随保存回传：中途有人改了剧本就拒绝保存，不让人为旧正文签字
    roster.value.current_hash = data?.current_hash || ''
    roster.value.cast = (data?.cast || []).map(m => ({ name: m.name || '', basis: m.basis || '', reason: m.reason || '', source: m.source || 'agent' }))
  } catch (e) {
    toastError(e)
  } finally {
    roster.value.loading = false
  }
}

async function saveRoster(status) {
  const cast = roster.value.cast.filter(m => (m.name || '').trim())
  roster.value.saving = true
  try {
    const data = await episodeAPI.saveCharacterRoster(epId.value, cast, status, roster.value.current_hash)
    roster.value.exists = !!data?.exists
    roster.value.status = data?.status || null
    roster.value.stale = !!data?.stale
    roster.value.updated_at = data?.updated_at || null
    roster.value.current_hash = data?.current_hash || ''
    roster.value.cast = (data?.cast || []).map(m => ({ name: m.name || '', basis: m.basis || '', reason: m.reason || '', source: m.source || 'human' }))
    toast.success(status === 'approved' ? t('episode.roster.confirmed') : t('episode.roster.draftSaved'))
    if (status === 'approved') roster.value.open = false
  } catch (e) {
    toastError(e)
  } finally {
    roster.value.saving = false
  }
}
// 工作台面板位置记忆（按剧集隔离）：仅页面刷新(reload)时恢复到上次所在步骤；
// 从列表/详情页点击进入时始终默认「剧本」面板；URL query 显式携带子状态时优先于本地记忆
const PANEL_STORE_KEY = `huobao:workbench:panel:${dramaId}:${episodeNumber}`
const isPageReload = (() => {
  try { return performance.getEntriesByType('navigation')[0]?.type === 'reload' } catch { return false }
})()
const storedPanel = (() => {
  if (!isPageReload) return null
  try { return JSON.parse(localStorage.getItem(PANEL_STORE_KEY) || 'null') } catch { return null }
})()
// ===== 子状态 deeplink：?panel=script|production|export &step=0|1
//      &tab=assets|poster|keyframes|videos（纪录片项目为 assets|poster|design|production|final）
//      &sub=cards|review（资产步的子页签，纪录片才有审核清单）
//      &extract=characters|scenes|props &asset=类型-id =====
const { replaceQuery } = useQuerySync()
const urlPanel = queryEnum(route.query.panel, ['script', 'production', 'export'])
const urlStep = queryEnum(route.query.step, ['0', '1'])
// 两类项目的页签并集（含旧链接 expression/layers，由 remapProdTab 归一）
const urlProdTab = queryEnum(route.query.tab, [...PROD_TAB_KEYS, 'expression', 'layers'])
const urlAssetTab = queryEnum(route.query.sub, ASSET_SUB_TABS)
// extract：资产面板的类型筛选页签（null = 全部），与左侧 EXTRACT_TARGETS 三类一致
const urlExtract = queryEnum(route.query.extract, ['characters', 'scenes', 'props'])
const pendingAssetLink = queryTypedId(route.query.asset, ['character', 'scene', 'prop'])
// 任一面板子状态出现在 URL（含非法值）即以 URL 为完整来源，缺失子参数取默认值，忽略本地记忆
const urlPanelGiven = !!(querySingle(route.query.panel) || urlStep || urlProdTab || querySingle(route.query.extract))
// 首个 refresh 时若已恢复面板位置（URL 显式 step 或无 URL 面板参数时的本地记忆），跳过按内容自动重置 scriptStep
let panelRestored = urlStep !== null || (!urlPanelGiven && !!storedPanel)
const panel = ref(urlPanelGiven
  ? (urlPanel || (urlProdTab || urlExtract ? 'production' : 'script'))
  : (['production', 'export'].includes(storedPanel?.panel) ? storedPanel.panel : 'script'))
const { running: rn, runningType: rt, run: runAgent } = useAgent()

const localRaw = ref(''), localScript = ref('')
const rawContent = computed(() => episode.value?.content || '')
const scriptContent = computed(() => episode.value?.script_content || episode.value?.scriptContent || '')
const epId = computed(() => episode.value?.id || 0)
const rawLen = computed(() => localRaw.value.replace(/\s/g, '').length || 0)
const scriptLen = computed(() => localScript.value.replace(/\s/g, '').length || 0)

// ===== 拼接导出:镜头选择 + 成片列表 =====
const exportSelectedIds = ref([]) // 勾选的镜头 id
const exportMerges = ref([])      // 成片(拼接记录)列表
let exportSelTouched = false      // 用户手动操作过选择后,不再自动全选
// Poster 片头（Issue #39）：可选静态海报 + 展示秒数
const posterData = ref(null)
const exportPosterEnabled = ref(false)
const exportPosterVersionId = ref(null)
const exportPosterDuration = ref(3)
const posterVersionOptions = computed(() => posterData.value?.versions || [])
const posterPreviewUrl = computed(() => {
  const version = posterVersionOptions.value.find(item => item.id === exportPosterVersionId.value)
  return version?.image ? thumbOf(mediaUrl(version.image)) : ''
})

// 导出可选 = 本镜原始视频真实可用（以后端文件判定为准）：合成片是派生产物，
// 「只剩成片」或源文件已丢的镜头都不能冒充有素材
const exportReadyIds = computed(() => sbs.value.filter(s => hasUsableVideo(s)).map(s => s.id))
const exportSelectedReadyIds = computed(() => exportSelectedIds.value.filter(id => exportReadyIds.value.includes(id)))

watch(exportReadyIds, (ids) => {
  if (exportSelTouched) {
    exportSelectedIds.value = exportSelectedIds.value.filter(id => ids.includes(id))
  } else {
    exportSelectedIds.value = [...ids]
  }
})

function isExportSelected(id) { return exportSelectedIds.value.includes(id) }
function toggleExportSelect(sb) {
  if (!hasUsableVideo(sb)) return
  exportSelTouched = true
  exportSelectedIds.value = isExportSelected(sb.id)
    ? exportSelectedIds.value.filter(x => x !== sb.id)
    : [...exportSelectedIds.value, sb.id]
}
function toggleSelectAllExport() {
  exportSelTouched = true
  exportSelectedIds.value = exportSelectedReadyIds.value.length === exportReadyIds.value.length ? [] : [...exportReadyIds.value]
}

// ===== 导出就绪（#42）：集级旁白开启时只认签名匹配的融合片，关闭时维持原视频拼接 =====
/** 当前所选里真正可拼接的镜头（融合最新 / 旁白关闭时有视频） */
const exportComposeReadyIds = computed(() =>
  exportSelectedReadyIds.value.filter(id => composeExportable(sbs.value.find(sb => sb.id === id))))
/** 已选但不可拼接：逐镜给出状态与原因，不静默少镜 */
const exportBlockedSelected = computed(() => exportSelectedReadyIds.value
  .map(id => sbs.value.find(sb => sb.id === id))
  .filter(sb => sb && !composeExportable(sb))
  .map(sb => ({
    id: sb.id,
    number: sbs.value.indexOf(sb) + 1,
    status: composeStatusOf(sb),
    label: composeStatusLabel(sb),
    reason: composeReasonOf(sb),
  })))
/** 已选、需要先补融合（缺失 / 已变化 / 待核验）的镜头：同一批量预览可直接修复 */
const exportRepairIds = computed(() => exportBlockedSelected.value
  .filter(item => ['missing', 'changed', 'unknown', 'skipped'].includes(item.status))
  .map(item => item.id))
const exportSourceLabel = computed(() => (narrationEnabledOf.value
  ? t('episode.export.sourceComposed')
  : t('episode.export.sourceRaw')))

/** 「仅选就绪镜头」：把选择显式缩小到可拼接的那批，而不是让后端悄悄跳过 */
function selectExportReadyOnly() {
  exportSelTouched = true
  exportSelectedIds.value = [...exportComposeReadyIds.value]
}

async function loadExportMerges() {
  if (!epId.value) return
  try { exportMerges.value = await mergeAPI.list(epId.value) || [] } catch { /* 静默 */ }
}

// ─── 删除成片 ────────────────────────────────────────────────
const mergeDelete = ref({ open: false, item: null, loading: false })
const deletingMergeId = computed(() => (mergeDelete.value.loading ? mergeDelete.value.item?.id ?? null : null))

/** 拼接进行中的成片不可删（后端同样拒绝） */
function isMergeInProgress(m) {
  const status = m?.status || 'pending'
  return status === 'pending' || status === 'processing' || status === 'queued' || status === 'running'
}

function askDeleteMerge(m) {
  if (!m || isMergeInProgress(m)) return
  mergeDelete.value = { open: true, item: m, loading: false }
}

async function confirmDeleteMerge() {
  const item = mergeDelete.value.item
  if (!item || mergeDelete.value.loading) return
  mergeDelete.value.loading = true
  try {
    const res = await mergeAPI.del(epId.value, item.id)
    if (activeMerge.value?.id === item.id) activeMerge.value = null
    mergeDelete.value.open = false
    toast.success(t('episode.export.deleteMergeDone'))
    // 成片列表 / 剧集「已合成」状态 / 任务中心导出行同步
    if (episode.value) episode.value.video_url = res?.episode_video_url ?? null
    await loadExportMerges()
    await loadEpisodeTasks(epId.value)
  } catch (e) {
    toastError(e, { fallback: 'common.deleteFailed' })
  } finally {
    mergeDelete.value.loading = false
  }
}

// URL 为面板来源时 step 缺失取默认 0（由 refresh 按内容自动推进），不继承本地记忆
const scriptStep = ref(urlStep !== null ? Number(urlStep) : (urlPanelGiven ? 0 : (storedPanel ? (storedPanel.scriptStep === 0 ? 0 : 1) : 0)))
// 旧版本地存储的 'storyboard' 子步骤已并入 'videos'（视频制作）；#49/#50 的 expression/layers
// 由 remapProdTab 在项目类型就绪后统一归一（URL 与本地记忆共用同一个纯函数）
const storedProdTab = storedPanel?.prodTab === 'storyboard' ? 'videos' : storedPanel?.prodTab
const prodTab = ref(urlProdTab || (urlPanelGiven ? 'assets' : (storedProdTab || 'assets')))
// 资产步子页签（#54）：资产卡 / 审核清单，审核清单只在纪录片出现
const assetTab = ref(urlAssetTab || (urlPanelGiven ? 'cards' : (storedPanel?.assetTab || 'cards')))
// 资产类型筛选页签：null=全部（三段平铺）| characters|scenes|props（只看该类），deeplink ?extract=
const extractTab = ref(urlExtract)
// 面板位置变化即持久化
watch([panel, scriptStep, prodTab, assetTab], ([p, s, pt, at]) => {
  try { localStorage.setItem(PANEL_STORE_KEY, JSON.stringify({ panel: p, scriptStep: s, prodTab: pt, assetTab: at })) } catch { /* 静默 */ }
})

async function loadPosterData() {
  if (!epId.value) return
  try {
    posterData.value = await posterAPI.get(epId.value)
  } catch { /* Poster 可选，加载失败不阻断工作台 */ }
}

watch([panel, prodTab], ([currentPanel, currentTab]) => {
  if ((currentPanel === 'production' && currentTab === 'poster') || currentPanel === 'export') void loadPosterData()
}, { immediate: true })

watch(posterData, data => {
  if (!data) return
  const ids = (data.versions || []).map(version => version.id)
  if (!exportPosterVersionId.value || !ids.includes(exportPosterVersionId.value)) {
    exportPosterVersionId.value = data.selected_version_id || ids[0] || null
  }
})
// ===== 视频制作三栏宽度：拖拽调节 + 全局持久化（双击分隔条恢复默认） =====
const VIDEO_COL_STORE_KEY = 'huobao:workbench:video-cols'
const VIDEO_COL_DEFAULTS = { left: 236, right: 420 }
const VIDEO_COL_LIMITS = { left: [180, 420], right: [320, 640] }
const storedVideoCols = (() => {
  try {
    const c = JSON.parse(localStorage.getItem(VIDEO_COL_STORE_KEY) || 'null')
    return c && typeof c === 'object' ? c : null
  } catch { return null }
})()
const clampVideoCol = (which, w) => Math.min(VIDEO_COL_LIMITS[which][1], Math.max(VIDEO_COL_LIMITS[which][0], Math.round(w)))
const videoLeftW = ref(clampVideoCol('left', Number(storedVideoCols?.left) || VIDEO_COL_DEFAULTS.left))
const videoRightW = ref(clampVideoCol('right', Number(storedVideoCols?.right) || VIDEO_COL_DEFAULTS.right))
watch([videoLeftW, videoRightW], ([l, r]) => {
  try { localStorage.setItem(VIDEO_COL_STORE_KEY, JSON.stringify({ left: l, right: r })) } catch { /* 静默 */ }
})
function startVideoColDrag(which, e) {
  if (e.button !== 0) return
  e.preventDefault()
  const target = e.currentTarget
  const startX = e.clientX
  const startW = which === 'left' ? videoLeftW.value : videoRightW.value
  const onMove = (ev) => {
    const dx = ev.clientX - startX
    const w = clampVideoCol(which, which === 'left' ? startW + dx : startW - dx)
    if (which === 'left') videoLeftW.value = w
    else videoRightW.value = w
  }
  const onUp = () => {
    target.removeEventListener('pointermove', onMove)
    target.removeEventListener('pointerup', onUp)
    target.removeEventListener('pointercancel', onUp)
    document.body.classList.remove('is-video-col-dragging')
  }
  document.body.classList.add('is-video-col-dragging')
  target.addEventListener('pointermove', onMove)
  target.addEventListener('pointerup', onUp)
  target.addEventListener('pointercancel', onUp)
  target.setPointerCapture?.(e.pointerId)
}
const prodTabIdx = computed({
  get: () => prodTabDefs.value.findIndex(d => d.id === prodTab.value),
  set: (v) => { prodTab.value = prodTabDefs.value[v]?.id || 'assets' },
})
// 分镜制作页要聚焦的镜头（#58）：视频页「去分镜制作」跳转时设置，工作区据此选中该镜
const productionFocusSbId = ref(0)
// 「去分镜制作」（#58）：视频页不再就地渲染图层段，一律跳到制作页并聚焦该镜
function gotoShotProduction(sb) {
  productionFocusSbId.value = sb?.id || 0
  panel.value = 'production'
  prodTab.value = 'production'
}
const imageConfigs = ref([])
const videoConfigs = ref([])
const textConfigs = ref([])
// 生成时可选模型：空串 = 跟随配置默认（models[0]）；选择持久化到 localStorage，刷新页面后保留
const MODEL_STORE_KEYS = { chat: 'huobao:model:chat', image: 'huobao:model:image', video: 'huobao:model:video' }
function readStoredModel(key, legacyKey = '') {
  try { return localStorage.getItem(key) || (legacyKey && localStorage.getItem(legacyKey)) || '' } catch { return '' }
}
// 顶栏文本模型：适用于所有 Chat Agent 调用（改写/提取/拆镜/视频提示词/最终提示词），空串 = 跟随配置默认
const chatModel = ref(readStoredModel(MODEL_STORE_KEYS.chat, 'huobao:model:rewrite'))
const imageModel = ref(readStoredModel(MODEL_STORE_KEYS.image))
const videoModel = ref(readStoredModel(MODEL_STORE_KEYS.video))
function persistModel(modelRef, key) {
  watch(modelRef, v => {
    try { v ? localStorage.setItem(key, v) : localStorage.removeItem(key) } catch {}
  })
}
persistModel(chatModel, MODEL_STORE_KEYS.chat)
persistModel(imageModel, MODEL_STORE_KEYS.image)
persistModel(videoModel, MODEL_STORE_KEYS.video)
// 左侧菜单栏收起/展开：收起为窄图标栏给内容区让位，持久化到 localStorage
const SIDEBAR_COLLAPSED_KEY = 'huobao:sidebar-collapsed'
const sidebarCollapsed = ref((() => {
  try { return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1' } catch { return false }
})())
function toggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value
  try {
    sidebarCollapsed.value
      ? localStorage.setItem(SIDEBAR_COLLAPSED_KEY, '1')
      : localStorage.removeItem(SIDEBAR_COLLAPSED_KEY)
  } catch { /* 静默 */ }
}
/** 顶栏文本模型覆盖参数：未选择时为 undefined，后端回退到 Agent/文本配置默认 */
function chatModelOverride() { return bareModelName(chatModel.value) || undefined }
function chatConfigId() { return ownerConfigId(textModelOptions.value, chatModel.value) }
// ===== 素材图片生成：按 sys_task 跟踪（排队位置 / 进度 / 失败原因 / 取消） =====
// 任务状态全部来自全局任务 store（轮询 /tasks/active + 进页时载入本集快照），
// 切页/刷新后自动恢复，页面不再自己轮询任务列表
const now = useNowTicker()
const {
  episodeTasks, latestAssetTask, latestKeyframeTask, registerTask, refreshTasks, loadEpisodeTasks, onTaskFinished,
} = useTasks()
// Documentary summaries cover all shots, including background work on an unselected shot.
// The legacy keyframe page owns its own slot refresh.
onTaskFinished((task) => {
  if (Number(task.episode_id) !== Number(epId.value)) return
  if (task.type === 'image' && task.storyboard_id && !isDocumentaryProject.value) return
  void refresh()
})
// 已点生成、后端尚未返回 sys_task 的空窗期（返回后立即被真实任务接管）
const submittingAssetImages = ref([])
const pendingVideoIds = ref([])
const failedVideoMessages = ref({})

const episodeImageTasks = computed(() => episodeTasks(epId.value).filter(task => task.type === 'image'))
const activeImageTasks = computed(() => episodeImageTasks.value.filter(task => isActiveTaskStatus(task.status)))
// 集级「图片生成队列」汇总条：加权整体进度 + 最晚一张的预计完成时间
const imageQueue = computed(() => summarizeTasks(activeImageTasks.value, now.value))
const imageQueueEtaText = computed(() =>
  imageQueue.value.etaSeconds === null ? '' : t('episode.image.queueEta', { time: formatSeconds(t, imageQueue.value.etaSeconds) }))
const imageQueuePercent = computed(() => Math.round(imageQueue.value.progress * 100))

function isAssetImagePending(type, id) {
  if (submittingAssetImages.value.includes(`${type}:${id}`)) return true
  return isActiveTaskStatus(latestAssetTask(type, id)?.status)
}
/** 卡片进度环：排队/生成中/失败/已取消时显示，已完成的卡片直接看图 */
function assetImageRing(type, id) {
  if (submittingAssetImages.value.includes(`${type}:${id}`)) return ringPropsFromTask({ status: 'queued' }, now.value)
  const task = latestAssetTask(type, id)
  if (!task || task.status === 'completed') return null
  return ringPropsFromTask(task, now.value)
}
function isAssetImageCancellable(type, id) {
  const task = latestAssetTask(type, id)
  return Boolean(task?.cancellable) && isActiveTaskStatus(task?.status)
}
async function cancelAssetImage(type, id) {
  const task = latestAssetTask(type, id)
  if (!task?.id) return
  try {
    const res = await taskAPI.cancel(task.id)
    registerTask(res)
    toast.success(t('episode.image.taskCancelRequested'))
    await refreshTasks()
  } catch (e) {
    toastError(e, { fallback: 'episode.image.taskCancelFailed' })
  }
}
// 重试 = 重新走各资产的生成接口（后端每次都新建 sys_task）
function retryAssetImage(type, id) {
  if (type === 'character') return genCharImg(id)
  if (type === 'scene') return genSceneImg(id)
  return genPropImg(id)
}

const imageViewer = ref({ open: false, src: '', title: '' })
const activeMerge = ref(null) // 成片大预览弹窗中正在播放的拼接记录
const previewShot = ref(null) // 导出页镜头素材预览弹窗中正在播放的分镜
function shotNumberOf(sb) {
  const i = sbs.value.findIndex(s => s.id === sb?.id)
  return i >= 0 ? i + 1 : 0
}
// 导出步骤完成 = 用户手动标记（episodes.status = 'completed'），不再按最新拼接记录推算
const exportDone = computed(() => episode.value?.status === 'completed')
async function toggleExportDone() {
  if (!epId.value) return
  const status = exportDone.value ? 'active' : 'completed'
  try {
    await episodeAPI.update(epId.value, { status })
    if (episode.value) episode.value.status = status
    toast.success(status === 'completed' ? t('episode.export.markedDoneToast') : t('episode.export.unmarkDoneToast'))
  } catch (e) {
    toastError(e)
  }
}
const assetDetail = ref({ open: false, type: '', item: null })
const mapDraftAssetId = ref(null)
const assetDetailDraft = ref({ appearance: '', styling: '', prompt: '', lighting: '', description: '', time: '' })
// 最终提示词手动编辑：dirty 时才随保存提交，避免无修改保存误清空 Agent 生成的提示词
const assetPromptDraft = ref('')
const assetPromptDirty = ref(false)
const savingAssetDetail = ref(false)
const switchingAssetVersion = ref(false)

function isPendingCharImage(id) {
  return isAssetImagePending('character', id)
}

function openImageViewer(src, title = '') {
  if (!src) return
  imageViewer.value = { open: true, src, title }
}

function closeImageViewer() {
  imageViewer.value = { open: false, src: '', title: '' }
}

// 场景时段词表：与 #21 的提取/提示词规则同一套（入库值固定为中文词，界面按语言显示）
const TIME_PERIODS = ['清晨', '上午', '正午', '午后', '黄昏', '夜晚', '深夜']
const TIME_PERIOD_KEYS = {
  清晨: 'dawn', 上午: 'morning', 正午: 'noon', 午后: 'afternoon', 黄昏: 'dusk', 夜晚: 'night', 深夜: 'lateNight',
}
function timePeriodLabel(period) {
  const key = TIME_PERIOD_KEYS[period]
  return key ? t(`episode.asset.timePeriods.${key}`) : period
}
function onSceneTimePreset(value) {
  if (value === '__custom__') {
    // 切到自填：保留已有自填值，常用时段值清空让用户输入
    if (TIME_PERIODS.includes(assetDetailDraft.value.time)) assetDetailDraft.value.time = ''
    return
  }
  assetDetailDraft.value.time = value
}

/** 语义面板要滚动并高亮的条目 id（审核清单的「标注待修正」直达用；为空与改动前逐字一致） */
const focusSemanticId = ref('')

function openAssetDetail(type, item) {
  if (!item) return
  mapDraftAssetId.value = null
  assetDetail.value = { open: true, type, item }
  assetDetailDraft.value = {
    appearance: item.appearance || '',
    styling: item.styling || '',
    prompt: item.prompt || (type === 'prop' ? '' : item.description) || '',
    lighting: item.lighting || '',
    description: item.description || '',
    time: item.time || '',
  }
  assetPromptDraft.value = item.final_prompt || item.finalPrompt || ''
  assetPromptDirty.value = false
}

/** 关键帧资产池卡片 → 打开同一个资产详情弹窗（卡片携带 kind code 与资产 id） */
function openPoolAssetDetail(asset) {
  if (!asset?.kind) return
  const list = asset.kind === 'character' ? chars.value : asset.kind === 'scene' ? scenes.value : propItems.value
  const item = list.find(x => x.id === asset.id)
  if (item) openAssetDetail(asset.kind, item)
}

function closeAssetDetail() {
  mapDraftAssetId.value = null
  focusSemanticId.value = ''
  assetDetail.value = { open: false, type: '', item: null }
  assetDetailDraft.value = { appearance: '', styling: '', prompt: '', lighting: '', description: '', time: '' }
  assetPromptDraft.value = ''
  assetPromptDirty.value = false
}

// ===== 子状态 → URL 同步（deeplink）：replace 更新，不污染历史栈，返回键 = 退出工作台 =====
// URL 始终镜像当前面板/子步骤/类型筛选/资产弹窗，任意时刻复制地址即可分享/刷新还原
// 水合守卫：首个 refresh 会按内容自动重置 scriptStep，若此时就 replace 会抢在
// applyAssetDeeplink 之前把 URL 里的 asset 参数冲掉（query 变化重建组件后链路丢失），
// 故在 onMounted 完成数据加载 + 资产弹窗回放后再整体同步一次
let workbenchHydrated = false
let workbenchDirty = false
function syncWorkbenchQuery() {
  if (!workbenchHydrated) { workbenchDirty = true; return }
  const query = { panel: panel.value }
  // step 仅在剧本面板、tab/extract 仅在制作面板可见，只写当前有意义的键，保持 URL 简洁
  if (panel.value === 'script') query.step = String(scriptStep.value)
  if (panel.value === 'production') {
    query.tab = prodTab.value
    if (prodTab.value === 'assets' && isDocumentaryProject.value) query.sub = assetTab.value
    if (prodTab.value === 'assets' && extractTab.value) query.extract = extractTab.value
  }
  if (assetDetail.value.open && assetDetail.value.item?.id) {
    query.asset = `${assetDetail.value.type}-${assetDetail.value.item.id}`
  }
  replaceQuery(query)
}
watch([panel, scriptStep, prodTab, assetTab, extractTab], syncWorkbenchQuery)
watch(assetDetail, syncWorkbenchQuery)

// ─── 手动新增资产 ────────────────────────────────────────────
// 类型短显示名渲染时求值（不模块级固化），逻辑判断一律用 kind code
const assetKindLabelMap = computed(() => ({
  character: t('common.role'),
  scene: t('common.scene'),
  prop: t('common.prop'),
}))
function assetKindLabel(type) {
  return assetKindLabelMap.value[type] || t('episode.asset.fallbackType')
}
const assetCreate = ref({ open: false, type: 'character', saving: false })
const assetCreateDraft = ref({})
const assetCreateTypeLabel = computed(() => assetKindLabel(assetCreate.value.type))

function openAssetCreate(type, prefill = null) {
  assetCreateDraft.value = { name: '', role: '', appearance: '', styling: '', location: '', time: '', prompt: '', lighting: '', type: '', description: '' }
  // 审核清单（#55）的「上传 / AI 生成」带着条目预填进来：名称 = 需要的素材描述
  if (prefill?.name) {
    if (type === 'scene') assetCreateDraft.value.location = prefill.name
    else assetCreateDraft.value.name = prefill.name
    if (type === 'prop') assetCreateDraft.value.description = prefill.name
  }
  assetCreate.value = {
    open: true,
    type,
    saving: false,
    reviewItemId: prefill?.review_item_id || 0,
    faithful: !!prefill?.faithful,
  }
}

async function saveAssetCreate() {
  const d = assetCreateDraft.value
  const type = assetCreate.value.type
  if (assetCreate.value.saving) return
  if (type === 'scene' ? !d.location?.trim() : !d.name?.trim()) {
    toast.warning(type === 'scene' ? t('episode.create.locationRequired') : t('episode.create.nameRequired'))
    return
  }
  assetCreate.value.saving = true
  try {
    // 带 asset_review_item_id 时服务端保存后直接把那条缺失项置「已补」并绑定（#55）
    const base = { drama_id: dramaId, episode_id: epId.value, asset_review_item_id: assetCreate.value.reviewItemId || undefined }
    let createdRow = null
    if (type === 'character') createdRow = await characterAPI.create({ ...base, name: d.name, role: d.role, appearance: d.appearance, styling: d.styling })
    else if (type === 'scene') createdRow = await sceneAPI.create({ ...base, location: d.location, time: d.time, prompt: d.prompt, lighting: d.lighting })
    else createdRow = await propAPI.create({ ...base, name: d.name, type: d.type, description: d.description, faithful: assetCreate.value.faithful || undefined })
    toast.success(t('episode.create.created', { type: assetCreateTypeLabel.value }))
    const fromReview = !!assetCreate.value.reviewItemId
    assetCreate.value.open = false
    await refresh()
    // 从审核清单来的：直接打开新资产详情，用户接着上传原件 / 生图
    if (fromReview && createdRow?.id) openAssetDetailById(type, createdRow.id)
    if (fromReview) refreshGates()
  } catch (e) {
    toastError(e)
  } finally {
    assetCreate.value.saving = false
  }
}

/** 审核清单 → 打开资产详情（可带语义条目聚焦） */
function openAssetDetailById(type, id, semanticId = null) {
  const list = type === 'character' ? chars.value : type === 'scene' ? scenes.value : propItems.value
  const item = list.find(x => x.id === Number(id))
  if (!item) return
  focusSemanticId.value = semanticId || ''
  openAssetDetail(type, item)
}

function openAssetFromReview(payload) {
  if (!payload?.kind || !payload?.id) return
  openAssetDetailById(payload.kind, payload.id, payload.semantic_id || null)
}

function openAssetCreateFromReview(payload) {
  if (!payload?.kind) return
  openAssetCreate(payload.kind, payload)
}

// ─── 删除资产 ────────────────────────────────────────────────
const assetDelete = ref({ open: false, type: '', item: null, loading: false })
const assetDeleteTypeLabel = computed(() => assetKindLabel(assetDelete.value.type))
const assetDeleteName = computed(() => assetDelete.value.item?.name || assetDelete.value.item?.location || '')

function askDeleteAsset(type, item) {
  assetDelete.value = { open: true, type, item, loading: false }
}

async function confirmDeleteAsset() {
  const { type, item } = assetDelete.value
  if (!item || assetDelete.value.loading) return
  assetDelete.value.loading = true
  try {
    if (type === 'character') await characterAPI.del(item.id)
    else if (type === 'scene') await sceneAPI.del(item.id)
    else await propAPI.del(item.id)
    toast.success(t('episode.delete.deleted', { type: assetDeleteTypeLabel.value }))
    assetDelete.value.open = false
    if (assetDetail.value.open && assetDetail.value.type === type && assetDetail.value.item?.id === item.id) closeAssetDetail()
    await refresh()
  } catch (e) {
    toastError(e)
  } finally {
    assetDelete.value.loading = false
  }
}

function onAssetPromptInput(event) {
  assetPromptDraft.value = event.target.value
  assetPromptDirty.value = true
}

const assetFinalPrompt = computed(() => {
  const item = assetDetail.value?.item
  return item?.final_prompt || item?.finalPrompt || ''
})

/** 资产弹窗当前是否仍打开着这个资产：异步回调回来时弹窗可能已换成别的资产（Issue #24） */
function isAssetDialogOn(type, id) {
  return assetDetail.value.open && assetDetail.value.type === type && assetDetail.value.item?.id === id
}

/** 把生成好的最终提示词同步到列表项与弹窗项 */
function applyFinalPrompt(type, id, fp) {
  // 后端 generate-prompt 把来源标记写成 agent（Issue #32），本地同步让来源徽标立刻翻转
  const patch = { final_prompt: fp, finalPrompt: fp, final_prompt_source: 'agent', final_prompt_updated_at: new Date().toISOString() }
  const list = type === 'character' ? chars.value : type === 'scene' ? scenes.value : propItems.value
  const target = list.find(x => x.id === id)
  if (target) Object.assign(target, patch)
  if (isAssetDialogOn(type, id)) Object.assign(assetDetail.value.item, patch)
}

const generatingPromptKeys = ref([])

function isGeneratingPrompt(type, id) {
  return generatingPromptKeys.value.includes(`${type}:${id}`)
}

/**
 * 生成最终提示词（弹窗按钮与外层两段式生图共用同一 key 状态，避免重复触发）
 * force=true 时忽略已有提示词强制重新生成
 * 返回最终提示词；生成失败由接口抛错，Agent 返回空时返回 ''
 */
async function ensureAssetPrompt(type, id, force = false) {
  const key = `${type}:${id}`
  if (generatingPromptKeys.value.includes(key)) return ''
  generatingPromptKeys.value.push(key)
  try {
    const res = type === 'character'
      ? await characterAPI.generatePrompt(id, epId.value, force, chatModelOverride(), chatConfigId())
      : type === 'scene'
        ? await sceneAPI.generatePrompt(id, epId.value, force, chatModelOverride(), chatConfigId())
        : await propAPI.generatePrompt(id, epId.value, force, chatModelOverride(), chatConfigId())
    const fp = res?.final_prompt || res?.finalPrompt || ''
    if (fp) applyFinalPrompt(type, id, fp)
    return fp
  } finally {
    generatingPromptKeys.value = generatingPromptKeys.value.filter(k => k !== key)
  }
}

/** 卡片上的「交给 Agent 重写」（Issue #32）：外部写入的最终提示词直接强制重生成 */
async function rewriteAssetPrompt(type, id) {
  if (isGeneratingPrompt(type, id)) return
  try {
    const fp = await ensureAssetPrompt(type, id, true)
    if (!fp) throw new Error(t('episode.asset.promptGenFailedRetry'))
    toast.success(t('episode.asset.promptRegenerated'))
  } catch (e) {
    toastServerMessage(e, { fallback: 'episode.asset.promptGenFailedRetry' })
  }
}

/**
 * 弹窗内生成最终提示词（不生图）；已有最终提示词时重新生成（force）。
 * 信息草稿改了还没保存时先保存，提示词按最新信息生成（Issue #24）。
 * 生成期间弹窗可能已切到别的资产：完成后只在弹窗仍是这个资产时写文本框，否则只提示。
 */
async function genAssetFinalPrompt() {
  const { open, type, item } = assetDetail.value
  if (!open || !item?.id) return
  const infoPatch = assetInfoPatch(type, item)
  if (!infoPatch) return
  if (Object.keys(infoPatch).length) {
    savingAssetDetail.value = true
    try {
      await persistAssetDetail(type, item, infoPatch)
      toast.success(t('episode.asset.savedBeforePrompt'))
    } catch (e) {
      toastServerMessage(e, { fallback: 'episode.asset.saveFailed' })
      return
    } finally {
      savingAssetDetail.value = false
    }
  }
  const force = !!(item.final_prompt || item.finalPrompt)
  try {
    const fp = await ensureAssetPrompt(type, item.id, force)
    if (!fp) throw new Error(t('episode.asset.promptGenFailedRetry'))
    if (isAssetDialogOn(type, item.id)) {
      assetPromptDraft.value = fp
      assetPromptDirty.value = false
      toast.success(force ? t('episode.asset.promptRegenerated') : t('episode.asset.promptGenerated'))
    } else {
      toast.success(t('episode.asset.promptReadyFor', { name: item.name || item.location || '' }))
    }
  } catch (e) {
    toastError(e, { fallback: 'episode.asset.promptGenFailed' })
  }
}

async function copyAssetFinalPrompt() {
  const text = assetPromptDraft.value || assetFinalPrompt.value
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    toast.success(t('episode.asset.promptCopied'))
  } catch {
    toast.error(t('episode.asset.copyFailed'))
  }
}

/**
 * 弹窗信息草稿里改了值的字段（不含最终提示词）：只提交真正修改过的字段。
 * 场景时间被清空时提示并返回 null（不可保存）。
 */
function assetInfoPatch(type, item) {
  const draft = assetDetailDraft.value
  const patch = {}
  if (type === 'character') {
    if (draft.appearance !== (item.appearance || '')) patch.appearance = draft.appearance
    if (draft.styling !== (item.styling || '')) patch.styling = draft.styling
  } else if (type === 'scene') {
    if (draft.prompt !== (item.prompt || '')) patch.prompt = draft.prompt
    if (draft.lighting !== (item.lighting || '')) patch.lighting = draft.lighting
    const time = draft.time.trim()
    if (!time) {
      toast.error(t('episode.asset.timeRequired'))
      return null
    }
    if (time !== (item.time || '')) patch.time = time
  } else if (draft.description !== (item.description || '')) {
    patch.description = draft.description
  }
  return patch
}

/**
 * PUT 资产并同步列表项与弹窗项。最终提示词一律以服务端返回行为准：
 * 改了影响画面的字段时旧提示词已被后端置空（Issue #24），场景改时间同理（Issue #21）。
 * await 之后只在弹窗仍是这个资产时回写草稿。
 */
async function persistAssetDetail(type, item, payload) {
  const res = type === 'character'
    ? await characterAPI.update(item.id, payload)
    : type === 'scene'
      ? await sceneAPI.update(item.id, payload)
      : await propAPI.update(item.id, payload)
  const fp = res?.final_prompt || null
  const patch = { final_prompt: fp, finalPrompt: fp }
  for (const key of Object.keys(payload)) {
    if (key !== 'final_prompt' && res?.[key] !== undefined) patch[key] = res[key]
  }
  Object.assign(item, patch)
  const list = type === 'character' ? chars.value : type === 'scene' ? scenes.value : propItems.value
  const target = list.find(x => x.id === item.id)
  if (target && target !== item) Object.assign(target, patch)
  if (isAssetDialogOn(type, item.id)) {
    if (type === 'scene') assetDetailDraft.value.time = item.time || ''
    assetPromptDraft.value = fp || ''
    assetPromptDirty.value = false
  }
}

async function saveAssetDetail() {
  const { open, type, item } = assetDetail.value
  if (!open || !item?.id) return
  const payload = assetInfoPatch(type, item)
  if (!payload) return
  // 手动编辑过最终提示词才提交；空串视为清空
  if (assetPromptDirty.value) payload.final_prompt = assetPromptDraft.value.trim() || ''
  if (!Object.keys(payload).length) {
    toast.info(t('episode.asset.noChanges'))
    return
  }
  savingAssetDetail.value = true
  try {
    await persistAssetDetail(type, item, payload)
    toast.success(t('episode.asset.saved'))
  } catch (e) {
    toastServerMessage(e, { fallback: 'episode.asset.saveFailed' })
  } finally {
    savingAssetDetail.value = false
  }
}

function assetImageSrc(item) {
  return mediaUrl(item?.image_url || item?.imageUrl || '')
}

function assetVersions(item) {
  const versions = item?.image_versions || item?.imageVersions
  if (!Array.isArray(versions)) return []
  return versions.filter(version => version?.url)
}

function versionImageSrc(version) {
  return mediaUrl(version?.url)
}

// 本集造型版本图（Issue #15）：styling_version.image_path 与资产图同样是相对路径
function stylingVersionSrc(character) {
  return versionImageSrc({ url: character?.styling_version?.image_path || '' })
}

function isCurrentAssetVersion(item, version) {
  const current = String(item?.image_url || item?.imageUrl || '').replace(/^\/+/, '')
  const candidate = String(version?.url || '').replace(/^\/+/, '')
  return Boolean(current && candidate && current === candidate)
}

async function selectAssetVersion(version) {
  const detail = assetDetail.value
  const path = String(version?.url || '').replace(/^\/+/, '')
  if (!detail.open || !detail.item?.id || !path || isCurrentAssetVersion(detail.item, version)) return
  switchingAssetVersion.value = true
  try {
    const payload = { image_url: path, local_path: path }
    if (detail.type === 'character') await characterAPI.update(detail.item.id, payload)
    else if (detail.type === 'scene') await sceneAPI.update(detail.item.id, payload)
    else await propAPI.update(detail.item.id, payload)
    detail.item.image_url = path
    detail.item.imageUrl = path
    for (const candidate of assetVersions(detail.item)) candidate.is_current = candidate.url === version.url
    const list = detail.type === 'character' ? chars.value : detail.type === 'scene' ? scenes.value : propItems.value
    const target = list.find(item => item.id === detail.item.id)
    if (target && target !== detail.item) Object.assign(target, detail.item)
    toast.success(t('episode.asset.versionSelected'))
  } catch (e) {
    toastError(e, { fallback: 'episode.asset.versionSelectFailed' })
  } finally {
    switchingAssetVersion.value = false
  }
}

function assetDetailTitle(detail) {
  if (!detail?.item) return ''
  if (detail.type === 'character') return detail.item.name || t('episode.asset.unnamedChar')
  if (detail.type === 'prop') return detail.item.name || t('episode.asset.unnamedProp')
  return detail.item.location || t('episode.asset.unnamedScene')
}

/** 资产详情弹窗 kicker / aria-label 用长标签 */
function assetTypeLabel(type) {
  return { character: t('episode.asset.typeChar'), scene: t('episode.asset.typeScene'), prop: t('episode.asset.typeProp') }[type] || t('episode.asset.fallbackType')
}

/** 资产详情预览图标题（角色形象/场景图/道具图） */
function assetDetailImageTitle(detail) {
  if (!detail?.item) return ''
  const kindLabel = detail.type === 'character' ? t('episode.asset.charPortrait') : detail.type === 'scene' ? t('episode.asset.sceneImage') : t('common.prop')
  return `${assetDetailTitle(detail)} ${kindLabel}`
}

function characterAppearanceValue(char) {
  return char?.appearance || t('episode.asset.appearanceTodo')
}

function characterStylingValue(char) {
  return char?.styling || t('episode.asset.stylingTodo')
}

function characterVisualSummary(char) {
  return `${t('episode.asset.appearance')}${characterAppearanceValue(char)} · ${t('episode.asset.styling')}${characterStylingValue(char)}`
}

function sceneDescriptionValue(scene) {
  return scene?.prompt || scene?.description || t('episode.asset.sceneDescTodo')
}

function sceneLightingValue(scene) {
  return scene?.lighting || t('episode.asset.sceneLightTodo')
}

function handleImageViewerKeydown(event) {
  if (event.key !== 'Escape') return
  if (imageViewer.value.open) closeImageViewer()
  else if (assetDetail.value.open) closeAssetDetail()
  // 任务中心抽屉自己处理 Esc（TaskCenterButton）
}

onMounted(() => {
  window.addEventListener('keydown', handleImageViewerKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleImageViewerKeydown)
  stopVideoBatchPolling()
})

function isPendingSceneImage(id) {
  return isAssetImagePending('scene', id)
}

function isPendingVideo(id) {
  return pendingVideoIds.value.includes(id)
}

function videoFailMessage(id) {
  return failedVideoMessages.value[id] || ''
}

// 内容审核类失败（真人/敏感内容，如火山的 OutputVideoSensitiveContentDetected）：
// 各厂商审核尺度不同，给出切换模型重试的引导
function videoModerationHint(msg) {
  return MODERATION_RE.test(String(msg || '')) ? t('episode.vid.moderationHint') : ''
}

function videoTaskState(sb) {
  // 活跃任务优先：有旧视频的镜头重绘中不能显示「已完成」（#28，与 #25 的根因 A 同源）
  if (latestActiveVideoTask(sb?.id) || isPendingVideo(sb?.id)) return 'pending'
  if (hasVid(sb)) return 'done'
  if (videoFailMessage(sb?.id)) return 'failed'
  return 'ready'
}

/**
 * 进行中（queued/processing）视频任务 → 进度环属性；无进行中任务返回 null（不显示环）。
 * 只认活跃任务：hasVid 的「已有旧视频」不再吞掉重生成中的进度（#28）。
 */
function videoRing(sb) {
  const task = latestActiveVideoTask(sb?.id)
  return task ? ringPropsFromTask(task, now.value) : null
}

/** 秒 → 紧凑时长（`Xm Ys` / `Xs`），ETA 与已用时共用 */
function fmtDur(seconds) {
  const total = Math.round(Number(seconds))
  if (!Number.isFinite(total) || total < 0) return ''
  if (total < 60) return `${total}s`
  const m = Math.floor(total / 60)
  const s = total % 60
  return s ? `${m}m ${s}s` : `${m}m`
}

function videoTaskStatusLabel(sb) {
  const state = videoTaskState(sb)
  if (state === 'done') return t('episode.status.done')
  if (state === 'pending') return t('episode.status.generating')
  if (state === 'failed') return t('episode.status.failed')
  return t('episode.status.todo')
}

function videoTaskActionLabel(sb) {
  const state = videoTaskState(sb)
  if (state === 'done') return t('episode.asset.regen')
  if (state === 'pending') return t('episode.asset.generating')
  return t('episode.asset.generate')
}

/** 视频提示词区旁的视频重跑入口：显式文案（重绘 / 生成视频），避免与「重新生成提示词」混淆 */
function promptHeadVideoActionLabel(sb) {
  const state = videoTaskState(sb)
  if (state === 'done') return t('episode.asset.regen')
  if (state === 'pending') return t('episode.asset.generating')
  return t('episode.vid.generateVideo')
}

const allVideoTaskRows = computed(() => sbs.value.map((sb, index) => {
  const duration = Number(sb.duration || 5)
  const referenceCount = shotVideoRefCount(sb)
  const sceneName = getSceneName(sb)
  return {
    id: sb.id,
    index,
    storyboard: sb,
    title: sb.description || t('episode.vid.shotN', { n: String(index + 1).padStart(2, '0') }),
    meta: sceneName,
    duration: Number.isFinite(duration) ? duration : 5,
    referenceCount,
    state: videoTaskState(sb),
    // 只有当前处于失败状态才显示错误,避免重试成功的分镜残留历史错误信息
    error: videoTaskState(sb) === 'failed' ? videoFailMessage(sb.id) : '',
  }
}))
// 列表筛选：点击顶部统计徽章过滤（再点一次取消）
const videoListFilter = ref('')
const videoTaskRows = computed(() => videoListFilter.value
  ? allVideoTaskRows.value.filter(task => task.state === videoListFilter.value)
  : allVideoTaskRows.value)
const videoTaskDoneCount = computed(() => allVideoTaskRows.value.filter(task => task.state === 'done').length)
const videoTaskFailedCount = computed(() => allVideoTaskRows.value.filter(task => task.state === 'failed').length)
function toggleVideoFilter(state) {
  videoListFilter.value = videoListFilter.value === state ? '' : state
}

// ===== 批量视频：选择模式 + 生成前确认（视频生成成本高，避免误触全量触发） =====
const videoSelectMode = ref(false)
const selectedVideoSbIds = ref([])
const batchVideoConfirm = ref({ open: false, loading: false, scoped: false, ids: [], items: [] })

function isVideoSbSelected(id) { return selectedVideoSbIds.value.includes(id) }
function toggleVideoSbSelect(id) {
  selectedVideoSbIds.value = isVideoSbSelected(id)
    ? selectedVideoSbIds.value.filter(item => item !== id)
    : [...selectedVideoSbIds.value, id]
}
function toggleVideoSelectMode() {
  videoSelectMode.value = !videoSelectMode.value
  if (!videoSelectMode.value) selectedVideoSbIds.value = []
}
function onVideoTaskRowClick(sb) {
  if (videoSelectMode.value) toggleVideoSbSelect(sb.id)
  else selectedSb.value = sb
}

// 旁白角色识别：按内容语言的关键词匹配（提取产物中的旁白角色不参与画面生成）
function isNarratorCharacter(char) {
  const text = `${char?.name || ''} ${char?.role || ''}`.toLowerCase()
  return ['旁白', '画外音', 'narrator', 'ナレーター', 'ナレーション', '내레이션', '해설'].some(k => text.includes(k))
}

const visualChars = computed(() => chars.value.filter(c => !isNarratorCharacter(c)))
const lockedVideoConfigId = computed(() => episode.value?.video_config_id || episode.value?.videoConfigId || null)
// 集视频分辨率：顶栏直接修改（持久化 episodes.resolution，生成任务按此值锁定）。
// 内部统一存 480p/720p/1080p 三档，界面按当前选中的视频模型显示厂商原生档位
// （Seedance 480p/720p、MiniMax 768P/2K），适配器再映射为官方枚举
const RESOLUTION_TIERS = {
  volcengine: ['480p', '720p'],
  minimax: ['720p', '1080p'],
  comfyui: ['480p', '720p', '1080p'],
}
const RESOLUTION_DISPLAY = {
  volcengine: { '480p': '480p', '720p': '720p', '1080p': '720p' },
  minimax: { '480p': '768P', '720p': '768P', '1080p': '2K' },
  comfyui: { '480p': '480p', '720p': '720p', '1080p': '1080p' },
}
const resolutionProvider = computed(() => RESOLUTION_TIERS[selectedVideoConfig.value?.provider] ? selectedVideoConfig.value.provider : 'volcengine')
const resolutionOptions = computed(() => RESOLUTION_TIERS[resolutionProvider.value].map(key => ({
  key,
  model: `${RESOLUTION_DISPLAY[resolutionProvider.value][key]} · ${t(`episode.resolution.${key === '480p' ? 'smooth' : key === '720p' ? 'hd' : 'uhd'}`)}`,
})))
const episodeResolution = computed({
  get: () => {
    const v = episode.value?.resolution
    return resolutionOptions.value.some(o => o.key === v) ? v : '720p'
  },
  set: (val) => { void changeEpisodeResolution(val) },
})
async function changeEpisodeResolution(val) {
  if (!episode.value || val === episodeResolution.value) return
  const prev = episode.value.resolution
  episode.value.resolution = val
  const label = resolutionOptions.value.find(o => o.key === val)?.model || val
  try {
    await episodeAPI.update(epId.value, { resolution: val })
    toast.success(t('episode.vid.resolutionSwitched', { label }))
  } catch (e) {
    episode.value.resolution = prev
    toastError(e)
  }
}
// 项目画幅（项目设置中可改），关键帧与视频统一使用
const dramaAspectRatio = computed(() => drama.value?.aspect_ratio || drama.value?.aspectRatio || '16:9')

// 生成可选模型列表：配置中的模型数组（首位为配置默认）；API 可能返回数组或 JSON 字符串
function configModels(cfg) {
  const raw = cfg?.model
  if (!raw) return []
  if (Array.isArray(raw)) return raw.filter(Boolean)
  try { const m = JSON.parse(raw); return Array.isArray(m) ? m.filter(Boolean) : [m].filter(Boolean) } catch { return [raw].filter(Boolean) }
}
// 汇总该类型全部启用配置的模型（按 厂商+模型 去重，按优先级排序），选中模型时连同所属配置一起调用
// 选中值使用 'provider/model' 复合键：同名模型可能来自不同厂商（如中转站与官方），必须区分
function collectModelOptions(cfgs) {
  const seen = new Set()
  const out = []
  const sorted = [...cfgs].filter(c => c.is_active).sort((a, b) => (b.priority || 0) - (a.priority || 0))
  for (const c of sorted) {
    for (const m of configModels(c)) {
      const key = `${c.provider}/${m}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ key, model: m, provider: c.provider, configId: c.id, configName: c.name || c.provider })
    }
  }
  return out
}
// 复合键 → 裸模型名（后端适配器按厂商校验模型名，不能带 provider 前缀）
function bareModelName(key) {
  if (!key) return ''
  const i = key.indexOf('/')
  return i >= 0 ? key.slice(i + 1) : key
}
function ownerConfigId(options, key) {
  return key ? (options.find(o => o.key === key)?.configId || undefined) : undefined
}
function hasMultiConfigs(options) {
  return new Set(options.map(o => o.configId)).size > 1
}
const textModelOptions = computed(() => collectModelOptions(textConfigs.value))
const imageModelOptions = computed(() => collectModelOptions(imageConfigs.value))
const videoModelOptions = computed(() => collectModelOptions(videoConfigs.value))
const selectedVideoConfig = computed(() => {
  const selected = videoModelOptions.value.find(option => option.key === videoModel.value)
  if (selected) return videoConfigs.value.find(config => config.id === selected.configId)
  const locked = videoConfigs.value.find(config => config.id === lockedVideoConfigId.value && config.is_active)
  if (locked) return locked
  return [...videoConfigs.value]
    .filter(config => config.is_active)
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))[0]
})
// 本次生成的生效配置（模型/分辨率/时长），用于右侧小结与批量确认弹窗
const effectiveVideoModelLabel = computed(() => {
  const explicit = bareModelName(videoModel.value)
  if (explicit) return explicit
  return configModels(selectedVideoConfig.value)[0] || ''
})
// 关键帧生图的生效配置：顶栏生图模型独立于视频模型，未显式选择时取优先级最高的启用配置
const selectedImageConfig = computed(() => {
  const selected = imageModelOptions.value.find(option => option.key === imageModel.value)
  if (selected) return imageConfigs.value.find(config => config.id === selected.configId)
  const locked = imageConfigs.value.find(config => config.id === (episode.value?.image_config_id || episode.value?.imageConfigId) && config.is_active)
  if (locked) return locked
  return [...imageConfigs.value]
    .filter(config => config.is_active)
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))[0]
})
const effectiveImageModelLabel = computed(() =>
  bareModelName(imageModel.value) || configModels(selectedImageConfig.value)[0] || '')
const episodeResolutionLabel = computed(() =>
  resolutionOptions.value.find(o => o.key === episodeResolution.value)?.model || episodeResolution.value)
// 短档位标签（480p / 768P / 2K 等厂商原生档位），用于底部生效配置小结
const episodeResolutionShort = computed(() =>
  RESOLUTION_DISPLAY[resolutionProvider.value][episodeResolution.value] || episodeResolution.value)
const effectiveVideoDuration = computed(() => Number(selectedSb.value?.duration || 10))
// ===== 单镜视频耗时预估（#28）：实测墙钟（提交→完成），config/model/duration 变化后防抖重取 =====
const videoEstimate = ref({ loading: false, data: null })
let videoEstimateTimer = null
let videoEstimateSeq = 0
// selectedSb 在 setup 更后面才声明，watch 的 getter 在 immediate 时会立刻求值 → 必须挂到 onMounted 之后再注册
onMounted(() => {
  watch(() => [selectedSb.value?.id, videoModel.value, selectedVideoConfig.value?.id, effectiveVideoModelLabel.value, effectiveVideoDuration.value], () => {
    if (videoEstimateTimer) { clearTimeout(videoEstimateTimer); videoEstimateTimer = null }
    videoEstimate.value = { loading: true, data: null }
    videoEstimateTimer = setTimeout(() => { void loadVideoEstimate() }, 300)
  }, { immediate: true })
})
async function loadVideoEstimate() {
  const seq = ++videoEstimateSeq
  try {
    const data = await videoQueueAPI.estimate({
      config_id: selectedVideoConfig.value?.id || undefined,
      model: effectiveVideoModelLabel.value || undefined,
      duration: effectiveVideoDuration.value,
    })
    if (seq !== videoEstimateSeq) return // 过期响应丢弃
    videoEstimate.value = { loading: false, data }
  } catch {
    if (seq !== videoEstimateSeq) return
    videoEstimate.value = { loading: false, data: null } // 拿不到就回落「暂无预估」
  }
}
onBeforeUnmount(() => { if (videoEstimateTimer) clearTimeout(videoEstimateTimer) })
// 生成中已用时间：本地时钟（useNowTicker）从任务 created_at 持续推导，不用接口快照
function taskCreatedUnix(t) { return t?.created_at_unix ?? (t?.created_at ? Math.floor(Date.parse(t.created_at) / 1000) : null) }
const activeVideoElapsedSeconds = computed(() => {
  const task = latestActiveVideoTask(selectedSb.value?.id)
  const created = task ? taskCreatedUnix(task) : null
  return created ? Math.max(0, Math.floor(now.value / 1000 - created)) : null
})
// footer 预估文案：生成中显示「已用 … / 预计 …」，平时只显示预估；墙钟口径须称「预计完成/总耗时」
const videoEstimateBaseText = computed(() => {
  const { loading, data } = videoEstimate.value
  if (loading) return t('episode.vid.etaEstimating')
  if (!data || data.supported === false || data.run_seconds == null) return t('episode.vid.etaNone')
  const fallback = data.basis === 'fallback-model'
  return t(fallback ? 'episode.vid.etaFallback' : 'episode.vid.etaValue', {
    time: fmtDur(data.run_seconds),
    n: Number(data.samples) || 0,
    model: (fallback ? data.source_model : data.requested_model) || '',
  })
})
const videoEtaLine = computed(() => {
  const used = activeVideoElapsedSeconds.value
  if (used == null) return videoEstimateBaseText.value
  return `${t('episode.vid.elapsedUsed', { time: fmtDur(used) })} / ${videoEstimateBaseText.value}`
})
const checkedVideoItems = computed(() => batchVideoConfirm.value.items.filter(item => item.checked))
const batchVideoTotalDuration = computed(() => checkedVideoItems.value.reduce((sum, item) => {
  const sb = sbs.value.find(s => s.id === item.storyboard_id)
  return sum + (Number(sb?.duration) || 5)
}, 0))

function setAllVideoChecked(value) {
  for (const item of batchVideoConfirm.value.items) {
    if (!item.selectable) continue
    item.checked = value
  }
}
function videoPreviewStatusLabel(item) {
  if (item.status === 'missing') return t('episode.vid.previewMissing')
  if (item.status === 'changed') return t('episode.vid.previewChanged')
  if (item.status === 'unchanged') return t('episode.vid.previewUnchanged', { n: Number(item.matched_version_no) || 0 })
  if (item.status === 'unknown') return t('episode.vid.previewUnknown')
  if (item.status === 'blocked') return t('episode.vid.previewBlocked')
  return t('episode.vid.previewSkipped')
}
function videoPreviewReason(item) {
  if (item.status === 'changed' && item.change_reasons?.length) {
    return t('episode.vid.previewChangedReason', { parts: item.change_reasons.join(t('common.listJoin')) })
  }
  return item.reason || ''
}

/** 批量视频确认框 = 服务端预览清单（逐镜按输入签名比较）+ 勾选；选择模式只缩小预览范围 */
async function openBatchVideoConfirm(storyboardIds) {
  if (videoBatchRunning.value) { toast.info(t('episode.vid.batchAlreadyRunning')); return }
  const scoped = Boolean(storyboardIds?.length)
  batchVideoConfirm.value = { open: true, loading: true, scoped, ids: storyboardIds || [], items: [] }
  try {
    const res = await episodeAPI.previewVideoBatch(epId.value, {
      storyboard_ids: scoped ? storyboardIds : undefined,
      model: bareModelName(videoModel.value) || undefined,
      config_id: ownerConfigId(videoModelOptions.value, videoModel.value),
    })
    const items = (res?.items || []).map(item => ({ ...item, checked: Boolean(item.checked) }))
    batchVideoConfirm.value = { ...batchVideoConfirm.value, loading: false, items }
    if (!items.some(item => item.selectable)) toast.info(t('episode.vid.previewNothing'))
  } catch (e) {
    batchVideoConfirm.value = { open: false, loading: false, scoped: false, ids: [], items: [] }
    toastServerMessage(e, { fallback: 'episode.vid.previewFailed' })
  }
}
function batchVideos() {
  // 选择模式且有勾选 → 只预览所选；否则预览全集（已有视频的镜头按签名判断是否变化）
  const useSelection = videoSelectMode.value && selectedVideoSbIds.value.length
  openBatchVideoConfirm(useSelection ? [...selectedVideoSbIds.value] : null)
}
function retryFailedVideos() {
  openBatchVideoConfirm(sbs.value.filter(s => videoTaskState(s) === 'failed').map(s => s.id))
}
async function confirmBatchVideos() {
  // 串行批量在服务端执行：按分镜顺序逐镜生成，关键帧作为首/中/尾引导帧，提交后可关闭页面
  const ids = checkedVideoItems.value
    .slice()
    .sort((a, b) => (a.storyboard_number || 0) - (b.storyboard_number || 0))
    .map(item => item.storyboard_id)
  batchVideoConfirm.value = { open: false, loading: false, scoped: false, ids: [], items: [] }
  if (!ids.length) return
  try {
    applyVideoBatch(await episodeAPI.startVideoBatch(epId.value, {
      storyboard_ids: ids,
      model: bareModelName(videoModel.value) || undefined,
      config_id: ownerConfigId(videoModelOptions.value, videoModel.value),
    }))
    startVideoBatchPolling()
    toast.success(t('episode.vid.batchStarted', { n: ids.length }))
    if (videoSelectMode.value) toggleVideoSelectMode()
  } catch (e) {
    toastServerMessage(e, { fallback: 'episode.vid.genFailed' })
  }
}

// ===== 服务端串行批量视频：进度轮询 =====
const videoBatch = ref(null)
const videoBatchItems = computed(() => videoBatch.value?.items || [])
const videoBatchRunning = computed(() => videoBatch.value?.status === 'running')
const videoBatchDoneCount = computed(() => videoBatchItems.value.filter(i => i.state === 'completed').length)
const videoBatchFailedItems = computed(() => videoBatchItems.value.filter(i => i.state === 'failed'))
const videoBatchSkippedItems = computed(() => videoBatchItems.value.filter(i => i.state === 'skipped'))
const videoBatchIssues = computed(() => [...videoBatchFailedItems.value, ...videoBatchSkippedItems.value])
const videoBatchCurrentNumber = computed(() => {
  const id = videoBatch.value?.current_storyboard_id ?? videoBatch.value?.currentStoryboardId ?? null
  return videoBatchItems.value.find(i => i.storyboard_id === id)?.storyboard_number || 0
})
const videoBatchStatusLabel = computed(() => {
  const status = videoBatch.value?.status
  if (status === 'running') return t(videoBatchStopping.value ? 'episode.vid.batchStateStopping' : 'episode.vid.batchStateRunning')
  if (status === 'cancelled') return t('episode.vid.batchStateCancelled')
  return t('episode.vid.batchStateDone')
})
// 已请求停止：在跑的那一镜跑完后批次才转为已停止
const videoBatchStopping = computed(() => videoBatchRunning.value && Boolean(videoBatch.value?.cancel_requested))
const videoBatchVisible = computed(() => Boolean(videoBatch.value) && (videoBatchRunning.value || videoBatchIssues.value.length > 0))
let videoBatchTimer = null
let videoBatchSettledCount = -1

// 批量状态回写到列表：正在生成的镜头标为生成中，失败原因沿用列表的失败提示
function applyVideoBatch(status) {
  const batch = status && status.status ? status : null
  videoBatch.value = batch
  const batchIds = new Set(videoBatchItems.value.map(i => i.storyboard_id))
  const runningId = batch?.status === 'running' ? (batch.current_storyboard_id ?? batch.currentStoryboardId ?? null) : null
  pendingVideoIds.value = pendingVideoIds.value.filter(id => !batchIds.has(id) || id === runningId)
  if (runningId && !pendingVideoIds.value.includes(runningId)) pendingVideoIds.value.push(runningId)
  for (const item of videoBatchItems.value) {
    if (item.state === 'failed' && item.error) {
      failedVideoMessages.value = { ...failedVideoMessages.value, [item.storyboard_id]: item.error }
    }
  }
  return batch
}
async function loadVideoBatch() {
  if (!epId.value) return
  let batch = null
  try {
    batch = applyVideoBatch(await episodeAPI.videoBatch(epId.value))
  } catch { return }
  const settled = videoBatchItems.value.filter(i => i.state !== 'pending' && i.state !== 'running').length
  const wasPolling = Boolean(videoBatchTimer)
  if (videoBatchSettledCount >= 0 && settled !== videoBatchSettledCount) await refresh() // 每完成一镜刷新，视频逐个出现
  videoBatchSettledCount = settled
  if (batch?.status === 'running') {
    startVideoBatchPolling()
  } else {
    stopVideoBatchPolling()
    if (wasPolling) {
      await refresh()
      toast.success(batch?.status === 'cancelled' ? t('episode.vid.batchCancelledToast') : t('episode.vid.batchDoneToast'))
    }
  }
}
function startVideoBatchPolling() {
  if (!videoBatchTimer) videoBatchTimer = setInterval(loadVideoBatch, 10_000)
}
function stopVideoBatchPolling() {
  if (videoBatchTimer) { clearInterval(videoBatchTimer); videoBatchTimer = null }
}
async function cancelVideoBatch() {
  try {
    applyVideoBatch(await episodeAPI.cancelVideoBatch(epId.value))
    toast.success(t('episode.vid.batchStopped'))
  } catch (e) {
    toastError(e)
  }
}

// 配置变化后校验持久化的模型是否仍存在（配置被删/模型被移除时回退默认，避免把失效模型传给后端）
function pruneStaleModel(modelRef, optionsRef) {
  watch(optionsRef, opts => {
    if (!modelRef.value || !opts.length) return
    if (opts.some(o => o.key === modelRef.value)) return
    // 旧版本地存储只有裸模型名：能对上则升级为复合键，对不上回退默认
    const legacy = opts.filter(o => o.model === modelRef.value)
    modelRef.value = legacy.length ? legacy[0].key : ''
  }, { immediate: true })
}
pruneStaleModel(chatModel, textModelOptions)
pruneStaleModel(imageModel, imageModelOptions)
pruneStaleModel(videoModel, videoModelOptions)
const textModelMultiCfg = computed(() => hasMultiConfigs(textModelOptions.value))
const imageModelMultiCfg = computed(() => hasMultiConfigs(imageModelOptions.value))
const videoModelMultiCfg = computed(() => hasMultiConfigs(videoModelOptions.value))

// Production step helpers
// ========== 分镜视频状态：从全局任务 store 恢复 ==========
const episodeVideoTasks = computed(() =>
  episodeTasks(epId.value).filter(task => task.type === 'video' && task.storyboard_id))

/**
 * 生成中/失败只是页面内存状态，刷新后会丢；按分镜取最新一条 sys_task 重建，
 * 否则已失败的镜头刷新后会退化成「待生成」。
 */
function syncVideoStateFromTasks() {
  // 每个分镜只取最新一条任务(created_at 降序、id 兜底),旧任务不干预当前状态
  const latestBySb = new Map()
  for (const task of episodeVideoTasks.value) {
    const prev = latestBySb.get(task.storyboard_id)
    if (!prev
      || String(task.created_at || '') > String(prev.created_at || '')
      || (String(task.created_at || '') === String(prev.created_at || '') && task.id > prev.id)) {
      latestBySb.set(task.storyboard_id, task)
    }
  }
  // pending/failed 全量重建而非与现有值并集——否则刷新恢复的"生成中"在任务失败后
  // 永不消退(videoTaskState 中 pending 优先于 failed,重试按钮还被禁用)
  const pending = new Set()
  const failed = {}
  for (const [sbId, task] of latestBySb) {
    // 分镜已有视频(失败后重试成功)时不再报历史错误
    if (hasVid(sbs.value.find(s => s.id === sbId))) continue
    if (isActiveTaskStatus(task.status)) pending.add(sbId)
    else if (task.status === 'failed') failed[sbId] = task.error_msg || t('episode.status.failed')
  }
  // 刚点击提交、任务记录尚未进 store 的本地状态保留,避免状态闪退
  for (const id of pendingVideoIds.value) if (!latestBySb.has(id)) pending.add(id)
  for (const id of Object.keys(failedVideoMessages.value)) {
    if (!latestBySb.has(Number(id))) failed[id] = failedVideoMessages.value[id]
  }
  pendingVideoIds.value = [...pending]
  failedVideoMessages.value = failed
}
// immediate：进页时 store 可能已有本集任务；storyboards 稍后到位时也要重算（有视频的镜头不报历史错误）
watch([episodeVideoTasks, sbs], syncVideoStateFromTasks, { immediate: true })

const productionBlockMessage = computed(() => {
  if (!scriptContent.value) return t('episode.prod.scriptFirst')
  return ''
})
const productionBlockActionLabel = computed(() => {
  if (!scriptContent.value) return t('episode.export.gotoScript')
  return t('episode.prod.goBack')
})
function goProductionBlockTarget() {
  if (!scriptContent.value) {
    panel.value = 'script'
    scriptStep.value = rawContent.value ? 1 : 0
    return
  }
  panel.value = 'production'
  prodTab.value = 'assets'
}
const stepLabels = computed(() => [t('episode.script.raw'), t(isDocumentaryProject.value ? 'episode.rewrite.narrationRewrite' : 'episode.script.rewrite')])

const charImgCount = computed(() => visualChars.value.filter(c => c.image_url || c.imageUrl).length)
const sceneImgCount = computed(() => scenes.value.filter(s => s.image_url || s.imageUrl).length)
const propImgCount = computed(() => propItems.value.filter(p => p.image_url || p.imageUrl).length)
const shotVidCount = computed(() => sbs.value.filter(s => s.video_url || s.videoUrl).length)
const visualCharTotal = computed(() => visualChars.value.length)
const pendingCharacterImageCount = computed(() => Math.max(visualCharTotal.value - charImgCount.value, 0))
const pendingSceneImageCount = computed(() => Math.max(scenes.value.length - sceneImgCount.value, 0))
const pendingAssetImageCount = computed(() => pendingCharacterImageCount.value + pendingSceneImageCount.value)
const assetTotalCount = computed(() => visualCharTotal.value + scenes.value.length + propItems.value.length)
const assetReadyCount = computed(() => charImgCount.value + sceneImgCount.value + propImgCount.value)

// 纪录片 7 步（Issue #63）：剧本 → 资产 → Poster（可选）→ 分镜设计 → 分镜制作 → 视频与成品 → 导出；
// 剧情项目的页签与步骤定义与 #54 之前逐项一致。
const prodTabDefs = computed(() => (isDocumentaryProject.value
  ? [
      { id: 'assets', label: t('episode.prod.assets'), icon: FolderKanban, badge: assetTotalCount.value ? `${assetReadyCount.value}/${assetTotalCount.value}` : '' },
      { id: 'poster', label: t('episode.prod.poster'), icon: ImageIcon, badge: posterData.value?.final_image ? '✓' : '' },
      { id: 'design', label: t('episode.prod.design'), icon: Lightbulb, badge: sbs.value.length ? `${gateState.value.design.confirmed}/${sbs.value.length}` : '' },
      { id: 'production', label: t('episode.prod.production'), icon: Images, badge: sbs.value.length ? `${keyframesConfirmedCount.value}/${sbs.value.length}` : '' },
      { id: 'final', label: t('episode.prod.final'), icon: Clapperboard, badge: sbs.value.length ? `${shotVidCount.value}/${sbs.value.length}` : '' },
    ]
  : [
      { id: 'assets', label: t('episode.prod.assets'), icon: FolderKanban, badge: assetTotalCount.value ? `${assetReadyCount.value}/${assetTotalCount.value}` : '' },
      { id: 'poster', label: t('episode.prod.poster'), icon: ImageIcon, badge: posterData.value?.final_image ? '✓' : '' },
      { id: 'keyframes', label: t('episode.prod.keyframes'), icon: Images, badge: sbs.value.length ? `${keyframesConfirmedCount.value}/${sbs.value.length}` : '' },
      { id: 'videos', label: t('episode.prod.videos'), icon: Clapperboard, badge: sbs.value.length ? `${shotVidCount.value}/${sbs.value.length}` : '' },
    ]))

const mainStageDefs = computed(() => (isDocumentaryProject.value
  ? [
      { id: 'script', label: t('episode.stage.narrationScript'), desc: t('episode.stage.narrationScriptDesc'), icon: FileText },
      { id: 'assets', label: t('episode.prod.assets'), desc: t('episode.stage.evidenceAssetsDesc'), icon: FolderKanban },
      { id: 'poster', label: t('episode.prod.poster'), desc: t('episode.stage.posterDesc'), icon: ImageIcon, optional: true },
      { id: 'design', label: t('episode.prod.design'), desc: t('episode.stage.designDesc'), icon: Lightbulb },
      { id: 'production', label: t('episode.prod.production'), desc: t('episode.stage.productionDesc'), icon: Images },
      { id: 'final', label: t('episode.prod.final'), desc: t('episode.stage.finalDesc'), icon: Clapperboard },
      { id: 'export', label: t('episode.stage.export'), desc: t('episode.stage.exportDesc'), icon: Download },
    ]
  : [
      { id: 'script', label: t('episode.stage.script'), desc: t('episode.stage.scriptDesc'), icon: FileText },
      { id: 'assets', label: t('episode.prod.assets'), desc: t('episode.stage.assetsDesc'), icon: FolderKanban },
      { id: 'poster', label: t('episode.prod.poster'), desc: t('episode.stage.posterDesc'), icon: ImageIcon },
      { id: 'keyframes', label: t('episode.prod.keyframes'), desc: t('episode.stage.keyframesDesc'), icon: Images },
      { id: 'videos', label: t('episode.stage.videos'), desc: t('episode.stage.videosDesc'), icon: Clapperboard },
      { id: 'export', label: t('episode.stage.export'), desc: t('episode.stage.exportDesc'), icon: Download },
    ]))

// 步骤门禁（#54）：服务端是唯一判定方，界面只渲染它给的解锁位 / 原因 / 跳转目标；
// 门禁未判定（ready=false：首屏尚未取到 /gates，或取数失败）时按锁定渲染，内容绝不先闪出来
const { gates: gateState, ready: gatesReady, applyGates, refreshGates, reasonOf: gateReasonOf, gotoOf: gateGotoOf } = useWorkflowGates(() => epId.value)
function stageGateUnknown(stageId) {
  return isStageGateUnknown({ documentary: isDocumentaryProject.value, stageId, gatesReady: gatesReady.value })
}
function stageLocked(stageId) {
  return isStageLocked({
    documentary: isDocumentaryProject.value,
    stageId,
    gatesReady: gatesReady.value,
    unlocked: gateState.value.unlocked,
  })
}
function stageLockReason(stageId) {
  if (stageGateUnknown(stageId)) return ''
  return stageLocked(stageId) ? gateReasonOf(stageId) : ''
}
/** 点锁定步骤时跳到真正阻塞它的那一步，而不是停在原地 */
function goStageBlocker(stageId) {
  const target = gateGotoOf(stageId)
  goMainStage(target || stageId)
}

// 项目类型决定页签集合：旧链接（expression/layers 与纪录片下的 keyframes/videos）统一经
// remapProdTab 归一，映射后仍非法才落回「资产」。项目尚未加载时不判定——此时类型未知。
watch([() => drama.value?.project_type, prodTabDefs], ([type]) => {
  if (!type) return
  prodTab.value = remapProdTab(prodTab.value, type)
  assetTab.value = remapAssetTab(assetTab.value, type)
}, { immediate: true })

// 切换制作页签时重算门禁（裁决：refresh / 剧本保存确认 / 任务结束 / 页签切换）。
// 导航类刷新是前台的：先作废上一次判定，拿到新结果前新步骤只渲染「校验中」，
// 不拿上一轮的解锁缓存放行（任务结束 / 剧本保存走 background，不打断正在看的内容）。
watch([prodTab, panel], () => { if (epId.value) refreshGates() })

const sidebarSections = computed(() => ([
  {
    id: 'script',
    label: isDocumentaryProject.value ? t('episode.stage.narrationScript') : t('episode.stage.script'),
    items: [
      { key: 'script:raw', label: t('episode.script.raw'), desc: '', icon: FileText },
      { key: 'script:rewrite', label: t(isDocumentaryProject.value ? 'episode.rewrite.narrationRewrite' : 'episode.script.rewrite'), desc: '', icon: FileText },
    ],
  },
  {
    id: 'production',
    label: t('episode.stage.production'),
    items: prodTabDefs.value.map(def => ({
      key: `prod:${def.id}`,
      label: def.label,
      desc: '',
      icon: def.id === 'assets' ? Users : def.icon,
      locked: stageLocked(def.id),
      lockReason: stageLockReason(def.id),
      optional: def.id === 'poster' && isDocumentaryProject.value,
    })),
  },
  {
    id: 'export',
    label: t('episode.stage.export'),
    items: [
      { key: 'export:merge', label: t('episode.stage.mergeExport'), desc: '', icon: Download },
    ],
  },
]))

// 大环节状态:pending(未开始)/ active(进行中)/ done(已完成)/ none(不显示状态,导出用)
// 进行中 = 环节内有任意进度但未全部完成,或当前正处于该环节
function sectionState(sectionId) {
  if (sectionId === 'export') return 'none'
  // 制作段完成 = 本项目类型下制作各步骤（Poster 可选除外）全部完成
  const prodStages = prodTabDefs.value.map(def => def.id).filter(id => id !== 'poster')
  const done = sectionId === 'script'
    ? mainStageDone('script')
    : prodStages.every(id => mainStageDone(id))
  if (done) return 'done'

  const hasProgress = sectionId === 'script'
    ? !!(rawContent.value || scriptContent.value)
    : !!(chars.value.length || scenes.value.length || propItems.value.length || sbs.value.length || shotVidCount.value)
  const isCurrent = sectionId === 'script'
    ? panel.value === 'script'
    : panel.value === 'production'
  return (hasProgress || isCurrent) ? 'active' : 'pending'
}

const activeMainStage = computed(() => {
  if (panel.value === 'export') return 'export'
  if (panel.value === 'production') {
    // 制作子页签与主环节同名（drama: assets/poster/keyframes/videos；documentary: assets/poster/design/production/final）
    if (mainStageDefs.value.some(stage => stage.id === prodTab.value)) return prodTab.value
    return isDocumentaryProject.value ? 'final' : 'videos'
  }
  return 'script'
})

function mainStageDone(stageId) {
  if (stageId === 'script') {
    // 纪录片：旁白稿「定稿」= 已确认；剧情项目口径不变（有改写稿即完成）
    return isDocumentaryProject.value ? !!gateState.value.script.confirmed : !!scriptContent.value
  }
  if (stageId === 'assets') {
    if (isDocumentaryProject.value) return gateState.value.assets.review_status === 'passed'
    return assetTotalCount.value > 0 && assetReadyCount.value === assetTotalCount.value
  }
  // Poster 可选：有最终版本即视为完成，不参与制作分组 done 判定
  if (stageId === 'poster') return !!posterData.value?.final_image
  // 分镜设计（纪录片）：每镜设计卡都已确认
  if (stageId === 'design') {
    const { confirmed, total } = gateState.value.design
    return total > 0 && confirmed === total
  }
  // 分镜制作（纪录片）：每镜都制作就绪（R5 前过渡读 keyframes_confirmed）
  if (stageId === 'production') {
    const { ready, total } = gateState.value.production
    return total > 0 && ready === total
  }
  // 视频与成品（纪录片）：每镜成品都是最新的
  if (stageId === 'final') {
    const { fresh, total } = gateState.value.final
    return total > 0 && fresh === total
  }
  // 关键帧步骤完成 = 本集每个分镜的关键帧都已人工确认
  if (stageId === 'keyframes') return allKeyframesConfirmed.value
  if (stageId === 'videos') {
    return !!sbs.value.length && shotVidCount.value === sbs.value.length
  }
  if (stageId === 'export') return exportDone.value
  return false
}

function goMainStage(stageId) {
  if (stageId === 'script') {
    panel.value = 'script'
    scriptStep.value = Math.min(scriptStep.value, 1)
    return
  }
  // 制作环节与子页签同名：直接跳到对应页签（按项目类型的定义，未知 id 落回导出）
  if (prodTabDefs.value.some(def => def.id === stageId)) {
    panel.value = 'production'
    prodTab.value = stageId
    return
  }
  panel.value = 'export'
}

const activeSubStepKey = computed(() => {
  if (panel.value === 'script') {
    if (scriptStep.value === 0) return 'script:raw'
    return 'script:rewrite'
  }
  if (panel.value === 'production') return `prod:${prodTab.value}`
  return 'export:merge'
})

// 步骤跑马灯：主流程各段（按项目类型取定义），段点击跳转、当前段流动光效；
// 锁定段渲染锁图标 + 灰态，tooltip 给原因，点击跳到真正阻塞它的那一步（#54）
const mainProgressSteps = computed(() => mainStageDefs.value.map(stage => ({
  id: stage.id,
  label: stage.label,
  locked: stageLocked(stage.id),
  reason: stageLockReason(stage.id),
  optional: !!stage.optional,
})))
const currentMainIdx = computed(() => {
  const i = mainProgressSteps.value.findIndex(s => s.id === activeMainStage.value)
  return i < 0 ? 0 : i
})

function goSubStep(key) {
  if (key.startsWith('script:')) {
    panel.value = 'script'
    const stepMap = {
      'script:raw': 0,
      'script:rewrite': 1,
    }
    scriptStep.value = stepMap[key] ?? 0
    return
  }
  if (key.startsWith('prod:')) {
    const stageId = key.replace('prod:', '')
    // 锁定步骤照常进入：锁定空态会给出原因与「去解决」按钮（跳到真正阻塞它的那一步），
    // 而不是悄悄把人甩到别的步骤上——侧栏点击与 deeplink 两条路径看到的东西必须一致
    panel.value = 'production'
    prodTab.value = stageId
    return
  }
  panel.value = 'export'
}

const pipelineTotal = 2
const pipelineProgress = computed(() =>
  ['script', 'production'].filter(id => sectionState(id) === 'done').length
)

const currentStageLabel = computed(() => {
  if (panel.value === 'script') return t('episode.stage.scriptStage', { step: stepLabels.value[scriptStep.value] })
  if (panel.value === 'production') return t('episode.stage.prodStage', { step: prodTabDefs.value[prodTabIdx.value]?.label || t('episode.stage.production') })
  return exportDone.value ? t('episode.stage.exportDone') : t('episode.stage.exportWaiting')
})

const currentMainStageLabel = computed(() => {
  const current = mainStageDefs.value.find(stage => stage.id === activeMainStage.value)
  return current?.label || t('episode.stage.workbench')
})

const currentSubStageLabel = computed(() => currentStageLabel.value)

const totalDuration = computed(() => sbs.value.reduce((s, sb) => s + (sb.duration || 10), 0))
const selectedSb = ref(null)
const selectedVideoTaskNumber = computed(() => {
  const index = videoTaskRows.value.findIndex(task => String(task.id) === String(selectedSb.value?.id))
  return index >= 0 ? index + 1 : 0
})

// ===== 字段级保存状态：键为「分镜 id : 字段」，关键帧页与视频页共用 =====
// 自动保存且需要给出保存反馈的字段（其余字段如绑定 ids 只做一致性提示，不显示保存状态）
const SAVE_STATUS_FIELDS = ['description', 'atmosphere', 'first_frame_prompt', 'mid_frame_prompt', 'mid_frame_time', 'last_frame_prompt', 'video_prompt', 'transition_prompt', 'narration_text']
const fieldSaveStates = ref({})

function fieldSaveKey(sb, field) { return `${sb?.id}:${field}` }

/** 当前状态：本次会话有记录用会话状态，否则回落到服务端持久化的 field_saved_at */
function fieldSaveInfo(sb, field) {
  const state = fieldSaveStates.value[fieldSaveKey(sb, field)]
  if (state) return state
  const stamps = sb?.field_saved_at || sb?.fieldSavedAt || {}
  const at = Number(stamps?.[field] || 0)
  return { status: at ? 'loaded' : 'idle', at }
}
function setFieldSave(sb, field, status, at) {
  const key = fieldSaveKey(sb, field)
  const prev = fieldSaveInfo(sb, field)
  fieldSaveStates.value = { ...fieldSaveStates.value, [key]: { status, at: at ?? prev.at } }
}

/** 比较用归一：null / undefined / 空串视为同一个「空」，数字按字符串比 */
function sameFieldValue(a, b) {
  const norm = v => (v === null || v === undefined ? '' : String(v))
  return norm(a) === norm(b)
}

/** 输入过程中（未失焦）标记「有未保存的修改」；改回原值则回到原状态 */
function markFieldDirty(sb, field, value) {
  if (!sb || !SAVE_STATUS_FIELDS.includes(field)) return
  const current = sb[field] ?? sb[toCamel(field)]
  const prev = fieldSaveInfo(sb, field)
  if (sameFieldValue(value, current)) {
    const status = prev.status === 'dirty' ? (prev.at ? 'saved' : 'idle') : prev.status
    setFieldSave(sb, field, status, prev.at)
    return
  }
  setFieldSave(sb, field, 'dirty', prev.at)
}

// ===== 参考图 ↔ 提示词一致性问题（后端 ref_issues） =====
function refIssuesOf(sb) {
  const list = sb?.ref_issues || sb?.refIssues
  return Array.isArray(list) ? list : []
}
function refIssueKey(issue) {
  return `${issue?.code}|${issue?.kind || ''}|${issue?.asset_id ?? issue?.name ?? ''}|${(issue?.fields || []).join(',')}`
}
/** 保存/绑定/版本切换后只提示「新增」的问题，避免同一问题反复弹 */
function toastNewRefIssues(before, after) {
  const seen = new Set(before.map(refIssueKey))
  for (const issue of after.filter(i => !seen.has(refIssueKey(i)))) {
    if (issue.severity === 'block') toast.error(issue.message, { duration: 7000 })
    else toast.warning(issue.message)
  }
}
function toastRefSync(sync) {
  const names = list => list.map(item => item?.name).filter(Boolean).join(t('common.listJoin'))
  const bound = names(Array.isArray(sync?.bound) ? sync.bound : [])
  const unbound = names(Array.isArray(sync?.unbound) ? sync.unbound : [])
  if (bound) toast.info(t('episode.ref.autoBound', { names: bound }))
  if (unbound) toast.info(t('episode.ref.autoUnbound', { names: unbound }))
}

/** 把 PUT /storyboards/:id 的响应（同步后的绑定 / 一致性问题 / 保存时间）落到本地分镜对象 */
function applyStoryboardUpdate(sb, res, before, field) {
  if (!sb || !res || typeof res !== 'object') return
  const assign = (snake, value) => {
    sb[snake] = value
    sb[toCamel(snake)] = value
  }
  if (Array.isArray(res.character_ids)) assign('character_ids', res.character_ids)
  if (Array.isArray(res.prop_ids)) assign('prop_ids', res.prop_ids)
  if ('scene_id' in res) assign('scene_id', res.scene_id ?? null)
  // 本镜资产池（#43）：人工保存 / 池选择后，后端回包带回重算后的有效池（手选 ∪ 提示词 @）
  if (Array.isArray(res.pool_assets)) assign('pool_assets', res.pool_assets)
  // 手动保存转场描述后后端会把 edited_manually 置 true，这里同步回本地（#11）
  if ('transition_review' in res) assign('transition_review', res.transition_review ?? null)
  // 目标级参考图（#18）：提示词保存 / 目标选版后后端返回最新装配结果
  if (res.target_assets && typeof res.target_assets === 'object') assign('target_assets', res.target_assets)
  if (Array.isArray(res.ref_issues)) {
    assign('ref_issues', res.ref_issues)
    toastNewRefIssues(before || [], res.ref_issues)
  }
  if (res.ref_sync) toastRefSync(res.ref_sync)
  const savedAt = Number(res.saved_at)
  if (Number.isFinite(savedAt) && savedAt > 0 && field) {
    const stamps = { ...(sb.field_saved_at || sb.fieldSavedAt || {}), [field]: savedAt }
    assign('field_saved_at', stamps)
  }
}

/** 分镜字段自动保存：返回 Promise，按（分镜, 字段）维护保存状态 */
async function updateField(sb, field, value) {
  const current = sb[field] ?? sb[toCamel(field)]
  const tracked = SAVE_STATUS_FIELDS.includes(field)
  // 上次保存失败时同值再次失焦要能重发，其余同值不发请求
  if (current === value && !(tracked && fieldSaveInfo(sb, field).status === 'error')) {
    if (tracked) markFieldDirty(sb, field, value)
    return
  }
  sb[field] = value
  const camelField = toCamel(field)
  if (camelField !== field) sb[camelField] = value
  if (tracked) setFieldSave(sb, field, 'saving')
  const before = refIssuesOf(sb)
  try {
    const res = await storyboardAPI.update(sb.id, { [field]: value })
    const savedAt = Number(res?.saved_at)
    applyStoryboardUpdate(sb, res, before, field)
    if (tracked) setFieldSave(sb, field, 'saved', Number.isFinite(savedAt) && savedAt > 0 ? savedAt : Math.floor(Date.now() / 1000))
  } catch (e) {
    if (tracked) setFieldSave(sb, field, 'error')
    toastError(e)
  }
}

function toCamel(field) {
  return field.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
}

function getStoryboardCharacterIds(sb) {
  return sb?.character_ids || sb?.characterIds || []
}

function getStoryboardCharacters(sb) {
  const ids = getStoryboardCharacterIds(sb)
  return visualChars.value.filter(char => ids.includes(char.id))
}

function getStoryboardScene(sb) {
  const sceneId = sb?.scene_id || sb?.sceneId
  if (!sceneId) return null
  return scenes.value.find(s => s.id === sceneId) || null
}

function isStoryboardCharacterSelected(sb, charId) {
  return getStoryboardCharacterIds(sb).includes(charId)
}

function getStoryboardPropIds(sb) {
  return sb?.prop_ids || sb?.propIds || []
}

function getStoryboardProps(sb) {
  const ids = getStoryboardPropIds(sb)
  return propItems.value.filter(p => ids.includes(p.id))
}

function isStoryboardPropSelected(sb, propId) {
  return getStoryboardPropIds(sb).includes(propId)
}

function getSceneName(sb) {
  const scene = getStoryboardScene(sb)
  if (!scene) return ''
  return `${scene.location} · ${scene.time || t('episode.asset.noTime')}`
}

const sceneOptions = computed(() => [
  { label: t('episode.sb.unboundScene'), value: '' },
  ...scenes.value.map(s => ({ label: `${s.location} · ${s.time || t('episode.asset.noTime')}`, value: s.id })),
])


function sceneShotCount(sceneId) {
  return sbs.value.filter(sb => String(sb?.scene_id || sb?.sceneId || '') === String(sceneId)).length
}

watch(rawContent, v => { localRaw.value = v }, { immediate: true })
watch(scriptContent, v => { localScript.value = v }, { immediate: true })

async function refresh() {
  try {
    drama.value = await dramaAPI.get(dramaId)
    const ep = drama.value.episodes?.find(e => (e.episode_number || e.episodeNumber) === episodeNumber)
    if (ep) {
      episode.value = ep
      try { chars.value = await episodeAPI.characters(ep.id) } catch { chars.value = [] }
      try { scenes.value = await episodeAPI.scenes(ep.id) } catch { scenes.value = [] }
      try { propItems.value = await episodeAPI.props(ep.id) } catch { propItems.value = [] }
      sbs.value = await episodeAPI.storyboards(ep.id)
      selectedVideoSbIds.value = selectedVideoSbIds.value.filter(id => sbs.value.some(sb => sb.id === id))
      if (sbs.value.length) {
        const currentSelectedId = selectedSb.value?.id
        selectedSb.value = sbs.value.find(sb => sb.id === currentSelectedId) || sbs.value[0]
      } else {
        selectedSb.value = null
      }

      const epHasContent = !!(episode.value?.content)
      const epHasScript = !!(episode.value?.script_content || episode.value?.scriptContent)

      if (panelRestored) {
        // 已恢复到上次所在步骤，跳过自动重置（仅首次加载生效）
        panelRestored = false
      } else if (epHasScript || epHasContent) scriptStep.value = 1
      else scriptStep.value = 0
    }
  } catch (e) {
    toastError(e)
  }
  try { mergeData.value = await mergeAPI.status(epId.value) } catch {}
  await Promise.all([loadEpisodeTasks(epId.value), loadExportMerges(), refreshGates({ background: true })])
  if ((panel.value === 'production' && prodTab.value === 'poster') || panel.value === 'export') await loadPosterData()
}

// ─── 旁白稿确认（Issue #54）：纪录片门禁链的第一环 ───────────────
const confirmingScript = ref(false)
const scriptConfirmed = computed(() => !!gateState.value.script.confirmed)
const scriptConfirmedAt = computed(() => {
  const at = gateState.value.script.confirmed_at
  return at ? new Date(at).toLocaleString() : ''
})
async function confirmScript() {
  confirmingScript.value = true
  try {
    applyGates(await episodeAPI.confirmScript(epId.value))
    toast.success(t('episode.script.confirmed'))
  } catch (e) {
    toastError(e)
  } finally {
    confirmingScript.value = false
  }
}
async function unconfirmScript() {
  confirmingScript.value = true
  try {
    applyGates(await episodeAPI.unconfirmScript(epId.value))
  } catch (e) {
    toastError(e)
  } finally {
    confirmingScript.value = false
  }
}
// 改稿会在服务端自动取消确认（onScriptChanged）：保存后前台重算门禁——先作废上一次判定，
// 拿到新结果前不再按旧的解锁位渲染任何受管内容，锁定态即时生效
function saveRaw() {
  episodeAPI.update(epId.value, { content: localRaw.value }).then(() => refreshGates())
  episode.value.content = localRaw.value
}
function saveScr() {
  episodeAPI.update(epId.value, { script_content: localScript.value }).then(() => refreshGates())
  episode.value.script_content = localScript.value
}
// 发给 Agent 的 message 是功能性提示词而非 UI 文案：产出语言由后端全局「内容语言」指令控制，
// 这里保持中文不随界面语言变化
function doRewrite() { saveRaw(); runAgent('script_rewriter', '请读取剧本并改写为格式化剧本，然后保存', dramaId, epId.value, refresh, chatModelOverride(), chatConfigId()) }
function skipRewrite() {
  const raw = (localRaw.value || rawContent.value || '').trim()
  if (!raw) {
    toast.warning(t('episode.script.rawRequired'))
    return
  }
  localScript.value = raw
  saveScr()
  toast.success(t('episode.script.skipDone'))
  panel.value = 'production'
  prodTab.value = 'assets'
}
// 资产提取：按类型独立的异步任务（后端任务表驱动），三类可并行；前端轮询状态直到完成
// label 渲染时求值（语言切换即时生效），key 为逻辑值
const EXTRACT_TARGETS = computed(() => [
  { key: 'characters', label: t('common.role') },
  { key: 'scenes', label: t('common.scene') },
  { key: 'props', label: t('common.prop') },
])
const extractingTargets = ref([])
const extractingLabels = computed(() => EXTRACT_TARGETS.value.filter(x => extractingTargets.value.includes(x.key)).map(x => x.label).join(t('common.listJoin')))
function isExtracting(target) { return extractingTargets.value.includes(target) }

function doExtract(target) {
  if (isExtracting(target) || !epId.value) return
  if (!isDocumentaryProject.value) saveScr()
  extractingTargets.value.push(target)
  episodeAPI.extract(epId.value, target, chatModelOverride(), chatConfigId())
    .then(() => pollExtractStatus(target))
    .catch(e => {
      extractingTargets.value = extractingTargets.value.filter(x => x !== target)
      toastError(e)
    })
}
function doExtractAll() { EXTRACT_TARGETS.value.forEach(x => doExtract(x.key)) }

// ─── 单资产「重新提取本资产信息」（Issue #32）────────────────
// 后端先清空该资产的提取字段再跑提取 Agent（save_dedup_* 只补空白，不清就测不出规则改动），
// 进度沿用本集的提取任务状态：POST 成功后按同一个 target 轮询，完成时 refresh() 拉回新内容。
const EXTRACT_TARGET_OF = { character: 'characters', scene: 'scenes', prop: 'props' }
// 与后端 asset-reextract.ts 的 CLEARED_FIELDS 一一对应，确认框里要如实列出被清空的字段
const REEXTRACT_FIELD_KEYS = {
  character: ['role', 'description', 'appearance', 'styling'],
  scene: ['prompt', 'lighting'],
  prop: ['type', 'description'],
}
const reExtract = ref({ open: false, type: '', id: 0, name: '', loading: false })
const reExtractStarting = ref('')

function extractTargetOf(type) { return EXTRACT_TARGET_OF[type] || '' }
function isReExtracting(type, id) { return reExtractStarting.value === `${type}:${id}` }

const reExtractFieldsLabel = computed(() => {
  const keys = REEXTRACT_FIELD_KEYS[reExtract.value.type] || []
  return keys.map(key => t(`episode.documentary.fields.${key}`)).join(t('common.listJoin'))
})

function askReExtract() {
  const { open, type, item } = assetDetail.value
  if (!open || !item?.id) return
  reExtract.value = { open: true, type, id: item.id, name: item.name || item.location || '', loading: false }
}

async function confirmReExtract() {
  const { type, id } = reExtract.value
  const target = extractTargetOf(type)
  if (!type || !id || !epId.value || reExtract.value.loading) return
  const assetApi = type === 'character' ? characterAPI : type === 'scene' ? sceneAPI : propAPI
  reExtract.value.loading = true
  reExtractStarting.value = `${type}:${id}`
  try {
    await assetApi.reExtract(id, epId.value, chatModelOverride(), chatConfigId())
    // 提取字段已被清空：先把本地行同步成空值，等轮询完成再用服务端内容覆盖
    applyReExtractCleared(type, id)
    reExtractPending.value = `${type}:${id}`
    if (!isExtracting(target)) {
      extractingTargets.value.push(target)
      pollExtractStatus(target)
    }
    reExtract.value.open = false
    toast.success(t('episode.documentary.reExtractStarted'))
  } catch (e) {
    toastError(e)
  } finally {
    reExtract.value.loading = false
    reExtractStarting.value = ''
  }
}

/**
 * 清空本地行的提取字段与最终提示词来源标记，与后端 re-extract 的清空范围一致。
 * keys 可收窄：按史料画像补充外貌时只有 appearance 会被后端改写，其它提取字段仍然有效。
 */
function applyReExtractCleared(type, id, keys = REEXTRACT_FIELD_KEYS[type] || []) {
  const patch = { final_prompt: '', finalPrompt: '', final_prompt_source: null, final_prompt_updated_at: null }
  for (const key of keys) patch[key] = ''
  const list = type === 'character' ? chars.value : type === 'scene' ? scenes.value : propItems.value
  const target = list.find(x => x.id === id)
  if (target) Object.assign(target, patch)
  if (isAssetDialogOn(type, id)) {
    Object.assign(assetDetail.value.item, patch)
    assetPromptDraft.value = ''
    assetPromptDirty.value = false
    for (const key of keys) {
      if (key in assetDetailDraft.value) assetDetailDraft.value[key] = ''
    }
  }
}

// 轮询完成时 pollExtractStatus 会 refresh()，整份资产列表被替换；弹窗里握的是旧对象，
// 只有「我们刚发起的这次重新提取」才把弹窗重新指向新行并重置草稿（不干扰其它刷新场景）
const reExtractPending = ref('')
watch([chars, scenes, propItems], () => {
  const key = reExtractPending.value
  if (!key) return
  const [type, rawId] = key.split(':')
  const id = Number(rawId)
  const list = type === 'character' ? chars.value : type === 'scene' ? scenes.value : propItems.value
  const fresh = list.find(x => x.id === id)
  if (!fresh) { reExtractPending.value = ''; return }
  if (isAssetDialogOn(type, id) && assetDetail.value.item !== fresh) openAssetDetail(type, fresh)
  reExtractPending.value = ''
})

function pollExtractStatus(target, attempts = 150) {
  const label = EXTRACT_TARGETS.value.find(x => x.key === target)?.label || target
  const tick = async (left) => {
    try {
      const st = await episodeAPI.extractStatus(epId.value)
      const task = st?.[target]
      if (task && task.status !== 'running') {
        extractingTargets.value = extractingTargets.value.filter(x => x !== target)
        if (task.status === 'done') {
          toast.success(t('episode.extract.done', { type: label }))
          await refresh()
        } else {
          toastError(task.error, { fallback: 'episode.extract.failed' })
        }
        return
      }
    } catch {}
    if (left > 0) setTimeout(() => tick(left - 1), 2500)
    else extractingTargets.value = extractingTargets.value.filter(x => x !== target)
  }
  setTimeout(() => tick(attempts), 2500)
}

/** 页面加载后恢复仍在运行的提取任务状态（刷新页面不丢进度展示） */
async function syncExtractStatus() {
  if (!epId.value) return
  try {
    const st = await episodeAPI.extractStatus(epId.value)
    for (const x of EXTRACT_TARGETS.value) {
      if (st?.[x.key]?.status === 'running' && !isExtracting(x.key)) {
        extractingTargets.value.push(x.key)
        pollExtractStatus(x.key)
      }
    }
  } catch {}
  try {
    const vp = await episodeAPI.videoPromptsStatus(epId.value)
    if (vp?.status === 'running' && !videoPromptBatch.value.running) {
      videoPromptBatch.value = { running: true, total: vp.total || 0, completed: vp.completed || 0 }
      pollVideoPromptBatch()
    }
  } catch {}
}

// ─── 批量视频提示词：后端异步逐分镜生成，前端轮询进度 ──────────
const videoPromptBatch = ref({ running: false, total: 0, completed: 0 })
// 单个视频提示词生成：按分镜 ID 跟踪，允许不同分镜并行生成（不走全局 rn 锁）
const videoPromptGeneratingIds = ref([])
// 视频制作页多选快捷操作：全选 / 仅选未生成视频（勾选集与批量视频共用 selectedVideoSbIds）
function toggleSelectAllVideos() {
  selectedVideoSbIds.value = selectedVideoSbIds.value.length === sbs.value.length ? [] : sbs.value.map(sb => sb.id)
}
function selectMissingVideos() {
  selectedVideoSbIds.value = sbs.value.filter(sb => !hasVid(sb)).map(sb => sb.id)
}

async function batchVideoPrompts() {
  if (videoPromptBatch.value.running || !epId.value) return
  if (!sbs.value.length) { toast.warning(t('episode.sb.breakFirst')); return }
  // 选择模式下有勾选 → 仅补齐所选；否则全量补齐缺失
  const ids = (videoSelectMode.value && selectedVideoSbIds.value.length) ? [...selectedVideoSbIds.value] : undefined
  try {
    const res = await episodeAPI.generateVideoPrompts(epId.value, chatModelOverride(), chatConfigId(), ids)
    if (!res?.total) {
      if (res?.already_running) {
        videoPromptBatch.value = { running: true, total: 0, completed: 0 }
        pollVideoPromptBatch()
      } else toast.info(ids ? t('episode.sb.selectedMissing') : t('episode.sb.allHavePrompts'))
      return
    }
    videoPromptBatch.value = { running: true, total: res.total, completed: 0 }
    toast.info(t('episode.sb.batchStarted', { n: res.total }))
    pollVideoPromptBatch()
  } catch (e) {
    toastError(e)
  }
}

function pollVideoPromptBatch(attempts = 240) {
  const tick = async (left) => {
    try {
      const st = await episodeAPI.videoPromptsStatus(epId.value)
      if (st && st.status !== 'running') {
        videoPromptBatch.value = { running: false, total: 0, completed: 0 }
        await refresh()
        if (st.status === 'done') {
          toast.success(st.failed ? t('episode.sb.batchDoneFailed', { n: st.failed }) : t('episode.sb.batchDone'))
        } else {
          toastError(st.error, { fallback: 'episode.sb.batchFailed' })
        }
        return
      }
      if (st) {
        const prev = videoPromptBatch.value.completed
        videoPromptBatch.value = { running: true, total: st.total || 0, completed: st.completed || 0 }
        if ((st.completed || 0) !== prev) await refresh() // 每完成一条刷新，提示词逐步出现
      }
    } catch {}
    if (left > 0) setTimeout(() => tick(left - 1), 2500)
    else videoPromptBatch.value = { running: false, total: 0, completed: 0 }
  }
  setTimeout(() => tick(attempts), 2500)
}
// ===== 拆分分镜（#30 C.1）：先问旁白，再跑拆分 Agent，开关打开时串联旁白写作 =====
const breakdownDialog = ref(false)
/** 本集是否已有审核过的旁白内容：重拆会把分镜连同旁白/配音一起删掉 */
const hasNarrationContent = computed(() => sbs.value.some(sb =>
  String(sb?.narration_text || sb?.narrationText || '').trim() || (sb?.narration_audio_url || sb?.narrationAudioUrl)))

function doBreakdown() {
  breakdownDialog.value = true
}

async function confirmBreakdown(narrationEnabled) {
  breakdownDialog.value = false
  if (narrationEnabled !== narrationEnabledOf.value) {
    try {
      await episodeAPI.update(epId.value, { narration_enabled: narrationEnabled })
      if (episode.value) {
        episode.value.narration_enabled = narrationEnabled
        episode.value.narrationEnabled = narrationEnabled
      }
    } catch (e) {
      toastError(e)
      return
    }
  }
  runBreakdownAgent()
}

function runBreakdownAgent() {
  const charList = chars.value.length
    ? chars.value.map(c => `${c.name}(ID:${c.id})`).join('、')
    : '（当前集还没有角色）'
  const sceneList = scenes.value.length
    ? scenes.value.map(s => `${s.location} · ${s.time || '未设时间'}(ID:${s.id})`).join('、')
    : '（当前集还没有场景）'
  const propList = propItems.value.length
    ? propItems.value.map(p => `${p.name}(ID:${p.id})`).join('、')
    : '（当前集还没有道具）'
  runAgent('storyboard_breaker', `请基于当前集剧本拆分分镜，并为每个分镜段落同时生成 video_prompt（视频生成提示词）与首/中/尾三条关键帧提示词。
本次视频模型：${effectiveVideoModelLabel.value}，请按该模型的特性与时长限制生成 video_prompt。

当前集已有角色：${charList}
当前集已有场景：${sceneList}
当前集已有道具：${propList}

绑定要求：
- 每个镜头必须根据剧本内容，从上述当前集已有角色中选出出场的角色绑定 character_ids（ID 必须来自上述列表；有角色出场就必须绑定，不要遗漏）
- 每个镜头尽量匹配上述已有场景填写 scene_id（ID 必须来自上述列表），不要凭空创造新场景
- 每个镜头出现关键道具（被使用、交接、特写或在画面中明显可见）时，从上述当前集已有道具中绑定 prop_ids（ID 必须来自上述列表）；没有道具出现可传空数组
- 只有纯环境空镜头才可以不绑定角色

衔接标记：
- 每个镜头都要判断与上一镜的关系并填写 continuity：画面连贯、同场景同时间直接接续填 "continue"；换场、跳时间、换视角的硬切填 "cut"（第一镜固定为 "cut"）
- 标记为 continue 的镜头默认直接用上一镜选定的尾帧关键帧作为首帧，不要写 first_frame_prompt；上一镜的 last_frame_prompt 要能直接作为本镜的开头画面

关键帧提示词（每个分镜都要）：
- first_frame_prompt：本镜第 0 秒的单帧静态画面（承接镜头留空）
- last_frame_prompt：本镜结束瞬间的单帧静态画面
- mid_frame_prompt 与 mid_frame_time：镜头中间某个子镜头开头的单帧画面及其秒数（必须落在 0.5s 与「本镜时长 - 0.5s」之间；只有一个子镜头的短分镜可以两者都留空）
- 每条关键帧提示词只写单帧构图：景别、机位、谁在画面什么位置、姿态、表情、光线

以图片为准（强制规则）：
- video_prompt 与三条关键帧提示词都不得描述角色的物种、衣着、颜色、发型等外形属性，外形只来自参考图与关键帧
- 角色一律用 @角色名 引用；角色名只是昵称，不可据此推断外形`, dramaId, epId.value, onBreakdownDone, chatModelOverride(), chatConfigId())
}

/** 拆分完成后刷新、自动补齐缺失的视频提示词（兜住 Agent 漏写/截断），开关打开时接着跑旁白写作 */
async function onBreakdownDone() {
  await refresh()
  const missing = sbs.value.filter(sb => !(sb.video_prompt || sb.videoPrompt || '').trim())
  if (missing.length) batchVideoPrompts()
  if (narrationEnabledOf.value) await batchNarration()
}

// ===== 旁白（#30）：集级开关 / 字幕时间码 / 三个集级批量任务 =====
const narrationEnabledOf = computed(() => Boolean(episode.value?.narration_enabled ?? episode.value?.narrationEnabled))
// 音频旁白设置面板（#35）：集级开关 / 文本规范化 / 整集主线都在面板里改
const narrationSettingsOpen = ref(false)
const episodeNarrationNormalize = computed(() =>
  (episode.value?.narration_normalize ?? episode.value?.narrationNormalize) !== false)
const episodeNarrationSpine = computed(() =>
  String(episode.value?.narration_spine ?? episode.value?.narrationSpine ?? ''))

/** 已拆过分镜的剧集也能在界面上开/关旁白，语义与拆分前对话框一致 */
async function setNarrationEnabled(enabled) {
  if (!episode.value || enabled === narrationEnabledOf.value) return
  const prev = episode.value.narration_enabled
  await updateEpisodeFields(
    { narration_enabled: enabled, narrationEnabled: enabled },
    { narration_enabled: prev, narrationEnabled: prev },
  )
}
async function setNarrationNormalize(value) {
  if (!episode.value || value === episodeNarrationNormalize.value) return
  const prev = episode.value.narration_normalize
  await updateEpisodeFields(
    { narration_normalize: value, narrationNormalize: value },
    { narration_normalize: prev, narrationNormalize: prev },
  )
}
async function setNarrationSpine(text) {
  if (!episode.value || text === episodeNarrationSpine.value) return
  const prev = episode.value.narration_spine
  await updateEpisodeFields(
    { narration_spine: text, narrationSpine: text },
    { narration_spine: prev, narrationSpine: prev },
  )
  toast.success(t('episode.narration.spineSaved'))
}
const SUBTITLE_TIMINGS = ['sentence', 'char']
const subtitleTimingOptions = computed(() => [
  { key: 'sentence', model: t('episode.narration.timingSentence') },
  { key: 'char', model: t('episode.narration.timingChar') },
])
const episodeSubtitleTiming = computed({
  get: () => {
    const v = episode.value?.subtitle_timing ?? episode.value?.subtitleTiming
    return SUBTITLE_TIMINGS.includes(v) ? v : 'sentence'
  },
  set: (val) => { void changeEpisodeSubtitleTiming(val) },
})
async function changeEpisodeSubtitleTiming(val) {
  if (!episode.value || val === episodeSubtitleTiming.value) return
  const prev = episode.value.subtitle_timing
  episode.value.subtitle_timing = val
  episode.value.subtitleTiming = val
  try {
    await episodeAPI.update(epId.value, { subtitle_timing: val })
    // 已有配音的镜头字幕仍按旧模式切分，提供一次性重出
    if (sbs.value.some(sb => sb.narration_audio_url || sb.narrationAudioUrl)) subtitleRegenConfirm.value = true
  } catch (e) {
    episode.value.subtitle_timing = prev
    episode.value.subtitleTiming = prev
    toastError(e)
  }
}

// ===== 旁白音轨与时长匹配（#31）：集级音轨模式 / 底音增益 / 默认匹配 =====
const MAX_PAD_SECONDS = 3
const DEFAULT_BED_GAIN_DB = -18
const audioMixModeOptions = computed(() => [
  { key: 'replace', model: t('episode.fit.mixReplace') },
  { key: 'mix', model: t('episode.fit.mixMix') },
])
const fitModeOptions = computed(() => [
  { key: 'pad', model: t('episode.fit.modePad') },
  { key: 'tempo', model: t('episode.fit.modeTempo') },
])
const fitPositionOptions = computed(() => [
  { key: 'tail', model: t('episode.fit.padTail') },
  { key: 'head', model: t('episode.fit.padHead') },
])

/** 乐观写集级字段：失败回滚并提示 */
async function updateEpisodeFields(patch, prevPatch) {
  if (!episode.value) return
  Object.assign(episode.value, patch)
  try {
    await episodeAPI.update(epId.value, patch)
  } catch (e) {
    Object.assign(episode.value, prevPatch)
    toastError(e)
  }
}

const episodeAudioMixMode = computed({
  get: () => ((episode.value?.audio_mix_mode ?? episode.value?.audioMixMode) === 'mix' ? 'mix' : 'replace'),
  set: (val) => {
    if (val === episodeAudioMixMode.value) return
    const prev = episode.value?.audio_mix_mode
    void updateEpisodeFields({ audio_mix_mode: val, audioMixMode: val }, { audio_mix_mode: prev, audioMixMode: prev })
  },
})

const episodeBedGainDb = computed({
  get: () => {
    const v = Number(episode.value?.audio_bed_gain_db ?? episode.value?.audioBedGainDb)
    return Number.isFinite(v) && v !== 0 ? v : DEFAULT_BED_GAIN_DB
  },
  set: (raw) => {
    const val = Math.min(Number(raw) || 0, 0)
    if (val === episodeBedGainDb.value) return
    const prev = episode.value?.audio_bed_gain_db
    void updateEpisodeFields(
      { audio_bed_gain_db: val, audioBedGainDb: val },
      { audio_bed_gain_db: prev, audioBedGainDb: prev },
    )
  },
})

/** 集级默认匹配：库里存 JSON 字符串，前端按对象读写 */
const episodeFitDefault = computed(() => {
  const raw = episode.value?.narration_fit_default ?? episode.value?.narrationFitDefault
  if (!raw) return { mode: 'pad', pad_ms: 800, pad_position: 'tail' }
  if (typeof raw === 'object') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return { mode: 'pad', pad_ms: 800, pad_position: 'tail' }
  }
})
async function saveEpisodeFitDefault(next) {
  const prev = episode.value?.narration_fit_default
  const json = JSON.stringify(next)
  await updateEpisodeFields(
    { narration_fit_default: json, narrationFitDefault: json },
    { narration_fit_default: prev, narrationFitDefault: prev },
  )
}
const episodeFitMode = computed({
  get: () => (episodeFitDefault.value.mode === 'tempo' ? 'tempo' : 'pad'),
  set: (val) => {
    if (val === episodeFitMode.value) return
    void saveEpisodeFitDefault({ ...episodeFitDefault.value, mode: val })
  },
})
const episodeFitPadSeconds = computed({
  get: () => ((Number(episodeFitDefault.value.pad_ms) || 0) / 1000).toFixed(1),
  set: (raw) => {
    const sec = Math.min(Math.max(Number(raw) || 0, 0), MAX_PAD_SECONDS)
    void saveEpisodeFitDefault({ ...episodeFitDefault.value, mode: 'pad', pad_ms: Math.round(sec * 1000) })
  },
})
const episodeFitPadPosition = computed({
  get: () => (episodeFitDefault.value.pad_position === 'head' ? 'head' : 'tail'),
  set: (val) => {
    if (val === episodeFitPadPosition.value) return
    void saveEpisodeFitDefault({ ...episodeFitDefault.value, mode: 'pad', pad_position: val })
  },
})

// 切换剧集时间码后重出全部已配音镜头的字幕（不重跑 TTS）
const subtitleRegenConfirm = ref(false)
const subtitleRegenRunning = ref(false)
async function regenerateAllSubtitles() {
  if (subtitleRegenRunning.value) return
  subtitleRegenRunning.value = true
  const targets = sbs.value.filter(sb => (sb.narration_audio_url || sb.narrationAudioUrl)
    && !(sb.subtitle_timing ?? sb.subtitleTiming))
  let failed = 0
  for (const sb of targets) {
    try { await storyboardAPI.regenerateSubtitle(sb.id) } catch { failed += 1 }
  }
  subtitleRegenRunning.value = false
  subtitleRegenConfirm.value = false
  await refresh()
  if (failed) toast.error(t('episode.narration.subtitleBatchFailed', { n: failed }))
  else toast.success(t('episode.narration.subtitleDone'))
}

const narrationBatch = ref({ running: false, total: 0, completed: 0 })
const narrationVoiceBatch = ref({ running: false, total: 0, completed: 0 })

/** 集级文本批量（旁白写作 / 旁白配音）共用的轮询：与视频提示词批量同一套状态模型 */
function pollTextBatch(stateRef, statusFn, doneKey, attempts = 240) {
  const tick = async (left) => {
    try {
      const st = await statusFn()
      if (st && st.status !== 'running') {
        stateRef.value = { running: false, total: 0, completed: 0 }
        await refresh()
        if (st.status === 'done') {
          toast.success(st.failed ? t('episode.narration.batchDoneFailed', { n: st.failed }) : t(doneKey))
        } else {
          toastError(st.error, { fallback: 'episode.narration.batchFailed' })
        }
        return
      }
      if (st) {
        const prev = stateRef.value.completed
        stateRef.value = { running: true, total: st.total || 0, completed: st.completed || 0, phase: st.phase }
        if ((st.completed || 0) !== prev) await refresh()
      }
    } catch {}
    if (left > 0) setTimeout(() => tick(left - 1), 2500)
    else stateRef.value = { running: false, total: 0, completed: 0 }
  }
  setTimeout(() => tick(attempts), 2500)
}

/**
 * 整集/选中镜头的旁白写作（#35）。
 * 后端已在运行时返回 already_running + 当前进度：进入运行态继续轮询，
 * 绝不再弹「没有需要处理的镜头」—— 那句话会把「正在跑」说成「没活干」。
 */
async function batchNarration(storyboardIds) {
  if (narrationBatch.value.running) {
    toast.info(t('episode.narration.batchAlreadyRunning', {
      done: narrationBatch.value.completed,
      total: narrationBatch.value.total,
    }))
    return
  }
  try {
    const res = await episodeAPI.generateNarration(epId.value, {
      storyboard_ids: storyboardIds,
      model: chatModelOverride() || undefined,
      config_id: chatConfigId() || undefined,
    })
    if (res?.already_running) {
      narrationBatch.value = {
        running: true,
        total: res.total || 0,
        completed: res.completed || 0,
        phase: res.phase,
      }
      toast.info(t('episode.narration.batchAlreadyRunning', { done: res.completed || 0, total: res.total || 0 }))
      pollTextBatch(narrationBatch, () => episodeAPI.narrationStatus(epId.value), 'episode.narration.batchDone')
      return
    }
    if (!res?.total) { toast.info(t('episode.narration.batchNothing')); return }
    narrationBatch.value = { running: true, total: res.total, completed: 0, phase: 'spine' }
    toast.info(t('episode.narration.batchStarted', { n: res.total }))
    pollTextBatch(narrationBatch, () => episodeAPI.narrationStatus(epId.value), 'episode.narration.batchDone')
  } catch (e) {
    toastError(e)
  }
}

/** 打开页面时若批量还在跑，直接显示运行态并接着轮询（刷新后按钮不会变回「批量生成旁白」） */
async function resumeNarrationBatch() {
  if (narrationBatch.value.running) return
  try {
    const st = await episodeAPI.narrationStatus(epId.value)
    if (st?.status !== 'running') return
    narrationBatch.value = { running: true, total: st.total || 0, completed: st.completed || 0, phase: st.phase }
    pollTextBatch(narrationBatch, () => episodeAPI.narrationStatus(epId.value), 'episode.narration.batchDone')
  } catch {}
}

const voiceBatchDialog = ref({ open: false, storyboardIds: undefined, submitting: false })

// 批量配音先弹参数弹窗（#37），手动选镜只缩小检查范围
function batchNarrationVoice(storyboardIds) {
  if (narrationVoiceBatch.value.running) return
  voiceBatchDialog.value = { open: true, storyboardIds, submitting: false }
}

async function confirmNarrationVoiceBatch(settings) {
  voiceBatchDialog.value.submitting = true
  try {
    const res = await episodeAPI.narrationVoiceBatch(epId.value, settings, voiceBatchDialog.value.storyboardIds)
    voiceBatchDialog.value.open = false
    if (res?.already_running) {
      narrationVoiceBatch.value = { running: true, total: res.total || 0, completed: res.completed || 0 }
      toast.info(t('episode.narration.voiceBatchRunning'))
    } else if (!res?.total) {
      toast.info(t('episode.narration.batchNothing'))
      return
    } else {
      narrationVoiceBatch.value = { running: true, total: res.total, completed: 0 }
      toast.info(t('episode.narration.voiceBatchStarted', { n: res.total }))
    }
    pollTextBatch(narrationVoiceBatch, () => episodeAPI.narrationVoiceBatchStatus(epId.value), 'episode.narration.voiceBatchDone')
  } catch (e) {
    toastError(e)
  } finally {
    voiceBatchDialog.value.submitting = false
  }
}

// ===== 融合（#42）：状态口径一律来自后端 compose_state，前端不自推「有 URL = 已就绪」 =====
function composeStateOf(sb) {
  return sb?.compose_state || sb?.composeState || null
}
/** 没有服务端状态时按本集旁白开关兜底：开 = 待核验，关 = 不适用 */
function composeStatusOf(sb) {
  return composeStateOf(sb)?.status || (narrationEnabledOf.value ? 'unknown' : 'disabled')
}
function composeStatusLabel(sb) {
  const status = composeStatusOf(sb)
  return t(`episode.compose.status${status.charAt(0).toUpperCase()}${status.slice(1)}`)
}
/**
 * 本镜视频是否真正可用：以后端的文件级判定为准（URL 非空不等于文件还在）。
 * 服务端还没给出状态时退回 URL，避免界面整体不可用。
 */
function hasUsableVideo(sb) {
  const inputs = composeStateOf(sb)?.inputs
  if (inputs && typeof inputs.video === 'boolean') return inputs.video
  return Boolean(rawVideoUrl(sb))
}
/** 可直接用于最终拼接：旁白开启看融合签名，关闭看原视频文件是否还在 */
function composeExportable(sb) {
  if (!narrationEnabledOf.value) return hasUsableVideo(sb)
  return Boolean(composeStateOf(sb)?.exportable)
}
function composeReasonOf(sb) {
  const state = composeStateOf(sb)
  if (!state) return ''
  return [state.reason, ...(state.change_reasons || [])].filter(Boolean).join(t('common.listJoin'))
}
function fusionUrlOf(sb) {
  return composeStateOf(sb)?.composed_video_url || sb?.composed_video_url || sb?.composedVideoUrl || ''
}

// 批量融合任务：状态持久化在 sys_task，进页/刷新后重连，不重复提交
const composeDialog = ref({ open: false, scopeIds: undefined, submitting: false })
const composeTask = ref(null)
const composeBatchRunning = computed(() => composeTask.value?.status === 'running')
let composePollTimer = null
// 页面存活标志：融合批量与拼接进度共用，卸载后所有轮询立即停止
let pollAlive = true

function stopComposePolling() {
  if (composePollTimer) { clearTimeout(composePollTimer); composePollTimer = null }
}

/** 轮询批量任务：完成数变化就重拉分镜，让列表/导出的融合状态跟着动 */
function startComposePolling() {
  stopComposePolling()
  const tick = async () => {
    composePollTimer = null
    if (!pollAlive) return
    let st = null
    try { st = await episodeAPI.composeBatchStatus(epId.value) } catch { /* 网络抖动：下一轮再试 */ }
    if (!pollAlive) return
    const before = composeTask.value
    if (st) composeTask.value = st
    if (!st || st.status !== 'running') {
      await refresh()
      if (st?.status === 'done') {
        toast.success(st.failed
          ? t('episode.compose.batchDoneFailed', { n: st.failed })
          : t('episode.compose.batchDone'))
      } else if (st?.status === 'error') {
        toastError(st.error, { fallback: 'episode.composeBatch.taskFailed' })
      }
      return
    }
    if ((st.completed || 0) !== (before?.completed || 0)) await refresh()
    if (pollAlive) composePollTimer = setTimeout(tick, 2500)
  }
  composePollTimer = setTimeout(tick, 2500)
}

/** 进页/刷新后重连既有批量任务（后端重启后的失败任务沿用既有「重试」约定） */
async function resumeComposeBatch() {
  try {
    const st = await episodeAPI.composeBatchStatus(epId.value)
    composeTask.value = st || null
    if (st?.status === 'running') startComposePolling()
  } catch { /* 静默：状态接口不可用时按无任务处理 */ }
}

/** 批量融合入口：先预览分类（范围可为整集或手动选镜），进行中则展示当前任务 */
function openComposeDialog(storyboardIds) {
  const scope = Array.isArray(storyboardIds) && storyboardIds.length ? [...storyboardIds] : undefined
  composeDialog.value = { open: true, scopeIds: scope, submitting: false }
  void resumeComposeBatch()
}

async function submitComposeBatch(ids) {
  if (!Array.isArray(ids) || !ids.length || composeDialog.value.submitting) return
  composeDialog.value.submitting = true
  try {
    const res = await episodeAPI.composeBatch(epId.value, ids)
    if (res?.already_running) toast.info(t('episode.compose.batchAlreadyRunning'))
    else toast.info(t('episode.compose.batchStarted', { n: res?.total ?? ids.length }))
    await resumeComposeBatch()
  } catch (e) {
    toastError(e)
  } finally {
    composeDialog.value.submitting = false
  }
}

function narrationStatusOf(sb) {
  return sb?.narration_status || sb?.narrationStatus || 'missing'
}
function narrationIssuesOf(sb) {
  return refIssuesOf(sb).filter(i => i.code === 'narration_too_long' || i.code === 'narration_voice_stale')
}

// 导出页：上一次拼接被跳过的镜头（镜号 + 原因）；被拒时后端逐镜给出原因
const mergeSkipped = ref([])
const mergeBlocked = ref([])

// 按需为单个分镜生成视频提示词：由 prompt_generator 读取分镜字段生成并保存到 video_prompt
async function genVideoPrompt(sb) {
  if (!sb || videoPromptGeneratingIds.value.includes(sb.id)) return
  const idx = sbs.value.indexOf(sb) + 1
  const cfg = selectedVideoConfig.value
  const label = cfg ? `${cfg.name} (${cfg.provider})` : '默认'
  const charNames = getStoryboardCharacters(sb).map(c => c.name).join('、') || '无'
  const propNames = getStoryboardProps(sb).map(p => p.name).join('、') || '无'
  videoPromptGeneratingIds.value.push(sb.id)
  try {
    await api.post(`/agent/prompt_generator/chat`, {
      message: `请为分镜 #${idx}(ID:${sb.id})生成视频提示词(video_prompt)。视频模型:${label},请根据该模型的特性和时长限制生成。

该分镜信息:时长 ${sb.duration || 10}s;场景:${getSceneName(sb) || '未绑定'};角色:${charNames};道具:${propNames}。

请先调用 read_storyboard_context 获取该分镜的画面描述(含【镜头N】子镜头与台词/旁白)、氛围、时长与三条关键帧提示词,据此生成 video_prompt(按 3 秒分段换行、用 @角色名/@场景名/@道具名 引用参考素材；段落内允许多镜头切镜,但不跨场景,切镜点对齐 description 的【镜头N】结构),然后调用 update_storyboard 保存到分镜 ID:${sb.id}。只更新 video_prompt 字段,不要改动其他字段,不要重新拆分整集。
关键帧驱动:第一段必须从首帧关键帧的画面开始,到 mid_frame_time 秒处切到中间关键帧,结尾停在尾帧关键帧;不要描述角色的物种、衣着、颜色、发型等外形,外形只来自关键帧与参考图,角色一律用 @角色名 引用。`,
      drama_id: dramaId,
      episode_id: epId.value,
      model: chatModelOverride() || undefined,
      config_id: chatConfigId() || undefined,
    })
    toast.success(t('episode.sb.promptGenerated', { n: idx }))
    await refresh()
  } catch (e) {
    toastError(e)
  } finally {
    videoPromptGeneratingIds.value = videoPromptGeneratingIds.value.filter(id => id !== sb.id)
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function watchAsyncResult(check, attempts = 24, delay = 2500) {
  void (async () => {
    for (let i = 0; i < attempts; i++) {
      await sleep(delay)
      await refresh()
      if (check()) return
    }
  })()
}

function isPendingPropImage(id) {
  return isAssetImagePending('prop', id)
}
/** 后端建好的 sys_task 立刻进全局 store：卡片进度环不必等下一轮轮询 */
function registerCreatedTasks(result) {
  const rows = Array.isArray(result) ? result : Array.isArray(result?.tasks) ? result.tasks : [result]
  for (const row of rows) if (row?.id) registerTask(row)
}

// 单张生成：后端同步建好 sys_task 再返回，提交后任务即进 store，卡片接上进度环
async function submitAssetImage(type, id, call, startedToastKey) {
  const key = `${type}:${id}`
  if (isAssetImagePending(type, id)) return
  submittingAssetImages.value = [...submittingAssetImages.value, key]
  try {
    const list = type === 'character' ? chars.value : type === 'scene' ? scenes.value : propItems.value
    const item = list.find(x => x.id === id)
    if (item && !(item.final_prompt || item.finalPrompt)) {
      toast.info(t('episode.asset.generatingPrompt'))
      try {
        await ensureAssetPrompt(type, id)
      } catch {} // 提示词生成失败不阻断：后端生图前会再兜底生成或回退本地拼接
    }
    registerCreatedTasks(await call())
    toast.success(t(startedToastKey))
    await refresh() // refresh() 内部会载入本集任务快照
  } catch (e) {
    toastError(e)
  } finally {
    submittingAssetImages.value = submittingAssetImages.value.filter(k => k !== key)
  }
}
function genCharImg(id) {
  return submitAssetImage('character', id,
    () => characterAPI.generateImage(id, epId.value, bareModelName(imageModel.value) || undefined, ownerConfigId(imageModelOptions.value, imageModel.value), chatModelOverride(), chatConfigId()),
    'episode.image.generatingChar')
}
// 本集造型版本出图（Issue #15）：以角色基础形象图换装，不走角色基础图的生成路径
const stylingVersionBusy = ref([])
async function genStylingVersionImg(id) {
  if (stylingVersionBusy.value.includes(id)) return
  stylingVersionBusy.value = [...stylingVersionBusy.value, id]
  try {
    registerCreatedTasks(await characterAPI.generateStylingVersionImage(
      id, epId.value, bareModelName(imageModel.value) || undefined, ownerConfigId(imageModelOptions.value, imageModel.value),
    ))
    toast.success(t('episode.image.generatingChar'))
    await refresh()
  } catch (e) {
    toastError(e)
  } finally {
    stylingVersionBusy.value = stylingVersionBusy.value.filter(x => x !== id)
  }
}
function genSceneImg(id) {
  return submitAssetImage('scene', id,
    () => sceneAPI.generateImage(id, epId.value, bareModelName(imageModel.value) || undefined, ownerConfigId(imageModelOptions.value, imageModel.value), chatModelOverride(), chatConfigId()),
    'episode.image.generatingScene')
}
function genPropImg(id) {
  return submitAssetImage('prop', id,
    () => propAPI.generateImage(id, epId.value, bareModelName(imageModel.value) || undefined, ownerConfigId(imageModelOptions.value, imageModel.value), chatModelOverride(), chatConfigId()),
    'episode.image.generatingProp')
}

// ===== 资产批量生成（#33）=====
// 四个入口（角色 / 场景 / 道具 / 全部资产）都走同一个服务端批次：
// 提示词在服务端按并发池跑，一好就提交图像任务，前端只负责确认框与进度展示。
const ASSET_BATCH_SCOPES = ['characters', 'scenes', 'props', 'all']
const assetBatch = reactive({ open: false, scope: 'all', status: null, stopping: false })
let assetBatchTimer = null

const assetBatchRunning = computed(() => assetBatch.status?.status === 'running')
const assetBatchCounts = computed(() => assetBatch.status?.counts || null)
const assetBatchDone = computed(() => {
  const c = assetBatchCounts.value
  if (!c) return 0
  return c.image.done + c.image.failed + c.skipped.has_image + c.skipped.running + c.skipped.faithful
})

function openAssetBatch(scope) {
  assetBatch.scope = scope
  assetBatch.open = true
}

function scheduleAssetBatchPoll() {
  if (assetBatchTimer) { clearTimeout(assetBatchTimer); assetBatchTimer = null }
  if (!assetBatchRunning.value) return
  assetBatchTimer = setTimeout(() => { void loadAssetBatch() }, 3000)
}

async function loadAssetBatch() {
  const wasRunning = assetBatchRunning.value
  try {
    assetBatch.status = await assetBatchAPI.status(dramaId)
  } catch {} // 批次状态拿不到不影响页面其它部分
  // 批次刚结束：重新载入资产，让新图与新提示词立刻显示
  if (wasRunning && !assetBatchRunning.value) await refresh()
  scheduleAssetBatchPoll()
}

function onAssetBatchStarted(status) {
  assetBatch.status = status
  toast.success(t('episode.assetBatch.started'))
  scheduleAssetBatchPoll()
  void refresh()
}

async function stopAssetBatch() {
  assetBatch.stopping = true
  try {
    assetBatch.status = await assetBatchAPI.cancel(dramaId)
    toast.success(t('episode.assetBatch.stopped'))
  } catch (e) {
    toastError(e)
  } finally {
    assetBatch.stopping = false
  }
  scheduleAssetBatchPoll()
}

onMounted(() => { void loadAssetBatch() })
onBeforeUnmount(() => { if (assetBatchTimer) clearTimeout(assetBatchTimer) })
function getVideoUrl(s) { return s?.video_url || s?.videoUrl || s?.composed_video_url || s?.composedVideoUrl || null }
function hasVid(s) { return !!getVideoUrl(s) }
/** 本镜的原始视频（不回落到合成片）：导出选镜与原片播放按它判断 */
function rawVideoUrl(s) { return s?.video_url || s?.videoUrl || '' }

// ===== 分镜视频历史（一个分镜可能生成多个视频,sys_task 留存全部记录）=====
const sbVideoHistory = ref([])
const previewVideoUrl = ref('') // 正在预览的历史视频(相对路径);空 = 预览当前主视频

// 右栏长分区可折叠（#42）：折叠偏好跨镜头保持，底部重绘参数也能收成一行，内容不被遮挡
const inspectorOpen = ref({ transition: true, narration: true, prompt: true })
const footerOpen = ref(false)

// ===== 主播放器源（#42）：原始视频 / 融合成片两个页签，切镜回到原片 =====
const playerSource = ref('original')
const selectedFusionUrl = computed(() => fusionUrlOf(selectedSb.value))
/** 融合片存在但不是最新签名：可预览，但明确标过期，不能当可导出成片 */
const selectedFusionStale = computed(() =>
  Boolean(selectedFusionUrl.value) && composeStatusOf(selectedSb.value) !== 'unchanged')
const mainPlayerUrl = computed(() => {
  if (previewVideoUrl.value) return previewVideoUrl.value
  if (playerSource.value === 'fusion' && selectedFusionUrl.value) return selectedFusionUrl.value
  return rawVideoUrl(selectedSb.value)
})
function setPlayerSource(source) {
  if (source === 'fusion' && !selectedFusionUrl.value) return
  previewVideoUrl.value = ''
  playerSource.value = source
}
watch(() => selectedSb.value?.id, () => { playerSource.value = 'original' })
// 融合片被删/重算掉后不能停留在空的融合页签
watch(selectedFusionUrl, (url) => { if (!url) playerSource.value = 'original' })

/** 单镜融合完成：只有发起的那一镜仍选中时才切到成片，异步结果不抢当前预览 */
async function onShotComposed(storyboardId) {
  await refresh()
  if (selectedSb.value?.id === storyboardId) {
    previewVideoUrl.value = ''
    playerSource.value = 'fusion'
  }
}

// 注意:扁平 /tasks 返回原始行(camelCase),任务中心接口返回 snake_case,两种命名都兼容
function taskVideoPath(t) { return t?.local_path || t?.localPath || t?.result_url || t?.resultUrl || '' }
function taskCreatedAt(t) { return t?.created_at || t?.createdAt || '' }
/** 任务产出时刻（unix 秒）：未完成的任务退回提交时间 */
function taskGeneratedAt(t) { return t?.generated_at ?? t?.generatedAt ?? t?.created_at_unix ?? null }
/** 历史条实测总耗时（serializeTask 的 elapsed_ms 墙钟快照）：缺失/非法返回 '' 隐藏 */
function historyElapsedTook(t) {
  const ms = Number(t?.elapsed_ms ?? t?.elapsedMs)
  return Number.isFinite(ms) && ms > 0 ? fmtDur(ms / 1000) : ''
}
/** 分镜「当前媒体」（关键帧 / 视频）的生成时间：后端按路径反查后随分镜返回 */
const mediaTimeOf = mediaTimeOfPath
function isCurrentVideo(t) { const p = taskVideoPath(t); return !!p && p === getVideoUrl(selectedSb.value) }

async function loadSbVideoHistory() {
  previewVideoUrl.value = ''
  if (!selectedSb.value?.id) { sbVideoHistory.value = []; return }
  try {
    const rows = await taskAPI.list({ type: 'video', storyboard_id: selectedSb.value.id })
    sbVideoHistory.value = (Array.isArray(rows) ? rows : [])
      .filter(t => t.status === 'completed' && taskVideoPath(t))
      .sort((a, b) => taskCreatedAt(b).localeCompare(taskCreatedAt(a)))
  } catch { sbVideoHistory.value = [] }
}

watch(() => [selectedSb.value?.id, getVideoUrl(selectedSb.value)], () => { loadSbVideoHistory() })

function previewHistoryVideo(t) {
  // 历史视频属于原片一侧：看历史时页签回到原始视频
  playerSource.value = 'original'
  previewVideoUrl.value = isCurrentVideo(t) ? '' : taskVideoPath(t)
}

async function setAsMainVideo() {
  const sb = selectedSb.value
  if (!sb || !previewVideoUrl.value) return
  try {
    await storyboardAPI.update(sb.id, { video_url: previewVideoUrl.value })
    sb.video_url = previewVideoUrl.value
    sb.videoUrl = previewVideoUrl.value
    toast.success(t('episode.vid.setMainDone'))
  } catch (e) { toastError(e, { fallback: 'episode.vid.setMainFailed' }) }
}

async function removeHistoryVideo(t) {
  try {
    await taskAPI.del(t.id)
    sbVideoHistory.value = sbVideoHistory.value.filter(x => x.id !== t.id)
    if (previewVideoUrl.value === taskVideoPath(t)) previewVideoUrl.value = ''
    toast.success(t('episode.vid.historyDeleted'))
  } catch (e) { toastError(e, { fallback: 'common.deleteFailed' }) }
}


// ===== 目标级参考图（后端 target_assets）：首/中/尾关键帧与视频各自由该目标提示词的 @ 自动绑定 =====
function storyboardTargetAssets(sb) {
  const raw = sb?.target_assets ?? sb?.targetAssets
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
}

/** (sb, target) => 该目标实际发送的参考图列表（后端已按 场景→角色→道具 排好序） */
function shotTargetAssets(sb, target) {
  const list = storyboardTargetAssets(sb)[target]
  return Array.isArray(list) ? list : []
}

function findAssetOfKind(kind, id) {
  const assetId = Number(id)
  if (!assetId) return null
  if (kind === 'scene') return scenes.value.find(s => s.id === assetId) || null
  if (kind === 'prop') return propItems.value.find(p => p.id === assetId) || null
  return visualChars.value.find(c => c.id === assetId) || null
}

/** 目标参考图的候选版本 = 该资产的图片版本列表 */
function targetAssetVersions(item) {
  const asset = findAssetOfKind(item?.kind, item?.asset_id)
  return asset ? assetVersions(asset) : []
}

/** 目标级选版（image 为 null 恢复默认）；返回体带该分镜最新 target_assets 与 ref_issues */
const targetVersionSaving = ref(false)
async function setTargetAssetVersion(sb, target, item, image) {
  if (!sb?.id || !item?.kind || !item?.asset_id || targetVersionSaving.value) return
  const before = refIssuesOf(sb)
  targetVersionSaving.value = true
  try {
    const res = await storyboardAPI.setTargetAsset(sb.id, target, {
      kind: item.kind,
      asset_id: item.asset_id,
      image: image || null,
    })
    applyStoryboardUpdate(sb, res, before)
    toast.success(image
      ? t('episode.ref.targetVersionSelected', { name: item.name })
      : t('episode.ref.targetVersionReset', { name: item.name }))
  } catch (e) {
    toastError(e)
    await refresh()
  } finally {
    targetVersionSaving.value = false
  }
}

// 视频目标：首帧关键帧固定占 1 号位，其余参考图由视频 / 转场提示词的 @ 决定
const videoTargetAssets = computed(() => shotTargetAssets(selectedSb.value, 'video'))
const videoTargetLead = computed(() => {
  const image = shotKeyframeImage(selectedSb.value, 'first')
  return image ? { image, label: t('episode.kf.slotFirst') } : null
})
function shotVideoRefCount(sb) {
  let max = shotKeyframeImage(sb, 'first') ? 1 : 0
  for (const item of shotTargetAssets(sb, 'video')) {
    const no = Number(item?.ref_no)
    if (Number.isFinite(no) && no > max) max = no
  }
  return max
}

// 本镜资产池（#43）：候选 = 本集全部可视角色 / 场景 / 道具；
// selected = 后端有效池（手选 ∪ 五个提示词的 @），manual / mentioned 标明来源。
// kind 为英文 code（逻辑值）；typeLabel 为显示名（渲染时求值）
function shotPoolAssets(sb) {
  const list = sb?.pool_assets || sb?.poolAssets
  return Array.isArray(list) ? list : []
}
function poolEntryOf(sb, kind, assetId) {
  return shotPoolAssets(sb).find(item => item?.kind === kind && Number(item?.asset_id ?? item?.assetId) === assetId) || null
}
function shotPoolCandidates(sb) {
  const out = []
  const push = (kind, id, fields) => {
    const entry = poolEntryOf(sb, kind, id)
    out.push({
      key: `${kind}-${id}`,
      id,
      kind,
      ...fields,
      selected: !!entry,
      manual: !!entry?.manual,
      mentioned: !!entry?.mentioned,
    })
  }
  for (const char of visualChars.value) {
    const imageUrl = char.image_url || char.imageUrl || ''
    push('character', char.id, {
      typeLabel: t('common.role'),
      name: char.name || t('episode.asset.unnamedChar'),
      meta: char.role || t('episode.asset.charPortrait'),
      imageUrl,
      ready: !!imageUrl,
    })
  }
  for (const scene of scenes.value) {
    const imageUrl = scene.image_url || scene.imageUrl || ''
    push('scene', scene.id, {
      typeLabel: t('common.scene'),
      name: `${scene.location} · ${scene.time || t('episode.asset.noTime')}`,
      meta: scene.time || t('episode.asset.sceneImage'),
      imageUrl,
      ready: !!imageUrl,
    })
  }
  for (const prop of propItems.value) {
    const imageUrl = prop.image_url || prop.imageUrl || ''
    push('prop', prop.id, {
      typeLabel: t('common.prop'),
      name: prop.name || t('episode.asset.unnamedProp'),
      meta: prop.type || t('episode.asset.propSingleImage'),
      imageUrl,
      ready: !!imageUrl,
    })
  }
  // 固定顺序（角色→场景→道具，按资产原顺序）：选中/取消不重排，避免跳动
  return out
}


// 参考面板分组顺序（kind code 驱动，label 渲染时求值）
const REF_KINDS = computed(() => ([
  { kind: 'character', label: t('common.role') },
  { kind: 'scene', label: t('common.scene') },
  { kind: 'prop', label: t('common.prop') },
]))

// 资产池单项手选 / 取消（#43）：后端是唯一真相，被提示词 @ 引用的资产取消会返回 400（原因就地展示）。
// 异步结果只写回发起时的分镜对象，切镜不会串状态；主场景 scene_id 不受此入口影响。
const poolSaveQueues = new Map()
function setShotPoolAsset(sb, asset, selected) {
  if (!sb?.id || !asset?.kind || !asset?.id) return Promise.resolve()
  // 同镜不同卡片可连续点击，但请求按顺序提交，防止较早的整池回包覆盖较新的选择。
  const previous = poolSaveQueues.get(sb.id) || Promise.resolve()
  const pending = previous.catch(() => {}).then(() => storyboardAPI
    .setPoolAsset(sb.id, { kind: asset.kind, asset_id: asset.id, selected: !!selected })
    .then((res) => { applyStoryboardUpdate(sb, res, refIssuesOf(sb)) }))
  poolSaveQueues.set(sb.id, pending)
  return pending.finally(() => {
    if (poolSaveQueues.get(sb.id) === pending) poolSaveQueues.delete(sb.id)
  })
}

// 提示词 @ 引用候选：本集全部可视角色 / 场景 / 道具（未预选也能搜到并引用，引用后后端自动入池）。
// 展示顺序：角色 → 场景 → 道具
// kind 为逻辑值（MentionTextarea 按 kind 着色/选图标），group 为显示文案
function shotMentionOptions(sb) {
  if (!sb) return []
  return [
    ...visualChars.value.map(c => ({
      label: c.name,
      value: c.name,
      kind: 'character',
      group: t('common.role'),
      image: thumbOf(assetImageSrc(c)),
    })),
    ...scenes.value.map(scene => ({
      label: `${scene.location} · ${scene.time || t('episode.asset.noTime')}`,
      value: scene.location,
      kind: 'scene',
      group: t('common.scene'),
      image: thumbOf(assetImageSrc(scene)),
    })),
    ...propItems.value.map(p => ({
      label: p.name,
      value: p.name,
      kind: 'prop',
      group: t('common.prop'),
      image: thumbOf(assetImageSrc(p)),
    })),
  ]
}
const mentionOptions = computed(() => shotMentionOptions(selectedSb.value))

// 分镜时长（视频生成参数区直接编辑并保存到分镜）：
// 统一限制 2-30s，列表/批量/单次生成统一读取该值；超出厂商支持范围由后端适配器收敛
function onVideoDurationChange(e) {
  const sb = selectedSb.value
  if (!sb) return
  const min = 2
  const max = 30
  let v = Math.round(Number(e.target.value))
  if (!Number.isFinite(v)) v = Number(sb.duration || 10)
  v = Math.min(max, Math.max(min, v))
  e.target.value = v
  updateField(sb, 'duration', v)
}

function shotNumber(sb) {
  return sb?.storyboard_number || sb?.storyboardNumber || 0
}

// ===== 分镜关键帧：有效首/中/尾帧与确认状态由后端计算，随分镜 JSON 的 keyframes 返回 =====
const KEYFRAME_SLOTS = computed(() => [
  { slot: 'first', label: t('episode.kf.slotFirst') },
  { slot: 'mid', label: t('episode.kf.slotMid') },
  { slot: 'last', label: t('episode.kf.slotLast') },
])
function shotKeyframeImage(sb, slot) {
  const k = sb?.keyframes || {}
  if (slot === 'first') return k.first_image ?? k.firstImage ?? ''
  if (slot === 'mid') return k.mid_image ?? k.midImage ?? ''
  return k.last_image ?? k.lastImage ?? ''
}
function shotKeyframePlaceholder(sb, slot) {
  if (slot !== 'mid') return t('episode.kf.slotEmpty')
  const task = latestKeyframeTask(sb?.id, 'mid_frame')
  if (isActiveTaskStatus(task?.status)) return t('episode.kf.generating')
  if (task?.status === 'failed') return t('episode.kf.genFailed')
  if (task?.status === 'cancelled') return t('episode.kf.batchItemCancelled')
  return t((sb?.mid_frame_prompt || '').trim() ? 'episode.kf.midRequired' : 'episode.kf.midOptional')
}
function isShotConfirmed(sb) {
  return Boolean(sb?.keyframes?.confirmed)
}
const keyframesConfirmedCount = computed(() => sbs.value.filter(sb => isShotConfirmed(sb)).length)
const allKeyframesConfirmed = computed(() => sbs.value.length > 0 && keyframesConfirmedCount.value === sbs.value.length)
// 中间帧引导只有 ComfyUI(H3) 支持；MiniMax 云端只用首尾帧，批量确认框里要写明
const videoProviderSupportsMidFrame = computed(() => selectedVideoConfig.value?.provider === 'comfyui')

function pickFile(accept, cb) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = accept
  input.onchange = () => { const f = input.files?.[0]; if (f) cb(f) }
  input.click()
}

// ===== 资产图片手动上传（角色形象 / 场景图 / 道具图）=====
// 上传类型显示名渲染时求值
const assetUploadLabelMap = computed(() => ({
  character: t('episode.asset.charPortrait'),
  scene: t('episode.asset.sceneImage'),
  prop: t('episode.asset.propImage'),
}))
const uploadingAssetKeys = ref([])
function isUploadingAsset(kind, id) { return uploadingAssetKeys.value.includes(`${kind}:${id}`) }
function uploadAssetImage(kind, id) {
  pickFile('image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp', async (file) => {
    const key = `${kind}:${id}`
    if (!uploadingAssetKeys.value.includes(key)) uploadingAssetKeys.value.push(key)
    try {
      const res = await uploadAPI.image(file)
      // 手动上传也是一个正式版本：注册到 sys_task，后端同时把它设为当前采用版本。
      await taskAPI.registerUpload(kind, id, res.path)
      toast.success(t('episode.upload.assetDone', { type: assetUploadLabelMap.value[kind] || '' }))
      await refresh()
    } catch (e) {
      toastError(e)
    } finally {
      uploadingAssetKeys.value = uploadingAssetKeys.value.filter(k => k !== key)
    }
  })
}

// 从素材库选资产图：复制一份库内图片，再按「一次新上传」注册为新版本并设为当前图
const assetLibrary = ref({ open: false, loading: false, kind: '', id: 0 })
function openAssetLibrary(kind, id) {
  assetLibrary.value = { open: true, loading: false, kind, id }
}
async function applyAssetImageFromLibrary(urls) {
  const { kind, id } = assetLibrary.value
  const url = urls[0]
  if (!url || !kind || !id || assetLibrary.value.loading) return
  assetLibrary.value = { ...assetLibrary.value, loading: true }
  const key = `${kind}:${id}`
  if (!uploadingAssetKeys.value.includes(key)) uploadingAssetKeys.value.push(key)
  try {
    const copy = await mediaLibraryAPI.copy(url)
    await taskAPI.registerUpload(kind, id, copy.path, copy.copied_from)
    toast.success(t('components.mediaLibrary.assetApplied'))
    assetLibrary.value = { open: false, loading: false, kind: '', id: 0 }
    await refresh()
  } catch (e) {
    toastError(e)
    assetLibrary.value = { ...assetLibrary.value, loading: false }
  } finally {
    uploadingAssetKeys.value = uploadingAssetKeys.value.filter(k => k !== key)
  }
}

// 参考图（生图输入）增删由 ReferenceImageManager 直接调服务端：
// 以响应返回的数组为准覆盖本地值，不做乐观更新；成片图 image_url 不受影响
function onAssetRefsUpdate(item, refs) {
  item.reference_images = refs
}

// 史料参考（Issue #32）：只做出处留档，不进生图；同样以服务端返回的数组为准
function onAssetArchivalUpdate(item, entries) {
  item.archival_images = entries
}

/**
 * 证据素材（Issue #47）：PropSemanticsPanel 的 update 事件给的是道具行的局部字段
 * （保存标注给 { semantics }，切换忠实原件给整行），一律按服务端返回值覆盖本地行。
 */
function onAssetSemanticsUpdate(item, patch) {
  if (!patch || typeof patch !== 'object') return
  Object.assign(item, patch)
  const target = propItems.value.find(p => p.id === item.id)
  if (target && target !== item) Object.assign(target, patch)
}

async function onAssetMapSpecUpdate(item, mapSpec) {
  onAssetSemanticsUpdate(item, { map_spec: mapSpec })
  mapDraftAssetId.value = null
  // Refresh server-owned map output/versions without replacing unsaved asset text drafts.
  const episodeId = epId.value
  try {
    const rows = await episodeAPI.props(episodeId)
    if (episodeId !== epId.value) return
    propItems.value = rows
    const updated = rows.find(prop => prop.id === item.id)
    if (updated) {
      Object.assign(item, updated)
      if (assetDetail.value.type === 'prop' && assetDetail.value.item?.id === item.id) {
        Object.assign(assetDetail.value.item, updated)
      }
    }
  } catch (err) {
    toastError(err)
  }
}

// 忠实素材开关：打开直接写；关闭要人确认（关掉后这张图会重新进入生图与批量重绘）
const faithfulSaving = ref(false)
const faithfulConfirm = ref({ open: false, name: '' })
const assetDetailFaithful = computed(() => assetDetail.value.type === 'prop' && !!assetDetail.value.item?.faithful)

function onFaithfulToggle(checked) {
  if (faithfulSaving.value) return
  if (!checked) {
    faithfulConfirm.value = { open: true, name: assetDetail.value.item?.name || '' }
    return
  }
  applyFaithful(true)
}

function confirmUnfaithful() {
  applyFaithful(false)
}

async function applyFaithful(faithful) {
  const item = assetDetail.value.item
  if (!item?.id || faithfulSaving.value) return
  faithfulSaving.value = true
  try {
    const row = await propAPI.setFaithful(item.id, faithful)
    onAssetSemanticsUpdate(item, row && typeof row === 'object' ? row : { faithful: faithful ? 1 : 0 })
    faithfulConfirm.value = { open: false, name: '' }
    toast.success(faithful ? t('episode.asset.faithfulOn') : t('episode.asset.faithfulOff'))
  } catch (e) {
    toastServerMessage(e, { fallback: 'episode.asset.faithfulFailed' })
  } finally {
    faithfulSaving.value = false
  }
}

// 按史料画像补充外貌（Issue #32）：后端只改写 appearance，所以走同一套清空路径但只收窄到该字段，
// 最终提示词与来源徽标照常清空（外貌变了提示词就作废），再把新外貌写回行与弹窗草稿
function onAssetAppearanceFromPortrait(item, appearance) {
  const id = item?.id
  if (!id) return
  applyReExtractCleared('character', id, ['appearance'])
  const target = chars.value.find(x => x.id === id)
  if (target) target.appearance = appearance
  item.appearance = appearance
  if (isAssetDialogOn('character', id)) assetDetailDraft.value.appearance = appearance
}

// 视频提示词的一致性问题：槽位字段为 video_prompt 的问题 + 绑定级问题（fields 为空）
function videoPromptIssues(sb) {
  return refIssuesOf(sb).filter(issue => {
    const fields = Array.isArray(issue?.fields) ? issue.fields : []
    return !fields.length || fields.includes('video_prompt')
  })
}
function videoBlockIssues(sb) {
  return videoPromptIssues(sb).filter(issue => issue.severity === 'block')
}
function videoBlockReason(sb) {
  return videoBlockIssues(sb).map(issue => issue.message).join(t('common.listJoin'))
}

// ===== 开场转场（#11）：只有承接镜头（首帧继承上一镜尾帧）才显示 =====
const transitionGeneratingIds = ref([])
const TRANSITION_MAX_DURATION = 15

function shotInheritsFirst(sb) {
  return Boolean(sb?.keyframes?.inherits_first)
}
function transitionReviewOf(sb) {
  return sb?.transition_review || sb?.transitionReview || null
}
function transitionEnabledOf(sb) {
  const value = sb?.transition_enabled ?? sb?.transitionEnabled
  return value !== false && value !== 0
}
function transitionStaleOf(sb) {
  return Boolean(sb?.transition_stale ?? sb?.transitionStale)
}
function prevShotOf(sb) {
  const index = sbs.value.indexOf(sb)
  return index > 0 ? sbs.value[index - 1] : null
}
/** 摘要里的「场景/时间」：优先分镜自己的 location/time，回落到绑定场景 */
function shotPlaceLabel(sb) {
  const scene = getSceneName(sb)
  const place = (sb?.location || '').trim() || scene || t('episode.trans.unknownPlace')
  const time = (sb?.time || '').trim()
  return time ? `${place} · ${time}` : place
}
/** 转场秒数 T：审核给出的秒数，没有则 3 秒 */
function transitionSeconds(sb) {
  return Number(transitionReviewOf(sb)?.seconds) || 3
}
function transitionVerdictLabel(sb) {
  const review = transitionReviewOf(sb)
  if (!review) return t('episode.trans.verdictPending')
  if (review.verdict === 'scene_time') return t('episode.trans.verdictSceneTime')
  if (review.verdict === 'continuity') {
    const hazards = (review.hazards || []).concat(review.changes || []).filter(Boolean)
    return t('episode.trans.verdictContinuity', { issues: hazards.slice(0, 2).join(t('common.listJoin')) || '—' })
  }
  return t('episode.trans.verdictNone')
}
/** 预计时长提示：12 秒 + 3 秒转场 = 15 秒 */
function transitionDurationHint(sb) {
  const content = Number(sb?.duration || 0)
  const seconds = transitionSeconds(sb)
  return t('episode.trans.durationHint', {
    content,
    seconds,
    total: Math.min(content + seconds, TRANSITION_MAX_DURATION),
  })
}
function transitionIssues(sb) {
  return refIssuesOf(sb).filter(issue => (issue?.fields || []).includes('transition_prompt'))
}
/** AI 审核并生成转场（单镜）：后端同步跑转场 agent 并落库 */
async function genTransition(sb) {
  if (!sb || transitionGeneratingIds.value.includes(sb.id)) return
  transitionGeneratingIds.value.push(sb.id)
  try {
    await storyboardAPI.generateTransition(sb.id, {
      model: chatModelOverride() || undefined,
      config_id: chatConfigId() || undefined,
    })
    toast.success(t('episode.trans.generated'))
    await refresh()
  } catch (e) {
    toastError(e)
  } finally {
    transitionGeneratingIds.value = transitionGeneratingIds.value.filter(id => id !== sb.id)
  }
}
async function setTransitionEnabled(sb, enabled) {
  if (!sb) return
  sb.transition_enabled = enabled
  sb.transitionEnabled = enabled
  try {
    await storyboardAPI.update(sb.id, { transition_enabled: enabled })
  } catch (e) {
    sb.transition_enabled = !enabled
    sb.transitionEnabled = !enabled
    toastError(e)
  }
}

// 单镜视频生成：关键帧引导、参考图、@图片N 映射、分辨率等全部由后端按分镜组装
async function genVid(sb) {
  if (!sb || videoBatchRunning.value) {
    if (videoBatchRunning.value) toast.info(t('episode.vid.batchAlreadyRunning'))
    return false
  }
  // 关键帧未确认的分镜不允许生成视频（后端同样会拒绝）
  if (!isShotConfirmed(sb)) {
    toast.warning(t('episode.kf.gateShotUnconfirmed'))
    return false
  }
  // 视频提示词与参考图不一致（缺图/未绑定/场景冲突/未知引用）同样拦截，后端复查
  if (videoBlockIssues(sb).length) {
    toast.error(t('episode.ref.videoBlocked', { reason: videoBlockReason(sb) }), { duration: 7000 })
    return false
  }
  try {
    delete failedVideoMessages.value[sb.id]
    if (!isPendingVideo(sb.id)) pendingVideoIds.value.push(sb.id)
    const generation = await storyboardAPI.generateVideo(sb.id, {
      model: bareModelName(videoModel.value) || undefined,
      config_id: ownerConfigId(videoModelOptions.value, videoModel.value),
    })
    toast.success(t('episode.vid.generating'))
    await refresh()
    void pollVideoGeneration(generation?.id, sb.id)
    return true
  } catch (e) {
    pendingVideoIds.value = pendingVideoIds.value.filter(item => item !== sb.id)
    failedVideoMessages.value = {
      ...failedVideoMessages.value,
      [sb.id]: e.message || t('episode.vid.genFailed'),
    }
    toastServerMessage(e, { fallback: 'episode.vid.genFailed' })
    return false
  }
}
async function pollVideoGeneration(generationId, storyboardId) {
  if (!generationId) {
    watchAsyncResult(() => {
      const target = sbs.value.find(s => s.id === storyboardId)
      const done = !!(target?.video_url || target?.videoUrl)
      if (done) pendingVideoIds.value = pendingVideoIds.value.filter(item => item !== storyboardId)
      return done
    }, 60, 4000)
    return false
  }
  // 与后端视频任务 10s × 300 的终态预算一致，避免长队列/长模型在前端先被判超时。
  for (let i = 0; i < 300; i++) {
    await sleep(10_000)
    try {
      const res = await taskAPI.get(generationId)
      await refresh()
      if (res?.status === 'completed') {
        pendingVideoIds.value = pendingVideoIds.value.filter(item => item !== storyboardId)
        delete failedVideoMessages.value[storyboardId]
        toast.success(t('episode.vid.genDone'))
        return true
      }
      if (res?.status === 'failed') {
        pendingVideoIds.value = pendingVideoIds.value.filter(item => item !== storyboardId)
        const errMsg = res?.error_msg || res?.errorMsg || t('episode.vid.genFailed')
        failedVideoMessages.value = {
          ...failedVideoMessages.value,
          [storyboardId]: errMsg,
        }
        toastError(errMsg, { fallback: 'episode.vid.genFailed' })
        return false
      }
      if (res?.status === 'cancelled') {
        pendingVideoIds.value = pendingVideoIds.value.filter(item => item !== storyboardId)
        toast.info(t('common.ring.cancelled'))
        return false
      }
    } catch {}
  }
  pendingVideoIds.value = pendingVideoIds.value.filter(item => item !== storyboardId)
  failedVideoMessages.value = {
    ...failedVideoMessages.value,
    [storyboardId]: t('episode.vid.genTimeout'),
  }
  toast.error(t('episode.vid.genTimeout'))
  return false
}
// 拼接前确认（#42）：纳入/排除镜号必须在确认时看得见，不可静默少镜
const mergeConfirm = ref({ open: false, ids: [], included: [], excluded: [], loading: false })

function shotNumberLabel(n) { return `#${String(n).padStart(2, '0')}` }

/** 发起拼接：先按服务端就绪口径校验所选，再确认纳入/排除 */
function askMerge() {
  mergeBlocked.value = []
  const selected = exportSelectedReadyIds.value
  if (!selected.length) {
    toast.error(t('episode.export.selectFirst'))
    return
  }
  if (exportBlockedSelected.value.length) {
    mergeBlocked.value = exportBlockedSelected.value.map(item => ({
      storyboard_id: item.id,
      storyboard_number: item.number,
      status: item.status,
      reason: item.reason || item.label,
    }))
    toast.error(t('episode.export.blockedToast', { n: exportBlockedSelected.value.length }))
    return
  }
  const included = selected
    .map(id => sbs.value.findIndex(sb => sb.id === id) + 1)
    .filter(n => n > 0)
    .sort((a, b) => a - b)
  const excluded = sbs.value
    .map((sb, index) => ({ sb, number: index + 1 }))
    .filter(item => !selected.includes(item.sb.id))
    .map(item => item.number)
  mergeConfirm.value = { open: true, ids: [...selected], included, excluded, loading: false }
}

// 确认弹窗的键盘与焦点：Esc 关闭（执行中不关），打开聚焦弹窗，关闭把焦点还给触发按钮
const mergeConfirmEl = ref(null)
let mergeConfirmReturnFocus = null
function closeMergeConfirm() {
  if (mergeConfirm.value.loading) return
  mergeConfirm.value.open = false
}
function onMergeConfirmTab(event) {
  const buttons = [...event.currentTarget.querySelectorAll('button')]
    .filter(button => !button.disabled && button.offsetParent !== null)
  if (!buttons.length) return
  const first = buttons[0]
  const last = buttons[buttons.length - 1]
  if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}
watch(() => mergeConfirm.value.open, async (open) => {
  if (open) {
    mergeConfirmReturnFocus = document.activeElement
    await nextTick()
    mergeConfirmEl.value?.focus()
  } else if (mergeConfirmReturnFocus?.isConnected) {
    mergeConfirmReturnFocus.focus()
    mergeConfirmReturnFocus = null
  }
})

async function confirmMerge() {
  if (mergeConfirm.value.loading) return
  mergeConfirm.value.loading = true
  const ok = await doMerge(mergeConfirm.value.ids)
  mergeConfirm.value.loading = false
  if (ok) mergeConfirm.value.open = false
}

async function doMerge(ids) {
  const storyboardIds = Array.isArray(ids) ? ids : undefined
  if (storyboardIds && !storyboardIds.length) {
    toast.error(t('episode.export.selectFirst'))
    return false
  }
  mergeSkipped.value = []
  mergeBlocked.value = []
  const poster = exportPosterEnabled.value && exportPosterVersionId.value
    ? {
        versionId: Number(exportPosterVersionId.value),
        duration: Math.min(10, Math.max(0.5, Number(exportPosterDuration.value) || 3)),
      }
    : undefined
  try {
    const res = await mergeAPI.merge(epId.value, storyboardIds, poster)
    // 旁白关闭时没有融合要求；被跳过的镜头接口仍逐条返回镜号与原因（#30 B.8）
    mergeSkipped.value = Array.isArray(res?.skipped) ? res.skipped : []
    toast.success(t('episode.export.mergingToast'))
    if (mergeSkipped.value.length) toast.warning(t('episode.compose.mergeSkippedToast', { n: mergeSkipped.value.length }))
  } catch (e) {
    // 依赖/新鲜度不满足时后端 400 带逐镜原因：就地展示，不泛化成「拼接失败」
    const blocked = Array.isArray(e?.body?.blocked) ? e.body.blocked : []
    if (blocked.length) {
      mergeBlocked.value = blocked
      toast.error(t('episode.export.blockedToast', { n: blocked.length }))
    } else {
      toastError(e, { fallback: 'episode.export.mergeFailed' })
    }
    await refresh()
    return false
  }
  startMergePolling()
  return true
}

// 拼接进度轮询：离开页面即停，不在已销毁的组件上继续发请求
let mergePollTimer = null
function stopMergePolling() {
  if (mergePollTimer) { clearTimeout(mergePollTimer); mergePollTimer = null }
}
function startMergePolling() {
  stopMergePolling()
  const tick = async () => {
    mergePollTimer = null
    if (!pollAlive) return
    try { mergeData.value = await mergeAPI.status(epId.value) } catch { /* 下一轮再试 */ }
    if (!pollAlive) return
    const status = mergeData.value?.status
    if (status === 'completed') {
      toast.success(t('episode.export.mergeDone'))
      await loadExportMerges()
      return
    }
    if (status === 'failed') {
      toastError(mergeData.value?.error_msg || mergeData.value?.errorMsg, { fallback: 'episode.export.mergeFailed' })
      return
    }
    mergePollTimer = setTimeout(tick, 3000)
  }
  mergePollTimer = setTimeout(tick, 3000)
}
async function loadConfigs() {
  try {
    const [imgCfgs, vidCfgs, txtCfgs] = await Promise.all([
      aiConfigAPI.list('image'),
      aiConfigAPI.list('video'),
      aiConfigAPI.list('text'),
    ])
    imageConfigs.value = imgCfgs || []
    videoConfigs.value = vidCfgs || []
    textConfigs.value = txtCfgs || []
  } catch (e) { console.error('Failed to load AI configs', e) }
}

// deeplink ?asset=类型-id：数据就绪后打开对应资产详情弹窗（并定位到资产面板）；
// 资产已删除/不存在时静默忽略，停留在按 URL/localStorage 恢复的面板
function applyAssetDeeplink() {
  if (!pendingAssetLink) return
  const { type, id } = pendingAssetLink
  const list = type === 'character' ? chars.value : type === 'scene' ? scenes.value : propItems.value
  const item = list.find(x => x.id === id)
  if (!item) return
  panel.value = 'production'
  prodTab.value = 'assets'
  openAssetDetail(type, item)
}

// 水合完成：数据就绪 + 资产弹窗回放后开启 URL 同步；带参数进入或水合期间状态已变化时整体同步一次
const WORKBENCH_QUERY_KEYS = ['panel', 'step', 'tab', 'extract', 'asset']
onMounted(async () => {
  await refresh()
  applyAssetDeeplink()
  workbenchHydrated = true
  if (workbenchDirty || WORKBENCH_QUERY_KEYS.some(k => k in route.query)) syncWorkbenchQuery()
  loadConfigs()
  syncExtractStatus()
  loadVideoBatch() // 批量进度在服务端，刷新页面后继续展示
  resumeNarrationBatch() // 旁白批量同理：刷新后按钮仍显示运行态与进度
  resumeComposeBatch() // 批量融合：浏览器刷新后从持久化任务恢复进度展示
})

// 离开页面停止融合 / 拼接轮询：组件卸载后不再发请求、不再写已销毁的状态
onBeforeUnmount(() => {
  pollAlive = false
  stopComposePolling()
  stopMergePolling()
})

// ===== 应用内引导（工作台）：沿左侧进度栏走 6 步流水线 =====
const EPISODE_TOUR = [
  { element: '.studio-topbar-main', titleKey: 'tour.episode.topbar.title', descKey: 'tour.episode.topbar.desc', popoverSide: 'bottom' },
  { element: '.pipe-section:nth-of-type(1)', titleKey: 'tour.episode.script.title', descKey: 'tour.episode.script.desc', popoverSide: 'right' },
  { element: '.pipe-section:nth-of-type(2)', titleKey: 'tour.episode.assets.title', descKey: 'tour.episode.assets.desc', popoverSide: 'right' },
  { element: '.pipe-section:nth-of-type(2) .pipe-item:last-child', titleKey: 'tour.episode.videos.title', descKey: 'tour.episode.videos.desc', popoverSide: 'right' },
  { element: '.studio-actions .tour-help-btn', titleKey: 'tour.episode.help.title', descKey: 'tour.episode.help.desc', popoverSide: 'bottom', popoverAlign: 'end' },
]
// ===== 步骤面板上下文（Issue #54）=====
// 各步骤的 markup 已搬进 components/*Panel.vue，状态与方法仍然只存在这里（单一数据源），
// 经 provide 传给挂载组件；后续 Issue 只改面板组件内部，不再回本文件改 markup。
provide(WORKBENCH_CTX, {
  KEYFRAME_SLOTS,
  VIDEO_COL_DEFAULTS,
  narrationSettingsOpen,
  shotMentionOptions,
  activeMerge,
  allKeyframesConfirmed,
  allVideoTaskRows,
  askDeleteMerge,
  askMerge,
  assetImageSrc,
  batchVideoPrompts,
  batchVideos,
  cancelVideoBatch,
  chatConfigId,
  chatModelOverride,
  composeBatchRunning,
  composeReasonOf,
  composeStateOf,
  composeStatusLabel,
  composeStatusOf,
  composeTask,
  confirmScript,
  confirmingScript,
  deletingMergeId,
  doRewrite,
  dramaAspectRatio,
  effectiveVideoDuration,
  effectiveVideoModelLabel,
  epId,
  episode,
  episodeAudioMixMode,
  episodeFitDefault,
  episodeNarrationNormalize,
  episodeResolutionShort,
  episodeSubtitleTiming,
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
  fieldSaveInfo,
  footerOpen,
  genTransition,
  genVid,
  genVideoPrompt,
  getVideoUrl,
  gotoShotProduction,
  hasUsableVideo,
  hasVid,
  historyElapsedTook,
  inspectorOpen,
  isCurrentVideo,
  isDocumentaryProject,
  isExportSelected,
  isMergeInProgress,
  isShotConfirmed,
  isVideoSbSelected,
  keyframesConfirmedCount,
  loadExportMerges,
  localRaw,
  localScript,
  mainPlayerUrl,
  mapError,
  markFieldDirty,
  mediaTimeOf,
  mentionOptions,
  mergeBlocked,
  mergeSkipped,
  narrationBatch,
  narrationEnabledOf,
  onShotComposed,
  onVideoDurationChange,
  onVideoTaskRowClick,
  openComposeDialog,
  openImageViewer,
  panel,
  pendingVideoIds,
  playerSource,
  posterPreviewUrl,
  posterVersionOptions,
  prevShotOf,
  previewHistoryVideo,
  previewShot,
  previewVideoUrl,
  prodTab,
  promptHeadVideoActionLabel,
  rawContent,
  rawLen,
  refresh,
  removeHistoryVideo,
  retryFailedVideos,
  rn,
  rt,
  saveRaw,
  sbVideoHistory,
  sbs,
  scriptConfirmed,
  scriptConfirmedAt,
  scriptContent,
  scriptLen,
  scriptStep,
  selectExportReadyOnly,
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
  shotVidCount,
  shotVideoRefCount,
  skipRewrite,
  startVideoColDrag,
  targetAssetVersions,
  targetVersionSaving,
  taskGeneratedAt,
  taskVideoPath,
  toast,
  toggleExportDone,
  toggleExportSelect,
  toggleSelectAllExport,
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
  unconfirmScript,
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
  videoSelectMode,
  videoTargetAssets,
  videoTargetLead,
  videoTaskActionLabel,
  videoTaskDoneCount,
  videoTaskFailedCount,
  videoTaskRows,
  videoTaskState,
  videoTaskStatusLabel,
})

onMounted(() => setTimeout(() => autoTour('episode', EPISODE_TOUR, t), 900))
</script>

<style scoped>
/* ===== Studio Layout ===== */
.studio {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
  /* 页面尺寸规格：最小可用宽度 1280px，更窄由外层横向滚动，不再继续压缩 */
  min-width: 1280px;
  padding: 8px;
  gap: 8px;
  background: var(--surface-base);
  /* 选中态:中性反色(浅色近黑/深色近白),与进行中(蓝脉冲)/已完成(绿勾)区分,
     遵循「颜色只承担状态指示」——选中不是状态,保持无色 */
  --sel: var(--text-0);
  --sel-bg: var(--bg-active);
  --sel-text: var(--text-0);
  --sel-glow: var(--bg-hover);
}

.studio-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-shrink: 0;
  min-height: 40px;
  padding: 4px 10px;
  border-radius: var(--radius-lg);
  background: var(--header-bg);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-card);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
}

.studio-topbar-main,
.sidebar,
.main {
  background: var(--surface-raised);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-card);
}

.studio-topbar-main {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0;
  border: 0;
  box-shadow: none;
  backdrop-filter: none;
  background: transparent;
  min-width: 0;
}

/* 用更高特异性压过后面的 .back-btn{height:40px}，保持顶栏紧凑 */
.studio-topbar .topbar-back {
  width: auto;
  min-width: 72px;
  padding: 0 12px;
  height: 26px;
  border-radius: var(--radius-pill);
  white-space: nowrap;
  font-size: 11px;
}

.studio-identity {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.studio-overline {
  display: none;
  font-size: 8px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-3);
}

.studio-title-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  min-width: 0;
}

.studio-title {
  font-size: 13px;
  line-height: 1;
  letter-spacing: -0.04em;
  white-space: nowrap;
  /* 长剧名在窄窗口省略，避免把右侧顶栏内容顶出视口 */
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.studio-episode-chip {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 8px;
  border-radius: var(--radius-pill);
  background: var(--accent-bg);
  color: var(--accent-text);
  font-size: 9px;
  font-weight: 700;
}

.studio-meta-row {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: nowrap;
  min-width: 0;
}

.studio-meta-pill {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 8px;
  border-radius: var(--radius-pill);
  background: var(--accent-bg);
  color: var(--accent-text);
  font-size: 8px;
  font-weight: 600;
  white-space: nowrap;
}

.studio-meta-pill.is-stage {
  background: var(--accent-bg);
  color: var(--accent-text);
}
.studio-meta-pill.is-progress {
  background: var(--success-bg);
  color: var(--success);
}
.studio-meta-inline {
  font-size: 9px;
  color: var(--text-3);
  font-weight: 600;
  white-space: nowrap;
}

.studio-topbar-side {
  display: flex;
  align-items: center;
  gap: 6px;
  /* 空间不足时由右侧模型选择区收缩，任务按钮所在的 .studio-actions 不收缩 */
  flex-shrink: 1;
  min-width: 0;
}

/* 顶栏内联数字输入（#31 底音增益 / 默认留白） */
.studio-num {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10.5px;
  color: var(--text-3);
  white-space: nowrap;
}
.studio-num-input {
  width: 60px;
  height: 26px;
  font-size: 10.5px;
}

.studio-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}
.studio-topbar .btn {
  height: 26px;
  padding: 0 9px;
  font-size: 10.5px;
  white-space: nowrap;
}

.studio-body {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);  /* 列宽跟随侧栏实际宽度（收起时 46px） */
  gap: 8px;
  min-height: 0;
  flex: 1;
}

/* ===== Sidebar ===== */
.sidebar {
  width: 208px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 0;
  border-radius: var(--radius);
}
.back-btn {
  min-width: 40px; width: auto; height: 40px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  gap: 6px;
  padding: 0 12px;
  border: none; border-radius: var(--radius-pill);
  background: var(--overlay-track); color: var(--text-1);
  cursor: pointer; transition: all 0.18s var(--ease-out);
  font-size: 12px;
  font-weight: 650;
  line-height: 1;
}
.back-btn:hover {
  background: var(--bg-active);
  color: var(--text-0);
}
.back-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3.5px var(--button-focus);
}

/* Pipeline Nav */
.pipeline { flex: 1; overflow-y: auto; padding: 12px 10px 8px; display: flex; flex-direction: column; gap: 8px; }
.pipe-section { display: flex; flex-direction: column; gap: 2px; }
.pipe-section-label {
  display: flex; align-items: center; gap: 5px;
  font-size: 10.5px; font-weight: 700; color: var(--text-3);
  text-transform: uppercase; letter-spacing: 0.06em;
  padding: 0 7px 2px;
}
/* 分组标题保持中性灰,状态色只在左侧小指示器上 */
.pipe-section-state {
  width: 13px; height: 13px; border-radius: 999px; flex-shrink: 0;
  display: inline-flex; align-items: center; justify-content: center;
}
.pipe-section.is-done .pipe-section-state {
  background: var(--success-bg); color: var(--success);
  border: 1px solid var(--success-bg);
}
.pipe-section-dot {
  width: 5px; height: 5px; border-radius: 999px;
  background: var(--text-3); opacity: 0.55;
}
.pipe-section-pulse {
  width: 6px; height: 6px; border-radius: 999px;
  background: var(--accent);
  animation: pipeSectionPulse 1.6s var(--ease-out) infinite;
}
@keyframes pipeSectionPulse {
  0% { box-shadow: 0 0 0 0 var(--accent-glow); }
  70% { box-shadow: 0 0 0 5px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}
.pipe-section-tag {
  font-size: 9.5px; font-weight: 600; letter-spacing: 0.03em;
  color: var(--text-2); background: var(--bg-2);
  border-radius: 999px; padding: 1px 5px;
  text-transform: none;
}
/* 子步骤进行中:与大环节同步的脉冲点 */
.pipe-item.doing { color: var(--text-1); }
.pipe-item.doing .pipe-icon {
  background: var(--accent-bg);
  border-color: var(--accent-glow);
}
.pipe-item-pulse {
  width: 6px; height: 6px; border-radius: 999px;
  background: var(--accent);
  animation: pipeSectionPulse 1.6s var(--ease-out) infinite;
}
.pipe-item {
  position: relative;
  display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 10px;
  padding: 7px 10px;
  border-radius: var(--radius);
  font-size: 13px; font-weight: 600;
  background: transparent; border: 1px solid transparent; color: var(--text-2); cursor: pointer;
  transition: all 0.18s var(--ease-out); width: 100%; text-align: left;
}
.pipe-item:hover {
  background: var(--bg-hover);
  border-color: transparent;
  color: var(--text-0);
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
.pipe-item:focus-visible {
  outline: none;
  border-color: var(--action-primary);
  box-shadow: 0 0 0 3px var(--button-focus), var(--button-shadow);
}
.pipe-item.done { color: var(--text-2); }
.pipe-item-sub {
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  padding: 5px 8px;
  position: relative;
  min-height: 34px;
}

.pipe-item-sub:not(:last-child)::after {
  content: '';
  position: absolute;
  left: 15px;
  top: 23px;
  bottom: -6px;
  width: 1px;
  background: var(--border);
}

.pipe-icon {
  width: 16px; height: 16px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  background: var(--bg-2); border: 1px solid var(--border);
  color: var(--text-3); flex-shrink: 0; transition: all 0.15s;
  position: relative;
  z-index: 1;
}
.pipe-item.active .pipe-icon { background: var(--sel); border-color: var(--sel); color: var(--surface-raised); }
.pipe-item.done .pipe-icon { background: var(--success-bg); border-color: var(--success-bg); color: var(--success); }
.pipe-item.active.done .pipe-icon { background: var(--sel); border-color: var(--sel); color: var(--surface-raised); }
.icon-active { background: var(--sel) !important; border-color: var(--sel) !important; color: var(--surface-raised) !important; }
.icon-done { background: var(--success-bg) !important; border-color: var(--success-bg) !important; color: var(--success) !important; }
.pipe-item.active.done .icon-done { background: var(--sel) !important; border-color: var(--sel) !important; color: var(--surface-raised) !important; }

.pipe-label { flex: 1; font-size: 12.5px; }
.pipe-copy { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.pipe-sub {
  display: none;
  font-size: 10px;
  line-height: 1.35;
  color: var(--text-3);
  font-weight: 500;
}
.pipe-badge {
  font-size: 9px; font-weight: 700; padding: 1px 5px;
  border-radius: 99px; background: var(--bg-3); color: var(--text-3);
  font-family: var(--font-mono);
}
.pipe-badge.badge-done { background: var(--success-bg); color: var(--success); }
.pipe-spinner { width: 10px; height: 10px; border: 1.5px solid var(--accent-bg); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }

/* Sidebar Bottom */
.sidebar-bottom {
  padding: 9px 10px 10px;
  border-top: 1px solid var(--border);
  display: flex; flex-direction: column; gap: 7px;
  flex-shrink: 0;
  background: var(--surface-soft);
}
/* 收起/展开按钮 */
.sidebar-toggle {
  display: flex; align-items: center; justify-content: center; gap: 5px;
  width: 100%; min-height: 22px;
  border: none; border-radius: 6px;
  background: transparent; color: var(--text-3);
  font: 600 11px var(--font-body);
  cursor: pointer; transition: background 0.14s, color 0.14s;
}
.sidebar-toggle:hover { background: var(--bg-hover); color: var(--text-0); }
.sidebar-toggle-icon { transition: transform 0.22s var(--ease-out); flex-shrink: 0; }
.sidebar.collapsed .sidebar-toggle-icon { transform: rotate(180deg); }

/* ===== 收起态：窄图标栏 ===== */
.sidebar { transition: width 0.22s var(--ease-out); }
.sidebar.collapsed { width: 46px; }
.sidebar.collapsed .pipeline { padding: 12px 5px 8px; gap: 10px; }
.sidebar.collapsed .pipe-section-label { justify-content: center; padding: 0 0 2px; }
.sidebar.collapsed .pipe-section-label > span:not(.pipe-section-state) { display: none; }
.sidebar.collapsed .pipe-item {
  grid-template-columns: auto; justify-content: center;
  padding: 6px 0; min-height: 0;
}
.sidebar.collapsed .pipe-item .pipe-copy { display: none; }
.sidebar.collapsed .pipe-item-sub:not(:last-child)::after { display: none; }
.sidebar.collapsed .pipe-icon { width: 22px; height: 22px; }
/* 收起态：进行中步骤的角标脉冲点 */
.pipe-mini-pulse {
  position: absolute; top: -3px; right: -3px;
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--accent);
  border: 1.5px solid var(--surface-raised);
  animation: pipeSectionPulse 1.6s var(--ease-out) infinite;
}
.sidebar.collapsed .sidebar-progress { display: none; }
.sidebar.collapsed .sidebar-bottom { padding: 9px 6px 10px; align-items: center; }
.sidebar.collapsed .refresh-btn { width: 28px; min-height: 28px; padding: 0; font-size: 0; gap: 0; }
/* 步骤跑马灯：四段主流程进度条，当前段流动光效 */
.sidebar-progress {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 2px 2px 4px;
}
.sidebar-progress-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.sidebar-progress-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  font-weight: 700;
  color: var(--text-1);
}
.sidebar-progress-count {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-3);
}
.sidebar-progress-track {
  display: flex;
  gap: 4px;
}
.sidebar-progress-seg {
  position: relative;
  flex: 1;
  height: 5px;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: var(--overlay-track);
  cursor: pointer;
  overflow: hidden;
  transition: background 0.2s var(--ease-out), transform 0.15s var(--ease-out);
}
.sidebar-progress-seg:hover { transform: scaleY(1.6); }
.sidebar-progress-seg:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--button-focus);
}
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
@keyframes seg-marquee {
  from { background-position: 220% 0; }
  to { background-position: -220% 0; }
}
.sidebar-progress-labels {
  display: flex;
  gap: 4px;
}
.sidebar-progress-labels span {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: center;
  font-size: 10.5px;
  color: var(--text-3);
}
.sidebar-progress-labels span.done { color: var(--success); }
.sidebar-progress-labels span.on {
  color: var(--accent-text);
  font-weight: 700;
}
.refresh-btn {
  width: 100%; display: flex; align-items: center; justify-content: center; gap: 6px;
  min-height: 28px;
  padding: 0 10px; font-size: 12.5px; font-weight: 650; color: var(--button-text);
  background: var(--button-bg); border: 1px solid var(--button-border); border-radius: var(--button-radius);
  cursor: pointer; transition: all 0.18s var(--ease-out);
  box-shadow: var(--button-shadow);
}
.refresh-btn:hover {
  background: var(--button-bg-hover);
  border-color: var(--button-border-hover);
  color: var(--button-text-hover);
  box-shadow: var(--button-shadow-hover);
}
.refresh-btn:focus-visible {
  outline: none;
  border-color: var(--action-primary);
  box-shadow: 0 0 0 3px var(--button-focus), var(--button-shadow-hover);
}

/* ===== Main Content ===== */
.main { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-width: 0; min-height: 0; border-radius: var(--radius); }
.content-panel { flex: 1; display: flex; flex-direction: column; overflow: hidden; position: relative; min-height: 0; }
.stage-subnav {
  align-self: flex-start;
  margin: 4px 12px 0;
  max-width: calc(100% - 24px);
  overflow-x: auto;
  flex-shrink: 0;
}
.stage-subnav-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  /* 压过全局 .seg-item{padding:7px 16px}，收紧子导航高度 */
  padding: 4px 13px;
  font-size: 12px;
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
.stage-subnav-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--success);
}

/* Toolbar */
.step-toolbar {
  display: flex; align-items: center; gap: 10px;
  min-height: 44px;
  padding: 8px 12px; border-bottom: 1px solid var(--border);
  background: var(--surface-raised); flex-shrink: 0;
}
.prod-toolbar { background: var(--surface-raised); }
.toolbar-left { display: flex; align-items: center; gap: 8px; flex: 1; }
.toolbar-right { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.step-indicator { display: flex; align-items: center; gap: 8px; }
.step-num {
  width: 26px; height: 26px; border-radius: 10px;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--accent-bg);
  font-family: var(--font-mono); font-size: 10px; font-weight: 800; color: var(--accent-text); letter-spacing: 0.05em;
}
.step-name { font-size: 12.5px; font-weight: 700; color: var(--text-1); font-family: var(--font-display); }
.char-count { font-size: 11px; color: var(--text-3); font-family: var(--font-mono); }

/* Editor Area */
.step-editor { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.fill-textarea {
  flex: 1; border: none; border-radius: 0; padding: 26px 28px;
  font-size: 13.5px; line-height: 1.9; resize: none; outline: none;
  font-family: var(--font-body); background: var(--bg-input); color: var(--text-0);
}
.fill-textarea:focus { box-shadow: none; }

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
.step-empty-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: center; }

/* Step Loading */
.step-loading {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  flex: 1; gap: 12px;
}
.loading-text { font-size: 13px; color: var(--text-2); }
.detail-panel { flex: 1; display: flex; flex-direction: column; overflow-y: auto; min-width: 0; }
.detail-head { display: flex; align-items: center; gap: 8px; padding: 9px 14px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.detail-head-copy { display: flex; flex-direction: column; gap: 2px; }
.detail-head-title { font-size: 14px; font-weight: 700; color: var(--text-0); }
.detail-body { padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
.detail-hero {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(220px, 0.9fr);
  gap: 12px;
  padding: 12px;
  border-radius: var(--radius-lg);
  background: var(--surface-raised);
  border: 1px solid var(--border);
}
.detail-hero-copy { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.detail-hero-label {
  font-size: 10px; font-weight: 700; letter-spacing: 0.12em;
  text-transform: uppercase; color: var(--text-3);
}
.detail-hero-text { font-size: 13px; color: var(--text-1); line-height: 1.7; }
.detail-status-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.detail-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  border-radius: var(--radius-lg);
  background: var(--surface-raised);
  border: 1px solid var(--border);
}
.detail-section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.detail-section-title { font-size: 12px; font-weight: 700; color: var(--text-0); }
.detail-section-copy { font-size: 11px; color: var(--text-3); }

/* Field */
.field { display: flex; flex-direction: column; gap: 5px; }
.field-label { font-size: 12px; font-weight: 500; color: var(--text-1); }
.field-row { display: flex; gap: 12px; }
.field-grid { display: grid; gap: 12px; }
.field-grid-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.field-grid-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.locked-config {
  display: inline-flex;
  align-items: center;
  height: 30px;
  padding: 0 12px;
  border-radius: 999px;
  background: var(--surface-muted);
  border: 1px solid var(--surface-outline);
  color: var(--text-1);
  font-size: 11px;
  font-weight: 600;
}

/* Production tabs */
.prod-tabs { display: flex; gap: 4px; background: var(--bg-2); border-radius: var(--radius); padding: 2px; }
.prod-tab {
  display: flex; align-items: center; gap: 4px; min-height: 26px; padding: 0 10px; font-size: 11px;
  border: 1px solid transparent; background: transparent; color: var(--text-2); cursor: pointer;
  border-radius: calc(var(--radius) - 2px); transition: all 0.18s var(--ease-out); font-weight: 650;
  line-height: 1;
}
.prod-tab:hover { color: var(--text-0); background: var(--button-bg); border-color: var(--button-border); }
.prod-tab.active { background: var(--accent-bg); color: var(--accent-text); font-weight: 650; border-color: var(--accent-glow); box-shadow: none; }
.prod-tab:focus-visible {
  outline: none;
  border-color: var(--action-primary);
  box-shadow: 0 0 0 3px var(--button-focus), var(--button-shadow);
}
.prod-tab-badge { font-size: 10px; font-family: var(--font-mono); padding: 0 4px; background: var(--bg-3); border-radius: 99px; }
.prod-tab.active .prod-tab-badge { background: var(--accent-bg); color: var(--accent-text); }

/* Production content */
.prod-content { flex: 1; overflow-y: auto; padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 10px; }
.prod-section-bar { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }

/* 资产栏动作：提取（虚线中性）与批量生成（强调色）视觉分组 */
.asset-bar-actions { align-items: center; }
.asset-bar-divider { width: 1px; height: 16px; margin: 0 4px; background: var(--surface-outline-strong); }
.asset-extract-filter { flex-shrink: 0; }
/* 压过全局 .seg-item{padding:7px 16px}，与资产栏动作按钮同高收紧 */
.asset-extract-filter .seg-item { padding: 4px 12px; font-size: 12px; }
.asset-btn-extract {
  background: transparent;
  color: var(--text-2);
  box-shadow: none;
  border: 1px dashed var(--surface-outline-strong);
}
.asset-btn-extract:hover { background: var(--surface-muted); color: var(--text-1); }
.asset-btn-batch {
  background: var(--accent-bg);
  color: var(--accent-text);
  box-shadow: none;
}
.asset-btn-batch:hover { background: var(--accent); color: var(--on-accent); }

/* 资产分区标题：新增入口 + 卡片删除按钮 */
.asset-section-title { display: flex; align-items: center; gap: 8px; }
.asset-add-btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px dashed var(--surface-outline-strong);
  background: transparent;
  color: var(--text-3);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}
.asset-add-btn:hover { color: var(--accent-text); border-color: var(--accent-text); }
.character-asset-card, .asset-click-card { position: relative; }
.asset-del-btn {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 3;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 9px;
  border: none;
  border-radius: 999px;
  background: var(--action-danger);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
  box-shadow: 0 1px 5px rgba(0, 0, 0, 0.24);
  transition: filter 0.15s, transform 0.15s, box-shadow 0.15s;
}
.asset-del-btn:hover { filter: brightness(1.08); transform: translateY(-1px); }
.asset-del-btn:focus-visible { outline: none; box-shadow: 0 0 0 3.5px var(--button-focus); }
.shot-check.on { background: var(--accent); border-color: var(--accent); }

/* 新增资产弹窗 */
.asset-create-dialog { width: 440px; max-width: calc(100vw - 48px); }
.asset-create-body { display: flex; flex-direction: column; gap: 10px; }

/* 选角名册弹窗（纪录片）：草稿 / 已确认 / 过期三态一眼可辨 */
.roster-dialog { width: 560px; max-width: calc(100vw - 48px); }
.roster-body { display: flex; flex-direction: column; gap: 10px; max-height: 60vh; overflow-y: auto; }
.roster-status { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.roster-badge { font-size: 11px; padding: 1px 7px; border-radius: 10px; border: 1px solid var(--border); }
.roster-badge-draft { color: #b45309; border-color: #b45309; }
.roster-badge-approved { color: var(--accent); border-color: var(--accent); }
.roster-badge-stale { color: #b91c1c; border-color: #b91c1c; }
.roster-badge-none { color: var(--text-dim); }
.roster-updated { font-size: 11px; }
.roster-hint { font-size: 11px; line-height: 1.5; }
.roster-empty { font-size: 12px; color: var(--text-dim); padding: 10px 0; }
.roster-row { display: flex; flex-direction: column; gap: 5px; padding: 8px; border: 1px solid var(--border); border-radius: 8px; }
.roster-row-head { display: flex; align-items: center; gap: 6px; }
.roster-name { flex: 1; }
.roster-source { font-size: 10px; padding: 1px 6px; border-radius: 8px; border: 1px solid var(--border); white-space: nowrap; }
.roster-source-human { color: var(--accent); border-color: var(--accent); }
.roster-source-agent { color: var(--text-dim); }
.roster-add { align-self: flex-start; }

/* Asset grid */
.asset-section-title {
  margin-top: 2px;
  font-size: 12px;
  font-weight: 800;
  color: var(--text-1);
  letter-spacing: 0.04em;
}
.prop-name-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.prop-name-row .asset-name {
  min-width: 0;
}
.asset-props-empty {
  padding: 14px;
  border: 1px dashed var(--surface-outline);
  border-radius: var(--radius);
  color: var(--text-3);
  font-size: 12px;
  text-align: center;
}
.asset-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 12px; align-items: stretch; }
.character-asset-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 260px));
  justify-content: start;
  gap: 10px;
}
.asset-card {
  display: flex; flex-direction: column; overflow: hidden;
  transition: transform 0.18s var(--ease-out), box-shadow 0.18s var(--ease-out), border-color 0.18s var(--ease-out);
}
.asset-card:hover { transform: translateY(-2px); box-shadow: var(--shadow-lift); }
.asset-click-card,
.character-asset-card {
  cursor: pointer;
}
.asset-click-card:focus-visible,
.character-asset-card:focus-visible {
  outline: none;
  border-color: var(--accent-glow);
  box-shadow: 0 0 0 3px var(--button-focus), var(--shadow-panel);
}
.character-asset-card {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 0;
  transition: transform 0.18s var(--ease-out), box-shadow 0.18s var(--ease-out), border-color 0.18s var(--ease-out);
}
.character-asset-card:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-lift);
  border-color: var(--border-strong);
}
.character-portrait {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  align-self: start;
  margin: 0;
  border: 1px solid var(--surface-outline);
  border-radius: var(--radius);
  background: var(--bg-2);
  overflow: hidden;
}
.character-portrait img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.character-portrait-empty {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
}
.character-asset-main {
  min-width: 0;
  width: 100%;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.character-asset-overview {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.character-asset-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  /* 操作按钮（生成/上传/素材库）放不下时整体换行，而不是把名字挤成竖排 */
  flex-wrap: wrap;
}
.character-title-block {
  min-width: 0;
  flex: 1 1 150px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.character-name-row {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  flex-wrap: wrap;
}
.character-name {
  font-size: 13px;
  line-height: 1.25;
  color: var(--text-0);
}
.character-gen-btn { flex-shrink: 0; align-self: center; }
.studio-model-picks {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-right: 12px;
  padding-right: 12px;
  border-right: 1px solid var(--border);
  /* 顶栏变窄时整体收缩，选择器文字省略而不是把任务按钮挤出视口 */
  flex-shrink: 1;
  min-width: 0;
}
.studio-model-picks :deep(.model-select) { min-width: 0; flex-shrink: 1; }
.studio-model-picks :deep(.model-select-label) { flex-shrink: 0; }
.studio-model-picks :deep(.model-select-trigger) { min-width: 0; }
.asset-final-prompt {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-top: 7px;
  border-top: 1px solid var(--border);
  font-size: 10.5px;
  line-height: 1.5;
}
.asset-styling-version {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 7px;
  border-top: 1px solid var(--border);
  font-size: 10.5px;
}
.styling-version-thumb {
  width: 40px;
  height: 24px;
  object-fit: cover;
  border-radius: 3px;
  cursor: pointer;
}
.styling-version-text { display: flex; flex-direction: column; min-width: 0; }
.afp-label {
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.05em;
  color: var(--text-3);
}
.afp-text {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  word-break: break-word;
  color: var(--text-2);
}
.afp-text.dim { color: var(--text-3); }
.asset-final {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  word-break: break-word;
  color: var(--text-2);
}
.asset-final .afp-label { margin-right: 4px; }
.character-visual-summary {
  max-width: 100%;
  display: flex;
  gap: 8px;
  overflow: hidden;
  color: var(--text-3);
  font-size: 10.5px;
  line-height: 1.45;
  white-space: nowrap;
}
.character-visual-summary span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.asset-cover { position: relative; aspect-ratio: 1; background: var(--bg-2); overflow: hidden; }
.asset-cover.wide { aspect-ratio: 16/9; }
.asset-cover img { width: 100%; height: 100%; object-fit: cover; }
.previewable-image { cursor: zoom-in; transition: transform 0.18s var(--ease-out), filter 0.18s var(--ease-out); }
.previewable-image:hover { transform: scale(1.015); filter: saturate(1.04); }
.asset-cover-badge {
  position: absolute;
  top: 7px;
  left: 7px;
  display: inline-flex;
  align-items: center;
  padding: 2px 7px;
  border-radius: 999px;
  /* 背景与文字都取主题变量：深色主题下不再是白底浅字 */
  background: var(--header-bg);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  box-shadow: var(--shadow-xs);
  color: var(--text-1);
  font-size: 9.5px;
  font-weight: 700;
}
/* 媒体生成时间：压在封面右下角，与左上角的状态徽章对称 */
.asset-cover-time {
  position: absolute;
  right: 7px;
  bottom: 7px;
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--header-bg);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  box-shadow: var(--shadow-xs);
  color: var(--text-1);
  font-size: 9.5px;
  font-weight: 700;
}
/* 状态色只给文字与描边，背景始终是主题的半透明底色，压在任何封面上都可读 */
.asset-cover-badge.is-ready {
  box-shadow: var(--shadow-xs), inset 0 0 0 1px var(--success);
  color: var(--success);
}
.asset-cover-badge.is-pending {
  box-shadow: var(--shadow-xs), inset 0 0 0 1px var(--accent);
  color: var(--accent-text);
}
.asset-cover-empty { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: var(--text-3); }
.asset-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 9px 11px 8px;
  min-width: 0;
}
.asset-name {
  font-size: 13px;
  font-weight: 650;
  color: var(--text-0);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.asset-meta { font-size: 11px; line-height: 1.5; }
.asset-desc {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  word-break: break-word;
}
.asset-light {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.asset-foot { display: flex; align-items: center; gap: 4px; padding: 7px 11px; border-top: 1px solid var(--border); }
/* 图片生成队列汇总条 + 卡片进度环 */
.image-queue-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
  padding: 8px 11px;
  border: 1px solid var(--accent);
  border-radius: 8px;
  background: var(--bg-2);
  font-size: 12px;
  color: var(--text-2);
}
.image-queue-title { font-weight: 600; color: var(--text-1); }
.image-queue-sep { color: var(--text-3); }
.image-queue-eta { color: var(--accent); font-weight: 600; }
.image-queue-progress {
  flex: 1;
  min-width: 120px;
  height: 8px;
  border-radius: 4px;
  background: var(--bg-3, var(--bg-1));
  overflow: hidden;
}
.image-queue-progress-fill {
  display: block;
  height: 100%;
  border-radius: 4px;
  background: var(--accent);
  transition: width 0.6s linear;
}
.image-queue-percent { font-variant-numeric: tabular-nums; }
.asset-task-ring {
  display: flex;
  padding: 7px 11px;
  border-top: 1px solid var(--border);
}
/* Frame grid */
.frame-grid { display: flex; flex-direction: column; gap: 8px; }
.frame-row {
  display: flex; align-items: center; gap: 14px;
  padding: 12px 14px; cursor: pointer;
  border-radius: var(--radius-lg);
  transition: all 0.15s;
  border: 1.5px solid transparent;
}
.frame-row:hover { background: var(--bg-0); border-color: var(--border); }
.frame-row.active {
  background: var(--bg-0);
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-glow);
}
.frame-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.frame-top { display: flex; align-items: center; gap: 8px; }
.frame-num {
  font-size: 13px; font-family: var(--font-mono); font-weight: 800;
  color: var(--accent);
}
.frame-badge {
  font-size: 11px; font-weight: 600; padding: 2px 8px;
  border-radius: 20px;
  background: var(--accent-bg); color: var(--accent);
  border: 1px solid var(--accent-glow);
  white-space: nowrap;
}
.frame-desc {
  font-size: 12px; line-height: 1.5; color: var(--text-1);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden;
}
.frame-meta { display: flex; align-items: center; gap: 6px; }
.frame-thumbs { display: flex; gap: 8px; flex-shrink: 0; }
.frame-thumb-wrap { display: flex; flex-direction: column; gap: 3px; align-items: center; }
.frame-thumb-label { font-size: 10px; font-weight: 600; color: var(--text-3); }
.frame-thumb {
  position: relative; width: 130px; aspect-ratio: 16/9;
  border-radius: 6px; overflow: hidden;
  background: var(--bg-2); cursor: pointer;
  transition: all 0.15s; border: 1.5px solid var(--border);
}
.frame-thumb:hover { border-color: var(--accent); box-shadow: 0 2px 8px rgba(0,0,0,0.2); }
.frame-thumb img { width: 100%; height: 100%; object-fit: cover; }
.frame-thumb-empty { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: var(--text-3); }
.frame-re {
  position: absolute; top: 3px; right: 3px; width: 18px; height: 18px;
  border-radius: 50%; background: rgba(0,0,0,0.5); color: #fff;
  display: none; align-items: center; justify-content: center;
}
.frame-thumb:hover .frame-re { display: flex; }
.frame-scroll { flex: 1; overflow-y: auto; padding: 10px 12px; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--bg-3); flex-shrink: 0; }
.dot.ok { background: var(--success); }
.dot.pending {
  background: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-glow);
}
:global(body.is-video-col-dragging) { cursor: col-resize; user-select: none; }
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
/* 生成前生效配置小结 */
.video-inspector-effective {
  margin: 0;
  padding: 4px 8px;
  border: 1px solid var(--accent-glow);
  border-radius: var(--radius);
  background: var(--accent-bg);
  color: var(--accent-text);
  font-family: var(--font-mono);
  font-size: 10.5px;
  font-weight: 600;
  line-height: 1.4;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 批量生成确认弹窗 */
.batch-video-dialog { width: 520px; max-width: calc(100vw - 48px); }
.batch-video-body { display: flex; flex-direction: column; gap: 10px; }
.batch-video-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
  color: var(--text-2);
  padding: 8px 12px;
  border: 1px solid var(--surface-outline);
  border-radius: var(--radius);
  background: var(--bg-input);
}
.batch-video-row strong { color: var(--text-0); font-weight: 600; }
.batch-video-note { margin: 4px 0 0; font-size: 11px; color: var(--text-3); line-height: 1.6; }
.batch-video-loading { font-size: 13px; color: var(--text-2); padding: 18px 0; text-align: center; }
.batch-video-actions { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.batch-video-list {
  display: flex; flex-direction: column; gap: 2px;
  /* 矮窗口下也要看得见清单：不被同列的摘要行挤扁 */
  flex: 1 1 auto; min-height: 132px; max-height: 320px; overflow-y: auto;
  border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 8px;
}
.batch-video-item {
  display: flex; align-items: center; gap: 8px;
  padding: 4px 6px; border-radius: var(--radius-sm);
  font-size: 12px; color: var(--text-1); cursor: pointer;
}
.batch-video-item:hover { background: var(--bg-hover); }
.batch-video-item.disabled { cursor: default; color: var(--text-3); }
.batch-video-item-shot { min-width: 34px; font-family: var(--font-mono); }
.batch-video-item-status { color: var(--text-2); white-space: nowrap; }
.batch-video-item.is-blocked .batch-video-item-status { color: var(--action-danger); }
.batch-video-item.is-unchanged .batch-video-item-status,
.batch-video-item.is-deterministic .batch-video-item-status,
.batch-video-item.is-unknown .batch-video-item-status { color: var(--text-3); }
.batch-video-item-reason { flex: 1; min-width: 0; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.batch-video-empty { font-size: 12px; color: var(--text-3); text-align: center; padding: 12px 0; }
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
.video-inspector-head {
  min-height: 56px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--surface-outline);
}
.video-inspector-title { color: var(--text-0); font-size: 14px; font-weight: 700; }
.video-inspector-sub { margin-top: 2px; color: var(--text-3); font-size: 11px; }
.video-inspector-params { display: grid; gap: 8px; }
.video-inspector-params div { display: flex; justify-content: space-between; gap: 12px; font-size: 12px; }
.video-inspector-params dt { color: var(--text-3); }
.video-inspector-params dd { margin: 0; color: var(--text-1); text-align: right; }
.video-param-value { color: var(--text-1); text-align: right; font-size: 11px; }
.video-batch-banner.is-running { border-color: var(--accent-glow); }

/* 资产批量生成（#33）横幅：与视频批量横幅同一套外观 */
.asset-batch-banner {
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
.asset-batch-banner.is-running { border-color: var(--accent-glow); }
.asset-batch-state { font-weight: 700; }
.asset-batch-sep { color: var(--text-3); }

/* Prod grid */
.prod-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 12px; }
.prod-card {
  display: flex; flex-direction: column; overflow: hidden;
  transition: transform 0.18s var(--ease-out), box-shadow 0.18s var(--ease-out), border-color 0.18s var(--ease-out);
  border-radius: 20px;
  background: var(--surface-raised);
  border: 1px solid var(--surface-outline);
}
.prod-card:hover { transform: translateY(-2px); box-shadow: var(--shadow-lift); }
.prod-cover { position: relative; aspect-ratio: 16/9; background: var(--bg-2); overflow: hidden; }
.prod-cover img { width: 100%; height: 100%; object-fit: cover; }
.prod-video { width: 100%; height: 100%; object-fit: cover; background: #000; display: block; }
.prod-cover-empty { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: var(--text-3); }
.prod-idx {
  position: absolute; top: 5px; left: 5px; font-size: 10px; font-weight: 700;
  font-family: var(--font-mono); background: rgba(0,0,0,0.5); color: #fff; padding: 1px 5px; border-radius: 3px;
}
.prod-overlay-badge {
  position: absolute; bottom: 5px; right: 5px; font-size: 10px; font-weight: 600;
  background: var(--success); color: var(--on-accent); padding: 1px 5px; border-radius: 3px;
}
.prod-info { padding: 10px 12px 8px; }
.prod-desc { font-size: 12px; line-height: 1.4; }
.prod-meta-line { margin-top: 5px; font-size: 10px; color: var(--text-3); }
.prod-dots { display: flex; align-items: center; gap: 4px; margin-top: 5px; color: var(--text-3); }
.prod-error {
  margin-top: 6px;
  font-size: 11px;
  line-height: 1.45;
  color: var(--error);
}
.prod-actions { display: flex; gap: 6px; padding: 8px 10px 10px; border-top: 1px solid var(--surface-outline); }
.prod-actions .btn { flex: 1; justify-content: center; }

/* Asset detail dialog */
.asset-detail-overlay {
  z-index: 118;
  padding: 28px;
}
.asset-detail-dialog {
  width: min(1040px, calc(100vw - 56px));
  max-height: calc(100vh - 56px);
}
.asset-detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--surface-outline);
}
.asset-detail-title-block {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.asset-detail-kicker {
  color: var(--text-3);
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.asset-detail-title {
  margin: 0;
  color: var(--text-0);
  font-size: 18px;
  line-height: 1.2;
  font-family: var(--font-display);
}
.asset-detail-head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.asset-detail-body {
  min-height: 0;
  overflow: auto;
  padding: 16px;
}
.asset-detail-shell {
  display: grid;
  grid-template-columns: minmax(280px, 380px) minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}
.asset-detail-preview-panel,
.asset-detail-editor-panel {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.asset-detail-preview-panel {
  position: sticky;
  top: 0;
}
.asset-detail-section-title {
  min-height: 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  color: var(--text-1);
  font-size: 12px;
  font-weight: 820;
  letter-spacing: 0.02em;
}
.asset-detail-section-title .dim {
  font-size: 11px;
  font-weight: 560;
  letter-spacing: 0;
  text-align: right;
}
.asset-detail-state {
  min-height: 20px;
  display: inline-flex;
  align-items: center;
  padding: 0 7px;
  border-radius: 999px;
  background: var(--overlay-track);
  color: var(--text-3);
  font-size: 10px;
  font-weight: 760;
  white-space: nowrap;
}
.asset-detail-state.is-ready {
  color: var(--success);
  background: var(--success-bg);
}
.asset-detail-media-frame {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  display: block;
  padding: 0;
  border: 1px solid var(--surface-outline);
  border-radius: var(--radius);
  background: var(--bg-2);
  color: var(--text-3);
  overflow: hidden;
  cursor: zoom-in;
}
.asset-detail-media-frame:disabled {
  cursor: default;
  opacity: 1;
}
.asset-detail-media-frame:focus-visible {
  outline: none;
  border-color: var(--action-primary);
  box-shadow: 0 0 0 3px var(--button-focus);
}
.asset-detail-media-frame img {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
}
.asset-version-panel {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.asset-version-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--text-2);
  font-size: 11px;
}
.asset-version-head span { color: var(--text-3); font-size: 10px; }
.asset-version-list {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
}
.asset-version-card {
  position: relative;
  min-width: 0;
  aspect-ratio: 1;
  overflow: hidden;
  padding: 0;
  border: 1.5px solid var(--surface-outline);
  border-radius: var(--radius-sm);
  background: var(--bg-2);
  cursor: pointer;
}
.asset-version-card.current { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-glow); }
.asset-version-card img { width: 100%; height: 100%; display: block; object-fit: cover; }
.asset-version-meta {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  overflow: hidden;
  padding: 3px 4px;
  background: rgba(0,0,0,0.64);
  color: #fff;
  font-size: 8px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.asset-version-current {
  position: absolute;
  top: 3px;
  right: 3px;
  padding: 1px 4px;
  border-radius: 999px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 8px;
  font-weight: 700;
}
.asset-version-hint { margin: 0; color: var(--text-3); font-size: 10px; line-height: 1.45; }
.asset-detail-media-empty {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
}
.asset-detail-desc {
  margin: 0;
  color: var(--text-1);
  font-size: 13px;
  line-height: 1.7;
}
.asset-detail-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}
.asset-detail-field {
  min-width: 0;
  padding: 9px 10px;
  border: 1px solid var(--surface-outline);
  border-radius: var(--radius);
  background: var(--surface-muted);
}
.asset-detail-field span,
.asset-detail-edit-field span,
.asset-detail-text-block span,
.asset-detail-shot-head {
  display: block;
  color: var(--text-3);
  font-size: 10px;
  font-weight: 780;
  letter-spacing: 0.04em;
}
.asset-detail-field strong {
  display: block;
  margin-top: 5px;
  min-width: 0;
  overflow: hidden;
  color: var(--text-0);
  font-size: 12px;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.asset-detail-text-block {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.asset-detail-edit-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
/* 单字段分组（角色/场景/道具）：整列占满宽度，不留半宽空白 */
.asset-detail-edit-grid--character,
.asset-detail-edit-grid--scene,
.asset-detail-edit-grid--prop {
  grid-template-columns: 1fr;
}
/* 场景时间：常用时段下拉 + 自填输入 */
.asset-detail-time-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.asset-detail-time-label { font-size: 12px; font-weight: 600; color: var(--text-1); flex: none; }
.asset-detail-time-select { width: 140px; flex: none; }
.asset-detail-time-input { flex: 1; min-width: 160px; }
.asset-detail-time-hint { font-size: 11px; flex: none; }
.asset-detail-edit-field {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.asset-detail-textarea {
  min-height: 138px;
  resize: vertical;
}
.asset-detail-edit-grid--character .asset-detail-textarea,
.asset-detail-edit-grid--scene .asset-detail-textarea {
  min-height: 164px;
}
.asset-detail-meta-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.asset-detail-meta-item {
  min-width: 0;
  padding: 9px 10px;
  border: 1px solid var(--surface-outline);
  border-radius: var(--radius);
  background: var(--surface-muted);
}
.asset-detail-meta-item span {
  display: block;
  color: var(--text-3);
  font-size: 10px;
  font-weight: 780;
  letter-spacing: 0.04em;
}
.asset-detail-meta-item strong {
  display: block;
  margin-top: 4px;
  min-width: 0;
  color: var(--text-0);
  font-size: 12px;
  line-height: 1.35;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.asset-detail-text-block > div,
.asset-detail-shot-list {
  padding: 10px;
  border: 1px solid var(--surface-outline);
  border-radius: var(--radius);
  background: var(--surface-muted);
}
.asset-detail-text-block p {
  margin: 5px 0 0;
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.55;
}
.asset-detail-shot-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.asset-detail-shot-items {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.asset-detail-shot-row {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  color: var(--text-2);
  font-size: 11px;
}
.asset-detail-shot-row strong {
  min-width: 0;
  overflow: hidden;
  color: var(--text-1);
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.asset-detail-shot-row small,
.asset-detail-empty {
  color: var(--text-3);
  font-size: 11px;
}
.asset-detail-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--surface-outline);
}
.asset-detail-secondary-actions,
.asset-detail-primary-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.asset-detail-prompt-panel {
  min-width: 0;
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--surface-outline);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
/* 弹窗内参考图区：大号卡片网格，横跨整个弹窗宽度 */
.asset-detail-ref-panel {
  min-width: 0;
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--surface-outline);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.asset-detail-ref-panel :deep(.ref-images) { border-top: 0; padding-top: 0; }
/* 证据素材（Issue #47）：卡片徽标与弹窗开关 */
.asset-faithful-tag {
  background: var(--warn-bg);
  border-color: var(--warn-border);
  color: var(--warn-text);
}
.asset-faithful-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--text-1);
  cursor: pointer;
}
.asset-faithful-hint {
  margin: 0;
  font-size: 10.5px;
}
.asset-detail-prompt-head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.asset-detail-copy-btn {
  gap: 5px;
}
.asset-detail-prompt-textarea {
  min-height: 96px;
  max-height: 260px;
  overflow: auto;
  padding: 12px 14px;
  border: 1px solid var(--surface-outline);
  border-radius: var(--radius);
  background: var(--surface-muted);
  color: var(--text-1);
  font-size: 12px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
  resize: vertical;
  width: 100%;
}
.asset-detail-prompt-hint {
  margin: 0;
  color: var(--text-3);
  font-size: 11px;
  line-height: 1.5;
}
.asset-detail-readonly-grid {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.asset-detail-readonly {
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid var(--surface-outline);
  border-radius: var(--radius);
  background: var(--surface-muted);
}
.asset-detail-readonly span {
  display: block;
  color: var(--text-3);
  font-size: 10px;
  font-weight: 780;
  letter-spacing: 0.04em;
}
.asset-detail-readonly p {
  margin: 6px 0 0;
  color: var(--text-1);
  font-size: 12px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
}
.asset-detail-readonly p.dim {
  color: var(--text-3);
}

/* Image viewer */
.image-viewer-overlay {
  z-index: 120;
  padding: 28px;
}
.image-viewer-dialog {
  width: min(1100px, calc(100vw - 56px));
  max-height: calc(100vh - 56px);
  background: var(--header-bg);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
}
.image-viewer-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 18px;
  border-bottom: 1px solid var(--surface-outline);
}
.image-viewer-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-1);
  font-family: var(--font-display);
}
.image-viewer-body {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  overflow: auto;
  min-height: 0;
}
.image-viewer-img {
  display: block;
  max-width: 100%;
  max-height: calc(100vh - 140px);
  border-radius: 18px;
  box-shadow: var(--shadow-xl);
  background: var(--surface-muted);
}
.merge-card-meta .btn { margin-left: auto; }
.merge-card-meta .btn + .btn { margin-left: 0; }
.merge-viewer-dialog { width: min(1080px, calc(100vw - 56px)); }
.merge-viewer-body {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 18px;
  min-height: 0;
}
.merge-viewer-video {
  width: 100%;
  max-height: calc(100vh - 220px);
  border-radius: var(--radius);
  background: #000;
  display: block;
}
.exp-check.on { background: var(--accent); border-color: var(--accent); }
/* 导出完成手动标记按钮 */
.export-done-btn.on {
  background: var(--success-bg, var(--accent-bg));
  color: var(--success, var(--accent-text));
  border-color: transparent;
  font-weight: 600;
}
/* 拼接确认弹窗（#42） */
.merge-confirm-dialog { width: 520px; max-width: calc(100vw - 48px); }
.merge-confirm-body { display: flex; flex-direction: column; gap: 10px; }
.merge-confirm-line { margin: 0; font-size: 12px; color: var(--text-1); }
.merge-confirm-group { display: flex; flex-direction: column; gap: 3px; }
.merge-confirm-label { font-size: 12px; font-weight: 600; color: var(--text-1); }
.merge-confirm-shots {
  font-size: 11px;
  color: var(--text-2);
  max-height: 110px;
  overflow-y: auto;
  font-variant-numeric: tabular-nums;
  word-break: break-word;
}
.merge-confirm-note { margin: 0; font-size: 11px; color: var(--text-3); }

/* Shared */
.dim { color: var(--text-3); }

/* 窄视口不再收缩：工作台 min-width 1280px，比它更窄时由外层横向滚动（页面尺寸规格见 AGENTS.md） */
</style>
