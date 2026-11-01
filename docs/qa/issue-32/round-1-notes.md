# Issue #32 质量闭环 — 环境与第 1 轮观察

## 隔离环境（本轮全部操作都在副本上，正式 drama 3 未动）

- worktree `/home/joysort/projects/huobao-drama-issue-32`，分支 `issue/32-documentary-assets`
- 后端 `:5722`（`SQLITE_PATH=<worktree>/data/huobao.sqlite3`），前端 `:3056`
- 数据副本：live `data/huobao.sqlite3` 经 SQLite backup API 复制；运行中 sys_task 标 failed
- 媒体副本：`data/static` 为 live 的**真实副本**（1.2 GB，`cp -a --reflink=auto`）
- live 备份：`~/huobao-backup/huobao.sqlite3.pre-issue32-20261101-201607`

### 事故与处置（必须记录）

初始 setup 把 `data/static` 做成了指向 live 的**符号链接**。随后在副本上执行「删除本集资产行」时，
`DELETE /characters|scenes|props/:id` 的 `deleteAllReferenceImages()` 沿符号链接删除了 **live** 的参考图目录，
造成 live 的 drama 3 道具 26 / 39 的 3 个参考图文件丢失。
处置：从 `huobao-drama-issue-33` worktree 的真实 static 副本按文件名恢复（md5 一致），
并把本 worktree 的 `data/static` 换成真实副本；已向并行 agent 通报该隐患。
**结论：隔离 worktree 必须用真实 static 副本，不能用符号链接。**

## 验收 1（题材规则加载）— 已通过（自动化证据）

`backend/tests/documentary-genre-rules.test.mjs`：

- `resolveGenreRuleset`：`纪录|紀錄|documentary` 命中；`古装历史剧`（只有「历史」）不命中；
- 开关优先：`on` 强制命中、`off` 强制不命中、`auto`/`null` 跟随关键字；
- `loadAgentSkills(type, lang)` 不带 ruleset 时输出**不含**任何 documentary 段落；
  带 `genreRuleset: 'documentary'` 时追加 `## Skill: documentary/documentary-*`，
  且输出以未命中版本的文本为前缀（基础技能一字未改）。

线上副本侧证：`GET /api/v1/dramas/3` 返回 `genre_ruleset: "documentary"`。

## 验收 3/4 的工具链路 — 已实测

- Commons 检索：`GET /api/v1/research/commons/search?q=Peter the Great portrait` 200，
  返回缩略图 + `artist=Pieter van der Werff` / `work_date=1690s` / `license=Public domain` / 来源页链接。
- 画像入库：`POST /api/v1/characters/25/archival-images {file_title}` 成功落 `archival_images`，
  `reference_images` 保持为空（生图链路不读 archival）。
- 提取期检索：第 1 轮角色提取中 Agent 自发调用 `wiki_search` 12 次（彼得一世 / 康熙 / 策妄阿拉布坦 /
  大策零敦多布等），落 81 条 `status='ok'` 记录；预算用尽后两条 `status='failed'`
  （「本次运行检索次数已达上限」），工具返回 degraded 指令「只用剧本原文」，提取未失败。

## 第 1 轮发现 → 已改规则/配置（规则级修正，不改单条产出）

1. **检索预算太小**：一集 12 个角色，12 次调用全部被 `wiki_search` 吃掉，`wiki_summary`/`wiki_extract`
   一次都没轮到。→ `RESEARCH_MAX_CALLS_PER_RUN` 12 → 24。
2. **一次检索落 8 行记录**，资产详情的「资料来源」会被刷成噪声。→ 每次 `wiki_search` 最多记 3 条命中
   （返回给 Agent 的结果不变）。
3. **检索记录挂不上资产**：Agent 写 `subject_name='康熙'`，资产名是「康熙帝」，逐字匹配回填失败。
   → `linkCitationsToAsset` 改为归一化 + 互相包含匹配。
4. **GLM 5.3 推理过长**：带 addendum 的整集角色提取单次推理超过 8 万字符仍未产出
   （`sys_task.params.reasoning_chars` 持续增长），耗时远超未带 addendum 的基线。
   这是下一轮必须先解决的问题（缩短 addendum / 显式限制推敲 / 用单资产重提取入口分批跑），
   否则量表 α/β 无法在 3 轮预算内跑完。

## 未完成（交接给后续）

- 量表 α（A1–A8）与 β（B1–B6，含彼得一世/康熙帝盲测与 Commons 画像比对）尚未评分：
  第 1 轮的角色提取未在本次会话内产出完整资产行。
- 抽样生图（4 角色 + 3 场景 + 3 道具）未执行。
- 浏览器 QA：前端 `:3056` 已起，首屏截图为空白，控制台错误尚未定位。
