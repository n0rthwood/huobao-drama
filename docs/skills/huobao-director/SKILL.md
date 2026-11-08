---
name: huobao-director
description: 通过火宝 HTTP API 按阶段推进剧本、资产、Poster、分镜设计卡、图层段、关键帧、旁白配音字幕、视频、合成与导出；含阶段闸门、参数含义、正/反例与图层-扩散分工，防止跳步、越权、误用。
---

# 火宝制作助理：从目标到成片的 API 工作法

> 契约快照：基于 `origin/master` `9cd3458`（含 Issue #80/#81/#82，release `20261108T055548Z`）与 2026-11-05 殷墟五镜实测；标注 `[R]` 的端点当轮真实跑过，`[S]` 仅源码核对。#80/#81/#82 的新端点与新字段当前均为 `[S]`（源码核对，尚未生产实测），首次使用前按 §4.6「八达岭长城测试 1008」做生产验收。路由/schema 变更后先 GET/预览校验再写。
>
> 历史细表：`references/api-core.md`、`references/api-production.md` 为 2026-11-02 快照，覆盖本目录未列的旧端点细节；与 `references/api-catalog.md` 或本正文冲突时，以新文档为准。错误案例中的 `[R]` 仅表示该错误行为有真实记录，不表示流程正确或已获授权。

### 0. 铁律框（任何模型不得越过；仅汇聚后文，不新增规则）

1. `gates`/`production_unlocked` 为 false 的阶段**不得写入**，无论服务端是否放行。
2. 人决定端点（确认/审批/combo/verdict/override_gate/not_needed/ignored/unconfirm/DELETE）**永不自行调用**；只在人明确决定后执行并记录授权原话。
3. 每次 GPU 提交前查预算台账；余额 ≤0 停下问人；`revise` 轮按 ≥1 图预扣。
4. 批量一律**先 preview**，启动传显式 `storyboard_ids`/`items`。
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

## 1. 综述：火宝要解决什么

火宝不是“一键生成视频”的黑箱，而是一套**分阶段、可回退、人在环**的影视制作框架：

- **人负责内容与审美**：说什么、信什么、不说什么；风格与画面品味；构图、节奏、表演、转场；选哪一版；最终是否通过。
- **火宝提供专业方法与工程能力**：剧本改写、资产提取与去重、专业提示词生成、资产引用装配、批量生成与排队、配音、字幕时间码、音画匹配、确定性图层渲染、合成与拼接。
- **UI 是人的可视化审核面，API 是 Agent 的操作面，Prompt/Skill 是火宝内置各工种的专业知识**。三者必须共用同一份内容与生产逻辑，不允许在本地绕开火宝另造一套结果。
- **Agent 是导演助理**：把导演意图翻译成火宝操作，收集上下文与证据，安排已授权的生产，检查真实产物，组织易审材料，报告问题并推动返工。不是自动批准内容的总导演，也不是绕过业务层的开发者。

判断“做完”的标准不是 HTTP 200、任务 `completed`、图片齐全，而是：**该阶段的专业检查真的做了，真实产物真的打开看过，人真的做了需要他做的决定**。

### 1.1 Agent 的规划算法（每次接任务先跑一遍）

1. **复述目标**：片种（剧情/纪录片）、集数、镜数、时长、预算（图片/视频/配音各几条）、人明确要求的产物。
2. **先核授权再读现状**：明确本次获准的 UI 步骤、可写字段与停止点；仅在授权包含火宝操作时执行 `GET /health` → `GET /tasks/active` → `GET /dramas/{d}` → `GET /episodes/{e}/gates` → 相关阶段列表。若用户已要求停止火宝操作、仅更新技能，不执行这串开工 GET。
3. **判断从哪一步继续**：已有产物不重做；已有活跃任务只观察；缺失的才补。**恢复要“补剩余”，不要从头上重跑。**
4. **拆阶段**：每个阶段先问“这一阶段的闸门是什么、需要人决定什么、我怎么验证”。
5. **每阶段固定节奏**：读事实 → 需要时 preview → 人决定 → 执行 → 轮询终态 → 读回状态 → 打开真实媒体 → 记录证据。
6. **遇到阻断**：读结构化 `reason/blocked/issues`，定位是哪一层（剧本/资产/绑定/关键帧/时长/模型能力），从对应入口修；修不了就报告缺口，不绕路。
7. **记录**：首次提交与终态必须逐条写 `requests.jsonl`；中间轮询可按批次汇总。图片/视频/音频的“实际看过”与“推测”分开写。
8. **软规则偏离**：标注为“默认/软”的流程可偏离，但必须在证据里写一句理由；写不出理由就按默认执行（弱模型无偏离权）。

### 1.2 预算台账（每次 GPU 请求前必做）

- 开工把预算写成硬台账：`{images: n, videos: n, tts: n}`，并列出已消耗的任务 ID。
- 只有真正提交到图像/视频/TTS 模型的请求计数；`compose`/`merge`/图层渲染/Poster 确定性画布不占 AI 额度。
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

Agent 可以做**技术验收**（结构、时长、音画、可解码、签名一致），但必须标注“技术验收”，不得写成“用户艺术批准”。

