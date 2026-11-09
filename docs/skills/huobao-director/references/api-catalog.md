# 火宝分阶段 API 目录（Agent 操作面）

所有路径都相对 `HUOBAO_API = {HUOBAO_BASE}api/v1/`（默认 `http://172.30.3.164/huobao/api/v1/`，以会话配置为准）。
拼接时**去掉路径开头的 `/`** 再拼；用 `urljoin` 会把 `/huobao/api/v1` 前缀丢掉，打到 SPA。
标注：`[R]` = 对应请求/行为真实运行；历史案例见 references，本轮为 drama 11 / episode 17（八达岭长城测试 1008-2）。`[S]` = 仅源码/实现自测；`[S/R]` = 部分实测。不能把相邻实测扩成全分支验证。
**源码快照**：功能代码至 `3eec6f7`，main `c6bf2ab`，release `20261108T204444Z`；早期 #80–#82 证据仍保留。
**本轮证据**：`docs/qa/issue-87-20261108/`。公开观测/消息分页、三阶段预估、auto 与暂停 pin 错误已在生产调用；未触发的错误原因/写分支保持 `[S]`。#84 代码 `ff09732` / release `20261109T015027Z` 已发布，项目 12 / 集 18 的 1009 三路线验收进行中，不能整节升格 `[R]`；#88 仍开放。

## 0. 通用约定

- 业务响应是 `{code:200|201,data,message}`；`/health` 是裸 JSON，不带包裹。
- 未知 `/api/v1/*` 路径会返回 **200 + text/html（SPA）**，不返回 404。每个响应都必须校验 `Content-Type: application/json`。
- 异步接口返回 `running/queued/processing` 只代表**受理**，不代表完成。必须轮询状态或任务中心到终态。
- 媒体路径可能是根绝对形式（`/static/...`）或相对形式（`static/...`）。根绝对路径按 `HUOBAO_BASE` 拼，相对路径按部署前缀拼；拼完必须仍在部署基址内，拒绝 `..` 与绝对注入。
- `drama_id` / `episode_id` 是数据库 ID；前端路由和审核深链用的是 `episode_number`（显示集数）。二者必须用 `GET /dramas/{d}` 双向核对。
- **路径简写约定**：目录里的 `...` 续接与省略前缀只用于分组阅读；实际调用必须展开。规则：S7/S8 的批量与状态端点属于 `/episodes/{e}/...`，镜头级属于 `/storyboards/{id}/...`；`/runs/{id}` 属于 `/asset-pipeline/runs/{id}`；`/runs/{id}/approve` 同理。不确定时以本节完整写法为准，宁可显式写全。
- 所有 GET/POST/PUT/DELETE（含轮询与错误）都要写 actor 自己的 `requests.jsonl`，附脱敏 request/response；`api_key`、认证头、密钥 URL 一律不入证据。
- 写入前保存受影响字段快照；写入后重新 GET 对照，报告 before/after。
- AI 配置响应按机密处理：只允许在内存中白名单提取 `id/provider/model/base_url`，不得落盘。

---

## 1. 接入与发现（S0）

### `GET /health` [R]
用途：确认服务可达且返回真实 JSON。返回 HTML 说明前缀/路由错误。
返回：裸 JSON（无 `{code,data,message}`）。

### `GET /tasks/active` [R]
用途：开工先看是否有正在运行的任务；已有任务就观察，不重复投单。
返回：`{items:[...], active_count}`。

### `GET /tasks/center?episode_id=&type=&status=&scope=&page=&page_size=` [R]
用途：本集任务快照。父行（关键帧批量/视频批量/导出）带 `progress/counts/children`。
`scope` 默认 `recent`（进行中 ∪ 最近 7 天）；`page_size` ≤ 200。

### `GET /tasks/{id}` [R]
用途：单任务详情、失败原因、`params`、`remote_state`、`elapsed_ms`、`cancellable`。

### `GET /tasks/{id}/observations?work_id=&cursor=&limit=&with_messages=&message_limit=` [R]（tasks 1281–1285；65 条调用完整分页）
用途：回看任务的持久工作项与实际模型调用。`cursor` 是上一页最后一个调用的 `id`，不是分镜序号；`work_id` 可缩小到某个工作项，`limit` 默认 50、钳 1–200；任务不存在时返回 400（不是 404）。
返回恒定形状 `{task_id, works[], calls[], messages[], message_limit, messages_complete, limit, next_cursor, has_more}`：`messages`/`message_limit`/`messages_complete` **在轻量模式下也始终存在**，分别是 `[]`、`0`、`false`，不要把 `messages_complete:false` 读成「正文被截断」，轻量模式本来就没取正文（`backend/src/routes/tasks.ts:298-325`）。
- `with_messages=1`（严格等于字符串 `1`，`true` 不生效）才附消息；此时 `message_limit` 默认 20、钳 1–200，是**每条调用**取前 N 条；`messages_complete=true` 仅当本页每条调用的 `message_count ≤ message_limit`。
- `works[]` 每行：`id/task_id/stage/source_chars/sample_key/storyboard_id/storyboard_number/started_at/finished_at/status/model_ms/queue_ms/work_ms/call_count/heartbeat_at/error_msg/created_at/active_call_started_at/active_call_heartbeat_at`。`stage ∈ skeleton|voice|design_card`，`status ∈ processing|completed|failed|interrupted`。
- `calls[]` 每行：`id/work_id/task_id/kind/config_id/config_name/provider/model/url/stream/status/http_status/queued_at/started_at/finished_at/duration_ms/queue_ms/request_chars/response_chars/prompt_tokens/completion_tokens/finish_reason/error_msg/heartbeat_at/created_at`，外加接口计算的 `message_count`。`kind ∈ llm|vision_chat|tts`（配音记的是真实 TTS 请求，不冒称 LLM 对话）。
- 时间点是 epoch 毫秒、时长是毫秒；`prompt_tokens`/`completion_tokens` 允许为 null，缺失的 usage 不编造。
任务窗口列表轮询用轻量模式，展开某条调用后再按需读消息。沿 `next_cursor` 翻页到末尾（`has_more` 为真即继续），不把第一页当完整历史。在飞调用/正文可以原 ID 增量更新，活动视图还须刷新已加载在飞行，不能只读取大于末尾 ID 的新行。旧任务没有观测记录不代表它没调用模型，不能回填伪造历史。

### `GET /tasks/{id}/observations/calls/{callId}/messages?cursor=&limit=` [R]（727 条公开消息读全，含跨任务 400）
用途：读取该真实调用的完整公开输入输出，含注入的 system/SKILL、工具定义、assistant 正文、工具参数与结果；不是索取模型隐藏思维。`cursor` 是上一页最后一个消息 `id`，`limit` 默认 40、钳 1–200。
错误：调用不存在，**或该调用的 `task_id` 不等于路径里的任务**，都返回 400「调用记录不存在」——跨任务取 callId 不会越权读到别人的正文（`backend/src/routes/tasks.ts:328-347`）。
返回 `{task_id, call_id, call, total, messages[], limit, next_cursor, has_more}`；`call` 就是上面 `calls[]` 的同一行调用元数据（含 `config_id/config_name/provider/model/url/kind/status/http_status/duration_ms/queue_ms/request_chars/response_chars/finish_reason/error_msg`，但这里**不含** `message_count`，条数看 `total`）。
`messages[]` 每条：`id/call_id/work_id/task_id/seq/phase/role/name/tool_call_id/body/chars/streaming/created_at`。`id` 是游标键（按它翻页，不要用 `seq`）；`phase ∈ request|response|final`；`role` 取 `system|user|assistant|tool|tool_call|tool_result|tool_definitions|request_params|request|result|error|raw_response`。正文按纯文本查看，分页不截断正文。图片/二进制是明确占位或安全资源引用，凭据在落盘前脱敏。失败前已收到的公开内容也保留；在飞正文由服务端分块持久化，重启后只显示已真实落盘的部分。
案例背景：用户无法从最终输出或 console 判定分镜设计在做什么，也无法审查实际 prompt/SKILL；因此 #87 先接骨架、设计卡及相关视觉子调用，配音记录真实 TTS 请求/结果与耗时。全局其他调用的逐项补齐仍在 **#88（未关闭）**，不因本接口存在就声称全局覆盖。
本轮 TTS 旧记录有完整请求正文，但早期调用级 request_chars 漏计；读取时只从已存请求 chars 合计恢复，不回写旧记录，也不从当前配置伪造历史 provider/name。新调用正常累计并冻结实际配置元数据；未知旧名称在 UI 用配置 ID 表示，不写“默认模型”。

