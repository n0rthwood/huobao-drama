/**
 * 设计卡的「现有资产依据」校验与提示词条款（Issue #87）
 *
 * 用户裁决（#87 用户确认 1）覆盖旧契约：AI 只能用**当前已有**的资产图像、属性、语义和既有渲染
 * 能力完成设计；不得把「锚点留空、等人工补标注」当作一次成功的填卡。人工补充信息不受此限制
 * （本文件只在 scope=design_card 的 AI 写入路径生效，人工 PUT 一律不套）。
 *
 * 旧实现（#57）的两处放行被本文件替换：
 * - 批量提示词里「语义为空时保留规划图层、anchor 留空待标注」的豁免；
 * - `update_storyboard` 只拒「填了名字但解析不到」的引用，留空的几何层照样放行。
 *
 * 判定全部是**可机器判断**的结构事实，不另造语义 LLM 审核器：引用是否解析得到、语义组别与
 * 图层类型是否相容、几何是否在本镜底图所属资产与版本上、以及需要锚定的层是否真的锚了。
 * 「这张图在历史上对不对」这类判断不在机检范围内，也不会因为一张图没有语义标注就一律禁用它。
 */
import {
  hasGenSegment,
  hasLayerSegment,
  type Combo,
  type DesignCard,
  type DesignCardAssetEntry,
  type DesignCardContext,
  type DesignCardSemanticEntry,
  type PlannedLayer,
  type PlannedLayerType,
} from './design-card.js'

/** 机检出的依据缺口；逐条回给模型，让它在当前工具循环内改正（Fabel 规则 9） */
export interface GroundingViolation {
  code:
    | 'base_unresolved'
    | 'must_mark_blank'
    | 'semantic_not_found'
    | 'semantic_group_mismatch'
    | 'semantic_geometry_empty'
    | 'semantic_version_mismatch'
    | 'anchor_not_on_base'
    | 'anchor_required_blank'
    | 'anchor_asset_ambiguous'
    | 'image_source_missing'
    | 'base_image_missing'
    | 'semantic_version_unverifiable'
    | 'reference_asset_unresolved'
    | 'reference_image_missing'
  /** planned_layers 下标（从 0 起）；不是图层问题时为 null */
  layer_index: number | null
  /** must_mark 下标（从 0 起）；不是 must_mark 问题时为 null */
  must_mark_index: number | null
  message: string
}

/**
 * 图层类型 → 它能从哪些语义组别取到可执行几何（与 layer-segment-draft 的实际取几何路径一致：
 * polygon / polyline 都从 regions.points 或 lines.points 取折点，marker 只认 points.at，
 * label 的定位框只认 labels.bbox）。card 只用文字、image 用资产图片本身，两者不要求语义几何。
 * 表里没有的类型 = 这一层不按坐标落到画面上。
 */
const COMPATIBLE_GROUPS: Partial<Record<PlannedLayerType, DesignCardSemanticEntry['group'][]>> = {
  polygon: ['region', 'line'],
  polyline: ['line', 'region'],
  marker: ['point'],
  label: ['label'],
}

/** 必须锚到真实语义几何才渲染得出来的图层类型（缺几何时 draft 会直接跳过该层） */
const GEOMETRY_REQUIRED: PlannedLayerType[] = ['polygon', 'polyline', 'marker']

/**
 * 各图层类型要真正画出来所需的最少几何点数（与 layer-segment-draft 的下限一致）：
 * polygon/polyline 归一化后不足 2 个点会被整层跳过，marker 要一个坐标，label 要一个 bbox。
 */
const MIN_GEOMETRY_POINTS: Partial<Record<PlannedLayerType, number>> = {
  polygon: 3,
  polyline: 2,
  marker: 1,
  label: 1,
}

const GROUP_LABELS: Record<DesignCardSemanticEntry['group'], string> = {
  label: '文字标注（labels，带 bbox）',
  point: '地点（points，带坐标）',
  region: '范围（regions，带多边形）',
  line: '线（lines，带折线）',
}

