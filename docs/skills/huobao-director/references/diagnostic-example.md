# 诊断片实测案例（2026-11-05 殷墟五镜，历史记录）

> 本文件从 `SKILL.md` §3 原样移出（移出方式沿用 Issue #84 分支 `1eb48cb` 的做法，仅为满足 managed skill 单文件 64,000 bytes 上限），内容不删减。
> 这是**历史案例**，不是现行配方：Poster 本地画布、「镜数=段落数」、固定 25fps、以及「设计卡在配音之前」的次序都已被 #72 / #57+#70 / #69 取代，执行一律按 `SKILL.md` §2。
## 3. 以诊断片为例：目标 → 步骤 → API（2026-11-05 历史案例，不是现行配方）

**授权前提（重要）**：本案例是“用户已明确授权五镜技术测试、逐镜确认 C/B/A/A/A 与预算、允许保留失败证据”的前提下，由协调者执行的记录。因此下文出现的 `script/confirm`、`design-card/confirm`、`confirm-keyframes`、`approve{override_gate:true}` 都是**人在此前已给出决定、协调者代按**的事实；通用 Agent 不得据此把这些端点当成可自主调用——必须逐项停下请人做决定，再做技术执行与记录。

**时效前提（同样重要）**：本节是 2026-11-05 那一轮的事实记录。其中的 Poster 本地画布登记（现为 #72 服务端 LayerDoc 渲染，见 S3）、「镜数=段落数」（现按 80 字上限与 `storyboardCountCap`，见 S4）、`timeline.fps:25` 与「25fps CFR」（现按 #69 派生目标帧率，见 S6）、以及「设计卡在配音之前」的步骤次序（纪录片现为 #70 的骨架→配音→设计卡→制作，见铁律 17）都已被后续 Issue 取代。**执行时一律按 §2，不照抄本节的旧配方。**
**工作目标**：在一个纪录片项目里，用 5 个镜头、约 55 秒，验证“剧本→资产→Poster→设计卡→图层段→关键帧→旁白→视频→合成→导出”全链路；预算 12 张 AI 图、2 条生产视频；不追求艺术验收，允许保留失败证据。

实际成片：`54.76s / 960×544 / 25fps / 1369 帧`，5 个合成片全部最新可导出；C186 衔接视觉 FAIL，B187 细节形变，均原样保留。下面每一步都给出**为什么这样做**与**实际参数**。

### 步骤 0：接入与预算确认
- 调用：`GET /health`；`GET /tasks/active`；`GET /style-presets`；`GET /ai-configs?service_type=text|image|video|tts`；`GET /skills?lang=zh`；`GET /prompts`。
- 目的：确认服务、拿 `config_id`（text=1/10、image=9、video=8、tts=13）、确认没有遗留任务、确认风格 `documentary-archival` 存在。
- 读回：`active_count=0`。

### 步骤 1：立项与剧本
- `POST /dramas`：`{title:"殷墟与碳十四·Round2五镜技术测试", project_type:"documentary", aspect_ratio:"16:9", genre:"历史纪录片", style:"documentary-archival", description:"…非用户艺术批准"}`
- `PUT /dramas/8`：`{documentary_rules:"on"}`（补落盘）。
- `POST /episodes`：`{drama_id:8, title:"年代如何被推知", resolution:"720p", image_config_id:9, video_config_id:8, tts_config_id:13}`
- **历史测试写入，仅保留审计，不是首轮导入模板**：当轮曾 `PUT /episodes/14 {content, script_content, narration_enabled:true, audio_mix_mode:"replace", subtitle_timing:"sentence"}`。这条记录不能复制为现行操作步骤，也不能证明 AI 改写已获授权或由火宝执行；普通任务按 S1 分开导入原文、获准后调用火宝改写。
- `GET /dramas/8`：读回项目/集/资产，核对 ID 与显示集数。
- **人**确认剧本 → 人授权后 `POST /episodes/14/script/confirm`（Agent 只准备差异与事实报告）。
- `GET /episodes/14/gates`：确认剧本闸门已开。
- 为什么：没有剧本确认，后续所有阶段都不该开工。