### `POST /episodes/{id}/work-estimate` [R]（三阶段、显式空选、配音草稿与模型选择）
只读预估，不创建生成任务、不调用 LLM 或 TTS 合成。请求体：`{stage:'skeleton'|'voice'|'design_card', storyboard_ids?:number[], model_mode?:'auto'|'pinned', config_id?:number, model?:string, settings?:object}`。
- 本端点确实支持 `model_mode`（`backend/src/services/ai-stages.ts:326-341`）：`auto` 忽略残留 `config_id`/`model`；`pinned` 必须带正整数 `config_id`，否则 400 文案指名要求；不传 `model_mode` 但带 `config_id` 按 `pinned` 处理。选不到模型时返回与生成入口同形状的结构化 400（`error ∈ model_pin_unavailable|vision_config_unavailable|text_config_unavailable`），不偷换计费服务。
- 配音使用当前待提交的 `settings`（voice、inference_timesteps、cfg_value、seed、instructions、normalize），不是只看已保存默认；单镜传该镜 id。`storyboard_ids:[]` 经过滤后等于显式空选，不能扩大为整集。`stage` 不在三值内 → 400。
- 返回 `{estimate, observation_summary}`（`backend/src/routes/episodes.ts:540-574`、`services/task-estimate.ts:70-123,272-300`）：
  - `estimate`：`{stage, unit:'episode'|'shot', sample_key, config_id, model, planned_units, planned_source_chars, estimate_ms, sample_count, basis:'history'|null, blocked_units}`。**本次待提交计划**：骨架 `unit='episode'`（整集一项），配音/设计卡 `unit='shot'`。`planned_source_chars` 是源旁白字数（骨架=整集旁白稿字数），不是提示词字数；ETA 按它缩放。`estimate_ms=null` + `sample_count=0` + `basis=null` 就是「暂无估计」，界面必须照实显示，不得编固定秒数。`blocked_units` 只算所请求范围内被前置门禁挡住的镜头，不把未勾选项算成阻断。
  - `observation_summary`：最近一次**同阶段**任务的真实计量，没有历史任务时为 `null`。字段 `{task_id, stage, unit, sample_key, task_status, terminal, planned_units, planned_source_chars, completed_units, failed_units, interrupted_units, remaining_units, completed_source_chars, remaining_source_chars, actual_call_ms, actual_queue_ms, queue_wait_known, work_wall_ms, current, rate, eta, eta_unknown_reason, items[], updated_at}`。
    - `actual_call_ms` 是实际服务调用耗时之和（并发时不是墙钟，也不是音频长度），`work_wall_ms` 是工作项墙钟之和；`queue_wait_known=false` 表示外部供应商队列不可知，不要把 `actual_queue_ms=0` 当成「没排队」。
    - `current`（进行中那一项）：`{storyboard_id, storyboard_number, source_chars, started_at, elapsed_ms, call_ms, estimate_ms, overrun}`。`overrun=true` = 已超过预计，界面显示「超过预估/更新中」，**不返回 0 倒计时**。
    - `eta`：`{remaining_ms, finish_at, overrun, basis:'current_batch'|'history', sample_count}`；为 `null` 时必须读 `eta_unknown_reason ∈ no_samples|terminal|not_started` 并照实呈现。`rate`：`{ms_per_char, per_unit_ms, sample_count, basis}`，无字数依据的项才用 `per_unit_ms`。
    - `items[]`：`{storyboard_id, storyboard_number, source_chars, state:'pending'|'processing'|'completed'|'failed'|'interrupted', call_ms, work_ms}`。
  - 两者不能互相替代：`estimate` 是「这次要跑什么」，`observation_summary` 是「上一个任务真实跑了什么」；失败/中断样本不进成功样本池，终态任务不再倒计时。
  - `observation_summary.task_id` 指的是**同阶段最近一次**任务，可直接拿去 `GET /tasks/{id}/observations` 回看上一轮。它**不保证**等于你刚提交的那一次：刚投单后要定位本次任务，用 `GET /tasks/center?episode_id={e}&type=text&page_size=200` 的前后快照差（骨架/配音则直接用发起响应里的 `task_id`）。


### `GET /style-presets` [R]
用途：项目风格白名单与英文风格词来源。创建项目前先读，不能凭记忆写 style。

### `GET /ai-configs?service_type=text|image|video|tts` [R]
用途：拿到 `config_id` 与可用 `model` 列表。**响应含 `api_key`，不得写入证据**。
注意：`model` 字段存 JSON 数组，只带首个时不要据此认为只有一种模型。

### `GET /ai-configs/ai-stages` [R][S]
用途：查看哪些 AI 阶段静态要求视觉模型（vision 标记），不要运行时探测。

### `GET /skills?lang=zh`、`GET /skills/{完整路径}?lang=zh`、`GET /prompts`、`GET /prompts/{agent_type}` [R]
用途：发现当前内置工种与方法全文；不要把旧文档里的技能数量当事实。

### `GET /dramas`、`GET /dramas/{d}` [R]
用途：定位项目。`/dramas/{d}` 同时返回项目字段、`episodes[]`、资产摘要、`documentary_rules`。
`episodes[]` 每项实测含 `id/episode_number/title/content/script_content/script_confirmed_at/narration_enabled/audio_mix_mode/subtitle_timing/tts_settings/resolution/image_config_id/video_config_id/tts_config_id` 等，可直接读剧本草稿与集级设置。
**没有 `GET /episodes/{id}` 路由**；单集信息从 `GET /dramas/{d}` 的 `episodes[]` 读。

---

## 2. 项目、剧集与剧本闸门（S1）

### `POST /dramas` [R]
Body：`{title, project_type, aspect_ratio, genre, style, description}`
- `project_type`：`drama|documentary`（纪录片才有资产审核清单、设计卡、图层段）。
- `aspect_ratio`：`16:9|9:16|4:3|3:4|1:1`，无默认，必须显式给。
- `style`：必须是 `GET /style-presets` 的 `value`。
注意：`POST /dramas` **不持久化 `documentary_rules`**，必须随后 `PUT /dramas/{id}` 落盘。

### `PUT /dramas/{d}` [R]
Body：任意项目字段，常用 `{documentary_rules:"on"|"off"|"auto"}`、`{style, aspect_ratio}`。
注意：改 `style` 会清空本项目全部 `final_prompt`，改画幅会改变关键帧/视频尺寸策略；先快照并告知人。

### `POST /episodes` [R]
Body：`{drama_id, title, resolution, image_config_id, video_config_id, tts_config_id}`
返回：code 200（不是 201），不要用 201 判定成功。
`resolution` 是生成档位，不等于最终画布。关键帧尺寸确实按画幅查表（16:9=1344×768，`services/storyboard-keyframes.ts:37-41`）。图层段/成片画布则是**实测优先**：按本集已有的第一条模型视频探测宽高与帧率，只有本集还没有模型视频时才退回画幅内置默认（16:9=960×544、9:16=544×960、1:1=768×768、4:3=960×720，`services/layer-segment.ts:114-119,536-560`）。所以 960×544 是「无视频时的 16:9 兜底值」，也是八达岭那一集实际成片的量得结果，不是全项目恒定尺寸——每集都要自己读 `GET /layer-segments/storyboards/{id}` 的 `spec` 或 ffprobe 实测，不要照抄。

### `PUT /episodes/{e}` [R]
Body 常用：
- `{content}`：第一步「原始内容」（`step=0`）导入。用户要求只做第一步/等待时，读回并给第一步链接即停止，不夹带 `script_content`，不启动改写。
- `{script_content}`：仅用于用户明确要求的人工修改或其定稿原样导入，必须如实标明；不是助手自行创作初次 AI 改写的入口。AI 生成必须走下列火宝内部工种。已有文本不得擅自覆盖。
- `{narration_enabled:true}`：开启旁白模式；开启后拆分镜、视频 Prompt、合成都会走旁白规则。
- `{audio_mix_mode:"replace"|"mix"}`：配音替换原声，或以原声为底混音。
- `{subtitle_timing:"sentence"|"char"}`：字幕时间码模式。
- `{narration_normalize:true|false}`：旁白文本规范化（镜级可覆盖）。

### `POST /agent/script_rewriter/chat` [S]（**纪录片不可用**）
用途：第二步「AI 改写」（`step=1`）的火宝内部生成入口。仅在用户明确授权该阶段后调用；第一步导入不隐含此权限。
Body：`{drama_id:d, episode_id:e, message:"用户的具体改写要求", config_id?, model?}`。
由火宝工种读取原始 `content`、生成并保存 `script_content`。调用后从 `GET /dramas/{d}` 的 `episodes[]` 读回实际稿件，未保存就不能报告成功；改写授权不等于人工批准。
不能改为助手本地代写再 PUT `script_content`，也不能因技能不适合压缩而自行绕过。这个入口已核对本地路由，但在2026-11-06漕运错误案例中**没有执行**，不能标成该案例的实测成功。
若用户说“不要再操作，只更新技能”，连开工 GET、回滚/清空和本入口都不得调用；这里只能修改明确获准的助手技能文件。
**纪录片（`project_type=documentary`）调用本入口直接 400** [R]（八达岭实测，`backend/src/routes/agent.ts:85-86`）：必须改走下面的分阶段流水线。

### `POST /episodes/{e}/script-rewrite` [R]（纪录片改写入口，Issue #70/#80）
Body：`{start_stage?, skip_stages?[], predecessor_version_id?, config_id?, model?, auto_adopt?, source_revision?, final_revision?, acknowledge_source_change?}`；异步，返回 `{run_id, task_id}`。
阶段：输入准备（自动过滤非旁白内容，必经）→ 忠实改写 `fidelity.v2` → 桥句润色。八达岭实测 run **3** / task **1212** 完成。
### `GET /episodes/{e}/script-rewrite` [R]
整页状态：运行、阶段、版本与修订号（`source_revision`/`final_revision`）。
### `GET /episodes/{e}/script-rewrite/runs/{runId}` [R]（八达岭 run 3 轮询 31 次）、`POST /episodes/{e}/script-rewrite/runs/{runId}/manual` [S]（本轮未调用）
单个运行详情；`manual` = 运行期间开始手改，先关掉自动采用。
### `POST /episodes/{e}/script-rewrite/versions/{versionId}/adopt` [S]（本轮未调用；八达岭走的是 `auto_adopt` 默认路径）
显式采用候选或历史版本。
### `PUT /episodes/{e}/script-rewrite/final` [S]（本轮**未调用**：八达岭只实测了分阶段 run + `GET` 状态/版本）
Body：`{content, final_revision, source_revision?}`（`final_revision` 必填，CAS 并发保护）。人工保存最终稿：产生 manual 不可变版本，并把活跃运行降级为「只留候选」。返回 `{changed, source_revision, final_revision, version_id}`。

