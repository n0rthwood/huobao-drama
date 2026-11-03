/**
 * 「按史料画像补充外貌」（Issue #32 A4/B4）
 *
 * 史料画像（archival_images）只是档案，生图链路一个字都读不到；真正进提示词的是
 * characters.appearance。这里把画像读成可画的外貌文字：优先把图片真的发给一个
 * 能看图的文本模型（vision-capability 探测得到），拿不到看图能力时退化为纯文字
 * （Commons 元数据 + 维基条目正文）。
 *
 * 三条硬约束：
 * 1. 绝不写 reference_images / archival_images —— 角色一旦有 reference_images 就会走
 *    image_edit（generation.ts），三视图定妆格式会被画像的构图顶掉。
 * 2. appearance 里绝不留 URL / 域名 /「据维基百科」/「[1]」等来源标注，否则会顺着
 *    final_prompt 污染生图；出处只进 research_citations。
 * 3. 外貌按「故事年份的样子」写，不写服装/配饰（那是 styling）、不写背景。
 *
 * 异步执行沿用文本任务机制（sys_task type=text，kind=portrait_appearance），
 * 状态接口直接读最近一次任务的 params，不新增表。
 */
import { and, desc, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { getConfigById, getTextConfig, type AIConfig } from './ai.js'
import { callTextChat, imageContentPart, type ChatContent, type ChatEndpointConfig } from './vision-chat.js'
import { listArchivalImages, type ArchivalImageEntry } from './archival-images.js'
import { linkCitationsToAsset, recordCitation } from './research-citations.js'
import { wikiExtract, wikiSearch } from './wiki-research.js'
import { resolveVisionTextConfig, type VisionTextConfig } from './vision-capability.js'
import {
  createTextTask,
  findActiveTextTask,
  finishTextTask,
  parseTextTaskParams,
  patchTextTaskParams,
  textTaskKindOf,
  textTaskOutcome,
} from './text-task.js'

/** 送进模型的画像张数上限：两张（通常是正面肖像 + 另一个年龄/角度）已经够定特征，再多只是噪声与 token */
const MAX_VISION_PORTRAITS = 2
const PORTRAIT_IMAGE_MAX_EDGE = 1024
const PORTRAIT_IMAGE_QUALITY = 82
/** 读图推理比纯文本慢，给足 3 分钟；超时按失败记录，不卡住任务行 */
const PORTRAIT_REQUEST_TIMEOUT_MS = 180_000
const WIKI_TEXT_MAX_CHARS = 4000
/** 剧本只为判断故事年份，节选够用；整本送进去会挤掉史料文字 */
const SCRIPT_EXCERPT_MAX_CHARS = 3000

export type PortraitAppearanceSource = 'vision' | 'text'

/** 模型必须返回的可画特征；字段顺序即 appearance 的拼装顺序 */
export interface PortraitTraits {
  face_shape?: string
  hair?: string
  facial_hair?: string
  build?: string
  age_at_story?: string
  distinguishing?: string
}

const TRAIT_ORDER: Array<keyof PortraitTraits> = [
  'face_shape', 'hair', 'facial_hair', 'build', 'age_at_story', 'distinguishing',
]

export interface StartPortraitAppearanceResult {
  started: boolean
  /** 未启动的原因，由路由翻译成 400 文案 */
  reason?: 'no_portrait' | 'running'
  taskId?: number
  vision: { used: boolean; config_name?: string; model?: string }
  portraits: number
}

export interface PortraitAppearanceStatus {
  status: 'running' | 'done' | 'error' | null
  source: PortraitAppearanceSource | null
  model: string | null
  appearance: string | null
  error: string | null
  updated_at: string | null
}

// ========== 纯函数（可单测） ==========

/** 行首/行尾的 ```json 围栏与散落的反引号 */
const FENCE = /```[a-z]*\s*|```/gi

/**
 * 模型返回 → 特征对象。模型常把 JSON 裹在 ```json 围栏或一段解释文字里，
 * 所以先剥围栏，再截第一个 `{` 到最后一个 `}`。解析不出对象就抛错让任务显式失败——
 * 宁可报错重跑，也不能把半截文字写进 appearance。
 */
export function parseTraitJson(raw: string): PortraitTraits {
  const text = String(raw || '').replace(FENCE, '').trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型没有返回 JSON 外貌字段')
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    throw new Error('模型返回的外貌 JSON 无法解析')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('模型返回的外貌 JSON 不是对象')
  }
  const record = parsed as Record<string, unknown>
  const traits: PortraitTraits = {}
  for (const key of TRAIT_ORDER) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) traits[key] = value.trim()
  }
  if (!TRAIT_ORDER.some(key => traits[key])) throw new Error('模型返回的外貌 JSON 没有任何可用特征')
  return traits
}

