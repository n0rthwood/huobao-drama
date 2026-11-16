<template>
  <section class="pip">
    <header class="pip-head">
      <strong>{{ t('mapStudio.pip.title') }}</strong>
      <span class="pip-meta">{{ t('mapStudio.pip.layout', { id: pip.layout.id, family: t('mapStudio.pip.family.' + pip.layout.family), tier: t('mapStudio.pip.labelTier.' + pip.layout.label_tier) }) }}</span>
      <span class="dim">{{ t('mapStudio.pip.aspect', { aspect: pip.aspect }) }}</span>
    </header>
    <p class="pip-hint dim">{{ t('mapStudio.pip.hint') }}</p>

    <p v-if="!rows.length" class="pip-empty dim">{{ t('mapStudio.pip.noFrames') }}</p>
    <div v-else class="pip-frames">
      <figure v-for="row in rows" :key="row.frame.no" class="pip-frame">
        <div class="pip-frame-head">
          <span class="pip-no" :style="{ background: row.color }">{{ row.frame.no }}</span>
          <span class="pip-role" :class="`is-${row.frame.role}`">{{ t('mapStudio.pip.role.' + row.frame.role) }}</span>
          <strong class="pip-label">{{ row.frame.label }}</strong>
        </div>
        <!-- 细节图在「完成」登记前还没有：如实说没渲染，不拿全览图冒充 -->
        <button v-if="row.detail" type="button" class="pip-thumb" @click="openDetail(row.frame.no)">
          <img
            :src="thumbOf(mediaUrl(row.detail.path))"
            :alt="row.frame.label"
            loading="lazy"
            @error="thumbFallback($event, mediaUrl(row.detail.path))"
          />
        </button>
        <p v-else class="pip-missing dim">{{ t('mapStudio.pip.detailPending') }}</p>
        <figcaption class="pip-caption">
          <p class="pip-reason">{{ row.frame.reason }}</p>
          <span class="pip-fact">{{ row.frame.storyboard_numbers.length
            ? t('mapStudio.pip.storyboards', { numbers: row.frame.storyboard_numbers.map(n => `#${n}`).join('、') })
            : t('mapStudio.pip.noStoryboard') }}</span>
          <span class="pip-fact">{{ t('mapStudio.pip.bbox', { bbox: row.frame.bbox.map(n => Number(n).toFixed(2)).join(' / ') }) }}</span>
        </figcaption>
      </figure>
    </div>

    <figure v-if="pip.composite" class="pip-frame pip-frame--composite">
      <button type="button" class="pip-thumb" @click="emit('preview', PIP_COMPOSITE_VIEW)">
        <img
          :src="thumbOf(mediaUrl(pip.composite.path))"
          :alt="t('mapStudio.pip.compositeTitle')"
          loading="lazy"
          @error="thumbFallback($event, mediaUrl(pip.composite.path))"
        />
      </button>
      <figcaption class="pip-caption">
        <strong class="pip-label">{{ t('mapStudio.pip.compositeTitle') }}</strong>
        <span class="pip-fact dim">{{ t('mapStudio.results.size', { w: pip.composite.width, h: pip.composite.height }) }}</span>
      </figcaption>
    </figure>
    <p v-else-if="rows.length" class="pip-missing dim">{{ t('mapStudio.pip.compositePending') }}</p>

    <details v-if="pip.usage" class="pip-usage">
      <summary>{{ t('mapStudio.pip.usageTitle') }}</summary>
      <pre class="pip-usage-body">{{ pip.usage }}</pre>
    </details>
  </section>
</template>

<script setup lang="ts">
/**
 * 画中画结果（Issue #107）：版式、每个细节框、已渲染的细节图与组合图、用法说明。
 *
 * 细节图的取景框由底图阶段决定，重跑底图就会换；本组件只如实呈现服务端产出，
 * 还没渲染的细节写明「还没渲染」，绝不显示空白大图或别的细节的图。
 * 点击缩略图沿用页面既有的产出预览机制（msview 只记产出身份，URL 里不带图片路径）。
 */
import { useI18n } from 'vue-i18n'
import type { MapPipDetail, MapPipOutput } from '~/map-studio/api'
import { pipFrameColor } from '~/map-studio/utils/mapPip'
import { PIP_COMPOSITE_VIEW, pipDetailView, type MapPreviewView } from '~/map-studio/utils/mapPreview'
import { mediaUrl } from '~/utils/url'
import { thumbFallback, thumbOf } from '~/composables/useMedia'

const { t } = useI18n()

const props = defineProps<{ pip: MapPipOutput }>()
const emit = defineEmits<{ (e: 'preview', view: MapPreviewView): void }>()

interface FrameRow { frame: MapPipOutput['frames'][number], detail: MapPipDetail | null, color: string }

const rows = computed<FrameRow[]>(() => (props.pip.frames ?? []).map(frame => ({
  frame,
  detail: (props.pip.details ?? []).find(item => item.no === frame.no) ?? null,
  color: pipFrameColor(frame.no) ?? '',
})))

function openDetail(no: number) {
  const view = pipDetailView(no)
  if (view) emit('preview', view)
}
</script>

<style scoped>
.pip { display: flex; flex-direction: column; gap: 6px; }
.pip-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px; font-size: 11px; color: var(--text-1); }
.pip-head strong { font: 600 12px var(--font-body); }
.pip-meta { font: 600 10.5px var(--font-body); color: var(--text-2); }
.pip-hint { margin: 0; font-size: 10.5px; }
.pip-empty { margin: 0; font-size: 10.5px; }
.pip-frames {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 380px));
  justify-content: start;
  gap: 10px;
}
.pip-frame {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-soft);
  overflow: hidden;
}
.pip-frame--composite { max-width: 560px; }
.pip-frame-head { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; padding: 6px 8px 0; }
.pip-no {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  border-radius: 999px;
  color: #fff;
  font: 700 10.5px var(--font-body);
}
.pip-role {
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  font: 600 10px var(--font-body);
  color: var(--text-2);
}
.pip-role.is-primary { border-color: var(--accent-text); color: var(--accent-text); }
.pip-label { font: 600 11px var(--font-body); color: var(--text-1); word-break: break-word; }
.pip-thumb {
  display: block;
  padding: 0;
  border: none;
  background: var(--bg-2);
  cursor: zoom-in;
}
.pip-thumb img { display: block; width: 100%; height: auto; max-height: 320px; object-fit: contain; }
.pip-missing { margin: 0; padding: 6px 8px; font-size: 10.5px; }
.pip-caption { display: flex; flex-direction: column; gap: 3px; padding: 6px 8px; font-size: 10.5px; color: var(--text-2); }
.pip-reason { margin: 0; word-break: break-word; }
.pip-fact { word-break: break-word; }
.pip-usage {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-soft);
  padding: 6px 9px;
  font-size: 10.5px;
  color: var(--text-2);
}
.pip-usage summary { cursor: pointer; font: 600 11px var(--font-body); color: var(--text-1); }
.pip-usage-body {
  margin: 6px 0 0;
  font: 10.5px/1.6 var(--font-body);
  color: var(--text-2);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
