# 强制制作工作流（hbwf + omp 扩展，Issue #97）

## 为什么有这一节

drama 3 / episode 26（剧情项目 + 旁白 + 纪录片规则集，122 镜）制作中，独立审计（Claude Opus 5.5，`history_project/ep26-yermak/reviews/workflow_audit/opus55_review.md`）确认：

- Poster 两次被计划漏掉。技能把它写成“可选、不进主闸门”，计划是凭记忆重建的。
- 41 镜关键帧待补/过期，但没有逐镜状态表，汇报把“字段非空”说成“已补齐”。
- 用户看到“合成成品：阻断”，以为是提前调用了合成。实际剧情镜无视频时就被动显示阻断，合成只提交过 `[810]` 与 `[811,814,815]`。
- 视频提示词时间轴超长的镜（898/906）照样提交，排队期间又被改写。
- 105 镜视频提示词被整集强制重写：显式 `storyboard_ids` 等于强制重写，不跳过已完成的镜。

用户要求：**工作流必须强制执行，并依据项目文件检查，而不是对话记忆或启动提示。** 于是有了：

- `workflow/hbwf.py`：从火宝 GET/preview 重新推导状态，是唯一的写入通道；
- `workflow/profiles/<profile>.json`：步骤、并发与失效规则；
- `workflow/omp-extension/huobao-workflow-gate.ts`：omp 扩展，拦截绕过 hbwf 的写入；
- 项目目录下的 `workflow/` 文件：配置、派生状态、决定、账本。

## 安装与启用（每台机器一次；技能更新后重做）

```bash
SK=~/.omp/agent/managed-skills/huobao-director
mkdir -p ~/.omp/agent/extensions
cp $SK/workflow/omp-extension/huobao-workflow-gate.ts ~/.omp/agent/extensions/
```

- 扩展只对**新会话**生效。
- 生效范围：cwd 位于 `HUOBAO_WF_ROOT`（默认 `~/projects/history_project`，可用冒号分隔多个）内的主会话与子 agent，含 omp-web 会话。
- `hbwf call` 在真实提交前核对已安装扩展与技能副本的 sha256，不一致就拒绝（fail-closed）。

## 开工（每集一次）

```bash
HBWF="python3 ~/.omp/agent/managed-skills/huobao-director/workflow/hbwf.py"
$HBWF init <项目目录> --api-base <API 根> --drama D --episode E --profile drama_narration \
  [--required-poster] --canonical <canonical_ids.json> \
  --models '{"text":{"config_id":..,"model":".."},"image":{..},"video":{..},"tts":{"config_id":..}}' \
  --authorization '<用户授权原话>'
$HBWF check            # 派生 state.json，打印 roadmap（当前步骤/缺失/blocked_by）、逐镜下一步与终检问题
```

- API 根写在项目的 `workflow.json`，不进仓库。
- `init` 会记录配置哈希；之后再改 `workflow.json`，派生时报“tampering”。
- `init` 时已在跑的批次会被“收养”，它们的子任务不算孤儿。

## 原声剧情模式与代理返工（Issue #129）

`drama_visual` 仅用于服务端明确 `project_type=drama`、`episode.narration_enabled=false` 的集；字段缺失、非布尔值或片种不符时阻断，不能把读取失败当作旁白关闭。其余流程继续使用 `drama_narration`。profile 是项目初始化配置，不手改现有 workflow.json 绕过校验。

原声剧情逐镜跳过配音、字幕与融合，merge 使用产品返回的原始视频；仍要求提示词结构、关键帧确认与审核、视频审核、canonical 顺序、Poster 决定、无在飞任务和对账通过。`check` 明示 `narration: required=False`。旁白模式继续校验配音/字幕/融合和原文覆盖率。

导出后只在 roadmap 的 export=done 且 m3_export=done 时通过。服务端将最新完成 merge 的 scenes 路径逐项与当前镜头产物路径及顺序比较；换用视频后旧成片即 stale，不能仅看旧文件仍存在。导出前允许 stale export，正由本次 merge 修复。

