/**
 * 分镜拆解 Agent 工具
 * 模块级单例 — episodeId + dramaId 通过 RequestContext 按请求注入
 */
import { createTool } from '@mastra/core/tools'
import type { ToolExecutionContext } from '@mastra/core/tools'
import { z } from 'zod'
import { db, getInsertId, schema } from '../../db/index.js'
import { eq } from 'drizzle-orm'
import { now } from '../../utils/response.js'
import { logTaskProgress, logTaskSuccess } from '../../utils/task-logger.js'
import { getDramaId, getEpisodeId, getResearchRunId, getStoryboardId } from '../context.js'
import { loadEpisodeKeyframes } from '../../services/keyframes.js'
import {
  PROMPT_FIELDS,
  applyExplicitBindings,
  deletePoolSelections,
  deleteTargetBindings,
  syncStoryboardBindingsFromPrompts,
} from '../../services/storyboard-assets.js'
import { parseReferenceImages, referenceImagePaths } from '../../services/reference-images.js'
import { stampFieldSavedAt } from '../../services/storyboard-fields.js'
import { MAX_NARRATION_CHARS, narrationCharCount, parseNarrationMeta, sha256 } from '../../services/narration.js'
import { locateNarrationInScript, narrationCoverage, scriptMatchKey } from '../../services/narration-first.js'

async function getEpisodeSceneIds(episodeId: number) {
  const links = await db.select().from(schema.episodeScenes)
    .where(eq(schema.episodeScenes.episodeId, episodeId))
  return new Set(links.map(link => link.sceneId))
}

async function getEpisodeCharacterIds(episodeId: number) {
  const links = await db.select().from(schema.episodeCharacters)
    .where(eq(schema.episodeCharacters.episodeId, episodeId))
  return new Set(links.map(link => link.characterId))
}

async function getEpisodePropIds(episodeId: number) {
  const links = await db.select().from(schema.episodeProps)
    .where(eq(schema.episodeProps.episodeId, episodeId))
  return new Set(links.map(link => link.propId))
}

async function validateStoryboardBindings(episodeId: number, dramaId: number, sceneId: number | null | undefined, characterIds: number[] | undefined, propIds?: number[] | undefined) {
  const episodeSceneIds = await getEpisodeSceneIds(episodeId)
  const episodeCharacterIds = await getEpisodeCharacterIds(episodeId)
  const episodePropIds = await getEpisodePropIds(episodeId)

  // 场景/角色/道具属于本剧但尚未关联到当前集时，自动补关联（拆分时即完成绑定）
  if (sceneId != null && !episodeSceneIds.has(sceneId)) {
    const [scene] = await db.select().from(schema.scenes).where(eq(schema.scenes.id, sceneId))
    if (!scene || scene.dramaId !== dramaId || scene.deletedAt) {
      throw new Error(`scene_id ${sceneId} 不属于当前项目`)
    }
    await db.insert(schema.episodeScenes).values({ episodeId, sceneId, createdAt: now() })
  }

  const uniqueCharacterIds = [...new Set((characterIds || []).filter(Boolean))]
  for (const characterId of uniqueCharacterIds) {
    if (episodeCharacterIds.has(characterId)) continue
    const [character] = await db.select().from(schema.characters).where(eq(schema.characters.id, characterId))
    if (!character || character.dramaId !== dramaId || character.deletedAt) {
      throw new Error(`character_id ${characterId} 不属于当前项目`)
    }
    await db.insert(schema.episodeCharacters).values({ episodeId, characterId, createdAt: now() })
  }

  const uniquePropIds = [...new Set((propIds || []).filter(Boolean))]
  for (const propId of uniquePropIds) {
    if (episodePropIds.has(propId)) continue
    const [prop] = await db.select().from(schema.props).where(eq(schema.props.id, propId))
    if (!prop || prop.dramaId !== dramaId || prop.deletedAt) {
      throw new Error(`prop_id ${propId} 不属于当前项目`)
    }
    await db.insert(schema.episodeProps).values({ episodeId, propId, createdAt: now() })
  }
}

type ToolContext = ToolExecutionContext | undefined

