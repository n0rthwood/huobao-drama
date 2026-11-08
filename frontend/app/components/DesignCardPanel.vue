<template>
  <!-- 门禁：分镜设计未解锁时只给原因与出路，绝不渲染设计卡内容 -->
  <div v-if="designLocked" class="step-empty" style="flex:1">
    <div class="empty-visual"><Lock :size="32" /></div>
    <div class="empty-title">{{ t('episode.design.lockedTitle') }}</div>
    <div class="empty-desc">{{ t('episode.design.lockedDesc', { reason: lockReason }) }}</div>
    <button class="btn btn-primary" @click="gotoBlocker">{{ t('episode.design.lockedGoto') }}</button>
  </div>

  <template v-else>
    <!-- 分镜设计的三个子阶段（#70）：骨架 → 配音 → 设计卡；顶层仍是同一个「分镜设计」步 -->
    <div class="dc-phases" role="tablist" :aria-label="t('episode.skeleton.phaseLabel')">
      <button
        v-for="(item, index) in phases"
        :key="item.key"
        type="button"
        role="tab"
        :class="['dc-phase', { on: phase === item.key }]"
        :aria-selected="phase === item.key"
        @click="setPhase(item.key)"
      >
        <span class="mono dc-phase-num">{{ index + 1 }}</span>
        <span class="dc-phase-name">{{ item.label }}</span>
        <span class="dc-phase-state">{{ item.state }}</span>
      </button>
    </div>

    <NarrationCoverageBar
      v-if="phase === 'skeleton'"
      :episode-id="episodeId"
      :chat-model="chatModel"
      :chat-config-id="chatConfigId"
      @refresh="emit('refresh')"
    />

    <NarrationSkeletonPanel
      v-if="phase !== 'cards'"
      :episode-id="episodeId"
      :phase="phase"
      :skeleton="skeleton"
      :chat-model="chatModel"
      :chat-config-id="chatConfigId"
      :voice-batch="narrationVoiceBatch"
      @update="applySkeleton"
      @refresh="onSkeletonRefresh"
      @voice-batch="ids => emit('batch-narration-voice', ids)"
    />

    <div v-else class="prod-content dc-step">
      <p v-if="!skeleton.confirmed" class="dc-block">
        {{ t('episode.skeleton.cardsNeedConfirm') }}
        <button class="btn btn-sm" @click="setPhase('skeleton')">{{ t('episode.skeleton.gotoSkeleton') }}</button>
      </p>
      <p v-else-if="skeleton.tts.invalid" class="dc-block">
        {{ t('episode.skeleton.cardsBlockedByTts', { n: skeleton.tts.invalid }) }}
        <button class="btn btn-sm" @click="setPhase('voice')">{{ t('episode.skeleton.gotoVoice') }}</button>
      </p>
      <p v-if="batchTtsBlocked.length" class="dc-block">
        {{ t('episode.skeleton.batchExcluded', { n: batchTtsBlocked.length }) }}
        <span class="mono dim">{{ batchTtsBlocked.map(item => '#' + pad(item.storyboard_number)).join(' ') }}</span>
        <button class="btn btn-sm" @click="setPhase('voice')">{{ t('episode.skeleton.gotoVoice') }}</button>
      </p>

      <div class="dc-bar">
        <span class="dim" style="font-size:12px">{{ t('episode.design.title') }}</span>
        <span class="tag mono">{{ t('episode.design.summary', counts) }}</span>
        <span class="tag mono">{{ t('episode.skeleton.fillableCount', { n: fillableIds.length, total: shots.length }) }}</span>
        <span v-if="batch.running" class="tag mono dc-tag-run">
          <Loader2 :size="11" class="animate-spin" />
          {{ t('episode.design.fill.progress', { done: batch.completed, total: batch.total }) }}
        </span>
        <TaskWorkMetrics :summary="fillSummary" :estimate="fillEstimate" dense />
        <span class="ml-auto" />
        <!-- 模型选择（#87 §B）：默认「自动」由后端挑健康视觉配置；顶栏残留的选择不冒充本次显式指定 -->
        <select v-model="modelMode" class="input dc-select dc-model-mode" :aria-label="t('workMetrics.modelMode')">
          <option value="auto">{{ t('workMetrics.modelAuto') }}</option>
          <option value="pinned" :disabled="!chatConfigId">{{ t('workMetrics.modelPinned', { name: chatModel || t('workMetrics.modelTopbar') }) }}</option>
        </select>
        <button
          class="btn btn-sm"
          :disabled="batch.running || !fillableIds.length || !skeleton.confirmed"
          :title="cardsBlockReason"
          @click="openScope('fill')"
        >
          <Sparkles :size="11" />
          {{ t('episode.design.batch.fillAll') }}
        </button>
        <button
          class="btn btn-sm"
          :disabled="batch.running || !fillableIds.length || !skeleton.confirmed"
          :title="cardsBlockReason"
          @click="openScope('confirm')"
        >
          {{ t('episode.design.batch.confirmAll') }}
        </button>
      </div>

      <!-- 模型选择失败（#87 §B）：指名原因，并给可用配置的一键重填入口，不静默换计费服务 -->
      <div v-if="pinError" class="dc-pin-error">
        <p>{{ pinError.message }}</p>
        <div class="dc-pin-actions">
          <button
            v-for="alt in pinError.alternatives"
            :key="alt.config_id"
            class="btn btn-sm btn-primary"
            @click="retryWithConfig(alt)"
          >{{ t('workMetrics.retryWith', { name: alt.name }) }}</button>
          <button class="btn btn-sm" @click="pinError = null">{{ t('episode.design.batch.cancel') }}</button>
        </div>
      </div>

      <div v-if="!shots.length" class="step-empty" style="flex:1">
        <div class="empty-title">{{ t('episode.design.empty.noShots') }}</div>
      </div>

      <div v-else class="dc-body">
        <!-- 左：镜列表（镜号 + 组合象形 + 状态点），支持拖拽与上下移动排序 -->
        <section class="dc-list" :aria-label="t('episode.design.order.hint')">
          <button
            v-for="(sb, index) in shots"
            :key="sb.id"
            type="button"
            :class="['dc-shot', { on: sb.id === selectedId }]"
            :aria-pressed="sb.id === selectedId"
            draggable="true"
            @click="selectedId = sb.id"
            @dragstart="onDragStart(sb)"
            @dragover.prevent
            @drop.prevent="onDrop(index)"
            @dragend="dragId = 0"
          >
            <span class="dc-shot-no mono">{{ shotLabel(sb) }}</span>
            <span class="dc-shot-combo mono" :title="comboTitle(stateOf(sb).combo)">{{ comboGlyph(stateOf(sb).combo) }}</span>
            <span :class="['dc-dot', 'is-' + stateOf(sb).design_card_status]" :title="t(`episode.design.status.${stateOf(sb).design_card_status}`)" />
            <span
              :class="['dc-tts-dot', ttsOf(sb.id).valid ? 'is-ok' : 'is-bad']"
              :title="ttsTitle(sb.id)"
            >{{ ttsOf(sb.id).valid ? '♪' : '✕' }}</span>
            <span class="dc-shot-grip">
              <span
                class="dc-move"
                role="button"
                tabindex="0"
                :aria-label="t('episode.design.order.up')"
                :title="t('episode.design.order.up')"
                @click.stop="move(index, -1)"
                @keydown.enter.stop.prevent="move(index, -1)"
              ><ChevronUp :size="11" /></span>
              <span
                class="dc-move"
                role="button"
                tabindex="0"
                :aria-label="t('episode.design.order.down')"
                :title="t('episode.design.order.down')"
                @click.stop="move(index, 1)"
                @keydown.enter.stop.prevent="move(index, 1)"
              ><ChevronDown :size="11" /></span>
            </span>
          </button>
        </section>

        <!-- 右：选中镜的设计卡 -->
        <section v-if="!selected" class="dc-card dc-card-empty">{{ t('episode.design.empty.selectShot') }}</section>
        <section v-else class="dc-card">
          <header class="dc-card-head">
            <strong>{{ shotLabel(selected) }}</strong>
            <span :class="['dc-state', 'is-' + current.design_card_status]">
              {{ t(`episode.design.status.${current.design_card_status}`) }}
            </span>
            <span :class="['dc-tts', ttsOf(selected.id).valid ? 'is-ok' : 'is-bad']">{{ ttsTitle(selected.id) }}</span>
            <span v-if="current.design_card_stale_reason" class="dc-stale" :title="current.design_card_stale_reason">
              {{ current.design_card_stale_reason === 'migration_combo_unresolved'
                ? t('episode.design.migrationComboUnresolvedShort')
                : current.design_card_stale_reason === 'migrated_from_intent'
                  ? t('episode.design.migratedFromIntent')
                  : current.design_card_stale_reason }}
            </span>
            <span v-if="saveState" class="dim" style="font-size:11px">{{ saveState }}</span>
            <span class="ml-auto" />
            <button
              class="btn btn-sm"
              :disabled="batch.running || busy || !ttsOf(selected.id).valid"
              :title="ttsOf(selected.id).valid ? '' : ttsTitle(selected.id)"
              @click="refillOne"
            >
              <Loader2 v-if="batch.running" :size="11" class="animate-spin" />
              {{ batch.running ? t('episode.design.actions.refilling') : t('episode.design.actions.refill') }}
            </button>
            <button
              v-if="current.design_card_status === 'confirmed'"
              class="btn btn-sm"
              :disabled="busy"
              @click="unconfirm"
            >{{ t('episode.design.actions.unconfirm') }}</button>
            <button
              v-else
              class="btn btn-sm btn-primary"
              :disabled="busy || !canConfirm"
              :title="confirmBlockReason"
              @click="confirm"
            >{{ t('episode.design.actions.confirm') }}</button>
          </header>

          <!-- 叙事 -->
          <div class="dc-section">
            <div class="dc-section-head">
              <span class="dc-section-title">{{ t('episode.design.section.narrative') }}</span>
              <span class="dc-affect" :title="t('episode.design.affectsTip.narrative')">{{ t('episode.design.affects.narrative') }}</span>
            </div>
            <div class="dc-field">
              <span class="dc-label">{{ t('episode.design.field.narration') }}</span>
              <p class="dc-read">{{ current.narration_text || t('episode.design.narrationEmpty') }}</p>
            </div>

            <div class="dc-field">
              <span class="dc-label">
                {{ t('episode.design.field.infoPoints') }}
                <span class="dc-affect" :title="t('episode.design.affectsTip.infoPoints')">{{ t('episode.design.affects.infoPoints') }}</span>
              </span>
              <div class="dc-chips">
                <span v-for="(point, index) in draft.info_points" :key="point.id || index" class="dc-chip">
                  <span class="dc-chip-text">{{ point.text }}</span>
                  <select
                    class="input dc-chip-select"
                    :value="point.via"
                    :aria-label="t('episode.design.field.infoPoints')"
                    @change="setInfoVia(index, $event.target.value)"
                  >
                    <option v-for="via in ctx.info_point_vias" :key="via" :value="via">{{ t(`episode.design.via.${via}`) }}</option>
                  </select>
                  <button
                    type="button"
                    class="dc-chip-del"
                    :aria-label="t('episode.design.actions.remove')"
                    @click="removeInfoPoint(index)"
                  >×</button>
                </span>
                <span class="dc-chip-add">
                  <input
                    class="input dc-chip-input"
                    type="text"
                    :value="infoDraft"
                    :placeholder="t('episode.design.field.infoPoints')"
                    @input="infoDraft = $event.target.value"
                    @keydown.enter.prevent="addInfoPoint"
                  >
                  <button type="button" class="btn btn-sm" :disabled="!infoDraft.trim()" @click="addInfoPoint">
                    {{ t('episode.design.actions.add') }}
                  </button>
                </span>
              </div>
            </div>

            <div class="dc-field">
              <span class="dc-label">
                {{ t('episode.design.field.neighbors') }}
                <span class="dc-affect" :title="t('episode.design.affectsTip.neighbors')">{{ t('episode.design.affects.neighbors') }}</span>
              </span>
              <p class="dc-read dim">
                {{ t('episode.design.prevShot') }}: {{ neighborText(-1) }} ｜ {{ t('episode.design.nextShot') }}: {{ neighborText(1) }}
              </p>
            </div>
          </div>

          <!-- 结构：段组合 + 时长预算 -->
          <div class="dc-section">
            <div class="dc-section-head">
              <span class="dc-section-title">{{ t('episode.design.section.structure') }}</span>
              <span class="dc-affect" :title="t('episode.design.affectsTip.combo')">{{ t('episode.design.affects.combo') }}</span>
            </div>
            <p class="dc-hint">{{ t('episode.design.combo.required') }}</p>
            <div class="dc-combos">
              <button
                v-for="key in COMBOS"
                :key="key"
                type="button"
                :class="['dc-combo', { on: draft.combo === key }]"
                :aria-pressed="draft.combo === key"
                @click="pickCombo(key)"
              >
                <span class="dc-combo-icons">
                  <Layers v-if="key !== 'B'" :size="14" />
                  <Sparkles v-if="key !== 'A'" :size="14" />
                  <span v-if="suggestedCombo === key" class="dc-combo-sug">{{ t('episode.design.combo.suggested') }}</span>
                </span>
                <span class="dc-combo-name">{{ t(`episode.design.combo.${key}.name`) }}</span>
                <span class="dc-combo-desc">{{ t(`episode.design.combo.${key}.desc`) }}</span>
              </button>
            </div>

            <div class="dc-field">
              <span class="dc-label">
                {{ totalSeconds === null ? t('episode.design.budget.totalMissing') : t('episode.design.budget.total', { n: totalSeconds.toFixed(1) }) }}
                <span class="dc-affect" :title="t('episode.design.affectsTip.budget')">{{ t('episode.design.affects.budget') }}</span>
              </span>
              <div class="dc-budget">
                <label v-if="hasLayer" class="dc-budget-num">
                  <span class="dim">{{ t('episode.design.budget.layerSegment') }}</span>
                  <input
                    class="input dc-num" type="number" min="0" :max="ctx.limits.layer_s" step="0.5"
                    :value="layerSeconds"
                    @change="setSeconds('layer_s', $event.target.value)"
                  >
                </label>
                <label v-if="hasGen" class="dc-budget-num">
                  <span class="dim">{{ t('episode.design.budget.genSegment') }}</span>
                  <input
                    class="input dc-num" type="number" min="0" :max="ctx.limits.gen_s" step="0.5"
                    :value="genSeconds"
                    @change="setSeconds('gen_s', $event.target.value)"
                  >
                </label>
                <span class="dim dc-budget-limit">
                  {{ t('episode.design.budget.limitLayer', { n: ctx.limits.layer_s }) }} ·
                  {{ t('episode.design.budget.limitGen', { n: ctx.limits.gen_s }) }}
                </span>
              </div>

              <p v-if="budgetMessage" class="dc-hint">{{ budgetMessage }}</p>
              <div v-if="budgetPositive" ref="barEl" class="dc-bar-track">
                <span v-if="hasLayer" class="dc-seg is-layer" :style="{ width: layerPct + '%' }">
                  <span v-if="layerOverPct > 0" class="dc-seg-over" :style="{ width: layerOverPct + '%' }" />
                  <span
                    class="dc-seg-tick"
                    :class="{ 'is-over': layerOverPct > 0 }"
                    :style="{ left: tickLeft(layerSeconds, ctx.limits.layer_s) + '%' }"
                    :title="t('episode.design.budget.limitLayer', { n: ctx.limits.layer_s })"
                  />
                  <span class="dc-seg-text mono">{{ layerSeconds.toFixed(1) }}s</span>
                </span>
                <span
                  v-if="hasLayer && hasGen"
                  class="dc-divider"
                  role="separator"
                  :aria-label="t('episode.design.budget.total', { n: totalSeconds.toFixed(1) })"
                  @pointerdown="startDrag"
                >◆</span>
                <span v-if="hasGen" class="dc-seg is-gen" :style="{ width: genPct + '%' }">
                  <span v-if="genOverPct > 0" class="dc-seg-over" :style="{ width: genOverPct + '%' }" />
                  <span
                    class="dc-seg-tick"
                    :class="{ 'is-over': genOverPct > 0 }"
                    :style="{ left: tickLeft(genSeconds, ctx.limits.gen_s) + '%' }"
                    :title="t('episode.design.budget.limitGen', { n: ctx.limits.gen_s })"
                  />
                  <span class="dc-seg-text mono">{{ genSeconds.toFixed(1) }}s</span>
                </span>
              </div>

              <p class="dc-hint mono">
                {{ t('designCard82.narration') }}: {{ measuredSeconds === null ? t('designCard82.pendingVoice') : `${measuredSeconds.toFixed(1)}s` }}
                <template v-if="hasLayer"> · {{ t('designCard82.layerBudget') }}: {{ layerSeconds === null ? '—' : `${layerSeconds.toFixed(1)}s` }}</template>
                <template v-if="hasGen"> · {{ t('designCard82.genBudget') }}: {{ genSeconds === null ? '—' : `${genSeconds.toFixed(1)}s` }}<template v-if="!auditById[selected.id]?.video_generated"> ({{ t('designCard82.notGenerated') }})</template></template>
                · {{ t('designCard82.total') }}: {{ totalSeconds === null ? '—' : `${totalSeconds.toFixed(1)}s` }}
                <template v-if="headroom !== null"> · {{ t(headroom < 0 ? 'designCard82.excess' : 'designCard82.remain') }}: {{ Math.abs(headroom).toFixed(1) }}s</template>
              </p>
              <!-- 旁白时长只认实测（#70）：没有当前有效配音就显示待配音，绝不显示估算 -->
              <div class="dc-narr-line">
                <span v-if="budgetPositive && measuredSeconds !== null" :class="['dc-narr-fill', narrationClass]" :style="{ width: narrationPct + '%' }" />
                <span class="dc-narr-text mono">
                  <template v-if="measuredSeconds === null">{{ ttsTitle(selected.id) }}</template>
                  <template v-else>
                    {{ t('episode.design.budget.measured', { n: measuredSeconds.toFixed(1) }) }}
                    <template v-if="!budgetPositive"> · {{ t('episode.design.budget.headroomMissing') }}</template>
                    <template v-else-if="narrationClass === 'is-over'"> · {{ t('episode.design.budget.over') }}</template>
                    <template v-else-if="narrationClass === 'is-tight'"> · {{ t('episode.design.budget.tight') }}</template>
                    <template v-else> · {{ t('episode.design.budget.remain', { n: headroom.toFixed(1) }) }}</template>
                  </template>
                </span>
              </div>
            </div>
          </div>

          <!-- 图层段计划（B 组合没有图层段） -->
          <div v-if="draft.combo !== 'B'" class="dc-section">
            <div class="dc-section-head">
              <span class="dc-section-title">{{ t('episode.design.section.layerPlan') }}</span>
              <span class="dc-affect" :title="t('episode.design.affectsTip.plannedLayers')">{{ t('episode.design.affects.plannedLayers') }}</span>
            </div>

            <div class="dc-field">
              <span class="dc-label">
                {{ t('episode.design.field.base') }}
                <span class="dc-affect" :title="t('episode.design.affectsTip.base')">{{ t('episode.design.affects.base') }}</span>
              </span>
              <select class="input dc-select" :value="baseValue" :aria-label="t('episode.design.field.base')" @change="setBase($event.target.value)">
                <option value="">{{ t('episode.design.baseNone') }}</option>
                <option value="inherit_prev">{{ t('episode.design.inheritPrev') }}</option>
                <option
                  v-for="candidate in ctx.base_candidates"
                  :key="`${candidate.asset_kind}:${candidate.asset_id}:${candidate.version_task_id ?? 0}`"
                  :value="baseKeyOf(candidate)"
                >
                  {{ candidate.name }}{{ candidate.verified ? ` · ${t('episode.design.picker.verified')}` : '' }}
                </option>
              </select>
              <!-- 实际引用版本的缩略图（#87 §E）：取底图候选自己的 path/version，不拿资产当前图冒充 -->
              <button
                v-if="baseCandidate && baseCandidate.path"
                type="button"
                class="dc-thumb"
                :title="t('designCard87.viewImage')"
                @click="previewImage(baseCandidate.path, baseCandidate.name, baseCandidate.version_task_id)"
              >
                <img :src="mediaUrl(baseCandidate.path)" :alt="baseCandidate.name">
                <span class="dc-thumb-tag mono">{{ baseCandidate.version_task_id ? t('designCard87.version', { n: baseCandidate.version_task_id }) : t('designCard87.currentVersion') }}</span>
              </button>
              <span v-else-if="baseValue && baseValue !== 'inherit_prev'" class="dim">{{ t('designCard87.noImage') }}</span>
            </div>

            <div class="dc-field">
              <span class="dc-label">
                {{ t('episode.design.field.mustMark') }}
                <span class="dc-affect" :title="t('episode.design.affectsTip.mustMark')">{{ t('episode.design.affects.mustMark') }}</span>
              </span>
              <div class="dc-chips">
                <span v-for="(item, index) in layerPlan.must_mark" :key="`${item.asset_id}:${item.semantic_id}`" :class="['dc-chip', { 'is-unresolved': item.unresolved }]">
                  <button
                    v-if="assetImage('prop', item.asset_id)"
                    type="button"
                    class="dc-chip-thumb"
                    :title="t('designCard87.viewImage')"
                    @click="previewImage(assetImage('prop', item.asset_id), item.name)"
                  ><img :src="mediaUrl(assetImage('prop', item.asset_id))" :alt="item.name"></button>
                  <span class="dc-chip-text">{{ item.name }}</span>
                  <button
                    type="button"
                    class="dc-chip-open"
                    :title="t('designCard87.openSemantics')"
                    @click="emit('open-asset', { kind: 'prop', id: item.asset_id, semantic_id: item.semantic_id || undefined, section: 'semantics' })"
                  >⌕</button>
                  <button type="button" class="dc-chip-del" :aria-label="t('episode.design.actions.remove')" @click="removeMustMark(index)">×</button>
                </span>
                <button type="button" class="btn btn-sm" @click="openPicker('must_mark')">{{ t('episode.design.actions.add') }}</button>
              </div>
            </div>

            <div class="dc-field">
              <span class="dc-label">{{ t('episode.design.field.plannedLayers') }}</span>
              <div class="dc-rows">
                <div v-for="(layer, index) in layerPlan.planned_layers" :key="index" class="dc-row">
                  <select
                    class="input dc-select dc-row-type"
                    :value="layer.type"
                    :aria-label="t('episode.design.field.plannedLayers')"
                    @change="patchLayer(index, { type: $event.target.value })"
                  >
                    <option v-for="type in ctx.planned_layer_types" :key="type" :value="type">{{ t(`episode.design.layerType.${type}`) }}</option>
                  </select>
                  <input
                    class="input dc-row-text" type="text" :value="layer.text || ''"
                    :aria-label="t('episode.design.field.plannedLayers')"
                    @input="patchLayer(index, { text: $event.target.value }, true)"
                    @blur="saveNow()"
                  >
                  <input
                    class="input dc-row-at" type="number" min="0" step="0.5" :value="layer.at_s"
                    :aria-label="t('episode.design.atSeconds', { n: layer.at_s })"
                    @change="patchLayer(index, { at_s: toSeconds($event.target.value) })"
                  >
                  <button type="button" class="dc-chip-del" :aria-label="t('episode.design.actions.remove')" @click="removeLayer(index)">×</button>
                </div>
                <button type="button" class="btn btn-sm" @click="addLayer">{{ t('episode.design.actions.add') }}</button>
              </div>
            </div>
          </div>

          <!-- 生成段计划（A 组合没有生成段） -->
          <div v-if="draft.combo !== 'A'" class="dc-section">
            <div class="dc-section-head">
              <span class="dc-section-title">{{ t('episode.design.section.genPlan') }}</span>
              <span class="dc-affect" :title="t('episode.design.affectsTip.frames')">{{ t('episode.design.affects.frames') }}</span>
            </div>

            <div class="dc-field">
              <span class="dc-label">
                {{ t('episode.design.field.referenceAssets') }}
                <span class="dc-affect" :title="t('episode.design.affectsTip.referenceAssets')">{{ t('episode.design.affects.referenceAssets') }}</span>
              </span>
              <div class="dc-chips">
                <span v-for="(item, index) in genPlan.reference_assets" :key="`${item.kind}:${item.id}`" :class="['dc-chip', { 'is-unresolved': item.unresolved }]">
                  <button
                    v-if="assetImage(item.kind, item.id)"
                    type="button"
                    class="dc-chip-thumb"
                    :title="t('designCard87.viewImage')"
                    @click="previewImage(assetImage(item.kind, item.id), item.name)"
                  ><img :src="mediaUrl(assetImage(item.kind, item.id))" :alt="item.name"></button>
                  <span class="dc-chip-text">{{ item.name }}</span>
                  <button
                    type="button"
                    class="dc-chip-open"
                    :title="t('designCard87.openAsset')"
                    @click="emit('open-asset', { kind: item.kind, id: item.id, section: 'semantics' })"
                  >⌕</button>
                  <button type="button" class="dc-chip-del" :aria-label="t('episode.design.actions.remove')" @click="removeReference(index)">×</button>
                </span>
                <button type="button" class="btn btn-sm" @click="openPicker('reference_assets')">{{ t('episode.design.actions.add') }}</button>
              </div>
            </div>

            <div v-for="slot in ['first', 'mid', 'last']" :key="slot" class="dc-field">
              <span class="dc-label">{{ t(`episode.design.field.${slot}`) }}</span>
              <p v-if="junctionSlot === slot" class="dc-read dc-junction" :title="t('episode.design.junction.noText')">
                {{ t('episode.design.junction.locked') }} · {{ draft.combo === 'C' ? t('episode.design.junction.layerLast') : t('episode.design.junction.layerFirst') }}
              </p>
              <input
                v-else
                class="input"
                type="text"
                :value="genPlan[slot] || ''"
                :aria-label="t(`episode.design.field.${slot}`)"
                @input="patchGen({ [slot]: $event.target.value }, true)"
                @blur="saveNow()"
              >
            </div>
          </div>

          <!-- 理由与问题 -->
          <div class="dc-section">
            <div class="dc-section-head">
              <span class="dc-section-title">{{ t('episode.design.section.rationale') }}</span>
              <span class="dc-affect" :title="t('episode.design.affectsTip.rationale')">{{ t('episode.design.affects.rationale') }}</span>
            </div>
            <p v-if="current.design_card_stale_reason === 'migration_combo_unresolved'" class="dc-read dc-stale">
              {{ t('episode.design.migrationComboUnresolved') }}
            </p>
            <textarea
              class="textarea"
              rows="3"
              :value="draft.rationale"
              :aria-label="t('episode.design.field.rationale')"
              :placeholder="t('episode.design.field.rationale')"
              @input="patchDraft({ rationale: $event.target.value }, true)"
              @blur="saveNow()"
            />
            <ul v-if="groupedIssues.length" class="dc-issues">
              <li v-for="(issue, index) in groupedIssues" :key="`${issue.code}-${index}`" :class="['dc-issue', 'is-' + issue.severity]">
                {{ issue.message || t(`episode.design.issue.${issue.code}`) }} <small>({{ issue.code }})</small><template v-if="issue.count > 1"> ×{{ issue.count }}</template>
              </li>
            </ul>
            <!--
              语义引用问题合并成一张可操作卡（#87 §E）：原因只说一次，逐层说明缺什么、影响什么，
              并给「打开该资产语义」「改绑引用」「看实际引用版本的大图」。不自动删层、不改真实数据。
            -->
            <div v-for="group in unresolvedGroups" :key="group.key" class="dc-unresolved">
              <div class="dc-unresolved-head">
                <strong>{{ t('designCard87.unresolvedTitle') }}</strong>
                <span class="dim">{{ t('designCard87.affectedLayers', { n: group.layers.length }) }}</span>
              </div>
              <p class="dc-unresolved-cause">
                {{ t('designCard87.cause', {
                  asset: `#${group.asset_id} ${group.asset_name || ''}`,
                  state: t(group.asset_exists ? 'designCard82.exists' : 'designCard82.missingAsset'),
                  semantic: group.semantic_id || group.semantic_name || t('designCard87.blankAnchor'),
                }) }}
              </p>
              <p class="dc-unresolved-cause">
                {{ group.available_semantics.length
                  ? t('designCard87.availableList', { list: group.available_semantics.map(item => `${item.name} (${item.id})`).join('、') })
                  : t('designCard82.noSemantics') }}
              </p>
              <p class="dc-unresolved-impact">{{ t('designCard87.impact') }}</p>
              <ul class="dc-unresolved-layers">
                <li v-for="layer in group.layers" :key="layer.index">
                  <span class="mono">#{{ layer.index + 1 }}</span>
                  <span>{{ t(`episode.design.layerType.${layer.type}`) }}</span>
                  <span class="dc-unresolved-text">{{ layer.text || '—' }}</span>
                  <span class="mono dim">{{ t('episode.design.atSeconds', { n: layerAt(layer.index) }) }}</span>
                  <span class="dc-unresolved-need">{{ t(`designCard87.need.${needOf(layer.type)}`) }}</span>
                </li>
              </ul>
              <div class="dc-unresolved-actions">
                <button type="button" class="btn btn-sm" @click="openAssetSemantics(group)">{{ t('designCard87.openSemantics') }}</button>
                <button type="button" class="btn btn-sm" @click="openAnchorPicker(group)">{{ t('designCard87.changeRef') }}</button>
                <button
                  v-if="assetImage('prop', group.asset_id)"
                  type="button"
                  class="btn btn-sm"
                  @click="previewImage(assetImage('prop', group.asset_id), group.asset_name)"
                >{{ t('designCard87.viewImage') }}</button>
              </div>
            </div>
            <label v-if="warnOnly" class="dc-ack">
              <input type="checkbox" :checked="acknowledged" @change="acknowledged = $event.target.checked">
              {{ t('episode.design.actions.acknowledge') }}
            </label>
          </div>
        </section>
      </div>
    </div>

    <!-- 批量范围清单：将处理 n 镜 / 排除 m 镜及原因 -->
    <Teleport to="body">
      <div v-if="scope" class="overlay" @click.self="scope = null">
        <div class="dialog dc-scope" role="dialog" aria-modal="true" :aria-label="t('episode.design.batch.scopeTitle')">
          <header class="dialog-head">
            <h2 class="dialog-title">{{ t('episode.design.batch.scopeTitle') }}</h2>
          </header>
          <div class="dialog-body">
            <p>{{ t('episode.design.batch.willProcess', { n: scope.include.length }) }}</p>
            <p class="dim">{{ t('episode.design.batch.excluded', { n: scope.exclude.length }) }}</p>
            <ul class="dc-scope-list">
              <li v-for="item in scope.exclude" :key="item.storyboard_id">
                <span class="mono">#{{ pad(item.shot_number) }}</span>
                <span class="dim">{{ t('episode.design.batch.reason') }}: {{ t(`episode.design.exclude.${item.reason}`) }}</span>
              </li>
            </ul>
          </div>
          <footer class="dialog-foot">
            <button class="btn btn-sm" @click="scope = null">{{ t('episode.design.batch.cancel') }}</button>
            <button class="btn btn-sm btn-primary" :disabled="!scope.include.length" @click="runScope">
              {{ t('episode.design.batch.run') }}
            </button>
          </footer>
        </div>
      </div>
    </Teleport>

    <!-- 本镜已有制作产物时，改组合不再直接写设计卡，而是走「保留/归档/新做」的影响清单 -->
    <ComboSwitchDialog
      v-if="comboSwitch.open"
      :storyboard-id="comboSwitch.sbId"
      :shot-number="comboSwitch.shotNumber"
      :from="comboSwitch.from"
      :initial="comboSwitch.to"
      @close="comboSwitch.open = false"
      @switched="onComboSwitched"
    />

    <AssetPicker
      :open="picker.open"
      :mode="picker.mode"
      :assets="ctx.assets"
      :selected="picker.selected"
      @close="picker.open = false"
      @confirm="onPicked"
    />
  </template>
