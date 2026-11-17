/**
 * 整集读缓存（Issue #118 A3）——批量读路径专用，键 = episodeId + 加载器。
 *
 * 背景：逐镜批量（提示词 / 设计卡）里 read_storyboard_context 每次重建整集事实，
 * O(镜数 × 整集) 的同步 SQLite 读把 HTTP 事件循环打满。批次生命周期内整集数据
 * 只由本批次自己改写，所以按集缓存整集加载结果、写后失效即可消掉重复查库。
 *
 * 正确性边界（#43）：
 * - 只有**批量读路径**（read_storyboard_context / 批次准备）经过本缓存；
 *   syncStoryboardBindingsFromPrompts 等 #43 同步事务链一律直接读库，绝不读缓存。
 * - 任何可能改变整集事实的写入都使该集缓存整体失效（粗粒度、宁可多失效）：
 *   工具保存（update_storyboard / save_storyboards / 转场保存）与衔接帧描述写入
 *   在写入后调用 invalidateEpisodeReadCache；批次结束/取消/异常在 finally 里
 *   releaseEpisodeReadCache 整体释放，缓存不跨批次存活。
 * - 并发写：同一集的两个批次同时跑时，一方的写入会让另一方下一镜读到新数据
 *   （失效是同步的，写入与失效之间不 await）；交互编辑同理。
 * - D（worker 进程隔离）实施前本缓存只在单进程内有效；跨进程写失效是 D 的前置条件。
 */
import { AsyncLocalStorage } from 'node:async_hooks'

type Loader<T> = () => Promise<T>

interface EpisodeCache {
  entries: Map<string, Promise<unknown>>
}

const scopeALS = new AsyncLocalStorage<EpisodeCache>()
/** 兜底失效登记（无批次作用域的写入也要能清掉别的批次缓存） */
const liveCaches = new Set<EpisodeCache>()

/** 包住一次批量运行（runWithTextTask 内层）；嵌套调用共享外层缓存 */
export function runWithEpisodeReadCache<T>(fn: () => Promise<T>): Promise<T> {
  const existing = scopeALS.getStore()
  if (existing) return fn()
  const cache: EpisodeCache = { entries: new Map() }
  liveCaches.add(cache)
  return scopeALS.run(cache, fn).finally(() => { liveCaches.delete(cache) })
}

/** 缓存命中直接复用；未命中执行 loader 并缓存 Promise（并发读单飞）。无作用域时直接执行。 */
export function cachedEpisodeRead<T>(episodeId: number, key: string, loader: Loader<T>): Promise<T> {
  const cache = scopeALS.getStore()
  if (!cache) return loader()
  const cacheKey = `${episodeId}:${key}`
  const hit = cache.entries.get(cacheKey)
  if (hit) return hit as Promise<T>
  const pending = loader().catch(err => {
    // 失败的加载不缓存：下一镜重试时重新查库
    if (cache.entries.get(cacheKey) === pending) cache.entries.delete(cacheKey)
    throw err
  })
  cache.entries.set(cacheKey, pending)
  return pending
}

/** 写后失效：清掉该集在所有活跃批次里的缓存条目（同步执行，调用方在写库之后立刻调） */
export function invalidateEpisodeReadCache(episodeId: number): void {
  const prefix = `${episodeId}:`
  for (const cache of liveCaches) {
    for (const key of cache.entries.keys()) {
      if (key.startsWith(prefix)) cache.entries.delete(key)
    }
  }
}

/** 批次收尾显式释放（finally 里调用；runWithEpisodeReadCache 自身也会兜底释放） */
export function releaseEpisodeReadCache(): void {
  const cache = scopeALS.getStore()
  if (cache) cache.entries.clear()
}