**硬禁止**：Agent 永不自行调用下列**破坏性或背书性**写入——`script/confirm|unconfirm`、`design-card/confirm|unconfirm`、`confirm-keyframes`、`character-roster` 的批准保存、`asset-pipeline/runs/{id}/approve` 的 `verdict`/`override_gate`、段组合的人工写入 `PUT /storyboards/{id}/design-card {combo}` 与 `POST /storyboards/{id}/combo`、`asset-review/items/{id}` 的 `not_needed`/`ignored`、`DELETE /storyboards/{id}`、`DELETE /tasks/{id}`、`DELETE /episodes/{e}/merges/{id}`。这些只在人已给出明确决定后执行；执行时在 `requests.jsonl` 记录“人授权原话/时间”，否则视为越权。唯一例外是 #82 的纪录片设计卡批次 `POST /episodes/{e}/design-cards/fill`：服务端只给**尚无 combo** 的镜写一次模型所选 combo，卡片仍是 `pending`，确认依旧由人按。
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
2. **第二步「AI 改写」（`?panel=script&step=1`）**：仅在用户已授权该步时，调用 `POST /agent/script_rewriter/chat {drama_id:d, episode_id:e, message:"本次改写要求"}`，可按已有配置附 `config_id` / `model`。由火宝内部工种读取 `content`、生成并保存 `script_content`；助手负责传达要求、检查任务和读回实际结果，不在本地或聊天里代写完整结果再 PUT 回第二步。重新 `GET /dramas/{d}` 核对真正保存的稿件，再交用户审核；没有该次火宝调用与保存结果，不得报告“火宝已改写”。本端点在本次漕运错误案例中未调用，不能冒充该案例的实测成功路径。
3. **人工确认**：执行 AI 改写的授权不等于认可其结果；确认是另一个人的决定。只有用户明确批准当前稿件，才可按授权调用 `POST /episodes/{e}/script/confirm`；不能因计划获批、普通“continue”、文本已保存或任务 completed 代替稿件批准，也不能用这些回应突破用户此前明确的“仅第一步”边界。

- **遇到改写规则不适用时**：若火宝内置技能只允许整理、限制内容量等，与用户的压缩改写目标冲突，说明具体冲突并等待用户决定；不自行改全局 Prompt/Skill，不绕过火宝代写，不用直接 PUT `script_content` 作假回退。
- **人工文案编辑的界线**：用户逐项明确要求修改既有稿、或原样导入其提供的定稿时，才可用最小 `PUT /episodes/{e} {script_content:...}` 并标明“人工修改/导入”。“用火宝改写”“先看原始材料”不是这类人工代填授权；助手自行创作的初次 AI 改写不得走此例外。
- **停止优先于纠错惯性**：用户要求停止火宝操作、只改技能后，不再 GET 核对，不自行清空、撤回、重生成或补写第二步。先报告错误；回滚也须等待用户另行授权，不能把“纠正我的错误”当作新业务操作权限。
- 项目/集基础端点仍为 `POST /dramas`、按当前读回需要时 `PUT /dramas/{d}`、`POST /episodes`。纪录片项目必须 `project_type=documentary` + `documentary_rules=on`；`POST /episodes` 返回 200 而非 201。项目设置与音频设置不因导入原始内容自动获得修改授权。
- 没有 `GET /episodes/{id}`：从 `GET /dramas/{d}` 的 `episodes[]` 按数据库 ID 找集，核对 `episode_number`；审核链接用显示集数。`content/script_content/script_confirmed_at` 都在集行中。`gates` 只反映服务端状态，不代替用户逐步授权。

#### S1-80 纪录片旁白稿纯净度（Issue #80，`[S]`）

**案例背景**：《历史纵横》E01（drama 9 / episode 15）的 `script_content` 带着维基出处块（原始材料 / 永久链接 / 原作者 / 许可 / 说明），旁白骨架用 `scriptMatchKey` 做逐字匹配，模型只能漏掉这些行（gap）或把 URL、许可写进旁白，于是「旁白骨架不合法」反复失败。用户的决策是：**非旁白内容必须由 AI 在改写阶段智能识别并剔除，不要再加关键词/正则规则；人工保存时命中只提示，由人决定删或留。**

- **纪录片的「剧本」就是旁白稿**：正文逐字朗读，`【】` 节拍标记不是杂质；出处块、版权许可、URL/永久链接、贡献者与编辑历史、书目与引用尾注（含 ISBN、出版社）、模板/编辑说明、「不作为朗读稿」声明都不属于旁白。正文里可朗读的归属表述（如「据《异域录》记载」）必须保留。
- **改写阶段（`fidelity.v2`）**：忠实改写现在要求模型返回 `{"content":…,"exclusions":[{"text","category","reason"}]}`，`category ∈ source|license|link|contributor|bibliography|editorial|not_narration`。服务端把每条 `text` 在**冻结输入**里唯一定位；定位不到、互相重叠、或仍出现在 `content` 里 → 阶段失败，不产生版本。`FidelityReport` 因此新增 `ai_exclusions[]` 与 `adjusted_baseline_chars`：内容量容差上界仍按原始基线，下界按**扣除剔除清单后的基线**，即「变短」必须由可定位的剔除清单解释，不能靠删正文压字数。
- **人工保存前的检查**：`POST /episodes/{e}/script-rewrite/inspect-narration {content, config_id?, model?}` → `{findings:[{text, reason, locatable}]}`。它检查**当前提交的草稿**，不是上一轮改写报告，并且**不写库**。仅纪录片项目可用（其它项目 400）；模型返回被截断或格式不合法时返回 502 `inspection_failed`。
- **检测失败 ≠ 稿件干净**：502 或字段缺失时必须按「检测失败」呈报并让人决定是否照样保存，不得当成「无问题」。`locatable:false` 的片段只能展示、不能自动删除（它在当前稿里找不到逐字匹配）。
- **删除是人的选择**：命中后由人选「删除可定位片段并保存」或「保留并保存」；Agent 不得自行决定删哪段，也不得把删除扩大成改写正文。
- 正例：改稿 → 调 `inspect-narration` → 把 `findings` 原样报给人（逐条 `text` + `reason` + 是否可定位）→ 按人的选择保存。
- 反例：① 自己写正则删「参考：…ISBN」；② 把 502 当作通过直接保存；③ 用 `inspect-narration` 的结果直接 `PUT` 改写正文；④ 拿上一次改写的 `ai_exclusions` 冒充本次草稿的检查结论。

