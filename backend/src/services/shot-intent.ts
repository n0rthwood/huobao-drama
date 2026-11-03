/**
 * 表达设计（shot intent）— `storyboards.intent` 的唯一 schema / 规范化 / 校验（Issue #49）
 *
 * 一句旁白 → 观众必须理解的**信息点** → 用什么**手段**（device）→ 画面上**必须可见**的要素
 * （must_show）→ 叠加层计划（overlay_plan）→ 确定性片段位置（deterministic）。
 * 这是纪录片项目在「拆分分镜」与「关键帧提示词」之间新增的显式步骤：
 * 没有它，模型只能把旁白名词复述成「地图渐次放大」这类空话（父 Issue #44 诊断 1/3）。
 *
 * 跨 Issue 契约：
 * - `device` 五选一；`deterministic` 的默认值**只来自程序表** `DEVICE_DEFAULT_CLIP`，
 *   模型只能在 `DEVICE_ALLOWED_CLIP` 内建议覆盖，越界即回落默认并记一条校验问题（父 Issue Q2）。
 * - `must_show` / `overlay_plan` 的锚点 `{asset_id, semantic}` 必须能在 #47 的 `props.semantics`
 *   里找到（按稳定 id 或名称），找不到就把该项标 `unresolved`，**不删**——人要在表达设计页看到它。
 * - `overlay_plan[].layer` 取值必须是 #48 `LayerDoc` 的图层类型；`overlay_plan → LayerDoc/timeline`
 *   的转换归 #50，本模块只保证结构合法、锚点可解析。
 *
 * 纯函数模块：不读库、不读文件，解析上下文由调用方装配（`loadIntentContext`）。
 */

/** 表达手段：地图动画 / 档案原件 / 卡片 / 再现静帧 / 再现视频 */
export const SHOT_DEVICES = ['map_anim', 'archival', 'card', 'reenact_still', 'reenact_video'] as const
export type ShotDevice = typeof SHOT_DEVICES[number]

/** 确定性片段相对模型视频的位置 */
export const CLIP_POSITIONS = ['replace', 'pre', 'post', 'none'] as const
export type ClipPosition = typeof CLIP_POSITIONS[number]

/** 程序默认表（父 Issue #44 Q2 ✅）：按 device 查表，LLM 不得自定义默认值 */
export const DEVICE_DEFAULT_CLIP: Record<ShotDevice, ClipPosition> = {
  map_anim: 'replace',
  archival: 'replace',
  card: 'replace',
  reenact_still: 'replace',
  reenact_video: 'none',
}

/** 允许集：只有 `reenact_video` 可以在 none/pre/post 之间选，其余固定整镜替代 */
export const DEVICE_ALLOWED_CLIP: Record<ShotDevice, ClipPosition[]> = {
  map_anim: ['replace'],
  archival: ['replace'],
  card: ['replace'],
  reenact_still: ['replace'],
  reenact_video: ['none', 'pre', 'post'],
}

/**
 * 不写扩散关键帧提示词的 device：整镜由 #50 的确定性片段渲染，三槽位显示「由片段渲染」。
 * `card` **不在**此列——它的底图仍是肖像/再现静帧，需要正常的关键帧提示词，
 * 只是额外叠一张姓名条图层。
 */
export const CLIP_RENDERED_DEVICES: ShotDevice[] = ['map_anim', 'archival']

/** 不生成视频提示词的 device（整镜由确定性片段替代，没有模型视频） */
export const NO_VIDEO_PROMPT_DEVICES: ShotDevice[] = ['map_anim', 'card', 'archival']

/** 走现有 keyframe-prompt 技能、且要做 `must_show` 覆盖校验的 device */
export const REENACT_DEVICES: ShotDevice[] = ['reenact_still', 'reenact_video']

/**
 * 外部导演分镜表 kind → device（父 Issue #44 评审采纳项）。
 * 事故来源 `episodes/ep01-lihalev/shotlist.yaml` 的 `kind` 与 `map.action` 两套取值都收在这里，
 * 导入外部分镜时不再「字段无处落地」。
 */
export const EXTERNAL_KIND_DEVICE: Record<string, ShotDevice> = {
  map_anim: 'map_anim',
  archival: 'archival',
  card: 'card',
  still_kenburns: 'reenact_still',
  i2v: 'reenact_video',
  // map.action 的三种取值都是 map_anim 的 overlay_plan 变体，不是独立手段
  reveal_areas: 'map_anim',
  reveal_column: 'map_anim',
  flyto: 'map_anim',
}