const LAYER_LABELS: Record<PlannedLayerType, string> = {
  polygon: '范围高亮',
  polyline: '路线/河流',
  marker: '地点标记',
  label: '文字标注',
  card: '卡片',
  image: '内嵌图片',
  text: '模板文本框',
}

/**
 * 本集资产定位，与 `design-card.ts` 的 `findAsset` 同口径：给了类别按「类别 + id」取，
 * 没给类别时**只有唯一匹配才算数**——跨表同 id 时挑第一个会把语义/图片核验落到错的资产上。
 */
function assetOf(
  ctx: DesignCardContext,
  assetId: number | null | undefined,
  kind?: DesignCardAssetEntry['kind'] | null,
): DesignCardAssetEntry | undefined {
  if (assetId == null) return undefined
  if (kind) return ctx.assets.find(asset => asset.id === assetId && asset.kind === kind)
  const matches = ctx.assets.filter(asset => asset.id === assetId)
  return matches.length === 1 ? matches[0] : undefined
}

/**
 * 锚点资产。`SemanticRef` 规范化后不保留 `asset_kind`，所以跨表同号时只能按事实判断：
 * 1）锚的就是底图那张资产（同号）→ 以底图为准；2）同号候选里只有一张真有这条语义 → 取那张；
 * 3）仍分不清 → 返回 undefined，由调用方报「同号无法判别」。**任何情况下都不挑第一个**。
 */
function anchorAssetOf(
  ctx: DesignCardContext,
  anchor: { asset_id: number; semantic_id: string; name: string },
  baseAsset: DesignCardAssetEntry | undefined,
): DesignCardAssetEntry | undefined {
  const unique = assetOf(ctx, anchor.asset_id)
  if (unique) return unique
  if (baseAsset && baseAsset.id === anchor.asset_id) return baseAsset
  const key = (anchor.semantic_id || anchor.name).trim()
  if (!key) return undefined
  const owners = ctx.assets.filter(asset =>
    asset.id === anchor.asset_id && asset.semantics?.some(item => item.id === key || item.name === key))
  return owners.length === 1 ? owners[0] : undefined
}

function layerTag(index: number, layer: PlannedLayer): string {
  const text = (layer.text || '').trim()
  return `第 ${index + 1} 层（${LAYER_LABELS[layer.type]} ${layer.type}${text ? `「${text}」` : ''}）`
}

/** 一条语义在清单里的写法：`id（名称，组别，n 个几何点）` */
function describeSemantic(item: DesignCardSemanticEntry): string {
  const geometry = item.geometry_points === undefined ? '' : `，${item.geometry_points} 个几何点`
  return `${item.id}（${item.name}，${item.group}${geometry}）`
}

function semanticInventory(asset: DesignCardAssetEntry | undefined): string {
  if (!asset) return '该资产不在本集'
  if (!asset.semantics?.length) return '该资产当前没有任何语义条目'
  return asset.semantics.map(describeSemantic).join('、')
}

/**
 * AI 写入路径的依据机检。`card` 已经过 `normalizeDesignCard`（引用解析不到时带 unresolved 标记）。
 * `combo` 为 null 时按「可能有图层段」从严判定。
 */