### `POST /episodes/{e}/script-rewrite/inspect-narration` [R]（Issue #80）
用途：纪录片旁白稿保存前的**非旁白内容检测**。检查的是本次提交的草稿，不是上一轮改写报告；**不写库**。
Body：`{content: string, config_id?: number, model?: string}`（`content` 必填）。
返回：`{findings:[{text, reason, locatable}]}`。`text` 是从草稿逐字复制的片段；`locatable=false` 表示在当前草稿里定位不到（只能展示，不能自动删除）。
识别范围：出处块、版权许可、URL/永久链接、贡献者与编辑历史、书目与引用尾注、模板/编辑说明、「不作为朗读稿」声明。正文里可朗读的归属表述（如「据《异域录》记载」）与 `【】` 节拍标记**不算**杂质。
错误：非纪录片项目 400；剧集不存在 404；模型回包被截断或格式不合法 → 502 `inspection_failed`。
注意：**502 或字段缺失不等于稿件干净**，必须按「检测失败」呈报并由人决定是否照样保存。删除哪些片段是人的选择，Agent 不自行删改正文。

### 改写阶段契约 `fidelity.v2` [R]（Issue #80）
忠实改写阶段的模型输出改为 JSON：`{"content":"整理后的旁白稿正文","exclusions":[{"text","category","reason"}]}`，`category ∈ source|license|link|contributor|bibliography|editorial|not_narration`。
服务端在**冻结输入**里唯一定位每条 `text`；定位不到、片段互相重叠、或该片段仍出现在 `content` 中 → 阶段失败，不产生版本。
`FidelityReport` 新增 `ai_exclusions:[{text,category,reason,start,end}]` 与 `adjusted_baseline_chars`；内容量判定上界按原始基线、下界按扣除剔除清单后的基线，即「变短」必须由可定位的剔除清单解释。

### `GET /episodes/{e}/gates` [R]
用途：读阶段闸门与阻断原因。**每进入下一阶段前先读**。
返回结构（实测）：
```
{script:{confirmed,confirmed_at},
 assets:{review_status,stale_reasons[],missing},
 design:{confirmed,total},
 production:{ready,total},
 final:{fresh,total},
 project_type,
 unlocked:{assets,design,production,final,export,poster},
 reasons:{design,production,final,export},
 goto:{design:"assets",...}}
```
`unlocked=false` 时按 `reasons[stage]` 去对应入口补；不要绕过。

### `POST /episodes/{e}/script/confirm` [R]
用途：人工确认剧本，解除下游闸门。`{}` 无 body。
注意：这是**人的确认**，Agent 不得替人按下去；必须由人明确指示。

### `POST /episodes/{e}/script/unconfirm` [S]
用途：撤销剧本确认（回到待审）。破坏性：会重锁下游；需人授权。

---

## 3. 资产（S2）

### `POST /episodes/{e}/extract` [R]
Body：`{target:"characters"|"scenes"|"props", config_id?, model?}`
用途：按本集剧本提取/去重并关联到本集。一次只提一类；三类分别调用。
返回：任务 ID / started；用 `GET /extract-status` 跟到终态。

### `GET /episodes/{e}/extract-status` [R]
用途：提取进度与失败原因。文本任务进度在 `params.progress`。

### `GET /episodes/{e}/characters`、`/scenes`、`/props` [R]
用途：读本集已关联资产（角色/场景/道具）。项目级资产不等于本集已关联。

### `GET /episodes/{e}/character-roster`、`PUT /episodes/{e}/character-roster` [S/R]
用途：纪录片本集名册契约。
GET 返回 `{cast[], exists, status, stale, script_hash, current_hash, updated_at}`。
PUT Body：`{cast:[{name, basis?, reason?, source?}], expected_hash?, status:"draft"|"approved"}`。
- `status` 缺省 = `approved`，即**缺省会批准**；草稿必须显式 `status:"draft"`。
- 必须把 GET 得到的 `current_hash` 回传为 `expected_hash`；剧本在打开名册后改动会 400，要求重新复核。
- 名册批准是人的动作，Agent 不得代签。

### `POST /episodes/{e}/assets/link` [R]
Body：`{kind:"character"|"scene"|"prop", asset_id}`；幂等；跨项目拒绝；本集已有同名拒绝。
### `DELETE /episodes/{e}/assets/link?kind=&asset_id=` [R]
用途：取消关联，不删资产。

### `POST /characters`、`POST /scenes`、`POST /props` [R]
用途：手动建资产。
- 场景：`{drama_id, episode_id?, location, prompt, lighting, time}`；`time` 是正式字段，非空时场景最终提示词必须原样包含它。
- 道具：`{drama_id, episode_id?, name, type, description, faithful?}`；`faithful:true` 表示真实证据素材，**不得进扩散链路**。实测 `faithful` 只存在于 `props`（场景/角色没有该字段）；真实地图/照片请建成 `prop` 并标 `faithful:true`，或只作确定性图层底图，不要指望 scene 的 faithful 标记。
- 角色：`{drama_id, episode_id?, name, role, appearance, styling, description}`。
注意：名字会被规范化（空白/非法字符→`_`），`@引用` 在空白处截断，所以名字不能带空格。

### `PUT /scenes/{id}`、`PUT /props/{id}`、`PUT /characters/{id}` [R]
用途：窄字段修正。影响画面的字段真的变了且没写新手写提示词 → `final_prompt` 置空，需重新生成。
场景 `time` 不能从非空改成空（400）；写入 `final_prompt` 必须原样含当前 `time`（400 否则）。
三个 PUT 都返回更新后的行；前端/Agent 以返回行为准。

### `POST /scenes/{id}/generate-prompt`、`POST /props/{id}/generate-prompt`、`POST /characters/{id}/generate-prompt` [R]
Body：`{episode_id, text_config_id?, force?}`
用途：让内置 Agent 写/重写最终提示词。`force` 才强制重写；不带则复用已存稿。
成功后必须读回**非空且与运行前不同**的新稿；返回旧稿视为失败。

### `POST /scenes/{id}/generate-image`、`POST /props/{id}/generate-image`、`POST /characters/{id}/generate-image` [R]
Body：`{episode_id?, config_id?, model?}`
用途：提交图片生成任务（异步）。角色定妆照固定 1920×1080；场景/道具按配置。
返回任务；用 `GET /tasks/{id}` 跟到 completed，再下载实际图片查看。

### `PUT /props/{id}/faithful-source` [R]
Body：`{version_task_id}`；把某个已登记版本标为忠实原件来源。
### `POST /upload/image` [R]
multipart `file`；返回 `{url,path}`。用于本地上传原件（地图、照片等素材）。**不再用于 Poster**：Poster 合成图由服务端从 `layer_doc` 渲染登记（§4），没有上传画布这一步。§3.84 的外部底图 `reference_image` 也走本接口；地图端点与分支证据见该节。
### `POST /tasks/register-upload` [R]
Body：`{asset_type:"character"|"scene"|"prop", asset_id, local_path}`
用途：把上传图片登记为该资产的新版本并设为当前图（`provider='upload'`）。
返回：**201** + `{id, local_path}`（`id` 即新 `sys_task` id，可作为 `version_task_id`）。

### `POST /episodes/{e}/asset-review/run` [R]
Body：`{config_id?, model?}`；仅纪录片；对照旁白稿生成「信息点 → 需要资产 → 已有/缺失」清单。
### `GET /episodes/{e}/asset-review` [R]
返回分组清单与计数（have/added/missing/not_needed/ignored）。
### `PUT /asset-review/items/{id}` [R]
Body：`{status:"have"|"added"|"ignored"|"not_needed"|"missing", reason?}`
注意：`not_needed` 与 `ignored` 都等于删减覆盖/消除缺口计数，属于人的决定；Agent 只能提建议与理由（本片用图层确定性呈现等），不能自行落库。
### `POST /asset-review/items/{id}/extract` [S]
用途：对缺失项单资产补提取，完成后自动回链。

### 精确 → 美化流水线（纪录片核心，S2 后段）

### `POST /asset-pipeline/asset-sources` [R]
multipart（`file`）或 JSON（`url`/`local_path`）：
`{asset_kind, asset_id, role:"generation_reference"|..., license, title, artist, era}`
用途：权威素材入库（按内容 sha256 缓存到 `static/asset-sources/`），供精确阶段引用与 QC 对照。

### `GET /asset-pipeline/assets/{kind}/{id}/sources` [R]
用途：查看该资产已缓存的权威素材。

### `POST /asset-pipeline/runs` [R]
Body：`{asset_kind, asset_id, episode_id, purpose:"precision"|"beautify", config_id?, model?, text_config_id?}`
用途：启动 Mastra 流水线（研究 → 规格 → 生成 → 视觉 QC → 人工审批 → 修订/美化）。
语义：`precision` 是“带权威参照、程序 gate 与人工审批的生成逼近”，**不是精确复原**；产物仍是艺术再现，不得声称考古/器物级精确。
返回：`{run_id, mastra_run_id}`。用 `GET /asset-pipeline/runs/{id}` 轮询阶段与候选。
注意：**没有“每轮最多几张”的入参**；每个 run 的轮次/候选由服务固定流程决定。Agent 只能按 run 计数并预留预算（每次 `approve revise` 可能再花一轮图），在启动前向人确认这条资产允许几轮。

### `GET /asset-pipeline/runs/{id}` [R]
用途：读轮次、候选图、程序 gate 结果、待审状态。**程序 gate FAIL 必须保留**。
实测字段：`rounds[]{id,purpose,generator,image,image_sha256,qc{hg_verdict,gate_pass,human_opened[{path,sha256}],...},gate{pass,coverage,invalid[],violations[],forbidden_hits[],text_in_image}}`。
`approve` 的 `opened` 必须是**你实际下载并打开过**的图与 hash：先 GET `rounds[].image` 的媒体字节，本地核对 sha256 与 `rounds[].image_sha256` 一致，再填 `{path,sha256}`。`rounds[].image_sha256` 只是参照值，不能没开图就照抄（否则等于未开图审批，违反反例 8）。