用户明确委任代理执行本轮审核和选版时，可以按委任记录 proxy 决定；所有审批仍绑定实际版本、授权原话和已打开的媒体。没有委任时继续等待用户本人决定。该委任不授权修改全局供应商、跳过闸门或新增目标。定向返工见 [visual-rework.md](visual-rework.md)。

## 命令

| 命令 | 作用 |
|---|---|
| `check [--ids a,b] [--json] [--final]` | 派生并打印 roadmap（`current`、每步 `status/missing/blocked_by`、里程碑）、逐镜 `next`、批次、Poster、对账、终检 |
| `status` | 只读上次 `state.json`，不联网 |
| `get PATH` | 只读 GET（`get /episodes/{e}/roadmap` 可看原始 JSON） |
| `call METHOD PATH --body-file f --intent "…" [--ids a,b] [--dry-run]` | **唯一写入通道**：加锁 → 派生（含 roadmap）→ 守卫（含步骤顺序）→ 记 prepared → 复核在飞批次 → 提交 → 记 outcome（含 roadmap 前后状态） |
| `decide KIND …` | 记录人/代行人决定，绑定当前对象版本 |
| `final` | 导出后终检：导出前判据 + roadmap 导出步骤 `done` + 里程碑 `m3_export` 达成 + 无 stale。导出前的最后检查用 `check --final`；`merge` 走同一批导出前判据 |

## 步骤状态（roadmap，Issue #105）

`derive`/`check` 每次读 `GET /episodes/{e}/roadmap`（结构见 `references/api-catalog.md` §2），并写进 `state.json` 的 `roadmap`。读不到时派生记一条 problem，映射到步骤的写入一律拒绝（fail-closed）。

- 纪录片（`strict=true`）：`raw → rewrite(prepared→fidelity→bridge→final→confirm) → assets(extract→review) → poster(free, required_before=export) → design(skeleton→voice→cards) → production(layer‖keyframes) → final → export`。
- 剧情项目（`strict=false`）：`script / assets / poster / keyframes / videos / export`，全部 `free`，roadmap 只作信息，不加锁。

**写入守卫（步骤顺序）**：每个写端点映射到所属步骤（显式表在 `hbwf.py` 的 `WRITE_STEPS`；`PUT /episodes/{id}` 与 `PUT /storyboards/{id}` 按 body 键细化，例如 `content`→`raw`、`script_content`→`rewrite.final`、`narration_enabled`→`design.voice`、帧/视频提示词→`production`、`narration_text`→`design.voice`）。提交前读 roadmap：

- 目标步骤之前还有严格步骤不是 `done`/`skipped` → **拒绝**，错误里带 `blocked_by`；Poster 只在写 `export` 时才算前置。
- 目标步骤自身 `unlocked=false` → 拒绝，错误里带 `lock_reason`/`goto`。
- 写入已 `done` 的步骤（返工）或当前步骤允许；纪录片子步骤按 `ordering` 判断（`production.layer`/`keyframes` 自由，`design`、`rewrite` 的子步骤严格）。
- 剧情项目不做步骤顺序守卫。
- 写入结束后重新派生 roadmap，`outcome` 记录 `roadmap{step,substep,before,after,terminal}`（`terminal=true` 表示该步已达到 `done`/`skipped`）。

## 逐镜 `next` 与决定绑定

`next` 按以下顺序取第一个未满足项：

旁白模式：`fix_narration` → `remove_acceleration` → `make_subtitle` → `wait_call` → `write_keyframe_prompts` → `generate_keyframes` / `wait_keyframes` → `review_keyframes` → `confirm_keyframes` → `wait_video` → `write_video_prompt` → `review_video_prompt` → `generate_video` → `review_video` → `compose` → `review_compose` → `done`

`drama_visual` 不进入旁白、字幕、融合动作；视频经审核后到 `done`。

纪录片项目有两个**人工确认**项排在前面（来自 roadmap，不调用确认端点）：

- 骨架未确认 → 所有镜 `next=await_skeleton_confirm`（`设计 · 骨架确认` 不是 `done`/`skipped`）；
- 骨架已确认但设计卡未全部确认 → 处于制作阶段的镜 `next=await_design_card_confirm`（`设计 · 设计卡确认` 不是 `done`/`skipped`）。

