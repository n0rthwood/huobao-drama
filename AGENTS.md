# AGENTS.md

## 工作流程（必须先执行）

### 1. 先分类，再行动

收到需求后，必须先判断它属于哪一类，并明确是否会修改版本库、是否需要配置随版本升级：

| 类型 | 典型场景 | GitHub Issue | 执行要求 |
| --- | --- | --- | --- |
| 事务性需求 | 调查、解释、核验现状，不改代码或配置 | 不需要 | 调查后直接给出有证据的结论 |
| 代码性需求 | Bug、功能、重构，以及任何需要修改版本库才能实现的需求 | 必须 | 先澄清和调查，再建 Issue、评审，最后实施 |
| 配置性需求 | 修改运行配置、供应商配置、部署参数等 | 视配置位置而定 | 必须区分版本库内配置与版本库外配置，并明确升级时的同步动作 |

- **版本库内配置**：与代码一起提交、发布；任何修改都视为版本库修改，必须对应 GitHub Issue。
- **版本库外配置**：例如密钥、token、内网地址和本机运行配置；不得写入版本库或 GitHub Issue。若升级依赖这些配置，必须明确配置项、应用/迁移动作和验证方式。
- 一个需求横跨多类时，按其中约束最严格的流程执行。只要会修改版本库，就必须走完整的 Issue 与评审流程。

### 2. 需求澄清与调查

1. 先围绕用户需求做初步调查，不修改代码或配置。
2. 对已有证据足以确定的内容，用简洁、便利用户确认的方式复述；对不确定、冲突、边界不清或可能有多种解释的内容，必须明确询问用户，不能自行替用户决定。
3. 所有问题必须直接写在普通回复中，**不得使用 omp 问题对话框**。使用 omp web/omp 可正确渲染的 Markdown，以标题、编号、列表和必要的表格明确区分：
   - 已确认的目标；
   - 调查到的现状与证据；
   - 尚待确认的问题；
   - 预计涉及的代码、配置及升级影响。
4. 得到用户确认后，继续做代码和运行现状核验，确保用户意图、现有实现和修改逻辑相互一致；不能以未经代码验证的推测代替事实。
5. 给用户的本机服务链接必须使用当前工作站可访问的 LAN 主机地址，并保留实际端口和路径，不要给 `localhost` 链接。主机地址从运行环境获取，禁止硬编码或提交内网 IP。
6. 涉及图像时，必须先通过读取工具打开并确认图像内容，再据此说明；读取结果也应让 omp 界面直接渲染给用户查看。

### 3. 创建 GitHub Issue

任何版本库修改开始前，必须使用 GitHub 工具创建或关联一个 Issue。若用户已给出 Issue，则进入第 6 节的执行流程，不重复创建。默认使用 `gh` CLI 读取、创建和评论 Issue，以减少 MCP tool schema 的上下文开销；`gh` 不可用时才改用 GitHub tool。

Issue 必须：

- 按实际性质标记为 Bug、Feature 或相应类别；
- 记录用户已经确认的目标、范围、验收结果和明确不做的内容；
- 记录调查核验后的代码现状、相关入口、约束和根因（适用于 Bug）；
- 区分版本库内配置与版本库外配置，禁止包含密钥、token、真实凭据等敏感信息；
- 给出与现状一致的修改思路、受影响范围、配置升级动作和验证方式；
- 不得加入用户未要求且没有必要的扩展设计。

### 4. Issue 方案的一次性评审

Issue 整理完成后、实施前，必须让 **Fabel（Anthropic）或 Astra（GPT）** 做一次 one-shot review。

- Reviewer 只能看到 Issue 中已经整理好的用户意图、调查后的代码现状和修改逻辑；不得读取仓库、文件、工具输出或任何额外上下文。
- Reviewer 只评审现有信息能否满足最终用户需求，不负责补充调查、修改方案、询问用户或执行代码。
- Reviewer 的输出必须先明确列出以下五项结论，再给详细意见：
  1. 是否需要提出更好的思路和改进意见；
  2. 是否存在额外的 over-engineering；
  3. 是否遗漏用户需求；
  4. 是否在用户意图未明确时擅自做了决定；
  5. 是否存在调查不足。
- 评审只执行一次。将评审意见评论到对应 GitHub Issue，并在评论中注明模型名，以及评审上下文仅限 Issue 内整理的用户意图、代码现状和修改逻辑。
- Reviewer 若发现问题，只提供评审意见；后续执行 Agent 负责判断是否需要补充调查、修改逻辑或再次向用户确认。

### 5. Issue worktree 与提交

每个新 Issue 都必须从干净、最新的远程基线开始，并在独立 worktree 中完成：

1. 开始前执行 `git status --short --branch` 并获取最新 `origin/master`。不得直接在主工作区实施 Issue。
2. 从 `origin/master` 创建 Issue 分支和独立 worktree，例如：`git worktree add ../huobao-drama-issue-<n> -b issue/<n>-<slug> origin/master`。
3. 主工作区 dirty 时，严禁用 `reset --hard`、`clean` 或覆盖文件来制造“干净”状态。保留用户改动，并仍从最新 `origin/master` 创建 worktree；只有明确属于该 Issue 的改动才可通过有保留副本的 stash/patch/复制迁入。
4. 调查后的所有实现、验证和 commit 都在 Issue worktree 中完成。提交按功能逻辑拆分并引用 Issue，禁止把无关改动混入。
5. Issue 完成后，**总是**将 Issue 分支合并到本地 `master` 并推送到 `origin/master`，无需再次询问用户。合并前先同步远程；禁止 force-push，远程有新提交时先安全 rebase/merge Issue 分支并重新验证。
6. 只有 `origin/master` 已包含对应提交、主工作区已同步且 worktree 内无未提交改动后，才能删除临时 worktree 和保留副本。

### 6. 根据既有 Issue 执行

用户提供 Issue 时：
1. 先读取 Issue、已有评论和 one-shot review 结果。
2. 结合评审意见判断是否需要补充调查或向用户澄清。涉及用户目标、范围或取舍且仍不明确时，必须先直接列出问题等待确认。
3. 若 Issue 已足够清晰，可直接执行。Reviewer 对现有逻辑错误给出的明确纠正，不涉及新的用户取舍时，不需要再次询问用户；按纠正后的逻辑实施，并在完成后告知用户。
4. 实施、验证和配置同步必须覆盖 Issue 中的全部验收条件；不得把 Reviewer 的建议自动扩成 Issue 范围之外的工作。

