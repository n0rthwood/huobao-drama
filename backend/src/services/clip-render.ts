/**
 * 确定性片段渲染（Issue #50）：图层文档 + 时间线 → mp4。
 *
 * ## 为什么不是「每帧调一次 renderLayerDoc」
 * #48 的实测（1344×768）：真实地图底图 + 全滤镜 **558 ms/帧**，预合成底图后 188 ms，
 * 纯矢量 60 ms。本模块 spike 复测（960×544，7 图层，含一个 2.2 MB 原图的 image 图层）：
 *
 * | 方案 | 单帧中位 | 375 帧外推 |
 * |---|---|---|
 * | 朴素 `renderLayerDoc`（底图 + 滤镜 + 原尺寸内嵌图片，输出 PNG） | 554 ms | ≈209 s |
 * | 只预合成「底图 + 滤镜」 | 311 ms | ≈117 s |
 * | 预合成底图 **+ 预缩放 image 图层** | 41 ms | ≈14.5 s |
 * | 同上但没有 image 图层（纯矢量叠加） | 19 ms | ≈7.0 s |
 *
 * 结论：瓶颈不是 SVG 栅格化，而是（a）每帧重做底图缩放与滤镜合成、（b）把整张原图
 * base64 内嵌进 SVG 让 librsvg 每帧重解一次 PNG。所以这里：
 * 1. **底图 + 滤镜只做一次**，直接预合成成画布分辨率的 raw RGB；
 * 2. **image 图层预缩放**到它在画布上的实际像素尺寸再内嵌；
 * 3. 逐帧只做「裁取景框 → 缩放到成片画幅 → 叠加层 SVG」，输出 **raw RGB 直接喂 ffmpeg**
 *    （不落 375 个 PNG）；
 * 4. 帧状态相同（静止段）直接复用上一帧的像素缓冲。
 *
 * 实测整段 15 s@25fps = 375 帧（81 帧实渲 + 294 帧缓存命中）含 x264 编码 **3.3 s**，
 * 远低于 ≤60 s/镜的目标，因此**不需要**退化成「关键状态帧 + ffmpeg 插值」方案。
 *
 * 字体自检失败或文字超出打包字体覆盖范围时直接抛错（与 #48 一致），绝不输出豆腐块。
 */
import fs from 'fs'
import path from 'path'
import { PassThrough } from 'stream'
import sharp from 'sharp'
import { v4 as uuid } from 'uuid'
import { STORAGE_ROOT } from '../utils/paths.js'
import { ffmpeg, checkFfmpegSuite, writeSilentWav } from '../utils/ffmpeg.js'
import { logTaskProgress } from '../utils/task-logger.js'
import { getAbsolutePath } from '../utils/storage.js'
import { mediaFacts } from './media-probe.js'
import { assertRenderableText, ensureLayerFonts } from './layer-fonts.js'
import { baseFilterLayers, layerDocToSvg } from './layer-svg.js'
import type { LayerDoc } from './layer-doc.js'
import {
  frameCount,
  frameKeyOf,
  frameStateAt,
  minViewportSize,
  timelineLayerIds,
  type ClipTimeline,
} from './clip-timeline.js'
import { clipSignatureOf, type ClipSpec, type StoryboardClip } from './storyboard-clips.js'

/** 画布相对成片画幅的最大预放大倍数：再大只是浪费内存，1920 宽的底图也到头了 */
const MAX_CANVAS_SCALE = 2.5
/** 片段音轨：静音（旁白在合成阶段混入，这里只保证音轨布局一致） */
const CLIP_SAMPLE_RATE = 48000
const CLIP_CHANNELS = 2

export interface ClipRenderResult {
  /** `static/clips/<uuid>.mp4` */
  render_path: string
  render_signature: string
  duration_ms: number
  width: number
  height: number
  fps: number
  frames: number
  /** 真正做了像素工作的帧数（其余命中帧缓存） */
  rendered_frames: number
  ms: number
}

function collectTexts(doc: LayerDoc): string[] {
  const texts: string[] = []
  for (const layer of doc.layers) {
    if (!layer.visible) continue
    if (layer.type === 'label' || layer.type === 'marker') texts.push(layer.text)
    if (layer.type === 'card') texts.push(layer.fields.title, layer.fields.sub, layer.fields.meta)
  }
  return texts.filter(Boolean)
}

function resolveLocalImage(relativePath: string, what: string): string {
  if (/^(https?:|data:)/i.test(relativePath)) {
    throw new Error(`${what}只支持本地 static 路径，收到：${relativePath.slice(0, 80)}`)
  }
  const abs = getAbsolutePath(relativePath)
  if (!fs.existsSync(abs)) throw new Error(`${what}文件不存在：${relativePath}`)
  return abs
}

/**
 * image 图层预缩放：按它在画布上的实际像素尺寸重采样后再内嵌。
 * 这一步把单帧从 311 ms 降到 41 ms —— 不做的话 librsvg 每帧都要重解整张原图。
 */
