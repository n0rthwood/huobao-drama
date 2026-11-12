# 火宝生产 API 参考（agent / storyboards / posters / merge / episodes 生产路由）

> **历史参考（2026-11-02 快照，revision `7ad79f6`）。本文件不是当前可执行指令。**
> 当前契约以 `SKILL.md` 与 `references/api-catalog.md`（源码快照：#86/#87 功能提交 `4a43731`，已合并 main `5f19f4a`，发布 `release 20261108T191425Z`）为准；冲突时一律以 api-catalog 为准。本文件保留 drama 5 / episode 6 的真实运行证据（请求、响应、媒体校验），**证据不删**，但其中的操作配方已被下列变更作废：
>
> | 本文写法（已过时） | 当前事实（见 api-catalog） |
> |---|---|
> | Poster 用 `layout:{texts:[...]}`，本地脚本渲染 PNG → `POST /upload/image` → `POST /poster/versions {image,...}` | Poster 工程是 `layer_doc`（旧 `layout` 不再读写）；`POST /poster/versions {layer_doc?}` 由**服务端**渲染合成图并登记、设为最终版本，不需要上传画布；另有 `/poster/concept*`、`/poster/load-version` 流程（api-catalog §4） |
> | 「compose 写 v2 签名」 | 有 `combo` 的纪录片镜写 **v4**，无 combo 的剧情镜仍写 v2（`services/compose-state.ts:70-137`，api-catalog §11） |
> | §6A 的「剧本 → 分镜 → 关键帧 → 旁白/配音 → 视频」顺序，以及纪录片用 `POST /agent/script_rewriter/chat` 改写 | 纪录片改写入口是 `POST /episodes/{e}/script-rewrite`（`script_rewriter/chat` 对纪录片**直接 400**）；时长必须先由配音实测确定，**配音在关键帧/视频之前**（见下方 §6A 的当前顺序） |
> | 图层段 `timeline.fps` 由调用方设定、「保持 25」 | `fps` 是派生值，沿用本集既有计划帧率（24 / 29.97 等照常保留，#69），请求里的 fps 不生效 |
> | 「16:9 最终输出 = 960×544」 | 960×544 是无视频时的 16:9 兜底值，也是当时那一集的实测结果；画布以本集首条模型视频实测为准 |
>
> 标 `[S]` 的契约在任何写入前都要重新 GET/预览校验；标 `[R]` 的只证明 2026-11-02 那一轮真实发过的请求，不得外推到别的集或别的参数。

依据 2026-11-02 源码核对（当时 `huobao-drama` revision `7ad79f6be09c7665c88193953fa1ca067de17f1a`；`backend/src/routes/{agent,storyboards,posters,merge,episodes}.ts` + `backend/src/services/{posters,poster-layout,narration-fit,narration-fit-service,narration-voice,narration-voice-params,narration,compose-state,keyframe-batch,video-batch,shot-compose,ffmpeg-merge}.ts`）以及 drama 5 / episode 6 的既有运行证据。源码证据和文件 SHA-256 见 `work/huobao-director-charcoal-20261102/compose-current/source-contract.{md,json}`，实际调用和媒体检查见 `compose-final/`。该 revision 早已变更，照本文行动前必须按 api-catalog 重扫。

路径拼接规则：`HUOBAO_API` 以 `/api/v1` 结尾（当前批准部署为 `http://172.30.3.164/huobao/api/v1/`），本文以 `/` 开头的路径与其直接字符串拼接。响应统一 `{code:200|201, data, message}`；错误为 400/404 + 中文 `message`；**收到 200 `text/html` 一律是路由/前缀错误，不是成功**。除特别注明外，POST/PUT 请求体为 JSON。返回 `static/...` 或 `/static/...` 媒体要保留部署前缀下载，例如 `http://172.30.3.164/huobao/static/...`；`POST /upload/image` 仍是通用图片落盘入口（返回 `path` = `static/...`），但它**不再**是 Poster 合成版本的登记前置。

> **最终合成的 2026-11-02 记录：**下面 §2/§3/§5 的通用契约来自 revision `7ad79f6`；d5/e6 的三镜实例在源 hash 再核对后以 JSON Content-Type、明确 IDs、实时 `compose_state` 和实际媒体进行验证。当时已有 `POST /episodes/{e}/compose-batch/preview`，以服务端 `compose_state` 签名统一单镜、批量与导出 readiness（签名版本口径见上表）；不要把任何旧 `compose_stale` 报告认作现存 bug。运行只验证所列路径和证据，不自动构成人工艺术批准。

## 0. 覆盖清单（method + path → 本文档节）

标记说明：**[S]** = source-verified（源码核对，未实跑）；**[R]** = runtime-tested（下表标 [R] 的路径已在 `work/huobao-director-charcoal-20261102/timeline-resume/`、`poster-resume/`、`compose-current/preflight/` 或 `compose-final/` 实际请求；适用时另下载查看媒体）。[R] 只证明该请求链路和所记载的观察结果；不代表人类艺术批准、独立审核通过或端到端质量放行。d5/e6 的 compose batch 与 merge 成功返回、轮询、真实文件解码和抽帧都已跑；最终文件仍须把音频逐段完整性作为单独的媒体检查，不能由 `completed` 推断。

| Method + Path | 节 | 标记 |
|---|---|---|
| POST /agent/{type}/chat | §1 | [R]（已实际调用 `storyboard_breaker`；其它 type 仍 [S]） |
| GET /agent/{type}/debug | §1 | [S] |
| GET /episodes/{e}/storyboards | §2 | [R] |
| POST /storyboards | §2 | [S] |
| PUT /storyboards/{id}（手动编辑/改 Prompt） | §2 | [R]（窄改 Prompt／旁白） |
| PUT /storyboards/{id}/target-assets/{target} | §2 | [S] |
| POST /storyboards/{id}/keyframes/{slot}/generate | §2 | [R]（单槽重生） |
| GET /storyboards/{id}/keyframes/{slot}/versions | §2 | [R] |
| PUT /storyboards/{id}/keyframes/{slot}（选版/继承） | §2 | [S] |
| POST /storyboards/{id}/confirm-keyframes | §2 | [S] |
| POST /storyboards/{id}/transition | §2 | [S] |
| POST /storyboards/{id}/narration/write | §2 | [S] |
| POST /storyboards/{id}/narration/voice | §2 | [S] |
| POST /storyboards/{id}/narration/subtitle | §2 | [R] |
| POST /storyboards/{id}/compose（当前同步视频＋音轨＋烧录 SRT） | §2 | [S]（单镜路径未实跑；d5/e6 已验证等价 compose-batch） |
| GET/PUT/DELETE /storyboards/{id}/narration-fit（preview/保存/清除） | §2 | [R]（GET + PUT；DELETE 未跑；compose-batch 前后均复读） |
| POST /storyboards/{id}/generate-video | §2 | [S] |
| DELETE /storyboards/{id} | §2 | [S] |
| PUT /episodes/{id}（含旁白字段） | §3 | [S] |
| POST /episodes/{e}/generate-keyframe-prompts + /keyframe-prompts-status | §3 | [R] |
| POST /episodes/{e}/generate-video-prompts + /video-prompts-status | §3 | [R]（仅文字 Prompt，不是视频） |
| POST/GET /episodes/{e}/keyframe-batch（+preview/cancel/retry-failed） | §3 | [R]（preview + POST + GET；cancel/retry-failed 未跑） |
| POST/GET /episodes/{e}/video-batch（+preview/cancel） | §3 | [S] |
| POST /episodes/{e}/generate-narration + /narration-status | §3 | [R] |
| GET /episodes/{e}/narration-markup-catalog | §3 | [R] |
| GET /episodes/{e}/tts-options | §3 | [R] |
| POST /episodes/{e}/narration/voice-batch（+preview, /voice-batch-status） | §3 | [R] |
| POST /episodes/{e}/compose-batch/preview | §3 | [R]（d5/e6 从 blocked 到三项 missing/selectable，合成后均 unchanged/exportable） |
| POST /episodes/{e}/compose-batch | §3 | [R]（d5/e6 显式 `[119,120,121]`，串行终态 completed:3/failed:0/skipped:0） |
| GET /episodes/{e}/compose-batch-status | §3 | [R]（未启动 null 与上述 completed 终态） |
| GET /episodes/{e}/pipeline-status；extract/extract-status；assets/link；character-roster；characters/scenes/props | §3 | [S] |
| GET/PUT /episodes/{e}/poster；POST /poster/generate（仅 `mode:"initial"`）；POST /poster/versions；PUT /poster/select | §4 | **契约已变更，不可照用**（当时 [R]：`layout` + 上传画布登记；`composite`／`layers` 当时 [S]）→ 见 api-catalog §4 |
| POST /merge/episodes/{id}/merge | §5 | [R]（d5/e6 fail-closed 400，以及显式三镜＋Poster 9/2s 的 merge 21 成功） |
| GET /merge/episodes/{id}/merge；GET /merge/episodes/{id}/merges | §5 | [R]（null/[]、merge 21 completed 与 history 读回） |
| DELETE /merge/episodes/{id}/merges/{mergeId} | §5 | [S] |
| POST /upload/image（multipart `file`；通用图片落盘入口） | §4 | [R]（当时用于上传 Poster 画布；Poster 登记已改服务端渲染，该用途作废） |

