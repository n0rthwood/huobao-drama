# Issue #128 隔离 QA 记录（worktree，生产数据副本）

日期：2026-11-21。环境：`huobao-drama-issue-128` worktree，backend :5689 / frontend :3023（`HUOBAO_BASE_PATH=/`），
DB = 生产库 SQLite backup API 副本（启动前把副本内 6 条活跃任务标失败、运行中批次标 cancelled），`HUOBAO_DATA_DIR` 指向 worktree data。
真实模型：config 10 DeepSeek V4.1 Flash 1017 (local)（与生产 #4991 同端点同模型）。生产实例与生产库未触碰。

## 任务 5014：#4991 同款失败现场重跑 → 拒收→修正→接受

- `POST /api/v1/episodes/34/poster/concept {config_id:10}` → task **5014**（drama 26 / ep 34，9:16）。
- 第 1 轮模型提交：c1/c2 主标题 3 行超 `p-vertical-left/right` 的 3 字×2 行容量 → 工具拒收，
  problems 逐条带容量与 p-vertical-top/bottom 换套提示（与 #4991 的失败同型）。
- 第 2 轮模型改短主标题（「尖叫着\n赶雪山」「全家冲\n大堂」等，每行 ≤3 字）→ **accepted**，任务 completed。
- `params.concept_rounds` = `[{round:1,outcome:'rejected',problems:[c1,c2]}, {round:2,outcome:'accepted',problems:[]}]`。
- 观测：1 个 `poster_concept` 工作项（completed，源字数 769），2 次 llm 调用（61.7s / 40.2s），
  公开消息含 tool_definitions / system / user / tool_call / tool_result / tool 全量（`isolated-5014-observations.json`）。
- concept 落库：`episode_posters.concept_updated_at=2026-11-21T15:40:08.099Z`，三方案 c1:p-vertical-left / c2:p-vertical-right / c3:p-vertical-top。
- 浏览器实证（agent-browser，session huobao-qa-128-76e70f8c91fa）：任务详情「模型对话与调用」显示工作项与两次调用，
  展开可见拒收 JSON（accepted:false / round:1 / rounds_left:7 / 中文 problems）——截图
  `isolated-5014-conversation.png`、`isolated-5014-rejection-feedback.png`。
- 对照：旧机制（生产任务 4991，同端点同模型同集）一次盲改后 failed；新机制两轮自愈。

## 任务 5015：运行中 HTTP 取消

- 再次 `POST …/poster/concept` → task 5015；`GET /tasks/5015` 显示 `cancellable:true`（processing）。
- `POST /api/v1/tasks/5015/cancel` → cancelled「用户取消」；8s 后终态仍 cancelled（收尾不覆盖）。
- concept 未被取消的运行改动（`concept_updated_at` 仍为 5014 的时间）。证据 `isolated-5015-cancelled.json`。

## 回归

- backend 全套：873 tests，失败 10 个，名单与主工作区基线逐名一致（均为历史遗留结构测试）。
- frontend 全套：212 tests，失败 19 个，名单与基线逐名一致。
- 新增 `tests/poster-concept-agent.test.mjs` 5 例全过（#4991 复刻 / #2991 资产引用进反馈环 / 8 轮拒收 / 取消 / 正文纠偏）。
- `tsc --noEmit` 通过。

## 顺手修复（QA 发现）

- 任务中心行级 `taskCenter.textKind.poster_concept` 四语缺失（显示原始 key）——本分支补齐（该缺口在旧代码即存在）。
