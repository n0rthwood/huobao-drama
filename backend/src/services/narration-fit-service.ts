/**
 * 旁白/画面匹配参数的读写（Issue #31）。
 *
 * 校验发生在两处：PUT 时按当时实测时长预检，合成时再复核——**以合成期为准**
 * （配音可能在两次操作之间被重新生成）。两处都走同一个纯函数 `planCompose`。
 */
import fs from 'fs'
import path from 'path'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { DATA_ROOT, STORAGE_ROOT } from '../utils/paths.js'
import { probeDurationMs } from './tts.js'
import { ComposeBlockedError, resolveTransitionT } from './shot-compose.js'
import {
  MAX_PAD_SECONDS,
  MAX_TEMPO,
  MIN_TEMPO,
  parseFitRecord,
  planCompose,
  resolveComposeFit,
  suggestedCharsForAvail,
  validateFitRecord,
  type ComposePlan,
  type NarrationFitRecord,
} from './narration-fit.js'
import { parseNarrationMeta } from './narration.js'

function toAbsPath(relativePath: string): string {
  if (path.isAbsolute(relativePath)) return relativePath
  if (relativePath.startsWith('static/')) return path.join(DATA_ROOT, relativePath)
  return path.join(STORAGE_ROOT, relativePath)
}

export interface NarrationFitPreview {
  storyboard_id: number
  mode: 'pad' | 'tempo'
  pad_ms: number
  pad_position: 'head' | 'tail'
  tempo: number
  tempo_override: number | null
  audio_mix_mode: 'replace' | 'mix'
  bed_gain_db: number
  inherited: boolean
  /** 纯函数算出的计划（目标时长、起播点、差距、是否阻断） */
  plan: ComposePlan
  suggested_chars: number
  tempo_available: boolean
  limits: { min_tempo: number; max_tempo: number; max_pad_seconds: number }
}

/** 实测 Dv / Da / T（没有视频或配音时回退到库里的时长，只用于预览） */
async function measure(storyboardId: number) {
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  if (!sb) throw new Error('镜头不存在')
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId))
  if (!ep) throw new Error('剧集不存在')

  let dv = Number(sb.duration || 0)
  if (sb.videoUrl) {
    const abs = toAbsPath(sb.videoUrl)
    if (fs.existsSync(abs)) dv = (await probeDurationMs(abs)) / 1000
  }

  const meta = parseNarrationMeta(sb.narrationMeta)
  let da: number | null = null
  if (sb.narrationEnabled !== false && sb.narrationAudioUrl) {
    const abs = toAbsPath(sb.narrationAudioUrl)
    da = fs.existsSync(abs)
      ? (await probeDurationMs(abs)) / 1000
      : (meta.audio ? meta.audio.duration_ms / 1000 : null)
  }

  const { t } = await resolveTransitionT(storyboardId, sb.transitionReview)
  return { sb, ep, dv, da, t }
}

export async function previewNarrationFit(storyboardId: number): Promise<NarrationFitPreview> {
  const { sb, ep, dv, da, t } = await measure(storyboardId)
  const availSeconds = Math.max(0, Math.min(dv, 15) - t)
  const fit = resolveComposeFit({
    episodeDefault: ep.narrationFitDefault,
    shotFit: sb.narrationFit,
    episodeMixMode: ep.audioMixMode,
    episodeBedGainDb: ep.audioBedGainDb,
    da,
    availSeconds,
  })
  const plan = planCompose({ dv, da, t, fit })
  const record = parseFitRecord(sb.narrationFit)
  const padMs = Math.round((fit.padHeadSeconds + fit.padTailSeconds) * 1000)

  return {
    storyboard_id: storyboardId,
    mode: fit.mode ?? 'pad',
    pad_ms: padMs,
    pad_position: fit.padHeadSeconds > 0 ? 'head' : 'tail',
    tempo: fit.tempo,
    tempo_override: record?.tempo_override ?? null,
    audio_mix_mode: fit.audioMixMode,
    bed_gain_db: fit.bedGainDb,
    inherited: !record,
    plan,
    suggested_chars: suggestedCharsForAvail(availSeconds),
    // 差距 ≤30% 时才允许一键倍速匹配（偏短方向不受限，钳到 1/1.3 后余量走留白）
    tempo_available: plan.gapRatio <= 0.3 + 1e-9,
    limits: { min_tempo: MIN_TEMPO, max_tempo: MAX_TEMPO, max_pad_seconds: MAX_PAD_SECONDS },
  }
}

/**
 * 保存本镜匹配参数。越界直接拒绝（不静默钳值），阻断时抛 ComposeBlockedError
 * 由路由渲染成结构化错误体。
 */
export async function saveNarrationFit(
  storyboardId: number,
  body: Record<string, unknown>,
): Promise<NarrationFitPreview> {
  const { sb, ep, dv, da, t } = await measure(storyboardId)

  // 枚举值一律显式校验：静默回落会让前端/脚本的拼写错误变成「保存成功但行为不同」
  if (body.mode !== 'pad' && body.mode !== 'tempo') {
    throw new Error('mode 只支持 pad / tempo')
  }
  const record: NarrationFitRecord = { mode: body.mode }
  if (body.pad_ms !== undefined && body.pad_ms !== null) {
    const padMs = Number(body.pad_ms)
    if (!Number.isFinite(padMs)) throw new Error('pad_ms 必须是数字（毫秒）')
    record.pad_ms = padMs
  }
  if (body.pad_position !== undefined && body.pad_position !== null) {
    if (body.pad_position !== 'head' && body.pad_position !== 'tail') {
      throw new Error('pad_position 只支持 head / tail')
    }
    record.pad_position = body.pad_position
  }
  if (body.tempo_override !== undefined && body.tempo_override !== null && body.tempo_override !== '') {
    const tempo = Number(body.tempo_override)
    if (!Number.isFinite(tempo)) throw new Error('tempo_override 必须是数字')
    record.tempo_override = tempo
  }
  if (body.audio_mix_mode !== undefined && body.audio_mix_mode !== null) {
    if (body.audio_mix_mode !== 'mix' && body.audio_mix_mode !== 'replace') {
      throw new Error('audio_mix_mode 只支持 replace / mix')
    }
    record.audio_mix_mode = body.audio_mix_mode
  }

  const error = validateFitRecord(record)
  if (error) throw new Error(error)

  // 用当时的实测时长预检：差距 >30% 的倍速模式、放不下的旁白一律拒绝保存
  const availSeconds = Math.max(0, Math.min(dv, 15) - t)
  const fit = resolveComposeFit({
    episodeDefault: ep.narrationFitDefault,
    shotFit: JSON.stringify(record),
    episodeMixMode: ep.audioMixMode,
    episodeBedGainDb: ep.audioBedGainDb,
    da,
    availSeconds,
  })
  const plan = planCompose({ dv, da, t, fit })
  if (plan.blocked) throw new ComposeBlockedError(plan, sb.storyboardNumber)

  record.updated_at = now()
  await db.update(schema.storyboards)
    .set({ narrationFit: JSON.stringify(record), updatedAt: now() })
    .where(eq(schema.storyboards.id, storyboardId))

  return previewNarrationFit(storyboardId)
}

/** 清除本镜的匹配参数覆盖，回到继承剧集默认 */
export async function clearNarrationFit(storyboardId: number): Promise<NarrationFitPreview> {
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  if (!sb) throw new Error('镜头不存在')
  await db.update(schema.storyboards)
    .set({ narrationFit: null, updatedAt: now() })
    .where(eq(schema.storyboards.id, storyboardId))
  return previewNarrationFit(storyboardId)
}
