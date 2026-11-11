/**
 * 图层文档编辑状态（Issue #48）：选择、增删改、z 序、撤销重做（快照栈 ≤100）、
 * 300ms 防抖保存回调。几何与样式的唯一解释权在 `utils/layerSvg.js`（与后端同源），
 * 这里只负责「文档怎么变」，不负责「文档怎么画」。
 *
 * 模板文本框（Issue #96）：`type='text'` 只存 `role` + `fields`，位置由文档级 `text_layout`
 * 与规范算出来——没有几何可改，所以几何补丁对它是空操作。
 */
import { computed, ref, watch } from 'vue'
import { THEME_PRESETS, layerBounds } from '~/utils/layerSvg'
import { TEXT_SPEC, textFamilyOf, textLayoutById, textLayoutsFor } from '~/utils/layerText'
import { useMissingGlyphs } from '~/composables/useMissingGlyphs'

export type LayerType = 'polygon' | 'polyline' | 'marker' | 'label' | 'card' | 'image' | 'text'
export type LayerTheme = 'archival' | 'clean' | 'ink'
export type LayerVariable = 'project_title' | 'episode_title' | 'episode_no'
/** 编辑器媒介：图层段用视频版式套，Poster 用海报版式套；地图编辑器两者都不用（缺省空串）。 */
export type LayerMedium = '' | 'video' | 'poster'
export interface LayerVariables { project_title: string; episode_title: string; episode_no: string }

export interface LayerBox { x: number; y: number; w: number; h: number }
export interface LayerRecord {
  id: string
  type: LayerType
  name: string
  visible: boolean
  locked: boolean
  z: number
  opacity: number
  rotation: number
  anchor?: { asset_id?: number; semantic_id?: string; semantic_name?: string; detached?: boolean }
  points?: [number, number][]
  at?: [number, number]
  box?: LayerBox
  text?: string
  variable?: LayerVariable
  template?: 'name' | 'year' | 'chapter'
  /** 卡片字段（旧文字层）与模板文本框字段（普通字段 = string，列表字段 = string[]）共用 */
  fields?: Record<string, string | string[]>
  /** 模板文本框（#96）：规范里的角色 id；`type='text'` 必填 */
  role?: string
  /** 模板文本框（#96）：字段 → 变量绑定（Poster 的栏目识别可绑项目名/集号） */
  field_vars?: Partial<Record<string, LayerVariable>>
  src?: { path: string; asset_kind?: 'prop' | 'scene' | 'character'; asset_id?: number; version_task_id?: number | null }
  fit?: 'contain' | 'cover'
  style: Record<string, unknown>
}
export interface LayerDocument {
  version: number
  base: {
    path: string; width: number; height: number; filter?: Record<string, unknown>
    crop?: LayerBox; source_width?: number; source_height?: number
    ref?: { asset_kind: 'prop' | 'scene' | 'character'; asset_id: number; version_task_id: number | null }
  }
  theme: LayerTheme
  layers: LayerRecord[]
  /** 模板文本框的成套位置 id（#96）；有 text 图层时必须选一套 */
  text_layout?: string
}

const HISTORY_LIMIT = 100
const SAVE_DELAY_MS = 300

export const LAYER_TYPE_LABELS: Record<LayerType, string> = {
  polygon: '区域',
  polyline: '路线',
  marker: '地点',
  label: '文字',
  card: '卡片',
  image: '图片',
  text: '模板文本框',
}

/** 图层的几何键：模板文本框没有这些（位置由规范排版），补丁里出现也一律忽略。 */
const GEOMETRY_KEYS: Array<keyof LayerRecord> = ['points', 'at', 'box', 'rotation']

export function emptyLayerDoc(base?: Partial<LayerDocument['base']>): LayerDocument {
  return {
    version: 1,
    base: { path: '', width: 1344, height: 768, ...base },
    theme: 'archival',
    layers: [],
  }
}

