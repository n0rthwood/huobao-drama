/**
 * Drizzle schema - SQLite column mappings.
 * 自 MySQL 迁移：varchar(x)→text（SQLite 不校验长度）、int→integer、
 * boolean→integer boolean mode、时间戳仍为 text 存 ISO 字符串，表/列名不变。
 */
import { sqliteTable, text, integer, real, primaryKey } from 'drizzle-orm/sqlite-core'

export const dramas = sqliteTable('dramas', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  description: text('description'),
  genre: text('genre'),
  // 纪录片规则显式开关（Issue #32）：'auto'（跟随 genre 关键字）| 'on' | 'off'；NULL 等价 'auto'
  documentaryRules: text('documentary_rules'),
  style: text('style').default('3d'),
  aspectRatio: text('aspect_ratio').default('16:9'),
  totalEpisodes: integer('total_episodes').default(1),
  totalDuration: integer('total_duration').default(0),
  status: text('status').notNull().default('draft'),
  thumbnail: text('thumbnail'),
  tags: text('tags'),
  metadata: text('metadata'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

export const episodes = sqliteTable('episodes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dramaId: integer('drama_id').notNull(),
  episodeNumber: integer('episode_number').notNull(),
  title: text('title').notNull(),
  content: text('content'),
  scriptContent: text('script_content'),
  description: text('description'),
  duration: integer('duration').default(0),
  status: text('status').default('draft'),
  videoUrl: text('video_url'),
  thumbnail: text('thumbnail'),
  imageConfigId: integer('image_config_id'),
  videoConfigId: integer('video_config_id'),
  // 本集锁定的语音合成（TTS）服务配置（#30）
  ttsConfigId: integer('tts_config_id'),
  // 剧集级旁白开关（#30）：1 = 产出旁白文本 + 配音 + 合成时烧录字幕；0 = 现有流程完全不变
  narrationEnabled: integer('narration_enabled', { mode: 'boolean' }).notNull().default(false),
  // 整集旁白主线/分段大纲（#35）：旁白写作阶段 A 的产物，用户可在「音频旁白设置」里改
  narrationSpine: text('narration_spine'),
  // 文本规范化（#35）：1 = 把数字/日期按读法展开后再送 TTS（normalize），默认开
  narrationNormalize: integer('narration_normalize', { mode: 'boolean' }).notNull().default(true),
  // 本集配音参数（#37）：配音弹窗确定后保存的 {voice, inference_timesteps, cfg_value, seed, instructions}；NULL = 沿用 TTS 配置
  ttsSettings: text('tts_settings'),
  // 本集字幕时间码模式（#30 Q10）：sentence = 分句边界（默认），char = 逐字时间戳
  subtitleTiming: text('subtitle_timing').notNull().default('sentence'),
  // 模型自带音轨的处理（#31）：replace = 丢弃，mix = 压到低电平作底音
  audioMixMode: text('audio_mix_mode').notNull().default('replace'),
  // 混音模式下模型音轨的增益（dB，负值）；NULL = 取默认 -18
  audioBedGainDb: real('audio_bed_gain_db'),
  // 本集默认的旁白/画面匹配方式 JSON（#31），新镜头继承
  narrationFitDefault: text('narration_fit_default'),
  resolution: text('resolution').default('720p'),
  // 纪录片选角名册（Issue #32）：JSON [{name, basis, reason, source}]，人在集页面复核后保存
  characterRoster: text('character_roster'),
  // 名册复核时所依据的剧本指纹（sha256）：剧本改了就判定名册过期，必须重新复核
  characterRosterHash: text('character_roster_hash'),
  // 'draft' = 提取 Agent 首轮生成、待人复核；'approved' = 人已复核保存
  characterRosterStatus: text('character_roster_status'),
  characterRosterUpdatedAt: text('character_roster_updated_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

export const characters = sqliteTable('characters', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dramaId: integer('drama_id').notNull(),
  name: text('name').notNull(),
  role: text('role'),
  description: text('description'),
  appearance: text('appearance'),
  styling: text('styling'),
  finalPrompt: text('final_prompt'),
  // 最终提示词来源（Issue #32）：'agent' = 提示词 Agent 保存，'external' = 外部 PUT 直写
  finalPromptSource: text('final_prompt_source'),
  finalPromptUpdatedAt: text('final_prompt_updated_at'),
  // 史料参考画像（Issue #32，JSON 数组）：生图链路任何环节都不读，与 reference_images 严格分离
  archivalImages: text('archival_images'),
  personality: text('personality'),
  imageUrl: text('image_url'),
  referenceImages: text('reference_images'),
  seedValue: text('seed_value'),
  sortOrder: integer('sort_order'),
  localPath: text('local_path'),
  // 背景信息载体（Issue #47）：旁白提到但不出场、只作视觉承载的实体
  exposition: integer('exposition').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

// Episode-Character many-to-many
// styling_version：本集的角色造型版本（Issue #15，JSON {name, description, image_path}）；
// 只决定本集分镜默认选用哪张角色图，不覆盖 characters.styling / image_url 等基础形象字段。
export const episodeCharacters = sqliteTable('episode_characters', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id').notNull(),
  characterId: integer('character_id').notNull(),
  stylingVersion: text('styling_version'),
  createdAt: text('created_at').notNull(),
})

// Episode-Scene many-to-many
export const episodeScenes = sqliteTable('episode_scenes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id').notNull(),
  sceneId: integer('scene_id').notNull(),
  createdAt: text('created_at').notNull(),
})

// Episode-Prop many-to-many
export const episodeProps = sqliteTable('episode_props', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id').notNull(),
  propId: integer('prop_id').notNull(),
  createdAt: text('created_at').notNull(),
})

export const scenes = sqliteTable('scenes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dramaId: integer('drama_id').notNull(),
  episodeId: integer('episode_id'),
  location: text('location').notNull(),
  time: text('time').notNull(),
  prompt: text('prompt').notNull(),
  lighting: text('lighting'),
  finalPrompt: text('final_prompt'),
  finalPromptSource: text('final_prompt_source'),
  finalPromptUpdatedAt: text('final_prompt_updated_at'),
  storyboardCount: integer('storyboard_count').default(1),
  imageUrl: text('image_url'),
  referenceImages: text('reference_images'),
  status: text('status').default('pending'),
  localPath: text('local_path'),
  // 背景信息载体（Issue #47）：旁白提到但不出场、只作视觉承载的实体（如波尔塔瓦战场）
  exposition: integer('exposition').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

export const storyboards = sqliteTable('storyboards', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id').notNull(),
  sceneId: integer('scene_id'),
  storyboardNumber: integer('storyboard_number').notNull(),
  title: text('title'),
  location: text('location'),
  time: text('time'),
  shotType: text('shot_type'),
  angle: text('angle'),
  movement: text('movement'),
  result: text('result'),
  atmosphere: text('atmosphere'),
  // 旧版单帧提示词：新流程改用三个关键帧提示词，仅保留列供存量数据读取，不再写入
  imagePrompt: text('image_prompt'),
  videoPrompt: text('video_prompt'),
  bgmPrompt: text('bgm_prompt'),
  soundEffect: text('sound_effect'),
  description: text('description'),
  duration: integer('duration').default(0),
  composedImage: text('composed_image'),
  // 关键帧三槽位：各槽位选定版本的图片地址（首帧为空且承接上一镜时继承其尾帧）
  firstFrameImage: text('first_frame_image'),
  midFrameImage: text('mid_frame_image'),
  lastFrameImage: text('last_frame_image'),
  // 每张关键帧各自的提示词（拆分镜时由 LLM 生成，用户可改）
  firstFramePrompt: text('first_frame_prompt'),
  midFramePrompt: text('mid_frame_prompt'),
  lastFramePrompt: text('last_frame_prompt'),
  // 中间关键帧的时间点（秒，落在 0.5 ~ 时长-0.5 之间）
  midFrameTime: real('mid_frame_time'),
  // 人工确认关键帧：视频生成的前提
  keyframesConfirmed: integer('keyframes_confirmed', { mode: 'boolean' }).default(false),
  referenceImages: text('reference_images'),
  // 字段级保存时间（JSON：字段 → unix 秒），整行 updated_at 会被生图回写污染
  fieldSavedAt: text('field_saved_at'),
  // LLM 拆分镜时标注的边界：continue=承接上一镜（首帧继承其尾帧关键帧），cut=硬切；NULL=未标注（按硬切处理）
  continuityBoundary: text('continuity_boundary'),
  // 承接镜头的开场转场（#11）：描述文本 / 是否随视频提示词一起发送 / 最近一次审核结果（JSON）
  transitionPrompt: text('transition_prompt'),
  transitionEnabled: integer('transition_enabled', { mode: 'boolean' }).notNull().default(true),
  transitionReview: text('transition_review'),
  // 本镜旁白（#30）：文稿 / 是否出旁白（纯画面镜头可单独关掉）/ 配音文件 / 状态 blob（JSON）
  narrationText: text('narration_text'),
  narrationEnabled: integer('narration_enabled', { mode: 'boolean' }).notNull().default(true),
  narrationAudioUrl: text('narration_audio_url'),
  narrationMeta: text('narration_meta'),
  // 本镜字幕时间码模式覆盖（#30 Q10）；NULL = 继承剧集级 subtitle_timing
  subtitleTiming: text('subtitle_timing'),
  // 本镜文本规范化覆盖（#35）；NULL = 继承剧集级 narration_normalize
  narrationNormalize: integer('narration_normalize', { mode: 'boolean' }),
  // 本镜的旁白/画面匹配参数 JSON（#31）；NULL = 继承剧集级 narration_fit_default
  narrationFit: text('narration_fit'),
  videoUrl: text('video_url'),
  subtitleUrl: text('subtitle_url'),
  composedVideoUrl: text('composed_video_url'),
  status: text('status').default('pending'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

export const storyboardCharacters = sqliteTable('storyboard_characters', {
  storyboardId: integer('storyboard_id').notNull(),
  characterId: integer('character_id').notNull(),
}, (table) => [
  primaryKey({ columns: [table.storyboardId, table.characterId] }),
])

export const storyboardProps = sqliteTable('storyboard_props', {
  storyboardId: integer('storyboard_id').notNull(),
  propId: integer('prop_id').notNull(),
}, (table) => [
  primaryKey({ columns: [table.storyboardId, table.propId] }),
])

/**
 * 本镜资产池的人工手选（Issue #43）：只记录用户手选与拆镜/人工显式绑定的资产。
 * 有效池 = 本表 ∪ 5 个提示词当前 @ 到的本集资产；@ 自动加入的资产不写表，
 * 删掉最后一处引用即自动退出，手选始终保留。场景可多选，且不改写 storyboards.scene_id。
 */
export const storyboardPoolSelections = sqliteTable('storyboard_pool_selections', {
  storyboardId: integer('storyboard_id').notNull(),
  kind: text('kind').notNull(),
  assetId: integer('asset_id').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.storyboardId, table.kind, table.assetId] }),
])

/**
 * 生成目标级素材绑定（Issue #18）：每张关键帧（first/mid/last）与视频（video）各自的参考素材。
 * 绑定 = 该目标提示词里 @ 到的本集场景/角色/道具，提示词写入后自动重算；
 * selected_image 为该目标上的人工选版，NULL = 默认（本集造型图 > 资产当前图）。
 */
export const storyboardTargetAssets = sqliteTable('storyboard_target_assets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  storyboardId: integer('storyboard_id').notNull(),
  target: text('target').notNull(),
  kind: text('kind').notNull(),
  assetId: integer('asset_id').notNull(),
  selectedImage: text('selected_image'),
  createdAt: text('created_at').notNull(),
})

