# 火宝 HTTP API 核心参考（api-core.md）

> **历史参考（2026-11-02 快照）**：若与 `SKILL.md` 或 `references/api-catalog.md` 冲突，以新文档为准；标 `[S]` 的契约在写入前需重新 GET/预览校验。本文的 `[R]` 只证明 2026-11-02 那一轮真的跑过该调用，**不扩展到之后新增的字段、模式或新链路**；Poster 本地画布上传（§11）已被 Issue #72 的服务端 LayerDoc 渲染取代，见 `SKILL.md` S3。

> 覆盖范围：项目／剧集 CRUD 与剧本、资产（角色／场景／道具）CRUD 与出图、单资产重提取、参考图、史料画像与外貌补写、选角名册、资料检索、资产库／素材库、上传、通用任务、图片／视频队列估计、AI 配置、风格预设、Prompt／技能管理、全局设置与服务器更新。
> 分镜／关键帧／视频／旁白／合成的生产路径见 `SKILL.md` §C–G（另一作者维护，不在本文件展开）。
>
> 依据：huobao-drama 源码扫描 2026-11-02（master）。每节标注来源文件。协议以当前部署为准；本文不含任何凭据或内网上游服务细节。

## 0. 通用约定

- 基址：`HUOBAO_API`（以 `/api/v1` 结尾；路由挂载见 `backend/src/index.ts:93`）。
- 响应包裹：`{code: 200|201, data, message}`（`backend/src/utils/response.ts`）。
  **例外**：`GET /health` 返回裸 JSON `{status:'ok', version?, timestamp}`（`backend/src/index.ts:60-63`），不是 code/data 包裹。
- 错误：400 参数错（`data` 可为 null 或对象）、404 不存在（`notFound`）。`PUT`/`DELETE` 成功多为 `data:null`，只代表落库成功——写后应重新 GET 核对。
- 时间戳：秒级 unix 整数（`now()`）；少数（名册 `updated_at`、检索 `retrieved_at`）为 ISO 字符串。
- 异步约定：`status:'running'` 只表示已受理；同集同类任务在跑时多数入口返回 `already_running:true` 而不重复投单。HTTP 超时后先 GET 状态再决定是否重发。
- `text_model` / `text_config_id`（文本模型覆盖）与 `model` / `config_id`（图像模型覆盖）是常见可选参数；不传时用系统当前启用的配置或集锁定配置。
- **配置响应的输出边界：**任何读取 AI／TTS／服务配置的响应都先在内存中按用途白名单提取字段，再允许进入工具返回、日志、证据或聊天输出；发现 `api_key`、token、secret、认证头、带凭据 URL 或未知敏感字段时，一律不输出原值并立即丢弃原始对象。发现配置时通常只需要 `id,name,model,priority,is_active`；业务调用优先传已获的 `config_id`。此规则也适用于只读 GET，不能因「读取成功」而输出原始配置。
- 标注 **[授权要求]** 的接口具有覆盖性／全局性／破坏性副作用，必须先拿到人的当版明确授权再调用。

## 1. 项目（dramas） — `backend/src/routes/dramas.ts`

### GET /dramas — 项目列表
Query：`page`（默认 1）、`page_size`（默认 20）、`status`（精确匹配）、`keyword`（title 包含）。
data：`{items:[{...drama行(snake), tags:[], total_episodes, episodes:[], characters:[], scenes:[]}], pagination:{page,page_size,total,total_pages}}`。按 updatedAt 倒序，排除软删。

### POST /dramas — 新建项目
Body：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| aspect_ratio | string | ✅ | 枚举 `16:9 / 9:16 / 4:3 / 3:4 / 1:1`，否则 400 |
| title | string | 建议 | 项目名 |
| description / genre / style / metadata | any | ❌ | style 为风格 key（见 GET /style-presets） |
| tags | string[] | ❌ | |

- `status` 固定写 `draft`；**不预建任何集**（dramas.ts:83）。
- 注意：POST **不落** `documentary_rules`（2026-11-02 实测核对，drama 5）；纪录片开关在建项目后用 PUT 补：`PUT /dramas/{id} {"documentary_rules":"on"}`。
- 响应 201，`data` = 新项目整行（`data.id` 即 drama_id）。
- 发现入口：建项目前用 `GET /style-presets` 取 style key；建集前用 `GET /ai-configs?service_type=image|video|tts` 确认已有启用配置。该响应**按机密处理**：仅在内存中白名单提取 `id,name,model,priority,is_active`，立即丢弃原始响应；不得记录、展示或保存其中可能返回的 `api_key`。完整安全规则见 §14。

### GET /dramas/stats — 按状态计数
data：`{total, by_status:[{status,count}]}`。

### GET /dramas/:id — 项目详情
data：drama 行 + `genre_ruleset`（documentary_rules 显式开关优先，否则按 genre 关键字归一，dramas.ts:128）+ `tags` + `episodes` + `characters/scenes/props`（各带 `image_generated_at`，由 sys_task 反查，查不到为 null）。**不存在 `GET /episodes/:id` 的单集详情路由**；要读某集标题、设置或 Poster 以外的集行，先 GET 此端点，再从 `data.episodes[]` 以 id／episode_number 精确定位。2026-11-02 运行中错误调用该不存在路由返回非 JSON，以上替代读法已实测。
404 `剧本不存在`（含软删）。

### PUT /dramas/:id — 修改项目
可选字段：`title, description, genre, style, aspect_ratio(同枚举), status, tags, metadata, documentary_rules`（`auto|on|off|null`，非法 400）。
**副作用**：`style` 变更（≠现值）会把本项目全部角色/场景/道具的 `final_prompt` 清空（dramas.ts:165-168），下次出图按新风格重写——属于全项目失效传播，改前保存快照。响应 `data:null`。`documentary_rules` 显式 `off` 覆盖 genre 的自动纪录片判定；现代科学／当代解释片不因 genre 含“纪录片”而自动采用历史 addendum 或历史 style。是否切换 `style`／`documentary_rules` 仍是人授权的项目级决定；2026-11-02 运行已确认将二者设为 `style:""`、`documentary_rules:"off"` 后，genre 不变且旧 `final_prompt` 失效。

### DELETE /dramas/:id — 软删项目 **[授权要求]**
只写 deletedAt；子资源行保留但多数入口不可见。幂等，无 404 检查。

