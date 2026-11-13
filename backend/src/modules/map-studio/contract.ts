/**
 * 地图工作室 ↔ 宿主（火宝）的进程内契约（Issue #99 契约 §2）
 *
 * 依赖倒置：模块只认识这五个类型，不认识道具、剧集、资产库或任务中心。
 * 火宝侧实现 `MapStudioHost`（需求读写、目标描述、成果回收）与 `MapStudioPlatform`
 * （底纹出图、旧检索 key 种子），在启动时注入；模块对宿主目标的每次读写都经由这两个对象。
 *
 * 落在这里的类型是**唯一**允许火宝 import 的契约面（`modules/map-studio/contract.js`）。
 */
import type { MapBrief } from './types.js'

/** 宿主目标引用：火宝用 `prop:<id>` */
export type MapStudioHostRef = string

export interface MapStudioHostTarget {
  /** 道具名 */
  title: string
  /** 《剧名》E02 等 */
  subtitle: string | null
  /** 火宝内的 SPA 路径（不含 baseURL 前缀），如 `/drama/20/episode/1?panel=assets` */
  return_path: string | null
}

export interface MapStudioDeliverable {
  task_id: number
  final_image: { path: string; width: number; height: number; sha256: string }
  base_image: { path: string; width: number; height: number; mode: 'program' | 'image' | 'earth'; provenance: object | null }
  texture_image: { path: string } | null
  /** 像素几何（width/height/points/lines/regions/labels），宿主按自己的语义规范化 */
  semantics: unknown
  /** 要素出处与核验：{ feature_id, name, kind, category, origin: dataset|source|model|manual, verification, relations, dataset_ref, proposed, source_ids, coordinate_basis, excerpt }；宿主不解释。 */
  features: unknown[]
  /** research.sources 原样 */
  sources: unknown[]
  kmz: { path: string } | null
  /** 可编辑源文件：{ version, map_spec, layer_doc, layer_options }；宿主不解释平滑参数。 */
  editable_source: unknown
  /** 来自人工图层编辑保存 */
  manual_edit: boolean
  /** 人话摘要（N 点 / N 线 / N 面，底图路线） */
  summary: string
}

export interface MapStudioDeliveryResult {
  version_ids: number[]
  message: string
}

export interface MapStudioHost {
  /** 'huobao' */
  id: string
  /** null = 目标已删除/不是地图（UI 只读提示，run/deliver 400 host_target_missing） */
  describe(ref: MapStudioHostRef): Promise<MapStudioHostTarget | null>
  /** 每次被调用都读最新（外部改动要与 state 内快照的 brief_hash 比对） */
  readBrief(ref: MapStudioHostRef): Promise<MapBrief | null>
  writeBrief(ref: MapStudioHostRef, brief: MapBrief): Promise<void>
  /** 交付；同一任务同一 final_image.sha256 再次调用必须幂等（返回已登记的版本，不重复插行） */
  deliver(ref: MapStudioHostRef, deliverable: MapStudioDeliverable): Promise<MapStudioDeliveryResult>
}

/** 进程级基础设施注入（火宝 index.ts 启动时提供） */
export interface MapStudioPlatform {
  /** 底纹出图：宿主实现为火宝的图片任务（任务中心可见、计费可追溯）；返回不透明引用 */
  submitImage(input: {
    prompt: string
    size: string
    configId?: number
    model?: string
    label: string
    hostRef: MapStudioHostRef | null
  }): Promise<{ ref: string }>
  pollImage(ref: string): Promise<{ status: 'pending' | 'completed' | 'failed' | 'cancelled' | 'missing'; path: string | null; error: string | null }>
  /** 一次性种子：模块研究 key 设置为空时调用 */
  legacyResearchKeys?(): Promise<Record<string, string>>
}
