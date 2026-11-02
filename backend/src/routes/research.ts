/**
 * 资料检索路由（Issue #32）— 人在火宝 UI 里能独立完成的联网能力
 *
 *   GET /research/commons/search?q=&limit=   Commons 画像检索（服务端按白名单代理）
 *   GET /research/citations?asset_kind=&asset_id=   某资产的「资料来源」记录
 *
 * 只接受检索词与资产标识，不接受任意 URL：外部 URL 下载是明确不做的事（防 SSRF）。
 */
import { Hono } from 'hono'
import { badRequest, success } from '../utils/response.js'
import { toSnakeCaseArray } from '../utils/transform.js'
import { RESEARCH_MAX_RESULTS } from '../config/research.js'
import { commonsSearch, ResearchUnavailableError } from '../services/wiki-research.js'
import { listAssetCitations } from '../services/research-citations.js'
import type { AssetKind } from '../services/reference-images.js'

const app = new Hono()

const ASSET_KINDS: Record<string, AssetKind> = { character: 'character', scene: 'scene', prop: 'prop' }

// GET /research/commons/search — Wikimedia Commons 图片检索（缩略图 + 作者/年代/许可证）
app.get('/commons/search', async (c) => {
  const q = (c.req.query('q') || '').trim()
  if (!q) return badRequest(c, '检索词必填')
  const limit = Math.min(Number(c.req.query('limit')) || RESEARCH_MAX_RESULTS, RESEARCH_MAX_RESULTS)
  try {
    const files = await commonsSearch(q, limit)
    return success(c, { query: q, results: files, retrieved_at: new Date().toISOString() })
  } catch (err) {
    if (err instanceof ResearchUnavailableError) return badRequest(c, err.message)
    return badRequest(c, err instanceof Error ? err.message : '检索失败')
  }
})

// GET /research/citations — 资产详情的「资料来源」列表
app.get('/citations', async (c) => {
  const kind = ASSET_KINDS[c.req.query('asset_kind') || '']
  const assetId = Number(c.req.query('asset_id'))
  if (!kind) return badRequest(c, 'asset_kind 必须是 character / scene / prop')
  if (!assetId) return badRequest(c, 'asset_id 必填')
  return success(c, toSnakeCaseArray(await listAssetCitations(kind, assetId)))
})

export default app
