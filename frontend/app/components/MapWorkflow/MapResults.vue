<template>
  <div class="res">
    <section v-if="cards.length" class="res-block">
      <header class="res-head">
        <strong>{{ t('episode.documentary.map.results.title') }}</strong>
        <span class="dim">{{ t('episode.documentary.map.results.hint') }}</span>
      </header>
      <div class="res-cards">
        <figure v-for="card in cards" :key="card.key" class="res-card">
          <button type="button" class="res-thumb" @click="emit('preview', card.view)">
            <img :src="card.url" :alt="card.label" loading="lazy" />
          </button>
          <figcaption class="res-caption">
            <strong>{{ card.label }}</strong>
            <span class="dim">{{ t('episode.documentary.map.results.size', { w: card.width, h: card.height }) }}</span>
            <span class="dim">{{ t('episode.documentary.map.results.source', { source: card.source }) }}</span>
          </figcaption>
        </figure>
      </div>
    </section>

    <section v-if="beforeCard && finalCard" class="res-block">
      <header class="res-head">
        <strong>{{ t('episode.documentary.map.results.compareTitle') }}</strong>
        <span class="dim">{{ t('episode.documentary.map.results.compareHint') }}</span>
      </header>
      <div class="res-compare">
        <figure v-for="card in [beforeCard, finalCard]" :key="`cmp-${card.key}`" class="res-card res-card--wide">
          <button type="button" class="res-thumb" @click="emit('preview', card.view)">
            <img :src="card.url" :alt="card.label" loading="lazy" />
          </button>
          <figcaption class="res-caption"><strong>{{ card.label }}</strong></figcaption>
        </figure>
      </div>
    </section>

    <section class="res-block">
      <header class="res-head">
        <strong>{{ t('episode.documentary.map.results.provenanceTitle') }}</strong>
      </header>
      <ul class="res-facts">
        <li v-if="registration">{{ t('episode.documentary.map.results.registration', { mode: t(`episode.documentary.map.baseMode.${registration.mode}`), detail: registrationSummary(registration) }) }}</li>
        <li v-if="registration?.earth?.calibrated && registration.earth.residual_px">
          {{ t('episode.documentary.map.results.calibrationCheck', { n: registration.earth.validation_count ?? 0, rms: registration.earth.residual_px.rms.toFixed(2), max: registration.earth.residual_px.max.toFixed(2) }) }}
        </li>
        <li v-if="attribution">{{ t('episode.documentary.map.results.attribution', { text: attribution }) }}</li>
        <li v-for="(source, index) in provenanceSources" :key="`psrc-${index}`">
          <span class="res-kind">{{ source.kind }}</span>
          <a v-if="source.url" class="res-link" :href="source.url" target="_blank" rel="noreferrer noopener">{{ source.name || source.url }}</a>
          <span v-else>{{ source.name }}</span>
          <span v-if="source.license" class="dim">{{ source.license }}</span>
          <span v-if="source.note" class="dim">{{ source.note }}</span>
        </li>
        <li v-if="outputs.kmz">
          <a class="res-link" :href="mediaUrl(outputs.kmz.path)" download>{{ t('episode.documentary.map.results.downloadKmz') }}</a>
          <span class="dim">{{ outputs.kmz.path }}</span>
        </li>
        <li v-if="!registration && !outputs.kmz && !attribution && !provenanceSources.length" class="dim">{{ t('episode.documentary.map.results.noProvenance') }}</li>
      </ul>
      <p v-if="warnings.length" class="res-warn">{{ t('episode.documentary.map.results.warningsTitle', { n: warnings.length }) }}</p>
      <ul v-if="warnings.length" class="res-facts">
        <li v-for="(warning, index) in warnings" :key="`warn-${index}`">{{ warning }}</li>
      </ul>
    </section>

    <section v-if="research" class="res-block">
      <header class="res-head">
        <strong>{{ t('episode.documentary.map.results.sourcesTitle', { n: research.sources.length }) }}</strong>
        <span class="dim">{{ t('episode.documentary.map.results.searchedAt', { at: research.searched_at }) }}</span>
      </header>
      <ul class="res-sources">
        <li v-for="(source, index) in research.sources" :key="`src-${index}`" class="res-source">
          <span class="res-tier" :class="`is-${source.tier.toLowerCase()}`">{{ source.tier }}</span>
          <a v-if="source.url" class="res-link" :href="source.url" target="_blank" rel="noreferrer noopener">{{ source.title || source.url }}</a>
          <span v-else>{{ source.title }}</span>
          <span class="dim">{{ source.institution }}</span>
          <span class="dim">{{ source.date }}</span>
          <span class="dim">{{ source.license }}</span>
        </li>
      </ul>
      <p v-if="!research.sources.length" class="dim res-note">{{ t('episode.documentary.map.results.noSources') }}</p>

      <div v-if="research.features.length" class="res-features">
        <strong class="res-sub">{{ t('episode.documentary.map.results.featuresTitle', { n: research.features.length }) }}</strong>
        <ul class="res-sources">
          <li v-for="(feature, index) in research.features" :key="`feat-${index}`" class="res-source">
            <span class="res-kind">{{ t(`episode.documentary.map.results.kind.${feature.kind}`) }}</span>
            <strong>{{ feature.name }}</strong>
            <span class="res-uncertain" :class="`is-${feature.uncertainty}`">{{ t(`episode.documentary.map.results.uncertainty.${feature.uncertainty}`) }}</span>
            <span class="dim">{{ feature.basis }}</span>
            <a v-if="feature.source_url" class="res-link" :href="feature.source_url" target="_blank" rel="noreferrer noopener">{{ feature.source_title || feature.source_url }}</a>
          </li>
        </ul>
      </div>

      <div v-if="research.uncertainties.length" class="res-uncertainties">
        <strong class="res-sub">{{ t('episode.documentary.map.results.uncertaintiesTitle') }}</strong>
        <ul class="res-facts">
          <li v-for="(item, index) in research.uncertainties" :key="`unc-${index}`">{{ item }}</li>
        </ul>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
