# Issue #33 资产批量生成 — 隔离 QA 记录

实例：worktree `huobao-drama-issue-33`，后端 5733（原定 5723 被 #31 的残留后端占用，已让出）、前端 3057（`HUOBAO_BASE_PATH=/`，否则 dev 的 vite 代理不匹配 `/huobao/api`）。
数据：live 库 sqlite backup API 复制到 `data/huobao.sqlite3`（备份 `~/huobao-backup/huobao.sqlite3.pre-issue33-20261101-201429`），启动前把活跃 `sys_task` 标 failed、`keyframe_batches`/`video_batches` 的 running 标 cancelled；`data/static` 为独立副本（非软链）。
测试剧集：drama 3《中俄纪录》/ episode 5（12 角色 + 15 场景 + 18 道具 = 45 个资产）。

## 验收对照

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 四个批量按钮 + 四语言 | ✅ | `01-dialog-all-assets.png`、`02-batch-running.png`；按钮文案 `批量角色 / 批量场景 / 批量道具 / 全部资产`，key `episode.prod.batch.{characters,scenes,props,all}` 四语言齐全 |
| 2 | 确认框统计与库一致、勾选实时重算 | ✅ | 无勾选 45 → 将生成 1（缺提示词 1）/ 跳过 已有图 38 + 忠实素材 6；勾「覆盖」→ 39（复用提示词 38 + 缺提示词 1），`39 = 45 − 6 忠实 − 0 生成中`；再勾「重写」→ 重写提示词 38 + 缺提示词 1 |
| 3 | 提示词与图像异步解耦 | ✅ | 批次 567 时间戳：第 1 张图像任务在后续资产提示词仍在生成时即创建（见 §异步解耦时间戳） |
| 4 | 文本并发 = `ASSET_PROMPT_CONCURRENCY`（默认 3） | ✅ | 日志同一时刻 3 条 `[FinalPrompt] character-generate`；状态接口始终恰好 3 项 `prompting` |
| 5a | 无提示词 + 提示词失败 → failed 且无图像任务 | ✅ | 批次 553（文本配置指向死端口）：角色 13（`final_prompt` 为空）state=failed、task_id=null |
| 5b | 有旧提示词 + 重写失败 → failed、不拿旧稿出图 | ✅ | 批次 553：角色 14–24 的 `final_prompt` sha256 前后完全一致，12 项全部 `task_id=null`，批次期间角色图像任务数 18 → 18 未增 |
| 5c | `unchanged_after_rewrite` → 照常出图并单列计数 | ✅ | 批次 565（假文本服务回放逐字相同的提示词）：角色 14 `prompt_outcome=unchanged_after_rewrite`、`task_id=566` 且图像完成，`counts.prompt.unchanged_after_rewrite=1`，提示词 hash 未变 |
| 5d | 未勾重写、已有提示词 → reused 并出图 | ✅ | 见 §复用出图 |
| 6 | 忠实素材保护 | ✅ | drama 3 的 6 个 `provider='upload'` 当前图（场景 29、道具 25/26/39/40/41）在「覆盖 + 重写」全量批量里全部 `skip_faithful`，未产生图像任务、提示词未改；另用 11 个人工注册的 upload 版本行验证角色侧同样被跳过（批次 565，`skipped.faithful=11`） |
| 7 | 取消 | ✅ | 批次 546：取消后父任务 `cancelled`，6 个已提交 qwen-jobs 任务全部 `cancelled`，剩余项 `cancelled`，无新派发 |
| 8 | 幂等重按 | ✅ | 见 §幂等重按 |
| 9 | 同剧单批次 | ✅ | 运行中再调 start → `400 该项目已有资产批量在运行，请等待或先停止`；UI 四个按钮同时置灰（`02-batch-running.png`） |
| 10 | 进度与排队 | ✅ | 确认框显示 `图像排队：在线 2 卡 · 当前等待 0s · 预计总耗时 31m 28s`；运行中横幅显示 进度/提示词/图像三段计数 + 停止按钮；资产卡片进度环与「等待中 · 第 N 位」零改动复用 |
| 11 | DoD（45 项终态） | ✅（机制） | 见 §全量批次，内容质量验收等 #32 规则定稿后再跑 |
| 12 | 测试集一致 + 纯函数行为测试 | ✅ | 后端 `not ok` 名称集合与主检出完全一致（pass 114 → 118，新增 4 条）；前端 `not ok` 集合与主检出一致（18 条历史失败） |

## 异步解耦时间戳

见 `03-timeline.txt`（父批次 items 的提交顺序与各图像 `sys_task.created_at`，以及后端日志里 `[FinalPrompt]` 与 `[AssetBatch] image submitted` 的交错）。

## 全量批次

见 `04-full-batch.json`（批次 567 的最终 counts 与逐项状态）。

## 复用出图 / 幂等重按

见 `05-reuse-and-idempotent.txt`。
