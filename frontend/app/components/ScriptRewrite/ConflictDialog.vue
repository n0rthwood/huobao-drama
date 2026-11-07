<template>
  <Teleport to="body">
    <div class="overlay" @click.self="emit('close')">
      <div class="dialog cd-dialog" role="dialog" aria-modal="true" :aria-label="title">
        <header class="dialog-head">
          <h2 class="dialog-title">{{ title }}</h2>
          <button class="btn btn-ghost btn-icon" :aria-label="t('common.close')" @click="emit('close')">
            <X :size="14" />
          </button>
        </header>

        <div class="dialog-body cd-body">
          <p class="cd-note">{{ note }}</p>
          <p v-if="message" class="cd-server">{{ message }}</p>

          <div class="cd-columns">
            <section class="cd-col">
              <h3 class="cd-col-title">{{ t('episode.rewrite.conflict.current') }}</h3>
              <pre class="cd-text">{{ current || '—' }}</pre>
            </section>
            <section class="cd-col">
              <h3 class="cd-col-title">{{ mineTitle }}</h3>
              <pre class="cd-text">{{ mine || '—' }}</pre>
            </section>
          </div>

          <section class="cd-diff">
            <h3 class="cd-col-title">{{ t('episode.rewrite.conflict.diffTitle') }}</h3>
            <DiffView :before="current" :after="mine" />
          </section>
        </div>

        <footer class="dialog-foot cd-foot">
          <button class="btn" :disabled="busy" @click="emit('keep')">{{ t('episode.rewrite.conflict.keepCurrent') }}</button>
          <button class="btn" :disabled="busy || !mine" @click="copyMine">
            {{ copied ? t('episode.rewrite.conflict.copied') : t('episode.rewrite.conflict.copyMine') }}
          </button>
          <button class="btn btn-primary" :disabled="busy || !mine" @click="emit('apply')">
            {{ kind === 'adopt' ? t('episode.rewrite.conflict.adoptAgain') : t('episode.rewrite.conflict.overwrite') }}
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
/**
 * 最终稿冲突处理（Issue #70）：**绝不自动合并**。
 *
 * 保存冲突 = 我的草稿 vs 服务器上更新后的最终稿；采用冲突 = 候选版本 vs 当前最终稿。
 * 两者都先展示对照与差异，由人决定「保留当前」「复制我的草稿」还是「按最新修订覆盖」。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { X } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import DiffView from '~/components/ScriptRewrite/DiffView.vue'
import { copyToClipboard } from '~/utils/clipboard'

const props = defineProps({
  kind: { type: String, default: 'save' },
  mine: { type: String, default: '' },
  current: { type: String, default: '' },
  message: { type: String, default: '' },
  busy: { type: Boolean, default: false },
})
const emit = defineEmits(['close', 'keep', 'apply'])

const { t } = useI18n()
const copied = ref(false)

const title = computed(() => (props.kind === 'adopt'
  ? t('episode.rewrite.conflict.adoptTitle')
  : t('episode.rewrite.conflict.saveTitle')))
const note = computed(() => (props.kind === 'adopt'
  ? t('episode.rewrite.conflict.adoptNote')
  : t('episode.rewrite.conflict.saveNote')))
const mineTitle = computed(() => (props.kind === 'adopt'
  ? t('episode.rewrite.conflict.candidate')
  : t('episode.rewrite.conflict.mine')))

async function copyMine() {
  if (await copyToClipboard(props.mine)) {
    copied.value = true
    toast.success(t('episode.rewrite.conflict.copied'))
  } else {
    toast.error(t('episode.rewrite.conflict.copyFailed'))
  }
}
</script>

<style scoped>
.cd-dialog { width: 1000px; max-width: calc(100vw - 48px); max-height: calc(100vh - 64px); display: flex; flex-direction: column; }
.cd-body { overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }
.cd-note { margin: 0; font-size: 12.5px; color: var(--text-1); line-height: 1.7; }
.cd-server { margin: 0; font-size: 11.5px; color: var(--danger-text, #d9534f); }
.cd-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
@media (max-width: 1100px) { .cd-columns { grid-template-columns: 1fr; } }
.cd-col { min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.cd-col-title { margin: 0; font-size: 11.5px; font-weight: 700; color: var(--text-2); }
.cd-text {
  margin: 0; padding: 8px 10px; max-height: 240px; overflow: auto;
  background: var(--overlay-track); border-radius: var(--radius);
  font-size: 12px; line-height: 1.8; white-space: pre-wrap; word-break: break-word; color: var(--text-1);
}
.cd-diff { display: flex; flex-direction: column; gap: 5px; }
.cd-foot { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
</style>