### POST /dramas/:id/assets/import — 跨项目全量复制资产 **[授权要求·写]**
Body：`{kind:'character|scene|prop', source_id:<源资产id>, name?（重命名，同名冲突时必填）, episode_id?（复制后同时关联到该集）}`。
全深拷贝：文本字段 + 当前图 + 全部历史版本 + 参考图 → 新行/新文件，源与副本此后互不影响（dramas.ts:180-211）。
- 400 且 `data:{suggestion}`：目标项目同名冲突，`suggestion` 为建议名（如 `名字-2`）。
- 404：源或目标不存在。IO 失败自动回滚并返回 500 文案。
- 成功 data（ImportResult，asset-library.ts:461-470）：`{kind, id(新资产id), name, version_count, skipped_versions(外部 http 地址、无法本地复制的版本数), skipped_reference_images, has_image, linked_episode_id(未传 episode_id 时 null)}`。

### 资产批量生成（Issue #33）
四入口共用，`scope: 'characters'|'scenes'|'props'|'all'`（all 顺序 角色→场景→道具）。

- **POST /dramas/:id/assets/batch-generate/preview**（不落库）
  Body：`{scope, episode_id(必填,正整数), rewrite_prompts:false, overwrite_images:false, text_model?, text_config_id?, model?, config_id?}`
  data：分类统计 + `running`（当前在跑的批次或 null）。
  选择语义：默认跳过「已有图」（`skip_has_image`）、「在跑」（`skip_running`）、「faithful 素材」（`skip_faithful`，永不重绘）；勾选 `overwrite_images` 才重出已有图；勾选 `rewrite_prompts` 才强制重写提示词。**资产本身挂项目，episode_id 只是提示词上下文**——批量按项目选集。
- **POST /dramas/:id/assets/batch-generate** **[授权要求·批量写]**：同 preview 正文（应保持一致）。同项目同时只允许一个批次（已在跑 → 400）。语义 = 先保证提示词、提示词一好即提交图像任务；提示词阶段 failed 的资产不出图也不兜底。
- **GET /dramas/:id/assets/batch-generate**：最近一次批次状态（刷新后仍可查）。data（`services/asset-batch.ts`）：
  `{id, drama_id, episode_id, scope, status:'running|completed|failed|cancelled', cancel_requested, options:{rewrite_prompts,overwrite_images}, counts:{total, skipped:{has_image,running,faithful}, prompt:{done,failed,reused,regenerated,unchanged_after_rewrite}, image:{submitted,done,failed}}, items:[{kind,asset_id,name,selection,state:'pending|prompting|submitted|completed|failed|cancelled|skip_*',prompt_outcome,task_id,error}], created_at, updated_at, error}`。
  重按启动按钮 = 重试（默认跳过已完成项）。
- **POST /dramas/:id/assets/batch-generate/cancel**：停止派发并撤销已提交的图像任务。

### PUT /dramas/:id/characters — 批量保存角色
Body：`{characters:[<整行或新行>]}`。有 `id` 更新、无 `id` 插入（自动补 dramaId）。名字先整批规范化，任何一条为空则**整批都不写**（400）。`reference_images` 字段被显式剔除——参考图只由 `/characters/:id/reference-images` 维护。响应 `data:null`。

### PUT /dramas/:id/episodes — 批量保存集
Body：`{episodes:[...]}`；新行缺省 `episode_number=1`（注意：不是自动递增，普通创建集请走 POST /episodes）、`title='未命名'`。响应 `data:null`。

## 2. 剧集（episodes） — `backend/src/routes/episodes.ts`

**详情读取陷阱**：本组没有 `GET /episodes/:id`。通过 `GET /dramas/{drama_id}` 的 `data.episodes[]` 读集行；本组其余 `/episodes/:id/...` 路由仅为本节及 production reference 明列的子资源／动作路由，不能推导出单集详情 GET。

### POST /episodes — 新建集
Body：

| 字段 | 必填 | 说明 |
|---|---|---|
| drama_id | ✅ | |
| title | ❌ | 缺省 `第N集` |
| resolution | ❌ | `480p|720p|1080p`，默认 `720p` |
| image_config_id / video_config_id | ❌ | 缺省自动锁定当前启用的最高优先级官方配置 |
| tts_config_id | ❌ | 缺省取启用 TTS 配置；没有则留空（不阻断） |

**前置条件**：必须存在启用的 image 配置与 video 配置各一，否则 400（「未找到启用的图片生成配置…」）。
`episode_number` 自动 = 未删集最大号 +1（中间删号可复用空位之后的值）。**响应 code 为 200**（`success` 包裹，2026-11-02 实测核对；与 POST /dramas 的 201 不同），data：`{id, episode_number, title, image_config_id, video_config_id, resolution}`。

### PUT /episodes/:id — 修改集字段
**白名单键**（其余键忽略；空 body → 400「没有可更新的字段」）：
`content`（原始文本）、`script_content`（AI 改写稿）、`title`、`description`、`status`、`resolution`(枚举)、`narration_enabled`(bool)、`tts_config_id`(null=清除)、`subtitle_timing`(`sentence|char`)、`audio_mix_mode`(`replace|mix`)、`audio_bed_gain_db`(number|null)、`narration_fit_default`(对象或 JSON 串，须过 fit 校验)、`narration_spine`(空白串→null)、`narration_normalize`(bool)。
最小原始内容导入例：`PUT /episodes/12 {"content":"<原文>"}`。响应 `data:null`。

**阶段授权约束**：上面的白名单只是接口能力，不是同时填写两步的授权。第一步只导入 `content`；用户要求等待时就停下。第二步 AI 改写必须在获准后由火宝生成保存：**纪录片走 `POST /episodes/:id/script-rewrite` 流水线**（旧 `POST /agent/script_rewriter/chat` 对纪录片直接 400），剧情项目走 `POST /agent/script_rewriter/chat {drama_id,episode_id,message}`；不得助手自写后 PUT `script_content` 冒充生成。人工改已有稿/导入用户定稿须另有明确指令，详见主技能 S1 与错误案例 §4.5。用户已要求停止业务操作、仅更新技能时，不调用火宝核对或回滚。

### DELETE /episodes/:id — 软删集 **[授权要求]**
分镜/生成记录保留但不可达；404 检查存在性。

### 本集资产读取与关联
- `GET /episodes/:id/characters|scenes|props`：本集已关联资产；每行附 `image_versions:[{id,url,provider,model,is_current,generated_at,…}]`（`services/asset-library.ts:181`）与 `image_generated_at`；角色另附 `styling_version`（本集造型，无则 null）。
- **POST /episodes/:id/assets/link** `{kind, asset_id}`：把本项目资产关联到本集（幂等）。data：`{linked:bool, kind, asset_id, episode_id}`；本集已有同名资产 → 400（提示用导入改名）；集或资产不存在 → 404。
- **DELETE /episodes/:id/assets/link?kind=&asset_id=**：取消关联（不删资产，幂等）。

