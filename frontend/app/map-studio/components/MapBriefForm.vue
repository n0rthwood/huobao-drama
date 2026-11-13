<template>
  <div class="brief">
    <div class="brief-grid">
      <label v-for="field in TEXT_FIELDS" :key="field" class="brief-field">
        <span class="brief-label">
          {{ t(`mapStudio.brief.${field}`) }}
          <span v-if="inferredOf(field)" class="brief-inferred" :title="inferredOf(field)?.basis">
            {{ t('mapStudio.brief.inferredBadge', { confidence: t(`mapStudio.brief.confidence.${inferredOf(field)?.confidence}`) }) }}
          </span>
        </span>
        <input
          class="input"
          :value="brief[field]"
          :disabled="disabled"
          :placeholder="t(`mapStudio.brief.${field}Placeholder`)"
          @input="patchText(field, $event)"
        />
        <span v-if="inferredOf(field)" class="brief-basis dim">{{ t('mapStudio.brief.inferredBasis', { basis: inferredOf(field)?.basis }) }}</span>
        <span v-for="issue in issuesOf(field)" :key="issue.code" :class="['brief-issue', issue.blocking ? 'is-blocking' : 'is-soft']">{{ issue.message }}</span>
      </label>
    </div>

    <div class="brief-grid">
      <label class="brief-field">
        <span class="brief-label">{{ t('mapStudio.brief.detailLevel') }}</span>
        <select class="input" :value="brief.detail_level" :disabled="disabled" @change="patchSelect('detail_level', $event)">
          <option v-for="level in DETAIL_LEVELS" :key="level" :value="level">{{ t(`mapStudio.brief.detail.${level}`) }}</option>
        </select>
        <span class="brief-basis dim">{{ t('mapStudio.brief.detailLevelHint') }}</span>
      </label>
      <label class="brief-field">
        <span class="brief-label">{{ t('mapStudio.brief.style') }}</span>
        <select class="input" :value="brief.style" :disabled="disabled" @change="patchSelect('style', $event)">
          <option v-for="style in STYLES" :key="style" :value="style">{{ t(`mapStudio.brief.styleOption.${style}`) }}</option>
        </select>
        <span class="brief-basis dim">{{ t('mapStudio.brief.styleHint') }}</span>
      </label>
      <label class="brief-field brief-check">
        <input type="checkbox" :checked="brief.schematic" :disabled="disabled" @change="patchCheckbox($event)" />
        <span>
          <span class="brief-label">{{ t('mapStudio.brief.schematic') }}</span>
          <span class="brief-basis dim">{{ t('mapStudio.brief.schematicHint') }}</span>
        </span>
      </label>
    </div>

    <section class="brief-modes">
      <span class="brief-label">{{ t('mapStudio.brief.baseMode') }}</span>
      <div class="brief-mode-cards">
        <button
          v-for="mode in BASE_MODES"
          :key="mode"
          type="button"
          class="brief-mode"
          :class="{ 'is-on': brief.base_mode === mode }"
          :aria-pressed="brief.base_mode === mode"
          :disabled="disabled"
          @click="emit('patch', { base_mode: mode })"
        >
          <strong>{{ t(`mapStudio.baseMode.${mode}`) }}</strong>
          <span class="brief-basis">{{ t(`mapStudio.baseModeHint.${mode}`) }}</span>
        </button>
      </div>
      <span v-for="issue in issuesOf('base_mode')" :key="issue.code" :class="['brief-issue', issue.blocking ? 'is-blocking' : 'is-soft']">{{ issue.message }}</span>
    </section>

    <MapCalibration
      v-if="brief.base_mode === 'image'"
      :reference="brief.reference_image"
      :disabled="disabled"
      @update="emit('patch', { reference_image: $event })"
    />
    <p v-else-if="brief.base_mode === 'earth'" class="brief-note">{{ t('mapStudio.brief.earthNote') }}</p>
    <p v-else class="brief-note">{{ t('mapStudio.brief.programNote') }}</p>
    <span v-for="issue in issuesOf('reference_image')" :key="issue.code" :class="['brief-issue', issue.blocking ? 'is-blocking' : 'is-soft']">{{ issue.message }}</span>

    <label class="brief-field">
      <span class="brief-label">{{ t('mapStudio.brief.notes') }}</span>
      <textarea
        class="textarea brief-notes"
        rows="3"
        :value="brief.notes"
        :disabled="disabled"
        :placeholder="t('mapStudio.brief.notesPlaceholder')"
        @input="patchNotes($event)"
      />
    </label>

    <p v-for="issue in otherIssues" :key="issue.code" :class="['brief-issue', issue.blocking ? 'is-blocking' : 'is-soft']">
      {{ issue.field ? `${issue.field} · ${issue.message}` : issue.message }}
    </p>
  </div>
