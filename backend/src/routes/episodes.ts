import { Hono } from 'hono'
import { and, eq, isNull } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { success, notFound, badRequest, now } from '../utils/response.js'
import { toSnakeCase } from '../utils/transform.js'
import { getActiveConfigId } from '../services/ai.js'
import { EXTRACT_TARGETS, getExtractionStatus, startExtraction, type ExtractTarget } from '../services/extraction.js'
import { getVideoPromptBatchStatus, startVideoPromptBatch } from '../services/video-prompts.js'
import { getKeyframePromptBatchStatus, startKeyframePromptBatch } from '../services/keyframe-prompts.js'
import { isKeyframeSlot, keyframesJson, loadEpisodeKeyframes, type KeyframeSlot } from '../services/keyframes.js'
import { parseStylingVersion } from '../services/styling-version.js'
import {
  cancelEpisodeVideoBatch,
  getEpisodeVideoBatch,
  previewEpisodeVideoBatch,
  startEpisodeVideoBatch,
} from '../services/video-batch.js'
import {
  cancelEpisodeKeyframeBatch,
  getEpisodeKeyframeBatch,
  retryFailedKeyframeBatch,
  startEpisodeKeyframeBatch,
  previewEpisodeKeyframeBatch,
} from '../services/keyframe-batch.js'
import { checkStoryboardRefs, loadEpisodeAssets, loadStoryboardTargetAssets } from '../services/storyboard-assets.js'
import { parseFieldSavedAt } from '../services/storyboard-fields.js'
import { lookupGeneratedAt } from '../services/media-time.js'
import { parseTransitionReview, transitionInputSignature } from '../services/transition.js'
import {
  AssetLibraryError,
  isAssetKind,
  linkAssetToEpisode,
  loadImageVersions,
  unlinkAssetFromEpisode,
} from '../services/asset-library.js'
import {
  DEFAULT_SUBTITLE_TIMING,
  estimateNarrationSeconds,
  narrationCharCount,
  narrationIssues,
  narrationStatus,
  parseNarrationMeta,
} from '../services/narration.js'
import { getNarrationScriptStatus, startNarrationScript } from '../services/narration-script.js'
import { getTtsOptions, getVoiceBatchStatus, previewVoiceBatch, resolveSubtitleTiming, startVoiceBatch } from '../services/narration-voice.js'
import { getComposeBatchStatus, startComposeBatch } from '../services/shot-compose.js'
import { DEFAULT_FIT_RECORD, parseFitRecord, validateFitRecord } from '../services/narration-fit.js'
import type { AssetKind } from '../services/reference-images.js'
import { loadEpisodeRosterRecord, saveEpisodeRosterRecord } from '../services/character-roster.js'
import type { RosterEntryInput } from '../services/character-roster.js'
import { normalizeAssetName } from '../services/asset-name.js'

const app = new Hono()

async function attachImageVersions<T extends { id: number; imageUrl: string | null }>(
  rows: T[],
  kind: AssetKind,
) {
  const versionsOf = await loadImageVersions(kind, rows)
  return rows.map((row) => {
    const versions = versionsOf.get(row.id) ?? []
    return {
      ...toSnakeCase(row),
      image_versions: versions,
      image_generated_at: versions.find(version => version.is_current)?.generated_at ?? null,
    }
  })
}


// POST /episodes — Create a new episode
app.post('/', async (c) => {
  const body = await c.req.json()
  if (!body.drama_id) return badRequest(c, 'drama_id 必填')

  // 图片/视频配置：显式传入优先，缺省时自动锁定当前启用的最高优先级官方配置
  const imageConfigId = body.image_config_id ?? await getActiveConfigId('image')
  const videoConfigId = body.video_config_id ?? await getActiveConfigId('video')
  if (!imageConfigId) return badRequest(c, '未找到启用的图片生成配置，请先在设置中心添加')
  if (!videoConfigId) return badRequest(c, '未找到启用的视频生成配置，请先在设置中心添加')
  const ts = now()

  // Get next episode number（忽略已软删的集，删除中间集后新集号可复用空位之后的最大值）
  const existing = await db.select().from(schema.episodes)
    .where(and(eq(schema.episodes.dramaId, body.drama_id), isNull(schema.episodes.deletedAt)))
    .orderBy(schema.episodes.episodeNumber)
  const nextNum = existing.length ? Math.max(...existing.map(e => e.episodeNumber)) + 1 : 1

  const res = await db.insert(schema.episodes).values({
    dramaId: body.drama_id,
    episodeNumber: nextNum,
    title: body.title || `第${nextNum}集`,
    imageConfigId,
    videoConfigId,
    // 语音合成配置：没有启用的 TTS 配置时留空，不挡住未用旁白功能的用户建集
    ttsConfigId: body.tts_config_id ?? await getActiveConfigId('tts'),
    subtitleTiming: DEFAULT_SUBTITLE_TIMING,
    // 视频分辨率在创建集时固定（480p/720p/1080p），后续可通过 PUT 修改；各视频适配器再映射为厂商档位
    resolution: ['480p', '720p', '1080p'].includes(body.resolution) ? body.resolution : '720p',
    createdAt: ts,
    updatedAt: ts,
  })

  const [ep] = await db.select().from(schema.episodes)
    .where(eq(schema.episodes.id, getInsertId(res)))
  return success(c, {
    id: ep.id,
    episode_number: ep.episodeNumber,
    title: ep.title,
    image_config_id: ep.imageConfigId,
    video_config_id: ep.videoConfigId,
    resolution: ep.resolution,
  })
})

