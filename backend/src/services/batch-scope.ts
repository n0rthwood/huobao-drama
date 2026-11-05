/**
 * 批量入口的「范围清单」（Issue #58，契约 §4 + Fabel §4.2/W3）。
 *
 * 所有批量按钮先让用户看清单再提交：**将处理 n 镜 / 排除 m 镜及原因**。
 * 本文件只提供「哪些镜会被处理、为什么被排除」的纯查询，真正的批量任务仍走原有服务；
 * 同一份 `{included, excluded}` 由调用方随任务落进 `params.scope`（快照口径与 R7 的批量统一）。
 *
 * 排除原因（按组合，不再按 device 跳步）：
 * - 组合 A：本镜没有生成段 → 关键帧提示词/关键帧/视频提示词都不处理；
 * - 设计卡未确认：制作产物一律不出（门禁）。
 */
import { and, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { toCombo, toDesignCardStatus, hasGenSegment } from './design-card.js'

export interface BatchScopeShot {
  storyboard_id: number
  storyboard_number: number
}

export interface BatchScopeExcluded extends BatchScopeShot {
  reason: string
}

export interface BatchScope {
  included: BatchScopeShot[]
  excluded: BatchScopeExcluded[]
}

export interface BatchScopePreviewItem extends BatchScopeShot {
  status: string
  checked?: boolean
  selectable?: boolean
  reason?: string
}

/** Build the exact execution snapshot from server preview rows, never client media or scope. */
export function scopeFromPreview(items: BatchScopePreviewItem[], selectedIds?: number[]): BatchScope {
  const selected = selectedIds === undefined ? null : new Set(selectedIds)
  const scope: BatchScope = { included: [], excluded: [] }
  for (const item of items) {
    const shot = { storyboard_id: item.storyboard_id, storyboard_number: item.storyboard_number }
    const eligible = item.selectable ?? ['missing', 'changed', 'unchanged', 'unknown'].includes(item.status)
    const included = eligible && (selected ? selected.has(item.storyboard_id) : (item.checked ?? ['missing', 'changed'].includes(item.status)))
    if (included) scope.included.push(shot)
    else scope.excluded.push({ ...shot, reason: item.reason || (item.status === 'unchanged' ? 'unchanged' : eligible ? 'not_selected' : item.status) })
  }
  return scope
}

/** 批量类型：决定排除口径（本 Issue 只覆盖提示词/关键帧；图层渲染与视频批量归 R7） */
export type BatchScopeKind = 'keyframe_prompts' | 'keyframes'

/**
 * 本集某个批量动作的范围：只排除**必然无产出**的镜头（组合 A、设计卡未确认），
 * 其余镜头一律进 `included`（具体槽位是否已生成由各自的 preview/签名判断）。
 * 指定 `storyboardIds`（选择模式）时只在这批镜里算。
 */
export async function batchScopeOf(episodeId: number, kind: BatchScopeKind, storyboardIds?: number[]): Promise<BatchScope> {
  const rows = await db.select().from(schema.storyboards)
    .where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt)))
    .orderBy(schema.storyboards.storyboardNumber)
  const scope: BatchScope = { included: [], excluded: [] }
  const only = storyboardIds?.length ? new Set(storyboardIds) : null
  for (const row of rows) {
    if (only && !only.has(row.id)) continue
    const shot = { storyboard_id: row.id, storyboard_number: row.storyboardNumber }
    const combo = toCombo(row.combo)
    const status = toDesignCardStatus(row.designCardStatus)
    if (!hasGenSegment(combo)) {
      scope.excluded.push({
        ...shot,
        reason: combo === 'A' ? '组合 A：本镜没有生成段' : '未选择段组合：本镜还没有生成段',
      })
      continue
    }
    if (status !== 'confirmed') {
      scope.excluded.push({ ...shot, reason: `设计卡未确认（${status}）：先在设计步骤确认本镜` })
      continue
    }
    scope.included.push(shot)
  }
  return scope
}

/** 把范围快照写进任务 params（批量任务统一口径：`params.scope = {included, excluded}`） */
export function scopeParam(scope: BatchScope): string {
  return JSON.stringify(scope)
}
