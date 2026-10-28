/**
 * 转场设计 Agent 工具（Issue #11）
 * 作用的分镜由 RequestContext.storyboardId 注入；technique_id 只接受 catalog.json 里的 id
 */
import { createTool } from '@mastra/core/tools'
import type { ToolExecutionContext } from '@mastra/core/tools'
import { z } from 'zod'
import { logTaskError, logTaskSuccess } from '../../utils/task-logger.js'
import { getStoryboardId } from '../context.js'
import {
  buildTransitionContext,
  legalTechniqueIds,
  saveTransitionReview,
  techniqueSecondsRange,
} from '../../services/transition.js'
import { syncStoryboardBindingsFromPrompts } from '../../services/storyboard-assets.js'

const readTransitionContext = createTool({
  id: 'read_transition_context',
  description: 'Read the previous shot, this shot, bound assets and the episode script for designing the opening transition.',
  inputSchema: z.object({}),
  execute: async (_input, context: ToolExecutionContext | undefined) => {
    const storyboardId = getStoryboardId(context?.requestContext)
    if (!storyboardId) return { error: 'Missing storyboard context' }
    try {
      const payload = await buildTransitionContext(storyboardId)
      logTaskSuccess('TransitionTool', 'read-context', { storyboardId })
      return payload
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'read_transition_context failed' }
    }
  },
})

/**
 * 决策落库。提示词里这一步就叫 update_storyboard（Fabel 原样产出），
 * 转场 Agent 的工具表里它指向这个实现，不会碰分镜的其他字段。
 */
const updateStoryboard = createTool({
  id: 'update_storyboard',
  description: 'Persist the transition decision for the current shot. technique_id must be one of the catalog ids.',
  inputSchema: z.object({
    verdict: z.enum(['scene_time', 'continuity', 'none']),
    changes: z.array(z.string()).default([]),
    hazards: z.array(z.string()).default([]),
    technique_id: z.string().nullable(),
    seconds: z.number(),
    transition_prompt: z.string(),
    reason: z.string().default(''),
  }),
  execute: async (input, context: ToolExecutionContext | undefined) => {
    const storyboardId = getStoryboardId(context?.requestContext)
    if (!storyboardId) return { error: 'Missing storyboard context' }
    const legal = legalTechniqueIds()
    const technique = input.verdict === 'none' ? null : input.technique_id

    if (input.verdict !== 'none') {
      if (!technique || !legal.includes(technique)) {
        logTaskError('TransitionTool', 'illegal-technique', { storyboardId, techniqueId: String(input.technique_id) })
        return {
          error: `technique_id "${input.technique_id}" 不在手法目录中，请改用合法 id 重新提交。合法 id：${legal.join('、')}`,
        }
      }
      if (!input.transition_prompt.trim()) {
        return { error: 'verdict 不是 none 时 transition_prompt 不能为空' }
      }
    }

    // 秒数落在该手法的范围内（目录是唯一事实来源），none 时恒为 0
    let seconds = 0
    if (input.verdict !== 'none') {
      const range = techniqueSecondsRange(technique)
      seconds = Math.min(range.max, Math.max(range.min, Number(input.seconds) || range.min))
    }

    try {
      const review = await saveTransitionReview(storyboardId, {
        verdict: input.verdict,
        changes: input.changes || [],
        hazards: input.hazards || [],
        technique,
        seconds,
        transitionPrompt: input.verdict === 'none' ? '' : input.transition_prompt.trim(),
        reason: input.reason || '',
      })
      // 转场段拼在视频提示词前一起提交：其中的 @名字 归视频绑定，同样参与 #7 一致性检查
      await syncStoryboardBindingsFromPrompts(storyboardId, ['transition_prompt'])
      logTaskSuccess('TransitionTool', 'save', {
        storyboardId,
        verdict: review.verdict,
        technique: review.technique || undefined,
        seconds: review.seconds,
      })
      return { message: `Transition saved for storyboard ${storyboardId}`, verdict: review.verdict, seconds: review.seconds }
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'save transition failed' }
    }
  },
})

export const transitionTools = { readTransitionContext, updateStoryboard }
