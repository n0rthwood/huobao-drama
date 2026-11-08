# AGENTS.md

## 工作流程（必须先执行）

### 0. 开工前先把工作区变干净

接到任务先跑 `git status --short --branch`，按类别处理干净后才开始本任务：

- 已修改、已暂存未提交的改动 → 提交；未跟踪但属于源码/文档/脚本的文件 → 提交；未跟踪但属于可再生成的构建产物或运行时数据 → 补 `.gitignore`，不提交。
- 遗留改动按逻辑拆成清晰的提交（属于既有 Issue 的在提交信息里引用），不要求凑成单个提交。
- 提交后主工作区必须干净；禁止把遗留改动带进新 Issue 的 worktree，也禁止用 `reset --hard`/`clean` 丢弃它们。
- 本规则只要求「先提交、工作区干净」；推送与合并仍按 §5 的流程执行，不强制直接推 `origin/master`。
- 已知不入库的路径：`frontend/dist`（release 软链）、`data/text-tasks/`（运行时思考记录）、`~/huobao-releases`（release 产物）；目录结构变化时按「产物/运行时数据 → `.gitignore`」的规则处理，不要把具体路径写进流程。

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

### 8. 测试质量

- 优先真实 API / 浏览器 QA 与断言函数或组件输出的行为测试（包括真实 Vue 挂载后的渲染与交互结果）；不要用 `readFileSync`、源码正则、locale 副本或调用次数断言钉住实现形状来替代行为覆盖。清理仅限已枚举、获准的本轮测试，边界不清默认保留，历史无关测试不扩删；报告清理前后的完整失败用例名单与差异，不以删测试冒充修复业务。

### 9. 测试原则（2026-11-08 起，验收强制）

- **所有验收测试在生产系统上进行**（生产入口 + 生产后端 + 生产库），并**留痕**：项目 ID / 集 ID / 任务 ID、浏览器截图、只读 DB 查询结果、后端日志片段。报告必须给出这些 ID 与证据路径，不能只写“已验证”。
- **隔离/独立环境（独立端口 + DB 副本的 worktree QA）不再作为验收依据**。它仍然可用于代码实现期的自测与调试，但验收结论必须来自生产系统的留痕。
- 生产测试**只允许新建专用测试项目**；严禁修改、生成、删除既有真实项目的数据（尤其 drama 3《利哈列夫远征》）。DB 一律只读查询。
- 生产测试会消耗真实算力与额度：必须经用户同意后才启动计费生成任务；任务 ID 全程记录，失败不隐瞒。
- 涉及火宝业务全流程的操作一律使用 `docs/skills/huobao-director/` 技能（见 §10），按技能约束调用 API，不自造流程。

### 10. 固定验收案例：八达岭长城测试 1008

同类功能/流程验收都按这个案例**新建项目**（不复用旧测试项目，便于对比与追溯）：

- 主题：**八达岭长城对明朝防御的作用**。
- 原始内容：**200–300 字**的中文素材（主题相关、可公开），作为项目原始输入。
- 项目名：**八达岭长城测试 1008**（同名重复时追加序号，如 `八达岭长城测试 1008-2`）；**实际项目 ID 以创建结果为准**并写入报告。
- 流程：走完火宝完整链路（建项目 → 原始内容 → 剧本/旁白 → 资产提取 → 生图 → 分镜 → 生视频 → 导出），本轮验收涉及的阶段必须真实跑通。
- 操作方式：**使用 huobao-director 技能**（`docs/skills/huobao-director/SKILL.md` 与 `references/`）调用生产 API。
- 证据清单：项目/集/任务 ID、每个关键阶段的截图、只读 DB 查询（状态与产物路径）、失败任务的日志片段。

**首次执行记录（2026-11-08）**

- 项目/集/合并：drama **10**（八达岭长城测试 1008）/ episode **16** / merge **27**。
- 最终媒体：`static/merged/c9bbd119-b086-42a6-8eaf-6ce63ed185fa.mp4`，浏览器实测 **960×544 / 65.44 s**（`readyState=4`），SHA-256 `62cc07d621227d499f6d054b8f01604ac19e11fc7149d0ff14f16fa4a2260fce`（本机无 ffprobe，时长/分辨率以浏览器媒体元数据为准）。
- 预算实际消耗（上限 → 实际）：图片 16 → **11**（资产 1226、1230–1233、1245–1246；关键帧 1248–1251），视频 2 → **2**（1254/1255），TTS 8 → **6**（voice batch 1228，#01–#06）。
- 报告与证据：`docs/qa/8daling-1008-20261108T061008Z/report.md`（含 `requests.jsonl` 与 01–11 截图，`11-voice-player-verify.png` 为配音页 6 个 audio 元素的验证）。
- 只读 DB 查询（主 agent 复核，2026-11-08）：`backend/data/huobao.sqlite3` 只读 —— `video_merges` id **27** → `episode_id` 16 / `drama_id` 10 / `status` completed / `merged_url` `static/merged/c9bbd119-b086-42a6-8eaf-6ce63ed185fa.mp4` / `duration` 65；episode 16 存活 `storyboards` **6**。另 `GET /episodes/16/narration-skeleton`：`confirmed=true`、6 镜、TTS 6/6，前两镜含 `audio_url`/`audio_version`/`duration_ms` 8800、3840。（原报告「本仓库无本地生产 SQLite 文件」不准确。）
- 已知失败/偏差（保留原始证据，未补跑 GPU）：#02 关键帧提示词在 GLM / DeepSeek local / DeepSeek cloud 三模型下均失败，combo 回退为 A 并由 #04 C 保留第二条生成视频；图层 draft 首次 `missing_base`；API 文档中 merge/rewrite 路径与实际存在偏差，已在报告中留痕。
- 成片的史实、画面与声音审美仍需用户审核；本记录只代表链路、预算与媒体可读性的技术验收。

### 11. huobao-director 技能同步

- 技能已入库：`docs/skills/huobao-director/`（`SKILL.md` + `references/`，来源与同步规则见该目录 `README.md`）。
- **每次功能或 API 升级（新增/变更/下线接口、字段、流程阶段、约束）都必须回顾并更新技能**：补充新增 API 点、触发该功能的案例背景、以及为何需要该功能的记录；变更与业务提交同一个 Issue 分支提交。
- 技能副本**不得包含真实密钥值**：`api_key`/token 的真实值、认证头实值、带真实凭据的 URL 一律不得写入；字段名、占位符与安全说明（例如 `GET /ai-configs` 响应含 `api_key`、只能在内存中白名单取字段）属于必要的 API 契约，必须保留。

火宝短剧（Huobao Drama）：AI 短剧一站式制作（小说 → 剧本 → 资产提取 → 生图 → 分镜 → 生视频 → FFmpeg 导出）。
项目结构、命令与架构总览见 `CLAUDE.md`，本文件只记录 Agent 开发时容易踩坑的补充信息。

## 开发服务 / 生产托管

- **生产（常驻，唯一 pm2 应用）**：`huobao-backend`（`npm start` = tsx 非 watch，`NODE_ENV=production`，:5679）同源托管 UI + `/api/v1` + `/static`。UI 来自 release 产物 `~/huobao-releases/current`（`FRONTEND_DIST`），**不跑 Nuxt dev**。
- **部署前缀（2026-10-30 起）**：SPA 以 `baseURL='/huobao/'` 构建（`nuxt.config.ts` 读 `HUOBAO_BASE_PATH`，默认 `/huobao/`），入口 **`https://164.joyai.dev/huobao/`**（LAN `http://172.30.3.164/huobao/` 免鉴权；`huobao.joyai.dev` 已 301 到这里）。Caddy `handle_path` 剥掉 `/huobao`，所以后端无需感知前缀；**前端所有绝对路径必须过 `app/utils/url.ts` 的 `apiBase()`/`mediaUrl()`/`appBase()`**（basePath 走 `runtimeConfig.public`，**不要用 `import.meta.env.BASE_URL`**——SPA 构建里它是相对值 `'./'`，深链页面上相对 fetch 会解析成 `/huobao/drama/api/...`）。新增 `<img>/<video>/fetch` 时一律用这些工具，别再手写 `'/static/...'` 或 `'/api/v1/...'`。
- 发布：`scripts/release.sh`（`nuxt generate` → 原子发布到 `~/huobao-releases/<UTC 时间戳>` → 切换 `current` 软链 → `pm2 restart huobao-backend` → smoke：后端直连 health/index + Caddy 前缀路径 `/huobao/`、`/huobao/api/v1/health`、深链、hash 资源，并校验 index.html 以 `/huobao/_nuxt/` 为基址）。增量约 5–7 s；保留最近 5 个版本（`HUOBAO_RELEASES`/`HUOBAO_RELEASES_KEEP` 可覆盖）。回滚 = 把 `current` 指回旧时间戳再 restart。
- 前端热加载开发（可选，非常驻）：在 `frontend/` 手工 `HUOBAO_BASE_PATH=/ npm run dev`（默认会带 `/huobao/` 前缀跑），`0.0.0.0:3013`，`strictPort: true`。`host: true` 会让当前 Nuxt 版本崩溃，必须写字符串 `'0.0.0.0'`。它只用于开发；生产入口是 `164.joyai.dev/huobao/`。
- 后端：`5679`。根目录 `npm run dev:backend` 已固定 `PORT=5679`（本机环境变量可能带 `PORT=5010`，属于 omp web UI）。
- 常驻监听只有 `:5679`；验证：`curl localhost:5679/api/v1/health`、`curl -s -o /dev/null -w '%{http_code}' localhost/huobao/drama/1`（经 Caddy 的深链必须 200）。

### 页面尺寸规格（Issue #20，前端改版必须遵守）
- 工作台（`layouts/studio.vue` + `views/drama/episode.vue` 的 `.studio`）**最小可用宽度 1280px**：更窄的视口由布局层横向滚动，不再收缩内容；因此 episode.vue 不再有 `max-width` 收缩断点，新增样式也不要加。
- 按 1440 / 1920 设计；≥2560 时卡片保持最大尺寸、只增加列数，不放大单卡。
- 所有展示图片的区域一律是**流式卡片网格**（`repeat(auto-fill, minmax(最小, 最大))` + `justify-content: start`），卡片同时有最小与最大宽度，图片 `object-fit: contain`：本帧参考图/视频绑定参考图 `TargetAssetList` 120–180px、本镜资产池 160–240px（图片区约 60% 卡片高度）、`ReferenceImageManager` 紧凑 64–96px / 大号（详情弹窗）120–200px。禁止整行长条 + 小缩略图，也不要在有横向空间时竖排一列。
- 关键帧槽位 = 左图片列 `clamp(320px, 30%, 640px)`（按剧集画幅 `aspect-ratio`，时间/版本等元信息在图片下方）+ 右提示词列 `minmax(420px, 1fr)`（`MentionTextarea` 带 `autogrow`），「本帧参考图」横跨整行；分镜列表宽度 `clamp(260px, 18vw, 340px)`。
- 覆盖在图片上的标签（`.asset-cover-badge` / `.asset-cover-time`）背景与文字都必须取主题变量（`--header-bg` / `--text-1`），禁止写死白底。
- 选中状态必须有明确标识（描边 + 勾选按钮 `aria-pressed`），不能只靠颜色文字或透明度。

### 进程管理：pm2（生产单应用；不要用 omp 会话跑服务）
- `ecosystem.config.cjs` 只有 `huobao-backend`（`npm start`，:5679，`NODE_ENV=production`，`FRONTEND_DIST=~/huobao-releases/current`）。omp 会话/daemon 结束后进程会跟着丢，所以**不要**用 omp 的 bash service/daemon 启动它。
- pm2 装在 `~/.local`（全局 `/usr` 无写权限，不要 sudo）。**一律通过 `scripts/pm2.sh` 调用**：`scripts/pm2.sh start ecosystem.config.cjs | restart huobao-backend | stop all | status | logs huobao-backend`。
- **环境变量隔离（重要）**：pm2 daemon 与子进程继承启动它的 shell 环境，omp 会话里有 `PORT`、`OMP_WEB_*`、`OMPCODE`、`NODE_ENV` 等变量。`scripts/pm2.sh` 用 `env -i` 清空环境，只传 `HOME/USER/LANG/PATH`；**不要直接敲 `pm2`**（哪怕只是 `pm2 -v`，也会拉起带污染环境的 daemon；误操作后 `scripts/pm2.sh kill` 再重启）。`PORT=5679`、`FRONTEND_DIST` 写在 `ecosystem.config.cjs` 的 `env` 里；改这些后要 `delete` + `start`（`restart` 不更新 env）。
- 验证无泄漏：`for p in $(pgrep -f "tsx.*src/index|nuxt"); do tr '\0' '\n' < /proc/$p/environ | grep -E '^OMP'; done` 应无输出。
- 改过应用集合后 `scripts/pm2.sh save`（开机 `pm2 resurrect` 按 dump 恢复）。

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
- **FLUX 图片服务（2026-10-29，Issue #27）**：本机 `providers.json` 另有 `image/qwen-jobs` 的 `FLUX.1-dev` / `FLUX.1-schnell` 两行（内网 FLUX 任务服务，LAN 无鉴权）。FLUX 不支持 `image_edit`，带参考图一律 `reference_to_image` 且只用第 1 张参考图 + `denoising_strength=0.75`（多张降级会记 warning 并写入任务 metadata）；模型名以 `flux` 开头即走 FLUX 分支（`isFluxJobsConfig`）。
- **资料检索 API key（Issue #78）**：Europeana、Smithsonian Open Access（key 由 api.data.gov 发放）的 key 由用户在设置页「资料检索」（`?tab=research`）填写，存业务库 `app_settings.research_api_keys`（与 AI 服务密钥同口径，不进仓库/`providers.json`）。来源注册表 `backend/src/config/research-sources.ts`（新增来源只加一条）；服务端读取用 `getResearchApiKey(id)`（`services/app-settings.ts`，同步）。接口 `GET/PUT /settings/research-sources[/:id]`、`POST …/:id/test`（可带未保存的草稿 key，不落库）**永不返回完整 key**，只给末 4 位（key 短于 12 位时不给任何字符）；请求日志中间件对 `api_key/apiKey/wskey/password/token/secret` 字段打码。ctext.org 只对机构订阅发 key 且禁止自动抓取，未接入。

## 供应商（Provider）架构

- 文本：`backend/src/agents/index.ts` `getModel` 统一走 `createOpenAI(...).chat`（`/chat/completions`）。`services/ai.ts` `getTextProviderBaseUrl`：openai 的 base URL 若已以 `/v<数字>` 结尾（如智谱 `…/paas/v4`）则原样使用，否则补 `/v1`。
- 图片 / 视频：`backend/src/services/adapters/` 每个厂商一个 adapter，在 `registry.ts` 注册；新增 provider 需同步：adapter 文件、`registry.ts`、`services/ai.ts` 的 `officialProviders`、`routes/aiConfigs.ts` 的 `buildProbe`、前端 `settings.vue`（providers 与预设）与 `episode.vue`（分辨率档位映射）。
- 视频 adapter 可选 `prepare(config, record)`：提交前的异步预处理（上传参考图、扩写提示词），抛错会作为任务失败原因落库；`parsePollResponse(result, config)` 可拿到 baseUrl 构造结果地址。
- `storage.ts getExtFromUrl` 会读 URL 的 `filename` 查询参数取扩展名（ComfyUI `/view?filename=x.mp4`）。

## 本机后端

### 文本：GLM 5.3
- 配成 `text / openai`，base URL `https://open.bigmodel.cn/api/coding/paas/v4`（智谱 coding 套餐专用端点），模型 `glm-5.3`，key 来自环境变量 `ZHIPU_API_KEY`（写入本机 `providers.json`）。
- GLM-5.x 始终思考：`agents/index.ts` 的 `isOfficialTextHost` 包含 `open.bigmodel.cn`，不会注入 `thinking: disabled`（否则 400）。
- reasoning 与 content 共享 `max_tokens`，项目默认注入 16384，不要调小。**本机 `backend/.env`（不入库，dotenv 加载）设 `AI_MAX_TOKENS=131072`**（2026-10-28，#19 live 生效）：GLM coding 端点 `max_tokens` 只接受 `[1,131072]`（131073 报 1210），实测 3.2 万 token 输入 + 131072 正常；32768 时代码注入值过小，拆分分镜一次推理 + 输出就能吃满（实测 31662/30764），`finish=length` 截断表现为「Agent 正常结束但什么都没保存」。重建本机环境时要同步这一项。