/** 来源标注关键词：整段出现这些词时按「标注」清掉，不留半句 */
const SOURCE_PREFIX = /(?:据|依据|根据|引自|参见|详见|资料来源|来源|出处)\s*[「“"'《]?(?:维基百科|维基|维基共享资源|Wikipedia|Wikimedia|Commons|百科)[」”"'》]?(?:记载|所述|资料|条目)?\s*[，,：:]?/gi
const SOURCE_CLAUSE = /[（(]?\s*(?:参见|详见|资料来源|来源|出处)\s*[：:][^，。；\n)）]*[）)]?/g
const URL_PATTERN = /https?:\/\/\S+|\bwww\.[^\s，。；]+/gi
const BARE_DOMAIN = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|cn|io|edu|gov|info|wiki|jp|ru|de|fr|uk)\b(?:\/\S*)?/gi
const FOOTNOTE = /[\[【]\s*\d{1,3}\s*[\]】]/g

/**
 * 清除来源标注（Fabel 第 11 点）：URL、裸域名、脚注号、「据维基百科」类前缀。
 * 这是 appearance 落库前的最后一道闸——出处只允许存在于 research_citations。
 */
export function stripSourceMarkers(text: string): string {
  return String(text || '')
    .replace(FOOTNOTE, '')
    .replace(URL_PATTERN, '')
    .replace(SOURCE_CLAUSE, '')
    .replace(SOURCE_PREFIX, '')
    .replace(BARE_DOMAIN, '')
    .replace(/[（(]\s*[）)]/g, '')
    .replace(/[，,；;]{2,}/g, '，')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s，,；;：:。.]+/, '')
    .replace(/[\s，,；;：:]+$/, '')
    .trim()
}

/**
 * 特征 → 一段 appearance。固定字段顺序保证同一张画像重复跑出的文字结构稳定；
 * 空字段直接跳过（模型答不出髭形时不该出现空壳短语）。
 */
export function composeAppearance(traits: PortraitTraits): string {
  const parts = TRAIT_ORDER
    .map(key => stripSourceMarkers(traits[key] || ''))
    .map(part => part.replace(/[。.]+$/, '').trim())
    .filter(Boolean)
  if (!parts.length) return ''
  return `${parts.join('，')}。`
}

// ========== 文本依据 ==========

/** Commons 元数据（标题/作者/年代/许可证/来源页）——纯文本与看图两条路都要带 */
function portraitMetaText(entries: ArchivalImageEntry[]): string {
  return entries.map((entry, index) => [
    `画像${index + 1}：${entry.file_title}`,
    entry.artist ? `作者：${entry.artist}` : '',
    entry.work_date ? `创作年代：${entry.work_date}` : '',
    entry.license ? `许可证：${entry.license}` : '',
    // 来源页进「依据」是安全的：只有模型产出与 appearance 必须无来源标注，输入可以带
    entry.source_page_url ? `来源页：${entry.source_page_url}` : '',
  ].filter(Boolean).join('；')).join('\n')
}

interface WikiBasis {
  text: string
  articles: Array<{ title: string; source_url: string; lang: string }>
}

/**
 * 维基条目正文（zh 优先，失败退 en）。联网失败是常态（无外网/被限流），
 * 这里一律静默降级为「只有剧本 + Commons 元数据」，不让整个任务失败。
 */
async function fetchWikiBasis(name: string): Promise<WikiBasis> {
  for (const lang of ['zh', 'en'] as const) {
    try {
      const hits = await wikiSearch(name, lang, 1)
      const title = hits[0]?.title
      if (!title) continue
      const article = await wikiExtract(title, lang)
      if (!article.text) continue
      return {
        text: article.text.slice(0, WIKI_TEXT_MAX_CHARS),
        articles: [{ title: article.title, source_url: article.source_url, lang }],
      }
    } catch {
      // 该语种不可用就试下一个；全失败时返回空依据
    }
  }
  return { text: '', articles: [] }
}

