/**
 * 地图工作流的底图阶段（Issue #90）：路线、取景（bbox / 投影）与图层参数全部由模型决定。
 *
 * 代码只提供三条底图路线的真实生产工具（程序底图 / 外部图配准 / Google Earth 标定截图），
 * 并在交付时校验：每个要素都在画内（留边）、要素整体占画面主体、登记件合法。
 * Earth 标定门槛（≤3px、漂移 ≤0.25px）在生产工具内部执行，失败作为工具错误回给模型，不放宽。
 * 已有 map_spec.bbox 只是模型可见的参考，不构成约束。
 */
import { z } from 'zod'
import type { StageModel } from '../../services/ai-stages.js'
import { normalizeMapSpec, canvasForAspect, type MapSpec } from './geo/base-render.js'
import { createMapBaseArtifact, type MapBaseArtifact, type MapBaseMode } from './geo/geometry.js'
import { readImage } from '../../agents/tools/vision-tools.js'
import { mapBriefText, rollbackTool, runStageAgent, stageTool, type StageAgentResult } from './agent-loop.js'
import { frameReport, specFeatures, FRAME_MARGIN, FRAME_MIN_EXTENT } from './validate.js'
import { MAP_BASE_MODES, type MapBrief } from './types.js'
import type { MapStudioContext } from './contract.js'
import { validateFrames, type MapPipOutput } from './pip/frames.js'
import { chooseLayoutId, layoutFor } from './pip/layouts.js'
import { pipUsageText } from './pip/usage.js'
import { resolveMapStyle, familyPromptSummary } from './styles/index.js'

/** 底图长边像素；画幅由项目参数决定（缺省 16:9） */
export const MAP_BASE_LONG_SIDE = 3840
const MAX_STEPS = 24

function contextText(context: MapStudioContext | null): string {
  if (!context || !context.shots.length) return ''
  const lines = context.shots.slice(0, 40).map(shot => {
    const points = shot.info_points.slice(0, 3).join('；')
    const marks = shot.must_mark.slice(0, 4).join('、')
    return `- 分镜 #${shot.number}：${shot.narration.slice(0, 90)}${points ? `｜信息点：${points}` : ''}${marks ? `｜必标：${marks}` : ''}`
  })
  return `引用这张地图的分镜（${context.shots.length} 个；据此决定全览范围，并用 set_frames 为反复强调、需要看清地理特征的位置设细节框）：\n${lines.join('\n')}`
}

export interface BaseStageResult {
  artifact: MapBaseArtifact
  mode: MapBaseMode
  /** 模型选定的取景：采用时写回 map_spec */
  spec: MapSpec
  /** 模型按分镜重点提出的细节框方案（已校验；无细节时为 null） */
  pip: MapPipOutput | null
}

export interface BaseStageInput {
  taskId: number
  runId: number
  stageModel: StageModel
  brief: MapBrief
  spec: MapSpec
  startRounds: number
  feedback: string | null
  /** 引用这张地图的分镜信息（宿主提供；独立任务为 null） */
  context: MapStudioContext | null
}

