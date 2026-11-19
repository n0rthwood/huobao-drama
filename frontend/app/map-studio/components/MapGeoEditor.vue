<script setup lang="ts">
/**
 * Issue #126：页面唯一草稿的几何编辑入口。
 * 普通地点/顶点编辑立即 cloneSpec → markManual → update；仅活动形状保留局部事务。
 * 本组件从不写 API。完成编辑仅收尾事务；页面「保存几何」才是唯一 CAS 持久化动作。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { DEEPLINK_KEYS, useDeeplink } from '~/composables/useQuerySync'
import type { MapFeatureMetadata, MapPlace, MapRegion, MapRoute, MapSpec } from '~/map-studio/api'
import { geoToPixel, registrationSummary, type MapRegistration } from '~/map-studio/utils/mapRegistration'
import { deviationProblems, insertVertex, smoothKeyFor, smoothPoints } from '~/map-studio/utils/smooth'
import { mediaUrl } from '~/utils/url'
import GeoCanvas, { type CanvasShape, type CanvasCandidate } from './geo/GeoCanvas.vue'
import GeoFeatureBadges from './geo/GeoFeatureBadges.vue'
import GeoPointDialog, { type PointRow } from './geo/GeoPointDialog.vue'
import GeoSmoothWarning from './geo/GeoSmoothWarning.vue'
import { DEFAULT_VIEW, normalizeView, type GeoView } from './geo/coords'
import { featureGeometryHash } from './geo/canonical'
import { coordinateMidpoint, featureCoordinates, isDatasetMissing, isGeometryUnverified, isClosedRing, minVertices, parseCoordinate, segmentCount, vertexCount, type FeatureKind, type LinearKind } from './geo/feature'

type LayerOptions = Record<string, { smooth: number }>
type GeoTab = 'point' | 'line' | 'region'
type Target = { kind: FeatureKind; id: string }
type ShapeDraft = { kind: LinearKind; id: string | null; points: Array<[number, number]> }
type DialogState = { mode: 'places' | 'vertices'; kind?: LinearKind; id?: string | null; draft: boolean; row: number | null; notice: string }
const props = withDefaults(defineProps<{
  spec: MapSpec
  persistedSpec: MapSpec | null
  registration: MapRegistration | null
  baseImage: { path: string; width: number; height: number } | null
  layerDoc?: { layers: Array<{ id: string; type: string; anchor?: { semantic_id?: string } }> } | null
  layerOptions?: LayerOptions
  disabled?: boolean
  focusTarget?: Target | null
}>(), { layerDoc: null, layerOptions: () => ({}), disabled: false })
const emit = defineEmits<{
  (e: 'update', spec: MapSpec): void
  (e: 'layer-options', options: LayerOptions): void
  (e: 'base-size', size: { width: number; height: number }): void
}>()
const { t } = useI18n()
const root = ref<HTMLElement | null>(null)
const dialogRef = ref<InstanceType<typeof GeoPointDialog> | null>(null)
const tab = ref<GeoTab>('point')
const tool = ref<'select' | 'draw' | 'pan'>('select')
const selected = ref<Target | null>(null)
const memories: Record<GeoTab, Target | null> = { point: null, line: null, region: null }
const selectedVertex = ref<{ kind: LinearKind; id: string; index: number } | null>(null)
const selectedEdge = ref<{ kind: LinearKind; id: string; segment: number } | null>(null)
const view = ref<GeoView>({ ...DEFAULT_VIEW })
const cursorGeo = ref<[number, number] | null>(null)
const draft = ref<ShapeDraft | null>(null)
const dialog = ref<DialogState | null>(null)
const tabPrompt = ref<{ target: GeoTab; reason: 'shape' | 'input' } | null>(null)
const overlap = ref<CanvasCandidate[]>([])
const placeBuffers = ref<Record<string, string>>({})
const placeDraft = ref<{ name: string; lon: string; lat: string } | null>(null)
const rejectNotice = ref('')
const naturalSize = ref({ width: 0, height: 0 })
const enlarged = ref(false)
const canvasShare = ref(65)
const listCollapsed = ref(false)
const listElement = ref<HTMLElement | null>(null)
const scrollMemory: Record<GeoTab, number> = { point: 0, line: 0, region: 0 }
const smoothingTouched = ref<string[]>([])
const TABS: GeoTab[] = ['point', 'line', 'region']
const TOOLS = ['select', 'draw', 'pan'] as const
const link = useDeeplink('mapStudioGeo', DEEPLINK_KEYS.mapStudioGeo)
let viewTimer: ReturnType<typeof setTimeout> | null = null
let returnFocus: HTMLElement | null = null
function toggleEnlarged() {
  enlarged.value = !enlarged.value
  if (!enlarged.value) focusSelector('.geo-enlarge')
}

function tabFor(kind: FeatureKind): GeoTab {
  return kind === 'place' ? 'point' : kind === 'route' ? 'line' : 'region'
}
function kindFor(value: GeoTab): FeatureKind {
  return value === 'point' ? 'place' : value === 'line' ? 'route' : 'region'
}
function listOf(spec: MapSpec | null, kind: FeatureKind): Array<MapPlace | MapRoute | MapRegion> {
  return kind === 'place' ? spec?.places ?? [] : kind === 'route' ? spec?.routes ?? [] : spec?.regions ?? []
}
function featureOf(spec: MapSpec | null, target: Target) {
  return listOf(spec, target.kind).find(item => item.id === target.id)
}
function parseTarget(raw: string | null): Target | null {
  const match = /^(place|route|region):(.+)$/.exec(raw ?? '')
  return match ? { kind: match[1] as FeatureKind, id: match[2]! } : null
}
function tabLabel(value: GeoTab): string {
  return t(`mapStudio.editor.tab${value[0]!.toUpperCase()}${value.slice(1)}`)
}
function coordinateDirty(target: Target): boolean {
  const saved = featureOf(props.persistedSpec, target)
  const current = featureOf(props.spec, target)
  if (!saved || !current) return true
  if (draft.value?.kind === target.kind && draft.value.id === target.id) return true
  return JSON.stringify(featureCoordinates(saved)) !== JSON.stringify(featureCoordinates(current))
}
function syncLinks() {
  if (viewTimer) { clearTimeout(viewTimer); viewTimer = null }
  const values: Record<string, string> = {}
  if (tab.value !== 'point') values.msgtab = tab.value
  if (view.value.zoom !== 1 || view.value.cx !== 0.5 || view.value.cy !== 0.5) {
    values.msgzoom = String(view.value.zoom)
    values.msgcx = String(view.value.cx)
    values.msgcy = String(view.value.cy)
  }
  if (selected.value && featureOf(props.persistedSpec, selected.value)) values.msgeo = `${selected.value.kind}:${selected.value.id}`
  const current = dialog.value
  if (current?.mode === 'places') values.msgpoints = 'all'
  else if (current?.kind && current.id) {
    const target = { kind: current.kind, id: current.id }
    const saved = featureOf(props.persistedSpec, target)
    if (saved) {
      values.msgpoints = `${target.kind}:${target.id}`
      if (current.row !== null && !coordinateDirty(target)) {
        const hash = featureGeometryHash(saved)
        if (hash) { values.msgrow = String(current.row + 1); values.msggeorev = hash }
      }
    }
  }
  link.set(values)
}
function changeView(next: GeoView) {
  view.value = next
  if (!viewTimer) viewTimer = setTimeout(syncLinks, 120)
}

// 恢复只改 UI：先校验已保存实体与坐标 hash，再创建行；初次进入及前进/后退复用同一入口。
let pendingNavigation: URLSearchParams | null = null
function restoreUi(query: { get(key: string): string | null }) {
  selected.value = null
  selectedVertex.value = null
  selectedEdge.value = null
  dialog.value = null
  const rawTab = query.get('msgtab')
  tab.value = rawTab && TABS.includes(rawTab as GeoTab) ? rawTab as GeoTab : 'point'
  const target = parseTarget(query.get('msgeo'))
  if (target) {
    if (featureOf(props.persistedSpec, target)) {
      selected.value = target
      tab.value = tabFor(target.kind)
      memories[tab.value] = target
    } else toast.warning(t('mapStudio.editor.entityMissing'))
  }
  const rawZoom = query.get('msgzoom')
  const normalized = normalizeView({ zoom: rawZoom ?? 1, cx: query.get('msgcx'), cy: query.get('msgcy') })
  view.value = normalized.view
  if (rawZoom && normalized.adjustedZoom) toast.warning(t('mapStudio.editor.zoomAdjusted', { zoom: Math.round(view.value.zoom * 100) }))
  const points = query.get('msgpoints')
  if (points === 'all') {
    tab.value = 'point'
    if (selected.value?.kind !== 'place') selected.value = null
    dialog.value = { mode: 'places', draft: false, row: null, notice: '' }
  } else if (points) {
    const entity = parseTarget(points)
    if (entity && entity.kind !== 'place') {
      tab.value = tabFor(entity.kind)
      const saved = featureOf(props.persistedSpec, entity)
      if (saved && 'points' in saved) {
        selected.value = entity
        memories[tab.value] = entity
        const row = Number(query.get('msgrow'))
        const valid = Number.isInteger(row) && row >= 1 && row <= vertexCount(entity.kind, saved.points)
          && query.get('msggeorev') === featureGeometryHash(saved) && !coordinateDirty(entity)
        dialog.value = { mode: 'vertices', kind: entity.kind, id: entity.id, draft: false, row: valid ? row - 1 : null, notice: query.get('msgrow') && !valid ? t('mapStudio.editor.rowLost') : '' }
        if (valid) selectedVertex.value = { kind: entity.kind, id: entity.id, index: row - 1 }
      } else toast.warning(t('mapStudio.editor.entityMissing'))
    } else toast.warning(t('mapStudio.editor.entityMissing'))
  }
  syncLinks()
}
restoreUi({ get: key => link.initial(key) })

function onHistoryNavigation() {
  const query = new URLSearchParams(window.location.search)
  if (dialogRef.value?.hasIncompleteInput()) {
    focusPendingInput()
    syncLinks()
    return
  }
  if (draft.value || placeDraft.value || hasInlineIncomplete()) {
    const entity = parseTarget(query.get('msgpoints')) ?? parseTarget(query.get('msgeo'))
    dialog.value = null
    const next = query.get('msgtab')
    pendingNavigation = query
    tabPrompt.value = { target: entity ? tabFor(entity.kind) : TABS.includes(next as GeoTab) ? next as GeoTab : 'point', reason: draft.value ? 'shape' : 'input' }
    syncLinks()
    return
  }
  restoreUi(query)
}
function stayCurrentTab() {
  tabPrompt.value = null
  pendingNavigation = null
  syncLinks()
}
onMounted(() => window.addEventListener('popstate', onHistoryNavigation))

const baseUrl = computed(() => props.baseImage?.path ? mediaUrl(props.baseImage.path) : '')
const size = computed(() => ({ width: props.registration?.width || props.baseImage?.width || naturalSize.value.width, height: props.registration?.height || props.baseImage?.height || naturalSize.value.height }))
const activeKind = computed(() => kindFor(tab.value))
const localSpecDirty = computed(() => {
  // 页面 normalizeSpec 可补 style/layers；这些不是编辑器改动，不能冒称已经加入草稿。
  const current = props.spec, saved = props.persistedSpec
  if (!saved) return !!(current.places.length || current.routes.length || current.regions.length)
  return JSON.stringify([
    current.places.map(item => [item.id, item.name, item.lon, item.lat]),
    current.routes.map(item => [item.id, item.name, item.points]),
    current.regions.map(item => [item.id, item.name, item.points]),
  ]) !== JSON.stringify([
    saved.places.map(item => [item.id, item.name, item.lon, item.lat]),
    saved.routes.map(item => [item.id, item.name, item.points]),
    saved.regions.map(item => [item.id, item.name, item.points]),
  ])
})
const activeItems = computed(() => listOf(props.spec, activeKind.value))
const linearItems = computed(() => activeKind.value === 'place' ? [] : activeItems.value as Array<MapRoute | MapRegion>)
const pendingCount = computed(() => activeItems.value.filter(isGeometryUnverified).length)
const proposedCount = computed(() => activeItems.value.filter(item => item.proposed === true).length)
const canFinish = computed(() => !!draft.value && new Set(draft.value.points.map(point => JSON.stringify(point))).size >= minVertices(draft.value.kind))
const cursorText = computed(() => !props.registration ? t('mapStudio.editor.canvasNoRegistration') : cursorGeo.value ? t('mapStudio.editor.cursor', { lon: cursorGeo.value[0].toFixed(5), lat: cursorGeo.value[1].toFixed(5) }) : t('mapStudio.editor.cursorOutside'))

const linearRows = computed(() => {
  const result = new Map<string, { attr: string; smooth: number; problems: Array<{ segment: number; deviation: number; limit: number; suggested: number }>; canPreview: boolean }>()
  for (const kind of ['route', 'region'] as const) {
    for (const shape of listOf(props.spec, kind) as Array<MapRoute | MapRegion>) {
      const count = vertexCount(kind, shape.points)
      const pixels = shape.points.slice(0, count).map(point => geoToPixel(props.registration, point[0], point[1]))
      const key = smoothKeyFor(props.layerDoc, shape.id)
      const explicit = props.layerOptions?.[key]?.smooth
      const smooth = typeof explicit === 'number' && Number.isFinite(explicit) ? explicit : shape.origin === 'dataset' ? 0 : 1
      const canPreview = !!props.registration && size.value.width > 0 && size.value.height > 0 && pixels.every(Boolean)
      const normalizedPoints = canPreview ? pixels.map(point => [point![0] / size.value.width, point![1] / size.value.height] as [number, number]) : []
      const options = { closed: kind === 'region', strength: smooth, ...size.value }
      const curve = canPreview ? smoothPoints(normalizedPoints, options) : []
      const problems = canPreview ? deviationProblems(normalizedPoints, options) : []
      result.set(`${kind}:${shape.id}`, { attr: curve.map(point => `${point[0] * size.value.width},${point[1] * size.value.height}`).join(' '), smooth, problems, canPreview })
    }
  }
  return result
})
const canvasShapes = computed<CanvasShape[]>(() => activeItems.value.filter(item => !isDatasetMissing(item)).map(item => {
  const editing = draft.value?.id === item.id ? draft.value : null
  const points: Array<[number, number]> = editing ? editing.points : 'points' in item ? item.points : [[item.lon, item.lat]]
  const pixels = points.map(point => geoToPixel(props.registration, point[0], point[1]))
  const attr = editing ? pixels.filter(Boolean).map(point => `${point![0]},${point![1]}`).join(' ') : linearRows.value.get(`${activeKind.value}:${item.id}`)?.attr ?? ''
  return { kind: activeKind.value, id: item.id, name: item.name, points, attr, dataset: !!item.dataset_ref, pending: isGeometryUnverified(item), visible: pixels.every(Boolean) }
}))
const offscreenCount = computed(() => props.registration ? canvasShapes.value.filter(shape => !shape.visible).length : 0)
const dialogPoints = computed<Array<[number, number]>>(() => {
  const current = dialog.value
  if (current?.mode !== 'vertices' || !current.kind) return []
  if (current.draft && draft.value?.kind === current.kind) return draft.value.points
  const shape = featureOf(props.spec, { kind: current.kind, id: current.id ?? '' })
  return shape && 'points' in shape ? shape.points.slice(0, vertexCount(current.kind, shape.points)) : []
})
const dialogRows = computed<PointRow[]>(() => dialog.value?.mode === 'places'
  ? props.spec.places.map((place, index) => ({ key: place.id, index: index + 1, name: place.name, lon: place.lon, lat: place.lat, feature: place }))
  : dialogPoints.value.map((point, index) => ({ key: String(index), index: index + 1, lon: point[0], lat: point[1] })))
const dialogEdges = computed(() => {
  const kind = dialog.value?.kind
  if (!kind) return []
  return Array.from({ length: segmentCount(kind, dialogPoints.value) }, (_, segment) => ({ segment, from: segment + 1, to: (segment + 1) % dialogPoints.value.length + 1 }))
})
const dialogName = computed(() => {
  if (dialog.value?.mode === 'places') return t('mapStudio.editor.placesTitle', { n: props.spec.places.length })
  if (dialog.value?.draft && !draft.value?.id) return t('mapStudio.editor.shapeInProgress', { n: draft.value?.points.length ?? 0, min: draft.value ? minVertices(draft.value.kind) : 0 })
  const current = dialog.value
  return current?.kind ? featureOf(props.spec, { kind: current.kind, id: current.id ?? '' })?.name || current.id || '' : ''
})

/** clone 保留全部未触碰元数据；只有真实坐标改变才 markManual。 */
function cloneSpec(): MapSpec {
  return JSON.parse(JSON.stringify(props.spec)) as MapSpec
}
function markManual(item: MapFeatureMetadata & { proposed?: boolean }) {
  const dataset = item.origin === 'dataset' || !!item.dataset_ref
  item.origin = 'manual'
  delete item.proposed
  delete item.dataset_ref
  item.verification = { status: 'confirmed', reasons: [t('mapStudio.editor.manualReason')] }
  if (dataset) toast.warning(t('mapStudio.editor.datasetEditWarning'))
}
function manualEntry<T extends { id: string }>(value: T): T & MapFeatureMetadata {
  return { ...value, origin: 'manual', verification: { status: 'confirmed', reasons: [t('mapStudio.editor.manualReason')] } }
}
function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}
function selectFeature(target: Target) {
  selected.value = target
  memories[tabFor(target.kind)] = target
  selectedVertex.value = null
  selectedEdge.value = null
  syncLinks()
}
function selectVertex(target: { kind: LinearKind; id: string; index: number }) {
  selected.value = { kind: target.kind, id: target.id }
  selectedVertex.value = target
  selectedEdge.value = null
  if (dialog.value?.mode === 'vertices') dialog.value.row = target.index
  syncLinks()
}
function selectEdge(target: { kind: LinearKind; id: string; segment: number } | null) {
  selectedEdge.value = target
  selectedVertex.value = null
  if (target) selected.value = { kind: target.kind, id: target.id }
  syncLinks()
}
function clearSelection() {
  selected.value = null
  selectedVertex.value = null
  selectedEdge.value = null
  syncLinks()
}
function focusSelector(selector: string) {
  void nextTick(() => root.value?.querySelector<HTMLElement>(selector)?.focus())
}
function hasInlineIncomplete(): boolean {
  return Object.entries(placeBuffers.value).some(([key, raw]) => parseCoordinate(key.endsWith(':lon') ? 'lon' : 'lat', raw) === null)
}
function applyTab(next: GeoTab) {
  scrollMemory[tab.value] = listElement.value?.scrollTop ?? 0
  tab.value = next
  tool.value = 'select'
  const remembered = memories[next]
  selected.value = remembered && featureOf(props.spec, remembered) ? remembered : null
  selectedVertex.value = null
  selectedEdge.value = null
  tabPrompt.value = null
  syncLinks()
  void nextTick(() => { if (listElement.value) listElement.value.scrollTop = scrollMemory[next] })
}
function requestTab(next: GeoTab) {
  if (next === tab.value) return
  if (draft.value) { tabPrompt.value = { target: next, reason: 'shape' }; return }
  if (hasInlineIncomplete() || placeDraft.value) { tabPrompt.value = { target: next, reason: 'input' }; return }
  applyTab(next)
}
function onTabKey(event: KeyboardEvent, index: number) {
  let next = index
  if (event.key === 'ArrowRight') next = (index + 1) % TABS.length
  else if (event.key === 'ArrowLeft') next = (index + TABS.length - 1) % TABS.length
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = TABS.length - 1
  else return
  event.preventDefault()
  root.value?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus()
}
function resolveTab(action: 'finish' | 'cancel' | 'discard') {
  const next = tabPrompt.value?.target
  if (!next) return
  if (action === 'finish' && !finishDraft()) return
  if (action === 'cancel') cancelDraft()
  if (action === 'discard') { placeBuffers.value = {}; placeDraft.value = null }
  applyTab(next)
  if (pendingNavigation) {
    const query = pendingNavigation
    pendingNavigation = null
    restoreUi(query)
  }
}
function openDialog(kind?: LinearKind, id?: string | null, row: number | null = null) {
  returnFocus = typeof document === 'undefined' ? null : document.activeElement as HTMLElement
  const isDraft = !!kind && draft.value?.kind === kind && draft.value.id === (id ?? null)
  if (kind && id) selectFeature({ kind, id })
  dialog.value = kind ? { mode: 'vertices', kind, id, draft: isDraft, row, notice: '' } : { mode: 'places', draft: false, row: null, notice: '' }
  rejectNotice.value = ''
  syncLinks()
}
function closeDialog() {
  dialog.value = null
  syncLinks()
  void nextTick(() => {
    if (returnFocus?.isConnected) returnFocus.focus()
    else root.value?.querySelector<HTMLElement>('.geo-list-head')?.focus()
  })
}
function beginShape(kind: LinearKind, id: string | null = null) {
  if (props.disabled || draft.value) return
  const existing = id ? featureOf(props.spec, { kind, id }) : null
  draft.value = { kind, id, points: existing && 'points' in existing ? existing.points.slice(0, vertexCount(kind, existing.points)).map(point => [point[0], point[1]]) : [] }
  tool.value = 'draw'
  if (id) selectFeature({ kind, id })
  if (!id) openDialog(kind, null)
  syncLinks()
}
function addCurrent() {
  if (tab.value === 'point') {
    placeDraft.value = { name: '', lon: '', lat: '' }
    focusSelector('[data-new-place="lon"]')
  } else beginShape(tab.value === 'line' ? 'route' : 'region')
}
function finishDraft(): boolean {
  const current = draft.value
  if (!current || !canFinish.value || props.disabled) return false
  const next = cloneSpec()
  const list = current.kind === 'route' ? next.routes : next.regions
  const existing = current.id ? list.find(item => item.id === current.id) : null
  let id = current.id
  if (existing) {
    const openPoints = existing.points.slice(0, vertexCount(current.kind, existing.points))
    if (JSON.stringify(openPoints) !== JSON.stringify(current.points)) {
      existing.points = current.points.map(point => [point[0], point[1]])
      markManual(existing)
      emit('update', next)
    }
  } else {
    id = newId(current.kind)
    list.push(manualEntry({ id, name: '', points: current.points.map(point => [point[0], point[1]] as [number, number]) }))
    emit('update', next)
  }
  const kind = current.kind
  draft.value = null
  tool.value = 'select'
  if (dialog.value?.draft) dialog.value = null
  if (id) selected.value = { kind, id }
  syncLinks()
  focusSelector(`[data-continue="${id}"]`)
  return true
}
function cancelDraft() {
  const current = draft.value
  draft.value = null
  if (dialog.value?.draft) dialog.value = null
  tool.value = 'select'
  syncLinks()
  focusSelector(current?.id ? `[data-continue="${current.id}"]` : '.geo-add-current')
}
function appendDraft(point: [number, number]) {
  if (props.disabled || activeKind.value === 'place') return
  if (!draft.value) draft.value = { kind: activeKind.value as LinearKind, id: null, points: [] }
  draft.value.points.push(point)
}
function addPlace(point: [number, number], name = '') {
  if (props.disabled) return
  const next = cloneSpec()
  const entry = manualEntry<MapPlace>({ id: newId('place'), name, lon: point[0], lat: point[1] })
  next.places.push(entry)
  emit('update', next)
  selectFeature({ kind: 'place', id: entry.id })
}
function createPlace(value: { name: string; lon: number; lat: number }) {
  addPlace([value.lon, value.lat], value.name)
}
function createInlinePlace() {
  const current = placeDraft.value
  if (!current) return
  const lon = parseCoordinate('lon', current.lon), lat = parseCoordinate('lat', current.lat)
  if (lon === null || lat === null) return
  addPlace([lon, lat], current.name)
  placeDraft.value = null
}
function setName(kind: FeatureKind, id: string, event: Event | string) {
  const value = typeof event === 'string' ? event : (event.target as HTMLInputElement).value
  const current = featureOf(props.spec, { kind, id })
  if (props.disabled || !current || current.name === value) return
  const next = cloneSpec()
  featureOf(next, { kind, id })!.name = value
  emit('update', next)
}
function setPlaceCoord(id: string, axis: 'lon' | 'lat', value: number) {
  const current = props.spec.places.find(item => item.id === id)
  if (props.disabled || !current || current[axis] === value) return
  const next = cloneSpec()
  const place = next.places.find(item => item.id === id)!
  place[axis] = value
  markManual(place)
  emit('update', next)
  syncLinks()
}
function onPlaceInput(id: string, axis: 'lon' | 'lat', event: Event) {
  const raw = (event.target as HTMLInputElement).value
  placeBuffers.value = { ...placeBuffers.value, [`${id}:${axis}`]: raw }
  const value = parseCoordinate(axis, raw)
  if (value !== null) setPlaceCoord(id, axis, value)
}
function moveCanvasVertex(target: { kind: FeatureKind; id: string; index: number; lon: number; lat: number }) {
  if (target.kind !== 'place') {
    moveVertex({ ...target, kind: target.kind })
    return
  }
  const next = cloneSpec()
  const place = next.places.find(item => item.id === target.id)
  if (!place || (place.lon === target.lon && place.lat === target.lat)) return
  place.lon = target.lon
  place.lat = target.lat
  markManual(place)
  emit('update', next)
}
function moveVertex(target: { kind: LinearKind; id: string; index: number; lon: number; lat: number }) {
  if (props.disabled) return
  const currentDraft = draft.value
  if (currentDraft?.kind === target.kind && currentDraft.id === target.id) {
    currentDraft.points[target.index] = [target.lon, target.lat]
    return
  }
  const next = cloneSpec()
  const shape = featureOf(next, target)
  if (!shape || !('points' in shape)) return
  const old = shape.points[target.index]
  if (!old || (old[0] === target.lon && old[1] === target.lat)) return
  const closed = isClosedRing(target.kind, shape.points)
  shape.points[target.index] = [target.lon, target.lat]
  if (closed && target.index === 0) shape.points[shape.points.length - 1] = [target.lon, target.lat]
  markManual(shape)
  emit('update', next)
  syncLinks()
}
function removeVertex(kind: LinearKind, id: string, index: number) {
  if (props.disabled) return
  const currentDraft = draft.value
  if (currentDraft?.kind === kind && currentDraft.id === id) {
    currentDraft.points.splice(index, 1)
    return
  }
  const current = featureOf(props.spec, { kind, id })
  if (!current || !('points' in current)) return
  const count = vertexCount(kind, current.points)
  if (count <= minVertices(kind) || (kind === 'region' && new Set(current.points.slice(0, count).filter((_, i) => i !== index).map(point => JSON.stringify(point))).size < 3)) {
    rejectNotice.value = t(kind === 'region' ? 'mapStudio.editor.minPolygonPoints' : 'mapStudio.editor.minLinePoints')
    toast.warning(rejectNotice.value)
    return
  }
  const next = cloneSpec()
  const shape = featureOf(next, { kind, id }) as MapRoute | MapRegion
  const closed = isClosedRing(kind, shape.points)
  shape.points.splice(index, 1)
  if (closed) shape.points[shape.points.length - 1] = [...shape.points[0]!] as [number, number]
  markManual(shape)
  emit('update', next)
  selectedVertex.value = { kind, id, index: Math.min(index, count - 2) }
  rejectNotice.value = ''
  syncLinks()
  focusSelector(`[data-input="${Math.min(index, count - 2)}:lon"]`)
}
function removeFeature(kind: FeatureKind, id: string) {
  if (props.disabled) return
  const next = cloneSpec()
  if (kind === 'place') next.places = next.places.filter(item => item.id !== id)
  else if (kind === 'route') next.routes = next.routes.filter(item => item.id !== id)
  else next.regions = next.regions.filter(item => item.id !== id)
  emit('update', next)
  if (draft.value?.id === id) cancelDraft()
  if (selected.value?.id === id) clearSelection()
  syncLinks()
}
function insertOnEdge(kind: LinearKind, id: string | null, segment: number) {
  if (props.disabled) return
  const activeDraft = draft.value?.kind === kind && draft.value.id === id ? draft.value : null
  const source = activeDraft?.points ?? (featureOf(props.spec, { kind, id: id ?? '' }) as MapRoute | MapRegion | undefined)?.points
  if (!source) return
  const count = vertexCount(kind, source)
  const a = source[segment], b = source[(segment + 1) % count]
  if (!a || !b) return
  const midpoint = coordinateMidpoint(a, b)
  if (activeDraft) activeDraft.points = insertVertex(source, segment, midpoint, kind === 'region')
  else {
    const next = cloneSpec()
    const shape = featureOf(next, { kind, id: id! }) as MapRoute | MapRegion
    shape.points = insertVertex(shape.points, segment, midpoint, kind === 'region')
    markManual(shape)
    emit('update', next)
  }
  if (!dialog.value) openDialog(kind, id, segment + 1)
  else dialog.value.row = segment + 1
  selectedVertex.value = id ? { kind, id, index: segment + 1 } : null
  syncLinks()
  focusSelector(`[data-input="${segment + 1}:lon"]`)
}
function editDialogVertex(payload: { rowIndex: number; axis: 'lon' | 'lat'; value: number }) {
  const current = dialog.value
  if (!current?.kind) return
  const point = dialogPoints.value[payload.rowIndex]
  if (!point) return
  if (current.draft && draft.value) {
    const next: [number, number] = [point[0], point[1]]
    next[payload.axis === 'lon' ? 0 : 1] = payload.value
    draft.value.points[payload.rowIndex] = next
  } else moveVertex({ kind: current.kind, id: current.id!, index: payload.rowIndex, lon: payload.axis === 'lon' ? payload.value : point[0], lat: payload.axis === 'lat' ? payload.value : point[1] })
}
function deleteDialogVertex(payload: { rowIndex: number }) {
  const current = dialog.value
  if (!current?.kind) return
  if (current.draft && draft.value) draft.value.points.splice(payload.rowIndex, 1)
  else removeVertex(current.kind, current.id!, payload.rowIndex)
}
function appendDialogVertex(payload: { lon: number; lat: number }) {
  const current = dialog.value
  if (!current?.kind) return
  if (current.draft && draft.value) draft.value.points.push([payload.lon, payload.lat])
  else {
    const next = cloneSpec()
    const shape = featureOf(next, { kind: current.kind, id: current.id! }) as MapRoute | MapRegion
    const closed = isClosedRing(current.kind, shape.points)
    shape.points.splice(closed ? shape.points.length - 1 : shape.points.length, 0, [payload.lon, payload.lat])
    markManual(shape)
    emit('update', next)
    syncLinks()
  }
}
function selectDialogVertex(payload: { rowIndex: number }) {
  const current = dialog.value
  if (current?.kind && current.id) selectVertex({ kind: current.kind, id: current.id, index: payload.rowIndex })
}
function selectDialogEdge(payload: { segment: number }) {
  const current = dialog.value
  if (current?.kind && current.id) selectEdge({ kind: current.kind, id: current.id, segment: payload.segment })
}
function insertDialogEdge(payload: { segment: number }) {
  const current = dialog.value
  if (current?.kind) insertOnEdge(current.kind, current.id ?? null, payload.segment)
}
function setSmooth(shape: MapRoute | MapRegion, value: number) {
  if (props.disabled || !Number.isFinite(value)) return
  const key = smoothKeyFor(props.layerDoc, shape.id)
  const smooth = Math.round(Math.min(1, Math.max(0, value)) * 100) / 100
  if (props.layerOptions?.[key]?.smooth === smooth) return
  if (!smoothingTouched.value.includes(shape.id)) smoothingTouched.value.push(shape.id)
  emit('layer-options', { ...props.layerOptions, [key]: { smooth } })
}
function onSmoothInput(shape: MapRoute | MapRegion, event: Event) {
  setSmooth(shape, Number((event.target as HTMLInputElement).value))
}
function chooseCandidate(candidate: CanvasCandidate) {
  selectFeature({ kind: candidate.kind, id: candidate.id })
  if (candidate.type === 'vertex' && candidate.kind !== 'place') selectVertex({ kind: candidate.kind, id: candidate.id, index: candidate.index })
  if (candidate.type === 'edge') selectEdge({ kind: candidate.kind, id: candidate.id, segment: candidate.segment })
  overlap.value = []
  focusSelector('.geo-stage')
}
function candidateLabel(candidate: CanvasCandidate): string {
  return candidate.type === 'vertex' ? t('mapStudio.editor.overlapVertex', { name: candidate.name || candidate.id, n: candidate.index + 1 }) : candidate.type === 'edge' ? t('mapStudio.editor.overlapEdge', { name: candidate.name || candidate.id, n: candidate.segment + 1 }) : candidate.name || candidate.id
}
function showCandidates(candidates: CanvasCandidate[]) {
  overlap.value = candidates
  focusSelector('.geo-overlap button')
}
function escapeEditor() {
  if (overlap.value.length) overlap.value = []
  else if (tabPrompt.value) stayCurrentTab()
  else if (draft.value) tabPrompt.value = { target: tab.value, reason: 'shape' }
  else clearSelection()
}
function editorKeydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement
  if (target?.closest?.('input,textarea,select,[contenteditable]')) return
  if (event.key === 'Escape' && !dialog.value) { escapeEditor(); return }
  if ((event.key === 'Delete' || event.key === 'Backspace') && selectedVertex.value && !dialog.value) {
    event.preventDefault()
    removeVertex(selectedVertex.value.kind, selectedVertex.value.id, selectedVertex.value.index)
  }
}
function onBaseSize(value: { width: number; height: number }) {
  naturalSize.value = value
  emit('base-size', value)
}
function hasPendingInput(): boolean {
  return !!draft.value || !!placeDraft.value || hasInlineIncomplete() || !!dialogRef.value?.hasIncompleteInput()
}
function focusPendingInput() {
  toast.warning(t('mapStudio.editor.pendingInputSave'))
  if (draft.value) openDialog(draft.value.kind, draft.value.id)
  else if (placeDraft.value) focusSelector('[data-new-place="lon"]')
}
defineExpose({ hasPendingInput, focusPendingInput })
watch(() => props.focusTarget, target => {
  if (!target || !featureOf(props.spec, target)) return
  memories[tabFor(target.kind)] = target
  requestTab(tabFor(target.kind))
  if (!tabPrompt.value) selectFeature(target)
})
watch(() => props.spec, () => {
  if (selected.value && !featureOf(props.spec, selected.value)) clearSelection()
  const current = dialog.value
  if (current?.mode === 'vertices' && !current.draft && current.kind && current.id && !featureOf(props.spec, { kind: current.kind, id: current.id })) {
    closeDialog()
    toast.warning(t('mapStudio.editor.entityMissing'))
  }
  if (current?.kind && current.id && coordinateDirty({ kind: current.kind, id: current.id })) current.row = null
  syncLinks()
}, { deep: true })
onUnmounted(() => {
  if (viewTimer) clearTimeout(viewTimer)
  window.removeEventListener('popstate', onHistoryNavigation)
})
</script>