</template>

<script setup>
/**
 * 分镜设计卡（Issue #57，纪录片）——导演分镜单：逐镜写明叙事、段组合、两段的时长预算与
 * 各自的制作计划，每个分组都标出「→ 影响」哪一步下游工作。
 *
 * 保存契约：后端**整份替换** `design_card`，所以任何一次改动都把完整卡片 PUT 回去，
 * 界面随后一律改用响应里的 design_card / issues / design_card_status（issues 是读时重算的
 * 结论，前端不自行推断）。同一镜的写入串行化，避免并发写各自用旧快照互相覆盖。
 *
 * Issue #70：本步内部分三个子阶段——旁白骨架 → 批量配音 → 实测时长设计卡。
 * 当前有效配音是填卡与确认的**硬前置**：没有有效实测的镜一律阻断，没有估算草稿。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { useI18n } from 'vue-i18n'
import { ChevronDown, ChevronUp, Layers, Loader2, Lock, Sparkles } from 'lucide-vue-next'
import NarrationCoverageBar from '~/components/NarrationCoverageBar.vue'
import NarrationSkeletonPanel from '~/components/NarrationSkeletonPanel.vue'
import AssetPicker from '~/components/AssetPicker.vue'
import ComboSwitchDialog from '~/components/ShotProduction/ComboSwitchDialog.vue'
import TaskWorkMetrics from '~/components/TaskWorkMetrics.vue'
import { mediaUrl } from '~/utils/url'
import { COMBOS, episodeAPI, narrationSkeletonAPI, storyboardAPI, ttsRequiredOf } from '~/composables/useApi'
import { onTaskFinished, refreshTasks, useTasks } from '~/composables/useTasks'
import { useWorkflowGates } from '~/composables/useWorkflowGates'
import { toastError, toastServerMessage } from '~/composables/useToast'

const { t, te } = useI18n()

const props = defineProps({
  episodeId: { type: Number, required: true },
  storyboards: { type: Array, default: () => [] },
  chatModel: { type: String, default: '' },
  chatConfigId: { type: Number, default: 0 },
  narrationVoiceBatch: { type: Object, default: () => ({ running: false, total: 0, completed: 0 }) },
})
// preview / open-asset 由集页面接到既有大图查看器与资产语义弹窗（#87 §E，#86 负责 URL 态）
const emit = defineEmits(['refresh', 'batch-narration-voice', 'preview', 'open-asset'])

const COMBO_GLYPH = { A: '▣', B: '▶', C: '▣▶', D: '▶▣' }
const EMPTY_CTX = {
  assets: [],
  base_candidates: [],
  combos: ['A', 'B', 'C', 'D'],
  info_point_vias: ['layer', 'generated', 'narration_only'],
  planned_layer_types: ['polygon', 'polyline', 'marker', 'label', 'card', 'image'],
  limits: { layer_s: 30, gen_s: 15, narration_cps: 4.2, info_points: 12, planned_layers: 20, must_mark: 12, rationale: 600 },
}

const ctx = ref({ ...EMPTY_CTX })
const audit = ref([])
const overrides = ref({})
const selectedId = ref(0)
const localOrder = ref(null)
const dragId = ref(0)
const busy = ref(false)
const saveState = ref('')
const infoDraft = ref('')
const acknowledged = ref(false)
const scope = ref(null)
/** 本次填卡用哪条模型（#87 §B）：'auto' = 后端挑健康视觉配置；'pinned' = 用户显式指定顶栏那条 */
const modelMode = ref('auto')
/** 显式指定不可用时后端返回的 4xx：指名配置与原因，并给可用候选 */
const pinError = ref(null)
/** 开跑前的计划字数与历史 ETA（GET /episodes/:id/work-estimate） */
const fillEstimate = ref(null)
/** 上一次提交的范围：改用其它配置重填时按同一范围重来，不悄悄扩大 */
const lastFillIds = ref(null)
/** 刚提交、任务还没出现在全局 store 里的空窗期（下一次轮询就会接上） */
const fillStarting = ref(false)
// layerIndexes 非空时是「改绑计划图层 anchor」模式（#87 §E）
const picker = reactive({ open: false, mode: 'asset', field: '', selected: [], layerIndexes: null })
const comboSwitch = ref({ open: false, sbId: 0, shotNumber: 0, from: '', to: '' })
const barEl = ref(null)

