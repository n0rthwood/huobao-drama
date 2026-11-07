<template>
  <div class="rs">
    <p v-if="loadError" class="rs-error">{{ loadError }}</p>
    <section v-for="s in sources" :key="s.id" class="card rs-card">
      <div class="rs-head">
        <div class="rs-badge"><Library :size="15" /></div>
        <div class="rs-main">
          <div class="rs-line">
            <span class="rs-name">{{ s.name }}</span>
            <span :class="['rs-state', s.configured && 'on']">
              {{ s.configured
                ? (s.key_hint ? t('settings.research.configuredHint', { hint: s.key_hint }) : t('settings.research.configured'))
                : t('settings.research.notConfigured') }}
            </span>
          </div>
          <div class="rs-desc">{{ t(`settings.research.sources.${s.id}.desc`) }}</div>
          <div class="rs-use">{{ t(`settings.research.sources.${s.id}.use`) }}</div>
        </div>
        <a class="btn btn-sm rs-apply" :href="s.apply_url" target="_blank" rel="noopener noreferrer">
          <ExternalLink :size="12" />{{ t('settings.research.apply') }}
        </a>
      </div>

      <div class="rs-form">
        <div class="rs-input-wrap">
          <input
            v-model="drafts[s.id]"
            class="input rs-input"
            :type="reveal[s.id] ? 'text' : 'password'"
            autocomplete="off"
            spellcheck="false"
            :placeholder="s.configured ? t('settings.research.replacePlaceholder') : t('settings.research.keyPlaceholder')"
            :aria-label="t('settings.research.keyLabel', { name: s.name })"
          />
          <button
            type="button"
            class="rs-eye"
            :title="reveal[s.id] ? t('settings.research.hide') : t('settings.research.show')"
            :aria-label="reveal[s.id] ? t('settings.research.hide') : t('settings.research.show')"
            @click="reveal[s.id] = !reveal[s.id]"
          >
            <EyeOff v-if="reveal[s.id]" :size="14" /><Eye v-else :size="14" />
          </button>
        </div>
        <button class="btn btn-sm" type="button" :disabled="busy[s.id] || (!drafts[s.id]?.trim() && !s.configured)" @click="test(s)">
          <Loader2 v-if="busy[s.id] === 'test'" :size="12" class="animate-spin" /><PlugZap v-else :size="12" />
          {{ drafts[s.id]?.trim() ? t('settings.research.testDraft') : t('settings.research.test') }}
        </button>
        <button class="btn btn-sm btn-primary" type="button" :disabled="busy[s.id] || !drafts[s.id]?.trim()" @click="store(s, drafts[s.id].trim())">
          <Loader2 v-if="busy[s.id] === 'save'" :size="12" class="animate-spin" /><Save v-else :size="12" />
          {{ t('settings.research.save') }}
        </button>
        <button v-if="s.configured" class="btn btn-sm" type="button" :disabled="busy[s.id]" @click="store(s, null)">
          <Trash2 :size="12" />{{ t('settings.research.clear') }}
        </button>
      </div>

      <p v-if="results[s.id]" :class="['rs-result', results[s.id].ok ? 'ok' : 'fail']" role="status">
        <CheckCircle2 v-if="results[s.id].ok" :size="13" /><CircleAlert v-else :size="13" />
        {{ results[s.id].ok
          ? t('settings.research.testOk', { count: results[s.id].count })
          : t('settings.research.testFail', { reason: results[s.id].message || '—' }) }}
      </p>
    </section>
    <p class="rs-note">{{ t('settings.research.securityNote') }}</p>
  </div>
</template>

<script setup>
/**
 * 资料检索 API key（Issue #78）。
 * 服务端永不返回完整 key：保存后只显示末 4 位；「测试连接」在服务端发请求，可带未保存的草稿 key（不落库）。
 */
import { CheckCircle2, CircleAlert, ExternalLink, Eye, EyeOff, Library, Loader2, PlugZap, Save, Trash2 } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { toastError } from '~/composables/useToast'
import { settingsAPI } from '~/composables/useApi'

const { t } = useI18n()

const sources = ref([])
const loadError = ref('')
const drafts = reactive({})
const reveal = reactive({})
const busy = reactive({})
const results = reactive({})

async function load() {
  try {
    sources.value = (await settingsAPI.researchSources())?.sources ?? []
    loadError.value = ''
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : t('settings.research.loadFailed')
  }
}

/** 保存（key 为字符串）或清除（null）；以服务端返回的视图为准（只含末 4 位提示） */
async function store(s, key) {
  busy[s.id] = 'save'
  try {
    const view = await settingsAPI.setResearchKey(s.id, key)
    sources.value = sources.value.map(item => (item.id === view.id ? view : item))
    drafts[s.id] = ''
    reveal[s.id] = false
    delete results[s.id]
    toast.success(t(key ? 'settings.research.saved' : 'settings.research.cleared', { name: s.name }))
  } catch (e) {
    toastError(e)
  } finally {
    busy[s.id] = ''
  }
}

async function test(s) {
  busy[s.id] = 'test'
  try {
    results[s.id] = await settingsAPI.testResearchKey(s.id, drafts[s.id]?.trim() || undefined)
  } catch (e) {
    toastError(e)
  } finally {
    busy[s.id] = ''
  }
}

onMounted(load)
</script>

<style scoped>
.rs { display: flex; flex-direction: column; gap: 14px; }
.rs-card { padding: 16px 20px; display: flex; flex-direction: column; gap: 12px; }
.rs-head { display: flex; align-items: flex-start; gap: 12px; }
.rs-badge {
  flex: none; width: 32px; height: 32px; border-radius: 9px;
  display: grid; place-items: center; background: var(--accent-bg); color: var(--accent);
}
.rs-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.rs-line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rs-name { font-size: 13.5px; font-weight: 650; color: var(--text-0); }
.rs-state {
  font-size: 11px; padding: 1px 8px; border-radius: var(--radius-pill);
  background: var(--overlay-track); color: var(--text-3);
}
.rs-state.on { background: var(--success-bg, var(--accent-bg)); color: var(--success, var(--accent)); }
.rs-desc { font-size: 12px; color: var(--text-2); line-height: 1.5; }
.rs-use { font-size: 11.5px; color: var(--text-3); line-height: 1.5; }
.rs-apply { flex: none; text-decoration: none; }
.rs-form { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rs-input-wrap { position: relative; flex: 1 1 320px; min-width: 0; }
.rs-input { width: 100%; padding-right: 34px; font-family: var(--font-mono, monospace); }
.rs-input::placeholder { font-family: var(--font-body); }
.rs-eye {
  position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
  border: 0; background: transparent; color: var(--text-3); cursor: pointer; padding: 4px; display: grid;
}
.rs-eye:hover { color: var(--text-1); }
.rs-result { margin: 0; display: flex; align-items: center; gap: 6px; font-size: 12px; overflow-wrap: anywhere; }
.rs-result.ok { color: var(--success, var(--accent)); }
.rs-result.fail { color: var(--danger, #d14343); }
.rs-error { margin: 0; font-size: 12px; color: var(--danger, #d14343); }
.rs-note { margin: 0; font-size: 11.5px; color: var(--text-3); }
</style>
