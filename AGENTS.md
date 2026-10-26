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

## 供应商（Provider）架构

- 文本：`backend/src/agents/index.ts` `getModel` 统一走 `createOpenAI(...).chat`（`/chat/completions`）。`services/ai.ts` `getTextProviderBaseUrl`：openai 的 base URL 若已以 `/v<数字>` 结尾（如智谱 `…/paas/v4`）则原样使用，否则补 `/v1`。
- 图片 / 视频：`backend/src/services/adapters/` 每个厂商一个 adapter，在 `registry.ts` 注册；新增 provider 需同步：adapter 文件、`registry.ts`、`services/ai.ts` 的 `officialProviders`、`routes/aiConfigs.ts` 的 `buildProbe`、前端 `settings.vue`（providers 与预设）与 `episode.vue`（分辨率档位映射）。
- 视频 adapter 可选 `prepare(config, record)`：提交前的异步预处理（上传参考图、扩写提示词），抛错会作为任务失败原因落库；`parsePollResponse(result, config)` 可拿到 baseUrl 构造结果地址。
- `storage.ts getExtFromUrl` 会读 URL 的 `filename` 查询参数取扩展名（ComfyUI `/view?filename=x.mp4`）。

## 本机后端

### 文本：GLM 5.3
- 配成 `text / openai`，base URL `https://open.bigmodel.cn/api/coding/paas/v4`（智谱 coding 套餐专用端点），模型 `glm-5.3`，key 来自环境变量 `ZHIPU_API_KEY`（写入本机 `providers.json`）。
- GLM-5.x 始终思考：`agents/index.ts` 的 `isOfficialTextHost` 包含 `open.bigmodel.cn`，不会注入 `thinking: disabled`（否则 400）。
- reasoning 与 content 共享 `max_tokens`，项目默认注入 16384，不要调小。

### 图片：GPT Image（codex 包装服务）
- `tools/codex-image/server.mjs`：本机常驻、OpenAI 兼容（`/v1/images/generations`、`/v1/images/edits`、`/v1/models`、`/health`），监听 `127.0.0.1:<port>`，Bearer token 鉴权。
- 每个请求 one-shot 调 `codex exec --skip-git-repo-check -C <tmp> --sandbox workspace-write "$imagegen …"`；**提示词必须在 `-i` 之前**。图片由 codex 写到 `~/.codex/generated_images/<session-id>/`，session id 取自 codex 输出的 `session id:` 行，按会话目录取图，并发互不串图。
- 常驻：`systemctl --user status huobao-codex-image`（unit 在 `~/.config/systemd/user/`，不入库）。
- 主项目配成 `image / openai`，base URL `http://127.0.0.1:<port>`，key 为 `codex-image.json` 里的 token。

### 视频：MiniMax H3（ComfyUI）
- provider `comfyui`：`adapters/comfyui-video.ts` + `comfyui-workflows.ts` + `h3-prompt.ts`；工作流模板在 `backend/src/workflows/h3/{t2v,firstlast,reference}.json`（ComfyUI API 格式，按固定节点 ID 填参数，随 JSON import 打进 bundle）。
- 流程：`prepare`（扩写提示词 → 等引擎队列空 → 上传参考图 `/upload/image`）→ `POST /prompt` → 轮询 `/history/{id}` → `/view` 下载。
- 模式：无图 t2v（8 步 + turbo LoRA）；首帧（可选尾帧）firstlast（同上）；参考图 reference（标准变体用基础 ref2va 权重、无 LoRA、**20 步**：4 步实测背景是未收敛的噪点，20 步清晰且耗时几乎不变；int8 变体用 fused refdelta 4 步蒸馏）。不支持参考视频/音频。
- **参考图 + 首/尾帧引导**：reference 模式下首帧/尾帧不再被丢弃，`buildReference` 追加 `LoadImage + MiniMaxH3AddGuide`（首帧 `frame_idx=0`、尾帧 `frame_idx=-1`，串在 `MiniMaxH3ReferenceToVideo` 之后，最后把 `BasicGuider.conditioning` 指到末个引导节点）。引导帧**不占用 Picture 编号**，`@图片N` 映射照旧。102 实测（fused refdelta int8 路径）：3 张参考图 + 首帧引导、12 秒、960×544 可跑通，第 0 帧与上一镜尾帧 SSIM 0.918；7 张参考图 + 首帧引导 + 尾帧引导（`frame_idx=-1`）、15 秒也可跑通（约 387 s，首/尾帧 SSIM 0.936/0.973）。
- **提示词契约（质量关键）**：H3 引擎逐字分词，必须是英文三段式 `integrated_multimodal_description / overall_soundscape / non_diegetic_music`（首尾帧/引导帧前加对齐声明，由代码生成）。裸中文会导致画面发糊。`buildH3Prompt` 对非契约文本用当前文本模型（GLM）扩写，失败即报错，不回退为裸提示词；reference + 首帧引导时还会要求 GLM 从上一镜结尾无缝续写、不重新交代空间。
- 服务器资料（2026-10-26 起）：**唯一视频实例在 `.102` tcs3（RTX 3090）**，经 Caddy `https://102.joyai.dev/video`（Cloudflare 隧道）访问，模型名 `MiniMax-H3-INT8-ComfyUI` 触发变体模板 `workflows/h3-int8/{t2v,firstlast,reference}.json`（fl2va int8 convrot + fused refdelta int8 + qwen3vl nvfp4_awq + turbo 8 步 LoRA）。参考图模式走 fused refdelta，无需 `ref2va`。bf16 实例（原 `.175`）已随 GPU 重排退役。引擎串行执行。
- 网关鉴权：base URL 走公网 Cloudflare 入口时 Caddy 要 HTTP Basic auth；凭据只存 `ai_service_configs.api_key`（格式 `user:password`，含冒号即 Basic），`comfyui-client.ts` 的 `authHeaders` 会在队列/上传/提交/轮询/`/view` 下载全程带上。口令绝不入库/入文档。