function requireIds(context: ToolContext): { episodeId: number; dramaId: number } | { error: string } {
  const episodeId = getEpisodeId(context?.requestContext)
  const dramaId = getDramaId(context?.requestContext)
  if (!episodeId || !dramaId) return { error: 'Missing episodeId/dramaId in request context' }
  return { episodeId, dramaId }
}

const readStoryboardContext = createTool({
  id: 'read_storyboard_context',
  description: 'Read the screenplay, characters, scenes, and props for storyboard breakdown.',
  inputSchema: z.object({}),
  execute: async (_input, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const { episodeId, dramaId } = ids
    const [ep] = await db.select().from(schema.episodes)
      .where(eq(schema.episodes.id, episodeId))
    if (!ep) return { error: 'Episode not found' }
    const script = ep.scriptContent || ep.content
    if (!script) return { error: 'Episode has no script' }

    const charLinks = await db.select().from(schema.episodeCharacters)
      .where(eq(schema.episodeCharacters.episodeId, episodeId))
    const sceneLinks = await db.select().from(schema.episodeScenes)
      .where(eq(schema.episodeScenes.episodeId, episodeId))
    const propLinks = await db.select().from(schema.episodeProps)
      .where(eq(schema.episodeProps.episodeId, episodeId))

    const linkedCharacterIds = new Set(charLinks.map(link => link.characterId))
    const linkedSceneIds = new Set(sceneLinks.map(link => link.sceneId))
    const linkedPropIds = new Set(propLinks.map(link => link.propId))

    const chars = await db.select().from(schema.characters)
      .where(eq(schema.characters.dramaId, dramaId))
    const scns = await db.select().from(schema.scenes)
      .where(eq(schema.scenes.dramaId, dramaId))
    const prps = await db.select().from(schema.props)
      .where(eq(schema.props.dramaId, dramaId))
    const existingStoryboards = await db.select().from(schema.storyboards)
      .where(eq(schema.storyboards.episodeId, episodeId))

    const characters = chars
      .filter(c => !c.deletedAt)
      .filter(c => !linkedCharacterIds.size || linkedCharacterIds.has(c.id))
      .map(c => ({
        id: c.id,
        name: c.name,
        role: c.role || '',
        description: c.description || '',
        appearance: c.appearance || '',
        styling: c.styling || '',
        image_url: c.imageUrl || '',
        // 参考图现在存 [{path, uploaded_at}]，给 LLM 的上下文只要路径
        reference_images: referenceImagePaths(parseReferenceImages(c.referenceImages)),
      }))

    const scenes = scns
      .filter(s => !s.deletedAt)
      .filter(s => !linkedSceneIds.size || linkedSceneIds.has(s.id))
      .map(s => ({
        id: s.id,
        location: s.location,
        time: s.time,
        prompt: s.prompt || '',
        lighting: s.lighting || '',
        image_url: s.imageUrl || '',
        storyboard_count: s.storyboardCount || 0,
      }))

    const props = prps
      .filter(p => !p.deletedAt)
      .filter(p => !linkedPropIds.size || linkedPropIds.has(p.id))
      .map(p => ({
        id: p.id,
        name: p.name,
        type: p.type || '',
        description: p.description || '',
        image_url: p.imageUrl || '',
      }))

    /**
     * 背景信息载体（Issue #47）：旁白提到但本集不出场的实体（组织/异地人物/异地事件），
     * 仍然按角色/场景/道具三类落库，这里**单列一份**，让分镜与表达设计知道
     * 「S13 要同时表达近卫团与彼得一世」时有哪些现成的视觉载体可以 @。
     * 它们同时留在上面的 characters/scenes/props 里，不改变既有字段语义。
     */
    const expositionAssets = [
      ...characters.filter(item => chars.find(c => c.id === item.id && Number(c.exposition) === 1))
        .map(item => ({ kind: 'character' as const, id: item.id, name: item.name, note: item.role, image_url: item.image_url })),
      ...scenes.filter(item => scns.find(s => s.id === item.id && Number(s.exposition) === 1))
        .map(item => ({ kind: 'scene' as const, id: item.id, name: item.location, note: item.prompt, image_url: item.image_url })),
      ...props.filter(item => prps.find(p => p.id === item.id && Number(p.exposition) === 1))
        .map(item => ({ kind: 'prop' as const, id: item.id, name: item.name, note: item.type, image_url: item.image_url })),
    ]

    // 关键帧状态：inherits_first 表示该分镜首帧承接上一分镜的尾关键帧（continue 边界且自身未选首帧）
    const keyframeMap = await loadEpisodeKeyframes(episodeId)
    const aliveStoryboards = existingStoryboards
      .filter(sb => !sb.deletedAt)
      .sort((a, b) => a.storyboardNumber - b.storyboardNumber)
    const byId = new Map(aliveStoryboards.map(sb => [sb.id, sb]))

    const existingStoryboardPayload = await Promise.all(aliveStoryboards
      .map(async (sb) => {
        const links = await db.select().from(schema.storyboardCharacters)
          .where(eq(schema.storyboardCharacters.storyboardId, sb.id))
        const sbPropLinks = await db.select().from(schema.storyboardProps)
          .where(eq(schema.storyboardProps.storyboardId, sb.id))
        const kf = keyframeMap.get(sb.id)
        const prev = kf?.previousId ? byId.get(kf.previousId) : undefined
        return {
          id: sb.id,
          shot_number: sb.storyboardNumber,
          title: sb.title || '',
          scene_id: sb.sceneId,
          character_ids: links.map(link => link.characterId),
          prop_ids: sbPropLinks.map(link => link.propId),
          shot_type: sb.shotType || '',
          duration: sb.duration || 0,
          description: sb.description || '',
          result: sb.result || '',
          atmosphere: sb.atmosphere || '',
          video_prompt: sb.videoPrompt || '',
          continuity_boundary: sb.continuityBoundary || null,
          first_frame_prompt: sb.firstFramePrompt || '',
          mid_frame_prompt: sb.midFramePrompt || '',
          mid_frame_time: sb.midFrameTime ?? null,
          last_frame_prompt: sb.lastFramePrompt || '',
          inherits_first: kf?.inheritsFirst === true,
          previous_last_frame_prompt: prev?.lastFramePrompt || '',
          previous_result: prev?.result || '',
        }
      }))

    const payload = {
      episode: {
        id: ep.id,
        title: ep.title,
        episode_number: ep.episodeNumber,
        description: ep.description || '',
      },
      script,
      characters,
      scenes,
      props,
      exposition_assets: expositionAssets,
      existing_storyboards: existingStoryboardPayload,
    }
    logTaskSuccess('StoryboardTool', 'read-context', {
      episodeId,
      dramaId,
      characters: characters.length,
      scenes: scenes.length,
      props: props.length,
      expositionAssets: expositionAssets.length,
      existingStoryboards: payload.existing_storyboards.length,
      scriptLength: script.length,
    })
    return payload
  },
})

