/**
 * MiniMax-H3 提示词契约（质量关键）
 *
 * 引擎逐字分词，模型按官方英文三段式训练；裸中文/任意文本会导致画面发糊、像没生成完。
 * 移植自 175 vidgen-studio 的 prompt_format.py（最终文本渲染）与 glm.py（官方指南扩写）。
 *
 * 最终文本布局：
 *   [首尾帧对齐声明]
 *
 *   integrated_multimodal_description: ...
 *
 *   overall_soundscape: ...
 *
 *   non_diegetic_music: ...
 */
import { getTextConfig, getTextProviderBaseUrl } from '../ai.js'

export type H3Mode = 't2v' | 'firstlast' | 'reference'

export const H3_FPS = 24
const DESCRIPTION_KEY = 'integrated_multimodal_description'
const REQUIRED_KEYS = [DESCRIPTION_KEY, 'overall_soundscape', 'non_diegetic_music'] as const

interface H3PromptObject {
  integrated_multimodal_description: string
  overall_soundscape: string
  non_diegetic_music: string
}

const H3_GUIDE = `
你为 MiniMax-H3(视频+原生音频联合生成模型)撰写提示词,必须遵循以下官方规范:
【整体结构】三键 JSON:
- integrated_multimodal_description: 完整时间线。以 [Shot 1] 开场,第一句定风格与构图
  (Live-action cinematic / 2D-animated / 3D CG / documentary realism 等);后续镜头写
  [Shot N] At MM:SS.mmm, the camera cuts to ...(时间严格递增且必须落在总时长内;[Shot 1] 不带时间戳)。
- overall_soundscape: 整段环境声/动效/非语言人声(1-4 句;不写对白与画面内音乐)。
- non_diegetic_music: 仅观众能听到的配乐,写乐器/节奏/动态,不写抽象情绪;无配乐写 "N/A"。
【画面内容】一切描述必须可拍摄或可听见;禁止 "cinematic/beautiful/epic" 这类空洞形容词堆砌。
【运镜语法】用自然英语写"类型+幅度+速度":
  The camera pushes in with small amplitude at slow speed toward ...
  可用类型:zoom in/out, push in/pull out, pan/truck left/right, tilt up/down,
  pedestal, arc, tracking, static, shake slightly/strongly, POV, roll cw/ccw。
  仅距离/角度变化时优先用运动而非剪辑。
【对白与文字】说话人稳定命名 (S1)(S2),联合说话写 (S1,S2);台词:
  <d>[中文] 原文</d> 保留原语言与标点;画外音: says in an off-screen voiceover 且人物不张嘴;
  画面内文字用英文双引号包裹原拼写。
【图像模式对齐】视频有首帧/尾帧图时,第一行(描述字段开头)写对齐声明:
  I2VA: For the target video, at 0.00 seconds, <Picture 1> is fully referenced.
  FL2VA: 说明 Picture 1 对齐 0.00 秒、Picture 2 对齐结尾时间点,并描述两帧之间的完整变化过程。
【参考图模式】主体形象由 <Picture 1> <Picture 2> 按序指代;明确各参考的保留程度
(fully preserved / partially preserved / attribute transfer);严禁发明参考图中不存在的结构。
`

const BASE_SYSTEM =
  '你是 MiniMax-H3 视频(含原生音频)生成模型的提示词工程师。' +
  '把用户的简短描述(可能是中文)扩写成符合下述官方规范的英文提示词。' +
  '只输出一个严格的 JSON 对象,恰好三个键:' +
  '"integrated_multimodal_description"、"overall_soundscape"、"non_diegetic_music"。\n' +
  '不要输出 JSON 以外的任何内容。\n' + H3_GUIDE

const MODE_EXTRA: Record<H3Mode, string> = {
  t2v: '',
  firstlast:
    '\n本任务为首/尾帧模式:视频从给定首帧开始(可选结束于尾帧)。' +
    '在描述字段开头写对齐声明,重点描述两帧之间的运动过程与过渡,保持人物/服装/空间一致。',
  reference:
    '\n本任务为参考图模式:用 <Picture N> 按上传顺序指代参考图并据此描述主体,' +
    '声明保留程度,严禁发明参考图中不存在的结构或部件。',
}

/** 参考图 + 首帧引导（尾帧承接）时追加给 LLM 的约束：开头是上一镜结尾的连续画面 */
const REFERENCE_CONTINUITY_EXTRA =
  '\n本镜还带有首帧引导:画面从上一镜的最后一帧无缝继续——不要重新交代空间,不要以切镜开场。' +
  '[Shot 1] 必须以 "The shot continues seamlessly from the previous moment" 开头。' +
  '<Picture N> 编号只指代参考图,不包含引导帧。'

/** 引擎把帧数吸附到 17k+5 网格，返回实际时长（秒） */
export function effectiveDuration(durationS: number): number {
  const n = Math.max(5, Math.round(durationS * H3_FPS))
  return (n + (((5 - (n % 17)) % 17) + 17) % 17) / H3_FPS
}