/**
 * 地图工作流结果与出处（Issue #84）。
 *
 * 「做完了」必须拿得出真图：确定性底图（before）、风格化成品（final）、可下载的 KMZ，以及底图配准与影像署名。
 * 考证来源、要素依据与不确定项一并显示——没把握的地方要说出来，不能在成品里装成确定结论。
 */
import { useI18n } from 'vue-i18n'
import type { MapResearch, MapWorkflowOutputs } from '~/composables/useApi'
import { mapPreviewImage, type MapPreviewView } from '~/utils/mapPreview'
import { registrationSummary, type MapRegistration } from '~/utils/mapRegistration'

const { t } = useI18n()

const props = defineProps<{
  outputs: MapWorkflowOutputs
  research: MapResearch | null
  registration: MapRegistration | null
}>()

const emit = defineEmits<{ (e: 'preview', view: MapPreviewView): void }>()

interface ResultCard { key: string; view: MapPreviewView; url: string; label: string; width: number; height: number; source: string }

function cardOf(view: Exclude<MapPreviewView, 'calibration'>): ResultCard | null {
  const image = mapPreviewImage(view, props.outputs, props.registration)
  if (!image) return null
  return {
    key: image.labelKey,
    view,
    url: image.url,
    label: t(`episode.documentary.map.results.${image.labelKey}`),
    width: image.width,
    height: image.height,
    source: image.source,
  }
}

const cards = computed(() => {
  const list = [cardOf('base'), cardOf('texture'), cardOf('final')].filter((card): card is ResultCard => !!card)
  const earth = mapPreviewImage('calibration', props.outputs, props.registration)
  if (earth) {
    list.push({
      key: 'calibration',
      view: 'calibration',
      url: earth.url,
      label: t('episode.documentary.map.results.calibrationEvidence'),
      width: earth.width,
      height: earth.height,
      source: earth.source,
    })
  }
  return list
})
const beforeCard = computed(() => cardOf('base'))
const finalCard = computed(() => cardOf('final'))

/**
 * 影像署名。
 * 底图 PNG 里已经烧进了署名条（Earth 的 Google 影像声明 / 外部图的来源与许可），这里只展示机器可读的那份，
 * 绝不再往成品上叠一层署名图层，否则会出现两份署名。
 */
