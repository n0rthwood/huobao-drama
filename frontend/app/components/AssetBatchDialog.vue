<template>
  <Teleport to="body">
    <div v-if="open" class="overlay" @click.self="emit('close')">
      <div class="dialog asset-batch-dialog" role="dialog" aria-modal="true" :aria-label="scopeTitle">
        <header class="dialog-head">
          <h2 class="dialog-title">{{ scopeTitle }}</h2>
          <button type="button" class="btn btn-ghost btn-icon" :title="t('common.close')" @click="emit('close')">
            <X :size="13" />
          </button>
        </header>

        <div class="dialog-body asset-batch-body">
          <p v-if="loading" class="asset-batch-loading">{{ t('episode.assetBatch.previewLoading') }}</p>
          <template v-else-if="preview">
            <div class="asset-batch-row">
              <span>{{ t('episode.assetBatch.total') }}</span>
              <strong>{{ t('episode.assetBatch.totalValue', { n: preview.total }) }}</strong>
            </div>
            <div class="asset-batch-row">
              <span>{{ t('episode.assetBatch.willGenerate') }}</span>
              <strong>{{ t('episode.assetBatch.willGenerateValue', { n: willGenerate }) }}</strong>
            </div>
            <p class="asset-batch-detail dim">
              {{ t('episode.assetBatch.breakdown', {
                missing: preview.will_generate.missing_prompt,
                reuse: preview.will_generate.reuse_prompt,
                rewrite: preview.will_generate.rewrite_prompt,
              }) }}
            </p>
            <p class="asset-batch-detail dim">
              {{ t('episode.assetBatch.skipped', {
                image: preview.skipped.has_image,
                running: preview.skipped.running,
                faithful: preview.skipped.faithful,
                map: preview.skipped.map || 0,
              }) }}
            </p>

            <label class="asset-batch-check">
              <input type="checkbox" :checked="overwriteImages" @change="toggle('overwrite', $event)">
              <span>{{ t('episode.assetBatch.overwriteImages') }}</span>
            </label>
            <label class="asset-batch-check">
              <input type="checkbox" :checked="rewritePrompts" @change="toggle('rewrite', $event)">
              <span>{{ t('episode.assetBatch.rewritePrompts') }}</span>
            </label>

            <p class="asset-batch-note">{{ t('episode.assetBatch.faithfulNote') }}</p>
            <p class="asset-batch-note">{{ t('episode.assetBatch.pipelineNote', { n: concurrency }) }}</p>
            <p v-if="queueText" class="asset-batch-note">{{ queueText }}</p>
            <p v-if="offlineWarning" class="asset-batch-warn">{{ t('episode.assetBatch.workersOffline') }}</p>
            <p v-if="preview.running" class="asset-batch-warn">{{ t('episode.assetBatch.alreadyRunning') }}</p>
          </template>
          <p v-else class="asset-batch-warn">{{ t('episode.assetBatch.previewFailed') }}</p>
        </div>

        <footer class="dialog-foot">
          <button type="button" class="btn" @click="emit('close')">{{ t('common.cancel') }}</button>
          <button
            type="button"
            class="btn btn-primary"
            :disabled="loading || starting || !willGenerate || !!preview?.running"
            @click="start"
          >
            <Loader2 v-if="starting" :size="13" class="animate-spin" />
            {{ t('episode.assetBatch.start', { n: willGenerate }) }}
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
/**
 * 资产批量生成确认框（Issue #33）：分类统计（不是 per-item 清单）+ 两个勾选 + 排队预估。
 * 勾选变化会实时重算统计（preview 接受 rewrite_prompts / overwrite_images）。
 */
import { Loader2, X } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { assetBatchAPI, imageQueueAPI } from '~/composables/useApi'
import { toastError } from '~/composables/useToast'

const { t } = useI18n()

const props = defineProps({
  open: { type: Boolean, default: false },
  dramaId: { type: Number, default: 0 },
  episodeId: { type: Number, default: 0 },
  // characters | scenes | props | all
  scope: { type: String, default: 'all' },
  imageModel: { type: String, default: '' },
  imageConfigId: { type: Number, default: 0 },
  textModel: { type: String, default: '' },
  textConfigId: { type: Number, default: 0 },
})
const emit = defineEmits(['close', 'started'])

