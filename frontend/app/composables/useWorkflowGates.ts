/**
 * 纪录片步骤门禁（Issue #54）：`GET /episodes/:id/gates` 的唯一前端入口。
 *
 * 刷新时机（契约裁决）：页面 refresh()、剧本保存/确认、拆分/提取/审核清单任务结束
 * （`onTaskFinished`）、以及切换制作页签时。剧情项目同样会取一次，只是恒为全解锁。
 */
import { computed, ref } from 'vue'

import { episodeAPI, type EpisodeGates, type GateKey } from '~/composables/useApi'
import { onTaskFinished } from '~/composables/useTasks'

/** 任务结束后要重算门禁的文本任务类型 */
const GATE_TASK_KINDS = ['storyboard_breaker', 'storyboard_fill_gaps', 'extract_characters', 'extract_scenes', 'extract_props', 'asset_review', 'script_rewrite']

const ALL_UNLOCKED: EpisodeGates = {
  project_type: 'drama',
  script: { confirmed: true, confirmed_at: null },
  assets: { review_status: 'passed', stale_reasons: [] },
  design: { confirmed: 0, total: 0 },
  production: { ready: 0, total: 0 },
  final: { fresh: 0, total: 0 },
  unlocked: { assets: true, design: true, production: true, final: true, poster: true, export: true },
  reasons: {},
  goto: {},
}

export function useWorkflowGates(episodeId: () => number) {
  const gates = ref<EpisodeGates>(ALL_UNLOCKED)
  const loading = ref(false)

  async function refreshGates(): Promise<void> {
    const id = episodeId()
    if (!id) return
    loading.value = true
    try {
      gates.value = await episodeAPI.gates(id)
    } catch {
      // 取不到门禁时不要把界面全锁死：保持上一次结果
    } finally {
      loading.value = false
    }
  }

  onTaskFinished((task) => {
    const kind = String(task?.kind || task?.params?.kind || '')
    if (GATE_TASK_KINDS.includes(kind)) refreshGates()
  })

  const unlocked = computed(() => gates.value.unlocked)
  const reasonOf = (gate: GateKey) => gates.value.reasons?.[gate] || ''
  const gotoOf = (gate: GateKey) => gates.value.goto?.[gate] || null

  return { gates, loading, refreshGates, unlocked, reasonOf, gotoOf }
}