// ========== 模型调用 ==========

const SYSTEM_PROMPT = [
  '你是历史纪录片的人物造型顾问。依据史料画像与史料文字，写出该人物在【故事年份】时的可画外貌。',
  '只写静态可见的面部与体貌特征：脸型、发型（若是时代假发，写明是假发及其形制）、髭须、身材、年龄感、辨识性特征。',
  '不写服装、配饰、勋章、冠冕（那是造型字段）；不写背景、环境、情绪、动作；不写画作风格或画家笔法。',
  // 实测缺陷（彼得一世第 1 次）：半身像里看不出身高，模型按画面比例写了「中等偏高」，
  // 而史料文字明写他身高逾两米——身高体格必须只认文字。
  '`build`（身材体格，含身高）**只能**取自史料文字里的明确记载；画像是半身/胸像时看不出身高，一律不得据画面推断。文字没有记载就留空。',
  // 实测缺陷：「左颊或右颊有痣」这种两可写法进了提示词就是让生图模型自己掷骰子。
  '不许写两可与推测：禁止出现「或」「可能」「似乎」「大约」「疑似」这类词；拿不准的特征直接留空，不要给备选项。',
  '`age_at_story` 写成确定的岁数（故事年份减出生年），例如「47 岁」；算不出就留空，不要写「四十余岁」之类的模糊区间。',
  '绝对不要出现任何网址、域名、「据维基百科」「资料来源」「参见」「[1]」之类的来源标注。',
  '每个字段一个简短中文短语（不超过 20 字），没有依据的字段留空字符串，不要编造。',
  '只输出 JSON，不要任何解释文字：',
  '{"face_shape":"","hair":"","facial_hair":"","build":"","age_at_story":"","distinguishing":"","confidence_notes":""}',
].join('\n')

/** 请求组装与发送已抽到 services/vision-chat.ts（#46），这里只保留本任务的参数口径 */
async function callChat(
  config: ChatEndpointConfig,
  content: ChatContent,
): Promise<string> {
  const { text } = await callTextChat(config, content, {
    systemPrompt: SYSTEM_PROMPT,
    temperature: 0.2,
    maxTokens: 1024,
    timeoutMs: PORTRAIT_REQUEST_TIMEOUT_MS,
  })
  return text
}

/** 用户消息正文：人物设定 + 本集剧本节选（故事年份线索） + 画像元数据 + 维基正文 */
function buildUserText(input: {
  name: string
  role: string | null
  description: string | null
  dramaTitle: string
  dramaGenre: string | null
  episodeTitle: string
  episodeDescription: string | null
  scriptExcerpt: string
  portraitMeta: string
  wikiText: string
  withImages: boolean
}): string {
  const lines = [
    `人物：${input.name}`,
    input.role ? `身份：${input.role}` : '',
    input.description ? `剧本设定：${input.description}` : '',
    `作品：${input.dramaTitle}${input.dramaGenre ? `（${input.dramaGenre}）` : ''}`,
    `本集：${input.episodeTitle}${input.episodeDescription ? `——${input.episodeDescription}` : ''}`,
    '',
    // 故事年份的唯一可靠来源就是剧本本身，节选必须进依据
    input.scriptExcerpt ? `本集剧本节选（判断故事年份用）：\n${input.scriptExcerpt}` : '',
    '',
    '史料画像元数据：',
    input.portraitMeta || '（无）',
    '',
    input.wikiText ? `史料文字：\n${input.wikiText}` : '史料文字：（本次只有剧本与画像元数据）',
    '',
    input.withImages
      ? '附上的图片就是上述史料画像。画像创作年代可能与故事年份不同：请以故事年份为准推断当时的样貌，若两者不同，按年龄差调整（例如画像晚于故事年份则相应减龄）。'
      : '本次没有图片可读，只能依据上述文字推断故事年份时的样貌。',
    '故事年份请从剧本节选与本集信息中判断；判断不出时按人物在该历史事件中的年龄写。',
  ]
  return lines.join('\n')
}

// ========== 任务入口 ==========