通用约定：


- 异步批量接口返回 `running` 只表示受理；必须轮询对应 status 接口。
- `model`（string，可选）覆盖文本/图像模型；`config_id`（number，可选）指定 AI 服务配置。批量预览与启动**必须用同一组 model/config_id**，否则签名口径不一致。
- 时间戳多为 unix 秒；`pad_ms` 等以 `_ms` 结尾的为毫秒。

---

## 1. Agent（`routes/agent.ts`）

### POST /agent/{type}/chat — 非流式 Agent 对话
- `type` ∈ `script_rewriter | extractor | storyboard_breaker | prompt_generator | transition_writer | narration_writer`（其余 400 无效的 Agent 类型）。
- Body：`message`（string，必填）、`drama_id`（number，必填）、`episode_id`（number，必填）、`model?`、`config_id?`。
- 同步执行（内部 maxSteps=20），也登记进任务中心（GET /tasks/{id} 可查）。
- 200 `data`: `{type:"done", text, toolCalls:[{toolName,args}], toolResults:[{toolName,result}]}`。
- 失败：400 + 模型/工具错误消息。
- **拆分镜覆盖语义**：`storyboard_breaker` 内部工具 `save_storyboards` 的第一批必须 `replace_existing:true`（清空本集旧分镜后写入；按 shot_number upsert，后续批次追加）。该开关由 Agent 按指令自动执行——完整重拆即是覆盖性操作，调用前要快照 `GET /episodes/{e}/storyboards`。
- 旁白条件技能按 `episodes.narration_enabled` 自动注入，无需传参。

示例（拆分镜，覆盖式）：
```json
POST /agent/storyboard_breaker/chat
{"drama_id":1,"episode_id":9,"message":"按当前剧本拆分整集分镜；实验演示镜头，2-3 段，每段 8-15 秒；道具跨镜连续。"}
```

### GET /agent/{type}/debug — 只读探针
校验 `type` 合法性：200 `{agent_type, valid:true}`；非法 400「无效的 Agent 类型」。无副作用，可用于开工自检。

---

## 2. 分镜（`routes/storyboards.ts`）

### GET /episodes/{episode_id}/storyboards — 分镜列表（核心读接口）
每镜返回（snake_case）全部分镜字段 + 计算字段：
- `character_ids`, `prop_ids`, `characters[]`, `props[]`（本镜绑定资产全量对象）
- `target_assets`：每个目标（first/mid/last/video）按提示词 @ 引用解析出的资产与所选图。**[R；负向 @ 绑定证据 `timeline-resume/s01-jar-binding-before.json`、`timeline-resume/calls/010-read-storyboards-after-split-response.json`；修正证据 `timeline-resume/s01-jar-binding-before-after.json`] 自动拆镜后的必查项**：目标 Prompt 中即使用否定句提及 `@资产名`，该资产仍会被解析并绑定；不在画面中的资产应完全不带 @ 提及。可见且跨镜交互的物件须有相应资产锚点。逐目标将此数组与实际画面状态比对，不能只看镜级 `prop_ids`。
- `field_saved_at`：字段级保存时间（人工编辑判据）
- `ref_issues[]`：参考图一致性/旁白问题（`severity:'block'` 会阻断对应生成）
- `keyframes`: 各槽位生效图/版本/继承/ready/confirmed
- `video_versions[]`: 历史视频版本 `{id,url,provider,model,created_at,generated_at,is_current}`
- `transition_review`, `transition_stale`
- `narration_meta`, `narration_status`, `narration_chars`, `narration_estimate_seconds`, `narration_normalize_effective`, `subtitle_timing_effective`, `narration_fit_effective`（含 `inherited`）
- `media_generated_at`: 路径→生成 unix 秒

### POST /storyboards — 手工新建分镜
Body：`episode_id`*、`storyboard_number`（默认 1）、`title?`、`description?`、`scene_id?`、`duration?`（默认 10 秒）、`character_ids?: number[]`、`prop_ids?: number[]`。绑定资产必须是本集已关联资产（`validateStoryboardBindings`），否则 400。201 返回新行。

### PUT /storyboards/{id} — 手工编辑（含手动改 Prompt）
可写白名单字段：`title, description, shot_type, angle, movement, duration, video_prompt, scene_id, location, time, atmosphere, result, bgm_prompt, sound_effect, video_url, first_frame_prompt, mid_frame_prompt, last_frame_prompt, mid_frame_time, continuity_boundary, transition_prompt, narration_text` + 开关 `transition_enabled`（bool）、`narration_enabled`（bool，本镜纯画面）、`subtitle_timing`（`sentence|char`|''=继承集级）、`narration_normalize`（bool|null=继承）、`character_ids`、`prop_ids`。
约束：
- `continuity_boundary` ∈ `continue|cut|null`（null=按硬切）。
- `mid_frame_time`（秒）必须满足 `0.5 < t < duration-0.5`。
- **只传本次要改的字段**；未传字段不动。
副作用：
- 写入任何提示词字段（first/mid/last_frame_prompt、video_prompt）→ 资产池按 @ 并集重算、该提示词的目标绑定重算（同请求显式传的 character_ids/prop_ids 会被提示词口径覆盖）；`transition_prompt` 写入 → 标记 edited_manually，之后不被自动审核覆盖。故要移除错误目标绑定，必须从相应 Prompt 删除 `@资产名`，以无 @ 的普通文字表达否定状态；**只 PUT `prop_ids` 不能覆盖 Prompt 重新计算的绑定**。
- 纯资产池编辑（不含提示词字段）保持用户选择。
返回：`{saved_at, character_ids, prop_ids, scene_id, transition_review, ref_issues, target_assets, ref_sync:{bound[],unbound[]}}`。**改完必须重新 GET 列表核对**未授权字段未变，并逐目标核对 `target_assets`；随后才以 `PUT /storyboards/{id}/target-assets/{target}` 给应出现的资产选图。

### PUT /storyboards/{id}/target-assets/{target} — 目标级资产选版
`target` ∈ `first|mid|last|video`。Body：`kind` ∈ `scene|character|prop`、`asset_id`（正整数）、`image`（该资产已存在的图片路径，或 `null` 恢复默认最新图）。返回 `{target_assets, ref_issues}`。

### POST /storyboards/{id}/keyframes/{slot}/generate — 单槽关键帧
`slot` ∈ `first|mid|last`。Body：`prompt?`（string；**非空才会保存**，空串不清除既有提示词；带 prompt 会先保存并同步该槽位 @ 绑定）、`model?`、`config_id?`。该镜在关键帧批量队列中时 400。201 返回 sys_task 记录（轮询 GET /tasks/{id}）。

### GET /storyboards/{id}/keyframes/{slot}/versions
版本列表，最新在前；版本号按时间从 1 递增。

