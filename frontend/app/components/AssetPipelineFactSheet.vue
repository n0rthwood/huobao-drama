<template>
  <section class="fact-sheet">
    <button class="fact-heading" type="button" :aria-expanded="expanded" @click="open = !open">
      <ChevronDown :size="12" :class="{ collapsed: !expanded }" />
      <strong>{{ t('episode.documentary.pipeline.specTitle') }}</strong>
      <span v-if="spec">{{ t('episode.documentary.pipeline.specVersion', { v: spec.version }) }}</span>
    </button>
    <template v-if="expanded">
      <p v-if="!spec">{{ t('episode.documentary.pipeline.specEmpty') }}</p>
      <template v-else>
        <p>{{ spec.summary }}</p>
        <strong>{{ t('episode.documentary.pipeline.specMustHave') }}</strong>
        <ul><li v-for="item in spec.must_have" :key="item.id"><b>{{ item.element }}</b><span>{{ t(`episode.documentary.pipeline.metric${cap(item.metric)}`) }}</span><span>{{ t('episode.documentary.pipeline.specWhy', { why: item.why }) }}</span><span>{{ t('episode.documentary.pipeline.specCheck', { check: item.check }) }}</span></li></ul>
        <template v-if="spec.forbidden.length"><strong>{{ t('episode.documentary.pipeline.specForbidden') }}</strong><ul><li v-for="item in spec.forbidden" :key="item.id"><b>{{ item.error }}</b><span>{{ item.why }}</span></li></ul></template>
        <template v-if="spec.tolerances.length"><strong>{{ t('episode.documentary.pipeline.specTolerances') }}</strong><ul><li v-for="(item, i) in spec.tolerances" :key="i">{{ item }}</li></ul></template>
        <template v-if="spec.uncertainties.length"><strong>{{ t('episode.documentary.pipeline.specUncertainties') }}</strong><ul><li v-for="(item, i) in spec.uncertainties" :key="i">{{ item }}</li></ul></template>
      </template>
    </template>
  </section>
</template>

<script setup lang="ts">
import { ChevronDown } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { ref, computed } from 'vue'
import type { AssetSpecRow } from '~/composables/useApi'
const props = defineProps<{ spec: AssetSpecRow | null; initiallyOpen?: boolean }>()
const { t } = useI18n()
const open = ref(Boolean(props.initiallyOpen))
const expanded = computed(() => open.value)
function cap(value: string) { return value ? value[0].toUpperCase() + value.slice(1) : '' }
</script>

<style scoped>
.fact-sheet { display: flex; flex-direction: column; gap: 5px; min-width: 0; overflow-wrap: anywhere; font-size: 11px; color: var(--text-2); }
.fact-heading { display: flex; align-items: center; gap: 6px; padding: 0; border: 0; background: none; color: var(--text-1); text-align: left; cursor: pointer; }
.collapsed { transform: rotate(-90deg); }
p, ul { margin: 0; }
ul { padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; }
li { display: flex; flex-wrap: wrap; gap: 6px; padding: 4px 6px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-soft); }
</style>