/** 外部 kind（可带 map.action）→ device；认不出返回 null，由调用方决定兜底 */
export function deviceFromExternalKind(kind: unknown, mapAction?: unknown): ShotDevice | null {
  const key = typeof kind === 'string' ? kind.trim().toLowerCase() : ''
  const direct = EXTERNAL_KIND_DEVICE[key]
  if (direct) return direct
  const action = typeof mapAction === 'string' ? mapAction.trim().toLowerCase() : ''
  return EXTERNAL_KIND_DEVICE[action] || null
}

/** `must_show` 条目类别：前四类指向语义标注，后三类指向资产本身 */
export const MUST_SHOW_KINDS = ['region', 'line', 'point', 'label', 'route', 'portrait', 'exposition'] as const
export type MustShowKind = typeof MUST_SHOW_KINDS[number]

/** 指向 `props.semantics` 几何/标签的条目类别 */
const SEMANTIC_MUST_SHOW: MustShowKind[] = ['region', 'line', 'point', 'label']

/** #48 LayerDoc 的图层类型（overlay_plan 只能引用这一集合） */
export const OVERLAY_LAYER_TYPES = ['polygon', 'polyline', 'marker', 'label', 'card', 'image'] as const
export type OverlayLayerType = typeof OVERLAY_LAYER_TYPES[number]

export type IntentAssetKind = 'character' | 'scene' | 'prop'

export interface MustShowItem {
  kind: MustShowKind
  /** 资产 id；route 可以不带（纯地名 from→to 时由人工补锚点） */
  asset_id?: number
  /** 资产类别：缺省按 kind 推断（几何类 = prop、portrait = character） */
  asset_kind?: IntentAssetKind
  /** 语义条目的稳定 id 或名称（写入时允许写名称，规范化后补 semantic_id/semantic_name） */
  semantic?: string
  semantic_id?: string
  semantic_name?: string
  /** route 用：起止地名（在同一张图的 labels/points 里） */
  from?: string
  to?: string
  note?: string
  /** 解析不到对应资产/语义项；**不删除**，在表达设计页高亮待修 */
  unresolved?: boolean
  unresolved_reason?: string
}

export interface OverlayPlanItem {
  layer: OverlayLayerType
  anchor?: { asset_id?: number; asset_kind?: IntentAssetKind; semantic_id?: string; semantic?: string }
  /** 该层出现的秒数（相对本镜开头），用于 #50 的逐层显现 */
  reveal_at?: number
  /** 视口（归一化 0–1 的 x,y,w,h），用于 flyto 类镜头 */
  viewport?: [number, number, number, number]
  /** card 图层模板名与字段（姓名条/年份卡/章节卡） */
  template?: string
  fields?: Record<string, string>
  text?: string
  note?: string
  unresolved?: boolean
  unresolved_reason?: string
}

export interface ShotIntent {
  /** 这一镜要让观众理解的**唯一**信息点 */
  info_point: string
  device: ShotDevice
  must_show: MustShowItem[]
  overlay_plan: OverlayPlanItem[]
  deterministic: ClipPosition
  rationale: string
  /** 来源：`agent` = 模型产出、`manual` = 人在表达设计页改过、`import` = 外部分镜表映射 */
  source?: 'agent' | 'manual' | 'import'
}

export type IntentIssueCode =
  | 'empty_info_point'
  | 'unresolved_must_show'
  | 'unresolved_overlay_anchor'
  | 'empty_overlay_plan'
  | 'clip_position_out_of_range'

export interface IntentIssue {
  code: IntentIssueCode
  severity: 'block' | 'warn'
  message: string
  index?: number
}

export interface IntentSemanticEntry {
  id: string
  name: string
  group: 'label' | 'point' | 'region' | 'line'
}

/** 解析上下文：本集可被引用的资产 + 各自的语义条目（名称/ id 摘要，不含坐标） */
export interface IntentAssetEntry {
  kind: IntentAssetKind
  id: number
  name: string
  exposition?: boolean
  faithful?: boolean
  semantics?: IntentSemanticEntry[]
}

export interface IntentContext {
  assets: IntentAssetEntry[]
}

const MAX_INFO_POINT = 200
const MAX_RATIONALE = 600
const MAX_MUST_SHOW = 20
const MAX_OVERLAY_PLAN = 40

function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

function toDevice(value: unknown): ShotDevice | null {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return (SHOT_DEVICES as readonly string[]).includes(raw) ? raw as ShotDevice : null
}

