/**
 * Google Earth Web 底图（Issue #84）
 *
 * 为什么要这条路线：程序底图（Natural Earth 50m）只有矢量轮廓，讲「殷墟的台地」「运河穿过
 * 哪片洼地」时需要真实影像。Earth 的影像不能截一张图就算数——必须知道**每个经纬度落在
 * 这张图的哪个像素**，否则后面的标注只能靠人眼对齐，等于回到扩散模型时代。
 *
 * 相机数学来自 ~/projects/qing_russia_history/src/qrdoc/earth.py（2026-11-01 实测闭合，
 * 见 skill kmz-google-earth）：Earth 把相机写在自己的 URL 里（`/@lat,lon,alt a,dist d,30y,0h,0t,0r`），
 * heading=0 / tilt=0 的球面针孔模型只用于计划机位与识别控制点，不作为真实影像配准的证明。
 * 实测 portrait 下 FOV 轴与旧 landscape 假设不同，因此用正方形窗口消除轴歧义；
 * 最终标注只认实际截图测得、经独立留出点检验的像素网格（地形高度也包含在测量里）。
 * `backend/scripts/earth-map.py`（Playwright）。**这里不依赖 qing_russia_history 的任何运行时文件。**
 *
 * 截图分三趟，实际机位一致：
 *   1. 用户 KMZ 的证据图，证明本地 KML 被解析；
 *   2. 专用 KMZ 的固定像素控制标记，测量 17×17 网格并验证 16×16 留出点 ≤3px；
 *   3. 不载入 KML 的干净影像底图。校准趟与底图趟机位漂移 >0.25px 则拒绝套用网格。
 * 实际相机、窗口、裁切框、控制点截图、KMZ hash、max/RMS 残差一并持久化。
 */
import { spawn } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { specCoordinates, specLabelledPoints } from './map-kmz.js'
import type { MapSpec } from './map-base-render.js'

/** 依赖缺失（Python / Playwright / Chromium）：可直接照做的错误，绝不退回程序底图冒充 Earth */
export class EarthDependencyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EarthDependencyError'
  }
}

/** Earth 打开了，但相机/取景/载入不可信：宁可失败也不保存一张不知道拍了什么的图 */
export class EarthCaptureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EarthCaptureError'
  }
}

export const EARTH_URL = 'https://earth.google.com/web/'
export const EARTH_RADIUS_M = 6_371_008.8
export const EARTH_FOV_DEG = 30
export const EARTH_IMAGERY_NOTE = 'Google Earth 影像 © Google 及其数据提供方（Landsat/Copernicus、SIO、NOAA、U.S. Navy、NGA、GEBCO）；叠加几何为本项目示意图形，非测绘成果。'

/** Earth Web 自身的界面（搜索框/工具栏/小地图/版权footer）贴着窗口四边，截图只取中间这块 */
export const EARTH_CHROME = { left: 110, top: 130, right: 110, bottom: 130 } as const

/** 标注留位（实测值，见 earth.py 注释）：全角字约 29.5px，图钉在坐标上方 */
const LABEL_CHAR_PX = 29.5
const LABEL_GAP_PX = 40
const PIN_ABOVE_PX = 120
const PIN_BELOW_PX = 40
const LINE_PAD_PX = 12
const FIT_SLACK_PX = 6
const MIN_SIDE = 820
const MAX_DISTANCE_M = 3.6e7
/** 地球边缘的雾化从 0.89 开始，裁切框最远角不得超过地平线半径的这个比例 */
const LIMB_USABLE = 0.86
/** SIGTERM 之后留给脚本关浏览器的时间；超过就对整个进程组 SIGKILL */
const KILL_GRACE_MS = 15_000

export interface EarthCamera { lat: number; lon: number; distance_m: number; fov_deg: number }
export interface EarthWindow { width: number; height: number }
export interface EarthCrop { x: number; y: number; width: number; height: number }

export interface EarthPlan {
  camera: EarthCamera
  frame: { width: number; height: number }
  window: EarthWindow
  url: string
  content_rect: [number, number, number, number]
  crop: EarthCrop
}

// ---------------------------------------------------------------- 相机投影

function unitVector(lat: number, lon: number): [number, number, number] {
  const rlat = (lat * Math.PI) / 180
  const rlon = (lon * Math.PI) / 180
  return [Math.cos(rlat) * Math.cos(rlon), Math.cos(rlat) * Math.sin(rlon), Math.sin(rlat)]
}

/** 正方形捕获窗口中横/纵视场角相同；名义焦距只用于取景，最终配准来自实际像素网格。 */
export function focalPx(windowWidth: number, fov = EARTH_FOV_DEG): number {
  return windowWidth / (2 * Math.tan((fov * Math.PI) / 180 / 2))
}

