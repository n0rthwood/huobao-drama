/**
 * 资产工作室的**草稿契约**（Issue #123，取代 #73 的轮次推进契约）—— 纯函数，不读库、不发网络
 *
 * 新模型：草稿（draft）→ 人工编辑确认 → 一次生图 → 版本。这里只放产品硬约束的判定，
 * 拿出来单测，调用方（drafts/route）只负责接错误：
 * ① 精确草稿：参考图 = 人选定的已入库素材 + 选中的检索候选，按路径去重后 ≤3 张；
 *    总输入 ≥1（图/检索文本/用户描述任一），0 图合法（纯文本走 t2i）。
 * ② 美化草稿：必须解析到该资产的一张已有版本图（或当前图），无图直接拒绝。
 * ③ 出图配置：显式指定的 config/model 必须是启用中的图片配置里真实存在的组合（ImageSelectionError）。
 */
import type { AssetKind, RoundPurpose, SourceRole } from './store.js'
import type { SemanticsPreserved } from './gate.js'
import type { ResearchCandidate, ResearchText } from './research/run.js'
/** 精确草稿参考图张数上限（出图服务的多图输入上限，也是人工可控的规模） */
export const MAX_PIPELINE_REFERENCES = 3

/** 人选的参考图不成立（数量、归属、角色、文件缺失） */
export class ReferenceSelectionError extends Error {}
/** 指定的出图配置/模型不成立 */
export class ImageSelectionError extends Error {}
/** 草稿输入不成立（空输入、超量、跨资产、美化无图、检索引用失效） */
export class DraftInputError extends Error {}

// ─── 草稿输入（冻结形状）─────────────────────────────────────

export type DraftTab = RoundPurpose

/** 精确草稿里选中的一次检索记录：候选按 sha256 选、文本按结果内下标选 */
export interface DraftResearchSelection {
  research_id: number
  candidate_shas: string[]
  text_indexes: number[]
}

export interface PrecisionDraftInputs {
  source_ids: number[]
  research: DraftResearchSelection[]
  notes: string
}

export interface BeautifyDraftInputs {
  /** null = 创建草稿时的当前图；createDraft 会解析成具体版本行 id 或 legacy 路径 */
  version_task_id: number | null
  notes: string
}

export type DraftInputs = PrecisionDraftInputs | BeautifyDraftInputs

/** 检索记录的最小视图（validate 只认这几列，便于单测直接喂字面量） */
export interface ResearchRecordView {
  id: number
  status: string
  result: {
    candidates?: ResearchCandidate[]
    texts?: ResearchText[]
  } | null
}

/** 版本的最小视图（loadImageVersions 的行） */
export interface VersionView {
  id: number | null
  url: string | null
  is_current: boolean
}

/** validate 只认这几列，便于单测直接喂字面量 */
export interface SelectableSource {
  id: number
  asset_kind: AssetKind
  asset_id: number
  role: SourceRole
  local_path: string
  sha256?: string
}

export interface DraftValidationContext {
  kind: AssetKind
  assetId: number
  sources: SelectableSource[]
  researchRecords: ResearchRecordView[]
  versions: VersionView[]
  /** 资产当前图（美化 version_task_id=null 的回退） */
  currentImageUrl: string | null
}

/** 校验通过后的解析结果：createDraft 据此冻结 inputs */
export interface ResolvedDraftInputs {
  /** 精确：按 source_ids 顺序的素材行 */
  sources: SelectableSource[]
  /** 精确：选中的检索候选（跨记录按 local_path 去重，保持选择顺序） */
  candidates: Array<{ research_id: number; sha256: string; local_path: string }>
  /** 精确：选中的检索文本（冻结摘录快照） */
  texts: Array<{ research_id: number; title: string; excerpt: string }>
  /** 美化：解析出的版本图路径与版本行 id（legacy 当前图为 null） */
  beautify: { version_task_id: number | null; path: string } | null
}