function toAssetKind(value: unknown): IntentAssetKind | null {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return raw === 'character' || raw === 'scene' || raw === 'prop' ? raw : null
}

function defaultAssetKind(kind: MustShowKind): IntentAssetKind | null {
  if (SEMANTIC_MUST_SHOW.includes(kind) || kind === 'route') return 'prop'
  if (kind === 'portrait') return 'character'
  return null
}
const KIND_LABELS: Record<IntentAssetKind, string> = { character: '角色', scene: '场景', prop: '道具' }

/**
 * 按 id 找资产。**kind 明确时只认同类**：角色/场景/道具的 id 各自从 1 开始，
 * 回退到「任意一类里 id 相同的那个」会把 `portrait asset_id:13` 解析成 13 号道具，
 * 校验反而变成放行。kind 未知（exposition 可以是三类中任意一种）时按
 * prop → character → scene 顺序找，命中多类时返回 null 交给调用方标为歧义。
 */
function findAsset(
  ctx: IntentContext | undefined,
  assetId: number,
  kind: IntentAssetKind | null,
): { asset?: IntentAssetEntry; ambiguous?: boolean } {
  if (!ctx) return {}
  if (kind) return { asset: ctx.assets.find(a => a.id === assetId && a.kind === kind) }
  const matches = ctx.assets.filter(a => a.id === assetId)
  if (matches.length > 1) return { ambiguous: true }
  return { asset: matches[0] }
}

function findSemantic(asset: IntentAssetEntry | undefined, ref: string): IntentSemanticEntry | undefined {
  if (!asset?.semantics?.length || !ref) return undefined
  const needle = ref.trim()
  return asset.semantics.find(s => s.id === needle)
    || asset.semantics.find(s => s.name === needle)
    || asset.semantics.find(s => s.name.replace(/\s+/g, '') === needle.replace(/\s+/g, ''))
}

function normalizeMustShow(raw: unknown, ctx: IntentContext | undefined, issues: IntentIssue[]): MustShowItem[] {
  if (!Array.isArray(raw)) return []
  const items: MustShowItem[] = []
  for (const entry of raw.slice(0, MAX_MUST_SHOW)) {
    if (!entry || typeof entry !== 'object') continue
    const row = entry as Record<string, unknown>
    const kindRaw = typeof row.kind === 'string' ? row.kind.trim().toLowerCase() : ''
    if (!(MUST_SHOW_KINDS as readonly string[]).includes(kindRaw)) continue
    const kind = kindRaw as MustShowKind
    const assetId = Number.isInteger(row.asset_id) ? Number(row.asset_id) : undefined
    const assetKind = toAssetKind(row.asset_kind) ?? defaultAssetKind(kind)
    const semanticRef = text(row.semantic ?? row.semantic_id ?? row.semantic_name, 120)
    const item: MustShowItem = { kind }
    if (assetId !== undefined) item.asset_id = assetId
    if (assetKind) item.asset_kind = assetKind
    if (semanticRef) item.semantic = semanticRef
    const from = text(row.from, 80)
    const to = text(row.to, 80)
    if (from) item.from = from
    if (to) item.to = to
    const note = text(row.note, 200)
    if (note) item.note = note

    if (ctx) {
      const found = assetId === undefined ? {} : findAsset(ctx, assetId, assetKind)
      const asset = found.asset
      if (assetId === undefined) {
        if (kind !== 'route') {
          item.unresolved = true
          item.unresolved_reason = '没有指定资产'
        }
      } else if (found.ambiguous) {
        item.unresolved = true
        item.unresolved_reason = `资产 ${assetId} 在多个类别里都存在，请写明 asset_kind`
      } else if (!asset) {
        item.unresolved = true
        item.unresolved_reason = assetKind
          ? `本集没有 id 为 ${assetId} 的${KIND_LABELS[assetKind]}`
          : `资产 ${assetId} 不在本集`
      } else {
        item.asset_kind = asset.kind
        if (SEMANTIC_MUST_SHOW.includes(kind)) {
          const semantic = semanticRef ? findSemantic(asset, semanticRef) : undefined
          if (!semantic) {
            item.unresolved = true
            item.unresolved_reason = semanticRef
              ? `「${asset.name}」的语义标注里没有「${semanticRef}」`
              : `没有指定「${asset.name}」上的语义项`
          } else {
            item.semantic_id = semantic.id
            item.semantic_name = semantic.name
          }
        } else if (kind === 'route') {
          const missing = [from, to].filter(端 => 端 && !findSemantic(asset, 端))
          if (missing.length) {
            item.unresolved = true
            item.unresolved_reason = `「${asset.name}」的语义标注里没有${missing.map(m => `「${m}」`).join('、')}`
          }
        }
      }
      if (item.unresolved) {
        issues.push({
          code: 'unresolved_must_show',
          severity: 'warn',
          index: items.length,
          message: `必须可见要素「${item.semantic || item.note || item.from || item.kind}」无法解析：${item.unresolved_reason}`,
        })
      }
    }
    items.push(item)
  }
  return items
}

