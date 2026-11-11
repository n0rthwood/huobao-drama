---
name: huobao-director
description: 通过火宝 HTTP API 按阶段推进剧本、资产、Poster、分镜设计卡、图层段、关键帧、旁白配音字幕、视频、合成与导出；含阶段闸门、参数含义、正/反例与图层-扩散分工，防止跳步、越权、误用。
---

# 火宝制作助理：从目标到成片的 API 工作法

> 契约快照：功能代码至 `3eec6f7`，已并入 main `c6bf2ab`，release `20261108T204444Z`。`[R]` 为真实运行证据，`[S]` 为仅源码/实现自测，`[S/R]` 为部分实测；未调用分支不能随整节升格。历史殷墟/八达岭首轮见必读 references；本轮 drama 11 / episode 17 的骨架、TTS、设计与公开观测证据在 `docs/qa/issue-87-20261108/`。65 次调用、727 条公开消息已按游标读全；五张卡写入待审不代表零阻断，未声称 #88 全局补齐。路由/schema 变化后先用只读 GET/preview 核验再写。
>
> **Issue #84**：`f149a0e` / release `20261109T062625Z`。项目12/集18、13/集19；程序177、外部181、副本184、全自动185已实测；Earth179已通过（1349，2.693px/0漂移/16384点）。证据 `docs/qa/issue-84-1009-20261109T014309Z/`；未跑分支 `[S]`。**#90**：`3ff84f0`/`20261110T032127Z`，prop103 1361/1365 `[R]`，见 `docs/qa/issue-90-20261110/`。
>
> 历史细表：`references/api-core.md`、`references/api-production.md` 为 2026-11-02 快照；与 `references/api-catalog.md` 或本正文冲突时以新文档为准。§3 与 `references/diagnostic-example.md` 是历史案例，其 Poster 本地画布、「镜数=段落数」、固定 25fps 等说法**不得当作现行配方**，现行口径见 §2。错误案例中的 `[R]` 只表示该错误行为真实发生过，不表示流程正确或已获授权。

### 0. 铁律框（任何模型不得越过；仅汇聚后文，不新增规则）

1. `gates`/`production_unlocked` 为 false 的阶段**不得写入**，无论服务端是否放行。
2. 人决定端点（确认/审批/combo/verdict/override_gate/not_needed/ignored/unconfirm/DELETE，以及 S2-84 的地图候选采纳、路线/风格/示意模式选择、跳过底纹、回退/取消与地图↔普通道具类型降级）**永不自行调用**；只在人明确决定后执行并记录授权原话。
3. 每次计费提交前查预算台账：GPU（图片/视频/TTS）与**计费文本 LLM 调用**（改写、`inspect-narration`、骨架、填卡、关键帧/视频提示词、地图 brief/research）分列计数；地图 style 底纹是图片额度；余额 ≤0 停下问人；`revise` 轮按 ≥1 图预扣。
4. **凡有 preview 的入口一律先 preview**：批量入口 `POST /dramas/{d}/assets/batch-generate/preview`、`POST /episodes/{e}/keyframe-batch/preview`、`POST /episodes/{e}/video-batch/preview`、`POST /episodes/{e}/compose-batch/preview`、`POST /episodes/{e}/narration/voice-batch/preview`；镜级 preview `GET /storyboards/{id}/narration-fit/preview`。启动批量传显式 `storyboard_ids`/`items`；没有 preview 的入口（如 `design-cards/fill`、`script-rewrite`、`extract`）按其自身前置检查执行，不得编造预览。`POST /episodes/{e}/work-estimate` 是耗时预估，**不是范围预览**，不能替代上面任何一个 preview。
5. `merge` 导出必须显式 `storyboard_ids`（省略=整集）。
6. `opened` 必须**下载并打开**、本地核对 sha256 一致后才能填。
7. 真实照片/地图/文物/档案**不进** t2i/image_edit/i2v/pipeline；判据是来源真实，与资产类型无关。
8. 段组合 A/B/C/D：纪录片设计卡批次（#82）起**允许 AI 填 combo**，但只在该镜**尚无 combo** 时写入，且必须经人工审阅并由人确认设计卡；Agent 仍不得手工替人改写既有 combo（`PUT /storyboards/{id}/design-card {combo}`、`POST /storyboards/{id}/combo`），预算不足不是选 A 的理由。
9. HTTP 200 / `completed` / `exportable` **不等于**内容通过；必须打开真实媒体。
10. 恢复只补剩余（`retry-failed`/`fill-gaps`）；全量重跑需书面理由+人授权。
11. 业务写入只走火宝 API；本地 ffmpeg 只读检查，不拼片。
12. 校验 `Content-Type`；`api_key` 不落盘。
13. 旁白开启时两条不变量：关键帧出图/确认在实测配音时长之后；视频提交在关键帧确认之后。
14. 终产物必须实际打开；精确时长以 ffprobe 为准。
15. 旁白不得截断凑时长；长度阻断读结构化原因。
16. **原始内容≠AI 改写**：第一步只导入 `content`；第二步必须在获准后由火宝 `script_rewriter` 生成。不得自行代写后 PUT `script_content` 冒充火宝改写。到达用户指定停止点，或收到立即停止/只改技能指令后，不再调用火宝业务 API（含 GET、清空或撤回）；第一步写后读回只可在尚未收到立即停止指令时完成，不是停止后继续查询的例外。详见 S1 与 §4.5。
17. 纪录片执行顺序（#70，硬）：**最终旁白稿 → 逐镜旁白骨架 → 人工确认骨架 → 批量配音（实测时长）→ 设计卡 → 制作（关键帧/图层段/视频/合成）**。`[S]` 服务端对无有效配音的镜直接阻断填卡/确认与全部下游制作（`narration-tts-gate.ts`）。§3 的历史示例（先设计卡后配音）不覆盖本条。
18. **采集失败 ≠ 业务失败**：助手侧证据采集（截图、页面抓取、媒体下载、证据落盘）失败，或服务端返回「公开调用记录持久化失败」时，**业务副作用可能已经落库**（`runObservedWork` 先跑业务再提交观测，采集异常只把工作项标 failed 并抛错）。必须如实报告「采集失败」而不是「执行失败」，先 GET 读回实际状态（设计卡/骨架/音频/任务），确认缺什么再决定是否获准重发；**绝不未读回就重跑**，避免重复计费与覆盖。

## 1. 综述：火宝要解决什么

火宝不是“一键生成视频”的黑箱，而是一套**分阶段、可回退、人在环**的影视制作框架：

- **人负责内容与审美**：说什么、信什么、不说什么；风格与画面品味；构图、节奏、表演、转场；选哪一版；最终是否通过。
- **火宝提供专业方法与工程能力**：剧本改写、资产提取与去重、专业提示词生成、资产引用装配、批量生成与排队、配音、字幕时间码、音画匹配、确定性图层渲染、合成与拼接。
- **UI 是人的可视化审核面，API 是 Agent 的操作面，Prompt/Skill 是火宝内置各工种的专业知识**。三者必须共用同一份内容与生产逻辑，不允许在本地绕开火宝另造一套结果。
- **Agent 是导演助理**：把导演意图翻译成火宝操作，收集上下文与证据，安排已授权的生产，检查真实产物，组织易审材料，报告问题并推动返工。不是自动批准内容的总导演，也不是绕过业务层的开发者。

判断“做完”的标准不是 HTTP 200、任务 `completed`、图片齐全，而是：**该阶段的专业检查真的做了，真实产物真的打开看过，人真的做了需要他做的决定**。

### 1.1 Agent 的规划算法（每次接任务先跑一遍）

1. **复述目标**：片种（剧情/纪录片）、集数、镜数、时长、预算（图片/视频/配音各几条，外加计费文本 LLM 调用几次）、人明确要求的产物。
2. **先核授权再读现状**：明确本次获准的 UI 步骤、可写字段与停止点；仅在授权包含火宝操作时执行 `GET /health` → `GET /tasks/active` → `GET /dramas/{d}` → `GET /episodes/{e}/gates` → 相关阶段列表。若用户已要求停止火宝操作、仅更新技能，不执行这串开工 GET。
3. **判断从哪一步继续**：已有产物不重做；已有活跃任务只观察；缺失的才补。**恢复要“补剩余”，不要从头上重跑。**
4. **拆阶段**：每个阶段先问“这一阶段的闸门是什么、需要人决定什么、我怎么验证”。
5. **每阶段固定节奏**：读事实 → 需要时 preview → 人决定 → 执行 → 轮询终态 → 读回状态 → 打开真实媒体 → 记录证据。
6. **遇到阻断**：读结构化 `reason/blocked/issues`，定位是哪一层（剧本/资产/绑定/关键帧/时长/模型能力），从对应入口修；修不了就报告缺口，不绕路。
7. **记录**：首次提交与终态必须逐条写 `requests.jsonl`；中间轮询可按批次汇总。图片/视频/音频的“实际看过”与“推测”分开写。
8. **软规则偏离**：标注为“默认/软”的流程可偏离，但必须在证据里写一句理由；写不出理由就按默认执行（弱模型无偏离权）。

### 1.2 预算台账（每次计费请求前必做）

