# Issue #105 生产验收：工作流 roadmap

- 发布：release `20261115T085404Z`（master `30bd11e3`）。发布前库备份：`data/huobao.sqlite3.bak-20261115T085404Z-pre-issue105`。启动迁移日志：补列 `status_override/status_derived/status_derived_at`，并删除 `dramas.status` / `episodes.status`。
- 入口：`http://172.30.3.164/huobao/`。所有证据都在本目录。

## 1. drama 20 / ep 27（只读核对，未写任何业务数据）

- `GET /episodes/27/roadmap` → `01-ep27-roadmap.json`：
  - 状态 `completed`（自动），8/8，`current` 为 null，M1/M2/M3 均为 done；
  - rewrite 子步骤：prepared=done、fidelity=skipped、bridge=done、final=done、confirm=done；
  - assets 带 2 条 notices（version_registered / semantics_changed）；
  - production 中图层 113/113、关键帧 75/75；final 113/113；export 113/113（merge 39，片头 = Poster v30）。
- 截图：
  - `02-project-list.png`：「中俄百年变局 纪录片测试 1113」显示「已完成 · 自动」；
  - `03-ep27-script.png`：阶段条全部 ✓；
  - `04-ep27-design.png`：骨架、配音、设计卡三个子阶段都是 ✓，侧栏各步骤都是 ✓。
- 旧接口 `GET /episodes/27/gates`、`GET /episodes/27/pipeline-status` 都返回 404 JSON。
- 冷请求 roadmap 约 1.5 s。

## 2. 新建测试项目「八达岭长城测试 1115」（drama 22 / episode 29，纪录片 16:9）

全程只做文本类步骤，写入都经 `hbwf call`，项目目录为 `~/projects/history_project/8daling-1115`。ledger 与 decisions 复制到 `40-*.jsonl`、`41-*.jsonl`。

| 步骤 | 调用 / 任务 | roadmap 变化 |
|---|---|---|
| 新建 | `POST /dramas` → 22，`POST /episodes` → 29 | `12-roadmap-empty.json`：draft，current=raw；资产及以后的步骤 locked |
| 守卫 | `hbwf call POST /episodes/29/extract`（前置未完成） | **REFUSED**，blocked_by=raw、rewrite、assets locked |
| 原始内容 | `PUT /episodes/29 {content}`（210 字） | raw done |
| AI 改写 | `POST /episodes/29/script-rewrite`，run 17 / task 3447（DeepSeek config 10） | prepared/fidelity/bridge/final 均为 done；confirm 为 available；current=rewrite.confirm；`20-test-rewrite-done.png` |
| 最终稿可选中 | 深链 `rwstage=final` 刷新后仍选中 | `21-test-final-selected.png` |
| 确认旁白稿 | `POST /episodes/29/script/confirm`（script_approval + exception 决定） | rewrite done，M1 done，项目变为 active，资产解锁 |
| 资产提取 | `POST /episodes/29/extract` ×3 | assets.extract done |
| 审核清单 | `POST /episodes/29/asset-review/run`，task 3451 | 22 条，缺 10 条；assets.review in_progress，12/22；`30-roadmap-review-pending.json`、`31-test-review-pending.png` |
| 处置缺项 | 10 次 `PUT /asset-review/items/{id} {status:ignored}` | assets done；current=design/design.skeleton；`32-roadmap-assets-done.json`、`33-test-design-current.png` |
| 守卫 | `hbwf call POST /episodes/29/design-cards/fill --dry-run` | **REFUSED**，blocked_by=design.skeleton(available)、design.voice(locked) |

- 预算：只调用了计费文本 LLM（改写 2 个阶段、提取 3 次、审核清单 1 次，均为 DeepSeek local）。图片、视频、配音均为 0。
- 只读 DB：`50-db-readonly.json`。drama 20 `status_derived=completed`；drama 22 / ep 29 为 `active`；ep 29 的 `script_confirmed_at` 已写入，`asset_review_status=passed`。
- 浏览器：生产会话 `huobao-qa-prod-105`，errors 为 0，console error 为 0。

## 3. 自测与验收中发现并修复的问题

- **hbwf（生产验收时发现，验收后修复）**：拆镜前 `derive` 调用逐镜预览接口拿到 400，导致中止，前期步骤无法 `check` / `call`。已修复：没有分镜时跳过预览。
- **前端（隔离自测时发现，已随发布修复）**：锁和状态被当成一个维度，导致「需复核但锁定」的步骤被渲染成「校验中」。已修复：锁一律读 `unlocked`，状态图标旁另画锁。
- **前端（隔离自测时发现，已随发布修复）**：最终稿被选中时，编辑区只占左半栏。已修复为占满整行。

## 4. 未覆盖 / 已知限制

- hbwf 对前期步骤的写入仍需逐次登记 `exception` 决定（hbwf 原有设计）；roadmap 守卫在此之前就已生效。
- 剧情项目没有 documentary profile，`hbwf check` 对纪录片仍会报 `profile drama_narration applies to project_type=drama`（原有问题，本 Issue 不涉及）。