/** 对齐声明由代码生成，不交给 LLM */
function alignmentLine(mode: H3Mode, eff: number, hasFirst: boolean, hasLast: boolean): string {
  const end = eff.toFixed(2)
  if (mode === 'reference') {
    // 引导帧不占 Picture 编号，声明按"锚定帧"书写
    const lines: string[] = []
    if (hasFirst) {
      lines.push('For the target video, at 0.00 seconds the video starts exactly from the anchored first-frame guide, ' +
        'which is the final frame of the previous shot (same characters, poses, framing and lighting).')
    }
    if (hasLast) {
      lines.push(`At the ${end}-second mark the video ends exactly on the anchored last-frame guide.`)
    }
    return lines.join(' ')
  }
  if (mode !== 'firstlast') return ''
  if (hasFirst && hasLast) {
    return 'How the reference pictures align with the target video — ' +
      'Picture 1 aligns with the 0.00-second mark of the target video; ' +
      `Picture 2 aligns with the ${end}-second mark of the target video.`
  }
  if (hasFirst) {
    return 'For the target video, at 0.00 seconds into the target video, <Picture 1> is fully referenced.'
  }
  if (hasLast) {
    return 'How the reference pictures align with the target video — ' +
      `<Picture 1> aligns with the ${end}-second mark of the target video.`
  }
  return ''
}

export function renderFinalPrompt(
  obj: H3PromptObject,
  mode: H3Mode,
  durationS: number,
  hasFirst: boolean,
  hasLast: boolean,
): string {
  const parts: string[] = []
  const align = alignmentLine(mode, effectiveDuration(durationS), hasFirst, hasLast)
  if (align) parts.push(align)
  parts.push(`${DESCRIPTION_KEY}: ${obj.integrated_multimodal_description}`)
  parts.push(`overall_soundscape: ${obj.overall_soundscape || 'N/A'}`)
  parts.push(`non_diegetic_music: ${obj.non_diegetic_music || 'N/A'}`)
  return parts.join('\n\n')
}

/** 解析 LLM 输出的三键 JSON（容忍 ```json 围栏） */
function parsePromptObject(content: string): H3PromptObject {
  const cleaned = content.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')
  const parsed: unknown = JSON.parse(cleaned)
  if (!parsed || typeof parsed !== 'object') throw new Error('输出不是 JSON 对象')
  const record = parsed as Record<string, unknown>
  for (const key of REQUIRED_KEYS) {
    if (typeof record[key] !== 'string') throw new Error(`缺少键 ${key}`)
  }
  return {
    integrated_multimodal_description: record[DESCRIPTION_KEY] as string,
    overall_soundscape: record.overall_soundscape as string,
    non_diegetic_music: record.non_diegetic_music as string,
  }
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>
}

/** 用当前启用的文本模型（OpenAI 兼容）把用户描述扩写成 H3 三键提示词 */
async function expandWithTextModel(
  mode: H3Mode,
  userText: string,
  effDuration: number,
  hasFirst: boolean,
): Promise<H3PromptObject> {
  const text = await getTextConfig()
  if (text.provider.toLowerCase() === 'gemini') {
    throw new Error('H3 提示词扩写需要 OpenAI 兼容的文本服务（当前启用的是 gemini）')
  }
  const url = `${getTextProviderBaseUrl(text)}/chat/completions`
  const continuityExtra = mode === 'reference' && hasFirst ? REFERENCE_CONTINUITY_EXTRA : ''
  const baseSystem = `${BASE_SYSTEM}${MODE_EXTRA[mode]}${continuityExtra}` +
    `\n本视频总时长为 ${effDuration.toFixed(2)} 秒(对齐后的有效时长):` +
    `所有镜头切换时间戳必须严格递增且落在 0–${effDuration.toFixed(2)} 秒内。`

  const errors: string[] = []
  for (const compact of [false, true]) {
    try {
      const system = compact ? `${baseSystem}\n第二次尝试:更紧凑,整体控制在 120 个英文词以内。` : baseSystem
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${text.apiKey}` },
        body: JSON.stringify({
          model: text.model,
          temperature: 0.7,
          max_tokens: 16384,
          messages: [{ role: 'system', content: system }, { role: 'user', content: userText }],
        }),
        signal: AbortSignal.timeout(300_000),
      })
      if (!resp.ok) throw new Error(`文本服务 ${resp.status}: ${(await resp.text()).slice(0, 300)}`)
      const data = (await resp.json()) as ChatCompletionResponse
      const choice = data.choices?.[0]
      if (choice?.finish_reason === 'length') throw new Error('输出被截断(finish_reason=length)')
      return parsePromptObject(choice?.message?.content ?? '')
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
    }
  }
  throw new Error(`H3 提示词扩写失败: ${errors.join(' | ')}`)
}

/**
 * 得到可直接送入 H3 的最终提示词。
 * 已是契约格式（含 integrated_multimodal_description:）的原样使用；否则扩写后渲染。
 * 扩写失败直接抛错，不回退为裸提示词（那正是画面发糊的原因）。
 */
export async function buildH3Prompt(
  userPrompt: string,
  mode: H3Mode,
  durationS: number,
  hasFirst: boolean,
  hasLast: boolean,
): Promise<string> {
  const prompt = userPrompt.trim()
  if (prompt.includes(`${DESCRIPTION_KEY}:`)) {
    // 已是契约格式：仍补上代码生成的对齐声明（首/尾帧或引导帧），已包含则不重复
    const align = alignmentLine(mode, effectiveDuration(durationS), hasFirst, hasLast)
    return align && !prompt.includes(align) ? `${align}\n\n${prompt}` : prompt
  }
  const obj = await expandWithTextModel(mode, prompt, effectiveDuration(durationS), hasFirst)
  return renderFinalPrompt(obj, mode, durationS, hasFirst, hasLast)
}
