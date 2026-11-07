/**
 * 剧本改写 Agent 工具
 * 模块级单例 — episodeId 通过 RequestContext 按请求注入
 */
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { db, schema } from '../../db/index.js'
import { and, eq } from 'drizzle-orm'
import { now } from '../../utils/response.js'
import { getEpisodeId } from '../context.js'
import { onScriptChanged } from '../../services/workflow-gates.js'
import { resolveDramaProjectType } from '../../services/project-type.js'

const readEpisodeScript = createTool({
  id: 'read_episode_script',
  description: 'Read the script content of the current episode.',
  inputSchema: z.object({}),
  execute: async (_input, context) => {
    const episodeId = getEpisodeId(context?.requestContext)
    if (!episodeId) return { error: 'Missing episodeId in request context' }
    const [ep] = await db.select().from(schema.episodes)
      .where(eq(schema.episodes.id, episodeId))
    if (!ep) return { error: `Episode not found (id=${episodeId})` }
    const content = ep.content || ep.scriptContent
    if (!content) return { error: `Episode has no content (id=${episodeId})` }
    return { content, word_count: content.length, episode_id: episodeId }
  },
})

const rewriteToScreenplay = createTool({
  id: 'rewrite_to_screenplay',
  description: 'Read the original content for AI rewriting. Returns the source text with formatting instructions.',
  inputSchema: z.object({
    instructions: z.string().optional().describe('Additional rewrite instructions'),
  }),
  execute: async ({ instructions }, context) => {
    const episodeId = getEpisodeId(context?.requestContext)
    if (!episodeId) return { error: 'Missing episodeId in request context' }
    const [ep] = await db.select().from(schema.episodes)
      .where(eq(schema.episodes.id, episodeId))
    if (!ep) return { error: `Episode not found` }
    const source = ep.content || ep.scriptContent
    if (!source) return { error: `Episode has no content to rewrite` }

    return {
      source_content: source,
      instruction: `请将以下内容改写为格式化剧本。

格式规范：
- 场景头：## S编号 | 内景/外景 · 地点 | 时间段
- 动作描写：自然段落，不包含镜头语言
- 对白：角色名：（状态/表情）台词内容
- 每个场景 30-60 秒内容

${instructions || ''}

【原始内容】
${source}`,
    }
  },
})

/**
 * 旁白稿/剧本保存。
 *
 * 纪录片项目（Issue #70）已经改成分阶段改写：阶段产出只能落不可变版本，最终稿由
 * 采用/人工保存经 `writeCanonicalFinal` 的修订号 CAS 写入。因此这里对纪录片**直接拒写**，
 * 不保留任何绕过版本与并发保护的旧通路（剧情项目行为不变）。
 */
const saveScript = createTool({
  id: 'save_script',
  description: 'Save the rewritten screenplay content to the current episode.',
  inputSchema: z.object({
    content: z.string().describe('The formatted screenplay content to save'),
  }),
  execute: async ({ content }, context) => {
    const episodeId = getEpisodeId(context?.requestContext)
    if (!episodeId) return { error: 'Missing episodeId in request context' }
    const [before] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
    if (!before) return { error: `Episode not found (id=${episodeId})` }
    if (resolveDramaProjectType(before.dramaId) === 'documentary') {
      return {
        error: '纪录片项目的旁白稿不再由本工具写入：请走分阶段改写接口 POST /episodes/:id/script-rewrite，'
          + '阶段产出会落成不可变版本，最终稿由采用或人工保存按修订号写入。',
      }
    }
    // 剧情项目：保持原有「直接写入 + 自动取消确认」语义，但把写入做成条件更新，
    // 并发保存时后到的一方拿到明确冲突，而不是悄悄互相覆盖。
    const baseRevision = before.finalRevision ?? 1
    const changed = (before.scriptContent || '') !== content
    const res = await db.update(schema.episodes)
      .set({ scriptContent: content, finalRevision: changed ? baseRevision + 1 : baseRevision, updatedAt: now() })
      .where(and(eq(schema.episodes.id, episodeId), eq(schema.episodes.finalRevision, baseRevision)))
    if (!res.changes) return { error: '保存冲突：本集旁白稿刚被其它操作修改，请重新读取后再保存' }
    if (changed) await onScriptChanged(episodeId, 'save_script 工具写入旁白稿')

    return { message: `Script saved`, word_count: content.length }
  },
})

export const scriptTools = { readEpisodeScript, rewriteToScreenplay, saveScript }