// ===== 子阶段（#70）：骨架 / 配音 / 设计卡 =====
const EMPTY_SKELETON = {
  enabled: false,
  confirmed: false,
  revision: '',
  confirmed_revision: null,
  script_confirmed: false,
  confirmable: false,
  blocked_reason: null,
  coverage: null,
  tts: { valid: 0, invalid: 0, total: 0 },
  shots: [],
}
const skeleton = ref({ ...EMPTY_SKELETON })
const phase = ref('cards')
const PHASE_KEY = 'huobao:designPhase'

/** 配音状态按镜索引：设计卡的时长与门禁都只认这里的实测结果 */
const ttsByShot = computed(() => {
  const map = new Map()
  for (const shot of skeleton.value.shots || []) map.set(shot.storyboard_id, shot)
  return map
})
const INVALID_TTS = { valid: false, reason: 'audio_missing', message: null, duration_ms: null }
/**
 * 单镜配音状态的取值顺序：写入/确认响应 > 审计 > 骨架接口。
 * 三者都是服务端判定，前端不自行推断有效性，也没有估算回退。
 */
function ttsOf(storyboardId) {
  return overrides.value[storyboardId]?.tts
    || auditById.value[storyboardId]?.tts
    || ttsByShot.value.get(storyboardId)?.tts
    || INVALID_TTS
}
function ttsTitle(storyboardId) {
  const tts = ttsOf(storyboardId)
  if (tts.valid && typeof tts.duration_ms === 'number' && tts.duration_ms > 0) return t('episode.skeleton.ttsValid', { sec: (tts.duration_ms / 1000).toFixed(1) })
  if (tts.valid) return t('designCard82.pendingVoice')
  const key = `episode.skeleton.ttsReason.${tts.reason || 'audio_missing'}`
  return t('episode.skeleton.ttsInvalid', { reason: te(key) ? t(key) : (tts.message || tts.reason || '') })
}
/** 可填卡的镜：当前有有效实测配音（后端 design_fillable 同一口径） */
const fillableIds = computed(() => (skeleton.value.shots || [])
  .filter(shot => shot.design_fillable)
  .map(shot => shot.storyboard_id))
