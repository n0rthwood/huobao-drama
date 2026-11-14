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
import { getDramaId, getEpisodeId, getResearchRunId, getStoryboardId, isStoryboardFillGaps } from '../context.js'
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
import { describeNarrationGaps, fitNarrationToGaps, locateNarrationInScript, narrationCoverage, narrationMatchKey, scriptMatchKey, scriptParagraphs } from '../../services/narration-first.js'
import { layerTextSpecPayload, loadDesignCardContext, semanticEntries } from '../../services/design-card-context.js'
import { designCardWindow } from '../../services/design-card-window.js'
import { shotTtsValidity } from '../../services/narration-tts-gate.js'
import {
  COMBOS,
  INFO_POINT_VIAS,
  PLANNED_LAYER_TYPES,
  aiTextPlanRejections,
  lockedGenSlot,
  normalizeDesignCard,
  parseDesignCard,
  serializeDesignCard,
  storyboardCountCap,
  textPlanRejectionMessage,
  toCombo,
  toDesignCardStatus,
  validateDesignCard,
} from '../../services/design-card.js'
import { checkDesignCardGrounding, groundingRejectionMessage } from '../../services/design-card-grounding.js'
import { aspectConflictMessage, compositionOf, findAspectConflicts, normalizeAspect } from '../../services/aspect.js'
import { junctionPromptRejections, lockedFramesOfEpisode } from '../../services/junction-caption.js'

/** 项目画幅（Issue #92）：出图尺寸按它查表，提示词里的画幅/构图写法也必须与它一致 */
async function dramaAspectRatio(dramaId: number): Promise<string> {
  const [drama] = await db.select().from(schema.dramas).where(eq(schema.dramas.id, dramaId))
  return normalizeAspect(drama?.aspectRatio)
}

