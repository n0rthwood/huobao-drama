/**
 * 工作流 roadmap（Issue #105）：`GET /episodes/:id/roadmap` 的唯一前端入口。
 *
 * 服务端是唯一判定方：大/小步骤的完成判据、严格顺序、锁定位、出路、计数与 milestone
 * 全部来自这一份载荷；前端不再自己拼完成状态。
 *
 * 刷新时机（沿用 #54/#62 裁决）：页面 refresh()、剧本保存/确认、相关任务结束
 * （`onTaskFinished`）、以及切换制作页签/面板。
 */
import { computed, ref } from 'vue'

import { episodeAPI, type Roadmap, type RoadmapNode, type StepStatus } from '~/composables/useApi'
import { onTaskFinished } from '~/composables/useTasks'

/** 任务结束后要重算 roadmap 的文本任务类型（与 #54 的门禁任务清单一致） */
const ROADMAP_TASK_KINDS = ['storyboard_breaker', 'storyboard_fill_gaps', 'extract_characters', 'extract_scenes', 'extract_props', 'asset_review', 'script_rewrite']

export function useEpisodeRoadmap(episodeId: () => number) {
  const roadmap = ref<Roadmap | null>(null)
  const loading = ref(false)
  /**
   * roadmap 是否已判定。首次取到之前、换集之后、以及导航触发的重新判定期间一律 false：
   * 界面在此期间只渲染「校验中」，不得同时出现 ✓ 与锁（#105 统一视觉口径）。
   */
  const ready = ref(false)
  /** 已判定结果对应的剧集；换集即作废 */
  let loadedFor = 0
  /** 请求序号：晚到的旧响应不得覆盖新结果 */
  let seq = 0

  /**
   * roadmap 载荷的唯一写入口（取数 / 确认 / 取消确认共用），保证 ready 与数据同步。
   * 落地即递增请求代号：确认/取消确认后，先前在飞的 `/roadmap` 响应是旧世界的结果，不得覆盖它。
   */
  function applyRoadmap(next: Roadmap | null): void {
    if (!next) return
    seq += 1
    roadmap.value = next
    ready.value = true
    loadedFor = episodeId()
  }

  /**
   * @param opts.background 后台重算（任务结束、剧本保存）：保留上一次结果，不打断正在看的内容。
   *   导航类刷新一律前台：先作废旧判定，拿到新结果再渲染状态。
   */
  async function refreshRoadmap(opts: { background?: boolean } = {}): Promise<void> {
    const id = episodeId()
    if (!id) return
    if (!opts.background || id !== loadedFor) ready.value = false
    loading.value = true
    const mine = ++seq
    try {
      const next = await episodeAPI.roadmap(id)
      // 本次请求已被更新的请求或一次确认/取消确认作废（seq 变了），或已经换了集：丢弃
      if (mine !== seq || id !== episodeId()) return
      // 先清 loading：applyRoadmap 会递增 seq（它本身就是一次「落地」），再判断就永远为假
      loading.value = false
      applyRoadmap(next)
    } catch {
      // 取不到 roadmap 时保持上一次结果；ready 维持 false（按校验中渲染，不臆造完成态）
      if (mine === seq) loading.value = false
    }
  }

  onTaskFinished((task) => {
    const kind = String(task?.kind || task?.params?.kind || '')
    if (ROADMAP_TASK_KINDS.includes(kind)) refreshRoadmap({ background: true })
  })

  const steps = computed<RoadmapNode[]>(() => roadmap.value?.steps || [])
  const milestones = computed(() => roadmap.value?.milestones || [])
  const progress = computed(() => roadmap.value?.progress || { done: 0, total: steps.value.length })
  const current = computed(() => roadmap.value?.current || { step: null, substep: null })

  /** 按 key 取节点：大步骤在前，再查各自子步骤（键全局唯一） */
  function nodeOf(key: string): RoadmapNode | null {
    if (!key) return null
    for (const step of steps.value) {
      if (step.key === key) return step
      for (const sub of step.substeps || []) if (sub.key === key) return sub
    }
    return null
  }

  /** 节点状态；尚未取到 roadmap 时为 null（渲染「校验中」，不臆造 available/done） */
  function statusOf(key: string): StepStatus | null {
    return nodeOf(key)?.status ?? null
  }

  function countsOf(key: string): { done: number; total: number } | null {
    return nodeOf(key)?.counts ?? null
  }

  /** 是否锁定：锁与状态是两个维度（有产物但上游未就绪时 status 可能是 in_progress/stale） */
  function lockedOf(key: string): boolean {
    return nodeOf(key)?.unlocked === false
  }

  /** 锁定原因：只有锁定才给原因，其余一律空串（避免把「缺什么」当锁） */
  function lockReasonOf(key: string): string {
    const node = nodeOf(key)
    return node?.unlocked === false ? (node.lock_reason || '') : ''
  }

  /** 出路：解锁需要先去的步骤 key；服务端没给就为 null */
  function gotoOf(key: string): string | null {
    return nodeOf(key)?.goto ?? null
  }

  return {
    roadmap, steps, milestones, progress, current,
    ready, loading, applyRoadmap, refreshRoadmap,
    nodeOf, statusOf, countsOf, lockedOf, lockReasonOf, gotoOf,
  }
}