### 7. 浏览器 QA

- 本项目 Web QA 统一使用 **`agent-browser` CLI + 它随当前安装版本提供的 `dogfood` skill**。开始前先运行 `agent-browser skills get dogfood`；详细命令见 `docs/agent-browser-qa-reference.md`。
- 常规 QA **不得启动 `agent-browser mcp`**。直接使用 CLI，避免 MCP tools schema 持续占用上下文。
- `browser39` 只用于网页搜索、资料和静态内容提取；它不执行被测 SPA 自身的 Vue/React 运行时代码，也没有完整视觉与运行时调试能力，**不得用于产品 QA 结论**。
- 每个 QA 任务必须使用 worktree 派生的命名 session，禁止共享默认 session：`export AGENT_BROWSER_SESSION="$(agent-browser session id --scope worktree --prefix huobao-qa)"`。
- 默认使用文本输出和 `snapshot -i -c`；只读内容优先 `read`，连续观察优先 `snapshot --delta`，复杂页面用 `-s`/`-d` 缩小范围。除非脚本需要，避免 `--json`。
- 页面变化后重新 snapshot，再使用最新 `@eN` ref；等待明确的文字、URL、元素或 JS 条件，禁止用固定 sleep 代替状态判断。
- UI 验证必须同时覆盖真实交互和视觉结果：需要视觉证据时使用 `screenshot --annotate`，重复截图使用 `--if-changed`，并通过读取工具实际查看图像后才能下结论。
- 每次 smoke 至少检查 `errors`、`console` 和关键请求；发现问题时立即保留可复现步骤和截图。结束时执行 `agent-browser close`。

火宝短剧（Huobao Drama）：AI 短剧一站式制作（小说 → 剧本 → 资产提取 → 生图 → 分镜 → 生视频 → FFmpeg 导出）。
项目结构、命令与架构总览见 `CLAUDE.md`，本文件只记录 Agent 开发时容易踩坑的补充信息。

## 开发服务

- 前端 Nuxt dev：`0.0.0.0:3013`，`strictPort: true`（端口被占会直接报错，不会漂移到 3014）。`host: true` 会让当前 Nuxt 版本崩溃，必须写字符串 `'0.0.0.0'`。
- 后端 Hono：`5679`。根目录 `npm run dev:backend` 已固定 `PORT=5679`（本机环境变量可能带 `PORT=5010`，属于 omp web UI）。
- 本机只应有这两个监听；验证：`curl localhost:3013/api/v1/health`、`curl localhost:5679/api/v1/health`。

### 进程管理：pm2（不要用 omp 会话跑 dev 服务）
- 前后端 dev 服务（保留热加载）由 pm2 管理，配置 `ecosystem.config.cjs`（`huobao-backend` 5679、`huobao-frontend` 3013）。omp 会话/daemon 结束后进程会跟着丢，所以**不要**用 omp 的 bash service/daemon 启动它们。
- pm2 装在 `~/.local`（全局 `/usr` 无写权限，不要 sudo）。**一律通过 `scripts/pm2.sh` 调用**：`scripts/pm2.sh start ecosystem.config.cjs | restart all | stop all | status | logs huobao-backend`。
- **环境变量隔离（重要）**：pm2 daemon 与子进程继承启动它的 shell 环境，omp 会话里有 `PORT`、`OMP_WEB_*`、`OMPCODE`、`NODE_ENV` 等变量。`scripts/pm2.sh` 用 `env -i` 清空环境，只传 `HOME/USER/LANG/PATH`；**不要直接敲 `pm2`**（哪怕只是 `pm2 -v`，也会拉起带污染环境的 daemon；误操作后 `scripts/pm2.sh kill` 再重启）。后端的 `PORT=5679` 写在 `ecosystem.config.cjs` 的 `env` 里。
- 验证无泄漏：`for p in $(pgrep -f "tsx.*src/index|nuxt"); do tr '\0' '\n' < /proc/$p/environ | grep -E '^OMP'; done` 应无输出。
- 开机自启未配置（需 root）：自行执行 `pm2 startup` 打印的 sudo 命令，再 `scripts/pm2.sh save`。

## 敏感配置规则（重要）

- 密钥、内网地址、token **一律放仓库外** `~/.config/huobao-drama-local/`（可用 `HUOBAO_LOCAL_CONFIG_DIR` 覆盖，目录 700、文件 600），**不得提交**。
  - `providers.json`：AI 服务配置（含 key），格式见 `backend/scripts/local-config.example.json`。
  - `codex-image.json`：codex 生图包装服务的端口/token/并发。
- 应用配置：`cd backend && npm run apply-local-config`（按 `service_type + provider + name` 幂等写入 SQLite `ai_service_configs`）。
- 代码与预设中不要写内网 IP 或真实 key。
- **升级到 qwen-jobs（2026-10-27，必须手工同步一次）**：
  1. `~/.config/huobao-drama-local/providers.json` 里图片服务条目的 `provider` 从 `comfyui` 改成 `qwen-jobs`（`base_url` `https://110.joyai.dev/image`、`api_key`、`model` 不变）。
  2. 本地库 `ai_service_configs` 的现有图片行**原地**改 provider，保留行 id（`episodes.image_config_id` 指向它，新建行会让集锁定失效）：
     `UPDATE ai_service_configs SET provider='qwen-jobs', updated_at=datetime('now') WHERE service_type='image' AND provider='comfyui';`
     不要靠 `apply-local-config` 完成这一步——它按 `(service_type, provider, name)` upsert，会新建一行。
  3. 110 侧已把 ComfyUI 原生接口收到 qwen-jobs 后面，旧的 `/image/prompt`、`/image/history` 路径不再可用。

## 供应商（Provider）架构

