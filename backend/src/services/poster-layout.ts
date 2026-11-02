/**
 * Poster 文字图层（Issue #39）：布局归一化、变量渲染、文字说明生成。
 *
 * 坐标与字号都与图片尺寸无关（0..1 比例），因此同一份布局可用于预览、
 * 任意分辨率的本地合成与二次生成的文字说明。
 * 变量框只存 kind，内容由剧集数据现场渲染，服务端不接受自定义内容。
 */
import { z } from 'zod'

export const POSTER_VARIABLE_KINDS = ['project_title', 'episode_title', 'episode_no'] as const
export type PosterVariableKind = (typeof POSTER_VARIABLE_KINDS)[number]
export type PosterBoxKind = 'text' | PosterVariableKind

export const POSTER_FONT_FAMILIES = ['sans', 'serif', 'kai', 'hand'] as const
export type PosterFontFamily = (typeof POSTER_FONT_FAMILIES)[number]

export const POSTER_ALIGNS = ['left', 'center', 'right'] as const
export type PosterAlign = (typeof POSTER_ALIGNS)[number]

export interface PosterTextBox {
  id: string
  kind: PosterBoxKind
  text: string
  /** 左边界（0..1） */
  x: number
  /** 上边界（0..1） */
  y: number
  /** 文本框宽度（0..1），用于换行与对齐 */
  width: number
  /** 字号 = 图片高度的比例 */
  fontSize: number
  fontFamily: PosterFontFamily
  color: string
  bold: boolean
  italic: boolean
  strokeColor: string
  /** 描边宽度 = 字号的比例 */
  strokeWidth: number
  shadow: boolean
  align: PosterAlign
}

export interface PosterLayout {
  texts: PosterTextBox[]
}

export interface PosterVariables {
  project_title: string
  episode_title: string
  episode_no: string
}

export const POSTER_MAX_BOXES = 40
const TEXT_MAX = 300
const COLOR_MAX = 32

function isPosterVariableKind(value: unknown): value is PosterVariableKind {
  return typeof value === 'string' && (POSTER_VARIABLE_KINDS as readonly string[]).includes(value)
}

const boundedNumber = (min: number, max: number, fallback: number) =>
  z.preprocess(
    value => {
      const num = typeof value === 'number' ? value : Number(value)
      return Number.isFinite(num) ? num : fallback
    },
    z.number().transform(value => Math.min(max, Math.max(min, value))),
  )

const clippedText = (max: number, fallback = '') =>
  z.preprocess(
    value => (typeof value === 'string' ? value.slice(0, max).trim() || fallback : fallback),
    z.string(),
  )

const booleanWithDefault = (fallback: boolean) =>
  z.preprocess(value => (typeof value === 'boolean' ? value : fallback), z.boolean())

const posterTextBoxSchema = z.object({
  id: clippedText(64),
  kind: z.preprocess(
    value => (isPosterVariableKind(value) ? value : 'text'),
    z.enum(['text', 'project_title', 'episode_title', 'episode_no']),
  ),
  text: clippedText(TEXT_MAX),
  x: boundedNumber(0, 1, 0.1),
  y: boundedNumber(0, 1, 0.1),
  width: boundedNumber(0.05, 1, 0.8),
  fontSize: boundedNumber(0.02, 0.4, 0.08),
  fontFamily: z.preprocess(
    value => ((POSTER_FONT_FAMILIES as readonly string[]).includes(String(value)) ? value : 'sans'),
    z.enum(['sans', 'serif', 'kai', 'hand']),
  ),
  color: clippedText(COLOR_MAX, '#ffffff'),
  bold: booleanWithDefault(true),
  italic: booleanWithDefault(false),
  strokeColor: clippedText(COLOR_MAX, '#000000'),
  strokeWidth: boundedNumber(0, 0.12, 0.03),
  shadow: booleanWithDefault(true),
  align: z.preprocess(
    value => ((POSTER_ALIGNS as readonly string[]).includes(String(value)) ? value : 'center'),
    z.enum(['left', 'center', 'right']),
  ),
})

const posterLayoutSchema = z.object({
  texts: z.array(z.unknown()).catch([]),
})

/**
 * 解析并归一化布局：字段白名单 + 范围裁剪；变量框内容强制清空，只保留 kind。
 * 非法条目单独跳过（与前端同口径），非法整体输入退化为空布局。
 */
export function normalizePosterLayout(raw: unknown): PosterLayout {
  let input = raw
  if (typeof raw === 'string') {
    try {
      input = JSON.parse(raw)
    } catch {
      return { texts: [] }
    }
  }
  const parsed = posterLayoutSchema.safeParse(input)
  if (!parsed.success) return { texts: [] }
  const texts: PosterTextBox[] = []
  parsed.data.texts.slice(0, POSTER_MAX_BOXES).forEach((item, index) => {
    const box = posterTextBoxSchema.safeParse(item)
    if (!box.success) return
    texts.push({
      ...box.data,
      text: box.data.kind === 'text' ? box.data.text : '',
      id: box.data.id || `box-${index + 1}`,
    })
  })
  return { texts }
}

/** 单个框的实际文本：变量框按剧集数据渲染，普通文本用自身内容。 */
export function resolveBoxText(box: PosterTextBox, vars: PosterVariables): string {
  if (box.kind === 'text') return box.text
  return vars[box.kind] || ''
}

/** 布局内所有非空文本（按图层顺序）。 */
export function resolveTexts(layout: PosterLayout, vars: PosterVariables): string[] {
  return layout.texts
    .map(box => resolveBoxText(box, vars).trim())
    .filter(Boolean)
}

/**
 * 二次生成的文字说明。只描述「必须原样呈现的文字」，不重复画面风格；
 * 没有文字时返回空串（调用方不加分隔符）。
 */
export function buildPosterTextInstruction(layout: PosterLayout, vars: PosterVariables): string {
  const texts = resolveTexts(layout, vars)
  if (!texts.length) return ''
  const lines = texts.map(value => `- ${JSON.stringify(value)}`)
  return [
    'The poster contains the following text elements. Render them exactly as written, keep every character and punctuation unchanged, do not translate, and do not invent any additional text:',
    ...lines,
  ].join('\n')
}