export async function runBaseStage(input: BaseStageInput): Promise<StageAgentResult<BaseStageResult>> {
  const selectedStyle = resolveMapStyle(input.brief)
  const features = specFeatures(input.spec)
  const artifacts = new Map<string, { artifact: MapBaseArtifact; mode: MapBaseMode; spec: MapSpec; problems: string[] }>()
  const aspect = input.brief.aspect_ratio ?? '16:9'
  const canvas = canvasForAspect(aspect, MAP_BASE_LONG_SIDE)
  // 细节框方案按「全览 artifact」登记：换底图取景后必须重新提出（框要落在新的全览范围内）
  const framePlans = new Map<string, MapPipOutput | null>()
  const needFrames = (input.context?.shots.length ?? 0) > 0
  // 取景只需要每个要素的经纬度范围：数据集河流有上百个顶点，逐点列出曾让底图阶段首个请求达 11 万字（生产 run 14）
  const featureLines = features.map(feature => {
    if (feature.kind === 'place') return `- ${feature.id} place「${feature.name}」：(${feature.coords[0]![0]}, ${feature.coords[0]![1]})`
    const lons = feature.coords.map(c => c[0]), lats = feature.coords.map(c => c[1])
    return `- ${feature.id} ${feature.kind}「${feature.name}」：${feature.coords.length} 个顶点，经度 ${Math.min(...lons)}–${Math.max(...lons)}，纬度 ${Math.min(...lats)}–${Math.max(...lats)}`
  })

  return await runStageAgent<BaseStageResult>({
    taskId: input.taskId,
    runId: input.runId,
    stage: 'base',
    stageModel: input.stageModel,
    skill: 'base',
    maxSteps: MAX_STEPS,
    startRounds: input.startRounds,
    initialFeedback: input.feedback,
    prompt: () => [
      '请为下面这张历史地图生产底图：选择路线、确定取景，生成后自己检查，再交付。',
      mapBriefText(input.brief),
      ...[familyPromptSummary(selectedStyle.family)],
      `地图里的要素（必须全部落在画面内）：\n${featureLines.join('\n') || '（无）'}`,
      `当前 map_spec 的取景（仅供参考，不是约束）：bbox=${JSON.stringify(input.spec.bbox)}，投影 ${input.spec.projection.type}，背景图层 ${JSON.stringify(input.spec.layers)}`,
      `交付校验：每个要素的所有顶点都要落在画面 [${FRAME_MARGIN}, ${1 - FRAME_MARGIN}] 内；要素整体外包框的最大边至少占画面 ${FRAME_MIN_EXTENT * 100}%。`,
      `项目画幅 ${aspect}（成图 ${canvas.width}×${canvas.height}）。`,
      contextText(input.context),
    ].filter(Boolean).join('\n\n'),
    // 底图阶段的状态由代码从本次会话已生成的 artifact 生成：早先 render_base 的 frame 明细被压缩后仍能看见
    state: () => artifacts.size
      ? `已生成的底图：\n${[...artifacts].map(([id, item]) => `${id} ${item.mode} bbox=${JSON.stringify(item.spec.bbox)} 投影=${item.spec.projection.type} 路径=${item.artifact.path} 取景${item.problems.length ? `问题：${item.problems.join('；')}` : '检查通过'}`).join('\n')}`
      : '已生成的底图：无（先 render_base）',
    tools: (session) => ({
      render_base: stageTool(session, {
        id: 'render_base',
        // Earth 路线内部截图上限 10 分钟（geo/earth.ts），工具墙钟要比它长，让 Earth 自己的超时原因先回给模型
        timeoutMs: 12 * 60_000,
        description: '按给定路线与取景生产一张底图（不消耗轮次）。返回 artifact_id、图片路径（可用 read_image 查看）以及取景检查结果 frame。'
          + `mode：${MAP_BASE_MODES.join(' / ')}（program=程序底图，Natural Earth 现代地理；earth=Google Earth 真实影像，较慢；image=用户提供的外部参考图配准，需求里没有参考图时不可用）。`
          + 'bbox=[west, south, east, north]（WGS84 度）。layers 不传则沿用当前背景图层设置。',
        inputSchema: z.object({
          mode: z.string().describe(MAP_BASE_MODES.join(' / ')),
          bbox: z.array(z.number()).describe('[west, south, east, north]'),
          projection: z.string().optional().describe('mercator / equirectangular，不传则沿用当前投影'),
          layers: z.object({
            land: z.boolean(), coastline: z.boolean(), rivers: z.boolean(), lakes: z.boolean(), countries: z.boolean(),
          }).optional().describe('程序底图的背景图层开关'),
        }),
        summarize: result => {
          const frame = result.frame && typeof result.frame === 'object' && 'problems' in result.frame && Array.isArray(result.frame.problems) ? result.frame.problems : []
          return frame.length
            ? `底图 ${String(result.artifact_id)}（${String(result.mode)}）bbox=${JSON.stringify(result.bbox)}，取景 ${frame.length} 个问题：${frame.slice(0, 3).map(String).join('；')}`
            : `底图 ${String(result.artifact_id)}（${String(result.mode)}）bbox=${JSON.stringify(result.bbox)}，取景检查通过`
        },
        execute: async (args) => {
          const mode = args.mode as MapBaseMode
          if (!MAP_BASE_MODES.includes(mode)) return { error: `mode 只能是 ${MAP_BASE_MODES.join(' / ')}，收到 ${JSON.stringify(args.mode)}` }
          if (mode === 'image' && !input.brief.reference_image) return { error: '需求里没有外部参考图（含控制点），不能用 image 路线；请改用 program 或 earth' }
          if (!Array.isArray(args.bbox) || args.bbox.length !== 4) return { error: `bbox 必须是 4 个数字 [west, south, east, north]，收到 ${JSON.stringify(args.bbox)}` }
          if (args.projection !== undefined && !['mercator', 'equirectangular'].includes(args.projection)) {
            return { error: `projection 只能是 mercator / equirectangular，收到 ${JSON.stringify(args.projection)}` }
          }
          const spec = normalizeMapSpec({
            ...input.spec,
            detail_level: input.brief.detail_level,
            style: { theme: selectedStyle.theme, map_style: selectedStyle.id },
            bbox: args.bbox,
            projection: { type: args.projection ?? input.spec.projection.type },
            layers: args.layers ?? input.spec.layers,
          })
          const artifact = await createMapBaseArtifact(spec, {
            mode,
            width: canvas.width,
            height: canvas.height,
            referenceImage: mode === 'image' ? input.brief.reference_image ?? undefined : undefined,
          })
          const frame = frameReport(specFeatures(spec), artifact.registration)
          const id = `B${artifacts.size + 1}`
          artifacts.set(id, { artifact, mode, spec, problems: frame.problems })
          const warnings = artifact.provenance && 'warnings' in artifact.provenance && Array.isArray(artifact.provenance.warnings)
            ? artifact.provenance.warnings.map(String) : []
          return {
            artifact_id: id,
            path: artifact.path,
            width: artifact.width,
            height: artifact.height,
            mode,
            bbox: spec.bbox,
            frame: {
              extent: frame.extent,
              problems: frame.problems,
              features: frame.features.map(item => ({ id: item.id, name: item.name, normalized: item.normalized.slice(0, 6) })),
            },
            ...(warnings.length ? { warnings } : {}),
            next: frame.problems.length ? '取景不合格，请调整 bbox 后重新生成' : '取景检查通过；可用 read_image 看图确认后用 submit_base 交付',
          }
        },
      }),
      set_frames: stageTool(session, {
        id: 'set_frames',
        description: '为某张已生成的全览底图提出「画中画」细节框方案（不消耗轮次）。全览 + 细节是独立资产，分镜会同时引用；'
          + '细节框由「要让观众看清的地理特征」驱动：旁白/信息点反复强调的河谷、山口、汇流处才设框，最多 4 个。'
          + 'frames 可为空数组（说明为什么单张全览就够，例如所有分镜只讲整体趋势）。每个框给 label、reason（要看清什么地理特征）、bbox=[west,south,east,north]、role=primary|aux。'
          + '不要写镜号：资产先于分镜设计，镜号不是引用依据（分镜侧读时反查）。'
          + '框必须落在该全览范围内；代码会按版式槽位的宽高比扩框并选择预置版式。',
        inputSchema: z.object({
          artifact_id: z.string().describe('render_base 返回的全览 artifact_id'),
          frames: z.array(z.object({
            label: z.string(), reason: z.string(),
            bbox: z.array(z.number()).describe('[west, south, east, north]'),
            role: z.string().optional().describe('primary | aux'),
            storyboard_numbers: z.array(z.number()).optional().describe('兼容字段，忽略：镜号不是资产身份/引用依据'),
          })),
        }),
        summarize: result => Array.isArray(result.problems) && result.problems.length
          ? `细节框方案被拒：${result.problems.slice(0, 3).map(String).join('；')}`
          : `细节框方案已登记：${String(result.layout_id)}，${String(result.count)} 个细节`,
        execute: async ({ artifact_id, frames }) => {
          const chosen = artifacts.get(String(artifact_id))
          if (!chosen) return { problems: [`没有底图 ${JSON.stringify(artifact_id)}；已生成：${[...artifacts.keys()].join('、') || '（无，请先 render_base）'}`] }
          const checked = validateFrames(chosen.spec.bbox, frames, aspect)
          if (checked.problems.length) return { problems: checked.problems }
          if (!checked.frames.length) { framePlans.set(String(artifact_id), null); return { layout_id: 'L1', count: 0, problems: [] } }
          const layoutId = chooseLayoutId({ detailCount: checked.frames.length, aspect, hasPrimary: checked.frames.some(f => f.role === 'primary') })
          const layout = layoutFor(layoutId, canvas)
          const plan: MapPipOutput = {
            version: 1, overview_bbox: chosen.spec.bbox, aspect, frames: checked.frames,
            layout: { id: layout.id, family: layout.family, canvas: layout.canvas, slots: layout.slots, locator: layout.locator, label_tier: layout.label_tier, min_slot_short_side: layout.min_slot_short_side },
            details: [], composite: null, usage: '',
          }
          plan.usage = pipUsageText(plan)
          framePlans.set(String(artifact_id), plan)
          return { layout_id: layoutId, family: layout.family, count: checked.frames.length, label_tier: layout.label_tier, frames: checked.frames.map(f => ({ no: f.no, label: f.label, role: f.role, bbox: f.bbox })), problems: [] }
        },
      }),
      read_image: readImage,
      submit_base: stageTool(session, {
        id: 'submit_base',
        timeoutMs: 12 * 60_000,
        description: '交付一张已生成的底图（消耗一轮）。取景检查有任何问题都会被拒收；有分镜引用这张地图时还必须先 set_frames。',
        inputSchema: z.object({ artifact_id: z.string().describe('render_base 返回的 artifact_id') }),
        summarize: result => result.accepted === true
          ? `第 ${String(result.round)} 轮交付已接受`
          : `第 ${String(result.round)} 轮交付被拒收，${Array.isArray(result.problems) ? result.problems.length : 0} 个问题（逐条见当前状态）`,
        execute: async ({ artifact_id }) => {
          const chosen = artifacts.get(String(artifact_id))
          const problems = chosen ? [...chosen.problems] : [`没有底图 ${JSON.stringify(artifact_id)}；已生成：${[...artifacts.keys()].join('、') || '（无，请先 render_base）'}`]
          if (chosen && needFrames && !framePlans.has(String(artifact_id))) problems.push('有分镜引用这张地图：请先对该全览调用 set_frames 给出细节框方案（单张全览就够时传空数组并说明原因）')
          return await session.deliver(problems, () => ({ artifact: chosen!.artifact, mode: chosen!.mode, spec: chosen!.spec, pip: framePlans.get(String(artifact_id)) ?? null }))
        },
      }),
      request_rollback: rollbackTool(session, { taskId: input.taskId, runId: input.runId }),
    }),
  })
}
