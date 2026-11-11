<template>
  <div class="layer-list">
    <div class="ll-head">
      <span class="ll-title">{{ t('layerCanvas.list.title') }}</span>
      <span class="ll-count">{{ doc.layers.length }}</span>
    </div>
    <div class="ll-add">
      <button
        v-for="type in addTypes" :key="type" type="button" class="btn-ghost ll-add-btn"
        :title="t(`layerCanvas.type.${type}`)" @click="emit('add', type)"
      ><component :is="TYPE_ICONS[type]" :size="13" />{{ t(`layerCanvas.type.${type}`) }}</button>
    </div>
    <!-- 模板文本框（#96）：按角色分类分组；位置由规范算，没有可拖的框 -->
    <div v-if="medium" class="ll-text-add">
      <span class="ll-text-label"><LetterText :size="13" />{{ t('layerText.add.title') }}</span>
      <select v-model="textRole" class="ll-text-select" :aria-label="t('layerText.add.title')" :disabled="!specReady">
        <optgroup v-for="group in roleGroups" :key="group.category" :label="categoryName(group.category)">
          <option v-for="role in group.roles" :key="role" :value="role">{{ roleName(role) }}</option>
        </optgroup>
      </select>
      <button type="button" class="btn-ghost ll-add-btn" :disabled="!specReady || !textRole" :title="t('layerText.add.button')" @click="addText">
        {{ t('layerText.add.button') }}
      </button>
      <small v-if="!specReady" class="ll-text-hint">{{ t('layerText.add.loading') }}</small>
    </div>
    <ul class="ll-items">
      <li
        v-for="(layer, index) in ordered" :key="layer.id"
        :class="['ll-item', { selected: selectedIds.includes(layer.id), dragging: dragId === layer.id }]"
        draggable="true"
        @click="onClick(layer, $event)"
        @dragstart="dragId = layer.id"
        @dragover.prevent
        @drop.prevent="onDrop(index)"
        @dragend="dragId = null"
      >
        <GripVertical :size="12" class="ll-grip" />
        <component :is="TYPE_ICONS[layer.type]" :size="14" />
        <input
          v-if="renaming === layer.id" ref="renameInput" class="ll-name-input" :value="layer.name"
          @click.stop @blur="commitRename(layer, $event)" @keydown.enter.prevent="$event.target.blur()"
        >
        <span v-else class="ll-name" @dblclick.stop="startRename(layer.id)">{{ layer.name }}</span>
        <span v-if="glyphs[layer.id]?.length" class="ll-warning" :title="t('layerCanvas.style.missingChars', { chars: glyphs[layer.id].join(' ') })"><TriangleAlert :size="13" /></span>
        <button v-if="layer.type !== 'text'" type="button" :class="['ll-icon', 'll-anchor', status(layer)]"
          :title="t(`layerCanvas.anchor.${status(layer)}`)" :aria-label="t('layerCanvas.anchor.relink')"
          @click.stop="emit('relink', layer.id)"><component :is="ANCHOR_ICONS[status(layer)]" :size="14" /></button>
        <button type="button" class="ll-icon" :aria-pressed="layer.visible" :title="t('layerCanvas.list.visible')" :aria-label="t('layerCanvas.list.visible')" @click.stop="toggle(layer, 'visible')"><component :is="layer.visible ? Eye : EyeOff" :size="14" /></button>
        <button type="button" class="ll-icon" :aria-pressed="layer.locked" :title="t('layerCanvas.list.locked')" :aria-label="t('layerCanvas.list.locked')" @click.stop="toggle(layer, 'locked')"><component :is="layer.locked ? Lock : LockOpen" :size="14" /></button>
        <button v-if="layer.type !== 'text' && layer.anchor && !layer.anchor.detached" type="button" class="ll-icon ll-hover" :title="t('layerCanvas.anchor.toManual')" :aria-label="t('layerCanvas.anchor.toManual')" @click.stop="manual(layer)"><Move :size="13" /></button>
        <!-- 文本框的角色在一个位置区里唯一：复制出来必然同区冲突，换成从菜单添加另一个角色 -->
        <button v-if="layer.type !== 'text'" type="button" class="ll-icon ll-hover" :title="t('layerCanvas.list.duplicate')" :aria-label="t('layerCanvas.list.duplicate')" @click.stop="emit('select', [layer.id]); emit('duplicate')"><Copy :size="13" /></button>
        <button type="button" class="ll-icon ll-hover" :title="t('layerCanvas.list.remove')" :aria-label="t('layerCanvas.list.remove')" @click.stop="emit('select', [layer.id]); emit('remove')"><Trash2 :size="13" /></button>
      </li>
    </ul>
    <div class="ll-foot">
      <button type="button" class="btn-ghost ll-icon" :title="t('layerCanvas.list.duplicate')" :aria-label="t('layerCanvas.list.duplicate')" :disabled="!selectedIds.length" @click="emit('duplicate')"><Copy :size="15" /></button>
      <button type="button" class="btn-ghost ll-icon" :title="t('layerCanvas.list.remove')" :aria-label="t('layerCanvas.list.remove')" :disabled="!selectedIds.length" @click="emit('remove')"><Trash2 :size="15" /></button>
    </div>
  </div>