### PUT /storyboards/{id}/keyframes/{slot} — 选版 / 首帧继承
Body：`{image: "<版本路径>"}` 或（仅 first）`{inherit:true}`。
- `image` 必须是**本镜该槽位的历史版本**（服务端校验 sys_task 归属），否则 400「不是本镜…历史版本」。
- `inherit:true` 要求非第一镜且 `continuity_boundary='continue'`，否则 400。
副作用：选定图变化 → `keyframesConfirmed` 作废（继承它的下一镜连带作废），需重新人工确认。返回完整 storyboardJson。

### POST /storyboards/{id}/confirm-keyframes — 人工确认闸门
Body `{confirmed: true|false}`。`true` 时服务端校验 ready：首帧+尾帧必须有图；写了中间帧提示词的镜还必须有中间帧图；否则 400。**这是视频生成的前置闸门，只能由人授权后调用。**

### POST /storyboards/{id}/transition — AI 转场审核
Body `model?/config_id?`。同步返回 storyboardJson（`transition_review` 更新）。

### POST /storyboards/{id}/narration/write — 单镜旁白写作（同步）
Body `model?/config_id?`。返回 `{narration_text, narration_enabled, duration}`（duration 秒，估算）。

### POST /storyboards/{id}/narration/voice — 单镜配音（同步）
Body：`settings?`。**不传 settings = 用当前生效参数直接合成**；传了则先按 `sanitizeVoiceSettings` 校验（音色必须在服务列表）并**保存为本集默认**（有镜级 normalize 覆盖的镜写镜级），再合成——不是无副作用预览。返回 `{storyboardId, audioUrl, subtitleUrl, durationMs, duration, cues, subtitleSource, jobId}`。

### POST /storyboards/{id}/narration/subtitle — 只重建字幕
不重跑 TTS。返回 `{subtitleUrl, cues, source}`。

### POST /storyboards/{id}/compose — 单镜原生合成 [S]
**无 body、同步返回** `{storyboardId,composedVideoUrl,durationMs,plan,burned}`。本集 `narration_enabled` 必须为 true；服务先实测文件，再要求 raw `video_url`、（非纯画面镜的）非空旁白、与旁白文本 SHA-256 匹配的配音、可读且至少一条 cue 的 SRT、非阻断 fit。成功生成 `static/composed/{uuid}.mp4`，仅写 `composed_video_url` 与 `narration_meta.composed`；输出期间任一输入变化会在下次状态计算为 `changed`，不会冒充最新（2026-11-02 行号：`routes/storyboards.ts:503-524`、`services/shot-compose.ts:85-168`、`services/compose-state.ts:271-358`）。
**签名版本（当前事实，已非 2026-11-02 口径）**：有 `combo` 的纪录片镜写 v4（含 combo、图层段片段键、衔接帧 hash、视频任务 ID），无 combo 的剧情镜仍写 v2 且字节不变（`services/compose-state.ts:70-137`）。本文其余处若写「v2 签名」按此纠正。

字幕按实际 `tempo` 和 `plan.narrationStart` 平移/缩放后烧录。`audio_mix_mode:'replace'` 只保留旁白；`'mix'` 在原片实际有音轨时以底音混入（无原音时降级 replace）。画面不足冻结末帧、超长裁尾；旁白绝不裁断；输出 H.264/AAC 48kHz、faststart（`services/shot-compose.ts:98-274`）。fit 规则阻断时 HTTP 400 为 `{success:false,message,block_reason:'narration_too_long'|'narration_gap_too_large',gap_ratio,current_sec,avail_sec,suggested_chars}`；其它依赖/占用/ffmpeg 错误是普通 `{code:400,message}`。

### GET /storyboards/{id}/narration-fit/preview — 音画匹配预览（纯函数）
返回 `NarrationFitPreview`：
```json
{"storyboard_id":1,"mode":"pad|tempo","pad_ms":800,"pad_position":"head|tail",
 "tempo":1.0,"tempo_override":null,"audio_mix_mode":"replace|mix","bed_gain_db":-18,
 "inherited":false,
 "plan":{"dv":10.2,"da":8.4,"daScaled":8.4,"t":0.5,"d":10.2,"narrationStart":0.5,
         "freezeSeconds":0,"trim":false,"availSeconds":9.7,"gapRatio":-0.13,
         "blocked":false,"blockReason":null},
 "suggested_chars":49,"tempo_available":true,
 "limits":{"min_tempo":0.77,"max_tempo":1.3,"max_pad_seconds":3}}
```
（dv=画面实测秒，da=旁白实测秒，t=转场偏移秒，availSeconds=min(dv,15)−t。）

### PUT /storyboards/{id}/narration-fit — 保存本镜匹配覆盖
Body（全部显式校验，拼错=400，不静默回落）：`mode`* ∈ `pad|tempo`；`pad_ms?`（毫秒，0–3000）；`pad_position?` ∈ `head|tail`；`tempo_override?`（数字，0.77–1.3）；`audio_mix_mode?` ∈ `replace|mix`。**PUT 是完整镜级 record 覆写，不会合并此前镜级 override：**省略/null `pad_ms,pad_position` 回固定默认 800 ms tail；省略/null/空 `tempo_override` 在 tempo 模式下按本次实测时长自动算；省略/null `audio_mix_mode` 继承集级。越界 400 直接拒绝（不钳值）；用当时实测时长预检，阻断时返回与 compose 相同的结构化 400。要完全撤销镜级 record、回继承集级 `narration_fit_default`，只能 DELETE；集级默认可经 PUT `/episodes` 传对象或 JSON 字符串。成功返回新的 preview（`services/narration-fit-service.ts:115-181`）。

### DELETE /storyboards/{id}/narration-fit — 清除镜级覆盖，回继承集级

### POST /storyboards/{id}/generate-video — 单镜视频
Body `model?/config_id?`。要求该镜 keyframesConfirmed（否则 400），在批量视频队列中时 400。201 返回 sys_task。

### DELETE /storyboards/{id} — 硬删分镜
连带删除绑定/目标绑定；继承它首帧的下一承接镜确认作废。

---

## 3. 集级生产（`routes/episodes.ts`）

### PUT /episodes/{id} — 集字段（含旁白字段）
白名单：`content, script_content, title, description, status, resolution('480p|720p|1080p'), narration_enabled(bool), tts_config_id(number|null), subtitle_timing('sentence'|'char'), audio_mix_mode('replace'|'mix'), audio_bed_gain_db(number|null dB), narration_fit_default(对象或JSON串), narration_spine(string,空串存null), narration_normalize(bool)`。
旁白相关默认：`subtitle_timing='sentence'`、`audio_mix_mode='replace'`、`narration_normalize=true`、`narration_fit_default={mode:'pad',pad_ms:800,pad_position:'tail'}`。空 body 400「没有可更新的字段」。成功 `data` 为空（重新 GET /dramas/{d} 核对）。

### 批量提示词（异步文本任务）
- `POST /episodes/{e}/generate-keyframe-prompts` body `{storyboard_ids?:number[], model?, config_id?}` → `{status:'running', total}`；`already_running:true` 表示已有任务在跑；`{status:'idle',total:0}` 表示没有需要处理的镜头（**不传 IDs 只补空缺；显式 IDs 强制重写，即使已有稿**）。轮询 `GET /episodes/{e}/keyframe-prompts-status`。
  **completed 语义陷阱**：进度按「该镜目标提示词（关键帧以 last_frame_prompt、视频以 video_prompt）非空」计数——强制重写失败也会带着**旧稿**计入 completed。必须先快照 `GET /episodes/{e}/storyboards`，跑完比对字段文本与 `field_saved_at`，不能只看 total=completed。
- `POST /episodes/{e}/generate-video-prompts` 同构；轮询 `GET /episodes/{e}/video-prompts-status`。不传 IDs 时只缺转场的承接镜也会被计入并显示 completed，而 video_prompt 本身不变；同样以字段差异为准。**强制顺序：**不得与会回写实际时长的 `narration/voice-batch` 并发；先让配音、字幕和 fit 稳定，再生成／校准 video_prompt，读回核对 `duration`、`mid_frame_time` 与各时间段末端后才可进 video-batch。

