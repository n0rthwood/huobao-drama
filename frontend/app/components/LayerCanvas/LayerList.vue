<template>
  <div class="layer-list">
    <div class="ll-head">
      <span class="ll-title">{{ t('layerCanvas.list.title') }}</span>
      <span class="ll-count">{{ doc.layers.length }}</span>
    </div>
    <div class="ll-add">
      <button
        v-for="type in LAYER_TYPES" :key="type" type="button" class="btn-ghost ll-add-btn"
        :title="t(`layerCanvas.type.${type}`)" @click="emit('add', type)"
      >+{{ t(`layerCanvas.type.${type}`) }}</button>
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
        <button
          type="button" class="ll-icon" :aria-pressed="layer.visible"
          :title="t('layerCanvas.list.visible')" @click.stop="toggle(layer, 'visible')"
        >{{ layer.visible ? '●' : '○' }}</button>
        <button
          type="button" class="ll-icon" :aria-pressed="layer.locked"
          :title="t('layerCanvas.list.locked')" @click.stop="toggle(layer, 'locked')"
        >{{ layer.locked ? '🔒' : '🔓' }}</button>
        <input
          v-if="renaming === layer.id" ref="renameInput" class="ll-name-input" :value="layer.name"
          @click.stop @blur="commitRename(layer, $event)" @keydown.enter.prevent="$event.target.blur()"
        >
        <span v-else class="ll-name" @dblclick.stop="startRename(layer.id)">{{ layer.name }}</span>
        <span class="ll-type">{{ t(`layerCanvas.type.${layer.type}`) }}</span>
        <span v-if="layer.anchor" class="ll-anchor" :title="anchorTitle(layer)">{{ layer.anchor.detached ? '⚲' : '⚓' }}</span>
      </li>
    </ul>
    <div class="ll-foot">
      <button type="button" class="btn-ghost" :disabled="!selectedIds.length" @click="emit('duplicate')">{{ t('layerCanvas.list.duplicate') }}</button>
      <button type="button" class="btn-ghost" :disabled="!selectedIds.length" @click="emit('remove')">{{ t('layerCanvas.list.remove') }}</button>
    </div>
  </div>
</template>

<script setup>
/**
 * 图层列表（Issue #48）：z 序拖拽、可见/锁定、重命名、增删。
 * 列表自上而下 = 画面从上层到下层（z 大的排在最前）。
 */
import { nextTick, computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps({
  doc: { type: Object, required: true },
  selectedIds: { type: Array, default: () => [] },
})
const emit = defineEmits(['select', 'patch', 'history', 'reorder', 'add', 'remove', 'duplicate'])
const { t } = useI18n()

const LAYER_TYPES = ['polygon', 'polyline', 'marker', 'label', 'card', 'image']
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

function anchorTitle(layer) {
  const anchor = layer.anchor || {}
  const parts = [anchor.asset_id ? `#${anchor.asset_id}` : '', anchor.semantic_id || ''].filter(Boolean)
  return `${anchor.detached ? t('layerCanvas.list.detached') : t('layerCanvas.list.anchored')} ${parts.join(' · ')}`.trim()
}
</script>

<style scoped>
.layer-list { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--border); background: var(--surface-card); }
.ll-head { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; border-bottom: 1px solid var(--border); font-size: 13px; font-weight: 600; }
.ll-count { color: var(--text-2); font-weight: 400; }
.ll-add { display: flex; flex-wrap: wrap; gap: 4px; padding: 6px; border-bottom: 1px solid var(--border); }
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
</style>
