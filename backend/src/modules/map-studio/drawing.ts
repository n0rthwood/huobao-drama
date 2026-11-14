/** Map Studio drawing harness: geometry stays server-side; models edit a validated draft with small tools. */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { z } from 'zod'
import { STORAGE_ROOT } from '../../utils/paths.js'
import type { StageModel } from '../../services/ai-stages.js'
import type { Layer, LayerDoc } from '../../services/layer-doc.js'
import { renderLayerDoc } from '../../services/layer-render.js'
import { readImage } from '../../agents/tools/vision-tools.js'
import type { MapSpec } from './geo/base-render.js'
import { forwardFor, type MapBackgroundResult } from './geo/geometry.js'
import { mapBriefText, rollbackTool, runStageAgent, stageTool, type StageAgentResult } from './agent-loop.js'
import { drawingProblems, drawnGeometryOf, projectedLabelFeatures, specFeatures, type DrawnGeometry, type OmittedFeature, type SpecFeature } from './validate.js'
import { autoPlaceLabels } from './layout/labels.js'
import { strictMapLayerDocProblems } from './layer-doc.js'
import { defaultLayerOptions, renderCopyWithSmoothing, smoothingProblems, validateLayerOptions, type LayerOptions } from './render/smooth.js'
import type { MapBrief } from './types.js'
import { featureStyleFor, labelStyleFor, familyPromptSummary, resolveMapStyle, MAP_LABEL_TIERS, MAP_MARKER_TIERS } from './styles/index.js'
import { readDefaultStyle } from './settings.js'

const MAX_STEPS = 60
export interface RenderedMapDoc { path: string; sha256: string; width: number; height: number }

/** No normalizer here: the module's validated dense dataset vertices must all reach layer-svg. */
export async function renderMapLayerDoc(doc: LayerDoc, layerOptions: LayerOptions = {}): Promise<RenderedMapDoc> {
  const problems = smoothingProblems(doc, layerOptions)
  if (problems.length) throw new Error(problems.map(p => p.message).join('；'))
  const rendered = await renderLayerDoc(renderCopyWithSmoothing(doc, layerOptions))
  const sha256 = crypto.createHash('sha256').update(rendered.buffer).digest('hex')
  const dir = path.join(STORAGE_ROOT, 'map-drawings')
  fs.mkdirSync(dir, { recursive: true })
  const file = `${sha256.slice(0, 32)}.png`
  const absolute = path.join(dir, file)
  if (!fs.existsSync(absolute)) fs.writeFileSync(absolute, rendered.buffer)
  return { path: `static/map-drawings/${file}`, sha256, width: rendered.width, height: rendered.height }
}

export function backgroundProblems(doc: LayerDoc, background: Pick<MapBackgroundResult, 'path' | 'width' | 'height'>): string[] {
  const problems: string[] = []
  if (doc.base.path !== background.path) problems.push(`base.path 必须是 ${JSON.stringify(background.path)}，当前是 ${JSON.stringify(doc.base.path)}`)
  if (doc.base.width !== background.width || doc.base.height !== background.height) problems.push(`base.width/height 必须是 ${background.width}×${background.height}，当前是 ${doc.base.width}×${doc.base.height}`)
  if (doc.base.crop) problems.push('地图底图不能裁切（base.crop）：需要改取景请回到底图阶段')
  return problems
}

export interface DrawingStageResult { doc: LayerDoc; rendered: RenderedMapDoc; geometry: DrawnGeometry; omitted: OmittedFeature[]; layerOptions: LayerOptions }
export interface DrawingStageInput {
  taskId: number; runId: number; stageModel: StageModel; brief: MapBrief; spec: MapSpec; background: MapBackgroundResult
  startRounds: number; feedback: string | null; layerOptions?: LayerOptions
  /** Family selection is resolved from brief + module settings, never an arbitrary style recipe. */
}
export function docKey(doc: LayerDoc, layerOptions: LayerOptions = {}): string {
  return crypto.createHash('sha256').update(JSON.stringify({ doc, layerOptions })).digest('hex')
}

/** Options chosen in the geo editor before drawing are resolved onto the resulting layer ids. */
export function optionsForDrawing(doc: LayerDoc, features: SpecFeature[], stored: LayerOptions = {}): LayerOptions {
  const options = defaultLayerOptions(doc, features)
  for (const layer of doc.layers) {
    if (layer.type !== 'polygon' && layer.type !== 'polyline') continue
    const explicit = stored[layer.id] ?? (layer.anchor?.semantic_id ? stored[layer.anchor.semantic_id] : undefined)
    if (explicit) options[layer.id] = { ...explicit }
  }
  return options
}