这两项只报告「等待人工确认」（`check` 末尾有说明行），由人做决定后再继续；Agent 不得自行调用 `narration-skeleton/confirm`、`design-card/confirm`。

| 决定 kind | 绑定对象（变化即 stale） | 用途 |
|---|---|---|
| `keyframe_approval` | 各槽图片路径 + 各槽提示词 | 确认关键帧的前提；只能在所有必需槽 preview 为 `unchanged` 时记录 |
| `video_prompt_review` | video_prompt + duration + mid_frame_time | 提交视频的前提；结构检查（时间轴连续、终点 = 时长）不过不能记录 |
| `video_approval` | video_url | 合成的前提；打开首/中/尾后记录 |
| `compose_approval` | composed_video_url | 终检要求；打开字幕/音轨后记录 |
| `poster_approval` | 版本 id + 图片 | `poster/select` 与终检要求 |
| `script_approval` | script_content | 剧情项目的稿件批准（`script/confirm` 是 no-op） |
| `rework` `--scope keyframe_prompts\|video_prompt\|all_prompts` | 在最近一次保存之后记录，保存后自动失效 | 重写已完整有效的提示词 |
| `structural_change` | ids 或 method + path | 拆镜、建镜、删镜、改旁白 |
| `exception` | method + path 正则，**单次有效** | 未纳管的写端点（取消、改其它字段等） |
| `reconcile` `--call-ids/--task-ids` | — | 认领结果未知的调用、确认孤儿写入 |
| `poster_waiver` | — | 非必需 Poster 的剧情集决定不做（`required_poster=true` 时无效；**纪录片一律拒绝**，#101） |

审批类决定必须带 `--evidence`：实际打开的媒体或审核文件，记录路径与 sha256。这是**留痕**，不是“看过”的证明。所有决定都带 `--authority`（用户授权原话）与 actor，交付时按类型逐条列出。

## 守卫规则要点（drama_narration）

- **提示词**：
  - `generate-keyframe-prompts` 的 ID 必须非空；只允许缺失或无效的镜，已完整有效的镜要有 `rework` 决定。
  - `generate-video-prompts` 只用于视频提示词**为空**的镜。它显式 ID 即强制重写，还会对全集做转场审核（`services/video-prompts.ts:56-61`）。重写已有提示词用 `prompt_generator/chat --ids`：消息必须禁止 `readStoryboardContext`；事后比对全集 `field_saved_at`，越界写入记为违规，未保存的目标列为 `not_saved`。
- **冻结**：在运行批次中排队的镜、被未结束调用占用的镜，提示词与旁白一律不得改。
- **关键帧**：
  - `items` 必须显式；只允许 preview 为 `missing/changed` 的槽；要求旁白已配音、提示词有效；每集同一时间只能有一个关键帧批次。
  - 确认要求 `keyframe_approval` 有效，且全部槽 `unchanged`、`ready`。
- **视频**：要求关键帧已确认且审核有效、提示词结构合法且 `video_prompt_review` 有效、preview 为 `missing/changed`、未在排队、模型等于固定配置。每集同时只能有一个视频批次；批次在跑时，批次外的镜可以走单镜 `generate-video`。
- **合成**：要求 `video_approval` 有效、旁白与字幕就绪、未加速、preview 为 `missing/changed/unknown` 且未阻断。
- **配音**：ID 显式；只允许 voice preview 为 `missing/changed` 的镜；不与视频提示词任务并发。`narration-fit` 只能 `pad`，`tempo_override ≤ 1`。
- **结构性改动**（breaker、`POST /storyboards`、删镜、改 `narration_text`）需 `structural_change` 决定。
- **merge** 必须通过终检：
  - 每镜 `next=done`；
  - `storyboard_ids` 等于 canonical 顺序；
  - 按该顺序拼接的旁白等于 `script_content`（去空白与【】）；
  - Poster 已选且审核有效（或非必需的剧情集有 waiver；纪录片 `poster_policy` 恒为 `required`，#101），`poster_version_id` 等于选定版本；
  - roadmap（纪录片）：导出步骤之前的所有步骤 `done`/`skipped`（Poster 为 `required_before=export`），且没有 `export` 以外的 `stale` 步骤/子步骤（导出本身 stale = 之前的成片过期，本次 merge 正是要修它）；剧情项目的 roadmap 只作信息，不参与 merge 前置，沿用原逐镜/Poster 判据；
  - 无在飞批次或任务；
  - 无孤儿写入，无未对账的 unknown 调用。
