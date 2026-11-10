/**
 * 地图工作流的标注绘制阶段（Issue #90）：模型用矢量图层（LayerDoc）自己作图。
 *
 * 硬约束：模型预览、最终成图、人工在图层编辑器里修改后的重渲染，**全部走同一条渲染链**
 * （layer-doc.ts 严格校验 → layer-svg.ts → layer-render.ts renderLayerDoc）。
 * 代码不排版、不替模型改文档；交付的文档必须原样就是规范化结果，否则逐字段拒收。
 * 成图就是交付文档的确定性渲染，语义（点/线/面像素坐标）从同一份文档的锚定图层导出。
 */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { z } from 'zod'
import { STORAGE_ROOT } from '../../utils/paths.js'
import type { StageModel } from '../ai-stages.js'
import type { MapSpec } from '../map-base-render.js'
import { forwardFor, type MapBackgroundResult } from '../map-geometry.js'
import { strictLayerDocProblems, type LayerDoc } from '../layer-doc.js'
import { renderLayerDoc } from '../layer-render.js'
import { readImage } from '../../agents/tools/vision-tools.js'
import { mapBriefText, rollbackTool, runStageAgent, stageTool, type StageAgentResult } from './agent-loop.js'
import { drawingProblems, drawnGeometryOf, specFeatures, type DrawnGeometry, type OmittedFeature, type SpecFeature } from './validate.js'
import type { MapBrief } from './types.js'

const MAX_STEPS = 30

export interface RenderedMapDoc {
  /** `static/map-drawings/<sha>.png`：内容寻址，同一文档同一字节 */
  path: string
  sha256: string
  width: number
  height: number
}

/** 同一文档 → 同一字节 → 同一路径：模型预览、成图与人工保存共用这一个出口 */
export async function renderMapLayerDoc(doc: LayerDoc): Promise<RenderedMapDoc> {
  const rendered = await renderLayerDoc(doc)
  const sha256 = crypto.createHash('sha256').update(rendered.buffer).digest('hex')
  const dir = path.join(STORAGE_ROOT, 'map-drawings')
  fs.mkdirSync(dir, { recursive: true })
  const file = `${sha256.slice(0, 32)}.png`
  const absolute = path.join(dir, file)
  if (!fs.existsSync(absolute)) fs.writeFileSync(absolute, rendered.buffer)
  return { path: `static/map-drawings/${file}`, sha256, width: rendered.width, height: rendered.height }
}

/** 地图 LayerDoc 的底图必须就是本次合成的背景（路径与尺寸一致、不裁切：裁切会让语义像素坐标与画面错位） */
export function backgroundProblems(doc: LayerDoc, background: Pick<MapBackgroundResult, 'path' | 'width' | 'height'>): string[] {
  const problems: string[] = []
  if (doc.base.path !== background.path) problems.push(`base.path 必须是 ${JSON.stringify(background.path)}，当前是 ${JSON.stringify(doc.base.path)}`)
  if (doc.base.width !== background.width || doc.base.height !== background.height) {
    problems.push(`base.width/height 必须是 ${background.width}×${background.height}，当前是 ${doc.base.width}×${doc.base.height}`)
  }
  if (doc.base.crop) problems.push('地图底图不能裁切（base.crop）：裁切会让语义坐标与画面错位；需要改取景请回到底图阶段')
  return problems
}

export interface DrawingStageResult {
  doc: LayerDoc
  rendered: RenderedMapDoc
  geometry: DrawnGeometry
  omitted: OmittedFeature[]
}

export interface DrawingStageInput {
  propId: number
  taskId: number
  dramaId: number
  stageModel: StageModel
  brief: MapBrief
  spec: MapSpec
  background: MapBackgroundResult
  startRounds: number
  feedback: string | null
}

const round5 = (value: number) => Math.round(value * 100000) / 100000

export function docKey(doc: LayerDoc): string {
  return crypto.createHash('sha256').update(JSON.stringify(doc)).digest('hex')
}