### `POST /asset-pipeline/runs/{id}/approve` [R]
Body：`{round_id, verdict:"approve"|"revise"|"rollback"|"abort", selected_violations?, notes?, opened:[{path,sha256}], override_gate?}`
注意：
- `opened` **必填**，必须是你实际打开看过的图与 sha256；没开图不能审。
- `override_gate:true` 只在程序 gate 未过但技术用途可接受时使用；必须在 `notes` 写清理由与适用范围，并保留 `gate_pass=0`。这不是用户艺术批准，且必须由人明确授权后执行。
- 每次 `approve` 都是一次人工轮次决定：`revise` 会再消耗一轮生成，先核对预算。

### `POST /asset-pipeline/runs/{id}/cancel` [S]
用途：取消运行。

### `GET /asset-pipeline/episodes/{e}/base-candidates` [R]
用途：图层段底图候选（含精确/美化后的资产图、地图、示意底图）。

### `POST /dramas/{d}/assets/batch-generate/preview` [S/R]
Body：`{scope:"all"|"characters"|"scenes"|"props", episode_id?, rewrite_prompts?, overwrite_images?}`
注意：**按项目范围**，传 `episode_id` 不代表只改本集。只授权个别资产时逐资产调用。
### `POST /dramas/{d}/assets/batch-generate`、`GET` 同路径 [S]
用途：启动/查看资产批量；同项目同时只允许一个。`rewrite_prompts` 与 `overwrite_images` 是独立操作。

### 3.84 地图资产工作流（S2，Issue #84）[S]

> **来源与状态**：来自 Issue #84 已评审分支，代码已合并至 `ff09732`、发布 `20261109T015027Z`。生产项目 12 / 集 18「八达岭长城测试 1009」逐项验收进行中；端点上线不代表所有分支通过。未有明确生产证据的字段/写分支保持 `[S]`，不得用开发副本或 HTTP 200 代替验收。
**背景**：旧地图面板没有串联检索、底图、风格与可编辑几何，地图生成后甚至可能没有点线语义。本流程以显式类型和持久化阶段解决该问题；扩散仅做底纹，地图几何不由扩散产生。新增端点在生产实测留痕前保持 `[S]`。

#### 类型与持久化

`POST /props {drama_id,name,type?,description?,episode_id?,asset_type:"map"}` 新建地图；普通道具为 `"prop"`。`PUT /props/{p} {asset_type}` 可显式更改，map→prop 另需 `confirm_asset_type_change:true`，不删除地图数据。跨项目资产导入仍用 `kind:"prop"`，保留地图分类与数据，不共享运行任务。

地图全量导入独立复制工作流使用的底图、底纹、成图、图层底图与历史快照依赖；版本 ID、`faithful_source` 和语义的 `image.source_task_id` 映射到目标资产的新版本，不共享源任务。改类为普通道具后仍保留的地图历史也随资产复制，但不自动恢复 map 类型。依赖文件缺失时导入补偿回滚。旧缺陷 prop 183 / task 1321 保留失败；修复后的新副本 184 已用 base 1324、final 1327 完成无模型重绘。

注意：此处 `asset_type` 是 prop 的地图子类；`POST /tasks/register-upload` 的 `asset_type` 则是目标表类别，地图仍填写 `"prop"`。不能写 `"map"` 作为第四类目标。

#### `GET /props/{p}/map-workflow`

返回 `{asset_type,brief,stage,status,mode,revision,task_id,text_config_id,image_config_id,image_model,steps,issues,research,map_spec,outputs,history,error}`。配置字段是已保存的选择（可为 null）；续跑省略覆盖项时沿用它们。普通道具返回 400 `not_a_map`；不存在返回 404。

- `stage ∈ brief|research|base|style|drawing|complete`，是当前或下一待执行阶段；`status ∈ idle|running|awaiting_review|blocked|failed|completed`。检查 `steps[].status/message` 判断哪些阶段真正完成。
- `issues[] = {field,code,message,blocking}`；`blocking=true` 要补齐，不把失败当无问题。
- `research.queries[]` 逐源记录 hits/error；来源固定为 `wikipedia-zh / wikipedia-en / europeana / smithsonian`，不是模型自选任意网站。`sources[]` 保存机构、年代、许可、URL 与实际摘录；`features[]` 保存点线面、坐标依据、支持原文、不确定性、来源引用和冲突。URL 存在不等于它证明了某个坐标。Europeana/Smithsonian 凭据仍由「设置→资料检索」保管，Agent 不获取、落盘或写入请求留痕；无 key 的来源失败应如实呈报。
- `outputs = {base_image,texture_image,final_image,kmz,layer_doc}`；image 项含 `{path,width,height,source,task_id,provenance}`。`provenance.registration` 是 geo↔像素配准真源；Earth 使用通过独立检验的实测控制网格，不用名义相机或 bbox 仿射替代；检验点残差超过 3px 或相机漂移时失败，保留标定截图、控制点与残差证据。
- 新采集使用 129×129 控制网格及 16384 留出中心；异色 17×17 锚点定位 33×33 中间网格，再关联密集控制点，名义相机只负责粗定位。最大残差仍须 ≤3px、相机漂移 ≤0.25px。旧失败保留：1320（17×17，5.408px）、1323（相机预测关联失败）、1328（33×33，5.701px）、1333（65×65，4.962px）。不能放宽门槛或登记失败截图。onboarding 按语义节点激活，不发全局 Escape；只续跑 base，不重做检索。
- 为免大数组在每次修订快照重复膨胀，新 Earth provenance 的 `earth.calibration` 只内联残差/数量/容差/相机漂移与截图、标定 KMZ；完整 controls/grid 在 `earth.sidecar_path` 所指的 static JSON，像素换算仍只用 `provenance.registration.grid`。历史存量记录不重写。独立导入同样复制 sidecar 与标定工件，不能用源文件地址冒充独立副本。
- 地名文本按共享字号/换行模型放进独立 label 图层并避让，marker 的真实点位不因排版移动；过于拥挤时明确报空间不足，不截断地名。历史成图不被升级自动覆盖，需重新 drawing 才采用新版布局，已有底图/底纹可复用。
- 编辑画布仅显示选中要素名称，其余名称可悬停或在列表查看，避免密集标签互相遮挡；文字不参与鼠标命中。`mfocus=place:<id>|route:<id>|region:<id>` 与宿主 `asset=prop-<id>` 一起定位已保存要素，刷新/新标签只恢复界面；未保存坐标与绘制草稿不入 URL。修改须显式保存几何并重绘，不等于点击「采纳」或史实批准。

- research 阶段会把有依据的点线面加入 `map_spec`，AI 新项带 `proposed:true`。自动制图可使用候选，但不是人工批准；人工采纳须去掉相应项的 `proposed` 再 PUT 保存，此后检索不覆盖该项。近似区域只能在显式 `schematic:true` 下采用，必须保留不确定性；没有依据不虚构范围。
#### `PUT /props/{p}/map-workflow`

Body：`{expected_revision,brief?,map_spec?,mode?}`，至少一个可保存字段。顶层未传的字段保留，brief 内字段合并；**map_spec 一旦传入就是完整替换**，不是按 ID 合并。先 GET 完整 spec，仅修改获准的项，带当前 expected_revision 保存并读回核对；省略已有 places/routes/regions 会丢掉它们。人工确认项的保留承诺仅针对自动检索合并，不会拦住人有意删除。

`brief` 字段：`{subject,era,location,purpose,detail_level:"overview"|"regional"|"site",schematic:boolean,base_mode:"program"|"earth"|"image",style:"archival"|"clean"|"ink",notes,reference_image?}`。

- 对象/时代/空间/用途可由 AI 解释隐含信息，但缺时代不能擅自默认；已知字段不得用模型猜测覆盖。
- `base_mode:"image"` 的 `reference_image = {path,source_url,license,control_points:[{x,y,lon,lat}]}`；先通过 `POST /upload/image` 上传，`path` 是返回的 static 相对路径，`x/y` 是源图像素，`lon/lat` 是 WGS84 度。至少三个非共线点，必须有来源与许可；最大拟合残差超过源图对角线 5% 时拒绝，保留 max/rms 像素残差供人工核对。恰好三个控制点可拟合为零，不代表整张图精准；残差不能代替史实核验。
- `map_spec` 沿用投影、bbox、背景层与 `places/routes`，新增 `regions:[{id,name,points:[[lon,lat],...],proposed?}]`。面至少三个不同且非共线顶点，规范化后闭合。人工确认的几何不能被重跑检索覆盖。
- 闭合面的末点是首点副本，不是独立顶点：编辑器只显示/计数独立顶点，拖动首点同步闭合点，删除或续画保持同一面身份；三角形不能再删顶点。
- 保存只是改真源，不等于已渲染新图。输出上限为 60 图层、每条线/面 240 顶点，画面外/地平线后或超限几何会阻断，不丢点、钳边或缩减内容。
- 几何编辑后读回响应的 `stage`：投影/bbox/背景层不变可复用配准底图和底纹，从 drawing 手动推进绘制，再推进 complete 采用，或在已授权范围内 auto 续跑；投影/bbox/背景层变更先重做 base。相同规范化 spec 保存不作废已有成图。

#### 执行与人工控制

