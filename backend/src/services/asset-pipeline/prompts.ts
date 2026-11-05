/**
 * 流水线三个 AI 环节的提示词（Issue #56）
 *
 * 为什么内联而不挂技能目录：这三步是直接 `callTextChat`，不是 Agent 运行，
 * `AGENT_SKILL_MAP` 不会注入技能（与 `asset-semantics-auto.ts` 同口径）。
 *
 * 关键约束写死在提示词里，不靠运行时纠正：
 * - 事实表每条必须带 `metric`（闸门禁用 `minor` 的依据）与年代约束；
 * - 出图提示词必须含 `no text, no labels, no captions, no legend`
 *   （底图零文字是图层体系的前提，画面文字一律判 FAIL）；
 * - QC 只许按清单逐条给 `verdict/detected/evidence`，不得自创 tolerance、不得改清单。
 */
import type { AssetSpecRow, AssetSourceRow } from './store.js'

export const RESEARCH_SYSTEM = `你是纪录片美术组的资料研究员。目标是为一件历史资产（人物/场景/器物/地图）找出**权威可核对**的图像资料线索。
严格要求：
1. 只产出**候选线索**，不要编造 URL。不确定时宁可少给，并在 notes 里说明不确定。
2. 每条候选必须写清：它能证明什么（what_it_proves）、年代（era）、许可提示（license_hint，如 Public domain / CC BY-SA / 不确定）。
3. 本系统**不会自动抓取**你给的链接；人工会逐条核对后手动入库。
只返回 JSON，不要 Markdown 代码块：
{"candidates":[{"url":"","title":"","artist":"","license_hint":"","era":"","what_it_proves":""}],"key_facts":[""],"notes":""}`

export const SPEC_SYSTEM = `你是纪录片美术组的考据负责人。把资料整理成一张**可逐条机检**的事实表，用于约束出图与质检。
严格要求：
1. must_have 5–9 条，每条给 {id, element, why, check, metric}。
   - metric 只能是 count / arrangement / color / shape / other；
   - **可数的数量、排列方式、颜色**必须分别标 count / arrangement / color（这三类之后不允许「轻微不符」）；
   - check 必须是**看图就能逐条核对**的动作，不能是「整体氛围到位」这种无法核验的话。
2. forbidden 3–8 条，每条给 {id, error, why}，写明典型的年代错误/形制错误。
3. tolerances 是**允许的差异白名单**（自然语言整句）。质检只能引用这里的原句，不能自创。
4. uncertainties 写明学术上无定论、不应据此判错的点。
5. 每条 why 必须带年代约束（era_constraint），写明该结论适用的年代范围。
6. palette 与 composition 各一句。
只返回 JSON，不要 Markdown 代码块：
{"summary":"","must_have":[{"id":"mh1","element":"","why":"","check":"","metric":"count"}],"forbidden":[{"id":"fb1","error":"","why":""}],"tolerances":[""],"uncertainties":[""],"palette":"","composition":""}`

export const QC_SYSTEM = `你是图像质检员。你只负责**描述你在图上看到了什么**，通过与否由程序判定，不要给总体结论之外的建议性放宽。
严格要求：
1. 对清单里的**每一个** id 各回答一次，不能漏、不能重复、不能新增 id。
2. must_have 每条给 {id, verdict, evidence}，verdict 只能是 ok / minor / violation。evidence 必须写你在画面哪里看到了什么。
3. forbidden 每条给 {id, detected, evidence}，detected 必须是布尔值 true/false。
4. **不得自创容差**。若你认为某条应按容差放行，必须在该条上加 "tolerance" 字段并**原文照抄**给你的容差清单里的整句；抄不到就不要加。
5. text_in_image 必须给 {present: true/false, evidence}：画面上只要有任何可辨认的文字、字母、数字、图例、水印，present 就是 true。
6. locate 只在给了定位目标时回答：每个目标给 {id, name, at:[x,y]}，x/y 是**归一化到 0–1** 的画面坐标（左上角为原点）。看不到就给 at:null。
只返回 JSON，不要 Markdown 代码块：
{"must_have":[{"id":"","verdict":"ok","evidence":""}],"forbidden":[{"id":"","detected":false,"evidence":""}],"text_in_image":{"present":false,"evidence":""},"locate":[],"fidelity_score":0,"beauty_score":0,"suggestions":[""],"overall":"pass"}`