### 步骤 2：资产提取与审核
- `POST /episodes/14/extract` ×3：`{target:"characters"|"scenes"|"props", config_id:1, model:"glm-5.3"}`；轮询 `GET /extract-status`。
- `GET /episodes/14/{characters,scenes,props}`、`GET /character-roster`。
- 修正：`PUT /scenes/40`、`PUT /scenes/41`（`location/prompt/lighting/time`），`PUT /props/91 {name,description}`；`DELETE /episodes/14/assets/link?kind=scene&asset_id=42`、`kind=prop&asset_id=90`（去掉误关联）。
- 生图：`POST /scenes/40/generate-prompt {episode_id:14,text_config_id:1}` → `POST /scenes/40/generate-image {episode_id:14,config_id:9,model:"qwen-image-2.1"}`；道具同理。任务 935/936。
- 忠实素材：`POST /props {drama_id:8, episode_id:14, name:"车马坑原始照片", type:"证据素材", description:"…", faithful:true}` → `POST /upload/image` → `POST /tasks/register-upload {asset_type:"prop", asset_id:92, local_path:"static/uploads/…"}` → `PUT /props/92/faithful-source {version_task_id}`；93 同。
- 资产审核：`POST /episodes/14/asset-review/run {config_id:1,model:"glm-5.3"}` → `GET /asset-review` → `PUT /asset-review/items/7|8|11 {status:"not_needed", reason:"…"}`。
- 语义：`purpose:"precision"` 不是“精确复原”，而是“带权威参照、程序 gate 与人工审批的生成逼近”，产物仍是艺术再现；不得声称考古/器物级精确复原。
- 精确→美化：`POST /asset-pipeline/asset-sources`（multipart CC0 照片 + `role:"generation_reference"`、`license`、`title`、`artist`、`era`）→ `POST /asset-pipeline/runs {asset_kind:"scene", asset_id:41, episode_id:14, purpose:"precision", config_id:9, model:"qwen-image-2.1", text_config_id:1}`（run 934）→ `GET /asset-pipeline/runs/934` 轮询 → 人打开 round1（task 940）→ `POST /asset-pipeline/runs/934/approve {round_id:1, verdict:"revise", selected_violations:["mh6"], notes:"…", opened:[{path,sha256}], override_gate:false}` → 美化 task 941 → 人开图 → **人明确授权技术例外后** `POST /asset-pipeline/runs/934/approve {round_id:2, verdict:"approve", notes:"技术例外：后轮辐条在原照中被遮挡…", opened:[…], override_gate:true}`。
- 读回：13 项审核 `8 have / 5 not_needed / 0 missing / 0 ignored`；两个程序 gate 仍 `gate_pass=0`（mh6），记录保留。
- 为什么：纪录片必须先解决“信息点需要什么资产”，缺的补、不要的可写理由；精确/美化不是随便重绘，必须带权威素材与开图审批。

### 步骤 3：Poster（可选）**【已过时：#72 之后按 S3 执行】**
- 当轮调用（历史）：`GET /episodes/14/poster` → `PUT /episodes/14/poster {prompt, base_image, reference_images, layout{texts[...]}}`（3 个文字层，坐标 0–1）→ 本地按 layout 渲染 PNG → `POST /upload/image` → `POST /episodes/14/poster/versions {image, base_image, layout}` → `PUT /episodes/14/poster/select {version_id:10}`。
- 读回：Poster 10，0 张 AI 图。
- **现行做法**：`layout` 与本地画布已被 `layer_doc` + `POST …/poster/versions` 的服务端渲染取代（S3）；不要再本地渲染后 `POST /upload/image` 登记。
- 为什么：Poster 不进主线闸门；精确排版用确定性渲染，不靠扩散写字。

