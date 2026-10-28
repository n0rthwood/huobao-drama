/**
 * 转场审核/生成的运行入口（Issue #11）
 * 单镜按钮、视频提示词批量、视频提交前的自动生成都走这里，口径唯一。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { mastra } from '../mastra/index.js'
import { buildAgentRequestContext } from '../agents/context.js'
import { runAgent } from '../agents/run.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import {
  legalTechniqueIds,
  loadTransitionPair,
  parseTransitionReview,
  transitionInputSignature,
  type TransitionReview,
} from './transition.js'

export interface TransitionRunOptions {
  model?: string
  configId?: number
}

const USER_MESSAGE_SUFFIX = '先调用 read_transition_context 读取上下文，按系统提示词的三步决策完成判定，'
  + '再调用 update_storyboard 提交 JSON 决策，最后只回复该 JSON。'

/**
 * 跑一次转场审核并落库。technique_id 非法时工具会返回错误让模型改正；
 * 整轮结束仍未落下新的审核结果就整体重试一次，再失败则抛错（调用方据此把该镜标记失败）。
 */
export async function runTransitionReview(
  storyboardId: number,
  opts: TransitionRunOptions = {},
): Promise<TransitionReview> {
  const pair = await loadTransitionPair(storyboardId)
  if (!pair) throw new Error('该镜头没有继承上一镜尾帧，无需转场')
  const agent = mastra.getAgent('transition_writer')
  if (!agent) throw new Error('转场设计 Agent 不可用')
  const signature = transitionInputSignature(pair.previous, pair.previousLastFrame, pair.current)

  logTaskStart('Transition', 'review', {
    storyboardId,
    episodeId: pair.episodeId,
    shotNumber: pair.current.storyboardNumber,
  })

  const requestContext = buildAgentRequestContext({
    episodeId: pair.episodeId,
    dramaId: pair.dramaId,
    storyboardId,
    modelOverride: opts.model || undefined,
    textConfigId: opts.configId || undefined,
  })

  const errors: string[] = []
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await runAgent(
        agent,
        [{
          role: 'user',
          content: `请为分镜 #${pair.current.storyboardNumber}（承接上一镜 #${pair.previous.storyboardNumber} 的尾帧）设计开场转场。${USER_MESSAGE_SUFFIX}`,
        }],
        { maxSteps: 8, requestContext },
      )
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
      continue
    }
    // 以实际落库为准：工具校验通过才会写入与当前输入签名一致的审核结果
    const [fresh] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
    const review = parseTransitionReview(fresh?.transitionReview)
    if (review && review.input_signature === signature && !review.edited_manually) {
      if (review.verdict !== 'none' && !legalTechniqueIds().includes(review.technique || '')) {
        errors.push(`technique_id ${review.technique} 不在手法目录中`)
        continue
      }
      logTaskSuccess('Transition', 'review', {
        storyboardId,
        verdict: review.verdict,
        technique: review.technique || undefined,
        seconds: review.seconds,
        attempt,
      })
      return review
    }
    errors.push('模型没有提交有效的转场决策（update_storyboard 未成功调用或 technique_id 非法）')
  }

  const message = `分镜 #${pair.current.storyboardNumber} 转场生成失败：${errors.join(' | ')}`
  logTaskError('Transition', 'review', { storyboardId, error: message })
  throw new Error(message)
}