### 关键帧批量
- `POST /episodes/{e}/keyframe-batch/preview` body `{storyboard_ids?, model?, config_id?}` → `{items:[{storyboard_id, storyboard_number, slot:'first|mid|last', status:'missing|changed|unchanged|blocked|skipped', checked, matched_version_no?, selected_version_no?, issues?, reason?}]}`。`checked=true` 默认勾选 = missing/changed；blocked（参考图阻断）/skipped（无提示词/承接首帧/生成中）不可投。mid 槽位仅在有 mid 提示词时出现。
- `POST /episodes/{e}/keyframe-batch` body `{items:[{storyboard_id, slot}], model?, config_id?}`（必填非空，否则 400）→ 批次状态 JSON。轮询 `GET /episodes/{e}/keyframe-batch`（最近一次批次进度）。
- `POST /episodes/{e}/keyframe-batch/cancel` 取消所有未结束项；`POST /episodes/{e}/keyframe-batch/retry-failed` 只重提失败/已取消项。
- 批次进行中，同镜单槽 generate 接口会被 400 拒绝。

### 视频批量
- `POST /episodes/{e}/video-batch/preview` body `{storyboard_ids?, model?, config_id?}` → `{items:[{storyboard_id, storyboard_number, status:'missing|changed|unchanged|unknown|blocked|skipped', checked, selectable, matched_version_no?, adopted_version_no?, change_reasons?[], reason?}]}`。blocked=关键帧未确认或提示词与绑定不一致；unknown=历史版本缺字段无法比较。
- `POST /episodes/{e}/video-batch` body `{storyboard_ids: number[](必填非空), model?, config_id?}`；服务端按提交顺序**串行**，不要并发另投单镜。轮询 `GET /episodes/{e}/video-batch`。
- `POST /episodes/{e}/video-batch/cancel`：停止提交后续镜头，在跑的一镜继续完成。

### 旁白写作
- `POST /episodes/{e}/generate-narration` body `{storyboard_ids?, model?, config_id?}`（需先 `PUT /episodes/{e} {narration_enabled:true}`，否则 400）。返回 running/already_running(带进度)/idle。轮询 `GET /episodes/{e}/narration-status`（含 total/completed/failed/phase）。
- `GET /episodes/{e}/narration-markup-catalog` → `{tones:[{tag,label,group}], polyphones, pause:{min,max,presets:[0.3,0.5,1,2]}}`。

### TTS 选项与配音批量
- `GET /episodes/{e}/tts-options?storyboard_id={s}` → `{config_id, config_name, voices[], steps:{min:2,max:30,default:10,presets[]}, cfg:{min:1,max:3,default:2}, chars_per_second:4.5, current:{voice, inference_timesteps, cfg_value, seed, instructions, normalize}}`。
  **默认陷阱**：`settings` 必须以 `current` **完整对象**为基线再改；只传 voice 或省略 `normalize` 会让服务端按缺省处理（normalize 缺省=false），意外改掉规范化。有效参数解析顺序：集级 tts_settings → TTS 配置 → VoxCPM 默认；normalize：镜级覆盖 → 集级。
- `POST /episodes/{e}/narration/voice-batch/preview` body `{settings(必填,完整对象), storyboard_ids?}` → `{items:[{storyboard_id, storyboard_number, status:'missing|changed|unchanged|skipped', audio_seconds}]}`（无 blocked；字数>80 或发音标记写错归 **skipped**）。**预览不落库**（只校验+分类）；保存集级默认只发生在带 `settings` 的批量启动或单镜 `narration/voice`。`settings.voice` 必填（`tts-options.current.voice` 为空串时原样传回 400「请选择音色」）；`inference_timesteps`(2–30)、`cfg_value`(1–3) 越界**静默钳制**（非拒绝），`seed` 非法才 400。
- `POST /episodes/{e}/narration/voice-batch` 同 body（settings 可省=用当前生效参数；需 `narration_enabled=true`）；返回 `{status:'running',total}` / `{status:'running',already_running:true,total,completed}` / `{status:'idle',total:0}`；串行执行，只配 missing+changed，带 settings 先保存为集级默认。轮询 `GET /episodes/{e}/narration/voice-batch-status`。

### 合成批量（源码 [S]；d5/e6 成功路径 [R]）
- **先预览：**`POST /episodes/{e}/compose-batch/preview` body 省略或 `{}` = 全部 live 分镜；`{"storyboard_ids":[正整数...]}` = 只看这组；**显式 `[]` = 空范围，不扩大**。非整数/非正值在路由层过滤。返回 `{items:ComposeState[]}`，每项为 `{storyboard_id,storyboard_number,title,status:'disabled'|'missing'|'changed'|'unchanged'|'unknown'|'blocked'|'skipped',selectable,checked,exportable,reason,change_reasons,signature,plan,inputs:{video,audio,subtitle,pure_visual},composed_video_url}`。`checked:true` 仅默认给 missing/changed；unknown 可手选重做；unchanged 必须人显式强制重做；blocked/skipped/disabled 不可选（`routes/episodes.ts:451-464`、`services/compose-state.ts:404-529`）。
- **再启动：**`POST /episodes/{e}/compose-batch {"storyboard_ids":[...]}`；唯一参数是必填、非空的正整数数组，**没有** model/config 参数。缺失/空值、非本集/已删 ID、旁白关闭均为 400。即时返回 `{status:'running',total}`；已有 active `shot_compose` 则 `{status:'running',already_running:true,total:0}`，不可重复投单。服务按选中镜头的 storyboard number 串行，在每镜执行前重新验当前输入；竞态依赖失败记为逐项 `skipped,reason`，执行失败记为 `failed,reason`，不悄悄纳入成功（`routes/episodes.ts:466-489`、`services/shot-compose.ts:320-440`）。
- **轮询：**`GET /episodes/{e}/compose-batch-status`，从未启动返回 `data:null`；否则 `{status:'running'|'done'|'error',total,completed,failed,skipped,current_storyboard_id?,started_at,finished_at?,error?,items:[{storyboard_id,storyboard_number,state:'pending'|'processing'|'completed'|'failed'|'skipped',reason}]}`。只在 running 轮询；done 仍须检查 `failed`、`skipped` 和每镜重新 GET 后的 `compose_state.exportable`。UI 是 2.5 秒轮询并在数量变化/终态重读分镜（`services/shot-compose.ts:287-315`、`frontend/app/views/drama/episode.vue:4657-4691`）。
- **2026-11-02 成功实例 [R，d5/e6 的 119/120/121，不是默认规模或人工批准]：**实际 raw 时长 `10.125/9.417/10.125 s` 下，GET fit preview 保持完整覆盖 `pad tail 1520/1320/1680 ms`、`audio_mix_mode:"replace"`、`d:10/9/10`、`trim:true`（只裁原始视觉尾部）和 `blocked:false`，没有重新配音或修改 fit。显式 preview 是三项 `missing/selectable:true`；同一 `[119,120,121]` body 启动后终态 `done,total:3,completed:3,failed:0,skipped:0`。重新 GET 后三项均 `status:"unchanged",exportable:true`；各 native composition 均含 48 kHz AAC、可见烧录中文 SRT，且与其 TTS WAV 的波形相关为 `0.99888/0.99942/0.99923`。FinalVisualReview 实测六条烧录 cue 的显示边界都在各 SRT cue 的一帧内；这只验证该 `replace/pad-tail/narrationStart:0` 实例，其他 fit/tempo 仍须单独测量。请求、响应、下载和 full-decode/frame 证据在 `work/huobao-director-charcoal-20261102/compose-final/`。