/**
 * 启动「按史料画像补充外貌」。看图配置在返回前就探测好并回传，
 * 让界面能先告诉用户「这次由哪个模型读画像」还是「只能按文字推断」。
 */
export async function startPortraitAppearance(
  characterId: number,
  opts: { episodeId: number; configId?: number },
): Promise<StartPortraitAppearanceResult> {
  const { episodeId } = opts
  const [character] = await db.select().from(schema.characters).where(eq(schema.characters.id, characterId))
  if (!character) return { started: false, reason: 'no_portrait', vision: { used: false }, portraits: 0 }

  const portraits = await listArchivalImages(characterId)
  if (!portraits.length) return { started: false, reason: 'no_portrait', vision: { used: false }, portraits: 0 }
  if (await findActiveTextTask(episodeId, 'portrait_appearance')) {
    return { started: false, reason: 'running', vision: { used: false }, portraits: portraits.length }
  }

  const vision = await resolveVisionTextConfig(opts.configId)
  // 没有能看图的配置时才退回纯文本：指定配置优先，否则用当前启用的文本模型
  const fallback = vision ? null : (opts.configId ? await getConfigById(opts.configId) : null) ?? await getTextConfig()
  const used: { provider: string; model: string } = vision ?? (fallback as AIConfig)

  const taskId = await createTextTask({
    kind: 'portrait_appearance',
    episodeId,
    dramaId: character.dramaId,
    prompt: `按史料画像补充「${character.name}」的外貌`,
    provider: used.provider || null,
    model: used.model || null,
    configId: vision ? vision.configId : (fallback?.id ?? opts.configId ?? undefined),
  })
  // 任务行按「集」落库，角色 id 必须进 params：状态接口要据此只回本角色的那次任务
  await patchTextTaskParams(taskId, {
    character_id: characterId,
    portrait_source: vision ? 'vision' : 'text',
  })

  logTaskStart('Portrait', 'appearance-from-portrait', {
    characterId, episodeId, name: character.name,
    portraits: portraits.length, vision: !!vision, model: used.model,
  })

  void runPortraitAppearance(taskId, {
    character,
    episodeId,
    portraits,
    vision,
    textConfig: vision ? null : (fallback as AIConfig),
  })

  return {
    started: true,
    taskId,
    vision: vision ? { used: true, config_name: vision.name, model: vision.model } : { used: false },
    portraits: portraits.length,
  }
}