### 尾帧承接与服务端批量视频
- 生效规则唯一实现在 `services/continuity.ts`：上一镜 = 同集内未删除、按 `storyboard_number` 排序的前一镜，第一镜永不承接；`storyboards.continuity_mode` 三态（`auto` 默认 / `previous_tail` 强制承接 / `none` 强制不承接）覆盖剧集开关 `episodes.continuity_enabled`（默认开启），`auto` 还要求 LLM 标注 `storyboards.continuity_boundary = continue`（NULL 视为硬切）。
- 视频请求一律由后端 `services/storyboard-video.ts` 组装（参考图顺序场景→角色→道具、素材版本选择、去重上限 9、`@名字 → @图片N名字`、风格词、时长/画幅/分辨率、分镜尾帧图）。承接镜头在**提交的那一刻**提取上一镜采用视频的尾帧作为首帧，**参考图照常发送**；上一镜没有采用视频直接报错。单镜入口 `POST /storyboards/:id/generate-video`，`POST /tasks` 不再有 `inherit_previous_tail`。
- 服务端批量 `services/video-batch.ts` + `POST|GET /episodes/:id/video-batch`、`POST /episodes/:id/video-batch/cancel`：按分镜顺序串行（提交 → 等 sys_task 终态 → 下一镜），状态持久化在 `video_batches`，后端重启后 `resumeVideoBatches()` 自动恢复（被打断的那一镜重新提交，接受上游可能的重复任务）。失败/跳过会断开承接链，依赖它的后续镜头标为 `skipped`，到下一个切换边界恢复。停止只是不再提交新的镜头，在跑的那一镜跑完后批次转 `cancelled`。
- 能力校验：video adapter 的 `supportsFrameGuides`（comfyui/minimax = true，volcengine = false）。Seedance 收到首/尾帧明确报错，不静默丢弃；批量启动前预检"承接镜头的上一镜不在批内且无采用视频"和"模型不支持首帧引导"，列出镜头号后拒绝启动。

### ComfyUI（Qwen Image 2.1）
- 入口（2026-10-26 起）：`.110`（2×RTX 3060）的 Caddy `https://110.joyai.dev/image`（Cloudflare 隧道，HTTP Basic auth，凭据同上存 api_key）。LAN 备选 `http://172.30.3.110/image`（免鉴权）。adapter 把所有路径拼在 base URL 之后，前缀自然生效，`waitEngineIdle` 只等该实例的队列。
- 去噪器是 azukivc 的 **Q6_K GGUF**（`UnetLoaderGGUF`，city96 ComfyUI-GGUF；`.110` 没有 safetensors 扩散模型，HF 上也无可用 Q8_0 GGUF），文本编码器仍是 Comfy-Org int8 convrot，VAE bf16。速度参考（3060，25 步）：1024² ≈ 89–93 s。
- 通用 ComfyUI 图像逻辑在 `adapters/comfyui-client.ts`（上传 `/upload/image`、`POST /prompt`、`/history`、`/view`、等队列空、节点校验错误解析）。provider 统一叫 `comfyui`，图片 `qwen-image*` → Qwen。新增图像模型 = 加模板 JSON（`backend/src/workflows/qwen/`）+ 填充函数 + adapter 分支。
- 模板取自服务器 `/history` 里已跑通的任务（API 格式）：Qwen `workflows/qwen/{t2i,i2i}.json`。
- Qwen Image 2.1：`TextEncodeQwenImage21`（参考图作为 `images.image_N` 自动增长输入，提示词用 `<image1>` 指代；没写时 adapter 自动补前缀）+ `QwenImage21Cache` + `KSampler`（euler/simple，25 步，cfg 1.0）。文生图用 `EmptyLatentImage`（尺寸对齐 32、总像素 ≤2048²），图生图尺寸跟随参考图。

## 待办

- 无。