</template>

<script setup>
/**
 * 图层列表（Issue #48）：z 序拖拽、可见/锁定、重命名、增删。
 * 列表自上而下 = 画面从上层到下层（z 大的排在最前）。
 */
import { nextTick, computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Lasso, Route, MapPin, Type, IdCard, Image, LetterText, GripVertical, Anchor, Move, Unlink, Eye, EyeOff, Lock, LockOpen, Copy, Trash2, TriangleAlert } from 'lucide-vue-next'
import { useMissingGlyphs } from '~/composables/useMissingGlyphs'
import { TEXT_SPEC, textRolesFor } from '~/utils/layerText'
import { useLayerTextSpec, useLayerTextNames } from '~/composables/useLayerTextSpec'

const props = defineProps({
  doc: { type: Object, required: true },
  selectedIds: { type: Array, default: () => [] },
  anchorStates: { type: Object, default: () => ({}) },
  variables: { type: Object, default: null },
  /** 编辑器媒介（#96）：video = 图层段（可留锚定文字标注）、poster = 海报、'' = 地图（没有文本框） */
  medium: { type: String, default: '' },
})
const emit = defineEmits(['select', 'patch', 'history', 'reorder', 'add', 'remove', 'duplicate', 'relink'])
const { t } = useI18n()
const { ready: specReady, version: specVersion } = useLayerTextSpec()
const { roleName, categoryName } = useLayerTextNames()

const TYPE_ICONS = { polygon: Lasso, polyline: Route, marker: MapPin, label: Type, card: IdCard, image: Image, text: LetterText }
const ANCHOR_ICONS = { anchored: Anchor, manual: Move, unlink: Unlink }
const { missingGlyphsByLayer: glyphs } = useMissingGlyphs(() => props.doc, () => props.variables)

/** 旧自由图层只在还有意义的地方给入口：海报没有锚定标注，图层段保留 label 当锚定文字标注。 */
const addTypes = computed(() => {
  if (props.medium === 'video') return ['label', 'marker', 'polygon', 'polyline', 'image']
  if (props.medium === 'poster') return ['marker', 'polygon', 'polyline', 'image']
  return ['polygon', 'polyline', 'marker', 'label', 'card', 'image']
})

/** 媒介可用的文本框角色（规范到达前为空）。 */
const textRoles = computed(() => {
  void specVersion.value
  return props.medium ? textRolesFor(props.medium) : []
})
const roleGroups = computed(() => {
  const groups = []
  for (const role of textRoles.value) {
    const category = TEXT_SPEC.roles[role]?.category || ''
    const group = groups.find(item => item.category === category)
    if (group) group.roles.push(role)
    else groups.push({ category, roles: [role] })
  }
  return groups
})
const textRole = ref('')
watch(roleGroups, groups => {
  if (!groups.some(group => group.roles.includes(textRole.value))) textRole.value = groups[0]?.roles[0] || ''
}, { immediate: true })

