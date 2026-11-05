<script setup>
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
const props = defineProps({ title: String, items: { type: Array, default: () => [] }, scope: Object, busy: Boolean, retryMode: Boolean })
const emit = defineEmits(['close', 'confirm'])
const { t } = useI18n()
const selected = ref([])
const idOf = item => Number(typeof item === 'object' ? item.storyboard_id ?? item.storyboardId ?? item.id : item)
const selectable = item => item.selectable !== false && !['blocked', 'excluded', 'skipped', 'disabled'].includes(item.status)
watch(() => props.items, items => { selected.value = props.retryMode ? items.filter(item => item.checked === true).map(idOf) : props.scope?.included ? props.scope.included.map(idOf) : items.filter(item => selectable(item) && item.checked !== false && item.status !== 'unchanged').map(idOf) }, { immediate: true })
const excluded = computed(() => props.items.filter(item => !selected.value.includes(idOf(item))))
function reasonLabel(item) {
  const reason = item.reason || item.change_reasons?.join('；') || item.status
  if (['no_generated_segment', 'keyframes_unconfirmed', 'generating', 'unchanged', 'not_selected', 'not_failed'].includes(reason)) return t(`episode.final.scopeReasons.${reason}`)
  const status = { missing: 'Missing', changed: 'Changed', unknown: 'Unknown', blocked: 'Blocked', excluded: 'Excluded', skipped: 'Skipped', disabled: 'Disabled' }[reason]
  return status ? t(`episode.compose.status${status}`) : reason
}
</script>
<template>
  <div class="overlay" @click.self="!busy && emit('close')">
    <section class="dialog scope-dialog" role="dialog" aria-modal="true" :aria-label="title" @keydown.esc="!busy && emit('close')">
      <header class="dialog-head"><h2>{{ title }}</h2><button class="btn btn-sm" :disabled="busy" @click="emit('close')">×</button></header>
      <div class="dialog-body">
        <p>{{ t('episode.final.scope', { included: selected.length, excluded: excluded.length }) }}</p>
        <p v-if="retryMode && scope">{{ t('episode.final.scope', { included: scope.included.length, excluded: scope.excluded.length }) }}</p>
        <label v-for="item in items" :key="idOf(item)" class="scope-row">
          <input v-model="selected" type="checkbox" :value="idOf(item)" :disabled="busy || retryMode || !selectable(item)" />
          #{{ item.storyboard_number ?? item.storyboardNumber ?? idOf(item) }} · {{ reasonLabel(item) }}
        </label>
      </div>
      <footer class="dialog-foot"><button class="btn btn-primary" :disabled="busy || !selected.length" @click="emit('confirm', selected)">{{ t('episode.final.start', { n: selected.length }) }}</button></footer>
    </section>
  </div>
</template>
<style scoped>.scope-dialog{width:min(760px,85vw)}.dialog-body{max-height:65vh;overflow:auto}.scope-row{display:flex;gap:10px;padding:10px;border-bottom:1px solid var(--border)}</style>