export function researchUserPrompt(input: {
  assetKind: string
  name: string
  description: string | null
  era: string | null
  existing: AssetSourceRow[]
}): string {
  const existing = input.existing.length
    ? input.existing.map(s => `- ${s.title || s.url || s.local_path}（许可：${s.license}；角色：${s.role}）`).join('\n')
    : '（暂无已入库素材）'
  return [
    `资产类型：${input.assetKind}`,
    `名称：${input.name}`,
    `描述：${input.description || '（无）'}`,
    `年代线索：${input.era || '（未给出，请在 key_facts 里推断并说明依据）'}`,
    '已入库素材：',
    existing,
  ].join('\n')
}

export function specUserPrompt(input: {
  assetKind: string
  name: string
  description: string | null
  research: string
  sources: AssetSourceRow[]
}): string {
  const usable = input.sources.filter(s => s.role !== 'rejected')
  const rejected = input.sources.filter(s => s.role === 'rejected')
  return [
    `资产类型：${input.assetKind}`,
    `名称：${input.name}`,
    `描述：${input.description || '（无）'}`,
    '资料研究结论（JSON）：',
    input.research,
    '可用素材：',
    usable.length
      ? usable.map(s => `- ${s.title || s.url || s.local_path}｜角色 ${s.role}｜年代 ${s.era || '未注明'}｜许可 ${s.license}`).join('\n')
      : '（无可用素材，事实表必须据文字资料写，并在 uncertainties 里说明缺少图像佐证）',
    rejected.length ? `已排除素材：${rejected.map(s => `${s.title || s.url}（${s.why_excluded || '未注明理由'}）`).join('；')}` : '',
  ].filter(Boolean).join('\n')
}

/** 出图提示词：事实表 → 英文描述；底图零文字是硬约束 */
export function buildImagePrompt(spec: AssetSpecRow, input: {
  name: string
  purpose: 'precision' | 'beautify'
  reviseNotes: string[]
  stylePrompt: string | null
}): string {
  const musts = spec.must_have.map(item => item.element).filter(Boolean)
  const parts = [
    input.purpose === 'precision'
      ? `historically accurate depiction of ${input.name}`
      : `refined, better-lit and sharper rendering of ${input.name} keeping every structural detail unchanged`,
    spec.summary.replace(/\s+/g, ' ').trim(),
    ...musts,
    spec.composition || '',
    spec.palette || '',
    input.purpose === 'beautify' && input.stylePrompt ? input.stylePrompt : '',
    ...input.reviseNotes,
    // 画面文字一律判 FAIL：地名/图例/标注都走图层体系，不进底图
    'no text, no labels, no captions, no legend, no watermark, no signage',
  ]
  return parts.filter(Boolean).join(', ')
}

export function buildNegativePrompt(spec: AssetSpecRow): string {
  return spec.forbidden.map(item => item.error).filter(Boolean).join(', ')
}

export function qcUserPrompt(spec: AssetSpecRow, framing: string): string {
  return [
    framing,
    `资产：${spec.summary}`,
    '必须要素清单（逐条回答，不得增删）：',
    ...spec.must_have.map(item => `- ${item.id}｜${item.element}｜核对方法：${item.check || '（未给出）'}｜metric=${item.metric}`),
    '禁止项清单（逐条回答，不得增删）：',
    ...spec.forbidden.map(item => `- ${item.id}｜${item.error}`),
    '允许的容差（只能原文引用，不得自创）：',
    ...(spec.tolerances.length ? spec.tolerances.map(item => `- ${item}`) : ['（无）']),
    '学术不确定项（不得据此判错）：',
    ...(spec.uncertainties.length ? spec.uncertainties.map(item => `- ${item}`) : ['（无）']),
    spec.locate_targets.length
      ? `定位目标（给归一化坐标）：${spec.locate_targets.map(t => `${t.id}=${t.name}`).join('、')}；定位地标：${spec.locate_anchors.map(t => `${t.id}=${t.name}`).join('、') || '（无）'}`
      : '本次不需要定位，locate 返回空数组。',
  ].join('\n')
}

/** 模型返回的 JSON 正文可能被包在 ```json 代码块里 */
export function parseJsonReply(text: string): unknown {
  const trimmed = text.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed)
  const body = fenced ? fenced[1]! : trimmed
  const start = body.search(/[[{]/)
  if (start < 0) throw new Error(`模型没有返回 JSON：${trimmed.slice(0, 200)}`)
  const candidate = body.slice(start)
  try {
    return JSON.parse(candidate)
  } catch {
    // 尾部可能多出解释性文字：回退到最后一个闭合括号
    const lastBrace = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'))
    if (lastBrace > 0) return JSON.parse(candidate.slice(0, lastBrace + 1))
    throw new Error(`模型返回的 JSON 无法解析：${candidate.slice(0, 200)}`)
  }
}
