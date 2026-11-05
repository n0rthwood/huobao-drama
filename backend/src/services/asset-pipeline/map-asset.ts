/**
 * 地图底图：渲染 → 登记成资产版本 → 按投影写语义（Issue #56）
 *
 * 几何**不经扩散模型**：点线的像素坐标直接由 `renderMapBase()` 用同一个投影算出来，
 * 所以 `props.semantics` 的 confidence 恒为 1，不需要 VLM 也不需要 CV 抽色。
 * 第一轮的事故（扩散重画海岸线、把殷墟点画到燕山以北）在这条路径上结构性地不可能发生。
 */
import crypto from 'crypto'
import fs from 'fs'
import { eq } from 'drizzle-orm'
import { db, getInsertId, schema } from '../../db/index.js'
import { now } from '../../utils/response.js'
import { getAbsolutePath } from '../../utils/storage.js'
import { completionStamp } from '../media-time.js'
import { logTaskStart, logTaskSuccess } from '../../utils/task-logger.js'
import { normalizeSemantics, savePropSemantics, type AssetSemantics } from '../asset-semantics.js'
import {
  MAP_ROUTE_COLOR,
  renderMapBase,
  type MapSpec,
} from '../map-base-render.js'

/** 底图版本行的 provider：与 upload / qwen-jobs 区分开，版本卡片能一眼看出是程序渲染的 */
export const MAP_RENDER_PROVIDER = 'map-render'

export interface MapRenderRegistration {
  path: string
  width: number
  height: number
  sha256: string
  reused: boolean
  task_id: number
  points: Array<{ id: string; name: string; at: [number, number] }>
  routes: Array<{ id: string; name: string; points: Array<[number, number]>; color: string }>
}

export async function renderAndRegisterMapBase(input: {
  propId: number
  spec: MapSpec
  width?: number
}): Promise<MapRenderRegistration> {
  const [prop] = await db.select().from(schema.props).where(eq(schema.props.id, input.propId))
  if (!prop || prop.deletedAt) throw new Error('道具不存在')

  logTaskStart('MapBase', 'render', { propId: input.propId, projection: input.spec.projection.type })
  const rendered = await renderMapBase(input.spec, input.width ? { width: input.width } : undefined)

  // 版本行：与 register-upload 同一套字段，只换 provider/model
  const ts = now()
  const res = await db.insert(schema.sysTask).values({
    type: 'image',
    propId: input.propId,
    dramaId: prop.dramaId,
    provider: MAP_RENDER_PROVIDER,
    model: 'd3-geo+natural-earth-50m',
    params: JSON.stringify({ source: 'map-render', map_signature: rendered.sha256, reused: rendered.reused }),
    resultUrl: rendered.path,
    localPath: rendered.path,
    status: 'completed',
    createdAt: ts,
    updatedAt: ts,
    ...completionStamp(ts),
  })
  const taskId = getInsertId(res)

  // 程序渲染的底图就是**原件**：它是几何真源，后续美化轮只能派生，不能覆盖
  await db.update(schema.props).set({
    imageUrl: rendered.path,
    localPath: rendered.path,
    mapSpec: JSON.stringify(input.spec),
    faithful: 1,
    faithfulSource: taskId,
    updatedAt: now(),
  }).where(eq(schema.props.id, input.propId))

  const semantics: AssetSemantics = normalizeSemantics({
    image: { width: rendered.width, height: rendered.height, source_task_id: taskId },
    labels: [],
    points: rendered.points.map(point => ({
      id: point.id,
      name: point.name,
      at: point.at,
      // 坐标来自投影换算，不是模型也不是像素算法——但 source 枚举只有三个值，
      // 「程序算出来的」对应 cv；真正的来源在 model 字段里写明 map-render
      source: 'cv' as const,
      confidence: 1,
    })),
    regions: [],
    lines: rendered.routes.map(route => ({
      id: route.id,
      name: route.name,
      points: route.points,
      kind: 'river' as const,
      source: 'cv' as const,
      confidence: 1,
      color: route.color || MAP_ROUTE_COLOR,
    })),
    generated_at: new Date().toISOString(),
    model: MAP_RENDER_PROVIDER,
  })
  await savePropSemantics(input.propId, semantics)

  // 文件是内容寻址的，复用时也要把真实 sha256 回报给调用方做确定性断言
  const actual = crypto.createHash('sha256')
    .update(fs.readFileSync(getAbsolutePath(rendered.path)))
    .digest('hex')
  logTaskSuccess('MapBase', 'render', {
    propId: input.propId, taskId, path: rendered.path, sha256: actual, reused: rendered.reused,
  })

  return {
    path: rendered.path,
    width: rendered.width,
    height: rendered.height,
    sha256: actual,
    reused: rendered.reused,
    task_id: taskId,
    points: rendered.points,
    routes: rendered.routes,
  }
}