/** 后端默认文本并发（ASSET_PROMPT_CONCURRENCY），只用于文案说明 */
const concurrency = 3

const loading = ref(false)
const starting = ref(false)
const preview = ref(null)
const queue = ref(null)
const rewritePrompts = ref(false)
const overwriteImages = ref(false)

const scopeTitle = computed(() => t(`episode.assetBatch.title.${props.scope}`))
const willGenerate = computed(() => {
  const w = preview.value?.will_generate
  return w ? w.missing_prompt + w.reuse_prompt + w.rewrite_prompt : 0
})
const offlineWarning = computed(() => queue.value?.supported && queue.value.online_workers === 0)

function fmtSeconds(seconds) {
  const total = Math.round(Number(seconds))
  if (!Number.isFinite(total) || total <= 0) return ''
  if (total < 60) return `${total}s`
  const m = Math.floor(total / 60)
  const s = total % 60
  return s ? `${m}m ${s}s` : `${m}m`
}

const queueText = computed(() => {
  const data = queue.value
  if (!data?.supported) return ''
  const total = fmtSeconds(data.total_seconds)
  if (!total) return t('episode.assetBatch.queueWorkers', { workers: data.online_workers })
  return t('episode.assetBatch.queueEta', {
    workers: data.online_workers,
    wait: fmtSeconds(data.queue_wait_seconds) || '0s',
    total,
  })
})

function batchParams() {
  return {
    scope: props.scope,
    episode_id: props.episodeId,
    rewrite_prompts: rewritePrompts.value,
    overwrite_images: overwriteImages.value,
    model: props.imageModel || undefined,
    config_id: props.imageConfigId || undefined,
    text_model: props.textModel || undefined,
    text_config_id: props.textConfigId || undefined,
  }
}

function toggle(which, event) {
  const value = !!event.target.checked
  if (which === 'rewrite') rewritePrompts.value = value
  else overwriteImages.value = value
  void loadPreview()
}

let previewSeq = 0
async function loadPreview() {
  if (!props.dramaId || !props.episodeId) return
  const seq = ++previewSeq
  loading.value = true
  try {
    const data = await assetBatchAPI.preview(props.dramaId, batchParams())
    if (seq !== previewSeq) return
    preview.value = data
    void loadQueue(data)
  } catch (e) {
    if (seq !== previewSeq) return
    preview.value = null
    toastError(e)
  } finally {
    if (seq === previewSeq) loading.value = false
  }
}

/** 排队信息按本次真正会出图的张数问 qwen-jobs（非 qwen-jobs 供应商返回 supported:false） */
async function loadQueue(data) {
  const count = data.will_generate.missing_prompt + data.will_generate.reuse_prompt + data.will_generate.rewrite_prompt
  if (!count) { queue.value = null; return }
  try {
    queue.value = await imageQueueAPI.estimate({ config_id: props.imageConfigId || undefined, count })
  } catch {
    queue.value = null
  }
}

async function start() {
  starting.value = true
  try {
    const status = await assetBatchAPI.start(props.dramaId, batchParams())
    emit('started', status)
    emit('close')
  } catch (e) {
    toastError(e)
  } finally {
    starting.value = false
  }
}

watch(() => [props.open, props.scope], ([open]) => {
  if (!open) return
  preview.value = null
  queue.value = null
  void loadPreview()
}, { immediate: true })
</script>

<style scoped>
.asset-batch-dialog {
  width: 460px;
  max-width: calc(100vw - 48px);
}
.asset-batch-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.asset-batch-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
}
.asset-batch-detail,
.asset-batch-note {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
}
.asset-batch-note {
  color: var(--text-dim, #888);
}
.asset-batch-warn {
  margin: 0;
  font-size: 12px;
  color: var(--warning, #d08700);
}
.asset-batch-check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  cursor: pointer;
}
.asset-batch-loading {
  font-size: 13px;
  color: var(--text-dim, #888);
}
</style>
