/**
 * 文本任务重启参数的校验 schema（Issue #77）。
 * 单独成文件供 `text-task-restart.ts`（派发）与 `text-task-autoretry.ts`（自动重排）共用，
 * 避免后者静态 import 整个派发器而把所有服务拉进工具模块的 import 图（ESM 循环初始化）。
 */
import { z } from 'zod'

export const restartOptionsSchema = z.object({
  model: z.string().optional(), configId: z.number().optional(), retryOf: z.number().optional(),
  excludeConfigIds: z.array(z.number()).optional(),
  singleAssetName: z.string().optional(), assetReviewItemId: z.number().optional(), episodeId: z.number().optional(),
  startStage: z.enum(['fidelity', 'bridge']).optional(), predecessorVersionId: z.number().optional(),
  skipStages: z.array(z.string()).optional(), autoAdopt: z.boolean().optional(),
  sourceRevision: z.number().optional(), finalRevision: z.number().optional(), acknowledgeSourceChange: z.boolean().optional(),
})

export const restartArgsSchema = z.object({
  episodeId: z.number().optional(), dramaId: z.number().optional(), characterId: z.number().optional(),
  sourceTaskId: z.number().optional(), target: z.enum(['characters', 'scenes', 'props']).optional(),
  storyboardIds: z.array(z.number()).optional(), opts: restartOptionsSchema.optional(),
  input: z.object({ propId: z.number(), episodeId: z.number(), dramaId: z.number(), propName: z.string(),
    absPath: z.string(), sourceTaskId: z.number().nullable(), configId: z.number().optional(), excludeConfigIds: z.array(z.number()).optional() }).optional(),
  req: z.object({ scope: z.enum(['characters', 'scenes', 'props', 'all']), episodeId: z.number(),
    rewritePrompts: z.boolean(), overwriteImages: z.boolean(), textModel: z.string().optional(),
    textConfigId: z.number().optional(), excludeTextConfigIds: z.array(z.number()).optional(), imageModel: z.string().optional(), imageConfigId: z.number().optional() }).optional(),
})