### 文本：DeepSeek V4.1 Flash 1017（本地引擎，Issue #23）
- 配成 `text / openai`，名称 `DeepSeek V4.1 Flash 1017 (local)`，base URL 走路由器公网入口 `http://tianan2.riadev.top:17580/deepseek`（`getTextProviderBaseUrl` 自动补 `/v1`），模型 `deepseek-chat`；key 与 omp `deepseek` provider 同一把，只写进本机 `providers.json`。优先级 90，默认文本模型仍是 GLM 5.3（100），要用时在模型下拉里选。
- 入口：**不用** Cloudflare 隧道 `…joyai.dev/deepseek`。它对长时间无数据的响应会 524（2026-10-28 实测单次长输出约 126 s 时 524），工具参数缓冲期同样有风险（见下节「一律流式」）；路由器入口实测单次 196 s / 9607 token 正常。
- 思考语义：引擎对 model 名一视同仁，`deepseek-reasoner` 这个 id **不会**自动开思考，只有请求带 `"reasoning_effort": "high"` 才思考并返回 `reasoning_content`。火宝对非官方端点一律注入 `thinking: disabled` / `enable_thinking: false` / `reasoning_effort: "none"`（`createThinkingOffFetch`），所以 DeepSeek 在火宝里**永不思考**（引擎日志 `thinking=False`），不配 `deepseek-reasoner`（与 `deepseek-chat` 等价）；DeepSeek 任务在 #19 思考面板里没有内容属正常。
- 输出上限：引擎 `max_model_len=1048576`，本机 `AI_MAX_TOKENS=131072` 可直接用。
- 旧 Qwen3.6 端口（`.175:8300`）现在转发到同一个 DeepSeek 引擎，**只为让其它旧应用的配置不挂**；火宝的「Qwen3.6 (175)」配置已停用（`is_active=0`），并已从 `providers.json` 删除——`apply-local-config` 对文件内条目一律写 `is_active=true`，留着会被重新启用。不要再给火宝配置该端口。
- 实测（2026-10-28）：tool call 正常；第 1 集「拆分分镜」117 s，`readStoryboardContext` → `saveStoryboards` 存下 4 镜，角色/道具绑定正确。

### Agent 读图工具 `read_image`（Issue #46）
- `backend/src/agents/tools/vision-tools.ts`，挂在 `extractor` / `storyboard_breaker` / `prompt_generator`。入参 `{ path, question, max_side?=1600, expect_json?=false }`，返回 `{ text|json, model, image } | { unsupported:true, reason } | { error }`，**任何错误都返回对象、不抛**（抛错会打断整次 Agent 运行）。
- 它**不走当前 Agent 的主模型**：用 `services/vision-capability.ts resolveVisionTextConfig()` 探测出的那条文本配置（本机是 DeepSeek V4.1 Flash）单独发一次 `/chat/completions`。只有 GLM 活跃时返回 `unsupported`，技能按「按文字推断 / 人工填写」降级，任务照常完成。
- `path` 必须是 `static/` 下的现存 jpg/png/webp（允许 `/static/...` 写法）；越界、目录、不存在、非图片一律报错。
- 请求组装与档案画像共用 `services/vision-chat.ts`（缩放 JPEG → data URL → 单次请求，`temperature=0.1`，120 s 超时）。工具会在问题前自动写明「这是一张 W×H 像素的图片」——实测不给尺寸口径时模型返回的像素框会整体偏移；返回的 `image.{width,height,source_width,source_height}` 用于把坐标换算回原图。
- 实测口径（资产 39 原图）：**问一批点名的文字**（10 个地名）像素框可用，开图核对命中；一次要「图上所有地名」（37 条）时定位质量明显下降。折线/多边形描摹不可用——几何交给 CV。
- 计量：每次调用累加到当前文本任务 `params.vision_calls {count,prompt_tokens,completion_tokens,model}`（`RequestContext.textTaskId` 注入，chat 路由/提取/关键帧·视频提示词批量/换模型重试都带），任务详情弹窗显示「读图调用」。没有任务上下文时只记日志。

### 文本 Agent 调用：一律流式（Issue #17）
- 所有 Agent 执行都走 `agents/run.ts runAgent()`（`agent.stream()` → `getFullOutput()` → 有 `error` 即抛），返回结构与 `generate()` 相同；**不要再直接调用 `agent.generate()`**。原因：非流式请求要等模型把推理 + 全部输出生成完才回响应头，长输出（拆分分镜）超过 undici 默认 `headersTimeout=300s`，AI SDK 再重试 2 次 → 约 900 s 后 `Headers Timeout Error`（任务 #281）。HTTP 接口仍是非流式，前端不变。
- GLM 与 DeepSeek 流式下都会把**工具调用参数生成完再一次性下发**（实测 DeepSeek 1817 字参数前约 22 s 无数据，GLM 约 10 s），一次 `saveStoryboards` 参数可达上万 token。所以 `agents/index.ts getModel` 的 fetch 底层用 npm `undici` 的专用 dispatcher（`bodyTimeout` 15 分钟，`TEXT_MODEL_BODY_TIMEOUT_MS`），fetch 与 dispatcher 必须同源自 npm undici，只作用于文本模型请求。
- DeepSeek（配置走路由器公网入口 `/deepseek`）流式正文逐 token 返回、工具调用正常；Cloudflare 隧道入口同样支持流式，但隧道对长时间无数据会断，工具参数缓冲期仍可能 524，**继续用路由器入口**。
- H3 提示词扩写（`adapters/h3-prompt.ts`）是单次短输出直连请求、自带 300 s 总超时，不经 Agent，仍为非流式。