// PUT /episodes/:id - Update episode fields
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()

  const allowed = [
    'content', 'script_content', 'title', 'description', 'status', 'resolution',
    'narration_enabled', 'tts_config_id', 'subtitle_timing',
    'audio_mix_mode', 'audio_bed_gain_db', 'narration_fit_default',
    'narration_spine', 'narration_normalize',
  ]
  const updates: Record<string, any> = {}
  for (const key of allowed) {
    if (key in body) updates[key] = body[key]
  }
  if (Object.keys(updates).length === 0) return badRequest(c, '没有可更新的字段')
  if ('resolution' in updates && !['480p', '720p', '1080p'].includes(updates.resolution)) {
    return badRequest(c, 'resolution 只支持 480p / 720p / 1080p')
  }
  if ('subtitle_timing' in updates && !['sentence', 'char'].includes(updates.subtitle_timing)) {
    return badRequest(c, 'subtitle_timing 只支持 sentence / char')
  }

  if ('audio_mix_mode' in updates && !['replace', 'mix'].includes(updates.audio_mix_mode)) {
    return badRequest(c, 'audio_mix_mode 只支持 replace / mix')
  }
  if ('narration_fit_default' in updates && updates.narration_fit_default != null) {
    const raw = typeof updates.narration_fit_default === 'string'
      ? updates.narration_fit_default
      : JSON.stringify(updates.narration_fit_default)
    const record = parseFitRecord(raw)
    if (!record) return badRequest(c, 'narration_fit_default 不是合法的匹配参数')
    const error = validateFitRecord(record)
    if (error) return badRequest(c, error)
    updates.narration_fit_default = JSON.stringify({ ...record, updated_at: now() })
  }
  // Map snake_case to camelCase for drizzle
  const drizzleUpdates: Record<string, any> = { updatedAt: now() }
  if ('content' in updates) drizzleUpdates.content = updates.content
  if ('script_content' in updates) drizzleUpdates.scriptContent = updates.script_content
  if ('title' in updates) drizzleUpdates.title = updates.title
  if ('description' in updates) drizzleUpdates.description = updates.description
  if ('status' in updates) drizzleUpdates.status = updates.status
  if ('resolution' in updates) drizzleUpdates.resolution = updates.resolution
  if ('narration_enabled' in updates) drizzleUpdates.narrationEnabled = updates.narration_enabled === true
  if ('tts_config_id' in updates) drizzleUpdates.ttsConfigId = updates.tts_config_id ?? null
  if ('subtitle_timing' in updates) drizzleUpdates.subtitleTiming = updates.subtitle_timing

  if ('audio_mix_mode' in updates) drizzleUpdates.audioMixMode = updates.audio_mix_mode
  if ('audio_bed_gain_db' in updates) {
    drizzleUpdates.audioBedGainDb = updates.audio_bed_gain_db == null ? null : Number(updates.audio_bed_gain_db)
  }
  if ('narration_fit_default' in updates) drizzleUpdates.narrationFitDefault = updates.narration_fit_default ?? null
  if ('narration_spine' in updates) {
    const spine = typeof updates.narration_spine === 'string' ? updates.narration_spine.trim() : ''
    drizzleUpdates.narrationSpine = spine || null
  }
  if ('narration_normalize' in updates) drizzleUpdates.narrationNormalize = updates.narration_normalize === true
  await db.update(schema.episodes).set(drizzleUpdates).where(eq(schema.episodes.id, id))
  return success(c)
})

// DELETE /episodes/:id - Soft delete episode（其分镜/生成记录保留但不可达）
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, id))
  if (!ep) return notFound(c, '剧集不存在')
  await db.update(schema.episodes).set({ deletedAt: now(), updatedAt: now() })
    .where(eq(schema.episodes.id, id))
  return success(c)
})

