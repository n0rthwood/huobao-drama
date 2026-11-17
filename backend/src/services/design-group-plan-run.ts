/**
 * 组级视觉规划的模型调用（Issue #109）—— 设计卡批次（`design-card-batch.ts`）里每组先跑这一步，
 * 再按规划逐镜填卡。
 *
 * 一组一次 `callTextChat`（非 Agent、不读图：规划只排「哪镜用哪张图、何时建立/提示」，
 * 画面能否实现由逐镜填卡时的依据机检负责）。规则写在技能 `documentary/design-group-plan`，
 * 硬校验在 `design-group-plan.ts`：不合格把错误原样回给模型纠正**一次**，仍不合格该组判失败，
 * 组内镜头不填卡（旧卡原样保留），绝不静默修正或补默认值。
 * 每次规划都是一个观测工作项（stage `design_group_plan`）：公开对话、耗时、失败现场都可回看。
 */
import { loadSkillDoc } from '../agents/skills.js'
import { sqlite } from '../db/index.js'
import { getContentLanguage } from './app-settings.js'
import { callTextChat } from './vision-chat.js'
import { runObservedWork } from './task-observability.js'
import { parseJsonReply } from './asset-pipeline/prompts.js'
import type { StageModel } from './ai-stages.js'
import { parseDesignCard, toCombo, type DesignCard, type DesignCardContext } from './design-card.js'
import {
  freshGroupPlan,
  normalizeGroupPlan,
  saveGroupPlan,
  validateGroupPlan,
  type EpisodeGroup,
  type GroupPlan,
  type GroupPlanInput,
  type HistoryShot,
  type PlanAssetInput,
  type PlanAssetRef,
} from './design-group-plan.js'
import { pipAssetLine } from './map-pip-assets.js'

const PLAN_MAX_TOKENS = Number(process.env.AI_MAX_TOKENS || 16384)
const PLAN_TIMEOUT_MS = 300_000
/** 跨组计数与「上次出现」判定需要回看的镜数 */
const HISTORY_SHOTS = 8

export interface ShotRowLite {
  id: number
  storyboardNumber: number
  combo: string | null
  designCard: string | null
  narrationText: string | null
}

function cardBase(card: DesignCard | null): PlanAssetRef | null {
  const base = card?.layer_plan?.base
  return base && base.kind === 'asset' ? { asset_kind: base.asset_kind, asset_id: base.asset_id } : null
}

/** 规划输入：本组成员镜 + 资产清单 + 本组之前的镜头（实际卡优先，没有卡用仍新鲜的规划） */
export function buildGroupPlanInput(args: {
  episodeId: number
  group: EpisodeGroup
  rows: ShotRowLite[]
  ctx: DesignCardContext
  /** 本次批次要重填的镜：不在这里、但已有组合的镜视为锁定 */
  pendingIds: Set<number>
  /** 当前有效配音的实测秒数 */
  measured: Map<number, number>
}): GroupPlanInput {
  const { group, rows, ctx, pendingIds, measured } = args
  const byId = new Map(rows.map(row => [row.id, row]))
  const shots = group.shots.map((shot) => {
    const row = byId.get(shot.storyboard_id)
    const combo = toCombo(row?.combo)
    const locked = !pendingIds.has(shot.storyboard_id) && combo
      ? { combo, base: cardBase(parseDesignCard(row?.designCard ?? null, ctx)) }
      : null
    return {
      storyboard_id: shot.storyboard_id,
      storyboard_number: shot.storyboard_number,
      narration: shot.narration,
      measured_s: measured.get(shot.storyboard_id) ?? shot.measured_s ?? 0,
      locked,
    }
  })

  const mapIds = new Set((sqlite.prepare("SELECT id FROM props WHERE asset_type = 'map' AND deleted_at IS NULL").all() as Array<{ id: number }>).map(row => row.id))
  const assets: PlanAssetInput[] = ctx.assets.map(asset => ({
    kind: asset.kind,
    id: asset.id,
    name: asset.name,
    has_image: !!asset.image,
    is_map: asset.kind === 'prop' && mapIds.has(asset.id),
  }))

  // 本组之前的镜头按实际设计卡计（批次按组先规划、再填卡，前面各组此时已经落了卡）
  const first = group.shots[0]?.storyboard_number ?? 0
  const history: HistoryShot[] = rows
    .filter(row => row.storyboardNumber < first)
    .slice(-HISTORY_SHOTS)
    .map(row => ({
      storyboard_id: row.id,
      storyboard_number: row.storyboardNumber,
      combo: toCombo(row.combo),
      base: cardBase(parseDesignCard(row.designCard, ctx)),
    }))
  return { group_no: group.group_no, shots, assets, history }
}