### 文本任务思考内容可见（Issue #19）
- 有 `sys_task` 的文本 Agent 调用（chat 路由、提取、关键帧/视频提示词批量、换模型重试）都会给 `runAgent` 传 `createReasoningSink(taskId)`；`agents/index.ts` 的 fetch 链最外层 `createReasoningCaptureFetch` 对 SSE 响应 tee 一路解析 `delta.reasoning_content`（AI SDK 不透出该字段），落盘到 `DATA_ROOT/text-tasks/<taskId>.reasoning.txt`（追加、永久保留），`params.reasoning_chars` 节流记累计字数。
- 最终正文全文存 `params.output_text`（只在 `GET /tasks/:id` 顶层返回，列表/`/tasks/active` 不带）；思考内容读 `GET /tasks/:id/reasoning?tail=`（默认尾部 4096，`offset+tail` 翻全文）。
- 前端 `TaskDetailDialog`：进行中思考块每 3 s 拉尾部并自动滚底（用户上滚暂停跟随），结束后折叠可展开全文；错误块可滚动且带「复制错误信息」（`utils/clipboard.js`，非安全上下文降级 `execCommand`），任务中心行级/子任务错误行也有复制按钮。

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
- **素材绑定以生成目标为主体（Issue #18，唯一实现 `services/storyboard-assets.ts`）**：表 `storyboard_target_assets(storyboard_id, target, kind, asset_id, selected_image)`，`target ∈ first|mid|last|video`、`kind ∈ scene|character|prop`。每个目标的绑定 = **该目标自己的提示词** @ 到的本集资产（first/mid/last = 对应槽位提示词；video = `video_prompt` ∪ `transition_prompt`，转场段拼在视频提示词前一起提交），`@名字` 按本集资产名（非旁白角色、道具、场景）**最长优先**匹配，**场景也按目标由 @ 决定**（不再要求与分镜场景一致，`scene_conflict` 已删除）。不提供手动增删：提示词写入（`PUT /storyboards/:id`、`POST …/keyframes/:slot/generate` 带 prompt、Agent 的 `update_storyboard`/`save_storyboards`、转场保存）后 `syncStoryboardBindingsFromPrompts(id, 写入的字段)` **只重算被写入的目标**（新 @ 的加行、仍 @ 的保留选版、不再 @ 的删行，提示词为空则清空），其他目标不动。选版按目标：`PUT /storyboards/:id/target-assets/:target {kind, asset_id, image|null}`（只能给已绑定的资产选，null = 默认），默认图读时解析 = 本集造型图（角色）> 资产当前成片图。分镜级 `scene_id` + `storyboard_characters/props` 保留为「本镜资产池」= 5 个提示词 @ 的并集（全空不动），只作 @ 候选、拆分分镜初始绑定与提示词/转场生成上下文，**不参与发图**。`checkStoryboardRefs` 按目标输出 `ref_issues`（`fields` 仍是提示词字段名）：阻断 = `missing_image`（该目标该资产无可用图）、`unbound_mention`（@ 到但该目标未绑定，重新保存该提示词即可）、`unknown_mention`（@ 的不是本集资产）；警告 = `unmentioned_binding`（该目标绑了但提示词没 @，仍会被发送，保存一次该提示词即解绑）、`over_capacity`（按目标装配后超 9 张被截断，视频侧首帧再占 1 张）。每个分镜 JSON 带 `target_assets{first,mid,last,video:[{kind,asset_id,name,image,selected_image,default_image,ref_no}]}`（顺序 = 发送顺序，视频 `ref_no` 从 2 起）、`ref_issues` 与 `field_saved_at`；`PUT /storyboards/:id` 返回 `{saved_at, character_ids, prop_ids, scene_id, ref_issues, target_assets, ref_sync:{bound,unbound}}`（`ref_sync` 是资产池的变化）。**存量迁移**：表首次创建时一次性把分镜当时的绑定 + `asset_version_selection` 选版复制给每个提示词非空的目标（与造型图相同的自动选版迁成默认），随后删除 `storyboards.asset_version_selection` 列；迁移后请求与签名不变，用户改哪一帧的提示词那一帧才按 @ 收窄。
- **提取规则的唯一事实来源（Issue #15）**：角色/场景/道具的判定标准、必提类别、命名与描述写法**只写在** `backend/workspace/prompts/extractor*.md` 与 `backend/workspace/skills/extractor/**`（含子技能 `extractor/prop-extraction`，按 `AGENT_SKILL_MAP` 目录前缀自动注入，新增子目录不用改代码）。`services/extraction.ts` 的 `EXTRACT_MESSAGES` 只剩「提取哪一类」的一句话，**不得**再写任何判定规则（旧版三处规则互相矛盾，导致整部剧 0 个道具）。分镜侧同理：`storyboard-breaker/prop-continuity`、`prompt-generator/{keyframe,video,prop,character}-prompt`。
- **分段资产锚定规则（2026-10-28，Fabel 原文，#15 live 落地）**：`video-prompt` / `keyframe-prompt` / `prop-continuity` 三个 skill（各 4 语言）规定——每个 3 秒段（含 #11 的开场转场段，不豁免）必须 `@` 本镜绑定的**场景**；段内仍在画面中的绑定资产（背景/虚化/镜中/静止物）逐段 `@` 并带可见性短语；`@道具` 的句子必须含辨识性要素（功能部位 / 握持点 / 使用动作），弱静态动词不合规；禁止裸文本指代（“画外穿衣镜”→“@落地穿衣镜（画外）”）与集体称呼首指（“父母/两人”）。段内缺场景 @、在场资产漏 @ 曾导致 E3#4 父母被顶替、房间漂移、遥控器变手柄；同类画面漂移应**先改规则、经正常流水线重出提示词**，不做单镜手工补丁。
- **角色造型版本（Issue #15，Q1=B）**：成套服装不做道具，而是本集的造型版本，存 `episode_characters.styling_version`（JSON `{name, description, image_path}`，`services/styling-version.ts` 唯一读写）。提取侧由 `save_dedup_characters` 的可选入参 `styling_version{name,description}` 写入；出图走 `POST /characters/:id/styling-version/generate-image`（以角色基础形象图做 image_edit，`sys_task` 带 `params.characterVersion`，完成后只回写 `image_path`，**不动** `characters.image_url`）。关键帧/视频取图优先级 = 该目标的人工选版（`storyboard_target_assets.selected_image`）> 本集造型图 > 资产当前成片图，造型图是读时默认值（Issue #18 起不再回写选版）。帽子/眼镜/头盔等可单独穿脱的配件仍是道具。
- **基础形象不被单集覆盖（Issue #15）**：`save_dedup_characters` 合并时 `appearance`/`styling`/`role`/`description` 只补空白字段，已有非空值保留，被忽略的改写在工具返回值 `ignored_overwrites` 里报告。`save_dedup_scenes` 返回 `near_location_hints`：地点互为前缀/包含时提示可能是同一物理空间，**只提示不自动合并**。
- **场景时间是正式字段（Issue #21，唯一判定 `services/scene-time.ts`）**：不变量 = `scenes.time` 非空时，场景最终提示词必须原样包含 time 文本（trim、忽略大小写）。提取：`save_dedup_scenes` 的 `time` 必填非空（schema 拒绝空值），extractor 技能/提示词（4 语言）要求写具体时段（清晨/上午/正午/午后/黄昏/夜晚/深夜或剧本明确时段），时段不能只写进 lighting、lighting 必须与 time 一致。出图：scene-prompt 技能要求原样写出 time；`save_scene_final_prompt` 不含 time 原文即拒存（Agent 重写）；`ensureSceneFinalPrompt` 发现已存提示词不含当前 time 视为无效并重新生成。`PUT /scenes/:id`（`planSceneTimePatch()` 纯函数）：time 不能从非空改成空（400）；任何非空 `final_prompt` 写入不含 time → 400（与已存值相同视为未写入）；time 变化且本次没写入合格的新提示词 → `final_prompt` 置空；返回更新后的场景行。去重口径仍是「地点 + 时间」。
- **资产最终提示词失效（Issue #24，唯一规则 `services/asset-prompt-invalidation.ts`）**：`PUT /characters|scenes|props/:id` 先读当前行，影响画面的字段**值真的变了**（角色 `appearance/styling/description`，场景 `location/prompt/lighting` + #21 的 `time`，道具 `name/type/description`；角色 `name/role` 不算）且本次没有写入新的手写提示词 → `final_prompt` 置空；请求里的提示词与已存值相同视为未写入（项目素材页回传旧稿挡不住失效）。三个 PUT 都返回更新后的行，前端本地提示词一律以返回行为准。`ensure*FinalPrompt` 跑完 Agent 后读回的提示词必须**非空且与运行前不同**才算成功，Agent 没保存新稿 → 返回 `''`（`generate-prompt` 400），绝不把旧稿当新稿；`read_characters/read_scenes/read_props` 不返回旧 `final_prompt`。前端两个资产弹窗（`episode.vue`、`detail.vue`）：点「生成/重新生成提示词」时信息草稿有未保存修改先自动保存；异步回调只在弹窗仍是同一资产（类型 + id）时写文本框，否则只 toast；「生成中」按资产键控。日志特征：`[FinalPrompt] START … force=false` 与 `DONE` 同一秒 = 复用了已存提示词。
- **资产删除同步清关联（Issue #15/#18）**：删除角色/场景/道具时 `services/asset-links.ts` 的 `deleteAssetLinks()` 一并删 `episode_*`、`storyboard_*` 关联行与 `storyboard_target_assets` 绑定；启动时 `cleanupStaleAssetLinks()`（`db/sqlite-schema.ts`）幂等清理存量残留（含指向已删分镜/资产的目标绑定）。
- **资产名规则（Issue #34，唯一实现 `services/asset-name.ts`）**：角色 `name`/道具 `name`/场景 `location` 不得含空白与文件名非法字符——`@引用` 解析（`parseMentions`/`resolvePromptRefs`）在空白处截断，带空格的名字永远绑定不上。`normalizeAssetName()`：连续的（空白 ∪ `\ / : * ? " < > | @` ∪ 控制字符）合并成**一个** `_`，去首尾 `_`/`.`；所有写入口都先规范化再写库（手动 POST/PUT 三类资产、`PUT /dramas/:id/characters`、`save_dedup_*` 提取工具、跨项目导入与 `suggestUniqueName`），HTTP 入口规范化后为空 → 400，提取工具跳过并记日志。前端 `utils/assetName.js` 的 `normalizeAssetName` 同口径（行为测试 `backend/tests/asset-name.test.mjs` 前后端逐例对照），弹窗以服务端返回的行为准。提取去重 `normalizeName`/`normalizeLocation` 忽略空白与 `_`（`斋桑湖北岸` 仍命中 `斋桑湖_北岸`）。存量由启动迁移 `migrateAssetNames()`（`services/asset-name-migration.ts`，幂等）改名，并把分镜 5 个提示词字段里的 `@旧名` 与「旧名去空白」写法改成 `@新名`（`rewriteAssetMentions` 最长优先，现有合法名原样保留），再按改动字段 `syncStoryboardBindingsFromPrompts`；资产正文与历史 `sys_task` 不改。
- **新增 `ref_issues` 码（Issue #15）**：阻断 `empty_video_prompt`（`video_prompt` 为空，只影响 `video_prompt` 字段，关键帧不受影响）；警告 `limb_risk`（`limbRiskIssues()` 纯函数：负向肢体写法「不要三条腿」、或高风险姿态/构图段落没写四肢状态；**永不进 `blockingIssuesFor`**）。
- **字段级保存时间**：`storyboards.field_saved_at`（JSON：字段 → unix 秒，`services/storyboard-fields.ts`）跟踪 `description/atmosphere/first_frame_prompt/mid_frame_prompt/mid_frame_time/last_frame_prompt/video_prompt`；PUT 与 Agent 写入这些字段时打点（整行 `updated_at` 会被生图回写污染，不能用）。相对时间文本由前端按本地时钟计算。
- 关键帧生成 `services/storyboard-keyframes.ts`：`buildKeyframeRequest(storyboardId, slot, opts)` 是单张/批量/预览共用的组装（参考图 = **该槽位绑定**的场景 → 角色 → 道具的选定版本（Issue #18），**不含任何关键帧**，实测把首帧当参考图生成尾帧会崩坏；提示词 = 风格词 + 槽位提示词，`@名字` → Qwen 的 `<imageN>名字`、其它厂商 `图片N名字`；尺寸按剧集画幅 16:9=1344×768、9:16=768×1344、4:3=1152×864、3:4=864×1152、1:1=1024×1024）。该槽位存在阻断问题时直接抛错 → 单张生成返回 400 并列出问题。**内容签名** = sha256(最终提示词, 参考图文件名(按发送顺序), 尺寸, provider, model)；历史版本签名由其 sys_task 的 `prompt/provider/model/params.size/params.referenceImages` 反算（缺字段 → `null`，视为不匹配）。提交时把 `episodeId/sourcePrompt/refNameIndex` 一并传给 `generateImage`（任务中心重试据此换模型重渲染）。接口：`POST /storyboards/:id/keyframes/:slot/generate`（可带改过的 `prompt`，会打保存时间并同步该槽位绑定）、`GET …/versions`（返回 `version_no`（按创建时间正序从 1 编号）与 `signature`）、`PUT /storyboards/:id/keyframes/:slot`（`{image}` 选版本 / `{inherit:true}` 仅首帧）、`POST /storyboards/:id/confirm-keyframes`。
- 剧集批量 `services/keyframe-batch.ts` + `POST /episodes/:id/keyframe-batch/preview`、`POST|GET /episodes/:id/keyframe-batch`、`…/cancel`、`…/retry-failed`：**先预览再入批**。预览逐个“分镜 × 槽位”返回 `missing`（无图，默认勾）、`changed`（当前签名与所有历史版本都不同，默认勾）、`unchanged`（命中历史签名，带 `matched_version_no` 与 `selected_version_no`，默认不勾）、`blocked`（一致性阻断，不可勾，带 `issues`）、`skipped`（提示词为空 / 承接首帧无自有提示词 / 正在生成）；`storyboard_ids` 只缩小预览范围，不改勾选口径。启动接收 `items: [{storyboard_id, slot}]`，服务端复查，预览后才变成阻断/正在生成/提示词被清空的项**跳过并标注原因**，不让整批失败。**provider 为 `qwen-jobs` 时一次性提交全部待生成槽位**（每提交一张立即把 sys_task id 落盘，重启恢复不会重复提交），之后只跟踪各 sys_task 状态——三张关键帧互不作为参考图，并发安全；其它 provider 保持严格串行（提交 → 等 sys_task 终态 → 等写回 → 下一张）。停止 = 取消所有未结束项，`retry-failed` 对失败/已取消项**新建 sys_task** 重提。状态 JSON 除原有字段外还有 `eta_seconds`、`progress`、`counts` 与各项 `queue_position/progress/remaining_seconds/estimated_finish_seconds`；聚合是纯函数 `services/keyframe-batch-progress.ts`（有行为测试）。持久化在 `keyframe_batches`，重启由 `resumeKeyframeBatches()` 恢复。提示词补齐：`POST /episodes/:id/generate-keyframe-prompts` + `GET /episodes/:id/keyframe-prompts-status`。
- 视频闸门：单镜 `POST /storyboards/:id/generate-video` 要求该镜已确认（否则 400 `分镜 #N 的关键帧尚未确认`）**且 `video_prompt` 无阻断性一致性问题**（否则 400 列出问题）；批量**逐镜阻断**（Issue #12，不再要求全集确认）：预览把未确认/有阻断问题的镜头列为 `blocked` 且不可勾，其余照常批量；启动只检查所选镜头与「模型支持关键帧引导」，每一镜提交前再复查，变为阻断的那一镜标 `skipped` 并写原因，批次继续。
- 视频组装 `services/storyboard-video.ts`：参考图 = [生效首帧关键帧, 视频目标绑定的场景, 角色, 道具]（去重 ≤9），所以素材编号从 `@图片2` 起；首帧同时作为第 0 帧引导，中间帧（仅 `supportsMidFrameGuide` 的模型）与尾帧作引导帧。能力位：`supportsFrameGuides`（comfyui/minimax = true，volcengine = false，Seedance 直接报"当前视频模型不支持关键帧引导"）、`supportsMidFrameGuide`（仅 comfyui）。
- **视频内容签名**（Issue #12，`services/storyboard-video.ts`）：`computeVideoSignature()` 取 `buildStoryboardVideoRequest` 的**最终输出**算 sha256，分项摘要 = 提示词（含风格词，#11 的转场段也在其中）/ 引导帧文件名 + 中间帧时间 / 参考图文件名（按顺序）/ 提交时长（整数秒）+ 画幅 + 分辨率 / provider + model，所以往提交参数里加东西会自动纳入签名。`videoSignatureFromTask()` 从历史 sys_task 的 `prompt/provider/model/params` 反算（缺 `firstFrameUrl`、时长、画幅等 → `null`，归 `unknown`），`loadVideoVersions()` 按创建时间正序编号，`describeSignatureDiff()` 给出变化分项。承接镜头「转场未审核 → changed」不靠签名（转场文本提交前才生成），由 #11 在预览里按审核状态标注。
- **以图片为准（所有提示词层的硬规则）**：关键帧提示词、视频提示词、分镜描述与 H3 的 GLM 扩写都**不得**描述角色的物种、衣着、颜色、发型等外形属性；角色只用 `@名字`（提示词）或 `the character in <Picture N>`（H3）指代，名字只是昵称，不能据此推断外形。剧集 2 的"鼠妈妈 → 灰老鼠"就是文字与图片打架造成的。
- 服务端批量视频 `services/video-batch.ts` + `POST /episodes/:id/video-batch/preview`、`POST|GET /episodes/:id/video-batch`、`…/cancel`：**先预览再入批**，启动必须带预览勾选的 `storyboard_ids`（以及预览用的 `config_id/model`），没有「不带参数 = 全部未生成」的旧行为。预览逐镜返回 `missing`（没有任何版本，默认勾）、`changed`（与所有可比较版本都不同，默认勾，`change_reasons` 为分项中文名：提示词/关键帧/参考图/时长画幅/模型）、`unchanged`（命中任一历史版本签名，带 `matched_version_no`，默认不勾但可勾选强制重出）、`unknown`（历史版本都缺对比字段，默认不勾）、`blocked`（不可勾）、`skipped`（正在生成）；分类优先级 = 命中 → `unchanged`，否则有可比较版本 → `changed`，全缺字段 → `unknown`，无版本 → `missing`。批次按分镜顺序串行，状态持久化在 `video_batches`，重启由 `resumeVideoBatches()` 恢复（被打断的那一镜重新提交）。停止只是不再提交新的镜头，在跑的那一镜跑完后批次转 `cancelled`（没有 runner 时直接落盘 `cancelled`）。**写回等待**以任务终态为主、`storyboards.video_url === 任务 local_path` 为辅并保留 60s 超时——镜头本来就有旧视频时只看「非空」等于没等。
- **视频耗时统计与预估（Issue #28，`routes/videoQueue.ts` + `services/video-estimate.ts` 纯函数）**：`GET /video-queue/estimate?config_id=&model=&duration=` 用近 30 天 `sys_task` 完成视频任务现算墙钟（=提交→完成，含扩写/上传/排队/下载，文案必须叫「预计/用时」不是渲染耗时）中位数：同时长桶 `|d-d0|≤0.5s` → `basis='model-duration'`；本模型 ≥3 样本按每条 `elapsed/duration` 比值中位数 × 请求时长 → `model-scaled`；本模型不足回退同 provider 其它模型（样本最多的先试，先桶后缩放）→ `fallback-model` + `source_model`；全无 → `supported=false`。`model` 参数必须是该配置模型列表里的值（`ai_service_configs.model` 存 JSON 数组、`AIConfig.model` 只带首个，路由自行查全列表），服务端解析结果即统计键，H3 与 H3Fast 分别给数。`serializeTask()` 对外带 `elapsed_ms`（完成=`completed_at-created_at`，活跃=`now-created_at`，缺失/倒挂 `null`）。
- **视频页生成中状态与布局（Issue #28）**：进度环取 `useTasks` 的 `latestActiveVideoTask(storyboardId)`（只认 queued/processing 的最新任务）+ `ringPropsFromTask`，`videoTaskState()` 也改为**活跃任务优先**——有旧视频的镜头重绘中显示「生成中」并禁用按钮，不再被 `hasVid` 吞掉；「已用」时长由前端 `useNowTicker` 从任务 `created_at_unix` 持续推导（不依赖接口快照），右栏 footer 显示预估（`episode.vid.eta*` / `elapsed*` 文案），历史条每条显示 `elapsed_ms`。布局：中列 = 播放器 + 历史条 + 素材 + 关键帧，右栏 = 转场 + 视频提示词 + footer（时长/生效配置/生成按钮 sticky 底部），右栏默认 420px、拖拽 320–640（`VIDEO_COL_DEFAULTS/LIMITS` 与分隔条 calc 回退值三处同步）。ComfyUI 视频没有队列位置数据，环是不定弧 + 已用/预计，没有 `#N`。
- 前端关键帧页（`components/StoryboardKeyframes.vue` + `views/drama/episode.vue`）：批量对话框先调 `POST /episodes/:id/keyframe-batch/preview` 拿「分镜 × 槽位」清单（`missing/changed/unchanged/blocked/skipped`，`checked` 为默认勾选），分组复选 + 全选/清空，耗时估计按勾选数重问 `/image-queue/estimate`，启动时提交显式 `items`；「选择」模式只缩小预览范围。版本下拉显示 `version_no`（第 N 版），`unchanged` 显示「同第 N 版（当前选中第 M 版）」。
- 前端视频页批量（`views/drama/episode.vue`）：「批量生成视频」先调 `POST /episodes/:id/video-batch/preview` 拿逐镜清单（`missing/changed/unchanged/unknown/blocked/skipped`，`checked` 为默认勾选，`selectable=false` 的不可勾），复选 + 全选/清空，`unchanged` 显示「与第 N 版相同」、`changed` 显示「变化：提示词/关键帧/…」，确认后只提交勾选的 `storyboard_ids`；没有 `!hasVid` 的本地过滤，也不再按「全集关键帧确认」禁用按钮（只有批次运行中才禁用）。
- 一致性问题（后端 `ref_issues`，`message` 直接展示）：关键帧页参考图区与各槽位、视频页视频提示词下方常驻列表，列表行显示问题计数；提示词保存 / 绑定切换 / 资产版本切换后只 toast **新增**的问题，`ref_sync` 的自动绑定/解绑各 toast 一次。阻断问题会禁用对应槽位与视频的生成按钮（title 给原因），服务端 400 的中文原因由 `toastServerMessage` 原样展示。
- 字段保存反馈：`episode.vue` 的 `updateField` 返回 Promise，按（分镜, 字段）维护状态（`有未保存的修改 / 保存中… / 已保存 · N 秒前 / 保存失败`），加载时用 `field_saved_at`（unix 秒）显示「上次保存 · N 分钟前」；相对时间由 `components/FieldSaveStatus.vue` 用 `useNowTicker()` 的 1s 共享心跳本地计算。覆盖画面描述、氛围、首/中/尾提示词、中间帧时间、视频提示词。
- `components/MentionTextarea.vue`：透明 textarea 叠在高亮镜像层上，两层都设 `scrollbar-gutter: stable` 且 `@引用` 不加粗——否则出现滚动条后两层换行位置不同，光标会逐行偏移（实测末行差 ≈3 个汉字）。

### 图片生成（Qwen Image 2.1 / qwen-jobs）
- 入口：`.110`（2×RTX 3060）的 `https://110.joyai.dev/image`（Cloudflare 隧道 + HTTP Basic auth，凭据只存 `ai_service_configs.api_key`，格式 `user:password`，火宝用 `huobao` 账号）。LAN 备选 `http://172.30.3.110/image`（免鉴权）。ComfyUI 不再对外暴露，它是该服务的私有 worker（每卡一个，一次一张）。
- provider 叫 **`qwen-jobs`**：服务端持久化排队、跨应用公平调度（火宝/studio 轮流出队）、按任务 ID 查询与取消、按分辨率实测时间估计。应用**不再提交工作流**，只传参数，三种固定模式：无参考图 → `text_to_image`（`pickQwenSize`：对齐 32、总像素 ≤2048²）；有参考图且是关键帧（`frameType` 命中槽位）→ `reference_to_image`（按剧集画幅出图）；其余有参考图 → `image_edit`（输出跟随第 1 张参考图，用于角色/道具）。提示词用 `<image1>` 指代参考图，没写时自动补前缀；参考图最多 9 张。
- 客户端 `adapters/qwen-jobs-client.ts`：`POST /v1/files`（按 sha256 进程内缓存 file id）、`POST /v1/jobs`（幂等键 `huobao-sys_task-<id>-<uuid>`，首次提交时生成并随请求体落盘；只用 id 会在数据库拷贝/重建后撞键）、`GET /v1/jobs?ids=`（≤100 批量）、`POST /v1/jobs/{id}/cancel`、`DELETE /v1/jobs/{id}`、`GET /v1/jobs/{id}/outputs/{n}`、`/v1/capacity`、`/v1/estimate`。
- 客户端身份（Issue #22）：`request()` 统一带 `X-Qwen-Client: huobao`（常量 `QWEN_CLIENT_ID`），qwen-jobs 据此做公平调度与任务/文件归属；110 网关不再写这个头，身份与走 LAN 还是隧道无关。
- 生命周期：`generation.ts` 提交前把完整请求体写进 `sys_task.remote_state.request`（含已上传的 file id）再调远端，拿到远端 id 立即落盘 `task_id`；之后由常驻追踪器 `services/qwen-jobs.ts` 每 3 s 批量查询，回写 `status`（queued→`queued`、running→`processing`）与 `remote_state`（排队位置/进度/估计）。成功时**先取回字节落盘再标 `completed`**（服务端取回即删，再取 410）。**没有客户端超时**：20 分钟超时与 worker 掉线由服务端处理。网络错误/5xx/网关 530 一律当瞬时故障下轮重试，只有远端 failed/cancelled、记录消失（连续 3 轮查不到）、输出已回收（410）才是终态。
- 重启恢复：`index.ts` 的启动清理**跳过** qwen-jobs 的活跃任务；有 `task_id` 的由追踪器继续跟，没有 `task_id`（提交途中重启）的按同一幂等键原样重发（服务端去重，不会重复跑）。任何**重试都必须新建 sys_task**（新幂等键），否则服务端会直接返回原任务而不重跑。
- 任务状态：`sys_task.status` 为 `queued | processing | completed | failed | cancelled`，活跃判断一律用 `isActiveTaskStatus()`（`services/sys-task.ts`）。所有返回任务的接口用 `serializeTask()` 输出 snake_case + 已解析的 `remote_state`（剥掉内部键 request/config_id/idempotency_key）+ `cancellable`。`POST /tasks/:id/cancel` 取消（非 qwen-jobs 返回 400）；`GET /image-queue/estimate?config_id&size&references&count` 给前端等待估计（整批 = 当前等待 + ⌈张数 / 在线卡数⌉ × 单张，在线卡数 = total − offline）。
- 速度参考（3060，25 步）：1024² ≈ 90 s，1344×768 三参考图关键帧 ≈ 175 s。模型：azukivc Q6_K GGUF + Comfy-Org int8 convrot 文本编码器 + bf16 VAE（固化在服务端，仓库里不再有工作流模板）。

