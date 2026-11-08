<template>
  <Teleport to="body">
    <div v-if="state.active" class="migrate-overlay">
      <div class="migrate-box">
        <Loader2 :size="26" class="animate-spin" />
        <div class="migrate-title">{{ t('migrate.title') }}</div>
        <div class="migrate-msg">{{ state.message }}</div>
        <div class="migrate-bar">
          <div class="migrate-bar-fill" :style="{ width: `${state.percent}%` }"></div>
        </div>
        <div class="migrate-hint">{{ t('migrate.hint') }}</div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { Loader2 } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { useMigrateState } from '~/composables/useMigrateState'
import { DEEPLINK_KEYS, useDeeplink } from '~/composables/useQuerySync'

const { t } = useI18n()
const { state } = useMigrateState()

// deeplink（#86）：遮罩在场时链接里带 migrating=1，复制出去能表达「这台机器正在迁移存储」。
// 恢复只认真实状态：迁移进度来自桌面端主进程推送，刷新后没有在跑的迁移就摘键并说明，
// 绝不凭链接伪造一个进度遮罩（那会假装有迁移在进行）。
const link = useDeeplink('migrateOverlay', DEEPLINK_KEYS.migrateOverlay)
watch(() => state.active, active => link.set({ migrating: active ? '1' : '' }), { immediate: true })
onMounted(() => {
  if (link.initial('migrating') === '1' && !state.active) toast.info(t('deeplink.missing'))
})
</script>

<style scoped>
.migrate-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-blocking);
  background: rgba(8, 10, 14, 0.72);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
}
.migrate-box {
  width: 380px;
  padding: 28px 32px;
  border-radius: 12px;
  background: var(--surface-raised);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-elevated);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: var(--text-0);
}
.migrate-title {
  font-size: 15px;
  font-weight: 600;
}
.migrate-msg {
  font-size: 12px;
  color: var(--text-2);
  min-height: 16px;
}
.migrate-bar {
  width: 100%;
  height: 6px;
  border-radius: 3px;
  background: var(--overlay-track);
  overflow: hidden;
}
.migrate-bar-fill {
  height: 100%;
  border-radius: 3px;
  background: var(--accent);
  transition: width 0.2s ease;
}
.migrate-hint {
  font-size: 11px;
  color: var(--text-3);
}
</style>