- `POST /props/{p}/map-workflow/run {mode:"auto"|"manual",expected_revision,text_config_id?,image_config_id?,image_model?}`：继续当前 `stage`，不会从 brief 重启；整条重做要先显式 rollback。auto 连续执行到完成或阻断，可能发生文本与底纹模型调用，先授权、先预扣预算；manual 仅执行当前一步供审阅。已 completed 时返回 `already_completed`，不重复计费。
- `POST /props/{p}/map-workflow/advance {expected_revision,text_config_id?,image_config_id?,image_model?,skip?}`：从当前 `stage` 执行一步。`skip:true` 仅可跳过 `style`（底纹）；不得跳过信息充分性或检索来伪造流程通过。
- `POST /props/{p}/map-workflow/rollback {stage,expected_revision}`：恢复目标阶段开始前的快照，保留上游已完成产物、已确认几何和历史；回退 drawing 不应清掉已经付费生成的底纹。`history.stage` 是事件后的阶段，`snapshot.stage` 才是快照实际取值阶段；旧记录从结构化 action 判定，不回填或伪造历史。回退不替代人的史实批准。
- `POST /props/{p}/map-workflow/cancel {}`：按人的决定取消该地图当前执行；此接口不接收 expected_revision，执行前读回当前 task_id，不把它描述为取消某个旧快照。已发出的底纹任务仍可能完成并消耗额度，取消不是退费，也不能声称上游任务已停止。
- 启动/推进返回工作流详情与 `task_id`，通过 `GET /tasks/{task_id}` 与本详情读到终态并打开真实产物。后台重启后保留产物与失败原因，由人明确继续，不自动重复计费步骤。
- `mode` 优先级：PUT 保存选择但不启动；run 使用请求 mode（省略默认 manual，不沿用已保存 auto）；advance 固定 manual，与 run manual 都执行当前一步，只有 advance 支持 skip。通常自动续跑用 run，逐步审核/跳过底纹用 advance。
- 正常完整流程：brief 1 次文本、research 2 次文本（计划+摘录提取），style 固定模板发 1 次图片；其余阶段确定性。未钉选文本端点时通用调用可最多尝试 3 个端点，完整流程保守预留至多 9 次文本；显式 text_config_id 钉选则不自动切端点。失败后重开阶段仍按实际新请求计数，不按容器任务数算账。
- complete 是当前图/语义/原件版本的技术采用，不是人批准史实；没有 opened 参数，不要自造。manual 在推进 complete 前打开 final，auto 完成后立即打开；都须在请求证据里记录实际打开的路径与 SHA-256，交人审核。地图最终图可带默认 35% alpha 独立底纹与标注，原始底图版本保存在 faithful_source；faithful 与 map 分类不是同一字段，不能把派生图当未改动原件。


409 `revision_conflict|workflow_busy`：保留本地草稿，刷新并由人决定；不无限重试。关键需求/关键证据缺失、充分性检查失败或所有来源均无有效结果会阻断；单源失败/无命中和非关键细节缺失保留告警，核心依据足够可继续。Earth/外部配准失败不得当通过或自动换路线冒充成功。失败重试也占额度，每次 GPU 提交前须有剩余预算和对应授权。

**正例**：获准地图与预算 → 新建 map → 保存对象/时代/用途 → manual 检查与检索 → 看来源/风险 → 生产选定底图 → 仅生成底纹 → 确定性绘制 → 开图核对 → 交人审核。**反例**：上传真实地图后调普通 `generate-image`；用博物馆搜索命中为模型猜测的疆域背书；配准失败后拿程序图标成 Earth；把 `completed` 当史实/版权通过。

---

## 4. Poster（S3，可选旁路，在资产之后）

**当前契约是 `layer_doc` + 服务端渲染（Issue #39/#72，`backend/src/routes/posters.ts`、`services/posters.ts:4-8`）**：编辑工程里的旧 `layout:{texts:[...]}` 已不再读写；文字排版合成图由服务端从 `layer_doc` 渲染，**不需要**浏览器 canvas，也不需要先 `POST /upload/image` 再登记。api-production.md §4/§6B 里「本地渲染 PNG → 上传 → 带 `image` 登记版本」的做法属于 2026-11-02 历史快照，已不可执行。
本节字段按当前源码核对，未在殷墟/八达岭两轮调用过，一律 `[S]`。

### `GET /episodes/{e}/poster` [S]
返回 bundle：`{id, prompt, text_prompt, copy, reference_images[], base_image, layer_doc, concept, provenance, variables, aspect_ratio, size, versions[], selected_version_id, final_image, task_status, error_msg}`。
- `layer_doc` 与分镜图层段同源（结构见 §7 `PUT /layer-segments/storyboards/{id}` 的 `layer_doc`）；`size` 取关键帧档位（16:9=1344×768）。
- `provenance` 记录每个字段/每个图层是 `ai` 还是 `manual`，AI 应用方案时据此判冲突。
### `PUT /episodes/{e}/poster` [S]
Body 只传要改的：`{prompt(≤4000), text_prompt(≤2000), copy, reference_images[](必须 static/ 下), base_image(static/ 或 null), layer_doc}`。写入的字段在 `provenance` 里被标成 `manual`；底图像素由服务端 `sharp` 实测写回，输出画布恒为本集画幅。
### `POST /episodes/{e}/poster/concept` [S]
Body：`{config_id?, model?}`；异步 AI 构想（只写 `concept`，不动编辑字段）。返回 `{task_id}`；已有构想在跑 → 409 `concept_running`；剧本/带图资产不足 → 400。
### `POST /episodes/{e}/poster/concept/generate` [S]
Body：`{composition_ids?, config_id?, model?}`；为方案各提交一张冻结快照底图（底图不带字）。返回 `{items}`。
### `POST /episodes/{e}/poster/concept/apply` [S]
Body：`{composition_id, fields?:("prompt"|"text_prompt"|"copy")[], overwrite?}`；省略 `fields` = 三个都应用。命中 `provenance=manual` 的字段 → **409 `manual_edit_conflict` + `fields[]`**，必须由人决定是否 `overwrite:true`，Agent 不自行覆盖人工稿。
### `POST /episodes/{e}/poster/concept/apply-layer-plan` [S]
Body：`{composition_id, overwrite?}`；只替换 `ai:` 前缀的文字层，保留变量层与人工层；`layer_doc` 或任一 AI 层被手改过时同样 409。
### `POST /episodes/{e}/poster/generate` [S]
Body：`{mode:"initial"|"composite"|"layers", prompt?, text_prompt?, version_id?, config_id?, model?}`；异步，返回 `{task_id, mode, prompt, references[]}`，轮询 `GET /tasks/{task_id}`。
- `initial`：当前工程 prompt + 参考图，自动前置项目风格词；**底图 prompt 不得带文字**。
- `composite`：以指定/当前 `composite` 版本图为唯一参考，附由 `layer_doc`+变量现场生成的文字指令；没有合成版本 → 400。
- `layers`：底图与透明文字层两张参考，**均由服务端从 `layer_doc` 渲染**；无底图或无可见文字层 → 400；FLUX 配置 → 400（改用 composite）。
### `POST /episodes/{e}/poster/versions` [S]
Body：`{layer_doc?, prompt?, text_prompt?}`；**服务端**按当前（或传入的）`layer_doc` 渲染合成图，登记 `kind:'composite'` 版本、自动设为最终版本并同步 `episodes.thumbnail`，返回整份 bundle。没有底图 → 400。不要再传 `image`。
### `PUT /episodes/{e}/poster/select` [S]
Body：`{version_id}`；选定最终海报并同步缩略图。
### `POST /episodes/{e}/poster/load-version` [S]
Body：`{version_id}`；把某版本的 `layer_doc` 载回当前工程（旧版本没有 `layer_doc` 时只换底图），载入后工程 `provenance.layer_doc='manual'`。

注意：Poster 不进主闸门；不得阻塞资产→分镜主线。生成海报时**不要**把真实照片/地图送扩散重绘，优先确定性底图 + 文字层。

---

## 5. 分镜拆分（S4）

### `POST /agent/storyboard_breaker/chat` [R]
Body：`{drama_id, episode_id, config_id?, model?, message}`
用途：按剧本叙事节拍拆镜，返回描述、资产关联、关键帧/视频初稿。
注意：
- 完整重拆可覆盖现有分镜，属覆盖性操作；**先获人授权并保存快照**，不得自行重拆。
- 旁白模式下必须逐段使用原旁白原文，不增删、不重复、不重排，覆盖率 100%。
- 拆镜阶段不应启动任何生图/生视频。
- 镜数要与段落数匹配；不要用拆镜修一条视频 Prompt。

### `GET /episodes/{e}/storyboards` [R]
唯一事实源。每个镜头含 `combo`、`design_card`、`design_card_status`、`target_assets`、`ref_issues`、`field_saved_at`、关键帧图与 `compose_state`。
### `POST /episodes/{e}/storyboards/fill-gaps` [S/R]
用途：只补缺失镜头并按剧本位置重编号（部分失败后恢复，不从头重拆）。
### `POST /storyboards`、`PUT /storyboards/{id}`、`DELETE /storyboards/{id}` [S/R]
用途：单镜增改删。`PUT` 常用 `{mid_frame_time, continuity_boundary:"continue"|"cut", video_prompt, first_frame_prompt, mid_frame_prompt, last_frame_prompt, narration_text}`。
`mid_frame_time` 是**生成段内**的时间点（秒），不是整镜时长：提交时直接作为视频中间引导帧时刻。服务端只按分镜 `duration` 粗验 `0.5 < t < duration−0.5`；Agent 必须按设计卡 `budget.gen_s` 自行判断（如 gen_s=6 → mid≈3；gen_s=10 → 0.5–9.5）。C/D 的 gen_s 与整镜时长不同，不要拿整镜时长算 mid。
### `PUT /storyboards/{id}/pool-assets`、`PUT /storyboards/{id}/target-assets/{target}` [S]
用途：本镜资产池（@候选）；目标级选版（`target ∈ first|mid|last|video`）。绑定本身由提示词 @ 决定，不提供手动增删。

---

## 5A. 纪录片旁白骨架（S4.5，Issue #81）

### `GET /episodes/{e}/narration-skeleton` [R]
返回：`{revision, confirmed_at, coverage{script_chars,covered_chars,uncovered_chars,gaps[{start,end,chars,excerpt}],in_order,not_in_script,complete}, shots:[{storyboard_id, storyboard_number, title, narration_text, narration_chars, tts{valid,reason,message,duration_ms,audio_url,audio_version}, design_card_status, design_ready}]}`。
注意字段名是 **`storyboard_number`**（不是 `shot_number`）。
`tts.audio_url` / `tts.audio_version`（#81 新增）：仅 `valid:true` 时可试听；`valid:false` 表示音频与当前旁白不一致（已过期），不得当作本镜配音证据。播放时按 `audio_version` 附版本参数避免缓存旧音频。八达岭实测 6 镜 `duration_ms` = 8800/3840/14400/9920/10240/8800。