/** Tool responses deliberately contain bbox/counts instead of the hundreds of stored vertices. */
export function drawingDraftSummary(doc: LayerDoc, layerOptions: LayerOptions, includePoints = false) {
  return { version: doc.version, base: doc.base, theme: doc.theme, layer_options: layerOptions, layers: doc.layers.map(layer => {
    if (layer.type !== 'polygon' && layer.type !== 'polyline' && layer.type !== 'marker') return layer
    const points = layer.type === 'marker' ? [layer.at] : layer.points
    const xs = points.map(p => p[0] * doc.base.width), ys = points.map(p => p[1] * doc.base.height)
    const common = { ...layer, pixel_bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], vertex_count: points.length }
    if (includePoints && !layer.anchor?.semantic_id) return common
    if ('points' in common) { const { points: _points, ...small } = common; return small }
    const { at: _at, ...small } = common
    return small
  }) }
}

export async function runDrawingStage(input: DrawingStageInput): Promise<StageAgentResult<DrawingStageResult>> {
  const { background } = input
  const selectedStyle = resolveMapStyle(input.spec.style.map_style ? { map_style: input.spec.style.map_style } : input.brief, { default_style: readDefaultStyle() })
  const features = specFeatures(input.spec)
  const forward = forwardFor(background.registration)
  const projectedFeatures = projectedLabelFeatures(features, background.registration)
  let draft: LayerDoc = { version: 1, base: { path: background.path, width: background.width, height: background.height, source_width: background.width, source_height: background.height }, theme: selectedStyle?.theme ?? input.brief.style, layers: [] }
  let layerOptions: LayerOptions = {}
  /** 最近一次检查（render_draft 的 submit_check / submit_draft 的 problems）：压缩后仍要在状态消息里可见 */
  let lastCheck: string[] = []
  const renders = new Map<string, RenderedMapDoc>()
  const checkDraft = (omitted: unknown) => {
    const strict = strictMapLayerDocProblems(draft, { features, registration: background.registration })
    const renderable = [...strict.problems.map(p => `${p.path}：${p.message}`), ...backgroundProblems(draft, background), ...smoothingProblems(draft, layerOptions).map(p => p.message)]
    const drawn = drawingProblems({ doc: draft, features, registration: background.registration, omitted, layerOptions })
    return { renderable, problems: [...renderable, ...drawn.problems], omitted: drawn.omitted }
  }
  /**
   * 草稿修改只回报变化的图层：完整图层清单每步都在「当前状态」消息里。
   * 生产 run 11：每次 add_label/update_layer 回整份草稿（约 1.8 万字），一步并行 4–6 个调用，
   * 压缩窗口内的三步就累积到 24 万字。
   */
  const acceptDraft = (next: LayerDoc) => {
    const sorted = { ...next, layers: [...next.layers].sort((a, b) => a.z - b.z) }
    const strict = strictMapLayerDocProblems(sorted, { features, registration: background.registration })
    if (strict.problems.length) return { error: '草稿修改被拒，原草稿保留', problems: strict.problems }
    const before = new Map(draft.layers.map(layer => [layer.id, JSON.stringify(layer)]))
    draft = strict.doc
    layerOptions = optionsForDrawing(draft, features, { ...input.layerOptions, ...layerOptions })
    const changedIds = new Set(draft.layers.filter(layer => before.get(layer.id) !== JSON.stringify(layer)).map(layer => layer.id))
    const removed = [...before.keys()].filter(id => !draft.layers.some(layer => layer.id === id))
    return {
      ok: true,
      layer_count: draft.layers.length,
      changed: drawingDraftSummary(draft, layerOptions).layers.filter(layer => changedIds.has(layer.id)),
      removed,
    }
  }
  /** 草稿类工具的压缩摘要：只说层数，不复述整份草稿 */
  const draftStatus = (result: Record<string, unknown>): string =>
    typeof result.layer_count === 'number' ? `草稿 ${result.layer_count} 层` : '草稿未变'
  const featureSummary = features.map(feature => {
    const p = projectedFeatures.find(f => f.id === feature.id)!
    const xs = p.points.map(point => point[0] * background.width), ys = p.points.map(point => point[1] * background.height)
    return { feature_id: feature.id, kind: feature.kind, category: feature.category, name: feature.name, origin: feature.origin, vertex_count: p.points.length, pixel_bbox: xs.length ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] : null }
  })
  return await runStageAgent<DrawingStageResult>({
    taskId: input.taskId, runId: input.runId, stage: 'drawing', stageModel: input.stageModel, skill: 'drawing', maxSteps: MAX_STEPS, startRounds: input.startRounds, initialFeedback: input.feedback,
    prompt: () => [
      '用服务器草稿作图。用 add_feature_layers 按 feature_id 精确投影要素，绝不抄写或提交要素顶点。用 add_layer/update_layer 添加标题及标注，auto_layout_labels 排布，render_draft 预览并 read_image 检查，然后 submit_draft 交付同一草稿。',
      mapBriefText(input.brief), `底图：${background.path}，${background.width}×${background.height}`,
      `要素摘要（不传顶点）：\n${JSON.stringify(featureSummary)}`,
      ...(selectedStyle ? [familyPromptSummary(selectedStyle.family)] : []),
    ].join('\n\n'),
    state: () => {
      // 状态消息每一步都重发：只列 id/类型/锚定要素/像素 bbox/点数（见契约 §1），不含顶点与样式
      const layers = drawingDraftSummary(draft, layerOptions).layers.map(layer => ({
        id: layer.id,
        type: layer.type,
        z: layer.z,
        visible: layer.visible,
        anchor: 'anchor' in layer && layer.anchor ? layer.anchor.semantic_id : null,
        pixel_bbox: 'pixel_bbox' in layer ? layer.pixel_bbox : null,
        vertex_count: 'vertex_count' in layer ? layer.vertex_count : null,
      }))
      return [
        `当前草稿（不含顶点）：${JSON.stringify({ version: draft.version, layers, layer_options: layerOptions })}`,
        `最近一次检查问题：${lastCheck.length ? lastCheck.join('；') : '（尚无检查记录；先 render_draft 预览）'}`,
      ].join('\n')
    },
    tools: session => ({
      add_feature_layers: stageTool(session, {
        id: 'add_feature_layers', description: '按 feature_id 将存储的地理几何精确投影并加入草稿。点/线/面自动对应 marker/polyline/polygon，数据集断段已有独立 feature_id；只传 id 与样式，不传点。重复添加拒收，返回图层 id、像素 bbox 与顶点数。',
        inputSchema: z.object({ items: z.array(z.object({ feature_id: z.string(), style: z.record(z.string(), z.unknown()).optional(), importance: z.enum(MAP_MARKER_TIERS).optional() })) }),
        summarize: draftStatus,
        execute: async ({ items }) => {
          const next = { ...draft, layers: [...draft.layers] }
          const problems: string[] = []
          for (const item of items) {
            const feature = features.find(f => f.id === item.feature_id)
            if (!feature) { problems.push(`未知 feature_id ${item.feature_id}`); continue }
            if (next.layers.some(l => l.anchor?.semantic_id === feature.id && ['marker', 'polygon', 'polyline'].includes(l.type))) { problems.push(`要素 ${feature.id} 已有几何图层，使用 update_layer 修改样式`); continue }
            const points = feature.coords.map(coord => {
              const pixel = forward(coord)
              return pixel ? [pixel[0] / background.width, pixel[1] / background.height] as [number, number] : null
            })
            if (points.some(p => !p)) { problems.push(`要素 ${feature.id} 在当前底图不可见，请回退 base`); continue }
            const coords = points as [number, number][]
            const id = feature.id.length <= 56 ? `feature-${feature.id}` : `feature-${crypto.createHash('sha256').update(feature.id).digest('hex').slice(0, 32)}`
            const defaults = selectedStyle ? featureStyleFor(selectedStyle.family, { ...feature, markerTier: item.importance }) : {}
            const common = { id, name: feature.name, visible: true, locked: false, z: next.layers.length, opacity: 1, rotation: 0, anchor: { semantic_id: feature.id, semantic_name: feature.name }, style: { ...defaults, ...item.style } }
            next.layers.push(feature.kind === 'place' ? { ...common, type: 'marker', at: coords[0]!, text: feature.name } : { ...common, type: feature.kind === 'region' ? 'polygon' : 'polyline', points: coords })
          }
          return problems.length ? { error: '未修改草稿', problems } : acceptDraft(next)
        },
      }),
      add_label: stageTool(session, {
        id: 'add_label', description: '按主题档位添加标题/区域/城市/河流/说明标签，不必逐层手写样式。box 是归一化位置尺寸；feature_id 可锚定要素，style 可覆盖主题。',
        inputSchema: z.object({ tier: z.enum(MAP_LABEL_TIERS), text: z.string(), box: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }), feature_id: z.string().optional(), style: z.record(z.string(), z.unknown()).optional() }),
        summarize: draftStatus,
        execute: async ({ tier, text, box, feature_id, style }) => {
          const feature = feature_id ? features.find(item => item.id === feature_id) : undefined
          if (feature_id && !feature) return { error: `未知 feature_id ${feature_id}` }
          let index = draft.layers.length + 1
          while (draft.layers.some(layer => layer.id === `theme-${tier}-${index}`)) index++
          const layer: Layer = { id: `theme-${tier}-${index}`, type: 'label', name: text.slice(0, 60) || tier, text, box, visible: true, locked: false, z: Math.min(9999, Math.max(0, ...draft.layers.map(item => item.z)) + 1), opacity: 1, rotation: 0, style: { ...(selectedStyle ? labelStyleFor(selectedStyle.family, tier) : {}), ...style }, ...(feature ? { anchor: { semantic_id: feature.id, semantic_name: feature.name } } : {}) }
          return acceptDraft({ ...draft, layers: [...draft.layers, layer] })
        },
      }),
      add_layer: stageTool(session, {
        id: 'add_layer', description: '新增非要素图层：标签/标题/card/图例/画框。layer 必须写全合法 LayerDoc 字段；手写形状最多200点，不能冒充锚定的要素几何。',
        inputSchema: z.object({ layer: z.record(z.string(), z.unknown()) }),
        summarize: draftStatus,
        execute: async ({ layer }) => {
          if (Array.isArray(layer.points) && layer.points.length > 200) return { error: '手写图层最多200点；要素几何使用 add_feature_layers' }
          if (layer.anchor && typeof layer.anchor === 'object' && 'semantic_id' in layer.anchor && ['marker', 'polygon', 'polyline'].includes(String(layer.type))) return { error: '要素几何只能用 add_feature_layers 添加' }
          const strict = strictMapLayerDocProblems({ ...draft, layers: [...draft.layers, layer] }, { features, registration: background.registration })
          return strict.problems.length ? { error: '图层非法，草稿保留', problems: strict.problems } : acceptDraft(strict.doc)
        },
      }),
      update_layer: stageTool(session, {
        id: 'update_layer', description: '小补丁更新 style/box/text/name/z/visible/opacity/rotation/fields，style 合并。锚定要素不能改 points/at 或旋转；非要素小形状可改 points/at（最多200点）。id/type/anchor 不可改。',
        inputSchema: z.object({ layer_id: z.string(), patch: z.record(z.string(), z.unknown()) }),
        summarize: draftStatus,
        execute: async ({ layer_id, patch }) => {
          const layer = draft.layers.find(l => l.id === layer_id)
          if (!layer) return { error: `未知 layer_id ${layer_id}` }
          const allowed = ['style', 'box', 'text', 'name', 'z', 'visible', 'opacity', 'rotation', 'fields']
          const geographic = layer.anchor?.semantic_id && ['marker', 'polygon', 'polyline'].includes(layer.type)
          if (!geographic && (layer.type === 'polygon' || layer.type === 'polyline')) allowed.push('points')
          if (!geographic && layer.type === 'marker') allowed.push('at')
          if (Array.isArray(patch.points) && patch.points.length > 200) return { error: '非要素形状最多200点，原草稿保留' }
          const unsupported = Object.keys(patch).filter(k => !allowed.includes(k))
          if (unsupported.length) return { error: `不允许修改 ${unsupported.join('、')}；要素几何不得改写` }
          const next = { ...layer, ...patch, ...('style' in layer && patch.style && typeof patch.style === 'object' && !Array.isArray(patch.style) ? { style: { ...layer.style, ...patch.style } } : {}) }
          return acceptDraft({ ...draft, layers: draft.layers.map(l => l.id === layer_id ? next as Layer : l) })
        },
      }),
      remove_layer: stageTool(session, {
        id: 'remove_layer', description: '删除指定图层；必须绘制的要素仍须补回或在 submit_draft.omitted 写理由。', inputSchema: z.object({ layer_id: z.string() }),
        summarize: draftStatus,
        execute: async ({ layer_id }) => draft.layers.some(l => l.id === layer_id) ? acceptDraft({ ...draft, layers: draft.layers.filter(l => l.id !== layer_id) }) : { error: `未知 layer_id ${layer_id}` },
      }),
      get_draft: stageTool(session, {
        id: 'get_draft', description: '读取草稿摘要。要素几何永远只返回 bbox 和点数，不输出顶点；include_points 只影响手写的非要素小形状。', inputSchema: z.object({ include_points: z.boolean().optional() }),
        summarize: result => `草稿 ${Array.isArray(result.layers) ? result.layers.length : 0} 层（完整摘要见当前状态）`,
        execute: async ({ include_points }) => drawingDraftSummary(draft, layerOptions, include_points === true),
      }),
      set_smoothing: stageTool(session, {
        id: 'set_smoothing', description: '设置线面渲染平滑强度 smooth=0..1。0关，数据集默认0，其余默认1；超偏离需你明确调低，代码不自动改强度。原始点不变。', inputSchema: z.object({ layer_id: z.string(), smooth: z.number() }),
        execute: async ({ layer_id, smooth }) => {
          const parsed = validateLayerOptions({ [layer_id]: { smooth } }, draft)
          if (parsed.problems.length) return { error: '平滑参数非法', problems: parsed.problems }
          layerOptions = { ...layerOptions, ...parsed.options }
          return { layer_id, smooth, problems: smoothingProblems(draft, layerOptions) }
        },
      }),
      auto_layout_labels: stageTool(session, {
        id: 'auto_layout_labels', description: '在当前草稿自动排布标签，不动标题/card，不删除、不缩字。返回 unresolved；完成后仍须 render_draft 看图。', inputSchema: z.object({}),
        summarize: result => `排布后 ${draftStatus(result)}，unresolved ${Array.isArray(result.unresolved) ? result.unresolved.length : 0} 项，${Array.isArray(result.problems) ? result.problems.length : 0} 个问题`,
        execute: async () => {
          const placed = autoPlaceLabels(draft, draft.base, projectedFeatures)
          const accepted = acceptDraft(placed.doc)
          const problems = checkDraft([]).problems
          lastCheck = problems
          return { ...accepted, unresolved: placed.unresolved, problems }
        },
      }),
      render_draft: stageTool(session, {
        id: 'render_draft', description: '用最终渲染链预览当前草稿，不消耗轮次；返回成图路径和 submit_check。用 read_image 自检。', inputSchema: z.object({}),
        summarize: result => {
          const problems = Array.isArray(result.submit_check) ? result.submit_check : []
          return problems.length
            ? `预览 ${String(result.path)}，submit_check ${problems.length} 个问题：${problems.slice(0, 3).map(String).join('；')}`
            : `预览 ${String(result.path)}，submit_check 预检通过`
        },
        execute: async () => {
          const checked = checkDraft([])
          if (checked.renderable.length) return { error: '草稿或平滑参数非法，未渲染', problems: checked.renderable }
          const rendered = await renderMapLayerDoc(draft, layerOptions)
          renders.set(docKey(draft, layerOptions), rendered)
          lastCheck = checked.problems
          return { ...rendered, submit_check: checked.problems.length ? checked.problems : '按交付标准预检通过' }
        },
      }),
      submit_draft: stageTool(session, {
        id: 'submit_draft', description: '交付已预览且未改动的当前草稿，消耗一轮；未解决的几何/平滑/标签问题均拒收。', inputSchema: z.object({ omitted: z.array(z.record(z.string(), z.unknown())).optional() }),
        summarize: result => result.accepted === true
          ? `第 ${String(result.round)} 轮交付已接受`
          : `第 ${String(result.round)} 轮交付被拒收，${Array.isArray(result.problems) ? result.problems.length : 0} 个问题（见当前状态）`,
        execute: async ({ omitted }) => {
          const checked = checkDraft(omitted)
          const rendered = renders.get(docKey(draft, layerOptions))
          if (!rendered) checked.problems.push('当前草稿还没有用 render_draft 成功渲染过，请先预览并 read_image 检查')
          lastCheck = checked.problems
          return session.deliver(checked.problems, () => ({ doc: draft, layerOptions, rendered: rendered!, geometry: drawnGeometryOf(renderCopyWithSmoothing(draft, layerOptions), features), omitted: checked.omitted }))
        },
      }),
      read_image: readImage,
      request_rollback: rollbackTool(session, { taskId: input.taskId, runId: input.runId }),
    }),
  })
}
