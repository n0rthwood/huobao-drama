<template>
  <section class="nt">
    <div class="nt-grid">
      <label class="nt-field">
        <span class="nt-label">{{ t('mapStudio.app.newTaskTitle') }}</span>
        <input v-model="title" class="input" :placeholder="t('mapStudio.app.newTaskTitlePlaceholder')" />
      </label>
    </div>

    <MapBriefForm :brief="brief" :issues="[]" :disabled="submitting" @patch="patchBrief" />

    <p v-if="error" class="nt-error">{{ error }}</p>

    <div class="nt-actions">
      <button type="button" class="btn btn-sm btn-primary" :disabled="submitting || !canSubmit" @click="submit">
        <Loader2 v-if="submitting" :size="11" class="animate-spin" />
        {{ submitting ? t('mapStudio.app.creating') : t('mapStudio.app.create') }}
      </button>
      <button type="button" class="btn btn-sm" :disabled="submitting" @click="emit('cancel')">{{ t('mapStudio.panel.discard') }}</button>
      <span class="nt-note dim">{{ t('mapStudio.app.createHint') }}</span>
    </div>
  </section>
</template>

<script setup lang="ts">
/**
 * 新建独立任务（Issue #99）：没有火宝宿主，需求直接存模块任务行。
 *
 * 表单与宿主任务用的是同一份 MapBrief（对象 / 年代 / 地域 / 用途四项明确才推得动后续阶段），
 * 提交只创建任务，不自动开跑——跑不跑、用什么模型由人在 harness 里决定。
 */
import { Loader2 } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import MapBriefForm from '~/map-studio/components/MapBriefForm.vue'
import { mapStudioAPI, type MapBrief } from '~/map-studio/api'

const { t } = useI18n()

const emit = defineEmits<{
  (e: 'cancel'): void
  (e: 'created', taskId: number): void
}>()

function emptyBrief(): MapBrief {
  return {
    subject: '',
    era: '',
    location: '',
    purpose: '',
    detail_level: 'regional',
    schematic: false,
    base_mode: 'program',
    style: 'archival',
    notes: '',
    reference_image: null,
    inferred: [],
  }
}

const title = ref('')
const brief = ref<MapBrief>(emptyBrief())
const submitting = ref(false)
const error = ref('')

const canSubmit = computed(() => !!title.value.trim() && !!brief.value.subject.trim())

function patchBrief(patch: Partial<MapBrief>) {
  brief.value = { ...brief.value, ...patch }
}

async function submit() {
  if (submitting.value || !canSubmit.value) return
  submitting.value = true
  error.value = ''
  try {
    const detail = await mapStudioAPI.createTask({ title: title.value.trim(), brief: brief.value })
    emit('created', detail.task_id)
  } catch (err) {
    error.value = err instanceof Error && err.message ? err.message : t('mapStudio.app.createFailed')
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.nt { display: flex; flex-direction: column; gap: 10px; }
.nt-grid { display: flex; flex-wrap: wrap; gap: 8px; }
.nt-field { display: flex; flex-direction: column; gap: 3px; flex: 1 1 320px; font-size: 10.5px; color: var(--text-2); }
.nt-label { font: 600 11px var(--font-body); color: var(--text-1); }
.nt-error { margin: 0; font-size: 10.5px; color: var(--action-danger); }
.nt-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.nt-note { font-size: 10.5px; }
</style>