/**
 * 经纬度 → 窗口像素（左上为原点）。`visible=false` 表示该点在地平线之后，
 * 此时像素值无意义，调用方必须丢弃而不是硬画。
 */
export function earthProject(
  lonlat: [number, number],
  camera: EarthCamera,
  windowSize: EarthWindow,
): { x: number; y: number; visible: boolean } {
  const [lon, lat] = lonlat
  const up = unitVector(camera.lat, camera.lon)
  const rlat0 = (camera.lat * Math.PI) / 180
  const rlon0 = (camera.lon * Math.PI) / 180
  const east: [number, number, number] = [-Math.sin(rlon0), Math.cos(rlon0), 0]
  const north: [number, number, number] = [
    -Math.sin(rlat0) * Math.cos(rlon0),
    -Math.sin(rlat0) * Math.sin(rlon0),
    Math.cos(rlat0),
  ]
  const focal = focalPx(windowSize.width, camera.fov_deg)
  const horizon = EARTH_RADIUS_M / (EARTH_RADIUS_M + camera.distance_m)
  const p = unitVector(lat, lon)
  const along = p[0] * up[0] + p[1] * up[1] + p[2] * up[2]
  const depth = EARTH_RADIUS_M + camera.distance_m - EARTH_RADIUS_M * along
  const x = EARTH_RADIUS_M * (p[0] * east[0] + p[1] * east[1] + p[2] * east[2])
  const y = EARTH_RADIUS_M * (p[0] * north[0] + p[1] * north[1] + p[2] * north[2])
  return {
    x: windowSize.width / 2 + (focal * x) / depth,
    y: windowSize.height / 2 - (focal * y) / depth,
    visible: along > horizon,
  }
}

/**
 * 窗口像素 → 经纬度：把像素反算成相机射线，与球面求交（取近交点）。
 * 射线不与球相交（指向太空）时返回 null —— 这是真实情况，不许外推。
 */
export function earthUnproject(
  px: [number, number],
  camera: EarthCamera,
  windowSize: EarthWindow,
): [number, number] | null {
  const focal = focalPx(windowSize.width, camera.fov_deg)
  const up = unitVector(camera.lat, camera.lon)
  const rlat0 = (camera.lat * Math.PI) / 180
  const rlon0 = (camera.lon * Math.PI) / 180
  const east: [number, number, number] = [-Math.sin(rlon0), Math.cos(rlon0), 0]
  const north: [number, number, number] = [
    -Math.sin(rlat0) * Math.cos(rlon0),
    -Math.sin(rlat0) * Math.sin(rlon0),
    Math.cos(rlat0),
  ]
  // 相机位置与方向：位于 up 方向 (R + d) 处，朝向球心（-up）
  const dx = px[0] - windowSize.width / 2
  const dy = windowSize.height / 2 - px[1]
  const eye: [number, number, number] = [
    up[0] * (EARTH_RADIUS_M + camera.distance_m),
    up[1] * (EARTH_RADIUS_M + camera.distance_m),
    up[2] * (EARTH_RADIUS_M + camera.distance_m),
  ]
  const dir: [number, number, number] = [
    east[0] * dx + north[0] * dy - up[0] * focal,
    east[1] * dx + north[1] * dy - up[1] * focal,
    east[2] * dx + north[2] * dy - up[2] * focal,
  ]
  const dirLen = Math.hypot(dir[0], dir[1], dir[2])
  const d: [number, number, number] = [dir[0] / dirLen, dir[1] / dirLen, dir[2] / dirLen]
  const b = eye[0] * d[0] + eye[1] * d[1] + eye[2] * d[2]
  const c = eye[0] * eye[0] + eye[1] * eye[1] + eye[2] * eye[2] - EARTH_RADIUS_M * EARTH_RADIUS_M
  const disc = b * b - c
  if (disc < 0) return null
  const t = -b - Math.sqrt(disc)
  if (t <= 0) return null
  const hit: [number, number, number] = [eye[0] + d[0] * t, eye[1] + d[1] * t, eye[2] + d[2] * t]
  const lat = (Math.asin(hit[2] / EARTH_RADIUS_M) * 180) / Math.PI
  const lon = (Math.atan2(hit[1], hit[0]) * 180) / Math.PI
  return [lon, lat]
}

// ---------------------------------------------------------------- 取景

interface EarthGeometry {
  points: Array<[number, number]>
  labelled: Array<{ lon: number; lat: number; name: string }>
}

