<script setup lang="ts">
/**
 * 点列表 / 全部地点弹窗（设计 03 §5，Issue #126）。
 *
 * 同一个组件两套列配置：线/面顶点表与全部地点表。规则：
 * - 有效坐标变化立即写页面唯一 specDraft（由宿主的 edit 事件完成），SVG 即时更新；
 * - 关闭弹窗不提交、也不撤销已经写入页面草稿的编辑；只有输入缓冲是半成品；
 * - 关闭时若有半成品输入，提供「继续输入 / 丢弃未生效输入并关闭」，只丢缓冲；
 * - 序号不随搜索变化；每页 50 行，顶点跳行/行深链先换页再聚焦；
 * - 背景 inert、焦点循环、Esc 与关闭按钮同义。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { X } from 'lucide-vue-next'
import { formatCoordinate, parseCoordinate, type FeatureGeometry, type LinearKind } from './feature'
import GeoFeatureBadges from './GeoFeatureBadges.vue'

export interface PointRow {
  /** 稳定键：地点 id 或顶点 0 起序号 */
  key: string
  /** 1 起的显示序号（不随搜索变化） */
  index: number
  /** 地点名称；顶点行没有 */
  name?: string
  lon: number
  lat: number
  /** 地点行携带完整要素，用于状态徽标 */
  feature?: FeatureGeometry
}

export interface EdgeRow {
  segment: number
  from: number
  to: number
}

const PAGE_SIZE = 50

const props = defineProps<{
  mode: 'places' | 'vertices'
  featureName: string
  rows: PointRow[]
  edges?: EdgeRow[]
  /** 顶点表来自未完成/继续编辑的活动形状事务时，保存提示不同 */
  draft?: boolean
  kind?: LinearKind
  disabled?: boolean
  dirty?: boolean
  /** 已校验的行定位（0 起）；hash 不匹配/越界时宿主传 null */
  linkedRow?: number | null
  /** 行定位失败的可读提示 */
  notice?: string
  /** 点数下限拒绝等宿主拒绝反馈 */
  rejectNotice?: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'edit-name', payload: { key: string, value: string }): void
  (e: 'edit-coordinate', payload: { key: string, axis: 'lon' | 'lat', value: number }): void
  (e: 'edit-vertex', payload: { rowIndex: number, axis: 'lon' | 'lat', value: number }): void
  (e: 'delete-place', payload: { key: string }): void
  (e: 'delete-vertex', payload: { rowIndex: number }): void
  (e: 'select-place', payload: { key: string }): void
  (e: 'select-vertex', payload: { rowIndex: number }): void
  (e: 'select-edge', payload: { segment: number }): void
  (e: 'insert-edge', payload: { segment: number }): void
  (e: 'append-vertex', payload: { lon: number, lat: number }): void
  (e: 'create-place', payload: { name: string, lon: number, lat: number }): void
}>()

const { t } = useI18n()
const query = ref('')
const page = ref(1)
const jumpText = ref('')
const searchInput = ref<HTMLInputElement | null>(null)
const dialog = ref<HTMLElement | null>(null)
const askDiscard = ref(false)
const buffers = ref<Record<string, string>>({})
const errors = ref<Record<string, boolean>>({})
const newPlace = ref({ name: '', lon: '', lat: '' })
const append = ref({ lon: '', lat: '' })

const filteredRows = computed(() => {
  if (props.mode !== 'places') return props.rows
  const text = query.value.trim().toLowerCase()
  return text ? props.rows.filter(row => (row.name ?? '').toLowerCase().includes(text)) : props.rows
})
const pageCount = computed(() => Math.max(1, Math.ceil(filteredRows.value.length / PAGE_SIZE)))
const pageRows = computed(() => filteredRows.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE))
const title = computed(() => (props.mode === 'places' ? t('mapStudio.editor.allPlacesTitle') : t('mapStudio.editor.pointsDialogTitle')))
const minText = computed(() => (props.kind === 'region' ? t('mapStudio.editor.minPolygonPoints') : t('mapStudio.editor.minLinePoints')))