### 批量状态响应形状（轮询判读）
- `GET /episodes/{e}/keyframe-batch` → `KeyframeBatchStatusJson`：`{id, episode_id, status:'running|done|cancelled', current_storyboard_id, current_slot:'first|mid|last'|null, cancel_requested, created_at, updated_at, eta_seconds:number|null, progress:0..1(按各项估计时长加权), counts, items[]}`。
- `GET /episodes/{e}/video-batch` → `VideoBatchStatus`：`{id, episode_id, status:'running|done|cancelled', current_storyboard_id, created_at, updated_at, cancel_requested, items:[{storyboard_id, storyboard_number, state:'pending|running|completed|failed|skipped', task_id:number|null, error:string|null}]}`。
- 文本类状态 `GET /episodes/{e}/keyframe-prompts-status | video-prompts-status | narration-status | narration/voice-batch-status` 共用 `PromptBatchStatus`（从未运行过返回 `data:null`）：`{status:'running|done|error', total, completed, failed, current_storyboard_id?, phase?:'spine'|'shots', started_at, finished_at?, error?}`。**compose-batch-status 不是泛化猜测的 PromptBatchStatus：**它还包含 `skipped` 与逐镜 `items`，形状以上节为准。
- **判读陷阱：`done` ≠ 成功。** 必须检查 `failed>0` 与逐项 `state==='failed'`；video/keyframe 批次 `status:'done'` 可含 failed 项，文本批次 `status:'done'` 只表示任务结束。失败项用 `keyframe-batch/retry-failed`（关键帧）或对应单镜接口重投。
### 2026-11-02 三镜运行配方 [R]（实例，不是项目默认）

证据根：`work/huobao-director-charcoal-20261102/timeline-resume/`。下列 ID、配置和音色只记录实际运行，不是后来任务可以照抄的默认值。

1. **文本 Prompt：** 对 IDs `[119,120,121]` 分别 POST `/episodes/6/generate-keyframe-prompts` 与 `/episodes/6/generate-video-prompts`，正文均为 `{"storyboard_ids":[119,120,121],"config_id":1,"model":"glm-5.3"}`（`calls/047-generate-keyframe-prompts-explicit-request.json`、`calls/081-generate-video-prompts-explicit-request.json`）。各自轮询 `*-prompts-status` 到 `done,total:3,completed:3,failed:0`；随后 GET storyboards 并比较 Prompt 与 `field_saved_at`。**不可只按 done 判断：**显式 IDs 是强制重写，状态仍按非空字段计数；121 的 first Prompt 按承接设计为空／继承，却被计入 batch 完成。视频 Prompt [R] 不等于 video-batch 已运行。
2. **关键帧：** POST `/episodes/6/keyframe-batch/preview {"storyboard_ids":[119,120,121],"config_id":9,"model":"qwen-image-2.1"}`；预览为 119/120 各 first/mid/last 加 121 mid/last 的八项 `missing,checked:true`，121 first 是 `skipped`，原因「承接上一镜尾帧，没有自有首帧提示词」。以同一 config/model POST `/episodes/6/keyframe-batch`，正文 `items` 为这八个 `{storyboard_id,slot}`；批次 14 终态 `done`，counts `completed:8,failed:0`（`calls/158-preview-explicit-keyframe-batch-request.json`、`calls/159-submit-explicit-keyframe-batch-request.json`、`calls/224-poll-keyframe-batch-065-response.json`）。下载并实际查看八张图；121 mid/last 首版只是质量返工，经过单槽再生后选中 version 2。最后重复 preview，八项 `unchanged`、继承 first 仍 `skipped`（`keyframe-batch-final-preview.json`）。未调用 confirm-keyframes，故不能推定可发视频。
3. **旁白、声音、字幕：** `POST /episodes/6/generate-narration` 使用显式 IDs、`config_id:1,model:"glm-5.3"`。从 `tts-options.current` 完整复制后，实际 settings 是 `{"voice":"纪录片·沉稳男声","inference_timesteps":10,"cfg_value":2,"seed":1720,"instructions":"中年男声，低沉克制，纪录片旁白，语速平缓，句间停顿清晰，不带情绪起伏","normalize":true}`；以此先 POST `/episodes/6/narration/voice-batch/preview`，再原样 POST `/episodes/6/narration/voice-batch`，都带 IDs `[119,120,121]`。预览三个 `missing`，终态 `done,total:3,completed:3,failed:0`（`voice-preview.json`、`calls/123-preview-explicit-voice-batch-request.json`、`calls/124-submit-explicit-voice-batch-request.json`、`calls/128-poll-voice-batch-status-02-response.json`）。逐镜 POST `/storyboards/{119|120|121}/narration/subtitle`，请求体为无 body。实际下载 WAV/SRT：48 kHz 单声道、非零 RMS、每镜两条不重叠 cue，文字等于最终旁白（`audio-srt-inspection.json`）。**不要省略 `normalize` 或只传 voice**；这是改变集级生效设置的生产写，不是预览。
4. **narration fit：** 每镜先 GET `/storyboards/{s}/narration-fit/preview`。默认继承 `pad_ms:800`（毫秒）、tail 时出现 `trim:true`；实际 PUT `/storyboards/119|120|121/narration-fit` 的 body 分别为 `{mode:"pad",pad_ms:1520,pad_position:"tail",audio_mix_mode:"replace"}`、1320、1680。读回均为 `d == dv`、`trim:false`、`blocked:false`（`narration-fit-before-after.json`，精确 request 是 `calls/145-save-full-duration-narration-fit-shot-119-request.json`、`calls/146-save-full-duration-narration-fit-shot-120-request.json`、`calls/147-save-full-duration-narration-fit-shot-121-request.json`）。这些毫秒数由本次实测音／画时长决定；下一集必须先读自己的 preview 及 limits，不能复用。
### 时序与画面复核缺口（运行发现，待修复后再作 [R] 验证）

后续独立复核发现，此三镜运行的 voice-batch 与 video-prompt batch 曾并发：配音回写的 duration 分别为 10、9、10 秒，而已保存 video_prompt 的末段仍为旧 11、11、12 秒。因此 `done,completed:3` 不构成视频就绪，旧 Prompt 不得作为 video-batch 输入；必须在时长稳定后重新生成／校准并逐镜读回。复核还发现 119 mid 的 Prompt 虽含陶瓷垫板，实际图像未见该物件；Prompt/@ 绑定和批次状态均不能替代打开图像检查。两项在 production owner 修复、重新下载／查看并留下新证据前，均不标作通过。



### 其它（同文件，简要）
- `GET /episodes/{e}/pipeline-status`：步骤聚合 `script_rewrite/extract_characters/extract_scenes/extract_storyboards/generate_images/generate_videos/merge_episode`，各 `{status:'pending|ready|partial|done', count?, completed?, total?, merged_url?}`。
- `POST /episodes/{e}/extract {target:'characters|scenes|props', model?, config_id?}` + `GET /episodes/{e}/extract-status`；资产关联 `POST /episodes/{e}/assets/link {kind, asset_id}` / `DELETE .../assets/link?kind=&asset_id=`。
- 选角名册 `GET/PUT /episodes/{e}/character-roster`（PUT：`cast[]` 必填逐条校验 name；`status` 缺省按 approved 保存——**不能当草稿随意存**；`expected_hash` 回传 GET 的 `current_hash`）。
- `GET /episodes/{e}/characters|scenes|props`：本集资产+图片版本（characters 另含 `styling_version`）。

---

## 4. Poster（`routes/posters.ts`，挂 /api/v1/episodes 下）—— **2026-11-02 历史契约，已不可执行**

> **不要按本节操作。** Poster 工程自 Issue #39/#72 起改为 `layer_doc`：旧 `layout:{texts:[...]}` 既不写也不读，`POST /episodes/{e}/poster/versions` 改为 `{layer_doc?, prompt?, text_prompt?}` 并由**服务端**渲染合成图、登记 `composite` 版本、自动设为最终版并同步缩略图，不再需要本地渲染 PNG + `POST /upload/image` + 传 `image`。另有 `/poster/concept`、`/poster/concept/generate`、`/poster/concept/apply`、`/poster/concept/apply-layer-plan`、`/poster/load-version` 与 `provenance` 冲突 409（`manual_edit_conflict`）等当时不存在的环节。当前契约见 `references/api-catalog.md` §4。
> 以下内容仅作历史记录：说明 2026-11-02 那一轮**实际发生过什么**（`poster-resume/` 证据），不构成今天的可执行步骤，其中的 `[R]` 只属于当时的 `layout` 契约。