</template>

<script setup lang="ts">
/**
 * 地图任务说明（brief）表单（Issue #84）。
 *
 * 这是整条工作流的输入口径：对象 / 年代 / 地域 / 用途四项不足就推不动后面的考证与底图，
 * 所以 AI 推断出来的值标成「推断」并附依据，缺口由后端以 issues 的形式给出可执行解释，人改完再复核。
 */
import { useI18n } from 'vue-i18n'
import MapCalibration from '~/map-studio/components/MapCalibration.vue'
import type { MapBaseMode, MapBrief, MapStyleTheme, MapStudioIssue } from '~/map-studio/api'

const { t } = useI18n()

const props = defineProps<{
  brief: MapBrief
  issues: MapStudioIssue[]
  disabled?: boolean
}>()

const emit = defineEmits<{ (e: 'patch', patch: Partial<MapBrief>): void }>()

type TextField = 'subject' | 'era' | 'location' | 'purpose'
const TEXT_FIELDS: TextField[] = ['subject', 'era', 'location', 'purpose']
const DETAIL_LEVELS: Array<MapBrief['detail_level']> = ['overview', 'regional', 'site']
const STYLES: MapStyleTheme[] = ['archival', 'clean', 'ink']
const BASE_MODES: MapBaseMode[] = ['program', 'earth', 'image']
const FIELD_NAMES = new Set<string>([...TEXT_FIELDS, 'detail_level', 'style', 'schematic', 'base_mode', 'reference_image', 'notes'])

function inferredOf(field: string) {
  return props.brief.inferred.find(item => item.field === field) ?? null
}

function issuesOf(field: string) {
  return props.issues.filter(issue => issue.field === field)
}

/** 不属于任何表单字段的问题（如研究阶段整体缺证据）也必须显示，不能被吞掉 */
const otherIssues = computed(() => props.issues.filter(issue => !FIELD_NAMES.has(issue.field)))

function patchText(field: TextField, event: Event) {
  const target = event.target
  if (!(target instanceof HTMLInputElement)) return
  const patch: Partial<MapBrief> = {}
  patch[field] = target.value
  emit('patch', patch)
}

function patchSelect(field: 'detail_level' | 'style', event: Event) {
  const target = event.target
  if (!(target instanceof HTMLSelectElement)) return
  if (field === 'style') emit('patch', { style: target.value as MapStyleTheme })
  else emit('patch', { detail_level: target.value as MapBrief['detail_level'] })
}

function patchCheckbox(event: Event) {
  const target = event.target
  if (target instanceof HTMLInputElement) emit('patch', { schematic: target.checked })
}

function patchNotes(event: Event) {
  const target = event.target
  if (target instanceof HTMLTextAreaElement) emit('patch', { notes: target.value })
}
</script>

<style scoped>
.brief { display: flex; flex-direction: column; gap: 10px; }
.brief-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 8px;
}
.brief-field { display: flex; flex-direction: column; gap: 3px; font-size: 10.5px; color: var(--text-2); }
.brief-label { font: 600 11px var(--font-body); color: var(--text-1); display: inline-flex; align-items: center; gap: 6px; }
.brief-basis { font-size: 10px; }
.brief-check { flex-direction: row; align-items: flex-start; gap: 6px; }
.brief-check > span { display: flex; flex-direction: column; gap: 2px; }
.brief-notes { min-height: 64px; width: 100%; }
.brief-inferred {
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--warn-bg);
  border: 1px solid var(--warn-border);
  color: var(--warn-text);
  font: 600 10px var(--font-body);
}
.brief-issue {
  padding: 3px 7px;
  border-radius: 6px;
  font: 600 10.5px var(--font-body);
}
.brief-issue.is-blocking { background: var(--warn-bg); border: 1px solid var(--warn-border); color: var(--warn-text); }
.brief-issue.is-soft { color: var(--text-2); }
.brief-note { margin: 0; font-size: 10.5px; color: var(--text-2); }
.brief-modes { display: flex; flex-direction: column; gap: 6px; }
.brief-mode-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 320px));
  gap: 8px;
}
.brief-mode {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px 10px;
  text-align: left;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--surface-soft);
  color: var(--text-2);
  cursor: pointer;
  font: 400 10.5px var(--font-body);
}
.brief-mode strong { font: 600 11.5px var(--font-body); color: var(--text-1); }
.brief-mode.is-on { border-color: var(--accent-text); color: var(--accent-text); }
.brief-mode.is-on strong { color: var(--accent-text); }
.brief-mode:disabled { opacity: 0.6; cursor: not-allowed; }
</style>
