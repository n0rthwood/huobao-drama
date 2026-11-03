/**
 * 旁白写作 Agent 工具（Issue #30）
 *
 * 旁白文本的唯一写入方。`save_narrations` 只写 narration_text / narration_enabled / duration
 * 三个字段，绝不触碰分镜的其它内容（画面描述、提示词、绑定一律不动）。
 */
import { createTool } from '@mastra/core/tools'
import type { ToolExecutionContext } from '@mastra/core/tools'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db, schema } from '../../db/index.js'
import { now } from '../../utils/response.js'
import { logTaskProgress, logTaskSuccess } from '../../utils/task-logger.js'
import { getEpisodeId, getNarrationShotNumbers } from '../context.js'
import { storyboardTools } from './storyboard-tools.js'
import {
  DEFAULT_TAIL_PAD_SECONDS,
  MAX_NARRATION_CHARS,
  MAX_SHOT_SECONDS,
  MIN_SHOT_SECONDS,
  NARRATION_CHARS_PER_SECOND,
  narrationCharCount,
  parseNarrationMeta,
  sha256,
} from '../../services/narration.js'
import { parseNarrationMarkup } from '../../services/narration-markup.js'
import { isMarkupOnlyEdit } from '../../services/narration-first.js'
import { stampFieldSavedAt } from '../../services/storyboard-fields.js'

/** drama 与 documentary 两个变体：drama 变体的 schema / description / 行为与 #45 之前逐字一致 */
function buildSaveNarrations(documentary: boolean) {
  return createTool({
  id: 'save_narrations',
  description: documentary
    ? 'Save the narration script for shots of this episode. Call in batches of at most 8 shots, upserted by shot_number. Only narration text / narration flag / duration are written — no other storyboard field is touched. This is a documentary project (narration-first): the shot narration already comes verbatim from the episode script, so you may ONLY add pronunciation markers — with the markers stripped the text must still be identical to the stored narration, otherwise the shot is rejected.'
    : 'Save the narration script for shots of this episode. Call in batches of at most 8 shots, upserted by shot_number. Only narration text / narration flag / duration are written — no other storyboard field is touched.',
  inputSchema: z.object({
    narrations: z.array(z.object({
      shot_number: z.number().describe('Shot number of the storyboard in this episode.'),
      narration: z.string().describe(`Narration script for this shot, in the target content language. Must be at most ${MAX_NARRATION_CHARS} spoken characters (TTS hard limit per segment; pronunciation markers do not count) and should fit the shot duration at 3.8–5.1 characters per second. Pronunciation markers use [[原文|pinyin with tones 1-4]] or [[原文|same-length homophone characters]].`),
      narration_enabled: z.boolean().optional().describe('false means this shot is deliberately left as pure visuals with no narration; narration must then be an empty string.'),
    })),
  }),
  execute: async ({ narrations }, context: ToolExecutionContext | undefined) => {
    const episodeId = getEpisodeId(context?.requestContext)
    if (!episodeId) return { error: 'Missing episode context' }
    const allowed = getNarrationShotNumbers(context?.requestContext)

    const rows = await db.select().from(schema.storyboards)
      .where(eq(schema.storyboards.episodeId, episodeId))
    const byShot = new Map(rows.filter(sb => !sb.deletedAt).map(sb => [sb.storyboardNumber, sb]))

    logTaskProgress('NarrationTool', 'save-begin', {
      episodeId,
      count: narrations.length,
      shotNumbers: narrations.map(n => n.shot_number).join(','),
    })

    const saved: number[] = []
    const rejected: { shot_number: number; reason: string }[] = []
    const ts = now()

    for (const item of narrations) {
      const sb = byShot.get(item.shot_number)
      if (!sb) {
        rejected.push({ shot_number: item.shot_number, reason: 'shot_number not found in this episode' })
        continue
      }
      // 分块/单镜运行只能写自己那一段（#35）：越界的镜头一律拒绝，防止并行的块互相覆盖
      if (allowed && !allowed.includes(item.shot_number)) {
        rejected.push({ shot_number: item.shot_number, reason: `out of scope for this run; only shots ${allowed.join(',')} may be written` })
        continue
      }
      const enabled = item.narration_enabled !== false
      const text = enabled ? (item.narration || '').trim() : ''
      const chars = narrationCharCount(text)
      if (enabled && !chars) {
        rejected.push({ shot_number: item.shot_number, reason: 'narration is empty; set narration_enabled=false for a pure-visual shot' })
        continue
      }
      if (chars > MAX_NARRATION_CHARS) {
        rejected.push({
          shot_number: item.shot_number,
          reason: `narration is ${chars} characters, exceeding the hard limit of ${MAX_NARRATION_CHARS}; shorten it and save again`,
        })
        continue
      }
      // 发音标记（#38）写错就退回，让模型按报错改正后重存
      const markupErrors = parseNarrationMarkup(text).errors
      if (markupErrors.length) {
        rejected.push({
          shot_number: item.shot_number,
          reason: `pronunciation marker error: ${markupErrors.map(e => e.message).join('; ')}. Use [[原文|pinyin with tones 1-4, one syllable per character]] or [[原文|homophone characters of the same length]]; fix and save again`,
        })
        continue
      }
      // narration-first（Issue #45）：纪录片项目的旁白只许注音，不许改字
      if (documentary && !isMarkupOnlyEdit(sb.narrationText, text)) {
        rejected.push({
          shot_number: item.shot_number,
          reason: 'this documentary project is narration-first: the shot narration is taken verbatim from the episode script and must not be rewritten. Re-send the stored narration unchanged, adding only [[原文|读音]] pronunciation markers',
        })
        continue
      }

      // 时长按旁白字数估算（内容段，不含转场）：字数 ÷ 4.5 字/秒 + 尾部留白，钳到 4–15 秒
      const duration = enabled
        ? Math.max(MIN_SHOT_SECONDS, Math.min(MAX_SHOT_SECONDS, Math.ceil(chars / NARRATION_CHARS_PER_SECOND + DEFAULT_TAIL_PAD_SECONDS)))
        : sb.duration || MIN_SHOT_SECONDS

      const meta = parseNarrationMeta(sb.narrationMeta)
      meta.text_sha256 = sha256(text)
      const stamp = stampFieldSavedAt(sb.fieldSavedAt, ['narration_text'])

      await db.update(schema.storyboards).set({
        narrationText: text,
        narrationEnabled: enabled,
        duration,
        narrationMeta: JSON.stringify(meta),
        ...(stamp.json ? { fieldSavedAt: stamp.json } : {}),
        updatedAt: ts,
      }).where(eq(schema.storyboards.id, sb.id))
      saved.push(item.shot_number)
    }

    logTaskSuccess('NarrationTool', 'save', {
      episodeId,
      saved: saved.length,
      rejected: rejected.length,
      shotNumbers: saved.join(','),
    })
    return { saved_shot_numbers: saved, rejected }
  },
  })
}

