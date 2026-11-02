<template>
  <div class="poster-tools">
    <div class="poster-tools-add">
      <span class="poster-tools-label">{{ t('poster.tools.add') }}</span>
      <button type="button" class="btn btn-sm" @click="emit('add', 'text')">{{ t('poster.tools.addText') }}</button>
      <button type="button" class="btn btn-sm" @click="emit('add', 'project_title')">{{ t('poster.tools.addProject') }}</button>
      <button type="button" class="btn btn-sm" @click="emit('add', 'episode_title')">{{ t('poster.tools.addEpisode') }}</button>
      <button type="button" class="btn btn-sm" @click="emit('add', 'episode_no')">{{ t('poster.tools.addNumber') }}</button>
    </div>

    <p v-if="!box" class="poster-tools-hint dim">{{ t('poster.tools.selectHint') }}</p>
    <template v-else>
      <div class="poster-tools-head">
        <span class="poster-tools-kind">{{ kindLabel(box.kind) }}</span>
        <button type="button" class="btn btn-sm btn-danger" @click="emit('remove', box.id)">{{ t('common.delete') }}</button>
      </div>

      <label v-if="box.kind === 'text'" class="poster-tools-field">
        <span>{{ t('poster.tools.content') }}</span>
        <textarea
          class="textarea"
          rows="2"
          maxlength="300"
          :value="box.text"
          @input="emit('update', { text: $event.target.value })"
        />
      </label>
      <div v-else class="poster-tools-field">
        <span>{{ t('poster.tools.content') }}</span>
        <div class="poster-tools-variable">{{ resolveBoxText(box, variables) }}</div>
        <span class="dim">{{ t('poster.tools.variableLocked') }}</span>
      </div>

      <div class="poster-tools-grid">
        <label class="poster-tools-field">
          <span>{{ t('poster.tools.font') }}</span>
          <select class="input" :value="box.fontFamily" @change="emit('update', { fontFamily: $event.target.value })">
            <option v-for="font in FONT_OPTIONS" :key="font" :value="font">{{ t(`poster.font.${font}`) }}</option>
          </select>
        </label>

        <label class="poster-tools-field">
          <span>{{ t('poster.tools.size', { n: Math.round(box.fontSize * 100) }) }}</span>
          <input
            type="range"
            min="2"
            max="40"
            step="1"
            :value="Math.round(box.fontSize * 100)"
            @input="emit('update', { fontSize: Number($event.target.value) / 100 })"
          />
        </label>

        <label class="poster-tools-field">
          <span>{{ t('poster.tools.color') }}</span>
          <input type="color" :value="box.color" @input="emit('update', { color: $event.target.value })" />
        </label>

        <label class="poster-tools-field">
          <span>{{ t('poster.tools.strokeColor') }}</span>
          <input type="color" :value="box.strokeColor" @input="emit('update', { strokeColor: $event.target.value })" />
        </label>

        <label class="poster-tools-field">
          <span>{{ t('poster.tools.strokeWidth', { n: Math.round(box.strokeWidth * 100) }) }}</span>
          <input
            type="range"
            min="0"
            max="12"
            step="1"
            :value="Math.round(box.strokeWidth * 100)"
            @input="emit('update', { strokeWidth: Number($event.target.value) / 100 })"
          />
        </label>
      </div>

      <div class="poster-tools-toggles">
        <label class="poster-tools-toggle">
          <input type="checkbox" :checked="box.bold" @change="emit('update', { bold: $event.target.checked })" />
          {{ t('poster.tools.bold') }}
        </label>
        <label class="poster-tools-toggle">
          <input type="checkbox" :checked="box.italic" @change="emit('update', { italic: $event.target.checked })" />
          {{ t('poster.tools.italic') }}
        </label>
        <label class="poster-tools-toggle">
          <input type="checkbox" :checked="box.shadow" @change="emit('update', { shadow: $event.target.checked })" />
          {{ t('poster.tools.shadow') }}
        </label>
      </div>

      <div class="poster-tools-field">
        <span>{{ t('poster.tools.align') }}</span>
        <div class="poster-tools-align">
          <button
            v-for="align in ALIGNS"
            :key="align"
            type="button"
            :class="['btn btn-sm', { on: box.align === align }]"
            @click="emit('update', { align })"
          >{{ t(`poster.align.${align}`) }}</button>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { resolveBoxText } from '~/utils/posterLayout'

const props = defineProps({
  box: { type: Object, default: null },
  variables: { type: Object, required: true },
})
const emit = defineEmits(['update', 'remove', 'add'])
const { t } = useI18n()

const FONT_OPTIONS = ['sans', 'serif', 'kai', 'hand']
const ALIGNS = ['left', 'center', 'right']

function kindLabel(kind) {
  const key = {
    text: 'poster.tools.kindText',
    project_title: 'poster.tools.kindProject',
    episode_title: 'poster.tools.kindEpisode',
    episode_no: 'poster.tools.kindNumber',
  }[kind] || 'poster.tools.kindText'
  return t(key)
}
</script>

<style scoped>
.poster-tools {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--border-color, #2a2e39);
  border-radius: 10px;
  background: var(--panel-bg, #14161c);
}
.poster-tools-add {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.poster-tools-label {
  font-size: 11px;
  color: var(--text-2, #aab);
  margin-right: 4px;
}
.poster-tools-hint {
  font-size: 12px;
  margin: 4px 0;
}
.poster-tools-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.poster-tools-kind {
  font-size: 12px;
  font-weight: 600;
}
.poster-tools-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 11px;
  color: var(--text-2, #aab);
}
.poster-tools-variable {
  padding: 4px 6px;
  border: 1px dashed var(--border-color, #2a2e39);
  border-radius: 6px;
  color: var(--text-1, #e6e8ee);
  font-size: 12px;
}
.poster-tools-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 10px;
}
.poster-tools-toggles {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 11px;
}
.poster-tools-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
}
.poster-tools-align {
  display: flex;
  gap: 4px;
}
.poster-tools-align .btn.on {
  border-color: var(--accent, #4f8cff);
  color: var(--accent, #4f8cff);
}
input[type='color'] {
  width: 100%;
  height: 22px;
  padding: 0;
  border: 1px solid var(--border-color, #2a2e39);
  background: transparent;
}
</style>