每集一份编辑工程。**[R，历史]** `GET /episodes/{e}/poster` 返回 bundle；`PUT /episodes/{e}/poster` 的 prompt、text_prompt、base_image、reference_images 和 layout 当时被实际接受；`POST /episodes/{e}/poster/generate {"mode":"initial"}` 已轮询至 completed 并下载实际 PNG；脚本渲染的文字画布也已实际上传、登记和选版。以下未另标者仍为 [S]；这些实测不代表人类艺术批准、独立审核通过或最终拼接通过。
```json
{"id":1,"prompt":"...","text_prompt":"...","reference_images":["static/..."],
 "base_image":"static/...|null","layout":{"texts":[...]},"size":"...",
 "variables":{"project_title":"...","episode_title":"...","episode_no":"..."},
 "aspect_ratio":"16:9","versions":[{...新→旧}],"selected_version_id":...,"final_image":"..."}
```
校验失败一律 400+中文原因。

### 文字图层 schema（`poster-layout.ts`，归一化后存储）
`layout = {texts: PosterTextBox[]}`，每框：
| 字段 | 类型/范围 | 默认 | 说明 |
|---|---|---|---|
| `id` | str ≤64 | `box-N` | 唯一标识 |
| `kind` | `text\|project_title\|episode_title\|episode_no` | `text` | 变量框内容强制清空，渲染时取剧集数据 |
| `text` | str ≤300 | `''` | 仅 kind=text 生效 |
| `x`,`y` | 0..1 | 0.1 | 左/上边界（比例坐标） |
| `width` | 0.05..1 | 0.8 | 文本框宽度 |
| `fontSize` | 0.02..0.4 | 0.08 | 字号=图高比例 |
| `fontFamily` | `sans\|serif\|kai\|hand` | `sans` | |
| `color` | str ≤32 | `#ffffff` | |
| `bold` | bool | true | |
| `italic` | bool | false | |
| `strokeColor` | str ≤32 | `#000000` | |
| `strokeWidth` | 0..0.12 | 0.03 | 描边宽=字号比例 |
| `shadow` | bool | true | |
| `align` | `left\|center\|right` | `center` | |
最多 40 框；非法条目单独跳过，整体非法退化为空布局。**API 与 UI 同一 schema，纯 API 即可完成文字定义。** 一个含两个 `kind:"text"` 文本框的 layout 已随上述 [R] PUT 成功，且按保存 layout／variables 渲染的画布已上传、登记、选版；变量框边界值与其它视觉组合仍是 [S]。

### PUT /episodes/{e}/poster — 保存工程 [R]
Body（只传要改的）：`prompt`（≤4000）、`text_prompt`（≤2000）、`reference_images: string[]`（必须已是 static/ 下路径）、`base_image`（static/ 路径或 null）、`layout`（对象或 JSON 串，按上表归一化）。返回完整 bundle。实测接受上述所有字段组合；未覆盖的边界值仍按 [S] 处理。

### POST /episodes/{e}/poster/generate — 生图 [R] initial；其余 [S]
Body：`mode` ∈ `initial|composite|layers`（默认 initial）+ 可选 `prompt/text_prompt/reference_images/layout`（先存草稿再生成）、`version_id?`（composite 用）、`base_image?`+`text_layer?`（layers 用，两者都必须是 static/ 路径）、`config_id?`、`model?`。
- `initial`：资产参考图（已存 reference_images），按剧集画幅；prompt=仅画面 prompt。**[R]** 空 body 以已保存草稿启动，返回 JSON 200/task_id；轮询得到 completed 后，生成 PNG 可经火宝部署前缀下载查看。
- `composite`：以指定/当前合成版本图为唯一参考；prompt=画面+text_prompt+由布局变量现场渲染的文字指令（"render exactly as written…"）。[S]
- `layers`：底图+透明文字图层两张参考；FLUX 配置下 400 拒绝。[S]
- 无任何文字时 prompt 为空则 400。返回 `{task_id, mode, prompt, references[]}`，轮询 `GET /tasks/{task_id}`；完成图自动登记为 generated 版本。[S，除 initial 的受理、完成和下载]

### POST /episodes/{e}/poster/versions — 登记合成版本 [R]（**API 路径，不需要 UI canvas**）
Body：`image`*（static/ 下合成图路径）、`base_image?`、`layout?`。登记为 `kind:'composite'` 版本并**自动设为最终版本 + 更新 episodes.thumbnail**。实际脚本画布上传后，该调用返回 bundle，含 composite version、`selected_version_id` 和 `final_image`；仍须重新 GET／下载核对。
图片获取路径：没有浏览器 canvas 时，用「initial/composite 生成图（任务完成的 generated 版本）」直接 `PUT /poster/select` 即可；若用户已授权精确文字排版，可让脚本严格按保存的 bundle `layout` 与 `variables` 渲染 UI 等价 PNG，再经 `POST /upload/image`（multipart 字段 `file`；返回 `{url:"/static/uploads/...","path":"static/uploads/..."}`，后续使用 `path`）上传，并用 `POST /episodes/{e}/poster/versions {"image":path,"base_image":...,"layout":...}` 登记。**脚本只产出待上传画布，上传／登记才是业务写入；未提供免脚本的纯 API 文字排版渲染端点。**

### PUT /episodes/{e}/poster/select — 选最终版本 [R]
Body `{version_id:number}`。同步 episodes.thumbnail。返回 bundle；实测后应 GET bundle 并下载 `final_image`，不以 200 代替视觉检查。



---

## 5. 拼接导出（`routes/merge.ts`）

### POST /merge/episodes/{id}/merge — 当前导出 [S]；d5/e6 拒绝及成功路径 [R]
该路由实际挂在 `/api/v1/merge`，故完整相对 API 路径就是本标题（`backend/src/index.ts:83,93`）。Body：

- `storyboard_ids?: number[]`：省略才是整集 live 分镜（按 storyboard number）；显式数组是严格所选范围。显式空数组、过滤后没有正整数、非本集或已删 ID 都 400，绝不扩大/缩小选择。
- `poster_version_id?: number`：只有 truthy 时启用，必须属于本集且有存在的图片文件；否则 400。
- `poster_duration?: number`：仅随 Poster 使用，默认 3 **秒**，必须有限；服务钳为 0.5–10 秒。Poster 等比缩放并居中留边到第一段视频尺寸，创建静音 H.264/AAC 片头并置于所选镜头之前（`routes/merge.ts:15-58`、`services/ffmpeg-merge.ts:195-255`）。

受理立即返回 `{merge_id,status:'processing',skipped:[]}` 并异步执行。旁白开启时，仅每镜 current `compose_state.exportable:true` 加有效 `composed_video_url` 可入片；任意 selected 镜缺失/changed/unknown/blocked/skipped/文件丢失都会整体 HTTP 400 `{success:false,message,blocked:[{storyboard_id,storyboard_number,status,reason}]}`，**不**回退 raw、也不静默少镜。旁白关闭时选 `video_url`，仅为历史兼容才回落 `composed_video_url`；缺片同样 block（`services/ffmpeg-merge.ts:43-184`）。
- **2026-11-02 实例 [R，d5/e6]：**未就绪时，同一明确 body `{"storyboard_ids":[119,120,121],"poster_version_id":9,"poster_duration":2}` 得 JSON 400，三项都在 `blocked[]`，且 current/history 仍 `null`/`[]`。完成 native compose 后，以该不变的明确 body 得 `{merge_id:21,status:"processing",skipped:[]}`；轮询 current 至 `completed`，history 含同一 ID、三个 `static/composed/...` scenes、Poster 9 的 image、`intro_duration:2` 和 `merged_url:"static/merged/e795e46d-73fe-4601-90c2-c9ab219b291b.mp4"`。真实文件是 H.264/AAC 48 kHz、960×544、30.92 s、full decode 退出 0。帧账为 Poster 51 帧（2.04 s）+ composed `249/224/249` 帧（各比计划 `d=10/9/10` 少一帧）= 773 帧/30.92 s；故不是笼统的“packaging rounding”。Poster 及中文烧录字幕样帧实际打开；这不是人工艺术批准，也不替代逐段音频完整性核验。