### S2 资产（纪录片含“提取→审核→精确→美化”）
- 提取：`POST /episodes/{e}/extract {target}` ×3 → `extract-status` → 读 `characters/scenes/props`。
- 字段与关联：`PUT /scenes/{id}`、`PUT /props/{id}`、`POST /episodes/{e}/assets/link`、`DELETE .../assets/link`。
- 单资产出图：`generate-prompt`（可 `force`）→ `generate-image` → `GET /tasks/{id}` → 下载并打开。
- 批量：`POST /dramas/{d}/assets/batch-generate/preview` → 人确认范围 → 同 body 启动 → `GET` 状态。
- 纪录片审核：`POST /episodes/{e}/asset-review/run` → `GET /asset-review` → 逐条 `PUT /asset-review/items/{id}`（`not_needed` 必须写理由）。
- 语义：`purpose:"precision"` 不是“精确复原”，而是“带权威参照、程序 gate 与人工审批的生成逼近”，产物仍是艺术再现；不得声称考古/器物级精确复原。
- 精确→美化：`POST /asset-pipeline/asset-sources`（权威素材入库）→ `POST /asset-pipeline/runs {purpose:"precision"|"beautify"}` → `GET /runs/{id}` → 程序 gate + 开图 → `POST /runs/{id}/approve {opened:[{path,sha256}]}`；不合格 `verdict:"revise"`。
- 忠实素材：实测 `faithful` 只存在于 `props`（场景/角色没有该字段）。真实照片/地图建 `prop` 并标 `faithful:true` 后只做确定性图层底图；`PUT /props/{id}/faithful-source` 标记原件版本。
- **faithful 与“精确→美化”互斥**：`faithful:true` 资产不得进入 `asset-pipeline` 的 precision/beautify 生图链路，也不得做 t2i/image_edit/i2v。需要“更好看的艺术再现”时，另建独立场景/道具（`faithful:false`、名称与描述明确“艺术再现”），保留原件、来源与 license，两者分别审核；不得把原件替换成重绘图后仍称原件。
- 组合场景：先提取→审核→（缺项补提取）→ 精确/美化 → 才允许拆镜。
- 陷阱：资产批量是**项目范围**，传 `episode_id` 不代表只改本集；`rewrite_prompts` 与 `overwrite_images` 是两个独立操作；审批没带 `opened` 会被 400（这是硬规则，防止没看图就批）。

### S3 Poster（可选，资产之后）
- 端点：`GET/PUT /episodes/{e}/poster`、`POST /poster/generate {mode}`、`POST /poster/versions`（本地画布登记）、`PUT /poster/select`。
- 用途：片头海报；**不进主闸门**，不能阻塞资产→分镜。
- 组合场景：需要精确文字排版时，按保存的 `layout` 本地渲染 PNG → `POST /upload/image` → `POST /poster/versions` → `PUT /poster/select`。
- 陷阱：把真实照片/地图送扩散重绘会得到伪文字/几何漂移；优先确定性底图 + 文字层。

### S4 分镜拆分
- 端点：`POST /agent/storyboard_breaker/chat {drama_id, episode_id, config_id, model, message}`；`GET /episodes/{e}/storyboards`；`POST .../storyboards/fill-gaps`。
- 用途：按叙事节拍拆镜，产出描述、资产关联、关键帧/视频初稿。
- 组合场景：旁白模式必须逐段使用原旁白原文（覆盖率 100%），镜数=段落数；拆镜阶段不启动任何生成。
- 陷阱：完整重拆会覆盖；**先获人授权并保存快照**，不能自行重拆；不能用重拆修一条视频 Prompt；部分失败用 `fill-gaps`。

### S4.5 纪录片旁白骨架（Issue #81，`[S]`）

纪录片在拆镜与设计卡之间有一步「旁白骨架」：把已确认的旁白稿**有序、连续、逐字**地分配到各镜 `storyboards.narration_text`，并写镜头标题与衔接；没有独立的表，骨架修订号 `revision` 是脚本 + 分镜行的指纹。

**案例背景**：E01 的骨架页只有「并入上一镜 / 在光标处拆分」，缺口只能靠反复保存试错，报错把同一处缺口按镜重复累计（1→12→93 字），而且配音页没有试听入口，人无法判断某镜的音频是否就是当前旁白。#81 因此加了 dry-run 校验、缺口处置按钮与骨架内试听。

