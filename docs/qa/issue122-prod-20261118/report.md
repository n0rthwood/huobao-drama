# Issue #122 生产验收报告（2026-11-18）

发布：release `20261118T091917Z`（merge `6e0f6e5b` → origin/master）。:5679 新进程（pid 3292116）；`/asset-studio/tasks` 返回 JSON，旧 `/asset-pipeline/runs` → 404；9 张模块表建立。发布前 DB 备份 `~/huobao-backup/huobao.sqlite3.pre-122-*.bak`。

## 专用测试项目
drama **25**「八达岭长城测试 1118-2」（documentary，16:9）/ ep **33** / prop **297**「测试青铜剑」。

## 验收证据（只读 DB + 截图，db-evidence.json）

### 1. 真实整轮流水线（生产 qwen-central + GLM）
- `POST /asset-studio/tasks/open {host_ref:'prop:297'}` → task 1。
- 入库素材 source 1（CC0）→ `POST /tasks/1/run {purpose:'precision',source_ids:[1]}` → run 1（mastra 891e329f）。
- research → spec → generate（成图 `static/images/a9bcaf9a-d14c-4b70-9dc3-6a395e1c24f8.png`，image_task_id 4949）→ QC → **gate PASS** → suspended waiting_approval。
- 观测 task_observed_work scope='asset_studio' 落盘阶段跨度。

### 2. 审批与交付
- `POST /runs/1/approve`（opened 带真实 sha256）→ 200；run → completed。
- `POST /runs/1/deliver {round_id:1,set_as_current:true}` → versionId 4949，prop 297 image_url 更新，delivery 1 行。

### 3. UI（生产 /huobao/ 入口，0 页面错误）
- `/huobao/asset-studio/1`：资产输入/阶段/模型/参考图/轮次/QC/审批/交付/运行历史/观测（截图 01）。
- 资产弹窗（drama 25 prop 297）：与 drama 一致，无内嵌流水线，仅「打开资产工作室」入口（截图 02）。

### 4. 套件
- 后端 tsc 干净；全量后端/前端失败名单与基线逐条相同。
- 引擎测试迁模块全过（gate 13/deadline 8/contract 6/references 8/approval-state 2/boundary 1）；前端迁移测试 32/32。

## 已知偏差（如实记录）
- **5 条历史 suspended asset_pipeline run（1003/1004/1203/1264/4943）在发布重启后被 failInterruptedTextTasks 标 failed「后端重启中断」**。原因：#122 删除了 asset_pipeline 豁免（新 run 不再进 sys_task），但存量 suspended 行仍属该 kind，重启即被判死。这些是 2026-11-07 起的陈旧审批等待行（数周未动），其 Mastra 快照仍在 data/mastra-workflows.db；如需续跑须从资产工作室新建 run（旧容器不再恢复）。**这是退役旧容器的预期代价，但应在发布前明确告知用户**——此处补记。新资产工作室 run 的 suspended 恢复语义不受影响（resumeAssetStudioRuns 保留 suspended）。
- 重启恢复的 interrupted 路径与交付幂等/409 冲突在隔离 QA 验证（docs/qa/issue122-20261118/），生产未复现 suspended 重启续审批（需真实挂起快照）。