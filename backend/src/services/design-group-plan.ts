/**
 * 组级视觉规划（Issue #109）—— 纪录片分镜设计的第一遍。
 *
 * 逐镜填卡只看得到「本镜 + 前后几镜」，于是同一段（逻辑组）里每一镜都把同一张地图从满幅干净底图
 * 重新放一遍，成片在「地图 ↔ 实拍」之间来回切（ep 27：53 次回切、#59–#75 连续 17 镜同一张图）。
 * 改为：先按组（= 最终旁白稿的一个自然段）规划这一组的视觉分工——哪张图何时完整建立、之后只做
 * 简短提示（画中画 / D 收尾落图 / 只靠旁白）、哪几镜交给生成段——再按规划逐镜填卡。
 *
 * 本文件 = 规划的类型、规范化、**硬校验**（回给模型）、签名、偏离检查与持久化（同步 SQL）。
 * 模型调用与批次编排在 `design-group-plan-run.ts`；镜 → 组的归属在 `narration-groups.ts`。
 */
import { sqlite } from '../db/index.js'
import { now } from '../utils/response.js'
import { narrationGroupsOf, type GroupWarning } from './narration-groups.js'
import { narrationMatchKey } from './narration-first.js'
import { spokenText } from './narration-markup.js'
import { parseNarrationMeta, sha256 } from './narration.js'
import type { Combo, DesignCard } from './design-card.js'

export type PlanAssetKind = 'character' | 'scene' | 'prop'
export interface PlanAssetRef { asset_kind: PlanAssetKind; asset_id: number }

export const PLAN_MODES = ['new_items', 'carry_only', 'no_layer'] as const
export type PlanMode = (typeof PLAN_MODES)[number]
export const PLAN_ROLES = ['establish', 'hint', 'background'] as const
export type PlanRole = (typeof PLAN_ROLES)[number]

export interface GroupPlanShot {
  storyboard_id: number
  combo: Combo
  base: PlanAssetRef | null
  pip: PlanAssetRef[]
  mode: PlanMode
  task: string
}

export interface GroupPlan {
  task: string
  geo_additions: Array<{ text: string; storyboard_id: number }>
  asset_roles: Array<{
    asset_kind: PlanAssetKind
    asset_id: number
    name: string
    role: PlanRole
    establish_storyboard_id: number | null
    exit_after_storyboard_id: number | null
    note: string
  }>
  shots: GroupPlanShot[]
  junction: string
}

/** 生成段/整镜生成段的硬上限（秒）；图层段没有上限（Issue #110） */
const GEN_MAX_S = 15
/** 「距这张图上次出现 ≥3 镜」允许无新增条目的再入（重新定位） */
export const REENTRY_GAP = 3
/** 同一底图连续回切开场的上限 */
export const MAX_CONSECUTIVE_REOPEN = 2

/** 组合的时长上限（秒）；`null` = 没有上限（A/C/D 的图层段是确定性渲染，可以加长承载长旁白） */
export function comboLimitSeconds(combo: Combo): number | null {
  return combo === 'B' ? GEN_MAX_S : null
}

const COMBO_SET: Record<string, true> = { A: true, B: true, C: true, D: true }
const KIND_SET: Record<string, true> = { character: true, scene: true, prop: true }
const hasLayer = (combo: Combo) => combo !== 'B'
const opensWithLayer = (combo: Combo) => combo === 'A' || combo === 'C'
const endsWithLayer = (combo: Combo) => combo === 'A' || combo === 'D'
const sameRef = (a: PlanAssetRef | null, b: PlanAssetRef | null) =>
  !!a && !!b && a.asset_kind === b.asset_kind && a.asset_id === b.asset_id
const refKey = (ref: PlanAssetRef) => `${ref.asset_kind}#${ref.asset_id}`

// ─── 校验输入 ─────────────────────────────────────────────────

export interface PlanShotInput {
  storyboard_id: number
  storyboard_number: number
  narration: string
  /** 当前有效配音的实测秒数 */
  measured_s: number
  /** 人工内容或已确认的卡：规划必须照抄它的组合与底图，不得改动 */
  locked: { combo: Combo; base: PlanAssetRef | null } | null
}