export const aiServiceConfigs = sqliteTable('ai_service_configs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  serviceType: text('service_type').notNull(),
  provider: text('provider'),
  name: text('name').notNull(),
  baseUrl: text('base_url').notNull(),
  apiKey: text('api_key').notNull(),
  model: text('model'),
  endpoint: text('endpoint'),
  queryEndpoint: text('query_endpoint'),
  priority: integer('priority').default(0),
  isDefault: integer('is_default', { mode: 'boolean' }).default(false),
  isActive: integer('is_active', { mode: 'boolean' }).default(true),
  settings: text('settings'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  // 注意: 此表无 deleted_at
})

export const aiServiceProviders = sqliteTable('ai_service_providers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  displayName: text('display_name'),
  serviceType: text('service_type').notNull(),
  provider: text('provider').notNull(),
  defaultUrl: text('default_url'),
  presetModels: text('preset_models'),
  description: text('description'),
  isActive: integer('is_active', { mode: 'boolean' }).default(true),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const stylePresets = sqliteTable('style_presets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  value: text('value').notNull(),
  prompt: text('prompt').notNull(),
  description: text('description'),
  sortOrder: integer('sort_order').default(0),
  isActive: integer('is_active', { mode: 'boolean' }).default(true),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  // 注意: 此表无 deleted_at（硬删除），value 列有唯一索引（见 sqlite-schema.ts DDL）
})