- 文本：`backend/src/agents/index.ts` `getModel` 统一走 `createOpenAI(...).chat`（`/chat/completions`）。`services/ai.ts` `getTextProviderBaseUrl`：openai 的 base URL 若已以 `/v<数字>` 结尾（如智谱 `…/paas/v4`）则原样使用，否则补 `/v1`。
- 图片 / 视频：`backend/src/services/adapters/` 每个厂商一个 adapter，在 `registry.ts` 注册；新增 provider 需同步：adapter 文件、`registry.ts`、`services/ai.ts` 的 `officialProviders`、`routes/aiConfigs.ts` 的 `buildProbe`、前端 `settings.vue`（providers 与预设）与 `episode.vue`（分辨率档位映射）。
- 视频 adapter 可选 `prepare(config, record)`：提交前的异步预处理（上传参考图、扩写提示词），抛错会作为任务失败原因落库；`parsePollResponse(result, config)` 可拿到 baseUrl 构造结果地址。
- `storage.ts getExtFromUrl` 会读 URL 的 `filename` 查询参数取扩展名（ComfyUI `/view?filename=x.mp4`）。

## 本机后端

### 文本：GLM 5.3
- 配成 `text / openai`，base URL `https://open.bigmodel.cn/api/coding/paas/v4`（智谱 coding 套餐专用端点），模型 `glm-5.3`，key 来自环境变量 `ZHIPU_API_KEY`（写入本机 `providers.json`）。
- GLM-5.x 始终思考：`agents/index.ts` 的 `isOfficialTextHost` 包含 `open.bigmodel.cn`，不会注入 `thinking: disabled`（否则 400）。
- reasoning 与 content 共享 `max_tokens`，项目默认注入 16384，不要调小。**本机 `backend/.env`（不入库，dotenv 加载）设 `AI_MAX_TOKENS=32768`**（2026-10-28，#15 live 落地）：#15 的拆分镜规则变长后，长剧集（5 镜 × 4 条提示词）在 16384 下推理 + 输出会在调用 `save_storyboards` 之前被截断，表现为「Agent 正常结束但什么都没保存」；GLM coding 端点实测接受 32768。重建本机环境时要同步这一项。

### 图片：GPT Image（codex 包装服务）
- `tools/codex-image/server.mjs`：本机常驻、OpenAI 兼容（`/v1/images/generations`、`/v1/images/edits`、`/v1/models`、`/health`），监听 `127.0.0.1:<port>`，Bearer token 鉴权。
- 每个请求 one-shot 调 `codex exec --skip-git-repo-check -C <tmp> --sandbox workspace-write "$imagegen …"`；**提示词必须在 `-i` 之前**。图片由 codex 写到 `~/.codex/generated_images/<session-id>/`，session id 取自 codex 输出的 `session id:` 行，按会话目录取图，并发互不串图。
- 常驻：`systemctl --user status huobao-codex-image`（unit 在 `~/.config/systemd/user/`，不入库）。
- 主项目配成 `image / openai`，base URL `http://127.0.0.1:<port>`，key 为 `codex-image.json` 里的 token。

### 视频：MiniMax H3（ComfyUI）
- provider `comfyui`：`adapters/comfyui-video.ts` + `comfyui-workflows.ts` + `h3-prompt.ts`；工作流模板在 `backend/src/workflows/h3/{t2v,firstlast,reference}.json`（ComfyUI API 格式，按固定节点 ID 填参数，随 JSON import 打进 bundle）。
- 流程：`prepare`（扩写提示词 → 等引擎队列空 → 上传参考图 `/upload/image`）→ `POST /prompt` → 轮询 `/history/{id}` → `/view` 下载。
- 模式：无图 t2v（8 步 + turbo LoRA）；首帧（可选尾帧）firstlast（同上）；参考图 reference（标准变体用基础 ref2va 权重、无 LoRA、**20 步**：4 步实测背景是未收敛的噪点，20 步清晰且耗时几乎不变；int8 变体用 fused refdelta 4 步蒸馏）。不支持参考视频/音频。
- **参考图 + 首/中/尾关键帧引导**：reference 模式下关键帧不占 Picture 之外的名额也不会被丢弃，`buildReference` 追加 `LoadImage + MiniMaxH3AddGuide`（首帧 `frame_idx=0`、中间帧 `frame_idx=round(mid_frame_time×24)` 按 17k+5 帧网格钳到 `[1, frames-2]`、尾帧 `frame_idx=-1`，串在 `MiniMaxH3ReferenceToVideo` 之后，最后把 `BasicGuider.conditioning` 指到末个引导节点；latent 永远取 `ReferenceToVideo` 的输出 1）。引导帧**不占用 Picture 编号**，`@图片N` 映射照旧。102 实测（fused refdelta int8 路径，12 秒 4 子镜头）：首帧既作 `<Picture 1>` 又作第 0 帧引导、中间帧与尾帧只作引导，首/中/尾命中 SSIM **0.932 / 0.946 / 0.947**，只在提示词切镜点跳变；三张都作 Picture 无额外收益且白占参考图名额；只作引导不作 Picture 时开头 3–8 帧会"瞬移"。
- **提示词契约（质量关键）**：H3 引擎逐字分词，必须是英文三段式 `integrated_multimodal_description / overall_soundscape / non_diegetic_music`（关键帧对齐声明由代码生成：`<Picture 1> is the first frame … at 0.00 seconds` + 中间帧时间点 + 尾帧结束时间）。裸中文会导致画面发糊。`buildH3Prompt(prompt, mode, durationS, { hasFirst, midTime, hasLast })` 对非契约文本用当前文本模型（GLM）扩写，失败即报错，不回退为裸提示词；GLM 规则为"精确从 `<Picture 1>` 开场、在中间帧时间点切镜落到中间关键帧、结尾停在尾帧"，并强制**以图片为准**（见下）。
- 服务器资料（2026-10-26 起）：**唯一视频实例在 `.102` tcs3（RTX 3090）**，2026-10-27 起经路由器 DNAT `http://tianan2.riadev.top:10280/video` 访问（Basic auth，`.164` 实测上传 ~19 MB/s）；**不要用** Cloudflare 隧道 `https://102.joyai.dev/video`——上行只有 ~32 KB/s，4 张参考图并行上传超过 `uploadImage` 的 120 s 超时（任务 #80/#92 `The operation was aborted due to timeout`）。模型名 `MiniMax-H3-INT8-ComfyUI` 触发变体模板 `workflows/h3-int8/{t2v,firstlast,reference}.json`（fl2va int8 convrot + fused refdelta int8 + qwen3vl nvfp4_awq + turbo 8 步 LoRA）。参考图模式走 fused refdelta，无需 `ref2va`。bf16 实例（原 `.175`）已随 GPU 重排退役。引擎串行执行。
- 网关鉴权：base URL 走公网入口（`tianan2:10280` 或 Cloudflare 隧道）时 Caddy 要 HTTP Basic auth；凭据只存 `ai_service_configs.api_key`（格式 `user:password`，含冒号即 Basic），`comfyui-client.ts` 的 `authHeaders` 会在队列/上传/提交/轮询/`/view` 下载全程带上。口令绝不入库/入文档。

