/**
 * 地图产出的大图预览标识（Issue #84 / #86 / #107）。
 *
 * 预览只认「产出身份」（底图 / 纹理 / 成品 / Earth 标定证据 / 某个画中画细节 / 组合图），
 * 绝不把签名或临时 URL 写进地址栏：刷新或新开标签时由当前工作流详情重新求值，
 * 产出被重跑替换后链接仍指向同一身份的最新一版。
 */
import type { MapStudioOutputs } from '~/map-studio/api'
import type { MapRegistration } from '~/map-studio/utils/mapRegistration'
import { mediaUrl } from '~/utils/url'

export const MAP_PREVIEW_VIEWS = ['base', 'texture', 'final', 'calibration'] as const
/** 画中画组合图的预览身份；细节图用 `pip-detail:<no>`（no 是 frame.no，从 1 起） */
export const PIP_COMPOSITE_VIEW = 'pip-composite'
const PIP_DETAIL_PATTERN = /^pip-detail:([1-9]\d{0,2})$/

export type MapFixedPreviewView = typeof MAP_PREVIEW_VIEWS[number]
export type MapPipDetailView = `pip-detail:${number}`
export type MapPreviewView = MapFixedPreviewView | typeof PIP_COMPOSITE_VIEW | MapPipDetailView

/** 产出字段 ↔ URL 值：URL 用短名，i18n 与 outputs 仍用后端字段名 */
const OUTPUT_KEY: Record<Exclude<MapFixedPreviewView, 'calibration'>, 'base_image' | 'texture_image' | 'final_image'> = {
  base: 'base_image',
  texture: 'texture_image',
  final: 'final_image',
}

/** 运行时同时给 TS 收窄：固定产出身份与画中画身份走不同的求值分支 */
function isFixedPreviewView(view: string): view is MapFixedPreviewView {
  return (MAP_PREVIEW_VIEWS as readonly string[]).includes(view)
}

/** i18n key 后缀 + 插值参数：细节图要带上编号与帧标题 */
export interface MapPreviewLabel { key: string, params?: Record<string, unknown> }

export interface MapPreviewImage {
  view: MapPreviewView
  url: string
  /** i18n key 后缀：results.<labelKey> */
  labelKey: string
  labelParams?: Record<string, unknown>
  width: number
  height: number
  /** 画中画细节/组合图是确定性渲染的产物，没有影像来源，这里为空串，调用方不显示来源行 */
  source: string
}

/** 细节编号 → 预览身份；编号不是正整数时返回 null，绝不给一个会被当成 1 号细节的坏值 */
export function pipDetailView(no: unknown): MapPipDetailView | null {
  return typeof no === 'number' && Number.isInteger(no) && no >= 1 ? `pip-detail:${no}` : null
}

/** 预览身份里的细节编号；不是细节身份返回 null */
export function pipDetailNo(view: MapPreviewView): number | null {
  const match = PIP_DETAIL_PATTERN.exec(view)
  return match ? Number(match[1]) : null
}

/** 地址栏值 → 预览身份：只认固定产出与 pip 两种写法，非法值返回 null（调用方给可读提示并清键） */
export function mapPreviewView(value: unknown): MapPreviewView | null {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (isFixedPreviewView(raw)) return raw
  if (raw === PIP_COMPOSITE_VIEW) return PIP_COMPOSITE_VIEW
  return PIP_DETAIL_PATTERN.test(raw) ? raw as MapPipDetailView : null
}

/**
 * 预览标题的 i18n key 与参数。与图片是否已求值无关：产出被回退清掉时也要能说出「哪个预览不可用」。
 * 细节图的帧标题来自当前 pip.frames；找不到帧就只给编号，不编标题。
 */
export function mapPreviewLabel(view: MapPreviewView, outputs: MapStudioOutputs | null | undefined): MapPreviewLabel {
  if (isFixedPreviewView(view)) return { key: view === 'calibration' ? 'calibrationEvidence' : OUTPUT_KEY[view] }
  const no = pipDetailNo(view)
  if (no === null) return { key: 'pipComposite' }
  const frame = outputs?.pip?.frames.find(item => item.no === no)
  return { key: 'pipDetail', params: { no, label: frame?.label ?? '' } }
}

/**
 * 求值某个预览身份当前对应的真实图片；该产出还没有（未跑到该阶段、已回退清掉、画中画细节还没渲染）时返回 null，
 * 调用方必须据此给出可读提示，绝不能显示空白大图或旧图。
 */
export function mapPreviewImage(
  view: MapPreviewView,
  outputs: MapStudioOutputs | null | undefined,
  registration: MapRegistration | null | undefined,
): MapPreviewImage | null {
  const label = mapPreviewLabel(view, outputs)
  if (isFixedPreviewView(view)) {
    if (view === 'calibration') {
      const earth = registration?.earth
      if (!earth?.calibration_image) return null
      return {
        view,
        url: mediaUrl(earth.calibration_image),
        labelKey: label.key,
        width: earth.window.width,
        height: earth.window.height,
        source: 'Google Earth',
      }
    }
    const image = outputs?.[OUTPUT_KEY[view]]
    if (!image?.path) return null
    return {
      view,
      url: mediaUrl(image.path),
      labelKey: label.key,
      width: image.width,
      height: image.height,
      source: image.source || '-',
    }
  }
  const no = pipDetailNo(view)
  if (no !== null) {
    const detail = outputs?.pip?.details.find(item => item.no === no)
    if (!detail?.path) return null
    return { view, url: mediaUrl(detail.path), labelKey: label.key, labelParams: label.params, width: detail.width, height: detail.height, source: '' }
  }
  const composite = outputs?.pip?.composite
  if (!composite?.path) return null
  return { view, url: mediaUrl(composite.path), labelKey: label.key, width: composite.width, height: composite.height, source: '' }
}