// GET /episodes/:id/characters — characters linked to this episode
app.get('/:id/characters', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const links = await db.select().from(schema.episodeCharacters)
    .where(eq(schema.episodeCharacters.episodeId, episodeId))
  const charIds = links.map(l => l.characterId)
  if (!charIds.length) return success(c, [])
  const allChars = await db.select().from(schema.characters)
  const result = allChars.filter(ch => charIds.includes(ch.id) && !ch.deletedAt)
  const withVersions = await attachImageVersions(result, 'character')
  // 本集造型版本（Issue #15）：前端在集资产页展示/重出这套造型图
  const stylingByCharId = new Map(links.map(l => [l.characterId, parseStylingVersion(l.stylingVersion)]))
  return success(c, withVersions.map((row: Record<string, any>) => ({
    ...row,
    styling_version: stylingByCharId.get(Number(row.id)) ?? null,
  })))
})

// GET /episodes/:id/scenes — scenes linked to this episode
app.get('/:id/scenes', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const links = await db.select().from(schema.episodeScenes)
    .where(eq(schema.episodeScenes.episodeId, episodeId))
  const sceneIds = links.map(l => l.sceneId)
  if (!sceneIds.length) return success(c, [])
  const allScenes = await db.select().from(schema.scenes)
  const result = allScenes.filter(sc => sceneIds.includes(sc.id) && !sc.deletedAt)
  return success(c, await attachImageVersions(result, 'scene'))
})

// GET /episodes/:id/props — props linked to this episode
app.get('/:id/props', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const links = await db.select().from(schema.episodeProps)
    .where(eq(schema.episodeProps.episodeId, episodeId))
  const propIds = links.map(l => l.propId)
  if (!propIds.length) return success(c, [])
  const allProps = await db.select().from(schema.props)
  const result = allProps.filter(p => propIds.includes(p.id) && !p.deletedAt)
  return success(c, await attachImageVersions(result, 'prop'))
})

// POST /episodes/:id/assets/link — 把本项目已有资产关联到本集（资产管理器·本项目复用）
app.post('/:id/assets/link', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const body: unknown = await c.req.json()
  const kind = body && typeof body === 'object' && 'kind' in body ? body.kind : undefined
  const assetIdRaw = body && typeof body === 'object' && 'asset_id' in body ? body.asset_id : undefined
  if (!isAssetKind(kind)) return badRequest(c, 'kind 必须是 character / scene / prop')
  const assetId = Number(assetIdRaw)
  if (!Number.isInteger(assetId) || assetId <= 0) return badRequest(c, 'asset_id 必填')
  try {
    return success(c, await linkAssetToEpisode(episodeId, kind, assetId))
  } catch (err) {
    if (err instanceof AssetLibraryError) {
      return err.status === 404 ? notFound(c, err.message) : badRequest(c, err.message)
    }
    throw err
  }
})

// DELETE /episodes/:id/assets/link?kind=&asset_id= — 取消关联（不删资产，幂等）
app.delete('/:id/assets/link', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const kind = c.req.query('kind')
  if (!isAssetKind(kind)) return badRequest(c, 'kind 必须是 character / scene / prop')
  const assetId = Number(c.req.query('asset_id'))
  if (!Number.isInteger(assetId) || assetId <= 0) return badRequest(c, 'asset_id 必填')
  return success(c, await unlinkAssetFromEpisode(episodeId, kind, assetId))
})

// POST /episodes/:id/extract — 异步提取资产（target: characters | scenes | props），立即返回，前端轮询状态
app.post('/:id/extract', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const target = body.target as ExtractTarget
  if (!EXTRACT_TARGETS.includes(target)) return badRequest(c, 'target 必须是 characters / scenes / props')
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, id))
  if (!ep) return notFound(c, '剧集不存在')
  const started = await startExtraction(ep.id, ep.dramaId, target, { model: body.model || undefined, configId: body.config_id ?? undefined })
  return success(c, { target, status: 'running', already_running: !started })
})

// GET /episodes/:id/extract-status — 查询三类资产提取任务状态
app.get('/:id/extract-status', async (c) => {
  const id = Number(c.req.param('id'))
  return success(c, await getExtractionStatus(id))
})

// GET /episodes/:id/character-roster — 纪录片选角名册（谁该建卡的契约，人在集页面复核）
app.get('/:id/character-roster', async (c) => {
  const id = Number(c.req.param('id'))
  const record = await loadEpisodeRosterRecord(id)
  if (!record) return notFound(c, '剧集不存在')
  return success(c, {
    cast: record.cast ?? [],
    exists: record.cast !== null,
    status: record.status,
    stale: record.stale,
    script_hash: record.script_hash,
    current_hash: record.current_hash,
    updated_at: record.updated_at,
  })
})

