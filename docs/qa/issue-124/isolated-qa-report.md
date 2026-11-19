# Issue #124 隔离 QA 报告（地图工作室：失败分型 / 追加步数 / 续跑 / 动态预算）

日期：2026-11-19。环境：worktree `huobao-drama-issue-124`（基线 origin/master 5b0c47f9），
后端 :5689 + 前端 :3023（HUOBAO_BASE_PATH=/），DB 为生产库 backup-API 副本（`data/huobao.sqlite3`，活跃任务已标失败），
模型为本地脚本化 OpenAI 兼容夹具 `backend/scripts-qa/qa-fixture-model.mjs`（不入库，QA 后删除）。
**本报告为实施期自测；生产验收在发布后另行留痕（AGENTS.md §9）。**

## 测试任务与运行（均在副本库，standalone 任务，不碰真实项目）

| 任务 | 场景 | 运行 | 结果 |
|---|---|---|---|
| 7 QA124 步数与续跑测试（6 目标，预算 76） | loop-then-submit（旧夹具 ref 故意非法） | 37 | 3 轮 rejected，逐条校验原因；progress 落盘（sources 5 / dataset_queries 67 / uncertainties 1） |
| 7 | loop-forever | 38/41 | mixed：r1 steps_exhausted（76+40 追加耗尽）、r2 追加段提前收尾→steps_exhausted（修复后）、r3 ended_without_delivery；每轮 step_extension 记录 |
| 7 | call-error（余额不足） | 42–46 | call_error；修复前原始错误被「文本模型已暂停」覆盖（缺陷证据），修复后见任务 10 |
| 7 | resume-submit（续跑） | 47→48 | 47 拒收（extent 裁剪问题，夹具修正）；48 第 1 轮 accepted：部分交付 1 要素 + uncertainties，progress 清空，stage→base |
| 8 QA124 追加与软提醒验收（1 目标，预算 46） | loop-then-submit | 49 | 软提醒在第 39 步触发（剩余 8），模型收尾补齐 4 适配器后部分交付，42/46 步 accepted，**未用追加** |
| 9 QA124 追加段交付验收（1 目标，预算 46） | extension-only（忽略软提醒） | 50 | 基础段 46 步耗尽 → step_extension(+40) → 追加段 5 步 accepted；夹具日志 sawExtension=true |
| 10 QA124 余额错误翻译验收 | call-error | 51 | call_error，message=「供应商余额不足，请充值或更换文本配置。原始错误：…Insufficient Balance (request_id: qa-fixture-0001)…」（首错保留+暂停原因还原） |
| 11 QA124 清空与失效验收 | end-early | 52–54 | ended_without_delivery 分型；UI 二次确认清空→summary=null、按钮变「重新检索（将从头开始）」；brief 修改→available=false 且新 run 不注入续跑；research 阶段 rejected 横幅显示重试按钮 |

## 关键证据

- 状态注入（run 47 首步，task_observed_text）：`dataset 查询历史：river「Kama」 bbox=[52,56,61,61.5] ×200 次 3 命中，refs：ne-group:10m_rivers_lake_centerlines:kama、ne:…1018、ne:…1017`（去重+refs 修复生效）；`本段步数：已用 1 / 预算 76（剩余 75）`。
- 软提醒文本（run 37 末步状态）：`步数预算即将用完：先补齐未检索适配器再立即提交已有要素，未尽事项写 uncertainties。`
- 续跑注入（run 47/48 首条 user）：`续跑：已登记 N 条来源；已读正文：…。未决事项：…。不要重复逐字相同的查询。`
- 追加启动消息（夹具日志 qa124-ext.jsonl sawExtension）：`上一段已耗尽 46 步仍未交付；必须提交部分结果，查不清的写入 uncertainties 作为后续着重点。`
- 截图：`qa124-failure-banner.png`（mixed 横幅+切换模型并重试/基于已有结果继续/清空检索成果）、`qa124-balance-banner.png`（余额不足翻译）、`qa124-rejected-research-retry.png`（rejected 态「重新检索（将从头开始）」）。
- 夹具请求日志：`qa124-*.jsonl`（每行 seq/scenario/sawExtension/sawWarn/toolMsgs/chars）。

## 集成期发现并修复的缺陷（均有回归测试）

1. 预算正则 `{2,30}?` 漏两字地名（长江）→ `{1,30}?`。
2. 状态注入逐次重复查询（67 条相同记录膨胀到 9977 字）→ 按 layer+query+bbox 去重 ×N。
3. onRoundEnd 的 expectedBriefHash 在 brief 变更时抛 Stale 打断交付 → best-effort 跳过。
4. brief 阶段两参构造 MapStageExhaustedError 丢失「3 轮」与分型 → 传逐轮摘要。
5. 追加段内提前收尾记 ended_without_delivery 且下轮重置预算 → 追加段未交付一律 steps_exhausted 计轮。
6. 余额错误被 SDK 重试的「文本模型已暂停」覆盖 → 保留首错并读暂停原因还原上游错误。
7. rejected 态失败横幅无重试入口（父容器排除 rejected）→ research 任意分型均显示重试按钮。

## 回归

- 后端全套：失败名单与基线完全一致（10 项既有失败，无新增）；新增 map-studio-steps / map-studio-resume 全绿；map-studio-agent / compaction / validate / research-schema 全绿。
- 前端全套：失败名单与基线一致（19 项既有失败，无新增）；map-studio 相关 8 文件 55 pass / 0 fail。
- `npx tsc --noEmit -p .`（backend）通过。
