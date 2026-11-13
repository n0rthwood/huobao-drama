/**
 * 地图产出的大图预览标识（Issue #84 / #86）。
 *
 * 预览只认「产出身份」（底图 / 纹理 / 成品 / Earth 标定证据），绝不把签名或临时 URL 写进地址栏：
 * 刷新或新开标签时由当前工作流详情重新求值，产出被重跑替换后链接仍指向同一身份的最新一版。
 */
import type { MapStudioOutputs } from '~/map-studio/api'
import type { MapRegistration } from '~/map-studio/utils/mapRegistration'
import { mediaUrl } from '~/utils/url'

export const MAP_PREVIEW_VIEWS = ['base', 'texture', 'final', 'calibration'] as const
export type MapPreviewView = typeof MAP_PREVIEW_VIEWS[number]

/** 产出字段 ↔ URL 值：URL 用短名，i18n 与 outputs 仍用后端字段名 */
const OUTPUT_KEY: Record<Exclude<MapPreviewView, 'calibration'>, 'base_image' | 'texture_image' | 'final_image'> = {
  base: 'base_image',
  texture: 'texture_image',
  final: 'final_image',
}

export interface MapPreviewImage {
  view: MapPreviewView
  url: string
  /** i18n key 后缀：results.<labelKey> */
  labelKey: string
  width: number
  height: number
  source: string
}

export function mapPreviewView(value: unknown): MapPreviewView | null {
  const raw = typeof value === 'string' ? value.trim() : ''
  return (MAP_PREVIEW_VIEWS as readonly string[]).includes(raw) ? raw as MapPreviewView : null
}

/**
 * 求值某个预览身份当前对应的真实图片；该产出还没有（未跑到该阶段、已回退清掉）时返回 null，
 * 调用方必须据此给出可读提示，绝不能显示空白大图或旧图。
 */
export function mapPreviewImage(
  view: MapPreviewView,
  outputs: MapStudioOutputs | null | undefined,
  registration: MapRegistration | null | undefined,
): MapPreviewImage | null {
  if (view === 'calibration') {
    const earth = registration?.earth
    if (!earth?.calibration_image) return null
    return {
      view,
      url: mediaUrl(earth.calibration_image),
      labelKey: 'calibrationEvidence',
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
    labelKey: OUTPUT_KEY[view],
    width: image.width,
    height: image.height,
    source: image.source || '-',
  }
}