function normalizeOverlayPlan(raw: unknown, ctx: IntentContext | undefined, issues: IntentIssue[]): OverlayPlanItem[] {
  if (!Array.isArray(raw)) return []
  const items: OverlayPlanItem[] = []
  for (const entry of raw.slice(0, MAX_OVERLAY_PLAN)) {
    if (!entry || typeof entry !== 'object') continue
    const row = entry as Record<string, unknown>
    const layerRaw = typeof row.layer === 'string' ? row.layer.trim().toLowerCase() : ''
    if (!(OVERLAY_LAYER_TYPES as readonly string[]).includes(layerRaw)) continue
    const item: OverlayPlanItem = { layer: layerRaw as OverlayLayerType }

    const anchorRaw = row.anchor && typeof row.anchor === 'object' ? row.anchor as Record<string, unknown> : null
    if (anchorRaw) {
      const assetId = Number.isInteger(anchorRaw.asset_id) ? Number(anchorRaw.asset_id) : undefined
      const semanticRef = text(anchorRaw.semantic_id ?? anchorRaw.semantic, 120)
      item.anchor = {}
      if (assetId !== undefined) item.anchor.asset_id = assetId
      if (semanticRef) item.anchor.semantic = semanticRef
      // 语义标注只存在于证据素材（`props.semantics`，#47），所以带语义引用的锚点默认按道具解析；
      // 不带语义引用的图片/卡片层可能锚在角色上，那种情况必须显式写 asset_kind
      const anchorKind = toAssetKind(anchorRaw.asset_kind) ?? (semanticRef ? 'prop' : null)
      if (anchorKind) item.anchor.asset_kind = anchorKind
      if (ctx && assetId !== undefined) {
        const { asset, ambiguous } = findAsset(ctx, assetId, anchorKind)
        if (ambiguous) {
          item.unresolved = true
          item.unresolved_reason = `资产 ${assetId} 在多个类别里都存在，请写明 asset_kind`
        } else if (!asset) {
          item.unresolved = true
          item.unresolved_reason = `资产 ${assetId} 不在本集`
        } else if (semanticRef) {
          const semantic = findSemantic(asset, semanticRef)
          if (!semantic) {
            item.unresolved = true
            item.unresolved_reason = `「${asset.name}」的语义标注里没有「${semanticRef}」`
          } else {
            item.anchor.semantic_id = semantic.id
            item.anchor.semantic = semantic.name
          }
        }
      }
    }

    if (typeof row.reveal_at === 'number' && Number.isFinite(row.reveal_at)) {
      item.reveal_at = Math.max(0, Math.round(row.reveal_at * 100) / 100)
    }
    if (Array.isArray(row.viewport) && row.viewport.length === 4
      && row.viewport.every(v => typeof v === 'number' && Number.isFinite(v))) {
      item.viewport = (row.viewport as number[])
        .map(v => Math.min(Math.max(v, 0), 1)) as [number, number, number, number]
    }
    const template = text(row.template, 60)
    if (template) item.template = template
    if (row.fields && typeof row.fields === 'object' && !Array.isArray(row.fields)) {
      const fields: Record<string, string> = {}
      for (const [key, value] of Object.entries(row.fields as Record<string, unknown>)) {
        const v = text(value, 200)
        if (v) fields[text(key, 40)] = v
      }
      if (Object.keys(fields).length) item.fields = fields
    }
    const content = text(row.text, 200)
    if (content) item.text = content
    const note = text(row.note, 200)
    if (note) item.note = note

    if (item.unresolved) {
      issues.push({
        code: 'unresolved_overlay_anchor',
        severity: 'warn',
        index: items.length,
        message: `叠加层「${item.layer}」的锚点无法解析：${item.unresolved_reason}`,
      })
    }
    items.push(item)
  }
  // reveal_at 升序（没写的排在最后，保持原顺序）
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const ra = a.item.reveal_at ?? Number.POSITIVE_INFINITY
      const rb = b.item.reveal_at ?? Number.POSITIVE_INFINITY
      return ra === rb ? a.index - b.index : ra - rb
    })
    .map(({ item }) => item)
}