// PUT /episodes/:id/character-roster — 人复核后保存名册（status 缺省按「已确认」保存）
app.put('/:id/character-roster', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>))
  if (!Array.isArray(body.cast)) return badRequest(c, 'cast 必须是数组')
  // 逐条校验：空对象/null 会被规范化成空名字而静默丢弃，那等于「确认了一份被悄悄删人的名册」
  for (const [index, row] of (body.cast as unknown[]).entries()) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return badRequest(c, `cast[${index}] 必须是对象`)
    const entry = row as Record<string, unknown>
    if (typeof entry.name !== 'string' || !normalizeAssetName(entry.name)) {
      return badRequest(c, `cast[${index}].name 必须是非空名字（空白与 \\ / : * ? " < > | @ 会自动替换为 _）`)
    }
    for (const key of ['basis', 'reason', 'source'] as const) {
      if (entry[key] !== undefined && typeof entry[key] !== 'string') return badRequest(c, `cast[${index}].${key} 必须是字符串`)
    }
  }
  const existing = await loadEpisodeRosterRecord(id)
  if (!existing) return notFound(c, '剧集不存在')
  // 打开名册后剧本被改过就不许直接确认：否则人是在为旧正文签字（前端把 GET 返回的 current_hash 回传）
  if (typeof body.expected_hash === 'string' && body.expected_hash && body.expected_hash !== existing.current_hash) {
    return badRequest(c, '剧本在你打开名册之后发生了改动，请重新打开「选角名册」复核后再保存')
  }
  const status = body.status === 'draft' ? 'draft' : 'approved'
  // 人手动保存的成员标 source='human'（Agent 草稿里原有的 source 会被保留），
  // 复核即以**当前剧本**重新盖指纹：名册与这一版正文绑定
  const record = await saveEpisodeRosterRecord(id, body.cast as RosterEntryInput[], status, 'human')
  if (!record) return notFound(c, '剧集不存在')
  return success(c, {
    cast: record.cast ?? [],
    exists: record.cast !== null,
    status: record.status,
    stale: record.stale,
    script_hash: record.script_hash,
    current_hash: record.current_hash,
    updated_at: record.updated_at,
  })
})

// POST /episodes/:id/generate-video-prompts — 异步批量为缺少视频提示词的分镜生成（立即返回，前端轮询状态）
app.post('/:id/generate-video-prompts', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({}))
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, id))
  if (!ep) return notFound(c, '剧集不存在')
  const storyboardIds = Array.isArray(body.storyboard_ids)
    ? body.storyboard_ids.map(Number).filter((n: number) => Number.isInteger(n) && n > 0)
    : undefined
  const result = await startVideoPromptBatch(ep.id, ep.dramaId, { model: body.model || undefined, configId: body.config_id ?? undefined }, storyboardIds)
  if (result.total === -1) return success(c, { status: 'running', already_running: true })
  if (!result.started) return success(c, { status: 'idle', total: 0 })
  return success(c, { status: 'running', total: result.total })
})

// GET /episodes/:id/video-prompts-status — 查询批量视频提示词任务状态
app.get('/:id/video-prompts-status', async (c) => {
  const id = Number(c.req.param('id'))
  return success(c, await getVideoPromptBatchStatus(id))
})

// ─── 旁白 / 配音 / 分镜合成（Issue #30）────────────────────────────

// POST /episodes/:id/generate-narration — 整集旁白写作（narration_writer），立即返回
app.post('/:id/generate-narration', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({} as Record<string, any>))
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, id))
  if (!ep) return notFound(c, '剧集不存在')
  if (ep.narrationEnabled !== true) return badRequest(c, '本集未开启旁白，请先在「音频旁白设置」里开启')
  const storyboardIds = Array.isArray(body.storyboard_ids)
    ? body.storyboard_ids.map(Number).filter((n: number) => Number.isInteger(n) && n > 0)
    : undefined
  const result = await startNarrationScript(
    ep.id,
    ep.dramaId,
    { model: body.model || undefined, configId: body.config_id ?? undefined },
    storyboardIds,
  )
  // 已在运行时把当前进度一起带回去（#35）：前端据此显示运行态，而不是误报「没有需要处理的镜头」
  if (result.total === -1) {
    const running = await getNarrationScriptStatus(ep.id)
    return success(c, {
      status: 'running',
      already_running: true,
      total: running?.total ?? 0,
      completed: running?.completed ?? 0,
      failed: running?.failed ?? 0,
      phase: running?.phase,
    })
  }
  if (!result.started) return success(c, { status: 'idle', total: 0 })
  return success(c, { status: 'running', total: result.total })
})

// GET /episodes/:id/narration-status — 旁白写作任务状态
app.get('/:id/narration-status', async (c) => {
  return success(c, await getNarrationScriptStatus(Number(c.req.param('id'))))
})