const cardsBlockReason = computed(() => {
  if (!skeleton.value.confirmed) return t('episode.skeleton.cardsNeedConfirm')
  if (!fillableIds.value.length) return t('episode.skeleton.cardsBlockedByTts', { n: skeleton.value.tts.invalid })
  return ''
})
const phases = computed(() => [
  {
    key: 'skeleton',
    label: t('episode.skeleton.phaseSkeleton'),
    state: skeleton.value.confirmed
      ? t('episode.skeleton.confirmed')
      : t('episode.skeleton.phaseSkeletonPending', { n: skeleton.value.shots.length }),
  },
  {
    key: 'voice',
    label: t('episode.skeleton.phaseVoice'),
    state: t('episode.skeleton.phaseVoiceState', { valid: skeleton.value.tts.valid, total: skeleton.value.tts.total }),
  },
  {
    key: 'cards',
    label: t('episode.skeleton.phaseCards'),
    state: t('episode.skeleton.phaseCardsState', { n: fillableIds.value.length }),
  },
])

function setPhase(key) {
  phase.value = key
  try { localStorage.setItem(PHASE_KEY, key) } catch { /* 静默 */ }
}
/** 合并时为 tts / shots 兜底：缺字段一律按「没有有效配音」渲染，绝不放行填卡 */
function applySkeleton(next) {
  if (!next) return
  skeleton.value = {
    ...EMPTY_SKELETON,
    ...next,
    tts: { ...EMPTY_SKELETON.tts, ...(next.tts || {}) },
    shots: Array.isArray(next.shots) ? next.shots : [],
  }
}
async function loadSkeleton() {
  if (!props.episodeId) return
  try {
    applySkeleton(await narrationSkeletonAPI.state(props.episodeId))
  } catch { /* 静默：骨架取不到时按「无有效配音」渲染，不放行填卡 */ }
}
function onSkeletonRefresh() {
  emit('refresh')
  loadSkeleton()
  loadAudit()
}

// ===== 批量填卡进度：全局任务 store 是唯一来源（kind='design_card'），本组件不轮询 =====
const { tasksById } = useTasks()
const fillTask = computed(() => {
  let latest = null
  for (const task of Object.values(tasksById.value)) {
    if (Number(task.episode_id) !== Number(props.episodeId)) continue
    if (String(task.kind || task.params?.kind || '') !== 'design_card') continue
    if (!latest || task.id > latest.id) latest = task
  }
  return latest
})
const batch = computed(() => {
  const task = fillTask.value
  const active = task?.status === 'queued' || task?.status === 'processing'
  const progress = task?.progress || task?.params?.progress || {}
  return {
    running: Boolean(active) || fillStarting.value,
    total: Number(progress.total || 0),
    completed: Number(progress.completed || 0),
  }
})
/** 本批次因缺少当前有效配音被排除的镜（后端写在任务 params.tts_blocked 上） */
const batchTtsBlocked = computed(() => {
  const blocked = fillTask.value?.params?.tts_blocked
  return Array.isArray(blocked) ? blocked : []
})
/**
 * 真实计量（#87 §D）：和任务详情读同一个 `observation_summary`，不另起轮询。
 * 任务还没出现（或已终态很久）时退回「开始前」的计划字数与历史 ETA。
 */
const fillSummary = computed(() => fillTask.value?.observation_summary || null)

/** 本次会填几镜、共多少源字数、历史同口径要多久；没有样本后端返回 null，界面显示「暂无估计」 */
async function loadFillEstimate() {
  if (!props.episodeId) return
  try {
    const res = await episodeAPI.workEstimate(props.episodeId, 'design_card')
    fillEstimate.value = res?.estimate || null
  } catch { /* 静默：预估失败不挡填卡，界面显示「暂无估计」 */ }
}

// ===== 实际引用版本的缩略图 / 大图 / 语义入口（#87 §E） =====
/** 当前底图选的是哪条候选：缩略图必须用这条候选自己的 path 与版本，不拿资产当前图冒充 */
const baseCandidate = computed(() => (ctx.value.base_candidates || [])
  .find(candidate => baseKeyOf(candidate) === baseValue.value) || null)

function assetImage(kind, id) {
  const asset = (ctx.value.assets || []).find(item => item.kind === kind && Number(item.id) === Number(id))
  return asset?.image || null
}
function previewImage(path, title, versionTaskId) {
  if (!path) return
  emit('preview', { path, title: title || '', version_task_id: versionTaskId ?? null })
}
function openAssetSemantics(group) {
  emit('open-asset', {
    kind: 'prop',
    id: group.asset_id,
    semantic_id: group.semantic_id || undefined,
    section: 'semantics',
  })
}
/** 问题卡里逐层显示计划时间点：用草稿里的真实值，没有就显示 0 */
function layerAt(index) {
  return Number(layerPlan.value.planned_layers?.[index]?.at_s ?? 0)
}
/** 这一层缺的是「可执行几何」还是「位置锚点」：决定人要补什么 */
function needOf(type) {
  return ['polygon', 'polyline', 'marker', 'image'].includes(type) ? 'geometry' : 'anchor'
}
// 任务一出现在 store 里就不再需要「刚提交」兜底
watch(() => (fillTask.value?.status === 'queued' || fillTask.value?.status === 'processing'), (running) => {
  if (running) fillStarting.value = false
})
// 填卡进度推进：逐镜结果已经落库，清掉本地覆盖并重新取审计
watch(() => Number(batch.value.completed), (next, before) => {
  if (next !== before && batch.value.running) { overrides.value = {}; emit('refresh'); loadAudit() }
})

