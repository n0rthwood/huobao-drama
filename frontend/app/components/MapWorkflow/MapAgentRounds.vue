<template>
  <section class="mar">
    <header class="mar-head">
      <strong>{{ t('episode.documentary.map.agent.title') }}</strong>
      <span class="dim">{{ t('episode.documentary.map.agent.hint') }}</span>
      <span class="mar-run dim">
        {{ agent.task_id
          ? t('episode.documentary.map.agent.runTask', { id: agent.task_id })
          : t('episode.documentary.map.agent.runNone') }}
      </span>
    </header>

    <div class="mar-counters">
      <span
        v-for="item in counters"
        :key="item.stage"
        class="mar-counter"
        :class="{ 'is-exhausted': item.used >= agent.max_rounds, 'is-current': item.stage === stage }"
      >
        {{ t('episode.documentary.map.agent.rounds', {
          stage: t('episode.documentary.map.stage.' + item.stage),
          used: item.used,
          max: agent.max_rounds,
        }) }}
      </span>
      <span class="mar-counter" :class="{ 'is-exhausted': agent.rollbacks >= agent.max_rollbacks }">
        {{ t('episode.documentary.map.agent.rollbacks', { used: agent.rollbacks, max: agent.max_rollbacks }) }}
      </span>
    </div>

    <p v-if="!agent.attempts.length" class="mar-empty dim">{{ t('episode.documentary.map.agent.noAttempts') }}</p>

    <ul v-else class="mar-groups">
      <li v-for="group in groups" :key="group.stage" class="mar-group">
        <button type="button" class="mar-group-head" :aria-expanded="group.stage === openStage" @click="toggle(group.stage)">
          <ChevronDown v-if="group.stage === openStage" :size="11" />
          <ChevronRight v-else :size="11" />
          <strong>{{ t('episode.documentary.map.stage.' + group.stage) }}</strong>
          <span class="dim">{{ t('episode.documentary.map.agent.attemptsCount', { n: group.attempts.length }) }}</span>
          <span class="mar-outcome" :class="`is-${group.last.outcome}`">{{ t('episode.documentary.map.agent.outcome.' + group.last.outcome) }}</span>
          <span class="dim">{{ relativeAt(group.last.at) }}</span>
        </button>
        <ol v-if="group.stage === openStage" class="mar-attempts">
          <li v-for="attempt in group.attempts" :key="`${attempt.task_id}-${attempt.stage}-${attempt.round}-${attempt.at}`" class="mar-attempt">
            <div class="mar-attempt-head">
              <span class="mar-round">
                {{ attempt.round > 0
                  ? t('episode.documentary.map.agent.round', { n: attempt.round })
                  : t('episode.documentary.map.agent.roundNone') }}
              </span>
              <span class="mar-outcome" :class="`is-${attempt.outcome}`">{{ t('episode.documentary.map.agent.outcome.' + attempt.outcome) }}</span>
              <span v-if="attempt.outcome === 'rollback' && attempt.target_stage" class="dim">
                {{ t('episode.documentary.map.agent.rollbackTarget', { stage: stageLabel(attempt.target_stage) }) }}
              </span>
              <span class="dim">{{ t('episode.documentary.map.agent.taskRef', { id: attempt.task_id }) }}</span>
              <span class="dim mar-at">{{ relativeAt(attempt.at) }}</span>
            </div>
            <ul v-if="attempt.problems.length" class="mar-problems">
              <li v-for="(problem, index) in attempt.problems" :key="index">{{ problem }}</li>
            </ul>
          </li>
        </ol>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
/**
 * 模型轮次与被拒原因（Issue #90）。
 *
 * 每个模型阶段最多 3 轮交付、整次运行最多 2 次跨阶段回退；轮次用完就交人工。
 * 被拒原因是服务端已脱敏的纯文本，一律按列表直出（禁止 v-html），让人一眼看出模型卡在哪一条校验上。
 * 展开的阶段是导航位置，由宿主面板写进 URL（mround），本组件只上报选择。
 */
import { ChevronDown, ChevronRight } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import type { MapAgentAttempt, MapAgentState, MapWorkflowStage } from '~/composables/useApi'

const { t } = useI18n()