### 步骤 4：拆镜
- `POST /agent/storyboard_breaker/chat {drama_id:8, episode_id:14, config_id:10, model:"deepseek-chat", message:"…恰好五段一镜一段，旁白逐字原文，覆盖率100%，不启动任何生成…"}`
- `GET /episodes/14/storyboards`：得到 186–190。
- 为什么（当轮事实）：本稿五段都短于 80 字，所以恰好五镜一段。**不要把它读成通则**：现行上限见 S4（单镜 ≤80 朗读字、`storyboardCountCap`），长段落必须拆成多镜；旁白原文不动、拆镜阶段不偷跑生成这两条仍然有效。

### 步骤 5：设计卡与组合
- `GET /design-card-context`、`GET /design-cards/audit`。
- `POST /design-cards/fill {storyboard_ids:[186..190], config_id:10, model:"deepseek-chat"}`（草稿）→ `GET /design-cards/status`。
- 人显式定：C/B/A/A/A。逐镜 `PUT /storyboards/{id}/design-card`：
  - 186：`combo:"C"`，`budget:{layer_s:4,gen_s:6}`，`layer_plan`（3 个 label：河南·安阳 / 殷墟 / 艺术再现），`gen_plan.first` 不写（由衔接帧锁定），`mid/last` 只写机位与“无人无文字”。
  - 187：`combo:"B"`，`budget:{layer_s:null,gen_s:10}`，`gen_plan.first/mid/last` 只用 `@车马坑艺术再现` 指代，不描述外形。
  - 188/189/190：`combo:"A"`，`budget.layer_s` 10/10/12，`layer_plan.base` 指向确定性底图（188 用示意底图，189 用流程底图，190 用真实照片 92 + 现代定位图 93）。
- 人逐镜审卡/定组合后 → `POST /storyboards/{id}/design-card/confirm {acknowledge:true}` ×5（Agent 不得自发确认）。
- `GET /design-cards/audit`：5 镜 `confirmed`，`unresolved=0`。
- 为什么：本轮（2026-11-05）组合全部由人显式给出；C 的衔接帧锁定必须体现在卡里（first 由图层末帧继承）。**两处口径已更新**：① #82 之后纪录片批次可为「尚无 combo」的镜首次写入 AI 所选组合，人改为逐镜审阅 + 确认（见 S5）；② #70 之后纪录片必须先确认旁白骨架、先配音拿到实测时长，才允许填/确认设计卡——本轮这个「设计卡在配音（步骤 8）之前」的次序已不可照抄。

### 步骤 6：图层段
- `GET /layer-segments/storyboards/186`：`combo:"C"`、`production_unlocked:true`。
- `POST /layer-segments/storyboards/186/draft`（按 `layer_plan` 出草稿）。
- `PUT /layer-segments/storyboards/186`：`{layer_doc{version,base{path,width:960,height:544,source_width:1920,source_height:1088},theme:"archival",layers[4 label]}, timeline{fps:25,ease:"inout",fade_ms:250,keyframes[{t:0,visible:[location,art]},{t:0.8,…},{t:1.5,…},{t:4,…}]}, duration:4}`（当轮本集的目标帧率恰为 25；现行 `timeline.fps` 由服务端按 #69 派生并覆盖请求值，见 S6）
- `POST /layer-segments/storyboards/186/render`：task 945；读回 `junction.hash=72d30e…`。
- A 镜：`GET /base-candidates` → `PUT /layer-segments/storyboards/188|189|190 {layer_doc, timeline, duration, base_ref}` → render。188 初次渲染后人工发现半衰期数字错，**只改 `layer_doc` 再 render**（不重跑上游）。
- 实际查看 `thumbnail/last`：文字安全边、对比度、数字正确。
- `mid_frame_time` 是**生成段内**时刻（186 生成段 6s → mid=3），不是整镜 10.583s 的中点。
- 为什么：图层用于精确信息；C 的末帧必须**去掉全部文字**再当生成段首帧。