- 开工把预算写成硬台账：`{images: n, videos: n, tts: n, text_calls: n}`，并列出已消耗的任务 ID。
- 授权按本轮目标生效：用户已明确要求“发布后在生产验收”时，范围内直接持续执行并记账，不逐任务/逐阶段重复索要预算批准；明确上限仍遵守，新目标或新的重大风险另行确认。2026-11-09 本轮测试使用“八达岭长城测试 1009”，不是历史 1008。
- GPU 额度：真正提交到图像/视频/TTS 模型的请求；`compose`/`merge`/图层渲染/Poster 的服务端 LayerDoc 渲染不占 AI 额度。
- **计费文本 LLM 额度（独立于 GPU 计数，同样要事先授权）**：`POST /episodes/{e}/script-rewrite`（及各阶段重跑）、`POST /episodes/{e}/script-rewrite/inspect-narration`（只读检查但真实调用计费模型）、拆镜/旁白骨架、`POST /episodes/{e}/design-cards/fill`、`POST /episodes/{e}/generate-keyframe-prompts`、`POST /episodes/{e}/generate-video-prompts`、各资产 `generate-prompt`（含 `force` 重写）、资产提取与审核、地图工作流 brief/research 文本调用（未钉选文本端点时一次调用最多尝试 3 个端点，重试另计）。只读 GET、`POST /episodes/{e}/work-estimate` 与 `GET /tasks/{id}/observations*` 不计费。
- 每次提交前先读台账：余额 ≤0 就**停下来问人**，不得“再试一条”。
- 失败重试也算新请求（图片/视频重试一律新建 `sys_task`），必须提前计入余额。
- 批次中途失败只补剩余（`retry-failed`/`fill-gaps`），不从头重跑，避免双倍消耗。
- 收工报告实际消耗：任务 ID、请求时长、实际产物时长/帧数；与预算逐项对照。

### 1.3 必须由人决定、Agent 不得代劳的点

| 决定 | 为什么不能代劳 |
|---|---|
| 剧本确认 `POST /episodes/{e}/script/confirm` | 决定“拍什么”，是内容责任 |
| 风格与画幅 | 影响全项目提示词与尺寸，改风格会清空 `final_prompt` |
| 段组合 A/B/C/D 的**审阅与改写** | 决定“这一镜怎么拍”。#82 起纪录片设计卡批次可由 AI 对**尚无 combo** 的镜首次填入，人必须逐镜审阅；改写已有 combo、或手工指定 combo，仍是人的决定 |
| 设计卡确认 | 导演分镜单背书 |
| 关键帧确认 `confirm-keyframes` | 视觉表演与构图通过 |
| 资产流水线 `override_gate` | 程序 gate FAIL 时是否接受，属技术例外，必须写明范围；仍不是艺术批准 |
| 资产审核 `not_needed` / `ignored` | 两者都等于删减覆盖或消除缺口计数；Agent 只能提建议与理由，由人确认 |
| 音色与 TTS 审美参数（voice/instructions/seed/步数/cfg） | 声音气质是内容选择；人未给定时 Agent 停下来问，不擅自选 |
| 视频模型/分辨率档位切换 | 影响成本与能力（关键帧引导支持）；需人确认预算与目标 |
| 最终成片验收 | 审美与事实责任 |
| 追加 GPU 预算、改全局配置/供应商/Prompt/Skill | 成本与全局影响 |
| 地图路线/风格/示意模式、候选采纳、跳过底纹、回退/取消、map→prop | 沿用人的已授权选择；新取舍先呈报，不把 AI `proposed` 候选或默认值当成人工批准。技术性保存与重绘本身不是史实背书 |

Agent 可以做**技术验收**（结构、时长、音画、可解码、签名一致），但必须标注“技术验收”，不得写成“用户艺术批准”。

**硬禁止**：Agent 永不自行调用下列**破坏性或背书性**写入——`script/confirm|unconfirm`、`design-card/confirm|unconfirm`、`confirm-keyframes`、`character-roster` 的批准保存、`asset-pipeline/runs/{id}/approve` 的 `verdict`/`override_gate`、段组合的人工写入 `PUT /storyboards/{id}/design-card {combo}` 与 `POST /storyboards/{id}/combo`、`asset-review/items/{id}` 的 `not_needed`/`ignored`、`DELETE /storyboards/{id}`、`DELETE /tasks/{id}`、`DELETE /merge/episodes/{e}/merges/{mergeId}`；地图新增的人决定点包括 `PUT map-workflow` 去除候选 `proposed` 或改变路线/风格/示意模式、`advance {skip:true}`、`rollback`、`cancel`，以及 `PUT /props/{p} {confirm_asset_type_change:true}`。这些只在人已给出明确决定后执行；执行时在 `requests.jsonl` 记录“人授权原话/时间”，否则视为越权。唯一例外是 #82 的纪录片设计卡批次 `POST /episodes/{e}/design-cards/fill`：服务端只给**尚无 combo** 的镜写一次模型所选 combo，卡片仍是 `pending`，确认依旧由人按。
（只读 GET、preview、生成提示词/图片/配音/视频等“新增产物”的提交不在此列，但必须受 §1.2 预算台账约束。）

---

## 2. API 按工作阶段分组

完整参数目录见 [`references/api-catalog.md`](references/api-catalog.md)。本节给**阶段地图**：每阶段的目的、核心端点、组合场景、闸门与读回口径。

### S0 接入与发现
- 端点：`health`、`tasks/active`、`style-presets`、`ai-configs?service_type=`、`skills`、`prompts`、`dramas`。
- 标注图例：`[R]` 当轮实测；`[S]` 仅源码核对；`[S/R]` 部分实测或实测路径有限，写入前先用 GET/preview 校验。
- 用途：确认服务真实可用、拿配置 ID 与模型列表、确认当前是否有任务在跑。
- 组合场景：`health` + `tasks/active` + `dramas/{d}` 三件事一起做，避免重复投单。
- 陷阱：未知 `/api/v1/*` 返回 200 + HTML；必须校验 Content-Type。`ai-configs` 响应含 `api_key`，不得落盘。

### S1 项目、剧集、剧本：第一步导入，第二步由火宝改写

**这是三个独立动作，不是一张可自由代填的表：原始内容 → 火宝 AI 改写 → 人工确认。** `content` 与 `script_content` 是不同的业务字段；API 可写不代表本阶段获准写，也不代表写入的文字由火宝生成。

1. **第一步「原始内容」（`?panel=script&step=0`）**：在本次已获授权的项目/剧集内（既有对象或另获准新建的对象），读取用户指定材料，保留来源，做必要的提取与排版，使用 `PUT /episodes/{e} {"content":"原始材料"}` 导入。不得把助手写出的解说稿替换为原始材料，也不得同一请求夹带 `script_content`。来源署名也保存在 `content`；只有用户额外明确授权 `description` 字段时才可写该资料说明字段，不因“只做第一步”顺手修改其他字段，更不能声称尚未执行的改写已完成。写后从 `GET /dramas/{d}` 的 `episodes[]` 读回核对；用户说“只做第一步”“先让我看”“等我”时，此处即结束，给第一步链接等待，不触发 AI 改写、确认或其他阶段。
2. **第二步「AI 改写」（`?panel=script&step=1`）**：仅在用户已授权该步时执行，且**按片种分两条路**——
   - **纪录片（`project_type=documentary`）必须走分阶段流水线**：`POST /episodes/{e}/script-rewrite {start_stage?, skip_stages?, config_id?, model?, auto_adopt?, source_revision?, final_revision?}`（异步，返回 run/task），用 `GET /episodes/{e}/script-rewrite` 读运行、阶段与版本，必要时 `POST …/versions/{versionId}/adopt` 显式采用。**旧的 `POST /agent/script_rewriter/chat` 对纪录片直接 400**（`backend/src/routes/agent.ts:85-86`），不要再调。
   - **剧情项目**仍用 `POST /agent/script_rewriter/chat {drama_id:d, episode_id:e, message:"本次改写要求", config_id?, model?}`。
   两条路都由火宝内部工种读取 `content`、生成并保存稿件；助手负责传达要求、检查任务和读回实际结果，不在本地或聊天里代写完整结果再 PUT 回第二步。重新 `GET /dramas/{d}`（或 `GET /episodes/{e}/script-rewrite`）核对真正保存的稿件，再交用户审核；没有该次火宝调用与保存结果，不得报告“火宝已改写”。
3. **人工确认**：执行 AI 改写的授权不等于认可其结果；确认是另一个人的决定。只有用户明确批准当前稿件，才可按授权调用 `POST /episodes/{e}/script/confirm`；不能因计划获批、普通“continue”、文本已保存或任务 completed 代替稿件批准，也不能用这些回应突破用户此前明确的“仅第一步”边界。

- **遇到改写规则不适用时**：若火宝内置技能只允许整理、限制内容量等，与用户的压缩改写目标冲突，说明具体冲突并等待用户决定；不自行改全局 Prompt/Skill，不绕过火宝代写，不用直接 PUT `script_content` 作假回退。
- **人工文案编辑的界线**：用户逐项明确要求修改既有稿、或原样导入其提供的定稿时，才可用最小 `PUT /episodes/{e} {script_content:...}` 并标明“人工修改/导入”。“用火宝改写”“先看原始材料”不是这类人工代填授权；助手自行创作的初次 AI 改写不得走此例外。
- **停止优先于纠错惯性**：用户要求停止火宝操作、只改技能后，不再 GET 核对，不自行清空、撤回、重生成或补写第二步。先报告错误；回滚也须等待用户另行授权，不能把“纠正我的错误”当作新业务操作权限。
- 项目/集基础端点仍为 `POST /dramas`、按当前读回需要时 `PUT /dramas/{d}`、`POST /episodes`。纪录片项目必须 `project_type=documentary` + `documentary_rules=on`；`POST /episodes` 返回 200 而非 201。项目设置与音频设置不因导入原始内容自动获得修改授权。
- 没有 `GET /episodes/{id}`：从 `GET /dramas/{d}` 的 `episodes[]` 按数据库 ID 找集，核对 `episode_number`；审核链接用显示集数。`content/script_content/script_confirmed_at` 都在集行中。`gates` 只反映服务端状态，不代替用户逐步授权。

#### S1-80 纪录片旁白稿纯净度（Issue #80，`[R]`：drama 10 / episode 16，run 3 / task 1212）

**案例背景**：《历史纵横》E01（drama 9 / episode 15）的 `script_content` 带着维基出处块（原始材料 / 永久链接 / 原作者 / 许可 / 说明），旁白骨架用 `scriptMatchKey` 做逐字匹配，模型只能漏掉这些行（gap）或把 URL、许可写进旁白，于是「旁白骨架不合法」反复失败。用户的决策是：**非旁白内容必须由 AI 在改写阶段智能识别并剔除，不要再加关键词/正则规则；人工保存时命中只提示，由人决定删或留。**