const props = defineProps<{
  agent: MapAgentState
  stage: MapWorkflowStage
  openStage: string
  now: number
}>()

const emit = defineEmits<{ (e: 'open', stage: string): void }>()

/** 只有模型阶段有交付轮次；style/complete 是基础设施阶段，失败按重试计，不占轮次。 */
const MODEL_STAGES: Array<'brief' | 'research' | 'base' | 'drawing'> = ['brief', 'research', 'base', 'drawing']

const counters = computed(() => MODEL_STAGES.map(name => ({ stage: name, used: props.agent.rounds[name] ?? 0 })))

/** 分组按阶段首次出现的顺序；组内保持服务端给的时间顺序（最新在后）。 */
const groups = computed(() => {
  const byStage = new Map<string, MapAgentAttempt[]>()
  for (const attempt of props.agent.attempts) {
    const list = byStage.get(attempt.stage)
    if (list) list.push(attempt)
    else byStage.set(attempt.stage, [attempt])
  }
  return [...byStage.entries()].map(([name, attempts]) => ({
    stage: name,
    attempts,
    last: attempts[attempts.length - 1] as MapAgentAttempt,
  }))
})

function stageLabel(name: string): string {
  return t('episode.documentary.map.stage.' + name)
}

function toggle(name: string) {
  emit('open', props.openStage === name ? '' : name)
}

/** 相对时间按本地时钟算（与列表页同口径）；时间非法就原样显示服务端文本。 */
function relativeAt(at: string): string {
  const parsed = Date.parse(at)
  if (!Number.isFinite(parsed)) return at || ''
  const diff = Math.max(0, props.now - parsed)
  if (diff < 60_000) return t('index.time.justNow')
  if (diff < 3_600_000) return t('index.time.minutesAgo', { n: Math.floor(diff / 60_000) })
  if (diff < 86_400_000) return t('index.time.hoursAgo', { n: Math.floor(diff / 3_600_000) })
  return t('index.time.daysAgo', { n: Math.floor(diff / 86_400_000) })
}
</script>

<style scoped>
.mar { display: flex; flex-direction: column; gap: 6px; }
.mar-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 11px; color: var(--text-1); }
.mar-run { margin-left: auto; }
.mar-counters { display: flex; flex-wrap: wrap; gap: 4px; }
.mar-counter {
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  font: 600 10.5px var(--font-body);
  color: var(--text-2);
}
.mar-counter.is-current { color: var(--accent-text); border-color: var(--accent-text); }
.mar-counter.is-exhausted { background: var(--warn-bg); border-color: var(--warn-border); color: var(--warn-text); }
.mar-empty { margin: 0; font-size: 10.5px; }
.mar-groups { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.mar-group { border: 1px solid var(--border); border-radius: 8px; background: var(--surface-soft); }
.mar-group-head {
  width: 100%;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 5px 8px;
  border: 0;
  background: transparent;
  color: var(--text-2);
  font: 600 10.5px var(--font-body);
  text-align: left;
  cursor: pointer;
}
.mar-group-head strong { font: 600 11px var(--font-body); color: var(--text-1); }
.mar-outcome { padding: 0 6px; border-radius: 999px; border: 1px solid var(--border-strong); font: 600 10px var(--font-body); }
.mar-outcome.is-accepted { color: var(--accent-text); border-color: var(--accent-text); }
.mar-outcome.is-rejected,
.mar-outcome.is-no_delivery,
.mar-outcome.is-error { background: var(--warn-bg); border-color: var(--warn-border); color: var(--warn-text); }
.mar-attempts { list-style: none; margin: 0; padding: 0 8px 8px; display: flex; flex-direction: column; gap: 5px; }
.mar-attempt { display: flex; flex-direction: column; gap: 3px; padding: 5px 7px; border: 1px solid var(--border); border-radius: 6px; }
.mar-attempt-head { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; font-size: 10.5px; color: var(--text-2); }
.mar-round { font: 600 10.5px var(--font-body); color: var(--text-1); }
.mar-at { margin-left: auto; }
.mar-problems { list-style: disc; margin: 0; padding-left: 16px; display: flex; flex-direction: column; gap: 2px; font-size: 10.5px; color: var(--text-2); }
.mar-problems li { word-break: break-word; }
</style>
