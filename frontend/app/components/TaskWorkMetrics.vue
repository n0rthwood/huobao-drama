<template>
  <div v-if="summary || estimate" :class="['twm', { 'is-dense': dense }]">
    <!-- 开跑前：只有计划字数与历史样本 ETA -->
    <template v-if="!summary && estimate">
      <span class="twm-item mono">{{ t('workMetrics.plannedChars', { chars: estimate.planned_source_chars, units: estimate.planned_units }) }}</span>
      <span v-if="estimate.blocked_units" class="twm-item twm-warn">{{ t('workMetrics.blockedUnits', { n: estimate.blocked_units }) }}</span>
      <span v-if="estimate.estimate_ms !== null" class="twm-item mono">
        {{ t('workMetrics.planEta', { duration: fmtDuration(estimate.estimate_ms), n: estimate.sample_count }) }}
      </span>
      <span v-else class="twm-item twm-muted">{{ t('workMetrics.noSamples') }}</span>
    </template>

    <!-- 运行中 / 已结束：全部数字来自持久观测事实 -->
    <template v-else-if="summary">
      <span class="twm-item mono">
        {{ t('workMetrics.units', { done: summary.completed_units, total: summary.planned_units }) }}
      </span>
      <!--
        真实进度条：已完成 / 失败 / 中断分段着色，剩余留空。
        「处理完 100%」不等于成功，失败与中断永远单独显示，不被进度条吞掉。
      -->
      <span class="twm-bar" :title="t('workMetrics.barHint')">
        <span class="twm-bar-ok" :style="{ width: pct(summary.completed_units) }" />
        <span class="twm-bar-bad" :style="{ width: pct(summary.failed_units) }" />
        <span class="twm-bar-warn" :style="{ width: pct(summary.interrupted_units) }" />
      </span>
      <span v-if="summary.failed_units" class="twm-item twm-bad">{{ t('workMetrics.failedUnits', { n: summary.failed_units }) }}</span>
      <span v-if="summary.interrupted_units" class="twm-item twm-warn">{{ t('workMetrics.interruptedUnits', { n: summary.interrupted_units }) }}</span>

      <span class="twm-item mono">
        {{ t('workMetrics.chars', { done: summary.completed_source_chars, total: summary.planned_source_chars }) }}
      </span>

      <span class="twm-item mono" :title="t('workMetrics.callHint')">
        {{ t('workMetrics.callTime', { duration: fmtDuration(summary.actual_call_ms) }) }}
      </span>
      <span class="twm-item mono twm-muted" :title="t('workMetrics.workHint')">
        {{ t('workMetrics.workTime', { duration: fmtDuration(summary.work_wall_ms) }) }}
      </span>
      <span class="twm-item mono twm-muted">
        {{ summary.queue_wait_known
          ? t('workMetrics.queueTime', { duration: fmtDuration(summary.actual_queue_ms) })
          : t('workMetrics.queueUnknown') }}
      </span>

      <span v-if="summary.current" class="twm-item mono">
        {{ t('workMetrics.current', {
          label: summary.current.storyboard_number === null ? t('workMetrics.wholeScript') : '#' + pad(summary.current.storyboard_number),
          elapsed: fmtDuration(summary.current.elapsed_ms),
        }) }}
        <template v-if="summary.current.estimate_ms !== null">
          {{ t('workMetrics.currentEstimate', { duration: fmtDuration(summary.current.estimate_ms) }) }}
        </template>
      </span>

      <span v-if="summary.eta && summary.eta.overrun" class="twm-item twm-warn">{{ t('workMetrics.overrun') }}</span>
      <span v-else-if="summary.eta" class="twm-item mono">
        {{ t('workMetrics.eta', { duration: fmtDuration(summary.eta.remaining_ms), clock: fmtClock(summary.eta.finish_at) }) }}
      </span>
      <span v-else-if="summary.eta_unknown_reason === 'no_samples'" class="twm-item twm-muted">{{ t('workMetrics.noSamples') }}</span>
      <span v-else-if="summary.eta_unknown_reason === 'not_started'" class="twm-item twm-muted">{{ t('workMetrics.notStarted') }}</span>

      <span v-if="summary.rate" class="twm-item twm-muted">
        {{ t(summary.rate.basis === 'current_batch' ? 'workMetrics.basisBatch' : 'workMetrics.basisHistory', { n: summary.rate.sample_count }) }}
      </span>
      <span v-if="summary.terminal" class="twm-item twm-muted">{{ t('workMetrics.finished') }}</span>
    </template>
  </div>
</template>

<script setup>
/**
 * 三阶段（旁白骨架 / 配音 / 设计卡）的真实计量展示（Issue #87 §D）。
 *
 * 所有数字都来自后端持久观测（task.observation_summary / work-estimate），
 * 刷新浏览器、重启后端都不归零也不重算：
 * - 「调用」= 实际服务调用耗时（模型 / TTS 请求到响应），不是音频长度；
 * - 「工作」= 工作项墙钟（含工具与文件处理），与调用耗时分开；
 * - 没有同口径样本就显示「暂无估计」，绝不编固定秒数；
 * - 当前项超过预计显示「超过预估·更新中」，不显示 0；终态不再倒计时。
 */
import { useI18n } from 'vue-i18n'

const props = defineProps({
  /** 运行中/已结束任务的观测汇总（后端 getTaskWorkSummary） */
  summary: { type: Object, default: null },
  /** 开跑前的计划字数与历史 ETA（GET /episodes/:id/work-estimate） */
  estimate: { type: Object, default: null },
  dense: { type: Boolean, default: false },
})

const { t } = useI18n()

function pad(n) { return String(n ?? 0).padStart(2, '0') }

/** 进度条分段宽度：按计划项数算；计划为 0 或该分段为 0 就不画，不假装 100% */
function pct(units) {
  const total = Number(props.summary?.planned_units) || 0
  const value = Number(units) || 0
  if (total <= 0 || value <= 0) return '0%'
  return `${Math.min(100, (value / total) * 100)}%`
}

/**
 * 毫秒 → 人读时长。没有事实（0 / 缺失）时显示「—」：
 * 首次请求还没结束时写「0.0s」等于谎称「调用已用 0 秒」。
 */
function fmtDuration(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value) || value <= 0) return '—'
  if (value < 1000) return `${(value / 1000).toFixed(1)}s`
  const total = Math.round(value / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h) return `${h}h${pad(m)}m`
  if (m) return `${m}m${pad(s)}s`
  return `${s}s`
}

function fmtClock(epochMs) {
  const value = Number(epochMs)
  if (!Number.isFinite(value) || value <= 0) return '--:--'
  const d = new Date(value)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
</script>

<style scoped>
.twm {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  font-size: 11px;
  color: var(--text-2, #666);
}
.twm.is-dense { gap: 2px 8px; font-size: 10px; }
.twm-item { white-space: nowrap; }
.twm-muted { opacity: 0.7; }
.twm-warn { color: var(--warn, #b26a00); }
.twm-bad { color: var(--danger, #c0392b); }
.twm-bar {
  display: inline-flex; width: 120px; height: 6px; border-radius: 3px;
  overflow: hidden; background: var(--bg-3, #e4e4e4);
}
.twm-bar-ok { background: var(--ok, #2e7d32); }
.twm-bar-bad { background: var(--danger, #c0392b); }
.twm-bar-warn { background: var(--warn, #b26a00); }
</style>