<template>
  <div ref="root" class="geo" :class="{ 'is-enlarged': enlarged }" :style="{ '--canvas-share': `${canvasShare}vh` }" @keydown="editorKeydown">
    <div :inert="dialog ? true : undefined" class="geo-content">
      <header class="geo-bar">
        <div class="geo-tabs" role="tablist" :aria-label="t('mapStudio.editor.categoryTabs')">
          <button v-for="(value, index) in TABS" :key="value" type="button" role="tab" class="geo-tab" :aria-selected="tab === value" :tabindex="tab === value ? 0 : -1" @click="requestTab(value)" @keydown="onTabKey($event, index)">
            {{ tabLabel(value) }} <span>{{ listOf(spec, kindFor(value)).length }}</span>
          </button>
        </div>
        <div class="geo-tools">
          <button v-for="value in TOOLS" :key="value" type="button" class="geo-tool" :class="{ 'is-on': tool === value }" :aria-pressed="tool === value" :disabled="disabled || (value === 'draw' && !registration)" @click="tool = value">{{ t(`mapStudio.editor.tool.${value}`) }}</button>
          <button type="button" class="geo-tool geo-add-current" :disabled="disabled || !!draft" @click="addCurrent">{{ t('mapStudio.editor.newFeature') }}</button>
          <button type="button" class="geo-tool geo-enlarge" :aria-pressed="enlarged" @click="toggleEnlarged">{{ t(enlarged ? 'mapStudio.editor.exitEnlarged' : 'mapStudio.editor.enlarge') }}</button>
        </div>
      </header>
      <p class="geo-hint geo-hidden-hint">{{ t('mapStudio.editor.hiddenHint', { label: tabLabel(tab) }) }}</p>
      <p v-if="registration" class="geo-hint dim">{{ t('mapStudio.editor.registration', { mode: t(`mapStudio.baseMode.${registration.mode}`), detail: registrationSummary(registration) }) }}</p>
      <p v-else class="geo-warn">{{ t('mapStudio.editor.canvasNoRegistration') }}</p>
      <div class="geo-layout">
        <div class="geo-map-column">
          <GeoCanvas v-if="baseUrl && size.width > 0 && size.height > 0" :base-url="baseUrl" :registration="registration" :size="size" :view="view" :tab="activeKind" :tool="tool" :disabled="disabled" :shapes="canvasShapes" :draft="draft?.id ? null : draft" :selected="selected" :selected-vertex="selectedVertex" :selected-edge="selectedEdge" @view="changeView" @base-size="onBaseSize" @select="selectFeature" @select-vertex="selectVertex" @select-edge="selectEdge" @clear-selection="clearSelection" @vertex-drag-end="moveCanvasVertex" @delete-vertex="removeVertex($event.kind, $event.id, $event.index)" @append-draft="appendDraft" @add-place="addPlace" @cursor="cursorGeo = $event" @overlap="showCandidates" @escape="escapeEditor" />
          <div v-else class="geo-no-base"><p>{{ t('mapStudio.editor.noBaseStage') }}</p></div>
          <p class="geo-cursor">{{ cursorText }}</p>
          <p v-if="offscreenCount" class="geo-warn">{{ t('mapStudio.editor.offscreen', { n: offscreenCount }) }}</p>
          <p v-if="hasInlineIncomplete()" class="geo-warn" role="alert">{{ t('mapStudio.editor.bufferSwitchPrompt') }}</p>
          <div v-if="selectedVertex || selectedEdge" class="geo-selected-actions">
            <template v-if="selectedVertex">
              <span>{{ t('mapStudio.editor.selectedVertexLabel', { n: selectedVertex.index + 1 }) }}</span>
              <button type="button" class="geo-tool geo-action" :disabled="disabled" :aria-label="t('mapStudio.editor.deleteVertexOfFeature', { name: featureOf(spec, selectedVertex)?.name || selectedVertex.id, n: selectedVertex.index + 1 })" @click="removeVertex(selectedVertex.kind, selectedVertex.id, selectedVertex.index)">{{ t('mapStudio.editor.deleteVertex') }}</button>
            </template>
            <template v-if="selectedEdge">
              <span>{{ t('mapStudio.editor.selectedEdgeLabel', { n: selectedEdge.segment + 1 }) }}</span>
              <button type="button" class="geo-tool geo-action" :disabled="disabled" @click="insertOnEdge(selectedEdge.kind, selectedEdge.id, selectedEdge.segment)">{{ t('mapStudio.editor.insertOnEdge') }}</button>
            </template>
          </div>
          <p v-if="rejectNotice" class="geo-warn" role="alert">{{ rejectNotice }}</p>
          <div v-if="tabPrompt" class="geo-switch-prompt" role="alert">
            <template v-if="tabPrompt.reason === 'shape'">
              <span>{{ t('mapStudio.editor.tabSwitchPrompt') }}</span>
              <button type="button" class="geo-tool" :disabled="!canFinish" @click="resolveTab('finish')">{{ t('mapStudio.editor.tabSwitchFinish') }}</button>
              <button type="button" class="geo-tool" @click="resolveTab('cancel')">{{ t('mapStudio.editor.tabSwitchCancel') }}</button>
            </template>
            <template v-else>
              <span>{{ t('mapStudio.editor.bufferSwitchPrompt') }}</span>
              <button type="button" class="geo-tool" @click="resolveTab('discard')">{{ t('mapStudio.editor.bufferSwitchDiscard') }}</button>
            </template>
            <button type="button" class="geo-tool" @click="stayCurrentTab">{{ t('mapStudio.editor.tabSwitchStay') }}</button>
          </div>
          <div v-if="overlap.length" class="geo-overlap" role="group" :aria-label="t('mapStudio.editor.overlapTitle')">
            <strong>{{ t('mapStudio.editor.overlapTitle') }}</strong>
            <button v-for="(candidate, index) in overlap" :key="index" type="button" class="geo-tool" @click="chooseCandidate(candidate)">{{ candidateLabel(candidate) }} · {{ t('mapStudio.editor.selectRow') }}</button>
            <button type="button" class="geo-tool" @click="overlap = []; focusSelector('.geo-stage')">{{ t('mapStudio.editor.overlapCancel') }}</button>
          </div>
        </div>
        <label v-if="enlarged" class="geo-splitter">{{ t('mapStudio.editor.canvasAllocation') }}<input v-model="canvasShare" type="range" min="35" max="75" step="1" :aria-label="t('mapStudio.editor.canvasAllocation')" /></label>
        <section class="geo-list" :class="{ 'is-collapsed': listCollapsed }" role="tabpanel" :aria-label="tabLabel(tab)">
          <header class="geo-list-head" tabindex="-1">
            <strong>{{ tabLabel(tab) }} ({{ activeItems.length }})</strong>
            <span>{{ t('mapStudio.editor.pendingCount', { n: pendingCount }) }}</span>
            <span v-if="proposedCount">{{ t('mapStudio.editor.aiCandidateCount', { n: proposedCount }) }}</span>
            <button v-if="tab === 'point'" type="button" class="geo-tool" @click="openDialog()">{{ t('mapStudio.editor.allPlacesTitle') }}</button>
            <button type="button" class="geo-tool" :aria-expanded="!listCollapsed" @click="listCollapsed = !listCollapsed">{{ t(listCollapsed ? 'mapStudio.editor.expandList' : 'mapStudio.editor.collapseList') }}</button>
            <span v-if="listCollapsed && selected">{{ featureOf(spec, selected)?.name || selected.id }}</span>
          </header>
          <div v-if="placeDraft && tab === 'point'" class="geo-item geo-draft-item">
            <strong>{{ t('mapStudio.editor.newPlace') }}</strong>
            <input v-model="placeDraft.name" class="input geo-name" :placeholder="t('mapStudio.editor.name')" />
            <label>{{ t('mapStudio.editor.lon') }}<input v-model="placeDraft.lon" data-new-place="lon" class="input geo-coord" /></label>
            <label>{{ t('mapStudio.editor.lat') }}<input v-model="placeDraft.lat" class="input geo-coord" /></label>
            <button type="button" class="geo-tool" :disabled="parseCoordinate('lon', placeDraft.lon) === null || parseCoordinate('lat', placeDraft.lat) === null" @click="createInlinePlace">{{ t('mapStudio.editor.newPlaceAction') }}</button>
            <button type="button" class="geo-tool" @click="placeDraft = null">{{ t('mapStudio.editor.cancelCurrentShape') }}</button>
          </div>
          <div v-if="draft && !draft.id && tabFor(draft.kind) === tab" class="geo-item geo-draft-item">
            <strong>{{ t('mapStudio.editor.shapeInProgress', { n: draft.points.length, min: minVertices(draft.kind) }) }}</strong>
            <button type="button" class="geo-tool" @click="openDialog(draft.kind, null)">{{ t('mapStudio.editor.pointsDialogTitle') }}</button>
            <button type="button" class="geo-tool geo-finish" :disabled="!canFinish || disabled" @click="finishDraft">{{ t('mapStudio.editor.finishEditing') }}</button>
            <button type="button" class="geo-tool" @click="cancelDraft">{{ t('mapStudio.editor.cancelCurrentShape') }}</button>
            <p class="geo-hint">{{ draft.kind === 'region' ? t('mapStudio.editor.minPolygonDraw') : t('mapStudio.editor.minLineDraw') }}</p>
          </div>
          <p v-if="!activeItems.length" class="geo-empty">{{ t('mapStudio.editor.empty') }}</p>
          <ul v-if="tab === 'point'" ref="listElement" class="geo-items">
            <li v-for="place in spec.places" :key="place.id" class="geo-item" :class="{ 'is-active': selected?.id === place.id, 'is-pending': isGeometryUnverified(place) }" @click="selectFeature({ kind: 'place', id: place.id })">
              <input class="input geo-name" :value="place.name" :disabled="disabled" :placeholder="t('mapStudio.editor.name')" @input="setName('place', place.id, $event)" />
              <label class="geo-num"><span>{{ t('mapStudio.editor.lon') }}</span><input class="input geo-coord" :value="placeBuffers[`${place.id}:lon`] ?? String(place.lon)" :disabled="disabled" @input="onPlaceInput(place.id, 'lon', $event)" /></label>
              <label class="geo-num"><span>{{ t('mapStudio.editor.lat') }}</span><input class="input geo-coord" :value="placeBuffers[`${place.id}:lat`] ?? String(place.lat)" :disabled="disabled" @input="onPlaceInput(place.id, 'lat', $event)" /></label>
              <GeoFeatureBadges :feature="place" />
              <button type="button" class="geo-tool geo-del" :disabled="disabled" :aria-label="t('mapStudio.editor.deletePlaceLabel', { name: place.name || place.id })" @click.stop="removeFeature('place', place.id)">{{ t('mapStudio.editor.deletePlace') }}</button>
            </li>
          </ul>
          <ul v-else ref="listElement" class="geo-items">
            <li v-for="shape in linearItems" :key="shape.id" class="geo-item" :class="{ 'is-active': selected?.id === shape.id, 'is-pending': isGeometryUnverified(shape) }" @click="selectFeature({ kind: activeKind, id: shape.id })">
              <input class="input geo-name" :value="shape.name" :disabled="disabled" :placeholder="t('mapStudio.editor.name')" @input="setName(activeKind, shape.id, $event)" />
              <button type="button" class="geo-tool geo-count" @click.stop="openDialog(activeKind as LinearKind, shape.id)">{{ t('mapStudio.editor.pointCount', { n: vertexCount(activeKind, shape.points) }) }}</button>
              <GeoFeatureBadges :feature="shape" />
              <div class="geo-smooth" @click.stop>
                <span>{{ t('mapStudio.editor.smoothTitle') }}</span>
                <button type="button" class="geo-tool geo-smooth-toggle" :aria-pressed="(linearRows.get(`${activeKind}:${shape.id}`)?.smooth ?? 0) > 0" :disabled="disabled" @click="setSmooth(shape, (linearRows.get(`${activeKind}:${shape.id}`)?.smooth ?? 0) > 0 ? 0 : 1)">{{ (linearRows.get(`${activeKind}:${shape.id}`)?.smooth ?? 0) > 0 ? t('mapStudio.editor.smoothOn') : t('mapStudio.editor.smoothOff') }}</button>
                <label class="geo-smooth-range"><span>{{ t('mapStudio.editor.smoothStrength') }}</span><input class="geo-smooth-slider" type="range" min="0" max="1" step="0.05" :value="linearRows.get(`${activeKind}:${shape.id}`)?.smooth ?? 0" :disabled="disabled" @input="onSmoothInput(shape, $event)" /><output>{{ Math.round((linearRows.get(`${activeKind}:${shape.id}`)?.smooth ?? 0) * 100) }}%</output></label>
              </div>
              <GeoSmoothWarning v-if="linearRows.get(`${activeKind}:${shape.id}`) && (linearRows.get(`${activeKind}:${shape.id}`)!.problems.length || ((!linearRows.get(`${activeKind}:${shape.id}`)!.canPreview || smoothingTouched.includes(shape.id)) && linearRows.get(`${activeKind}:${shape.id}`)!.smooth > 0))" :feature-name="shape.name || shape.id" :problems="linearRows.get(`${activeKind}:${shape.id}`)!.problems" :strength="linearRows.get(`${activeKind}:${shape.id}`)!.smooth" :can-preview="linearRows.get(`${activeKind}:${shape.id}`)!.canPreview" :disabled="disabled" @apply-suggested="setSmooth(shape, $event)" @disable="setSmooth(shape, 0)" />
              <div class="geo-row-actions" @click.stop>
                <button type="button" class="geo-tool" :data-continue="shape.id" :disabled="disabled || (!!draft && draft.id !== shape.id)" @click="beginShape(activeKind as LinearKind, shape.id)">{{ t('mapStudio.editor.continueShape') }}</button>
                <button type="button" class="geo-tool geo-finish" :disabled="disabled || draft?.id !== shape.id || !canFinish" :title="draft?.id === shape.id ? t('mapStudio.editor.finishLocalNote') : t('mapStudio.editor.finishNeedsPoints')" @click="finishDraft">{{ t('mapStudio.editor.finishEditing') }}</button>
                <button v-if="draft?.id === shape.id" type="button" class="geo-tool" @click="cancelDraft">{{ t('mapStudio.editor.cancelCurrentShape') }}</button>
                <button type="button" class="geo-tool geo-del" :disabled="disabled" @click="removeFeature(activeKind, shape.id)">{{ t('mapStudio.editor.remove') }}</button>
              </div>
              <p v-if="draft?.id === shape.id" class="geo-hint">{{ t('mapStudio.editor.datasetManualNote') }}</p>
            </li>
          </ul>
          <p v-if="draft" class="geo-hint">{{ t('mapStudio.editor.finishLocalNote') }}</p>
        </section>
      </div>
      <p v-if="localSpecDirty" class="geo-draft-status" role="status">{{ t('mapStudio.editor.draftStatus') }}</p>
    </div>
    <GeoPointDialog
      v-if="dialog" ref="dialogRef" :mode="dialog.mode" :feature-name="dialogName"
      :rows="dialogRows" :edges="dialogEdges" :draft="dialog.draft" :kind="dialog.kind"
      :disabled="disabled" :dirty="localSpecDirty" :linked-row="dialog.row"
      :notice="dialog.notice" :reject-notice="rejectNotice"
      @close="closeDialog" @edit-name="setName('place', $event.key, $event.value)"
      @edit-coordinate="setPlaceCoord($event.key, $event.axis, $event.value)"
      @edit-vertex="editDialogVertex" @delete-place="removeFeature('place', $event.key)"
      @delete-vertex="deleteDialogVertex" @select-place="selectFeature({ kind: 'place', id: $event.key })"
      @select-vertex="selectDialogVertex" @select-edge="selectDialogEdge"
      @insert-edge="insertDialogEdge" @append-vertex="appendDialogVertex" @create-place="createPlace"
    />
  </div>
