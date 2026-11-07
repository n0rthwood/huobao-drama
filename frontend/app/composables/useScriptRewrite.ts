/**
 * 分阶段改写的前端状态（Issue #70，纪录片）。
 *
 * 三条不可混用的事实：
 * 1. **运行**是可变执行状态（queued/processing/completed/failed），进度只来自全局任务 store
 *    （`sys_task.params.rewrite`），本组件不另起轮询；
 * 2. **版本**是不可变文本，切换阶段/版本只改预览，绝不改最终稿；
 * 3. **最终稿**是画布上唯一可编辑的正文，写入一律带修订标识做条件写入（CAS）。
 */
import { computed, ref, watch } from 'vue'

import {
  scriptRewriteAPI, rewriteErrorOf,
  type RewriteErrorInfo, type RewriteRun, type RewriteStageKey, type RewriteStageStatus,
  type RewriteTaskProgress, type RewriteVersion, type RewriteVersionStage,
  type ScriptRewriteStartBody, type ScriptRewriteState,
} from '~/composables/useApi'
import { useTasks } from '~/composables/useTasks'

/** 阶段条上的一格：输入准备 + 后端注册表里的 AI 阶段 */
export interface StripStage {
  key: RewriteVersionStage
  /** 输入准备不是 AI 阶段：没有重跑/跳过菜单 */
  ai: boolean
  status: RewriteStageStatus
  versionId: number | null
  error: string | null
}

export interface RewriteConflict {
  kind: 'save' | 'adopt'
  versionId: number | null
  /** 冲突时我方待写内容 */
  mine: string
  message: string
}

/** 启动运行的结果：失败时 error 带后端错误码，调用方据此决定提示或二次确认 */
export interface StartResult {
  ok: boolean
  error: RewriteErrorInfo | null
  message: string
}

/** 采用 / 保存最终稿的结果：changed=false 表示字节未变，不触发下游失效 */
export interface WriteResult {
  ok: boolean
  changed: boolean
  message: string
}

const EMPTY_STATE: ScriptRewriteState = {
  runs: [], versions: [], current_run: null, current_final_version_id: null,
  source_revision: '', final_revision: '', stages: [],
}

