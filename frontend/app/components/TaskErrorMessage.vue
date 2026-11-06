<template>
  <div class="task-error-message" role="status">
    <p class="task-error-summary">{{ presentation.message }}</p>
    <details v-if="presentation.hasDetails">
      <summary>{{ t('taskCenter.errorPresentation.details') }}</summary>
      <pre>{{ presentation.diagnostic }}</pre>
    </details>
    <button v-if="showCopy" class="btn btn-ghost btn-sm" type="button" @click="copy">
      {{ t(copied ? 'taskCenter.errorPresentation.copied' : 'taskCenter.errorPresentation.copy') }}
    </button>
  </div>
</template>

<script setup>
import { computed, ref, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { copyToClipboard } from '~/utils/clipboard'
import { taskErrorPresentation } from '~/utils/taskError'

const props = defineProps({ error: { type: String, default: '' }, showCopy: { type: Boolean, default: true } })
const { t } = useI18n()
const presentation = computed(() => taskErrorPresentation(props.error, t))
const copied = ref(false)
let resetTimer
async function copy() {
  if (await copyToClipboard(presentation.value.diagnostic)) {
    copied.value = true
    clearTimeout(resetTimer)
    resetTimer = setTimeout(() => { copied.value = false }, 1800)
  }
}
onBeforeUnmount(() => clearTimeout(resetTimer))
</script>

<style scoped>
.task-error-message { min-width: 0; color: var(--danger-text, var(--action-danger)); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.task-error-summary { margin: 0; white-space: pre-wrap; }
summary { cursor: pointer; color: var(--text-2); margin-top: 6px; }
pre { margin: 6px 0 0; padding: 8px; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 200px; overflow-y: auto; background: var(--overlay-track); border-radius: var(--radius); font: inherit; }
</style>