export function earthGeometryOf(spec: MapSpec): EarthGeometry {
  const points = specCoordinates(spec)
  if (!points.length) throw new EarthCaptureError('地图没有任何几何要素，Earth 取景无从算起')
  // 请求的地图范围必须参与取景，不能只把用户区域框裁成整张图的边框。
  const [west, south, east, north] = spec.bbox
  points.push([west, south], [west, north], [east, north], [east, south])
  return { points, labelled: specLabelledPoints(spec) }
}

/** 全角字算 1，半角算 0.5 —— Earth 画名字的宽度 */
export function labelWidthPx(name: string): number {
  let units = 0
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0
    const wide = (code >= 0x1100 && code <= 0x115f)
      || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6)
    units += wide ? 1 : 0.5
  }
  return LABEL_CHAR_PX * units
}

function projectedBox(
  points: Array<[number, number]>,
  camera: EarthCamera,
  windowSize: EarthWindow,
): [number, number, number, number] | null {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity
  for (const point of points) {
    const projected = earthProject(point, camera, windowSize)
    if (!projected.visible) return null
    minX = Math.min(minX, projected.x); maxX = Math.max(maxX, projected.x)
    minY = Math.min(minY, projected.y); maxY = Math.max(maxY, projected.y)
  }
  return [minX, minY, maxX, maxY]
}

/** 要出现在画面里的矩形：全部几何 + 每个地名自己的图钉/文字留位 */
export function contentRect(
  geometry: EarthGeometry,
  camera: EarthCamera,
  windowSize: EarthWindow,
): [number, number, number, number] | null {
  const box = projectedBox(geometry.points, camera, windowSize)
  if (!box) return null
  const rect: [number, number, number, number] = [
    box[0] - LINE_PAD_PX, box[1] - LINE_PAD_PX, box[2] + LINE_PAD_PX, box[3] + LINE_PAD_PX,
  ]
  for (const item of geometry.labelled) {
    const projected = earthProject([item.lon, item.lat], camera, windowSize)
    if (!projected.visible) return null
    rect[0] = Math.min(rect[0], projected.x - LABEL_GAP_PX)
    rect[1] = Math.min(rect[1], projected.y - PIN_ABOVE_PX)
    rect[2] = Math.max(rect[2], projected.x + labelWidthPx(item.name) + LABEL_GAP_PX)
    rect[3] = Math.max(rect[3], projected.y + PIN_BELOW_PX)
  }
  return rect
}

function insideClip(
  rect: [number, number, number, number],
  frame: { width: number; height: number },
  slack = 0,
): boolean {
  return rect[0] >= EARTH_CHROME.left + slack
    && rect[1] >= EARTH_CHROME.top + slack
    && rect[2] <= EARTH_CHROME.left + frame.width - slack
    && rect[3] <= EARTH_CHROME.top + frame.height - slack
}

export function windowSizeOf(frame: { width: number; height: number }): EarthWindow {
  // 实测 portrait 下 Earth 的 FOV 轴与旧 landscape 假设不同。固定方形浏览器视口，
  // 消除横/纵 FOV 歧义，再在其中裁出内容画幅；最终还必须通过真实像素控制点验收。
  const side = Math.max(
    frame.width + EARTH_CHROME.left + EARTH_CHROME.right,
    frame.height + EARTH_CHROME.top + EARTH_CHROME.bottom,
  )
  return { width: side, height: side }
}

function frameForAspect(aspect: number, longSide: number): { width: number; height: number } {
  const width = aspect >= 1 ? longSide : Math.round(longSide * aspect)
  const height = aspect >= 1 ? Math.round(longSide / aspect) : longSide
  return { width: Math.max(width, MIN_SIDE), height: Math.max(height, MIN_SIDE) }
}

function limbAngleDeg(distance: number): number {
  return (Math.asin(EARTH_RADIUS_M / (EARTH_RADIUS_M + distance)) * 180) / Math.PI
}

function rectAngleDeg(
  rect: [number, number, number, number],
  windowSize: EarthWindow,
  fov: number,
): number {
  const focal = focalPx(windowSize.width, fov)
  const cx = windowSize.width / 2
  const cy = windowSize.height / 2
  const corners: Array<[number, number]> = [
    [rect[0], rect[1]], [rect[2], rect[1]], [rect[0], rect[3]], [rect[2], rect[3]],
  ]
  const worst = Math.max(...corners.map(([x, y]) => Math.hypot(x - cx, y - cy)))
  return (Math.atan(worst / focal) * 180) / Math.PI
}

/** 裁切框最远角相对地平线半径的比例；> LIMB_USABLE 就会拍到地球边缘/太空 */
export function limbFill(
  rect: [number, number, number, number],
  windowSize: EarthWindow,
  distance: number,
  fov: number,
): number {
  return Math.tan((rectAngleDeg(rect, windowSize, fov) * Math.PI) / 180)
    / Math.tan((limbAngleDeg(distance) * Math.PI) / 180)
}