const storyboardFields = z.object({
  shot_number: z.number(),
  title: z.string().optional(),
  shot_type: z.string().optional(),
  angle: z.string().optional(),
  movement: z.string().optional(),
  location: z.string().optional(),
  time: z.string().optional(),
  description: z.string().optional(),
  result: z.string().optional(),
  atmosphere: z.string().optional(),
  first_frame_prompt: z.string().optional().describe("Keyframe prompt for the FIRST still frame of this segment (opening moment of 【镜头1】). Self-contained: scene, who is in frame, pose, framing, lighting. Reference characters only by @名字 — never describe species, clothing, colours, hairstyle or any appearance attribute. Leave empty when continuity is 'continue' (the first frame is inherited from the previous segment's last keyframe)."),
  mid_frame_prompt: z.string().optional().describe("Keyframe prompt for an optional MID still frame, describing the opening moment of the chosen sub-shot at mid_frame_time. Same self-contained and @名字-only rules. Omit when the segment has only one sub-shot."),
  mid_frame_time: z.number().optional().describe("Time in SECONDS from the start of this segment for the mid keyframe. Must be the start time of a sub-shot 【镜头N】 other than the first one, and must fall inside the segment (strictly between 0.5s and duration-0.5s). Omit for single-sub-shot segments or when mid_frame_prompt is omitted."),
  last_frame_prompt: z.string().optional().describe("Keyframe prompt for the LAST still frame of this segment, matching `result`. Same self-contained and @名字-only rules. Must be a stable, readable frame because the next segment may inherit it as its first frame."),
  video_prompt: z.string().optional(),
  bgm_prompt: z.string().optional(),
  sound_effect: z.string().optional(),
  duration: z.number().optional(),
  scene_id: z.number().nullable().optional(),
  character_ids: z.array(z.number()).optional(),
  prop_ids: z.array(z.number()).optional(),
  continuity: z.enum(['continue', 'cut']).optional().describe("Transition from the previous shot: 'continue' means this shot starts exactly where the previous shot ended (same scene, immediately following moment, characters carried over) and this shot inherits the previous shot's LAST keyframe image as its own first keyframe, so first_frame_prompt must be left empty; 'cut' means a hard cut (scene change, time jump, flashback, or the first shot of the episode) and needs its own first_frame_prompt. Omit when unsure."),
})