### 项目设置（风格 / 画幅，Issue #16）
- 风格 = `dramas.style`（存 `style_presets.value`），由 `services/style-preset.ts getDramaStylePrompt()` 解析成预设英文词，**自动前置**到关键帧、分镜视频、手动视频任务与资产兜底提示词；Agent 保存资产最终提示词时会把风格词**烘焙进** `characters/scenes/props.final_prompt`。剧本改写/拆分分镜不写风格词。
- 画幅 = `dramas.aspect_ratio`，白名单 `16:9 / 9:16 / 4:3 / 3:4 / 1:1`（`routes/dramas.ts ASPECT_RATIOS`，与 `KEYFRAME_SIZES`、H3 `pickResolution` 一致）。`POST /dramas` 必须带合法画幅（无默认，前端创建对话框不预选，必选）；`PUT /dramas/:id` 画幅不在白名单 → 400，项目不存在 → 404。不再有 `adaptive`（它在 qwen 关键帧与 H3 上静默回落 16:9）；存量 legacy 值只读兼容，不能再写入。
- 创建后在项目详情页「项目设置」（齿轮按钮）可改风格与画幅；页头显示风格预设名（`composables/useStylePresets.ts` 的 `label()`，模块级预设清单，`ASPECT_RATIO_OPTIONS` 也在这里）与画幅。
- **改风格（新值 ≠ 原值）时后端清空本项目三类资产的全部 `final_prompt`**（含手工修改过的），下次生图由 `services/final-prompt.ts ensure*FinalPrompt` 按新风格重写；同值保存不清空。已生成的图片/视频不自动重做：关键帧与视频签名都对**含风格词的最终提示词**和尺寸/画幅取哈希，改动后批量预览自动把旧镜头标「已变化」。
- 角色定妆照固定 1920x1080（`routes/characters.ts CHARACTER_IMAGE_SIZE`），不随项目画幅变化。

### 纪录片旁白骨架编辑（Issue #81）
- 骨架编辑（含缺口三种处置、并入和拆分）先暂存，统一保存；防抖调用 `PUT /episodes/:id/narration-skeleton` 的 `validate_only`，复用后端逐字校验。缺口坐标为去空白及节拍标记的剧本位置；超过 80 字应在保存前拆分。出处及版权信息应回旁白稿处理（#80）。
- 保存使用 revision CAS；修订变化使确认失效，需重新确认。冲突时刷新后重新编辑。并入的镜软删除并保留媒体；`backend/src/services/narration-skeleton.ts` 的 `saveNarrationSkeleton` 会将文本变化镜及结构变化邻镜的设计卡标 stale。
- 配音仅当前有效时可试听；存在 URL 但无效时标记已过期，不允许播放旧音频；没有 URL 显示未生成。播放器不预加载，地址附生成版本以避免缓存。

### 旁白配音参数（Issue #37）
- 唯一实现 `services/narration-voice-params.ts`（纯函数，行为测试 `backend/tests/narration-voice-params.test.mjs`）。生效参数 = 集级 `episodes.tts_settings`（JSON `{voice, inference_timesteps, cfg_value, seed|null, instructions}`）→ TTS 配置行 settings → VoxCPM 默认（10 步 / cfg 2.0 / seed 随机）；规范化沿用 #35：镜级 `storyboards.narration_normalize` → 集级 `episodes.narration_normalize`。
- 单镜「生成/重新生成配音」与「批量生成配音」都先弹 `components/NarrationVoiceDialog.vue`：选项来自 `GET /episodes/:id/tts-options?storyboard_id=`（实时读 VoxCPM Studio `GET /api/voices`，分组同 Studio「我的音色」+「预置 · 分类」；步数 2–30 + 预设 4/10/30 及 RTF 0.35/0.49/0.93；cfg 1.0–3.0），预填当前生效值。确定 = `settings` 随 `POST /storyboards/:id/narration/voice` 或 `POST /episodes/:id/narration/voice-batch` 提交，服务端校验（音色必须在列表里）并**保存为本集默认**（规范化写当前生效那一层：单镜有镜级覆盖则写镜级）。
- 批量统一口径：只配 `missing`（无配音）+ `changed`（`text_sha256` 变了，或 `meta.audio.params` 与本次参数逐项不同）；手动选镜只缩小范围。`POST /episodes/:id/narration/voice-batch/preview` 与执行共用 `classifyVoiceShot`。seed 比较的是**所选值**（随机 = null）。`meta.audio.params` 记录实际请求参数；#37 之前的存量音频按当时事实重建（`normalize=false`），所以开规范化后存量配音会显示为「已变化」。
- 「实测配音 + 留白超 15 秒」只挡合成、不挡配音（单镜按钮与批量都放行）：换音色/参数重配本身就是解决办法之一（#38 一并修正）；配音只被「字数超 80」与发音标记写错挡住。

### 旁白发音标记与编辑器（Issue #38）
- `narration_text` 存**源写法**：`[[原文|拼音]]`（逐字音节、声调 1–4，如 `[[可汗|ke4 han2]]`）、`[[原文|同音字]]`（等长，如 `[[单于|蝉于]]`）、`[[停顿|秒]]`（0.1–10）、`[[语气|tag]]`（VoxCPM 11 个非语言标签）。唯一解析 `services/narration-markup.ts`，前端 `utils/narrationMarkup.js` 同口径（`backend/tests/narration-markup.test.mjs` 逐例对照）。普通标点（，。……）就是自然停顿，照常作为正文。
- 三种派生：`spokenText`（字幕/字数/80 字上限/预计时长，时长另加停顿秒数）、`engineSpokenText`（VoxCPM 实际念的字，与字幕逐字等长，供 `buildSubtitleCues({alignText})` 对齐时间戳）、`toVoxcpmText`（`可汗(ke4 han2)` / `蝉于` / `[停顿1.5秒]` / `[sigh]`；正文 `()（）` 一对一换 `〔〕`、`[]{}` 换全角，避免被 Studio 误当标记）。`text_sha256` 仍对源文本取哈希（改任何标记都让配音过期）。
- 合成前先调 Studio `POST /api/markup/preview`：有错误或它认出的朗读文字 ≠ `engineSpokenText` 就不合成。Studio 一见拼音注音就关掉整段 normalize，所以「拼音注音 + 阿拉伯数字 + 规范化开」给警告 `narration_phoneme_no_normalize`（改用同音字）；标记写错是阻断 `narration_markup_invalid`，`save_narrations` 也据此退回模型。
- 编辑器 `components/NarrationEditor.vue`（取代旁白 textarea）：高亮镜像层 + 工具条「注音 / 多音字检查 / 语气 / 停顿」全部弹窗选择后插入；注音候选来自前端 `pinyin-pro`（过滤轻声）+ Studio 常见多音字例词（`GET /episodes/:id/narration-markup-catalog`），光标落在标记内出现「编辑 / 删除标记」。插入/删除标记立即保存。
- AI 写旁白（四语提示词与 skill「多音字与读音标注」）：只给有误读风险的多音字/专名加拼音注音，本镜有阿拉伯数字时改用同音字；**不写停顿与语气**（待实例总结后再定）。

### 叠加图层：数据模型 / 服务端渲染 / Canva-lite 编辑器（Issue #48）
- `LayerDoc` 的唯一 schema 与规范化在 `services/layer-doc.ts`：`{version:1, base:{path,width,height,filter?}, theme:'archival'|'clean'|'ink', layers[]}`，图层类型 `polygon|polyline|marker|label|card|image`，公共字段 `id/name/visible/locked/z/opacity/rotation/anchor{asset_id,semantic_id,detached}`。**坐标 x×宽、y×高，一律钳在 0–1**（跨 Issue 契约；编辑器 `useLayerDoc.patchLayer` 同口径先钳再写，避免画布与服务端规范化结果不一致）；**所有标量尺寸（字号/线宽/点半径/圆角/边框）都是输出高度的比例**（与 Poster 的 fontSize 同口径），所以换输出尺寸不用改文档。框的 `w/h` 可到 2、marker 的 `label_offset` 可到 ±0.5，所以内容仍可越出画面右/下边缘。规范化只做白名单 + 钳制 + 按 z 稳定排序（id 冲突时找不重复的后缀），**不注入主题默认值**；样式缺省由渲染层的 `THEME_PRESETS` 兜底。上限：60 图层 / 240 点。
- 画面由**前后端同源**的纯函数生成：`services/layer-svg.ts` 与 `frontend/app/utils/layerSvg.js` 必须逐行等价（`backend/tests/layer-svg.test.mjs` 逐例对照，口径同 `asset-name` / `narration-markup`）。两端唯一允许不同的是图片 `href`（服务端内联 data URI、前端走 `mediaUrl`），由调用方传 `resolveImage`。编辑器直接把这份 SVG 插进画布，所以「所见即所得」是结构保证。
- **文字排版是固定模型，不读字体度量**：宽字 1.0em / 空格 0.33em / 其它 0.55em，行高 1.35em、基线 0.88em，贪心换行（全角逐字断、拉丁整词断、超长词硬切、行首禁则不换行）。这样 librsvg 与浏览器断行完全一致；改这几个常数等于改所有历史图层的版面。
- **底图确定性风格化**（父 Issue #44 Q1 的「先精准后美化」里的精准侧）= `base.filter{paper,tint,tint_strength,vignette}` → `baseFilterLayers()` 产出若干张**纯 alpha** 覆盖层。**不要用混合模式**：实测 libvips 的 multiply/soft-light 对半透明源与浏览器 `mix-blend-mode` 结果差一大截（白底 + 30% sepia：sharp 198,196,192，浏览器 244,237,225），改回混合模式就会出现「编辑器暖、成图灰」。
- 渲染 `services/layer-render.ts`：`sharp(底图).resize(fill).composite([风格化层…, 叠加层 SVG]).png()`。底图与 `image` 图层路径都必须落在 `DATA_ROOT` 内（越界/缺文件给中文原因）。接口 `POST /api/v1/layer-docs/render`（返回 PNG，响应头 `X-Render-Ms`）、`POST …/render-to-file`（落盘 `static/overlays/<uuid>.png`）、`GET …/fonts`（自检状态）、`GET …/fonts/:file`（打包字体，供编辑器 `@font-face`）。
- **1344×768 单帧实测（各连测 10 帧取中位，给 #50 片段渲染做容量规划）**：纯色小底图 + 6 图层无滤镜 **16 ms**；真实地图底图（2.2 MB 原图）+ 6 图层 + 全滤镜 **558 ms**（375 帧 ≈ 209 s，**超 #50 的 ≤60 s/镜目标**）；把「底图 + 风格化」**预渲染一次**后每帧只画叠加层 **188 ms**（≈71 s），大头是 2.8 MB 肖像每帧内联成 data URI 重新解码；再去掉内嵌图片（纯矢量/文字图层）**60 ms**（≈23 s）。结论：#50 做帧序列必须 ① 先把底图 + 滤镜合成成一张输出尺寸的中间图，② 把 `image` 图层位图预缩放到出图尺寸并复用，否则单镜要跑 3 分钟以上。
- **字体必须是仓库里的**：`backend/assets/fonts/` 打包四族子集（7 件 ≈ 58 MB，OFL：Noto Sans SC / Noto Serif SC / LXGW WenKai / Ma Shan Zheng；覆盖区间、子集化命令与许可见该目录 README）。kai/hand 的字形覆盖较小，缺字按字族栈回退到打包的 Noto，渲染前的缺字检查仍以 Noto 四件交集为准。`services/layer-fonts.ts` 启动时生成只含本目录的 fontconfig 配置并指向它（不读系统字体，保证跨机确定性），再做一次探针渲染（有墨迹、与缺字占位图可区分、sans≠serif）；启动失败只告警，**渲染时直接抛错**。文字里出现打包字体未覆盖的码位 → `POST /layer-docs/render` 400 并列出具体字符，**绝不输出豆腐块**；编辑器样式面板同步提示。
- 编辑器 `frontend/app/components/LayerCanvas/`（`LayerCanvas` 画布 + `LayerList` z 序/显隐/锁定/重命名 + `LayerStyle` 分类型样式面板）与 `composables/useLayerDoc.ts`（撤销栈 ≤100、300 ms 防抖保存；人工改几何自动给 `anchor.detached=true`）。画布尺寸由 JS 按视口实测算出——grid/flex 里 `aspect-ratio + max-width:100%` 会按内容宽解析，1280 工作台下画布会超出中栏被裁。演示页 `pages/dev/layer-canvas.vue` 只进 dev 构建（`nuxt.config.ts` 的 `pages:extend` 在 production 里剔除 `/dev/` 路由）。
- Poster（#72）已迁到同一套图层编辑器（`PosterLayerEditor.vue` + `LayerCanvas/LayerRail/LayerList/LayerStyle`），旧 `PosterCanvasStage`/`PosterTextTools`/`posterCanvas.js`/`posterLayout.js` 与 `poster-layout.ts` 已删除，不再有两套编辑器。