### POST /episodes/:id/extract — 整集异步提取
Body：`{target:'characters|scenes|props', model?, config_id?}`（target 非法 400，集不存在 404）。
立即返回 `{target, status:'running', already_running}`；同集同类型并行允许一个，重复请求 `already_running:true`。**[授权要求]**：提取会写资产表（复用去重、只补空白字段）。
- `GET /episodes/:id/extract-status`：`{characters:…, scenes:…, props:…}`，每类为 `ExtractTask | null`（未启动为 null）。ExtractTask（extraction.ts:30-35）精确为 `{status:'running'|'done'|'error', started_at(ISO), finished_at?(ISO), error?}`——status 由 sys_task 行状态映射，error 为失败原因文案。
- **纪录片顺序与地图归属（Issue #93）**：纪录片项目的整集道具提取在开始调用模型前，会等同一集正在进行的场景提取结束（等待期间任务仍为 `queued`，`params.progress={step:'waiting_scenes', waiting_task_id}`）；三个 target 按 角色 → 场景 → 道具 依次 POST 即可，不必等前一个完成。地图（`asset_type:'map'` 的道具）由**场景提取**保存，道具提取只保存非地图道具；越界条目在 `save_dedup_props` 返回值 `rejected[{name,reason}]` 中列出、不落库。单资产重提取（`re-extract`、审核清单补提取）与剧情项目不受此约束。背景：Issue #93 实验中三类并行时道具提取漏掉旁白点名的器物（号炮），且「地点单独建场景还是进地图」若分在两次运行里判断会互相推诿。

### 选角名册（纪录片规则集，Issue #32）
- `GET /episodes/:id/character-roster`：`{cast:[{name,basis,reason,source:'agent|human'}]|null, exists, status:'draft'|'approved'|null, stale, script_hash, current_hash, updated_at}`。`cast:null` = 从未生成（区别于空名册）；`stale:true` = 剧本在复核后已改动，名册过期。
- **PUT /episodes/:id/character-roster** **[授权要求·人审动作]**：Body `{cast:[{name(必填非空), basis?, reason?, source?}], status?:'draft'|'approved'(缺省按 approved 保存！), expected_hash?}`。
  - 逐条校验 name（空白与 `\ / : * ? " < > | @` 自动替换 `_` 后须非空）；`basis/reason/source` 若传须为字符串。
  - `expected_hash` ≠ `current_hash` → 400（剧本已变，须重新打开复核）。**必须回传 GET 得到的 current_hash**。
  - 保存后以当前剧本重盖指纹；人保存的成员标 `source='human'`。**缺省 status=approved 意味着「保存即确认」，不能当草稿随手存。**

### GET /episodes/:id/pipeline-status — 流水线进度（只读）
data：`{episode_id, steps:{script_rewrite, extract_characters, extract_scenes, extract_storyboards, generate_images, generate_videos, merge_episode}}`，各步 `{status:'done|partial|pending'|<merge任务状态>, count/completed/total?, merged_url?}`。仅覆盖计数，不代表内容验收。

（`/episodes/:id/storyboards`、`/generate-video-prompts`、`/video-prompts-status`、`/generate-narration`、`/narration-*`、`/tts-options`、`/compose-batch*`、`/video-batch*`、`/generate-keyframe-prompts`、`/keyframe-*` 属分镜/关键帧/视频/旁白/合成生产路径，由 **api-production.md**（同级 `references/api-production.md`）主维护；本文件不重复展开，避免两份文档漂移。）

## 3. 资产：角色 — `backend/src/routes/characters.ts`

字段名统一 snake_case（`image_url/local_path/final_prompt` 等）。名字规范化：`normalizeAssetName` 去首尾空白并把 `\ / : * ? " < > | @` 替换 `_`；空名 400。

### POST /characters — 手动新增
`{drama_id✅, name✅(规范化后非空), role?, description?, appearance?, styling?, episode_id?（同时关联该集）}` → 201 整行。

### PUT /characters/:id — 更新
可写字段：`name, role, description, appearance, styling, image_url, local_path, final_prompt`（手写最终提示词以传入为准）。不传 `final_prompt` 时，appearance/styling/description 值变化会**作废旧 final_prompt**（Issue #24 失效传播）。响应 data = 更新后整行。角色不存在 400（本路由用 badRequest 而非 404）。

### DELETE /characters/:id — 软删 **[授权要求]**
同时清理参考图文件、集关联与分镜绑定（避免已删角色继续被提取/@引用看到）。

### POST /characters/:id/generate-prompt — 生成三视图最终提示词（同步）
`{episode_id✅, force?(true=强制重写), text_model?, text_config_id?}` → data `{final_prompt}`。不传 force 且库中提示词有效时正常复用；本次确有不同的新稿时返回新稿。force 后逐字未变属于 `unchanged_after_rewrite`，**单发路由的 savedPromptOf 不接受该状态，返回 400**，不得当成已生成新稿或盲目重试。批量 `prompt_outcome` 会区分 `reused/regenerated/unchanged_after_rewrite/failed`，其中 unchanged 可继续批量出图（`asset-batch-select.ts:shouldSubmitImage`）；不要把单发和批量行为混为一谈。

### POST /characters/:id/generate-image — 出角色定妆图（异步）
`{episode_id✅, model?, config_id?(缺省=集锁定 image 配置), text_model?, text_config_id?, reference_images?}`。
- `reference_images` 缺省用角色自己保存的参考图；**显式传（含空数组）则以请求为准**；文件缺失的项分到 `missing_reference_images` 并告警不阻断。
- 固定尺寸 1920x1080。有参考图时走 image_edit（构图跟随第 1 张）。
- data：`{image_generation_id, reference_images, missing_reference_images}`。轮询：`GET /tasks/{image_generation_id}` 或 `/tasks/active`；完成后 `writeBackImageAssets` 自动把 `image_url` 写回该角色（`services/generation.ts:763`）并产生一条版本历史。

### PUT /characters/:id/styling-version — 保存本集造型文字
`{episode_id✅, name✅(非空), description?, image_path?}` → data `{styling_version}`。角色未关联本集 → 400。

### POST /characters/:id/styling-version/generate-image — 出本集造型图（异步）
`{episode_id✅, name?, description?, model?, config_id?}`。缺省沿用已存造型版本；会先把 name/description 落库。硬前置：角色已关联本集 + 角色已有基础形象图（否则 400）。image_edit：基础形象图为唯一参考，保持身份只换装。data `{image_generation_id, styling_version}`。