### 步骤 7：关键帧提示词与预检（只写文本，不出图）
- `GET /episodes/14/keyframe-prompts/scope` → `POST /episodes/14/generate-keyframe-prompts {storyboard_ids:[186..190], config_id:1, model:"glm-5.3"}` → `GET /episodes/14/keyframe-prompts-status`。
- `POST /episodes/14/keyframe-batch/preview {storyboard_ids:[186..190], config_id:9, model:"qwen-image-2.1"}`：
  - 186-first `skipped`（衔接帧锁定，C 首帧由图层末帧继承）；
  - 188/190 首尾 `skipped`（A 无生成段 / 提示词空）；
  - 187 首中尾 `missing`；189 首尾虽显示 `missing`，但 A 镜不用于生成视频，本轮**不出图**（避免浪费额度）。
- 读回待出图清单：**186 mid/last + 187 first/mid/last = 5 张**。
- 为什么：关键帧用于生成段；A 镜由图层段承担全部画面，不需要关键帧。锁定槽不能单独出图。

### 步骤 8：旁白与配音（实测时长）
- `GET /episodes/14/tts-options`。
- `POST /episodes/14/narration/voice-batch/preview {storyboard_ids:[186..190], settings:{voice:"纪录片·沉稳男声", inference_timesteps:10, cfg_value:2, seed:1720, instructions:"中年男声…", normalize:true}}`
- `POST /episodes/14/narration/voice-batch` 同 body → `GET /episodes/14/narration/voice-batch-status`；5 条 TTS（951）。
- 逐镜 `GET /storyboards/{id}/narration-fit/preview`。
- `POST /storyboards/{id}/narration/subtitle` ×5；`PUT /storyboards/{id}/narration-fit {mode:"pad", pad_ms:800, pad_position:"tail", audio_mix_mode:"replace"}` ×5。
- 实测时长落定后 → `PUT /storyboards/186 {mid_frame_time:3, continuity_boundary:"cut"}`（mid 是**生成段内**时刻：186 生成段 6s → mid=3；不是整镜 10.583s 的中点）。
- 下载 WAV/SRT 实际检查；覆盖率 161/161。
- 为什么：先定配音实测时长与生成段预算，才能落定 mid 时刻、校准视频 Prompt 尾段；否则关键帧引导时间与成片时长对不上。

### 步骤 9：关键帧出图与确认 → 视频提示词 → 视频
- 实际出图（按步骤 7 的清单，共 5 张）：`POST /storyboards/186/keyframes/mid|last/generate`，`POST /storyboards/187/keyframes/first|mid|last/generate`（tasks 954/955/957/958/959）。
- 轮询 `GET /tasks/{id}` → 下载并开图检查构图/参考一致性。
- `POST /episodes/14/generate-video-prompts {storyboard_ids:[186..190], config_id:1, model:"glm-5.3"}` → `GET /episodes/14/video-prompts-status`（此时配音时长已定，可对齐尾段）。
- 人看过已出关键帧后 → `POST /storyboards/186/confirm-keyframes {confirmed:true}`、187 同。
- `POST /episodes/14/video-batch/preview {storyboard_ids:[186..190], config_id:8, model:"MiniMax-H3-INT8-ComfyUI"}`：186/187 `missing`，188/189/190 `excluded:no_generated_segment`。
- `POST /episodes/14/video-batch {storyboard_ids:[186,187], config_id:8, model:"…"}`：恰好 2 条生产视频（960/961）。
- 轮询 `GET /episodes/14/video-batch` 与 `GET /tasks/960|961`；下载 raw：C 请求 6s→实际 6.583333s/24fps；B 请求 10s→10.125s/24fps。
- 为什么：确认必须在实测时长与最终 mid 落定之后；批量只提交预览勾选的生成段镜头；A 镜由图层段直接产出视频，不走模型。