### GET /merge/episodes/{id}/merge — 当前最新状态 [S]；null 与 completed 行 [R]
返回最近一条未软删 merge 的 snake_case 行，按创建时间倒序；从未导出返回 `data:null`。轮询至 `status:'completed'|'failed'`，失败看 `error_msg`。完成行含 `merged_url`、整数 `duration`、`generated_at`、`created_at_unix`；`duration` 只适合作展示/近似，精确秒数、帧数、轨道必须下载 `merged_url` 后用 ffprobe 测量。下载时将 `static/merged/...` 接批准的 `/huobao/` 部署前缀。成功时服务写 `episodes.video_url`；失败保留 failed 记录（`routes/merge.ts:61-90`、`services/ffmpeg-merge.ts:257-327`）。

### GET /merge/episodes/{id}/merges — 当前成片历史 [S]；空与 completed history [R]
最多 30 条、新→旧、排除软删。`DELETE /merge/episodes/{id}/merges/{mergeId}` 不能删 `pending|processing|queued|running`；已删当前成片时，`episodes.video_url` 回退到剩余最新 completed，或置空（`routes/merge.ts:75-152`）。

---

## 6. 配方

本节分两部分：**6.0 当前顺序**（可执行）与 **6.A/6.B 历史证据（不可执行）**。历史小节保留 2026-11-02 那一轮真实跑过的 ID、参数与结果，供追溯；不要照着它的步骤顺序操作。

### 6.0 当前顺序（以 `references/api-catalog.md` 为准）

**纪录片（`project_type=documentary`）**：
1. **剧本**：`PUT /episodes/{e} {"content":...}` 导入原始内容 →（人明确授权改写后）`POST /episodes/{e}/script-rewrite` 轮询 `GET /episodes/{e}/script-rewrite`。**纪录片不能用 `POST /agent/script_rewriter/chat`（直接 400）**，也不能由助手本地代写再 PUT `script_content`。人工保存旁白稿前先 `POST /episodes/{e}/script-rewrite/inspect-narration` 查非旁白杂质，删留由人决定。人确认：`POST /episodes/{e}/script/confirm`。
2. **资产**：`POST /episodes/{e}/extract` ×3 → `POST /episodes/{e}/asset-review/run` 对清单补缺 → 需要精确/美化时走 `POST /asset-pipeline/runs` + `approve`（每次 `revise` 再花一轮预算）。每进下一阶段前读 `GET /episodes/{e}/gates`。
3. **旁白骨架**：`POST /episodes/{e}/narration-skeleton/generate`（返回整份骨架 + `task_id`）→ 用 `PUT /episodes/{e}/narration-skeleton {validate_only:true}` dry-run 调边界 → 人工 `POST .../narration-skeleton/confirm`。
4. **配音先行**：先确保本集 `narration_enabled=true`（`PUT /episodes/{e} {"narration_enabled":true}`，否则 voice-batch 抛「本集未开启旁白，无法生成配音」）→ `GET /episodes/{e}/tts-options` 取 `current` 全量作基线 → `POST /episodes/{e}/narration/voice-batch/preview` → `POST /episodes/{e}/narration/voice-batch`（真入批时返回 `task_id`）→ `GET .../voice-batch-status`。**实测时长在这里产生**，后面的设计卡门禁、video_prompt 时间段、合成时长都依赖它。
5. **设计卡**：可选先 `POST /episodes/{e}/work-estimate {"stage":"design_card"}` 看计划字数/ETA/`blocked_units` → `POST /episodes/{e}/design-cards/fill` → `GET .../design-cards/status` → `GET .../design-cards/audit` 逐镜读 issue/`unresolved_layers` → 人工逐镜 `POST /storyboards/{s}/design-card/confirm`。**没有当前有效配音的镜一个都不会进批次**（`services/design-card-batch.ts:83-99`），所以第 4 步不能后置。
6. **图层段**：`POST /layer-segments/storyboards/{s}/draft` → `PUT /layer-segments/storyboards/{s}`（`layer_doc`/`duration`/`base_ref`；`timeline.fps` 是派生值，传了不生效）→ `POST .../render` → 打开 `thumbnail/{which}` 与 `junction` 实际查看。
7. **关键帧**：`POST /episodes/{e}/generate-keyframe-prompts` → `POST /episodes/{e}/keyframe-batch/preview` → `POST /episodes/{e}/keyframe-batch` → 逐张打开检查 → 人工逐镜 `POST /storyboards/{s}/confirm-keyframes {"confirmed":true}`（确认会快照 junction hash，图层重渲后自动作废）。
8. **视频 Prompt → 视频**：时长稳定后才 `POST /episodes/{e}/generate-video-prompts`（与 voice-batch **不得并发**），读回核对 `duration`/`mid_frame_time`/末段终点；再 `POST /episodes/{e}/video-batch/preview` → `POST /episodes/{e}/video-batch`（preview 与启动用完全相同的 ids/config/model）。
9. **合成 → 导出**：`POST /episodes/{e}/compose-batch/preview` → `POST /episodes/{e}/compose-batch {"storyboard_ids":[...]}` → 轮询 `compose-batch-status` → 逐镜 `exportable:true` 后 `POST /merge/episodes/{e}/merge`（显式 ids；Poster 片头可选）。下载真实字节做解码/字幕/音频检查，不以状态代替媒体验收。
10. **贯穿**：要看某阶段真的调了什么模型、发了什么 prompt，拿该阶段的任务 ID 去 `GET /tasks/{id}/observations`（#86/#87，代码已上线，生产验收前按 `[S]` 对待）。骨架 `generate`、配音 `voice-batch` 的发起响应**直接带 `task_id`**；**设计卡 `fill` 与 `design-cards/status` 都没有 `task_id`**，要用投单前后两次 `GET /tasks/center?episode_id={e}&type=text&page_size=200` 的差集按 `kind="design_card"` 认领本次任务——取不到 ID 不等于任务失败，不要据此中止（会白费一次已授权生成）。

**剧情片（`project_type=drama`）** 走另一条链，不要套纪录片的骨架/设计卡/图层段端点：`PUT /episodes/{e} {"content":...}` → `POST /agent/script_rewriter/chat` → `POST /episodes/{e}/extract` ×3 + `POST /episodes/{e}/assets/link` → **Poster 决定（#97：资产完成后即可与后续步骤并行；做则选版审核并在 merge 传 `poster_version_id`，不做须显式 `poster_waiver`）** → `POST /agent/storyboard_breaker/chat`（覆盖式，先快照分镜）→ 之后与上面共用：旁白写作/配音实测（第 4 步）→ 关键帧提示词与批次 → 人工 `confirm-keyframes` → video_prompt 校准 → video-batch → compose-batch → merge。**配音/实测时长仍必须在视频 Prompt 与关键帧确认之前**；`narration-skeleton*`、`design-cards*`、`layer-segments*` 是纪录片专有，剧情片不适用。现行执行一律经 `hbwf`（`references/workflow.md`）。

### 6.A 历史证据（不可执行）：2026-11-02 d5/e6 的实际执行顺序

> 下面是当时真实跑过的步骤与结果，**不是今天的操作指引**。已知两处与当前要求冲突：(a) 它把关键帧批次放在旁白/配音之前，导致 video_prompt 末段仍是旧秒数（复核结论见 §3「时序与画面复核缺口」）；(b) 它用 `POST /agent/script_rewriter/chat` 改写，这对纪录片现在直接 400。当前顺序见 §6.0。