const attribution = computed(() => {
  const parts: string[] = []
  for (const provenance of [props.outputs.final_image?.provenance, props.outputs.base_image?.provenance, props.outputs.kmz?.provenance]) {
    const text = provenance && typeof provenance.attribution === 'string' ? provenance.attribution.trim() : ''
    if (text && !parts.includes(text)) parts.push(text)
  }
  if (!parts.length) {
    const note = props.registration?.earth?.imagery_note
    if (note) parts.push(note)
    const image = props.registration?.image
    if (image?.source_url) parts.push(image.source_url)
    if (image?.license) parts.push(image.license)
  }
  return parts.join(' · ')
})

interface ProvenanceSource { kind: string; name: string; url: string; license: string; note: string }

/** provenance.sources[]：底图生产者给的机器可读出处（影像、矢量数据、外部原件） */
const provenanceSources = computed<ProvenanceSource[]>(() => {
  const raw = props.outputs.final_image?.provenance?.sources ?? props.outputs.base_image?.provenance?.sources
  if (!Array.isArray(raw)) return []
  const list: ProvenanceSource[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    list.push({
      kind: String(item.kind ?? ''),
      name: String(item.name ?? ''),
      url: String(item.url ?? ''),
      license: String(item.license ?? ''),
      note: String(item.note ?? ''),
    })
  }
  return list
})

/** 绘制阶段回报的 warnings（纹理强度等真实质量提醒）：几何超限/出框由几何侧直接报错，不会悄悄裁掉，所以这里只做如实展示 */
const warnings = computed<string[]>(() => {
  const sources = [props.outputs.final_image?.provenance?.warnings, props.outputs.layer_doc?.warnings]
  const list: string[] = []
  for (const raw of sources) {
    if (!Array.isArray(raw)) continue
    for (const item of raw) {
      const text = String(item ?? '').trim()
      if (text && !list.includes(text)) list.push(text)
    }
  }
  return list
})
</script>

<style scoped>
.res { display: flex; flex-direction: column; gap: 12px; }
.res-block { display: flex; flex-direction: column; gap: 6px; }
.res-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; font-size: 11px; color: var(--text-1); }
.res-sub { font: 600 11px var(--font-body); color: var(--text-1); }
.res-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 380px));
  justify-content: start;
  gap: 10px;
}
.res-compare {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 10px;
}
.res-card {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-soft);
  overflow: hidden;
}
.res-thumb {
  display: block;
  padding: 0;
  border: none;
  background: var(--bg-2);
  cursor: zoom-in;
}
.res-thumb img { display: block; width: 100%; height: auto; max-height: 420px; object-fit: contain; }
.res-card--wide .res-thumb img { max-height: 560px; }
.res-caption { display: flex; flex-direction: column; gap: 2px; padding: 6px 8px; font-size: 10.5px; color: var(--text-2); }
.res-caption strong { font: 600 11px var(--font-body); color: var(--text-1); }
.res-facts { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; font-size: 10.5px; color: var(--text-2); }
.res-facts li { display: flex; flex-wrap: wrap; gap: 6px; }
.res-note { margin: 0; font-size: 10.5px; }
.res-sources { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.res-source {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 4px 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-soft);
  font-size: 10.5px;
  color: var(--text-2);
}
.res-source strong { color: var(--text-1); }
.res-link { color: var(--accent-text); text-decoration: none; }
.res-link:hover { text-decoration: underline; }
.res-tier,
.res-kind,
.res-uncertain {
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  font: 600 10px var(--font-body);
}
.res-tier.is-a { border-color: var(--accent-text); color: var(--accent-text); }
.res-uncertain.is-high { background: var(--warn-bg); border-color: var(--warn-border); color: var(--warn-text); }
.res-features,
.res-uncertainties { display: flex; flex-direction: column; gap: 4px; }
.res-warn {
  margin: 4px 0 0;
  padding: 4px 8px;
  border-radius: 6px;
  background: var(--warn-bg);
  border: 1px solid var(--warn-border);
  color: var(--warn-text);
  font: 600 10.5px var(--font-body);
}
</style>