export async function runDrawingStage(input: DrawingStageInput): Promise<StageAgentResult<DrawingStageResult>> {
  const { background } = input
  const features: SpecFeature[] = specFeatures(input.spec)
  const forward = forwardFor(background.registration)
  const toNormalized = (coord: [number, number]): [number, number] | null => {
    const px = forward(coord)
    return px ? [round5(px[0] / background.width), round5(px[1] / background.height)] : null
  }
  /** 渲染成功过的文档 → 渲染结果；交付的文档必须先预览过 */
  const renders = new Map<string, RenderedMapDoc>()
  const skeleton = {
    version: 1,
    base: { path: background.path, width: background.width, height: background.height, source_width: background.width, source_height: background.height },
    theme: input.brief.style,
    layers: [],
  }
  const featureLines = features.map(feature => `- id=${feature.id} ${feature.kind}「${feature.name}」→ 归一化坐标 ${
    JSON.stringify(feature.coords.map(toNormalized))}`)
  const checkDoc = (raw: unknown, omitted: unknown) => {
    const strict = strictLayerDocProblems(raw)
    const renderable = [
      ...strict.problems.map(problem => `${problem.path || '(文档)'}：${problem.message}`),
      ...backgroundProblems(strict.doc, background),
    ]
    const drawn = drawingProblems({ doc: strict.doc, features, registration: background.registration, omitted })
    return { doc: strict.doc, renderable, problems: [...renderable, ...drawn.problems], omitted: drawn.omitted }
  }

  return await runStageAgent<DrawingStageResult>({
    propId: input.propId,
    taskId: input.taskId,
    dramaId: input.dramaId,
    stage: 'drawing',
    stageModel: input.stageModel,
    skill: 'map-workflow/drawing',
    maxSteps: MAX_STEPS,
    startRounds: input.startRounds,
    initialFeedback: input.feedback,
    prompt: () => [
      '请用图层文档（LayerDoc）在下面的底图上画出这张历史地图：画什么、怎么画、标签放哪里都由你决定。'
        + '先 render_layer_doc 预览并用 read_image 检查成图，满意后用 submit_layer_doc 交付同一份文档。',
      mapBriefText(input.brief),
      `底图（已含质感底纹，LayerDoc 的 base 必须原样使用）：${background.path}，${background.width}×${background.height}`,
      `要素及其在底图上的归一化坐标（x 对宽、y 对高，已按底图登记件换算）：\n${featureLines.join('\n') || '（无）'}`,
      `起始文档骨架：\n${JSON.stringify(skeleton)}`,
    ].join('\n\n'),
    tools: (session) => ({
      geo_to_pixel: stageTool(session, {
        id: 'geo_to_pixel',
        description: '把经纬度换算成本底图上的归一化坐标 [x, y]（x 对宽、y 对高）。地平线之后不可见时返回 null。',
        inputSchema: z.object({ points: z.array(z.array(z.number())).describe('[[lon, lat], ...]') }),
        execute: async ({ points }) => ({
          normalized: points.map(point => (point.length === 2 ? toNormalized([point[0]!, point[1]!]) : null)),
        }),
      }),
      render_layer_doc: stageTool(session, {
        id: 'render_layer_doc',
        description: '用与成图、图层编辑器完全相同的渲染链渲染一份 LayerDoc（不消耗轮次）。文档必须原样合法（不会被修正）；'
          + '返回成图路径（可用 read_image 检查）以及按交付标准预检出的问题 submit_check。',
        inputSchema: z.object({
          layer_doc: z.record(z.string(), z.unknown()).describe('完整的 LayerDoc'),
          omitted: z.array(z.record(z.string(), z.unknown())).optional().describe('确实不画的要素：[{feature_id, reason}]'),
        }),
        execute: async ({ layer_doc, omitted }) => {
          const checked = checkDoc(layer_doc, omitted)
          if (checked.renderable.length) return { error: '文档不合法或底图不对，未渲染；请逐条修正', problems: checked.renderable }
          const rendered = await renderMapLayerDoc(checked.doc)
          renders.set(docKey(checked.doc), rendered)
          return {
            path: rendered.path,
            width: rendered.width,
            height: rendered.height,
            submit_check: checked.problems.length ? checked.problems : '按交付标准预检通过',
          }
        },
      }),
      read_image: readImage,
      submit_layer_doc: stageTool(session, {
        id: 'submit_layer_doc',
        description: '交付最终图层文档（消耗一轮）。必须是已经用 render_layer_doc 成功渲染过的同一份文档；任何问题都会被拒收并逐条说明。',
        inputSchema: z.object({
          layer_doc: z.record(z.string(), z.unknown()).describe('完整的 LayerDoc（与预览过的那份完全相同）'),
          omitted: z.array(z.record(z.string(), z.unknown())).optional().describe('确实不画的要素：[{feature_id, reason}]'),
        }),
        execute: async ({ layer_doc, omitted }) => {
          const checked = checkDoc(layer_doc, omitted)
          const rendered = checked.renderable.length ? undefined : renders.get(docKey(checked.doc))
          const problems = [...checked.problems]
          if (!checked.renderable.length && !rendered) problems.push('这份文档还没有用 render_layer_doc 成功渲染过：请先预览并用 read_image 检查成图，再交付同一份文档')
          return await session.deliver(problems, () => ({
            doc: checked.doc,
            rendered: rendered!,
            geometry: drawnGeometryOf(checked.doc, features),
            omitted: checked.omitted,
          }))
        },
      }),
      request_rollback: rollbackTool(session, { propId: input.propId, taskId: input.taskId }),
    }),
  })
}