/** 新建图层：几何给一份居中的默认值，样式从主题预设拷贝成具体值，便于样式面板直接编辑。 */
export function createLayer(type: LayerType, theme: LayerTheme, index: number, role?: string): LayerRecord {
  const id = `${type}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const style = JSON.parse(JSON.stringify(THEME_PRESETS[theme][type]))
  const base: LayerRecord = {
    id,
    type,
    name: `${LAYER_TYPE_LABELS[type]} ${index + 1}`,
    visible: true,
    locked: false,
    z: index,
    opacity: 1,
    rotation: 0,
    style,
  }
  if (type === 'text') {
    // 文本框的名字就是角色名（与后端规范化缺省一致）；没给角色时按空名字等着被拒绝
    base.role = role || ''
    base.name = (role && TEXT_SPEC.roles[role]?.name) || LAYER_TYPE_LABELS.text
    base.fields = {}
  } else if (type === 'polygon') base.points = [[0.35, 0.35], [0.65, 0.35], [0.65, 0.6], [0.35, 0.6]]
  else if (type === 'polyline') base.points = [[0.3, 0.6], [0.5, 0.45], [0.7, 0.4]]
  else if (type === 'marker') {
    base.at = [0.5, 0.5]
    base.text = '地点'
  } else if (type === 'label') {
    base.box = { x: 0.32, y: 0.45, w: 0.36, h: 0.12 }
    base.text = '文字说明'
  } else if (type === 'card') {
    base.box = { x: 0.3, y: 0.7, w: 0.4, h: 0.14 }
    base.template = 'name'
    base.fields = { title: '姓名', sub: '职务', meta: '年代' }
  } else {
    base.box = { x: 0.38, y: 0.3, w: 0.24, h: 0.32 }
    base.src = { path: '' }
    base.fit = 'cover'
  }
  return base
}

export function useLayerDoc(
  onSave?: (doc: LayerDocument) => void,
  external?: { snapshot?: () => unknown; restore?: (value: unknown) => void },
  variables?: () => LayerVariables | undefined,
  options?: { medium?: LayerMedium },
) {
  const medium = options?.medium || ''
  const doc = ref<LayerDocument>(emptyLayerDoc())
  const selectedIds = ref<string[]>([])
  const past = ref<string[]>([])
  const future = ref<string[]>([])
  let saveTimer: number | null = null
  let silent = false

  const selectedLayers = computed(() => doc.value.layers.filter(layer => selectedIds.value.includes(layer.id)))
  const canUndo = computed(() => past.value.length > 0)
  const canRedo = computed(() => future.value.length > 0)
  const aspect = computed(() => doc.value.base.width / doc.value.base.height)
  const { missingGlyphs, missingGlyphsByLayer } = useMissingGlyphs(doc, variables)

  function captureSnapshot() {
    return JSON.stringify({ doc: doc.value, external: external?.snapshot?.() })
  }

  function restoreSnapshot(snapshot: string) {
    const value = JSON.parse(snapshot)
    doc.value = value.doc
    if ('external' in value) external?.restore?.(value.external)
    selectedIds.value = selectedIds.value.filter(id => doc.value.layers.some(layer => layer.id === id))
  }

  /** 在一次「可撤销的改动」之前调用；连续拖动只在按下时调一次。 */
  function pushHistory() {
    past.value.push(captureSnapshot())
    if (past.value.length > HISTORY_LIMIT) past.value.shift()
    future.value = []
  }

  function load(next: LayerDocument) {
    silent = true
    doc.value = JSON.parse(JSON.stringify(next))
    selectedIds.value = []
    past.value = []
    future.value = []
  }

  /** Accept normalized server metadata without resetting selection/history or autosaving it again. */
  function acceptSaved(next: LayerDocument) {
    clearTimeout(saveTimer ?? undefined)
    silent = true
    doc.value = JSON.parse(JSON.stringify(next))
  }

  function undo() {
    const snapshot = past.value.pop()
    if (!snapshot) return
    future.value.push(captureSnapshot())
    restoreSnapshot(snapshot)
  }

  function redo() {
    const snapshot = future.value.pop()
    if (!snapshot) return
    past.value.push(captureSnapshot())
    restoreSnapshot(snapshot)
  }

  /** 坐标归一化 0–1（跨 Issue 契约）：编辑器里就钳住，避免服务端规范化后位置和画布对不上。 */
  function clampGeometry(patch: Partial<LayerRecord>): Partial<LayerRecord> {
    const unit = (value: number) => Math.min(1, Math.max(0, value))
    const out: Partial<LayerRecord> = { ...patch }
    if (out.points) out.points = out.points.map(([x, y]) => [unit(x), unit(y)] as [number, number])
    if (out.at) out.at = [unit(out.at[0]), unit(out.at[1])]
    if (out.box) out.box = { ...out.box, x: unit(out.box.x), y: unit(out.box.y) }
    return out
  }

  /** Geometry cannot silently detach an anchor; callers confirm before beginning a gesture. */
  function patchLayer(id: string, patch: Partial<LayerRecord>) {
    const layer = doc.value.layers.find(item => item.id === id)
    if (!layer) return
    // 模板文本框的位置/旋转由规范排版：几何补丁直接丢弃，不给「拖不动却压了一条历史」的错觉
    const effective = layer.type === 'text'
      ? (Object.fromEntries(Object.entries(patch).filter(([key]) => !GEOMETRY_KEYS.includes(key as keyof LayerRecord))) as Partial<LayerRecord>)
      : patch
    const geometryChanged = GEOMETRY_KEYS.some(key => key in effective)
    if (geometryChanged && layer.anchor?.semantic_id && !layer.anchor.detached) {
      return { confirmationRequired: true as const, layer }
    }
    Object.assign(layer, clampGeometry(effective))
    return { confirmationRequired: false as const, layer }
  }

  /** Explicit user-approved detach; history belongs to the complete gesture, not this helper. */
  function detachAnchors(ids: string[]) {
    for (const layer of doc.value.layers) {
      if (ids.includes(layer.id) && layer.anchor) layer.anchor.detached = true
    }
  }

  /** Rebinding is explicit and atomically restores the source geometry and its anchor. */
  function reanchorLayer(id: string, patch: Partial<LayerRecord>) {
    const layer = doc.value.layers.find(item => item.id === id)
    if (!layer || !patch.anchor?.semantic_id) return
    pushHistory()
    Object.assign(layer, clampGeometry(patch), { anchor: { ...patch.anchor, detached: false } })
  }

  function setBase(base: LayerDocument['base']) {
    pushHistory()
    doc.value.base = JSON.parse(JSON.stringify(base))
  }

  function patchStyle(id: string, patch: Record<string, unknown>) {
    const layer = doc.value.layers.find(item => item.id === id)
    if (layer) layer.style = { ...layer.style, ...patch }
  }

  function addLayer(type: LayerType, partial?: Partial<LayerRecord>) {
    const role = type === 'text' ? String(partial?.role || '') : ''
    // 文本框的最小完整状态 = 角色；没有角色/规范未到时什么也不建（不做「先建一个空框」的隐式默认）
    if (type === 'text' && !TEXT_SPEC.roles[role]) return null
    pushHistory()
    const layer = createLayer(type, doc.value.theme, doc.value.layers.length, role)
    Object.assign(layer, partial || {})
    layer.z = doc.value.layers.length ? Math.max(...doc.value.layers.map(item => item.z)) + 1 : 0
    doc.value.layers.push(layer)
    selectedIds.value = [layer.id]
    // 第一个文本框必须有一套版式：按成片画幅与编辑器媒介选第一套，用户随后可在版式套选择器里换
    if (type === 'text' && !doc.value.text_layout) {
      const layouts = textLayoutsFor(textFamilyOf(doc.value.base.width, doc.value.base.height), medium || 'video')
      if (layouts.length) doc.value.text_layout = layouts[0].id
    }
    return layer
  }

  /** 换版式套（#96）：只改文档级 text_layout，各图层的角色与字段原样保留。 */
  function setTextLayout(id: string) {
    if (!id) {
      if (!doc.value.text_layout) return
      pushHistory()
      delete doc.value.text_layout
      return
    }
    if (id === doc.value.text_layout || !textLayoutById(id)) return
    pushHistory()
    doc.value.text_layout = id
  }

  function removeSelected() {
    if (!selectedIds.value.length) return
    pushHistory()
    doc.value.layers = doc.value.layers.filter(layer => !selectedIds.value.includes(layer.id))
    selectedIds.value = []
  }

  function duplicateSelected() {
    if (!selectedIds.value.length) return
    pushHistory()
    const maxZ = Math.max(...doc.value.layers.map(layer => layer.z), -1)
    const copies = selectedLayers.value.map((layer, index) => {
      const copy: LayerRecord = JSON.parse(JSON.stringify(layer))
      copy.id = `${layer.type}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}-${index}`
      copy.name = `${layer.name} 副本`
      copy.z = maxZ + 1 + index
      if (copy.points) copy.points = copy.points.map(([x, y]) => [x + 0.02, y + 0.02])
      if (copy.at) copy.at = [copy.at[0] + 0.02, copy.at[1] + 0.02]
      if (copy.box) copy.box = { ...copy.box, x: copy.box.x + 0.02, y: copy.box.y + 0.02 }
      if (copy.anchor) copy.anchor = { ...copy.anchor, detached: true }
      return copy
    })
    doc.value.layers.push(...copies)
    selectedIds.value = copies.map(copy => copy.id)
  }

  /** 把图层移动到列表中的新位置并重排 z（列表里越靠下 z 越大 = 越靠上层）。 */
  function reorder(id: string, toIndex: number) {
    const from = doc.value.layers.findIndex(layer => layer.id === id)
    if (from < 0 || toIndex < 0 || toIndex >= doc.value.layers.length || from === toIndex) return
    pushHistory()
    const [moved] = doc.value.layers.splice(from, 1)
    doc.value.layers.splice(toIndex, 0, moved)
    doc.value.layers.forEach((layer, index) => { layer.z = index })
  }

  function setTheme(theme: LayerTheme) {
    if (doc.value.theme === theme) return
    pushHistory()
    doc.value.theme = theme
  }

  function setFilter(patch: Record<string, unknown>) {
    pushHistory()
    doc.value.base.filter = { paper: 0, tint: 'none', tint_strength: 0.35, vignette: 0, ...(doc.value.base.filter || {}), ...patch }
  }

  /** 选中图层整体平移（拖动与方向键共用）；模板文本框没有几何，原地不动。 */
  function moveSelected(dx: number, dy: number) {
    for (const layer of selectedLayers.value) {
      if (layer.locked || layer.type === 'text') continue
      if (layer.points) patchLayer(layer.id, { points: layer.points.map(([x, y]) => [x + dx, y + dy]) })
      else if (layer.at) patchLayer(layer.id, { at: [layer.at[0] + dx, layer.at[1] + dy] })
      else if (layer.box) patchLayer(layer.id, { box: { ...layer.box, x: layer.box.x + dx, y: layer.box.y + dy } })
    }
  }

  function boundsOf(layer: LayerRecord): LayerBox {
    return layerBounds(layer, doc.value.theme, aspect.value)
  }

  watch(doc, () => {
    if (silent) {
      silent = false
      return
    }
    if (!onSave) return
    clearTimeout(saveTimer ?? undefined)
    saveTimer = setTimeout(() => onSave(JSON.parse(JSON.stringify(doc.value))), SAVE_DELAY_MS) as unknown as number
  }, { deep: true })

  return {
    doc,
    medium,
    selectedIds,
    selectedLayers,
    canUndo,
    canRedo,
    aspect,
    missingGlyphs,
    missingGlyphsByLayer,
    detachAnchors,
    reanchorLayer,
    setBase,
    load,
    acceptSaved,
    pushHistory,
    undo,
    redo,
    patchLayer,
    patchStyle,
    addLayer,
    setTextLayout,
    removeSelected,
    duplicateSelected,
    reorder,
    setTheme,
    setFilter,
    moveSelected,
    boundsOf,
  }
}