function assetLines(input: GroupPlanInput, ctx: DesignCardContext): string[] {
  // #110：画中画资产要带地理范围（label + 取景框经纬度 + 全览范围），否则规划器不知道细节覆盖哪里，
  // 会把旁白里的地点派给一张根本不含它的细节图。镜号类说明（别的集的分镜号）一律不给。
  const pip = new Map<number, string>()
  for (const row of sqlite.prepare('SELECT id, map_pip FROM props WHERE map_pip IS NOT NULL AND deleted_at IS NULL').all() as Array<{ id: number; map_pip: string }>) {
    const line = pipAssetLine(row.map_pip)
    if (line) pip.set(row.id, line)
  }
  const semantics = new Map(ctx.assets.map(asset => [`${asset.kind}#${asset.id}`, asset.semantics ?? []]))
  return input.assets.map((asset) => {
    const key = `${asset.kind}#${asset.id}`
    const names = (semantics.get(key) ?? []).map(entry => entry.name).filter(Boolean)
    const tags = [
      asset.is_map ? '地图' : asset.kind === 'scene' ? '场景' : asset.kind === 'character' ? '角色' : '道具/档案',
      asset.has_image ? '' : '**无图，不可用**',
      asset.kind === 'prop' && pip.has(asset.id) ? pip.get(asset.id)! : '',
      names.length ? `标注 ${names.length} 条：${names.slice(0, 24).join('、')}${names.length > 24 ? '…' : ''}` : '',
    ].filter(Boolean)
    return `- ${key}「${asset.name}」（${tags.join('；')}）`
  })
}

function historyLines(input: GroupPlanInput): string[] {
  const names = new Map(input.assets.map(asset => [`${asset.kind}#${asset.id}`, asset.name]))
  return input.history.map(shot => `- #${shot.storyboard_number}（ID ${shot.storyboard_id}）组合 ${shot.combo ?? '未选'}，底图 ${
    shot.base ? `${shot.base.asset_kind}#${shot.base.asset_id}「${names.get(`${shot.base.asset_kind}#${shot.base.asset_id}`) ?? '?'}」` : '无'}`)
}

export function buildGroupPlanPrompt(group: EpisodeGroup, input: GroupPlanInput, ctx: DesignCardContext, nextExcerpt: string | null): string {
  return [
    `# 逻辑组：第 ${group.group_no} 段`,
    group.paragraph_text,
    '',
    '# 本组镜头（按顺序；storyboard_id 用这里的 ID）',
    ...input.shots.map(shot => `- ID ${shot.storyboard_id}（#${shot.storyboard_number}，实测配音 ${shot.measured_s} 秒${shot.locked
      ? `，**已锁定**：组合 ${shot.locked.combo}，底图 ${shot.locked.base ? `${shot.locked.base.asset_kind}#${shot.locked.base.asset_id}` : '无'}，必须照抄`
      : ''}）：${shot.narration}`),
    '',
    '# 前面的镜头（跨组计数用；最近的在最后）',
    ...(input.history.length ? historyLines(input) : ['- （本组是开头）']),
    '',
    '# 下一段开头（只作衔接参考，不要规划它）',
    nextExcerpt ? nextExcerpt : '（没有下一段）',
    '',
    '# 本集资产（只能用有图的；引用写 {asset_kind, asset_id}，asset_kind 只能是 character / scene / prop——地图、档案画、器物图都是 prop）',
    ...assetLines(input, ctx),
    '',
    '只返回技能第 5 节规定的 JSON。',
  ].join('\n')
}

export class GroupPlanFailedError extends Error {}

/**
 * 规划一组：仍新鲜的成功规划且未强制重做 → 直接复用；否则调模型（最多纠正一次）并落库。
 * 失败时也落库（status=failed + 原因），抛 `GroupPlanFailedError`，调用方把组内待填镜标失败。
 */
export async function planGroup(args: {
  taskId: number
  episodeId: number
  group: EpisodeGroup
  nextExcerpt: string | null
  rows: ShotRowLite[]
  ctx: DesignCardContext
  pendingIds: Set<number>
  measured: Map<number, number>
  stageModel: StageModel
  sampleKey: string
  force: boolean
}): Promise<{ plan: GroupPlan; reused: boolean }> {
  const { taskId, episodeId, group } = args
  if (!args.force) {
    const fresh = freshGroupPlan(episodeId, group)
    if (fresh) return { plan: fresh, reused: true }
  }
  const input = buildGroupPlanInput(args)
  const fail = (message: string): never => {
    saveGroupPlan(episodeId, group.group_no, { signature: group.signature, status: 'failed', plan: null, error: message, taskId })
    throw new GroupPlanFailedError(message)
  }
  const plan = await runObservedWork({
    taskId,
    stage: 'design_group_plan',
    sourceChars: group.paragraph_chars,
    sampleKey: args.sampleKey,
    storyboardId: group.shots[0]?.storyboard_id,
    storyboardNumber: group.shots[0]?.storyboard_number,
  }, async () => {
    const system = await loadSkillDoc('documentary/design-group-plan', getContentLanguage())
    const prompt = buildGroupPlanPrompt(group, input, args.ctx, args.nextExcerpt)
    const call = async (content: string) => {
      const { text } = await callTextChat(args.stageModel, content, {
        systemPrompt: system,
        temperature: 0.2,
        maxTokens: PLAN_MAX_TOKENS,
        timeoutMs: PLAN_TIMEOUT_MS,
      })
      return text
    }
    const check = (text: string): { plan: GroupPlan | null; errors: string[] } => {
      let raw: unknown
      try {
        raw = parseJsonReply(text)
      } catch (err) {
        return { plan: null, errors: [err instanceof Error ? err.message : String(err)] }
      }
      const normalized = normalizeGroupPlan(raw)
      if (!normalized.plan) return normalized
      return { plan: normalized.plan, errors: validateGroupPlan(normalized.plan, input) }
    }
    const firstReply = await call(prompt)
    const first = check(firstReply)
    if (first.plan && !first.errors.length) return first.plan
    // 纠正一次：把上一次的输出与逐条错误原样回给模型
    const retryPrompt = [
      prompt,
      '',
      '# 你上一次的输出',
      firstReply.trim(),
      '',
      '# 校验没有通过，请逐条改正后重新输出完整 JSON',
      ...first.errors.map(error => `- ${error}`),
    ].join('\n')
    const second = check(await call(retryPrompt))
    if (second.plan && !second.errors.length) return second.plan
    throw new GroupPlanFailedError(`第 ${group.group_no} 段的视觉规划两次都没有通过校验：${second.errors.slice(0, 4).join('；')}`)
  }).catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)))

  saveGroupPlan(episodeId, group.group_no, { signature: group.signature, status: 'ok', plan, error: null, taskId })
  return { plan, reused: false }
}

