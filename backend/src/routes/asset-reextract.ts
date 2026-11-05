/**
 * 单资产「重新提取本资产信息」（Issue #32）— 角色 / 场景 / 道具共用一套实现
 *
 *   POST /:id/re-extract  { episode_id, text_model?, text_config_id? }
 *
 * 先清空该资产的提取字段（角色 role/description/appearance/styling；场景 prompt/lighting；
 * 道具 type/description）再跑提取 Agent：save_dedup_* 对已有非空字段「只补空白」
 * （Issue #15 的刻意设计，不改），不清空就测不出规则改动的效果。
 * 字段被清空意味着旧的最终提示词也失效（Issue #24 同语义），一并置空来源标记。
 */
import type { Context, Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { badRequest, success, now } from '../utils/response.js'
import { logTaskStart } from '../utils/task-logger.js'
import { EXTRACT_TASK_KINDS, startSingleAssetExtraction, type ExtractTarget } from '../services/extraction.js'
import { findActiveTextTask } from '../services/text-task.js'
import type { AssetKind } from '../services/reference-images.js'
import { assertGate } from '../services/workflow-gates.js'

const TARGET_OF: Record<AssetKind, ExtractTarget> = {
  character: 'characters',
  scene: 'scenes',
  prop: 'props',
}

/** 被清空的提取字段（与各资产 extractor 工具可写的字段一致） */
const CLEARED_FIELDS: Record<AssetKind, string[]> = {
  character: ['role', 'description', 'appearance', 'styling'],
  scene: ['prompt', 'lighting'],
  prop: ['type', 'description'],
}

export function mountReExtractRoute(app: Hono, kind: AssetKind) {
  app.post('/:id/re-extract', async (c: Context) => {
    const id = Number(c.req.param('id'))
    const body = await c.req.json()
    const episodeId = Number(body.episode_id)
    if (!episodeId) return badRequest(c, 'episode_id 必填')

    const table = kind === 'character' ? schema.characters : kind === 'scene' ? schema.scenes : schema.props
    const [row] = await db.select().from(table).where(eq(table.id, id))
    if (!row) return badRequest(c, '资产不存在')

    const name = kind === 'scene'
      ? (row as typeof schema.scenes.$inferSelect).location
      : (row as typeof schema.characters.$inferSelect).name
    // 门禁（#54）：重新提取属于「资产」步，纪录片剧本未确认时拒绝——必须在清字段之前拦，
    // 否则被拦的请求会把资产清成空壳。资产生图/美化流水线不拦（资产是项目级、可跨集复用）。
    await assertGate(episodeId, 'assets')
    // 先确认能起任务再清字段：清空后才发现同类任务在跑的话，这个资产会被清成空壳
    // （startSingleAssetExtraction 返回 false，字段已经没了）
    if (await findActiveTextTask(episodeId, EXTRACT_TASK_KINDS[TARGET_OF[kind]])) {
      return badRequest(c, '该集的同类提取任务正在运行，请等它结束')
    }

    const ts = now()
    const cleared: Record<string, string | null> = { updatedAt: ts, finalPrompt: null, finalPromptSource: null, finalPromptUpdatedAt: null }
    // 场景的 prompt 是 NOT NULL，清成空串而不是 NULL
    for (const field of CLEARED_FIELDS[kind]) cleared[field] = ''
    await db.update(table).set(cleared).where(eq(table.id, id))

    logTaskStart('Extract', `${kind}-re-extract`, { assetId: id, episodeId, name })
    const started = await startSingleAssetExtraction(episodeId, row.dramaId, TARGET_OF[kind], name, {
      model: body.text_model || undefined,
      configId: body.text_config_id ?? undefined,
    })
    // 竞态兜底：两个请求同时挤进来时，后到的那个把字段还原不了，只能如实报错
    if (!started) return badRequest(c, '该集的同类提取任务正在运行，请等它结束')
    return success(c, { started: true, asset_id: id, cleared_fields: CLEARED_FIELDS[kind] })
  })
}
