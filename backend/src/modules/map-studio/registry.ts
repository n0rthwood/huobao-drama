/**
 * 进程级注入点（Issue #99 契约 §1/§2）：宿主与平台在火宝 `index.ts` 启动时注入一次。
 *
 * 模块内所有对外部世界的依赖都从这里取：
 * - `getPlatform()`：底纹出图（宿主图片任务）与旧检索 key 的一次性种子；
 * - `getHost(id)`：宿主任务的需求读写、目标描述与成果回收。
 *
 * 未注入时（独立跑测试、模块页面在未被接线的进程里）操作会得到明确的 400/500 说明，
 * 而不是静默降级成「假装完成」。
 */
import type { MapStudioHost, MapStudioPlatform } from './contract.js'

export const HUOBAO_HOST_ID = 'huobao'

let platform: MapStudioPlatform | null = null
const hosts = new Map<string, MapStudioHost>()

export function setMapStudioPlatform(value: MapStudioPlatform | null): void {
  platform = value
}

export function getMapStudioPlatform(): MapStudioPlatform {
  if (!platform) {
    throw new Error('地图工作室的平台能力未注入：底纹出图与检索 key 种子需要宿主在启动时调用 initMapStudio(platform)')
  }
  return platform
}

export function registerMapStudioHost(host: MapStudioHost): void {
  hosts.set(host.id, host)
}

export function unregisterMapStudioHost(id: string): void {
  hosts.delete(id)
}

export function getHost(id: string): MapStudioHost | null {
  return hosts.get(id) ?? null
}