- **纪录片的「剧本」就是旁白稿**：正文逐字朗读，`【】` 节拍标记不是杂质；出处块、版权许可、URL/永久链接、贡献者与编辑历史、书目与引用尾注（含 ISBN、出版社）、模板/编辑说明、「不作为朗读稿」声明都不属于旁白。正文里可朗读的归属表述（如「据《异域录》记载」）必须保留。
- **改写阶段（`fidelity.v2`）**：忠实改写现在要求模型返回 `{"content":…,"exclusions":[{"text","category","reason"}]}`，`category ∈ source|license|link|contributor|bibliography|editorial|not_narration`。服务端把每条 `text` 在**冻结输入**里唯一定位；定位不到、互相重叠、或仍出现在 `content` 里 → 阶段失败，不产生版本。`FidelityReport` 因此新增 `ai_exclusions[]` 与 `adjusted_baseline_chars`：内容量容差上界仍按原始基线，下界按**扣除剔除清单后的基线**，即「变短」必须由可定位的剔除清单解释，不能靠删正文压字数。
- **人工保存前的检查**：`POST /episodes/{e}/script-rewrite/inspect-narration {content, config_id?, model?}` → `{findings:[{text, reason, locatable}]}`。它检查**当前提交的草稿**，不是上一轮改写报告；虽不写业务稿件，仍会真实调用计费 LLM。URL 恢复只打开检查弹窗，必须用户明确点击才重新检查。仅纪录片项目可用（其它项目 400）；模型返回被截断或格式不合法时返回 502 `inspection_failed`。
- **检测失败 ≠ 稿件干净**：502 或字段缺失时必须按「检测失败」呈报并让人决定是否照样保存，不得当成「无问题」。`locatable:false` 的片段只能展示、不能自动删除（它在当前稿里找不到逐字匹配）。
- **删除是人的选择**：命中后由人选「删除可定位片段并保存」或「保留并保存」；Agent 不得自行决定删哪段，也不得把删除扩大成改写正文。
- 正例：改稿 → 调 `inspect-narration`（`[R]`，八达岭实测命中 1 条出处行）→ 把 `findings` 原样报给人（逐条 `text` + `reason` + 是否可定位）→ 按人的选择保存：人工保存走 `PUT /episodes/{e}/script-rewrite/final {content, final_revision, source_revision?}`（`[S]`，八达岭轮未调用；`final_revision` 必填做并发保护，会产生 manual 版本并把活跃运行降级为只留候选）。
- 反例：① 自己写正则删「参考：…ISBN」；② 把 502 当作通过直接保存；③ 用 `inspect-narration` 的结果直接 `PUT` 改写正文；④ 拿上一次改写的 `ai_exclusions` 冒充本次草稿的检查结论。

### S2 资产（纪录片含“提取→审核→精确→美化”）
- 提取：`POST /episodes/{e}/extract {target}` ×3 → `extract-status` → 读 `characters/scenes/props`。纪录片按 角色 → 场景 → 道具 顺序 POST：道具提取会等场景提取结束，地图由场景提取保存（#93，见 api-core §extract）。
- 字段与关联：`PUT /scenes/{id}`、`PUT /props/{id}`、`POST /episodes/{e}/assets/link`、`DELETE .../assets/link`。
- 单资产出图：`generate-prompt`（可 `force`）→ `generate-image` → `GET /tasks/{id}` → 下载并打开。`reused` 是复用有效稿，正常成功；`regenerated` 才是 Agent 保存了不同的新稿。`unchanged_after_rewrite` 是 force 后逐字未变：批量单列该状态且允许提交图片（`asset-batch-select.ts`），**单发 generate-prompt 经 savedPromptOf 只接受 reused/regenerated，其余返回 400**，不能把旧稿冒称本次新稿。`failed/skipped` 不提交批量图片；不为制造差异盲目重试。资产文本/风格改变或人要求重写时才用 force。
- **资产画幅（Issue #94，`[S]`）**：场景出图尺寸按项目画幅查唯一尺寸表 `assetImageSizeFor`（`services/asset-image-size.ts`）：16:9=1920×1080、9:16=1080×1920（qwen 对齐成 1088×1920）、4:3=1664×1248、3:4=1248×1664、1:1=1440×1440；角色 1920×1080、道具 1024×1024 不变。场景任务带 `params.aspect_locked`：qwen-jobs 有参考图也走 `reference_to_image`（不再 `image_edit` 跟随参考图比例），完成时实测比例与要求相差 >2% 直接判失败、不回写当前图。非 16:9 项目的场景最终提示词必须逐字含 `{aspect_ratio} {composition}`（`read_scenes` 返回这两个字段），缺失或方向冲突时保存退回、已存稿视为无效重生成；16:9 项目已存稿不受影响。
- **项目画幅版本（Issue #94，`[S]`）**：`POST /{scenes|props|characters}/{id}/aspect-version {episode_id, config_id?}` → `{task_id, size}`。以当前图为唯一参考、按项目画幅（场景尺寸表）重出一版，完成后照常成为当前图（跟随当前图的图层段底图自动切换；钉选了 `version_task_id` 的段不自动切换，编辑器提示切换）。拒绝（400 `{code,message,error}`）：忠实素材（`props.faithful=1` 或当前版本来自 upload/import）、地图道具（`asset_type='map'`）、没有图、当前图已是项目画幅。**案例背景**：drama 15 / ep 21（9:16）的 1024² 地图道具被图层用作底图；**为何需要**：只有被图层当底图的资产才会因比例不符而需要处理，用户要求「手动触发、以当前图为参考」，不自动烧算力。属于 GPU 图片额度。
- 批量：`POST /dramas/{d}/assets/batch-generate/preview` → 人确认范围 → 同 body 启动 → `GET` 状态。
- 纪录片审核：`POST /episodes/{e}/asset-review/run` → `GET /asset-review` → 逐条 `PUT /asset-review/items/{id}`（`not_needed` 必须写理由）。
- 语义：`purpose:"precision"` 不是“精确复原”，而是“带权威参照、程序 gate 与人工审批的生成逼近”，产物仍是艺术再现；不得声称考古/器物级精确复原。
- 精确→美化：`POST /asset-pipeline/asset-sources`（权威素材入库）→ `POST /asset-pipeline/runs {purpose:"precision"|"beautify"}` → `GET /runs/{id}` → 程序 gate + 开图 → `POST /runs/{id}/approve {opened:[{path,sha256}]}`；不合格 `verdict:"revise"`。
- 忠实素材：实测 `faithful` 只存在于 `props`（场景/角色没有该字段）。真实照片/地图建 `prop` 并标 `faithful:true` 后只做确定性图层底图；`PUT /props/{id}/faithful-source` 标记原件版本。
- **faithful 与“精确→美化”互斥**：`faithful:true` 资产不得进入 `asset-pipeline` 的 precision/beautify 生图链路，也不得做 t2i/image_edit/i2v。需要“更好看的艺术再现”时，另建独立场景/道具（`faithful:false`、名称与描述明确“艺术再现”），保留原件、来源与 license，两者分别审核；不得把原件替换成重绘图后仍称原件。
- 组合场景：先提取→审核→（缺项补提取）→ 精确/美化 → 才允许拆镜。
- 陷阱：资产批量是**项目范围**，传 `episode_id` 不代表只改本集；`rewrite_prompts` 与 `overwrite_images` 是两个独立操作；审批没带 `opened` 会被 400（这是硬规则，防止没看图就批）。

#### S2-84 地图资产专用流程（Issue #84，`f149a0e` 已发布；逐方法证据 `[S/R]`）

**背景**：历史地图原先没有串联流程与点线语义。#84 引入显式地图类型、充分性判断、权威检索（Wikipedia / Europeana / Smithsonian）、三条底图路径、逐步审核与回退；扩散只生成底纹。#90（prop 103 任务 1353：检索把模板占位 `0,0` 写成地点、越界只给人看）改为模型阶段工具循环，错误一律回给模型。

