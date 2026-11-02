<template>
  <div v-if="open" class="overlay" @click.self="emit('close')">
    <div class="dialog narration-settings-dialog">
      <header class="dialog-head">
        <h2 class="dialog-title">{{ t('episode.narration.settingsTitle') }}</h2>
        <button class="btn btn-ghost btn-icon" @click="emit('close')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </header>

      <!-- 关闭态：只给开启入口，不展示任何明细设置 -->
      <div v-if="!narrationEnabled" class="dialog-body narration-settings-body">
        <p class="ns-off-title">{{ t('episode.narration.settingsOffTitle') }}</p>
        <p class="ns-hint">{{ t('episode.narration.settingsOffHint') }}</p>
        <p class="ns-hint">{{ t('episode.breakdown.chain') }}</p>
        <button class="btn btn-primary ns-enable" @click="emit('update:narrationEnabled', true)">
          {{ t('episode.narration.enableNarration') }}
        </button>
      </div>

      <div v-else class="dialog-body narration-settings-body">
        <p class="ns-hint">{{ t('episode.narration.settingsScope') }}</p>

        <section class="ns-group">
          <h3 class="ns-group-title">{{ t('episode.narration.groupScript') }}</h3>
          <label class="ns-field">
            <span class="ns-label">{{ t('episode.narration.episodeTimingLabel') }}</span>
            <BaseSelect
              class="ns-select"
              :model-value="subtitleTiming"
              :options="toSelectOptions(timingOptions)"
              :searchable="false"
              @update:model-value="v => emit('update:subtitleTiming', v)"
            />
          </label>
          <label class="ns-check">
            <input
              type="checkbox"
              :checked="narrationNormalize"
              @change="emit('update:narrationNormalize', $event.target.checked)"
            />
            {{ t('episode.narration.normalizeLabel') }}
          </label>
          <p class="ns-hint">{{ t('episode.narration.normalizeHint') }}</p>

          <div class="ns-field ns-field-block">
            <span class="ns-label">{{ t('episode.narration.spineLabel') }}</span>
            <textarea
              v-model="spineDraft"
              class="textarea ns-spine"
              rows="6"
              :placeholder="t('episode.narration.spinePlaceholder')"
              @blur="saveSpine"
            />
            <p class="ns-hint">{{ t('episode.narration.spineHint') }}</p>
          </div>
        </section>

        <section class="ns-group">
          <h3 class="ns-group-title">{{ t('episode.narration.groupAudio') }}</h3>
          <label class="ns-field">
            <span class="ns-label">{{ t('episode.fit.episodeMixLabel') }}</span>
            <BaseSelect
              class="ns-select"
              :model-value="audioMixMode"
              :options="toSelectOptions(mixModeOptions)"
              :searchable="false"
              @update:model-value="v => emit('update:audioMixMode', v)"
            />
          </label>
          <label v-if="audioMixMode === 'mix'" class="ns-field">
            <span class="ns-label">{{ t('episode.fit.episodeBedGain') }}</span>
            <input
              class="input ns-num"
              type="number"
              max="0"
              step="1"
              :value="bedGainDb"
              @change="emit('update:bedGainDb', $event.target.value)"
            />
          </label>
          <label class="ns-field">
            <span class="ns-label">{{ t('episode.fit.episodeFitLabel') }}</span>
            <BaseSelect
              class="ns-select"
              :model-value="fitMode"
              :options="toSelectOptions(fitModeOptions)"
              :searchable="false"
              @update:model-value="v => emit('update:fitMode', v)"
            />
          </label>
          <template v-if="fitMode === 'pad'">
            <label class="ns-field">
              <span class="ns-label">{{ t('episode.fit.episodeFitPad') }}</span>
              <input
                class="input ns-num"
                type="number"
                min="0"
                :max="maxPadSeconds"
                step="0.1"
                :value="fitPadSeconds"
                @change="emit('update:fitPadSeconds', $event.target.value)"
              />
            </label>
            <label class="ns-field">
              <span class="ns-label">{{ t('episode.fit.episodeFitPosition') }}</span>
              <BaseSelect
                class="ns-select"
                :model-value="fitPadPosition"
                :options="toSelectOptions(fitPositionOptions)"
                :searchable="false"
                @update:model-value="v => emit('update:fitPadPosition', v)"
              />
            </label>
          </template>
        </section>

        <button class="btn ns-disable" @click="askDisable">{{ t('episode.narration.disableNarration') }}</button>
      </div>

      <footer class="dialog-foot">
        <button class="btn" @click="emit('close')">{{ t('common.close') }}</button>
      </footer>
    </div>

    <ConfirmDialog
      :open="disableConfirm"
      :title="t('episode.narration.disableConfirmTitle')"
      :message="t('episode.narration.disableConfirmMessage')"
      :confirm-text="t('episode.narration.disableNarration')"
      @cancel="disableConfirm = false"
      @confirm="confirmDisable"
    />
  </div>
