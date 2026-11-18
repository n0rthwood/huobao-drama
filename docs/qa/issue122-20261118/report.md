# Issue #122 隔离 QA 报告（2026-11-18）

环境：worktree `huobao-drama-issue-122`，后端 :5689 / 前端 :3023（HUOBAO_BASE_PATH=/），DB 生产库副本（活跃任务中和），static 全量副本。

## 验收项与证据

### 1. 模块边界与持久化
- 9 张模块表幂等建立（asset_studio_task/run/setting/delivery/research/source/spec/round/qc_record）。
- 后端边界测试 1/1、前端边界测试 2/2 通过；backend tsc 干净。
- 旧 `/asset-pipeline/runs` → 404；新 `/asset-studio/tasks` → 200 JSON。

### 2. 真实整轮流水线（专用测试项目 drama 910 / ep 910 / prop 910「测试青铜剑」）
- `POST /asset-studio/tasks/open {host_ref:'prop:910'}` → task 1，带资产快照。
- 入库素材（source 1，CC0）→ `POST /tasks/1/run {purpose:'precision',source_ids:[1]}` → run 1。
- 真实跑通 research → spec → generate（qwen-central 出图 `static/images/0ee7fd08-….png`，image_task_id 4949）→ QC → **gate PASS** → suspended waiting_approval（awaiting round_id 1, suggestion pass）。
- 观测：task_observed_work scope='asset_studio' 2 works / 2 calls，stage_spans research completed / spec→generate→qc。

### 3. 审批与交付
- `POST /runs/1/approve {verdict:'approve',opened:[…]}` → 200；run → completed/finalize。
- `POST /runs/1/deliver {round_id:1,set_as_current:true}` → versionId 4949，prop 910 image_url 更新为成图，delivery 1 行。
- **幂等**：重复 deliver → 200 同 versionId，不重复登记。
- **冲突保护**：外部改 prop 描述后再 deliver → **409**「资产已在工作室外修改」。

### 4. 重启恢复
- 插入 running run 90（无 Mastra 快照）→ 重启后端 → run 90 标 failed「重启恢复：工作流快照缺失」（不假装继续）；completed run 1 保留。
- suspended 保持等审批语义由 resumeAssetStudioRuns 实现（suspended+快照 suspended → continue）。

### 5. 前端 UI（0 页面错误）
- `/asset-studio/1`：资产输入、流水线阶段、模型选择、参考图多选、轮次图、QC/闸门、审批面板、交付/采用、运行历史、观测调用分页（截图 01/02）。
- 资产弹窗（drama 910 prop 910）：与 drama 一致，无内嵌流水线面板，仅「打开资产工作室」入口；点击 → `/asset-studio/1?run=1`（deeplink）。
- 顶栏「资产工作室」入口与地图工作室并列。

### 6. 套件
- 后端全量失败名单与 main 逐条相同（10 个既有无关失败）；前端 17 个与 main 相同。
- 引擎测试迁模块全过：gate 13、deadline 8、contract 6、references 8、approval-state 2、boundary 1。
- 前端迁移测试 32/32（asset-pipeline-facts/pipeline-text-policy/layer-editor-behavior + boundary）。

## 待生产验收
本报告为隔离 QA。按 AGENTS.md §9，最终验收在生产系统用专用测试项目留痕（发布后执行）。

## 已知限制
- 重启恢复测试用无快照 run 验证 failed 路径；真实 suspended 重启续审批未在隔离环境复现（需真实 Mastra 挂起快照），生产验收补。
- layer-editor-behavior 测试输出含两类控制台异常（el.addEventListener / undefined.length），为既有测试 stub 局限，非本次回归（失败名单与 main 一致）。