<script setup>
/**
 * 资产审核清单（Issue #54 建壳，R2 填充）
 *
 * 纪录片「资产」步的第二个子页签：AI 逐条列出「信息点 → 需要的素材 → 有/缺」，
 * 全部处置后 `episodes.asset_review_status` 变成 `passed`，分镜设计步才解锁。
 * R1 只提供空态与当前清单状态；对照本体（运行、条目、处置）属于 R2。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ClipboardCheck } from 'lucide-vue-next'

const props = defineProps({
  /** `GET /episodes/:id/gates` 的 assets 分项：{ review_status, stale_reasons } */
  review: { type: Object, default: () => ({ review_status: 'none', stale_reasons: [] }) },
})

const { t } = useI18n()

const statusLabel = computed(() => {
  const map = {
    none: t('episode.assetReview.statusNone'),
    running: t('episode.assetReview.statusRunning'),
    pending: t('episode.assetReview.statusPending'),
    passed: t('episode.assetReview.statusPassed'),
  }
  return map[props.review?.review_status] || map.none
})
</script>

<template>
  <div class="prod-content">
    <div class="prod-section-bar">
      <span class="dim" style="font-size:12px">{{ t('episode.assets.tabReview') }}</span>
      <span class="tag mono">{{ t('episode.assetReview.statusLabel', { status: statusLabel }) }}</span>
    </div>
    <div class="step-empty" style="flex:1">
      <div class="empty-visual">
        <ClipboardCheck :size="32" />
      </div>
      <div class="empty-title">{{ t('episode.assetReview.emptyTitle') }}</div>
      <div class="empty-desc">{{ t('episode.assetReview.emptyDesc') }}</div>
      <button class="btn btn-primary" disabled :title="t('episode.assetReview.startDisabled')">
        {{ t('episode.assetReview.start') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.prod-content { flex: 1; overflow-y: auto; padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 10px; }
.prod-section-bar { display: flex; align-items: center; gap: 8px; }
.step-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; text-align: center; }
.empty-visual { opacity: 0.5; }
.empty-title { font-size: 13px; font-weight: 600; }
.empty-desc { font-size: 12px; opacity: 0.65; max-width: 520px; line-height: 1.6; }
</style>