/**
 * 规范化 + 校验。永远返回一份结构合法的 intent（不抛错）：
 * 解析不到的条目留在原地并标 `unresolved`，问题列在 `issues` 里给界面展示。
 * `raw` 不含可识别的 device 时返回 `intent: null`（视为「这一镜还没做表达设计」）。
 */
export function normalizeShotIntent(
  raw: unknown,
  ctx?: IntentContext,
): { intent: ShotIntent | null; issues: IntentIssue[] } {
  const issues: IntentIssue[] = []
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { intent: null, issues }
  const row = raw as Record<string, unknown>
  const device = toDevice(row.device)
  if (!device) return { intent: null, issues }

  const infoPoint = text(row.info_point, MAX_INFO_POINT)
  if (!infoPoint) {
    issues.push({ code: 'empty_info_point', severity: 'block', message: '没有写本镜的信息点（info_point）' })
  }

  const mustShow = normalizeMustShow(row.must_show, ctx, issues)
  const overlayPlan = normalizeOverlayPlan(row.overlay_plan, ctx, issues)

  // 「禁止把地图当道具平铺推拉」：map_anim 镜头必须有叠加层计划
  if (device === 'map_anim' && !overlayPlan.length) {
    issues.push({
      code: 'empty_overlay_plan',
      severity: 'block',
      message: '地图动画镜头的 overlay_plan 不能为空：至少要有一层高亮/路线/标签，否则就是把地图当道具平铺推拉',
    })
  }

  const allowed = DEVICE_ALLOWED_CLIP[device]
  const requested = typeof row.deterministic === 'string' ? row.deterministic.trim().toLowerCase() : ''
  let deterministic = DEVICE_DEFAULT_CLIP[device]
  if (requested && (CLIP_POSITIONS as readonly string[]).includes(requested)) {
    if (allowed.includes(requested as ClipPosition)) {
      deterministic = requested as ClipPosition
    } else {
      issues.push({
        code: 'clip_position_out_of_range',
        severity: 'warn',
        message: `${device} 的片段位置只能是 ${allowed.join(' / ')}，已回落到默认值 ${DEVICE_DEFAULT_CLIP[device]}（收到 ${requested}）`,
      })
    }
  } else if (requested) {
    issues.push({
      code: 'clip_position_out_of_range',
      severity: 'warn',
      message: `片段位置 ${requested} 不是合法取值，已回落到默认值 ${DEVICE_DEFAULT_CLIP[device]}`,
    })
  }

  const source = row.source === 'manual' || row.source === 'import' ? row.source : 'agent'

  return {
    intent: {
      info_point: infoPoint,
      device,
      must_show: mustShow,
      overlay_plan: overlayPlan,
      deterministic,
      rationale: text(row.rationale, MAX_RATIONALE),
      source,
    },
    issues,
  }
}

/** 库里的 JSON 文本 → intent（坏数据返回 null，不抛） */
export function parseShotIntent(raw: string | null | undefined): ShotIntent | null {
  if (!raw) return null
  try {
    return normalizeShotIntent(JSON.parse(raw)).intent
  } catch {
    return null
  }
}

export function serializeShotIntent(intent: ShotIntent | null): string | null {
  return intent ? JSON.stringify(intent) : null
}


/** 该 intent 要求关键帧提示词必须 @ 到的资产（只有再现类镜头才做这项校验） */
export function mustShowAssetRefs(intent: ShotIntent | null): { kind: IntentAssetKind; id: number }[] {
  if (!intent || !REENACT_DEVICES.includes(intent.device)) return []
  const refs: { kind: IntentAssetKind; id: number }[] = []
  for (const item of intent.must_show) {
    if (item.unresolved || item.asset_id === undefined) continue
    const kind = item.asset_kind || defaultAssetKind(item.kind)
    if (!kind) continue
    if (!refs.some(r => r.kind === kind && r.id === item.asset_id)) refs.push({ kind, id: item.asset_id })
  }
  return refs
}

export const DEVICE_LABELS: Record<ShotDevice, string> = {
  map_anim: '地图动画',
  archival: '档案原件',
  card: '卡片',
  reenact_still: '再现静帧',
  reenact_video: '再现视频',
}
