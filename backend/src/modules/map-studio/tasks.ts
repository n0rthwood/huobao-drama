import { sqlite } from '../../db/index.js'
import { now } from '../../utils/response.js'
import { getActiveConfig } from '../../services/ai.js'
import { MAP_STUDIO_SCHEMA, insertTask, selectTask, selectTaskByHost, hasSettingRow, writeSetting, updateTask, type RunRow } from './db.js'
import { getHost, setMapStudioPlatform } from './registry.js'
import { seedLegacyResearchKeys } from './settings.js'
import { emptyBrief, emptyWorkflow, normalizeBrief } from './types.js'
import { briefHash, loadTask, parseWorkflow, serializeDetail, MapStudioRequestError } from './store.js'
import type { MapStudioPlatform } from './contract.js'

export async function initMapStudio(platform: MapStudioPlatform): Promise<void> {
  for (const sql of MAP_STUDIO_SCHEMA) sqlite.exec(sql)
  setMapStudioPlatform(platform)
  const interrupted = sqlite.prepare("SELECT * FROM map_studio_run WHERE status = 'processing'").all() as RunRow[]
  // 冻结到最后已持久确认的时刻：运行行只在阶段边界更新，在飞调用的心跳在观测表里；
  // 取两者较晚者，否则墙钟会短于其中已落盘的模型调用耗时。
  const lastHeartbeat = sqlite.prepare("SELECT MAX(heartbeat_at) AS hb FROM task_observed_work WHERE scope = 'map_studio' AND task_id = ?")
  sqlite.transaction(() => {
    for (const run of interrupted) {
      const hb = Number((lastHeartbeat.get(run.id) as { hb: number | null } | undefined)?.hb ?? 0)
      const frozenAt = new Date(Math.max(Date.parse(run.updated_at) || 0, hb)).toISOString()
      sqlite.prepare("UPDATE map_studio_run SET status = 'interrupted', error_msg = '后端重启中断', finished_at = ? WHERE id = ? AND status = 'processing'").run(frozenAt, run.id)
      const row = selectTask(run.task_id)
      if (!row) continue
      const state = parseWorkflow(row.state)
      if (state.status !== 'running' || state.run_id !== run.id) continue
      state.status = 'failed'
      state.error = '后端重启中断；已产出内容保留，请从当前步骤重新开始'
      state.revision++
      state.updated_at = now()
      for (const step of state.steps) if (step.status === 'running') Object.assign(step, { status: 'failed', message: state.error, finished_at: frozenAt })
      state.history = [...state.history, { revision: state.revision, at: state.updated_at, stage: state.stage, status: state.status, action: 'restart_interrupted', actor: 'system' as const, note: state.error }].slice(-30)
      updateTask(row.id, { expectedState: row.state, expectedMapSpec: row.map_spec, expectedBrief: row.brief, state: JSON.stringify(state), mapSpec: row.map_spec, brief: row.brief, updatedAt: state.updated_at })
    }
  })()
  await seedLegacyResearchKeys(platform)
  if (!hasSettingRow('models')) {
    const text = await getActiveConfig('text')
    const image = await getActiveConfig('image')
    writeSetting('models', { text_config_id: text?.id ?? null, image_config_id: image?.id ?? null, image_model: image?.model || null })
  }
}

export async function createStandaloneTask(input: { title: string; brief?: unknown }) {
  const title = input.title.trim()
  if (!title) throw new MapStudioRequestError('任务标题必填', 'missing_title')
  const brief = normalizeBrief(input.brief ?? {}, { ...emptyBrief(), subject: title })
  const state = emptyWorkflow()
  state.brief = brief; state.brief_hash = briefHash(brief)
  const id = insertTask({ title, host: null, hostRef: null, brief: JSON.stringify(brief), state: JSON.stringify(state), mapSpec: null })
  const loaded = await loadTask(id)
  if (!loaded) throw new Error('地图任务创建失败')
  return serializeDetail(loaded)
}

export async function openHostTask(input: { host: string; ref: string; existingTaskId?: number | null }): Promise<{ task_id: number; path: string }> {
  const host = getHost(input.host)
  const target = host ? await host.describe(input.ref) : null
  if (!host || !target) throw new MapStudioRequestError('宿主目标不存在或不是地图资产', 'host_target_missing')
  const existing = input.existingTaskId ? selectTask(input.existingTaskId) : null
  const found = existing?.host === input.host && existing.host_ref === input.ref ? existing : selectTaskByHost(input.host, input.ref)
  if (found) return { task_id: found.id, path: `/map-studio/${found.id}` }
  const brief = await host.readBrief(input.ref) ?? { ...emptyBrief(), subject: target.title }
  const state = emptyWorkflow()
  state.brief = brief; state.brief_hash = briefHash(brief)
  let id: number
  try { id = insertTask({ title: target.title, host: input.host, hostRef: input.ref, brief: null, state: JSON.stringify(state), mapSpec: null }) }
  catch (err) {
    const concurrent = selectTaskByHost(input.host, input.ref)
    if (!concurrent) throw err
    id = concurrent.id
  }
  return { task_id: id, path: `/map-studio/${id}` }
}