async function runPortraitAppearance(taskId: number, ctx: {
  character: typeof schema.characters.$inferSelect
  episodeId: number
  portraits: ArchivalImageEntry[]
  vision: VisionTextConfig | null
  textConfig: AIConfig | null
}): Promise<void> {
  const { character, episodeId, portraits, vision } = ctx
  try {
    const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
    const [drama] = await db.select().from(schema.dramas).where(eq(schema.dramas.id, character.dramaId))
    const wiki = await fetchWikiBasis(character.name)
    logTaskProgress('Portrait', 'basis-ready', {
      characterId: character.id, wiki: wiki.articles.length, portraits: portraits.length,
    })

    const userText = buildUserText({
      name: character.name,
      role: character.role,
      description: character.description,
      dramaTitle: drama?.title || '',
      dramaGenre: drama?.genre || null,
      episodeTitle: episode?.title || '',
      episodeDescription: episode?.description || null,
      scriptExcerpt: (episode?.scriptContent || episode?.content || '').slice(0, SCRIPT_EXCERPT_MAX_CHARS),
      portraitMeta: portraitMetaText(portraits),
      wikiText: wiki.text,
      withImages: !!vision,
    })

    let content: ChatContent = userText
    if (vision) {
      const images: Array<Record<string, unknown>> = []
      for (const entry of portraits.slice(0, MAX_VISION_PORTRAITS)) {
        try {
          const prepared = await imageContentPart(entry.path, {
            maxSide: PORTRAIT_IMAGE_MAX_EDGE,
            quality: PORTRAIT_IMAGE_QUALITY,
          })
          images.push(prepared.part)
        } catch (err) {
          // 文件丢了就少读一张，不整单失败
          logTaskProgress('Portrait', 'portrait-unreadable', {
            characterId: character.id, path: entry.path,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      content = [{ type: 'text', text: userText }, ...images]
    }

    const config = vision ?? ctx.textConfig
    if (!config) throw new Error('未配置可用的文本模型')
    const raw = await callChat({
      baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model, provider: config.provider,
    }, content)
    const appearance = composeAppearance(parseTraitJson(raw))
    if (!appearance) throw new Error('模型没有给出可用的外貌特征')

    // 外貌变了，旧的最终提示词就失效（与 asset-reextract 同语义）；绝不碰 reference_images
    await db.update(schema.characters)
      .set({
        appearance,
        finalPrompt: null,
        finalPromptSource: null,
        finalPromptUpdatedAt: null,
        updatedAt: now(),
      })
      .where(eq(schema.characters.id, character.id))

    await recordProvenance(character, episodeId, portraits, wiki, !!vision)
    await patchTextTaskParams(taskId, { portrait_source: vision ? 'vision' : 'text', portrait_appearance: appearance })
    await finishTextTask(taskId, 'completed', { outputText: appearance })
    logTaskSuccess('Portrait', 'appearance-from-portrait', {
      characterId: character.id, source: vision ? 'vision' : 'text', chars: appearance.length,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logTaskError('Portrait', 'appearance-from-portrait', { characterId: character.id, error: message })
    await finishTextTask(taskId, 'failed', { errorMsg: message })
  }
}

/** 出处只进 research_citations：每张画像的 Commons 来源页一条，实际读到的维基条目一条 */
async function recordProvenance(
  character: typeof schema.characters.$inferSelect,
  episodeId: number,
  portraits: ArchivalImageEntry[],
  wiki: WikiBasis,
  visionUsed: boolean,
): Promise<void> {
  for (const entry of portraits) {
    await recordCitation({
      dramaId: character.dramaId,
      episodeId,
      assetKind: 'character',
      assetName: character.name,
      tool: 'portrait_appearance',
      query: character.name,
      title: entry.file_title,
      sourceUrl: entry.source_page_url,
      lang: null,
      snippet: [entry.artist, entry.work_date, entry.license].filter(Boolean).join('；')
        + (visionUsed ? '（本次由模型读图）' : '（本次仅用元数据）'),
      status: 'ok',
    })
  }
  for (const article of wiki.articles) {
    await recordCitation({
      dramaId: character.dramaId,
      episodeId,
      assetKind: 'character',
      assetName: character.name,
      tool: 'portrait_appearance',
      query: character.name,
      title: article.title,
      sourceUrl: article.source_url,
      lang: article.lang,
      snippet: '外貌推断所用条目正文',
      status: 'ok',
    })
  }
  await linkCitationsToAsset(episodeId, 'character', character.name, character.id)
}

/**
 * 状态接口：该角色最近一次 portrait_appearance 任务（给了集号就限定在该集）。
 * sys_task 行按「集」落库，同一集里不同角色各有各的任务行，必须按 params.character_id
 * 过滤——否则会把别的角色的模型/外貌回给当前角色。进行中的那条优先。
 */
export async function getPortraitAppearanceStatus(
  characterId: number,
  episodeId: number | null,
): Promise<PortraitAppearanceStatus> {
  const where = episodeId
    ? and(eq(schema.sysTask.type, 'text'), eq(schema.sysTask.episodeId, episodeId))
    : eq(schema.sysTask.type, 'text')
  const rows = (await db.select().from(schema.sysTask)
    .where(where)
    .orderBy(desc(schema.sysTask.id))
  ).filter(r => textTaskKindOf(r) === 'portrait_appearance'
    && parseTextTaskParams(r.params)?.character_id === characterId)

  const row = rows.find(r => textTaskOutcome(r.status) === 'running') ?? rows[0]
  if (!row) return { status: null, source: null, model: null, appearance: null, error: null, updated_at: null }

  const params: Record<string, unknown> = parseTextTaskParams(row.params) || {}
  const source = params.portrait_source === 'vision' || params.portrait_source === 'text'
    ? params.portrait_source as PortraitAppearanceSource
    : null
  const status = textTaskOutcome(row.status)
  const appearance = status === 'done' && typeof params.portrait_appearance === 'string'
    ? params.portrait_appearance
    : null

  return {
    status,
    source,
    model: row.model ?? null,
    appearance,
    error: row.errorMsg ?? null,
    updated_at: row.updatedAt ?? null,
  }
}
