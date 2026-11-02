/**
 * 资产批量生成的选集判定与统计（纯函数，不碰数据库；Issue #33）
 *
 * 判定顺序是硬约束（Issue #33 §修改思路-后端-3，验收 12）：
 *   skip_faithful > skip_running > need_prompt > skip_has_image > ready
 * `need_prompt` 必须排在 `skip_has_image` 之前——「有图但没有提示词」的资产要先补提示词再出新版本图（Q3），
 * 顺序写反会让这些资产被默认跳过。
 *
 * 语义：
 * - `skip_faithful`：当前图是人工上传 / 跨项目导入的忠实素材，勾了「覆盖已有图片」也不碰（Q5）。
 * - `skip_running`：该资产已有活跃的图像任务，无论勾什么都跳过。
 * - `need_prompt`：没有有效提示词，或勾了「重写提示词」；先跑提示词，成功后出图。
 * - `skip_has_image`：已有图且有提示词，没勾「覆盖已有图片」（Q1）。
 * - `ready`：提示词可直接复用，出图（缺图，或勾了覆盖）。
 */
import type { FinalPromptOutcome } from './final-prompt.js'
import type { AssetKind } from './reference-images.js'

export type { AssetKind } from './reference-images.js'

/** 四个批量入口 */
export type AssetBatchScope = 'characters' | 'scenes' | 'props' | 'all'

export const ASSET_BATCH_SCOPES: AssetBatchScope[] = ['characters', 'scenes', 'props', 'all']

export function isAssetBatchScope(value: unknown): value is AssetBatchScope {
  return typeof value === 'string' && (ASSET_BATCH_SCOPES as string[]).includes(value)
}

/** 忠实素材：人工上传（register-upload）与跨项目导入复制出的版本行 */
export const FAITHFUL_PROVIDERS = ['upload', 'import']

export type AssetSelectionState = 'ready' | 'need_prompt' | 'skip_has_image' | 'skip_running' | 'skip_faithful'

export interface AssetBatchOptions {
  /** 勾「重写提示词」：已有提示词也重新生成 */
  rewritePrompts: boolean
  /** 勾「覆盖已有图片」：已有图的资产也重新出图 */
  overwriteImages: boolean
}

export interface AssetSelectionInput {
  /** 当前有成片图（image_url 非空） */
  hasImage: boolean
  /** 有可直接复用的最终提示词（场景还要求提示词写到了场景时间） */
  hasPrompt: boolean
  /** 当前图来自人工上传 / 跨项目导入 */
  faithful: boolean
  /** 该资产存在活跃的图像 sys_task */
  running: boolean
}

export function classifyAsset(input: AssetSelectionInput, opts: AssetBatchOptions): AssetSelectionState {
  if (input.faithful) return 'skip_faithful'
  if (input.running) return 'skip_running'
  if (!input.hasPrompt || opts.rewritePrompts) return 'need_prompt'
  if (input.hasImage && !opts.overwriteImages) return 'skip_has_image'
  return 'ready'
}

/** 提示词阶段结论 → 是否出图：只有 failed 不出图，也不拿库里残留的旧提示词兜底（Q4 / Q12） */
export function shouldSubmitImage(outcome: FinalPromptOutcome): boolean {
  return outcome !== 'failed'
}

export interface AssetBatchPlanItem {
  kind: AssetKind
  asset_id: number
  name: string
  selection: AssetSelectionState
  /** 判定时资产是否已有有效提示词（区分「缺提示词」与「重写提示词」两类统计） */
  has_prompt: boolean
}

export interface AssetBatchPreviewCounts {
  total: number
  will_generate: {
    missing_prompt: number
    reuse_prompt: number
    rewrite_prompt: number
  }
  skipped: {
    has_image: number
    running: number
    faithful: number
  }
}

/** 分类统计（确认框口径，不是 per-item 清单）：will_generate 三项之和 = 本次真正会处理的资产数 */
export function summarizeAssetBatchPlan(items: AssetBatchPlanItem[]): AssetBatchPreviewCounts {
  const counts: AssetBatchPreviewCounts = {
    total: items.length,
    will_generate: { missing_prompt: 0, reuse_prompt: 0, rewrite_prompt: 0 },
    skipped: { has_image: 0, running: 0, faithful: 0 },
  }
  for (const item of items) {
    switch (item.selection) {
      case 'need_prompt':
        if (item.has_prompt) counts.will_generate.rewrite_prompt++
        else counts.will_generate.missing_prompt++
        break
      case 'ready':
        counts.will_generate.reuse_prompt++
        break
      case 'skip_has_image':
        counts.skipped.has_image++
        break
      case 'skip_running':
        counts.skipped.running++
        break
      case 'skip_faithful':
        counts.skipped.faithful++
        break
    }
  }
  return counts
}

export interface AssetVersionRow {
  provider: string | null
  resultUrl: string | null
  localPath: string | null
}

/**
 * 忠实素材判定（Q5，本期不加 schema 字段）：当前图对应的版本行里有 provider ∈ {upload, import} 就算。
 * 同一张图可能同时被生成行和上传行引用（上传注册会复用已有文件路径），按 Q5「宁可多跳过」取任一命中。
 * 当前图找不到任何对应版本行（例如直接 PUT 写进来的地址）时不算忠实素材——用户把当前版本切回
 * 生成版本即解除保护，这与「当前版本决定保护」的语义一致。
 */
export function isFaithfulCurrentImage(
  asset: { imageUrl: string | null; localPath: string | null },
  versions: AssetVersionRow[],
): boolean {
  const current = (asset.imageUrl || asset.localPath || '').trim()
  if (!current) return false
  return versions.some(v =>
    FAITHFUL_PROVIDERS.includes(v.provider || '')
    && ((v.localPath || '').trim() === current || (v.resultUrl || '').trim() === current))
}