onTaskFinished((task) => {
  if (Number(task?.episode_id) !== Number(props.episodeId)) return
  const kind = String(task?.kind || task?.params?.kind || '')
  // 配音任务结束：实测时长与有效性全部重判（设计卡的硬前置）
  if (kind === 'narration_tts') { loadSkeleton(); return }
  if (kind !== 'design_card') return
  fillStarting.value = false
  overrides.value = {}
  emit('refresh')
  loadAudit()
  // 这一批的真实样本已落库：下一次「开始前预估」用得上
  loadFillEstimate()
  loadSkeleton()
  nextTick(syncDraft)
  const failed = Number(task?.progress?.failed || task?.params?.progress?.failed || 0)
  if (task?.status === 'completed') {
    toast.success(failed ? t('episode.design.fill.doneFailed', { n: failed }) : t('episode.design.fill.done'))
  } else {
    toastError(task?.error_msg, { fallback: 'episode.design.error.fillFailed' })
  }
})

// ===== 门禁 =====
const { gates, ready: gatesReady, refreshGates, reasonOf, gotoOf } = useWorkflowGates(() => props.episodeId)
// 门禁未判定（首屏未取到 /gates 或取数失败）时同样按锁定渲染，内容绝不先闪出来
const designLocked = computed(() => !gatesReady.value || gates.value.unlocked?.design === false)
const lockReason = computed(() => reasonOf('design') || t('episode.gate.checking'))
function gotoBlocker() {
  const target = gotoOf('design') || 'assets'
  const url = new URL(window.location.href)
  if (target === 'script') {
    url.searchParams.set('panel', 'script')
    url.searchParams.delete('tab')
  } else {
    url.searchParams.set('panel', 'production')
    url.searchParams.set('tab', target)
  }
  window.location.assign(url.toString())
}

// ===== 镜列表与选中镜 =====
const auditById = computed(() => Object.fromEntries(audit.value.map(item => [item.storyboard_id, item])))

const shots = computed(() => {
  const list = [...props.storyboards]
  const order = localOrder.value
  if (!order) return list
  const rank = new Map(order.map((id, index) => [id, index]))
  return list.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))
})

function pad(n) { return String(n ?? 0).padStart(2, '0') }
function shotLabel(sb) { return `#${pad(stateOf(sb).shot_number)}` }
function comboGlyph(combo) { return combo ? COMBO_GLYPH[combo] : t('episode.design.combo.none') }
function comboTitle(combo) { return combo ? t(`episode.design.combo.${combo}.name`) : t('episode.design.combo.required') }

/** 单镜状态：PUT/确认的响应覆盖 > 审计结果 > 分镜行本身 */
function stateOf(sb) {
  const override = overrides.value[sb?.id]
  if (override) return override
  const item = auditById.value[sb?.id]
  const card = sb?.design_card ?? sb?.designCard ?? null
  return {
    storyboard_id: sb?.id,
    shot_number: sb?.shot_number ?? sb?.shotNumber ?? item?.shot_number ?? 0,
    narration_text: sb?.narration_text ?? sb?.narrationText ?? item?.narration_text ?? '',
    combo: sb?.combo ?? item?.combo ?? null,
    design_card: card,
    design_card_status: sb?.design_card_status ?? item?.status ?? 'blank',
    design_card_confirmed_at: sb?.design_card_confirmed_at ?? item?.confirmed_at ?? null,
    design_card_stale_reason: sb?.design_card_stale_reason ?? item?.stale_reason ?? null,
    issues: sb?.design_card_issues ?? card?.issues ?? item?.issues ?? [],
    // 旁白时长不再从审计读取：唯一来源是骨架接口里的当前有效配音实测值（#70）
  }
}

const selected = computed(() => shots.value.find(sb => sb.id === selectedId.value) || null)
const current = computed(() => (selected.value ? stateOf(selected.value) : stateOf(null)))

const counts = computed(() => {
  const all = shots.value.map(sb => stateOf(sb))
  return {
    confirmed: all.filter(s => s.design_card_status === 'confirmed').length,
    pending: all.filter(s => s.design_card_status === 'pending').length,
    stale: all.filter(s => s.design_card_status === 'stale').length,
    issues: all.filter(s => (s.issues || []).length).length,
  }
})

// ===== 卡片草稿：服务端响应即真值，本地只在两次保存之间持有编辑中的内容 =====
function emptyCard() {
  return {
    version: 2,
    combo: null,
    info_points: [],
    budget: { layer_s: null, gen_s: null },
    layer_plan: { base: null, must_mark: [], planned_layers: [] },
    gen_plan: { reference_assets: [], first: '', mid: '', last: '' },
    rationale: '',
    suggested_combo: null,
  }
}
const draft = ref(emptyCard())

function fromState(state) {
  const card = state?.design_card || null
  const next = emptyCard()
  next.combo = state?.combo ?? null
  if (!card) return next
  next.info_points = (card.info_points || []).map(item => ({ ...item }))
  next.budget = { layer_s: card.budget?.layer_s ?? null, gen_s: card.budget?.gen_s ?? null }
  next.layer_plan = {
    base: card.layer_plan?.base ? { ...card.layer_plan.base } : null,
    must_mark: (card.layer_plan?.must_mark || []).map(item => ({ ...item })),
    planned_layers: (card.layer_plan?.planned_layers || []).map(item => ({ ...item })),
  }
  next.gen_plan = {
    reference_assets: (card.gen_plan?.reference_assets || []).map(item => ({ ...item })),
    first: card.gen_plan?.first || '',
    mid: card.gen_plan?.mid || '',
    last: card.gen_plan?.last || '',
  }
  next.rationale = card.rationale || ''
  next.suggested_combo = card.suggested_combo ?? null
  return next
}

function syncDraft() {
  draft.value = fromState(current.value)
  infoDraft.value = ''
  acknowledged.value = false
  saveState.value = ''
}

const layerPlan = computed(() => draft.value.layer_plan)
const genPlan = computed(() => draft.value.gen_plan)
const suggestedCombo = computed(() => draft.value.suggested_combo)
const issues = computed(() => (current.value.issues || []).filter(issue => !budgetMissing.value
  || !['budget_under_narration', 'budget_tight'].includes(issue.code)))
const groupedIssues = computed(() => {
  const groups = new Map()
  for (const issue of issues.value) {
    const key = `${issue.code}\0${issue.severity}\0${issue.message}`
    const group = groups.get(key)
    if (group) group.count++
    else groups.set(key, { ...issue, count: 1 })
  }
  return [...groups.values()]
})
const unresolvedGroups = computed(() => {
  const groups = new Map()
  for (const layer of auditById.value[selectedId.value]?.unresolved_layers || []) {
    const key = JSON.stringify([layer.asset_id, layer.asset_name, layer.semantic_id, layer.semantic_name])
    if (!groups.has(key)) groups.set(key, { ...layer, key, layers: [] })
    groups.get(key).layers.push(layer)
  }
  return [...groups.values()]
})
const warnOnly = computed(() => issues.value.length > 0 && issues.value.every(issue => issue.severity !== 'block'))
const junctionSlot = computed(() => (draft.value.combo === 'C' ? 'first' : (draft.value.combo === 'D' ? 'last' : '')))

// ===== 时长预算 =====
const hasLayer = computed(() => draft.value.combo !== 'B' && draft.value.combo !== null)
const hasGen = computed(() => draft.value.combo !== 'A' && draft.value.combo !== null)
const layerSeconds = computed(() => draft.value.budget.layer_s)
const genSeconds = computed(() => draft.value.budget.gen_s)
const budgetMissing = computed(() => !draft.value.combo
  || (hasLayer.value && layerSeconds.value === null)
  || (hasGen.value && genSeconds.value === null))
const totalSeconds = computed(() => budgetMissing.value ? null
  : (hasLayer.value ? layerSeconds.value : 0) + (hasGen.value ? genSeconds.value : 0))
const budgetPositive = computed(() => !budgetMissing.value
  && (!hasLayer.value || layerSeconds.value > 0)
  && (!hasGen.value || genSeconds.value > 0))
const budgetMessage = computed(() => {
  if (!draft.value.combo) return t('episode.design.budget.comboMissing')
  if (budgetMissing.value) return t('episode.design.budget.valuesMissing')
  if (!budgetPositive.value) return t('episode.design.budget.invalid')
  return ''
})
const layerPct = computed(() => (budgetPositive.value && hasLayer.value ? (layerSeconds.value / totalSeconds.value) * 100 : 0))
const genPct = computed(() => (budgetPositive.value && hasGen.value ? (genSeconds.value / totalSeconds.value) * 100 : 0))
/** 段内超出硬限的比例：刻度画在限额处，右侧溢出部分标红 */
const layerOverPct = computed(() => (layerSeconds.value > ctx.value.limits.layer_s
  ? ((layerSeconds.value - ctx.value.limits.layer_s) / layerSeconds.value) * 100 : 0))
const genOverPct = computed(() => (genSeconds.value > ctx.value.limits.gen_s
  ? ((genSeconds.value - ctx.value.limits.gen_s) / genSeconds.value) * 100 : 0))
const overLimit = computed(() => layerOverPct.value > 0 || genOverPct.value > 0)

/**
 * 旁白秒数只来自**当前有效配音的实测时长**（#70）。没有有效配音时为 null：
 * 不回退估算、不沿用旧音频，预算对照与余量一律显示为「待配音」。
 */
const measuredSeconds = computed(() => {
  const tts = ttsOf(selectedId.value)
  if (!tts.valid) return null
  if (typeof tts.duration_ms === 'number' && Number.isFinite(tts.duration_ms) && tts.duration_ms > 0) {
    return Number(tts.duration_ms) / 1000
  }
  // 审计接口的 tts 可能只回 {valid:true}；实测秒数另有 narration_measured_s。
  // 缺失值一律显示「待配音」，绝不把 undefined 变成 0.0s（#82）。
  const measured = auditById.value[selectedId.value]?.narration_measured_s
  return typeof measured === 'number' && Number.isFinite(measured) && measured > 0 ? measured : null
})
const headroom = computed(() => (budgetPositive.value && measuredSeconds.value !== null
  ? totalSeconds.value - measuredSeconds.value
  : null))
const narrationPct = computed(() => (totalSeconds.value > 0 && measuredSeconds.value !== null
  ? Math.min(100, (measuredSeconds.value / totalSeconds.value) * 100)
  : 0))
