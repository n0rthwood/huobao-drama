<template>
  <div class="layer-style">
    <section class="ls-block">
      <h4>{{ t('layerCanvas.style.docTitle') }}</h4>
      <label class="ls-row">
        <span>{{ t('layerCanvas.style.theme') }}</span>
        <select :value="doc.theme" @change="emit('theme', $event.target.value)">
          <option v-for="theme in THEMES" :key="theme" :value="theme">{{ t(`layerCanvas.theme.${theme}`) }}</option>
        </select>
      </label>
      <label class="ls-row">
        <span>{{ t('layerCanvas.style.tint') }}</span>
        <select :value="filter.tint" @change="emit('filter', { tint: $event.target.value })">
          <option v-for="tint in TINTS" :key="tint" :value="tint">{{ t(`layerCanvas.tint.${tint}`) }}</option>
        </select>
      </label>
      <label class="ls-row">
        <span>{{ t('layerCanvas.style.tintStrength') }}</span>
        <input type="range" min="0" max="1" step="0.05" :value="filter.tint_strength" @input="emit('filter', { tint_strength: Number($event.target.value) })">
        <em>{{ filter.tint_strength }}</em>
      </label>
      <label class="ls-row">
        <span>{{ t('layerCanvas.style.paper') }}</span>
        <input type="range" min="0" max="1" step="0.05" :value="filter.paper" @input="emit('filter', { paper: Number($event.target.value) })">
        <em>{{ filter.paper }}</em>
      </label>
      <label class="ls-row">
        <span>{{ t('layerCanvas.style.vignette') }}</span>
        <input type="range" min="0" max="1" step="0.05" :value="filter.vignette" @input="emit('filter', { vignette: Number($event.target.value) })">
        <em>{{ filter.vignette }}</em>
      </label>
    </section>

    <section v-if="!layer" class="ls-empty">{{ t('layerCanvas.style.empty') }}</section>

    <template v-else>
      <section class="ls-block">
        <h4>{{ t(`layerCanvas.type.${layer.type}`) }} · {{ layer.name }}</h4>
        <label class="ls-row">
          <span>{{ t('layerCanvas.style.opacity') }}</span>
          <input type="range" min="0" max="1" step="0.05" :value="layer.opacity" @input="setLayer('opacity', Number($event.target.value))" @change="endEdit">
          <em>{{ layer.opacity }}</em>
        </label>
        <label class="ls-row">
          <span>{{ t('layerCanvas.style.rotation') }}</span>
          <input type="range" min="-180" max="180" step="1" :value="layer.rotation" @input="setLayer('rotation', Number($event.target.value))" @change="endEdit">
          <em>{{ layer.rotation }}°</em>
        </label>
      </section>

      <section v-if="layer.type === 'polygon'" class="ls-block">
        <label class="ls-row"><span>{{ t('layerCanvas.style.fill') }}</span><input type="color" :value="value('fill')" @input="setStyle('fill', $event.target.value)" @change="endEdit"></label>
        <label class="ls-row"><span>{{ t('layerCanvas.style.fillOpacity') }}</span><input type="range" min="0" max="1" step="0.05" :value="value('fill_opacity')" @input="setStyle('fill_opacity', Number($event.target.value))" @change="endEdit"><em>{{ value('fill_opacity') }}</em></label>
        <label class="ls-row"><span>{{ t('layerCanvas.style.stroke') }}</span><input type="color" :value="value('stroke')" @input="setStyle('stroke', $event.target.value)" @change="endEdit"></label>
        <label class="ls-row"><span>{{ t('layerCanvas.style.strokeWidth') }}</span><input type="range" min="0" max="0.02" step="0.001" :value="value('stroke_width')" @input="setStyle('stroke_width', Number($event.target.value))" @change="endEdit"><em>{{ value('stroke_width') }}</em></label>
        <label class="ls-row"><span>{{ t('layerCanvas.style.dash') }}</span><select :value="value('dash')" @change="setStyle('dash', $event.target.value); endEdit()"><option v-for="dash in DASHES" :key="dash" :value="dash">{{ t(`layerCanvas.dash.${dash}`) }}</option></select></label>
      </section>

      <section v-else-if="layer.type === 'polyline'" class="ls-block">
        <label class="ls-row"><span>{{ t('layerCanvas.style.stroke') }}</span><input type="color" :value="value('stroke')" @input="setStyle('stroke', $event.target.value)" @change="endEdit"></label>
        <label class="ls-row"><span>{{ t('layerCanvas.style.width') }}</span><input type="range" min="0.001" max="0.03" step="0.001" :value="value('width')" @input="setStyle('width', Number($event.target.value))" @change="endEdit"><em>{{ value('width') }}</em></label>
        <label class="ls-row"><span>{{ t('layerCanvas.style.dash') }}</span><select :value="value('dash')" @change="setStyle('dash', $event.target.value); endEdit()"><option v-for="dash in DASHES" :key="dash" :value="dash">{{ t(`layerCanvas.dash.${dash}`) }}</option></select></label>
        <label class="ls-row"><span>{{ t('layerCanvas.style.arrowStart') }}</span><input type="checkbox" :checked="value('arrow_start')" @change="setStyle('arrow_start', $event.target.checked); endEdit()"></label>
        <label class="ls-row"><span>{{ t('layerCanvas.style.arrowEnd') }}</span><input type="checkbox" :checked="value('arrow_end')" @change="setStyle('arrow_end', $event.target.checked); endEdit()"></label>
      </section>

      <section v-else-if="layer.type === 'marker'" class="ls-block">
        <label class="ls-row ls-wide"><span>{{ t('layerCanvas.style.text') }}</span><input :value="layer.text" @input="setLayer('text', $event.target.value)" @change="endEdit"></label>
        <label class="ls-row"><span>{{ t('layerCanvas.style.dotColor') }}</span><input type="color" :value="value('color')" @input="setStyle('color', $event.target.value)" @change="endEdit"></label>
        <label class="ls-row"><span>{{ t('layerCanvas.style.textColor') }}</span><input type="color" :value="value('text_color')" @input="setStyle('text_color', $event.target.value)" @change="endEdit"></label>
        <label class="ls-row"><span>{{ t('layerCanvas.style.dotRadius') }}</span><input type="range" min="0.004" max="0.05" step="0.001" :value="value('dot_radius')" @input="setStyle('dot_radius', Number($event.target.value))" @change="endEdit"><em>{{ value('dot_radius') }}</em></label>
        <label class="ls-row"><span>{{ t('layerCanvas.style.size') }}</span><input type="range" min="0.01" max="0.12" step="0.002" :value="value('size')" @input="setStyle('size', Number($event.target.value))" @change="endEdit"><em>{{ value('size') }}</em></label>
        <label class="ls-row"><span>{{ t('layerCanvas.style.font') }}</span><select :value="value('font')" @change="setStyle('font', $event.target.value); endEdit()"><option v-for="font in FONTS" :key="font" :value="font">{{ t(`layerCanvas.font.${font}`) }}</option></select></label>
        <label class="ls-row"><span>{{ t('layerCanvas.style.bold') }}</span><input type="checkbox" :checked="value('bold')" @change="setStyle('bold', $event.target.checked); endEdit()"></label>
        <label class="ls-row"><span>{{ t('layerCanvas.style.labelOffset') }}</span>
          <input type="number" step="0.005" :value="value('label_offset')[0]" @input="setOffset(0, $event.target.value)" @change="endEdit">
          <input type="number" step="0.005" :value="value('label_offset')[1]" @input="setOffset(1, $event.target.value)" @change="endEdit">
        </label>
      </section>

      <section v-else-if="layer.type === 'label'" class="ls-block">
        <label class="ls-row ls-wide"><span>{{ t('layerCanvas.style.text') }}</span><textarea rows="3" :value="layer.text" @input="setLayer('text', $event.target.value)" @change="endEdit" /></label>
        <label class="ls-row"><span>{{ t('layerCanvas.style.font') }}</span><select :value="value('font')" @change="setStyle('font', $event.target.value); endEdit()"><option v-for="font in FONTS" :key="font" :value="font">{{ t(`layerCanvas.font.${font}`) }}</option></select></label>
        <label class="ls-row"><span>{{ t('layerCanvas.style.size') }}</span><input type="range" min="0.015" max="0.2" step="0.002" :value="value('size')" @input="setStyle('size', Number($event.target.value))" @change="endEdit"><em>{{ value('size') }}</em></label>
        <label class="ls-row"><span>{{ t('layerCanvas.style.color') }}</span><input type="color" :value="value('color')" @input="setStyle('color', $event.target.value)" @change="endEdit"></label>
        <label class="ls-row"><span>{{ t('layerCanvas.style.stroke') }}</span><input type="color" :value="value('stroke')" @input="setStyle('stroke', $event.target.value)" @change="endEdit"></label>
        <label class="ls-row"><span>{{ t('layerCanvas.style.strokeWidth') }}</span><input type="range" min="0" max="0.02" step="0.001" :value="value('stroke_width')" @input="setStyle('stroke_width', Number($event.target.value))" @change="endEdit"><em>{{ value('stroke_width') }}</em></label>
        <label class="ls-row"><span>{{ t('layerCanvas.style.bg') }}</span><input type="color" :value="value('bg')" @input="setStyle('bg', $event.target.value)" @change="endEdit"></label>
        <label class="ls-row"><span>{{ t('layerCanvas.style.bgOpacity') }}</span><input type="range" min="0" max="1" step="0.05" :value="value('bg_opacity')" @input="setStyle('bg_opacity', Number($event.target.value))" @change="endEdit"><em>{{ value('bg_opacity') }}</em></label>
        <label class="ls-row"><span>{{ t('layerCanvas.style.align') }}</span><select :value="value('align')" @change="setStyle('align', $event.target.value); endEdit()"><option v-for="align in ALIGNS" :key="align" :value="align">{{ t(`layerCanvas.align.${align}`) }}</option></select></label>
        <label class="ls-row"><span>{{ t('layerCanvas.style.bold') }}</span><input type="checkbox" :checked="value('bold')" @change="setStyle('bold', $event.target.checked); endEdit()"></label>
      </section>

      <section v-else-if="layer.type === 'card'" class="ls-block">
        <label class="ls-row"><span>{{ t('layerCanvas.style.template') }}</span><select :value="layer.template" @change="setLayer('template', $event.target.value); endEdit()"><option v-for="tpl in TEMPLATES" :key="tpl" :value="tpl">{{ t(`layerCanvas.template.${tpl}`) }}</option></select></label>
        <label class="ls-row ls-wide"><span>{{ t('layerCanvas.style.title') }}</span><input :value="layer.fields.title" @input="setField('title', $event.target.value)" @change="endEdit"></label>
        <label class="ls-row ls-wide"><span>{{ t('layerCanvas.style.sub') }}</span><input :value="layer.fields.sub" @input="setField('sub', $event.target.value)" @change="endEdit"></label>
        <label class="ls-row ls-wide"><span>{{ t('layerCanvas.style.meta') }}</span><input :value="layer.fields.meta" @input="setField('meta', $event.target.value)" @change="endEdit"></label>
        <label class="ls-row"><span>{{ t('layerCanvas.style.font') }}</span><select :value="value('font')" @change="setStyle('font', $event.target.value); endEdit()"><option v-for="font in FONTS" :key="font" :value="font">{{ t(`layerCanvas.font.${font}`) }}</option></select></label>
        <label class="ls-row"><span>{{ t('layerCanvas.style.bg') }}</span><input type="color" :value="value('bg')" @input="setStyle('bg', $event.target.value)" @change="endEdit"></label>
        <label class="ls-row"><span>{{ t('layerCanvas.style.bgOpacity') }}</span><input type="range" min="0" max="1" step="0.05" :value="value('bg_opacity')" @input="setStyle('bg_opacity', Number($event.target.value))" @change="endEdit"><em>{{ value('bg_opacity') }}</em></label>
        <label class="ls-row"><span>{{ t('layerCanvas.style.color') }}</span><input type="color" :value="value('color')" @input="setStyle('color', $event.target.value)" @change="endEdit"></label>
        <label class="ls-row"><span>{{ t('layerCanvas.style.accent') }}</span><input type="color" :value="value('accent')" @input="setStyle('accent', $event.target.value)" @change="endEdit"></label>
      </section>

      <section v-else class="ls-block">
        <label class="ls-row ls-wide"><span>{{ t('layerCanvas.style.src') }}</span><input :value="layer.src.path" @input="setLayer('src', { path: $event.target.value })" @change="endEdit"></label>
        <label class="ls-row"><span>{{ t('layerCanvas.style.fit') }}</span><select :value="layer.fit" @change="setLayer('fit', $event.target.value); endEdit()"><option value="cover">cover</option><option value="contain">contain</option></select></label>
        <label class="ls-row"><span>{{ t('layerCanvas.style.border') }}</span><input type="color" :value="value('border')" @input="setStyle('border', $event.target.value)" @change="endEdit"></label>
        <label class="ls-row"><span>{{ t('layerCanvas.style.borderWidth') }}</span><input type="range" min="0" max="0.02" step="0.001" :value="value('border_width')" @input="setStyle('border_width', Number($event.target.value))" @change="endEdit"><em>{{ value('border_width') }}</em></label>
        <label class="ls-row"><span>{{ t('layerCanvas.style.radius') }}</span><input type="range" min="0" max="0.1" step="0.002" :value="value('radius')" @input="setStyle('radius', Number($event.target.value))" @change="endEdit"><em>{{ value('radius') }}</em></label>
        <label class="ls-row"><span>{{ t('layerCanvas.style.shadow') }}</span><input type="checkbox" :checked="value('shadow')" @change="setStyle('shadow', $event.target.checked); endEdit()"></label>
      </section>

      <p v-if="missingChars.length" class="ls-warn">{{ t('layerCanvas.style.missingChars', { chars: missingChars.join(' ') }) }}</p>
    </template>
  </div>