/**
 * 草稿输入校验（纯函数）。所有拒绝都抛 DraftInputError / ReferenceSelectionError，
 * 路由 onError 映射 400。返回解析结果供 createDraft 冻结。
 */
export function validateDraftInputs(tab: DraftTab, inputs: DraftInputs, ctx: DraftValidationContext): ResolvedDraftInputs {
  if (tab === 'beautify') {
    const raw = inputs as BeautifyDraftInputs
    const versionId = raw.version_task_id
    if (versionId != null) {
      const version = ctx.versions.find(v => v.id === versionId)
      if (!version?.url) throw new DraftInputError(`版本 #${versionId} 不是该资产的已完成图片版本`)
      return { sources: [], candidates: [], texts: [], beautify: { version_task_id: versionId, path: version.url } }
    }
    if (!ctx.currentImageUrl) throw new DraftInputError('美化需要已有资产图；请先在精确流程生成或上传资产图')
    const current = ctx.versions.find(v => v.is_current && v.id != null)
    return { sources: [], candidates: [], texts: [], beautify: { version_task_id: current?.id ?? null, path: ctx.currentImageUrl } }
  }

  const raw = inputs as PrecisionDraftInputs
  const sourceIds = Array.isArray(raw.source_ids) ? raw.source_ids : []
  const research = Array.isArray(raw.research) ? raw.research : []
  const notes = String(raw.notes ?? '').trim()

  const seen = new Set<number>()
  const picked: SelectableSource[] = []
  for (const idRaw of sourceIds) {
    const id = Number(idRaw)
    if (!Number.isInteger(id) || id <= 0) throw new ReferenceSelectionError(`参考图 id「${idRaw}」不是合法的素材编号`)
    if (seen.has(id)) throw new ReferenceSelectionError(`参考图 #${id} 被重复选择`)
    seen.add(id)
    const row = ctx.sources.find(item => item.id === id)
    if (!row || row.asset_kind !== ctx.kind || row.asset_id !== ctx.assetId) {
      throw new ReferenceSelectionError(`参考图 #${id} 不属于该资产，请在该资产的素材库里选择`)
    }
    if (row.role === 'rejected') throw new ReferenceSelectionError(`参考图 #${id} 已被标记为「排除」，不能用作生成参考`)
    if (!row.local_path?.trim()) throw new ReferenceSelectionError(`参考图 #${id} 没有本地文件，请先重新入库`)
    picked.push(row)
  }

  const candidates: ResolvedDraftInputs['candidates'] = []
  const texts: ResolvedDraftInputs['texts'] = []
  const candidatePaths = new Set(picked.map(item => item.local_path))
  for (const selection of research) {
    const record = ctx.researchRecords.find(item => item.id === Number(selection.research_id))
    if (!record) throw new DraftInputError(`检索记录 #${selection.research_id} 不存在`)
    if (record.status !== 'completed' || !record.result) throw new DraftInputError(`检索记录 #${selection.research_id} 尚未完成，不能选用`)
    const recordCandidates = record.result.candidates ?? []
    for (const sha of selection.candidate_shas ?? []) {
      const candidate = recordCandidates.find(item => item.sha256 === sha)
      if (!candidate) throw new DraftInputError(`检索记录 #${record.id} 里没有候选 ${sha}`)
      if (!candidate.local_path) throw new DraftInputError(`检索候选 ${sha} 没有本地缓存文件`)
      if (candidatePaths.has(candidate.local_path)) continue
      candidatePaths.add(candidate.local_path)
      candidates.push({ research_id: record.id, sha256: sha, local_path: candidate.local_path })
    }
    const recordTexts = record.result.texts ?? []
    for (const indexRaw of selection.text_indexes ?? []) {
      const index = Number(indexRaw)
      if (!Number.isInteger(index) || index < 0 || index >= recordTexts.length) {
        throw new DraftInputError(`检索记录 #${record.id} 的文本下标 ${indexRaw} 超出范围`)
      }
      const text = recordTexts[index]!
      texts.push({ research_id: record.id, title: String(text.title ?? ''), excerpt: String(text.excerpt ?? '') })
    }
  }

  const imageCount = picked.length + candidates.length
  if (imageCount > MAX_PIPELINE_REFERENCES) {
    throw new ReferenceSelectionError(`参考图最多 ${MAX_PIPELINE_REFERENCES} 张（含检索候选），当前选了 ${imageCount} 张`)
  }
  if (!imageCount && !texts.length && !notes) {
    throw new DraftInputError('请至少选择一张参考图、一条检索文本，或填写描述')
  }
  return { sources: picked, candidates, texts, beautify: null }
}