### 资产管理器（跨集复用 / 跨项目导入，Issue #9）
- 资产属于**项目**（`characters/scenes/props.drama_id`），剧集通过 `episode_*` 关联表拥有资产；历史版本 = `sys_task`（`type='image' AND status='completed'`，owner 指向资产），当前版本 = 资产行 `image_url`。
- 唯一实现 `services/asset-library.ts`（版本装配 `loadImageVersions()` 也被 `routes/episodes.ts` 复用）：
  - **本项目内复用 = 关联同一资产**：`POST /episodes/:id/assets/link {kind, asset_id}`（幂等；跨项目资产拒绝；本集已有同名资产拒绝，因为 `@提及` 同名先到先得），`DELETE /episodes/:id/assets/link?kind=&asset_id=` 取消关联（不删资产）。
  - **跨项目 = 全量复制**：`POST /dramas/:id/assets/import {kind, source_id, name?, episode_id?}` 复制文本字段 + 当前图 + 全部历史版本 + 参考图（都是新 uuid 文件），源与副本此后互不影响。复制出的版本行 `provider='import'`（常量 `IMPORTED_TASK_PROVIDER`），原 provider/model/task id 记在 `params.imported_from`，**保留原 `created_at`/`completed_at`/`generated_at`**、参考图保留原 `uploaded_at`（全量复制，历史时间不变）；派生字段重置（`scenes.storyboard_count=0`、`status` 按有无图重算、`characters.sort_order` 追加末尾、`scenes.episode_id=null`）。
  - 同名冲突**强制改名**（角色/道具比 `name`、场景比 `location`，与 `@` 解析口径一致），默认 `名字-2`、`名字-3`…：规则是纯函数 `suggestUniqueName()`，前端同源实现在 `frontend/app/utils/assetName.js`，`GET /asset-library/suggest-name?kind&drama_id&name` 也给同样的结果。
  - 源文件缺失只跳过该版本/参考图并在结果里计数（`skipped_versions`/`skipped_reference_images`），外部 http 地址原样保留；只有真正的 IO 失败才整体**补偿回滚**（删掉本次插入的资产行、sys_task 行、关联行和复制出的文件，接口返回 500「导入失败，已回滚：…」）。
  - 浏览接口 `GET /asset-library?drama_id&kind&q&target_drama_id`（`target_drama_id` 额外返回目标项目已占用的名字）与 `GET /asset-library/:kind/:id`（文本字段 + 全部版本 + 参考图 + 所属剧集）。
- 导入产生的版本行按 `provider='import'` 排除出全局任务中心（`services/task-center.ts`）。
- 前端唯一组件 `components/AssetBrowserDialog.vue`，两个入口都显式 import：剧集资产页工具栏「从资产库导入」（本项目 → 关联，其他项目 → 复制并关联到本集）、项目素材库页「从其他项目导入」（只复制，不关联，左栏不显示本项目）。已在本集的资产标「已在本集」且不可选。

### 素材管理器（历史图片浏览与选用，Issue #10）
- 与「资产管理器」互补：资产管理器复制**整个资产**，素材管理器只复制**一张图片**（与源资产的文本、版本无任何关系）。
- 唯一实现 `services/media-library.ts`：`collectLibraryImages()` 一次扫描建立「可见图片全集」，树的计数、分页列表、复制接口的白名单校验共用同一份结果。来源三类：完成的图片任务（资产版本 / 分镜首中尾关键帧）、资产 `image_url` 里没有对应任务的 legacy 图、各资产已上传的参考图；只列磁盘存在的文件，软删项目/剧集/资产与已删版本不出现。资产归集走 `episode_*` 关联表，关键帧经 `storyboard_id → storyboards.episode_id`（存量 `sys_task.episode_id` 为空，不可依赖）。
- 接口：`GET /media-library/dramas`、`GET /media-library/tree?drama_id=`（懒加载第二层）、`GET /media-library/images?drama_id&episode_id&kind&owner_id&slot&page&page_size`、`POST /media-library/copy {url}` → `{url, path, copied_from}`（结构同 `/upload/image`）、`POST /{characters,scenes,props}/:id/reference-images/from-library {urls}`。**复制类接口一律先过白名单**（`assertLibraryImage`，不在素材库内一律 403），库外的任意服务器路径无法插入。
- 选图 = 一次「新上传」：资产图 → `POST /tasks/register-upload`（`source='media-library'`，`params={source,copied_from}`）注册为新版本并设为当前图，`generated_at` 取选择时刻；参考图 → 复制进该资产自己的参考图目录，条目写 `{path, uploaded_at=选择时刻, copied_from=源图相对路径}`。`copied_from` 只由 from-library 写入，用于同一资产同源去重；超上限（`REFERENCE_IMAGE_MAX_COUNT`）整批拒绝，不复制半份。参考图读写仍只经 `services/reference-images.ts`。
- 项目素材库页的上传与剧集资产页一致：`uploadAPI.image → taskAPI.registerUpload`，都会多出一个 `provider='upload'` 的版本。
- 前端唯一组件 `components/MediaLibraryDialog.vue`（显式 import）：参考图入口多选并显示上限，资产图入口单选；入口在 `ReferenceImageManager.vue`、`episode.vue` 资产卡片与详情弹窗、`detail.vue` 素材卡片与编辑弹窗。