</template>

<script setup>
/**
 * 图层样式面板（Issue #48）：按类型给出可编辑字段 + 主题预设 + 底图风格化。
 * 字段缺省值来自 layerSvg.js 的 THEME_PRESETS（与渲染同源），面板里改什么就写什么。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { THEME_PRESETS, unsupportedChars } from '~/utils/layerSvg'

const props = defineProps({
  doc: { type: Object, required: true },
  layer: { type: Object, default: null },
})
const emit = defineEmits(['patch', 'style', 'history', 'theme', 'filter'])
const { t } = useI18n()

const THEMES = ['archival', 'clean', 'ink']
const TINTS = ['none', 'sepia', 'cool', 'warm']
const DASHES = ['none', 'dash', 'dot']
const FONTS = ['sans', 'serif']
const ALIGNS = ['left', 'center', 'right']
const TEMPLATES = ['name', 'year', 'chapter']

const editingKey = ref(null)
const filter = computed(() => ({ paper: 0, tint: 'none', tint_strength: 0.35, vignette: 0, ...(props.doc.base.filter || {}) }))

const missingChars = computed(() => {
  if (!props.layer) return []
  const texts = [props.layer.text || '', ...(props.layer.fields ? Object.values(props.layer.fields) : [])]
  const out = []
  for (const text of texts) {
    for (const ch of unsupportedChars(text)) {
      if (!out.includes(ch)) out.push(ch)
    }
  }
  return out
})

/** 样式字段的当前值：图层自己没写就取主题预设（与渲染口径一致）。 */
function value(key) {
  const own = props.layer.style || {}
  if (own[key] !== undefined && own[key] !== null && own[key] !== '') return own[key]
  return THEME_PRESETS[props.doc.theme][props.layer.type][key]
}