- **导出后终检**（`hbwf final`）：上面的判据 + roadmap 导出步骤 `done` + 里程碑 `m3_export` 达成（最新 completed 合并按顺序覆盖当前全部成品；纪录片片头 = 当前选定 Poster）。导出步骤 `stale` 在这里算失败（成片与当前镜头/Poster 不一致，重新 merge 后再跑）。剧情项目同样要求 `m3_export`。
- **其余写端点**默认拒绝，除非有单次 `exception` 决定。

## 对账（不依赖拦截）

每次派生都读取 `GET /tasks/center?episode_id=`。init 之后创建、却无法归属到账本的任务或批次，列为 `orphans`。归属依据有三种：已入账的批次 id、批次子任务、提交时间窗。

UI 点击、浏览器操作、绕过扩展的脚本产生的写入都会显示在这里，终检会拦下。UI 直接改提示词不产生任务，但会让绑定哈希失效，相关审核变成 stale，同样过不了终检。

## 合法交错与并发

- 逐镜依赖：P7 配音 → P8 字幕；P7 → P9 关键帧提示词 → {P10 视频提示词 ∥ P11 出图}；P11 → P12 审核确认；{P10 审核, P12} → P13 视频；{P13 审片, P8} → P14 合成。
- 某镜满足前一步就能进入下一步，不必等整集。
- 同类批次每集互斥：每集同时只能有一个视频批次、一个关键帧批次、一个提示词任务。不同类批次在镜头不重叠时可以并发，例如 A 组镜头生成视频的同时，B 组镜头出关键帧。
- voice-batch 与 generate-video-prompts 不并发。
- Poster 只依赖资产，可与 P6–P14 任意时间并行；必须在导出前选定并通过审核。纪录片的 Poster 是必做步骤（#101），资产审核清单完成后就开始，不得等到导出前才补。

## 失效矩阵

| 改动 | 作废 |
|---|---|
| 旁白文本 | 配音、字幕、关键帧提示词、视频提示词、关键帧、确认、视频、合成 |
| 关键帧提示词或参考图 | 关键帧、关键帧审核、确认、视频、合成 |
| 视频提示词、时长、mid_frame_time | 视频提示词审核、视频、合成 |
| 视频 | 视频审片、合成 |
| 合成成品 | 合成审片 |

## 界面状态语义

- 剧情镜没有视频时，`compose_state=blocked`，界面显示“合成成品：阻断”。这是**被动未就绪**，不是执行失败，也不代表调用过合成。
- `compose-batch` 回执的 `scope.excluded` 会列出整集所有未入选的镜。
- 汇报时必须区分三种状态：未提交、被动阻断、提交后失败。（产品侧缺陷登记在 #98。）

## 交接与停止

- **正常交接**：先停止写入，再 `hbwf check` 读回终态，把 `workflow/state.json` 路径交给接手方。
- **立即停止或禁止新调用**：不再发任何请求，包括 GET。只保全在飞请求的回执，相关状态标为 unknown 或 derived。获准恢复后，第一步是 `hbwf check`。
- **传输异常**（`call` 退出码 3）：结果未知。**不得重发**。先 `hbwf check` 读回实际状态，再用 `decide reconcile --call-ids …` 认领，之后才能再发同一请求。
- 子 agent 同样受扩展与 hbwf 约束。父子 agent 都只经 `hbwf call` 写入，共用同一份账本。

## 已知边界

- 扩展靠文本特征拦截，不是安全沙箱；被刻意规避时依赖对账与终检兜底。
- eval prelude 的浏览器 helper 本身不触发 `tool_call`。扩展会拦截代码里同时出现 `/huobao/` 与 browser 的 eval。
- 派生一次约 50 秒（三次全集 preview + 任务中心分页），另加一次 `GET /episodes/{e}/roadmap`（服务端约 1.5–3.5 秒）；`status` 读缓存不联网。
