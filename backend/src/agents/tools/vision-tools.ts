/**
 * 看图 Agent 工具（Issue #46）— read_image
 *
 * 把 static/ 下的本地图片交给**一条能看图的文本配置**（vision-capability.ts 的真实探测结果），
 * 而不是当前 Agent 的主模型：主模型常是 GLM，它直接拒收多模态消息。请求通路与档案画像共用
 * services/vision-chat.ts（缩放 JPEG → data URL → 一次 /chat/completions）。
 *
 * 纪律：
 * - path 必须是 static/ 下的现存图片文件，越界/不存在一律返回错误对象，不抛异常（工具抛错会打断整次运行）；
 * - 没有任何能看图的配置时返回 { unsupported: true, reason }，技能据此降级（例如要求人工填写语义标注）；
 * - expect_json=true 时解析首个 JSON 对象/数组，解析失败原样回文本并标 json_error；
 * - 每次调用把次数与 token 累加到当前文本任务的 params.vision_calls；没有任务上下文时只记日志。
 */
import fs from 'fs'
import path from 'path'
import { createTool } from '@mastra/core/tools'
import type { ToolExecutionContext } from '@mastra/core/tools'
import { z } from 'zod'
import { getAbsolutePath } from '../../utils/storage.js'
import { STORAGE_ROOT } from '../../utils/paths.js'
import { logTaskError, logTaskProgress, logTaskSuccess } from '../../utils/task-logger.js'
import { resolveVisionTextConfig } from '../../services/vision-capability.js'
import { callTextChat, imageContentPart } from '../../services/vision-chat.js'
import { parseTextTaskParams, patchTextTaskParams } from '../../services/text-task.js'
import { getTextTaskId } from '../context.js'
import { db, schema } from '../../db/index.js'
import { eq } from 'drizzle-orm'

/** 读图比纯文本慢得多，但也不能把整条 Agent 运行卡死：2 分钟 */
const READ_IMAGE_TIMEOUT_MS = 120_000
/** 实测 1600px / q85 的 JPEG 足以读出地图上的小字，再大只是 token */
export const READ_IMAGE_DEFAULT_MAX_SIDE = 1600
const READ_IMAGE_QUALITY = 85
const READ_IMAGE_MAX_TOKENS = 4096
/** 定位类问答必须稳定可复现，温度压到最低 */
const READ_IMAGE_TEMPERATURE = 0.1

const IMAGE_EXT: Record<string, true> = { '.jpg': true, '.jpeg': true, '.png': true, '.webp': true }

export interface ResolvedImagePath {
  /** 规范化后的仓库相对路径（static/ 开头） */
  relative: string
  absolute: string
}

/**
 * 路径白名单（纯函数，便于单测）：只认 static/ 下的现存图片文件。
 * 既挡 `../`、绝对路径、符号链接逃逸，也挡目录与非图片扩展名。
 */
export function resolveStaticImagePath(raw: unknown): ResolvedImagePath | { error: string } {
  const input = typeof raw === 'string' ? raw.trim() : ''
  if (!input) return { error: 'path 必填' }
  // 允许传入 /static/... 或 ./static/...（UI 上的 image_url 两种写法都有）
  const normalized = input.replace(/^\.?\//, '')
  if (!normalized.startsWith('static/')) {
    return { error: `只允许读取 static/ 下的图片，收到：${input}` }
  }
  if (normalized.split('/').includes('..')) {
    return { error: '路径不得包含 ..' }
  }
  const root = path.resolve(STORAGE_ROOT)
  const absolute = path.resolve(getAbsolutePath(normalized))
  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    return { error: '路径越界，不在 static/ 目录内' }
  }
  if (!IMAGE_EXT[path.extname(absolute).toLowerCase()]) {
    return { error: '只支持 jpg/jpeg/png/webp 图片' }
  }
  let stat: fs.Stats
  try {
    stat = fs.statSync(absolute)
  } catch {
    return { error: `图片不存在：${normalized}` }
  }
  if (!stat.isFile()) return { error: `不是文件：${normalized}` }
  return { relative: normalized, absolute }
}

/**
 * 从模型正文里取第一个 JSON 对象/数组（纯函数，便于单测）。
 * 模型常把 JSON 裹在 ```json 围栏或解释文字里，所以先剥围栏再截第一个 `{`/`[`。
 */
export function extractFirstJson(raw: string): { json: unknown } | { error: string } {
  const text = String(raw || '').replace(/```[a-z]*\s*|```/gi, '').trim()
  const starts = [text.indexOf('{'), text.indexOf('[')].filter(i => i >= 0)
  if (!starts.length) return { error: '返回内容里没有 JSON' }
  const start = Math.min(...starts)
  const close = text[start] === '{' ? '}' : ']'
  const end = text.lastIndexOf(close)
  if (end <= start) return { error: 'JSON 没有闭合' }
  try {
    return { json: JSON.parse(text.slice(start, end + 1)) }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'JSON 解析失败' }
  }
}

export interface VisionCallsMeter {
  count: number
  prompt_tokens: number
  completion_tokens: number
  model: string
}