export function checkDesignCardGrounding(
  card: DesignCard | null,
  ctx: DesignCardContext,
  combo: Combo | null = null,
): GroundingViolation[] {
  if (!card) return []
  const out: GroundingViolation[] = []
  const plan = card.layer_plan
  const layerSegment = combo === null ? true : hasLayerSegment(combo)
  const base = plan?.base && plan.base.kind === 'asset' ? plan.base : null
  const baseAsset = base ? assetOf(ctx, base.asset_id, base.asset_kind) : undefined

  if (base?.unresolved) {
    out.push({
      code: 'base_unresolved',
      layer_index: null,
      must_mark_index: null,
      message: `图层段底图引用不到：${base.unresolved_reason || `资产 ${base.asset_id} 不在本集`}。底图只能选 read_storyboard_context 返回的本集资产。`,
    })
  } else if (layerSegment && base && !baseAsset?.image) {
    // 底图必须是**现在就有图**的资产：没有成图的资产不能当作已具备的实现条件
    out.push({
      code: 'base_image_missing',
      layer_index: null,
      must_mark_index: null,
      message: `图层段底图「${baseAsset?.name ?? `资产 ${base.asset_id}`}」当前没有可用图片（既没有原件也没有生成图），不能作为本镜的底图。请换一张现在就有图的资产，或改用不依赖底图的表达；不要按「以后会有图」来规划。`,
    })
  }

  // must_mark：必须逐条落到真实语义条目上，留空不再是「待标注」的合法写法
  for (const [index, ref] of (plan?.must_mark || []).entries()) {
    const asset = anchorAssetOf(ctx, ref, baseAsset)
    if (!ref.semantic_id.trim() && !ref.name.trim()) {
      out.push({
        code: 'must_mark_blank',
        layer_index: null,
        must_mark_index: index,
        message: `must_mark 第 ${index + 1} 条没有写 semantic_id / name。must_mark 的含义是「本镜必须在底图上标出的真实语义条目」，不能留空等人工补标注。「${asset?.name ?? `资产 ${ref.asset_id}`}」现有语义：${semanticInventory(asset)}。如果这条信息本来就没有可用标注，请删掉这条 must_mark，改用该资产实际支持的表达，或说明本镜无法完成。`,
      })
      continue
    }
    if (ref.unresolved) {
      out.push({
        code: 'semantic_not_found',
        layer_index: null,
        must_mark_index: index,
        message: `must_mark 第 ${index + 1} 条引用不到：${ref.unresolved_reason || `「${ref.semantic_id || ref.name}」不存在`}。semantic_id / name 只能逐字取自该资产的真实清单；资产名不是语义名。「${asset?.name ?? `资产 ${ref.asset_id}`}」现有语义：${semanticInventory(asset)}。`,
      })
    }
  }

  for (const [index, layer] of (plan?.planned_layers || []).entries()) {
    const anchor = layer.anchor
    const anchorAsset = anchor ? anchorAssetOf(ctx, anchor, baseAsset) : undefined
    const needsGeometry = layerSegment && GEOMETRY_REQUIRED.includes(layer.type)
    // 跨表同号（例如道具 7 与角色 7）且既不是底图那张、也没有唯一一张带着这条语义：
    // 无法判断锚的是哪张图，绝不默默挑第一个
    const ambiguous = !!anchor && !anchorAsset && ctx.assets.filter(asset => asset.id === anchor.asset_id).length > 1
    if (ambiguous) {
      out.push({
        code: 'anchor_asset_ambiguous',
        layer_index: index,
        must_mark_index: null,
        message: `${layerTag(index, layer)} 的 anchor.asset_id=${anchor!.asset_id} 在本集同时对应多个资产（角色 / 场景 / 道具里有同号），而这条语义在它们之间也不唯一，无法确定锚的是哪一张图。请改用本镜图层段底图那张资产上的语义条目（anchor.asset_id 写成底图的 asset_id）。`,
      })
      continue
    }

    if (layer.type === 'image') {
      // image 层画的是资产图片本身（无锚点时用底图），不要求语义；但那张图必须真的存在
      const source = anchorAsset ?? baseAsset
      if (anchor && !anchorAsset) {
        out.push({
          code: 'semantic_not_found',
          layer_index: index,
          must_mark_index: null,
          message: `${layerTag(index, layer)} 的 anchor.asset_id=${anchor.asset_id} 不在本集。`,
        })
      } else if (!source?.image) {
        out.push({
          code: 'image_source_missing',
          layer_index: index,
          must_mark_index: null,
          message: `${layerTag(index, layer)} 没有可用的图片：${source ? `「${source.name}」当前没有生成图/原件` : '既没有 anchor 指向的资产，也没有图层段底图'}。请改用确实已有图片的资产，或换成本镜资产支持的其他表达。`,
        })
      }
      continue
    }

    if (!anchor || (!anchor.semantic_id.trim() && !anchor.name.trim())) {
      if (needsGeometry) {
        out.push({
          code: 'anchor_required_blank',
          layer_index: index,
          must_mark_index: null,
          message: `${layerTag(index, layer)} 要画出资产上的具体${layer.type === 'marker' ? '位置' : layer.type === 'polyline' ? '路线' : '范围'}，必须锚定到真实语义条目，anchor 留空渲染时会被整层丢弃。底图「${baseAsset?.name ?? '（未指定）'}」现有语义：${semanticInventory(baseAsset)}。没有可用几何时不要留空占位：改成该资产确实支持的表达（整体展示、文字说明等），或者不保存本镜并说明缺什么。`,
        })
      }
      // 纯标题 / 定义 / 说明类的 label、card 不指向资产内具体对象时，无锚点是合法写法
      continue
    }

    if (anchor.unresolved) {
      out.push({
        code: 'semantic_not_found',
        layer_index: index,
        must_mark_index: null,
        message: `${layerTag(index, layer)} 的 anchor 引用不到：${anchor.unresolved_reason || `「${anchor.semantic_id || anchor.name}」不存在`}。不要虚构语义、不要用资产名冒充语义、也不要借用别的资产或别的版本上的同名语义。「${anchorAsset?.name ?? `资产 ${anchor.asset_id}`}」现有语义：${semanticInventory(anchorAsset)}。`,
      })
      continue
    }

    const anchorKey = (anchor.semantic_id || anchor.name).trim()
    const entry = anchorAsset?.semantics?.find(item => item.id === anchorKey || item.name === anchorKey)
    const compatible = COMPATIBLE_GROUPS[layer.type]
    if (entry && compatible && !compatible.includes(entry.group)) {
      out.push({
        code: 'semantic_group_mismatch',
        layer_index: index,
        must_mark_index: null,
        message: `${layerTag(index, layer)} 只能用${compatible.map(group => GROUP_LABELS[group]).join('或')}，但「${entry.name}」是${GROUP_LABELS[entry.group]}，类型不相容，渲染不出这一层。请改锚到相容的语义条目，或把图层类型换成与现有语义相符的那一种。`,
      })
      continue
    }

    // 语义 ID 真实存在，但那条语义本身没有可用几何：同样不是「已可实现」的依据
    const minPoints = MIN_GEOMETRY_POINTS[layer.type]
    if (entry && minPoints !== undefined && entry.geometry_points !== undefined && entry.geometry_points < minPoints) {
      out.push({
        code: 'semantic_geometry_empty',
        layer_index: index,
        must_mark_index: null,
        message: `${layerTag(index, layer)} 锚到的「${entry.name}」虽然真实存在，但它只有 ${entry.geometry_points} 个几何点，画这一层至少需要 ${minPoints} 个，渲染时会被整层跳过。请改锚到几何完整的语义条目，或改用该资产确实支持的表达。`,
      })
      continue
    }

    // 语义坐标是**该资产原图像素**：锚到别的资产，坐标落不到本镜底图上。
    // 只对真正用坐标的层生效（card 只借名字，不画位置）。
    if (layerSegment && base && compatible && anchor.asset_id !== base.asset_id) {
      out.push({
        code: 'anchor_not_on_base',
        layer_index: index,
        must_mark_index: null,
        message: `${layerTag(index, layer)} 锚到了「${anchorAsset?.name ?? `资产 ${anchor.asset_id}`}」的语义，但本镜图层段底图是「${baseAsset?.name ?? `资产 ${base.asset_id}`}」。语义坐标只在自己那张图上成立，跨资产借用画不出正确位置。请改用底图自身的语义条目，或把底图换成该语义所属的资产。`,
      })
      continue
    }

    // 钉死底图版本时，语义必须能证明是针对同一版图做的；
    // 「标注没记录版本」是未确认，不能当成相容（Fabel 规则 3）。
    if (layerSegment && base && compatible && base.version_task_id != null && anchorAsset) {
      const semanticsVersion = anchorAsset.semantics_source_task_id
      if (semanticsVersion == null) {
        out.push({
          code: 'semantic_version_unverifiable',
          layer_index: index,
          must_mark_index: null,
          message: `${layerTag(index, layer)} 的底图钉死在版本 ${base.version_task_id}，但「${anchorAsset.name}」的语义标注没有记录它针对哪一版图，无法确认坐标与该版本相容。请把 base.version_task_id 置为 null（用当前生效图，语义即按它标注），或改用能确认版本的依据。`,
        })
      } else if (semanticsVersion !== base.version_task_id) {
        out.push({
          code: 'semantic_version_mismatch',
          layer_index: index,
          must_mark_index: null,
          message: `${layerTag(index, layer)} 的语义标注是针对「${anchorAsset.name}」另一版本（版本 ${semanticsVersion}）的图做的，而底图指定的是版本 ${base.version_task_id}，坐标不相容。请把底图改回语义所针对的版本，或改用该版本上真实存在的语义。`,
        })
      }
    }
  }

  const genSegment = combo === null ? true : hasGenSegment(combo)
  for (const [index, ref] of (card.gen_plan?.reference_assets || []).entries()) {
    if (ref.unresolved) {
      out.push({
        code: 'reference_asset_unresolved',
        layer_index: null,
        must_mark_index: null,
        message: `gen_plan.reference_assets 第 ${index + 1} 条引用不到：${ref.unresolved_reason || `资产 ${ref.id} 不在本集`}。参考资产只能取本集已有资产。`,
      })
      continue
    }
    // 参考资产是**送进生成模型的图**：现在没有图就不是可用依据，不能按「以后会出图」规划
    // 「引用了不存在的资产」任何组合都不许写；「现在还没有图」只在真有生成段时才阻断
    const asset = assetOf(ctx, ref.id, ref.kind)
    if (genSegment && !asset?.image) {
      out.push({
        code: 'reference_image_missing',
        layer_index: null,
        must_mark_index: null,
        message: `gen_plan.reference_assets 第 ${index + 1} 条「${asset?.name || ref.name || `资产 ${ref.id}`}」当前没有图片（既没有原件也没有生成图），不能作为生成段的参考。请改用已经有图的资产，或改用不依赖它的表达。`,
      })
    }
  }

  return out
}