/** 一次连续编辑（拖滑杆、连续输入）只压一条撤销记录，change/blur 后重新开始。 */
function beginEdit(key) {
  if (editingKey.value === key) return
  editingKey.value = key
  emit('history')
}

function endEdit() {
  editingKey.value = null
}

function setLayer(key, value) {
  beginEdit(`layer:${key}`)
  emit('patch', { id: props.layer.id, patch: { [key]: value } })
}

function setStyle(key, value) {
  beginEdit(`style:${key}`)
  emit('style', { id: props.layer.id, patch: { [key]: value } })
}

function setField(key, value) {
  beginEdit(`field:${key}`)
  emit('patch', { id: props.layer.id, patch: { fields: { ...props.layer.fields, [key]: value } } })
}

function setOffset(index, raw) {
  const offset = [...value('label_offset')]
  offset[index] = Number(raw) || 0
  setStyle('label_offset', offset)
}
</script>

<style scoped>
.layer-style { display: flex; flex-direction: column; gap: 10px; padding: 10px; overflow: auto; border-left: 1px solid var(--border); background: var(--surface-card); font-size: 12px; }
.ls-block { display: flex; flex-direction: column; gap: 6px; }
.ls-block h4 { margin: 0 0 2px; font-size: 12px; font-weight: 600; color: var(--text-1); }
.ls-row { display: grid; grid-template-columns: 92px 1fr auto; align-items: center; gap: 6px; color: var(--text-2); }
.ls-row.ls-wide { grid-template-columns: 92px 1fr; }
.ls-row em { font-style: normal; color: var(--text-2); min-width: 36px; text-align: right; }
.ls-row input[type="color"] { width: 40px; height: 22px; padding: 0; border: 1px solid var(--border); background: none; }
.ls-row input[type="range"] { width: 100%; }
.ls-row input[type="number"], .ls-row input[type="text"], .ls-row input:not([type]), .ls-row textarea, .ls-row select { width: 100%; font-size: 12px; }
.ls-empty { color: var(--text-2); padding: 8px 2px; }
.ls-warn { margin: 0; color: #c0472e; line-height: 1.5; }
</style>