### 史料画像（Issue #32）
- **POST /characters/:id/archival-images** `{file_title✅}`（Commons 的 `File:` 标题）：服务端按白名单拉取落库，**不进生图链路**（角色有 reference_images 会走 image_edit，画像会顶掉三视图构图——因此画像绝不写 reference_images）。上限 10 张、25MB。data：完整画像数组，每条 `{path, file_title, source_page_url, file_url, artist, work_date, license, license_url, retrieved_at}`（ISO）。
- **DELETE /characters/:id/archival-images?path=<相对路径>**：删一张（path 必须是已保存的该角色画像路径）。
- **POST /characters/:id/appearance-from-portrait** `{episode_id✅, text_config_id?}` **[授权要求·写 appearance]**：按画像补写外貌（只写 appearance 并作废旧 final_prompt）。未启动原因 → 400（`running` 或角色无画像）。成功 data：`{started:true, task_id, vision:{used,config_name?,model?}, portraits}`。
- `GET /characters/:id/appearance-from-portrait?episode_id=`（episode_id 可选，缺省取该角色最近一次任务）：`{status:'running|done|error'|null, source:'vision'|'text'|null, model, appearance, error, updated_at}`。

## 4. 资产：场景 — `backend/src/routes/scenes.ts`

### POST /scenes
`{drama_id✅, location✅(名字口径是 location 不是 name), time?, prompt?|description?|location?(缺省), lighting?, episode_id?}` → 201 整行（注意本路由返回原始行，键为 camelCase `imageUrl` 等——以响应为准）。

### PUT /scenes/:id
可写：`location, prompt, description(别名→prompt), lighting, time, image_url/imageUrl(直传图，非空同时置 status='completed'), local_path/localPath, final_prompt`。
**场景时间不变量（Issue #21）**：final_prompt 必须引用 time；改 time/画面字段会让旧提示词失效。time/final_prompt 的合法性由 `planSceneTimePatch` 裁决，可能 400。响应 data = 更新后整行（snake）。纠正既有场景的时段／光线时，快照后只传必要键，例如 `PUT /scenes/{id} {"time":"室内恒定灯光","lighting":"恒定顶灯中性白光，亮度稳定"}`；重新 GET 后再 `POST /scenes/{id}/generate-prompt {"episode_id":e,"force":true}`。不要为此使用 `re-extract`：它不会把旧场景的 `time` 自动协调为修订剧本，且会清空提取字段。**[R]** 此窄 PUT → 强制改 Prompt → generate-image 链路已实际跑通并下载图像；它只证明接口、失效与媒体回写闭环，图像科学／视觉质量另由独立审查决定。

### POST /scenes/:id/generate-prompt — 同角色语义（`{episode_id✅, force?, text_model?, text_config_id?}` → `{final_prompt}`）。单发只接受 reused/regenerated；force 后未变仍返回 400，批量单列 unchanged_after_rewrite 的规则见 §3。场景稿未覆盖 time 也属失败。
### POST /scenes/:id/generate-image — 同角色语义；尺寸走适配器默认；受理时置 `status='processing'`，失败置 `'failed'`；完成自动回写 `image_url` + `status='completed'`。无人物约束兜底：回退拼接会追加「画面中没有任何人物…」。**[R]** 受理、轮询完成、媒体下载均已验证；首次生成可能不符合内容要求，不能由 completed/status 推定正确。

### DELETE /scenes/:id — 软删 + 清理参考图与关联，同角色。

## 5. 资产：道具 — `backend/src/routes/props.ts`

### POST /props
`{drama_id✅, name✅, type?, description?, episode_id?}` → 201 整行（snake）。**[R]** 可创建并在同请求关联本集的独立可绑定道具；用于跨镜可见但尚无资产锚点的物件时，仍须后续生成／审图。

### PUT /props/:id
可写：`name, type, description, image_url/imageUrl, local_path/localPath, final_prompt`；name/type/description 变化作废旧 final_prompt（同 Issue #24）。响应 data = 更新后整行。**[R]** 有既存 final_prompt 时，对 description 的窄编辑会使其变为 null；保存前后仅比较授权字段，再以 force 生成新 Prompt。

### POST /props/:id/generate-prompt、/generate-image — 同角色语义（复用 vs `force` 重写的口径见 §3，`force` 后文本不变也是成功）；固定尺寸 1024x1024 白底单品；完成自动回写 `image_url`。**[R]** 已实测 `generate-prompt {episode_id,force,text_model,text_config_id}` 后提交 image、轮询并下载当前图；任务受理或 completed 不代表首版几何／科学内容正确，保留失败版作为证据并在授权下修订资产文本后重走该链路。

### DELETE /props/:id — 软删 + 清理，同角色。

## 6. 单资产重提取 — `backend/src/routes/asset-reextract.ts`（挂在 /characters|scenes|props/:id/re-extract）

**POST /characters|scenes|props/:id/re-extract** `{episode_id✅, text_model?, text_config_id?}` **[授权要求·先清空再提取]**
- 行为：先**清空该资产提取字段**（角色 role/description/appearance/styling；场景 prompt/lighting；道具 type/description）与 final_prompt 三件套，再跑指名提取。清空即旧提示词失效。
- 同集同类提取任务在跑 → 400（先检查再清空，避免清成空壳）。竞态兜底也会 400。
- data：`{started:true, asset_id, cleared_fields:[...]}`。结果由提取 Agent 异步写回（see §2 extract-status）。**不用于对账修复**既有场景 `time` 或少数人工字段：该 Agent 只会按当前脚本重新补提，不能保证撤销／协调旧键；这类修复用 §4 的窄 PUT + force 生成提示词。

## 7. 参考图 — `backend/src/routes/reference-images.ts`（三类资产同构）

存储：`static/uploads/reference_images/{kind}/{assetId}/{uuid}.{ext}`；库内表示 `[{path, uploaded_at(unix秒|null), copied_from?}]`；**与成片图 image_url 严格分离**。