// GET /episodes/:id/tts-options?storyboard_id= — 配音弹窗的选项与预填值（#37）
app.get('/:id/tts-options', async (c) => {
  const storyboardId = Number(c.req.query('storyboard_id') || 0) || undefined
  try {
    return success(c, await getTtsOptions(Number(c.req.param('id')), storyboardId))
  } catch (err) {
    return badRequest(c, err instanceof Error ? err.message : '读取配音选项失败')
  }
})

function voiceBatchIds(body: Record<string, any>): number[] | undefined {
  return Array.isArray(body.storyboard_ids)
    ? body.storyboard_ids.map(Number).filter((n: number) => Number.isInteger(n) && n > 0)
    : undefined
}

// POST /episodes/:id/narration/voice-batch/preview {settings, storyboard_ids?} — 按弹窗参数逐镜分类（#37）
app.post('/:id/narration/voice-batch/preview', async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, any>))
  try {
    const items = await previewVoiceBatch(Number(c.req.param('id')), body.settings, voiceBatchIds(body))
    return success(c, { items })
  } catch (err) {
    return badRequest(c, err instanceof Error ? err.message : '配音预览失败')
  }
})

// POST /episodes/:id/narration/voice-batch {settings?, storyboard_ids?} — 批量旁白配音（只配缺失 + 已变化）
app.post('/:id/narration/voice-batch', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({} as Record<string, any>))
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, id))
  if (!ep) return notFound(c, '剧集不存在')
  try {
    const result = await startVoiceBatch(ep.id, ep.dramaId, voiceBatchIds(body), body.settings)
    if (result.total === -1) {
      const running = await getVoiceBatchStatus(ep.id)
      return success(c, { status: 'running', already_running: true, total: running?.total ?? 0, completed: running?.completed ?? 0 })
    }
    if (!result.started) return success(c, { status: 'idle', total: 0 })
    return success(c, { status: 'running', total: result.total })
  } catch (err) {
    return badRequest(c, err instanceof Error ? err.message : '批量配音启动失败')
  }
})

// GET /episodes/:id/narration/voice-batch-status
app.get('/:id/narration/voice-batch-status', async (c) => {
  return success(c, await getVoiceBatchStatus(Number(c.req.param('id'))))
})

// POST /episodes/:id/compose-batch — 批量合成分镜成片（视频 + 旁白 + 字幕）
app.post('/:id/compose-batch', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({} as Record<string, any>))
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, id))
  if (!ep) return notFound(c, '剧集不存在')
  const storyboardIds = Array.isArray(body.storyboard_ids)
    ? body.storyboard_ids.map(Number).filter((n: number) => Number.isInteger(n) && n > 0)
    : undefined
  try {
    const result = await startComposeBatch(ep.id, ep.dramaId, storyboardIds)
    if (result.total === -1) return success(c, { status: 'running', already_running: true })
    if (!result.started) return success(c, { status: 'idle', total: 0 })
    return success(c, { status: 'running', total: result.total })
  } catch (err) {
    return badRequest(c, err instanceof Error ? err.message : '批量合成启动失败')
  }
})

// GET /episodes/:id/compose-batch-status
app.get('/:id/compose-batch-status', async (c) => {
  return success(c, await getComposeBatchStatus(Number(c.req.param('id'))))
})

// POST /episodes/:id/video-batch/preview — 逐镜列出 缺视频/已变化/未变化(同第N版)/无法判断/阻断/跳过
app.post('/:id/video-batch/preview', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({} as Record<string, any>))
  try {
    const items = await previewEpisodeVideoBatch(id, {
      storyboardIds: Array.isArray(body.storyboard_ids) ? body.storyboard_ids.map(Number) : undefined,
      model: body.model,
      configId: body.config_id,
    })
    return success(c, { items })
  } catch (err) {
    return badRequest(c, err instanceof Error ? err.message : '批量视频预览失败')
  }
})

// POST /episodes/:id/video-batch — 服务端批量视频（按预览勾选的分镜顺序串行，脱离浏览器）
app.post('/:id/video-batch', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({} as Record<string, any>))
  const storyboardIds = Array.isArray(body.storyboard_ids)
    ? body.storyboard_ids.map(Number).filter((n: number) => Number.isInteger(n) && n > 0)
    : []
  if (!storyboardIds.length) return badRequest(c, '请先在清单里勾选要生成的镜头')
  try {
    const status = await startEpisodeVideoBatch(id, {
      storyboardIds,
      model: body.model,
      configId: body.config_id,
    })
    return success(c, status)
  } catch (err) {
    return badRequest(c, err instanceof Error ? err.message : '批量视频启动失败')
  }
})