const saveNarrations = buildSaveNarrations(false)
const saveDocumentaryNarrations = buildSaveNarrations(true)

/**
 * 整集旁白主线（#35 阶段 A）。唯一写 episodes.narration_spine 的地方。
 * 主线只决定「每一段讲什么、承什么、留什么」，不写具体旁白句子。
 */
const saveNarrationSpine = createTool({
  id: 'save_narration_spine',
  description: 'Save the narration spine (through-line + per-chunk beats) for this episode. Call exactly once.',
  inputSchema: z.object({
    spine: z.string().describe('The whole-episode narration spine: the through-line in a few sentences, then one line per shot range describing what that stretch tells, what it picks up from the previous stretch and what it hands to the next one.'),
  }),
  execute: async ({ spine }, context: ToolExecutionContext | undefined) => {
    const episodeId = getEpisodeId(context?.requestContext)
    if (!episodeId) return { error: 'Missing episode context' }
    const text = (spine || '').trim()
    if (!text) return { error: 'spine is empty' }
    await db.update(schema.episodes)
      .set({ narrationSpine: text, updatedAt: now() })
      .where(eq(schema.episodes.id, episodeId))
    logTaskSuccess('NarrationTool', 'save-spine', { episodeId, chars: text.length })
    return { saved: true, chars: text.length }
  },
})

export const narrationTools = {
  readStoryboardContext: storyboardTools.readStoryboardContext,
  saveNarrations,
  saveNarrationSpine,
}

/** 纪录片项目（Issue #45）：save_narrations 换成只许注音的变体，其余工具相同 */
export const documentaryNarrationTools = {
  readStoryboardContext: storyboardTools.readStoryboardContext,
  saveNarrations: saveDocumentaryNarrations,
  saveNarrationSpine,
}
