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
  assets: { review_status: 'passed', stale_reasons: [], missing: 0 },
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
  /**
   * 门禁是否已判定。首次取到之前、换集之后、以及导航触发的重新判定期间一律 false：
   * 界面在此期间不得渲染任何受门禁管辖的内容，否则锁定步骤会闪一下完整面板
   * （取数失败、或拿上一集/上一轮的「全解锁」缓存放行，都是同一类越权渲染）。
   */
  const ready = ref(false)
  /** 已判定结果对应的剧集；换集即作废 */
  let loadedFor = 0
  /** 请求序号：晚到的旧响应不得覆盖新结果 */
  let seq = 0

  /**
   * 门禁载荷的唯一写入口（取数 / 确认 / 取消确认共用），保证 ready 与数据同步。
   * 落地即递增请求代号：确认/取消确认后，先前在飞的 `/gates` 响应是旧世界的结果，不得覆盖它。
   */
  function applyGates(next: EpisodeGates): void {
    seq += 1
    gates.value = next
    ready.value = true
    loadedFor = episodeId()
  }

  /**
   * @param opts.background 后台重算（任务结束、剧本保存）：保留上一次结果，不打断正在看的内容。
   *   导航类刷新一律前台：先作废旧判定，拿到新结果再渲染内容。
   */
  async function refreshGates(opts: { background?: boolean } = {}): Promise<void> {
    const id = episodeId()
    if (!id) return
    if (!opts.background || id !== loadedFor) ready.value = false
    loading.value = true
    const mine = ++seq
    try {
      const next = await episodeAPI.gates(id)
      // 本次请求已被更新的请求或一次确认/取消确认作废（seq 变了），或已经换了集：丢弃
      if (mine !== seq || id !== episodeId()) return
      applyGates(next)
      loading.value = false
    } catch {
      // 取不到门禁时保持上一次结果；ready 维持 false（按锁定渲染，不放行）
      if (mine === seq) loading.value = false
    }
  }

  onTaskFinished((task) => {
    const kind = String(task?.kind || task?.params?.kind || '')
    if (GATE_TASK_KINDS.includes(kind)) refreshGates({ background: true })
  })

  const unlocked = computed(() => gates.value.unlocked)
  const reasonOf = (gate: GateKey) => gates.value.reasons?.[gate] || ''
  const gotoOf = (gate: GateKey) => gates.value.goto?.[gate] || null

  return { gates, loading, ready, applyGates, refreshGates, unlocked, reasonOf, gotoOf }
}
