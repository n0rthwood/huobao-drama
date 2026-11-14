<template>
  <section class="style-picker">
    <strong>{{ t('mapStudio.styles.title') }}</strong>
    <p class="dim">{{ t('mapStudio.styles.hint') }}</p>
    <p v-if="error" role="alert">{{ error }} <button type="button" :disabled="disabled" @click="load">{{ t('mapStudio.panel.refresh') }}</button></p>
    <button v-if="allowDefault && catalogue" type="button" class="style-default" :aria-pressed="modelValue === null" :disabled="disabled" @click="emit('update:modelValue', null)">
      {{ modelValue === null ? '✓ ' : '' }}{{ t('mapStudio.styles.followDefault', { name: familyName(catalogue.default_style) }) }}
    </button>
    <p v-if="allowDefault && modelValue === undefined" class="dim">{{ t('mapStudio.styles.legacy') }}</p>
    <div class="style-cards">
      <article v-for="family in catalogue?.families ?? []" :key="family.id" class="style-card" :class="{ selected: modelValue === family.id }">
        <button type="button" class="style-choice" :disabled="disabled" :aria-pressed="modelValue === family.id" @click="emit('update:modelValue', family.id)">
          <img :src="mapStudioAPI.stylePreviewUrl(family.id)" :alt="family.reference.title" loading="lazy" />
          <strong>{{ modelValue === family.id ? '✓ ' : '' }}{{ familyName(family.id) }}</strong>
          <span>{{ t(`mapStudio.styles.family.${family.id}.purpose`) }}</span>
          <span class="style-palette" :aria-label="t('mapStudio.styles.palette')"><span v-for="(color, name) in family.palette" :key="name" :style="{ backgroundColor: color }" :title="`${name}: ${color}`" /></span>
        </button>
        <a :href="family.reference.source" target="_blank" rel="noopener noreferrer">{{ family.reference.title }} · {{ family.reference.license }}</a>
      </article>
    </div>
    <p class="dim">{{ t('mapStudio.styles.referenceHint') }}</p>
  </section>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { mapStudioAPI, type MapStudioStyles } from '~/map-studio/api'
const { t } = useI18n()
withDefaults(defineProps<{ modelValue?: string | null; disabled?: boolean; allowDefault?: boolean }>(), { allowDefault: true })
const emit = defineEmits<{ (event: 'update:modelValue', value: string | null): void }>()
const catalogue = ref<MapStudioStyles | null>(null)
const error = ref('')
let stopped = false
function familyName(id: string) { return t(`mapStudio.styles.family.${id}.name`) }
async function load() {
  error.value = ''
  try { const result = await mapStudioAPI.styles(); if (!stopped) catalogue.value = result }
  catch (err) { if (!stopped) error.value = err instanceof Error ? err.message : t('mapStudio.styles.loadFailed') }
}
onMounted(load)
onBeforeUnmount(() => { stopped = true })
</script>

<style scoped>
.style-picker { display: flex; flex-direction: column; gap: 8px; }
.style-picker p { margin: 0; font-size: 11px; }
.style-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 240px)); justify-content: start; gap: 8px; }
.style-card { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--surface-soft); }
.style-card.selected { border: 2px solid var(--accent-text); }
.style-choice { display: flex; flex-direction: column; gap: 7px; padding: 8px; width: 100%; border: 0; background: transparent; text-align: left; color: var(--text-1); cursor: pointer; font-size: 11px; }
.style-choice:disabled { cursor: not-allowed; opacity: .6; }
.style-choice img { width: 100%; height: 110px; object-fit: contain; }
.style-choice > span { color: var(--text-2); }
.style-palette { display: flex; width: 100%; height: 15px; border: 1px solid var(--border); }
.style-palette span { flex: 1; }
.style-card a { display: block; padding: 0 8px 8px; font-size: 9px; color: var(--accent-text); }
.style-default { align-self: flex-start; border: 1px solid var(--border); padding: 6px 10px; border-radius: 6px; color: var(--text-1); background: var(--surface-soft); cursor: pointer; }
.style-default[aria-pressed=true] { border-color: var(--accent-text); }
</style>
