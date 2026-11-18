/**
 * 提示词生成 Agent 工具
 * 模块级单例 — dramaId 通过 RequestContext 按请求注入
 *
 * Agent 负责创作最终提示词：
 * 1. 角色 → 三视图（character turnaround：正面/侧面/背面）
 * 2. 场景 → 固定视角 + 前景/中景/后景分层构图
 * 3. 道具 → 白底单品静物（single product shot on pure white background）
 * 工具负责读取资产信息与保存 Agent 产出的最终提示词（保存时注入项目视觉风格）。
 * 读取工具不返回已存的最终提示词：重写必须只依据最新的资产信息，不能照着旧稿改（Issue #24）
 *
 * 参考图（Issue #107）：读工具返回逐张编号的参考图（1 起即发送顺序）与画像路径；
 * 保存工具校验提示词逐张引用每张参考图，漏引用时返回 { error, saved: false } 让 Agent 改写。
 */
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { db, schema } from '../../db/index.js'
import { eq } from 'drizzle-orm'
import { now } from '../../utils/response.js'
import { getDramaStylePrompt } from '../../services/style-preset.js'
import { getDramaId } from '../context.js'
import { sceneFinalPromptCoversTime, sceneTimeMissingMessage } from '../../services/scene-time.js'
import { compositionOf, sceneAspectIssue } from '../../services/aspect.js'
import { resolveDramaAspect } from '../../services/asset-image-size.js'
import { effectiveReferenceImages } from '../../services/reference-images.js'
import { parseArchivalImages } from '../../services/archival-images.js'
import { checkReferenceCitations, referenceCitationIssue, referenceToken } from '../../services/asset-reference-prompt.js'
import { descriptionCitationsOf } from '../../services/asset-submit-refs.js'

/**
 * 参考图字段（Issue #107 追加范围）：编号 1 起即发送顺序。
 * 只列磁盘上真实存在的图——提示词校验与生图提交用的是同一份列表，Agent 引用不存在的那张会被拒绝保存。
 */
function referenceFields(saved: unknown) {
  const paths = effectiveReferenceImages(saved)
  return {
    reference_images: paths.map((path, i) => ({ n: i + 1, path })),
    reference_count: paths.length,
  }
}

/**
 * 保存工具共用的参考图门槛（Issue #121 口径）：越界引用、或描述字段里用户引用的
 * 参考图未在新稿落地时退回让模型改写。未引用的普通参考图不是错误（按需引用）。
 */
function referenceRejectReason(prompt: string, saved: unknown, descriptionCitations: number[]): string | null {
  const issue = referenceCitationIssue(prompt, effectiveReferenceImages(saved).length, descriptionCitations)
  return issue ? `${issue}（写法 ${referenceToken(1)}、${referenceToken(2)}…）；未保存，请修正后重新调用该保存工具` : null
}

// ─── 角色提示词 ───────────────────────────────────────

const readCharacters = createTool({
  id: 'read_characters',
  description: '读取当前剧集中的所有角色信息，用于生成角色三视图最终提示词。',
  inputSchema: z.object({}),
  execute: async (_input, context) => {
    const dramaId = getDramaId(context?.requestContext)
    if (!dramaId) return { error: 'Missing dramaId in request context' }
    const chars = (await db.select().from(schema.characters)
      .where(eq(schema.characters.dramaId, dramaId)))
      .filter(c => !c.deletedAt)
    return {
      characters: chars.map(c => ({
        id: c.id,
        name: c.name,
        role: c.role || '',
        description: c.description || '',
        appearance: c.appearance || '',
        styling: c.styling || '',
        // 生图参考图：编号=列表序；生图只发送最终提示词实际引用的那几张（#121）
        ...referenceFields(c.referenceImages),
        description_citations: descriptionCitationsOf('character', c as unknown as Record<string, unknown>),
        // 该角色是否已入库史料画像（Issue #32）：画像本身不进生图链路，
        // 但提示词要忠实于 appearance/styling 里已文本化的画像特征，不得自行发挥
        has_archival_reference: !!c.archivalImages && c.archivalImages !== '[]',
        // 画像路径（只读）：Agent 可以用 read_image 看图、把可见特征写进提示词，
        // 但仍不得把画像当生图参考图引用（Issue #32 的边界不变）
        archival_images: parseArchivalImages(c.archivalImages).map(entry => entry.path),
      })),
    }
  },
})

