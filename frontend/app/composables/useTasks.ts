/**
 * 全局任务 store（模块级状态 + 单一轮询）。
 *
 * 任务状态只存在后端（sys_task），前端任何页面/组件都从这里读：
 * - 任务中心（抽屉 / `/tasks` 页）按钮角标与列表
 * - 关键帧槽位进度环、素材卡片进度环、图片队列汇总条
 *
 * 轮询只有一个定时器：有活跃任务时 3s，空闲时 15s；页面不可见时暂停，
 * 重新可见立即拉一次。任务从「活跃」列表消失时会补拉一次 `GET /tasks/:id`
 * 取终态，并通知订阅者（组件据此刷新自己的数据）。
 */
import { ref, computed, onScopeDispose, getCurrentScope } from 'vue'
import { taskAPI } from '~/composables/useApi'
import { isActiveTaskStatus } from '~/composables/useTaskProgress'
import type { RemoteState } from '~/composables/useTaskProgress'

export type TaskType = 'image' | 'video' | 'text'
export type TextKind =
  | 'extract_characters' | 'extract_scenes' | 'extract_props'
  | 'keyframe_prompts' | 'video_prompts' | 'script_rewrite' | 'storyboard_breaker'

export interface TaskParams {
  frameType?: string
  size?: string
  duration?: number
  referenceImages?: string[]
  progress?: { completed?: number; total?: number } | null
  kind?: string
  retry_of?: number | null
  [key: string]: unknown
}

/** 后端 serializeTask + 任务中心附加字段（见 Issue #8 契约） */
export interface TaskRow {
  row_type?: 'task'
  id: number
  type?: string
  status?: string
  provider?: string
  model?: string
  prompt?: string
  params?: TaskParams | null
  result_url?: string | null
  local_path?: string | null
  remote_state?: RemoteState | null
  error_msg?: string | null
  cancellable?: boolean
  created_at?: string
  updated_at?: string
  completed_at?: string | null
  episode_id?: number | null
  drama_id?: number | null
  storyboard_id?: number | null
  character_id?: number | null
  scene_id?: number | null
  prop_id?: number | null
  drama_title?: string | null
  episode_number?: number | null
  storyboard_number?: number | null
  target_kind?: 'storyboard' | 'character' | 'scene' | 'prop' | 'episode' | null
  target_name?: string | null
  frame_type?: string | null
  kind?: string | null
  // 文本任务进度（后端从 params.progress 透出）
  progress?: { completed?: number; total?: number; failed?: number; current_storyboard_id?: number | null } | null
  label?: string | null
  retry_of?: number | null
}

/** 关键帧批次 / 视频批次 / 导出合成：任务中心里的父任务行 */
export interface ParentRow {
  row_type: 'keyframe_batch' | 'video_batch' | 'video_merge'
  id: number
  episode_id?: number | null
  drama_id?: number | null
  label?: string | null
  status?: string
  progress?: number | null
  counts?: Record<string, number> | null
  result_url?: string | null
  error_msg?: string | null
  created_at?: string
  updated_at?: string
  children?: TaskRow[]
}

export type CenterRow = TaskRow | ParentRow

export function isParentRow(row: CenterRow | null | undefined): row is ParentRow {
  return Boolean(row && row.row_type && row.row_type !== 'task')
}

const FAST_INTERVAL = 3000
const IDLE_INTERVAL = 15000

// ===== 模块级状态 =====
const tasksById = ref<Record<number, TaskRow>>({})
const activeIds = ref<number[]>([])
const activeCount = ref(0)
// 任务中心抽屉：全局开关（顶栏按钮在多个布局里，抽屉只渲染一份）
const centerOpen = ref(false)
const centerEpisodeId = ref<number | null>(null)
const centerDramaId = ref<number | null>(null)

let timer: number | null = null
let currentInterval = 0
let polling = false
let started = false

type FinishedHandler = (task: TaskRow) => void
const finishedHandlers = new Set<FinishedHandler>()