- **POST /characters|scenes|props/:id/reference-images** — multipart `file=<图片>`（jpg/png/webp/gif…按扩展名+MIME 双校验）。上限张数（超限 400）。data：`{reference_images:[最新数组]}`。
- **POST …/:id/reference-images/from-library** `{urls:[库内图片 url]}`：从素材库复制为参考图（新 uuid）。data：`{reference_images, added, skipped}`。
- **DELETE …/:id/reference-images?url=<已保存相对路径>`：删一张。url 不存在 404。data 同上。
- 资产不存在 → 404。

## 8. 资料检索 — `backend/src/routes/research.ts`（Issue #32）

- **GET /research/commons/search?q=&limit=**：Commons 画像检索（q 必填；limit 缺省 RESEARCH_MAX_RESULTS 并封顶）。只接受检索词，不接受任意 URL（防 SSRF）。data：`{query, results:[CommonsFile], retrieved_at}`；CommonsFile（wiki-research.ts:199-211）精确为 `{file_title, thumb_url, file_url, source_page_url, artist, work_date, license, license_url, mime, width, height}`。服务不可用 → 400。
- **GET /research/citations?asset_kind=character|scene|prop&asset_id=**：某资产「资料来源」记录列表（source 不进生图正文）。任一参数非法 400。

## 9. 资产库（跨项目浏览/导入） — `backend/src/routes/asset-library.ts`

- **GET /asset-library?drama_id=&kind=&q=&target_drama_id=**：可浏览资产列表（省略 drama_id = 全部项目；keyword 模糊）。`target_drama_id` 附带 `taken_names:{character:[],scene:[],prop:[]}`（目标项目已占名，用于改名预填）。data 另含 `dramas:[{id,title,asset_count}]` 与 `items`。
- **GET /asset-library/:kind/:id**：单资产详情 = 文本字段（角色 role/description/appearance/styling/personality/final_prompt；场景 time/prompt/lighting/final_prompt；道具 type/description/prompt/final_prompt）+ 全部历史版本 + 参考图 + 所属剧集。
- **GET /asset-library/suggest-name?drama_id=&kind=&name=**：同名冲突建议（`名字-2` 递增）。data `{name, taken:[...]}`。

## 10. 素材管理器 — `backend/src/routes/media-library.ts`

- **GET /media-library/dramas**：项目列表（含图片计数）。
- **GET /media-library/tree?drama_id=**：单项目浏览树（懒加载第二层）。
- **GET /media-library/images?drama_id=&episode_id=(数字或 `unassigned`)&kind=character|scene|prop|storyboard&owner_id=&slot=first_frame|mid_frame|last_frame&page=&page_size=(≤200,默认60)**：分页图片列表。每条：`{path, url, thumb_url, drama_id, drama_title, episode_ids, kind, owner_id, owner_name, slot, source:'version'|…, version_index, generated_at, provider, model, source_label}`（`services/media-library.ts`）。
- **POST /media-library/copy** `{url}`：复制库内图片（新 uuid，落 static/images），返回 `{url, path, copied_from}`，结构同 /upload/image。白名单校验：库外路径 403（不在素材库内）。任务无资产归属（storyboard/asset 槽位）的图片不出现在库里。

## 11. 上传 — `backend/src/routes/upload.ts`（均 multipart `file=`）

- **POST /upload/image**：任意图片。data：`{url:'/static/uploads/…', path}`（同步生成缩略图）。**[R]** 2026-11-02 的实测形状来自当时的 Poster 画布上传；**该 Poster 用法已被 Issue #72 取代**（编辑工程改 `layer_doc`，合成图由 `POST /episodes/:id/poster/versions` 服务端渲染），本端点本身仍可用于一般图片上传，凡引用已保存图片的接口一律传 `path`，不传根绝对 `url`。
- **POST /upload/video**：`.mp4/.mov/.webm/.m4v`，≤50MB。
- **POST /upload/audio**：`.mp3/.wav/.m4a/.aac`，≤20MB。
上传只落文件；要把上传图登记为某资产当前图/版本用 **POST /tasks/register-upload**（见 §12）。MIME 可伪造，扩展名为准。

## 12. 通用任务 — `backend/src/routes/tasks.ts`

- **GET /tasks/active**：全部活跃任务（扁平，含批次子任务与文本任务）+ 顶层活跃计数。开工必查。
- **GET /tasks/center?drama_id=&episode_id=&type=image|video|text&status=active|completed|failed|cancelled&scope=all|recent&page=&page_size=**：全局任务中心（含批次父行与导出行，分页）。
- **GET /tasks/:id**：任务详情；文本任务额外带 `output_text` 全文。轮询主入口。
- **GET /tasks?type=&storyboard_id=&drama_id=&character_id=&scene_id=&prop_id=**：按归属过滤。
- **GET /tasks/:id/reasoning?tail=&offset=**：仅文本任务的思考内容（tail 默认 4096 字符；offset+tail 取区间）。
- **POST /tasks** — 通用生成入口（body.type: `image|video`）**[授权要求]**：
  - image：`{type:'image', prompt✅, model?, config_id?, size?, reference_images?, frame_type?, storyboard_id?, episode_id?, drama_id?, scene_id?, character_id?}`；storyboard_id 存在且未传 config_id 时回退集锁定 image 配置。
  - video：zod 校验，字段 `prompt, model, image_url, first_frame_url, mid_frame_url+mid_frame_time(必须成对), last_frame_url, reference_image_urls(≤9), reference_video_urls(≤3), reference_audio_urls(≤3,且需至少一个图/视频参考), generate_audio, duration, aspect_ratio, resolution, seed, prompt_extend, watermark`。校验规则：中间帧与时间必须同时提供；参考音频需 ≥1 图/视频参考；完全无参考且空 prompt 400。视频 prompt 前自动注入项目风格词。model 必须属于生效配置（否则 400）。
  - 响应 201 = 新 sys_task 行（serializeTask：snake，含 `remote_state` 解析结果与 `cancellable`；不含 request/config_id/idempotency_key/cancel_pending）。
- **POST /tasks/register-upload** `{asset_type:'character|scene|prop', asset_id, local_path(须 static/ 前缀), source?:'media-library', copied_from?}`：把上传/库选图登记为资产当前图并纳入版本历史（写 image_url/local_path，场景另置 status='completed'）。data：`{id, local_path}`。
- **POST /tasks/:id/retry** `{config_id?, model?}` **[授权要求]**：一律新建任务（提示词不可改），可能覆盖下游产物。响应 201 新任务。
- **POST /tasks/:id/cancel** **[授权要求]**：qwen-jobs 图片任务与 h3-jobs 视频任务（Issue #100）支持；排队中立即取消，运行中先 `cancel_requested` 再由服务端收尾；取消后不写回结果。其它供应商 400。
- **DELETE /tasks/:id** **[授权要求·删记录]**：丢弃任务行；qwen-jobs / h3-jobs 远端任务一并取消并清理文件。

## 13. 队列估计

### 图片 — GET /image-queue/estimate?config_id=&size=WxH&references=&count= — `backend/src/routes/imageQueue.ts`
仅 qwen-jobs 类配置支持（其它返回 `{supported:false}`）。模式推导：无参考=text_to_image；有参考+指定画幅=reference_to_image（关键帧）；只有参考=image_edit（FLUX 配置按 reference_to_image 1024²）。
data：`{supported:true, per_image_seconds, basis, queue_wait_seconds, online_workers, total_seconds(=queue_wait+⌈count/在线卡⌉×单张；卡全离线为 null)}`。

### 视频 — GET /video-queue/estimate?config_id=&model=&duration=[&resolution=&aspect=&references=] — `backend/src/routes/videoQueue.ts`
`duration`（秒）必为正数。本地样本 provider（comfyui/minimax）：样本 = 近 30 天本机 completed 视频任务墙钟耗时；model 必须属于该配置的模型列表，否则回退首个。
data（VideoEstimate，video-estimate.ts:21-30）精确为 `{supported, provider, requested_model, source_model(借同 provider 其它模型样本时非 null), duration, run_seconds(中位数估计；无样本 null), samples, basis:'model-duration'|'model-scaled'|'fallback-model'|'none'}`。
`h3-jobs` 队列配置（Issue #100）改由队列估计：额外字段 `duration_key, queue_wait_seconds, estimated_finish_seconds`，`basis:'measured'|'scaled'|'default'`；`duration` 为提交口径（4–15 整数秒）。队列不可达 `supported:false`。

### 视频队列概览 — GET /video-queue/overview?config_id= — `backend/src/routes/videoQueue.ts`
仅 h3-jobs 配置可用：`{available, counts{running,queued}, workers{total,idle,busy,offline}, estimated_wait_seconds, mine{running[],queued[]}}`（`mine` 条目附 `sys_task_id/storyboard_id`）；否则 `{available:false, reason}`。

### 存储位置 — GET /storage — `backend/src/routes/storage.ts`（挂载 index.ts:86，只读）
无参数。设置页「存储位置」卡片数据源。data：
`{mode:'desktop'|'server'`（env `HUOBAO_DESKTOP=1` → desktop）`, dataDir, storageRoot, sqlitePath`（服务器路径，仅诊断展示，不据此写文件）`, usage:{db, images, videos, merged, uploads, temp, other, total}`（字节，按用途分桶；db 桶=sqlite 主库+wal+shm，utils/dirsize.ts:12-21）`, usageStale`（占用计算重：60s TTL + stale-while-revalidate，过期先回旧值后台重算，true=旧值/在算）`, computedAt(ISO|null), freeBytes(卷剩余字节|null)}`。
示例：`GET /storage` → `{"code":200,"data":{"mode":"server","dataDir":"…/data","storageRoot":"…/data/static","sqlitePath":"…/huobao.sqlite3","usage":{"db":1048576,"images":…,"videos":…,"merged":0,"uploads":…,"temp":0,"other":…,"total":…},"usageStale":false,"computedAt":"2026-11-02T…Z","freeBytes":…}}`。

## 14. AI 配置 — `backend/src/routes/aiConfigs.ts`（全局管理，**[授权要求]** 写操作）

- **GET /ai-configs?service_type=text|image|video|tts**：配置列表；通常需读取 `id, service_type, provider, name, base_url, model:[...], priority, is_active, temperature?` 与 `tts_settings?(仅tts)`。**安全更正 [R]：实际运行的 GET 响应包含 `api_key` 字段，与原先“不会回传”的源码说明相反。** 调用封装器必须在**产生任何日志、证据、聊天输出或返回对象之前**，只构造允许字段的安全对象（发现配置时至少 `id,name,model,priority,is_active`）；不得先保留原响应再做落盘脱敏。原始响应、`api_key`、带密钥 URL、认证头及其原值均不得离开内存。该服务缺口已报告给维护方；读取仍是只读，不授权配置写入。
- **GET /ai-configs/:id** / **PUT /ai-configs/:id**：详情／更新（service_type, provider(须官方组合), name, base_url, api_key, model, priority, is_active, temperature(0~2,null=清除), tts_settings{voice,instructions,cfg_value,inference_timesteps,seed}——省略/置空键=清除；tts 配置必须带 voice）。详情响应同样按机密处理。
- **POST /ai-configs**：同上创建，`service_type+provider` 必填且须官方组合，模型须过校验；新建默认 `is_active:true`。
- **DELETE /ai-configs/:id**：硬删。
- **POST /ai-configs/test**：连通性探针（按 provider 构造最小探测请求；`reachable` 含 400/401/403——端点有响应即算可达，认证对不对看 status）。
- **GET /ai-configs/tts-voices?config_id= | ?base_url=&api_key=**：TTS 音色列表 `{voices:[...]}`（程序不得自动取第一个音色）。优先 `config_id`；若人明确授权临时 `base_url/api_key` 查询，绝不把带 key 的 URL 写进请求日志或证据。
- **GET /ai-providers**：官方 provider 预设（含 preset_models）。

## 15. 风格预设 — `backend/src/routes/stylePresets.ts`（全局，**[授权要求]** 写操作）

- **GET /style-presets**（默认仅启用项；`?all=1` 全部）：按 sort_order 排序的 `{id,name,value,prompt,description,sort_order,is_active}`。
- **POST /style-presets**：`{name✅, value✅(小写字母/数字/中划线,唯一), prompt✅, description?, sort_order?, is_active?(默认true)}`。
- **PUT /style-presets/:id**：name/prompt/description/sort_order/is_active 可改；**value 创建后不可改**。
- **DELETE /style-presets/:id**：硬删（已用项目保留 key，无害）。
- 项目换 style（PUT /dramas/:id）触发全项目 final_prompt 清空，见 §1。

## 16. Agent Prompt 管理 — `backend/src/routes/prompts.ts`（全局，**[授权要求]** 写操作）

文件 jail 在 `backend/workspace/prompts/`；`?lang=zh|en|ja|ko`（zh/缺省=基础版）。
- **GET /prompts**：各 Agent `{agent_type, name, model, is_default}`。
- **GET /prompts/:type?lang=**：`{agent_type, lang, name, model, system_prompt, is_default}`（变体缺失回退基础版并标 `is_default:true`）。
- **PUT /prompts/:type?lang=**：`{system_prompt✅(非空), name?, model?(仅基础版保存), lang?}`。
- **POST /prompts/:type/reset?lang=**：删对应语言文件回退默认。
本技能默认只读；缺陷走火宝维护任务（SKILL.md §2）。

## 17. 技能管理 — `backend/src/routes/skills.ts`（全局，**[授权要求]** 写操作）

文件 jail 在 `backend/workspace/skills/`；语言变体 `SKILL.<lang>.md`。
- **GET /skills?lang=**：`[{id(相对路径), name, description}]`（经 Workspace 原生发现）。
- **GET /skills/{完整技能路径}?lang=**：`{id, lang, content(raw含frontmatter), is_default}`；不存在 400。
- **PUT /skills/{id}?lang=**：`{content}` 写文件（基础版变更后自动刷新技能缓存）。
- **POST /skills**：`{id(每段仅 [a-z0-9-]), description?}` 新建目录+模板。
- **DELETE /skills/{id}**：递归删目录。
本技能默认只读。

## 18. 全局设置 — `backend/src/routes/settings.ts`（**[授权要求]** 写操作）

- **GET/PUT /settings/content-language**：AI 内容语言 `{language:'zh|en|ja|ko'}`（PUT 校验枚举，非法 400；data `{language}`）。**路径带 `/settings` 前缀**（挂载 index.ts:87）；裸 `/content-language` 会落到 SPA 返回 HTML，不是 API。
- **GET/PUT /settings/tours-seen**：UI 引导漫游已读 id `{seen:string[]}`（PUT 须字符串数组；纯前端状态，一般不动）。

## 19. 服务器更新 — `backend/src/routes/serverUpdate.ts`（**[授权要求·管理员]**）

- **GET /server-update/state**：当前版本 + 更新模式 + 上次检查结果。
- **POST /server-update/check**：拉发布清单比较版本。
- **POST /server-update/apply**：触发 Watchtower 拉新镜像并**重建本容器**（仅 watchtower 模式；服务会中断）。本技能不执行。

## 20. 最小可用序列（角色资产示例）

# 建项目：历史纪录片（人已决定采用历史附加规则时）
POST /dramas {"title":"示例","genre":"纪录片","aspect_ratio":"16:9"}
PUT  /dramas/{d} {"documentary_rules":"on"}
# 现代科学／当代解释片：不要因 genre 自动继承历史附加规则；经人授权可改为
PUT  /dramas/{d} {"style":"","documentary_rules":"off"}
# 建集（前置：已有启用的 image/video 配置）
POST /episodes {"drama_id":d,"resolution":"720p"}
PUT  /episodes/{e} {"content":"<原始文本>"}
# 提取 + 轮询
POST /episodes/{e}/extract {"target":"characters"}
GET  /episodes/{e}/extract-status
GET  /episodes/{e}/characters
# 单角色出图：先提示词后图，图异步
POST /characters/{id}/generate-prompt {"episode_id":e}
POST /characters/{id}/generate-image  {"episode_id":e}
GET  /tasks/active   # 完成 writeBack 自动更新 characters.image_url
```