// GET /episodes/:id/video-batch — 最近一次批量的进度（刷新页面后仍可查看）
app.get('/:id/video-batch', async (c) => {
  const id = Number(c.req.param('id'))
  return success(c, await getEpisodeVideoBatch(id))
})

// POST /episodes/:id/video-batch/cancel — 停止：不再提交新的镜头，在跑的那一镜继续完成
app.post('/:id/video-batch/cancel', async (c) => {
  const id = Number(c.req.param('id'))
  try {
    return success(c, await cancelEpisodeVideoBatch(id))
  } catch (err) {
    return badRequest(c, err instanceof Error ? err.message : '停止批量视频失败')
  }
})

// POST /episodes/:id/generate-keyframe-prompts — 异步批量补齐关键帧提示词（立即返回，前端轮询状态）
app.post('/:id/generate-keyframe-prompts', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({}))
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, id))
  if (!ep) return notFound(c, '剧集不存在')
  const storyboardIds = Array.isArray(body.storyboard_ids)
    ? body.storyboard_ids.map(Number).filter((n: number) => Number.isInteger(n) && n > 0)
    : undefined
  const result = await startKeyframePromptBatch(ep.id, ep.dramaId, { model: body.model || undefined, configId: body.config_id ?? undefined }, storyboardIds)
  if (result.total === -1) return success(c, { status: 'running', already_running: true })
  if (!result.started) return success(c, { status: 'idle', total: 0 })
  return success(c, { status: 'running', total: result.total })
})

// GET /episodes/:id/keyframe-prompts-status — 查询批量关键帧提示词任务状态
app.get('/:id/keyframe-prompts-status', async (c) => {
  const id = Number(c.req.param('id'))
  return success(c, await getKeyframePromptBatchStatus(id))
})

// POST /episodes/:id/keyframe-batch/preview — 逐个“分镜 × 槽位”列出 缺图/已变化/未变化(同第N版)/阻断/跳过
app.post('/:id/keyframe-batch/preview', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({} as Record<string, any>))
  try {
    const items = await previewEpisodeKeyframeBatch(id, {
      storyboardIds: Array.isArray(body.storyboard_ids) ? body.storyboard_ids.map(Number) : undefined,
      model: body.model,
      configId: body.config_id,
    })
    return success(c, { items })
  } catch (err) {
    return badRequest(c, err instanceof Error ? err.message : '批量关键帧预览失败')
  }
})

// POST /episodes/:id/keyframe-batch — 服务端批量关键帧（按勾选的 分镜 × 槽位 入批）
app.post('/:id/keyframe-batch', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({} as Record<string, any>))
  const items: Array<{ storyboard_id: number; slot: KeyframeSlot }> = []
  for (const raw of Array.isArray(body.items) ? (body.items as unknown[]) : []) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as { storyboard_id?: unknown; slot?: unknown }
    const storyboardId = Number(entry.storyboard_id)
    if (!Number.isInteger(storyboardId) || !isKeyframeSlot(entry.slot)) continue
    items.push({ storyboard_id: storyboardId, slot: entry.slot })
  }
  if (!items.length) return badRequest(c, 'items 必须是 [{ storyboard_id, slot }] 且 slot 为 first/mid/last')
  try {
    const status = await startEpisodeKeyframeBatch(id, {
      items,
      model: body.model,
      configId: body.config_id,
    })
    return success(c, status)
  } catch (err) {
    return badRequest(c, err instanceof Error ? err.message : '批量关键帧启动失败')
  }
})

// GET /episodes/:id/keyframe-batch — 最近一次批量的进度（刷新页面后仍可查看）
app.get('/:id/keyframe-batch', async (c) => {
  const id = Number(c.req.param('id'))
  return success(c, await getEpisodeKeyframeBatch(id))
})

// POST /episodes/:id/keyframe-batch/cancel — 停止：取消该批次所有未结束的关键帧任务
app.post('/:id/keyframe-batch/cancel', async (c) => {
  const id = Number(c.req.param('id'))
  try {
    return success(c, await cancelEpisodeKeyframeBatch(id))
  } catch (err) {
    return badRequest(c, err instanceof Error ? err.message : '停止批量关键帧失败')
  }
})

// POST /episodes/:id/keyframe-batch/retry-failed — 只重提失败/已取消项（新建 sys_task）
app.post('/:id/keyframe-batch/retry-failed', async (c) => {
  const id = Number(c.req.param('id'))
  try {
    return success(c, await retryFailedKeyframeBatch(id))
  } catch (err) {
    return badRequest(c, err instanceof Error ? err.message : '重试失败项失败')
  }
})