/** 把相机对准**要发布的矩形**的中心（不是几何中心：长地名只向东占位） */
function centredCamera(
  geometry: EarthGeometry,
  centre: { lat: number; lon: number },
  distance: number,
  frame: { width: number; height: number },
  windowSize: EarthWindow,
  fov: number,
): EarthCamera {
  let { lat, lon } = centre
  const targetX = EARTH_CHROME.left + frame.width / 2
  const targetY = EARTH_CHROME.top + frame.height / 2
  const focal = focalPx(windowSize.width, fov)
  for (let i = 0; i < 16; i++) {
    const rect = contentRect(geometry, { lat, lon, distance_m: distance, fov_deg: fov }, windowSize)
    if (!rect) break
    const dx = (rect[0] + rect[2]) / 2 - targetX
    const dy = (rect[1] + rect[3]) / 2 - targetY
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) break
    const perDegree = (focal * 111_320) / distance
    lon += dx / Math.max(perDegree * Math.cos((lat * Math.PI) / 180), 1e-6)
    lat = Math.max(-85, Math.min(85, lat - dy / perDegree))
  }
  return { lat, lon, distance_m: distance, fov_deg: fov }
}

function fits(
  geometry: EarthGeometry,
  centre: { lat: number; lon: number },
  distance: number,
  frame: { width: number; height: number },
  windowSize: EarthWindow,
  fov: number,
): boolean {
  const camera = centredCamera(geometry, centre, distance, frame, windowSize, fov)
  const rect = contentRect(geometry, camera, windowSize)
  return rect !== null && insideClip(rect, frame, FIT_SLACK_PX)
}

function fitDistance(
  geometry: EarthGeometry,
  centre: { lat: number; lon: number },
  frame: { width: number; height: number },
  windowSize: EarthWindow,
  fov: number,
): number {
  let low = 1e4
  let high = MAX_DISTANCE_M
  if (!fits(geometry, centre, high, frame, windowSize, fov)) {
    throw new EarthCaptureError('这张地图的范围在 Earth 的任何机位都装不进一帧，请缩小 bbox 或拆成多张底图')
  }
  for (let i = 0; i < 48; i++) {
    const mid = (low + high) / 2
    if (fits(geometry, centre, mid, frame, windowSize, fov)) high = mid
    else low = mid
  }
  let distance = high
  while (distance <= MAX_DISTANCE_M) {
    if (fits(geometry, centre, distance, frame, windowSize, fov)) {
      const camera = centredCamera(geometry, centre, distance, frame, windowSize, fov)
      const rect = contentRect(geometry, camera, windowSize)
      if (rect && limbFill(rect, windowSize, distance, fov) <= LIMB_USABLE) return distance
    }
    distance *= 1.01
  }
  throw new EarthCaptureError(
    '没有任何机位能同时装下这张地图又不拍到地球边缘；请提高底图宽度（像素更多时图钉/文字占比更小）或缩小范围',
  )
}

export function cropBoxOf(
  rect: [number, number, number, number],
  frame: { width: number; height: number },
): EarthCrop {
  const x0 = Math.max(EARTH_CHROME.left, Math.floor(rect[0]))
  const y0 = Math.max(EARTH_CHROME.top, Math.floor(rect[1]))
  const x1 = Math.min(EARTH_CHROME.left + frame.width, Math.ceil(rect[2]))
  const y1 = Math.min(EARTH_CHROME.top + frame.height, Math.ceil(rect[3]))
  return { x: x0, y: y0, width: Math.max(x1 - x0, 1), height: Math.max(y1 - y0, 1) }
}

/** 开浏览器之前就把相机/画幅/裁切框算完（Earth 的画面反馈不收敛，绝不靠看图调参） */
export function planEarthShot(spec: MapSpec, longSide = 2000): EarthPlan {
  const geometry = earthGeometryOf(spec)
  const lons = geometry.points.map(point => point[0])
  const lats = geometry.points.map(point => point[1])
  const centre = {
    lat: (Math.min(...lats) + Math.max(...lats)) / 2,
    lon: (Math.min(...lons) + Math.max(...lons)) / 2,
  }
  const fov = EARTH_FOV_DEG
  // 画幅形状取决于内容，内容的像素形状又取决于相机：两三轮就收敛
  let frame = frameForAspect(trialAspect(geometry.points, centre), longSide)
  let windowSize = windowSizeOf(frame)
  let camera = centredCamera(geometry, centre, fitDistance(geometry, centre, frame, windowSize, fov), frame, windowSize, fov)
  let rect = contentRect(geometry, camera, windowSize)
  for (let i = 0; i < 6; i++) {
    if (!rect) break
    const wanted = frameForAspect((rect[2] - rect[0]) / (rect[3] - rect[1]), longSide)
    if (wanted.width === frame.width && wanted.height === frame.height) break
    frame = wanted
    windowSize = windowSizeOf(frame)
    camera = centredCamera(geometry, centre, fitDistance(geometry, centre, frame, windowSize, fov), frame, windowSize, fov)
    rect = contentRect(geometry, camera, windowSize)
  }
  if (!rect) throw new EarthCaptureError('取景失败：部分几何落在地平线之后，无法在一帧里拍全')
  return {
    camera,
    frame,
    window: windowSize,
    url: earthCameraUrl(camera),
    content_rect: rect,
    crop: cropBoxOf(rect, frame),
  }
}