/** 纪录片项目（Issue #45）：多一个 narration_text 字段，内容必须逐字取自剧本正文 */
const documentaryStoryboardFields = storyboardFields.extend({
  narration_text: z.string().optional().describe(`Narration for this shot, copied VERBATIM from a consecutive stretch of the episode script (this project's script IS the narration script). Never rewrite, shorten, merge or invent text: the tool checks that the whitespace-stripped text occurs literally in the script and rejects anything else. Cut only at sentence boundaries, at most ${MAX_NARRATION_CHARS} spoken characters per shot. Leave it out for a deliberately silent visual shot.`),
})

/** 已经执行过整集清空的运行 id（纪录片变体）：同一次运行的后续批次不再清空 */
const replacedRuns = new Set<string>()

/** drama 与 documentary 两个变体：drama 变体的 schema / description / 行为与 #45 之前逐字一致 */
function buildSaveStoryboards(documentary: boolean) {
  return createTool({
  id: 'save_storyboards',
  description: documentary
    ? 'Save storyboards for this episode. Call in batches of at most 8 storyboards: the first batch must set replace_existing: true (clears all old storyboards for the episode, then writes), every following batch omits replace_existing (appends). Rows are upserted by shot_number, so overlapping batches and retries never create duplicates. This is a documentary project: every shot also carries narration_text copied verbatim from the script, in script order, and the result reports how much of the script is still uncovered.'
    : 'Save storyboards for this episode. Call in batches of at most 8 storyboards: the first batch must set replace_existing: true (clears all old storyboards for the episode, then writes), every following batch omits replace_existing (appends). Rows are upserted by shot_number, so overlapping batches and retries never create duplicates.',
  inputSchema: z.object({
    replace_existing: z.boolean().optional(),
    storyboards: z.array(documentary ? documentaryStoryboardFields : storyboardFields),
  }),
  execute: async ({ storyboards, replace_existing }, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const { episodeId, dramaId } = ids
    const ts = now()
    logTaskProgress('StoryboardTool', 'save-begin', {
      episodeId,
      dramaId,
      replaceExisting: replace_existing === true,
      count: storyboards.length,
      shotNumbers: storyboards.map(sb => sb.shot_number).join(','),
    })
    // 纪录片（Issue #45）：一次运行只允许第一批清空。模型在后续批次重复传 replace_existing
    // 会把前面已切好的镜头连同旁白一起删掉，整集覆盖就断了（实测 GLM 第二批重复传过）。
    const runId = documentary ? getResearchRunId(context?.requestContext) : null
    const replaceIgnored = replace_existing === true && runId !== null && replacedRuns.has(runId)
    if (replace_existing === true && !replaceIgnored) {
      const existingStoryboardRows = await db.select().from(schema.storyboards)
        .where(eq(schema.storyboards.episodeId, episodeId))
      for (const storyboardId of existingStoryboardRows.map(sb => sb.id)) {
        await deleteTargetBindings({ storyboardId })
        await deletePoolSelections({ storyboardId })
      }
      await db.delete(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId))
      if (runId) {
        // 运行 id 唯一且只增，集合按容量截断（长期运行的进程不无限增长）
        if (replacedRuns.size > 500) replacedRuns.clear()
        replacedRuns.add(runId)
      }
    }

    // shot_number → id 索引（含本次调用内新增的行），保证按分镜号幂等 upsert
    const existingRows = await db.select().from(schema.storyboards)
      .where(eq(schema.storyboards.episodeId, episodeId))
    const shotToId = new Map<number, number>(
      existingRows.filter(sb => !sb.deletedAt).map(sb => [sb.storyboardNumber, sb.id]),
    )

    // narration-first（Issue #45）：剧本正文就是旁白稿，逐镜核对「这段话确实出自剧本」
    const [episodeRow] = documentary
      ? await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
      : [undefined]
    const scriptKey = documentary ? scriptMatchKey(episodeRow?.scriptContent || episodeRow?.content) : ''
    const batchShots = new Set(storyboards.map(sb => sb.shot_number))
    // 游标从「本批之前的镜头已取用到哪里」起算，保证分批保存时顺序仍然成立
    let scriptCursor = documentary
      ? narrationCoverage(scriptKey, existingRows
        .filter(sb => !sb.deletedAt && sb.storyboardNumber < Math.min(...batchShots) && !batchShots.has(sb.storyboardNumber))
        .sort((a, b) => a.storyboardNumber - b.storyboardNumber)
        .map(sb => sb.narrationText)).cursor
      : 0
    const narrationRejected: { shot_number: number; reason: string }[] = []

    for (const sb of storyboards) {
      await validateStoryboardBindings(episodeId, dramaId, sb.scene_id, sb.character_ids, sb.prop_ids)
      const existingId = shotToId.get(sb.shot_number)
      if (existingId !== undefined) {
        await db.update(schema.storyboards).set({
          title: sb.title, shotType: sb.shot_type,
          angle: sb.angle, movement: sb.movement,
          location: sb.location, time: sb.time,
          description: sb.description, result: sb.result,
          atmosphere: sb.atmosphere,
          firstFramePrompt: sb.first_frame_prompt,
          midFramePrompt: sb.mid_frame_prompt,
          midFrameTime: sb.mid_frame_time,
          lastFramePrompt: sb.last_frame_prompt,
          videoPrompt: sb.video_prompt, bgmPrompt: sb.bgm_prompt,
          soundEffect: sb.sound_effect,
          sceneId: sb.scene_id, duration: sb.duration || 10,
          continuityBoundary: sb.continuity,
          updatedAt: ts,
        }).where(eq(schema.storyboards.id, existingId))
        // 拆镜显式传入的绑定 = 手选；提示词里的 @ 另由 syncStoryboardBindingsFromPrompts 自动进池
        await applyExplicitBindings(existingId, {
          characterIds: sb.character_ids || [],
          propIds: sb.prop_ids || [],
          sceneId: sb.scene_id ?? null,
        })
      } else {
        const res = await db.insert(schema.storyboards).values({
          episodeId,
          storyboardNumber: sb.shot_number,
          title: sb.title, shotType: sb.shot_type,
          angle: sb.angle, movement: sb.movement,
          location: sb.location, time: sb.time,
          description: sb.description, result: sb.result,
          atmosphere: sb.atmosphere,
          firstFramePrompt: sb.first_frame_prompt,
          midFramePrompt: sb.mid_frame_prompt,
          midFrameTime: sb.mid_frame_time,
          lastFramePrompt: sb.last_frame_prompt,
          videoPrompt: sb.video_prompt, bgmPrompt: sb.bgm_prompt,
          soundEffect: sb.sound_effect,
          continuityBoundary: sb.continuity,
          sceneId: sb.scene_id, duration: sb.duration || 10,
          createdAt: ts, updatedAt: ts,
        })
        const newId = getInsertId(res)
        shotToId.set(sb.shot_number, newId)
        await applyExplicitBindings(newId, {
          characterIds: sb.character_ids || [],
          propIds: sb.prop_ids || [],
          sceneId: sb.scene_id ?? null,
        })
      }
      // 关键帧/视频提示词写入后：打字段保存时间 + 绑定跟随 @引用（LLM 不必自己传 ids）
      const savedId = existingId ?? shotToId.get(sb.shot_number)!
      const writtenFields = Object.entries(sb).filter(([, value]) => value !== undefined).map(([key]) => key)
      const [savedRow] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, savedId))
      const stamp = stampFieldSavedAt(savedRow?.fieldSavedAt, writtenFields)
      if (stamp.json) {
        await db.update(schema.storyboards).set({ fieldSavedAt: stamp.json })
          .where(eq(schema.storyboards.id, savedId))
      }
      await syncStoryboardBindingsFromPrompts(savedId, writtenFields)
      // narration-first：逐字取自剧本才写库；改写过的文本不写旁白字段，画面字段照常保存
      if (documentary && 'narration_text' in sb) {
        const text = typeof sb.narration_text === 'string' ? sb.narration_text.trim() : ''
        const chars = narrationCharCount(text)
        const found = text ? locateNarrationInScript(scriptKey, text, scriptCursor) : { index: -1, chars: 0 }
        if (!text) {
          // 刻意留白的纯画面镜头：关掉该镜旁白
          await db.update(schema.storyboards)
            .set({ narrationText: '', narrationEnabled: false, updatedAt: ts })
            .where(eq(schema.storyboards.id, savedId))
        } else if (chars > MAX_NARRATION_CHARS) {
          narrationRejected.push({ shot_number: sb.shot_number, reason: `narration is ${chars} characters, exceeding the per-shot limit of ${MAX_NARRATION_CHARS}; split the script passage at a sentence boundary into two shots` })
        } else if (found.index < 0) {
          narrationRejected.push({ shot_number: sb.shot_number, reason: 'narration is not a verbatim stretch of the episode script; copy the script text exactly (whitespace aside) instead of rewriting it' })
        } else {
          scriptCursor = Math.max(scriptCursor, found.index + found.chars)
          const meta = parseNarrationMeta(savedRow?.narrationMeta)
          meta.text_sha256 = sha256(text)
          const narrationStamp = stampFieldSavedAt(savedRow?.fieldSavedAt, ['narration_text'])
          await db.update(schema.storyboards).set({
            narrationText: text,
            narrationEnabled: true,
            narrationMeta: JSON.stringify(meta),
            ...(narrationStamp.json ? { fieldSavedAt: narrationStamp.json } : {}),
            updatedAt: ts,
          }).where(eq(schema.storyboards.id, savedId))
        }
      }
    }

    // 整集时长 = 当前全部存活分镜时长之和（分批保存时不能再按单批累加）
    const allRows = await db.select().from(schema.storyboards)
      .where(eq(schema.storyboards.episodeId, episodeId))
    const totalDuration = allRows
      .filter(sb => !sb.deletedAt)
      .reduce((sum, sb) => sum + (sb.duration || 0), 0)

    await db.update(schema.episodes)
      .set({ duration: Math.ceil(totalDuration / 60), updatedAt: ts })
      .where(eq(schema.episodes.id, episodeId))

    logTaskSuccess('StoryboardTool', 'save-complete', {
      episodeId,
      count: storyboards.length,
      totalDuration,
    })
    if (!documentary) {
      return { message: `Saved ${storyboards.length} storyboards`, count: storyboards.length, total_duration: totalDuration }
    }
    // 纪录片：回报剧本覆盖进度，模型据此继续切下一段（全部切完时 covered_chars = script_chars）
    const coverage = narrationCoverage(scriptKey, allRows
      .filter(sb => !sb.deletedAt)
      .sort((a, b) => a.storyboardNumber - b.storyboardNumber)
      .map(sb => sb.narrationText))
    return {
      message: `Saved ${storyboards.length} storyboards`,
      count: storyboards.length,
      total_duration: totalDuration,
      narration_rejected: narrationRejected,
      replace_existing_ignored: replaceIgnored,
      script_coverage: coverage,
    }
  },
  })
}