// 统一生成任务表：图片/视频生成共用，type 区分，生成参数存 params(JSON)
export const sysTask = sqliteTable('sys_task', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  type: text('type').notNull(), // image | video | text
  storyboardId: integer('storyboard_id'),
  // 任务归属的集（分镜任务取分镜所属集；资产出图为发起时所在集，可空；文本任务必填）
  episodeId: integer('episode_id'),
  dramaId: integer('drama_id'),
  sceneId: integer('scene_id'),
  characterId: integer('character_id'),
  propId: integer('prop_id'),
  provider: text('provider'),
  prompt: text('prompt'),
  model: text('model'),
  // image: {size, frameType, referenceImages[]}
  // video: {referenceMode, firstFrameUrl, lastFrameUrl, referenceImageUrls[], referenceVideoUrls[], referenceAudioUrls[], generateAudio, duration, aspectRatio, resolution, seed, promptExtend, watermark}
  params: text('params'),
  taskId: text('task_id'),
  resultUrl: text('result_url'),
  localPath: text('local_path'),
  // qwen-jobs 任务快照 + 内部键（request/config_id/idempotency_key），见 services/sys-task.ts
  remoteState: text('remote_state'),
  // queued | processing | completed | failed | cancelled
  status: text('status').default('processing'),
  errorMsg: text('error_msg'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  completedAt: text('completed_at'),
  // 媒体生成时间（unix 秒）：完成时与 completed_at 一起写入，前端按浏览器时区显示
  generatedAt: integer('generated_at'),
})