/**
 * 任务新旧比较：created_at 相同（同一秒内提交）时按 id 兜底。
 * 槽位环 / 素材环 / 分镜视频状态都要「取最新一条」，必须同一口径。
 */
function isNewer(candidate: TaskRow, current: TaskRow | null): boolean {
  if (!current) return true
  const a = String(candidate.created_at || '')
  const b = String(current.created_at || '')
  if (a !== b) return a > b
  return Number(candidate.id) > Number(current.id)
}

/** 合并一行任务到缓存（后端快照覆盖本地的乐观记录） */
function mergeTask(task: TaskRow | null | undefined): TaskRow | null {
  const id = Number(task?.id)
  if (!task || !Number.isFinite(id)) return null
  const prev = tasksById.value[id]
  const next = prev ? { ...prev, ...task } : { ...task }
  tasksById.value = { ...tasksById.value, [id]: next }
  return next
}

/** 把任意一组任务行（含批次父行的 children）摊平写入缓存 */
export function absorbRows(rows: CenterRow[] | null | undefined): void {
  if (!Array.isArray(rows)) return
  for (const row of rows) {
    if (isParentRow(row)) {
      for (const child of row.children || []) mergeTask(child)
    } else {
      mergeTask(row)
    }
  }
}

function schedule(): void {
  if (typeof window === 'undefined') return
  if (typeof document !== 'undefined' && document.hidden) {
    clearTimeout(timer ?? undefined)
    timer = null
    currentInterval = 0
    return
  }
  const wanted = activeIds.value.length > 0 ? FAST_INTERVAL : IDLE_INTERVAL
  if (timer && currentInterval === wanted) return
  clearTimeout(timer ?? undefined)
  currentInterval = wanted
  timer = setTimeout(() => { timer = null; void pollOnce() }, wanted) as unknown as number
}

async function pollOnce(): Promise<void> {
  if (polling) return
  polling = true
  try {
    const data = await taskAPI.active()
    const items: TaskRow[] = Array.isArray(data?.items) ? data.items : []
    for (const item of items) mergeTask(item)
    const nextIds = items.map(item => Number(item.id)).filter(id => Number.isFinite(id))
    const stillActive = new Set(nextIds)
    const left = activeIds.value.filter(id => !stillActive.has(id))
    activeIds.value = nextIds
    activeCount.value = Number(data?.active_count ?? nextIds.length) || 0
    // 离开活跃列表 = 已终态：补拉一次拿到 result_url / error_msg，并通知订阅者刷新数据
    for (const id of left) {
      let row: TaskRow | null = null
      try { row = await taskAPI.get(id) } catch { row = null }
      const merged = mergeTask(row) || tasksById.value[id] || null
      if (!merged) continue
      for (const handler of [...finishedHandlers]) {
        try { handler(merged) } catch { /* 订阅者异常不影响其它订阅者 */ }
      }
    }
  } catch { /* 轮询失败只跳过本轮，不改任务状态 */ }
  finally {
    polling = false
    schedule()
  }
}

/** 立即拉一次活跃任务（提交任务后、抽屉打开时调用） */
export function refreshTasks(): Promise<void> {
  return pollOnce()
}

/**
 * 刚提交的任务立即进入 store，进度环不必等下一轮轮询。
 * 即便任务瞬间完成，下一轮它不在活跃列表里也会被当作「已离开」补拉终态。
 */
export function registerTask(task: TaskRow | null | undefined): TaskRow | null {
  const merged = mergeTask(task)
  if (!merged) return null
  const id = Number(merged.id)
  if (isActiveTaskStatus(merged.status) && !activeIds.value.includes(id)) {
    activeIds.value = [...activeIds.value, id]
    activeCount.value += 1
  }
  schedule()
  return merged
}

/** 订阅「任务转为终态」事件；组件卸载自动退订 */
export function onTaskFinished(handler: FinishedHandler): () => void {
  finishedHandlers.add(handler)
  const off = () => { finishedHandlers.delete(handler) }
  if (getCurrentScope()) onScopeDispose(off)
  return off
}