export const saveStoryboards = buildSaveStoryboards(false)
const saveDocumentaryStoryboards = buildSaveStoryboards(true)

const storyboardUpdateSchema = z.object({
    storyboard_id: z.number(),
    title: z.string().optional(),
    shot_type: z.string().optional(),
    angle: z.string().optional(),
    movement: z.string().optional(),
    location: z.string().optional(),
    time: z.string().optional(),
    result: z.string().optional(),
    atmosphere: z.string().optional(),
    first_frame_prompt: z.string().optional().describe("Keyframe prompt for the FIRST still frame of this segment (opening moment of 【镜头1】). Self-contained: scene, who is in frame, pose, framing, lighting. Reference characters only by @名字 — never describe species, clothing, colours, hairstyle or any appearance attribute. Leave empty when continuity is 'continue'."),
    mid_frame_prompt: z.string().optional().describe("Keyframe prompt for an optional MID still frame, describing the opening moment of the chosen sub-shot at mid_frame_time. Same self-contained and @名字-only rules. Omit when the segment has only one sub-shot."),
    mid_frame_time: z.number().optional().describe("Time in SECONDS from the start of this segment for the mid keyframe. Must be the start time of a sub-shot 【镜头N】 other than the first one, and must fall strictly between 0.5s and duration-0.5s. Omit for single-sub-shot segments."),
    last_frame_prompt: z.string().optional().describe("Keyframe prompt for the LAST still frame of this segment, matching `result`. Same self-contained and @名字-only rules. Must be a stable, readable frame because the next segment may inherit it as its first frame."),
    video_prompt: z.string().optional(),
    bgm_prompt: z.string().optional(),
    sound_effect: z.string().optional(),
    description: z.string().optional(),
    scene_id: z.number().nullable().optional(),
    character_ids: z.array(z.number()).optional(),
    prop_ids: z.array(z.number()).optional(),
    duration: z.number().optional(),
    continuity: z.enum(['continue', 'cut']).optional().describe("Transition from the previous shot: 'continue' means this shot starts exactly where the previous shot ended and inherits the previous shot's LAST keyframe image as its first keyframe (first_frame_prompt stays empty); 'cut' means a hard cut and needs its own first_frame_prompt."),
})
const updateStoryboard = createTool({
  id: 'update_storyboard',
  description: 'Update a specific storyboard shot.',
  inputSchema: storyboardUpdateSchema,
  execute: async ({ storyboard_id, ...fields }, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const { episodeId, dramaId } = ids
    const [storyboard] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboard_id))
    if (!storyboard) return { error: `Storyboard ${storyboard_id} not found` }

    // 过滤模型回传的垃圾值：视频提示词 Agent 常把整行字段回传，
    // 拿不准的字符串字段写成 "null"/"undefined"，直接覆盖会毁掉已有内容
    for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
      const v = fields[key]
      if (typeof v === 'string' && (v === 'null' || v === 'undefined' || v === 'NULL' || v === 'Null')) {
        delete fields[key]
      }
    }

    logTaskProgress('StoryboardTool', 'update-begin', {
      episodeId,
      storyboardId: storyboard_id,
      fields: Object.keys(fields),
    })

    const currentCharacterIds = 'character_ids' in fields
      ? fields.character_ids
      : (await db.select().from(schema.storyboardCharacters)
          .where(eq(schema.storyboardCharacters.storyboardId, storyboard_id)))
          .map(link => link.characterId)

    const currentPropIds = 'prop_ids' in fields
      ? fields.prop_ids
      : (await db.select().from(schema.storyboardProps)
          .where(eq(schema.storyboardProps.storyboardId, storyboard_id)))
          .map(link => link.propId)

    await validateStoryboardBindings(
      episodeId,
      dramaId,
      'scene_id' in fields ? fields.scene_id : storyboard.sceneId,
      currentCharacterIds,
      currentPropIds,
    )

    const updates: Record<string, any> = { updatedAt: now() }
    if ('title' in fields) updates.title = fields.title
    if ('shot_type' in fields) updates.shotType = fields.shot_type
    if ('angle' in fields) updates.angle = fields.angle
    if ('movement' in fields) updates.movement = fields.movement
    if ('location' in fields) updates.location = fields.location
    if ('time' in fields) updates.time = fields.time
    if ('result' in fields) updates.result = fields.result
    if ('atmosphere' in fields) updates.atmosphere = fields.atmosphere
    if ('first_frame_prompt' in fields) updates.firstFramePrompt = fields.first_frame_prompt
    if ('mid_frame_prompt' in fields) updates.midFramePrompt = fields.mid_frame_prompt
    if ('mid_frame_time' in fields) updates.midFrameTime = fields.mid_frame_time
    if ('last_frame_prompt' in fields) updates.lastFramePrompt = fields.last_frame_prompt
    if ('video_prompt' in fields) updates.videoPrompt = fields.video_prompt
    if ('bgm_prompt' in fields) updates.bgmPrompt = fields.bgm_prompt
    if ('sound_effect' in fields) updates.soundEffect = fields.sound_effect
    if ('description' in fields) updates.description = fields.description
    if ('scene_id' in fields) updates.sceneId = fields.scene_id
    if ('continuity' in fields) updates.continuityBoundary = fields.continuity
    if ('duration' in fields) updates.duration = fields.duration
    const stamp = stampFieldSavedAt(storyboard.fieldSavedAt, Object.keys(fields))
    if (stamp.json) updates.fieldSavedAt = stamp.json
    await db.update(schema.storyboards).set(updates).where(eq(schema.storyboards.id, storyboard_id))
    if ('character_ids' in fields || 'prop_ids' in fields || ('scene_id' in fields && fields.scene_id != null)) {
      // 显式传入的绑定 = 手选（Issue #43）；只替换传入类别，主场景只增不减
      await applyExplicitBindings(storyboard_id, {
        characterIds: 'character_ids' in fields ? fields.character_ids || [] : undefined,
        propIds: 'prop_ids' in fields ? fields.prop_ids || [] : undefined,
        sceneId: 'scene_id' in fields ? fields.scene_id ?? null : null,
      })
    }
    // 提示词被写入时：有效池 = 手选 ∪ 5 个提示词的 @，写入的目标按各自 @ 重算
    if (PROMPT_FIELDS.some(field => field in fields)) {
      await syncStoryboardBindingsFromPrompts(storyboard_id, Object.keys(fields))
    }
    logTaskSuccess('StoryboardTool', 'update-complete', {
      episodeId,
      storyboardId: storyboard_id,
      updatedFields: Object.keys(updates),
      characterIds: 'character_ids' in fields ? (fields.character_ids || []).join(',') : undefined,
      propIds: 'prop_ids' in fields ? (fields.prop_ids || []).join(',') : undefined,
    })
    return { message: `Storyboard ${storyboard_id} updated` }
  },
})