/** 工具拒绝时回给模型的正文：逐条缺口 + 不许绕过的写法（Fabel 规则 8/9） */
export function groundingRejectionMessage(violations: GroundingViolation[]): string {
  const items = violations.map((item, index) => `${index + 1}. ${item.message}`).join('\n')
  return [
    '设计卡没有保存：下列依赖在当前资产里没有真实、相容、可执行的依据。',
    items,
    '请在本次工具循环内改正后重新调用 update_storyboard：改锚到真实且类型相容的语义条目，'
    + '或改用现有资产确实支持的表达（整体展示、文字说明、生成段演绎），信息点一条都不能丢。'
    + '不要把 anchor 清空冒充「无锚定」、不要删掉引用字段、不要自造字段宣称成功；'
    + '若现有资产确实无法满足本镜必须的视觉任务，就不要保存这张卡，直接说明受影响的图层、所需依据、'
    + '以及现有资产缺少什么——待人工补标注不是本次设计已完成的理由。',
  ].join('\n')
}

/**
 * 批量填卡提示词里的「资产依据」整段（Issue #87 / Fabel 中文母版）。
 * 返回值包含本集**真实语义清单**与全部填写规则，调用方直接整段插入即可，无需另拼语义列表。
 */
export function buildDesignCardGroundingInstruction(assets: DesignCardContext['assets']): string {
  const inventory = assets.length
    ? assets.map(asset => {
      const entries = asset.semantics?.length
        ? asset.semantics.map(describeSemantic).join('、')
        : '无语义条目'
      return `- ${asset.kind} #${asset.id} ${asset.name}：${entries}`
    }).join('\n')
    : '- （本集没有可引用的资产）'

  return `【设计卡填写规则：现有资产依据与可执行设计】

本集真实语义清单（semantic_id 只能逐字取自这里，组别决定它能支撑哪种图层）：
${inventory}

1. 以现有资产和既有制作能力完成设计。设计必须能依据当前任务可用的资产图像、属性、语义和既有渲染能力实现；不得把尚未存在的信息、尚未创建的标注、猜测的点位或路线写成已经具备的实现条件。
2. 选择资产前先确认所需依据。先读与该用途相关的现有信息，确认实际引用的资产及版本；文件名、资产标题、其他版本的图片或其他资产的语义，都不能代替本次引用对象的证据。涉及具体画面内容时用 read_image 看原图确认，不要声称看过没读过的内容。
3. 区分「尚未读取」与「已确认不存在」。没读就先读；读过确认没有，就不能继续当它存在，也不能用「待人工补充」作为完成设计的理由。
4. 所有依赖都必须有真实、相容、可执行的依据。要绑定资产内具体位置、对象、路线或区域的图层，必须引用**本镜底图那张资产、那个版本**上真实存在、含义与类型相容、且带所需几何的语义：polygon / polyline 要带折点的 region 或 line（polygon 至少 3 点，polyline 至少 2 点），marker 要 point（坐标），label 的定位框要 label（文字框）。语义 ID / 名称只能取自上面的真实清单；不得杜撰，不得用资产名冒充语义，不得借用其他资产或不相容版本上的同名语义；语义存在但缺少所需几何同样不能算依据。底图与生成段 reference_assets 必须是**现在就有图**的资产（有原件或已生成图），不能按「以后会出图」规划；把底图钉在某个 version_task_id 时，该资产的标注必须能确认是针对那一版做的，确认不了就不要钉版本。
5. 按实际依赖判断是否需要锚定。纯章节标题、定义、说明类的 label / card，以及不指向资产内具体对象或位置的屏幕排版元素，可以明确不写 anchor。但不要因为图层类型是 label 或 card 就自动免除依据：内容实际指向某个地点、区域或路线时，仍须满足第 4 条。**空锚点本身不是一律错误；需要锚定却留空才是错误**——留空的几何层在渲染时会被整层丢弃，等于这条信息没有出现。
6. 没有语义标注的图片，可以用于它实际支持的用途：作为背景、整体展示，或其他不依赖缺失标注的表达。不要求每张图都先标注。但不得把普通河网当成某条特定历史路线，不得把「图里有河流」说成「已经具备这条航线的可执行路径」。
7. 可以更换表现手法，不得静默丢失任务要求。某种表现方式做不到时，改用现有资产支持的其他表达，但必须保留全部信息点，并满足脚本/用户明确要求的视觉任务；不得修改旁白逐字契约，不得把必须由画面呈现的关系静默退成纯旁白。AI 自选的装饰手法可以替换，用户明确要求的视觉功能不能自行取消。
8. 现有条件无法满足必要任务时，不要保存为完成设计。先在现有资产里找可行替代；仍不行就不要调用 update_storyboard 保存这张卡，改为说明：受影响的图层、所需依据、当前资产缺少什么、为何现有替代不能满足。不得写入不存在的引用、留空的必要依赖或「后期补标注」占位卡。可以说明人工补哪些信息会改变可行性，但那只是缺口说明，不是本次设计已完成的条件。
9. 工具拒绝必须在当前循环内处理。update_storyboard 返回具体层的引用、类型、几何或可执行性错误时，按真实返回改正后重试，不要靠删引用字段、改称「无锚定」或改走人工写入路径绕过，也不要自造字段宣称成功。
10. 以上约束只针对 AI 自动生成与 AI 写工具。人工可以补充信息、创建标注、扩展设计，不受「只能使用当前已有依据」的限制；你不得因此改写人工已有的卡片、删除人工图层或覆盖已有制作产物，也不得把人工将来可能补的标注算作本次已完成的依据。`
}