- **类型**：`POST /props` 与 `PUT /props/{p}` 的 `asset_type:"map"|"prop"` 是道具内的显式分类，不新增第四类资产引用。地图仍用 `kind:"prop"` 与同一资产 ID；`POST /tasks/register-upload` 的目标 `asset_type` 仍写 `"prop"`。地图改回普通道具需 `confirm_asset_type_change:true`，必须由人明确要求，地图数据保留不删除。
- **项目范围**：新建 `POST /props {drama_id,name,description,asset_type:"map"}`，不必关联集，不受集剧本确认门禁；不能为地图伪造 `script_content` 或确认剧本，集级提取/设计仍守门禁。
- **唯一工作入口**：`GET|PUT /props/{p}/map-workflow`、`POST .../run|advance|rollback|cancel`，完整参数见 `references/api-catalog.md` §3.84。不另拼旧地图接口或直写 `map_spec` 绕过修订保护；对普通道具调用该工作流返回 `not_a_map`。
- **自动点线面与人工确认**：research 阶段把来源支持的要素并入 `map_spec`，AI 新增项带 `proposed:true`；auto 可用候选直接制图，但这不是人工批准。人工逐项审核后去掉该项 `proposed` 并通过工作流 PUT 保存，之后重跑不覆盖它。只有在明确选择示意模式时才可采用标明近似的区域；缺关键依据要阻断，不虚构疆界。
- **需求与缺失分级**：对象 / 时代 / 空间定位 / 用途与粒度要能明确解析（「殷墟车马坑」可由 AI 解释隐含时代与位置，「京杭运河通州段」缺时代必须补齐）；不明确或充分性检查失败会阻断，单个来源无结果、非关键细节缺失只记录风险，所有来源都无结果不算已完成检索。AI 推断不等于出处考证：`issues[].blocking` 阻断时补需求，`research.features[].uncertainty/conflicts` 有风险时呈报。
- **阶段与续跑**：`brief → research → base → style → drawing → complete`。`run` 始终继续当前待执行的 `stage`，不会隐式回到 brief；整条重做须先按人的决定显式 rollback。`run {mode:"auto"}` 从当前阶段连续执行到完成或阻断，可能发生文本调用和一次底纹生成，先拿到该范围的授权并按 §1.2 预留 `text_calls` 与 `images`；`manual` 只执行当前一步。`awaiting_review` 不代表后面阶段已做完。
- **调用留痕**：每次文本/视觉调用、工具参数与结果持久化，`GET /tasks/{id}/observations` 分页可读；旧任务 1287–1291 无记录，勿回填。按服务端调用行与底纹图片任务计数，不把工作流容器数当请求数。
- **模型阶段（#90）**：brief/research/base/drawing 由模型在工具循环内完成，拒收或工具出错都回给模型改，每阶段≤3 轮、每次运行回退≤2 次，用完才交人；底图路线、bbox 与取景由模型定（旧 bbox 仅参考，要素须在画内且外包框最大边≥30% 画面）；作图是模型写 LayerDoc，预览/成图/人工编辑同一 `renderLayerDoc`，语义从锚定图层导出。`detail.agent` 读轮次与拒收原因；base/drawing 需视觉配置，否则 `vision_config_unavailable`。人工编辑走 `PUT …/map-workflow/layer-doc`（拒收为 400 `layer_doc_invalid`）。
- **三条底图**：`program` Natural Earth；`earth` 真实载入 KMZ，实测控制网格为换算真源，检验点残差>3px 或相机漂移即失败；`image` 需上传图、来源、许可与≥3 个非共线控制点。标定残差不证明史实位置。点线面改动不动投影/bbox/背景层时回到 `drawing` 复用底图与底纹，否则先重做 base。
- **重启后的底纹续接**：工作流在飞时重启会标失败，保留阶段与原任务 ID，不假装仍在执行。同配置续跑 style 会认领原任务 `params.map_texture_task_id` 指向的排队中/生成中/已完成图片，不重复下单；换图片配置/模型或原图任务已失败时才新建计费任务。显式回退/取消仍按人的决定执行。
- **模型与原件边界**：地图原件、Earth 影像和外部史料图不进入 t2i/image_edit/i2v；图片调用只生成无地理内容的底纹，点线面与文字是模型写的图层。`asset_type:"map"` 才是地图判据；完成时原始底图版本存 `faithful_source`，`image_url` 是派生图。底纹默认 35%（上限 60%）alpha，人要求原图外观不变时跳过 style。`texture_image.task_id` 计 `images` 预算，回退后同运行链按原任务认领不重复计费；`base_image/final_image` 不计 GPU 图数。
- **编辑与回退**：先 GET `revision`，PUT 带 `expected_revision`；409 保留草稿、重新读回，由人决定合并。几何真源是 WGS84 `map_spec`，画布拖动按实际配准反算。回退/取消按人的明确要求执行，不把历史状态冒充新一轮审核通过。
- **读回与验收**：打开 `outputs.base_image/final_image` 核对配准、图例文字/点位与来源；检查 `outputs.layer_doc`、`research.queries` 的失败/无命中及风险提示。`completed` 只代表流程技术完成，史实、许可与发布合规仍需人审核。
- **保存粒度**：顶层 `brief/map_spec/mode` 不传则保留，brief 内字段合并；传 `map_spec` 是**完整替换**（含 places/routes/regions）。先 GET 完整 spec，仅改获准的项并带当前 `expected_revision`；人工确认项只保证不被自动检索合并覆盖。
- **调用量与模式**：brief 1–3 次文本；research/base/drawing 各是多步工具循环（每步一次文本调用，交付≤3 轮，另含 read_image 视觉调用），回退会让目标阶段重跑；style 1 次图片。预算按阶段步数保守预留，紧时显式 `text_config_id` 钉选并用 manual 分段核账。run 入参覆盖保存的 mode，未传默认 manual；advance 永远 manual，只有它支持 skip；PUT mode 只保存选择，不会自行启动。

### S3 Poster（可选，资产之后；Issue #39/#72）
- 端点：`GET /episodes/{e}/poster`、`PUT /episodes/{e}/poster {prompt?, text_prompt?, copy?, reference_images?, base_image?, layer_doc}`、`POST …/poster/generate {mode:"initial"|"composite"|"layers", config_id?, model?, version_id?, composition_id?}`、`POST …/poster/concept`、`POST …/poster/concept/generate`、`POST …/poster/concept/apply`、`POST …/poster/concept/apply-layer-plan`、`POST …/poster/versions {layer_doc?, prompt?, text_prompt?}`、`PUT …/poster/select {version_id}`、`POST …/poster/load-version {version_id}`。
- 用途：片头海报；**不进主闸门**，不能阻塞资产→分镜。
- **编辑工程 = `layer_doc`（与分镜图层同源）；#72 起旧 `layout` 字段不再读写，浏览器画布合成也已取消。**精确文字排版的正确做法：`PUT …/poster {layer_doc}` 保存图层 → `POST …/poster/versions`，**服务端**从当前 LayerDoc 渲染合成图（版本记 `provider:"local"`、`model:"layer-doc"`）并自动设为最终版本 → 需要换版时 `PUT …/poster/select`，想回到某版继续编辑用 `POST …/poster/load-version`。不要再本地渲染 PNG 后 `POST /upload/image` 登记版本。
- `generate` 三种 mode：`initial` = 出不带字的底图（注入项目风格词，AI 构想方案可直接带 `composition_id`）；`composite` = 对已登记的合成版本再生成；`layers` = 底图＋服务端渲染的文字层双参考图再生成（FLUX 配置不支持，会 400）。AI 构想只写 `concept`，套用必须显式调 `concept/apply`（手动字段冲突返回 409 `manual_edit_conflict`，覆盖要人决定并显式 `overwrite`）。
- 陷阱：把真实照片/地图送扩散重绘会得到伪文字/几何漂移；优先确定性底图 + 图层文字。`POST …/poster/versions` 没有底图（`layer_doc.base.path` 空）会 400。
- **模板文本框（Issue #96，`[S]`）**：Poster 文字只用 `layer_doc` 的 `{type:"text", role, fields, field_vars?}` + 文档级 `text_layout`（Poster 专用类型 `poster_project / poster_title / poster_details`，位置与样式由套决定，不写坐标/字号/颜色）。AI 构想的 `layer_plan` 是 `{text_layout, items:[{role, fields}]}`，`apply-layer-plan` 只替换 `ai:` 层；旧形状构想套用返回 400 `layer_plan_legacy`（重新生成构想）。文字超容量/缺字段/同区冲突时 `POST …/poster/versions` 返回 400 `text_layer_invalid` + `problems[]`：按 `problems[].message` 改短或换套，不要换回自由 label。容量读 `GET /layer-docs/text-spec` 规范或编辑器提示，不硬编码。**案例背景**：drama 15 / Poster 20 卡片文字溢出卡片两侧、主标题贴边，用户要求「类型 × 成套位置 × 容量」的专业模板（设计定稿见仓库 `docs/design/layer-text-96/`）。

### S4 分镜拆分
- 端点：`POST /agent/storyboard_breaker/chat {drama_id, episode_id, config_id, model, message}`；`GET /episodes/{e}/storyboards`；`POST .../storyboards/fill-gaps`。
- 用途：按叙事节拍拆镜，产出描述、资产关联、关键帧/视频初稿。
- 组合场景：旁白模式必须逐段使用原旁白原文（覆盖率 100%）；拆镜阶段不启动任何生成。**镜数不等于段落数**：单镜旁白上限 80 个朗读字，长段落必须拆成多镜；服务端硬上限 `storyboardCountCap` = max(短稿防过拆上限 `min(⌈段落数×1.5⌉, 段落数+3)`，各段按 80 字切分所需镜数之和)。只在段落都短于 80 字时镜数才可能恰好等于段落数。
- 陷阱：完整重拆会覆盖；**先获人授权并保存快照**，不能自行重拆；不能用重拆修一条视频 Prompt；部分失败用 `fill-gaps`。

### S4.5 纪录片旁白骨架（Issue #81，`[R]`：drama 10 / episode 16，骨架 task 1227、TTS batch 1228）

纪录片在拆镜与设计卡之间有一步「旁白骨架」：把已确认的旁白稿**有序、连续、逐字**地分配到各镜 `storyboards.narration_text`，并写镜头标题与衔接；没有独立的表，骨架修订号 `revision` 是脚本 + 分镜行的指纹。

**案例背景**：E01 的骨架页只有「并入上一镜 / 在光标处拆分」，缺口只能靠反复保存试错，报错把同一处缺口按镜重复累计（1→12→93 字），而且配音页没有试听入口，人无法判断某镜的音频是否就是当前旁白。#81 因此加了 dry-run 校验、缺口处置按钮与骨架内试听。