### `POST /episodes/{e}/narration-skeleton/generate` [R]
Body：**只有 `{config_id?, model?}`**；本端点没有 `model_mode`（`backend/src/routes/narration-skeleton.ts:56-72` 只读这两个键），别把设计卡/`work-estimate` 的 `model_mode` 照抄过来——多传的键会被静默忽略，不会变成「显式指定」。不带 `config_id` 时由 `storyboard_breaker_documentary` 环节自动选健康视觉候选。
AI 按旁白稿拆骨架（只写分镜序号 / `narration_text` / `title` / `continuity`）。首批 `replace_existing` 会硬删本集既有分镜行——重拆需人授权。
返回：**整份骨架状态（同 `GET /episodes/{e}/narration-skeleton`）再加 `task_id`**，所以发起后直接拿返回里的 `task_id` 去轮询 `GET /tasks/{id}` 或 `GET /tasks/{id}/observations`，不用去任务列表里猜。
拒绝发起时是 400 + 中文 `message`（非纪录片 / 旁白稿为空 / 拆分或补镜任务正在运行 / 门禁未过），不是 `started:false` 的 200。
八达岭实测 task 1227 出 6 镜、覆盖 241/241 且无 gap。drama 11 / episode 17 的生产运行同样从发起响应直接拿到 `task_id`（1281）——该轮整体验收仍由主控最终裁定，不在此处升格结论。

### `PUT /episodes/{e}/narration-skeleton` [R]
Body：`{revision, shots:[{id?, narration_text, title?}], validate_only?: true}`
- `revision` 必填，取自刚读到的骨架；不匹配 → 冲突错误，先重读再编辑。
- `shots` 不带 `id` = 新建一镜；原有镜不出现在列表 = 合并/删除。
- 保存按**有序、连续、逐字**重写各镜旁白边界；正文改字会被逐字校验拒绝（要改字回旁白稿）。保存改变 `revision`，**原有确认失效**，须重新确认。
- **`validate_only:true`（#81 新增）= dry-run**：返回 `{problems, gaps:[{start,end,chars,text,next_index}], excerpts:{<行号>: string}}`，**不写库**（八达岭实测：人为删掉第 2 镜首字「它」→ `{start:42,end:43,chars:1,text:"它",next_index:1}`，库未变）。坐标是去空白与 `【】` 节拍标记后的剧本下标（左闭右开）；`next_index` 是该缺口应并入的下一镜序号（等于 `shots.length` 表示结尾缺口）。任一镜旁白在剧本中定位不到时 `gaps` 返回空数组，只看 `problems`。
- **缺口处置就是改这同一份 `shots` 草稿**（都先 dry-run 再正式保存）：
  - **补到上一镜末尾**：把缺口原文接到 `shots[next_index-1].narration_text` 末尾（`next_index=0` 时不可用）。
  - **补到下一镜开头**：接到 `shots[next_index].narration_text` 开头（`next_index === shots.length` 时不可用，该缺口在结尾）。
  - **新建一镜领走这段**：在 `next_index` 位置插入一条**不带 `id`** 的 `{narration_text: 缺口原文, title?}`。
  - 单镜上限 80 字：超长缺口先插新镜再拆分。**属于出处/版权/链接的缺口不要并进旁白**，回 S1-80（`inspect-narration` + 旁白稿保存）处理。

### `POST /episodes/{e}/narration-skeleton/confirm` [R]
Body：`{revision}`。人的确认，Agent 不自行调用。
### `POST /episodes/{e}/narration-skeleton/unconfirm` [S]
破坏性：重锁下游；需人授权。

---

## 6. 设计卡与段组合（S5）

### `GET /episodes/{e}/design-card-context` [R]
返回：候选资产、语义条目、底图候选、段时长上限（图层 ≤30s、生成 ≤15s）。
### `GET /episodes/{e}/design-cards/audit` [R]（#82 新字段亦为 `[R]`：八达岭 drama 10 / episode 16）
返回逐镜结构机检：`combo`、`status`、`budget{layer_s,gen_s}`、`issues`、`unresolved`、旁白估算/实测时长。
#82 新增：
- `tts.duration_ms: number|null` — 当前有效配音的实测毫秒数；为 `null` 时展示「待配音」，**不得**当作 0.0s。
- `unresolved_layers: [{index, type, text, asset_id, asset_name, asset_exists, semantic_id, semantic_name, available_semantics:[{id,name,group}]}]` — 每个未解析锚点属于哪张资产、缺哪个语义条目、该资产现有哪些语义条目。报错时引用这些名字，不要只报 `issue.code`。
- `video_generated: boolean` — 本镜是否已有生成视频。
### `POST /episodes/{e}/design-cards/fill` [R]（#82 行为变更亦为 `[R]`：八达岭 6 镜 AI 首次写入 combo #01 C / #02 D / #03–#06 C）
Body：`{storyboard_ids?, model_mode?:"auto"|"pinned", config_id?, model?}`；不带 `storyboard_ids` = 只补空白/过期，纪录片还会带上「有卡但 `combo` 为空且 `pending`」的镜。
返回（`backend/src/routes/design-cards.ts:254-299`）只有三种 200：`{status:"running", total}`（已入批）、`{status:"running", already_running:true}`（本集已有填卡任务在跑，**不带 total**，不要重复投单）、`{status:"idle", total:0}`（没有要处理的镜）。**本端点不返回 `task_id`**；`GET /episodes/{e}/design-cards/status` 也不带（它是 `PromptBatchStatus`：`{status,total,completed,failed,started_at,finished_at?,...}`）。生产实测即为此形状（episode 17 填卡返回 `{status:"running",total:1}`，状态接口返回 `done` 且无 `task_id`）——**不要因为取不到 `task_id` 就判定失败并停下**：任务照常在跑，误停会白白消耗一次已授权的生成额度。
取本次任务 ID 的可靠办法（生产实测）：投单**前后各取一次** `GET /tasks/center?episode_id={e}&type=text&page_size=200` 快照，在返回行里按 `kind="design_card"` 挑**新出现的那个 ID、且范围与本次提交一致**的行。不要「拿最近一条 active」当答案，也不要凭空编造 `task_id` 字段。`POST /episodes/{e}/work-estimate {stage:"design_card"}` 的 `observation_summary.task_id` 只是「同阶段最近一次」，在投单后未必就是刚投的这一次，只能作对照，不能当本次任务 ID。
前置拒绝：非纪录片 400；资产审核门禁未过按 gate 报错；骨架未确认 → 400 `{error:"skeleton_unconfirmed"}`。
`model_mode` 为 #87 新字段（`[R]`：episode 17 自动模式忽略暂停的 config 10 与残留 model，实际视觉调用均用 Cloud config 14；显式 pin 10 返回 suspended）：`auto` 明确忽略残留 `config_id` **和** `model`，按本阶段选健康候选；`pinned` 必须带正整数 `config_id`，不可用时不静默改用另一计费服务。旧客户端不带 mode 但带 config_id 仍视为显式指定；非法 mode 返回 400（后二项仅源码/自测 `[S]`）。
模型选择错误为 400，`error ∈ model_pin_unavailable | vision_config_unavailable | text_config_unavailable`，含 `stage/stage_label/vision_required/message/alternatives[]`；显式指定不可用还带 `config_id/config_name/reason`（如 suspended/not_vision/inactive/missing/model_mismatch），每个候选含配置 ID、名称、provider/model/vision。仅 suspended 拒绝及 Cloud 替代候选已生产实测 `[R]`，其他错误分支仍 `[S]`。自动模式无候选不代表全局不存在视觉配置；不要按错误文案擅自恢复暂停模型或改视觉标记。
#82 起：模型可直接填 `design_card.combo`，`suggested_combo` 变为可选且仅供展示。
- 该镜**已有 combo** → 保留，模型值被忽略；**无 combo** → 采用模型值。
- 纪录片「有卡无 combo」走 **combo-only 补选**：只写 `combo`，不重写卡片内容。
- 模型给出**非法/缺失 combo** → 该镜计入 `failed`，状态置 `pending` 并把原因写进 `design_card_stale_reason`。
- **AI 依赖校验（#87 新行为 `[S/R]`）**：不存在/空白的必要语义、类型/归属/版本不相容、或有名无所需几何的定位/描线/区域设计，不得通过留空必要字段、“待人工补”而落成成功卡。工具把具体层及原因回给模型沿当前工具循环修正；仍不可实现时按失败处理并保留旧卡。无位置依赖的标题/定义/说明卡及无语义图的合法背景用途不因此被禁止；人工 PUT 不套 AI 限制。episode 17 已真实读取图片并保存五张待审卡 `[R]`；各拒绝边界仅行为自测 `[S]`，任务 completed 不等于卡片零阻断或人工通过。
- 写入后卡片一律 `pending`、`design_card_confirmed_at` 清空；确认仍只能由人按。
### `GET /episodes/{e}/design-cards/status` [R]
用途：填卡任务进度。返回 `PromptBatchStatus`：`{status:"running"|"done"|"error", total, completed, failed, current_storyboard_id?, phase?, started_at, finished_at?, error?}`；从未跑过是 `data:null`。**没有 `task_id`**（取法见上）；`status:"done"` 只表示任务结束，必须查 `failed` 与逐镜卡片状态。
### `PUT /storyboards/{id}/design-card` [R]
Body：`{combo:"A"|"B"|"C"|"D"|null, design_card:{...}}`
`design_card` 结构（实测/源码）：
```
{
 version: 2,                                                             // 当前卡片版本号（services/design-card.ts:102-113）
 info_points: [{id, text, via:"layer"|"generated"|"narration_only"}],   // ≤12 条
 budget: {layer_s: number|null, gen_s: number|null},                     // layer≤30, gen≤15
 rationale: string,                                                      // ≤600
 suggested_combo: "A"|"B"|"C"|"D"|null,                                   // 仅展示；实际 combo 存在分镜列上
 layer_plan: {
   base: {kind:"asset", asset_kind:"character"|"scene"|"prop", asset_id, version_task_id|null} | {kind:"inherit_prev"} | null,
   must_mark: [{asset_id, semantic_id, name, unresolved?, unresolved_reason?}],       // SemanticRef，≤20；不是字符串数组
   planned_layers: [{type:"polygon"|"polyline"|"marker"|"label"|"card"|"image",       // ≤40，按 at_s 升序存
                     at_s: number,                                                    // 必有；缺省/非法归一化为 0
                     text?: string,
                     anchor?: {asset_id, semantic_id, name, unresolved?, unresolved_reason?}}]
 } | null,
 gen_plan: {
   reference_assets: [{kind, id, name}],
   first?: string, mid?: string, last?: string                          // 每个 ≤400 字；只 @ 名字，不写外形
 } | null
}
```
`via:"narration_only"` 表示该信息点只由旁白/字幕承担，不需要画面资产。
`must_mark` / `planned_layers[].anchor` 里的 `asset_id` + `semantic_id` 必须来自 `GET /episodes/{e}/design-card-context` 当场返回的候选资产与语义条目（归一化会丢弃类型不在白名单的层，但**不会**替你造语义）。解析不到的引用会带 `unresolved/unresolved_reason` 落卡，并在 `issues` 里出现 `unresolved_ref`（warn），逐条明细读 `GET /episodes/{e}/design-cards/audit` 的 `unresolved_layers`。下游 `POST /layer-segments/storyboards/{id}/draft` 对无几何的 polygon/polyline/marker 只能告警跳过——所以不要凭想象写语义名，先回资产侧补语义。
- `A` 图层段 only；`B` 生成段 only；`C` 图层→生成；`D` 生成→图层。**没有默认值**：要么由人显式写入本端点/`POST /storyboards/{id}/combo`，要么由 #82 的设计卡批次在该镜尚无 combo 时首次写入；本端点收到的 `combo` 永远视为人工决定，Agent 不自行调用。
- `budget.layer_s` ≤30；`budget.gen_s` ≤15；超限直接 400。
- 写卡后状态回 `pending`，需要重新确认。
- 已确认且已有制作产物时改 `combo` 会被拒（gate `combo_switch`），必须走 `POST /storyboards/{id}/combo`。
### `POST /storyboards/{id}/design-card/confirm` [R]
Body：`{acknowledge?:true}`
- 有 `block` 级 issue → 400；只有 `warn` 时必须 `acknowledge:true` 才放行。
- 400 响应体带 `issues[]`，其中 `message` 是可读原因（#82 起前端与报告都应直接引用它，而不是只显示 `code`）。
- 确认是人的背书，不是 Agent 的“看起来没问题”。
### `POST /storyboards/{id}/design-card/unconfirm` [S]
注意：撤销确认会重锁制作；需人授权，Agent 不自行调用。
### `GET /storyboards/{id}/combo/impact?to=C`、`POST /storyboards/{id}/combo {combo}`、`GET /storyboards/{id}/combo/log` [S]
用途：已有产物时切换组合；先看影响清单（保留/归档/需要新做），再执行并留日志。