### Poster AI 构想与图层编辑器（Issue #72）
- 数据：`episode_posters` 新增 `layer_doc` / `concept` / `copy` / `provenance` / `concept_updated_at`，`poster_versions` 新增 `layer_doc` / `concept_composition_id`；旧 `layout` 列保留但**不再读写**，旧 canvas 路径整体删除（用户授权丢弃旧排版）。
- AI 构想 `services/poster-concept.ts`：输入 = `episodes.script_content`（仅 AI 改写/拆分稿，`stripProvenanceBlock` 剔除文首出处块）+ 本集资产描述；一次产出 **3 个**构图方案（`theme/theme_reason`、`compositions[].{assets,image_prompt,text_description,copy,layer_plan}`，只标一个推荐），`assets` 必须属于本集、有图、逐个 `@` 且同名不重复。`poster_concept` 是 `sys_task(type='text', params.kind='poster_concept')`，只写 `concept` 与 `concept_updated_at`，**不碰**当前 prompt/text_prompt/copy/layer_doc；任务中心标签「Poster 构想」，`retryText` 有专门分支。模型输出结构不符时同一次任务内纠正一次。长剧本按 8000 字分段提炼（不静默截断），`script_segments_used` 记录覆盖段数。
- 底图：`POST /poster/concept/generate` 对每个方案用**冻结快照**（`assets[].path/version_task_id`）各提交一个 `initial` 任务，三项互不依赖；任一失败不影响其他项，候选卡显示失败原因并可用「生成这张底图」重试该方案。所有 `initial` 前置项目风格词并追加硬约束「画面中不要出现任何文字/字母/数字…」；`text_description`/`copy` 不进 initial。`concept_composition_id` 落在 `poster_versions`，刷新后仍按方案归属展示；选一张不删其余。
- 无底图时只有**推荐方案**的图自动成为临时编辑底图（`posterAutoBase`），自动时同时写 `layer_doc.base.path/width/height/source_width/source_height`，不设最终版本；完成瞬间用户已有底图则不覆盖。推荐方案失败不影响其他候选。
- 应用：构想只产 `concept`；`POST /poster/concept/apply` 应用字段、`…/apply-layer-plan` 只替换 `ai:` 前缀层。字段 provenance（`ai|manual`，图层逐 id）在 `services/poster-store.ts`；目标字段为 `manual` 且 `overwrite!==true` → 409 `manual_edit_conflict` + `fields`，前端弹「有手动编辑，是否需要覆盖？」。重复应用不重复文字，固定变量层与人工层保留。
- 图层文档：`label.variable ∈ project_title|episode_title|episode_no`（只读，渲染取 `variables`）；label 样式新增 `italic`（skewX）与 `shadow`（SVG filter）；字体枚举 `sans|serif|kai|hand`；card 新增 `scale`。`layer-svg.ts` 与前端 `layerSvg.js` 同源（`layer-svg.test.mjs` 逐例对照），`layerBounds` 用解析后的变量文本。`services/layer-render.ts` 新增 `transparent` 输出（只画 SVG，不要求底图），Poster `layers` 模式的底图与透明叠加层都由服务端渲染，不再依赖浏览器 canvas。
- 接口：`GET/PUT /episodes/:id/poster`（接受 `prompt/text_prompt/copy/reference_images/base_image/layer_doc`）、`POST /poster/generate {mode:initial|composite|layers}`、`POST /poster/concept`、`POST /poster/concept/generate`、`POST /poster/concept/apply`、`POST /poster/concept/apply-layer-plan`、`POST /poster/versions`（服务端渲染合成图并设最终版本）、`PUT /poster/select`、`POST /poster/load-version`。底图为空允许保存/编辑图层，`composite|layers` 与渲染合成返回 400「请先生成或选择底图」。FLUX 仍不支持 layers，多参考图引用失效时 400 并给换模型/只留第 1 张的提示。
- 前端：`PosterLayerEditor.vue`（画布 + 底图候选 + 变量按钮 + 保存 + 渲染合成）+ 重写的 `PosterPanel.vue`（画布优先布局；构想卡显示方案/推荐/资产/三张候选图与「设为最终版本」「作为编辑底图」；文案输入、参考图命名/人工分区、冲突弹窗）。文本模型由 `episode.vue` 的 `chat-model/chat-config-id` 注入。Poster 四语 locale 新增 `poster.concept.*` / `poster.conflict.*` / `poster.variables.*` / `poster.editor.*`；`layerCanvas.font.kai|hand`、`layerCanvas.style.italic|shadow|scale|variable*`。
- 明确不做：不做旧 Poster 排版迁移、不做剧本/资产变化自动失效、AI 图层规划只产 label/card、不产图片/几何层。

### 纪录片 7 步工作流骨架与步骤门禁（Issue #54）
- 纪录片项目（`project_type='documentary'`）的步骤是 **剧本 → 资产（资产卡 / 审核清单）→ Poster（可选·不入链）→ 分镜设计 → 分镜制作 → 视频与成品 → 导出**（Issue #63，用户确认的 Poster 第 3 步覆盖初稿第 6 步）；剧情项目仍是 **剧本 → 资产 → Poster → 分镜关键帧 → 视频制作 → 导出**，行为与 #54 之前逐字一致。
- **工作流结构的唯一口径是 `isDocumentaryProject`（`project_type`）**；`isDocumentaryRuleset`（`genre_ruleset`，#54 由 `isDocumentary` 改名）只驱动内容规则类能力（当前唯一用处 = 选角名册按钮）。drama 3（`project_type='drama'` + `documentary_rules=on`）因此仍走剧情 6 步并保留名册按钮。禁止互相顶替。
- 服务端门禁的唯一实现 `backend/src/services/workflow-gates.ts`：纯函数 `computeGates(facts)` + `episodeGates(id)` + `assertGate(id, gate)`（`gate ∈ assets|design|production|final|poster|export`）。解锁规则**逐级传递**：资产 ← 剧本已确认；分镜设计 ← `episodes.asset_review_status='passed'`；分镜制作 ← 至少一镜设计已确认（**R4 落地前过渡读 `storyboards.intent_reviewed`**）；视频与成品 ← 至少一镜制作就绪（过渡读 `keyframes_confirmed`）；导出 ← 至少一镜成品 `exportable`（compose-state 同源）；Poster ← 跟随资产解锁，可选不入链。`reasons[step]` 永远写**最靠上**的未满足原因，`goto[step]` 指向真正阻塞的那一步。剧情项目恒全解锁、`reasons` 为空。
- 对外接口：`GET /episodes/:id/gates`、`POST /episodes/:id/script/{confirm,unconfirm}`。门禁拦截点：`POST /agent/storyboard_breaker/chat`（纪录片）、`/episodes/:id/storyboards/fill-gaps`、`/episodes/:id/generate-intents`（R4 改名为 `/design-cards/fill` 时沿用同一个 `assertGate`）走 `design`；`/episodes/:id/extract` 与三类资产的 `/:id/re-extract` 走 `assets`（**必须在清空字段之前**）。资产生图 / 美化流水线**不拦**——资产是项目级、可跨集复用。
- 400 响应形状固定 `{code:400, error:'gate_blocked', gate, reason, message}`，转换**只在 `src/index.ts` 的全局 `app.onError`**（`middleware/logger.ts` 的 `errorHandler` 对 `GateBlockedError` 原样向上抛），各路由不自己 try/catch。
- 剧本确认：`episodes.script_confirmed_at`（NULL = 未确认）。`onScriptChanged(episodeId, reason)` 是剧本变更的**唯一钩子**（事件名 `script_changed`），挂在 `PUT /episodes/:id`（content / script_content 真的变了才触发）与 `save_script` 工具上；R4 在同一函数里补「设计卡置 stale」。启动时 `backfillScriptConfirmation()` 做**一次性升级迁移**（`app_settings` 的 `workflow_gates.script_confirm_backfilled` 标记拦住后续重启，用户之后改稿/取消确认的集绝不会被重新确认）：**纪录片集已有分镜 → 视为已确认**（否则第一轮产物会被新门禁锁死），无分镜的集与剧情集保持 NULL。
- `episodes.asset_review_status`（`none|running|pending|passed`，默认 `none`）与 `asset_review_stale_reasons`（JSON 数组，只做横幅、不回退 `passed`）由 R2（#55）写值，R1 只建列并把非 `passed` 当未通过；门禁文案由 R2 的纯函数 `assetReviewGateReason(status, missingCount)` 给出，`GateFacts.assets.missing` 是它的入参来源。
- 前端：步骤/页签/重映射的纯函数在 `frontend/app/utils/workbenchSteps.js`（URL `?tab=` 与 localStorage 面板记忆共用；旧链接 `expression→design`、`layers→production`，纪录片下 `keyframes→production`、`videos→final`），门禁数据走 `composables/useWorkflowGates.ts`（refresh / 剧本保存确认 / 任务结束 / 页签切换时刷新）。锁定步骤在侧栏与进度条显示锁图标 + 原因 tooltip，点击跳到阻塞步骤；**deeplink 直达锁定步骤只渲染锁定空态**，服务端另有同一道闸门。
- **每步一个稳定挂载组件**，`episode.vue` 对这些步骤只保留挂载行：`ScriptStepPanel` / `AssetReviewPanel`（R2 填充）/ `DesignCardPanel`（R4）/ `ShotProductionPanel`（R5）/ `VideoShotPanel`（R7）/ `PosterPanel` / `ExportPanel`（R7）。`VideoShotPanel`、`ExportPanel`、`ScriptStepPanel` 的状态与方法由 `episode.vue` 经 `provide(WORKBENCH_CTX, …)` 注入（单一数据源仍在 episode.vue）。后续 Issue 只改面板内部，不再回 `episode.vue` 改 markup。
- 术语（四语 locale 同步）：表达设计 → **分镜设计**（`episode.prod.design` / `episode.stage.designDesc`）、图层 → **分镜制作**（`episode.prod.production`）、新增 **视频与成品**（`episode.prod.final`）；`episode.compose*` / `episode.export.sourceComposed|repairFusion` 的「融合 / fusion / 융합」文案一律改为**合成成品**（键名不变）。服务端 `task-label.ts`、`ai-stages.ts` 的 `shot_intent` 标签与 `storyboard-assets.ts` 的 `intent_unmet` 消息同步改为「分镜设计」。`episode.intent.*` 随 R4、`episode.clip.*` 随 R5 删除。

### 分镜设计卡 design card（纪录片专属，Issue #57，替换 #49 的表达设计）
- 一镜最多由两段组成：**▣ 图层段**（确定性渲染，≤30 s）与 **▶ 生成段**（视频模型，≤15 s），二者不互斥。段组合 `storyboards.combo ∈ A|B|C|D`（A 只图层 / B 只生成 / C 图层→生成 / D 生成→图层）是**显式人工选择，没有默认值**，AI 只写 `design_card.suggested_combo`（服务端忽略模型给的 `combo`）。C 的首帧 / D 的尾帧由**衔接帧**锁定继承（派生归 R5）。
- 列：`storyboards.combo`、`design_card`（JSON）、`design_card_status ∈ blank|ai_filling|pending|confirmed|stale`、`design_card_confirmed_at`、`design_card_stale_reason`。`intent` / `intent_reviewed` 两列已由 `services/design-card-migration.ts` 转换后**自行 DROP COLUMN**（`sqlite-schema.ts` 的 `columnRemovals` 跑在数据迁移之前，不能用），回滚需从 DB 备份恢复。
- 唯一 schema / 规范化 / 校验在 `services/design-card.ts`（纯函数，不读库）：链条是 **信息点 `info_points[{id,text,via}]` → 图层段计划 `layer_plan{base, must_mark[], planned_layers[]}` → 生成段计划 `gen_plan{reference_assets[], first/mid/last}` → 预算 `budget{layer_s, gen_s}` → `rationale`**。`issues` **读时重算、不落库**；阻断码 `combo_missing / budget_over_layer / budget_over_gen / budget_under_narration / missing_base / gen_slot_missing`，警告码 `info_point_unassigned / must_mark_not_planned / reference_not_mentioned / budget_tight / unresolved_ref`。配音实测时长只重算问题，**不回写 `budget`**。
- **解析不到的引用保留并标 `unresolved`，绝不静默删除**（沿用 #49 的原则）。解析上下文 `services/design-card-context.ts` 的 `loadDesignCardContext(episodeId)` 必须保持**同步**（一致性检查在 `syncStoryboardBindingsFromPrompts` 的同步事务里调用，中途 await 会丢更新，#43 的教训）；底图候选 `listBaseCandidates()` 是异步的，单独走路由，**不进同步上下文**。`buildDesignCardBriefs()` 给关键帧/视频提示词批量拼「本镜设计卡 + 前后镜」的 message 片段。
- 接口全在 `routes/design-cards.ts`（按 posters 的先例双挂载到 `/episodes` 与 `/storyboards`，`routes/episodes.ts` 只负责删掉旧的四条 intent 路由）：`PUT /storyboards/:id/design-card {combo?, design_card?}`（任何写入 → `pending`；预算超硬上限 400 `budget_over_layer|budget_over_gen`；已确认且有制作产物时改组合 400 `{gate:'combo_switch'}` 指向 R5）、`POST …/design-card/confirm {acknowledge?}`（0 阻断才放行，有警告需 `acknowledge:true`，否则 400 `blocked` / `needs_acknowledge` 并回传 `issues`）、`POST …/design-card/unconfirm`、`POST /episodes/:id/design-cards/fill`、`GET …/design-cards/{status,audit}`、`GET /episodes/:id/design-card-context`、`PUT /episodes/:id/storyboards/order {ids}`（ids 必须是本集存活分镜全集，两阶段负号写入 + 「上一镜变了就撤销关键帧确认」级联）。**`ai_filling` 中对同一镜的 PUT/confirm/unconfirm 一律 409 `card_busy`**。
- AI 环节 `AI_STAGES.design_card = { vision: true }`（替换 `shot_intent`），调用点 `services/design-card-batch.ts`，任务 `sys_task(type='text', params.kind='design_card')`。续跑语义：指定 ids 重填这几镜，否则只补 `blank`/`stale`；运行期该镜置 `ai_filling`，成功写 `pending`、失败回原状态；**重填前把整批旧卡写进该次任务的 `params.previous_card`**（不存 `__prev`）。工具收窄用 `storyboardPromptScope='design_card'`（只给「读上下文 + `read_image` + 只写 design_card」，不给 `save_storyboards`）。
- `ref_issues` 码 **`card_ref_unmet`（阻断，取代 `intent_unmet`）**：启用了生成段的镜头，`gen_plan.reference_assets` 每一条都必须被**写了内容的**关键帧/视频提示词 `@` 到。`combo='A'` 的镜头不再报 `empty_video_prompt`（整镜由图层段渲染，本来就没有模型视频），也被 `keyframe-prompts.ts` / `video-prompts.ts` / `video-batch.ts` 跳过（判据从 device 常量换成 `combo`，`clipPositionOfCombo()` 在 `storyboard-clips.ts`）。`clip-draft.ts` 改读 `layer_plan`（最小端口，卡片字段/默认位置/底图回退三项缺陷仍归 R5）。
- **拆镜硬上限（契约 §8）**：`save_storyboards` 的纪录片变体在写库前算 `cap = min(ceil(段数 × 1.5), 段数 + 3)`（段数 = `scriptParagraphs(script)`，`services/narration-first.ts`），超出的镜**逐条拒存**并写进返回值 `rejected[]`；**空旁白拒存**（纪录片每镜必须承载一段旁白，旧的「关掉旁白」分支已删）；**重复旁白拒存**（按 `narrationMatchKey` 归一化比对本集既有镜 + 本批）。止损：同一集**连续 2 批整批被拒** → `consumeStoryboardStopReason()` 把合并建议交给调用方（`routes/agent.ts` 与 `storyboard-fill-gaps.ts`），任务判 `failed`，不让模型无限重试。
- 过期传播的唯一写入口 `services/staleness.ts`：`onScriptChanged()` → 整集设计卡 `stale`（`script_changed`）；`markDesignCardsStaleForReviewItems()` 消费 R2 的 `changed_item_ids`，只把**引用了被改动条目**的卡置过期（`asset_review_items` 表还没合并时返回 0，表一出现自动生效）。`blank` / `ai_filling` 的镜头不置过期。
- 技能（四语）：`documentary-storyboard` 的 §4 改写为设计卡链路 + 组合建议规则（**永不决定 `combo`**）+ 三条硬规则；`documentary-keyframe-prompt` 的 device 分支表换成 combo 分支（A 不写提示词、C/D 的锁定槽位不写提示词，阻断码文案改 `card_ref_unmet`）。
- 前端：`components/DesignCardPanel.vue`（R1 的挂载壳内部）+ `components/AssetPicker.vue`（统一素材/语义条目选择弹层）；i18n 键组 `episode.design.*`（四语同步），`episode.intent.*` 已删除。镜表支持拖拽与上移/下移重排。