- 端点：`GET /episodes/{e}/narration-skeleton`、`PUT /episodes/{e}/narration-skeleton {revision, shots:[{id?, narration_text, title?}]}`、`POST /episodes/{e}/narration-skeleton/confirm|unconfirm`。
- **dry-run 校验（新）**：同一个 `PUT` 加 `validate_only:true` → `{problems, gaps:[{start,end,chars,text,next_index}], excerpts}`，**不写库**。`revision` 仍要带且仍会冲突报错（人在别处改过 → 先重读）。坐标是**去空白与 `【】` 节拍标记后**的剧本下标，左闭右开；`next_index` 是该缺口应并入的下一镜序号（`shots.length` 表示结尾处缺口）。任何一镜的旁白在剧本里定位不到时，`gaps` 返回空数组（无法给出可信坐标），只看 `problems`。
- **缺口处置**：把缺口补到上一镜末尾 / 下一镜开头 / 新建一镜领走；属于出处或版权信息的缺口**不要并进旁白**，回 S1-80 的旁白稿处理。单镜上限 80 字，超长缺口先建新镜再拆分。
- **骨架内试听（新）**：`tts` 新增 `audio_url` 与 `audio_version`。`valid:true` 才可播放；`valid:false` 表示音频与当前旁白不一致（已过期），**不得**拿旧音频当本镜配音证据，必须重新生成。播放地址按 `audio_version` 加版本参数防缓存。
- **保存语义**：`shots` 不带 `id` = 新建一镜；原有镜不出现在列表 = 合并/删除；保存会改变 `revision`，**原有确认随之失效**，必须重新确认。正文改字会被逐字校验拒绝——要改字去旁白稿，不在骨架里改。
- 正例：编辑草稿 → `validate_only:true` 看 `problems/gaps/excerpts` → 处置缺口 → 再 dry-run 直到干净 → 正式 `PUT` → 人确认 → 配音 → 逐镜试听（只听 `valid:true`）。
- 反例：① 直接正式保存去试错；② 把许可/链接缺口并进某镜旁白凑覆盖率；③ 播放 `valid:false` 的旧音频并报告「配音已完成」；④ 用骨架编辑代替旁白稿改写。

### S5 设计卡与段组合（含 Issue #82 变更，`[S]`）
- 端点：`GET /episodes/{e}/design-card-context`、`GET /episodes/{e}/design-cards/audit`、`POST /episodes/{e}/design-cards/fill`、`GET /episodes/{e}/design-cards/status`、`PUT /storyboards/{id}/design-card {combo, design_card}`、`POST /storyboards/{id}/design-card/confirm {acknowledge}`。
- 用途：把“这一镜怎么拍”写成导演分镜单；`combo` 决定是否用图层段/生成段及顺序。
- **案例背景（#82）**：E01 实测 20 张已填卡里 12 张 `combo` 为空，批量确认全被 `combo_missing` 挡住；卡头显示「实测 0.0s」（audit 的 `tts` 没有 `duration_ms`，前端把 `undefined` 当 0）；310 个 `unresolved_ref` 只显示通用文案，看不出是哪张资产、缺哪个语义条目。用户的决定：AI 直接把 combo 选出来、把时长关系讲清楚、把错误写成人能照着修的话，并且**绝不虚构语义名**。
- **AI 填 combo（变更）**：`design_card` 工具 schema 新增 `combo`，`suggested_combo` 变为可选仅供展示。`POST /episodes/{e}/design-cards/fill` 批次里：该镜**已有 combo** → 保留，不被覆盖；**没有 combo** → 采用模型所选；模型给出非法/缺失 combo → 该镜失败并把原因写进 `design_card_stale_reason`。纪录片「有卡但没 combo」的镜会进入 **combo-only 补选**：只补 combo，**不重写卡片内容**。写入后卡片一律回到 `pending`，确认仍由人按。
- **语义引用不得虚构**：批次提示词里带本集真实语义清单；模型写了不存在的 `semantic_id`/`name` → 该镜直接失败并回报可读原因。正确做法是**保留规划图层**、把 `semantic_id` 与 `name` 留空、在 `rationale` 写明「待标注」，不要为了过校验而降级成卡片/标签。
- **audit 新字段**：`tts.duration_ms`（缺失就显示「待配音」，**不要写 0.0s**）、`unresolved_layers[{index,type,text,asset_id,asset_name,asset_exists,semantic_id,semantic_name,available_semantics[]}]`、`video_generated`。报问题时引用 `issue.message` 与 `unresolved_layers` 的具体资产/语义名，不要只报 `code`。
- 组合场景：AI 填卡（含 combo）→ 人逐镜审阅并按需改 → 人确认（0 block；有 warn 需 acknowledge）。
- 陷阱：预算 `layer_s≤30`、`gen_s≤15` 超限直接拒存；已确认且有产物时改 combo 会被拒，必须走 `POST /storyboards/{id}/combo`（先看 `combo/impact`）；批次只对「无 combo」的镜写 combo，不要指望它纠正人已选的组合；确认失败时读返回体 `issues[].message`，它已包含具体原因。

### S6 图层段
- 端点：`GET /layer-segments/storyboards/{id}`、`POST .../draft`、`PUT .../{id} {layer_doc,timeline,duration,base_ref}`、`POST .../render`、`GET .../thumbnail/{first|last|frame-N}`、`GET .../junction`、`GET /layer-docs/fonts`。
- 用途：确定性渲染“精确信息”（文字、年代、地点、箭头、流程图、真实照片/地图的 contain 摆放、时间轴显隐）。
- 组合场景：
  - A：整个镜头=图层段（适合原理示意、流程、地图定位）。
  - C：前段图层（如 4s 定位/标注）→ 末精确帧去文字 → 作为生成段首帧。
  - D：生成段 → 首精确帧作为生成段尾帧 → 图层收束。