const narrationClass = computed(() => {
  if (!budgetPositive.value || headroom.value === null) return ''
  if (headroom.value < 0) return 'is-over'
  if (headroom.value < 0.5) return 'is-tight'
  return 'is-ok'
})

function toSeconds(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.round(n * 2) / 2
}
/** 硬限刻度位置：段内超限时画在限额处，未超限时落在段的右端 */
function tickLeft(seconds, limit) {
  return seconds > limit ? (limit / seconds) * 100 : 100
}

function setSeconds(field, value) {
  const next = { ...draft.value.budget, [field]: value.trim() === '' ? null : toSeconds(value) }
  patchDraft({ budget: next })
}

/** 拖分界：总时长不变，按 0.5s 吸附重新分配两段 */
function startDrag(event) {
  if (!hasLayer.value || !hasGen.value || !barEl.value) return
  const total = totalSeconds.value
  if (total <= 0) return
  const rect = barEl.value.getBoundingClientRect()
  const onMove = (e) => {
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    const layer = toSeconds(total * ratio)
    draft.value = { ...draft.value, budget: { layer_s: layer, gen_s: toSeconds(total - layer) } }
  }
  const onUp = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    saveNow()
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  onMove(event)
}

// ===== 编辑动作 =====
// 防抖写入必须记住它属于**哪一镜**：延迟期间换镜时，待写内容仍要落回原来那一镜，
// 否则会把上一镜的草稿 PUT 到新选中的分镜上。
let debounceTimer = null
let pendingSave = null
function patchDraft(patch, debounce = false) {
  draft.value = { ...draft.value, ...patch }
  const sbId = selectedId.value
  if (!sbId) return
  if (debounce) {
    pendingSave = { sbId, card: draft.value }
    saveState.value = ''
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => { debounceTimer = null; flushPending() }, 600)
    return
  }
  flushPending()
  save(sbId, draft.value)
}
/** 立即提交待写内容（失焦、拖动结束、换镜、卸载前都走这里） */
function flushPending() {
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null }
  const job = pendingSave
  pendingSave = null
  if (job) save(job.sbId, job.card)
}
function saveNow() {
  flushPending()
}

/** 本镜是否已有制作产物：已出过任一关键帧图（图层段渲染与否由后端门禁兜底） */
function hasProductionArtifacts(sb) {
  const k = sb?.keyframes || {}
  return Boolean(
    k.first_image || k.firstImage ||
    k.mid_image || k.midImage ||
    k.last_image || k.lastImage ||
    sb?.layer_segment || sb?.layerSegment,
  )
}
function pickCombo(key) {
  if (draft.value.combo === key) return
  const sb = selected.value
  // 已有产物：先看影响清单再切换（只归档不删除），不再直接覆盖写设计卡
  if (sb && draft.value.combo && hasProductionArtifacts(sb)) {
    comboSwitch.value = {
      open: true,
      sbId: sb.id,
      shotNumber: Number(stateOf(sb).shot_number) || 0,
      from: draft.value.combo,
      to: key,
    }
    return
  }
  patchDraft({ combo: key })
}
function onComboSwitched() {
  emit('refresh')
  if (selected.value) syncDraft()
}
function setInfoVia(index, via) {
  const list = draft.value.info_points.map((item, i) => (i === index ? { ...item, via } : item))
  patchDraft({ info_points: list })
}
function addInfoPoint() {
  const text = infoDraft.value.trim()
  if (!text) return
  if (draft.value.info_points.length >= ctx.value.limits.info_points) return
  const id = `ip-${Date.now().toString(36)}-${draft.value.info_points.length}`
  infoDraft.value = ''
  patchDraft({ info_points: [...draft.value.info_points, { id, text, via: ctx.value.info_point_vias[0] || 'layer' }] })
}
function removeInfoPoint(index) {
  patchDraft({ info_points: draft.value.info_points.filter((_, i) => i !== index) })
}

function baseKeyOf(candidate) {
  return `asset:${candidate.asset_kind}:${candidate.asset_id}:${candidate.version_task_id ?? ''}`
}
const baseValue = computed(() => {
  const base = layerPlan.value.base
  if (!base) return ''
  if (base.kind === 'inherit_prev') return 'inherit_prev'
  const exact = `asset:${base.asset_kind}:${base.asset_id}:${base.version_task_id ?? ''}`
  if (base.version_task_id != null) return exact
  // 迁移与 AI 填卡只写到资产级（没有版本号）：落到该资产的候选版本上，
  // 否则下拉匹配不到任何 option，明明选了底图却显示成「未选择底图」
  const candidate = ctx.value.base_candidates.find(item => item.asset_kind === base.asset_kind && item.asset_id === base.asset_id)
  return candidate ? baseKeyOf(candidate) : exact
})
function setBase(value) {
  let base = null
  if (value === 'inherit_prev') base = { kind: 'inherit_prev' }
  else if (value) {
    const candidate = ctx.value.base_candidates.find(item => baseKeyOf(item) === value)
    if (candidate) {
      base = {
        kind: 'asset',
        asset_kind: candidate.asset_kind,
        asset_id: candidate.asset_id,
        version_task_id: candidate.version_task_id ?? null,
      }
    }
  }
  patchDraft({ layer_plan: { ...layerPlan.value, base } })
}
function removeMustMark(index) {
  patchDraft({ layer_plan: { ...layerPlan.value, must_mark: layerPlan.value.must_mark.filter((_, i) => i !== index) } })
}
function addLayer() {
  if (layerPlan.value.planned_layers.length >= ctx.value.limits.planned_layers) return
  const type = ctx.value.planned_layer_types[0] || 'label'
  patchDraft({ layer_plan: { ...layerPlan.value, planned_layers: [...layerPlan.value.planned_layers, { type, text: '', at_s: 0 }] } })
}
function patchLayer(index, patch, debounce = false) {
  const list = layerPlan.value.planned_layers.map((item, i) => (i === index ? { ...item, ...patch } : item))
  patchDraft({ layer_plan: { ...layerPlan.value, planned_layers: list } }, debounce)
}
function removeLayer(index) {
  patchDraft({ layer_plan: { ...layerPlan.value, planned_layers: layerPlan.value.planned_layers.filter((_, i) => i !== index) } })
}
function patchGen(patch, debounce = false) {
  patchDraft({ gen_plan: { ...genPlan.value, ...patch } }, debounce)
}
function removeReference(index) {
  patchGen({ reference_assets: genPlan.value.reference_assets.filter((_, i) => i !== index) })
}

function openPicker(field) {
  picker.field = field
  picker.layerIndexes = null
  picker.mode = field === 'must_mark' ? 'semantic' : 'asset'
  picker.selected = field === 'must_mark'
    ? layerPlan.value.must_mark.map(item => ({ ...item }))
    : genPlan.value.reference_assets.map(item => ({ ...item }))
  picker.open = true
}
/**
 * 改绑引用（#87 §E）：直接改这些计划图层的 anchor。
 * 只挑一个真实语义条目，其余图层字段（类型 / 文案 / 时间点）原样保留；
 * 不删层、不自动清空，人工确认后照常走保存与审计刷新。
 */
function openAnchorPicker(group) {
  picker.field = 'anchor'
  picker.mode = 'semantic'
  picker.layerIndexes = group.layers.map(layer => layer.index)
  picker.selected = []
  picker.open = true
}
function onPicked(items) {
  picker.open = false
  if (picker.field === 'anchor') {
    const pick = items?.[0]
    const indexes = picker.layerIndexes || []
    picker.layerIndexes = null
    if (!pick || !indexes.length) return
    const anchor = { asset_id: Number(pick.asset_id), semantic_id: String(pick.semantic_id), name: String(pick.name || '') }
    const layers = layerPlan.value.planned_layers.map((layer, index) => (
      indexes.includes(index) ? { ...layer, anchor: { ...anchor } } : layer
    ))
    patchDraft({ layer_plan: { ...layerPlan.value, planned_layers: layers } })
    saveNow()
    // 等这一镜的保存队列落库后再刷新审计，否则看到的还是改绑前的旧警告
    void (saveQueues.get(selectedId.value) || Promise.resolve()).then(() => { loadAudit(); emit('refresh') })
    return
  }
  if (picker.field === 'must_mark') patchDraft({ layer_plan: { ...layerPlan.value, must_mark: items } })
  else patchGen({ reference_assets: items })
}

function neighborText(delta) {
  const index = shots.value.findIndex(sb => sb.id === selectedId.value)
  const neighbor = index >= 0 ? shots.value[index + delta] : null
  if (!neighbor) return t('episode.design.noneShot')
  const state = stateOf(neighbor)
  const text = (state.narration_text || '').slice(0, 20)
  return `#${pad(state.shot_number)} ${text}`
}

// ===== 保存：永远 PUT 完整卡片，响应即真值 =====
const saveQueues = new Map()
/** 同一镜的写入串行化：整份替换的并发写会用各自的旧快照互相覆盖 */
function save(sbId, card) {
  if (!sbId || !card) return Promise.resolve()
  // 超硬上限的段条不往后端送：后端必定 400，回灌服务端事实会把用户刚输入的数字抹掉，
  // 红色超限段与禁用的确认按钮就永远看不到。留在草稿里，改回上限内再接着存。
  const overLayer = Number(card.budget?.layer_s || 0) > ctx.value.limits.layer_s
  const overGen = Number(card.budget?.gen_s || 0) > ctx.value.limits.gen_s
  if (overLayer || overGen) {
    if (sbId === selectedId.value) {
      saveState.value = t(overLayer ? 'episode.design.error.budgetOverLayer' : 'episode.design.error.budgetOverGen')
    }
    return Promise.resolve()
  }
  const prev = saveQueues.get(sbId) || Promise.resolve()
  const next = prev.catch(() => {}).then(() => runSave(sbId, card))
  saveQueues.set(sbId, next)
  return next
}
function payloadOf(card) {
  return {
    version: 2,
    info_points: card.info_points,
    budget: card.budget,
    layer_plan: card.layer_plan,
    gen_plan: card.gen_plan,
    rationale: card.rationale,
    suggested_combo: card.suggested_combo,
    issues: [],
  }
}
async function runSave(sbId, card) {
  if (sbId === selectedId.value) saveState.value = t('episode.design.actions.save')
  try {
    const res = await storyboardAPI.setDesignCard(sbId, { combo: card.combo, design_card: payloadOf(card) })
    applyResult(sbId, res)
    if (sbId === selectedId.value) saveState.value = t('episode.design.actions.saved')
    emit('refresh')
    loadAudit()
  } catch (err) {
    if (sbId === selectedId.value) saveState.value = ''
    reportError(err, 'episode.design.error.saveFailed')
    // 写入被拒（超上限 / 卡被 AI 占用）时回到服务端的事实，不让界面留着没落库的值
    if (sbId === selectedId.value) syncDraft()
  }
}
function applyResult(id, res) {
  if (!res) return
  overrides.value = { ...overrides.value, [id]: res }
  if (id === selectedId.value) {
    draft.value = fromState(res)
    acknowledged.value = false
  }
}