export interface PlanAssetInput {
  kind: PlanAssetKind
  id: number
  name: string
  has_image: boolean
  is_map: boolean
}

/** 本组之前（按镜号）的镜头实际/计划的段组合与底图，用于跨组计数 */
export interface HistoryShot {
  storyboard_id: number
  storyboard_number: number
  combo: Combo | null
  base: PlanAssetRef | null
}

export interface GroupPlanInput {
  group_no: number
  shots: PlanShotInput[]
  assets: PlanAssetInput[]
  history: HistoryShot[]
}

// ─── 规范化 ──────────────────────────────────────────────────

function asText(value: unknown, max = 400): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}
function asId(value: unknown): number | null {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}
/** 资产引用；不合法时给出可直接回给模型的原因（不猜：`map` 不会被当成 `prop`） */
function asRef(value: unknown): PlanAssetRef | null | { invalid: string } {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object') return { invalid: `必须是 {asset_kind, asset_id} 对象，收到 ${JSON.stringify(value)}` }
  const raw = value as Record<string, unknown>
  const kind = String(raw.asset_kind ?? raw.kind ?? '')
  const id = asId(raw.asset_id ?? raw.id)
  if (!KIND_SET[kind]) return { invalid: `asset_kind 只能是 character / scene / prop（地图、档案画、器物图都是 prop），收到「${kind}」` }
  if (id === null) return { invalid: `asset_id 必须是资产清单里的正整数 ID，收到 ${JSON.stringify(raw.asset_id ?? raw.id ?? null)}` }
  return { asset_kind: kind as PlanAssetKind, asset_id: id }
}

/**
 * 模型输出 → 规划对象。结构不合法的字段一律记成错误回给模型，**不猜、不补默认值**。
 */
export function normalizeGroupPlan(raw: unknown): { plan: GroupPlan | null; errors: string[] } {
  const errors: string[] = []
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { plan: null, errors: ['输出必须是一个 JSON 对象'] }
  const obj = raw as Record<string, unknown>
  const task = asText(obj.task)
  if (!task) errors.push('task 不能为空：写清观众看完本组应当理解/记住什么')

  const shots: GroupPlanShot[] = []
  if (!Array.isArray(obj.shots)) errors.push('shots 必须是数组，本组每镜恰好一条')
  for (const [index, item] of (Array.isArray(obj.shots) ? obj.shots : []).entries()) {
    const s = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
    const label = `shots[${index}]`
    const id = asId(s.storyboard_id)
    const combo = String(s.combo ?? '')
    const base = asRef(s.base)
    const mode = String(s.mode ?? '')
    if (id === null) { errors.push(`${label}.storyboard_id 缺失或不是正整数`); continue }
    if (!COMBO_SET[combo]) { errors.push(`${label}（分镜 ${id}）combo 必须是 A/B/C/D`); continue }
    if (base && 'invalid' in base) { errors.push(`${label}（分镜 ${id}）base ${base.invalid}`); continue }
    if (!(PLAN_MODES as readonly string[]).includes(mode)) { errors.push(`${label}（分镜 ${id}）mode 必须是 new_items / carry_only / no_layer`); continue }
    const pip: PlanAssetRef[] = []
    for (const p of Array.isArray(s.pip) ? s.pip : []) {
      const ref = asRef(p)
      if (ref && !('invalid' in ref)) pip.push(ref)
      else errors.push(`${label}（分镜 ${id}）pip ${ref ? ref.invalid : '不能是 null'}`)
    }
    shots.push({ storyboard_id: id, combo: combo as Combo, base, pip, mode: mode as PlanMode, task: asText(s.task, 200) })
  }

  const geo: GroupPlan['geo_additions'] = []
  for (const item of Array.isArray(obj.geo_additions) ? obj.geo_additions : []) {
    const g = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
    const text = asText(g.text, 120)
    const id = asId(g.storyboard_id)
    if (!text || id === null) { errors.push('geo_additions 每条都要有 text 与 storyboard_id'); continue }
    geo.push({ text, storyboard_id: id })
  }
  if (obj.geo_additions !== undefined && !Array.isArray(obj.geo_additions)) errors.push('geo_additions 必须是数组（没有新增条目就给 []）')

  const roles: GroupPlan['asset_roles'] = []
  for (const item of Array.isArray(obj.asset_roles) ? obj.asset_roles : []) {
    const r = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
    const ref = asRef(r)
    const role = String(r.role ?? '')
    if (!ref || 'invalid' in ref) { errors.push(`asset_roles 的资产引用${ref ? ref.invalid : '缺少 asset_kind 与 asset_id'}`); continue }
    if (!(PLAN_ROLES as readonly string[]).includes(role)) { errors.push(`asset_roles（${refKey(ref)}）role 必须是 establish / hint / background`); continue }
    roles.push({
      ...ref,
      name: asText(r.name, 80),
      role: role as PlanRole,
      establish_storyboard_id: asId(r.establish_storyboard_id),
      exit_after_storyboard_id: asId(r.exit_after_storyboard_id),
      note: asText(r.note, 200),
    })
  }

  if (errors.length) return { plan: null, errors }
  return { plan: { task, geo_additions: geo, asset_roles: roles, shots, junction: asText(obj.junction) }, errors }
}