function bufferKey(prefix: string, axis: 'lon' | 'lat'): string {
  return `${prefix}:${axis}`
}

function currentText(prefix: string, axis: 'lon' | 'lat', value: number): string {
  const buffered = buffers.value[bufferKey(prefix, axis)]
  return buffered !== undefined ? buffered : formatCoordinate(value)
}

function setBuffer(prefix: string, axis: 'lon' | 'lat', raw: string) {
  const key = bufferKey(prefix, axis)
  buffers.value = { ...buffers.value, [key]: raw }
  errors.value = { ...errors.value, [key]: parseCoordinate(axis, raw) === null && raw.trim() !== '' }
}

function hasIncompleteInput(): boolean {
  const unfinishedRows = Object.entries(buffers.value).some(([key, raw]) => parseCoordinate(key.endsWith(':lon') ? 'lon' : 'lat', raw) === null)
  const unfinishedAppend = !!(append.value.lon || append.value.lat)
  const unfinishedPlace = !!(newPlace.value.name || newPlace.value.lon || newPlace.value.lat)
  return unfinishedRows || unfinishedAppend || unfinishedPlace
}

function attemptClose() {
  if (hasIncompleteInput()) {
    askDiscard.value = true
    return
  }
  emit('close')
}

function discardAndClose() {
  buffers.value = {}
  errors.value = {}
  askDiscard.value = false
  emit('close')
}

function keepEditing() {
  askDiscard.value = false
  const [firstKey] = Object.keys(errors.value).filter(key => errors.value[key])
  if (firstKey) void nextTick(() => focusInput(firstKey))
}

function focusInput(prefix: string) {
  dialog.value?.querySelector<HTMLInputElement>(`[data-input="${prefix}"]`)?.focus()
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.stopPropagation()
    if (askDiscard.value) keepEditing()
    else attemptClose()
    return
  }
  if (event.key !== 'Tab') return
  const focusables = dialog.value?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]')
  if (!focusables || focusables.length === 0) return
  const first = focusables[0]!
  const last = focusables[focusables.length - 1]!
  const active = typeof document === 'undefined' ? null : document.activeElement
  if (event.shiftKey && (active === first || !dialog.value?.contains(active as Node))) {
    last.focus()
    event.preventDefault()
  } else if (!event.shiftKey && active === last) {
    first.focus()
    event.preventDefault()
  }
}

/** 坐标提交：合法且与当前值不同才发事件；半成品留在缓冲里 */
function commit(axis: 'lon' | 'lat', raw: string, rowKey: string, rowIndex: number, current: number, mode: 'place' | 'vertex') {
  const value = parseCoordinate(axis, raw)
  if (value === null || value === current) return
  if (mode === 'place') emit('edit-coordinate', { key: rowKey, axis, value })
  else emit('edit-vertex', { rowIndex, axis, value })
}

function onCoordInput(row: PointRow, axis: 'lon' | 'lat', mode: 'place' | 'vertex', event: Event) {
  const target = event.target
  if (!(target instanceof HTMLInputElement)) return
  setBuffer(row.key, axis, target.value)
  commit(axis, target.value, row.key, row.index - 1, axis === 'lon' ? row.lon : row.lat, mode)
  if (parseCoordinate(axis, target.value) !== null) {
    const key = bufferKey(row.key, axis)
    delete buffers.value[key]
    delete errors.value[key]
  }
}

function onNameInput(row: PointRow, event: Event) {
  const target = event.target
  if (!(target instanceof HTMLInputElement)) return
  emit('edit-name', { key: row.key, value: target.value })
}

function onAppendInput(axis: 'lon' | 'lat', event: Event) {
  const target = event.target
  if (!(target instanceof HTMLInputElement)) return
  append.value = { ...append.value, [axis]: target.value }
}

function onNewPlaceInput(field: 'name' | 'lon' | 'lat', event: Event) {
  const target = event.target
  if (!(target instanceof HTMLInputElement)) return
  newPlace.value = { ...newPlace.value, [field]: target.value }
}