### 资产审核清单（纪录片专属，Issue #55）
- 「资产」步第二个子页签：AI 逐段对照旁白稿列「信息点 → 需要的素材 → 有/缺」，每条必须被处置成 `have|added|ignored|not_needed`，否则 `asset_review_status` 停在 `pending`，#54 的门禁把「分镜设计」锁死。剧情项目（含 `documentary_rules=on` 的 drama 3）不渲染该页签，所有接口 400 `not_documentary`，两列永不写值。
- 表 `asset_review_items`（`UNIQUE(episode_id, fingerprint)`）。**条目身份 `fingerprint = sha256(归一化信息点 + need_kind)`，不含段号**——剧本中间插一段不会让后面所有条目重来。重跑合并三步：指纹命中 → 只刷新 `run_id/segment_no/narration_excerpt/need_desc`（处置、绑定、`decided_at` 原样保留）；未命中 → 在「本次没被认领且**已处置**」的旧行里按**信息点相似度**（`infoPointSimilarity`，归一化后二元字组 Dice，阈值 `INFO_POINT_MATCH_MIN = 0.5`，包含关系算 1）取最像的一条迁移；仍未命中 → 新行，最后把没被认领的旧行删掉。结果 `{kept, added, removed, changed_item_ids[]}` 落在 `sys_task.params.review_diff`，读接口 `run.diff` 回传，并在合并后**调用一次** `markDesignCardsStaleForReviewItems()`（R4 接缝）把引用这些条目的设计卡置过期。
- **重跑必须保住上一轮的处置**：每段提示词都带「上一轮清单的信息点」全集，要求模型对同一信息点**逐字沿用旧措辞**；相似度兜底只是第二道闸。实测（殷墟 6 段）不带旧信息点时 GLM 整句改写 → `kept 12 / removed 21`，带上之后 `kept 31 / removed 2`。改这两处任一都要重测重跑保留率。
- 唯一读写口 `services/asset-review.ts`：`startAssetReview`（`sys_task kind='asset_review'`，逐段一次 `callTextChat`，单段失败只计 `failed` 不中断）、`getAssetReview`、`updateAssetReviewItem`、`recomputeAssetReviewStatus`（优先级 **running > pending(有 missing) > passed > none**）、`markAssetReviewStale`、`revalidateAssetReviewBindings`、`onAssetLibraryChanged/onEpisodeAssetLinkChanged/onAssetRemoved`、`onReviewExtractionFinished`、`bindCreatedAssetToReviewItem`、`reviewExtractionPlan`。依赖方向固定 **extraction → asset-review**（补提取的回链钩子），`routes/asset-review.ts` 负责发起提取，服务层不反向 import。
- 模型只写 `info_point / need_kind / need_desc / match_name / match_semantic_name / not_needed`，**不写 `status`、不写任何 id**；状态由服务端判：`not_needed` → `not_needed`，`match_name` 能按 `normalizeAssetName`/`normalizeNearName` 解析到**本集**资产且类别相容 → `have` + 绑定（`prop_faithful` 只认 `props.faithful=1`，`exposition` 只认 `exposition=1`），其余 `missing`。`match_semantic_name` 按 `points/regions/lines[].name` 与 `labels[].text` 解析成 `semantic_id`，解析不到就只留资产级绑定，**绝不编造条目 id**。
- 处置状态机：`missing → 任意`；`have|added|not_needed` 只能**撤销**回 `missing` 再改判；`ignored → 任意`。`ignored` 的理由 trim 后 <5 字返回 400 `reason_required`。
- 失效 vs 硬退化：资产关联/取消关联、新版本登记（`register-upload` 与 `generation.ts` 的 `handleImageComplete` 回写）、语义保存（`PUT /props/:id/semantics` 与自动标注）只**追加 `asset_review_stale_reasons`** 做横幅，`passed` 不回退；绑定目标消失（软删资产、取消关联、关掉 `faithful`、语义条目被删）走 `revalidateAssetReviewBindings`，条目回 `missing`、门禁重新上锁。资产级事件按 `episode_characters/episode_scenes/episode_props` ∪ 已绑定该资产的清单行反查剧集逐集处理。重新对照成功后清空 `stale_reasons`。
- 接口：`POST /episodes/:id/asset-review/run`（异步任务，返回 `{started, task_id}`；非纪录片 400，已在跑 409）、`GET /episodes/:id/asset-review`（按段分组，`items[]` 带 `asset_name/semantic_name/semantics_needs_review`）、`PUT /asset-review/items/:id`、`POST /asset-review/items/:id/extract`（单资产重提取，任务带 `params.assetReviewItemId`，完成后按名字回链为 `added`）。
- 补齐三条路径：**补提取**（提取 Agent 重跑一个资产）/ **上传 · AI生成**（打开 `episode.vue` 的新建资产抽屉，预填 kind 与名称，创建请求带 `asset_review_item_id`，三个资产 POST 路由保存后自动 `bindCreatedAssetToReviewItem` 置 `added`）/ **选择已有资产**（手动绑定 → `have`）。需要语义条目但标注 `needs_review` 的行显示琥珀「标注待修正」，点击 emit `open-asset {kind,id,semantic_id}`，`PropSemanticsPanel` 的可选 prop `focusSemanticId` 滚动并高亮该条目（为空时行为与 #55 之前逐字一致）。
- AI 环节 `asset_review`（`vision:false`，`AI_CALL_SITES['services/asset-review.ts']`）；技能 `backend/workspace/skills/documentary/asset-review/`（四语，由 `loadSkillDoc(relPath, lang)` 直读拼 system，**不进 `AGENT_SKILL_MAP`**，避免污染 extractor/storyboard_breaker 的注入内容）。`not_needed` 限定为「纯年份 / 纯数字 / 纯度量」这类由图层卡片表达的信息点。
- 分段口径：`splitNarrationSegments()` 按空行或 `##` 标题切段；整篇无空行时按句末标点聚合到 ≤200 字一段并在界面标「自动分段」。段号只用于展示/分组。

### 图层段 + 生成段 + 衔接帧（纪录片专属，Issue #58，取代 #50 的确定性片段）
- 一镜最多两段：**▣ 图层段**（确定性渲染，≤30 s）+ **▶ 生成段**（视频模型，≤15 s），由 `storyboards.combo ∈ A|B|C|D` 显式决定（A 只图层 / B 只生成 / C 图层→生成 / D 生成→图层），**没有默认值**。`storyboard_clips`（`replace|pre|post` 三条片段）已在启动迁移里转成一镜一行的 `storyboard_layer_segments` 并 **DROP**；同镜多片段按 `replace > pre > post` 取一条并记 `stale_reasons=['migrated_multi_clip']`，combo 为空的记 `['combo_missing']`。
- 唯一读写口 `services/layer-segment.ts`：`saveLayerSegment/getLayerSegment/deleteLayerSegment`、签名 `layerSegmentSignatureOf`（`seg-v1` + layer_doc + timeline + duration + crop + `WxH@fps` + 底图/图片 sha256，**不含 position**）、`layerSegmentIsFresh()` 读时现算。`end_hold` 是**派生值**（`duration − 末个精确关键帧 t`），不落列。
- 时间线 `services/segment-timeline.ts`：`{fps, ease, fade_ms, keyframes:[{t, viewport, visible[]}]}`（原 `states` 已改名 `keyframes`，读入兼容旧键）；插值、`w === h` 取景框归一化、`MAX_LAYER_SEGMENT_SECONDS=30`、`SEGMENT_MAX_KEYFRAMES=60` 口径与 #50 相同。`resolveEpisodeSegmentSpec` 的尺寸仍只实测**模型视频**，绝不探测图层段 mp4。**目标 FPS（Issue #69）优先读本集未删除且 combo=A/C/D 的 stored 图层 raw timeline.fps**（有限且在既有 1–60 范围内，按 storyboard_number、id 取最前，不依赖 fresh/status/产物是否存在；非法候选跳过、不钳成另一个计划）；读写保留 24/29.97 等原值，新段跟随本集目标。无计划才沿用视频 FPS/默认 25；计划查询优先于视频缓存，视频完成或原生 video_url 改变时使视频缓存失效，所以首 raw 出现、清缓存或重启不能让已渲层/衔接帧自失效。原生合成用 fps 滤镜归一不同帧率；签名算法、尺寸政策不变，`source` 仅说明尺寸来源、不进签名。升级无需改库/外部配置或重渲旧层，仅 GET 重算新鲜度。
- 渲染 `services/layer-segment-render.ts`：产出 `static/layer-segments/<uuid>.mp4` + **衔接帧 PNG** `static/layer-frames/<segmentId>-<hash>.png`；三条性能硬规矩（底图+滤镜只合一次、`image` 图层预缩放、逐帧 raw pipe 给 ffmpeg）沿用 #50。衔接帧渲染时 **`label`/`card` 整层隐藏、`marker` 只画点不画字**，`hash = sha256(PNG)`；渲染成功后删除同段旧 hash 的 PNG，但保留 `storyboards.keyframes_junction_hash` 仍引用的那张。
- 衔接帧 `services/junction-frame.ts`：C 取 `t=duration`、D 取 `t=0`；段没渲染或签名过期 → `stale:true`。槽位锁定在 `services/keyframes.ts`：combo=C 锁 `first`、D 锁 `last`、D+`continuity_boundary='continue'` 首尾双锁（只有中间帧能出图）；锁定槽**不写** `first_frame_image/last_frame_image` 列，生效图取衔接帧。`PUT /storyboards/:id/keyframes/:slot` 与 `POST …/generate` 对锁定槽返回 400 `{code:'slot_locked'}`；关键帧批量预览也把锁定槽标 `skipped`（原因「该槽位由衔接帧锁定继承，不单独出图」）。渲染后 hash ≠ `keyframes_junction_hash` → `invalidateKeyframeConfirmation(id,'junction_updated')`，`keyframes_stale_reason='junction_updated'`；`confirm-keyframes` 成功时快照当前 hash。
- 关键帧就绪仍要求**首尾都有可用图**（锁定槽必须有新鲜衔接帧，中间帧只在写了提示词时必需）；选定路径对应文件已丢失等同空槽，API 的生效图返回 NULL、`confirm-keyframes` 返回 400。空槽不渲染 `<img>`；缩略图失败先回退原图，原图也失败则显示空槽占位。嵌入编辑器以纵向 flex 占警示条下剩余高度，仅正文滚动，确认页脚固定可见；不要把这些高度约束应用到剧情关键帧页。
- 草稿 `services/layer-segment-draft.ts` 读**设计卡** `layer_plan`（不再读 `intent.overlay_plan`）：底图只认 `layer_plan.base`（`asset` / `inherit_prev`），**没有合格底图就不落行**并返回 400 `{code:'missing_base'}`（#50 的「任意有图资产」回退已删）。卡片字段扩为 `{title, sub, meta, years}`（`layer-doc.ts`/`layer-svg.ts`/`layer-render.ts`/前端 `utils/layerSvg.js` 四处同源必须同改），卡片默认 `box={x:0.06,y:0.56,w:0.46,h:0.18}`；卡片底边 >0.88 给警告 `card_subtitle_overlap`（不阻断）。
- 任务壳 `services/layer-segment-task.ts`：`sys_task type='video', provider='layer-segment', model='layer-segment'`——不是模型任务，不过 provider/模型校验、不要 `config_id`；`task-retry.ts` 的重试＝按库里当前文档重渲染。渲染同步执行（秒级），失败保留上一次成品。
- 一致性问题 `services/segment-issues.ts`（警告级，读时现算）：`must_mark_not_marked`（设计卡要求标注但图层段没锚定，前端给「一键创建标记并锚定」）、`reference_not_mentioned`（字段是 `reference`）、`card_subtitle_overlap`、`budget_mismatch`、`missing_base`。
- 组合切换 `services/combo-switch.ts` + `GET /storyboards/:id/combo/impact?to=`、`POST /storyboards/:id/combo`：对话框三栏「保留 / 失效（归档可恢复）/ 需要新做」，执行**只归档不删除**（被替换版本写 `params.archived_reason`，对应列置 NULL，图层段行保留回 `draft`），写一条 `storyboard_change_log(kind='combo')`，设计卡回 `pending`。
- 批量范围清单 `services/batch-scope.ts`：`{included, excluded[{storyboard_id, storyboard_number, reason}]}`，排除口径按 **combo** 而不是 device（组合 A 无生成段 / 设计卡未确认）；关键帧与提示词批量按钮先弹清单再提交，同一份快照落 `params.scope`。图层渲染与视频批量的 scope 归 R7。
- 合成接入：本 Issue 只把 `compose-state.ts`/`shot-compose.ts` 的数据源从 `storyboard_clips` 换成新表（A 等价旧 `replace`，C/D 等价 `pre/post`），**签名版本仍是 v3、拼接顺序不变**；v4 与 `shotMaxSeconds(combo)` 归 R7。
- 接口挂 `/api/v1/layer-segments`（`/api/v1/clips` 已删）：`GET|PUT|DELETE /storyboards/:id`、`POST /storyboards/:id/draft`、`POST /storyboards/:id/render`、`GET /storyboards/:id/thumbnail/:which`（`first|last|frame-<i>`，按需渲染 + LRU）、`GET /storyboards/:id/junction`。
- 前端 `components/ShotProduction/`（`ClipWorkspace/*` 已删）：`SegmentBar`（按时长比例分宽的段头 + 48px ◆ 衔接帧缩略图与锁定 tooltip；**combo=D 用 CSS order 把生成段排在前**）、`LayerSegmentEditor` + `PreciseKeyframePanel`、`GeneratedSegmentEditor`（`StoryboardKeyframes` 的 `embedded` + `lockedSlot` 模式：锁定槽渲染成「🔒 衔接帧 / 🔒 承接」卡片，无提示词、无版本、无生成按钮）、`ComboSwitchDialog`、`RehearsalDialog`（帧条按 combo 排序，Esc/点遮罩关闭，固定文案「预演为示意，不代表最终视频效果」）。设计卡未确认的镜在列表里 `locked` 置灰并提示「先确认 #NN 的设计卡」。
- **四语 locale 里的字面 `@` 必须写成 `{'@'}`**：vue-i18n 把 `@{t}` 当链接消息语法，编译报 `Invalid linked format` 并让整个制作页白屏（本 Issue 实测踩中，`junctionTip*`/`junctionSource*`/`referenceNotMentioned` 全部改过）。`episode.clip.*` 已整体删除，新增 `episode.production.*` 与 `episode.segment.*`。

### 旁白覆盖缺口与「补全剩余」（纪录片专属，Issue #52）
- 拆分分镜被覆盖闸门中断（`routes/agent.ts` 的 narration-first 闸门把任务标 `failed`）之后**不必整集重拆**：`GET /episodes/:id/narration-coverage` 给出 `{script_chars, covered_chars, uncovered_chars, gaps[], gap_count, shots, running}`（口径就是 `narrationCoverage()`，非纪录片项目恒为 0 缺口），`POST /episodes/:id/storyboards/fill-gaps` 只补缺口。该集已有 `storyboard_breaker` 或 `storyboard_fill_gaps` 任务在跑 → **409**；一个缺口都没有 → 200 `{status:'idle'}` **不建任务**。
- 补镜任务 `sys_task(type='text', params.kind='storyboard_fill_gaps')`，实现在 `services/storyboard-fill-gaps.ts`。message 只给**缺口原文**（去空白剧本的切片）+ 缺口两侧相邻镜的旁白尾/首句与 intent，不重复整集剧本。
- 「补镜模式」由 `requestContext.storyboardFillGaps` 打开（`isStoryboardFillGaps()`），`save_storyboards`（纪录片变体）因此变成**纯插入**：`replace_existing` 直接拒绝（返回 `error`，一条分镜都不删）、**忽略模型给的 `shot_number`**（服务端从 `max+1` 起分配临时编号，绝不 upsert 到已有镜）、新镜 `continuity` 缺省为 `cut`。旁白必须落在某段缺口内：`fitNarrationToGaps()`（`services/narration-first.ts`，纯函数）头尾各允许 `GAP_TRIM_TOLERANCE=40` 字的越界并**自动裁到缺口边界**（裁了多少回报在 `narration_trimmed`），越界过多 / 已被既有镜领走 / 同批重复领同一段 → 拒存并在 `narration_rejected[].reason` 里给出**精确缺口边界**（避免「补→拒→再补」空转）。
- 跑完先 `renumberStoryboardsByScript(episodeId)`：按每镜旁白在剧本中的起始位置整集重编号，**只改 `storyboard_number`，id / intent / 选版 / 子数据一律不动**；同一个同步事务里两阶段写（先写唯一负号再写最终号，规避将来可能加的唯一约束），编号没变化时一行都不写。旁白定位不到（被人改过或刻意留白）时沿用「上一镜」的位置，位置相同按旧编号稳定排序。重编号后「上一镜」变了且**继承首帧**（`continue` 且自己没有首帧图）的镜头按 #keyframes 既有规则取消关键帧确认（`reconfirm` 列表）。
- 收尾：新插入镜用 `startShotIntentBatch` 补齐缺失的表达设计；仍有缺口 → 任务 `failed` 并列出剩余缺口（可再点一次「补全剩余」）。
- 任务中心：**覆盖缺口失败的纪录片拆分任务重试 = 补镜**（`task-retry.ts` 按 `isCoverageGapFailure(error_msg)` 判定，不再整集重拆——这改变了「重试 = 覆盖本集分镜」的旧口径，仅限这一种失败）；`storyboard_fill_gaps` 的重试同样走补镜。显式整集重拆仍走分镜页的「拆分分镜」按钮，语义不变。
- 前端：`components/NarrationCoverageBar.vue` 挂在分镜关键帧页与表达设计页顶部（`isDocumentaryProject` 才渲染），显示「旁白覆盖 X / Y 字 + 百分比 + 缺口 N 段」，有缺口时给「补全剩余」按钮（任务进任务中心，5 s 轮询覆盖接口，任务结束自动 `refresh`）。文案 `episode.coverage.*`（四语）。
- 相关修正：`GET /episodes/:id/storyboards` 现在过滤 `deleted_at IS NULL`——重编号只排存活分镜，带上软删行会出现重号的幽灵卡片。