/** 结构化错误码 → 可读文案（400/409 的 code / gate 由后端给出） */
function reportError(err, fallback) {
  // 配音硬前置被拦下（#70）：逐镜列出哪一镜、因为什么被阻断，不给估算出路
  const blocked = ttsRequiredOf(err)
  if (blocked) {
    const detail = blocked
      .map(item => `#${pad(item.storyboard_number ?? 0)} ${ttsTitle(item.storyboard_id)}`)
      .join(t('common.listJoin'))
    toast.error(detail ? `${t('episode.skeleton.ttsRequired')}：${detail}` : t('episode.skeleton.ttsRequired'))
    loadSkeleton()
    return
  }
  const body = err?.body || {}
  const map = {
    card_busy: 'episode.design.error.cardBusy',
    budget_over_gen: 'episode.design.error.budgetOverGen',
    budget_over_layer: 'episode.design.error.budgetOverLayer',
    blocked: 'episode.design.error.blocked',
    needs_acknowledge: 'episode.design.error.needsAcknowledge',
  }
  if (body.gate === 'combo_switch') {
    // 后端判定已有制作产物：按影响清单走组合切换（不直接改写设计卡）
    const sb = selected.value
    if (sb && draft.value.combo) {
      comboSwitch.value = {
        open: true,
        sbId: sb.id,
        shotNumber: Number(stateOf(sb).shot_number) || 0,
        from: draft.value.combo,
        to: '',
      }
      syncDraft()
    } else toast.error(t('episode.design.error.comboSwitch'))
    return
  }
  // 后端错误体是 { code: 400, error: 'budget_over_layer', ... }：错误码在 error 上，code 是 HTTP 状态
  const key = map[body.error]
  if (key) {
    const detail = Array.isArray(body.issues) && body.issues.length
      ? body.issues.map(issue => issue.message || t(`episode.design.issue.${issue.code}`)).join(t('common.listJoin'))
      : ''
    toast.error(detail ? `${t(key)}：${detail}` : t(key))
    return
  }
  if (Array.isArray(body.issues) && body.issues.length) {
    toast.error(body.issues.map(issue => issue.message || t(`episode.design.issue.${issue.code}`)).join(t('common.listJoin')))
    return
  }
  toastServerMessage(err, { fallback })
}

// ===== 确认 / 取消确认 =====
const confirmBlockReason = computed(() => {
  if (!ttsOf(selectedId.value).valid) return ttsTitle(selectedId.value)
  const blocking = issues.value.filter(issue => issue.severity === 'block')
  if (blocking.length) return blocking.map(issue => issue.message || t(`episode.design.issue.${issue.code}`)).join(t('common.listJoin'))
  if (!draft.value.combo) return t('episode.design.issue.combo_missing')
  if (budgetMessage.value) return budgetMessage.value
  if (overLimit.value) {
    return layerOverPct.value > 0
      ? t('episode.design.issue.budget_over_layer')
      : t('episode.design.issue.budget_over_gen')
  }
  if (warnOnly.value && !acknowledged.value) return t('episode.design.error.needsAcknowledge')
  return ''
})
const canConfirm = computed(() => !confirmBlockReason.value)

async function confirm() {
  const sb = selected.value
  if (!sb) return
  busy.value = true
  try {
    const res = await storyboardAPI.confirmDesignCard(sb.id, warnOnly.value && acknowledged.value)
    applyResult(sb.id, res)
    emit('refresh')
    loadAudit()
    refreshGates({ background: true })
  } catch (err) {
    reportError(err, 'episode.design.error.confirmFailed')
  } finally {
    busy.value = false
  }
}
async function unconfirm() {
  const sb = selected.value
  if (!sb) return
  busy.value = true
  try {
    const res = await storyboardAPI.unconfirmDesignCard(sb.id)
    applyResult(sb.id, res)
    emit('refresh')
    loadAudit()
    refreshGates({ background: true })
  } catch (err) {
    reportError(err, 'episode.design.error.confirmFailed')
  } finally {
    busy.value = false
  }
}

// ===== 排序：拖拽与上下按钮共用一个提交口 =====
function onDragStart(sb) { dragId.value = sb.id }
function onDrop(targetIndex) {
  const from = shots.value.findIndex(sb => sb.id === dragId.value)
  dragId.value = 0
  if (from < 0 || from === targetIndex) return
  const ids = shots.value.map(sb => sb.id)
  const [moved] = ids.splice(from, 1)
  ids.splice(targetIndex, 0, moved)
  commitOrder(ids)
}
function move(index, delta) {
  const target = index + delta
  if (target < 0 || target >= shots.value.length) return
  const ids = shots.value.map(sb => sb.id)
  const [moved] = ids.splice(index, 1)
  ids.splice(target, 0, moved)
  commitOrder(ids)
}
async function commitOrder(ids) {
  const previous = localOrder.value
  localOrder.value = ids
  try {
    await episodeAPI.reorderStoryboards(props.episodeId, ids)
    toast.success(t('episode.design.order.saved'))
    emit('refresh')
    loadAudit()
  } catch (err) {
    localOrder.value = previous
    toastServerMessage(err, { fallback: 'episode.design.error.orderFailed' })
  }
}

// ===== 批量：先弹范围清单，再执行 =====
/**
 * 批量范围：「AI 填写」只处理 空白/过期，「批量确认」只处理 待审且零问题，
 * 其余逐镜给出被排除的原因（已确认 / AI 填写中 / 有阻断问题 / 有问题 / 状态不符）。
 */
function excludeReasonFor(state, kind) {
  // 没有当前有效配音的镜，既不能填卡也不能确认（硬前置，不是提醒）
  if (!ttsOf(state.storyboard_id).valid) return 'ttsInvalid'
  if (state.design_card_status === 'ai_filling') return 'ai_filling'
  if (state.design_card_status === 'confirmed') return 'confirmed'
  if (kind === 'fill') {
    return ['blank', 'stale'].includes(state.design_card_status) || (state.design_card_status === 'pending' && !state.combo) ? '' : 'notPending'
  }
  if (state.design_card_status !== 'pending') return 'notPending'
  if ((state.issues || []).some(issue => issue.severity === 'block')) return 'blocked'
  if ((state.issues || []).length) return 'hasIssues'
  return ''
}
function openScope(kind) {
  const include = []
  const exclude = []
  for (const sb of shots.value) {
    const state = stateOf(sb)
    const reason = excludeReasonFor(state, kind)
    if (reason) exclude.push({ storyboard_id: sb.id, shot_number: state.shot_number, reason })
    else include.push({ storyboard_id: sb.id, shot_number: state.shot_number })
  }
  scope.value = { kind, include, exclude }
}
async function runScope() {
  const picked = scope.value
  scope.value = null
  if (!picked) return
  if (picked.kind === 'fill') await startFill(picked.include.map(item => item.storyboard_id))
  else await confirmMany(picked.include.map(item => item.storyboard_id))
}
async function confirmMany(ids) {
  busy.value = true
  for (const id of ids) {
    try {
      const res = await storyboardAPI.confirmDesignCard(id, false)
      applyResult(id, res)
    } catch (err) {
      reportError(err, 'episode.design.error.confirmFailed')
    }
  }
  busy.value = false
  emit('refresh')
  loadAudit()
  refreshGates({ background: true })
}

/**
 * 发起填卡（#87 §B）：模型选择必须显式。
 * 'auto' 不带 model/config_id —— 顶栏 localStorage 的残留选择绝不冒充本次用户指定；
 * 'pinned' 带上用户选的那条，后端不可用时返回指名原因的 4xx，不静默换到另一计费服务。
 */
async function startFill(ids, override) {
  pinError.value = null
  const mode = override?.config_id ? 'pinned' : modelMode.value
  try {
    const res = await episodeAPI.fillDesignCards(props.episodeId, {
      storyboard_ids: ids,
      model_mode: mode,
      model: override?.model ?? props.chatModel,
      config_id: override?.config_id ?? props.chatConfigId,
    })
    if (!res?.total && !res?.already_running) {
      toast.info(t('episode.design.fill.allFilled'))
      return
    }
    if (res?.total) toast.info(t('episode.design.fill.started', { n: res.total }))
    fillStarting.value = true
    lastFillIds.value = ids || null
    // 进度来自全局任务 store（kind='design_card'）：立刻拉一次，之后随全局轮询刷新
    void refreshTasks()
  } catch (err) {
    const body = err?.body
    const code = body?.error
    if (code === 'model_pin_unavailable' || code === 'vision_config_unavailable' || code === 'text_config_unavailable') {
      // 指名原因直接显示后端文案（它带配置名与具体原因），并给可用候选的一键重填
      pinError.value = {
        message: String(body.message || t('episode.design.error.fillFailed')),
        alternatives: Array.isArray(body.alternatives) ? body.alternatives : [],
      }
      lastFillIds.value = ids || null
      return
    }
    reportError(err, 'episode.design.error.fillFailed')
  }
}
/** 「改用可用配置重填」：显式切到用户点的那条，不是后端悄悄换 */
async function retryWithConfig(alt) {
  pinError.value = null
  modelMode.value = 'pinned'
  await startFill(lastFillIds.value || undefined, { config_id: alt.config_id, model: alt.model })
}
async function refillOne() {
  if (!selected.value) return
  await startFill([selected.value.id])
}

// ===== 取数 =====
async function loadContext() {
  if (!props.episodeId) return
  try {
    const data = await episodeAPI.designCardContext(props.episodeId)
    ctx.value = { ...EMPTY_CTX, ...(data || {}), limits: { ...EMPTY_CTX.limits, ...(data?.limits || {}) } }
  } catch (err) {
    toastError(err, { fallback: 'episode.design.error.loadFailed' })
  }
}
async function loadAudit() {
  if (!props.episodeId) return
  try {
    const data = await episodeAPI.designCardAudit(props.episodeId)
    audit.value = Array.isArray(data) ? data : []
  } catch { /* 静默：审计只影响左列状态点与批量范围 */ }
}

function ensureSelection() {
  if (!shots.value.length) { selectedId.value = 0; return }
  if (!shots.value.some(sb => sb.id === selectedId.value)) selectedId.value = shots.value[0].id
}

watch(() => props.storyboards, () => {
  flushPending()
  overrides.value = {}
  // 服务端顺序已经追上本地乐观顺序后就放手，之后一律以 props 为准
  if (localOrder.value) {
    const serverIds = props.storyboards.map(sb => sb.id).join(',')
    if (serverIds === localOrder.value.join(',')) localOrder.value = null
  }
  ensureSelection()
  loadSkeleton()
  loadAudit()
  nextTick(syncDraft)
})
// 换镜前先把待写内容提交回原来那一镜，再按新镜的服务端事实重建草稿
watch(selectedId, () => { flushPending(); syncDraft() })
watch(() => props.episodeId, () => {
  overrides.value = {}
  localOrder.value = null
  selectedId.value = 0
  skeleton.value = { ...EMPTY_SKELETON }
  loadContext()
  loadAudit()
  loadSkeleton()
  loadFillEstimate()
  refreshGates()
})