// ─── Host / Platform 契约 ────────────────────────────────────

export type AssetStudioHostRef = string
export interface AssetStudioTarget { title: string; subtitle: string | null; return_path: string | null }
export interface AssetStudioAssetSnapshot {
 kind: 'character'|'scene'|'prop'; id: number; dramaId: number; episodeId: number | null
 name: string; description: string | null; appearance?: string | null; styling?: string | null
 prompt?: string | null; lighting?: string | null; imageUrl: string | null; faithful: boolean; isMap: boolean
 /** 资产子类型：props.type / characters.role / scenes.time */
 subtype: string | null
 /** popup 链路的最终提示词（只读展示，与工作室 prompt 各自独立） */
 finalPrompt: string | null
 referenceImages: {path:string; usage?:string}[]; fingerprint: string
}
export class AssetStudioDeliveryConflict extends Error {}
export interface AssetStudioHost {
 id: string
 describe(ref:string): Promise<AssetStudioTarget|null>
 readAsset(ref:string): Promise<AssetStudioAssetSnapshot|null>
 adoptOriginal(ref:string,imagePath:string): Promise<{adopted:boolean; reason?:string}>
 deliver(ref:string,d:{runId:number;roundId:number;imagePath:string;sha256:string;setAsCurrent:boolean;sources:unknown[];frozenFingerprint:string}): Promise<{versionId:number|null;message:string}>
 invalidateFinalPrompt(ref:string,specVersion:number): Promise<void>
 semanticsContext(ref:string): Promise<{labels:string[];expected:{id:string;name:string;at:[number,number]}[]}>
 /** 该资产的已完成图片版本（与 popup 版本列表同口径，loadImageVersions） */
 listVersions(ref:string): Promise<VersionView[]>
 /** 上传参考图到资产 reference_images（不触发自动分类/采用），返回最新条目 */
 addReferenceImage(ref:string,file:File): Promise<{path:string; usage?:string}[]>
 removeReferenceImage(ref:string,url:string): Promise<{path:string; usage?:string}[]>
}
export interface AssetStudioPlatform {
 submitImage(input:{hostRef:string;episodeId:number|null;prompt:string;negativePrompt?:string;size?:string;aspectLocked?:boolean;referenceImages:string[];referenceOrigins?:unknown[];configId?:number|null;model?:string|null;roundKey:string}): Promise<{taskId:number}>
 pollImage(taskId:number): Promise<{status:'pending'|'completed'|'failed'|'cancelled'|'missing';path:string|null;error:string|null}>
 imageInputs(taskId:number): Promise<Record<string,unknown>|null>
 cancelImage(taskId:number): Promise<void>
 adoptOrphanImage(hostRef:string,prompt:string,since:string): Promise<number|null>
 stylePrompt(dramaId:number): Promise<string|null>
 sceneSize(dramaId:number): Promise<string>
 researchKeys(): Promise<Record<string,string>>
 imageSelection(input:{configId?:number|null;model?:string|null}): Promise<{configId:number|null;model:string;generator:string}>
 modelOptions(): Promise<unknown[]>
 checkSemantics(input:{hostRef:string;absPath:string;labelsReadable?:{text:string;readable:boolean}[]}): Promise<SemanticsPreserved>
}

export type {AssetKind,RoundPurpose} from './store.js'
export {FIDELITY_LINE_COVERAGE} from './gate.js'
export type {SemanticsPreserved} from './gate.js'