### 步骤 10：合成与导出
- `POST /episodes/14/compose-batch/preview {storyboard_ids:[186..190]}`：5 镜 `missing`、`plan` 显示 `dv/da/d` 与 `gapRatio`。
- `POST /episodes/14/compose-batch {storyboard_ids:[186..190]}` → 轮询 `GET /compose-batch-status`：`5 completed / 0 failed / 0 skipped`。
- `GET /episodes/14/storyboards`：逐镜 `compose_state.status="unchanged"`、`exportable=true`。
- `GET /merge/episodes/14/merge` → `POST /merge/episodes/14/merge {storyboard_ids:[186..190], poster_version_id:10, poster_duration:2}` → merge 26 → 轮询到 completed。
- 下载最终片，ffprobe + 全解码 + 五镜联系表 + 浏览器播放。
- 实际：`54.76s / 960×544 / 25fps / 1369 帧`；Poster 51 帧 2.04s；五合成片 `dff15a3b…/781364c2…/395f2172…/5818152f…/d6c0c0e0…`。
- 为什么：签名只证明“输入一致”，不证明画面正确；必须打开实际媒体。

### 步骤 11：验收与失败记录
- 逐镜比对：C186 的首帧应为 junction PNG（hash `72d30e…`）；实测生成首帧与 junction SSIM **0.248407**，成片约 6.04s 出现机位/天空/柱基跳变 → 判 **视觉 FAIL**，保留在成片中。
- 零 GPU 诊断：确认上传首帧/ref0 字节都等于 junction hash；引擎图 `guide0 frame_idx=0 / guide1=72 / guide2=-1`，latent 131；扩写提示词与图片几何矛盾（高俯角/填满/圆孔 vs 有天空/无圆孔）。结论只能是“上传与图结构未发现错误；唯一因果未证明”，不能把“模型局限”写成 PASS。
- B187：车轮远近景辐条/毂形变；资产程序 gate mh6 仍 FAIL。
- 音频：五旁白保留（native→final 相关 0.998788–0.999594，100ms 语音窗 ≥0.97956）；未人工听审；AAC 解码少量峰值 >1.0 如实记录。
- 成本：9 AI 图（935/936/940/941/954/955/957/958/959）、2 生产视频、5 TTS；Poster 与原生图 0。
- 为什么：诊断片的价值是暴露问题；把 `exportable` 当“质量通过”会掩盖 C 的真实缺陷。

## 附：典型错误案例 — 助手代填「AI 改写」（2026-11-06，《历史纵横》漕运，第 1 集；`SKILL.md` §4.5 全文）

- **用户边界**：先做第一步、让用户看完再等指令。两页分别是 `drama/9/episode/1?panel=script&step=0`「原始内容」与 `...&step=1`「AI 改写」；数据库 `drama_id=9`、`episode_id=15`。
- **真实错误 [R]**：助手自行写了840字符、16段解说稿，直接 `PUT /episodes/15`，请求含 `content`、`description`、`script_content`。结果原始内容与 AI 改写两页同时被填上，但没有调用 `POST /agent/script_rewriter/chat`。经 API 存进去的自写稿不是“通过火宝改写”。
- **错误推理**：把“用户想用火宝改写”误当成“允许助手代写回填”；把通用字段编辑能力误当成当前阶段授权；又以纪录片内置技能只允许整理、内容量±5%为理由绕开火宝。计划里写入了这套错误方案，也不能替代用户的具体阶段边界。旧流程把两种文本字段并列、历史示例又同时写两者，容易强化误读，但不是越权借口。
- **为什么必须禁止**：用户失去第一步的审核与推进控制；第二步失去火宝内部工种的生成链路与记录；即使没有确认或生成媒体，提前代填第二步本身已经越权。
- **应当怎样做**：原文只进 `content` → 读回并提交第一步链接 → 等用户；获准改写后才调用火宝 `script_rewriter` → 读回火宝稿件 → 再等用户审核。规则冲突就报告，不本地代写补位。
- **纠错边界**：用户随后明确“不要再操作，只更新 skill”。这时只改已授权的助手技能文档；不再请求火宝、清空稿件、运行改写或声称已经恢复某个业务状态。本案例记录的是错误及预防规则，不是可复制的成功流程。
