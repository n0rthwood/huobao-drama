# Issue #124 生产验收报告（地图工作室：失败分型 / 追加步数 / 续跑 / 动态预算）

日期：2026-11-19。发布：release `20261119T071130Z`（origin/master b317ede0）。
入口：`http://172.30.3.164/huobao/map-studio/7`。生产库只读查询；测试为**新建 standalone 专用任务**，不碰真实项目。
发布前备份：`~/huobao-backup/huobao.sqlite3.pre-issue124-20261119T071106Z`。

## 测试任务与运行

任务 **7「QA124 生产验收 1119」**（standalone，6 地理目标 brief：卡马河、楚索瓦亚河、乌拉尔山脉、索利卡姆斯克盐场、奥廖尔镇、丘索瓦亚镇）。

| 运行 | 阶段 | 配置 | 结果 |
|---|---|---|---|
| 37 | brief | 16 Qwen4-Max | 阻断（时代/用途不够具体，brief 判定正常）；首轮 429 配额错误记 `error` |
| 38 | brief | 16 | failed：3 轮 429「Allocated quota exceeded」→ 配置 16 被健康机制暂停；error_detail.kind=call_error |
| 39 | brief | 1 GLM-5.3 | accepted（改写 brief 后一次通过） |
| 40 | research | 1 GLM-5.3 | **completed，181.8 s**：r1 rejected（near_river 10 km vs 实算 70.94 km）→ r2 rejected（70 km 仍差 0.94 km）→ r3 accepted；7 要素 / 9 来源 |

## 验收条件对照（Issue #124）

1. **分型判定**：生产 run 38 = call_error（429 原文保留）；run 40 逐轮 rejected/accepted 带 steps_used。steps_exhausted / ended_without_delivery / 追加段提前收尾 / 同轮先拒收后耗尽：隔离 QA 全分支覆盖（`isolated-qa-report.md`，行为测试 map-studio-steps.test.mjs）。
2. **追加段**：隔离 run 50（task 9）基础段 46 步耗尽 → step_extension(+40) → 追加段 5 步部分交付 accepted；追加启动消息含实际耗尽步数与「必须提交部分结果」（夹具日志 qa124-ext.jsonl）。生产 run 40 未触发追加（8 步内交付）。
3. **软提醒**：隔离 run 49（task 8）第 39/46 步触发提醒后模型收尾交付（qa124-warn.jsonl，warn=4）；生产 run 40 未触发（步数远未到阈值）。
4. **续跑**：生产 run 40 r1 拒收后 `research_progress_summary` 落盘（sources 9 / dataset_queries 6 / uncertainties 4 / steps_used 6），r2/r3 同 run 续用；验收后 summary=null。跨 run 恢复、brief 变化失效、显式清空：隔离 QA task 7/11 全链路证据 + map-studio-resume.test.mjs。
5. **已验收成果保护**：run 40 验收后 stage→base（awaiting_review），research 成果保留；startStage 续跑逻辑未改（既有 map-studio-agent.test.mjs 回归通过）。
6. **动态预算**：生产 run 40 状态消息「本段步数：已用 1 / 预算 100（剩余 99）」——brief 专名去重计数 = 10（卡马河/楚索瓦亚河/乌拉尔山/索利卡姆斯克盐场/奥廖尔镇/丘索瓦亚镇等，含自由文本切分的长短语候选），40+6×10=100 达上限；隔离 task 8/9 单目标 brief 预算 46。计算口径行为测试覆盖（去重/两字地名/保底/上限）。计数是确定性规模估计，长短语候选会抬高预算（宁多勿少），不是精确地名识别。
7. **用户提示**：生产 UI 逐轮面板显示「第 1 轮 被拒 6/100 步 … relation_conflict …」（截图 prod124-rounds-accepted.png）；余额不足翻译、mixed 横幅、切换模型并重试/基于已有结果继续/清空检索成果（二次确认）：隔离 QA 截图与 DOM 断言。
8. **根因消除**：生产 run 40 状态注入逐条带 refs（task_observed_text：`dataset 查询历史：river「Kama」… refs：ne-group:10m_rivers_lake_centerlines:kama、…`，6 条状态消息含 refs），无逐字重复查询循环；同任务 6 的旧循环（run 35/36 每轮 40 步重查）不再复现于本次运行。
9. **回归**：后端/前端全套失败名单与基线一致（10/19 项既有失败，无新增）；backend tsc 通过；map-studio 边界测试通过。

## 证据

- 截图：`prod124-research-running.png`（研究执行中）、`prod124-rounds-accepted.png`（逐轮 6/100、7/100、8/100 步与拒收原因）。
- 隔离 QA 全分支证据与 7 项集成缺陷修复记录：`isolated-qa-report.md` + qa124-*.jsonl/png。

## 已知限制

- 生产未真实触发 steps_exhausted/追加/软提醒分支（GLM 8 步交付，属正常）；这些分支由脚本化模型夹具在隔离环境稳定复现并留痕，行为测试常驻回归。
- 配置 16（Qwen4-Max 百炼）验收期间配额 429 被暂停，未恢复（属供应商配额问题，非本次代码变更）；任务 6 仍停在 base awaiting_review，未改动。
