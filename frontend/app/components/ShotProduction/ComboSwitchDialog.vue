<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="dialog cs-dialog">
      <header class="dialog-head">
        <h2 class="dialog-title">{{ t('episode.segment.comboSwitchTitle', { n: shotNo }) }}</h2>
        <button class="btn btn-ghost btn-icon" @click="emit('close')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </header>
      <div class="dialog-body cs-body">
        <div class="cs-targets">
          <span class="cs-targets-label">{{ t('episode.segment.comboSwitchTo') }}</span>
          <button
            v-for="key in COMBOS" :key="key"
            type="button"
            :class="['cs-target', { on: target === key, disabled: key === from }]"
            :disabled="key === from"
            @click="pick(key)"
          >
            <span class="cs-glyph">{{ COMBO_GLYPH[key] }}</span>
            <span>{{ t(`episode.design.combo.${key}.name`) }}</span>
          </button>
        </div>

        <div v-if="loading" class="cs-loading">{{ t('episode.segment.comboSwitchLoading') }}</div>
        <p v-else-if="error" class="cs-error">{{ error }}</p>
        <div v-else-if="impact" class="cs-columns">
          <section class="cs-col">
            <h3 class="cs-col-title">{{ t('episode.segment.comboKeep') }}</h3>
            <ul class="cs-list">
              <li v-for="item in impact.keep" :key="item.code">{{ item.text }}</li>
              <li v-if="!impact.keep.length" class="cs-empty">{{ t('episode.segment.comboNone') }}</li>
            </ul>
          </section>
          <section class="cs-col">
            <h3 class="cs-col-title">{{ t('episode.segment.comboArchive') }}</h3>
            <ul class="cs-list">
              <li v-for="item in impact.archive" :key="item.code">{{ item.text }}</li>
              <li v-if="!impact.archive.length" class="cs-empty">{{ t('episode.segment.comboNone') }}</li>
            </ul>
          </section>
          <section class="cs-col">
            <h3 class="cs-col-title">{{ t('episode.segment.comboRedo') }}</h3>
            <ul class="cs-list">
              <li v-for="item in impact.redo" :key="item.code">{{ item.text }}</li>
              <li v-if="!impact.redo.length" class="cs-empty">{{ t('episode.segment.comboNone') }}</li>
            </ul>
          </section>
        </div>
      </div>
      <footer class="dialog-foot">
        <p class="cs-note">{{ t('episode.segment.comboNote') }}</p>
        <button class="btn" @click="emit('close')">{{ t('episode.segment.comboCancel') }}</button>
        <button class="btn btn-primary" :disabled="!target || loading || submitting || target === from" @click="confirm">
          {{ submitting ? t('episode.segment.comboSwitching') : t('episode.segment.comboConfirm') }}
        </button>
      </footer>
    </div>
  </div>
</template>

<script setup>
/**
 * 组合切换对话框（Issue #58）：三栏「保留 / 失效（归档可恢复）/ 需要新做」，
 * 数据来自 GET /storyboards/:id/combo/impact?to=；确认后 POST /storyboards/:id/combo。
 * 切换只归档不删除，被替换的版本仍可在历史里恢复。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { storyboardAPI } from '~/composables/useApi'
import { toastServerMessage } from '~/composables/useToast'

const props = defineProps({
  storyboardId: { type: Number, required: true },
  shotNumber: { type: Number, default: 0 },
  from: { type: String, default: '' },
  // 打开时预选的目标组合（从设计卡点过来时就是用户想切到的那一档），有则立刻拉影响
  initial: { type: String, default: '' },
})
const emit = defineEmits(['close', 'switched'])
const { t } = useI18n()

const COMBOS = ['A', 'B', 'C', 'D']
const COMBO_GLYPH = { A: '▣', B: '▶', C: '▣→▶', D: '▶→▣' }

const shotNo = computed(() => String(props.shotNumber || 0).padStart(2, '0'))
const target = ref('')
const impact = ref(null)
const loading = ref(false)
const submitting = ref(false)
const error = ref('')

async function pick(combo) {
  if (combo === props.from || combo === target.value) return
  target.value = combo
  impact.value = null
  error.value = ''
  loading.value = true
  try {
    impact.value = await storyboardAPI.comboImpact(props.storyboardId, combo)
  } catch (e) {
    error.value = e?.body?.error || e?.message || String(e)
    target.value = ''
  } finally {
    loading.value = false
  }
}

async function confirm() {
  if (!target.value) return
  submitting.value = true
  try {
    const res = await storyboardAPI.setCombo(props.storyboardId, target.value)
    toast.success(t('episode.segment.comboSwitched'))
    emit('switched', res)
    emit('close')
  } catch (e) {
    toastServerMessage(e, { fallback: 'episode.segment.comboSwitchFailed' })
  } finally {
    submitting.value = false
  }
}

// 打开时预选目标并预取影响（换镜/换目标时重来）
watch(() => [props.storyboardId, props.initial], ([, initial]) => {
  target.value = ''
  impact.value = null
  error.value = ''
  if (initial && initial !== props.from) void pick(initial)
}, { immediate: true })
</script>

<style scoped>
.cs-dialog { max-width: 720px; width: 92vw; }
.cs-body { display: flex; flex-direction: column; gap: 10px; }
.cs-targets { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.cs-targets-label { font-size: 12px; color: var(--text-2); }
.cs-target { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; font-size: 12px; border: 1px solid var(--border); border-radius: 6px; background: none; color: var(--text-2); cursor: pointer; }
.cs-target.on { border-color: var(--accent); color: var(--text-0); }
.cs-target.disabled { opacity: 0.45; cursor: not-allowed; }
.cs-glyph { color: var(--text-3); }
.cs-loading, .cs-error { font-size: 12px; color: var(--text-3); }
.cs-error { color: #c0472e; }
.cs-columns { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.cs-col { border: 1px solid var(--border); border-radius: 8px; padding: 8px; background: var(--surface-card); }
.cs-col-title { margin: 0 0 6px; font-size: 12px; color: var(--text-2); }
.cs-list { margin: 0; padding-left: 16px; font-size: 12px; line-height: 1.7; }
.cs-empty { list-style: none; color: var(--text-3); margin-left: -16px; }
.cs-note { margin: 0 auto 0 0; font-size: 12px; color: var(--text-3); }
</style>
