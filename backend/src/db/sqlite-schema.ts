/**
 * SQLite 启动建表 DDL + 种子数据（自 mysql-schema.ts 翻译）
 * - AUTO_INCREMENT → AUTOINCREMENT；删除 ENGINE/CHARSET；TINYINT(1) → INTEGER
 * - MySQL 内联 INDEX 拆为独立 CREATE INDEX IF NOT EXISTS
 * - 种子语句去掉 FROM DUAL（SQLite 非法），幂等语义（WHERE NOT EXISTS）保留
 */
import type Database from 'better-sqlite3'

export const sqliteSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS dramas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    genre TEXT,
    project_type TEXT NOT NULL DEFAULT 'drama',
    documentary_rules TEXT,
    style TEXT DEFAULT '3d',
    aspect_ratio TEXT DEFAULT '16:9',
    total_episodes INTEGER DEFAULT 1,
    total_duration INTEGER DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'draft',
    thumbnail TEXT,
    tags TEXT,
    metadata TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER NOT NULL,
    episode_number INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT,
    script_content TEXT,
    description TEXT,
    duration INTEGER DEFAULT 0,
    status TEXT DEFAULT 'draft',
    video_url TEXT,
    thumbnail TEXT,
    image_config_id INTEGER,
    video_config_id INTEGER,
    tts_config_id INTEGER,
    narration_enabled INTEGER NOT NULL DEFAULT 0,
    narration_spine TEXT,
    narration_normalize INTEGER NOT NULL DEFAULT 1,
    tts_settings TEXT,
    subtitle_timing TEXT NOT NULL DEFAULT 'sentence',
    audio_mix_mode TEXT NOT NULL DEFAULT 'replace',
    audio_bed_gain_db REAL,
    narration_fit_default TEXT,
    resolution TEXT DEFAULT '720p',
    character_roster TEXT,
    character_roster_hash TEXT,
    character_roster_status TEXT,
    character_roster_updated_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS characters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    role TEXT,
    description TEXT,
    appearance TEXT,
    styling TEXT,
    final_prompt TEXT,
    final_prompt_source TEXT,
    final_prompt_updated_at TEXT,
    archival_images TEXT,
    personality TEXT,
    image_url TEXT,
    reference_images TEXT,
    seed_value TEXT,
    sort_order INTEGER,
    local_path TEXT,
    exposition INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS scenes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER NOT NULL,
    episode_id INTEGER,
    location TEXT NOT NULL,
    time TEXT NOT NULL,
    prompt TEXT NOT NULL,
    lighting TEXT,
    final_prompt TEXT,
    final_prompt_source TEXT,
    final_prompt_updated_at TEXT,
    storyboard_count INTEGER DEFAULT 1,
    image_url TEXT,
    reference_images TEXT,
    status TEXT DEFAULT 'pending',
    local_path TEXT,
    exposition INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS storyboards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL,
    scene_id INTEGER,
    storyboard_number INTEGER NOT NULL,
    title TEXT,
    location TEXT,
    time TEXT,
    shot_type TEXT,
    angle TEXT,
    movement TEXT,
    result TEXT,
    atmosphere TEXT,
    image_prompt TEXT,
    video_prompt TEXT,
    bgm_prompt TEXT,
    sound_effect TEXT,
    description TEXT,
    duration INTEGER DEFAULT 0,
    composed_image TEXT,
    first_frame_image TEXT,
    mid_frame_image TEXT,
    last_frame_image TEXT,
    first_frame_prompt TEXT,
    mid_frame_prompt TEXT,
    last_frame_prompt TEXT,
    mid_frame_time REAL,
    keyframes_confirmed INTEGER DEFAULT 0,
    reference_images TEXT,
    field_saved_at TEXT,
    continuity_boundary TEXT,
    transition_prompt TEXT,
    transition_enabled INTEGER NOT NULL DEFAULT 1,
    transition_review TEXT,
    narration_text TEXT,
    narration_enabled INTEGER NOT NULL DEFAULT 1,
    narration_audio_url TEXT,
    narration_meta TEXT,
    subtitle_timing TEXT,
    narration_normalize INTEGER,
    narration_fit TEXT,
    intent TEXT,
    intent_reviewed INTEGER NOT NULL DEFAULT 0,
    video_url TEXT,
    subtitle_url TEXT,
    composed_video_url TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS episode_characters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL,
    character_id INTEGER NOT NULL,
    styling_version TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_episode_characters_episode_id ON episode_characters (episode_id)`,
  `CREATE INDEX IF NOT EXISTS idx_episode_characters_character_id ON episode_characters (character_id)`,

  `CREATE TABLE IF NOT EXISTS episode_scenes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL,
    scene_id INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_episode_scenes_episode_id ON episode_scenes (episode_id)`,
  `CREATE INDEX IF NOT EXISTS idx_episode_scenes_scene_id ON episode_scenes (scene_id)`,

  `CREATE TABLE IF NOT EXISTS episode_props (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL,
    prop_id INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_episode_props_episode_id ON episode_props (episode_id)`,
  `CREATE INDEX IF NOT EXISTS idx_episode_props_prop_id ON episode_props (prop_id)`,

  `CREATE TABLE IF NOT EXISTS storyboard_characters (
    storyboard_id INTEGER NOT NULL,
    character_id INTEGER NOT NULL,
    PRIMARY KEY (storyboard_id, character_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_storyboard_characters_character_id ON storyboard_characters (character_id)`,

  `CREATE TABLE IF NOT EXISTS storyboard_props (
    storyboard_id INTEGER NOT NULL,
    prop_id INTEGER NOT NULL,
    PRIMARY KEY (storyboard_id, prop_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_storyboard_props_prop_id ON storyboard_props (prop_id)`,

  // 本镜资产池的人工手选（Issue #43）：kind ∈ scene|character|prop；@ 自动加入的资产不写表
  `CREATE TABLE IF NOT EXISTS storyboard_pool_selections (
    storyboard_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    asset_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (storyboard_id, kind, asset_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_storyboard_pool_selections_asset ON storyboard_pool_selections (kind, asset_id)`,

  // 生成目标级素材绑定（Issue #18）：target ∈ first|mid|last|video，kind ∈ scene|character|prop
  `CREATE TABLE IF NOT EXISTS storyboard_target_assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    storyboard_id INTEGER NOT NULL,
    target TEXT NOT NULL,
    kind TEXT NOT NULL,
    asset_id INTEGER NOT NULL,
    selected_image TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (storyboard_id, target, kind, asset_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_storyboard_target_assets_asset ON storyboard_target_assets (kind, asset_id)`,

  `CREATE TABLE IF NOT EXISTS ai_service_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_type TEXT NOT NULL,
    provider TEXT,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key TEXT NOT NULL,
    model TEXT,
    endpoint TEXT,
    query_endpoint TEXT,
    priority INTEGER DEFAULT 0,
    is_default INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    settings TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS ai_service_providers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    display_name TEXT,
    service_type TEXT NOT NULL,
    provider TEXT NOT NULL,
    default_url TEXT,
    preset_models TEXT,
    description TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS style_presets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    value TEXT NOT NULL,
    prompt TEXT NOT NULL,
    description TEXT,
    sort_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (value)
  )`,

  `CREATE TABLE IF NOT EXISTS sys_task (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    storyboard_id INTEGER,
    episode_id INTEGER,
    drama_id INTEGER,
    scene_id INTEGER,
    character_id INTEGER,
    prop_id INTEGER,
    provider TEXT,
    prompt TEXT,
    model TEXT,
    params TEXT,
    task_id TEXT,
    result_url TEXT,
    local_path TEXT,
    remote_state TEXT,
    status TEXT DEFAULT 'processing',
    error_msg TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    generated_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sys_task_type ON sys_task (type)`,
  `CREATE INDEX IF NOT EXISTS idx_sys_task_drama_id ON sys_task (drama_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sys_task_storyboard_id ON sys_task (storyboard_id)`,
  // 当前媒体按路径反查生成时间（资产/分镜每个响应一次批量 IN 查询）
  `CREATE INDEX IF NOT EXISTS idx_sys_task_local_path ON sys_task (local_path)`,

  `CREATE TABLE IF NOT EXISTS video_merges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER,
    drama_id INTEGER,
    title TEXT,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    scenes TEXT,
    merged_url TEXT,
    duration INTEGER,
    task_id TEXT,
    error_msg TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    generated_at INTEGER,
    deleted_at TEXT
  )`,

  // 剧集 Poster（Issue #39）：每集一份编辑工程 + 生图/排版版本
  `CREATE TABLE IF NOT EXISTS episode_posters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER NOT NULL,
    episode_id INTEGER NOT NULL UNIQUE,
    prompt TEXT,
    text_prompt TEXT,
    reference_images TEXT,
    base_image TEXT,
    layout TEXT,
    selected_version_id INTEGER,
    final_image TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS poster_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    poster_id INTEGER NOT NULL,
    episode_id INTEGER NOT NULL,
    drama_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    image TEXT,
    base_image TEXT,
    layout TEXT,
    prompt TEXT,
    text_prompt TEXT,
    mode TEXT,
    reference_images TEXT,
    provider TEXT,
    model TEXT,
    sys_task_id INTEGER,
    created_at TEXT NOT NULL,
    generated_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_poster_versions_poster ON poster_versions (poster_id)`,

  `CREATE TABLE IF NOT EXISTS props (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    type TEXT,
    description TEXT,
    prompt TEXT,
    final_prompt TEXT,
    final_prompt_source TEXT,
    final_prompt_updated_at TEXT,
    image_url TEXT,
    reference_images TEXT,
    local_path TEXT,
    faithful INTEGER NOT NULL DEFAULT 0,
    faithful_source INTEGER,
    semantics TEXT,
    exposition INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER,
    episode_id INTEGER,
    storyboard_id INTEGER,
    storyboard_num INTEGER,
    name TEXT,
    description TEXT,
    type TEXT,
    category TEXT,
    url TEXT,
    thumbnail_url TEXT,
    local_path TEXT,
    file_size INTEGER,
    mime_type TEXT,
    width INTEGER,
    height INTEGER,
    duration INTEGER,
    format TEXT,
    image_gen_id INTEGER,
    video_gen_id INTEGER,
    is_favorite INTEGER DEFAULT 0,
    view_count INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )`,

  // 应用级全局设置（key-value，如 AI 内容语言 content_language）
  `CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  // 服务端批量视频任务（按分镜顺序串行），持久化以便重启恢复
  `CREATE TABLE IF NOT EXISTS video_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL,
    status TEXT DEFAULT 'running',
    options TEXT,
    items TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  // 服务端批量关键帧任务（按分镜 × 槽位串行），持久化以便重启恢复
  `CREATE TABLE IF NOT EXISTS keyframe_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL,
    status TEXT DEFAULT 'running',
    options TEXT,
    items TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  // 资料检索记录（Issue #32）：Agent 每次调用维基系检索工具落一行，资产详情的「资料来源」读它
  `CREATE TABLE IF NOT EXISTS research_citations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER,
    episode_id INTEGER,
    asset_kind TEXT,
    asset_id INTEGER,
    asset_name TEXT,
    tool TEXT NOT NULL,
    query TEXT,
    title TEXT,
    source_url TEXT,
    lang TEXT,
    snippet TEXT,
    status TEXT NOT NULL DEFAULT 'ok',
    retrieved_at TEXT NOT NULL
  )`,

  // 确定性片段（Issue #50）：底图 + 图层文档 + 时间线渲染出的 mp4
  // position ∈ replace|pre|post；每镜每个 position 至多一条
  `CREATE TABLE IF NOT EXISTS storyboard_clips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    storyboard_id INTEGER NOT NULL,
    position TEXT NOT NULL,
    layer_doc TEXT NOT NULL,
    timeline TEXT NOT NULL,
    duration REAL NOT NULL,
    render_path TEXT,
    render_signature TEXT,
    rendered_at TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_storyboard_clips_unique ON storyboard_clips (storyboard_id, position)`,
]

/**
 * 存量库补列 — CREATE TABLE IF NOT EXISTS 不会给老表加列。
 * SQLite 的 ADD COLUMN 不重建表、可空列无默认值即无数据改写，按 PRAGMA table_info 幂等跳过。
 */
const columnAdditions: { table: string; column: string; type: string }[] = [
  // 场景参考图（与 characters/props 的 reference_images 同语义：用户上传的生图输入）
  { table: 'scenes', column: 'reference_images', type: 'TEXT' },
  // LLM 标注的承接边界
  { table: 'storyboards', column: 'continuity_boundary', type: 'TEXT' },
  // 分镜关键帧：三个槽位的提示词、中间帧时间与选定图、人工确认标记
  { table: 'storyboards', column: 'first_frame_prompt', type: 'TEXT' },
  { table: 'storyboards', column: 'mid_frame_prompt', type: 'TEXT' },
  { table: 'storyboards', column: 'last_frame_prompt', type: 'TEXT' },
  { table: 'storyboards', column: 'mid_frame_time', type: 'REAL' },
  { table: 'storyboards', column: 'mid_frame_image', type: 'TEXT' },
  { table: 'storyboards', column: 'keyframes_confirmed', type: 'INTEGER DEFAULT 0' },
  // 字段级保存时间（JSON：字段 → unix 秒）
  { table: 'storyboards', column: 'field_saved_at', type: 'TEXT' },
  // 承接镜头的开场转场（#11）：存量行 transition_prompt=NULL、transition_enabled=1、transition_review=NULL
  { table: 'storyboards', column: 'transition_prompt', type: 'TEXT' },
  { table: 'storyboards', column: 'transition_enabled', type: 'INTEGER NOT NULL DEFAULT 1' },
  { table: 'storyboards', column: 'transition_review', type: 'TEXT' },
  // qwen-jobs 远端任务快照（排队位置/进度/估计）+ 提交请求体，重启后据此恢复
  { table: 'sys_task', column: 'remote_state', type: 'TEXT' },
  // 任务归属的集：全局任务中心按剧/集筛选与编号，启动时按 storyboard_id 回填存量行
  { table: 'sys_task', column: 'episode_id', type: 'INTEGER' },
  // 媒体生成时间（unix 秒）：完成时写入，启动时按 completed_at || created_at 回填存量行
  { table: 'sys_task', column: 'generated_at', type: 'INTEGER' },
  { table: 'video_merges', column: 'generated_at', type: 'INTEGER' },
  // Poster 片头（Issue #39）：与成片封面 *_poster.jpg 无关，记录实际插入的静态片头
  { table: 'video_merges', column: 'intro_image', type: 'TEXT' },
  { table: 'video_merges', column: 'intro_duration', type: 'REAL' },
  // 本集角色造型版本（Issue #15，JSON {name, description, image_path}）
  { table: 'episode_characters', column: 'styling_version', type: 'TEXT' },
  // 旁白 / 字幕 / 配音（#30）：剧集级开关与 TTS 配置，每镜文稿 / 开关 / 配音 / 状态 blob
  { table: 'episodes', column: 'tts_config_id', type: 'INTEGER' },
  { table: 'episodes', column: 'narration_enabled', type: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'storyboards', column: 'narration_text', type: 'TEXT' },
  { table: 'storyboards', column: 'narration_enabled', type: 'INTEGER NOT NULL DEFAULT 1' },
  { table: 'storyboards', column: 'narration_audio_url', type: 'TEXT' },
  { table: 'storyboards', column: 'narration_meta', type: 'TEXT' },
  // 字幕时间码模式（#30 Q10）：剧集级默认 sentence，分镜级 NULL = 继承
  { table: 'episodes', column: 'subtitle_timing', type: "TEXT NOT NULL DEFAULT 'sentence'" },
  { table: 'storyboards', column: 'subtitle_timing', type: 'TEXT' },
  // 旁白与画面的时长/音轨匹配（#31）：存量行默认 = 替代 + 尾部留白，与 #30 的默认行为等价
  { table: 'episodes', column: 'audio_mix_mode', type: "TEXT NOT NULL DEFAULT 'replace'" },
  { table: 'episodes', column: 'audio_bed_gain_db', type: 'REAL' },
  { table: 'episodes', column: 'narration_fit_default', type: 'TEXT' },
  { table: 'storyboards', column: 'narration_fit', type: 'TEXT' },
  // 旁白主线与文本规范化（#35）：存量集补 narration_normalize=1（数字/日期展开读法默认开）
  { table: 'episodes', column: 'narration_spine', type: 'TEXT' },
  { table: 'episodes', column: 'narration_normalize', type: 'INTEGER NOT NULL DEFAULT 1' },
  { table: 'storyboards', column: 'narration_normalize', type: 'INTEGER' },
  // 本集配音参数（#37）：NULL = 沿用 TTS 配置
  { table: 'episodes', column: 'tts_settings', type: 'TEXT' },
  // 纪录片规则显式开关（Issue #32）：'auto' | 'on' | 'off'；NULL 等价 'auto'（按 genre 关键字判定）
  { table: 'dramas', column: 'documentary_rules', type: 'TEXT' },
  // 最终提示词来源标记（Issue #32）：'agent' = 提示词 Agent 保存，'external' = 外部直写
  { table: 'characters', column: 'final_prompt_source', type: 'TEXT' },
  { table: 'characters', column: 'final_prompt_updated_at', type: 'TEXT' },
  { table: 'scenes', column: 'final_prompt_source', type: 'TEXT' },
  { table: 'scenes', column: 'final_prompt_updated_at', type: 'TEXT' },
  { table: 'props', column: 'final_prompt_source', type: 'TEXT' },
  { table: 'props', column: 'final_prompt_updated_at', type: 'TEXT' },
  // 史料参考画像（Issue #32，JSON 数组）：与 reference_images 严格分离，生图链路不读
  { table: 'characters', column: 'archival_images', type: 'TEXT' },
  // 纪录片选角名册（Issue #32）：谁该建卡的名册本体 + 复核时的剧本指纹 + draft/approved 状态
  { table: 'episodes', column: 'character_roster', type: 'TEXT' },
  { table: 'episodes', column: 'character_roster_hash', type: 'TEXT' },
  { table: 'episodes', column: 'character_roster_status', type: 'TEXT' },
  { table: 'episodes', column: 'character_roster_updated_at', type: 'TEXT' },
  // 项目类型（Issue #45）：'drama' | 'documentary'；存量项目一律 drama，创建后不可切换
  { table: 'dramas', column: 'project_type', type: "TEXT NOT NULL DEFAULT 'drama'" },
  // 证据素材与语义标注（Issue #47）：faithful 是持久资产属性（不再按当前版本 provider 推断），
  // faithful_source 指向语义坐标所针对的那张上传原图，semantics 存标注 JSON
  { table: 'props', column: 'faithful', type: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'props', column: 'faithful_source', type: 'INTEGER' },
  { table: 'props', column: 'semantics', type: 'TEXT' },
  // 背景信息载体（Issue #47）：旁白提到但不出场、需要视觉承载的实体（近卫团、彼得一世、波尔塔瓦）。
  // 不新增第 4 类资产：仍按角色/场景/道具三类落库，这一列只回答「它是不是背景信息载体」，
  // 供表达设计（#49）的 exposition_assets 单列引用。
  { table: 'characters', column: 'exposition', type: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'scenes', column: 'exposition', type: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'props', column: 'exposition', type: 'INTEGER NOT NULL DEFAULT 0' },
  // 表达设计（Issue #49）：纪录片每镜的信息点/表达手段/必须可见要素/叠加层计划（JSON）
  // 与人工确认位；非纪录片项目恒为 NULL / 0。
  { table: 'storyboards', column: 'intent', type: 'TEXT' },
  { table: 'storyboards', column: 'intent_reviewed', type: 'INTEGER NOT NULL DEFAULT 0' },
]

/**
 * 存量库删列 — 旧的"视频尾帧承接"已被关键帧流程取代，残留列会让 drizzle 的
 * 全列 SELECT 与新 schema 不一致。SQLite ≥3.35 支持 DROP COLUMN（better-sqlite3 自带），
 * 按 PRAGMA table_info 判断列是否存在，幂等。
 */
const columnRemovals: { table: string; column: string }[] = [
  { table: 'episodes', column: 'continuity_enabled' },
  { table: 'storyboards', column: 'continuity_mode' },
  // 分镜级素材版本选择 → storyboard_target_assets.selected_image（Issue #18，先迁移再删列）
  { table: 'storyboards', column: 'asset_version_selection' },
]

function applyColumnRemovals(sqlite: Database.Database): void {
  for (const { table, column } of columnRemovals) {
    const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    if (!columns.some(col => col.name === column)) continue
    sqlite.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`)
    console.log(`🧹 表 ${table} 删除废弃列 ${column}`)
  }
}

function applyColumnAdditions(sqlite: Database.Database): void {
  for (const { table, column, type } of columnAdditions) {
    // PRAGMA 返回固定形状，better-sqlite3 无静态类型，按已知结果结构断言
    const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    if (columns.some(col => col.name === column)) continue
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
    console.log(`🧱 表 ${table} 补列 ${column}`)
  }
}

/**
 * 存量清理（Issue #15）— 资产软删/硬删后残留的集关联行。
 * 残留关联会让提取 Agent 与 @引用 看到已删资产（线上 E1 就有 3 条），
 * 删除行即可，幂等：资产已不存在或 deleted_at 非空的关联一律清掉。
 */
const STALE_LINK_CLEANUPS: { table: string; column: string; asset: string }[] = [
  { table: 'episode_characters', column: 'character_id', asset: 'characters' },
  { table: 'episode_scenes', column: 'scene_id', asset: 'scenes' },
  { table: 'episode_props', column: 'prop_id', asset: 'props' },
  { table: 'storyboard_characters', column: 'character_id', asset: 'characters' },
  { table: 'storyboard_props', column: 'prop_id', asset: 'props' },
]

function cleanupStaleAssetLinks(sqlite: Database.Database): void {
  for (const { table, column, asset } of STALE_LINK_CLEANUPS) {
    const res = sqlite.prepare(
      `DELETE FROM ${table} WHERE ${column} NOT IN (SELECT id FROM ${asset} WHERE deleted_at IS NULL)`,
    ).run()
    if (res.changes > 0) console.log(`🧹 清理 ${table} 中指向已删资产的关联 ${res.changes} 条`)
  }
  const targetRes = sqlite.prepare(
    `DELETE FROM storyboard_target_assets WHERE storyboard_id NOT IN (SELECT id FROM storyboards WHERE deleted_at IS NULL)
      OR (kind = 'scene' AND asset_id NOT IN (SELECT id FROM scenes WHERE deleted_at IS NULL))
      OR (kind = 'character' AND asset_id NOT IN (SELECT id FROM characters WHERE deleted_at IS NULL))
      OR (kind = 'prop' AND asset_id NOT IN (SELECT id FROM props WHERE deleted_at IS NULL))`,
  ).run()
  if (targetRes.changes > 0) console.log(`🧹 清理 storyboard_target_assets 中失效的绑定 ${targetRes.changes} 条`)
  // 资产池手选（Issue #43）：分镜被删或资产被删后，手选行不能继续让已删资产留在池里
  const poolRes = sqlite.prepare(
    `DELETE FROM storyboard_pool_selections WHERE storyboard_id NOT IN (SELECT id FROM storyboards WHERE deleted_at IS NULL)
      OR (kind = 'scene' AND asset_id NOT IN (SELECT id FROM scenes WHERE deleted_at IS NULL))
      OR (kind = 'character' AND asset_id NOT IN (SELECT id FROM characters WHERE deleted_at IS NULL))
      OR (kind = 'prop' AND asset_id NOT IN (SELECT id FROM props WHERE deleted_at IS NULL))`,
  ).run()
  if (poolRes.changes > 0) console.log(`🧹 清理 storyboard_pool_selections 中失效的手选 ${poolRes.changes} 条`)
}

/** 生成目标 → 决定其绑定的提示词列（与 services/storyboard-assets.ts TARGET_PROMPT_FIELDS 同口径） */
const TARGET_PROMPT_COLUMNS: Record<string, string[]> = {
  first: ['first_frame_prompt'],
  mid: ['mid_frame_prompt'],
  last: ['last_frame_prompt'],
  video: ['video_prompt', 'transition_prompt'],
}

/**
 * 存量迁移（Issue #18）— 只在 storyboard_target_assets 表首次创建时执行一次：
 * 每个未删除分镜里提示词非空的生成目标都继承分镜当前的绑定（场景 + 角色 + 道具）；
 * 提示词为空的目标不会被生成（如承接上一镜的首帧），不写绑定，之后写入提示词时按 @ 计算。
 * 选版取 asset_version_selection 的对应键；与本集造型图相同的条目是 #15 自动选版写入的，
 * 迁移成 NULL（读时解析结果相同），之后造型图重出仍会自动跟随。
 * 迁移后的参考图序列与迁移前逐字节一致；用户改哪一帧的提示词，那一帧才按 @ 重算。
 */
function migrateStoryboardTargetAssets(sqlite: Database.Database): void {
  const hasSelection = (sqlite.prepare('PRAGMA table_info(storyboards)').all() as { name: string }[])
    .some(col => col.name === 'asset_version_selection')
  const storyboards = sqlite.prepare(
    `SELECT id, episode_id, scene_id, first_frame_prompt, mid_frame_prompt, last_frame_prompt, video_prompt, transition_prompt${hasSelection ? ', asset_version_selection' : ''} FROM storyboards WHERE deleted_at IS NULL`,
  ).all() as Array<Record<string, string | number | null> & { id: number; episode_id: number; scene_id: number | null; asset_version_selection?: string | null }>
  const charsOf = sqlite.prepare('SELECT character_id AS id FROM storyboard_characters WHERE storyboard_id = ?')
  const propsOf = sqlite.prepare('SELECT prop_id AS id FROM storyboard_props WHERE storyboard_id = ?')
  const stylingOf = sqlite.prepare('SELECT character_id, styling_version FROM episode_characters WHERE episode_id = ?')
  const insert = sqlite.prepare(
    'INSERT OR IGNORE INTO storyboard_target_assets (storyboard_id, target, kind, asset_id, selected_image, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
  const ts = new Date().toISOString()
  let rows = 0
  sqlite.transaction(() => {
    for (const sb of storyboards) {
      let selection: Record<string, string> = {}
      try {
        const parsed: unknown = sb.asset_version_selection ? JSON.parse(sb.asset_version_selection) : {}
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) selection = parsed as Record<string, string>
      } catch { /* 非法 JSON 视为无选版 */ }
      const styling = new Map<number, string>()
      for (const link of stylingOf.all(sb.episode_id) as { character_id: number; styling_version: string | null }[]) {
        try {
          const parsed = link.styling_version ? JSON.parse(link.styling_version) as { image_path?: unknown } : null
          if (parsed && typeof parsed.image_path === 'string' && parsed.image_path) styling.set(link.character_id, parsed.image_path)
        } catch { /* 忽略 */ }
      }
      const assets: { kind: string; id: number }[] = []
      if (sb.scene_id != null) assets.push({ kind: 'scene', id: sb.scene_id })
      for (const row of charsOf.all(sb.id) as { id: number }[]) assets.push({ kind: 'character', id: row.id })
      for (const row of propsOf.all(sb.id) as { id: number }[]) assets.push({ kind: 'prop', id: row.id })
      const targets = Object.keys(TARGET_PROMPT_COLUMNS)
        .filter(target => TARGET_PROMPT_COLUMNS[target]!.some(column => String(sb[column] ?? '').trim()))
      for (const asset of assets) {
        let selected: string | null = selection[`${asset.kind}:${asset.id}`] || null
        if (selected && asset.kind === 'character' && styling.get(asset.id) === selected) selected = null
        for (const target of targets) {
          rows += insert.run(sb.id, target, asset.kind, asset.id, selected, ts).changes
        }
      }
    }
  })()
  console.log(`🧩 生成目标级素材绑定迁移：${storyboards.length} 个分镜，写入 ${rows} 条（继承分镜绑定）`)
}

/**
 * 存量迁移（Issue #43）— 只在 storyboard_pool_selections 表首次创建时执行一次：
 * 历史数据分不出哪条是手选、哪条是 @ 自动加入的，为了不丢用户已选内容，
 * 保守地把每个未删除分镜现有的角色/道具关联与**主场景**都记为手选。
 * 提示词里已有的 @ 不写进本表（随提示词实时推导），由启动时的
 * `backfillPoolProjection()`（services/storyboard-assets.ts）补齐到角色/道具投影。
 * 迁移不改提示词、不改主场景 scene_id、不动目标级绑定与选版、不碰关键帧/视频与确认状态。
 */
function migrateStoryboardPoolSelections(sqlite: Database.Database): void {
  const ts = new Date().toISOString()
  const insert = sqlite.prepare(
    'INSERT OR IGNORE INTO storyboard_pool_selections (storyboard_id, kind, asset_id, created_at) VALUES (?, ?, ?, ?)',
  )
  let rows = 0
  const migrate = sqlite.transaction(() => {
    const storyboards = sqlite.prepare(
      'SELECT id, scene_id FROM storyboards WHERE deleted_at IS NULL',
    ).all() as Array<{ id: number; scene_id: number | null }>
    const charsOf = sqlite.prepare('SELECT character_id AS id FROM storyboard_characters WHERE storyboard_id = ?')
    const propsOf = sqlite.prepare('SELECT prop_id AS id FROM storyboard_props WHERE storyboard_id = ?')
    for (const sb of storyboards) {
      if (sb.scene_id != null) rows += insert.run(sb.id, 'scene', sb.scene_id, ts).changes
      for (const row of charsOf.all(sb.id) as { id: number }[]) rows += insert.run(sb.id, 'character', row.id, ts).changes
      for (const row of propsOf.all(sb.id) as { id: number }[]) rows += insert.run(sb.id, 'prop', row.id, ts).changes
    }
    return storyboards.length
  })
  const count = migrate()
  console.log(`🧩 本镜资产池手选迁移：${count} 个分镜，写入 ${rows} 条（历史关联与主场景保留为手选）`)
}

/** 证据素材迁移命中的道具子类型（Issue #47）：地图是事故现场，也是唯一能机械判定的一类 */
const FAITHFUL_PROP_TYPES = ['地图']
/**
 * 版本历史里算「原件」的 provider。这里**只认 `upload`**（人工上传的原件），
 * 不含跨项目导入的 `import`：导入复制出的版本可能本身就是别处的生成图，
 * 一次性迁移不该替人断定它是原件。导入资产的 faithful 由 asset-library 的复制逻辑
 * 从源资产带过来，人也可以在界面上随时补标。
 */
const FAITHFUL_MIGRATION_PROVIDERS = ['upload']

/**
 * 存量迁移（Issue #47）— 只在 props.faithful 列首次补上时执行一次：
 * `type='地图'` 且版本历史里存在 `provider='upload'` 版本的道具标成证据素材，
 * faithful_source 取最早的那条原件版本（后来的上传多半是美化/替换，原件是第一张）。
 *
 * **只打标记，不动 image_url**（用户确认 Q1）：回退底图由人在界面上显式执行
 * `PUT /props/:id/faithful-source`，迁移本身不改变任何已生成的关键帧签名。
 */
function migrateFaithfulProps(sqlite: Database.Database): void {
  const placeholders = FAITHFUL_PROP_TYPES.map(() => '?').join(', ')
  const providers = FAITHFUL_MIGRATION_PROVIDERS.map(() => '?').join(', ')
  const candidates = sqlite.prepare(
    `SELECT id FROM props WHERE deleted_at IS NULL AND type IN (${placeholders})`,
  ).all(...FAITHFUL_PROP_TYPES) as Array<{ id: number }>
  const originalOf = sqlite.prepare(
    `SELECT id FROM sys_task
     WHERE type = 'image' AND status = 'completed' AND prop_id = ?
       AND provider IN (${providers})
     ORDER BY created_at ASC, id ASC LIMIT 1`,
  )
  const mark = sqlite.prepare('UPDATE props SET faithful = 1, faithful_source = ? WHERE id = ?')
  let marked = 0
  sqlite.transaction(() => {
    for (const prop of candidates) {
      const original = originalOf.get(prop.id, ...FAITHFUL_MIGRATION_PROVIDERS) as { id: number } | undefined
      if (!original) continue
      marked += mark.run(original.id, prop.id).changes
    }
  })()
  console.log(`🗺️ 证据素材迁移：${candidates.length} 个地图道具，标记 ${marked} 个为忠实素材（只打标记，不改当前图）`)
}

/**
 * 风格预设种子数据 — value 存入 dramas.style，prompt 注入生图提示词（作为前缀拼接）
 *
 * prompt 统一按多维结构书写，保证跨模型/跨镜头的风格控制力：
 *   核心媒介与渲染 → 线条/造型 → 上色/材质 → 光影 → 色彩调性 → 背景处理 → 画质锚点 → avoid 禁忌项
 */
export const stylePresetSeeds = [
  {
    name: '3D 漫剧', value: '3d', sortOrder: 1,
    prompt: 'high-quality 3D CG animation still, modern game-engine cinematic render, Unreal Engine and Pixar grade quality, semi-realistic stylized characters with refined facial features, clean sculpted anatomy, detailed skin shader with subtle subsurface scattering, PBR materials with crisp detailed textures, volumetric cinematic lighting with soft rim light, rich depth of field, polished film color grading, detailed environment art, sharp focus, consistent character design across shots, avoid flat lighting, avoid plastic waxy skin, avoid low-poly blurry look, avoid 2D flat cel shading, avoid anime line art',
    description: '游戏引擎级 3D 渲染，半写实角色，当前短剧主流的 3D 漫剧质感',
  },
  {
    name: '日漫赛璐璐', value: 'anime', sortOrder: 2,
    prompt: 'Japanese TV anime style, clean cel shading with hard-edged shadow shapes, crisp uniform black line art, vivid saturated color palette, expressive large-eyed character design with on-model proportions, detailed hand-painted anime backgrounds, dramatic anime key lighting with screentone highlights, key-visual poster quality, consistent character design across shots, avoid 3D CGI look, avoid painterly soft blending, avoid watercolor texture, avoid photorealism, avoid thick western comic outlines',
    description: '日式赛璐璐动画风格',
  },
  {
    name: '吉卜力手绘', value: 'ghibli', sortOrder: 3,
    prompt: 'Studio Ghibli hand-drawn animation style, soft painterly brushwork with organic hand-crafted line quality, lush warm watercolor painted backgrounds, gentle natural daylight with nostalgic warm glow, muted earthy natural color palette, whimsical cozy storybook atmosphere, subtle film-grain softness, theatrical background art quality, consistent character design across shots, avoid hard cel shading, avoid 3D render look, avoid neon over-saturated colors, avoid sharp digital edges, avoid photorealism',
    description: '吉卜力手绘治愈风',
  },
  {
    name: '水彩绘本', value: 'watercolor', sortOrder: 4,
    prompt: 'delicate watercolor storybook illustration, soft translucent color washes, visible cold-press paper texture, fluid hand-painted brushstrokes with gentle pigment bleeds, light airy atmosphere, harmonious pastel palette, whimsical children book charm, loose expressive edges, consistent character design across shots, avoid bold black outlines, avoid digital airbrush look, avoid harsh contrast, avoid 3D rendering, avoid photorealism',
    description: '水彩插画质感',
  },
  {
    name: '美式漫画', value: 'comic', sortOrder: 5,
    prompt: 'Western graphic-novel comic book style, bold confident black ink outlines, halftone dot shading and screentone gradients, dynamic saturated colors with dramatic contrast, dramatic spotlight lighting, flat graphic print look, sharp inking details, dynamic cinematic composition, consistent character design across shots, avoid painterly soft blending, avoid watercolor washes, avoid photorealistic rendering, avoid 3D CGI look, avoid anime cel shading',
    description: '美式漫画粗线条风格',
  },
  {
    name: '国风 2.5D', value: 'guofeng', sortOrder: 7,
    prompt: 'Chinese guofeng 2.5D illustration style, semi-realistic donghua-quality character art, elegant flowing line work, rich traditional Chinese aesthetic elements, layered ink-wash inspired atmospheric backgrounds, refined silk and fabric textures, soft luminous lighting with gentle haze, sophisticated muted jewel-tone palette, xianxia drama poster quality, consistent character design across shots, avoid flat cel shading, avoid western comic ink style, avoid photorealism, avoid plastic 3D look, avoid modern clothing and props unless specified',
    description: '国风动画/仙侠剧质感，2.5D 半写实',
  },
  {
    name: '韩系网漫', value: 'webtoon', sortOrder: 8,
    prompt: 'Korean webtoon manhwa style, clean digital painting with soft gradient shading, slim elegant character proportions, large expressive eyes with detailed highlights, soft glowing skin rendering, romantic dreamy lighting, modern pastel-to-vivid color palette, detailed fashion and fabric rendering, webtoon key visual quality, consistent character design across shots, avoid heavy black ink outlines, avoid halftone dots, avoid 3D render look, avoid watercolor paper texture, avoid chibi proportions',
    description: '韩国条漫/网漫精致上色风',
  },
  {
    name: '黑白漫画', value: 'noir', sortOrder: 9,
    prompt: 'black and white manga illustration, high-contrast monochrome ink work, dynamic hatching and cross-hatching shading, bold solid blacks with dramatic negative space, screentone gray gradation, expressive confident ink linework, cinematic noir lighting, professional manga page quality, consistent character design across shots, strictly no color, avoid grayscale blur smudging, avoid painterly soft edges, avoid photorealism, avoid 3D render look',
    description: '黑白漫/ Noir 高对比墨水风',
  },
  // 纪录片/历史题材（Issue #32 Q9）：原本只存在于用户本机库，随版本库发布为正式预设
  {
    name: '冷峻档案纪实', value: 'documentary-archival', sortOrder: 10,
    prompt: 'cinematic historical documentary still, 35mm, desaturated cool slate palette with amber highlights, soft overcast daylight, low contrast, subtle film grain, gentle vignette, period-accurate production design, no modern objects, no lettering, no watermark',
    description: '历史纪录片档案质感：35mm 胶片、冷峻低饱和、年代考据美术',
  },
]

/**
 * 旧版种子 prompt（v1 一句话风格描述）— 用于内容寻址升级：
 * 仅当库中行的 prompt 仍等于旧种子值（未被用户在设置页编辑过）才覆盖为新 prompt
 */
const LEGACY_SEED_PROMPTS: Record<string, string> = {
  '3d': '3D CG animation style, game-engine quality render, semi-realistic stylized characters, refined facial features, detailed materials and textures, cinematic lighting, high detail',
  anime: 'Japanese anime style, cel shading, clean crisp line art, vivid saturated colors, expressive character designs, detailed painted backgrounds',
  ghibli: 'Studio Ghibli style, hand-drawn animation, soft watercolor painted backgrounds, warm nostalgic lighting, gentle natural palette, whimsical cozy atmosphere',
  watercolor: 'watercolor illustration style, soft translucent washes, visible paper texture, delicate fluid brushwork, light airy atmosphere, hand-painted storybook feel',
  comic: 'Western comic book style, bold black ink outlines, halftone dot shading, dynamic saturated colors, dramatic contrast lighting, flat graphic novel look',
}

/**
 * 已下架的种子预设 — 内容寻址删除：仅当库中行的 prompt 仍是种子原文
 * （未被用户编辑过）才删除；用户改过的同名行视为用户数据保留。
 * live（真人写实）：真人影像过不了平台真人内容审核，下架。
 */
const REMOVED_SEED_PROMPTS: Record<string, string> = {
  live: 'ultra-realistic cinematic live-action look, professional film photography, natural skin tones with detailed pores and realistic texture, true human anatomy and proportions, shallow depth of field with creamy bokeh, cinematic three-point lighting, subtle film grain, 35mm lens cinematic framing, true-to-life color grading, detailed real-world environments, consistent actor appearance across shots, avoid cartoon or anime features, avoid 3D render look, avoid illustration style, avoid plastic waxy skin, avoid over-smoothing beauty filter',
}

// INSERT ... SELECT WHERE NOT EXISTS → 幂等：只补缺失行，不覆盖用户编辑
// （SQLite 无 FROM DUAL，无 FROM 的 SELECT 合法）
const SEED_SQL = 'INSERT INTO style_presets ("name", "value", "prompt", "description", "sort_order", "is_active", "created_at", "updated_at") SELECT ?, ?, ?, ?, ?, 1, ?, ? WHERE NOT EXISTS (SELECT 1 FROM style_presets WHERE value = ?)'
// 内容寻址升级：命中旧种子原文才更新（用户在设置页改过的行不动）
const UPGRADE_SQL = 'UPDATE style_presets SET "name" = ?, "prompt" = ?, "description" = ?, "sort_order" = ?, "updated_at" = ? WHERE "value" = ? AND "prompt" = ?'
// 内容寻址下架：命中下架种子原文才删除
const REMOVE_SQL = 'DELETE FROM style_presets WHERE "value" = ? AND "prompt" = ?'

export function initSqliteSchema(sqlite: Database.Database) {
  // 目标级绑定表是否已存在：不存在说明是首次升级到 #18，需要一次性继承分镜绑定
  const hadTargetAssets = !!sqlite.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'storyboard_target_assets'",
  ).get()
  // 资产池手选表是否已存在：不存在说明是首次升级到 #43，需要一次性把历史关联与主场景记为手选
  const hadPoolSelections = !!sqlite.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'storyboard_pool_selections'",
  ).get()
  // props.faithful 是否已存在：不存在说明是首次升级到 #47，需要一次性把地图原件标成证据素材
  const hadFaithful = (sqlite.prepare('PRAGMA table_info(props)').all() as { name: string }[])
    .some(col => col.name === 'faithful')
  for (const statement of sqliteSchemaStatements) {
    sqlite.exec(statement)
  }
  applyColumnAdditions(sqlite)
  // 依赖补列的索引：旧库要等 ADD COLUMN 之后才能建
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_sys_task_episode_id ON sys_task (episode_id)')
  // 先迁移（要读 asset_version_selection）再删列
  if (!hadTargetAssets) migrateStoryboardTargetAssets(sqlite)
  if (!hadPoolSelections) migrateStoryboardPoolSelections(sqlite)
  if (!hadFaithful) migrateFaithfulProps(sqlite)
  applyColumnRemovals(sqlite)
  cleanupStaleAssetLinks(sqlite)
  const insertSeed = sqlite.prepare(SEED_SQL)
  const upgradeSeed = sqlite.prepare(UPGRADE_SQL)
  const removeSeed = sqlite.prepare(REMOVE_SQL)
  for (const s of stylePresetSeeds) {
    const ts = new Date().toISOString()
    insertSeed.run(s.name, s.value, s.prompt, s.description, s.sortOrder, ts, ts, s.value)
    const legacyPrompt = LEGACY_SEED_PROMPTS[s.value]
    if (legacyPrompt) {
      const res = upgradeSeed.run(s.name, s.prompt, s.description, s.sortOrder, ts, s.value, legacyPrompt)
      if (res.changes > 0) console.log(`🎨 风格预设「${s.name}」已升级为结构化提示词`)
    }
  }
  for (const [value, prompt] of Object.entries(REMOVED_SEED_PROMPTS)) {
    const res = removeSeed.run(value, prompt)
    if (res.changes > 0) console.log(`🗑️ 风格预设「${value}」已下架`)
  }
}
