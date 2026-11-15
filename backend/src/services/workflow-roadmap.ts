/** Issue #105: UI 与 AI 共用的工作流完成状态；门禁仍只由 computeGates 决定。 */
import { and, desc, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { assetReviewCounts } from './asset-review.js'
import { EXTRACT_TARGETS, EXTRACT_TASK_KINDS } from './extraction.js'
import { narrationSkeletonState } from './narration-skeleton.js'
import { parseStylingVersion } from './styling-version.js'
import { findActiveTextTask } from './text-task.js'
import { activeRun, getRun, getVersion, listStages, type RunRow, type StageStatus } from './script-rewrite/store.js'
import { REWRITE_STAGES } from './script-rewrite/stages.js'
import { computeGates, episodeGateFactSet, type AssetReviewStatus, type GateFacts, type GateKey } from './workflow-gates.js'

export const ROADMAP_STATUSES = ['draft', 'active', 'completed'] as const
export type WorkflowStatus = typeof ROADMAP_STATUSES[number]
export type StepStatus = 'locked' | 'available' | 'in_progress' | 'done' | 'stale' | 'skipped'
export interface RoadmapMissing { code: string; message: string; count?: number }
export interface RoadmapNotice { code: string; message: string }
export interface RoadmapNode {
  key: string
  label: string
  order: number
  ordering: 'strict' | 'free'
  required_before?: 'export'
  status: StepStatus
  criteria_met: boolean
  unlocked: boolean
  lock_reason: string | null
  goto: string | null
  done_criteria: string[]
  missing: RoadmapMissing[]
  notices: RoadmapNotice[]
  blocked_by: string[]
  counts?: { done: number; total: number }
  substeps: RoadmapNode[]
}
export interface RoadmapMilestone {
  key: 'm1_script' | 'm2_production' | 'm3_export'
  label: string
  status: 'done' | 'in_progress' | 'pending' | 'stale'
  achieved_at: string | null
  steps: string[]
  done_criteria: string[]
}
export interface Roadmap {
  episode_id: number
  drama_id: number
  project_type: 'documentary' | 'drama'
  strict: boolean
  status: { effective: WorkflowStatus; derived: WorkflowStatus; override: WorkflowStatus | null }
  current: { step: string | null; substep: string | null }
  progress: { done: number; total: number }
  milestones: RoadmapMilestone[]
  steps: RoadmapNode[]
  computed_at: string
}
export interface RoadmapFacts {
  episode_id: number
  drama_id: number
  project_type: 'documentary' | 'drama'
  status_override: WorkflowStatus | null
  gates: GateFacts
  raw: { chars: number }
  rewrite: {
    owner_run: { id: number; status: string; prepared_version_id: number | null; source_revision: number } | null
    active_run: { id: number; status: string; prepared_version_id: number | null; source_revision: number } | null
    stages: { key: string; label: string; status: StageStatus; error: string | null }[]
    has_final: boolean
    final_revision: number
    source_revision: number
    confirmed: boolean
    confirmed_at: string | null
  }
  assets: {
    links: number
    images_ready: number
    extract_running: boolean
    review_status: AssetReviewStatus
    review_total: number
    missing: number
    stale_reasons: string[]
  }
  poster: { final_image: string | null; has_concept: boolean; versions: number }
  design: {
    skeleton: { confirmed: boolean; was_confirmed: boolean; confirmed_at: string | null; blocked_reason: string | null }
    tts: { valid: number; total: number }
    cards: { confirmed: number; pending: number; ai_filling: number; stale: number; blank: number; total: number }
  }
  final: { fresh: number; total: number; stale: number }
  export: {
    /** 最近一条未删除的合并；新合并失败/进行中时不能拿更早的成功记录冒充最新。 */
    latest_merge: { status: string; scenes: string[]; intro_image: string | null; completed_at: string | null } | null
    had_completed_merge: boolean
    current_paths: string[]
  }
  drama: { shots: number; keyframes_confirmed: number; videos: number }
  /** 时钟由读库边界注入，纯计算不读取当前时间。 */
  computed_at: string
}

export const STATUS_OVERRIDE_MESSAGE = 'status 只支持 draft / active / completed；null 或 auto 恢复自动推算'

/** undefined 表示非法输入；null 是合法的「恢复自动」。 */
export function parseStatusOverride(value: unknown): WorkflowStatus | null | undefined {
  if (value === null || value === 'auto') return null
  if (typeof value === 'string' && (ROADMAP_STATUSES as readonly string[]).includes(value)) return value as WorkflowStatus
  return undefined
}

/** 列表/详情只读快照；从未算过的行显示 draft，由后台刷新补齐。 */
export function statusSnapshot(row: { statusDerived?: string | null; statusOverride?: string | null }) {
  const derived = (ROADMAP_STATUSES as readonly unknown[]).includes(row.statusDerived) ? row.statusDerived as WorkflowStatus : 'draft'
  const override = (ROADMAP_STATUSES as readonly unknown[]).includes(row.statusOverride) ? row.statusOverride as WorkflowStatus : null
  return { status: override ?? derived, status_derived: derived, status_override: override }
}

/** 项目聚合只读剧集派生快照，不用剧集的人工覆盖冒充业务进度。 */
export function deriveDramaStatus(episodeStatuses: readonly WorkflowStatus[]): WorkflowStatus {
  if (!episodeStatuses.length) return 'draft'
  if (episodeStatuses.every(status => status === 'completed')) return 'completed'
  if (episodeStatuses.some(status => status === 'active' || status === 'completed')) return 'active'
  return 'draft'
}

interface NodeInput {
  key: string
  label: string
  order: number
  ordering?: 'strict' | 'free'
  required_before?: 'export'
  criteria_met: boolean
  progress?: boolean
  stale?: boolean
  skipped?: boolean
  unlocked?: boolean
  lock_reason?: string | null
  goto?: string | null
  done_criteria: string[]
  missing?: RoadmapMissing[]
  notices?: RoadmapNotice[]
  counts?: { done: number; total: number }
  substeps?: RoadmapNode[]
}

function finishNode(input: NodeInput, earlier: RoadmapNode[] = [], extraBlockers: string[] = []): RoadmapNode {
  const ordering = input.ordering ?? 'strict'
  const blockers = ordering === 'strict'
    ? [...earlier.filter(node => node.ordering === 'strict' && node.status !== 'done' && node.status !== 'skipped').map(node => node.key), ...extraBlockers]
    : []
  const unlocked = input.unlocked !== false
  let status: StepStatus
  if (input.stale) status = 'stale'
  else if (input.skipped) status = 'skipped'
  else if (input.criteria_met && !blockers.length) status = 'done'
  else if (input.criteria_met || input.progress) status = 'in_progress'
  else status = unlocked ? 'available' : 'locked'
  return {
    key: input.key, label: input.label, order: input.order, ordering,
    ...(input.required_before ? { required_before: input.required_before } : {}),
    status, criteria_met: input.criteria_met, unlocked,
    lock_reason: unlocked ? null : input.lock_reason ?? '前置步骤尚未就绪',
    goto: unlocked ? null : input.goto ?? null,
    done_criteria: input.done_criteria, missing: input.missing ?? [], notices: input.notices ?? [],
    blocked_by: status === 'in_progress' ? [...new Set(blockers)] : [],
    ...(input.counts ? { counts: input.counts } : {}), substeps: input.substeps ?? [],
  }
}

const REVIEW_NOTICE: Record<string, string> = {
  asset_linked: '审核通过后关联了资产，请留意审核清单是否仍覆盖当前资产',
  asset_unlinked: '审核通过后取消了资产关联，请留意审核清单是否仍适用',
  version_registered: '审核通过后有资产新版本，请留意素材内容变化',
  semantics_changed: '审核通过后素材语义已变化，请留意审核清单是否仍适用',
}

/** 纯函数：所有 UI / AI 完成判定只从这里产出；解锁仍调用原 computeGates。 */
export function computeRoadmap(facts: RoadmapFacts): Roadmap {
  const documentary = facts.project_type === 'documentary'
  const gates = computeGates(facts.gates)
  const steps: RoadmapNode[] = []
  const gateProps = (key: GateKey) => ({
    unlocked: !documentary || gates.unlocked[key],
    lock_reason: gates.reasons[key] ?? null,
    goto: gates.goto[key] === 'script' ? 'rewrite' : gates.goto[key] ?? null,
  })
  const addParent = (input: Omit<NodeInput, 'criteria_met' | 'progress' | 'stale'> & { substeps: RoadmapNode[] }, ownCriteria = true) => {
    const substeps = input.substeps
    const criteria_met = ownCriteria && substeps.every(node => node.criteria_met || node.status === 'skipped')
    steps.push(finishNode({
      ...input, criteria_met,
      progress: substeps.some(node => ['done', 'in_progress', 'stale', 'skipped'].includes(node.status)),
      stale: substeps.some(node => node.status === 'stale'),
      missing: substeps.flatMap(node => node.missing),
      notices: input.notices ?? substeps.flatMap(node => node.notices),
    }, steps))
  }
  const counted = (key: string, label: string, order: number, done: number, total: number, criteria: string, props: Partial<NodeInput> = {}): NodeInput => ({
    key, label, order, criteria_met: total > 0 && done === total, progress: done > 0,
    done_criteria: [criteria], counts: { done, total },
    missing: total > 0 && done === total ? [] : [{ code: `${key}_incomplete`, message: total ? `还有 ${total - done} 项未完成` : '还没有可处理的镜头或资产', count: total - done }],
    ...props,
  })

  if (documentary) {
    steps.push(finishNode({ key: 'raw', label: '原始内容', order: 1, criteria_met: facts.raw.chars > 0,
      done_criteria: ['原始内容（资料正文）非空'], missing: facts.raw.chars ? [] : [{ code: 'raw_empty', message: '还没有原始内容' }] }))
    const rewrite: RoadmapNode[] = []
    const run = facts.rewrite.owner_run ?? (!facts.rewrite.has_final ? facts.rewrite.active_run : null)
    const manualFinal = !facts.rewrite.owner_run && facts.rewrite.has_final
    const sourceStale = !!run && run.source_revision !== facts.rewrite.source_revision
    rewrite.push(finishNode({ key: 'rewrite.prepared', label: '输入准备', order: 1,
      criteria_met: !!run?.prepared_version_id && !sourceStale, skipped: manualFinal, stale: sourceStale,
      progress: !!facts.rewrite.active_run || run?.status === 'processing' || run?.status === 'queued',
      done_criteria: ['所属改写运行的输入准备版本存在（人工最终稿可跳过）'],
      missing: sourceStale ? [{ code: 'rewrite_source_changed', message: '原始内容在改写后已变更，需要重新核对改写' }]
        : manualFinal || run?.prepared_version_id ? [] : [{ code: 'prepared_missing', message: '改写输入准备尚未完成' }],
    }, rewrite))
    for (const [index, stage] of facts.rewrite.stages.entries()) {
      rewrite.push(finishNode({ key: `rewrite.${stage.key}`, label: stage.label, order: index + 2,
        criteria_met: !sourceStale && (stage.status === 'completed' || stage.status === 'skipped'), skipped: manualFinal || stage.status === 'skipped', stale: sourceStale,
        progress: stage.status === 'processing' || stage.status === 'failed',
        done_criteria: [`${stage.label}阶段已完成（或明确跳过）`],
        missing: sourceStale ? [{ code: 'rewrite_source_changed', message: '原始内容在改写后已变更，需要重新核对改写' }]
          : manualFinal || stage.status === 'completed' || stage.status === 'skipped' ? [] : [{ code: stage.status === 'failed' ? 'rewrite_failed' : 'rewrite_pending', message: stage.error || `${stage.label}尚未完成` }],
      }, rewrite))
    }
    rewrite.push(finishNode({ key: 'rewrite.final', label: '最终稿', order: rewrite.length + 1,
      criteria_met: facts.rewrite.has_final, done_criteria: ['最终稿（旁白稿正文）非空'],
      missing: facts.rewrite.has_final ? [] : [{ code: 'final_empty', message: '还没有最终旁白稿' }],
    }, rewrite))
    rewrite.push(finishNode({ key: 'rewrite.confirm', label: '确认旁白稿', order: rewrite.length + 1,
      criteria_met: facts.rewrite.confirmed, unlocked: facts.rewrite.has_final, lock_reason: '最终稿为空：请先写入最终稿', goto: 'rewrite.final',
      done_criteria: ['旁白稿已确认（script_confirmed_at 非空）'],
      missing: facts.rewrite.confirmed ? [] : [{ code: 'script_unconfirmed', message: '旁白稿尚未确认' }],
    }, rewrite))
    addParent({ key: 'rewrite', label: 'AI 改写旁白稿', order: 2, substeps: rewrite,
      done_criteria: ['输入准备与已注册的改写阶段均已完成或跳过', '最终稿非空且旁白稿已确认'],
      notices: manualFinal ? [{ code: 'manual_final', message: '最终稿为人工写入，三个 AI 子步骤记为跳过' }] : [],
    })
    const assets: RoadmapNode[] = []
    assets.push(finishNode({ key: 'assets.extract', label: '提取', order: 1, ...gateProps('assets'),
      criteria_met: facts.assets.links > 0, progress: facts.assets.extract_running,
      done_criteria: ['本集关联角色、场景或道具的总数 > 0'],
      missing: facts.assets.links ? [] : [{ code: 'assets_missing', message: '本集还没有关联资产' }],
    }, assets))
    assets.push(finishNode({ key: 'assets.review', label: '审核清单通过', order: 2, ...gateProps('assets'),
      criteria_met: facts.assets.review_status === 'passed' && facts.assets.missing === 0,
      progress: facts.assets.review_status === 'running' || facts.assets.review_status === 'pending',
      done_criteria: ['资产审核清单状态为 passed，且待处置条目为 0'],
      missing: facts.assets.review_status === 'passed' && !facts.assets.missing ? [] : [{ code: 'asset_review_incomplete', message: facts.assets.missing ? `还有 ${facts.assets.missing} 条清单待处置` : '资产审核清单尚未通过', count: facts.assets.missing }],
      notices: facts.assets.stale_reasons.map(code => ({ code, message: REVIEW_NOTICE[code] ?? code })),
      counts: { done: facts.assets.review_total - facts.assets.missing, total: facts.assets.review_total },
    }, assets))
    addParent({ key: 'assets', label: '资产', order: 3, ...gateProps('assets'), substeps: assets,
      done_criteria: ['本集资产已提取', '资产审核清单已通过且没有待处置条目'] })
    steps.push(finishNode({ key: 'poster', label: 'Poster', order: 4, ordering: 'free', required_before: 'export', ...gateProps('poster'),
      criteria_met: !!facts.poster.final_image, progress: facts.poster.has_concept || facts.poster.versions > 0,
      done_criteria: ['已选定最终 Poster（final_image 存在）', '只阻塞导出完成，不阻塞中间步骤'],
      missing: facts.poster.final_image ? [] : [{ code: 'poster_missing', message: '尚未选定最终 Poster' }],
    }, steps))
    const design: RoadmapNode[] = []
    const skeleton = facts.design.skeleton
    design.push(finishNode({ key: 'design.skeleton', label: '骨架确认', order: 1, ...gateProps('design'),
      criteria_met: skeleton.confirmed, progress: facts.design.cards.total > 0, stale: skeleton.was_confirmed && !skeleton.confirmed,
      done_criteria: ['当前旁白骨架已确认，确认后剧本与骨架没有变更'],
      missing: skeleton.confirmed ? [] : [{ code: 'skeleton_unconfirmed', message: skeleton.blocked_reason ?? '请确认当前旁白骨架' }],
    }, design))
    const designLock = !gates.unlocked.design ? gateProps('design') : { unlocked: skeleton.confirmed, lock_reason: '请先确认当前旁白骨架', goto: 'design.skeleton' }
    design.push(finishNode(counted('design.voice', '配音', 2, facts.design.tts.valid, facts.design.tts.total, '逐镜当前有效配音数 = 镜头总数 > 0', designLock), design))
    const cards = facts.design.cards
    design.push(finishNode(counted('design.cards', '设计卡确认', 3, cards.confirmed, cards.total, '设计卡确认数 = 镜头总数 > 0', {
      ...designLock, progress: cards.confirmed + cards.pending + cards.ai_filling > 0, stale: cards.stale > 0,
      ...(cards.stale ? { missing: [{ code: 'design_cards_stale', message: `${cards.stale} 镜设计卡需要复核`, count: cards.stale }] } : {}),
    }), design))
    addParent({ key: 'design', label: '分镜设计', order: 5, ...gateProps('design'), substeps: design,
      counts: { done: cards.confirmed, total: cards.total }, done_criteria: ['旁白骨架已确认', '全部镜头配音当前有效', '全部设计卡已确认'] })
    const production: RoadmapNode[] = []
    const layer = facts.gates.production.layer
    const frames = facts.gates.production.keyframes
    const segmentSteps = [
      { key: 'production.layer', label: '图层段', count: layer, criteria: '组合 A/C/D 的图层段签名新鲜' },
      { key: 'production.keyframes', label: '生成段关键帧', count: frames, criteria: '组合 B/C/D 的关键帧已确认' },
    ]
    for (const [index, segment] of segmentSteps.entries()) {
      const count = segment.count
      production.push(finishNode(counted(segment.key, segment.label, index + 1, count.ready, count.total, segment.criteria, {
        ...gateProps('production'), ordering: 'free', criteria_met: count.ready === count.total && facts.gates.production.total > 0,
        stale: (count.stale ?? 0) > 0,
        ...(count.total === 0 && facts.gates.production.total > 0 ? { missing: [] } : {}),
        ...(count.stale ? { missing: [{ code: `${segment.key}_stale`, message: `${count.stale} 镜曾就绪的制作产物已过期`, count: count.stale }] } : {}),
      })))
    }
    addParent({ key: 'production', label: '分镜制作', order: 6, ...gateProps('production'), substeps: production,
      counts: { done: facts.gates.production.ready, total: facts.gates.production.total },
      done_criteria: ['启用的图层段全部新鲜就绪', '启用的生成段关键帧全部已确认'] }, facts.gates.production.total > 0 && facts.gates.production.ready === facts.gates.production.total)
    steps.push(finishNode(counted('final', '视频与成品', 7, facts.final.fresh, facts.final.total, '全部镜头都有与当前输入一致的可导出成品', {
      ...gateProps('final'), stale: facts.final.stale > 0,
      ...(facts.final.stale ? { missing: [{ code: 'compose_stale', message: `${facts.final.stale} 镜成品已过期，需要重新合成`, count: facts.final.stale }] } : {}),
    }), steps))
  } else {
    steps.push(finishNode({ key: 'script', label: '剧本', order: 1, ordering: 'free', criteria_met: facts.rewrite.has_final,
      done_criteria: ['剧本正文（script_content）非空'], missing: facts.rewrite.has_final ? [] : [{ code: 'script_empty', message: '还没有剧本正文' }] }))
    steps.push(finishNode(counted('assets', '资产', 2, facts.assets.images_ready, facts.assets.links, '本集全部关联资产都有图片', { ordering: 'free' })))
    steps.push(finishNode({ key: 'poster', label: 'Poster', order: 3, ordering: 'free', criteria_met: !!facts.poster.final_image,
      progress: facts.poster.has_concept || facts.poster.versions > 0, done_criteria: ['已选定最终 Poster'],
      missing: facts.poster.final_image ? [] : [{ code: 'poster_missing', message: '尚未选定最终 Poster（不阻塞剧情项目导出）' }] }))
    steps.push(finishNode(counted('keyframes', '分镜关键帧', 4, facts.drama.keyframes_confirmed, facts.drama.shots, '全部镜头关键帧已确认', { ordering: 'free' })))
    steps.push(finishNode(counted('videos', '视频', 5, facts.drama.videos, facts.drama.shots, '全部镜头都有 video_url', { ordering: 'free' })))
  }

  const merge = facts.export.latest_merge
  const total = documentary ? facts.final.total : facts.drama.shots
  const allPaths = total > 0 && facts.export.current_paths.length === total
  const scenesMatch = !!merge && merge.status === 'completed' && allPaths
    && merge.scenes.length === total && merge.scenes.every((value, i) => value === facts.export.current_paths[i])
  const posterDone = !!facts.poster.final_image
  const posterMatch = !documentary || (posterDone && merge?.intro_image === facts.poster.final_image)
  const exportMet = scenesMatch && posterMatch
  const mergeRunning = !!merge && ['pending', 'queued', 'processing', 'running'].includes(merge.status)
  const exportMissing: RoadmapMissing[] = []
  if (!merge || merge.status !== 'completed') exportMissing.push({ code: 'merge_not_completed', message: mergeRunning ? '成片正在拼接中' : '最新一次成片拼接尚未完成' })
  if (!allPaths) exportMissing.push({ code: 'export_incomplete', message: '必须包含全部存活镜头的当前成品（部分导出不算完成）', count: total - facts.export.current_paths.length })
  if (merge && !scenesMatch) exportMissing.push({ code: 'merge_outdated', message: '最新合并与当前全部镜头的成品路径或顺序不一致' })
  if (documentary && !posterDone) exportMissing.push({ code: 'poster_missing', message: '纪录片导出完成前必须完成 Poster' })
  else if (!posterMatch) exportMissing.push({ code: 'poster_changed', message: '成片片头不是当前选定的 Poster，需要重新导出' })
  steps.push(finishNode({ key: 'export', label: '导出', order: steps.length + 1, ordering: documentary ? 'strict' : 'free', ...gateProps('export'),
    criteria_met: exportMet, progress: mergeRunning || !!merge,
    stale: facts.export.had_completed_merge && !exportMet && !mergeRunning && (!documentary || posterDone),
    counts: { done: merge?.scenes.filter((value, i) => value === facts.export.current_paths[i]).length ?? 0, total },
    done_criteria: ['最新一次合并已完成', '合并按顺序包含当前全部存活镜头的成品（部分导出不算完成）', ...(documentary ? ['片头是当前选定的 Poster'] : [])],
    missing: exportMet ? [] : exportMissing,
  }, steps, documentary && !posterDone ? ['poster'] : []))

  const milestoneSpecs = documentary ? [
    { key: 'm1_script' as const, label: '旁白稿定稿', keys: ['raw', 'rewrite'], criteria: ['原始内容、AI 改写、最终稿与旁白稿确认全部完成'], at: facts.rewrite.confirmed_at },
    { key: 'm2_production' as const, label: '制作完成', keys: ['assets', 'poster', 'design', 'production', 'final'], criteria: ['资产、分镜设计、分镜制作、视频与成品完成；含 Poster（只阻塞导出完成，不阻塞中间步骤）'], at: null },
    { key: 'm3_export' as const, label: '成片导出', keys: ['export'], criteria: ['最新成片覆盖当前全部成品，且片头为当前选定 Poster'], at: merge?.completed_at ?? null },
  ] : [
    { key: 'm1_script' as const, label: '剧本定稿', keys: ['script'], criteria: ['剧本正文非空'], at: null },
    { key: 'm2_production' as const, label: '制作完成', keys: ['assets', 'keyframes', 'videos'], criteria: ['资产图片、分镜关键帧与视频全部完成（不含 Poster）'], at: null },
    { key: 'm3_export' as const, label: '成片导出', keys: ['export'], criteria: ['最新成片覆盖当前全部视频'], at: merge?.completed_at ?? null },
  ]
  const milestones: RoadmapMilestone[] = milestoneSpecs.map(spec => {
    const nodes = steps.filter(node => spec.keys.includes(node.key))
    const status = nodes.every(node => node.status === 'done' || node.status === 'skipped') ? 'done'
      : nodes.some(node => node.status === 'stale') ? 'stale'
      : nodes.some(node => node.status === 'done' || node.status === 'in_progress') ? 'in_progress' : 'pending'
    return { key: spec.key, label: spec.label, steps: spec.keys, status, achieved_at: status === 'done' ? spec.at : null, done_criteria: spec.criteria }
  })
  let current = steps.find(node => (!documentary || node.ordering === 'strict') && node.status !== 'done' && node.status !== 'skipped')
  if (documentary && current?.key === 'export' && !posterDone) current = steps.find(node => node.key === 'poster')
  const substep = current?.substeps.find(node => node.status !== 'done' && node.status !== 'skipped')
  const derived: WorkflowStatus = milestones[2]!.status === 'done' ? 'completed'
    : (facts.raw.chars > 0 || steps.some(node => ['done', 'in_progress', 'stale'].includes(node.status) || node.substeps.some(sub => ['done', 'in_progress', 'stale'].includes(sub.status)))) ? 'active' : 'draft'
  return {
    episode_id: facts.episode_id, drama_id: facts.drama_id, project_type: facts.project_type, strict: documentary,
    status: { effective: facts.status_override ?? derived, derived, override: facts.status_override },
    current: { step: current?.key ?? null, substep: substep?.key ?? null },
    progress: { done: steps.filter(node => node.status === 'done' || node.status === 'skipped').length, total: steps.length },
    milestones, steps, computed_at: facts.computed_at,
  }
}

/** 沿最终稿版本父链找到第一条带 run_id 的版本；不拿无关的最近运行代替谱系。 */
async function owningRewriteRun(finalVersionId: number | null): Promise<RunRow | null> {
  const visited = new Set<number>()
  let id = finalVersionId
  while (id !== null && !visited.has(id)) {
    visited.add(id)
    const version = await getVersion(id)
    if (!version) return null
    if (version.runId !== null) return getRun(version.runId)
    id = version.predecessorId
  }
  return null
}

/** 完成度包括所有存活的本集资产；@引用池会排除旁白角色，不能借它统计资产完成度。 */
async function roadmapAssetImages(episodeId: number): Promise<(string | null)[]> {
  const [characters, scenes, props] = await Promise.all([
    db.select({ image: schema.characters.imageUrl, styling: schema.episodeCharacters.stylingVersion }).from(schema.episodeCharacters)
      .innerJoin(schema.characters, and(eq(schema.characters.id, schema.episodeCharacters.characterId), isNull(schema.characters.deletedAt)))
      .where(eq(schema.episodeCharacters.episodeId, episodeId)),
    db.select({ image: schema.scenes.imageUrl }).from(schema.episodeScenes)
      .innerJoin(schema.scenes, and(eq(schema.scenes.id, schema.episodeScenes.sceneId), isNull(schema.scenes.deletedAt)))
      .where(eq(schema.episodeScenes.episodeId, episodeId)),
    db.select({ image: schema.props.imageUrl }).from(schema.episodeProps)
      .innerJoin(schema.props, and(eq(schema.props.id, schema.episodeProps.propId), isNull(schema.props.deletedAt)))
      .where(eq(schema.episodeProps.episodeId, episodeId)),
  ])
  return [...characters.map(row => parseStylingVersion(row.styling)?.image_path || row.image), ...scenes.map(row => row.image), ...props.map(row => row.image)]
}

/** 读库边界：门禁与 roadmap 共用 episodeGateFactSet，额外事实不重算其签名。 */
export async function episodeRoadmapFacts(episodeId: number): Promise<RoadmapFacts | null> {
  const set = await episodeGateFactSet(episodeId)
  if (!set || set.episode.deletedAt) return null
  const { episode: ep, rows, projectType, facts: gates, composeStates } = set
  const [run, active, assets, skeleton, posters, versions, merges, extraction] = await Promise.all([
    owningRewriteRun(ep.finalVersionId), activeRun(episodeId), roadmapAssetImages(episodeId),
    projectType === 'documentary' ? narrationSkeletonState(episodeId) : null,
    db.select().from(schema.episodePosters).where(eq(schema.episodePosters.episodeId, episodeId)),
    db.select({ id: schema.posterVersions.id }).from(schema.posterVersions).where(eq(schema.posterVersions.episodeId, episodeId)),
    db.select().from(schema.videoMerges).where(and(eq(schema.videoMerges.episodeId, episodeId), isNull(schema.videoMerges.deletedAt))).orderBy(desc(schema.videoMerges.id)),
    Promise.all(EXTRACT_TARGETS.map(target => findActiveTextTask(episodeId, EXTRACT_TASK_KINDS[target]))),
  ])
  const workingRun = run ?? (!ep.scriptContent?.trim() ? active : null)
  const stages = workingRun ? await listStages([workingRun.id]) : []
  const cards = { confirmed: 0, pending: 0, ai_filling: 0, stale: 0, blank: 0, total: rows.length }
  for (const row of rows) {
    const key = row.designCardStatus as Exclude<keyof typeof cards, 'total'>
    if (key !== ('total' as string) && Object.hasOwn(cards, key)) cards[key]++
    else cards.blank++
  }
  const review = assetReviewCounts(episodeId)
  const merge = merges[0]
  let scenes: string[] = []
  try {
    const parsed: unknown = merge?.scenes ? JSON.parse(merge.scenes) : []
    if (Array.isArray(parsed) && parsed.every((item): item is string => typeof item === 'string')) scenes = parsed
  } catch { /* 非法历史 JSON 不满足完成判据 */ }
  const poster = posters[0]
  return {
    episode_id: ep.id, drama_id: ep.dramaId, project_type: projectType, status_override: statusSnapshot(ep).status_override, gates,
    computed_at: now(),
    raw: { chars: (ep.content ?? '').trim().length },
    rewrite: {
      owner_run: run ? { id: run.id, status: run.status, prepared_version_id: run.preparedVersionId, source_revision: run.sourceRevision } : null,
      active_run: active ? { id: active.id, status: active.status, prepared_version_id: active.preparedVersionId, source_revision: active.sourceRevision } : null,
      stages: REWRITE_STAGES.map(spec => {
        const row = stages.find(stage => stage.stageKey === spec.key)
        return { key: spec.key, label: spec.label, status: (row?.status ?? 'pending') as StageStatus, error: row?.errorMsg ?? null }
      }),
      has_final: !!ep.scriptContent?.trim(), final_revision: ep.finalRevision, source_revision: ep.sourceRevision,
      confirmed: gates.script.confirmed, confirmed_at: gates.script.confirmed_at,
    },
    assets: { links: assets.length, images_ready: assets.filter(Boolean).length,
      extract_running: extraction.some(Boolean), review_status: gates.assets.review_status, review_total: review.total,
      missing: gates.assets.missing, stale_reasons: gates.assets.stale_reasons },
    poster: { final_image: poster?.finalImage ?? null, has_concept: !!poster?.concept, versions: versions.length },
    design: {
      skeleton: { confirmed: skeleton?.confirmed ?? false, was_confirmed: !!(skeleton?.confirmed_revision || skeleton?.confirmed_at), confirmed_at: skeleton?.confirmed_at ?? null, blocked_reason: skeleton?.blocked_reason ?? null },
      tts: { valid: skeleton?.tts.valid ?? 0, total: skeleton?.tts.total ?? rows.length }, cards,
    },
    final: { ...gates.final, stale: composeStates?.filter(state => !!state.composed_video_url && !state.exportable).length ?? 0 },
    export: {
      latest_merge: merge ? { status: merge.status ?? 'pending', scenes, intro_image: merge.introImage, completed_at: merge.completedAt } : null,
      had_completed_merge: merges.some(row => row.status === 'completed'),
      current_paths: projectType === 'documentary'
        ? (composeStates ?? []).filter(state => state.exportable && state.composed_video_url).map(state => state.composed_video_url!)
        : rows.filter(row => !!row.videoUrl).map(row => row.videoUrl!),
    },
    drama: { shots: rows.length, keyframes_confirmed: rows.filter(row => row.keyframesConfirmed).length, videos: rows.filter(row => !!row.videoUrl).length },
  }
}

/** 将项目快照由存活剧集的派生快照聚合，零剧集明确为 draft。 */
export async function refreshDramaSnapshot(dramaId: number): Promise<WorkflowStatus | null> {
  const [drama] = await db.select().from(schema.dramas).where(eq(schema.dramas.id, dramaId))
  if (!drama) return null
  const episodes = await db.select().from(schema.episodes).where(and(eq(schema.episodes.dramaId, dramaId), isNull(schema.episodes.deletedAt)))
  const derived = deriveDramaStatus(episodes.map(ep => statusSnapshot(ep).status_derived))
  if (drama.statusDerived !== derived || !drama.statusDerivedAt) {
    await db.update(schema.dramas).set({ statusDerived: derived, statusDerivedAt: now() }).where(eq(schema.dramas.id, dramaId))
  }
  return derived
}

/** 唯一公共读入口：计算后只在派生值变化时落快照，不触碰任何业务产物。 */
export async function episodeRoadmap(episodeId: number): Promise<Roadmap | null> {
  const facts = await episodeRoadmapFacts(episodeId)
  if (!facts) return null
  const roadmap = computeRoadmap(facts)
  const [stored] = await db.select({ derived: schema.episodes.statusDerived, at: schema.episodes.statusDerivedAt }).from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (stored?.derived !== roadmap.status.derived || !stored?.at) {
    await db.update(schema.episodes).set({ statusDerived: roadmap.status.derived, statusDerivedAt: roadmap.computed_at }).where(eq(schema.episodes.id, episodeId))
  }
  await refreshDramaSnapshot(roadmap.drama_id)
  return roadmap
}

const REFRESH_INTERVAL_MS = 60_000
let refreshFlight: Promise<number> | null = null
let lastRefreshStarted = 0

/** 单飞、最多每分钟一次；列表不等待重查询，始终读取已持久化的快照。 */
export function refreshRoadmapSnapshots(): Promise<number> {
  if (refreshFlight) return refreshFlight
  if (Date.now() - lastRefreshStarted < REFRESH_INTERVAL_MS) return Promise.resolve(0)
  lastRefreshStarted = Date.now()
  refreshFlight = (async () => {
    const episodes = await db.select({ id: schema.episodes.id }).from(schema.episodes).where(isNull(schema.episodes.deletedAt))
    for (const ep of episodes) await episodeRoadmap(ep.id)
    const dramas = await db.select({ id: schema.dramas.id }).from(schema.dramas).where(isNull(schema.dramas.deletedAt))
    for (const drama of dramas) await refreshDramaSnapshot(drama.id)
    return episodes.length
  })().finally(() => { refreshFlight = null })
  return refreshFlight
}

export function requestRoadmapRefresh(): void {
  void refreshRoadmapSnapshots().catch(error => console.error('工作流状态快照刷新失败:', error instanceof Error ? error.message : error))
}