- 陷阱：设计卡未确认不能写/渲；无合格底图 → 400 `missing_base`；重渲改变 junction hash 会让关键帧确认失效；`timeline.fps` 会被持久化为目标帧率，必须与最终输出一致（默认 25），混帧率会导致 stale。
- **输出规格**：图层渲染画布取剧集画幅（16:9 = 960×544；源图可为 1920×1088 或 1024×1024，按 contain/裁切记录在 `base.source_width/source_height`）。最终 compose/merge 沿用同一画幅；模型 raw 可能是 24fps，merge 会输出 25fps CFR，不需要也不允许把图层改成 24fps 迎合 raw。

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

### S8 旁白、配音、字幕、音画适配
- **旁白模式的两条不变量（硬）**：①关键帧出图/确认必须在实测配音时长之后；②视频提交必须在关键帧确认之后。
- 默认顺序（软，可记录理由后调整）：旁白文稿 → 配音（实测时长）→ 字幕 → `narration-fit` → 视频 Prompt 按时长对齐 → `mid_frame_time` 落定 → 关键帧出图与确认 → 视频。关键帧提示词可以提前写。
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

### S10 合成
- 端点：`POST /storyboards/{id}/compose`、`POST /episodes/{e}/compose-batch/preview`、`POST .../compose-batch {storyboard_ids}`、`GET .../compose-batch-status`、`POST .../retry-failed`。
- 用途：把视频 + 旁白音轨 + 烧录字幕变成可导出的融合片，写 v2 签名。
- 组合场景：preview 读 `status/exportable/plan/signature` → 启动显式 IDs → 轮询 → 逐镜读回 `compose_state`。
- 陷阱：只有 `unchanged` + `exportable:true` 才可导出；`missing/changed/unknown` 要重做；`blocked/skipped` 先按 reason 修。200 与“导出成功”不是一回事。

### S11 导出
- 端点：`GET /episodes/{e}/merge`、`POST /episodes/{e}/merge {storyboard_ids, poster_version_id?, poster_duration?}`、`GET /episodes/{e}/merges`。
- 用途：按所选镜头顺序拼成最终片，可加 Poster 片头。
- 组合场景：显式 `storyboard_ids`（省略=整集，导出时必须显式）；`poster_duration` 钳 0.5–10 秒。
- 陷阱：任一镜未 `exportable` 且开启旁白 → 整体 400 并给 `blocked[]`，不能静默回退原片/少镜；merge record 的 `duration` 是整数显示，精确时长必须用 ffprobe 测。

### S12 任务与返工（贯穿）
- 端点：`GET /tasks/active`、`GET /tasks/center`、`GET /tasks/{id}`、`POST /tasks/{id}/retry`、`POST /tasks/{id}/cancel`。
- 用途：唯一进度源；重试只改模型/配置并新建任务；取消能力有限。
- 陷阱：`retry` 的剧本/拆镜会覆盖本集内容，必须授权；不能为停止文本任务重启服务。

---

## 3. 以诊断片为例：目标 → 步骤 → API

**授权前提（重要）**：本案例是“用户已明确授权五镜技术测试、逐镜确认 C/B/A/A/A 与预算、允许保留失败证据”的前提下，由协调者执行的记录。因此下文出现的 `script/confirm`、`design-card/confirm`、`confirm-keyframes`、`approve{override_gate:true}` 都是**人在此前已给出决定、协调者代按**的事实；通用 Agent 不得据此把这些端点当成可自主调用——必须逐项停下请人做决定，再做技术执行与记录。

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

### 步骤 3：Poster（可选）
- `GET /episodes/14/poster` → `PUT /episodes/14/poster {prompt, base_image, reference_images, layout{texts[...]}}`（3 个文字层，坐标 0–1）→ 本地按 layout 渲染 PNG → `POST /upload/image` → `POST /episodes/14/poster/versions {image, base_image, layout}` → `PUT /episodes/14/poster/select {version_id:10}`。
- 读回：Poster 10，0 张 AI 图。
- 为什么：Poster 不进主线闸门；精确排版用确定性画布，不靠扩散写字。

### 步骤 4：拆镜
- `POST /agent/storyboard_breaker/chat {drama_id:8, episode_id:14, config_id:10, model:"deepseek-chat", message:"…恰好五段一镜一段，旁白逐字原文，覆盖率100%，不启动任何生成…"}`
- `GET /episodes/14/storyboards`：得到 186–190。
- 为什么：镜数=段落数，旁白原文不动，避免拆镜阶段偷跑生成。

### 步骤 5：设计卡与组合
- `GET /design-card-context`、`GET /design-cards/audit`。
- `POST /design-cards/fill {storyboard_ids:[186..190], config_id:10, model:"deepseek-chat"}`（草稿）→ `GET /design-cards/status`。
- 人显式定：C/B/A/A/A。逐镜 `PUT /storyboards/{id}/design-card`：
  - 186：`combo:"C"`，`budget:{layer_s:4,gen_s:6}`，`layer_plan`（3 个 label：河南·安阳 / 殷墟 / 艺术再现），`gen_plan.first` 不写（由衔接帧锁定），`mid/last` 只写机位与“无人无文字”。
  - 187：`combo:"B"`，`budget:{layer_s:null,gen_s:10}`，`gen_plan.first/mid/last` 只用 `@车马坑艺术再现` 指代，不描述外形。
  - 188/189/190：`combo:"A"`，`budget.layer_s` 10/10/12，`layer_plan.base` 指向确定性底图（188 用示意底图，189 用流程底图，190 用真实照片 92 + 现代定位图 93）。