const saveCharacterFinalPrompt = createTool({
  id: 'save_character_final_prompt',
  description: `保存为角色创作的三视图最终提示词。项目视觉风格会由工具自动拼接，prompt 参数中不要包含风格词。参考图按需引用（写法 ${referenceToken(1)}、${referenceToken(2)}…，编号=列表序）：生图只发送 prompt 实际引用的那几张，零引用则一张不发；描述字段里用户已引用的参考图必须保留引用并写明贡献，引用不存在的编号会拒绝保存。保存前建议先调用 check_final_prompt_references 自查。`,
  inputSchema: z.object({
    character_id: z.number(),
    prompt: z.string().describe('角色三视图最终提示词（使用会话语言指令指定的目标语言，不含风格词；按需引用参考图，描述里用户引用的必须保留）'),
  }),
  execute: async ({ character_id, prompt }, context) => {
    const dramaId = getDramaId(context?.requestContext)
    if (!dramaId) return { error: 'Missing dramaId in request context' }
    const [c] = await db.select().from(schema.characters)
      .where(eq(schema.characters.id, character_id))
    if (!c) return { error: 'Character not found' }
    const referenceIssue = referenceRejectReason(prompt, c.referenceImages, descriptionCitationsOf('character', c as unknown as Record<string, unknown>))
    if (referenceIssue) return { error: referenceIssue, saved: false }

    const stylePrompt = await getDramaStylePrompt(dramaId)
    const finalPrompt = stylePrompt ? `${stylePrompt}, ${prompt}` : prompt
    const ts = now()
    await db.update(schema.characters)
      // 来源标记（Issue #32）：UI 据此显示「Agent 生成」徽标，与外部直写区分
      .set({ finalPrompt, finalPromptSource: 'agent', finalPromptUpdatedAt: ts, updatedAt: ts })
      .where(eq(schema.characters.id, character_id))

    return {
      character_id: c.id,
      character_name: c.name,
      saved: true,
      final_prompt: finalPrompt,
    }
  },
})

// ─── 场景提示词 ───────────────────────────────────────

const readScenes = createTool({
  id: 'read_scenes',
  description: '读取当前剧集中的所有场景信息与项目画幅，用于生成场景固定视角最终提示词。',
  inputSchema: z.object({}),
  execute: async (_input, context) => {
    const dramaId = getDramaId(context?.requestContext)
    if (!dramaId) return { error: 'Missing dramaId in request context' }
    const scenes = (await db.select().from(schema.scenes)
      .where(eq(schema.scenes.dramaId, dramaId)))
      .filter(s => !s.deletedAt)
    // 项目画幅（Issue #94）：场景图按项目画幅出图，提示词必须逐字写出 `{aspect_ratio} {composition}`
    const aspectRatio = await resolveDramaAspect(dramaId)
    return {
      aspect_ratio: aspectRatio,
      composition: compositionOf(aspectRatio),
      scenes: scenes.map(s => ({
        id: s.id,
        location: s.location,
        time: s.time || '',
        prompt: s.prompt || '',
        lighting: s.lighting || '',
        ...referenceFields(s.referenceImages),
        description_citations: descriptionCitationsOf('scene', s as unknown as Record<string, unknown>),
      })),
    }
  },
})

const saveSceneFinalPrompt = createTool({
  id: 'save_scene_final_prompt',
  description: `保存为场景创作的固定视角（前景/中景/后景）最终提示词。项目视觉风格会由工具自动拼接，prompt 参数中不要包含风格词。场景 time 非空时 prompt 必须原样包含 time 文字；非 16:9 项目的 prompt 必须逐字包含 read_scenes 返回的「{aspect_ratio} {composition}」；参考图按需引用（写法 ${referenceToken(1)}、${referenceToken(2)}…）：生图只发送 prompt 实际引用的那几张；描述字段里用户已引用的必须保留，引用不存在的编号拒绝保存。保存前建议先调用 check_final_prompt_references 自查。`,
  inputSchema: z.object({
    scene_id: z.number(),
    prompt: z.string().describe('场景固定视角最终提示词（使用会话语言指令指定的目标语言，不含风格词；必须原样包含场景 time 与项目画幅短语；按需引用参考图，描述里用户引用的必须保留）'),
  }),
  execute: async ({ scene_id, prompt }, context) => {
    const dramaId = getDramaId(context?.requestContext)
    if (!dramaId) return { error: 'Missing dramaId in request context' }
    const [s] = await db.select().from(schema.scenes)
      .where(eq(schema.scenes.id, scene_id))
    if (!s) return { error: 'Scene not found' }
    const referenceIssue = referenceRejectReason(prompt, s.referenceImages, descriptionCitationsOf('scene', s as unknown as Record<string, unknown>))
    if (referenceIssue) return { error: referenceIssue, saved: false }
    // 场景时间是正式字段（Issue #21）：最终提示词必须引用它，不满足则让 Agent 重写
    if (!sceneFinalPromptCoversTime(prompt, s.time)) {
      return { error: `${sceneTimeMissingMessage(s.time!)}；未保存，请按 time 改写后重新调用 save_scene_final_prompt`, saved: false }
    }
    // 项目画幅（Issue #94）：写错方向或非 16:9 项目漏写画幅都退回让模型改，不静默重写
    const aspectIssue = sceneAspectIssue(prompt, await resolveDramaAspect(dramaId))
    if (aspectIssue) {
      return { error: `${aspectIssue}未保存，请改写后重新调用 save_scene_final_prompt`, saved: false }
    }

    const stylePrompt = await getDramaStylePrompt(dramaId)
    const finalPrompt = stylePrompt ? `${stylePrompt}, ${prompt}` : prompt
    const sceneTs = now()
    await db.update(schema.scenes)
      .set({ finalPrompt, finalPromptSource: 'agent', finalPromptUpdatedAt: sceneTs, updatedAt: sceneTs })
      .where(eq(schema.scenes.id, scene_id))

    return {
      scene_id: s.id,
      location: s.location,
      saved: true,
      final_prompt: finalPrompt,
    }
  },
})