export function useScriptRewrite(episodeId: () => number) {
  const { tasksById, registerTask, refreshTasks } = useTasks()

  const state = ref<ScriptRewriteState>(EMPTY_STATE)
  const loaded = ref(false)
  const loading = ref(false)
  const loadError = ref('')
  const busy = ref(false)
  const conflict = ref<RewriteConflict | null>(null)

  async function reload(): Promise<void> {
    const id = episodeId()
    if (!id) return
    loading.value = true
    try {
      const next = await scriptRewriteAPI.state(id)
      state.value = { ...EMPTY_STATE, ...(next || {}) }
      loadError.value = ''
      loaded.value = true
    } catch (err) {
      loadError.value = (err as Error)?.message || ''
    } finally {
      loading.value = false
    }
  }

  // ===== 运行与进度（全局任务 store 是唯一进度来源） =====
  const currentRun = computed<RewriteRun | null>(() => state.value.current_run)
  /** 正在查看的运行：默认最新一次；看历史运行只改预览，不改执行 */
  const viewRunId = ref<number | null>(null)
  const viewedRun = computed<RewriteRun | null>(() => {
    if (viewRunId.value === null) return currentRun.value
    return (state.value.runs || []).find(run => run.id === viewRunId.value) || currentRun.value
  })
  const viewingHistory = computed(() => Boolean(
    viewedRun.value && currentRun.value && viewedRun.value.id !== currentRun.value.id,
  ))
  const runTask = computed(() => {
    const taskId = currentRun.value?.task_id
    return taskId ? tasksById.value[taskId] || null : null
  })
  const runProgress = computed<RewriteTaskProgress | null>(() => {
    const raw = (runTask.value?.params as Record<string, unknown> | null | undefined)?.rewrite
    return raw && typeof raw === 'object' ? raw as RewriteTaskProgress : null
  })
  const runActive = computed(() => {
    const status = currentRun.value?.status
    return status === 'queued' || status === 'processing'
  })
  /** 「正在执行第 2/2 阶段」——阶段计数是真实的，不折算成百分比 */
  const stagePosition = computed(() => {
    const progress = runProgress.value
    if (!runActive.value || !progress?.stage_total) return null
    return { index: progress.stage_index, total: progress.stage_total, key: progress.stage_key }
  })

  // 任务状态/阶段推进即重新取一次状态：阶段完成后新版本才会出现在 versions 里
  watch(
    () => {
      const task = runTask.value
      const progress = runProgress.value
      return `${task?.status || ''}:${progress?.stage_key || ''}:${progress?.stage_index ?? ''}`
    },
    (next, prev) => { if (loaded.value && next !== prev) void reload() },
  )

  // ===== 版本 =====
  const versions = computed(() => state.value.versions || [])
  const versionById = computed(() => {
    const map = new Map<number, RewriteVersion>()
    for (const version of versions.value) map.set(version.id, version)
    return map
  })
  const runById = computed(() => {
    const map = new Map<number, RewriteRun>()
    for (const run of state.value.runs || []) map.set(run.id, run)
    return map
  })
  /** 当前最终稿的溯源链：采用版本 + 它的全部前驱（不在链上的版本标「不属于当前采用链」） */
  const adoptedChain = computed(() => {
    const chain = new Set<number>()
    let cursor = state.value.current_final_version_id
    let guard = 0
    while (cursor && !chain.has(cursor) && guard++ < 200) {
      chain.add(cursor)
      cursor = versionById.value.get(cursor)?.predecessor_id ?? null
    }
    return chain
  })
  /** 每个阶段的版本列表（含跨运行的历史版本，新的在前） */
  const versionsByStage = computed(() => {
    const map = new Map<RewriteVersionStage, RewriteVersion[]>()
    for (const version of versions.value) {
      const list = map.get(version.stage_key)
      if (list) list.push(version)
      else map.set(version.stage_key, [version])
    }
    for (const list of map.values()) list.sort((a, b) => b.id - a.id)
    return map
  })
  /** 该版本实际使用的前驱（不是页面上恰好选中的上一步版本） */
  function predecessorOf(version: RewriteVersion | null): RewriteVersion | null {
    if (!version?.predecessor_id) return null
    return versionById.value.get(version.predecessor_id) || null
  }
  /** 基于旧原文：该版本所属运行冻结的原文与当前原文不一致 */
  function isStaleSource(version: RewriteVersion | null): boolean {
    if (!version?.run_id) return false
    const run = runById.value.get(version.run_id)
    if (!run) return false
    return String(run.source_revision) !== String(state.value.source_revision)
  }

  // ===== 阶段条 =====
  const stageDefs = computed(() => viewedRun.value?.stage_plan || state.value.stages || [])
  const strip = computed<StripStage[]>(() => {
    const run = viewedRun.value
    // 进度只属于正在执行的那次运行；看历史运行时不得借用当前任务的进度
    const progress = viewingHistory.value ? null : runProgress.value
    const live = !viewingHistory.value && runActive.value
    const out: StripStage[] = [{
      key: 'prepared_source',
      ai: false,
      status: run?.prepared_version_id ? 'completed' : (live ? 'processing' : 'pending'),
      versionId: run?.prepared_version_id ?? null,
      error: null,
    }]
    for (const def of stageDefs.value) {
      const stage = run?.stages?.find(item => item.key === def.key)
      let status: RewriteStageStatus = stage?.status || 'pending'
      // 任务正在跑这一阶段时，状态以任务进度为准（运行行可能还没落库）
      if (live && progress?.stage_key === def.key && status === 'pending') status = 'processing'
      out.push({
        key: def.key,
        ai: true,
        status,
        versionId: stage?.version_id ?? null,
        error: stage?.error ?? null,
      })
    }
    return out
  })
  const stageKeys = computed<RewriteStageKey[]>(() => stageDefs.value.map(def => def.key))

  /** 候选：运行已出结果但尚未写入最终稿 */
  const candidateVersion = computed<RewriteVersion | null>(() => {
    const run = currentRun.value
    if (!run?.candidate_version_id) return null
    if (run.adoption_status === 'adopted') return null
    return versionById.value.get(run.candidate_version_id) || null
  })

  // ===== 动作 =====
  async function start(body: ScriptRewriteStartBody): Promise<StartResult> {
    busy.value = true
    try {
      const submitted = await scriptRewriteAPI.start(episodeId(), {
        ...body,
        source_revision: body.source_revision ?? state.value.source_revision,
        final_revision: body.final_revision ?? state.value.final_revision,
      })
      registerTask({ id: submitted.task_id, type: 'text', status: 'queued', episode_id: episodeId(), params: { kind: 'script_rewrite' } })
      await reload()
      await refreshTasks()
      return { ok: true, error: null, message: '' }
    } catch (err) {
      return { ok: false, error: rewriteErrorOf(err), message: (err as Error)?.message || '' }
    } finally {
      busy.value = false
    }
  }

  /** 运行期间进入编辑：先把「本次不自动采用」落盘，再放行输入 */
  async function disableAutoAdopt(): Promise<boolean> {
    const run = currentRun.value
    if (!run) return true
    if (run.adoption_status === 'manual') return true
    busy.value = true
    try {
      await scriptRewriteAPI.manual(episodeId(), run.id)
      await reload()
      return true
    } catch {
      return false
    } finally {
      busy.value = false
    }
  }

  async function adopt(versionId: number): Promise<WriteResult> {
    busy.value = true
    try {
      const res = await scriptRewriteAPI.adopt(episodeId(), versionId, {
        source_revision: state.value.source_revision,
        final_revision: state.value.final_revision,
      })
      state.value = { ...EMPTY_STATE, ...(res || {}) }
      return { ok: true, changed: Boolean(res?.changed), message: '' }
    } catch (err) {
      const info = rewriteErrorOf(err)
      if (info?.error === 'revision_conflict') {
        await reload()
        conflict.value = {
          kind: 'adopt',
          versionId,
          mine: versionById.value.get(versionId)?.content || '',
          message: (err as Error)?.message || '',
        }
      }
      return { ok: false, changed: false, message: (err as Error)?.message || '' }
    } finally {
      busy.value = false
    }
  }

  async function saveFinal(content: string, expected?: { source_revision: string | number; final_revision: string | number }): Promise<WriteResult> {
    busy.value = true
    try {
      const res = await scriptRewriteAPI.saveFinal(episodeId(), {
        content,
        final_revision: expected?.final_revision ?? state.value.final_revision,
        source_revision: expected?.source_revision ?? state.value.source_revision,
      })
      state.value = {
        ...state.value,
        final_revision: res?.final_revision ?? state.value.final_revision,
        source_revision: res?.source_revision ?? state.value.source_revision,
      }
      await reload()
      return { ok: true, changed: Boolean(res?.changed), message: '' }
    } catch (err) {
      const info = rewriteErrorOf(err)
      if (info?.error === 'revision_conflict') {
        await reload()
        conflict.value = { kind: 'save', versionId: null, mine: content, message: (err as Error)?.message || '' }
      }
      return { ok: false, changed: false, message: (err as Error)?.message || '' }
    } finally {
      busy.value = false
    }
  }

  /** 冲突时按新修订强制写入我的内容（人工决定，不自动合并） */
  async function forceSave(content: string): Promise<WriteResult> {
    conflict.value = null
    return saveFinal(content)
  }

  return {
    state, loaded, loading, loadError, busy, conflict,
    reload,
    currentRun, viewRunId, viewedRun, viewingHistory, runTask, runProgress, runActive, stagePosition,
    versions, versionById, runById, versionsByStage, adoptedChain, predecessorOf, isStaleSource,
    strip, stageKeys, stageDefs, candidateVersion,
    start, disableAutoAdopt, adopt, saveFinal, forceSave,
  }
}