/** 关键帧提示词字段 → 退回信息；三条提示词都查，返回空数组表示放行 */
function aspectRejections(
  fields: { first_frame_prompt?: string; mid_frame_prompt?: string; last_frame_prompt?: string },
  aspect: string,
): string[] {
  const reasons: string[] = []
  for (const [field, text] of [
    ['first_frame_prompt', fields.first_frame_prompt],
    ['mid_frame_prompt', fields.mid_frame_prompt],
    ['last_frame_prompt', fields.last_frame_prompt],
  ] as const) {
    const conflicts = findAspectConflicts(text, aspect)
    if (conflicts.length) reasons.push(aspectConflictMessage(field, conflicts, aspect))
  }
  return reasons
}

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
  description: 'Read the screenplay, characters, scenes, props, existing storyboards, the project aspect and (for documentary design cards) the template text-box spec text_spec: layouts, roles and per-field capacity.',
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
        /** 证据素材（#47）：永不重绘，表达设计只能在它的语义标注里挑要显示的东西 */
        faithful: Number(p.faithful) === 1,
        /**
         * 语义标注摘要（#47 → #49）：**只有名称、稳定 id 与类别**，没有坐标。
         * `must_show` / `overlay_plan` 的 `semantic` 必须逐字取自这里；
         * 旁白里出现的地名/路线/范围在这张表里找不到，就说明这张图承载不了那句旁白。
         */
        semantics: semanticEntries(p.semantics),
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
    // 锁定衔接帧（Issue #95）：C 的首帧 = 图层段末帧、D 的尾帧 = 图层段首帧，这两个槽位
    // 不单独出图。没有这条事实，写视频提示词的模型会把 0 秒写成切镜、丢掉引导帧。
    const lockedFrames = await lockedFramesOfEpisode(episodeId)
    const aliveStoryboards = existingStoryboards
      .filter(sb => !sb.deletedAt)
      .sort((a, b) => a.storyboardNumber - b.storyboardNumber)
    const byId = new Map(aliveStoryboards.map(sb => [sb.id, sb]))
    // 设计卡逐镜填写（#102）：只给本镜 ± 前后各 3 镜，整集设计卡与提示词不再重复发送
    const targetId = context?.requestContext?.get('storyboardPromptScope' as never) === 'design_card'
      ? getStoryboardId(context?.requestContext)
      : null
    const window = targetId != null ? designCardWindow(aliveStoryboards.map(sb => sb.id), targetId) : null
    const windowIds = window ? new Set(window.ids) : null
    const contextStoryboards = windowIds ? aliveStoryboards.filter(sb => windowIds.has(sb.id)) : aliveStoryboards

    const existingStoryboardPayload = await Promise.all(contextStoryboards
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
          // 窗口模式（#102）逐镜给旁白：不必再从整集剧本里自己定位本镜与邻镜念的是哪一段
          ...(window ? { narration_text: sb.narrationText || '' } : {}),
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
          // 分镜设计卡（#57）：前后镜的设计卡让模型知道「上一镜已经让观众看到什么」，
          // 同一段落内的镜头才能共用底图与图层状态，而不是各写各的
          design_card: parseDesignCard(sb.designCard),
          combo: toCombo(sb.combo),
          // 只有 C/D 且已有图层段的镜头才有锁定槽位；`caption` = 视觉模型对实际衔接帧的描述
          locked_frames: lockedFrames.get(sb.id) || [],
          design_card_status: toDesignCardStatus(sb.designCardStatus),
        }
      }))

    // 项目画幅（Issue #92）：关键帧/视频提示词里的画幅与构图方向必须照这两个值写，
    // 技能文本不再写死 16:9；写错方向保存时会被退回。
    const aspectRatio = await dramaAspectRatio(dramaId)
    const payload = {
      episode: {
        id: ep.id,
        title: ep.title,
        episode_number: ep.episodeNumber,
        description: ep.description || '',
      },
      aspect_ratio: aspectRatio,
      composition: compositionOf(aspectRatio),
      // 模板文本框规范（#96）：本画幅家族的成套位置、类型字段与逐字段容量（数字全部由引擎算）
      text_spec: layerTextSpecPayload(aspectRatio),
      script,
      characters,
      scenes,
      props,
      exposition_assets: expositionAssets,
      existing_storyboards: existingStoryboardPayload,
      ...(window ? {
        context_window: {
          note: '设计卡只附本镜与前后相邻镜头；整集其余镜头未列出，不要据此推断它们不存在。',
          target_storyboard_id: targetId,
          before: window.before,
          after: window.after,
          shot_ids: window.ids,
        },
      } : {}),
    }
    logTaskSuccess('StoryboardTool', 'read-context', {
      episodeId,
      dramaId,
      characters: characters.length,
      scenes: scenes.length,
      props: props.length,
      expositionAssets: expositionAssets.length,
      existingStoryboards: payload.existing_storyboards.length,
      ...(window ? { contextWindow: `${window.before}+1+${window.after}` } : {}),
      scriptLength: script.length,
      aspectRatio,
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

const semanticRefSchema = z.object({
  asset_id: z.number().describe('Asset id the annotated element lives on (prop id for maps/documents).'),
  semantic_id: z.string().describe('Stable id (or exact name) of the annotated element, copied verbatim from the semantics list in read_storyboard_context.'),
  name: z.string().optional().describe('Human readable name of that element.'),
})

/**
 * 分镜设计卡（Issue #57）。纪录片每一镜都要先回答「这一镜要让观众 get 到哪几个信息点、
 * 图层段画什么、生成段拍什么、两段各占多久」，再去写画面描述与关键帧提示词。
 * combo 由模型填写，已有组合不会被后台批量填写覆盖。
 */
const designCardSchema = z.object({
  combo: z.string().optional().describe("Segment combination: A layer only, B generated only, C layer then generated, D generated then layer."),
  info_points: z.array(z.object({
    id: z.string().optional().describe('Stable short id such as ip1.'),
    text: z.string().describe('One piece of information the viewer must get from this shot.'),
    via: z.enum(INFO_POINT_VIAS).describe("How this point is delivered: 'layer' drawn on the layer segment, 'generated' shown in the generated video segment, 'narration_only' carried by the narration alone."),
  })).max(12).optional().describe('What the viewer must understand after this shot. At most 12.'),
  budget: z.object({
    layer_s: z.number().nullable().optional().describe('Planned length of the layer segment in seconds, at most 30. null when this shot has no layer segment.'),
    gen_s: z.number().nullable().optional().describe('Planned length of the generated segment in seconds, at most 15. null when this shot has no generated segment.'),
  }).optional().describe('Segment budget. layer_s + gen_s must be at least the estimated narration duration (4.5 spoken characters per second plus 0.8s tail).'),
  layer_plan: z.object({
    base: z.object({
      kind: z.enum(['asset', 'inherit_prev']).describe("'asset' picks a verified faithful original / generated image; 'inherit_prev' continues the previous shot's base image."),
      asset_kind: z.enum(['character', 'scene', 'prop']).optional(),
      asset_id: z.number().optional(),
    }).optional().describe('Base image of the layer segment.'),
    must_mark: z.array(semanticRefSchema).max(20).optional().describe('Elements this shot promises to mark. Use real asset semantics only; when an annotation is missing, leave semantic_id and name empty and retain the planned layer as awaiting annotation.'),
    planned_layers: z.array(z.object({
      type: z.enum(PLANNED_LAYER_TYPES).describe("Layer type drawn on top of the base image. Screen typography is ALWAYS type 'text' (a template text box: role + fields); 'card' is not accepted anymore, and 'label' is only for text pinned to an annotated element (it requires anchor)."),
      text: z.string().optional().describe('Text shown by an anchored label or an image caption (ignored for text layers).'),
      anchor: semanticRefSchema.optional().describe('Annotated element this layer is drawn from (required for label).'),
      role: z.string().optional().describe("Only for type 'text': role id copied verbatim from text_spec.roles in read_storyboard_context (date / heading / statement / keyword / quote / metric / bullets)."),
      fields: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional().describe("Only for type 'text': field values keyed by the role's field keys. Respect text_spec.capacity[layout][role] (chars per line × lines) for the chosen layout; list fields take a string array."),
      at_s: z.number().optional().describe('Seconds from the start of the layer segment when this layer appears.'),
    })).max(40).optional().describe('Rough layer plan. Screen typography must use text template boxes; a map without any layer is just a prop being panned over.'),
    text_layout: z.string().optional().describe('The template text-box layout id (成套位置) for this shot, copied from text_spec.layouts. Choose it by where the base image subject/chart sits (subject right → left-hand layout). Required as soon as planned_layers contains a text layer.'),
  }).optional().describe('Layer segment plan. Required when the shot has a layer segment (combos A, C, D).'),
  gen_plan: z.object({
    reference_assets: z.array(z.object({
      kind: z.enum(['character', 'scene', 'prop']),
      id: z.number(),
      name: z.string().optional(),
    })).max(20).optional().describe('Assets the keyframe prompts must reference with @名字.'),
    first: z.string().optional().describe('One sentence for the first story keyframe. Omit when the junction frame locks it (combo C).'),
    mid: z.string().optional().describe('One sentence for the optional middle story keyframe.'),
    last: z.string().optional().describe('One sentence for the last story keyframe. Omit when the junction frame locks it (combo D).'),
  }).optional().describe('Generated segment plan. Required when the shot has a generated segment (combos B, C, D).'),
  rationale: z.string().optional().describe('Why this plan expresses the narration; mention the neighbouring shots when this shot continues them.'),
  suggested_combo: z.enum(COMBOS).optional().describe("Suggested segment combination for display."),
})

/**
 * 纪录片项目的拆镜 = **旁白骨架**（Issue #70）：只分配旁白边界、顺序与标题。
 * 设计卡、画面描述、关键帧/视频提示词都属于后面的「按实测配音时长填设计卡」阶段，
 * 这一步一个都不收——设计必须建立在实测时长之上，不能先凭估算编一版。
 */
const documentaryStoryboardFields = z.object({
  shot_number: z.number(),
  title: z.string().optional().describe('One sentence naming the single information point this shot delivers.'),
  narration_text: z.string().optional().describe(`Narration for this shot, copied VERBATIM from a consecutive stretch of the episode script (this project's script IS the narration script). Never rewrite, shorten, merge or invent text: the tool checks that the whitespace-stripped text occurs literally in the script and rejects anything else. Cut only at sentence boundaries, at most ${MAX_NARRATION_CHARS} spoken characters per shot. Every documentary shot MUST carry narration: shots with empty narration_text are rejected and listed in rejected[], and two shots may never claim the same passage.`),
  continuity: z.enum(['continue', 'cut']).optional().describe("Transition from the previous shot: 'continue' means this shot continues the previous moment, 'cut' means a hard cut. Omit when unsure."),
})

/** 已经执行过整集清空的运行 id（纪录片变体）：同一次运行的后续批次不再清空 */
const replacedRuns = new Set<string>()

/**
 * 镜头数硬上限的止损（Issue #57，主进程裁决 S3）。
 * `capStrikes` = 某集「连续整批被拒」的次数；连续 2 次就把合并建议写进 `storyboardStopReasons`，
 * 由本次运行的调用方（chat 路由 / 补镜任务）取走并把任务判 failed，避免模型反复刷同一批。
 */
const capStrikes: Record<number, number> = {}
const storyboardStopReasons: Record<number, string> = {}

/** 取走本集的停机原因（取后即清）；没有则返回 null */
export function consumeStoryboardStopReason(episodeId: number): string | null {
  const reason = storyboardStopReasons[episodeId]
  if (reason === undefined) return null
  delete storyboardStopReasons[episodeId]
  return reason
}

/** drama 与 documentary 两个变体：drama 变体的 schema / description / 行为与 #45 之前逐字一致 */
function buildSaveStoryboards(documentary: boolean) {
  return createTool({
  id: 'save_storyboards',
  description: documentary
    ? 'Save the NARRATION SKELETON for this documentary episode. Call in batches of at most 8 shots: the first batch must set replace_existing: true (clears all old storyboards for the episode, then writes), every following batch omits replace_existing (appends). Rows are upserted by shot_number, so overlapping batches and retries never create duplicates. A skeleton shot carries ONLY shot_number, narration_text copied verbatim from the script in script order, a one-sentence title and the continuity flag — visual design (design cards, descriptions, keyframe/video prompts) belongs to a LATER stage that runs on measured voice-over durations, so do not send it here. The result reports how much of the script is still uncovered. In fill-gap mode (the user message says 补镜模式) replace_existing is forbidden and shot_number is ignored: every shot is inserted with a server-assigned number and its narration must fall inside one of the uncovered passages.'
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
    // 画幅校验（Issue #92）：必须在 replace_existing 清空之前判完 —— 否则一批写错画幅的
    // 提示词会先删掉整集分镜再被拒。任一镜不合格则整批不落地，逐镜说明退回给模型改正。
    if (!documentary) {
      const aspect = await dramaAspectRatio(dramaId)
      const aspectRejected = (storyboards as z.infer<typeof storyboardFields>[])
        .flatMap(sb => aspectRejections(sb, aspect).map(reason => ({ shot_number: sb.shot_number, reason })))
      if (aspectRejected.length) {
        logTaskProgress('StoryboardTool', 'save-aspect-rejected', {
          episodeId,
          aspect,
          shotNumbers: [...new Set(aspectRejected.map(item => item.shot_number))].join(','),
        })
        return {
          error: `本项目画幅是 ${aspect} ${compositionOf(aspect)}，有 ${aspectRejected.length} 条关键帧提示词写了别的画幅或构图方向，整批未保存。请按下面逐镜说明改写后重新调用 save_storyboards。`,
          count: 0,
          rejected: aspectRejected,
          aspect_ratio: aspect,
          composition: compositionOf(aspect),
        }
      }
      // 衔接帧校验（Issue #95）：整批里带 video_prompt 且该镜号已经是 C/D 时，与单镜写入同一条规则。
      // 新拆出来的镜号还没有 combo，锁定槽位是设计卡阶段才确定的，不校验。同样在清空之前判完。
      const withVideo = (storyboards as z.infer<typeof storyboardFields>[]).filter(sb => (sb.video_prompt || '').trim())
      if (withVideo.length) {
        const existingRows = await db.select({
          id: schema.storyboards.id,
          storyboardNumber: schema.storyboards.storyboardNumber,
          deletedAt: schema.storyboards.deletedAt,
        }).from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId))
        const idByNumber = new Map(existingRows.filter(row => !row.deletedAt).map(row => [row.storyboardNumber, row.id]))
        const junctionRejected: { shot_number: number; reason: string }[] = []
        for (const sb of withVideo) {
          const existingId = idByNumber.get(sb.shot_number)
          if (!existingId) continue
          for (const reason of await junctionPromptRejections(existingId, sb.video_prompt || '')) {
            junctionRejected.push({ shot_number: sb.shot_number, reason })
          }
        }
        if (junctionRejected.length) {
          logTaskProgress('StoryboardTool', 'save-junction-rejected', {
            episodeId,
            shotNumbers: [...new Set(junctionRejected.map(item => item.shot_number))].join(','),
          })
          return {
            error: `有 ${junctionRejected.length} 条视频提示词不符合锁定衔接帧规则（C 的首段必须是 0-1 秒空镜、@ 角色与切镜/转场只能写在第二段起；D 的末段不许切镜；时间分段必须是正区间），整批未保存。请按下面逐镜说明改写后重新调用 save_storyboards。`,
            count: 0,
            rejected: junctionRejected,
          }
        }
      }
    }
    // 补镜模式（Issue #52）：既有分镜一条都不动，只把旁白覆盖缺口补成新镜头。
    // 纯插入——忽略模型给的 shot_number（服务端从 max+1 起分配临时编号），跑完由
    // renumberStoryboardsByScript 按旁白在剧本中的位置整集归位，绝不 upsert 到已有镜。
    const fillGaps = documentary && isStoryboardFillGaps(context?.requestContext)
    if (fillGaps && replace_existing === true) {
      return {
        error: 'replace_existing is forbidden in fill-gap mode: the storyboards already broken down for this episode must be kept. Call again without replace_existing.',
        count: 0,
      }
    }
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
    // 普通拆镜与补镜共享上限：短稿防过拆，但不得低于逐段合法切分旁白所需镜数。
    const paragraphs = documentary ? scriptParagraphs(episodeRow?.scriptContent || episodeRow?.content) : []
    const paragraphCount = paragraphs.length
    const shotCap = documentary ? storyboardCountCap(paragraphs) : 0
    let aliveCount = existingRows.filter(sb => !sb.deletedAt).length
    // 旁白去重：归一化文本 → 已经领走它的镜号（本集既有 + 本批）
    const narrationOwners: Record<string, number> = {}
    if (documentary) {
      for (const sb of existingRows) {
        if (sb.deletedAt) continue
        const key = narrationMatchKey(sb.narrationText)
        if (key) narrationOwners[key] = sb.storyboardNumber
      }
    }

    // 补镜模式的编号与旁白校验在写库之前一次算完：落在缺口外的镜头直接拒存，不留半条记录
    const fillGapList = fillGaps
      ? narrationCoverage(scriptKey, existingRows.filter(sb => !sb.deletedAt)
        .sort((a, b) => a.storyboardNumber - b.storyboardNumber)
        .map(sb => sb.narrationText)).gaps
      : []
    let nextShotNumber = existingRows.reduce((max, sb) => Math.max(max, sb.storyboardNumber), 0) + 1
    // 本批内已经被领走的剧本区间：同一批里两镜抄同一段时后者拒存
    const takenSpans: Array<[number, number]> = []
    const narrationTrimmed: { shot_number: number; head: number; tail: number }[] = []
    const queue: Array<{ sb: typeof storyboards[number]; shotNumber: number; fillText: string }> = []
    for (const sb of storyboards) {
      // 纪录片硬规则（契约 §8 行 1 + R8 遗留缺陷）：空旁白拒存、重复旁白拒存、超上限拒存。
      // 这三条都在写库之前判完，被拒的镜一行都不落地。
      if (!fillGaps) {
        if (documentary) {
          const narration = 'narration_text' in sb && typeof sb.narration_text === 'string' ? sb.narration_text.trim() : ''
          if (!narration) {
            narrationRejected.push({ shot_number: sb.shot_number, reason: '纪录片每镜必须承载一段旁白：narration_text 为空的镜头不保存，请把这段画面并进相邻的有旁白镜头' })
            continue
          }
          const key = narrationMatchKey(narration)
          const owner = narrationOwners[key]
          if (owner !== undefined && owner !== sb.shot_number) {
            narrationRejected.push({ shot_number: sb.shot_number, reason: `这段旁白已经被分镜 #${owner} 领走了：每一段剧本原文只能属于一镜，请改切一段还没被领走的文字` })
            continue
          }
          if (shotCap > 0 && !shotToId.has(sb.shot_number) && aliveCount >= shotCap) {
            narrationRejected.push({ shot_number: sb.shot_number, reason: `本集最多 ${shotCap} 镜（旁白 ${paragraphCount} 段），已经有 ${aliveCount} 镜，请合并相邻的短句而不是继续加镜` })
            continue
          }
          narrationOwners[key] = sb.shot_number
          if (!shotToId.has(sb.shot_number)) aliveCount++
        }
        queue.push({ sb, shotNumber: sb.shot_number, fillText: '' })
        continue
      }
      if (shotCap > 0 && aliveCount >= shotCap) {
        narrationRejected.push({ shot_number: sb.shot_number, reason: `本集最多 ${shotCap} 镜（旁白 ${paragraphCount} 段），已经有 ${aliveCount} 镜，请合并相邻的短句而不是继续补镜` })
        continue
      }
      const raw = 'narration_text' in sb && typeof sb.narration_text === 'string' ? sb.narration_text : ''
      const fit = fitNarrationToGaps(scriptKey, fillGapList, raw)
      if (fit.status === 'rejected') {
        narrationRejected.push({ shot_number: sb.shot_number, reason: fit.reason || 'narration does not fall inside an uncovered passage' })
        continue
      }
      const chars = narrationCharCount(fit.text)
      if (chars > MAX_NARRATION_CHARS) {
        narrationRejected.push({ shot_number: sb.shot_number, reason: `narration is ${chars} characters, exceeding the per-shot limit of ${MAX_NARRATION_CHARS}; split the uncovered passage at a sentence boundary into two shots` })
        continue
      }
      if (takenSpans.some(([start, end]) => fit.start < end && start < fit.end)) {
        narrationRejected.push({ shot_number: sb.shot_number, reason: `narration at characters ${fit.start}–${fit.end} overlaps text another shot in this same batch already took; each shot must take a different stretch of the uncovered passage` })
        continue
      }
      takenSpans.push([fit.start, fit.end])
      if (fit.trimmedHead || fit.trimmedTail) {
        narrationTrimmed.push({ shot_number: sb.shot_number, head: fit.trimmedHead, tail: fit.trimmedTail })
      }
      queue.push({ sb, shotNumber: nextShotNumber++, fillText: fit.text })
      aliveCount++
    }

    for (const { sb, shotNumber, fillText } of queue) {
      // 纪录片拆镜 = 旁白骨架（#70）：只写标题/衔接/旁白，不收画面字段、资产绑定与设计卡。
      // 视觉设计要等批量配音出实测时长之后再填，这里先把 zod 的联合类型收敛成一份可读的字段视图。
      const shot = sb as z.infer<typeof storyboardFields> & { narration_text?: string }
      if (!documentary) {
        await validateStoryboardBindings(episodeId, dramaId, shot.scene_id, shot.character_ids, shot.prop_ids)
      }
      // 补镜模式永不 upsert：即使模型给的编号撞上已有镜，也只插入新行
      const existingId = fillGaps ? undefined : shotToId.get(shotNumber)
      if (existingId !== undefined) {
        await db.update(schema.storyboards).set(documentary ? {
          title: shot.title,
          continuityBoundary: shot.continuity,
          updatedAt: ts,
        } : {
          title: shot.title, shotType: shot.shot_type,
          angle: shot.angle, movement: shot.movement,
          location: shot.location, time: shot.time,
          description: shot.description, result: shot.result,
          atmosphere: shot.atmosphere,
          firstFramePrompt: shot.first_frame_prompt,
          midFramePrompt: shot.mid_frame_prompt,
          midFrameTime: shot.mid_frame_time,
          lastFramePrompt: shot.last_frame_prompt,
          videoPrompt: shot.video_prompt, bgmPrompt: shot.bgm_prompt,
          soundEffect: shot.sound_effect,
          sceneId: shot.scene_id, duration: shot.duration || 10,
          continuityBoundary: shot.continuity,
          updatedAt: ts,
        }).where(eq(schema.storyboards.id, existingId))
        // 拆镜显式传入的绑定 = 手选；提示词里的 @ 另由 syncStoryboardBindingsFromPrompts 自动进池
        if (!documentary) {
          await applyExplicitBindings(existingId, {
            characterIds: shot.character_ids || [],
            propIds: shot.prop_ids || [],
            sceneId: shot.scene_id ?? null,
          })
        }
      } else {
        const res = await db.insert(schema.storyboards).values(documentary ? {
          episodeId,
          storyboardNumber: shotNumber,
          title: shot.title,
          continuityBoundary: fillGaps ? (shot.continuity ?? 'cut') : shot.continuity,
          // 时长由设计卡阶段按实测配音时长决定，骨架阶段不预设
          duration: 0,
          createdAt: ts, updatedAt: ts,
        } : {
          episodeId,
          storyboardNumber: shotNumber,
          title: shot.title, shotType: shot.shot_type,
          angle: shot.angle, movement: shot.movement,
          location: shot.location, time: shot.time,
          description: shot.description, result: shot.result,
          atmosphere: shot.atmosphere,
          firstFramePrompt: shot.first_frame_prompt,
          midFramePrompt: shot.mid_frame_prompt,
          midFrameTime: shot.mid_frame_time,
          lastFramePrompt: shot.last_frame_prompt,
          videoPrompt: shot.video_prompt, bgmPrompt: shot.bgm_prompt,
          soundEffect: shot.sound_effect,
          continuityBoundary: shot.continuity,
          sceneId: shot.scene_id, duration: shot.duration || 10,
          createdAt: ts, updatedAt: ts,
        })
        const newId = getInsertId(res)
        shotToId.set(shotNumber, newId)
        if (!documentary) {
          await applyExplicitBindings(newId, {
            characterIds: shot.character_ids || [],
            propIds: shot.prop_ids || [],
            sceneId: shot.scene_id ?? null,
          })
        }
      }
      // 关键帧/视频提示词写入后：打字段保存时间 + 绑定跟随 @引用（LLM 不必自己传 ids）
      const savedId = existingId ?? shotToId.get(shotNumber)!
      const writtenFields = Object.entries(sb).filter(([, value]) => value !== undefined).map(([key]) => key)
      const [savedRow] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, savedId))
      const stamp = stampFieldSavedAt(savedRow?.fieldSavedAt, writtenFields)
      if (stamp.json) {
        await db.update(schema.storyboards).set({ fieldSavedAt: stamp.json })
          .where(eq(schema.storyboards.id, savedId))
      }
      if (!documentary) await syncStoryboardBindingsFromPrompts(savedId, writtenFields)
      // narration-first：逐字取自剧本才写库；改写过的文本不写旁白字段，画面字段照常保存
      if (documentary && (fillGaps || 'narration_text' in sb)) {
        // 补镜模式的文本在入队前已校验（逐字出自剧本 + 落在缺口内，必要时裁到边界）
        const text = fillGaps ? fillText : ('narration_text' in sb && typeof sb.narration_text === 'string' ? sb.narration_text.trim() : '')
        const chars = narrationCharCount(text)
        const found = !text ? { index: -1, chars: 0 }
          : fillGaps ? { index: scriptCursor, chars }
          : locateNarrationInScript(scriptKey, text, scriptCursor)
        if (!text) {
          // 纪录片每镜必须承载一段旁白：空文本在入队阶段就被拒了，这里只兜底不写库
          narrationRejected.push({ shot_number: shotNumber, reason: '纪录片每镜必须承载一段旁白：narration_text 为空的镜头不保存' })
        } else if (chars > MAX_NARRATION_CHARS) {
          narrationRejected.push({ shot_number: shotNumber, reason: `narration is ${chars} characters, exceeding the per-shot limit of ${MAX_NARRATION_CHARS}; split the script passage at a sentence boundary into two shots` })
        } else if (found.index < 0) {
          narrationRejected.push({ shot_number: shotNumber, reason: 'narration is not a verbatim stretch of the episode script; copy the script text exactly (whitespace aside) instead of rewriting it' })
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
      count: queue.length,
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
    // 止损（主进程裁决 S3）：同一集连续 2 次整批被拒 → 记下停机原因，
    // 调用方（chat 路由 / 补镜任务）在本次运行结束后把任务判 failed，避免模型无限重试同一批。
    let capStop: string | null = null
    if (storyboards.length > 0 && narrationRejected.length === storyboards.length) {
      const strikes = (capStrikes[episodeId] || 0) + 1
      capStrikes[episodeId] = strikes
      if (strikes >= 2) {
        capStop = `连续 ${strikes} 批分镜全部被拒。合并建议：本集旁白 ${paragraphCount} 段，最多 ${shotCap} 镜，当前已有 ${aliveCount} 镜，请把相邻短句合并成一镜再保存。`
        storyboardStopReasons[episodeId] = capStop
        delete capStrikes[episodeId]
      }
    } else {
      delete capStrikes[episodeId]
    }
    // 覆盖缺口（#49）：中间整段被跳过时必须当场回报，否则模型会以为切完了就收工
    // ——实测 93 镜漏掉 746 字，连「彼得一世亲自筹建近卫团」那句都没有对应镜头。
    const mustFix = coverage.gaps.length
      ? `旁白覆盖缺口：剧本有 ${coverage.gaps.length} 段（共 ${coverage.uncovered_chars} 字）还没有被任何一镜领走，必须继续补镜把它们逐字切进 narration_text（${fillGaps ? '继续新增镜头，shot_number 由服务端分配' : '在句界处插入新的 shot_number'}，不要改写原文）：${describeNarrationGaps(coverage.gaps)}`
      : null
    return {
      message: capStop || mustFix || `Saved ${queue.length} storyboards`,
      count: queue.length,
      total_duration: totalDuration,
      rejected: narrationRejected,
      narration_rejected: narrationRejected,
      shot_cap: shotCap || null,
      narration_paragraphs: paragraphCount || null,
      replace_existing_ignored: replaceIgnored,
      script_coverage: coverage,
      must_fix: capStop || mustFix,
      stop: capStop,
      fill_gaps_mode: fillGaps,
      narration_trimmed: narrationTrimmed,
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
    design_card: designCardSchema.optional().describe('Documentary design card, including the chosen combo and optional suggestion.'),
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
    // 画幅校验（Issue #92）：写错画幅/构图方向的关键帧提示词一律不落库，退回让模型自己改正
    const aspect = await dramaAspectRatio(dramaId)
    const aspectReasons = aspectRejections(fields, aspect)
    if (aspectReasons.length) {
      logTaskProgress('StoryboardTool', 'update-aspect-rejected', { episodeId, storyboardId: storyboard_id, aspect })
      return {
        error: aspectReasons.join(' '),
        rejected: aspectReasons,
        aspect_ratio: aspect,
        composition: compositionOf(aspect),
      }
    }
    // 衔接帧校验（Issue #95）：C 的首段必须是 0-1 秒空镜（不许 @ 角色、不许切镜、不许场景过渡），
    // D 的末段不许切镜 —— 该槽位的画面由衔接帧锁定，首段写得越多 H3 越把第 0 帧画成第二段内容。
    // 退回信息带上 caption，模型按真实构图重写后重新保存。
    if ('video_prompt' in fields) {
      const junctionReasons = await junctionPromptRejections(storyboard_id, fields.video_prompt || '')
      if (junctionReasons.length) {
        const combo = toCombo(storyboard.combo)
        const slot = lockedGenSlot(combo)
        logTaskProgress('StoryboardTool', 'update-junction-rejected', { episodeId, storyboardId: storyboard_id, combo })
        return {
          error: junctionReasons.join(' '),
          rejected: junctionReasons,
          combo,
          locked_frame: slot ? { slot, source: slot === 'first' ? 'layer_last' : 'layer_first' } : null,
        }
      }
    }

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
    // 只有设计卡批次接受模型选择；已有组合保留。补选模式绝不改写原有卡片。
    const cardReport: { code: string; message: string }[] = []
    if ('design_card' in fields && fields.design_card) {
      const scope = context?.requestContext?.get('storyboardPromptScope' as never)
      const comboOnly = context?.requestContext?.get('designCardComboOnly' as never) === true
      const ctx = loadDesignCardContext(episodeId)
      const card = normalizeDesignCard(fields.design_card, ctx)
      const proposed = toCombo(fields.design_card.combo)
      const combo = toCombo(storyboard.combo) || (scope === 'design_card' ? proposed : null)
      if (scope === 'design_card' && !toCombo(storyboard.combo) && !proposed) {
        const reason = `模型给出非法组合 ${String(fields.design_card.combo ?? '（缺失）')}；请选择 A、B、C 或 D 后重试`
        context?.requestContext?.set('designCardError' as never, reason as never)
        return { error: reason }
      }
      // AI 写入路径的依据机检（#87）：只认当前已有资产能支撑的设计。
      // 旧实现只拒「填了名字但解析不到」的引用，留空的几何层照样放行——用户已裁定
      // 「留空待人工补标注」不是 AI 完成设计的出口。人工 PUT 不走这里，不受此限制。
      // AI 写入路径的模板文本框硬规则（#96）：card、无锚点的 label、没选成套位置、
      // 引擎报出的阻断级排版问题（含逐字段容量数字）都不落库，当前循环内回给模型改正。
      if (!comboOnly && scope === 'design_card' && card) {
        const textRejections = aiTextPlanRejections(card, ctx.aspect, fields.design_card.layer_plan?.planned_layers)
        if (textRejections.length) {
          const reason = textPlanRejectionMessage(textRejections)
          context?.requestContext?.set('designCardError' as never, reason as never)
          return { error: reason, text_plan_issues: textRejections }
        }
      }
      if (!comboOnly && scope === 'design_card' && card) {
        const violations = checkDesignCardGrounding(card, ctx, combo)
        if (violations.length) {
          const reason = groundingRejectionMessage(violations)
          context?.requestContext?.set('designCardError' as never, reason as never)
          return { error: reason, grounding_issues: violations }
        }
      }
      if (card && !comboOnly) {
        updates.designCard = serializeDesignCard(card)
        updates.designCardStatus = 'pending'
        updates.designCardConfirmedAt = null
        updates.designCardStaleReason = null
        // 本次写入被接受：清掉上一轮工具拒绝留下的原因，批量不能把它当成本镜失败
        context?.requestContext?.set('designCardError' as never, null as never)
      }
      if (scope === 'design_card' && !storyboard.combo && combo) updates.combo = combo
      const actualCard = comboOnly ? parseDesignCard(storyboard.designCard, ctx) : card
      const tts = await shotTtsValidity(storyboard_id)
      for (const issue of validateDesignCard({
        card: actualCard,
        combo,
        narrationText: storyboard.narrationText,
        measuredSeconds: tts.valid ? tts.duration_s : null,
        aspect: ctx.aspect,
      })) {
        cardReport.push({ code: issue.code, message: issue.message })
      }
    }
    const stamp = stampFieldSavedAt(storyboard.fieldSavedAt, Object.keys(fields))
    if (stamp.json) updates.fieldSavedAt = stamp.json
    await db.update(schema.storyboards).set(updates).where(eq(schema.storyboards.id, storyboard_id))
    if (context?.requestContext?.get('storyboardPromptScope' as never) === 'design_card' && fields.design_card) {
      context.requestContext.set('designCardSaved' as never, true as never)
    }
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
    return cardReport.length
      ? { message: `Storyboard ${storyboard_id} updated`, design_card_issues: cardReport }
      : { message: `Storyboard ${storyboard_id} updated` }
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
/** 设计卡填写（#57）：单镜任务只允许写 design_card，绝不能顺手重拆整集 */
const designCardOnlySchema = storyboardUpdateSchema.pick({ storyboard_id: true, design_card: true })

function promptUpdater(
  inputSchema: typeof promptSchema | typeof videoPromptSchema | typeof keyframePromptSchema | typeof designCardOnlySchema,
) {
  return createTool({
    id: 'update_storyboard',
    description: 'Save only the fields this request permits (the requested storyboard prompts, or the shot design card). Other storyboard fields are never writable with this tool.',
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
      const allowed = scope === 'video' ? videoPromptSchema
        : scope === 'keyframes' ? keyframePromptSchema
        : scope === 'design_card' ? designCardOnlySchema
        : inputSchema
      const safe = allowed.parse(input)
      if (!Object.keys(safe).some(key => key !== 'storyboard_id')) return { error: 'No permitted fields supplied' }
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
  designCard: promptUpdater(designCardOnlySchema),
}