典型编辑示例（只改一个字段）：
`PUT /characters/7 {"appearance":"中年，方脸，短须，深目"}` —— 不带 `final_prompt`，旧 final_prompt 因来源变化被作废；随后 `POST /characters/7/generate-prompt {"episode_id":3,"force":true}` 重写。

## 21. 来源索引

dramas.ts、episodes.ts、characters.ts、scenes.ts、props.ts、asset-reextract.ts、reference-images.ts、research.ts、asset-library.ts、media-library.ts、upload.ts、tasks.ts、imageQueue.ts、videoQueue.ts、aiConfigs.ts、stylePresets.ts、prompts.ts、skills.ts、settings.ts、serverUpdate.ts（均在 `backend/src/routes/`）；服务实现 `backend/src/services/{asset-batch,extraction,character-roster,archival-images,portrait-appearance,reference-images,asset-library,media-library,research-citations,wiki-research,generation,sys-task,task-center,video-estimate}.ts`；挂载与健康检查 `backend/src/index.ts:60,93`。

## 附录 A. 路由覆盖清单（method + path → 文档节 → 验证）

> 路径相对 `HUOBAO_API`（`/api/v1`）。源文件列指 `backend/src/routes/`。**`ⓜ` = 经挂载函数注入**：参考图来自 `mountReferenceImageRoutes()`（reference-images.ts），重提取来自 `mountReExtractRoute()`（asset-reextract.ts）——在 characters/scenes/props.ts 里看不到这些 handler，必须看被挂载文件。
> 验证列：**R** = 2026-11-02 生产实测通过（charcoal 运行，drama 5 / episode 6）；**S** = 仅源码核对（未发实测请求）；**A** = 管理员/破坏性操作，S 且需人的显式授权。