- 端点：`GET /episodes/{e}/narration-skeleton`、`PUT /episodes/{e}/narration-skeleton {revision, shots:[{id?, narration_text, title?}]}`、`POST /episodes/{e}/narration-skeleton/confirm|unconfirm`。
- **dry-run 校验（新）**：同一个 `PUT` 加 `validate_only:true` → `{problems, gaps:[{start,end,chars,text,next_index}], excerpts}`，**不写库**。`revision` 仍要带且仍会冲突报错（人在别处改过 → 先重读）。坐标是**去空白与 `【】` 节拍标记后**的剧本下标，左闭右开；`next_index` 是该缺口应并入的下一镜序号（`shots.length` 表示结尾处缺口）。任何一镜的旁白在剧本里定位不到时，`gaps` 返回空数组（无法给出可信坐标），只看 `problems`。
- **缺口处置**：把缺口补到上一镜末尾 / 下一镜开头 / 新建一镜领走；属于出处或版权信息的缺口**不要并进旁白**，回 S1-80 的旁白稿处理。单镜上限 80 字，超长缺口先建新镜再拆分。
- **骨架内试听（新）**：`tts` 新增 `audio_url` 与 `audio_version`。`valid:true` 才可播放；`valid:false` 表示音频与当前旁白不一致（已过期），**不得**拿旧音频当本镜配音证据，必须重新生成。播放地址按 `audio_version` 加版本参数防缓存。
- **保存语义**：`shots` 不带 `id` = 新建一镜；原有镜不出现在列表 = 合并/删除；保存会改变 `revision`，**原有确认随之失效**，必须重新确认。正文改字会被逐字校验拒绝——要改字去旁白稿，不在骨架里改。
- 正例：编辑草稿 → `validate_only:true` 看 `problems/gaps/excerpts` → 处置缺口 → 再 dry-run 直到干净 → 正式 `PUT` → 人确认 → 配音 → 逐镜试听（只听 `valid:true`）。
- 反例：① 直接正式保存去试错；② 把许可/链接缺口并进某镜旁白凑覆盖率；③ 播放 `valid:false` 的旧音频并报告「配音已完成」；④ 用骨架编辑代替旁白稿改写。

### S5 设计卡与段组合（含 Issue #82 变更，`[R]`：drama 10 / episode 16，6 镜 AI 首次写入 combo）
- 端点：`GET /episodes/{e}/design-card-context`、`GET /episodes/{e}/design-cards/audit`、`POST /episodes/{e}/design-cards/fill`、`GET /episodes/{e}/design-cards/status`、`PUT /storyboards/{id}/design-card {combo, design_card}`、`POST /storyboards/{id}/design-card/confirm {acknowledge}`。
- 用途：把“这一镜怎么拍”写成导演分镜单；`combo` 决定是否用图层段/生成段及顺序。
- **案例背景（#82）**：E01 实测 20 张已填卡里 12 张 `combo` 为空，批量确认全被 `combo_missing` 挡住；卡头显示「实测 0.0s」（audit 的 `tts` 没有 `duration_ms`，前端把 `undefined` 当 0）；310 个 `unresolved_ref` 只显示通用文案，看不出是哪张资产、缺哪个语义条目。用户的决定：AI 直接把 combo 选出来、把时长关系讲清楚、把错误写成人能照着修的话，并且**绝不虚构语义名**。
- **AI 填 combo（变更）**：`design_card` 工具 schema 新增 `combo`，`suggested_combo` 变为可选仅供展示。`POST /episodes/{e}/design-cards/fill` 批次里：该镜**已有 combo** → 保留，不被覆盖；**没有 combo** → 采用模型所选；模型给出非法/缺失 combo → 该镜计入 `failed`，状态置 `pending` 并把原因写进 `design_card_stale_reason`。纪录片「有卡但没 combo」的镜会进入 **combo-only 补选**：只补 combo，**不重写卡片内容**。写入成功后卡片一律回到 `pending`，确认仍由人按。
- **现有资产可实现性（#87，`[S/R]`）**：先读实际资产/版本图像、属性、真实语义及所需几何。不许资产名冒充语义、跨资产/不相容版本借同名条目，或把必要定位/描线/区域层留空锚点、备注“待人工补”后算成功。无语义图片可作其实际支持的背景；无位置依赖的标题/说明卡可无锚定，但不能丢信息点、把必要视觉任务退成纯旁白或把普通河网冒充特定历史路线。无法满足必要任务时失败、保留旧卡、不计成功；人工路径不放宽 AI 校验。本轮真实读图 19 次、成功五卡；各种非法依赖的拒绝分支有行为自测，不冒称都在生产触发。
- **audit 新字段**：`tts.duration_ms`（缺失就显示「待配音」，**不要写 0.0s**）、`unresolved_layers[{index,type,text,asset_id,asset_name,asset_exists,semantic_id,semantic_name,available_semantics[]}]`、`video_generated`。报问题时引用 `issue.message` 与 `unresolved_layers` 的具体资产/语义名，不要只报 `code`。
- 组合场景：AI 填卡（含 combo）→ 人逐镜审阅并按需改 → 人确认（0 block；有 warn 需 acknowledge）。
- 陷阱：预算 `layer_s≤30`、`gen_s≤15` 超限直接拒存；已确认且有产物时改 combo 会被拒，必须走 `POST /storyboards/{id}/combo`（先看 `combo/impact`）；批次只对「无 combo」的镜写 combo，不要指望它纠正人已选的组合；确认失败时读返回体 `issues[].message`，它已包含具体原因。
- **为何改（#87）**：《历史纵横》E01 的第 01 镜五个计划图层都引用资产 #103 的同名“语义”，实际语义清单为空。旧指令允许“保留规划、空锚点待标注”，使 AI 明知缺信息仍能把设计当成完成；Fabel 判定必须同时修正 prompt、AI 写工具和成功计数，不是一句“不要幻觉”或一个人工补标注按钮能解决。人工审核时仍可打开资产语义弹窗，按实际绑定重查问题；新增标注不等于旧引用自动修好。
- **人工核对界面（#87，`[S/R]`）**：图像使用 120–180px 流式卡片、contain；底图取候选的 path/version，不拿当前图冒充固定旧版本；引用卡取相应资产当前图。点击开大图，`⌕` 打开现有资产/语义面板。未解析引用按具体层列缺口，可打开语义或改绑真实条目；改绑只改计划层 anchor，不删层、不改资产。新增标注不会自动修好旧引用。本轮已打开真实参考图；固定旧版本及缺失语义修复写入未在生产制造测试数据，仍是源码/行为核验。
- **屏幕文字 = 模板文本框（Issue #96，`[S]`）**：`layer_plan.planned_layers` 里不锚定的文字一律 `{type:"text", role, fields, at_s}`，同时给 `layer_plan.text_layout`（`design-card-context` 的 `text_spec.layouts[].id`）；`text_spec.capacity[layout][role]` 是每个字段的基准容量（引擎现算）。AI 写入拒收 `card`、无锚点 `label`、无套的 text 与引擎阻断（溢出/缺字段/引文无引号/说明句 ≥2 处并列/同拍同区/同拍重复），拒绝消息带容量数字；人工 PUT 只得到读时问题 `text_plan_invalid`（阻断）/`text_plan_warning`。同区后出现的框替换前一个（日期可与主信息同屏），同一 `at_s` 两个同区框 = 冲突。锚定在地图点线上的地名仍是带 `anchor` 的 `label`/`marker`。

#### S5-87 任务公开对话与真实计量（`[R]`：tasks 1281–1285；未触发分支另标 `[S]`）
- **新 API 点**：`GET /tasks/{id}/observations?work_id=&cursor=&limit=` 读取持久工作项与实际调用；`GET /tasks/{id}/observations/calls/{callId}/messages?cursor=&limit=` 分页回看某次调用的完整公开消息。游标及字段见 `references/api-catalog.md`，不要拿第一页冒充全历史。
- **采集失败的处置（`[S]`，有故障注入自测）**：出现「公开调用记录持久化失败」时，卡片/骨架/音频可能已保存。先读回状态与产物再决定是否重提；如实报采集缺口，不回滚业务、不自动补跑。
- 开跑前用 `POST /episodes/{e}/work-estimate {stage:"skeleton"|"voice"|"design_card", storyboard_ids?, settings?, model?/config_id?}`，把本次模型选择或当前配音参数放请求体；显式空选 `storyboard_ids:[]` 不得变成整集。这个 POST 只读预估、不计费；它**不是范围预览**（不返回逐镜 `status/checked/reason`），不能替代 §铁律 4 列出的任何 preview，也不能与计费稿件检查混淆。无同口径样本时 `estimate_ms=null`，显示「暂无估计」，不编固定秒数。
- **对话是什么**：实际发送的 system/user/assistant/tool 等公开消息、注入的 Prompt/SKILL 与工具定义、模型公开正文、工具参数与返回（含失败）；read_image 子调用须可归属同一任务。图片/二进制用明确占位或安全引用，凭据脱敏，不索取隐藏思维，不用最终一句“完成”或活动计数替代正文。
- **三阶段怎么计量**：骨架按整稿、设计卡按镜、TTS 按合成请求统计；源字数、实际请求/输出字数、排队、实际服务调用耗时、任务墙钟和音频长度分别看。配音没有 LLM normalize，不给它虚构 LLM 对话；音频长度也不是合成推理耗时。
- **如何理解 ETA**：使用同阶段、实际配置/模型及相关参数的成功样本，优先本批再看历史；当前项已用从该项同口径预计总耗时扣除。无样本/未知队列显示未知，超过估计显示超出预估，不把剩余零秒当作已完成；并发调用耗时相加不等于墙钟完成时间。
- **恢复纪律**：刷新后从服务端重新读取同一持久事实；后端重启后保留已存正文、样本及完成项，在飞调用准确标中断并冻结到最后已持久确认时刻。沿现有任务恢复/重试政策，不假装在飞请求继续，不用失败或中断样本训练成功 ETA。
- **覆盖边界**：本轮先落实分镜设计链路；全局其他 harness 由 #88 逐项盘点补齐。接口/规则存在，不等于全部旧调用已经覆盖。
- 调用列表默认只返回轻量元数据；展开某次调用后按游标读取消息全文。任务弹窗 URL 的 `owork` / `ocalls` 可恢复所选工作项、展开调用与已加载消息位置，但只读恢复不得触发模型、重试或业务保存。


### S6 图层段
- 端点：`GET /layer-segments/storyboards/{id}`、`POST .../draft`、`PUT .../{id} {layer_doc,timeline,duration,base_ref}`、`POST .../render`、`GET .../thumbnail/{first|last|frame-N}`、`GET .../junction`、`GET /layer-docs/fonts`。
- 用途：确定性渲染“精确信息”（文字、年代、地点、箭头、流程图、真实照片/地图的 contain 摆放、时间轴显隐）。
- 组合场景：
  - A：整个镜头=图层段（适合原理示意、流程、地图定位）。
  - C：前段图层（如 4s 定位/标注）→ 末精确帧去文字 → 作为生成段首帧。
  - D：生成段 → 首精确帧作为生成段尾帧 → 图层收束。