- 人逐镜审卡/定组合后 → `POST /storyboards/{id}/design-card/confirm {acknowledge:true}` ×5（Agent 不得自发确认）。
- `GET /design-cards/audit`：5 镜 `confirmed`，`unresolved=0`。
- 为什么：本轮（2026-11-05）组合全部由人显式给出；C 的衔接帧锁定必须体现在卡里（first 由图层末帧继承）。**口径已更新**：#82 之后纪录片批次可为「尚无 combo」的镜首次写入 AI 所选组合，人改为逐镜审阅 + 确认（见 S5）。

### 步骤 6：图层段
- `GET /layer-segments/storyboards/186`：`combo:"C"`、`production_unlocked:true`。
- `POST /layer-segments/storyboards/186/draft`（按 `layer_plan` 出草稿）。
- `PUT /layer-segments/storyboards/186`：`{layer_doc{version,base{path,width:960,height:544,source_width:1920,source_height:1088},theme:"archival",layers[4 label]}, timeline{fps:25,ease:"inout",fade_ms:250,keyframes[{t:0,visible:[location,art]},{t:0.8,…},{t:1.5,…},{t:4,…}]}, duration:4}`
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
- `GET /episodes/14/merge` → `POST /episodes/14/merge {storyboard_ids:[186..190], poster_version_id:10, poster_duration:2}` → merge 26 → 轮询到 completed。
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
| 用户已授权 AI 改写 | 走火宝 `POST /agent/script_rewriter/chat`，读回火宝保存的结果；不是助手代写回填 |
| 每阶段开工 | 先核本次授权；获准操作后再读 `GET /episodes/{e}/gates` / 预览 / `tasks/active`，不猜、不抢跑 |
| 批量生成 | 一律先 preview，读 `checked/status/reason`，人确认后传显式 IDs |
| 写入 | 先快照 → 最小字段 PUT → 重新 GET 对照 → 报告 before/after |
| 审批 | 必须开图并附 `opened:[{path,sha256}]`；程序 FAIL 保留，`override_gate` 只写技术例外范围 |
| 返工 | 定位错在哪一层（剧本/资产/绑定/关键帧/时长/模型），从对应入口修；通用规则缺陷交维护任务 |
| 恢复 | 用批次状态/`fill-gaps`/`retry-failed` 补剩余，不从头重跑；已有活跃任务只观察 |
| 证据 | 每次调用写 `requests.jsonl`；媒体“已打开”与“未核”分开记录 |
| 验收 | 技术验收与艺术批准分开写；`exportable` 只代表签名就绪 |
| 成本 | 任何新 GPU 请求前确认预算；额度用尽时停下来问人 |

### 4.3 反例模式（Agent 常犯的错误想法）

| 错误想法 | 为什么错 | 正确做法 |
|---|---|---|
| “第一步和第二步都是文本，我一次填完更省事” | 混淆原始材料与 AI 工种产物，越过用户要求的停止点 | 第一页只写 `content`；等用户授权第二步，再让火宝生成 |
| “API 能写 script_content，所以我能代做 AI 改写” | 可写字段不等于阶段授权；经火宝保存不等于由火宝生成 | AI 改写必须走火宝内部工种；直接人工编辑须用户逐项明确授权且如实标明 |
| “纪录片技能限制整理范围，我本地写好再存进去” | 用规则冲突为绕开业务工种找理由 | 报告冲突并等用户决定，不换成助手代写或改全局技能 |
| “用户说停下，我先 GET/清空错稿再停” | 停止指令已收窄操作范围，修错不自动新增业务权限 | 立即停止火宝调用；仅完成明确获准的技能修订，回滚另等授权 |
| “HTTP 200 / completed / exportable，所以这镜通过了” | 这些只证明受理/输入一致，不证明画面正确 | 下载并打开真实媒体；逐项比对（首帧/junction、轮辐、字幕边界、音频） |
| “先把图都生成了再说” | 跳过剧本确认/资产审核/设计卡闸门，浪费预算且产物不可用 | 按 S1→S2→S5 顺序推进，每阶段先读 gate |
| “AI 填卡时顺手把 combo 定了” | 组合是导演选择，默认推定会让镜头变成 PPT 或丢失生成段 | `combo` 由人显式给；AI 只填草稿与 `suggested_combo` |
| “图层更可控，所有镜头都用图层” | 叙事/表演镜头需要扩散的表现力；全图层会像幻灯片 | A 只用于精确信息镜；B/C/D 保留生成段 |
| “扩散更漂亮，真实照片也重绘一下” | 地图/文物/档案会被改几何、造伪文字 | 忠实素材只做确定性底图+图层；艺术再现另建资产并标注 |
| “关键帧提示词里写清角色长相更稳” | 文字与图片打架，模型会改掉已定形象 | 只用 `@名字` 指代；外形以图片为准 |
| “C 的首帧槽也出一张，保险” | 锁定槽由图层衔接帧继承，另出一张会破坏锁定 | `skipped/slot_locked` 就跳过；只出 mid/last |
| “A 镜也出首中尾，反正没坏处” | A 没有生成段，图不会被用，白花钱 | 预览 `excluded:no_generated_segment`，不出 |
| “先定视频时长再配音，省事” | 实测配音与视频尾段不符，合成时挤压/留白 | 旁白→配音→fit→视频 Prompt 时长对齐→关键帧确认→视频 |
| “批量失败就整个重跑” | 重复花钱、覆盖已完成产物 | `retry-failed` / `fill-gaps` 只补剩余 |
| “merge 不传 IDs 就是全部，正好” | 省略=整集，可能带入未就绪镜头或非预期镜头 | 导出必须显式 `storyboard_ids` |
| “本地 ffmpeg 拼一下更快” | 绕过业务签名/音频/字幕逻辑，产物不可追溯 | 只用火宝 compose/merge；本地 ffmpeg 仅只读检查 |
| “改库/写 media/重启服务能绕过 bug” | 破坏业务事实源与其他项目 | 报告缺口；业务写入只走 API |
| “asset gate 没过，直接 approve 算了” | 没开图/没写理由的批准是造假 | `opened` 必填；`override_gate` 需技术理由与范围，保留 gate FAIL |
| “用户之前同意过类似版本，这次也算同意” | 沉默/旧版本/别的镜头批准不等于本版通过 | 每版重新取得明确同意 |
| “C 跳变是模型局限，标注 PASS 吧” | 未证明唯一因果，且视觉确实 FAIL | 保留 FAIL，报告证据与可选修复路径，等人决定预算 |
| “先 release 再说，验证回头补” | 发布不等于验收；生产改动会影响真实项目 | 先验证真实路径，再发布；发布后回归原项目 |