function addText() {
  if (!textRole.value) return
  emit('add', 'text', { role: textRole.value })
}

function status(layer) {
  return props.anchorStates[layer.id] || (layer.anchor?.semantic_id && !layer.anchor.detached ? 'anchored' : 'manual')
}

function manual(layer) {
  emit('history')
  emit('patch', { id: layer.id, patch: { anchor: { ...layer.anchor, detached: true } } })
}
const dragId = ref(null)
const renaming = ref(null)
const renameInput = ref(null)

/** 画面上层在列表顶部：doc.layers 按 z 升序存，这里倒序显示。 */
const ordered = computed(() => [...props.doc.layers].reverse())

function onClick(layer, event) {
  if (event.shiftKey) {
    const next = props.selectedIds.includes(layer.id)
      ? props.selectedIds.filter(id => id !== layer.id)
      : [...props.selectedIds, layer.id]
    emit('select', next)
    return
  }
  emit('select', [layer.id])
}

function toggle(layer, key) {
  emit('history')
  emit('patch', { id: layer.id, patch: { [key]: !layer[key] } })
}

function startRename(id) {
  renaming.value = id
  nextTick(() => {
    const input = Array.isArray(renameInput.value) ? renameInput.value[0] : renameInput.value
    input?.focus()
    input?.select()
  })
}

function commitRename(layer, event) {
  const name = String(event.target.value || '').trim()
  renaming.value = null
  if (!name || name === layer.name) return
  emit('history')
  emit('patch', { id: layer.id, patch: { name } })
}

function onDrop(displayIndex) {
  const id = dragId.value
  dragId.value = null
  if (!id) return
  // 显示顺序是倒序：显示第 i 行对应数组下标 length-1-i
  emit('reorder', { id, toIndex: props.doc.layers.length - 1 - displayIndex })
}

</script>

<style scoped>
.layer-list { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--border); background: var(--surface-card); }
.ll-head { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; border-bottom: 1px solid var(--border); font-size: 13px; font-weight: 600; }
.ll-count { color: var(--text-2); font-weight: 400; }
.ll-add { display: flex; flex-wrap: wrap; gap: 4px; padding: 6px; border-bottom: 1px solid var(--border); }
.ll-text-add { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 6px; border-bottom: 1px solid var(--border); }
.ll-text-label { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-2); }
.ll-text-select { flex: 1; min-width: 0; font-size: 11px; padding: 2px 4px; }
.ll-text-hint { width: 100%; font-size: 11px; color: var(--text-3); }
.ll-add-btn { font-size: 11px; padding: 2px 6px; }
.ll-items { flex: 1; min-height: 0; overflow: auto; margin: 0; padding: 0; list-style: none; }
.ll-item { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--border); cursor: pointer; font-size: 12px; }
.ll-item.selected { background: var(--surface-active, rgba(47, 123, 214, 0.12)); box-shadow: inset 2px 0 0 var(--accent); }
.ll-item.dragging { opacity: 0.5; }
.ll-icon { background: none; border: none; cursor: pointer; font-size: 11px; padding: 0 2px; color: var(--text-2); }
.ll-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-1); }
.ll-name-input { flex: 1; min-width: 0; font-size: 12px; }
.ll-type { color: var(--text-2); font-size: 11px; }
.ll-anchor { color: var(--text-2); font-size: 11px; }
.ll-foot { display: flex; gap: 6px; padding: 6px; border-top: 1px solid var(--border); }
.ll-add-btn, .ll-icon { display: inline-flex; align-items: center; justify-content: center; gap: 4px; }
.ll-grip { flex-shrink: 0; color: var(--text-3); cursor: grab; }
.ll-anchor.anchored { color: var(--accent); }
.ll-anchor.manual { color: var(--text-3); }
.ll-anchor.unlink, .ll-warning { color: var(--danger, #c0472e); }
.ll-hover { opacity: 0; }
.ll-item:hover .ll-hover, .ll-item:focus-within .ll-hover { opacity: 1; }
.ll-icon:disabled { opacity: .4; }
</style>