- 陷阱：设计卡未确认不能写/渲；无合格底图 → 400 `missing_base`；重渲改变 junction hash 会让关键帧确认失效；`timeline.fps` 不是可选项——保存时一律被改写为本集目标帧率，自己传的值会被忽略，混帧率会导致 stale。
- **输出规格（Issue #69）**：画幅取本集已有**模型视频**实测值；本集还没有视频时按画幅比例用内置默认（16:9 = 960×544、9:16 = 544×960、1:1 = 768×768）。源图可为 1920×1088 或 1024×1024，按 contain/裁切记录在 `base.source_width/source_height`。**目标帧率 = 本集最靠前的有效既存图层计划的 `timeline.fps`**；没有计划才回退到实测视频帧率（保留三位小数，29.97 不取整为 30），再没有才用默认 25。合法范围 1–60，所以 24 / 25 / 29.97 等都成立：**不要再假设全项目恒为 25fps**。最终 compose/merge 沿用同一画幅与同一目标帧率，模型 raw 的不同帧率由 `fps` 滤镜统一，不需要改图层去迎合 raw。
- **底图永不拉伸 + 视觉验证（Issue #94，`[S]`）**：
  - 案例背景：drama 15 / ep 21（9:16）22 段图层的底图是 1920×1088 横版场景，旧渲染 `fit:'fill'` 把它横向压扁约 3.1× 写进衔接帧，C 组合视频从变形画面开始；生产库 42 段里 41 段比例不符（含 16:9 项目里 1024² 道具被横向拉宽）。用户裁决：任何情况下不拉伸。
  - 取景框 `baseFrameOf(base, spec)`：边界 = `base.crop`（缺省整图），像素比例与成片相差 ≤1% → `cover`；否则 `contain`：取景框沿短边扩到成片比例（归一化到整张原图，可超出 [0,1]），底图等比完整居中，留白用同图放大模糊垫底。viewport 一律归一到成片比例并夹在取景框内；`contain` 时文字/线宽尺寸单位 = 取景框像素高（「size = 成片画布高度比例」照旧成立），图层坐标允许 [-3,4] 以便把字放进留白带。裁切框按**成片比例**（不再写死 16:9）。渲染前断言取景比例，违反直接报「取景比例与成片不符，拒绝拉伸」。
  - 升级影响：`contain` 段的渲染签名含取景框，发布前比例不符的段读时变为过期，需要重渲（drama 6/8/10 的 19 段、drama 15 ep 21 的 22 段）。
  - 视觉验证：底图有裁切或为 `contain` 时必须验证。渲染成功后自动起文本任务 `kind='layer_base_check'`（阶段 `layer_base_check`，用 `vision=1` 配置；任务中心可回看对话），输入原图 + 无字取景画面（C/D 另附衔接帧），判主体完整、取景位置、变形、留白；结果写 `storyboard_layer_segments.base_check`（`pending|passed|failed|error|overridden`，签名 = 底图 sha + crop + 取景框 + 成片尺寸 + 衔接帧 hash，改文字不重验）。`GET /layer-segments/storyboards/{id}` 返回 `base_check`、`base_check_required`、`base_check_satisfied`。`POST /layer-segments/storyboards/{id}/base-check` 重验；`POST …/base-check/override {reason}` 人工放行（**人决定端点**，必须先开图并有人的授权原话，理由必填）。
  - 闸门：验证未满足时衔接帧不可用（关键帧不就绪）、视频批次预览该镜 `blocked`（原因「图层底图待视觉验证」/「图层底图视觉验证未通过：…」，A 组合同样阻断）、单镜生成视频与合成拒绝。不影响图层段新鲜度（批量渲染不会因此反复重渲）。
  - 推荐顺序：竖版项目先让场景按竖版出图；道具/角色被选作底图且比例不符 → `aspect-version`；忠实素材/地图 → 裁切到成片比例或留白 + 视觉验证。
- **模板文本框（Issue #96，`[S]`）**：图层段的 text 层是**画面坐标**（不随 Ken Burns 推拉）、不可拖动；`text_layout` 必须与成片画幅同家族（否则 `text_layout_aspect_mismatch`）。`POST …/render` 遇文本阻断问题直接失败（原因 = 引擎消息），段问题码 `text_layer_invalid`/`text_layer_warning`；C/D 衔接帧不含 text 层。验收时打开渲染帧确认：同屏框不重叠、竖版文字不进底部 35% 与右侧按钮栏、横版不进底部字幕区。

### S7 关键帧
- 端点（全路径）：`GET /episodes/{e}/keyframe-prompts/scope`、`POST /episodes/{e}/generate-keyframe-prompts`、`GET /episodes/{e}/keyframe-prompts-status`、`POST /episodes/{e}/keyframe-batch/preview`、`POST /episodes/{e}/keyframe-batch {items}`、`GET /episodes/{e}/keyframe-batch`、`POST /storyboards/{id}/keyframes/{slot}/generate`、`GET /storyboards/{id}/keyframes/{slot}/versions`、`PUT /storyboards/{id}/keyframes/{slot} {image|inherit}`、`POST /storyboards/{id}/confirm-keyframes`。
- 用途：先写提示词，再出首/中/尾图；人工确认后视频才可提交。
- **旁白开启时不要按 S7→S8 的顺序硬走**：先配音拿到实测时长，再定 `mid_frame_time`、生成/校准视频 Prompt，最后出关键帧图并确认；否则中间帧时间与尾段时长会对不上（见 S8 首条）。
- 组合场景：preview 逐槽看 `missing/changed/unchanged/blocked/skipped` → 勾选 → 入批 → 轮询 → 开图 → 确认。
- 陷阱：
  - A 组合没有生成段：预览 `skipped/excluded`，不要硬出图。
  - C-first / D-last 是锁定槽：`slot_locked`，由图层衔接帧继承，不能单独生成。
  - 承接镜没有自有首帧提示词时 `skipped`，不要补图。
  - `changed` 是签名与所有历史都不同；`unchanged` 命中历史，默认不勾。
  - 选版/重渲会自动取消确认。
- **案例背景（#92，drama 14 / episode 20，9:16 竖屏短剧 22 镜）**：① `keyframe-prompt` 技能把「16:9 横构图电影感剧照」写死在结尾语里，而 `read_storyboard_context` 不返回项目画幅，模型只能照抄，于是 9:16 项目的 64 条关键帧提示词全写着 16:9（出图尺寸本身按画幅查表，是**文字与尺寸矛盾**）。② 第 19 镜「两名随从」只写了身份泛称、没有任何服色与身份标识，参考图里只有 @刘邦、@子婴，模型把 @刘邦 的造型套给了随从，成片像有多个刘邦。
- **画幅由上下文决定（#92）**：`read_storyboard_context` 返回 `aspect_ratio`（如 `9:16`）与 `composition`（`横构图`/`竖构图`/`方构图`），技能结尾语写成 `{aspect_ratio} {composition}电影感剧照`。`save_storyboards` / `update_storyboard` 保存关键帧提示词时校验画幅白名单（16:9、9:16、4:3、3:4、1:1、21:9）与方向短语，与项目不符**逐镜退回让模型改正**，不静默重写；`save_storyboards` 在 `replace_existing` 清空之前就判完，整批不落地。人工 `PUT /storyboards/{id}` 与转场提示词不校验。单独的 `portrait`（肖像）与「10:30」这类时刻不算画幅词。
- **无名人物（#92）**：画面出现没有资产的人物（随从/士兵/属吏/百姓等）时，提示词必须写明人数、站位、身份，并给出与同画面每个 `@角色` 都不同的可见标识（服色、服制、冠帽、持物），多镜复现沿用同一套标识；有资产的 `@角色` 仍一个外观字都不写，也不为无名人物建资产。规则已落进 `keyframe-prompt`、`video-prompt`、`video-prompt-narration`、`storyboard-breaker` 四个技能的 zh/en/ja/ko。
- 旧提示词不会自动改：需要的镜头经 `POST /episodes/{e}/generate-keyframe-prompts {storyboard_ids}` 重出；只重出提示词而不重出图，会让该镜提示词与已确认图片不一致，是已知副作用。

### S8 旁白、配音、字幕、音画适配
- **旁白模式的两条不变量（硬）**：①关键帧出图/确认必须在实测配音时长之后；②视频提交必须在关键帧确认之后。
- 纪录片的执行顺序是硬的（#70，见铁律 17）：旁白骨架确认 → 配音（实测时长）→ 设计卡 → 制作。其余环节的默认顺序（软，可记录理由后调整）：字幕 → `narration-fit` → 视频 Prompt 按时长对齐 → `mid_frame_time` 落定 → 关键帧出图与确认 → 视频。关键帧**提示词文本**可在设计卡确认后提前写，但出图/确认仍受两条不变量与铁律 17 约束；纪录片不得在配音与设计卡确认之前启动任何制作阶段调用。
- 端点（全路径）：`GET /episodes/{e}/tts-options`、`POST /episodes/{e}/narration/voice-batch/preview`、`POST /episodes/{e}/narration/voice-batch`、`GET /episodes/{e}/narration/voice-batch-status`、`POST /episodes/{e}/narration/voice-batch/retry-failed`、`POST /storyboards/{id}/narration/voice`、`POST /storyboards/{id}/narration/write`、`POST /episodes/{e}/generate-narration`、`GET /episodes/{e}/narration-coverage`、`POST /storyboards/{id}/narration/subtitle`、`GET/PUT/DELETE /storyboards/{id}/narration-fit`。
- 用途：写旁白 → 配音 → 实测时长 → 字幕 → fit → 视频 Prompt 时长对齐。
- 组合场景：批量先 preview 分类 `missing/changed`，只配这两类；镜级 fit 用 `mode:"pad"|"tempo"` + `pad_ms`（毫秒，0–3000）+ `pad_position` + `audio_mix_mode:"replace"|"mix"`。
- 陷阱：
  - 顺序错：先锁视频时长再配音 → 后期 fit 挤压/留白，视频 Prompt 尾段时间与实测配音不符。
  - `PUT narration-fit` 是**整条新 record**，不与旧 override 合并；要回继承用 DELETE。
  - 长度阻断 400 要读 `block_reason/gap_ratio/current_sec/avail_sec/suggested_chars`，不能截旁白凑时长。
  - 发音标记（拼音/同音字/停顿/语气）写错是阻断；拼音注音会关闭整段 normalize。