</template>

<style scoped>
.geo, .geo-content { display: flex; flex-direction: column; gap: 8px; }
.geo-bar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.geo-tabs { display: inline-flex; border: 1px solid var(--border-strong); border-radius: 9px; overflow: hidden; }
.geo-tab { padding: 8px 15px; border: 0; background: var(--bg-1); color: var(--text-2); font-weight: 600; cursor: pointer; }
.geo-tab[aria-selected="true"] { background: var(--accent-soft); color: var(--accent-text); box-shadow: inset 0 -2px var(--accent-text); }
.geo-tab span { font: 500 10px var(--font-mono, monospace); margin-left: 4px; }
.geo-tools, .geo-row-actions, .geo-selected-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 5px; }
.geo :deep(.geo-tool) { display: inline-flex; align-items: center; justify-content: center; gap: 4px; padding: 5px 10px; min-height: 36px; border-radius: 6px; border: 1px solid var(--border-strong); background: var(--bg-1); color: var(--text-2); font: 600 11px var(--font-body); cursor: pointer; }
.geo :deep(.geo-tool:hover:not(:disabled)), .geo :deep(.geo-tool.is-on) { color: var(--accent-text); border-color: var(--accent-text); background: var(--accent-soft); }
.geo :deep(.geo-tool:disabled) { opacity: .45; cursor: not-allowed; }
.geo :deep(.geo-action) { min-height: 44px; min-width: 44px; }
.geo-layout { display: grid; grid-template-columns: minmax(320px, 62fr) minmax(290px, 38fr); gap: 14px; align-items: start; }
.geo-map-column { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.geo-list { min-width: 0; display: flex; flex-direction: column; gap: 7px; }
.geo-list-head { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; color: var(--text-2); font-size: 11px; }
.geo-items { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 7px; max-height: 650px; overflow: auto; }
.geo-item { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; padding: 9px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-2); font-size: 11px; }
.geo-item.is-active { border-color: var(--accent-text); outline: 1px solid var(--accent-text); outline-offset: -1px; }
.geo-item.is-pending { border-left: 3px solid #d97732; }
.geo-draft-item { border-style: dashed; }
.geo-name { flex: 1 1 140px; min-width: 100px; }
.geo-num { display: inline-flex; align-items: center; gap: 4px; }
.geo-coord { width: 104px; }
.geo-smooth { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; width: 100%; }
.geo-smooth-range { display: inline-flex; align-items: center; gap: 5px; }
.geo-smooth-slider { width: 100px; accent-color: var(--accent-text); }
.geo-row-actions { width: 100%; }
.geo-item :deep(.geo-smooth-warn) { flex: 1 0 100%; }
.geo-hint, .geo-cursor, .geo-empty { margin: 0; font-size: 11px; color: var(--text-2); }
.geo-hidden-hint { padding: 5px 8px; background: var(--bg-2); border-radius: 6px; }
.geo-cursor { font-family: var(--font-mono, monospace); }
.geo-warn, .geo-switch-prompt { margin: 0; padding: 7px 9px; border-radius: 7px; background: var(--warn-bg); border: 1px solid var(--warn-border); color: var(--warn-text); font-size: 11px; }
.geo-switch-prompt, .geo-overlap { display: flex; flex-direction: column; align-items: flex-start; gap: 5px; }
.geo-overlap { padding: 8px; border: 1px solid var(--border-strong); border-radius: 7px; background: var(--bg-1); }
.geo-no-base { display: grid; place-items: center; min-height: 320px; border: 1px dashed var(--border-strong); border-radius: 9px; color: var(--text-2); text-align: center; padding: 20px; }
.geo-draft-status { margin: 0; font-size: 11px; color: var(--accent-text); }
.geo-del:hover:not(:disabled) { color: var(--danger, #b4382d); border-color: var(--danger, #b4382d); }
.geo.is-enlarged { position: fixed; inset: 16px; z-index: 1000; padding: 16px; overflow: auto; background: var(--bg-1); border: 1px solid var(--border-strong); border-radius: 12px; }
.geo.is-enlarged .geo-layout { display: flex; flex-direction: column; }
.geo.is-enlarged .geo-map-column, .geo.is-enlarged .geo-list { width: 100%; }
.geo.is-enlarged :deep(.geo-stage) { height: var(--canvas-share); min-height: 320px; }
.geo.is-enlarged .geo-list { min-height: 160px; }
.geo-splitter { display: flex; align-items: center; gap: 8px; width: 100%; padding: 4px; color: var(--text-2); font-size: 11px; }
.geo-splitter input { flex: 1; }
.geo-list.is-collapsed .geo-items { display: none; }
@media(max-width: 1050px) { .geo-layout { grid-template-columns: 1fr; } .geo-items { max-height: 400px; } }
</style>