/**
 * 载入某一集的任务快照（含已结束的任务）：刷新页面后素材卡片的失败态、
 * 分镜视频的失败/生成中状态、关键帧槽位的历史任务都从这里恢复。
 */
export async function loadEpisodeTasks(episodeId: number): Promise<void> {
  if (!episodeId) return
  try {
    const data = await taskAPI.center({ episode_id: episodeId, page_size: 200 })
    absorbRows(data?.items)
  } catch { /* 静默：快照失败不阻塞页面 */ }
}

/** 某分镜某槽位最新的关键帧任务（frame_type: first_frame | mid_frame | last_frame） */
export function latestKeyframeTask(storyboardId: number, frameType: string): TaskRow | null {
  let latest: TaskRow | null = null
  for (const task of Object.values(tasksById.value)) {
    if (task.type !== 'image') continue
    if (Number(task.storyboard_id) !== Number(storyboardId)) continue
    if (String(task.frame_type || task.params?.frameType || '') !== frameType) continue
    if (isNewer(task, latest)) latest = task
  }
  return latest
}

const ASSET_FIELD: Record<string, 'character_id' | 'scene_id' | 'prop_id'> = {
  character: 'character_id', scene: 'scene_id', prop: 'prop_id',
}

/** 某素材（角色/场景/道具）最新的一条出图任务 */
export function latestAssetTask(kind: 'character' | 'scene' | 'prop', assetId: number): TaskRow | null {
  const field = ASSET_FIELD[kind]
  let latest: TaskRow | null = null
  for (const task of Object.values(tasksById.value)) {
    if (task.type !== 'image' || !field) continue
    if (Number(task[field]) !== Number(assetId)) continue
    // 关键帧任务也挂在分镜上，素材出图任务没有 storyboard_id
    if (task.storyboard_id) continue
    if (isNewer(task, latest)) latest = task
  }
  return latest
}

/** 某分镜最新的一条视频任务 */
export function latestVideoTask(storyboardId: number): TaskRow | null {
  let latest: TaskRow | null = null
  for (const task of Object.values(tasksById.value)) {
    if (task.type !== 'video') continue
    if (Number(task.storyboard_id) !== Number(storyboardId)) continue
    if (isNewer(task, latest)) latest = task
  }
  return latest
}

/** 某分镜最新的一条进行中（queued/processing）视频任务 */
export function latestActiveVideoTask(storyboardId: number): TaskRow | null {
  let latest: TaskRow | null = null
  for (const task of Object.values(tasksById.value)) {
    if (task.type !== 'video') continue
    if (Number(task.storyboard_id) !== Number(storyboardId)) continue
    if (!isActiveTaskStatus(task.status)) continue
    if (isNewer(task, latest)) latest = task
  }
  return latest
}

export function openTaskCenter(opts: { episodeId?: number | null; dramaId?: number | null } = {}): void {
  centerEpisodeId.value = opts.episodeId ?? null
  centerDramaId.value = opts.dramaId ?? null
  centerOpen.value = true
  void refreshTasks()
}

export function useTasks() {
  if (!started && typeof window !== 'undefined') {
    started = true
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        clearTimeout(timer ?? undefined)
        timer = null
        currentInterval = 0
      } else {
        void pollOnce()
      }
    })
    void pollOnce()
  }

  const activeTasks = computed<TaskRow[]>(() =>
    activeIds.value.map(id => tasksById.value[id]).filter((task): task is TaskRow => Boolean(task)))

  return {
    tasksById,
    activeTasks,
    activeCount,
    centerOpen,
    centerEpisodeId,
    centerDramaId,
    /** 该集的全部已知任务（活跃 + 已载入的历史快照） */
    episodeTasks: (episodeId: number) =>
      Object.values(tasksById.value).filter(task => Number(task.episode_id) === Number(episodeId)),
    refreshTasks,
    registerTask,
    onTaskFinished,
    loadEpisodeTasks,
    latestKeyframeTask,
    latestAssetTask,
    latestVideoTask,
    openTaskCenter,
    closeTaskCenter: () => { centerOpen.value = false },
  }
}