### 资产「精确 → 美化」流水线与地图确定性底图（Issue #56）
- **替代了 #47 的一次性美化**：`services/prop-beautify.ts` 与 `POST /props/:id/beautify` 已删除，AI 环节 `prop_beautify` 也从 `AI_STAGES` 移除。美化改成多轮流水线，结论由**程序闸门**算、人工审批。
- **run 容器 = `sys_task(type='text', params.kind='asset_pipeline', provider='mastra')`**，没有独立 run 表。`params.mastra_run_id` = Mastra runId，`params.progress.step` 依次是 `research→curate→spec→prompt→generate→qc→gate→approval→finalize`。`failInterruptedTextTasks()`（`task-center.ts`）**显式排除这个 kind** —— 它可以合法地长时间停在「等待人工审批」上，漏改这一条会在每次重启把等审批的 run 全判死。
- **引擎 = Mastra Workflows**（`@mastra/core` + `@mastra/libsql`），独立实例 `services/asset-pipeline/mastra.ts` 的 `pipelineMastra`，快照落 `data/mastra-workflows.db`（**不要**指向业务库；`src/mastra/index.ts` 的 agent 注册表仍然无 storage，剧情 Agent 链路零影响）。跨进程挂起/续跑实测可用（1.78.0 + 1.29.0）：进程 A `createRun({runId}).start()` 命中 `suspend()`，全新进程 `getWorkflowRunById()` 读到 `status='suspended'`，再 `createRun({runId}).resume()` 走完。`getWorkflowRunById()` 返回的是 `WorkflowState`：**顶层**带 `status`/`suspendedPaths`/`steps[stepId].suspendPayload`，没有 `snapshot` 包裹层。
- 轮次上限写死在图里：`prepare → round_0 → approval_0 → round_1 → approval_1 → round_2 → approval_2 → finalize`。精确轮打头的 run = `precision, beautify, beautify`；`purpose='beautify'` 的 run = `beautify, beautify`。已结束的 run 流过后面的块时整块短路。
- **每一步可重入**：重启后整条 run 从头重放，`research`/`spec` 命中 `sys_task.params`（`asset_research`/`asset_spec_id`）直接复用，`generate` 以 `asset_round(pipeline_task_id, round_no)` 唯一索引为幂等落点（已下单就只继续轮询那条生图任务，绝不重复下单），`qc` 便宜允许重算、每次追加一条 `asset_qc_record`。启动时 `resumeAssetPipelines()`（`index.ts` 的批次恢复旁）：`suspended` 保持等待人工、`running` 原地重放、快照缺失标 failed。
- **四张表**（`db/schema.ts` + `db/sqlite-schema.ts`，`CREATE TABLE IF NOT EXISTS` 幂等）：`asset_source`（本地许可证缓存，文件按内容寻址落 `static/asset-sources/<sha256>.<ext>`，`UNIQUE(asset_kind, asset_id, sha256)`）、`asset_spec`（版本化事实表，`sources` 是**按值冻结**的素材快照，`UNIQUE(asset_kind, asset_id, version)`）、`asset_round`（`pipeline_task_id` = 流水线任务、`image_task_id` = 生图任务、`width/height` 由 sharp 探测，`UNIQUE(pipeline_task_id, round_no)`）、`asset_qc_record`（每轮可多条，**以最新一条为准**，`human_verdict` 非空时人工裁决优先）。补列 `props.map_spec`。
- **实际参考来源审计（Issue #64）**：`asset_round.reference_ids:number[]` 只记真实选中并提交的 `asset_source.id`，按输入顺序，绝不混 task/round id。选源时正向携带 ID；缺 ID 才在 static 内做规范化路径唯一匹配，同路径多来源不猜。新图任务在既有 `params.referenceImages` 旁存等长 `pipeline_reference_origins` 身份元数据，不复制路径；详情 `rounds[].reference_images` = 有序 `{type:source|prev_round|unknown,path,source_id?,round_id?}`，路径唯一事实源是该轮 `image_task_id` 的不可变 params。已记录的身份只校验 static 安全词法边界，不再读当前文件；后来删缓存、替换字节或改成 symlink 都不改变当时的 source_id/round_id。旧无身份元数据的任务才用该轮 `spec_id` 的冻结素材快照/此前轮次作路径兜底，禁止读当前 sources/spec 冒充旧输入；前轮产物不作 source。词法越界一律 unknown；旧记录兜底遇到 symlink、缺文件、歧义也标 unknown。旧任务缺输入用 `{type:'unknown',path:''}`，不拿当前资产图补默认、不回写历史 round/params。无 schema/供应商配置变化，不重发生产任务；等活跃流水线结束后安全发布。
- **闸门在代码里，不采信模型**（`services/asset-pipeline/gate.ts`，纯函数，`tests/asset-pipeline-gate.test.mjs`）：清单逐条覆盖（缺项/重复/枚举非法/`text_in_image.present` 或 `overlay` 非布尔 → `invalid`，不可能 PASS）；任一 `violation` 或 `forbidden.detected` → FAIL；`metric ∈ {count, arrangement, color}` 的条目给 `minor` 一律升级成 `violation`；QC 引用的 tolerance 必须出自 `spec.tolerances` 白名单；**只有生成器额外加的标注/图例/字幕/水印/招牌（`overlay=true`）判 FAIL，器物自身铭文/正文（`present=true, overlay=false`）允许保留且不要求必须出现**；位置一致性用「目标 + 两地标」相似变换归一化后比距离，地标不足 → `not_comparable` 且 FAIL；资产已有 `props.semantics` 时追加 `semantics_preserved`（`semantics-check.ts`，标注可读 + 线条色域覆盖率 ≥80%），无标注记 `not_applicable`。`decideRound()` **只给建议**，不自动推进。
- **人工审批是状态机的唯一推进力**：每轮 qc/gate 后一律 `suspend()`。`POST /asset-pipeline/runs/:id/approve {round_id, verdict: approve|revise|rollback|abort, selected_violations[], notes, opened[{path,sha256}], override_gate, next_purpose?}`；`opened` 为空 → 400（必须先打开看过图），闸门 FAIL 轮要 `approve` 必须 `override_gate=true` + 填理由。`next_purpose` 只对 `revise` 有效，**默认沿用本轮用途（精确轮默认继续精修）**，人可显式改选美化；轮次块数精确起步 3、美化起步 2，美化累计 ≤2；去向不成立返回 400，不静默降级。
- 接口前缀 `/api/v1/asset-pipeline`（`routes/asset-pipeline.ts`）：`POST /runs`（同资产已有活跃 run → 409）、`GET /runs`、`GET /runs/:id`、`POST /runs/:id/approve|cancel`、`GET /episodes/:id/base-candidates`、`GET /assets/:kind/:id/sources`、`POST /asset-sources`（JSON `url`/`local_path` 或 multipart `file`）、`DELETE /asset-sources/:id`。**底图候选的函数契约是 `services/asset-pipeline/base-candidates.ts` 的 `listBaseCandidates(episodeId)`**，服务端内部直接调函数；只含 faithful 原件、**通过闸门**的轮次图、已生成图——未过闸门的美化图不可选。
- 出图路由 `generator.ts`：**新 run 在启动时由 `resolveImageSelection()` 冻结 `image_config_id` / `image_model`，整条 run 与重启续跑都使用同一配置；未指定时默认 GPT Image（provider `openai` 且模型名含 `gpt-image`），没有则取最高优先级启用配置**。启动时显式配置/模型必须合法（模型必须在该配置的模型列表里），否则 400。老 run 没有冻结字段时才回退旧的按用途择优（精确优先 openai、美化优先 qwen-jobs）并在 `asset_round.generator` 记 `generator_fallback:` 前缀。每轮都用 `sizeBucketFor()` 保证派生图与底图**同画幅**（否则既有语义坐标全部错位）。
- 新 AI 环节：`asset_research`（非视觉，只产候选 URL + 许可提示，**绝不自动抓取**）、`asset_spec`（非视觉）、`asset_qc`（**视觉**）。提示词内联在 `asset-pipeline/prompts.ts`（直接 `callTextChat`，不是 Agent，技能目录不会注入）。`TEXT_MAX_TOKENS` 读 `AI_MAX_TOKENS`（默认 32768）——GLM-5.x 推理与正文共享预算，给到 6000 时 research 步返回空串。
- **每一步都有墙钟时限**（`services/asset-pipeline/deadline.ts` 的 `withStepDeadline()`，`tests/asset-pipeline-deadline.test.mjs`）：research/spec/qc 各 10 分钟、curate 1 分钟、generate 25 分钟（比等图上限 20 分钟长，让等图那层先报自己的原因）。时限到期 → `AbortController.abort()` 把 signal 一路传到 `callTextChat()` 的 fetch（`ChatCallOptions.signal` 与 `AbortSignal.timeout(timeoutMs)` 取先到者）**真的掐断在飞的请求**，再抛 `StepTimeoutError`，由 `run.ts` 写成人话的 `error_msg` 把 sys_task 结束掉。**不允许「挂着不动」这种第三种结局**——单次 fetch 的超时管不住一个步骤（可能两次请求 + 读库 + 等图）。等图轮询用 `abortableSleep()`，被中止时停止等待但**不作废**生图任务（重跑按幂等守卫认领）。
- QC 的 `fidelity_score/beauty_score` 统一经 `normalizeScore()`（`gate.ts`）归一到 0–100：模型实测既给过 `95` 也给过 `0.95`，提示词已写死「0–100 整数」但不靠它保证。这两个分数**只用于展示**，闸门结论不读。
- **事实表出新版本 → 该资产 `final_prompt` 置空**（`classifyPromptInvalidation()` 的 `spec_version` 来源，走既有 `planFinalPromptWrite()` 出口）；`faithful=1` 的道具不动（`final-prompt.ts:130` 的 `skipped` 行为不变）。
- 版本列表的 `fidelity/fidelity_reason`：存量派生版本仍读 `params.fidelity`，流水线轮次产出的版本改读闸门/人工结论（`asset-pipeline/fidelity.ts`，`asset-library.ts` 一次性批量预取，不在同步 map 里打库）。

#### 审批可见性与错误呈现（Issue #74）
- `services/asset-pipeline/execution.ts` 从真实 Mastra 快照的 suspended path / payload 推导 `pipeline.state` 与 `awaiting{round_id,round_no}`，用于流水线详情与任务中心；不新增全局任务状态，不把旧 `progress.step='approval'` 当等待依据，终态不能继承旧快照的等待状态。等待审批不显示生成/思考动画；经过时间是包含等待的墙钟时间，终态停止增长。
- 任务中心直接复用 `AssetPipelinePanel` 的 `reviewRunId` 模式，显示实际输入参考图（可能为空）、本轮成图、完整事实表、逐项 QC 与程序闸门；阻断原因前置。弹窗固定头尾、正文滚动，小屏单列，长 URL 换行；审批仍须先打开本轮图片，FAIL 强行通过仍须覆盖闸门并说明理由，提交失败保留表单。通过只接受本轮并结束 run，不自动采用为资产当前图。
- 新 QC 把完整 gate 存入既有 `verdicts.gate_result` JSON；`gate-serialization.ts` 对历史缺失的语义核验返回 `unknown`，不能捏造 PASS / 不适用，也不拿当前资产重新计算历史结论。
- `TaskErrorMessage` / `utils/taskError.js` 把供应商错误转成人话，诊断默认折叠、脱敏且限长，按纯文本渲染。内容审核的 `assistant/user` 仅说明输出/输入方向，`level` 不代表分类；平台未提供命中片段时明确不可判断。没有新增模型重试、自动切换或审核绕过。
- 非地图道具不挂载 `MapSpecPanel`；只有已有 `map_spec` 或明确点击「创建地图底图」才展示。新建草稿可取消且取消不写库；保存后按已配置地图显示并禁用扩散流水线入口。地图身份不从类型名称、faithful 或语义数组猜测。
- 升级无需改库或同步供应商配置。精确轮参考图/模型契约与文字政策已由 #73 落地（见下节）；OCR/文字框定位仅登记 #75，本次不变更算法。

#### 精确轮启动契约与文字政策（Issue #73）
- **启动时选定参考图与模型**：`POST /asset-pipeline/runs` 接受 `source_ids[]`、`config_id`、`model`。精确轮必须选 1–3 张**已入库**（`asset_source`，role≠rejected，有 `local_path`）且属于该资产的素材；0 张、超 3、跨资产、已排除、无文件、重复均 400，且**不创建计费生图任务**。选定结果冻结为 `sys_task.params.reference_source_ids`，配合 `image_config_id` / `image_model` 一起进入 `PipelineInput`；重启、续跑与每一轮都用同一套，不读“当前”素材角色或配置。
- **旧 suspended run 兼容**：params 里没有 `reference_source_ids` 时，精确轮才退回“前 3 条 `generation_reference`”的旧口径；一条都没有就 400，绝不零参考出图。已启动的旧 run 不补写冻结字段。
- **打回去向**：`next_purpose` 仅对 `revise` 有效；默认沿用本轮用途（精确轮→继续精修），可显式转美化。`services/asset-pipeline/contract.ts` 的 `planNextRound()` 是唯一判定（块数精确起步 3、美化起步 2，美化累计 ≤2）；不成立 400。工作流用 `purposeOverrides` 记录改过的轮次，`reviseNotes` 仍把勾选问题传给下一轮。
- **文字政策**：`QC_SYSTEM` 输出 `text_in_image{present, overlay, evidence}`；`overlay` 只表示生成器新增的标注/图例/字幕/水印/招牌。`buildImagePrompt()` 只禁这些新增叠加，并要求保留器物自身铭文，但**不要求**出现文字；不新增针对铭文内容的细化规则。新 QC 缺 `overlay` 布尔 → `invalid`；历史记录 `overlay=null` 显示“未记录”，原 `gate_pass` 不重算，旧记录因文字判 FAIL 时说明“当时按零文字规则判为未通过”。
- 前端：启动区 `AssetPipelinePanel.vue` 提供模型下拉（默认 GPT Image）与参考图多选（上限 3、显示标题/许可/年代；零选禁用启动）并展示实际配置；打回区提供“继续精修 / 转入美化”（默认精修，展示本轮问题与上限）。文字展示口径由 `utils/pipelineText.js` 与 `tests/pipeline-text-policy.test.mjs` 同源覆盖。