### 分镜关键帧与视频
- 流程：资产 → 拆分分镜（含分镜提示词）→ **分镜关键帧（独立步骤，人工确认）** → 视频 → 导出。旧的"提取上一镜视频尾帧承接"已整体删除（`extractVideoTailFrame`、`episodes.continuity_enabled`、`storyboards.continuity_mode` 均不再存在）。
- 数据：`storyboards` 的 `first_frame_prompt / mid_frame_prompt / last_frame_prompt`（每张关键帧各自的提示词）、`mid_frame_time`（秒，必须落在 0.5 与 时长-0.5 之间，PUT 越界报 400）、`first_frame_image / mid_frame_image / last_frame_image`（各槽位选定版本）、`keyframes_confirmed`。版本 = `sys_task`（type=image，`params.frameType` 为 `first_frame/mid_frame/last_frame`），默认选最新生成的那张。保留 LLM 标注的 `continuity_boundary`（continue/cut）。`image_prompt` 不迁移、不再写入。
- 规则唯一实现在 `services/keyframes.ts`：上一镜 = 同集内未删除、按 `storyboard_number` 排序的前一镜，第一镜永不继承；`continuity_boundary='continue'` 且自己没有首帧图 → **继承上一镜的尾帧关键帧**（`inherits_first`）。就绪 = 有效首帧 + 尾帧都有图，且"写了中间帧提示词的分镜必须有中间帧图"。确认 = 已就绪且人工点过确认；任一槽位选定图变化（新图生成完成、切换版本、改继承）自动取消确认，并连带取消继承它的下一镜；删除分镜时继承首帧的下一镜也取消确认。
- **参考图 ↔ 提示词一致性（唯一实现 `services/storyboard-assets.ts`）**：4 个提示词字段（`first/mid/last_frame_prompt`、`video_prompt`）里的 `@名字` 按本集资产名（非旁白角色、道具、场景）**最长优先**匹配。任一提示词被写入（`PUT /storyboards/:id`、`POST …/keyframes/:slot/generate` 带 prompt、Agent 的 `update_storyboard`/`save_storyboards`）后，**角色/道具绑定 = 4 个提示词 @ 到的并集**（同请求里显式传的 `character_ids/prop_ids` 以提示词为准被覆盖；4 个提示词全空时不动绑定；场景永不自动改）。`checkStoryboardRefs` 输出 `ref_issues`：阻断 = `missing_image`（@ 到的资产没有可用图）、`unbound_mention`（@ 到但未绑定）、`scene_conflict`（@ 了非绑定场景）、`unknown_mention`（@ 的不是本集资产）；警告 = `unmentioned_binding`（绑了但没 @，下次保存会解绑）、`over_capacity`（装配后超 9 张被截断，视频侧首帧再占 1 张）。每个分镜 JSON 都带 `ref_issues` 与 `field_saved_at`；`PUT /storyboards/:id` 返回 `{saved_at, character_ids, prop_ids, scene_id, ref_issues, ref_sync:{bound,unbound}}`。
- **提取规则的唯一事实来源（Issue #15）**：角色/场景/道具的判定标准、必提类别、命名与描述写法**只写在** `backend/workspace/prompts/extractor*.md` 与 `backend/workspace/skills/extractor/**`（含子技能 `extractor/prop-extraction`，按 `AGENT_SKILL_MAP` 目录前缀自动注入，新增子目录不用改代码）。`services/extraction.ts` 的 `EXTRACT_MESSAGES` 只剩「提取哪一类」的一句话，**不得**再写任何判定规则（旧版三处规则互相矛盾，导致整部剧 0 个道具）。分镜侧同理：`storyboard-breaker/prop-continuity`、`prompt-generator/{keyframe,video,prop,character}-prompt`。
- **分段资产锚定规则（2026-10-28，Fabel 原文，#15 live 落地）**：`video-prompt` / `keyframe-prompt` / `prop-continuity` 三个 skill（各 4 语言）规定——每个 3 秒段（含 #11 的开场转场段，不豁免）必须 `@` 本镜绑定的**场景**；段内仍在画面中的绑定资产（背景/虚化/镜中/静止物）逐段 `@` 并带可见性短语；`@道具` 的句子必须含辨识性要素（功能部位 / 握持点 / 使用动作），弱静态动词不合规；禁止裸文本指代（“画外穿衣镜”→“@落地穿衣镜（画外）”）与集体称呼首指（“父母/两人”）。段内缺场景 @、在场资产漏 @ 曾导致 E3#4 父母被顶替、房间漂移、遥控器变手柄；同类画面漂移应**先改规则、经正常流水线重出提示词**，不做单镜手工补丁。
- **角色造型版本（Issue #15，Q1=B）**：成套服装不做道具，而是本集的造型版本，存 `episode_characters.styling_version`（JSON `{name, description, image_path}`，`services/styling-version.ts` 唯一读写）。提取侧由 `save_dedup_characters` 的可选入参 `styling_version{name,description}` 写入；出图走 `POST /characters/:id/styling-version/generate-image`（以角色基础形象图做 image_edit，`sys_task` 带 `params.characterVersion`，完成后只回写 `image_path`，**不动** `characters.image_url`）。分镜取图优先级 = 人工 `asset_version_selection` > 本集造型图 > 资产当前成片图，`autofillCostumeSelection()` 在提示词同步时把造型图写进该镜的 `asset_version_selection`（已有人工选择不覆盖）。帽子/眼镜/头盔等可单独穿脱的配件仍是道具。
- **基础形象不被单集覆盖（Issue #15）**：`save_dedup_characters` 合并时 `appearance`/`styling`/`role`/`description` 只补空白字段，已有非空值保留，被忽略的改写在工具返回值 `ignored_overwrites` 里报告。`save_dedup_scenes` 返回 `near_location_hints`：地点互为前缀/包含时提示可能是同一物理空间，**只提示不自动合并**。
- **资产删除同步清关联（Issue #15）**：删除角色/场景/道具时 `services/asset-links.ts` 的 `deleteAssetLinks()` 一并删 `episode_*` 与 `storyboard_*` 关联行；启动时 `cleanupStaleAssetLinks()`（`db/sqlite-schema.ts`）幂等清理存量残留。
- **新增 `ref_issues` 码（Issue #15）**：阻断 `empty_video_prompt`（`video_prompt` 为空，只影响 `video_prompt` 字段，关键帧不受影响）；警告 `limb_risk`（`limbRiskIssues()` 纯函数：负向肢体写法「不要三条腿」、或高风险姿态/构图段落没写四肢状态；**永不进 `blockingIssuesFor`**）。
- **字段级保存时间**：`storyboards.field_saved_at`（JSON：字段 → unix 秒，`services/storyboard-fields.ts`）跟踪 `description/atmosphere/first_frame_prompt/mid_frame_prompt/mid_frame_time/last_frame_prompt/video_prompt`；PUT 与 Agent 写入这些字段时打点（整行 `updated_at` 会被生图回写污染，不能用）。相对时间文本由前端按本地时钟计算。
- 关键帧生成 `services/storyboard-keyframes.ts`：`buildKeyframeRequest(storyboardId, slot, opts)` 是单张/批量/预览共用的组装（参考图 = 场景 → 角色 → 道具的选定版本，**不含任何关键帧**，实测把首帧当参考图生成尾帧会崩坏；提示词 = 风格词 + 槽位提示词，`@名字` → Qwen 的 `<imageN>名字`、其它厂商 `图片N名字`；尺寸按剧集画幅 16:9=1344×768、9:16=768×1344、4:3=1152×864、3:4=864×1152、1:1=1024×1024）。该槽位存在阻断问题时直接抛错 → 单张生成返回 400 并列出问题。**内容签名** = sha256(最终提示词, 参考图文件名(按发送顺序), 尺寸, provider, model)；历史版本签名由其 sys_task 的 `prompt/provider/model/params.size/params.referenceImages` 反算（缺字段 → `null`，视为不匹配）。提交时把 `episodeId/sourcePrompt/refNameIndex` 一并传给 `generateImage`（任务中心重试据此换模型重渲染）。接口：`POST /storyboards/:id/keyframes/:slot/generate`（可带改过的 `prompt`，会打保存时间并同步绑定）、`GET …/versions`（返回 `version_no`（按创建时间正序从 1 编号）与 `signature`）、`PUT /storyboards/:id/keyframes/:slot`（`{image}` 选版本 / `{inherit:true}` 仅首帧）、`POST /storyboards/:id/confirm-keyframes`。
- 剧集批量 `services/keyframe-batch.ts` + `POST /episodes/:id/keyframe-batch/preview`、`POST|GET /episodes/:id/keyframe-batch`、`…/cancel`、`…/retry-failed`：**先预览再入批**。预览逐个“分镜 × 槽位”返回 `missing`（无图，默认勾）、`changed`（当前签名与所有历史版本都不同，默认勾）、`unchanged`（命中历史签名，带 `matched_version_no` 与 `selected_version_no`，默认不勾）、`blocked`（一致性阻断，不可勾，带 `issues`）、`skipped`（提示词为空 / 承接首帧无自有提示词 / 正在生成）；`storyboard_ids` 只缩小预览范围，不改勾选口径。启动接收 `items: [{storyboard_id, slot}]`，服务端复查，预览后才变成阻断/正在生成/提示词被清空的项**跳过并标注原因**，不让整批失败。**provider 为 `qwen-jobs` 时一次性提交全部待生成槽位**（每提交一张立即把 sys_task id 落盘，重启恢复不会重复提交），之后只跟踪各 sys_task 状态——三张关键帧互不作为参考图，并发安全；其它 provider 保持严格串行（提交 → 等 sys_task 终态 → 等写回 → 下一张）。停止 = 取消所有未结束项，`retry-failed` 对失败/已取消项**新建 sys_task** 重提。状态 JSON 除原有字段外还有 `eta_seconds`、`progress`、`counts` 与各项 `queue_position/progress/remaining_seconds/estimated_finish_seconds`；聚合是纯函数 `services/keyframe-batch-progress.ts`（有行为测试）。持久化在 `keyframe_batches`，重启由 `resumeKeyframeBatches()` 恢复。提示词补齐：`POST /episodes/:id/generate-keyframe-prompts` + `GET /episodes/:id/keyframe-prompts-status`。
- 视频闸门：单镜 `POST /storyboards/:id/generate-video` 要求该镜已确认（否则 400 `分镜 #N 的关键帧尚未确认`）**且 `video_prompt` 无阻断性一致性问题**（否则 400 列出问题）；批量**逐镜阻断**（Issue #12，不再要求全集确认）：预览把未确认/有阻断问题的镜头列为 `blocked` 且不可勾，其余照常批量；启动只检查所选镜头与「模型支持关键帧引导」，每一镜提交前再复查，变为阻断的那一镜标 `skipped` 并写原因，批次继续。
- 视频组装 `services/storyboard-video.ts`：参考图 = [生效首帧关键帧, 场景, 角色, 道具]（去重 ≤9），所以素材编号从 `@图片2` 起；首帧同时作为第 0 帧引导，中间帧（仅 `supportsMidFrameGuide` 的模型）与尾帧作引导帧。能力位：`supportsFrameGuides`（comfyui/minimax = true，volcengine = false，Seedance 直接报"当前视频模型不支持关键帧引导"）、`supportsMidFrameGuide`（仅 comfyui）。
- **视频内容签名**（Issue #12，`services/storyboard-video.ts`）：`computeVideoSignature()` 取 `buildStoryboardVideoRequest` 的**最终输出**算 sha256，分项摘要 = 提示词（含风格词，#11 的转场段也在其中）/ 引导帧文件名 + 中间帧时间 / 参考图文件名（按顺序）/ 提交时长（整数秒）+ 画幅 + 分辨率 / provider + model，所以往提交参数里加东西会自动纳入签名。`videoSignatureFromTask()` 从历史 sys_task 的 `prompt/provider/model/params` 反算（缺 `firstFrameUrl`、时长、画幅等 → `null`，归 `unknown`），`loadVideoVersions()` 按创建时间正序编号，`describeSignatureDiff()` 给出变化分项。承接镜头「转场未审核 → changed」不靠签名（转场文本提交前才生成），由 #11 在预览里按审核状态标注。
- **以图片为准（所有提示词层的硬规则）**：关键帧提示词、视频提示词、分镜描述与 H3 的 GLM 扩写都**不得**描述角色的物种、衣着、颜色、发型等外形属性；角色只用 `@名字`（提示词）或 `the character in <Picture N>`（H3）指代，名字只是昵称，不能据此推断外形。剧集 2 的"鼠妈妈 → 灰老鼠"就是文字与图片打架造成的。
- 服务端批量视频 `services/video-batch.ts` + `POST /episodes/:id/video-batch/preview`、`POST|GET /episodes/:id/video-batch`、`…/cancel`：**先预览再入批**，启动必须带预览勾选的 `storyboard_ids`（以及预览用的 `config_id/model`），没有「不带参数 = 全部未生成」的旧行为。预览逐镜返回 `missing`（没有任何版本，默认勾）、`changed`（与所有可比较版本都不同，默认勾，`change_reasons` 为分项中文名：提示词/关键帧/参考图/时长画幅/模型）、`unchanged`（命中任一历史版本签名，带 `matched_version_no`，默认不勾但可勾选强制重出）、`unknown`（历史版本都缺对比字段，默认不勾）、`blocked`（不可勾）、`skipped`（正在生成）；分类优先级 = 命中 → `unchanged`，否则有可比较版本 → `changed`，全缺字段 → `unknown`，无版本 → `missing`。批次按分镜顺序串行，状态持久化在 `video_batches`，重启由 `resumeVideoBatches()` 恢复（被打断的那一镜重新提交）。停止只是不再提交新的镜头，在跑的那一镜跑完后批次转 `cancelled`（没有 runner 时直接落盘 `cancelled`）。**写回等待**以任务终态为主、`storyboards.video_url === 任务 local_path` 为辅并保留 60s 超时——镜头本来就有旧视频时只看「非空」等于没等。
- 前端关键帧页（`components/StoryboardKeyframes.vue` + `views/drama/episode.vue`）：批量对话框先调 `POST /episodes/:id/keyframe-batch/preview` 拿「分镜 × 槽位」清单（`missing/changed/unchanged/blocked/skipped`，`checked` 为默认勾选），分组复选 + 全选/清空，耗时估计按勾选数重问 `/image-queue/estimate`，启动时提交显式 `items`；「选择」模式只缩小预览范围。版本下拉显示 `version_no`（第 N 版），`unchanged` 显示「同第 N 版（当前选中第 M 版）」。
- 前端视频页批量（`views/drama/episode.vue`）：「批量生成视频」先调 `POST /episodes/:id/video-batch/preview` 拿逐镜清单（`missing/changed/unchanged/unknown/blocked/skipped`，`checked` 为默认勾选，`selectable=false` 的不可勾），复选 + 全选/清空，`unchanged` 显示「与第 N 版相同」、`changed` 显示「变化：提示词/关键帧/…」，确认后只提交勾选的 `storyboard_ids`；没有 `!hasVid` 的本地过滤，也不再按「全集关键帧确认」禁用按钮（只有批次运行中才禁用）。
- 一致性问题（后端 `ref_issues`，`message` 直接展示）：关键帧页参考图区与各槽位、视频页视频提示词下方常驻列表，列表行显示问题计数；提示词保存 / 绑定切换 / 资产版本切换后只 toast **新增**的问题，`ref_sync` 的自动绑定/解绑各 toast 一次。阻断问题会禁用对应槽位与视频的生成按钮（title 给原因），服务端 400 的中文原因由 `toastServerMessage` 原样展示。
- 字段保存反馈：`episode.vue` 的 `updateField` 返回 Promise，按（分镜, 字段）维护状态（`有未保存的修改 / 保存中… / 已保存 · N 秒前 / 保存失败`），加载时用 `field_saved_at`（unix 秒）显示「上次保存 · N 分钟前」；相对时间由 `components/FieldSaveStatus.vue` 用 `useNowTicker()` 的 1s 共享心跳本地计算。覆盖画面描述、氛围、首/中/尾提示词、中间帧时间、视频提示词。
- `components/MentionTextarea.vue`：透明 textarea 叠在高亮镜像层上，两层都设 `scrollbar-gutter: stable` 且 `@引用` 不加粗——否则出现滚动条后两层换行位置不同，光标会逐行偏移（实测末行差 ≈3 个汉字）。