// GET /episodes/:episode_id/storyboards
app.get('/:episode_id/storyboards', async (c) => {
  const episodeId = Number(c.req.param('episode_id'))
  const rows = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)

  const links = await db.select().from(schema.storyboardCharacters)
  const charIdsByStoryboard = new Map<number, number[]>()
  for (const link of links) {
    const arr = charIdsByStoryboard.get(link.storyboardId) || []
    arr.push(link.characterId)
    charIdsByStoryboard.set(link.storyboardId, arr)
  }

  const propLinks = await db.select().from(schema.storyboardProps)
  const propIdsByStoryboard = new Map<number, number[]>()
  for (const link of propLinks) {
    const arr = propIdsByStoryboard.get(link.storyboardId) || []
    arr.push(link.propId)
    propIdsByStoryboard.set(link.storyboardId, arr)
  }

  const episodeCharLinks = await db.select().from(schema.episodeCharacters)
    .where(eq(schema.episodeCharacters.episodeId, episodeId))
  const episodeCharIds = episodeCharLinks.map(link => link.characterId)
  const allChars = (await db.select().from(schema.characters))
    .filter(ch => episodeCharIds.includes(ch.id) && !ch.deletedAt)

  const episodePropLinks = await db.select().from(schema.episodeProps)
    .where(eq(schema.episodeProps.episodeId, episodeId))
  const episodePropIds = episodePropLinks.map(link => link.propId)
  const allProps = (await db.select().from(schema.props))
    .filter(p => episodePropIds.includes(p.id) && !p.deletedAt)

  const videoTasks = (await db.select().from(schema.sysTask))
    .filter(task => task.type === 'video' && task.status === 'completed' && task.storyboardId)

  // 关键帧状态（生效首帧、就绪、确认），界面据此显示状态与承接标记
  const keyframes = await loadEpisodeKeyframes(episodeId)

  // 「当前媒体」（三个槽位的生效关键帧 + 当前分镜视频）的生成时间：一次批量反查
  const mediaPaths: Array<string | null> = []
  for (const row of rows) {
    const state = keyframes.get(row.id)
    mediaPaths.push(row.videoUrl, row.firstFrameImage, row.midFrameImage, row.lastFrameImage,
      state?.first ?? null, state?.mid ?? null, state?.last ?? null)
  }
  const mediaGeneratedAt = await lookupGeneratedAt(mediaPaths)
  const episodeAssets = await loadEpisodeAssets(episodeId)
  // 旁白状态由服务端算好（前端不自己推）：开关 + 文本 + 配音 + 合成签名
  const [narrationEpisode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  const episodeNarrationEnabled = narrationEpisode?.narrationEnabled === true
  return success(c, await Promise.all(rows.map(async (row) => {
    const videoVersions: Array<{
      id: number | null
      url: string | null
      provider: string | null
      model: string | null
      created_at: string | null
      generated_at: number | null
      is_current: boolean
    }> = videoTasks
      .filter(task => task.storyboardId === row.id && (task.localPath || task.resultUrl))
      .map(task => ({
        id: task.id,
        url: task.localPath || task.resultUrl,
        provider: task.provider,
        model: task.model,
        created_at: task.createdAt,
        generated_at: task.generatedAt ?? null,
        is_current: (task.localPath || task.resultUrl) === row.videoUrl,
      }))
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    if (row.videoUrl && !videoVersions.some(version => version.url === row.videoUrl)) {
      videoVersions.unshift({
        id: null,
        url: row.videoUrl,
        provider: 'legacy',
        model: null,
        created_at: null,
        generated_at: null,
        is_current: true,
      })
    }
    return {
      ...toSnakeCase(row),
      target_assets: await loadStoryboardTargetAssets(row, episodeAssets),
      field_saved_at: parseFieldSavedAt(row.fieldSavedAt),
      ref_issues: [
        ...await checkStoryboardRefs(row, episodeAssets),
        ...narrationIssues({
          episodeNarrationEnabled,
          shotNarrationEnabled: row.narrationEnabled !== false,
          narrationText: row.narrationText,
          meta: parseNarrationMeta(row.narrationMeta),
        }),
      ],
      narration_meta: parseNarrationMeta(row.narrationMeta),
      narration_status: narrationStatus({
        episodeNarrationEnabled,
        shotNarrationEnabled: row.narrationEnabled !== false,
        narrationText: row.narrationText,
        narrationAudioUrl: row.narrationAudioUrl,
        videoUrl: row.videoUrl,
        composedVideoUrl: row.composedVideoUrl,
        subtitleUrl: row.subtitleUrl,
        meta: parseNarrationMeta(row.narrationMeta),
      }),
      narration_chars: narrationCharCount(row.narrationText),
      narration_estimate_seconds: estimateNarrationSeconds(row.narrationText),
      // 本镜生效的文本规范化（#35）：镜级覆盖 > 集级默认（默认开）
      narration_normalize_effective: row.narrationNormalize ?? (narrationEpisode?.narrationNormalize !== false),
      subtitle_timing_effective: resolveSubtitleTiming(narrationEpisode?.subtitleTiming, row.subtitleTiming),
      // 本镜生效的匹配参数（#31）：镜级覆盖 > 集级默认 > 内置默认；inherited=true 表示没有镜级覆盖
      narration_fit_effective: {
        ...(parseFitRecord(row.narrationFit) || parseFitRecord(narrationEpisode?.narrationFitDefault) || DEFAULT_FIT_RECORD),
        inherited: !parseFitRecord(row.narrationFit),
        audio_mix_mode: parseFitRecord(row.narrationFit)?.audio_mix_mode
          ?? (narrationEpisode?.audioMixMode === 'mix' ? 'mix' : 'replace'),
      },
      keyframes: keyframesJson(keyframes.get(row.id)),
      video_versions: videoVersions,
      transition_review: parseTransitionReview(row.transitionReview),
      // 上下镜输入变化后旧审核即失效，前端据此提示「建议重新审核」（#11）
      transition_stale: (() => {
        const review = parseTransitionReview(row.transitionReview)
        const prevId = keyframes.get(row.id)?.previousId
        const prev = prevId ? rows.find(item => item.id === prevId) : null
        if (!review || !prev || !keyframes.get(row.id)?.inheritsFirst) return false
        return transitionInputSignature(prev, keyframes.get(prev.id)?.last ?? null, row) !== review.input_signature
      })(),
      // 路径 → 生成时间（unix 秒）：关键帧槽位、分镜视频等「当前媒体」共用，反查不到的路径不在表里
      media_generated_at: Object.fromEntries(
        [row.videoUrl, row.firstFrameImage, row.midFrameImage, row.lastFrameImage,
          keyframes.get(row.id)?.first ?? null, keyframes.get(row.id)?.mid ?? null, keyframes.get(row.id)?.last ?? null]
          .filter((p): p is string => !!p && mediaGeneratedAt.has(p))
          .map(p => [p, mediaGeneratedAt.get(p)!]),
      ),
      character_ids: charIdsByStoryboard.get(row.id) || [],
      prop_ids: propIdsByStoryboard.get(row.id) || [],
      characters: allChars
        .filter(ch => (charIdsByStoryboard.get(row.id) || []).includes(ch.id))
        .map(ch => toSnakeCase(ch)),
      props: allProps
        .filter(p => (propIdsByStoryboard.get(row.id) || []).includes(p.id))
        .map(p => toSnakeCase(p)),
    }
  })))
})