#### 检索权威资料（Issue #79）
- 精确轮的资料检索是**程序真实检索**，不再让模型凭记忆列 URL。唯一实现 `services/asset-research/`：`sources.ts` 13 个适配器（维基百科中/英、维基文库、维基共享资源关键词 `filetype:bitmap` + 分类浏览、Europeana、Smithsonian（#78 key）、大都会、克利夫兰、美国国会图书馆、Internet Archive、英国国家档案馆、OpenAlex），分级 A 机构 / B 维基系，自媒体域名拒绝名单；单源失败只记录不中断。
- `run.ts`：独立文本任务 `params.kind='asset_research'`（`POST|GET /asset-pipeline/assets/:kind/:id/research`，同资产进行中 409），步骤 = 检索计划（环节 `asset_research`，提示词要求中文器物名、分类浏览、分三类找图）→ 检索 + 维基正文摘录（每条文字查询取首条）→ 著录预筛 → 下载到 `static/asset-sources/candidates/<sha256>`（只收公网图片 ≤20 MB）→ 视觉判断角色（新环节 `asset_curate`：original / generation_reference / shape_only / text_source / reject）。结果整体在 `params.asset_research`，不建表。
- 入库仍须用户点：面板 `AssetResearchPanel.vue`（嵌在流水线「素材」区块）按视觉判断分组展示，许可预填可改，入库走 `POST /asset-sources {local_path, source_url}`（`source_url` 只记出处，不重新下载；`local_path` 校验不变）。
- 流水线 research 步：优先复用该资产最近一次成功检索；没有则现场只做文字检索（`withImages:false`，控制在步骤时限内）。结果冻结进 run 的 `params.asset_research`；#79 之前的 run 冻结的旧线索原样交给事实表。事实表提示词改为输入文字摘录 + 视觉判断后的图像资料，要求依据、测量对象、「不是什么」写进 forbidden、资料不足给合理示意并记 uncertainties（用户口径：尽量贴近、给出概念）。

#### 地图底图：程序渲染，扩散不碰几何
- `services/map-base-render.ts`：`d3-geo`（`geoMercator`/`geoEquirectangular` + `geoPath` + `fitExtent`）把 `backend/assets/geo/ne_50m_*.geojson`（Natural Earth 50m，公有领域，`HUOBAO_GEO_DIR` 可覆盖）投影成 SVG，再按 `layer-render.ts` 的 `sharp().composite()` 栅格化成 **16:9 / 默认 3840×2160** 的 PNG，落 `static/map-bases/<signature>.png`。**底图上绝不渲染任何文字**（地名/图例一律走叠加图层）；同 spec 同尺寸字节级一致，已存在即复用。
- `props.map_spec`（`MapSpec`：`projection` 只有 mercator / equirectangular，`bbox`，`layers`，`places[]`，`routes[]`，`style.theme`）。接口在 `routes/props.ts`：`GET|PUT /props/:id/map-spec`、`POST /props/:id/map-render`、`POST /props/:id/map-suggest`（AI 建议坐标一律 `proposed`，人工勾选确认后前端才写进 `map_spec`）。
- `POST /props/:id/map-render` 之后产物被登记成**原件版本**（`sys_task.provider='map-render'`，`props.faithful=1` + `faithful_source` 指向它），并把投影换算出的点/线像素坐标直接写进 `props.semantics`（`source='cv'`、`confidence=1`、`model='map-render'`）——**不经 VLM、不经色域抽线**，第一轮「扩散重画海岸线 / 殷墟点跑到燕山以北」那类事故在这条路径上结构性不可能。
- 风格化（底图作参考图走 `image_edit`）**默认关闭**：`qwen-jobs` 的 `image_edit` 分支不传 `denoising_strength`（`qwen-jobs-client.ts:187` 只在 FLUX 分支用常量），没有可调低强度，开着等于让扩散重画几何。
- **上传截图的语义阈值放宽**（契约 §8 的遗留缺陷）：Google Earth 截图上同一条水体沿程从 rgb(80,144,224) 压到 rgb(16,48,96)，欧氏距离 172、偏色幅度 48 同时被 `colorMask` 的两条判据判掉，命中率为 0。现在 `isExtractableLineColor()` 对强蓝（`b−r>60 且 b−g>20`）跳过亮度下限，`colorMask(..., { hueOnly: true })` 改按**通道序 + 最小彩度 `HUE_ONLY_MIN_CHROMA=24`** 判。放宽**只用于上传截图路径**：`asset-semantics-auto.ts` 的抽线先按严格判据试，失败才放宽重试（两条理由都写进 warnings），扫描印刷图走原判据不受影响。

### 发布前遗留闭环（Issue #61）
- 拆镜上限接收实际段落文本，取短稿防过拆上限与 `Σceil(narrationCharCount(段落)/MAX_NARRATION_CHARS)` 的较大值；普通拆分与补镜共用保存入口，不能再只传段数。两段各 900 字必须允许 24 镜，900 字加四个短段须按逐段取整得 16 镜。
- 首次旧设计迁移只接受已定义的 device × deterministic 组合；未定义组合保留可恢复设计内容、`combo=NULL`、`suggested_combo=NULL`，一律待审，并以 `migration_combo_unresolved` 提示显式重选。已迁移后人工确认的卡不重复回填或降级。
- 设计卡未选组合/启用段预算为 NULL 时显示缺失状态，不用 0 秒或负余量冒充预算；明确填写 0 仍是无效值。原生类型选择器按内容自适应且不可压缩，紧凑高度必须同步减小纵向 padding。
- 地图离线数据补 Natural Earth 50m 现代省界与城市背景点（公有领域，来源与校验和见 `backend/assets/geo/LICENSE.md`）；仅作现代定位参照，不代表古代边界，背景点不进入已审核语义点。渲染结果与 UI 明示覆盖计数及缺层警告，城市尺度无数据时不可伪造细节或隐式升级精度。
### 图层编辑器与裁切/清晰度（Issue #59）
- `LayerCanvas/PreciseKeyframeBar.vue` 替代 `ShotProduction/PreciseKeyframePanel.vue`：画布下方时间缩略条、逐帧取景/可见性/过渡检查器、首帧保护、末尾停留只读派生；组合 C 末端 / D 首端标记衔接，文字只警告不静默删除。
- `base.crop` 是原图归一化有效区域，`viewport` 始终归一化于**整图**。无裁切沿用旧正方形归一化取景；有裁切采用保持源像素输出比例的矩形。应用裁切保留能容纳的原取景，不能容纳时显式提示钳制；裁切与全部取景共同撤销，绝不改写源文件。
- `services/layer-quality.ts` 与 `utils/layerQuality.js` 同源：有效像素 = `viewport.w/h × source_width/height`，**不能再乘 crop**。保存时读取实际源文件尺寸并重算 `quality_warnings`；全幅 crop 省略，信息性来源/尺寸不使旧无裁切签名失效。
- `LayerRail.vue` 是底图/图层/样式手风琴；素材沿用 `AssetPicker`，图片 `src.path` 仍为渲染真源，资产 ID/版本为出处。旧路径明确标识；继承底图禁换图/裁切/语义锚定。
- 所有已锚定几何修改必须先确认，`patchLayer` 本身也拒绝静默解绑；`detachAnchors` / `reanchorLayer` 是明确动作。`useLayerDoc` 历史可携带外部时间线快照；服务端保存回灌走 `acceptSaved`，防止归一化元数据触发二次脏标记。
- 缺字单源 `useMissingGlyphs` → 同源 `unsupportedChars`；字段/图层/画布即时展示，整段有缺字时禁渲染。共享 `StoryboardKeyframes` 的设计卡提示只在 `projectType='documentary'` 展示，剧情含 documentary_rules 不受影响。
- 集成 smoke 恢复两条原路径：`useApi.ts` 必须显式导入 `apiBase`（Nuxt auto-import 不替代同名工具函数）；剧情 `StoryboardKeyframes` 挂载必须传真实 `epId`，批量预览不能误请求 `/episodes/0/…`。图片选择器的上传/库中帧图登记为真实素材版本，保存后刷新资产上下文，避免登记时立即刷新吞掉未保存编辑。

### 全局任务中心
- `sys_task` 多了 `episode_id`（分镜任务由分镜反查、资产出图取发起时所在集、文本任务必填；启动时 `backfillTaskEpisodeIds()` 按 `storyboard_id` 回填存量行）与 `type='text'`。**文本任务不再存进程内存**：提取（`services/extraction.ts`）、关键帧/视频提示词批量（`keyframe-prompts.ts`/`video-prompts.ts`）、同步 chat 的剧本改写与拆分分镜（`routes/agent.ts`）都在开始时建 `sys_task(type='text')`，`params.kind` ∈ `extract_characters|extract_scenes|extract_props|keyframe_prompts|video_prompts|script_rewrite|storyboard_breaker`，进度写 `params.progress`（`{completed,total,failed,current_storyboard_id}`，**不复用 `remote_state`**，那是 qwen-jobs 追踪器的）。`/extract-status`、`/keyframe-prompts-status`、`/video-prompts-status` 响应结构不变，只是改成从库里读（函数变成 async）。
- 重启：启动清理对 `type='text'` 的活跃任务一律标 `failed`（`error_msg='后端重启中断'`，`failInterruptedTextTasks()`），**唯一例外是 `params.kind='asset_pipeline'`**（#56，它等人工审批时本来就没有执行线程，由 `resumeAssetPipelines()` 接管），不自动重跑；图像/视频规则不变（qwen-jobs 交追踪器、其它 provider 标失败、批次照旧恢复）。
- 增强行（`services/task-center.ts`）= `serializeTask()` + `params`（对象）+ `episode_id/drama_title/episode_number/storyboard_number/target_kind/target_name/frame_type/kind/progress/retry_of/label/row_type`。编号 `label` 由服务端用 `services/task-label.ts`（纯函数，可单测）拼：分镜 `《剧名》E02-#05 · 首帧|中间帧|尾帧|视频`、资产 `《剧名》· 角色|场景|道具 · 名字`、集级 `《剧名》E02 · 拆分分镜|…|关键帧批量|视频批量|导出合成`。
- 换模型重试 `POST /tasks/:id/retry {config_id?, model?}`（`services/task-retry.ts`）：**只改模型/配置，提示词只读**，一律新建 sys_task（`params.retry_of` 记来源）。图片/视频沿用原 `params`（参考图、尺寸、帧类型、时长…），换厂商时用 `params.sourcePrompt + params.refNameIndex` 按新 provider 重渲染 `@名字`（qwen-jobs `<imageN>名字`、其它 `图片N名字`、视频 `@图片N名字`），旧任务没有源提示词时直接复用最终提示词；视频沿用"模型不支持关键帧引导就报错"的规则，不支持中间帧引导的模型只发首尾帧。文本按原 kind/范围后台重跑（提示词批量把实际处理的分镜 id 落在 `params.storyboardIds`），**剧本改写/拆分分镜的重试会覆盖本集剧本/分镜**（Agent 工具直接写库，用户已确认）。
- 前端只有一个任务状态源：`composables/useTasks.ts`（模块级 store + 单一轮询 `GET /tasks/active`，有活跃任务 3s、空闲 15s、页面不可见暂停）。任务离开活跃列表时补拉 `GET /tasks/:id` 并通过 `onTaskFinished()` 通知订阅者（关键帧组件重载版本、工作台 `refresh()`）；刚提交的任务用 `registerTask()` 立刻进 store，进度环不等下一轮。进页时 `loadEpisodeTasks(epId)` 用 `GET /tasks/center?episode_id=&page_size=200` 载入本集快照（父行 children 摊平），刷新后失败/生成中状态照旧恢复。**组件内不得再轮询单个任务**（旧的 `StoryboardKeyframes.slotTasks`/`pollKeyframeTask`、`episode.vue` 的 `loadGenTasks` 已删除），槽位环取 `latestKeyframeTask(storyboardId, frameType)`、素材环取 `latestAssetTask(kind, id)`。
- 任务中心 UI：`components/TaskCenterButton.vue`（顶栏按钮 + 角标 + 抽屉，`layouts/default.vue` 头部与 `episode.vue` 顶栏各放一个）、`components/TaskCenterPanel.vue`（筛选/分页/父行展开，抽屉与 `pages/tasks.vue` 共用）、`components/TaskDetailDialog.vue`（详情 + 取消 + 换模型重试，`ModelSelect` 选项来自 `composables/useModelOptions.ts`；重试 `script_rewrite`/`storyboard_breaker` 前弹确认框）。文案在 `locales/*.json` 的 `taskCenter.*`（旧的 `episode.tasks.*`、`episode.topbar.tasks` 已删）。

### 纪录片视频与成品（Issue #60）
- `shot-duration.ts` 是整镜上限单源：A=30、B=15、C/D=45、剧情无 combo=15。生成段预算独立≤15，转场准备占用同一个生成段上限；配音实测只更新音频元数据/设计卡问题，不改纪录片设计预算。
- 合成快照 v4 记录显式 `combo`、`layer_segment`、采用的视频任务与衔接帧 hash；无 combo 的剧情镜摘要保持 v2 字节不变。C/D 依次拼接图层/生成或生成/图层，统一到集级 `resolveEpisodeSegmentSpec`，保留完整两段后对齐配音、烧录字幕。
- 纪录片即使关闭旁白，也必须先合成当前成品才能导出；设计卡、图层段、衔接帧或采用视频过期都阻断，返回逐镜 `blocked[].change_reasons`。部分导出必须显式选择，不能悄悄丢掉过期镜。
- 所有视频/图层渲染/配音/合成批量使用 `batch-scope.ts` 的同源预览，执行写入不可变 `params.scope`（视频批次写 `options.scope`）；任务中心读这份快照，不重新推算范围。显式空选不能扩大为整集。
- `backend/scripts/junction-diff.mjs` 用 sharp 比较实际抽帧的灰度平均绝对差，衔接帧锁定只保证输入来源，不声称模型输出逐像素连续。
- 资产事件沿现有 `onAssetLibraryChanged` 的关联集范围传播：仅受影响图层段更新当前底图/未解除锚点几何，再经 `markStale('layer_segment')` 阻断旧衔接帧与下游。`asset_version_changed/semantic_changed/base_version_changed` 在当前输入成功渲染后才消化；找不到素材/条目保留 `source_unresolved`，恢复引用/解除锚点后可重渲。`quality_warnings` 与迁移历史提示不升级为硬门禁。
- 通用 `POST /tasks` 一旦绑定纪录片分镜，必须走 `buildStoryboardVideoRequest`，只接受模型/配置覆盖，不能信任客户端首尾图/衔接 hash/时长/归属。单镜、重试、批量沿用同一 builder；显式指定的视频配置失效、停用或类型不符时返回 400，不静默切到另一个计费服务，生成持久化边界再校验一次。剧情/无分镜手动任务的旧默认语义不变。
- C 最后一个实际编码帧采样精确 `duration`，D 第一个实际编码帧采样 `0`，与去字衔接 PNG 同源；文字在段内独立淡出/淡入，标点/几何不跟着淡出。C/D 渲染签名使用 `seg-v2-C/D`，旧渲染必须更新；A 保持原签名。压缩和模型输出仍可能有像素差异，不能把锁定来源写成“像素完全连续”。
- 资产来源以 R6 的 `layer_doc.base.ref` / 图片 `src.asset_kind/asset_id/version_task_id` 为准；显式版本固定，不跟随当前版本，未固定的来源通过资产事件刷新；旧锚点只作存量回退。历史视频缺衔接快照时仅对实际保存、可完整解码的本地图层 PNG 字节算 hash；缺失、损坏、越界、两端歧义均为 unknown，不改写旧任务。
- 新纪录片视频任务把实际采用的 `config_id` 一并保存；无覆盖的重试继续使用该目标，停用后拒绝而不是转到默认服务。旧记录没有该字段时按原有默认规则，不伪造或回填历史事实。

## 待办

- 无。
