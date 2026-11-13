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
import { normalizeMapSpec, type MapSpec } from './geo/base-render.js'
import { createMapBaseArtifact, type MapBaseArtifact, type MapBaseMode } from './geo/geometry.js'
import { readImage } from '../../agents/tools/vision-tools.js'
import { mapBriefText, rollbackTool, runStageAgent, stageTool, type StageAgentResult } from './agent-loop.js'
import { frameReport, specFeatures, FRAME_MARGIN, FRAME_MIN_EXTENT } from './validate.js'
import { MAP_BASE_MODES, type MapBrief } from './types.js'

/** 工作区画幅：与 geo/base-render 的 16:9 口径一致 */
export const MAP_BASE_WIDTH = 3840
const MAX_STEPS = 24

export interface BaseStageResult {
  artifact: MapBaseArtifact
  mode: MapBaseMode
  /** 模型选定的取景：采用时写回 map_spec */
  spec: MapSpec
}

export interface BaseStageInput {
  taskId: number
  runId: number
  stageModel: StageModel
  brief: MapBrief
  spec: MapSpec
  startRounds: number
  feedback: string | null
}

export async function runBaseStage(input: BaseStageInput): Promise<StageAgentResult<BaseStageResult>> {
  const features = specFeatures(input.spec)
  const artifacts = new Map<string, { artifact: MapBaseArtifact; mode: MapBaseMode; spec: MapSpec; problems: string[] }>()
  const featureLines = features.map(feature => `- ${feature.id} ${feature.kind}「${feature.name}」：${feature.kind === 'place'
    ? `(${feature.coords[0]![0]}, ${feature.coords[0]![1]})`
    : feature.coords.map(c => `(${c[0]}, ${c[1]})`).join(' → ')}`)

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
      `地图里的要素（必须全部落在画面内）：\n${featureLines.join('\n') || '（无）'}`,
      `当前 map_spec 的取景（仅供参考，不是约束）：bbox=${JSON.stringify(input.spec.bbox)}，投影 ${input.spec.projection.type}，背景图层 ${JSON.stringify(input.spec.layers)}`,
      `交付校验：每个要素的所有顶点都要落在画面 [${FRAME_MARGIN}, ${1 - FRAME_MARGIN}] 内；要素整体外包框的最大边至少占画面 ${FRAME_MIN_EXTENT * 100}%。`,
    ].join('\n\n'),
    tools: (session) => ({
      render_base: stageTool(session, {
        id: 'render_base',
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
            bbox: args.bbox,
            projection: { type: args.projection ?? input.spec.projection.type },
            layers: args.layers ?? input.spec.layers,
          })
          const artifact = await createMapBaseArtifact(spec, {
            mode,
            width: MAP_BASE_WIDTH,
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
      read_image: readImage,
      submit_base: stageTool(session, {
        id: 'submit_base',
        description: '交付一张已生成的底图（消耗一轮）。取景检查有任何问题都会被拒收。',
        inputSchema: z.object({ artifact_id: z.string().describe('render_base 返回的 artifact_id') }),
        execute: async ({ artifact_id }) => {
          const chosen = artifacts.get(String(artifact_id))
          const problems = chosen ? chosen.problems : [`没有底图 ${JSON.stringify(artifact_id)}；已生成：${[...artifacts.keys()].join('、') || '（无，请先 render_base）'}`]
          return await session.deliver(problems, () => ({ artifact: chosen!.artifact, mode: chosen!.mode, spec: chosen!.spec }))
        },
      }),
      request_rollback: rollbackTool(session, { taskId: input.taskId, runId: input.runId }),
    }),
  })
}