### 图片生成（Qwen Image 2.1 / qwen-jobs）
- 入口：`.110`（2×RTX 3060）的 `https://110.joyai.dev/image`（Cloudflare 隧道 + HTTP Basic auth，凭据只存 `ai_service_configs.api_key`，格式 `user:password`，火宝用 `huobao` 账号）。LAN 备选 `http://172.30.3.110/image`（免鉴权）。ComfyUI 不再对外暴露，它是该服务的私有 worker（每卡一个，一次一张）。
- provider 叫 **`qwen-jobs`**：服务端持久化排队、跨应用公平调度（火宝/studio 轮流出队）、按任务 ID 查询与取消、按分辨率实测时间估计。应用**不再提交工作流**，只传参数，三种固定模式：无参考图 → `text_to_image`（`pickQwenSize`：对齐 32、总像素 ≤2048²）；有参考图且是关键帧（`frameType` 命中槽位）→ `reference_to_image`（按剧集画幅出图）；其余有参考图 → `image_edit`（输出跟随第 1 张参考图，用于角色/道具）。提示词用 `<image1>` 指代参考图，没写时自动补前缀；参考图最多 9 张。
- 客户端 `adapters/qwen-jobs-client.ts`：`POST /v1/files`（按 sha256 进程内缓存 file id）、`POST /v1/jobs`（幂等键 `huobao-sys_task-<id>-<uuid>`，首次提交时生成并随请求体落盘；只用 id 会在数据库拷贝/重建后撞键）、`GET /v1/jobs?ids=`（≤100 批量）、`POST /v1/jobs/{id}/cancel`、`DELETE /v1/jobs/{id}`、`GET /v1/jobs/{id}/outputs/{n}`、`/v1/capacity`、`/v1/estimate`。
- 生命周期：`generation.ts` 提交前把完整请求体写进 `sys_task.remote_state.request`（含已上传的 file id）再调远端，拿到远端 id 立即落盘 `task_id`；之后由常驻追踪器 `services/qwen-jobs.ts` 每 3 s 批量查询，回写 `status`（queued→`queued`、running→`processing`）与 `remote_state`（排队位置/进度/估计）。成功时**先取回字节落盘再标 `completed`**（服务端取回即删，再取 410）。**没有客户端超时**：20 分钟超时与 worker 掉线由服务端处理。网络错误/5xx/网关 530 一律当瞬时故障下轮重试，只有远端 failed/cancelled、记录消失（连续 3 轮查不到）、输出已回收（410）才是终态。
- 重启恢复：`index.ts` 的启动清理**跳过** qwen-jobs 的活跃任务；有 `task_id` 的由追踪器继续跟，没有 `task_id`（提交途中重启）的按同一幂等键原样重发（服务端去重，不会重复跑）。任何**重试都必须新建 sys_task**（新幂等键），否则服务端会直接返回原任务而不重跑。
- 任务状态：`sys_task.status` 为 `queued | processing | completed | failed | cancelled`，活跃判断一律用 `isActiveTaskStatus()`（`services/sys-task.ts`）。所有返回任务的接口用 `serializeTask()` 输出 snake_case + 已解析的 `remote_state`（剥掉内部键 request/config_id/idempotency_key）+ `cancellable`。`POST /tasks/:id/cancel` 取消（非 qwen-jobs 返回 400）；`GET /image-queue/estimate?config_id&size&references&count` 给前端等待估计（整批 = 当前等待 + ⌈张数 / 在线卡数⌉ × 单张，在线卡数 = total − offline）。
- 速度参考（3060，25 步）：1024² ≈ 90 s，1344×768 三参考图关键帧 ≈ 175 s。模型：azukivc Q6_K GGUF + Comfy-Org int8 convrot 文本编码器 + bf16 VAE（固化在服务端，仓库里不再有工作流模板）。