### S9 视频
- 端点（全路径）：`POST /episodes/{e}/generate-video-prompts`、`GET /episodes/{e}/video-prompts-status`、`POST /episodes/{e}/video-batch/preview`、`POST /episodes/{e}/video-batch`、`GET /episodes/{e}/video-batch`、`POST /episodes/{e}/video-batch/cancel`、`POST /episodes/{e}/video-batch/retry-failed`、`POST /storyboards/{id}/generate-video`、`GET /video-queue/estimate`。
- 用途：把分镜写成时间段动作/运镜，按签名判断是否需要重出，批量生成。
- 组合场景：preview（`missing/changed/unchanged/unknown/blocked/skipped/excluded`）→ 勾选 → 启动 → 轮询 → 下载并检查首/中/尾与衔接。
- 陷阱：
  - A 组合 `excluded:no_generated_segment`。
  - 关键帧未确认 / `video_prompt` 有阻断 → 400。
  - 模型不支持关键帧引导时直接报错，不要降级偷偷去掉引导。
  - 视频签名覆盖提示词、引导帧文件名+中间帧时间、参考图顺序、时长/画幅/分辨率、provider/model；改任一项都会 `changed`。
  - 停止批量的语义是“不再提交新镜头”，在跑的那一镜会跑完。
  - **锁定衔接帧（Issue #95）**：C 的首帧 = 图层段末帧、D 的尾帧 = 图层段首帧，这两张不单独出图（`keyframe-batch/preview` 里 C-first / D-last 是 `skipped`）。`read_storyboard_context` 逐镜返回 `locked_frames[{slot:"first"|"last", source:"layer_last"|"layer_first", base, framing:"full"|"crop"|"contain"|"zoomed", caption, caption_note?}]`：`caption` 是视觉模型对**实际衔接帧 PNG** 的描述（`AI_STAGES.junction_caption` vision，按 `junction_hash` 缓存于 `storyboard_layer_segments.junction_caption`），衔接帧未渲染 / 输入已变化 / 底图验证未过 / 无视觉配置时为 `null` 并带原因，绝不编画面。`generate-video-prompts` 在 Agent 开跑前逐镜补算描述（同一任务的观测 stage `junction_caption`）并把锁定槽位 + caption 写进话术。视频提示词保存时解析时间分段行（`0-3秒：`、`0-2.5秒:`、`0-3s:` 等）：C 的首段必须是 **0–1.5 秒的空镜**——超过 1.5 秒、@ 到本集角色资产、出现场景过渡写法（过渡为 / 过渡到 / 转入 / 化为 / 变为 / 叠化、dissolve / transition to / morph into、ディゾルブ / 移り変わ、디졸브 / 바뀌어）或切镜写法（切到 / 切回 / 切换为 / 切换到 / 转到 / 硬切、cut to / cuts to、カット / 切り替え、컷 / 전환）都退回，D 的末段切镜也退回，任一分段是 0 长 / 倒序（`3-3秒`、`5-3秒`）一律退回；退回信息带 caption，人物入画与转场要挪到第二段。收紧依据是 ep 21 二次验收：首段已无切镜写法，但 7/22 镜仍在首段（0–3 秒）写「@子婴 走向画外」「长卷过渡为山脊」，H3 把第二段内容画到第 0 帧、衔接帧被整段替换。A/B 组合不校验。人工 `PUT /storyboards/{id}` 不校验（与 #92 的画幅校验同口径）。

### S10 合成
- 端点：`POST /storyboards/{id}/compose`、`POST /episodes/{e}/compose-batch/preview`、`POST .../compose-batch {storyboard_ids}`、`GET .../compose-batch-status`、`POST .../retry-failed`。
- 用途：把视频 + 旁白音轨 + 烧录字幕变成可导出的融合片，写输入快照签名。**带显式段组合的纪录片镜头写 v4**（#60：段组合、图层段、生成版本、衔接帧都进签名）；**无 combo 的剧情镜仍写 v2**（#42：video/audio/subtitle/burned/text/fit/T），这是刻意保持的逐字兼容，不是遗留 bug。签名版本 <2 的历史记录一律判 `unknown`，需重做。
- 组合场景：preview 读 `status/exportable/plan/signature` → 启动显式 IDs → 轮询 → 逐镜读回 `compose_state`。
- 陷阱：只有 `unchanged` + `exportable:true` 才可导出；`missing/changed/unknown` 要重做；`blocked/skipped` 先按 reason 修。200 与“导出成功”不是一回事。
- **烧录字幕行宽随输出画面（#91）**：合成时按实际输出尺寸重排每条字幕（单字宽 ≈ 0.0425×输出高，扣 libass 默认左右边距；544×960 = 12 字/行，横屏与方形封顶 20 字/行），一条最多 4 行，窄画面遵守避头点（下一行不以标点开头）；字号/字体不变，配音阶段写的 SRT 不变。只有「烧录 且 行宽 ≠ 20」时行宽才进合成签名，所以横屏既有成片逐字节不变、仍为 `unchanged`；竖屏在 #91 发布前合成的镜头会显示 `changed`（原因「字幕排版已变化（每行 20 字 → 每行 12 字）」），重合成即可，不占 GPU。案例背景：drama 14 / episode 20（9:16）merge 29 的字幕在 544 宽画面左右被裁。
- **视频预览返回整集**：`POST /episodes/{e}/video-batch/preview {storyboard_ids:[544]}` 实测返回了整集 22 镜的逐镜结果（其中别的镜也可能是 `changed`+`checked`）；启动 `video-batch` 前必须再按自己要做的 ID 过滤，不能把预览里所有 `checked` 原样提交（#91/#92 生产验收时因此误重出一条视频，已改选回原版）。

### S11 导出
- 端点（**注意 router 前缀 `/merge`**）：`GET /merge/episodes/{e}/merge`、`POST /merge/episodes/{e}/merge {storyboard_ids, poster_version_id?, poster_duration?}`、`GET /merge/episodes/{e}/merges`、`DELETE /merge/episodes/{e}/merges/{mergeId}`。
- 用途：按所选镜头顺序拼成最终片，可加 Poster 片头。
- 组合场景：显式 `storyboard_ids`（省略=整集，导出时必须显式）；`poster_duration` 钳 0.5–10 秒。
- 陷阱：写成 `/episodes/{e}/merge`（漏 `/merge` 前缀）会得到 **200 + HTML（SPA）**，不是 404——必须校验 `Content-Type`（八达岭实测踩中，见 §4.6）。任一镜未 `exportable` 且开启旁白 → 整体 400 并给 `blocked[]`，不能静默回退原片/少镜；merge record 的 `duration` 是整数显示，精确时长要用 ffprobe（无 ffprobe 时如实写明依据，如浏览器媒体元数据）。

### S12 任务与返工（贯穿）
- 端点：`GET /tasks/active`、`GET /tasks/center`、`GET /tasks/{id}`、`POST /tasks/{id}/retry`、`POST /tasks/{id}/cancel`。
- 用途：唯一进度源；重试只改模型/配置并新建任务；取消能力有限。
- 陷阱：`retry` 的剧本/拆镜会覆盖本集内容，必须授权；不能为停止文本任务重启服务。

---

## 3. 诊断片实测案例（2026-11-05，历史记录）

完整步骤、参数、成本与失败证据见 [`references/diagnostic-example.md`](references/diagnostic-example.md)（分离只为满足 64,000 bytes 上限，内容未删减），**抄作业或做全流程规划前必读**。摘要 `[R]`（drama 8 / ep 14，5 镜）：`54.76s / 960×544 / 25fps / 1369 帧`，Poster 10，merge 26；9 图 / 2 视频 / 5 TTS；C186 首帧 vs junction SSIM **0.248407** 视觉 FAIL，B187 形变，gate mh6 FAIL，均原样保留。该轮的 Poster 本地画布、「镜数=段落数」、固定 25fps、「设计卡在配音之前」已分别被 #72 / #57+#70 / #69 取代——现行按 §2 与铁律 17。
---

## 4. 正例/反例与设计原则

### 4.1 图层与扩散的分工（最重要的一条）

| 用途 | 正确工具 | 原因 |
|---|---|---|
| 精确信息：文字、年代、地名、数字、箭头、流程、时间轴显隐、测量值 | **图层段**（确定性渲染） | 像素级可控、可复查、不会虚构 |
| 真实照片/地图/文物的**摆放**与标注 | **确定性底图 + 图层**（contain，不重绘） | 保持原始几何与文字；扩散会改海岸线/铭文/比例 |
| 氛围、光影、材质、表演、镜头运动、艺术再现 | **扩散模型**（关键帧→视频） | 表现力强，适合“看起来对”，不适合“逐项保真” |
| 既要美观又要准确 | **扩散生成美化底图 → 图层在其上精确绘制** | 美观来自扩散，准确来自图层 |

- **反例 1**：用图层段替代整镜叙事（尤其人物/动作镜头）→ 成片像“配了旁白的 PPT”，关键帧与视频模型被跳过，表现力丢失。
- **反例 2**：把真实照片/地图/文物送 t2i/image_edit/i2v 重绘 → 几何漂移、伪文字、年代错误。忠实素材**一律不重绘、不风格化**；需要更好看的版本时，另建 `faithful:false` 的艺术再现资产，原件保留并分别审核。
- **反例 3**：用扩散模型做精确复原（考古结构、铭文、器物辐数、测量值）→ 模型会“编造细节”；这类信息只能由图层或文字表达，且不得声称精确复原。
- **反例 4**：图层文字/卡片层进入 C 的末帧或 D 的首帧 → 生成段首/尾帧带字，模型会把字烧进画面；junction 必须去文字。

