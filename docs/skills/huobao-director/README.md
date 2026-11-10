# huobao-director 技能（仓库内副本）

## 来源

本目录是 `huobao-director` 技能（Agent 用于驱动火宝全流程 API 的操作说明）的**仓库内权威副本**，由本机全局 managed skills 目录（`~/.omp/agent/managed-skills/huobao-director/`）在 Issue #83 中复制入库：

- `SKILL.md`：主技能文档（流程阶段、调用顺序、禁止事项、证据要求）。
- `references/api-catalog.md`：API 清单与证据规范。
- `references/api-core.md`：核心接口（项目/集/资产/配置/任务）细节与安全约束。
- `references/api-production.md`：2026-11-02 生产链路历史快照；已作废的操作不能当现行配方，当前契约以 `api-catalog.md` 为准。
- `references/diagnostic-example.md`：历史五镜诊断片与助手误填案例；保留原始证据及作废流程警告。
- `references/anti-patterns.md`：强制反模式对照表，约束力与主文档相同。
- `references/fixed-case-8daling.md`：固定 224 字案例正文、出处、授权边界及首轮实测证据。

## 为什么入库

技能原先只存在于本机全局目录，仓库里没有任何副本：后端 API 变更时既没有提醒，也没有 diff 可追溯，技能与代码很容易静默失配。入库后技能与业务代码共享同一条 Issue / commit 历史。

## 同步规则（强制）

1. **每次功能或 API 升级必须回顾并更新本目录**，范围包括：新增/变更/下线的接口与字段、流程阶段顺序、新的约束与失败模式。
2. 更新时必须记录三件事：
   - **新增 API 点**（方法 + 路径 + 关键请求/响应字段）；
   - **案例背景**（哪个 Issue / 哪次验收促成了这次变更）；
   - **为何需要该功能**（用户需求或问题现象，避免后续被当成无用接口删掉）。
3. 技能更新与对应业务改动在**同一个 Issue 分支**提交，不单独积压。
4. 本目录是权威版本；本机全局 managed skills 目录只是运行时副本，修改后应从本目录重新同步，避免两边各自演化。
5. **严禁写入真实密钥值**：`api_key`/token 的真实值、认证头实值、带真实凭据的 URL 一律不得出现在 `SKILL.md` 或 `references/` 中；字段名、占位符与安全说明（`GET /ai-configs` 的响应含 `api_key`，只能在内存中白名单取字段）是必要的 API 契约，必须保留。
6. 新端点/新字段在生产实测前一律标 `[S]`，实测通过后才改 `[R]`；标注与 `SKILL.md` 顶部的契约快照（`origin/master` commit）一起更新。

## 同步到全局 managed skill（每次更新后必做）

1. 用 omp 的 `manage_skill` **update**（`name: huobao-director`）写入本目录 `SKILL.md` 的正文（去掉 YAML front matter，`description` 走参数）。
2. 把本目录 `references/` 与被正文引用的 `reviews/` 全量复制到 managed skill 的同名子目录，保留 #84 未发布标记与其原始评审。
3. 复制后核对两边 `SKILL.md` 正文与所有辅助文件内容一致，确认无真实凭据值、认证头实值或带真实凭据的 URL；必要字段名与占位符不得删掉。
4. managed skills 是隔离目录，只动 `huobao-director`，不要触碰用户自建技能。

## 版本记录

| 日期 | 对应 Issue | 技能变更 |
|---|---|---|
| 2026-11-10 | #91 / #92（drama 14 / episode 20，9:16 竖屏） | S7：`read_storyboard_context` 返回 `aspect_ratio`/`composition`，关键帧提示词画幅校验与无名人物标识规则（#92）；S10：烧录字幕行宽随输出画面、≤4 行、避头点，行宽≠20 时进合成签名（#91）；记录 `video-batch/preview` 返回整集、提交前须按 ID 过滤的实测坑。 |
| 2026-11-08 | #86 / #87（生产 release `20261108T204444Z`） | 全应用嵌套界面与弹窗 deeplink；设计依赖真实资产与语义；自动/显式视觉模型选择；骨架、配音、设计卡持久调用与字数/耗时/ETA；任务中心公开对话按需分页。drama 11 / episode 17 已真实执行 65 次调用、分页读全 727 条公开消息，保留骨架失败与在飞重启中断；卡片待人工审核，不冒充全部内容通过。全局其他调用另见 #88。 |
| 2026-11-08 | #84（仅保留待发布文档） | 保留已评审分支 `1eb48cb` 的地图技能、API 与评审，所有新增地图契约仍为 `[S]`，代码未合并/未发布；避免本次同步覆盖并行工作。 |
| 2026-11-08（晚） | #85 续：八达岭 1008 首次生产验收 | 契约快照升至 `5d08b18`；#80/#81/#82 本轮实际调用的端点/字段由 `[S]` 改 `[R]`（drama 10 / episode 16 / merge 27，证据 `docs/qa/8daling-1008-20261108T061008Z/`），未调用的保持 `[S]`；更正纪录片改写入口为 `POST /episodes/{e}/script-rewrite`（旧 agent 入口对纪录片 400）并补全 rewrite 流水线端点；更正 merge 路径为 `/merge/episodes/{e}/merge(s)`（漏前缀会得到 200+HTML）；骨架字段更正为 `storyboard_number` 并补三种缺口处置；更正「虚构语义」失败语义（不写 `design_card_stale_reason`）；§4.6 追加「首次执行结果（2026-11-08）」 |
| 2026-11-08 | #85（随 #80/#81/#82 发布 `20261108T055548Z`） | 新增 `POST /episodes/{e}/script-rewrite/inspect-narration` 与 `fidelity.v2` 剔除清单（#80）；旁白骨架 `validate_only` dry-run、缺口处置与 `tts.audio_url/audio_version`（#81）；设计卡 AI 填 `combo`、combo-only 补选、audit 的 `tts.duration_ms`/`unresolved_layers`/`video_generated` 与可读 `issues[].message`（#82）；修订「AI 绝不选 combo」旧口径；新增 §4.6「八达岭长城测试 1008」生产验收案例（含固定 224 字原始内容与故意保留的出处行） |
| 2026-11-07 | #83 | 技能首次入库（从本机全局 managed skills 复制），建立同步规则 |

## 使用场景

- 生产验收测试（见 `AGENTS.md` §9 测试原则、§10 八达岭长城测试 1008 固定案例）必须按本技能操作生产 API。
- 任何会产生计费生成任务的调用需先获得用户同意，并记录任务 ID 与结果。