### 全局任务中心
- `sys_task` 多了 `episode_id`（分镜任务由分镜反查、资产出图取发起时所在集、文本任务必填；启动时 `backfillTaskEpisodeIds()` 按 `storyboard_id` 回填存量行）与 `type='text'`。**文本任务不再存进程内存**：提取（`services/extraction.ts`）、关键帧/视频提示词批量（`keyframe-prompts.ts`/`video-prompts.ts`）、同步 chat 的剧本改写与拆分分镜（`routes/agent.ts`）都在开始时建 `sys_task(type='text')`，`params.kind` ∈ `extract_characters|extract_scenes|extract_props|keyframe_prompts|video_prompts|script_rewrite|storyboard_breaker`，进度写 `params.progress`（`{completed,total,failed,current_storyboard_id}`，**不复用 `remote_state`**，那是 qwen-jobs 追踪器的）。`/extract-status`、`/keyframe-prompts-status`、`/video-prompts-status` 响应结构不变，只是改成从库里读（函数变成 async）。
- 重启：启动清理对 `type='text'` 的活跃任务一律标 `failed`（`error_msg='后端重启中断'`，`failInterruptedTextTasks()`），不自动重跑；图像/视频规则不变（qwen-jobs 交追踪器、其它 provider 标失败、批次照旧恢复）。
- 接口（`routes/tasks.ts`，`/center` 与 `/active` 必须注册在 `/:id` 之前）：`GET /tasks/center?drama_id&episode_id&type&status&scope&page&page_size`（默认 `scope=recent` = 进行中 ∪ 最近 7 天，`page_size` ≤200）返回 `{items,total,page,page_size}`；`keyframe_batches`/`video_batches` 是 `row_type='keyframe_batch'|'video_batch'` 的父行（带 `progress/counts/children`），子任务不在顶层重复，`video_merges` 是 `row_type='video_merge'` 的导出行（无重试）。`GET /tasks/active` 给顶栏轮询（扁平全部活跃任务 + 顶层 `active_count`）。`GET /tasks/:id` 返回同样的增强行。扁平 `GET /tasks`（精确过滤）保持原样给老调用方。旧的 `GET /episodes/:id/generation-tasks` **已删除**。
- 增强行（`services/task-center.ts`）= `serializeTask()` + `params`（对象）+ `episode_id/drama_title/episode_number/storyboard_number/target_kind/target_name/frame_type/kind/progress/retry_of/label/row_type`。编号 `label` 由服务端用 `services/task-label.ts`（纯函数，可单测）拼：分镜 `《剧名》E02-#05 · 首帧|中间帧|尾帧|视频`、资产 `《剧名》· 角色|场景|道具 · 名字`、集级 `《剧名》E02 · 拆分分镜|…|关键帧批量|视频批量|导出合成`。
- 换模型重试 `POST /tasks/:id/retry {config_id?, model?}`（`services/task-retry.ts`）：**只改模型/配置，提示词只读**，一律新建 sys_task（`params.retry_of` 记来源）。图片/视频沿用原 `params`（参考图、尺寸、帧类型、时长…），换厂商时用 `params.sourcePrompt + params.refNameIndex` 按新 provider 重渲染 `@名字`（qwen-jobs `<imageN>名字`、其它 `图片N名字`、视频 `@图片N名字`），旧任务没有源提示词时直接复用最终提示词；视频沿用"模型不支持关键帧引导就报错"的规则，不支持中间帧引导的模型只发首尾帧。文本按原 kind/范围后台重跑（提示词批量把实际处理的分镜 id 落在 `params.storyboardIds`），**剧本改写/拆分分镜的重试会覆盖本集剧本/分镜**（Agent 工具直接写库，用户已确认）。
- 前端只有一个任务状态源：`composables/useTasks.ts`（模块级 store + 单一轮询 `GET /tasks/active`，有活跃任务 3s、空闲 15s、页面不可见暂停）。任务离开活跃列表时补拉 `GET /tasks/:id` 并通过 `onTaskFinished()` 通知订阅者（关键帧组件重载版本、工作台 `refresh()`）；刚提交的任务用 `registerTask()` 立刻进 store，进度环不等下一轮。进页时 `loadEpisodeTasks(epId)` 用 `GET /tasks/center?episode_id=&page_size=200` 载入本集快照（父行 children 摊平），刷新后失败/生成中状态照旧恢复。**组件内不得再轮询单个任务**（旧的 `StoryboardKeyframes.slotTasks`/`pollKeyframeTask`、`episode.vue` 的 `loadGenTasks` 已删除），槽位环取 `latestKeyframeTask(storyboardId, frameType)`、素材环取 `latestAssetTask(kind, id)`。
- 任务中心 UI：`components/TaskCenterButton.vue`（顶栏按钮 + 角标 + 抽屉，`layouts/default.vue` 头部与 `episode.vue` 顶栏各放一个）、`components/TaskCenterPanel.vue`（筛选/分页/父行展开，抽屉与 `pages/tasks.vue` 共用）、`components/TaskDetailDialog.vue`（详情 + 取消 + 换模型重试，`ModelSelect` 选项来自 `composables/useModelOptions.ts`；重试 `script_rewrite`/`storyboard_breaker` 前弹确认框）。文案在 `locales/*.json` 的 `taskCenter.*`（旧的 `episode.tasks.*`、`episode.topbar.tasks` 已删）。

## 待办

- 无。
