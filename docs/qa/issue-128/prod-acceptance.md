# Issue #128 生产验收记录（2026-11-21）

发布：release `20261121T154638Z`（merge `712b0b1d`，origin/master 已含）。发布前确认无在飞文本/视频任务
（最后一条 qwen-jobs 图片 5003 与关键帧批 78 已自然完成），SQLite backup API 备份
`~/huobao-backup/huobao.sqlite3.pre-release-issue128-20261121T154638Z`。
smoke 全 200（backend health/index + edge /huobao/、/huobao/api、深链、_nuxt 资源）；
:5679 listener 属新 PM2 进程树（pid 4052751 → node 4052795）。

## 生产任务 5014（用户授权的验收对象：drama 26《Florence》/ episode 34，真实项目）

- 入口：`POST http://172.30.3.164/huobao/api/v1/episodes/34/poster/concept {config_id:10}` → task **5014**。
  模型 = DeepSeek V4.1 Flash 1017 (local)（与失败任务 4991 同端点同模型）。
- **第 1 轮拒收**：c1/c2 主标题 3 行，超 `p-vertical-left/right` 的 `poster_title.main` 3 字×2 行容量；
  工具结果带逐条中文问题 + 容量 + p-vertical-top/bottom 换套提示（与 4991 失败同型）。
- **第 2 轮接受**：模型改短主标题（「尖叫着\n赶雪山」「全家冲\n大堂」「装备就位\n开战」，每行 ≤3 字）→ accepted。
- 任务 completed，墙钟 15:46:59.959Z → 15:48:34.396Z（约 94 s，2 次模型调用）。
- `params.concept_rounds` = rejected(round 1, c1/c2) → accepted(round 2)。
- 只读 DB 复核：`episode_posters.concept_updated_at=2026-11-21T15:48:34.395Z`（覆盖 4992 的旧构想，用户已确认），
  三方案 c1:p-vertical-left / c2:p-vertical-right / c3:p-vertical-top；`prompt`/`base_image` 等编辑字段未动，未自动生图。
- 观测：`GET /tasks/5014/observations` 1 个 poster_concept 工作项 + 2 次 llm 调用，公开消息全量
  （tool_definitions/system/user/tool_call/tool_result/tool），导出 `prod-5014-observations.json`、`prod-5014-task.json`。
- 浏览器实证（生产 LAN 入口 /huobao/，命名 session huobao-prod-128-76e70f8c91fa）：任务详情「模型对话与调用」
  显示工作项与两次调用，展开可见拒收 JSON（accepted:false / round:1 / rounds_left:7 / 中文 problems）；
  页面 errors/console error 为空。截图 `prod-5014-rejection-feedback.png`（已实际读图核对）。

## 对照结论

同集同模型：旧机制（任务 4991）一次盲改后 failed；新机制（任务 5014）第 1 轮拒收 → 第 2 轮修正 → accepted，
错误信息经工具结果回给 harness 继续下一轮，符合用户要求的反馈机制。

## 回归与隔离 QA

- backend 873 tests / frontend 212 tests，失败名单与基线逐名一致；新增 5 例行为测试全过；tsc 通过。
- 隔离 QA（worktree :5689/:3023，生产库副本）：任务 5014 同型自愈 + 任务 5015 运行中 HTTP 取消（cancellable=true，
  终态不被覆盖、concept 不受影响），见 `docs/qa/issue-128/isolated-qa.md`（issue 分支留痕）。
