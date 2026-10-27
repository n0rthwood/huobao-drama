/**
 * 任务编号与 @引用渲染的纯函数（不碰数据库，便于单测）。
 *
 * 编号（用户确认 2026-10-27）：
 *   分镜任务 `《剧名》E02-#05 · 尾帧 / 中间帧 / 首帧 / 视频`
 *   资产出图 `《剧名》· 角色|场景|道具 · <名字>`
 *   集级文本/批次/导出 `《剧名》E02 · 拆分分镜 / 关键帧批量 / 视频批量 / 导出合成`
 */
import type { TextTaskKind } from './text-task.js'

export type TaskTargetKind = 'storyboard' | 'character' | 'scene' | 'prop' | 'episode'

const FRAME_LABEL: Record<string, string> = {
  first_frame: '首帧',
  mid_frame: '中间帧',
  last_frame: '尾帧',
}

const TEXT_KIND_LABEL: Record<TextTaskKind, string> = {
  extract_characters: '提取角色',
  extract_scenes: '提取场景',
  extract_props: '提取道具',
  keyframe_prompts: '关键帧提示词',
  video_prompts: '视频提示词',
  script_rewrite: '剧本改写',
  storyboard_breaker: '拆分分镜',
}

const ASSET_KIND_LABEL: Record<string, string> = {
  character: '角色',
  scene: '场景',
  prop: '道具',
}

export interface TaskLabelInput {
  type: string
  dramaTitle?: string | null
  episodeNumber?: number | null
  storyboardNumber?: number | null
  frameType?: string | null
  kind?: string | null
  targetKind?: TaskTargetKind | null
  targetName?: string | null
}

/**
 * 集级编号：`《剧名》E02 · <后缀>`，批次/导出/文本任务共用。
 * 剧名缺失用占位、集号缺失则整段省略。
 */
export function composeEpisodeLabel(dramaTitle: string | null | undefined, episodeNumber: number | null | undefined, suffix: string): string {
  const drama = `《${(dramaTitle || '').trim() || '未命名剧集'}》`
  const episode = episodeNumber != null ? `E${String(episodeNumber).padStart(2, '0')} ` : ''
  return `${drama}${episode}· ${suffix}`
}

/** 任务编号：缺失的部分自动省略，始终返回可展示的字符串 */
export function composeTaskLabel(input: TaskLabelInput): string {
  const drama = `《${(input.dramaTitle || '').trim() || '未命名剧集'}》`
  const episode = input.episodeNumber != null ? `E${String(input.episodeNumber).padStart(2, '0')}` : ''

  if (input.targetKind === 'storyboard') {
    const shot = input.storyboardNumber != null ? `#${String(input.storyboardNumber).padStart(2, '0')}` : ''
    const head = [episode, shot].filter(Boolean).join('-')
    const suffix = input.type === 'video'
      ? '视频'
      : FRAME_LABEL[input.frameType || ''] || '图片'
    return `${drama}${head ? `${head} ` : ''}· ${suffix}`
  }

  if (input.type === 'text') {
    return composeEpisodeLabel(input.dramaTitle, input.episodeNumber, TEXT_KIND_LABEL[input.kind as TextTaskKind] || '文本任务')
  }

  const assetLabel = ASSET_KIND_LABEL[input.targetKind || '']
  if (assetLabel) return `${drama}· ${assetLabel} · ${(input.targetName || '').trim() || '未命名'}`

  return `${drama}${episode ? `${episode} ` : ''}· ${input.type === 'video' ? '视频' : '图片'}`
}

/**
 * 换厂商重试时按新 provider 重新渲染 @名字 引用。
 * 图片：qwen-jobs（Qwen Image 2.1）用 `<imageN>名字`，其它厂商退化成 `图片N名字`；
 * 视频：统一 `@图片N名字`（与 storyboard-video.ts 同口径）。
 * 名字按长度倒序匹配，避免“鼠妈”抢在“鼠妈妈”前面命中；未知 @引用原样保留。
 */
export function renderRefPrompt(
  sourcePrompt: string,
  refNameIndex: Record<string, number>,
  opts: { type: 'image' | 'video'; provider: string | null | undefined },
): string {
  const names = Object.keys(refNameIndex).sort((a, b) => b.length - a.length)
  if (!names.length) return sourcePrompt
  const isQwen = (opts.provider || '').toLowerCase() === 'qwen-jobs'
  const format = (index: number, name: string) => {
    if (opts.type === 'video') return `@图片${index}${name}`
    return isQwen ? `<image${index}>${name}` : `图片${index}${name}`
  }
  let out = ''
  for (let i = 0; i < sourcePrompt.length;) {
    if (sourcePrompt[i] !== '@') {
      out += sourcePrompt[i]
      i++
      continue
    }
    const rest = sourcePrompt.slice(i + 1)
    const hit = names.find(name => rest.startsWith(name))
    if (!hit) {
      out += sourcePrompt[i]
      i++
      continue
    }
    out += format(refNameIndex[hit], hit)
    i += 1 + hit.length
  }
  return out
}