| Method + Path | 节 | 验证 | 源 |
|---|---|---|---|
| GET /dramas | §1 | S | dramas.ts |
| POST /dramas | §1 | R | dramas.ts |
| GET /dramas/stats | §1 | S | dramas.ts |
| GET /dramas/:id | §1 | R | dramas.ts |
| PUT /dramas/:id | §1 | R | dramas.ts（documentary_rules 实测） |
| DELETE /dramas/:id | §1 | A | dramas.ts |
| POST /dramas/:id/assets/import | §1 | A | dramas.ts + services/asset-library.ts |
| POST /dramas/:id/assets/batch-generate/preview | §1 | S | dramas.ts + services/asset-batch.ts |
| POST /dramas/:id/assets/batch-generate | §1 | A | 同上 |
| GET /dramas/:id/assets/batch-generate | §1 | S | 同上 |
| POST /dramas/:id/assets/batch-generate/cancel | §1 | A | 同上 |
| PUT /dramas/:id/characters | §1 | S | dramas.ts |
| PUT /dramas/:id/episodes | §1 | S | dramas.ts |
| POST /episodes | §1 | R | episodes.ts |
| PUT /episodes/:id | §2 | R | episodes.ts（content 写入实测） |
| DELETE /episodes/:id | §2 | A | episodes.ts |
| GET /episodes/:id/characters、/scenes、/props（3 个端点） | §2 | S | episodes.ts + services/asset-library.ts |
| POST /episodes/:id/assets/link | §2 | S | episodes.ts + services/asset-library.ts |
| DELETE /episodes/:id/assets/link | §2 | S | 同上 |
| POST /episodes/:id/extract | §2 | A | episodes.ts + services/extraction.ts |
| GET /episodes/:id/extract-status | §2 | S | 同上 |
| GET /episodes/:id/character-roster | §2 | S | episodes.ts + services/character-roster.ts |
| PUT /episodes/:id/character-roster | §2 | A | 同上 |
| GET /episodes/:id/pipeline-status | §2 | S | episodes.ts |
| POST /characters | §3 | S | characters.ts |
| PUT /characters/:id | §3 | S | characters.ts + services/asset-prompt-invalidation.ts |
| DELETE /characters/:id | §3 | A | characters.ts + services/asset-links.ts |
| POST /characters/:id/generate-prompt | §3 | S | characters.ts + services/final-prompt.ts |
| POST /characters/:id/generate-image | §3 | S | characters.ts + services/generation.ts |
| PUT /characters/:id/styling-version | §3 | S | characters.ts + services/styling-version.ts |
| POST /characters/:id/styling-version/generate-image | §3 | S | 同上 |
| POST /characters/:id/archival-images | §3 | S | characters.ts + services/archival-images.ts |
| DELETE /characters/:id/archival-images | §3 | S | 同上 |
| POST /characters/:id/appearance-from-portrait | §3 | A | characters.ts + services/portrait-appearance.ts |
| GET /characters/:id/appearance-from-portrait | §3 | S | 同上 |
| POST /characters\|scenes\|props/:id/reference-images（3 类同构，ⓜ） | §7 | S | ⓜ reference-images.ts |
| POST /characters\|scenes\|props/:id/reference-images/from-library（3 类同构，ⓜ） | §7 | S | ⓜ reference-images.ts + services/media-library.ts |
| DELETE /characters\|scenes\|props/:id/reference-images（3 类同构，ⓜ） | §7 | S | ⓜ reference-images.ts |
| POST /characters\|scenes\|props/:id/re-extract（3 类同构，ⓜ） | §6 | A | ⓜ asset-reextract.ts + services/extraction.ts |
| POST /scenes | §4 | S | scenes.ts |
| PUT /scenes/:id | §4 | R | scenes.ts + services/scene-time.ts（窄时段／光线修正） |
| DELETE /scenes/:id | §4 | A | scenes.ts |
| POST /scenes/:id/generate-prompt | §4 | R | scenes.ts + services/final-prompt.ts（force 重写） |
| POST /scenes/:id/generate-image | §4 | R | scenes.ts + services/generation.ts（受理／完成／下载；非内容 PASS） |
| POST /props | §5 | R | props.ts（新建并关联独立道具） |
| PUT /props/:id | §5 | R | props.ts + services/asset-prompt-invalidation.ts（窄编辑使 Prompt 失效） |
| DELETE /props/:id | §5 | A | props.ts |
| POST /props/:id/generate-prompt | §5 | R | props.ts + services/final-prompt.ts（force 重写） |
| POST /props/:id/generate-image | §5 | R | props.ts + services/generation.ts（受理／完成／下载；非内容 PASS） |
| GET /research/commons/search | §8 | S | research.ts + services/wiki-research.ts |
| GET /research/citations | §8 | S | research.ts + services/research-citations.ts |
| GET /asset-library | §9 | S | asset-library.ts + services/asset-library.ts |
| GET /asset-library/:kind/:id | §9 | S | 同上 |
| GET /asset-library/suggest-name | §9 | S | 同上 |
| GET /media-library/dramas | §10 | S | media-library.ts + services/media-library.ts |
| GET /media-library/tree | §10 | S | 同上 |
| GET /media-library/images | §10 | S | 同上 |
| POST /media-library/copy | §10 | S | 同上 |
| POST /upload/image | §11 | R | upload.ts + utils/storage.ts（2026-11-02 经当时的 Poster 画布上传实测；该 Poster 路径已被 #72 服务端渲染取代） |
| POST /upload/video | §11 | S | 同上 |
| POST /upload/audio | §11 | S | 同上 |
| GET /tasks | §12 | S | tasks.ts |
| GET /tasks/active | §12 | S | tasks.ts + services/task-center.ts |
| GET /tasks/center | §12 | S | 同上 |
| GET /tasks/:id | §12 | S | 同上 |
| GET /tasks/:id/reasoning | §12 | S | tasks.ts + agents/reasoning-sink.ts |
| POST /tasks | §12 | A | tasks.ts + services/generation.ts（video 体 zod schema 在 tasks.ts 内） |
| POST /tasks/register-upload | §12 | S | tasks.ts |
| POST /tasks/:id/retry | §12 | A | tasks.ts + services/task-retry.ts |
| POST /tasks/:id/cancel | §12 | A | tasks.ts + services/qwen-jobs.ts（图片）/ services/h3-jobs.ts（视频） |
| DELETE /tasks/:id | §12 | A | 同上 |
| GET /image-queue/estimate | §13 | S | imageQueue.ts + services/adapters/qwen-jobs-client.ts |
| GET /video-queue/estimate | §13 | S | videoQueue.ts + services/video-estimate.ts / adapters/h3-jobs-client.ts |
| GET /video-queue/overview | §13 | S | videoQueue.ts + adapters/h3-jobs-client.ts |
| GET /storage | §13 | S | storage.ts + utils/dirsize.ts（挂载 index.ts:86） |
| GET /ai-configs | §14 | R | aiConfigs.ts（发现入口实测） |
| POST /ai-configs | §14 | A | aiConfigs.ts + services/ai.ts |
| POST /ai-configs/test | §14 | S | 同上 |
| GET /ai-configs/tts-voices | §14 | S | aiConfigs.ts + services/tts.ts |
| GET /ai-configs/:id | §14 | S | aiConfigs.ts |
| PUT /ai-configs/:id | §14 | A | 同上 |
| DELETE /ai-configs/:id | §14 | A | 同上 |
| GET /ai-providers | §14 | S | aiConfigs.ts（导出子 app） |
| GET /style-presets | §15 | R | stylePresets.ts（发现入口实测） |
| POST /style-presets | §15 | A | stylePresets.ts |
| PUT /style-presets/:id | §15 | A | stylePresets.ts |
| DELETE /style-presets/:id | §15 | A | stylePresets.ts |
| GET /prompts | §16 | S | prompts.ts + agents/prompts.ts |
| GET /prompts/:type | §16 | S | 同上 |
| PUT /prompts/:type | §16 | A | 同上 |
| POST /prompts/:type/reset | §16 | A | 同上 |
| GET /skills | §17 | S | skills.ts + agents/skills.ts |
| GET /skills/* | §17 | S | 同上 |
| PUT /skills/* | §17 | A | 同上 |
| POST /skills | §17 | A | 同上 |
| DELETE /skills/* | §17 | A | 同上 |
| GET /settings/content-language | §18 | S | settings.ts + services/app-settings.ts（挂载 /settings，index.ts:87） |
| PUT /settings/content-language | §18 | A | 同上 |
| GET /settings/tours-seen | §18 | S | 同上 |
| PUT /settings/tours-seen | §18 | S | 同上 |
| GET /server-update/state | §19 | S | serverUpdate.ts + services/server-update.ts |
| POST /server-update/check | §19 | S | 同上 |
| POST /server-update/apply | §19 | A | 同上 |
| GET /health（裸 JSON，非 code/data 包裹） | §0 | R | index.ts:60 |

**不在本文件（主 own = api-production.md）**：`/agent/*`、`/storyboards/*`、`/episodes/:id/{storyboards,generate-video-prompts,video-prompts-status,generate-narration,narration-*,tts-options,compose-batch*,video-batch*,generate-keyframe-prompts,keyframe-*}`、`/merge/*`、`/posters/*`、`/episodes/:id/poster*`。

**骨架内未在 api-core 描述的路由**（属其它作者范围，见 api-production.md）：`agent.ts`、`merge.ts`、`posters.ts`、`storyboards.ts`。
**计数（2026-11-02 当前源码重扫）：**上表 **103 个 method+path 行**；4 行为多类/多端点展开（本集资产 GET ×3；characters\|scenes\|props 三方法 ×3 类 = 9；re-extract ×3），展开后共 **113 个具体端点**（含 GET /health）。`api-production.md` 当前枚举为 **53** 个生产侧具体端点（新增 `POST /episodes/:id/compose-batch/preview` 已纳入），故当前合计为 **166**；旧 ProtocolReviewer 的 164 是该新端点/当前 production 清单之前的历史对账数，不能冻结沿用。