function trialAspect(points: Array<[number, number]>, centre: { lat: number; lon: number }): number {
  const box = projectedBox(points, { lat: centre.lat, lon: centre.lon, distance_m: 1e7, fov_deg: EARTH_FOV_DEG }, { width: 2000, height: 2000 })
  if (!box) return 1
  return (box[2] - box[0]) / Math.max(box[3] - box[1], 1e-6)
}

export function earthCameraUrl(camera: EarthCamera): string {
  return `${EARTH_URL}@${camera.lat.toFixed(6)},${camera.lon.toFixed(6)},0a,${camera.distance_m.toFixed(0)}d,${camera.fov_deg}y,0h,0t,0r`
}

// ---------------------------------------------------------------- 运行时依赖

export interface EarthRuntime { python: string; chromium?: string; source: string }

/**
 * Earth 截图需要仓库外的 Python 运行时（playwright + chromium）。
 * python 与 chromium **各自独立**解析：环境变量优先，缺哪一个就去本地配置文件补哪一个
 * （机器相关路径不入库，与 providers.json 同目录口径）。
 * pm2 的 `--env-i` 会丢掉 shell export，所以配置文件这条路必须存在；
 * 只导出了 PYTHON 而把 chromium 写在配置里，也要能跑起来。
 */
export function resolveEarthRuntime(): EarthRuntime {
  const envPython = process.env.HUOBAO_EARTH_PYTHON?.trim()
  const envChromium = process.env.HUOBAO_EARTH_CHROMIUM?.trim()
  const configDir = process.env.HUOBAO_LOCAL_CONFIG_DIR || path.join(os.homedir(), '.config', 'huobao-drama-local')
  const file = path.join(configDir, 'earth-runtime.json')

  let filePython = ''
  let fileChromium = ''
  if (fs.existsSync(file)) {
    let parsed: { python?: unknown; chromium?: unknown }
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (error) {
      throw new EarthDependencyError(`Earth 运行时配置 ${file} 不是合法 JSON：${(error as Error).message}`)
    }
    filePython = typeof parsed.python === 'string' ? parsed.python.trim() : ''
    fileChromium = typeof parsed.chromium === 'string' ? parsed.chromium.trim() : ''
  }

  const python = envPython || filePython
  const chromium = envChromium || fileChromium
  if (python) {
    const source = envPython ? (fileChromium && !envChromium ? `env:HUOBAO_EARTH_PYTHON + ${file}` : 'env:HUOBAO_EARTH_PYTHON') : file
    return { python, chromium: chromium || undefined, source }
  }
  throw new EarthDependencyError(
    'Earth 底图需要仓库外的 Python + Playwright 运行时，但没找到配置：'
    + `请设置环境变量 HUOBAO_EARTH_PYTHON（可选 HUOBAO_EARTH_CHROMIUM），或写入 ${file}，内容形如 `
    + '{"python":"/path/to/venv/bin/python","chromium":"/path/to/chrome"}。'
    + '该运行时需安装 playwright 与 Pillow（python -m pip install playwright Pillow），并具备可用的 Chromium/Chrome。',
  )
}

// ---------------------------------------------------------------- 截图

export interface EarthSidecar {
  capture_version: 'pixelgrid-v2'
  calibration: {
    grid: {
      lon_min: number; lat_min: number; lon_max: number; lat_max: number
      cols: number; rows: number; points: Array<[number, number]>
    }
    residual_px: { max: number; rms: number }
    validation_count: number
    tolerance_px: number
    camera_drift_px: number
    screenshot: string
    kmz: string
    kmz_sha256: string
    controls: Array<{ kind: string; row: number; col: number; lon: number; lat: number; pixel: [number, number]; withheld_error_px?: number }>
  }
  camera_planned: EarthCamera
  camera_used: EarthCamera
  window: EarthWindow
  frame: { width: number; height: number }
  crop: EarthCrop
  image: { width: number; height: number }
  basemap: string
  kmz_sha256: string
  kmz_folders: string[]
  evidence_path: string
  captured_at: string
  tiles_settled_after_s: number
  source: string
  camera_url: string
  note: string
}