export const videoMerges = sqliteTable('video_merges', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id'),
  dramaId: integer('drama_id'),
  title: text('title'),
  provider: text('provider'),
  model: text('model'),
  status: text('status').default('pending'),
  scenes: text('scenes'), // JSON
  mergedUrl: text('merged_url'),
  duration: integer('duration'),
  taskId: text('task_id'),
  errorMsg: text('error_msg'),
  createdAt: text('created_at').notNull(),
  completedAt: text('completed_at'),
  // 成片生成时间（unix 秒），与 sys_task.generated_at 同口径
  generatedAt: integer('generated_at'),
  // Poster 片头（Issue #39）：静态海报图 + 展示秒数；与成片封面 *_poster.jpg 无关
  introImage: text('intro_image'),
  introDuration: real('intro_duration'),
  deletedAt: text('deleted_at'),
})

// 剧集 Poster（Issue #39）：每集一份编辑工程，保留生图候选与排版保存版本
export const episodePosters = sqliteTable('episode_posters', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dramaId: integer('drama_id').notNull(),
  episodeId: integer('episode_id').notNull(),
  // 画面 prompt 与针对文字的描述
  prompt: text('prompt'),
  textPrompt: text('text_prompt'),
  // 本集资产参考图快照 JSON（[{path, label}]）
  referenceImages: text('reference_images'),
  // 当前编辑底图
  baseImage: text('base_image'),
  // 文字图层布局 JSON
  layout: text('layout'),
  selectedVersionId: integer('selected_version_id'),
  finalImage: text('final_image'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

// Poster 版本：kind = generate（AI 候选）| composite（本地合成）
export const posterVersions = sqliteTable('poster_versions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  posterId: integer('poster_id').notNull(),
  episodeId: integer('episode_id').notNull(),
  dramaId: integer('drama_id').notNull(),
  kind: text('kind').notNull(),
  image: text('image'),
  baseImage: text('base_image'),
  layout: text('layout'),
  prompt: text('prompt'),
  textPrompt: text('text_prompt'),
  mode: text('mode'),
  referenceImages: text('reference_images'),
  provider: text('provider'),
  model: text('model'),
  sysTaskId: integer('sys_task_id'),
  createdAt: text('created_at').notNull(),
  generatedAt: integer('generated_at'),
})


// 服务端批量视频任务：按分镜顺序串行生成，持久化以便重启恢复与跨页面查看进度
export const videoBatches = sqliteTable('video_batches', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id').notNull(),
  status: text('status').default('running'), // running | done | cancelled
  options: text('options'), // JSON: { model?, configId? }
  items: text('items'), // JSON: BatchItem[]
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

// 服务端批量关键帧任务：按分镜 × 槽位顺序串行生成，结构与 video_batches 相同
export const keyframeBatches = sqliteTable('keyframe_batches', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id').notNull(),
  status: text('status').default('running'), // running | done | cancelled
  options: text('options'), // JSON: { model?, configId? }
  items: text('items'), // JSON: KeyframeBatchItem[]
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const props = sqliteTable('props', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dramaId: integer('drama_id').notNull(),
  name: text('name').notNull(),
  type: text('type'),
  description: text('description'),
  prompt: text('prompt'),
  finalPrompt: text('final_prompt'),
  finalPromptSource: text('final_prompt_source'),
  finalPromptUpdatedAt: text('final_prompt_updated_at'),
  imageUrl: text('image_url'),
  referenceImages: text('reference_images'),
  localPath: text('local_path'),
  // 证据素材（Issue #47）：faithful=1 的道具（地图/版画/文书）永不进入资产生图/批量重绘
  faithful: integer('faithful').notNull().default(0),
  // 语义标注坐标所针对的那张原图 = 该上传版本的 sys_task id
  faithfulSource: integer('faithful_source'),
  // 语义标注 JSON（labels/points/regions/lines，坐标为原图像素）；唯一读写口在 services/asset-semantics.ts
  semantics: text('semantics'),
  // 背景信息载体（Issue #47）：旁白提到但不出场、只作视觉承载的实体
  exposition: integer('exposition').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

export const assets = sqliteTable('assets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dramaId: integer('drama_id'),
  episodeId: integer('episode_id'),
  storyboardId: integer('storyboard_id'),
  storyboardNum: integer('storyboard_num'),
  name: text('name'),
  description: text('description'),
  type: text('type'),
  category: text('category'),
  url: text('url'),
  thumbnailUrl: text('thumbnail_url'),
  localPath: text('local_path'),
  fileSize: integer('file_size'),
  mimeType: text('mime_type'),
  width: integer('width'),
  height: integer('height'),
  duration: integer('duration'),
  format: text('format'),
  imageGenId: integer('image_gen_id'),
  videoGenId: integer('video_gen_id'),
  isFavorite: integer('is_favorite', { mode: 'boolean' }).default(false),
  viewCount: integer('view_count').default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
})

/**
 * 资料检索记录（Issue #32）— Agent 每次调用维基系检索工具落一行，UI 的「资料来源」列表读它。
 * assetId 在提取阶段还不知道（资产行可能刚创建），先按 assetName 落库，
 * save_dedup_* 落库后回填 assetId。status：'ok' = 检索成功，'failed' = 不可用（降级为只用剧本原文）。
 */
export const researchCitations = sqliteTable('research_citations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dramaId: integer('drama_id'),
  episodeId: integer('episode_id'),
  assetKind: text('asset_kind'),
  assetId: integer('asset_id'),
  assetName: text('asset_name'),
  tool: text('tool').notNull(),
  query: text('query'),
  title: text('title'),
  sourceUrl: text('source_url'),
  lang: text('lang'),
  snippet: text('snippet'),
  status: text('status').notNull().default('ok'),
  retrievedAt: text('retrieved_at').notNull(),
})