/** 逐镜填卡指令里注入的「本组规划」文字（本镜条目单列在最前） */
export function describePlanForShot(plan: GroupPlan, group: EpisodeGroup, storyboardId: number, ctx: DesignCardContext): string {
  const names = new Map(ctx.assets.map(asset => [`${asset.kind}#${asset.id}`, asset.name]))
  const ref = (r: PlanAssetRef | null) => (r ? `${r.asset_kind}#${r.asset_id}「${names.get(`${r.asset_kind}#${r.asset_id}`) ?? '?'}」` : '无')
  const number = new Map(group.shots.map(shot => [shot.storyboard_id, shot.storyboard_number]))
  const label = (id: number | null) => (id ? `#${number.get(id) ?? id}` : '—')
  const mine = plan.shots.find(shot => shot.storyboard_id === storyboardId)
  const additions = plan.geo_additions.filter(item => item.storyboard_id === storyboardId)
  return [
    `本镜属于第 ${group.group_no} 段（逻辑组）。本组视觉规划：${plan.task}`,
    mine
      ? `**本镜条目**：组合 ${mine.combo}；底图 ${ref(mine.base)}；画中画 ${mine.pip.length ? mine.pip.map(ref).join('、') : '无'}；模式 ${mine.mode}；画面任务：${mine.task}`
      : '本镜不在本组规划里（按技能自行判断，并在 rationale 说明）',
    additions.length ? `本镜要落图的新增条目：${additions.map(item => item.text).join('；')}` : '本镜没有被指派新增条目：不要以地图满幅开场来重复已经建立过的地理信息',
    '本组各镜：',
    ...plan.shots.map(shot => `- ${label(shot.storyboard_id)} ${shot.combo} 底图 ${ref(shot.base)}${shot.pip.length ? ` 画中画 ${shot.pip.map(ref).join('、')}` : ''}：${shot.task}`),
    plan.asset_roles.length ? `素材用法：${plan.asset_roles.map(role => `${role.name || `${role.asset_kind}#${role.asset_id}`}=${role.role}（建立 ${label(role.establish_storyboard_id)}，退出 ${label(role.exit_after_storyboard_id)}）${role.note ? ` ${role.note}` : ''}`).join('；')}` : '',
    plan.junction ? `与上一组的接缝：${plan.junction}` : '',
  ].filter(Boolean).join('\n')
}
