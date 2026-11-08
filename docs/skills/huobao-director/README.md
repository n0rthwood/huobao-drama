# huobao-director 技能（仓库内副本）

## 来源

本目录是 `huobao-director` 技能（Agent 用于驱动火宝全流程 API 的操作说明）的**仓库内权威副本**，由本机全局 managed skills 目录（`~/.omp/agent/managed-skills/huobao-director/`）在 Issue #83 中复制入库：

- `SKILL.md`：主技能文档（流程阶段、调用顺序、禁止事项、证据要求）。
- `references/api-catalog.md`：API 清单与证据规范。
- `references/api-core.md`：核心接口（项目/集/资产/配置/任务）细节与安全约束。
- `references/api-production.md`：生产链路（生图、分镜、生视频、导出）接口细节。

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
2. 把本目录 `references/` 全量复制到 `~/.omp/agent/managed-skills/huobao-director/references/`。
3. 复制后核对两边 `SKILL.md` 正文与 `references/*.md` 内容一致，并确认不含 `api_key`、认证头或带凭据的 URL。
4. managed skills 是隔离目录，只动 `huobao-director`，不要触碰用户自建技能。

## 版本记录

| 日期 | 对应 Issue | 技能变更 |
|---|---|---|
| 2026-11-08 | #85（随 #80/#81/#82 发布 `20261108T055548Z`） | 新增 `POST /episodes/{e}/script-rewrite/inspect-narration` 与 `fidelity.v2` 剔除清单（#80）；旁白骨架 `validate_only` dry-run、缺口处置与 `tts.audio_url/audio_version`（#81）；设计卡 AI 填 `combo`、combo-only 补选、audit 的 `tts.duration_ms`/`unresolved_layers`/`video_generated` 与可读 `issues[].message`（#82）；修订「AI 绝不选 combo」旧口径；新增 §4.6「八达岭长城测试 1008」生产验收案例（含固定 224 字原始内容与故意保留的出处行） |
| 2026-11-07 | #83 | 技能首次入库（从本机全局 managed skills 复制），建立同步规则 |

## 使用场景

- 生产验收测试（见 `AGENTS.md` §9 测试原则、§10 八达岭长城测试 1008 固定案例）必须按本技能操作生产 API。
- 任何会产生计费生成任务的调用需先获得用户同意，并记录任务 ID 与结果。