export interface EarthCaptureInput {
  spec: MapSpec
  kmzAbsPath: string
  kmzSha256: string
  /** 干净底图落盘的绝对路径（PNG） */
  outAbsPath: string
  /** 载入 KMZ 的证据图落盘的绝对路径（PNG） */
  evidenceAbsPath: string
  longSide?: number
  timeoutMs?: number
  /** 取消用：上层任务被取消时直接杀掉浏览器子进程 */
  signal?: AbortSignal
}

function scriptPath(): string {
  // src/services → backend/scripts（tsx/编译产物同深度），桌面版 bundle 旁也放一份
  const here = path.dirname(new URL(import.meta.url).pathname)
  const candidates = [
    path.resolve(here, '../../scripts/earth-map.py'),
    path.resolve(here, 'scripts/earth-map.py'),
    path.resolve(process.cwd(), 'scripts/earth-map.py'),
  ]
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate
  throw new EarthDependencyError(`Earth 截图脚本缺失：在 ${candidates.join(' / ')} 都没找到 earth-map.py`)
}

/**
 * 杀掉命令行里带本次作业标记的浏览器进程（Linux：扫 /proc/<pid>/cmdline）。
 * 只在强制清理路径上调用，且只认 `--huobao-earth-job=<marker>` 这一个本次作业唯一的标记：
 * 绝不按进程名（chrome/chromium）匹配——那会误杀用户自己开的浏览器，也不会碰别的作业。
 * 非 Linux 平台没有 /proc，直接返回 0（优雅关闭那条路仍然有效）。
 */
function killMarkedBrowsers(marker: string): number {
  if (process.platform !== 'linux') return 0
  let entries: string[]
  try {
    entries = fs.readdirSync('/proc')
  } catch {
    return 0
  }
  let killed = 0
  for (const entry of entries) {
    const pid = Number(entry)
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue
    let cmdline: string
    try {
      cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
    } catch {
      continue
    }
    if (!cmdline.includes(`--huobao-earth-job=${marker}`)) continue
    try {
      process.kill(pid, 'SIGKILL')
      killed++
    } catch { /* 已经退出 */ }
  }
  return killed
}

/**
 * 真的打开 Google Earth Web、载入 KMZ、拍两张图。失败一律抛错，绝不返回伪造结果。
 * 相机/裁切框以 Earth 回报为准，返回的 sidecar 就是后续地理↔像素换算的唯一依据。
 *
 * **必须异步**：一次拍摄要两三分钟，同步跑会把整个 Hono 进程钉死，期间所有请求
 * （包括这条任务自己的进度查询和取消）全部排队。这里用 spawn + Promise，
 * `signal` 可由调用方取消；不做任何重试（重试由上层任务决定）。
 */