function commitNewPlace() {
  const lon = parseCoordinate('lon', newPlace.value.lon)
  const lat = parseCoordinate('lat', newPlace.value.lat)
  if (lon === null || lat === null) return
  emit('create-place', { name: newPlace.value.name.trim(), lon, lat })
  newPlace.value = { name: '', lon: '', lat: '' }
}

function commitAppend() {
  const lon = parseCoordinate('lon', append.value.lon)
  const lat = parseCoordinate('lat', append.value.lat)
  if (lon === null || lat === null) return
  emit('append-vertex', { lon, lat })
  append.value = { lon: '', lat: '' }
  void nextTick(() => focusInput('append:lon'))
}

function goToPage(next: number) {
  page.value = Math.min(pageCount.value, Math.max(1, next))
}

function jumpToRow() {
  const row = Number(jumpText.value)
  if (!Number.isInteger(row) || row < 1 || row > props.rows.length) return
  const target = props.rows[row - 1]!
  const filtered = props.mode === 'places' ? filteredRows.value.findIndex(item => item.key === target.key) : row - 1
  if (filtered < 0) return
  page.value = Math.floor(filtered / PAGE_SIZE) + 1
  emit('select-vertex', { rowIndex: row - 1 })
  void nextTick(() => focusInput(props.mode === 'places' ? `row:${target.key}` : `${target.key}:lon`))
}

function goToLinkedRow() {
  if (props.linkedRow === undefined || props.linkedRow === null) return
  const row = props.rows[props.linkedRow]
  if (!row) return
  const filtered = filteredRows.value.findIndex(item => item.key === row.key)
  const index = filtered >= 0 ? filtered : props.linkedRow
  page.value = Math.floor(index / PAGE_SIZE) + 1
  void nextTick(() => focusInput(props.mode === 'places' ? `row:${row.key}` : `${row.key}:lon`))
}

watch(() => props.linkedRow, () => goToLinkedRow())
watch(() => props.mode, () => {
  buffers.value = {}
  errors.value = {}
  page.value = 1
  void nextTick(() => goToLinkedRow())
})
watch(pageCount, total => { if (page.value > total) page.value = total })
nextTick(() => {
  if (props.mode === 'places') searchInput.value?.focus()
  else if (!props.rows.length) focusInput('append:lon')
  else dialog.value?.querySelector<HTMLButtonElement>('.geo-dialog-close')?.focus()
  goToLinkedRow()
})
defineExpose({ hasIncompleteInput })
</script>