async function prescaleImageLayers(
  doc: LayerDoc,
  canvas: { width: number; height: number },
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const layer of doc.layers) {
    if (layer.type !== 'image' || !layer.visible) continue
    if (out[layer.src.path]) continue
    const abs = resolveLocalImage(layer.src.path, '图片图层')
    const width = Math.max(16, Math.round(layer.box.w * canvas.width))
    const height = Math.max(16, Math.round(layer.box.h * canvas.height))
    const buffer = await sharp(abs)
      .resize(width, height, { fit: layer.fit === 'contain' ? 'inside' : 'cover' })
      .png()
      .toBuffer()
    out[layer.src.path] = `data:image/png;base64,${buffer.toString('base64')}`
  }
  return out
}

interface RenderPlan {
  width: number
  height: number
  fps: number
  frames: number
  canvasWidth: number
  canvasHeight: number
}

function planOf(timeline: ClipTimeline, duration: number, spec: Pick<ClipSpec, 'width' | 'height' | 'fps'>): RenderPlan {
  // 推得最近的那一帧决定底图要预放大到多少，才不会在推近时糊掉
  const scale = Math.min(MAX_CANVAS_SCALE, Math.max(1, 1 / minViewportSize(timeline)))
  return {
    width: spec.width,
    height: spec.height,
    fps: spec.fps,
    frames: frameCount(spec.fps, duration),
    canvasWidth: Math.round(spec.width * scale),
    canvasHeight: Math.round(spec.height * scale),
  }
}

/** 一次性准备好的逐帧渲染素材：预合成底图（raw RGB）+ 预缩放图片 + 时间线涉及的图层 */
interface FrameSource {
  baseBuffer: Buffer
  resolveImage: (path: string) => string
  layerIds: string[]
}

async function prepareFrameSource(doc: LayerDoc, plan: RenderPlan, timeline: ClipTimeline): Promise<FrameSource> {
  const baseAbs = resolveLocalImage(doc.base.path, '底图')
  const size = { width: plan.canvasWidth, height: plan.canvasHeight }
  const baseBuffer = await sharp(baseAbs)
    .resize(plan.canvasWidth, plan.canvasHeight, { fit: 'fill' })
    .composite(baseFilterLayers(doc.base.filter, size).map(layer => ({ input: Buffer.from(layer.svg) })))
    .removeAlpha()
    .raw()
    .toBuffer()
  const inlined = await prescaleImageLayers(doc, size)
  return {
    baseBuffer,
    resolveImage: (relativePath: string) => inlined[relativePath] || relativePath,
    layerIds: timelineLayerIds(timeline),
  }
}

/**
 * 合成一帧：从预合成底图里裁取景框 → 缩放到成片画幅 → 叠加层 SVG。
 * sharp 的算子顺序是固定的（extract → resize → composite），所以底图必须是**已经**
 * 合过滤镜的 raw 缓冲：在同一条管线里「先 composite 再 extract」会被重排成先裁后叠，
 * 叠加层尺寸对不上直接报错（spike 里踩过）。
 */
async function composeFrame(
  doc: LayerDoc,
  plan: RenderPlan,
  source: FrameSource,
  state: { viewport: { x: number; y: number; w: number; h: number }; opacity: Record<string, number> },
  format: 'raw' | 'png',
): Promise<Buffer> {
  const svg = layerDocToSvg(doc, { width: plan.width, height: plan.height }, {
    resolveImage: source.resolveImage,
    viewport: state.viewport,
    opacity: state.opacity,
    visibleIds: source.layerIds.filter(id => state.opacity[id] > 0),
  })
  const left = Math.round(state.viewport.x * plan.canvasWidth)
  const top = Math.round(state.viewport.y * plan.canvasHeight)
  const pipeline = sharp(source.baseBuffer, {
    raw: { width: plan.canvasWidth, height: plan.canvasHeight, channels: 3 },
  })
    .extract({
      left,
      top,
      width: Math.max(2, Math.min(Math.round(state.viewport.w * plan.canvasWidth), plan.canvasWidth - left)),
      height: Math.max(2, Math.min(Math.round(state.viewport.h * plan.canvasHeight), plan.canvasHeight - top)),
    })
    .resize(plan.width, plan.height, { fit: 'fill' })
    .composite([{ input: Buffer.from(svg) }])
  return format === 'png' ? pipeline.png().toBuffer() : pipeline.removeAlpha().raw().toBuffer()
}

/**
 * 渲染一段片段到 `static/clips/<uuid>.mp4`。
 * 画面与成片同规格（画幅来自本集实测，帧率来自时间线），音轨为等长静音。
 */
