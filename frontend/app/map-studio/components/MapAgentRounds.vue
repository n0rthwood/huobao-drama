<template>
  <section class="mar">
    <header class="mar-head">
      <strong>{{ t('mapStudio.agent.title') }}</strong>
      <span class="dim">{{ t('mapStudio.agent.hint') }}</span>
      <span class="mar-run dim">
        {{ agent.run_id
          ? t('mapStudio.agent.runLabel', { id: agent.run_id })
          : t('mapStudio.agent.runNone') }}
      </span>
    </header>

    <div class="mar-counters">
      <span
        v-for="item in counters"
        :key="item.stage"
        class="mar-counter"
        :class="{ 'is-exhausted': item.used >= maxRounds, 'is-current': item.stage === stage }"
      >
        {{ t('mapStudio.agent.rounds', {
          stage: t('mapStudio.stage.' + item.stage),
          used: item.used,
          max: maxRounds,
        }) }}
      </span>
      <span class="mar-counter" :class="{ 'is-exhausted': agent.rollbacks >= maxRollbacks }">
        {{ t('mapStudio.agent.rollbacks', { used: agent.rollbacks, max: maxRollbacks }) }}
      </span>
    </div>

    <p v-if="!agent.attempts.length" class="mar-empty dim">{{ t('mapStudio.agent.noAttempts') }}</p>

    <ul v-else class="mar-groups">
      <li v-for="group in groups" :key="group.stage" class="mar-group">
        <button type="button" class="mar-group-head" :aria-expanded="group.stage === openStage" @click="toggle(group.stage)">
          <ChevronDown v-if="group.stage === openStage" :size="11" />
          <ChevronRight v-else :size="11" />
          <strong>{{ t('mapStudio.stage.' + group.stage) }}</strong>
          <span class="dim">{{ t('mapStudio.agent.attemptsCount', { n: group.attempts.length }) }}</span>
          <span class="mar-outcome" :class="`is-${group.last.outcome}`">{{ t('mapStudio.agent.outcome.' + group.last.outcome) }}</span>
          <span class="dim">{{ relativeAt(group.last.at) }}</span>
        </button>
        <ol v-if="group.stage === openStage" class="mar-attempts">
          <li v-for="attempt in group.attempts" :key="`${attempt.run_id}-${attempt.stage}-${attempt.round}-${attempt.at}`" class="mar-attempt">
            <div class="mar-attempt-head">
              <span class="mar-round">
                {{ attempt.round > 0
                  ? t('mapStudio.agent.round', { n: attempt.round })
                  : t('mapStudio.agent.roundNone') }}
              </span>
              <span class="mar-outcome" :class="`is-${attempt.outcome}`">{{ t('mapStudio.agent.outcome.' + attempt.outcome) }}</span>
              <span v-if="attempt.outcome === 'rollback' && attempt.target_stage" class="dim">
                {{ t('mapStudio.agent.rollbackTarget', { stage: stageLabel(attempt.target_stage) }) }}
              </span>
              <span class="dim">{{ t('mapStudio.agent.runRef', { id: attempt.run_id }) }}</span>
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
 * 展开的阶段是导航位置，由宿主面板写进 URL（msstage），本组件只上报选择，本组件只上报选择。
 */
import { ChevronDown, ChevronRight } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import type { MapAgentAttempt, MapAgentState, MapStudioStage } from '~/map-studio/api'

const { t } = useI18n()

const props = defineProps<{
  agent: MapAgentState
  stage: MapStudioStage
  openStage: string
  now: number
}>()

const emit = defineEmits<{ (e: 'open', stage: string): void }>()

/** 只有模型阶段有交付轮次；style/complete 是基础设施阶段，失败按重试计，不占轮次。 */
const MODEL_STAGES: Array<'brief' | 'research' | 'base' | 'drawing'> = ['brief', 'research', 'base', 'drawing']

const counters = computed(() => MODEL_STAGES.map(name => ({ stage: name, used: props.agent.rounds[name] ?? 0 })))

/** 契约固定的上限：每个模型阶段 3 轮、每次运行 2 次跨阶段回退；服务端回传时以服务端为准 */
const maxRounds = computed(() => props.agent.max_rounds ?? 3)
const maxRollbacks = computed(() => props.agent.max_rollbacks ?? 2)

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
  return t('mapStudio.stage.' + name)
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
