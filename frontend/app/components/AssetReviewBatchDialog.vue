<script setup>
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps({
  mode: { type: String, required: true },
  items: { type: Array, default: () => [] },
  saving: { type: Boolean, default: false },
  result: { type: Object, default: null },
})
const emit = defineEmits(['close', 'confirm'])
const { t, te } = useI18n()
const selected = ref([])
watch(() => props.items, items => { selected.value = items.map(item => item.id) }, { immediate: true })
const allSelected = computed(() => selected.value.length === props.items.length)
function toggleAll(event) {
  selected.value = event.target.checked ? props.items.map(item => item.id) : []
}
function reasonLabel(reason) {
  const key = `episode.assetReview.results.reason.${reason}`
  return te(key) ? t(key) : reason
}
</script>

<template>
  <div class="overlay" @click.self="!saving && emit('close')">
    <div class="dialog batch-dialog" role="dialog" aria-modal="true" :aria-label="t(result ? 'episode.assetReview.results.title' : `episode.assetReview.batch.${mode}`)">
      <div class="dialog-head">
        <h2 class="dialog-title">{{ t(result ? 'episode.assetReview.results.title' : `episode.assetReview.batch.${mode}`) }}</h2>
      </div>
      <div v-if="!result" class="dialog-body batch-body">
        <p class="dim">{{ t('episode.assetReview.batch.hint') }}</p>
        <label class="select-all"><input type="checkbox" :checked="allSelected" @change="toggleAll"> {{ t('episode.assetReview.batch.selectAll', { n: items.length }) }}</label>
        <label v-for="item in items" :key="item.id" class="batch-item">
          <input v-model="selected" type="checkbox" :value="item.id">
          <span class="item-text">
            <strong>{{ item.info_point }}</strong>
            <span>{{ t('episode.assetReview.needLine', { kind: t(`episode.assetReview.needKind.${item.need_kind}`), desc: item.need_desc }) }}</span>
            <span v-if="item.extraction" class="dim">{{ t(`episode.assetReview.batch.${item.extraction.status}`) }}</span>
          </span>
        </label>
      </div>
      <div v-else class="dialog-body batch-body">
        <p>{{ result.summary }}</p>
        <div v-for="row in result.rows" :key="row.item_id" class="result-item">
          <strong>{{ row.info_point }} <span class="dim">#{{ row.item_id }}</span></strong>
          <span v-if="row.reason">{{ t('episode.assetReview.results.skipped') }}: {{ reasonLabel(row.reason) }}</span>
          <span v-else>{{ t(`episode.assetReview.results.${result.mode === 'create' ? 'created' : 'updated'}`) }}<template v-if="row.name">: {{ row.name }}</template></span>
          <span v-if="row.candidate">{{ t('episode.assetReview.results.candidate', { kind: t(`episode.assetReview.needKind.${row.candidate.kind}`), name: row.candidate.name, id: row.candidate.id }) }}</span>
        </div>
      </div>
      <div class="dialog-foot">
        <button class="btn" :disabled="saving" @click="emit('close')">{{ t(result ? 'common.close' : 'common.cancel') }}</button>
        <button v-if="!result" class="btn btn-primary" :disabled="saving || !selected.length" @click="emit('confirm', selected)">{{ t('episode.assetReview.batch.confirm', { n: selected.length }) }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.batch-dialog { width: min(760px, 90vw); max-height: 85vh; display: flex; flex-direction: column; }
.batch-body { overflow-y: auto; font-size: 12px; }
.select-all { display: flex; align-items: center; gap: 8px; padding: 8px 0; }
.batch-item, .result-item { display: flex; gap: 10px; padding: 9px 0; border-top: 1px solid var(--border, rgba(128, 128, 128, 0.25)); }
.batch-item { align-items: flex-start; cursor: pointer; }
.item-text, .result-item { display: flex; flex-direction: column; gap: 4px; min-width: 0; overflow-wrap: anywhere; }
</style>