// GET /episodes/:id/pipeline-status — 流水线进度
// 按集聚合任务的旧接口 /generation-tasks 已删除：任务中心统一走 GET /tasks/center（sys_task.episode_id）
app.get('/:id/pipeline-status', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!ep) return notFound(c, '剧集不存在')

  const chars = await db.select().from(schema.characters).where(eq(schema.characters.dramaId, ep.dramaId))
  const scenes = await db.select().from(schema.scenes).where(eq(schema.scenes.dramaId, ep.dramaId))
  const sbs = await db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId))
  // 软删的成片不参与「已合成」判断：文件已被删除，继续展示会产生死链
  const merges = await db.select().from(schema.videoMerges)
    .where(and(eq(schema.videoMerges.episodeId, episodeId), isNull(schema.videoMerges.deletedAt)))

  const sbsWithImage = sbs.filter(s => s.composedImage)
  const sbsWithVideo = sbs.filter(s => s.videoUrl)
  const latestMerge = merges[merges.length - 1]

  function stepStatus(done: boolean, partial?: boolean) {
    if (done) return 'done'
    if (partial) return 'partial'
    return 'pending'
  }

  return success(c, {
    episode_id: episodeId,
    steps: {
      script_rewrite: { status: ep.scriptContent ? 'done' : (ep.content ? 'ready' : 'pending') },
      extract_characters: { status: stepStatus(chars.length > 0), count: chars.length },
      extract_scenes: { status: stepStatus(scenes.length > 0), count: scenes.length },
      extract_storyboards: { status: stepStatus(sbs.length > 0), count: sbs.length },
      generate_images: { status: stepStatus(sbsWithImage.length === sbs.length && sbs.length > 0, sbsWithImage.length > 0), completed: sbsWithImage.length, total: sbs.length },
      generate_videos: { status: stepStatus(sbsWithVideo.length === sbs.length && sbs.length > 0, sbsWithVideo.length > 0), completed: sbsWithVideo.length, total: sbs.length },
      merge_episode: { status: latestMerge?.status === 'completed' ? 'done' : (latestMerge ? latestMerge.status : 'pending'), merged_url: latestMerge?.mergedUrl },
    },
  })
})

export default app