</template>

<script setup>
/**
 * 音频旁白设置面板（#35）。
 * 入口在分镜拆分区，不在全局顶栏 —— 没有旁白的剧集根本不需要这些设置。
 * 关闭态只给「开启旁白」；开启后才显示字幕时间码、文本规范化、整集主线、音轨与时长匹配。
 * 镜级覆盖不在这里，留在每一镜自己的旁白块。
 */
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import BaseSelect from '~/components/BaseSelect.vue'
import ConfirmDialog from '~/components/ConfirmDialog.vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  narrationEnabled: { type: Boolean, default: false },
  narrationNormalize: { type: Boolean, default: true },
  spine: { type: String, default: '' },
  subtitleTiming: { type: String, default: 'sentence' },
  timingOptions: { type: Array, default: () => [] },
  audioMixMode: { type: String, default: 'replace' },
  mixModeOptions: { type: Array, default: () => [] },
  bedGainDb: { type: [Number, String], default: -18 },
  fitMode: { type: String, default: 'pad' },
  fitModeOptions: { type: Array, default: () => [] },
  fitPadSeconds: { type: [Number, String], default: '0.8' },
  fitPadPosition: { type: String, default: 'tail' },
  fitPositionOptions: { type: Array, default: () => [] },
  maxPadSeconds: { type: Number, default: 3 },
})
const emit = defineEmits([
  'close', 'update:narrationEnabled', 'update:narrationNormalize', 'update:spine',
  'update:subtitleTiming', 'update:audioMixMode', 'update:bedGainDb',
  'update:fitMode', 'update:fitPadSeconds', 'update:fitPadPosition',
])


// 顶栏原来用 ModelSelect（{key, model}），面板用 BaseSelect（{value, label}）：在这里统一一次
function toSelectOptions(options) {
  return (options || []).map(o => ({ value: o.value ?? o.key, label: o.label ?? o.model }))
}
const { t } = useI18n()
const spineDraft = ref(props.spine)
const disableConfirm = ref(false)

watch(() => [props.open, props.spine], () => { spineDraft.value = props.spine })

function saveSpine() {
  if (spineDraft.value === props.spine) return
  emit('update:spine', spineDraft.value)
}

function askDisable() {
  disableConfirm.value = true
}
function confirmDisable() {
  disableConfirm.value = false
  emit('update:narrationEnabled', false)
}
</script>

<style scoped>
.narration-settings-dialog {
  width: 560px;
  max-width: 94vw;
}
.narration-settings-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: 70vh;
  overflow-y: auto;
}
.ns-off-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
}
.ns-hint {
  margin: 0;
  font-size: 11px;
  color: var(--text-3);
}
.ns-enable {
  align-self: flex-start;
}
.ns-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-soft);
}
.ns-group-title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-1);
}
.ns-field {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ns-field-block {
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
}
.ns-label {
  font-size: 12px;
  color: var(--text-2);
  min-width: 140px;
}
.ns-select {
  min-width: 180px;
}
.ns-num {
  width: 100px;
}
.ns-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-1);
}
.ns-spine {
  width: 100%;
}
.ns-disable {
  align-self: flex-start;
  color: var(--action-danger);
}
</style>