// ─── 道具提示词 ───────────────────────────────────────

const readProps = createTool({
  id: 'read_props',
  description: '读取当前剧集项目中的所有道具信息，用于生成道具白底单品最终提示词。',
  inputSchema: z.object({}),
  execute: async (_input, context) => {
    const dramaId = getDramaId(context?.requestContext)
    if (!dramaId) return { error: 'Missing dramaId in request context' }
    const props = (await db.select().from(schema.props)
      .where(eq(schema.props.dramaId, dramaId)))
      .filter(p => !p.deletedAt)
    return {
      props: props.map(p => ({
        id: p.id,
        name: p.name,
        type: p.type || '',
        description: p.description || '',
        ...referenceFields(p.referenceImages),
        description_citations: descriptionCitationsOf('prop', p as unknown as Record<string, unknown>),
      })),
    }
  },
})

const savePropFinalPrompt = createTool({
  id: 'save_prop_final_prompt',
  description: `保存为道具创作的白底单品最终提示词。项目视觉风格会由工具自动拼接，prompt 参数中不要包含风格词。参考图按需引用（写法 ${referenceToken(1)}、${referenceToken(2)}…）：生图只发送 prompt 实际引用的那几张；描述字段里用户已引用的必须保留，引用不存在的编号拒绝保存。保存前建议先调用 check_final_prompt_references 自查。`,
  inputSchema: z.object({
    prop_id: z.number(),
    prompt: z.string().describe('道具白底单品最终提示词（使用会话语言指令指定的目标语言，不含风格词；按需引用参考图，描述里用户引用的必须保留）'),
  }),
  execute: async ({ prop_id, prompt }, context) => {
    const dramaId = getDramaId(context?.requestContext)
    if (!dramaId) return { error: 'Missing dramaId in request context' }
    const [p] = await db.select().from(schema.props)
      .where(eq(schema.props.id, prop_id))
    if (!p) return { error: 'Prop not found' }
    const referenceIssue = referenceRejectReason(prompt, p.referenceImages, descriptionCitationsOf('prop', p as unknown as Record<string, unknown>))
    if (referenceIssue) return { error: referenceIssue, saved: false }

    const stylePrompt = await getDramaStylePrompt(dramaId)
    const finalPrompt = stylePrompt ? `${stylePrompt}, ${prompt}` : prompt
    const propTs = now()
    await db.update(schema.props)
      .set({ finalPrompt, finalPromptSource: 'agent', finalPromptUpdatedAt: propTs, updatedAt: propTs })
      .where(eq(schema.props.id, prop_id))

    return {
      prop_id: p.id,
      prop_name: p.name,
      saved: true,
      final_prompt: finalPrompt,
    }
  },
})

/**
 * 保存前自查工具（Issue #121）：harness 在调用 save_*_final_prompt 之前用它核验草稿。
 * 返回实际会发送的参考图、越界引用、描述引用未落地清单；与保存闸门同一纯函数。
 */
const checkFinalPromptReferences = createTool({
  id: 'check_final_prompt_references',
  description: '核验最终提示词草稿的参考图引用（保存前自查）：返回实际会发送的参考图编号、越界引用、描述字段里用户引用但草稿未落地的编号。与保存闸门同一口径；不写库。',
  inputSchema: z.object({
    kind: z.enum(['character', 'scene', 'prop']),
    asset_id: z.number(),
    prompt: z.string().describe('待核验的最终提示词草稿（不含风格词也可，引用编号口径一致）'),
  }),
  execute: async ({ kind, asset_id, prompt }) => {
    const table = kind === 'character' ? schema.characters : kind === 'scene' ? schema.scenes : schema.props
    const [row] = await db.select().from(table).where(eq(table.id, asset_id))
    if (!row) return { error: 'Asset not found' }
    const record = row as unknown as Record<string, unknown>
    const refCount = effectiveReferenceImages(record.referenceImages).length
    const descriptionCitations = descriptionCitationsOf(kind, record)
    const result = checkReferenceCitations(prompt, { refCount, descriptionCitations })
    const issue = referenceCitationIssue(prompt, refCount, descriptionCitations)
    return {
      ok: !issue,
      issue,
      reference_count: refCount,
      will_send: result.willSend,
      out_of_range: result.outOfRange,
      description_citations: descriptionCitations,
      description_citations_missing: result.descriptionMissing,
    }
  },
})

export const imagePromptTools = {
  readCharacters,
  saveCharacterFinalPrompt,
  readScenes,
  saveSceneFinalPrompt,
  readProps,
  savePropFinalPrompt,
  checkFinalPromptReferences,
}