onMounted(() => {
  try {
    const saved = localStorage.getItem(PHASE_KEY)
    if (saved === 'skeleton' || saved === 'voice' || saved === 'cards') phase.value = saved
  } catch { /* 静默 */ }
  ensureSelection()
  syncDraft()
  loadContext()
  loadAudit()
  loadSkeleton()
  loadFillEstimate()
  refreshGates()
})
onBeforeUnmount(() => {
  flushPending()
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = null
})
</script>

<style scoped>
.dc-step { display: flex; flex-direction: column; gap: 8px; min-height: 0; }
.dc-bar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.dc-model-mode { max-width: 220px; }

/* 模型选择失败（#87 §B）：指名原因 + 可用候选，不静默换服务 */
.dc-pin-error {
  border: 1px solid var(--warn, #b26a00); border-radius: 6px;
  padding: 8px 10px; font-size: 12px; background: var(--bg-2);
}
.dc-pin-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }

/* 实际引用版本的缩略图（#87 §E）：点开大图走集页面既有查看器 */
.dc-thumb {
  position: relative; display: inline-flex; padding: 0; margin-left: 6px;
  border: 1px solid var(--border); border-radius: 4px; background: var(--bg-2); cursor: zoom-in;
}
.dc-thumb img { width: 72px; height: 48px; object-fit: cover; border-radius: 3px; display: block; }
.dc-thumb-tag {
  position: absolute; left: 0; bottom: 0; right: 0;
  font-size: 9px; line-height: 1.4; text-align: center;
  background: rgba(0, 0, 0, 0.55); color: #fff; border-radius: 0 0 3px 3px;
}
.dc-chip-thumb { padding: 0; border: 0; background: none; cursor: zoom-in; display: inline-flex; }
.dc-chip-thumb img { width: 20px; height: 20px; object-fit: cover; border-radius: 3px; display: block; }
.dc-chip-open { border: 0; background: none; cursor: pointer; color: var(--text-2); font-size: 12px; }

/* 语义引用问题卡：原因说一次，逐层说明缺什么、影响什么，并给修复入口 */
.dc-unresolved {
  border: 1px solid var(--warn, #b26a00); border-radius: 6px;
  padding: 8px 10px; margin-top: 6px; font-size: 12px; background: var(--bg-2);
}
.dc-unresolved-head { display: flex; align-items: baseline; gap: 8px; }
.dc-unresolved-cause { margin: 4px 0 0; }
.dc-unresolved-impact { margin: 4px 0 0; color: var(--warn, #b26a00); }
.dc-unresolved-layers { margin: 6px 0 0; padding-left: 16px; }
.dc-unresolved-layers li { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; }
.dc-unresolved-text { flex: 1 1 160px; min-width: 0; overflow-wrap: anywhere; }
.dc-unresolved-need { color: var(--warn, #b26a00); }
.dc-unresolved-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }

/* 子阶段条（#70）：骨架 → 配音 → 设计卡 */
.dc-phases { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dc-phase {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 10px; border: 1px solid var(--border); border-radius: 999px;
  background: var(--bg-2); color: var(--text-1); font-size: 12px; cursor: pointer;
}
.dc-phase.on { outline: 2px solid var(--accent); outline-offset: -2px; }
.dc-phase-num { font-size: 10px; color: var(--text-3); font-weight: 700; }
.dc-phase-name { font-weight: 600; }
.dc-phase-state { font-size: 10.5px; color: var(--text-3); }
.dc-block {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 0;
  padding: 7px 10px; font-size: 12px; color: var(--text-1);
  background: var(--warn-bg); border: 1px solid var(--warn-border); border-radius: var(--radius);
}
.dc-tts { font-size: 11px; }
.dc-tts.is-ok { color: var(--ok-text, var(--text-1)); }
.dc-tts.is-bad { color: var(--tag-danger-text, #ef5350); }
.dc-tts-dot { font-size: 10px; }
.dc-tts-dot.is-ok { color: var(--ok-text, var(--text-2)); }
.dc-tts-dot.is-bad { color: var(--tag-danger-text, #ef5350); }
.dc-tag-run { display: inline-flex; align-items: center; gap: 4px; }

.dc-body { display: grid; grid-template-columns: clamp(220px, 16vw, 300px) minmax(0, 1fr); gap: 10px; flex: 1; min-height: 0; }

.dc-list { display: flex; flex-direction: column; gap: 3px; overflow-y: auto; }
.dc-shot {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px;
  background: var(--bg-2); color: var(--text-1); font-size: 12px; cursor: pointer; text-align: left;
}
.dc-shot.on { outline: 2px solid var(--accent); outline-offset: -2px; }
.dc-shot-no { min-width: 34px; }
.dc-shot-combo { min-width: 28px; color: var(--text-2); }
.dc-shot-grip { margin-left: auto; display: flex; gap: 2px; }
.dc-move {
  display: inline-flex; align-items: center; justify-content: center;
  width: 18px; height: 18px; border-radius: 4px; color: var(--text-3); cursor: pointer;
}
.dc-move:hover { background: var(--bg-3); color: var(--text-1); }
.dc-dot { width: 8px; height: 8px; border-radius: 999px; background: var(--text-3); }
.dc-dot.is-blank { background: var(--text-3); }
.dc-dot.is-ai_filling { background: var(--tag-info-text, #4fc3f7); }
.dc-dot.is-pending { background: var(--tag-warning-text, #ffb74d); }
.dc-dot.is-confirmed { background: var(--tag-success-text, #66bb6a); }
.dc-dot.is-stale { background: var(--tag-danger-text, #ef5350); }

.dc-card { display: flex; flex-direction: column; gap: 10px; min-width: 0; overflow-y: auto; padding-right: 4px; }
.dc-card-empty { align-items: center; justify-content: center; color: var(--text-3); font-size: 12px; }
.dc-card-head { display: flex; align-items: center; gap: 8px; }
.dc-state { padding: 1px 6px; border-radius: 999px; font-size: 11px; background: var(--bg-3); color: var(--text-2); }
.dc-state.is-confirmed { color: var(--tag-success-text, #66bb6a); }
.dc-state.is-pending { color: var(--tag-warning-text, #ffb74d); }
.dc-state.is-stale { color: var(--tag-danger-text, #ef5350); }
.dc-stale { font-size: 11px; color: var(--tag-danger-text, #ef5350); }

.dc-section { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-2); }
.dc-section-head { display: flex; align-items: center; gap: 8px; }
.dc-section-title { font-size: 12px; font-weight: 600; }
.dc-affect {
  padding: 1px 6px; border-radius: 999px;
  background: var(--bg-3); color: var(--text-3); font-size: 11px; cursor: help;
}
.dc-hint { margin: 0; font-size: 11px; color: var(--text-3); }
.dc-field { display: flex; flex-direction: column; gap: 4px; }
.dc-label { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-2); }
.dc-read { margin: 0; font-size: 12px; line-height: 1.5; }
.dc-junction { color: var(--text-2); }

.dc-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.dc-chip {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 6px; border: 1px solid var(--border); border-radius: 999px;
  background: var(--bg-3); font-size: 11px;
}
.dc-chip.is-unresolved { border-color: var(--tag-danger-text, #ef5350); }
.dc-chip-text { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dc-chip-select { height: 20px; padding: 0 4px; font-size: 11px; }
.dc-chip-del { border: 0; background: transparent; color: var(--text-3); cursor: pointer; font-size: 12px; line-height: 1; }
.dc-chip-del:hover { color: var(--text-1); }
.dc-chip-add { display: inline-flex; align-items: center; gap: 4px; }
.dc-chip-input { height: 24px; width: 180px; font-size: 11px; }

.dc-rows { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; }
.dc-row { display: flex; align-items: center; gap: 4px; width: 100%; }
.dc-row-type { width: auto; min-width: max-content; flex: 0 0 auto; }
.dc-row-text { flex: 1; min-width: 0; }
.dc-row-at { width: 80px; }
.dc-select { height: 26px; padding: 2px 8px; font-size: 12px; line-height: normal; }
.dc-num { width: 80px; height: 24px; font-size: 12px; }

.dc-combos { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
.dc-combo {
  display: flex; flex-direction: column; gap: 3px;
  padding: 8px; border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg-3); color: var(--text-1); text-align: left; cursor: pointer;
}
.dc-combo.on { outline: 2px solid var(--accent); outline-offset: -2px; }
.dc-combo-icons { display: flex; align-items: center; gap: 4px; color: var(--text-2); }
.dc-combo-sug {
  margin-left: auto; padding: 0 5px; border-radius: 999px;
  background: var(--bg-2); color: var(--tag-warning-text, #ffb74d); font-size: 10px;
}
.dc-combo-name { font-size: 12px; font-weight: 600; }
.dc-combo-desc { font-size: 11px; color: var(--text-3); line-height: 1.4; }

.dc-budget { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.dc-budget-num { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; }
.dc-budget-limit { font-size: 11px; }
.dc-bar-track { display: flex; align-items: stretch; height: 22px; border-radius: 4px; overflow: hidden; background: var(--bg-3); }
.dc-seg { position: relative; display: flex; align-items: center; justify-content: center; min-width: 0; }
.dc-seg.is-layer { background: color-mix(in srgb, var(--accent) 30%, transparent); }
.dc-seg.is-gen { background: color-mix(in srgb, var(--accent) 14%, transparent); }
.dc-seg-over { position: absolute; top: 0; right: 0; bottom: 0; background: color-mix(in srgb, #ef5350 45%, transparent); }
.dc-seg-tick { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: var(--text-2); }
.dc-seg-tick.is-over { background: #ef5350; }
.dc-seg-text { position: relative; font-size: 11px; }
.dc-divider { display: flex; align-items: center; padding: 0 2px; cursor: col-resize; color: var(--text-2); font-size: 11px; user-select: none; }

.dc-narr-line { position: relative; display: flex; align-items: center; gap: 6px; height: 16px; }
.dc-narr-fill { position: absolute; left: 0; top: 7px; height: 2px; background: var(--text-3); }
.dc-narr-fill.is-over { background: var(--tag-danger-text, #ef5350); }
.dc-narr-fill.is-tight { background: var(--tag-warning-text, #ffb74d); }
.dc-narr-text { position: relative; font-size: 11px; color: var(--text-2); }

.dc-issues { display: flex; flex-direction: column; gap: 2px; margin: 0; padding-left: 16px; font-size: 11px; }
.dc-issue.is-block { color: var(--tag-danger-text, #ef5350); }
.dc-issue.is-warn { color: var(--tag-warning-text, #ffb74d); }
.dc-ack { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-2); }

.dc-scope { width: 420px; max-width: calc(100vw - 32px); }
.dc-scope-list { display: flex; flex-direction: column; gap: 2px; margin: 6px 0 0; padding-left: 16px; font-size: 11px; }
</style>