/** 累加计量（纯函数，便于单测）：同一任务多次调用只记最后一次用的模型 */
export function accumulateVisionCalls(
  prev: unknown,
  add: { prompt_tokens: number; completion_tokens: number; model: string },
): VisionCallsMeter {
  const base = (prev && typeof prev === 'object' ? prev : {}) as Partial<VisionCallsMeter>
  return {
    count: (Number(base.count) || 0) + 1,
    prompt_tokens: (Number(base.prompt_tokens) || 0) + add.prompt_tokens,
    completion_tokens: (Number(base.completion_tokens) || 0) + add.completion_tokens,
    model: add.model,
  }
}

/** 把一次调用记进当前文本任务；没有任务上下文（或任务已不在）时只记日志 */
async function meter(taskId: number | null, add: { prompt_tokens: number; completion_tokens: number; model: string }) {
  if (!taskId) {
    logTaskProgress('VisionTool', 'read-image-unscoped', { model: add.model, promptTokens: add.prompt_tokens })
    return
  }
  const [row] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, taskId))
  if (!row) return
  const prev = parseTextTaskParams(row.params)?.vision_calls
  await patchTextTaskParams(taskId, { vision_calls: accumulateVisionCalls(prev, add) })
}

const READ_IMAGE_DESCRIPTION =
  'Read a local image (must be a path under static/, e.g. an asset image_url or an uploaded original) with a vision-capable text model and answer a question about it. '
  + 'Use it to find what is actually drawn in a map/diagram/photo (place names, labels, pixel boxes) before writing prompts or semantics. '
  + 'Returns { unsupported: true } when no vision-capable text config exists — then fall back to text-only reasoning and say so. '
  + 'Ask for concrete, verifiable facts (text labels and their pixel boxes); do NOT ask the model to trace polylines or polygons, it is unreliable. '
  + 'Any pixel coordinates in the answer are in the returned image.{width,height} frame (the resized image that was sent); '
  + 'image.source_width/source_height give the original size for rescaling.'

export const readImage = createTool({
  id: 'read_image',
  description: READ_IMAGE_DESCRIPTION,
  inputSchema: z.object({
    path: z.string().describe('图片路径，必须是 static/ 下的现存文件，例如 static/uploads/xxx.png'),
    question: z.string().describe('要问这张图什么；越具体越好（例如「列出图上可读的地名及其像素框」）'),
    max_side: z.number().int().min(256).max(2048).optional()
      .describe(`送进模型前把长边缩到多少像素，默认 ${READ_IMAGE_DEFAULT_MAX_SIDE}`),
    expect_json: z.boolean().optional().describe('为 true 时解析返回里的第一个 JSON；解析失败会原样回文本并标 json_error'),
  }),
  execute: async (input, context: ToolExecutionContext | undefined) => {
    const resolved = resolveStaticImagePath(input.path)
    if ('error' in resolved) {
      logTaskError('VisionTool', 'read-image-path', { path: String(input.path), error: resolved.error })
      return { error: resolved.error }
    }

    const config = await resolveVisionTextConfig()
    if (!config) {
      logTaskProgress('VisionTool', 'read-image-unsupported', { path: resolved.relative })
      return {
        unsupported: true as const,
        reason: '当前没有任何能看图的文本配置，无法读图；请改为按文字推断，或请人工填写。',
      }
    }

    const maxSide = input.max_side ?? READ_IMAGE_DEFAULT_MAX_SIDE
    const taskId = getTextTaskId(context?.requestContext)
    try {
      const prepared = await imageContentPart(resolved.relative, { maxSide, quality: READ_IMAGE_QUALITY })
      // 像素坐标只有带着尺寸口径才有意义：实测不告知缩放后尺寸时，模型按自己假想的画布给框，
      // 整体系统性偏移；明写「这是一张 W×H 的图」后框才落到字上。原图尺寸一并回传供换算。
      const framing = `这是一张 ${prepared.width}×${prepared.height} 像素的图片，`
        + `所有像素坐标都以这个尺寸为准（原点在左上角）。\n`
      const { text, usage } = await callTextChat(
        config,
        [{ type: 'text', text: framing + input.question }, prepared.part],
        { temperature: READ_IMAGE_TEMPERATURE, maxTokens: READ_IMAGE_MAX_TOKENS, timeoutMs: READ_IMAGE_TIMEOUT_MS },
      )
      await meter(taskId, {
        prompt_tokens: usage?.prompt_tokens ?? 0,
        completion_tokens: usage?.completion_tokens ?? 0,
        model: config.model,
      })
      logTaskSuccess('VisionTool', 'read-image', {
        path: resolved.relative, model: config.model, chars: text.length, maxSide,
      })

      const image = {
        width: prepared.width,
        height: prepared.height,
        source_width: prepared.sourceWidth,
        source_height: prepared.sourceHeight,
      }
      if (!input.expect_json) return { text, model: config.model, image }
      const parsed = extractFirstJson(text)
      if ('error' in parsed) return { text, model: config.model, image, json_error: parsed.error }
      return { json: parsed.json, model: config.model, image }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logTaskError('VisionTool', 'read-image', { path: resolved.relative, error: message })
      return { error: `读图失败：${message}` }
    }
  },
})

export const visionTools = { readImage }