---

## 7. 图层段（S6）

### `GET /layer-segments/storyboards/{id}` [R]
返回：`{spec{width,height,fps,source}, combo, design_card_status, production_unlocked, gate_reason, segment, junction{source,t,path,hash,stale,segment_fresh}, issues}`
- 设计卡未确认 → `production_unlocked=false`，不能写/渲。
- `junction` 是 C 的末精确帧、D 的首精确帧；`hash` 用于绑定关键帧确认。

### `POST /layer-segments/storyboards/{id}/draft` [R]
用途：按设计卡 `layer_plan` 生成图层段草稿。无合格底图 → 400 `missing_base`（回设计卡指定底图）。

### `PUT /layer-segments/storyboards/{id}` [R]
Body 四选一/组合：`{layer_doc?, timeline?, duration?, base_ref?}`
- `layer_doc`：`{version, base:{path,width,height,source_width,source_height,crop?}, theme, layers[]}`
  - 图层类型：`label`（文字，`box{x,y,w,h}` 0–1、`style{font,size,color,bold,align,stroke_width,bg_opacity}`）、`polygon`/`polyline`（`points` 0–1、`style{fill/fill_opacity/stroke/width/arrow_end}`）、image 等。
  - `z` 控制叠放；`visible` 控制默认可见性。
- `timeline`：`{fps, ease:"inout"|..., fade_ms, keyframes:[{t, viewport{x,y,w,h}, visible:[layerId]}]}`
  - **`fps` 不是可选项，是派生值**：保存时服务端一律写成本集目标帧率（`services/layer-segment.ts:266-272`），请求里的 `fps` 不生效。目标帧率取「本集最前一条有效图层计划的 `timeline.fps`」→ 没有计划时取本集首条模型视频的实测帧率（保留三位小数，29.97 不取整为 30）→ 都没有才用内置默认 25（`services/layer-segment.ts:101-103,520-560`，范围 1–60、允许小数）。
  - 因此 **24 / 29.97 等既有计划帧率会被沿用**（#69），不要为了「统一 25」去改已有集；原生合成会用 fps 滤镜把模型视频统一到这个目标帧率。要确认当前值就读 `GET /layer-segments/storyboards/{id}` 的 `spec.fps`（`spec.source` 只说明**画幅**来自 video 还是 default，不代表帧率来源）。
- `duration`：图层段秒数（≤30）。
- `base_ref`：A 镜的确定性底图引用（真实照片/地图按 contain 摆放，不重绘）。结构：
  `{kind:"asset", asset_kind:"character"|"scene"|"prop", asset_id, version_task_id:number|null, unresolved?, unresolved_reason?}` 或 `{kind:"inherit_prev"}`；`null`=无引用。
  资产版本变化/文件丢失会让段 `stale_reasons` 出现 `base_ref_unresolved`，需回设计卡指定底图。

### `POST /layer-segments/storyboards/{id}/render` [R]
用途：同步渲染 mp4 + 出衔接帧，建 `sys_task`。返回 `{task_id, spec, segment, junction, keyframes_invalidated}`。
注意：重渲改变 junction hash 会让已确认关键帧失效；必须重新确认。

### `GET /layer-segments/storyboards/{id}/thumbnail/{which}` [R]
`which`：`first|last|frame-<index>`。用途：实际查看文字排版/几何，不能只看 render 200。

### `GET /layer-segments/storyboards/{id}/junction` [R]
用途：下载衔接帧原图（C 末帧/D 首帧），用于与生成视频首/尾帧比对。

### `GET /layer-docs/fonts`、`POST /layer-docs/render` [S]
用途：字体清单与无状态画布渲染（调试/预览）。生产渲染走上面 render。

### 图层段批量 [S]
`POST /episodes/{e}/layer-render-batch/preview`、`GET /episodes/{e}/layer-render-batch-status`。
用途：整集图层段预览/批量渲染；与关键帧批量一样先预览再入批。

---

## 8. 关键帧（S7）

### `GET /episodes/{e}/keyframe-prompts/scope` [S/R]
用途：批量范围与排除原因（A 组合无生成段、设计卡未确认等）。
### `POST /episodes/{e}/generate-keyframe-prompts` [R]
Body：`{storyboard_ids?, config_id?, model?}`；只写提示词，不出图。
### `GET /episodes/{e}/keyframe-prompts-status` [R]
用途：提示词任务进度。
（S7 其余端点：批量 `/episodes/{e}/keyframe-batch*`；单镜 `/storyboards/{id}/keyframes/*`、`/storyboards/{id}/confirm-keyframes`。）

### `POST /episodes/{e}/keyframe-batch/preview` [R]
Body：`{storyboard_ids?, config_id?, model?}`
返回逐「分镜×槽位」`status`：
- `missing`（无图，默认勾）、`changed`（签名与所有历史版本都不同，默认勾）、
- `unchanged`（命中历史签名，带 `matched_version_no`/`selected_version_no`，默认不勾）、
- `blocked`（一致性阻断，不可勾，带 `issues`）、
- `skipped`（提示词为空 / C-first/D-last 锁定 / A 无生成段 / 正在生成）。
`scope.excluded` 说明整镜被排除的原因（如 `no_generated_segment`）。

### `POST /episodes/{e}/keyframe-batch` [R]
Body：`{items:[{storyboard_id, slot:"first"|"mid"|"last"}], config_id?, model?}`
必须来自预览的非空勾选；服务端会复查，变成阻断的项跳过并标注原因。
### `GET /episodes/{e}/keyframe-batch`、`POST …/cancel`、`POST …/retry-failed` [S/R]
用途：进度/停止/只重试失败项（新建 sys_task，不重跑已成功项）。

### `POST /storyboards/{id}/keyframes/{slot}/generate` [R]
Body：`{config_id?, model?, prompt?}`
- 设计卡未确认 → 400；锁定槽（C-first / D-last / 承接首帧）→ 400 `slot_locked`。
- 该槽位有阻断 `ref_issues` → 400 并列出问题。
### `GET /storyboards/{id}/keyframes/{slot}/versions` [R]
返回历史版本 `version_no` + `signature`。
### `PUT /storyboards/{id}/keyframes/{slot}` [R]
Body：`{image}` 选版本；或 `{inherit:true}`（仅首帧，承接上一镜尾帧）。
注意：选版变化会自动取消关键帧确认，并连带取消继承它的下一镜。
### `POST /storyboards/{id}/confirm-keyframes` [R]
Body：`{confirmed:true|false}`；`ready` 要求首帧与尾帧都有图，且写了中间帧提示词的必须有中间帧图。
确认会快照当前 junction hash；图层重渲后 hash 变 → 确认自动作废。

---

## 9. 旁白、配音、字幕、音画适配（S8）