// ─── 硬校验 ──────────────────────────────────────────────────

/**
 * 规划的硬校验（全部回给模型改正）。规则与技能 2.2.0 逐条对应：
 * 1. 本组每镜恰好一条，不多不少；人工/已确认的镜照抄原组合与底图；
 * 2. 组合装得下实测配音（只有 B ≤15 s——整镜就是一个生成段；A/C/D 的图层段没有上限，永远装得下）；
 * 3. 有图层段的镜必须有底图，底图/画中画必须是本集有图的资产；B 的 mode 只能是 no_layer；
 * 4. 新增条目只能指派给本组有图层段的镜；
 * 5. **回切**（上一镜不是以同一张图的图层收尾，本镜却以已经出现过的底图开场）必须被指派新增条目，
 *    或满足再入豁免（距这张图上次出现 ≥3 镜）；
 * 6. 同一底图**连续**回切开场 ≤2 镜（跨组计数：history 里本组之前的镜一起算）。
 */
export function validateGroupPlan(plan: GroupPlan, input: GroupPlanInput): string[] {
  const errors: string[] = []
  const members = new Map(input.shots.map(shot => [shot.storyboard_id, shot]))
  const label = (id: number) => {
    const shot = members.get(id)
    return shot ? `#${shot.storyboard_number}` : `分镜 ${id}`
  }
  const seen = new Set<number>()
  for (const shot of plan.shots) {
    if (!members.has(shot.storyboard_id)) errors.push(`分镜 ${shot.storyboard_id} 不属于本组：shots 只能列本组的镜`)
    else if (seen.has(shot.storyboard_id)) errors.push(`${label(shot.storyboard_id)} 在 shots 里出现了两次`)
    seen.add(shot.storyboard_id)
  }
  const missing = input.shots.filter(shot => !seen.has(shot.storyboard_id))
  if (missing.length) errors.push(`shots 漏了 ${missing.map(shot => `#${shot.storyboard_number}`).join('、')}：本组每一镜都要有一条`)

  const assets = new Map(input.assets.map(asset => [`${asset.kind}#${asset.id}`, asset]))
  const checkAsset = (ref: PlanAssetRef, where: string) => {
    const asset = assets.get(refKey(ref))
    if (!asset) errors.push(`${where} 引用的 ${refKey(ref)} 不是本集资产`)
    else if (!asset.has_image) errors.push(`${where} 引用的「${asset.name}」还没有图，不能用作底图或画中画`)
  }

  // 本组镜头按镜号顺序，拼在 history 之后统一判回切
  const ordered = input.shots
    .map(shot => ({ shot, planned: plan.shots.find(item => item.storyboard_id === shot.storyboard_id) }))
    .filter((entry): entry is { shot: PlanShotInput; planned: GroupPlanShot } => !!entry.planned)
  for (const { shot, planned } of ordered) {
    const where = `#${shot.storyboard_number}`
    if (shot.locked) {
      if (planned.combo !== shot.locked.combo || !(sameRef(planned.base, shot.locked.base) || (!planned.base && !shot.locked.base))) {
        errors.push(`${where} 已有人工/已确认的设计（组合 ${shot.locked.combo}，底图 ${shot.locked.base ? refKey(shot.locked.base) : '无'}）：规划必须照抄，不得改动`)
      }
    }
    const limit = comboLimitSeconds(planned.combo)
    if (limit !== null && shot.measured_s > limit) {
      errors.push(`${where} 实测配音 ${shot.measured_s} 秒，组合 ${planned.combo} 最多 ${limit} 秒：`
        + '超过 15 秒不能只用生成段，改用 C 或 D（用图层段承载余下时长，图层段没有上限）')
    }
    if (hasLayer(planned.combo)) {
      if (!planned.base) errors.push(`${where} 组合 ${planned.combo} 有图层段，必须给 base`)
      else checkAsset(planned.base, `${where} 的 base`)
      if (planned.mode === 'no_layer') errors.push(`${where} 有图层段，mode 不能是 no_layer`)
    } else {
      if (planned.base) errors.push(`${where} 组合 B 没有图层段，base 必须是 null`)
      if (planned.pip.length) errors.push(`${where} 组合 B 没有图层段，不能放画中画`)
      if (planned.mode !== 'no_layer') errors.push(`${where} 组合 B 的 mode 只能是 no_layer`)
    }
    for (const pip of planned.pip) {
      checkAsset(pip, `${where} 的画中画`)
      if (sameRef(pip, planned.base)) errors.push(`${where} 的画中画不能与底图是同一张图`)
    }
  }

  for (const item of plan.geo_additions) {
    const planned = plan.shots.find(shot => shot.storyboard_id === item.storyboard_id)
    if (!members.has(item.storyboard_id)) errors.push(`新增条目「${item.text}」指派给了不属于本组的分镜 ${item.storyboard_id}`)
    else if (planned && !hasLayer(planned.combo)) errors.push(`新增条目「${item.text}」指派给了 ${label(item.storyboard_id)}，但该镜是组合 B（没有图层段，落不了图）`)
  }
  // asset_roles 是给人和逐镜填卡看的说明：建立镜可以在前面的组（如「#59 已建立」），镜号不作硬校验
  for (const role of plan.asset_roles) {
    if (!assets.has(refKey(role))) errors.push(`asset_roles 里的 ${refKey(role)} 不是本集资产`)
  }

  // 回切判定：history（本组之前）+ 本组规划，按镜号顺序
  const assigned = new Set(plan.geo_additions.map(item => item.storyboard_id))
  const sequence: Array<{ id: number; number: number; combo: Combo | null; base: PlanAssetRef | null; inGroup: boolean }> = [
    ...input.history.map(h => ({ id: h.storyboard_id, number: h.storyboard_number, combo: h.combo, base: h.base, inGroup: false })),
    ...ordered.map(({ shot, planned }) => ({ id: shot.storyboard_id, number: shot.storyboard_number, combo: planned.combo, base: planned.base, inGroup: true })),
  ]
  const lastSeen = new Map<string, number>()
  let run = 0
  let runKey = ''
  sequence.forEach((entry, index) => {
    const prev = index > 0 ? sequence[index - 1]! : null
    const opens = !!entry.combo && opensWithLayer(entry.combo) && !!entry.base
    const continuous = opens && !!prev?.combo && endsWithLayer(prev.combo) && sameRef(prev.base, entry.base)
    const key = entry.base ? refKey(entry.base) : ''
    const reopen = opens && !continuous && lastSeen.has(key)
    if (reopen && entry.inGroup) {
      const gap = index - lastSeen.get(key)!
      const name = assets.get(key)?.name || key
      if (!assigned.has(entry.id) && gap < REENTRY_GAP) {
        errors.push(`#${entry.number} 以「${name}」开场是回切（${gap} 镜前刚出现过），但本镜没有被指派新增条目：`
          + '紧接着重提时观众已有概念，改用组合 B、D 收尾落图、非地图底图，或在别的底图上用画中画提示；确有新增条目就把它写进 geo_additions 指派给本镜')
      }
    }
    if (reopen) {
      run = runKey === key ? run + 1 : 1
      runKey = key
      if (entry.inGroup && run > MAX_CONSECUTIVE_REOPEN) {
        errors.push(`#${entry.number} 是连续第 ${run} 次以「${assets.get(key)?.name || key}」回切开场（上限 ${MAX_CONSECUTIVE_REOPEN}，跨组也算）：这一镜改用 B、D 或非地图底图`)
      }
    } else {
      run = 0
      runKey = ''
    }
    if (entry.combo && hasLayer(entry.combo) && entry.base) lastSeen.set(key, index)
  })
  return errors
}

// ─── 偏离检查（读时，警告级）─────────────────────────────────

/** 卡的组合/底图与组规划不一致时给出中文说明；一致返回 null */
export function groupPlanDeviation(planned: GroupPlanShot, combo: Combo | null, card: DesignCard | null): string | null {
  const reasons: string[] = []
  if (combo && combo !== planned.combo) reasons.push(`组合是 ${combo}，组规划为 ${planned.combo}`)
  const base = card?.layer_plan?.base
  const cardBase: PlanAssetRef | null = base && base.kind === 'asset' ? { asset_kind: base.asset_kind, asset_id: base.asset_id } : null
  if (combo && combo !== 'B' && planned.base && cardBase && !sameRef(cardBase, planned.base)) {
    reasons.push(`底图是 ${refKey(cardBase)}，组规划为 ${refKey(planned.base)}`)
  }
  return reasons.length ? `与本组视觉规划不一致：${reasons.join('；')}。请在 rationale 说明原因，或按规划改正` : null
}

// ─── 签名 ────────────────────────────────────────────────────

/** 实测时长按 0.5 s 分桶入签名：同文本重配音的细微抖动不让整组规划过期 */
export function bucketSeconds(seconds: number | null | undefined): number {
  return typeof seconds === 'number' && seconds > 0 ? Math.round(seconds * 2) / 2 : 0
}

export function groupPlanSignature(paragraph: string, shots: Array<{ storyboard_id: number; narration: string; measured_s: number | null }>): string {
  const body = shots
    .map(shot => `${shot.storyboard_id}\u0001${narrationMatchKey(spokenText(shot.narration))}\u0001${bucketSeconds(shot.measured_s)}`)
    .join('\u0000')
  return sha256(`${narrationMatchKey(paragraph)}\u0002${body}`).slice(0, 16)
}

// ─── 持久化与读取 ────────────────────────────────────────────

export type GroupPlanStatus = 'ok' | 'failed'

interface PlanRow {
  episode_id: number
  group_no: number
  signature: string
  status: GroupPlanStatus
  plan: string | null
  error_msg: string | null
  task_id: number | null
  updated_at: string
}

export function saveGroupPlan(episodeId: number, groupNo: number, input: {
  signature: string
  status: GroupPlanStatus
  plan: GroupPlan | null
  error: string | null
  taskId: number | null
}): void {
  sqlite.prepare(`INSERT INTO design_group_plans (episode_id, group_no, signature, status, plan, error_msg, task_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(episode_id, group_no) DO UPDATE SET signature = excluded.signature, status = excluded.status,
      plan = excluded.plan, error_msg = excluded.error_msg, task_id = excluded.task_id, updated_at = excluded.updated_at`)
    .run(episodeId, groupNo, input.signature, input.status, input.plan ? JSON.stringify(input.plan) : null, input.error, input.taskId, now())
}

function planRows(episodeId: number): Map<number, PlanRow> {
  const rows = sqlite.prepare('SELECT episode_id, group_no, signature, status, plan, error_msg, task_id, updated_at FROM design_group_plans WHERE episode_id = ?')
    .all(episodeId) as PlanRow[]
  return new Map(rows.map(row => [row.group_no, row]))
}

function parsePlan(raw: string | null): GroupPlan | null {
  if (!raw) return null
  try {
    return normalizeGroupPlan(JSON.parse(raw)).plan
  } catch {
    return null
  }
}

export interface EpisodeGroupShot {
  storyboard_id: number
  storyboard_number: number
  narration: string
  measured_s: number | null
}

export interface EpisodeGroup {
  group_no: number
  paragraph_text: string
  paragraph_chars: number
  shots: EpisodeGroupShot[]
  warnings: GroupWarning[]
  signature: string
}

function measuredOf(narrationMeta: string | null): number | null {
  const ms = parseNarrationMeta(narrationMeta).audio?.duration_ms
  return typeof ms === 'number' && ms > 0 ? Math.round(ms / 100) / 10 : null
}

/** 本集当前的逻辑组（含成员镜与签名）；非纪录片或没有剧本时为空 */
export function episodeGroups(episodeId: number): EpisodeGroup[] {
  const ep = sqlite.prepare('SELECT script_content, content FROM episodes WHERE id = ?').get(episodeId) as { script_content: string | null; content: string | null } | undefined
  if (!ep) return []
  const rows = sqlite.prepare('SELECT id, storyboard_number, narration_text, narration_meta FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL ORDER BY storyboard_number')
    .all(episodeId) as Array<{ id: number; storyboard_number: number; narration_text: string | null; narration_meta: string | null }>
  const byId = new Map(rows.map(row => [row.id, row]))
  return narrationGroupsOf(ep.script_content || ep.content, rows.map(row => ({
    id: row.id, storyboard_number: row.storyboard_number, narration_text: row.narration_text,
  }))).map((group) => {
    const shots = group.shot_ids.map((id) => {
      const row = byId.get(id)!
      return { storyboard_id: id, storyboard_number: row.storyboard_number, narration: row.narration_text || '', measured_s: measuredOf(row.narration_meta) }
    })
    return {
      group_no: group.group_no,
      paragraph_text: group.paragraph_text,
      paragraph_chars: group.paragraph_chars,
      shots,
      warnings: group.warnings,
      signature: groupPlanSignature(group.paragraph_text, shots),
    }
  })
}

export interface GroupPlanView {
  group_no: number
  paragraph_excerpt: string
  paragraph_chars: number
  shot_ids: number[]
  warnings: GroupWarning[]
  status: 'none' | GroupPlanStatus
  error: string | null
  fresh: boolean
  updated_at: string | null
  task_id: number | null
  plan: GroupPlan | null
}

/** `GET /episodes/:id/design-group-plans` 的返回体 */
export function listGroupPlans(episodeId: number): GroupPlanView[] {
  const rows = planRows(episodeId)
  return episodeGroups(episodeId).map((group) => {
    const row = rows.get(group.group_no)
    return {
      group_no: group.group_no,
      paragraph_excerpt: group.paragraph_text.replace(/\s+/g, ' ').slice(0, 60),
      paragraph_chars: group.paragraph_chars,
      shot_ids: group.shots.map(shot => shot.storyboard_id),
      warnings: group.warnings,
      status: row?.status ?? 'none',
      error: row?.error_msg ?? null,
      fresh: !!row && row.signature === group.signature,
      updated_at: row?.updated_at ?? null,
      task_id: row?.task_id ?? null,
      plan: parsePlan(row?.plan ?? null),
    }
  })
}

/** 当前**仍然新鲜**的组规划里，每镜的规划条目（偏离检查用）；没有规划的镜不在表里 */
export function freshPlannedShots(episodeId: number): Map<number, GroupPlanShot> {
  const map = new Map<number, GroupPlanShot>()
  const rows = planRows(episodeId)
  if (!rows.size) return map
  for (const group of episodeGroups(episodeId)) {
    const row = rows.get(group.group_no)
    if (!row || row.status !== 'ok' || row.signature !== group.signature) continue
    for (const shot of parsePlan(row.plan)?.shots ?? []) map.set(shot.storyboard_id, shot)
  }
  return map
}

/** 某组当前有效（签名一致、成功）的规划；没有就返回 null */
export function freshGroupPlan(episodeId: number, group: EpisodeGroup): GroupPlan | null {
  const row = planRows(episodeId).get(group.group_no)
  if (!row || row.status !== 'ok' || row.signature !== group.signature) return null
  return parsePlan(row.plan)
}