export const storyboardTools = { readStoryboardContext, saveStoryboards, updateStoryboard }
/** 纪录片项目（Issue #45）：save_storyboards 换成带 narration_text 校验的变体，其余工具相同 */
export const documentaryStoryboardTools = { readStoryboardContext, saveStoryboards: saveDocumentaryStoryboards, updateStoryboard }

const promptSchema = storyboardUpdateSchema.pick({
  storyboard_id: true,
  first_frame_prompt: true,
  mid_frame_prompt: true,
  mid_frame_time: true,
  last_frame_prompt: true,
  video_prompt: true,
})
const videoPromptSchema = promptSchema.pick({ storyboard_id: true, video_prompt: true })
const keyframePromptSchema = promptSchema.omit({ video_prompt: true })

function promptUpdater(inputSchema: typeof promptSchema | typeof videoPromptSchema | typeof keyframePromptSchema) {
  return createTool({
    id: 'update_storyboard',
    description: 'Save only the requested storyboard prompts. Other storyboard fields are never writable with this tool.',
    inputSchema,
    execute: async (input, context) => {
      const ids = requireIds(context)
      if ('error' in ids) return ids
      const expectedId = getStoryboardId(context?.requestContext)
      if (expectedId !== null && input.storyboard_id !== expectedId) {
        return { error: `Only storyboard ${expectedId} may be updated in this request` }
      }
      const [row] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, input.storyboard_id))
      if (!row || row.deletedAt || row.episodeId !== ids.episodeId) {
        return { error: 'Storyboard does not belong to the current episode' }
      }
      // 再按可信上下文收窄，直接调用 execute 也不能绕过模型侧 schema。
      const scope = context?.requestContext?.get('storyboardPromptScope' as never)
      const allowed = scope === 'video' ? videoPromptSchema : scope === 'keyframes' ? keyframePromptSchema : inputSchema
      const safe = allowed.parse(input)
      if (!Object.keys(safe).some(key => key !== 'storyboard_id')) return { error: 'No permitted prompt fields supplied' }
      const ignored = Object.keys(input).filter(key => !(key in safe))
      const result = await updateStoryboard.execute!(safe, context)
      return ignored.length && result && typeof result === 'object' ? { ...result, ignored_fields: ignored } : result
    },
  })
}

export const promptStoryboardUpdaters = {
  all: promptUpdater(promptSchema),
  video: promptUpdater(videoPromptSchema),
  keyframes: promptUpdater(keyframePromptSchema),
}