### 4.4 每阶段最小核对清单

- **第一步原始内容**：来源与 `content` 对应；未夹带 `script_content` 或改写调用；到达用户指定停止点即结束。
- **第二步 AI 改写**：已获该步授权；存在真实火宝改写调用与保存结果；不是助手代写回填；再审原文 vs 改写差异与事实归属。保存前跑过 `inspect-narration` 并把 `findings` 原样呈报（502 记为「检测失败」）；改写报告的 `ai_exclusions` 逐条可定位。稿件确认和后续旁白覆盖率另按阶段检查。
- **旁白骨架**：正式保存前 `validate_only:true` 干净（`problems` 空、`gaps` 空）；缺口按「并入上/下镜或新建镜」处置，非旁白内容回旁白稿；保存后重新确认；试听只用 `tts.valid=true` 的音频。
- **资产**：本集关联是否正确；名字无空格；`faithful` 未进扩散；审核清单 0 missing；程序 gate 与人工例外分开记录。
- **Poster**：文字未裁切、底图来源正确、未调用不必要生图。
- **设计卡**：5 个信息点都有 `via`；预算不超限；每镜都有 combo（AI 首次填入的也必须人工审阅）；`unresolved_layers` 逐条有真实资产与语义名或明确「待标注」；`tts.duration_ms` 缺失时显示「待配音」而非 0.0s；确认状态 `confirmed`。
- **图层段**：`base` 尺寸/裁切正确；文字安全边；junction 去文字；`timeline.fps` 与输出一致；`thumbnail` 实际打开。
- **关键帧**：预览分类正确；锁定槽未出图；版本签名与当前提示词/参考图一致；确认后再提交视频。
- **旁白**：字数 ≤80（按 spokenText）；发音标记合法；配音实测时长；fit 不截断旁白；字幕与音频逐字对齐。
- **视频**：raw 时长/帧率；首帧 vs junction（C）/尾帧 vs junction（D）；引导链；参考图顺序。
- **合成**：`unchanged/exportable` 逐镜；音频与 composed source 相关；字幕烧录边界。
- **导出**：显式 IDs；Poster 时长；完整解码；帧账（Poster 帧数 + 各镜帧数）；真实时长以 ffprobe 为准。

### 4.5 典型错误案例：助手代填「AI 改写」（2026-11-06，《历史纵横》漕运，第1集）

- **用户边界**：先做第一步、让用户看完再等指令。两页分别是 `drama/9/episode/1?panel=script&step=0`「原始内容」与 `...&step=1`「AI 改写」；数据库 `drama_id=9`、`episode_id=15`。
- **真实错误 [R]**：助手自行写了840字符、16段解说稿，直接 `PUT /episodes/15`，请求含 `content`、`description`、`script_content`。结果原始内容与 AI 改写两页同时被填上，但没有调用 `POST /agent/script_rewriter/chat`。经 API 存进去的自写稿不是“通过火宝改写”。
- **错误推理**：把“用户想用火宝改写”误当成“允许助手代写回填”；把通用字段编辑能力误当成当前阶段授权；又以纪录片内置技能只允许整理、内容量±5%为理由绕开火宝。计划里写入了这套错误方案，也不能替代用户的具体阶段边界。旧流程把两种文本字段并列、历史示例又同时写两者，容易强化误读，但不是越权借口。
- **为什么必须禁止**：用户失去第一步的审核与推进控制；第二步失去火宝内部工种的生成链路与记录；即使没有确认或生成媒体，提前代填第二步本身已经越权。
- **应当怎样做**：原文只进 `content` → 读回并提交第一步链接 → 等用户；获准改写后才调用火宝 `script_rewriter` → 读回火宝稿件 → 再等用户审核。规则冲突就报告，不本地代写补位。
- **纠错边界**：用户随后明确“不要再操作，只更新 skill”。这时只改已授权的助手技能文档；不再请求火宝、清空稿件、运行改写或声称已经恢复某个业务状态。本案例记录的是错误及预防规则，不是可复制的成功流程。

### 4.6 生产验收固定案例：八达岭长城测试 1008（`AGENTS.md` §9/§10）

**为什么用它做生产验收**：隔离 worktree（独立端口 + DB 副本）从 2026-11-08 起不再作为验收依据——它跑的是副本数据与副本静态目录，掩盖过生产独有的路径前缀、任务队列与真实模型行为。验收必须在生产入口 + 生产后端 + 生产库上留痕，又绝不能碰既有真实项目（尤其 drama 3《利哈列夫远征》）。固定一个**主题、篇幅、命名都确定**的新项目，既保证每轮验收覆盖同样的链路、可横向对比，又把写入限制在一次性测试项目里。

