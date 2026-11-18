/**
 * 流水线 AI 环节的提示词（Issue #56；事实表输入改为真实检索结果见 #79，检索计划/筛选提示词在 services/asset-research/run.ts）
 *
 * 为什么内联而不挂技能目录：这三步是直接 `callTextChat`，不是 Agent 运行，
 * `AGENT_SKILL_MAP` 不会注入技能（与 `asset-semantics-auto.ts` 同口径）。
 *
 * 关键约束写死在提示词里，不靠运行时纠正：
 * - 事实表每条必须带 `metric`（闸门禁用 `minor` 的依据）与年代约束；
 * - 出图提示词禁的是**额外加上去的**标注（`no added labels/captions/legend/watermark/signage`），
 *   器物本身的铭文/刻字要保留（画面文字是否判 FAIL 只看 `text_in_image.overlay`）；
 * - QC 只许按清单逐条给 `verdict/detected/evidence`，不得自创 tolerance、不得改清单。
 */
import type { AssetSpecRow, AssetSourceRow } from './store.js'

export const SPEC_SYSTEM = `你是纪录片美术组的考据负责人。把检索到的资料整理成一张**可逐条机检**的事实表，用于约束出图与质检。
目标是「尽量贴近史料、给观众一个准确的概念」：资料充分时照资料写；资料不足时给出最合理的示意要求并在 uncertainties 里说明，不要因为缺资料就留空，也绝不编造出处。
严格要求：
1. must_have 5–9 条，每条给 {id, element, why, check, metric}。
   - metric 只能是 count / arrangement / color / shape / other；
   - **可数的数量、排列方式、颜色**必须分别标 count / arrangement / color（这三类之后不允许「轻微不符」）；
   - check 必须是**看图就能逐条核对**的动作，不能是「整体氛围到位」这种无法核验的话；
   - 尺寸、比例必须写清**测量对象**（如「正视印面的长:宽」而不是整张图的比例），资料里有尺寸就按资料换算；
   - why 必须写依据：引用下面给出的文字资料标题或图像资料标题；没有资料依据时写「示意：依据<常识/用户描述>」。
2. forbidden 3–8 条，每条给 {id, error, why}：写明「它不是什么」——易混淆的对象、年代错位、形制错误、用户描述里与资料冲突的细节。
3. tolerances 是**允许的差异白名单**（自然语言整句）。质检只能引用这里的原句，不能自创。
4. uncertainties 写明学术上无定论、资料缺失、只能示意的点（如带文字的器物查不到逐字原文时，写明文字是示意）。
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
5. text_in_image 必须给 {present: true/false, overlay: true/false, evidence}：
   - present：画面上有没有任何可辨认的文字、字母、数字（含器物本身的铭文、印文、刻字、钱币文字）。
   - overlay：这些文字里**有没有生成器额外加上去的**标注/图例/说明/字幕/水印/招牌——即不属于被画物体本身的文字。
     只有 overlay=true 才算问题；器物本身的铭文只记 present=true、overlay=false。
   - evidence 写清文字在画面哪里、写的是什么、你判断它属于物体本身还是额外添加。
6. locate 只在给了定位目标时回答：每个目标给 {id, name, at:[x,y]}，x/y 是**归一化到 0–1** 的画面坐标（左上角为原点）。看不到就给 at:null。
7. fidelity_score / beauty_score 一律给 **0–100 的整数**（不要用 0–1 的小数）：前者是对事实表的还原度，后者是画面质感。
只返回 JSON，不要 Markdown 代码块：
{"must_have":[{"id":"","verdict":"ok","evidence":""}],"forbidden":[{"id":"","detected":false,"evidence":""}],"text_in_image":{"present":false,"overlay":false,"evidence":""},"locate":[],"fidelity_score":0,"beauty_score":0,"suggestions":[""],"overall":"pass"}`

const SPEC_TEXT_BUDGET = 24_000

/** 把检索结果整理成事实表的输入：文字摘录 + 视觉判断过的图像资料；#79 之前冻结的旧线索原样附 JSON */
function researchSection(research: unknown): string {
  const r = (research && typeof research === 'object' ? research : {}) as {
    texts?: Array<{ title: string; url: string | null; excerpt: string }>
    candidates?: Array<{ title: string; institution: string; date: string; license: string; role: string; depicts: string; what_it_proves: string[]; cautions: string[] }>
  }
  if (!Array.isArray(r.texts) && !Array.isArray(r.candidates)) return `资料研究结论（JSON）：\n${JSON.stringify(research ?? {})}`
  const texts = r.texts ?? []
  const perText = Math.floor(SPEC_TEXT_BUDGET / Math.max(1, texts.length))
  const images = (r.candidates ?? []).filter(c => c.role !== 'reject')
  return [
    '检索到的文字资料：',
    texts.length ? texts.map(t => `【${t.title}】${t.url ? `（${t.url}）` : ''}\n${t.excerpt.slice(0, perText)}`).join('\n\n') : '（无）',
    '检索到并经视觉判断的图像资料：',
    images.length
      ? images.map(c => `- 【${c.title}】${c.institution}｜${c.date || '年代未注明'}｜许可 ${c.license || '未注明'}｜判断 ${c.role}｜图上是：${c.depicts}｜能证明：${c.what_it_proves.join('；') || '—'}｜注意：${c.cautions.join('；') || '—'}`).join('\n')
      : '（无）',
  ].join('\n')
}

export function specUserPrompt(input: {
  assetKind: string
  name: string
  description: string | null
  research: unknown
  sources: AssetSourceRow[]
}): string {
  const usable = input.sources.filter(s => s.role !== 'rejected')
  const rejected = input.sources.filter(s => s.role === 'rejected')
  return [
    `资产类型：${input.assetKind}`,
    `名称：${input.name}`,
    `用户描述：${input.description || '（无）'}（用户描述可能有错，与资料冲突时以资料为准，并把冲突写进 forbidden）`,
    researchSection(input.research),
    '已入库素材（会作为生成参考或形制参考）：',
    usable.length
      ? usable.map(s => `- ${s.title || s.url || s.local_path}｜角色 ${s.role}｜年代 ${s.era || '未注明'}｜许可 ${s.license}`).join('\n')
      : '（无可用素材，事实表必须据文字资料写，并在 uncertainties 里说明缺少图像佐证）',
    rejected.length ? `已排除素材：${rejected.map(s => `${s.title || s.url}（${s.why_excluded || '未注明理由'}）`).join('；')}` : '',
  ].filter(Boolean).join('\n')
}

/** 出图提示词：事实表 → 英文描述；只禁额外添加的标注，器物自带的铭文照留 */
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
    // 地名/图例/说明走图层体系，不进底图；但器物自身的铭文属于形制，不能让模型抹掉
    'no added labels, no captions, no legend, no watermark, no signage; keep any inscriptions or markings that are part of the object itself',
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
