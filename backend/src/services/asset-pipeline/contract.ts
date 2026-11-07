/**
 * 流水线的**启动/续跑契约**（Issue #73）—— 纯函数，不读库、不发网络
 *
 * 这里只放三件产品硬约束的判定，拿出来单测，调用方（run/route/workflow）只负责接错误：
 * ① 轮次推进：打回重修默认**继续当前用途**（精确轮继续精确），人可以显式改成美化；
 *    轮次块数写死在图里（精确起步 3 块、美化起步 2 块），美化累计 ≤2 轮。
 * ② 精确轮参考图：必须是**启动时人选定**的 1–3 条已入库素材，0 条不许出图。
 *    老 run 的快照里没有选择记录，才退回「前 3 条 generation_reference」，仍然 0 条就报错。
 * ③ 出图配置：显式指定的 config/model 必须是启用中的图片配置里真实存在的组合。
 */
import { MAX_BEAUTIFY_ROUNDS } from './gate.js'
import type { RoundPurpose, SourceRole } from './store.js'

/** 精确轮参考图张数上限（出图服务的多图输入上限，也是人工可控的规模） */
export const MAX_PIPELINE_REFERENCES = 3

/** 人选的参考图不成立（数量、归属、角色、文件缺失） */
export class ReferenceSelectionError extends Error {}
/** 指定的出图配置/模型不成立 */
export class ImageSelectionError extends Error {}
/** 下一轮无处可去（块数用满、美化轮用满、用途非法） */
export class RoundPlanError extends Error {}

export interface RoundPlan {
  purpose: RoundPurpose
  /** 下一轮的 round_no（= 轮次块 index） */
  index: number
}

export function planNextRound(input: {
  currentPurpose: RoundPurpose
  currentRoundNo: number
  /** 人显式选的下一轮用途；不给就沿用当前轮 */
  requested?: RoundPurpose | null
  /** 本 run 已经跑掉的美化轮数 */
  beautifyDone: number
  /** 本 run 的轮次块总数（roundPurposes(...).length） */
  maxRounds: number
}): RoundPlan {
  const requested = input.requested ?? null
  if (requested !== null && requested !== 'precision' && requested !== 'beautify') {
    throw new RoundPlanError('下一轮用途只能是 precision（精确轮）或 beautify（美化轮）')
  }
  const purpose: RoundPurpose = requested ?? input.currentPurpose
  const index = input.currentRoundNo + 1
  if (index >= input.maxRounds) {
    throw new RoundPlanError(`本条流水线最多 ${input.maxRounds} 轮，第 ${input.currentRoundNo} 轮之后无法再开新轮，请回退到此前通过的轮次或终止后重新发起`)
  }
  if (purpose === 'beautify' && input.beautifyDone >= MAX_BEAUTIFY_ROUNDS) {
    throw new RoundPlanError(`美化轮已用满 ${MAX_BEAUTIFY_ROUNDS} 轮，无法再开美化轮`)
  }
  return { purpose, index }
}

/** `selectPrecisionSources` 只认这几列，便于单测直接喂字面量 */
export interface SelectableSource {
  id: number
  role: SourceRole
  local_path: string
}

/**
 * 精确轮参考图选择。`ids` 来自启动时冻结的人工选择；
 * `undefined` 表示这条 run 是新契约之前启动的（快照里没有选择），才走兼容口径。
 */
export function selectPrecisionSources<T extends SelectableSource>(sources: T[], ids?: number[] | null): T[] {
  const pool = Array.isArray(sources) ? sources : []
  if (ids === undefined || ids === null) {
    const legacy = pool.filter(item => item.role === 'generation_reference' && Boolean(item.local_path?.trim()))
      .slice(0, MAX_PIPELINE_REFERENCES)
    if (!legacy.length) {
      throw new ReferenceSelectionError('精确轮没有可用的生成参考图（该 run 启动时未记录参考图选择），请用新启动流程选择参考')
    }
    return legacy
  }
  if (!ids.length) throw new ReferenceSelectionError(`精确轮必须选择 1–${MAX_PIPELINE_REFERENCES} 张已入库的生成参考图`)
  if (ids.length > MAX_PIPELINE_REFERENCES) {
    throw new ReferenceSelectionError(`精确轮参考图最多 ${MAX_PIPELINE_REFERENCES} 张，当前选了 ${ids.length} 张`)
  }
  const seen = new Set<number>()
  const picked: T[] = []
  for (const raw of ids) {
    const id = Number(raw)
    if (!Number.isInteger(id) || id <= 0) throw new ReferenceSelectionError(`参考图 id「${raw}」不是合法的素材编号`)
    if (seen.has(id)) throw new ReferenceSelectionError(`参考图 #${id} 被重复选择`)
    seen.add(id)
    const row = pool.find(item => item.id === id)
    if (!row) throw new ReferenceSelectionError(`参考图 #${id} 不属于该资产，请在该资产的素材库里选择`)
    if (row.role === 'rejected') throw new ReferenceSelectionError(`参考图 #${id} 已被标记为「排除」，不能用作生成参考`)
    if (!row.local_path?.trim()) throw new ReferenceSelectionError(`参考图 #${id} 没有本地文件，请先重新入库`)
    picked.push(row)
  }
  return picked
}