<template>
  <div class="geo-dialog-overlay" @click.self="attemptClose">
    <div
      ref="dialog"
      class="geo-dialog"
      role="dialog"
      aria-modal="true"
      :aria-label="title"
      tabindex="-1"
      @keydown="onKeydown"
    >
      <header class="geo-dialog-head">
        <strong>{{ title }}</strong>
        <span class="geo-dialog-sub">{{ featureName }}</span>
        <span v-if="linkedRow !== undefined && linkedRow !== null" class="geo-dialog-linked">{{ t('mapStudio.editor.linkedRow', { n: linkedRow + 1 }) }}</span>
        <button type="button" class="geo-tool geo-dialog-close" :aria-label="t('mapStudio.editor.closeDialog')" @click="attemptClose">
          <X :size="12" />
          {{ t('mapStudio.editor.closeDialog') }}
        </button>
      </header>

      <p v-if="notice" class="geo-dialog-notice">{{ notice }}</p>
      <p v-if="rejectNotice" class="geo-dialog-reject" role="alert">{{ rejectNotice }}</p>
      <p class="geo-dialog-hint">{{ draft ? t('mapStudio.editor.dialogDraftHint') : t('mapStudio.editor.dialogSavedHint') }}</p>
      <p v-if="Object.values(errors).some(Boolean)" class="geo-dialog-reject" role="alert">{{ t('mapStudio.editor.coordinateRange') }}</p>

      <div class="geo-dialog-tools">
        <label v-if="mode === 'places'" class="geo-dialog-search">
          <span>{{ t('mapStudio.editor.searchPlaces') }}</span>
          <input ref="searchInput" v-model="query" class="input" type="search" :placeholder="t('mapStudio.editor.searchPlaces')" @input="page = 1" />
        </label>
        <label v-else class="geo-dialog-search">
          <span>{{ t('mapStudio.editor.jumpRow') }}</span>
          <input v-model="jumpText" class="input" type="number" min="1" :max="rows.length" @keydown.enter.prevent="jumpToRow" />
          <button type="button" class="geo-tool" :disabled="disabled" @click="jumpToRow">{{ t('mapStudio.editor.jumpRowGo') }}</button>
        </label>
        <span class="geo-dialog-count">{{ t('mapStudio.editor.rowsCount', { n: filteredRows.length }) }}</span>
      </div>

      <div class="geo-dialog-body">
        <table v-if="mode === 'places'" class="geo-dialog-table">
          <thead>
            <tr>
              <th>{{ t('mapStudio.editor.columnIndex') }}</th>
              <th>{{ t('mapStudio.editor.columnName') }}</th>
              <th>{{ t('mapStudio.editor.columnLon') }}</th>
              <th>{{ t('mapStudio.editor.columnLat') }}</th>
              <th>{{ t('mapStudio.editor.columnActions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in pageRows" :key="row.key" :class="{ 'is-error': errors[`${row.key}:lon`] || errors[`${row.key}:lat`] }">
              <td class="geo-dialog-index">{{ row.index }}</td>
              <td>
                <input class="input" :data-input="`row:${row.key}`" :value="row.name ?? ''" :disabled="disabled" :placeholder="t('mapStudio.editor.name')" @input="onNameInput(row, $event)" />
                <GeoFeatureBadges v-if="row.feature" :feature="row.feature" />
              </td>
              <td>
                <input class="input geo-dialog-coord" :data-input="`${row.key}:lon`" :value="currentText(row.key, 'lon', row.lon)" :disabled="disabled" @input="onCoordInput(row, 'lon', 'place', $event)" />
              </td>
              <td>
                <input class="input geo-dialog-coord" :data-input="`${row.key}:lat`" :value="currentText(row.key, 'lat', row.lat)" :disabled="disabled" @input="onCoordInput(row, 'lat', 'place', $event)" />
              </td>
              <td class="geo-dialog-actions">
                <button type="button" class="geo-tool" :disabled="disabled" @click="emit('select-place', { key: row.key })">{{ t('mapStudio.editor.selectRow') }}</button>
                <button type="button" class="geo-del" :disabled="disabled" :aria-label="t('mapStudio.editor.deletePlaceLabel', { name: row.name || row.key })" @click="emit('delete-place', { key: row.key })">
                  <X :size="12" />
                </button>
              </td>
            </tr>
          </tbody>
        </table>

        <table v-else class="geo-dialog-table">
          <thead>
            <tr>
              <th>{{ t('mapStudio.editor.columnIndex') }}</th>
              <th>{{ t('mapStudio.editor.columnLon') }}</th>
              <th>{{ t('mapStudio.editor.columnLat') }}</th>
              <th>{{ t('mapStudio.editor.columnActions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in pageRows" :key="row.key" :class="{ 'is-error': errors[`${row.key}:lon`] || errors[`${row.key}:lat`] }">
              <td class="geo-dialog-index">{{ row.index }}</td>
              <td>
                <input class="input geo-dialog-coord" :data-input="`${row.key}:lon`" :value="currentText(row.key, 'lon', row.lon)" :disabled="disabled" @input="onCoordInput(row, 'lon', 'vertex', $event)" />
              </td>
              <td>
                <input class="input geo-dialog-coord" :data-input="`${row.key}:lat`" :value="currentText(row.key, 'lat', row.lat)" :disabled="disabled" @input="onCoordInput(row, 'lat', 'vertex', $event)" />
              </td>
              <td class="geo-dialog-actions">
                <button type="button" class="geo-tool" :disabled="disabled" @click="emit('select-vertex', { rowIndex: row.index - 1 })">{{ t('mapStudio.editor.selectRow') }}</button>
                <button type="button" class="geo-del" :disabled="disabled" :aria-label="t('mapStudio.editor.deleteVertexOfFeature', { name: featureName, n: row.index })" @click="emit('delete-vertex', { rowIndex: row.index - 1 })">
                  <X :size="12" />
                </button>
              </td>
            </tr>
          </tbody>
        </table>

        <div v-if="mode === 'vertices' && edges && edges.length" class="geo-dialog-edges">
          <strong>{{ t('mapStudio.editor.edgeListTitle') }}</strong>
          <ul class="geo-dialog-edge-items">
            <li v-for="edge in edges" :key="edge.segment" class="geo-dialog-edge">
              <span>{{ t('mapStudio.editor.edgeRow', { n: edge.segment + 1, from: edge.from, to: edge.to }) }}</span>
              <button type="button" class="geo-tool" :disabled="disabled" @click="emit('select-edge', { segment: edge.segment })">{{ t('mapStudio.editor.selectRow') }}</button>
              <button type="button" class="geo-tool" :disabled="disabled" @click="emit('insert-edge', { segment: edge.segment })">{{ t('mapStudio.editor.insertOnEdge') }}</button>
            </li>
          </ul>
        </div>

        <div v-if="mode === 'vertices'" class="geo-dialog-append">
          <strong>{{ t('mapStudio.editor.appendVertex') }}</strong>
          <span class="dim">{{ minText }}</span>
          <label class="geo-dialog-field">
            <span>{{ t('mapStudio.editor.lon') }}</span>
            <input class="input geo-dialog-coord" :data-input="'append:lon'" :value="append.lon" :disabled="disabled" @input="onAppendInput('lon', $event)" />
          </label>
          <label class="geo-dialog-field">
            <span>{{ t('mapStudio.editor.lat') }}</span>
            <input class="input geo-dialog-coord" :data-input="'append:lat'" :value="append.lat" :disabled="disabled" @input="onAppendInput('lat', $event)" />
          </label>
          <button type="button" class="geo-tool" :disabled="disabled || parseCoordinate('lon', append.lon) === null || parseCoordinate('lat', append.lat) === null" @click="commitAppend">
            {{ t('mapStudio.editor.appendVertexAction') }}
          </button>
        </div>

        <div v-if="mode === 'places'" class="geo-dialog-append">
          <strong>{{ t('mapStudio.editor.newPlace') }}</strong>
          <label class="geo-dialog-field">
            <span>{{ t('mapStudio.editor.name') }}</span>
            <input class="input" :data-input="'new:name'" :value="newPlace.name" :disabled="disabled" @input="onNewPlaceInput('name', $event)" />
          </label>
          <label class="geo-dialog-field">
            <span>{{ t('mapStudio.editor.lon') }}</span>
            <input class="input geo-dialog-coord" :data-input="'new:lon'" :value="newPlace.lon" :disabled="disabled" @input="onNewPlaceInput('lon', $event)" />
          </label>
          <label class="geo-dialog-field">
            <span>{{ t('mapStudio.editor.lat') }}</span>
            <input class="input geo-dialog-coord" :data-input="'new:lat'" :value="newPlace.lat" :disabled="disabled" @input="onNewPlaceInput('lat', $event)" />
          </label>
          <button type="button" class="geo-tool" :disabled="disabled || parseCoordinate('lon', newPlace.lon) === null || parseCoordinate('lat', newPlace.lat) === null" @click="commitNewPlace">
            {{ t('mapStudio.editor.newPlaceAction') }}
          </button>
        </div>
      </div>

      <footer class="geo-dialog-foot">
        <div class="geo-dialog-pager">
          <button type="button" class="geo-tool" :disabled="page <= 1" @click="goToPage(page - 1)">{{ t('mapStudio.editor.pagePrev') }}</button>
          <span>{{ t('mapStudio.editor.pageStatus', { page, total: pageCount }) }}</span>
          <button type="button" class="geo-tool" :disabled="page >= pageCount" @click="goToPage(page + 1)">{{ t('mapStudio.editor.pageNext') }}</button>
        </div>
        <div v-if="askDiscard" class="geo-dialog-discard">
          <span role="alert">{{ t('mapStudio.editor.discardInputPrompt') }}</span>
          <button type="button" class="geo-tool" @click="keepEditing">{{ t('mapStudio.editor.continueEditing') }}</button>
          <button type="button" class="geo-tool" @click="discardAndClose">{{ t('mapStudio.editor.discardInputClose') }}</button>
        </div>
        <span class="geo-dialog-status">{{ draft ? t('mapStudio.editor.dialogDraftHint') : dirty ? t('mapStudio.editor.draftStatus') : t('mapStudio.editor.dialogSavedHint') }}</span>
        <button type="button" class="geo-tool geo-dialog-done" @click="attemptClose">{{ t('mapStudio.editor.closeDialog') }}</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.geo-dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.42);
  padding: 16px;
}
.geo-dialog {
  width: min(760px, calc(100vw - 32px));
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  gap: 6px;
  border-radius: 10px;
  border: 1px solid var(--border-strong);
  background: var(--bg-1);
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.3);
  padding: 10px 12px;
  overflow: hidden;
}
@media (max-width: 640px) {
  .geo-dialog-overlay { padding: 0; }
  .geo-dialog { width: 100vw; max-height: 100vh; height: 100vh; border-radius: 0; }
}
.geo-dialog-head { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.geo-dialog-sub { color: var(--text-2); font-size: 11px; }
.geo-dialog-linked { padding: 1px 6px; border-radius: 999px; border: 1px solid var(--accent-text); color: var(--accent-text); font: 600 10px var(--font-body); }
.geo-dialog-close { margin-left: auto; }
.geo-dialog-notice, .geo-dialog-reject { margin: 0; padding: 4px 8px; border-radius: 6px; font: 600 10.5px var(--font-body); }
.geo-dialog-notice { background: var(--accent-soft, var(--warn-bg)); color: var(--text-1); border: 1px solid var(--border); }
.geo-dialog-reject { background: var(--warn-bg); border: 1px solid var(--warn-border); color: var(--warn-text); }
.geo-dialog-hint { margin: 0; font-size: 10.5px; color: var(--text-2); }
.geo-dialog-tools { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 10.5px; color: var(--text-2); }
.geo-dialog-search { display: inline-flex; align-items: center; gap: 4px; }
.geo-dialog-count { margin-left: auto; }
.geo-dialog-body { overflow: auto; flex: 1; min-height: 80px; display: flex; flex-direction: column; gap: 8px; }
.geo-dialog-table { width: 100%; border-collapse: collapse; font-size: 10.5px; }
.geo-dialog-table th { text-align: left; padding: 3px 4px; color: var(--text-2); font-weight: 600; border-bottom: 1px solid var(--border); }
.geo-dialog-table td { padding: 3px 4px; border-bottom: 1px solid var(--border); vertical-align: top; }
.geo-dialog-table tr.is-error { background: var(--warn-bg); }
.geo-dialog-index { width: 36px; color: var(--text-2); font: 500 10px var(--font-mono, var(--font-body)); }
.geo-dialog-coord { width: 110px; }
.geo-dialog-actions { display: inline-flex; align-items: center; gap: 4px; }
.geo-del { display: inline-flex; align-items: center; justify-content: center; min-width: 44px; min-height: 44px; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--bg-1); color: var(--text-2); cursor: pointer; }
.geo-dialog-edges { display: flex; flex-direction: column; gap: 3px; }
.geo-dialog-edge-items { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.geo-dialog-edge { display: flex; align-items: center; gap: 6px; font-size: 10.5px; }
.geo-dialog-append { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; font-size: 10.5px; }
.geo-dialog-field { display: inline-flex; align-items: center; gap: 3px; }
.geo-dialog-foot { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; border-top: 1px solid var(--border); padding-top: 6px; }
.geo-dialog-pager { display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; }
.geo-dialog-discard { display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; color: var(--warn-text); }
.geo-dialog-status { margin-left: auto; font-size: 10.5px; color: var(--text-2); }
.geo-dialog-done { min-height: 32px; }
</style>