1. 〔历史〕`PUT /episodes/{e} {"content":...}` →（人审）→ `POST /agent/script_rewriter/chat`。
2. 〔历史〕`POST /episodes/{e}/extract {"target":"characters"|"scenes"|"props"}` ×3，轮询 `extract-status`；补关联 `POST /episodes/{e}/assets/link`。
3. 〔历史〕`POST /agent/storyboard_breaker/chat`（覆盖式，先快照 `GET /episodes/{e}/storyboards`）。
4. 〔历史〕`POST /episodes/{e}/generate-keyframe-prompts {}` → 轮询。
5. 〔历史〕`POST /episodes/{e}/keyframe-batch/preview {}` → 取 checked 项组 items → `POST /episodes/{e}/keyframe-batch` → 轮询 `GET /episodes/{e}/keyframe-batch`，逐槽打开检查。
6. 〔历史〕`PUT /episodes/{e} {"narration_enabled":true}` → `POST /episodes/{e}/generate-narration` → 轮询；单镜重写 `POST /storyboards/{s}/narration/write`；人工修订用 `PUT /storyboards/{s} {"narration_text":...}`。
7. 〔历史〕`GET /episodes/{e}/tts-options` → 以 `current` 全量 + 人的改动组 settings → `POST /episodes/{e}/narration/voice-batch/preview`（只校验+分类，不落库）→ `POST /episodes/{e}/narration/voice-batch` → 轮询；逐镜重建字幕，必要时保存 narration-fit，并读回实际 duration。
8. 〔历史〕**时长稳定后才写视频 Prompt。** 从当时文本配置取得 `T`／`TM`，`POST /episodes/{e}/generate-video-prompts {"storyboard_ids":[...],"config_id":T,"model":TM}` → 轮询；重新 GET 分镜，逐镜核对实际 `duration`、`mid_frame_time` 和 video_prompt 最末时间段终点。voice-batch 与该步不得并发（这一轮实际并发了，见复核缺口）。
9. 〔历史〕**[S] 人工帧闸门。** 对每个已审的当前镜头单独 `POST /storyboards/{s}/confirm-keyframes {"confirmed":true}`；先 GET 分镜核对首／中／尾的当前有效版本和承接关系，绝不以 batch ready 代替确认。
10. 〔历史〕**[S] 视频批次。** 从当集实际锁定的 video config／model 取得 `C`／`M`（不要沿用文字或图像配置），先 `POST /episodes/{e}/video-batch/preview {"storyboard_ids":[...],"config_id":C,"model":M}`，只选择 `selectable:true` 且在授权范围的 IDs；以**完全相同**的 `storyboard_ids,config_id,model` POST `/episodes/{e}/video-batch`，轮询 GET `/episodes/{e}/video-batch`；它串行执行。下载每个完成片段并实际检查媒体。
11. 〔历史，结果 [R]〕原视频、旁白、字幕与 fit 稳定后，逐镜读 `compose_state.inputs/status/reason/plan`；`POST /episodes/{e}/compose-batch/preview {"storyboard_ids":[...]}` 只取 `selectable:true`；再 `POST /episodes/{e}/compose-batch {"storyboard_ids":[...]}`，轮询 status，重新 GET 分镜确认每个已选镜 `unchanged,exportable:true`。d5/e6 实测 batch 只接受 `storyboard_ids`、串行完成且无 skipped；单镜返工 `POST /storyboards/{s}/compose {}` 当时未跑（[S]）。下载检查真实轨道、full decode、烧录字幕样帧，并与当前 TTS source 作可复现比对。
12. 〔历史，结果 [R]〕仅在所有**显式所选**镜头 `exportable:true` 后 POST `/merge/episodes/{e}/merge {"storyboard_ids":[...],"poster_version_id":V,"poster_duration":D}`。检查 400 `blocked[]`、轮询至 terminal、下载 `merged_url` 与 history。d5/e6 得到 `poster_duration:2`、3 个 composed sources、`skipped:[]` 的 merge 21；实际 Poster 是 51 帧/2.04 s，说明参数值不是帧精确时长承诺。不要把接受响应、空 `skipped` 或整数 `duration` 当作媒体验收。

### 6.B 历史证据（不可执行）：2026-11-02 的带文字 Poster 做法

> **当前不要照做**：Poster 已改 `layer_doc` + 服务端渲染（api-catalog §4）。下列第 2、4 步依赖的 `layout` 字段与「本地渲染 PNG → `/upload/image` → `POST /poster/versions {image}`」路径都已不存在。

1. 〔历史〕`GET /episodes/{e}/poster` 取 variables/aspect_ratio/size。
2. 〔历史，字段已废〕`PUT /episodes/{e}/poster {"prompt":"...","reference_images":["static/assets/..."],"layout":{"texts":[{"id":"t1","kind":"project_title",...},{"id":"t2","kind":"text","text":"为什么木炭燃烧需要氧气",...}]}}`（当时接受 `layout`；此示例不代表文字内容已获人审）。
3. 〔历史〕`POST /episodes/{e}/poster/generate {"mode":"initial"}` → 轮询任务；完成后 `GET /episodes/{e}/poster` 看 generated 版本并下载／查看图像（不等于人审通过）。
4. 〔历史，路径已废〕选生成版用 `PUT /episodes/{e}/poster/select {"version_id":V}`（这一步今天仍有效）；当时若要精确文字排版，是本地按 `layout`／`variables` 渲染 PNG → `POST /upload/image` → `POST /episodes/{e}/poster/versions {"image":...,"layout":{...}}`。**现在改为 `POST /episodes/{e}/poster/versions {"layer_doc":{...}}`，由服务端渲染并登记。**
5. 〔历史，结果 [R]〕拼接带片头：`POST /merge/episodes/{id}/merge {"storyboard_ids":[...],"poster_version_id":V,"poster_duration":2}`；V 必须属于该集且图片存在，时长单位是秒并钳 0.5–10。d5/e6 的 Poster 9 (1344×768) 以 2 秒片头写入该集 960×544 成片，样帧中文字未被裁切；这只验证该实例，仍须每次打开所生成片头。

### 安全吞吐
- 视频服务端按镜串行；批次内镜头不要再单投 `generate-video`。TTS 批量也串行。
- 同类批次 already_running 时只轮询，不重发。HTTP 超时先 GET 状态再决定。
- 预览与启动保持相同 model/config_id/storyboard_ids 口径。

## 7. 已知 UI/API 差距（未虚构补齐）
- ~~Poster 排版化合成图无纯 API 渲染端点~~ **该差距已消除**：`POST /episodes/{e}/poster/versions {"layer_doc":{...}}`（省略则用工程里已存的 `layer_doc`）由服务端渲染合成图、登记 `composite` 版本、自动设为最终版并同步 `episodes.thumbnail`（`services/posters.ts:655-697`）。不再需要浏览器 canvas，也不再需要脚本产图 + `/upload/image` + 传 `image`。文字层经 `PUT /episodes/{e}/poster {"layer_doc":...}` 或 `POST /poster/concept/apply-layer-plan` 写入，均为纯 API。完整当前契约见 `references/api-catalog.md` §4；本文件 §4/§6.B 的 `layout` + 上传做法只是历史记录。
- `/tasks/{id}/cancel` 仅支持 qwen-jobs 图片任务；文本/视频任务不可取消。
- compose 批量没有取消端点；merge 也没有取消端点。merge 进行中只能等完，之后才可删除记录。
- 当前 API/status 没有返回“烧录字幕可读、音频可听清、视频内容正确”的自动判定；必须下载真实 composed/merged bytes 做解码、画面/字幕和音频检查，不能把 `exportable` 当内容 QA。含 Poster 的 merge 应逐段比较最终 AAC 与每个 composed AAC，并以 AAC packet/priming 允许的**子样本**延迟寻优，不能使用粗粒度 1 ms 网格误判缺音：d5/e6 merge 21 的 119 实际起播 `2.0266667 s`（95 AAC frames），native→final `0.99952`、TTS→final `0.99855`、100 ms speech windows ≥`0.993`、envelope `0.99975`、尾部 −132 dBFS，raw-H3 `0.019`；120/121 分别为 `0.99948/0.99933`。独立复核据此确认三个 replace narration 段保留完整、无 H3 泄漏；仍不等同人类听感或艺术批准。
- `GET /tasks/center?episode_id=&page_size=` 为任务历史统一入口（旧 /generation-tasks 已删除）。