export function captureEarthBase(input: EarthCaptureInput): Promise<EarthSidecar> {
  const runtime = resolveEarthRuntime()
  const plan = planEarthShot(input.spec, input.longSide ?? 2000)
  const script = scriptPath()
  const geometry = earthGeometryOf(input.spec)
  const jobMarker = `huobao-earth-${crypto.randomUUID()}`
  const job = {
    kmz: input.kmzAbsPath,
    bbox: input.spec.bbox,
    out: input.outAbsPath,
    evidence: input.evidenceAbsPath,
    camera: plan.camera,
    window: plan.window,
    frame: plan.frame,
    crop: plan.crop,
    // 几何由 Node 侧给定，脚本不再自己解 KMZ：两边必须对同一组坐标取景，否则裁切框对不上
    points: geometry.points,
    labelled: geometry.labelled,
    chromium: runtime.chromium ?? null,
    earth_url: EARTH_URL,
    // 失败现场（截图/URL/标签）落在底图旁边，便于事后诊断
    debug: input.outAbsPath.replace(/\.png$/i, ''),
    // 本次作业的唯一标记：作为一个 Chromium 会忽略的命令行开关传下去，
    // 强制清理时据此精确定位本次拉起的浏览器进程
    marker: jobMarker,
  }
  fs.mkdirSync(path.dirname(input.outAbsPath), { recursive: true })

  return new Promise<EarthSidecar>((resolve, reject) => {
    // detached：子进程自成进程组。Playwright 会再拉起 driver 与 Chromium，
    // 只杀 python 会把浏览器留成孤儿（吃显存吃 CPU），所以超时/取消时按**进程组**终止。
    const child = spawn(runtime.python, [script], { stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    let stdout = ''
    let stderr = ''
    let settled = false
    let hardKill: NodeJS.Timeout | null = null
    const timeoutMs = input.timeoutMs ?? 10 * 60_000

    /**
     * 先 SIGTERM（脚本把它翻译成 SystemExit，`finally` 会 browser.close()），
     * 宽限后再对整组 SIGKILL，并清掉本次作业标记下的 Chromium。
     *
     * 为什么还要按标记补一刀：Playwright 的 driver 启动 Chromium 时自己用了 detached，
     * 浏览器**不在** python 的进程组里，光杀进程组够不着它。只杀命令行里带本次 marker 的
     * 进程——绝不按进程名（chrome/chromium）乱杀，那会误伤用户自己的浏览器。
     */
    const stop = (): void => {
      const pid = child.pid
      if (!pid) return
      const signalGroup = (signal: NodeJS.Signals): void => {
        try {
          process.kill(-pid, signal)
        } catch {
          try { child.kill(signal) } catch { /* 已经退出 */ }
        }
      }
      signalGroup('SIGTERM')
      if (!hardKill) {
        hardKill = setTimeout(() => {
          // python 已退出时不能再按旧 PID 杀进程组（PID 可能已复用），但仍需清理独立组的 Chromium。
          if (child.exitCode === null && child.signalCode === null) signalGroup('SIGKILL')
          killMarkedBrowsers(jobMarker)
        }, KILL_GRACE_MS)
      }
    }

    const timer = setTimeout(() => {
      stop()
      finish(new EarthCaptureError(
        `Google Earth 截图超时（${Math.round(timeoutMs / 1000)}s）：Earth 载入或影像加载太慢；`
        + `已向浏览器进程组发 SIGTERM，${Math.round(KILL_GRACE_MS / 1000)}s 后强杀`,
      ))
    }, timeoutMs)

    const onAbort = (): void => {
      stop()
      finish(new EarthCaptureError('Google Earth 截图已被取消，浏览器进程组已终止'))
    }
    input.signal?.addEventListener('abort', onAbort, { once: true })

    const finish = (error: Error | null, value?: EarthSidecar): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(value as EarthSidecar)
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    // 输出上限与同步版一致：截图脚本只回一行 JSON，异常刷屏不该把内存吃光
    child.stdout.on('data', chunk => { if (stdout.length < 16 * 1024 * 1024) stdout += chunk })
    child.stderr.on('data', chunk => { if (stderr.length < 1024 * 1024) stderr += chunk })
    child.on('error', error => {
      const err = error as NodeJS.ErrnoException
      if (err.code === 'ENOENT') {
        finish(new EarthDependencyError(
          `Earth 截图找不到 Python 运行时 ${runtime.python}（来源 ${runtime.source}）：请确认路径存在且可执行。`,
        ))
        return
      }
      finish(new EarthCaptureError(`Google Earth 截图无法启动：${err.message}`))
    })
    child.on('close', code => {
      // Python 退出不证明 detached 的 Chromium 已退出：先清一次，再保留已安排的标记清理兜底。
      if (hardKill) killMarkedBrowsers(jobMarker)
      const detail = (stderr || stdout).trim().slice(-5000)
      if (code !== 0) {
        if (/ModuleNotFoundError|No module named 'playwright'|Executable doesn't exist|BrowserType\.launch/i.test(detail)) {
          finish(new EarthDependencyError(
            `Earth 截图的 Python 运行时缺依赖（${runtime.python}，来源 ${runtime.source}）：${detail}\n`
            + '请在该运行时安装 playwright 与 Pillow（python -m pip install playwright Pillow），并设置 HUOBAO_EARTH_CHROMIUM 指向已安装的 Chrome/Chromium 可执行文件。',
          ))
          return
        }
        finish(new EarthCaptureError(`Google Earth 截图失败（退出码 ${code}）：${detail || '脚本没有输出'}`))
        return
      }
      const line = stdout.trim().split('\n').filter(Boolean).pop() ?? ''
      let sidecar: EarthSidecar & { error?: string }
      try {
        sidecar = JSON.parse(line)
      } catch {
        finish(new EarthCaptureError(`Earth 截图脚本没有返回可解析的结果：${stdout.trim().slice(-800)}`))
        return
      }
      if (sidecar.error) {
        finish(new EarthCaptureError(`Google Earth 截图失败：${sidecar.error}`))
        return
      }
      try {
        verifyEarthCapture(input, plan, sidecar)
      } catch (error) {
        finish(error as Error)
        return
      }
      finish(null, { ...sidecar, note: EARTH_IMAGERY_NOTE, camera_planned: plan.camera })
    })
    child.stdin.on('error', () => { /* 子进程提前退出时的 EPIPE：真正的原因在 close 分支里报 */ })
    if (input.signal?.aborted) onAbort()
    else child.stdin.end(JSON.stringify(job))
  })
}

/**
 * 保存前的验收：图在不在、尺寸对不对、KMZ 是不是真被 Earth 解析了、
 * 用 **Earth 实际回报的相机** 复算一遍几何是否全部落在裁切框内。
 * 任何一条不过就抛错——宁可没有底图，也不要一张不知道拍了哪里的影像。
 */
function verifyEarthCapture(input: EarthCaptureInput, plan: EarthPlan, sidecar: EarthSidecar): void {
  const calibration = sidecar.calibration
  if (sidecar.capture_version !== 'pixelgrid-v2' || !calibration
    || !Number.isFinite(calibration.residual_px?.max) || calibration.residual_px.max > 3
    || !Number.isFinite(calibration.residual_px?.rms)
    || calibration.validation_count < 16
    || !Number.isFinite(calibration.camera_drift_px) || calibration.camera_drift_px > 0.25
    || !fs.existsSync(calibration.screenshot)
    || !calibration.grid || calibration.grid.points.length !== calibration.grid.cols * calibration.grid.rows
    || calibration.grid.points.some(point => !Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite))) {
    throw new EarthCaptureError('Earth 实际像素校准证据缺失或残差超限（独立留出点须 ≤3px、相机漂移须 ≤0.25px）；不接受仅模型公式往返自洽的登记件')
  }
  if (!fs.existsSync(input.outAbsPath)) {
    throw new EarthCaptureError('Earth 截图脚本声称成功，但底图文件不存在')
  }
  if (!fs.existsSync(input.evidenceAbsPath)) {
    throw new EarthCaptureError('Earth 载入 KMZ 的证据图缺失，无法证明本地 KML 真的被解析')
  }
  if (!sidecar.kmz_folders?.length) {
    throw new EarthCaptureError('Earth 的图层树里没有出现 KMZ 的文件夹：本地 KML 没有被解析，拒绝把这次结果当作 Earth 底图')
  }
  if (sidecar.kmz_sha256 !== input.kmzSha256) {
    throw new EarthCaptureError(
      `Earth 载入的 KMZ 与本次生成的不一致（脚本 ${sidecar.kmz_sha256?.slice(0, 12)} vs 期望 ${input.kmzSha256.slice(0, 12)}）`,
    )
  }
  const geometry = earthGeometryOf(input.spec)
  const rect = contentRect(geometry, sidecar.camera_used, sidecar.window)
  if (!rect) {
    throw new EarthCaptureError(
      `按 Earth 实际回报的相机（${earthCameraUrl(sidecar.camera_used)}）复算，有几何落在地平线之后，截图不可用`,
    )
  }
  if (!insideClip(rect, sidecar.frame)) {
    throw new EarthCaptureError(
      `按 Earth 实际回报的相机复算，地图超出了无界面画幅（内容 ${rect.map(Math.round).join(',')}，画幅 ${sidecar.frame.width}×${sidecar.frame.height}）`,
    )
  }
  const fill = limbFill(rect, sidecar.window, sidecar.camera_used.distance_m, sidecar.camera_used.fov_deg)
  if (fill > LIMB_USABLE) {
    throw new EarthCaptureError(
      `裁切框会拍到地球边缘（占地平线半径 ${(fill * 100).toFixed(0)}%，上限 ${(LIMB_USABLE * 100).toFixed(0)}%），拒绝保存`,
    )
  }
  // 裁切框必须覆盖按实际相机复算的内容矩形，否则像素登记与画面对不上
  const crop = sidecar.crop
  if (rect[0] < crop.x - 1 || rect[1] < crop.y - 1
    || rect[2] > crop.x + crop.width + 1 || rect[3] > crop.y + crop.height + 1) {
    throw new EarthCaptureError(
      `裁切框 ${JSON.stringify(crop)} 没有完整包含按实际相机复算的内容 ${rect.map(v => Math.round(v)).join(',')}`,
    )
  }
  if (sidecar.image.width !== crop.width || sidecar.image.height !== crop.height) {
    throw new EarthCaptureError(
      `截图尺寸 ${sidecar.image.width}×${sidecar.image.height} 与裁切框 ${crop.width}×${crop.height} 不一致`,
    )
  }
  if (Math.abs(sidecar.camera_used.fov_deg - plan.camera.fov_deg) > 0.01) {
    throw new EarthCaptureError(
      `Earth 使用的视场角 ${sidecar.camera_used.fov_deg}° 与计划的 ${plan.camera.fov_deg}° 不同，像素登记不可信`,
    )
  }
}