顺序：**旁白文稿 → 配音 → 实测时长 → 字幕 → narration-fit → 视频 Prompt 时长对齐 → 关键帧确认 → 视频**。顺序错了会出现视频尾段时长与实测配音不符。

### `GET /episodes/{e}/tts-options?storyboard_id=` [R]
用途：实时读 VoxCPM 音色列表（我的音色 + 预置分类）与步数/cfg 范围。
### `POST /episodes/{e}/narration/voice-batch/preview` [R]
Body：`{storyboard_ids?, settings:{voice, inference_timesteps, cfg_value, seed|null, instructions, normalize}}`
返回 `missing`（无配音）/`changed`（文本哈希变或参数变）分类，无副作用。
### `POST /episodes/{e}/narration/voice-batch` [R]
同一 body；只配 `missing` + `changed`；带 `settings` 时保存为本集默认参数。
返回 `{status:"running", total, task_id, scope}`（真的入批时才有 `task_id`）／`{status:"running", already_running:true, total, completed, scope}`（本集已有配音任务，**无 task_id**，改去读状态）／`{status:"idle", total:0, scope}`。
### `GET /episodes/{e}/narration/voice-batch-status` [R]
返回 `PromptBatchStatus` 再加 `{task_id, scope, items[]}`——**配音是三个阶段里唯一能从状态接口直接拿到 `task_id` 的**，可直接拿去 `GET /tasks/{id}/observations`；从未跑过是 `data:null`。drama 11 / episode 17 生产运行的配音任务 ID 为 1282（发起响应与状态接口一致）。
### `POST /episodes/{e}/narration/voice-batch/retry-failed` [S]
### `POST /storyboards/{id}/narration/voice` [S/R]
Body：`{settings?}`；单镜配音（整镜一次），带 settings 时校验并保存为本集默认。
### `POST /storyboards/{id}/narration/write` [S]
Body：`{config_id?, model?}`；单镜旁白写作/重写。
### `POST /episodes/{e}/generate-narration` [S]
Body：`{storyboard_ids?, config_id?, model?}`；整集旁白写作（需 `narration_enabled=true`）。
### `GET /episodes/{e}/narration-status`、`GET /episodes/{e}/narration-coverage` [S/R]
用途：写作进度；覆盖率（应为 100%）。
### `POST /storyboards/{id}/narration/subtitle` [R]
用途：按当前时间码模式重生成字幕（不重跑 TTS）。
### `GET /storyboards/{id}/narration-fit/preview` [R]
返回 `dv/da/daScaled/t/d/narrationStart/freezeSeconds/trim/availSeconds/gapRatio/blocked/blockReason/suggested_chars`。
### `PUT /storyboards/{id}/narration-fit` [R]
Body：`{mode:"pad"|"tempo", pad_ms:0–3000, pad_position:"head"|"tail", tempo_override:0.77–1.3, audio_mix_mode:"replace"|"mix"}`
注意：PUT 会**新建完整镜级 record，不与旧 override 合并**；省略 `pad_*` 回默认 800ms tail；要回继承用 `DELETE /storyboards/{id}/narration-fit`。
任何长度阻断 400 都读结构化 `block_reason/gap_ratio/current_sec/avail_sec/suggested_chars`，不得截断旁白凑时长。

---

## 10. 视频（S9）

### `POST /episodes/{e}/generate-video-prompts` [R]
Body：`{storyboard_ids?, config_id?, model?}`；把已定分镜写成时间段动作/运镜/表演，不重拆镜头。
### `GET /episodes/{e}/video-prompts-status` [R]
（S9 其余端点：批量 `/episodes/{e}/video-batch*`；单镜 `/storyboards/{id}/generate-video`；估计 `/video-queue/estimate`。）

### `POST /episodes/{e}/video-batch/preview` [R]
Body：`{storyboard_ids?, config_id, model}`
返回逐镜：`missing`（无版本，默认勾）、`changed`（与所有可比版本都不同，带 `change_reasons`）、`unchanged`（命中历史签名，默认不勾但可强出）、`unknown`（历史缺对比字段）、`blocked`（不可勾）、`skipped`（正在生成）、`excluded`（A 组合 `no_generated_segment`）。
### `POST /episodes/{e}/video-batch` [R]
Body：`{storyboard_ids:[...], config_id, model}`；必须来自预览勾选；逐镜复查，变为阻断的标 `skipped` 并继续。
### `GET /episodes/{e}/video-batch`、`POST …/cancel`、`POST …/retry-failed` [R/S]
注意：停止只是不再提交新镜头，在跑的那一镜跑完才转 `cancelled`。重试新建任务，不重跑已成功项。
### `POST /storyboards/{id}/generate-video` [S/R]
Body：`{config_id?, model?}`；单镜生成。要求关键帧已确认且 `video_prompt` 无阻断问题；模型不支持关键帧引导时直接 400。
### `GET /video-queue/estimate?config_id=&model=&duration=` [R]
返回中位数墙钟估计（含排队/上传/扩写/下载），文案必须是「预计/用时」，不是渲染耗时。
### 视频版本 [S]
`GET /storyboards/{id}/video/versions`（按内容签名编号，`describeSignatureDiff` 给变化分项）。

---

## 11. 单镜合成（S10）

### `POST /storyboards/{id}/compose` [S]
无 body；同步生成「视频 + 旁白音轨 + 烧录字幕」的融合片。
**签名版本按是否有 combo 分叉**（`services/compose-state.ts:70-137`）：纪录片（该镜有 `combo`）写 **v4**，摘要额外含 combo、图层段片段键、衔接帧 hash 与视频任务 ID；没有 combo 的剧情镜仍写 **v2**，字节完全不变（所以存量剧情成片不会因为版本升级被判 changed）。看到旧文档里「compose 一律写 v2 签名」按本节纠正。`signature_version < 2` 的历史行读成 `unknown`，由人决定是否重做。
### `POST /episodes/{e}/compose-batch/preview` [R]
Body：`{storyboard_ids?}`（省略=整集，显式 `[]`=空范围）
返回逐镜 `status`（missing/changed/unchanged/unknown/blocked/skipped）、`exportable`、`plan`、`signature`、`inputs{video,audio,subtitle,pure_visual}`、`change_reasons`。
### `POST /episodes/{e}/compose-batch` [R]
Body：`{storyboard_ids:[...]}`；显式非空数组；串行执行、持久化进度。
### `GET /episodes/{e}/compose-batch-status` [R]
返回 `{status,total,completed,failed,skipped,current_storyboard_id,items[{storyboard_id,state,reason}]}`。
`done` 仍要逐项检查 `failed/skipped`。
### `POST /episodes/{e}/compose-batch/retry-failed` [S]

---

## 12. 导出与拼接（S11）

**路径前缀**：merge router 挂在 `/merge`（`backend/src/index.ts:121`），完整路径是 `/merge/episodes/{e}/...`。写成 `/episodes/{e}/merge` 会命中 SPA，返回 **200 + text/html**（八达岭实测踩中），必须校验 `Content-Type`。

### `GET /merge/episodes/{e}/merge` [R]
用途：最新拼接任务状态与结果（`merged_url`、history）。
### `POST /merge/episodes/{e}/merge` [R]
Body：`{storyboard_ids:[...], poster_version_id?, poster_duration?}`
- `storyboard_ids` **省略 = 整集**；导出必须显式传所选镜头，避免意外全量。
- `poster_version_id` + `poster_duration`（秒，默认 3，钳 0.5–10）= 可选片头。
- 旁白开启时任一镜未 `exportable` → 整体 400 并返回 `blocked[]`；不得静默回退原片或少镜。
返回：`{merge_id, status:"processing", skipped:[]}`（受理，不是完成）。八达岭实测：显式 IDs `[511..516]` → merge **27** completed，`skipped:[]`，媒体 960×544 / 65.44s。
### `GET /merge/episodes/{e}/merges` [R]
用途：历史导出记录。
### `DELETE /merge/episodes/{e}/merges/{mergeId}` [S]
用途：删除导出记录；破坏性，需人授权。

---

## 13. 任务与返工（贯穿全流程）

### `POST /tasks/{id}/retry` [S/R]
Body：`{config_id?, model?}`；只改模型/配置，提示词只读；一律新建 sys_task（`params.retry_of`）。
注意：剧本改写/拆分镜的重试会覆盖本集剧本/分镜；必须先获人授权。
### `POST /tasks/{id}/cancel` [S]
仅部分任务（当前 qwen-jobs 图片）可取消；不能假设文本/视频都能取消，更不能为停止文本任务重启服务。
### `DELETE /tasks/{id}` [S]
需授权。

---

## 14. 素材库与资产库（可选）

### `GET /media-library/dramas`、`GET /media-library/tree?drama_id=`、`GET /media-library/images?...` [S]
用途：浏览历史图片（资产版本、关键帧、参考图）。
### `POST /media-library/copy {url}` [S]
用途：把库内单图复制为新上传（先过白名单）。返回 `{url,path,copied_from}`。
### `GET /asset-library?drama_id&kind&q&target_drama_id`、`GET /asset-library/{kind}/{id}` [S]
### `POST /episodes/{e}/assets/link`、`POST /dramas/{d}/assets/import {kind, source_id, name?, episode_id?}` [S]
用途：本项目复用=关联同一资产；跨项目=全量复制（改名、保留历史时间、派生字段重置）。

---

## 15. 设置类（默认只读，写入需单独明确授权）

`GET/PUT /ai-configs/*`、`GET/PUT /prompts/{type}`、`GET/PUT /skills/*`、`GET/PUT /settings/content-language`、`GET/PUT /dramas/{d}` 的风格/画幅。
- 默认自主执行**不改**供应商、全局 Prompt、Skill、内容语言。
- 发现规则缺陷：写证据与建议，交给独立维护任务；不擅自改全局配置。
- 用户单独明确授权后，只做最小写入并读回对照，不保存/泄露密钥，不扩大授权范围。