- **主题**：八达岭长城对明朝防御的作用。
- **原始内容（固定文本，正文 224 字，去空白计；只进第一步 `PUT /episodes/{e} {content}`）**：长度刻意压在 200–300 字，是为了让旁白骨架、配音、设计卡在可控镜数内跑完，GPU 成本可预算。正文（内容为公有领域历史常识整理，可公开）：

  > 八达岭长城位于北京西北的军都山关沟北口，是明代长城中规制最高、保存最完整的段落之一。明永乐以后，蒙古诸部屡次南下，朝廷把京师北面的防线层层加厚：外有宣府、大同，内有居庸关，而八达岭扼守关沟最窄处，成为居庸关的前哨。城墙依山脊起伏，以条石为基、青砖包砌，顶部宽处可容五马并行，便于快速调兵。沿线每隔数百米设敌台与烽燧，守军以烟火与号炮为信，警讯昼夜之间即可传到京城。它的作用不只是阻挡，更是把进攻者逼入狭窄山道，使明军能以较少兵力守住通往北京的咽喉。

  正文之后再**另起一行**附这条**故意保留的非旁白出处行**（它不是旁白，用来触发 #80 的检测；不计入上面的 224 字）：

  > 资料来源：公有领域历史常识整理；本行为出处说明，不作为朗读稿。

  导入时两段一起写进 `content`（原始材料保留出处是 S1 的要求）；AI 改写走第二步，改写与保存前的检测应当把这条出处行识别为 `source`/`not_narration` 并给出可定位的 `findings`，正文 224 字不得被改写删减。
- **项目命名**：`八达岭长城测试 1008`；同名已存在时追加序号（`八达岭长城测试 1008-2`）。**不复用旧测试项目**；实际 `drama_id`/`episode_id` 以创建结果为准并写进报告。
- **链路**：建项目（`project_type=documentary` + `documentary_rules=on`）→ 原始内容 → AI 改写 → 旁白稿检查（#80）→ 人工确认 → 资产提取/审核 → 旁白骨架（#81）→ 配音 → 设计卡（#82）→ 图层段/关键帧 → 视频 → 合成 → 导出。本轮验收涉及的阶段必须真实跑通，不涉及的阶段写明「未覆盖」。
- **本案例要覆盖的新功能**：
  1. `POST /episodes/{e}/script-rewrite/inspect-narration`：在原始内容尾部刻意保留一条出处/链接行，验证 AI 识别、`locatable` 判定与「删除可定位片段 / 保留」两条人工路径；
  2. `fidelity.v2` 的 `ai_exclusions` 与 `adjusted_baseline_chars`：改写报告能看到被剔除片段与调整后基线；
  3. `PUT …/narration-skeleton {validate_only:true}`：缺口坐标、`excerpts`、三种缺口处置；
  4. 骨架 `tts.audio_url` / `audio_version`：配音后逐镜试听，并验证改动旁白后旧音频转为 `valid:false` 不可试听；
  5. `POST …/design-cards/fill` 的 AI combo 与 combo-only 补选（含「已有 combo 不被覆盖」）；
  6. `GET …/design-cards/audit` 的 `tts.duration_ms`、`unresolved_layers`、`video_generated`，以及确认失败时可读的 `issues[].message`。
- **证据清单**：`drama_id`/`episode_id`/各阶段 `task_id`；每个关键阶段的浏览器截图（读图后再下结论）；只读 DB 查询（状态与产物路径）；失败任务的日志片段；GPU 消耗台账（图片/视频/TTS 条数）。报告必须给出这些 ID 与证据路径，不能只写「已验证」。
- **纪律**：生产测试消耗真实额度，任何计费生成任务先取得用户同意；严禁修改、生成、删除既有真实项目数据；DB 一律只读；失败不隐瞒，保留证据。

---

## 5. 失败处理与报告模板

发现失败时，按这个顺序写，不要先下结论：

1. **事实**：哪一镜、哪一秒、哪个文件、哪个 hash/SSIM/帧号。
2. **输入核对**：上传字节、引导帧、参考图顺序、提示词原文、时长/画幅。
3. **图结构核对**：引擎节点/guide frame_idx/conditioning（只读；不直连上游做生产请求）。
4. **因果状态**：能证明什么、不能证明什么（例如“上传与图结构未发现错误；prompt 与图片几何矛盾；唯一因果未证明”）。
5. **可选修复**：改通用规则/重出哪一段/需要多少预算；明确“不保证一次通过”。
6. **保留证据**：失败版本不删、不本地修补、不改签名冒充通过。

报告给用户时给：可播放链接、审核深链、真实文件路径、成本账、通过项、失败项、需要他做的决定。

---

## 6. 能力边界（写进技能，防止越权）

允许：在当前阶段授权内调用火宝 HTTP API；文件系统读取与证据保存；本地只读 ffprobe/ffmpeg 检查；网络检索取证；用户逐项明确指示下的人工字段修改/用户定稿导入（按 S1 标明来源，不替代火宝 AI 生成）；经单独明确授权的设置修改（最小写入+读回）。

禁止：助手自行生成剧本再直接回填 `script_content` 冒充火宝 AI 改写；跨过用户指定的第一步/停止点；用户已停止业务操作后仍以验证或撤回为由调用火宝；直接读写 SQLite；写生产 media/数据库/任务状态；SSH/部署/重启服务；直连上游模型/TTS/ComfyUI；默认改供应商/全局配置/Prompt/Skill；修改审核状态冒充人已批准；在未授权项目上写；把本地合成冒充火宝产物。