### 4.2 正向模式（应这样做）

| 场景 | 正确做法 |
|---|---|
| 第一页导入原始内容 | 只写 `content`，读回后给 `step=0` 链接；用户要求先等候就到此停止 |
| 用户已授权 AI 改写 | 纪录片走 `POST /episodes/{e}/script-rewrite` 流水线（旧 `/agent/script_rewriter/chat` 对纪录片 400），剧情项目走 `POST /agent/script_rewriter/chat`；都读回火宝保存的结果，不是助手代写回填 |
| 每阶段开工 | 先核本次授权；获准操作后再读 `GET /episodes/{e}/gates` / 预览 / `tasks/active`，不猜、不抢跑 |
| 批量生成 | 有 preview 的入口一律先 preview，读 `checked/status/reason`，人确认后传显式 IDs；没有 preview 的入口（`design-cards/fill` 等）照其前置检查执行，`work-estimate` 不算预览 |
| 写入 | 先快照 → 最小字段 PUT → 重新 GET 对照 → 报告 before/after |
| 审批 | 必须开图并附 `opened:[{path,sha256}]`；程序 FAIL 保留，`override_gate` 只写技术例外范围 |
| 返工 | 定位错在哪一层（剧本/资产/绑定/关键帧/时长/模型），从对应入口修；通用规则缺陷交维护任务 |
| 恢复 | 用批次状态/`fill-gaps`/`retry-failed` 补剩余，不从头重跑；已有活跃任务只观察 |
| 证据 | 每次调用写 `requests.jsonl`；媒体“已打开”与“未核”分开记录 |
| 验收 | 技术验收与艺术批准分开写；`exportable` 只代表签名就绪 |
| 成本 | 任何新 GPU **或计费文本 LLM** 请求前确认预算台账；额度用尽时停下来问人 |

### 4.3 反例模式（Agent 常犯的错误想法）

完整的 21 条错误想法 → 为什么错 → 正确做法对照表移至 [`references/anti-patterns.md`](references/anti-patterns.md)（分离只为满足 managed skill 64,000 bytes 上限，条目未删减）。**开工前必须读该表**；它与铁律框等效，不是可选读物。

最常踩的五条：① 把 `content` 与 `script_content` 一次填完冒充火宝改写；② 把 HTTP 200 / `completed` / `exportable` 当内容通过；③ AI 填卡替人确认或改写既有 combo；④ 先定视频时长再配音；⑤ 没开图就 `approve` 或 `override_gate`。

### 4.4 每阶段最小核对清单

- **第一步原始内容**：来源与 `content` 对应；未夹带 `script_content` 或改写调用；到达用户指定停止点即结束。
- **第二步 AI 改写**：已获该步授权；存在真实火宝改写调用与保存结果（纪录片 `POST /episodes/{e}/script-rewrite`，剧情 `POST /agent/script_rewriter/chat`）；不是助手代写回填；再审原文 vs 改写差异与事实归属。保存前跑过 `POST /episodes/{e}/script-rewrite/inspect-narration` 并把 `findings` 原样呈报（502 记为「检测失败」）；改写报告的 `ai_exclusions` 逐条可定位。稿件确认和后续旁白覆盖率另按阶段检查。
- **旁白骨架**：正式保存前 `validate_only:true` 干净（`problems` 空、`gaps` 空）；缺口按「并入上/下镜或新建镜」处置，非旁白内容回旁白稿；保存后重新确认；试听只用 `tts.valid=true` 的音频。
- **资产**：本集关联是否正确；名字无空格；`faithful` 未进扩散；审核清单 0 missing；程序 gate 与人工例外分开记录。
- **Poster**：编辑工程用 `layer_doc`（无 `layout`、无本地画布上传）；版本由 `POST …/poster/versions` 服务端渲染并已 `select`；文字未裁切、底图来源正确、未调用不必要生图。
- **设计卡**：纪录片已先确认骨架并有有效配音（无配音时服务端直接阻断）；各信息点都有 `via`，必要视觉任务未丢失；预算不超限；每镜都有 combo（AI 首次填入仍待人工审阅）；AI 输出的必要语义/几何依赖真实、归属和版本相容且可执行，不能以「待标注」占位算完成；无锚定层确实不依赖资产内位置；`tts.duration_ms` 缺失显示「待配音」而非 0.0s；底图缩略图看的是**该候选的实际版本**（`version_task_id`），`must_mark`/`reference_assets` 芯片显示的是该资产**当前图**（要核特定版本得去资产弹窗）；未解析引用经「改绑引用」处理而不是靠新增标注；确认状态仍由人决定。
- **图层段**：`base` 尺寸/裁切正确；底图比例与成片一致，否则确认是 contain/裁切且 `base_check_satisfied=true`（衔接帧与中/尾关键帧并排看几何比例）；文字安全边；junction 去文字；`timeline.fps` = 本集目标帧率（服务端派生，与成片一致，不假设 25）；`thumbnail` 实际打开。
- **关键帧**：预览分类正确；锁定槽未出图；版本签名与当前提示词/参考图一致；确认后再提交视频。
- **旁白**：字数 ≤80（按 spokenText）；发音标记合法；配音实测时长；fit 不截断旁白；字幕与音频逐字对齐。
- **视频**：raw 时长/帧率；首帧 vs junction（C）/尾帧 vs junction（D）；引导链；参考图顺序。
- **合成**：`unchanged/exportable` 逐镜；音频与 composed source 相关；字幕烧录边界。
- **导出**：显式 IDs；Poster 时长；完整解码；帧账（Poster 帧数 + 各镜帧数）；真实时长以 ffprobe 为准。

### 4.5 典型错误案例：助手代填「AI 改写」（2026-11-06，《历史纵横》漕运，第1集）

完整经过见 [`references/diagnostic-example.md`](references/diagnostic-example.md) 末节。要点 `[R]`：助手自写 840 字符解说稿直接 `PUT /episodes/15`（含 `content`+`description`+`script_content`），从未调火宝改写——经 API 存进去的自写稿不是「通过火宝改写」。正确做法：原文只进 `content` → 读回交第一步链接 → 获准后才由火宝改写。用户要求「只更新 skill」后，不得再请求火宝、清稿或自行回滚。

### 4.6 生产验收固定案例：八达岭长城测试（本轮用户指定 1009；`AGENTS.md` §9/§10）

固定定义（主题、224 字固定正文与那条故意保留的出处行、命名、链路、新功能覆盖清单、证据清单与纪律）及 2026-11-08 首轮结果 `[R]` 见 [`references/fixed-case-8daling.md`](references/fixed-case-8daling.md)，**跑生产验收前必读并逐条照做**，正文 224 字与授权边界不得改写。要点：隔离 worktree 自 2026-11-08 起不再是验收依据，必须在生产入口/后端/库留痕，只写一次性测试项目，绝不碰既有真实项目（尤其 drama 3）；计费生成先取得同意；DB 只读；失败留证。首轮：drama 10 / ep 16，6 镜，覆盖 241/241，merge 27，960×544 / 65.44s（浏览器元数据，无 ffprobe）；各功能只覆盖报告明列路径。
---

## 5. 失败处理与报告模板

发现失败时，按这个顺序写，不要先下结论：

1. **事实**：哪一镜、哪一秒、哪个文件、哪个 hash/SSIM/帧号。
2. **输入核对**：上传字节、引导帧、参考图顺序、提示词原文、时长/画幅。
3. **图结构核对**：引擎节点/guide frame_idx/conditioning（只读；不直连上游做生产请求）。
4. **因果状态**：能证明什么、不能证明什么（例如“上传与图结构未发现错误；prompt 与图片几何矛盾；唯一因果未证明”）。
5. **可选修复**：改通用规则/重出哪一段/需要多少预算；明确“不保证一次通过”。
6. **保留证据**：失败版本不删、不本地修补、不改签名冒充通过。
7. **区分「业务执行失败」与「证据/观测采集失败」**：助手侧的截图、页面抓取、媒体下载、证据落盘失败，以及服务端「公开调用记录持久化失败」，都属于采集失败。此时业务副作用可能**已经提交**：先保留它、如实报「采集失败」，再用对应的 GET/status/`observations` 读回当前状态，确认缺什么后才讨论是否获准重发；**禁止盲目重跑**可能已落库的请求。照实写「业务结果 X / 证据缺 Y」（见铁律 18、S5-87）。

报告给用户时给：可播放链接、审核深链、真实文件路径、成本账、通过项、失败项、需要他做的决定。

---

## 6. 能力边界（写进技能，防止越权）

允许：在当前阶段授权内调用火宝 HTTP API；文件系统读取与证据保存；本地只读 ffprobe/ffmpeg 检查；网络检索取证；用户逐项明确指示下的人工字段修改/用户定稿导入（按 S1 标明来源，不替代火宝 AI 生成）；经单独明确授权的设置修改（最小写入+读回）。

禁止：助手自行生成剧本再直接回填 `script_content` 冒充火宝 AI 改写；跨过用户指定的第一步/停止点；用户已停止业务操作后仍以验证或撤回为由调用火宝；直接读写 SQLite；写生产 media/数据库/任务状态；SSH/部署/重启服务；直连上游模型/TTS/ComfyUI；默认改供应商/全局配置/Prompt/Skill；修改审核状态冒充人已批准；在未授权项目上写；把本地合成冒充火宝产物。

本节约束普通制作助理。另行授权的工程维护/发布角色按仓库 AGENTS.md 执行；生产验收的数据库证据只能只读采集，业务写入仍必须经产品 API，维护权限不自动授予制作流程。