export async function renderClip(
  clip: Pick<StoryboardClip, 'layer_doc' | 'timeline' | 'duration' | 'position'>,
  spec: ClipSpec,
): Promise<ClipRenderResult> {
  const started = Date.now()
  const suite = await checkFfmpegSuite()
  if (!suite.ffmpeg || !suite.ffprobe) {
    throw new Error('本机 ffmpeg 不可用，无法渲染确定性片段。请删除 node_modules 后重新安装依赖，或设置 FFMPEG_BIN/FFPROBE_BIN 后重启服务')
  }
  await ensureLayerFonts()
  const doc = clip.layer_doc
  if (!doc.base.path) throw new Error('图层文档缺少底图路径 base.path')
  assertRenderableText(collectTexts(doc))

  const plan = planOf(clip.timeline, clip.duration, spec)
  const source = await prepareFrameSource(doc, plan, clip.timeline)

  const tempDir = path.join(STORAGE_ROOT, 'temp')
  fs.mkdirSync(tempDir, { recursive: true })
  const outputDir = path.join(STORAGE_ROOT, 'clips')
  fs.mkdirSync(outputDir, { recursive: true })
  const outputName = `${uuid()}.mp4`
  const outputPath = path.join(outputDir, outputName)
  const duration = plan.frames / plan.fps
  const silenceAbs = path.join(tempDir, `${uuid()}-clip-silence.wav`)
  writeSilentWav(silenceAbs, CLIP_SAMPLE_RATE, CLIP_CHANNELS, duration)

  const frameStream = new PassThrough()
  // 本仓 tsconfig 的 lib 低于 es2024，没有 Promise.withResolvers（与 shot-compose / media-probe 同）
  const encoded = new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(frameStream)
      .inputFormat('rawvideo')
      .inputOptions(['-pix_fmt', 'rgb24', '-s', `${plan.width}x${plan.height}`, '-framerate', String(plan.fps)])
      .input(silenceAbs)
      .outputOptions([
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-crf', '23',
        '-pix_fmt', 'yuv420p',
        '-r', String(plan.fps),
        '-c:a', 'aac',
        '-ar', String(CLIP_SAMPLE_RATE),
        '-ac', String(CLIP_CHANNELS),
        '-b:a', '192k',
        '-movflags', '+faststart',
        '-shortest',
      ])
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(new Error(`片段渲染失败：${err.message}`)))
      .run()
  })

  let renderedFrames = 0
  try {
    let lastKey = ''
    let lastFrame: Buffer | null = null
    for (let index = 0; index < plan.frames; index++) {
      const state = frameStateAt(clip.timeline, index / plan.fps)
      const key = frameKeyOf(state)
      // 静止段相邻帧的状态键完全相同，直接复用上一帧像素（15 s 片段里通常有七八成）
      if (key !== lastKey || !lastFrame) {
        lastFrame = await composeFrame(doc, plan, source, state, 'raw')
        lastKey = key
        renderedFrames++
      }
      if (!frameStream.write(lastFrame)) {
        await new Promise(resolve => frameStream.once('drain', resolve))
      }
    }
    frameStream.end()
    await encoded
  } catch (err) {
    frameStream.destroy()
    throw err
  } finally {
    fs.rmSync(silenceAbs, { force: true })
  }

  const produced = await mediaFacts(outputPath)
  if (!produced) throw new Error('片段渲染产物无法读取时长，可能写盘失败')
  const renderPath = `static/clips/${outputName}`
  const ms = Date.now() - started
  logTaskProgress('ClipRender', 'render', {
    path: renderPath,
    size: `${plan.width}x${plan.height}@${plan.fps}`,
    frames: String(plan.frames),
    renderedFrames: String(renderedFrames),
    ms: String(ms),
  })
  return {
    render_path: renderPath,
    render_signature: clipSignatureOf(clip, spec),
    duration_ms: produced.durationMs,
    width: plan.width,
    height: plan.height,
    fps: plan.fps,
    frames: plan.frames,
    rendered_frames: renderedFrames,
    ms,
  }
}

/** 片段首/末帧缩略图（关键帧页「由片段渲染」占位展示用） */
export async function renderClipThumbnails(
  clip: Pick<StoryboardClip, 'layer_doc' | 'timeline' | 'duration'>,
  spec: Pick<ClipSpec, 'width' | 'height' | 'fps'>,
): Promise<{ first: Buffer; last: Buffer }> {
  await ensureLayerFonts()
  const doc = clip.layer_doc
  if (!doc.base.path) throw new Error('图层文档缺少底图路径 base.path')
  assertRenderableText(collectTexts(doc))
  const plan = planOf(clip.timeline, clip.duration, spec)
  const source = await prepareFrameSource(doc, plan, clip.timeline)
  const lastT = Math.max(0, clip.duration - 1 / plan.fps)
  return {
    first: await composeFrame(doc, plan, source, frameStateAt(clip.timeline, 0), 'png'),
    last: await composeFrame(doc, plan, source, frameStateAt(clip.timeline, lastT), 'png'),
  }
}
