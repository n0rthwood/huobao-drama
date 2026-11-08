# 火宝分阶段 API 目录（Agent 操作面）

所有路径都相对 `HUOBAO_API = {HUOBAO_BASE}api/v1/`（默认 `http://172.30.3.164/huobao/api/v1/`，以会话配置为准）。
拼接时**去掉路径开头的 `/`** 再拼；用 `urljoin` 会把 `/huobao/api/v1` 前缀丢掉，打到 SPA。
标注：`[R]` = 真实跑通（2026-11-05 殷墟五镜诊断片，和/或 2026-11-08 八达岭长城测试 1008 生产验收 drama 10 / episode 16 / merge 27）；`[S]` = 仅源码核对，未在这两轮运行；`[S/R]` = 部分实测或只跑通读路径，写入前先用 GET/preview 校验。
本目录对齐 `origin/master` `5d08b18`（含 Issue #80/#81/#82）；八达岭轮**实际调用过的**端点与字段标 `[R]`（证据见 `docs/qa/8daling-1008-20261108T061008Z/`），本轮未调用的仍保持 `[S]`（如 `script-rewrite/final`、`versions/{id}/adopt`、`runs/{id}/manual`、各 `unconfirm`、`DELETE` 类）。

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
`resolution` 是生成档位，不等于最终画布：最终输出按项目 `aspect_ratio` 定尺寸（16:9=960×544），关键帧按画幅定尺寸（16:9=1344×768），两者不要混用。

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
multipart `file`；返回 `{url,path}`。用于本地上传原件（地图、照片、Poster 画布）。
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

---

## 4. Poster（S3，可选旁路，在资产之后）

### `GET /episodes/{e}/poster` [R]
返回：编辑工程 `{prompt, base_image, reference_images, layout, variables, versions[]}`。
### `PUT /episodes/{e}/poster` [R]
Body：`{prompt, base_image, reference_images[], layout:{texts:[{id,kind,text,x,y,width,fontSize,fontFamily,color,bold,align,strokeWidth,shadow}]}}`
坐标/字号是 0–1 比例。
### `POST /episodes/{e}/poster/generate` [S/R]
Body：`{mode:"initial"|"composite"|"layers"}`；异步生成海报版本。
### `POST /episodes/{e}/poster/versions` [R]
Body：`{image, base_image, layout}`；登记本地渲染的文字画布（必须先用 `POST /upload/image` 上传）。
### `PUT /episodes/{e}/poster/select` [R]
Body：`{version_id}`；选定最终海报。

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
Body：`{config_id?, model?}`；AI 按旁白稿拆骨架（只写分镜序号 / `narration_text` / `title` / `continuity`）。首批 `replace_existing` 会硬删本集既有分镜行——重拆需人授权。八达岭实测 task 1227 出 6 镜、覆盖 241/241 且无 gap。

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
Body：`{storyboard_ids?, config_id?, model?}`；不带 `storyboard_ids` = 只补空白/过期，纪录片还会带上「有卡但 `combo` 为空且 `pending`」的镜。
#82 起：模型可直接填 `design_card.combo`，`suggested_combo` 变为可选且仅供展示。
- 该镜**已有 combo** → 保留，模型值被忽略；**无 combo** → 采用模型值。
- 纪录片「有卡无 combo」走 **combo-only 补选**：只写 `combo`，不重写卡片内容。
- 模型给出**非法/缺失 combo** → 该镜计入 `failed`，状态置 `pending` 并把原因写进 `design_card_stale_reason`。
- 模型写了**不存在的 `semantic_id`/`name`** → 工具直接回错给模型、本镜不落卡；批次计 `failed` 但**保留原状态与原 stale_reason**（不写 `design_card_stale_reason`），原因只在任务输出/日志里。
- 写入后卡片一律 `pending`、`design_card_confirmed_at` 清空；确认仍只能由人按。
### `GET /episodes/{e}/design-cards/status` [R]
用途：填卡任务进度。
### `PUT /storyboards/{id}/design-card` [R]
Body：`{combo:"A"|"B"|"C"|"D"|null, design_card:{...}}`
`design_card` 结构（实测/源码）：
```
{
 version: number,
 info_points: [{id, text, via:"layer"|"generated"|"narration_only"}],   // ≤12 条
 budget: {layer_s: number|null, gen_s: number|null},                     // layer≤30, gen≤15
 rationale: string,                                                      // ≤600
 suggested_combo: "A"|"B"|"C"|"D"|null,                                   // 仅展示；实际 combo 存在分镜列上
 layer_plan: {
   base: {kind:"asset", asset_kind:"character"|"scene"|"prop", asset_id, version_task_id|null} | {kind:"inherit_prev"} | null,
   must_mark: string[],                                                  // ≤20
   planned_layers: [{type:"label"|"polygon"|"polyline"|..., at_s?:number, text?, ...}]  // ≤40
 } | null,
 gen_plan: {
   reference_assets: [{kind, id, name}],
   first?: string, mid?: string, last?: string                          // 每个 ≤400 字；只 @ 名字，不写外形
 } | null
}
```
`via:"narration_only"` 表示该信息点只由旁白/字幕承担，不需要画面资产。
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
  - `fps` 会被持久化，作为该集图层段的目标帧率（1–60，允许小数）。保持 25 与最终视频一致，避免混帧率 stale。
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
同一 body；只配 `missing` + `changed`；保存为本集默认参数。
### `GET /episodes/{e}/narration/voice-batch-status` [R]
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
无 body；同步生成「视频 + 旁白音轨 + 烧录字幕」的融合片，写 v2 签名。
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
