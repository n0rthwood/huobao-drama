# Issue #118 生产验收报告 — 后端事件循环被批量 agent 任务打满（2026-11-17）

- 仓库：n0rthwood/huobao-drama；分支 `issue/118-event-loop`，合并至 `master`（最终 `092e2ae3`，其后另有 #110 会话的 `e063d8d6`）。
- 发布：`20261117T191345Z`（A/B/C 主体）→ `20261117T192440Z`（列表批量化）→ `20261117T194048Z`（视频预览批量化 + 衔接帧解码缓存）→ `20261117T195307Z`（项目类型/段解析缓存）→ `20261117T200323Z`（视频版本整集加载）。每次发布均按 huobao-prod-release 技能留痕在飞任务与打断决定（`interrupt-decision.json`），重启后按既有政策续跑。
- 生产入口：`http://172.30.3.164/huobao/`；后端 :5679（每次发布后 `ss -ltnp` 确认新进程持有监听）。
- 授权：用户 2026-11-17「可打断在跑任务、升级、重启、发布后在生产验收，尽快实施」；sys_task 4282/4283 可被打断。

## 交付内容（Issue v2 口径）

- **A 上下文瘦身 + 批量缓存**：`read_storyboard_context` 在 video/keyframes scope 省略 `text_spec`；道具只保留窗口内各镜绑定/设计卡引用/资产池 @ 到者的完整 semantics+map_pip，其余一行摘要（`detail_omitted`，`read_props` 可补）。整集加载器（关键帧状态/锁定衔接帧/本集资产/设计卡上下文/池关联）按 episodeId 批量生命周期缓存，写后失效；#43 同步事务链不读缓存。A4 未做（Issue 允许降级）。
- **B 全局 agent 并发闸**：`runAgent` 入口进程内信号量，默认 2（`HUOBAO_AGENT_GLOBAL_CONCURRENCY`），交互下一空槽优先（非抢占），排队可取消（AbortController 注册表 + `POST /tasks/:id/cancel` 支持 keyframe_prompts/video_prompts/design_card），全局等待单独记 `task_observed_work.agent_gate_ms`（不混端点 queue_ms），任务进度 `step='waiting_agent_slot'` 四语文案。
- **C 同步热路径优化（不是异步化）**：keyframe-batch preview 整集一次查绑定/版本 + Map 分发；生产 CPU profile（inspector 采样）定位并修复了四个额外热点：
  1. `GET /episodes/:id/storyboards` 逐镜 `checkStoryboardRefs` 重建整集设计卡上下文（profile 占 ~55% CPU）→ 整集绑定一次查 + 预加载上下文（ep30 列表 7.75s → ~1s）。
  2. `video-batch/preview` 每 15s 被工作台轮询、每次 ~12.3s：逐镜重建整集事实 + 每版本 sharp 重解码历史衔接帧 → 整集预加载 + 解码按 realpath+size+mtime 缓存（12.3s → ~1s）。
  3. `resolveDramaProjectType` 每次查库（类型创建后不可变）→ 进程内缓存。
  4. `parseSegmentRow` 每次读重新规范化 + 展开地图资产层（~15% CPU）→ 按行全列 + 底图资产版本指纹缓存；`loadVideoVersions` 逐镜全表扫 sys_task → 整集 join 一次。
- **D worker 进程隔离：本轮未实施**（前置条件风险高，见 Issue 评论的后续计划）。不宣称已获得进程隔离。
- Caddy 静态直出由主会话完成（版本库外），本轮未动。

## 验收① 功能无回归（八达岭长城测试 1117）

- 项目 **drama 23 / episode 31**（documentary，16:9，冷峻档案纪实），固定 224 字正文 + 出处行。
- 链路（全部生产 API，hbwf 留痕 `~/projects/history_project/8daling-1117/workflow/`）：
  - 原始内容 → AI 改写 run 22 / task **4310**（qwen4-max-preview，fidelity.v3 + bridge.v3，adopted）→ inspect-narration `findings=[]`（出处行已剔除）→ 剧本确认（m1_script done）。
  - 提取 characters/scenes/props（0 角色 / 2 场景 / 3 道具，含补提取 task **4341** 城墙断面）→ 审核清单 task **4322**：17 条 = 15 have + 1 added + 1 ignored（961 exposition 由旁白承载，理由留痕）+ 0 missing；5 条 prop_faithful 绑定地图道具 293（faithful=1）。
  - 旁白骨架 5 镜 242/242 字全覆盖 → 确认（revision 3fb13c9ffcc8786c）→ 配音 task **4352** 5/5（CosyVoice3，生产默认音色「沉稳男声·冷静讲解（净化）」）。
  - 设计卡 task **4353** 5/5（AI 首次填 combo 全 B，audit 0 阻断）→ 5/5 确认。
  - **关键帧提示词批量 task 4354：completed 5/5，failed 0**（1368 承接镜 first_frame_prompt 按规则留空）。观测：5 工作项 / 16 调用 / 177 条公开消息。
  - **视频提示词批量 task 4355：completed 5/5，failed 0**。观测：5 工作项 / 19 调用 / 212 条公开消息。
- 任务中心可回看完整公开调用（UI 截图 ui-02…ui-06；`GET /tasks/4355/observations` 返回 works/calls 含 agent_gate_ms）。
- 重启后历史仍在：4282/4283 的 124 条修复前工作项保留；在飞项按既有政策标「后端重启中断」后续跑（4282→4308→4311→4313→4319→4346→4359；4283→4309→4312→4314→4320→4347→4360，每次发布打断均留痕）。
- 绑定一致性（验收⑤）：ep31 5/5、ep30 78/78、ep27 75/75 镜 `computeTargetSync` 重算与库内绑定 **0 mismatch**（只读探针 probe-118-bindings.mts）。
- 未覆盖：Poster、图层段、关键帧出图、视频生成、合成、导出（验收①范围止于提示词批量）。

## 验收② 真实负载响应性（TTFB ≥60 次采样，p95 < 500ms）

采样 = 本机回环 `/api/v1/health` 与 `/api/v1/tasks/active` 交替，1.5s 间隔；时间戳与 `task_observed_work` 阶段对齐留痕。

| 轮次 | 窗口（UTC） | 负载 | 样本 | p50 | p95 | max | 结论 |
|---|---|---|---|---|---|---|---|
| round3 | 19:42–19:47 | 2 批量续跑 + 旧预览代码 | 122 | 367ms | 3930ms | 4662ms | 未达标（定位出列表/预览热点） |
| round4 | 19:53–19:58 | 3 批量 + 列表/预览修复中 | 142 | 60ms | 3745ms | 4600ms | 未达标（视频预览仍 ~4.8s） |
| **round5** | **20:03–20:08** | **3 批量续跑（4346/4347/4348）+ 设计卡/配音** | **193** | **18ms** | **351ms** | **914ms** | **达标** |
| round6 | 20:16–20:20 | 4 批量（+4355） | 148 | 20ms | 649ms | 1448ms | 略超（4 批量 + 另一会话 #110 发布重启边缘） |
| **round7** | **20:23–20:28** | **2 批量续跑（4359/4360）+ 取消验证** | **193** | **15ms** | **284ms** | **2451ms** | **达标** |

- round5 窗口内 41 个工作项（junction_caption 11 / video_prompts 12 / keyframe_prompts 7 / voice 5 / design_card 2 / design_group_plan 2 / layer_base_check 2），覆盖上下文重建、工具装配与观测写入阶段（`ttfb-round5-window-works.json`）。
- round7 窗口内 24 个工作项（video_prompts 14 / keyframe_prompts 8 / junction_caption 2）。
- 修复前基线（Issue 调查）：`/api/v1/tasks/active` TTFB 0.3–44s；round1/2（修复初期）p95 7.4s/9.5s。

## 验收③ 同口径性能对比（ep30 同集同模型 cfg:1 glm-5.3-flash）

- 基线 work 1972（sb1317，修复前）：work_ms **187,781** / model_ms **73,408**。
- 修复前任务 4282 全部 63 个完成工作项：avg work **108,261ms** / avg model **54,185ms**；中位 work 44,330ms；中位非模型 gap 3,079ms。
- 修复后 ep30 续跑（4319/4346/4359，36 个完成工作项）：avg work **53,972ms** / avg model **32,451ms** / avg 全局闸等待 **19,461ms**；**扣除闸等待后 avg work 34,511ms，中位 work 23,953ms，中位非模型 gap 486ms**（修复前 3,079ms → 486ms，-84%）。
- 闸等待是 3 批量并发下的人为排队（B 的设计目标），不是 CPU；单批量时段（4359/4360 双批量但端点空闲）gap 中位 ~500ms。
- `read_storyboard_context` 工具结果字符数（观测表实测）：修复前 4282/4283 每次 **122,641–139,770**；修复后 ep30 续跑 **64,330–87,992**（-37%~-48%）；测试项目 ep31 **11,864–16,183**。隔离探针（ep30 真实数据）：video scope payload 86,724 → ~60–70K，props 段 33,901 → 22,276（33 道具中 4 个保留细节），text_spec 11,201 → 0；批量内第 2 镜起上下文构建 347ms → 12–14ms（缓存命中）。
- 不宣称 114s 全是同步 CPU：gap 分解 = 上下文重建 + JSON 装配 + 同步 SQLite + 观测落盘 + Mastra 流式工具参数处理；本轮消掉的是其中可机检的重复查库/重复解码部分。

## 验收④ 全局闸证据（3+ 批量并发）

- 生产日志 `[AgentGate]`（`prod-gate-log.txt`，222 行）：4 批量并发期间（4346/4347/4348/4355，20:16–20:21）`active` 恒 ≤2，`queued=1` 真实出现；**0 次 active>2**。
- 活跃 runAgent 计数与并发 LLM 流分开记录：round5 窗口 64 次 LLM 调用、最大并发流 **3**（read_image 直连视觉调用不占 runAgent 闸，属预期）；round6 窗口 54 次调用、最大并发流 **2**。
- 交互优先：20:04:19 `interactive=true` 排队 → 20:04:25 下一空槽获得（gateWaitMs=5245），期间批量等待者未被抢占。
- **排队取消不泄漏槽（生产实测）**：第三批量 task **4361**（ep31 关键帧提示词 2 镜）进入 `step='waiting_agent_slot'`（queued=1）→ `POST /tasks/4361/cancel` 200 cancelled → 日志 queued=1→0（waiter 出队），active 恒 ≤2，其余批量照常拿槽（20:23:52 acquired gateWaitMs=23699）；4361 终态 cancelled 不被收尾覆盖（`prod-cancel-evidence.json`）。
- 隔离 QA（5689，副本库）同验证：3 批量并发 active≤2、交互优先、取消出队（`qa-gate-log.txt`、`gate-timeline.json`）；行为测试 tests/agent-gate.test.mjs 3/3、tests/episode-read-cache.test.mjs 1/1。

## 验收⑤ 吞吐不劣化 + 绑定一致性

- 修复前 4282（2 批量并发、无闸）：63 镜 / 6,821s = **108.3 s/镜**。
- 修复后 4359+4360（2 批量并发、闸 2）：17 镜 / 361s = **21.2 s/镜聚合**（每批量 ~42 s/镜，含闸等待）；扣除闸等待的单镜中位 work 23,953ms vs 修复前 44,330ms。**吞吐不劣化（>20% 判据通过）**。
- 绑定一致性：ep30 78/78、ep27 75/75、ep31 5/5 镜 0 mismatch（见验收①）。
- preview 等价性（C 的正确性）：QA 副本库上旧/新 `previewEpisodeKeyframeBatch` 332/336 项逐字一致；旧/新 `previewEpisodeVideoBatch` 112/112 项逐字一致（含 reason/change_reasons/version_no）。

## 验收⑥ 数据口径

- 未新建/删除/手改既有真实项目数据；ep30/ep27 续跑写入属既有恢复政策（用户授权打断），任务 ID 链留痕（见验收①）。
- 其余 DB 访问全部只读（better-sqlite3 readonly / mode=ro）；生产写入只经产品 API（hbwf call 留痕）。
- 测试项目 drama 23 为一次性验收项目；其审核处置/确认由测试代行并逐条留痕（decisions.jsonl）。

## 验收⑦ D 未实施

见 Issue 评论：跨进程领取互斥、共享并发计数、崩溃恢复不重复生成三项前置条件未满足，本轮不实施 worker 隔离，不宣称已获得进程隔离。

## 测试与回归

- backend `node --test tests/*.test.*`：820 tests，810 pass / 10 fail，**not-ok 集合与 master 基线逐条一致**（存量失败，无新增）。
- `npx tsc --noEmit` 通过。新增行为测试：agent-gate（封顶/交互优先/取消/env/观测分列）、episode-read-cache（复用/失效/作用域外不缓存/失败不缓存）。
- 前端仅 TaskDetailDialog 一行等待文案 + 四语 locale key（取消按钮复用既有 `cancellable` 通道，无新组件）。

## 证据文件（本目录）

- `baseline-pre-release.json`、`interrupt-decision.json`、`perf-comparison.json`、`post-release-works.json`
- `ttfb-round3.json` … `ttfb-round7-pass.json` + 对应 `*-window-works.json`、`ttfb-round5-llm-streams.json`
- `prod-gate-log.txt`、`prod-cancel-evidence.json`
- `acceptance-1117-summary.json`、`ui-01…ui-06` 截图（已读图核对）
- `qa-gate-log.txt`、`gate-timeline.json`、`gate-driver.out`、`qa-context-probe-ep30.json`（隔离 QA）
- hbwf 台账：`~/projects/history_project/8daling-1117/workflow/{ledger,decisions}.jsonl`

## 已知限制

- 全局闸是进程内信号量：D 实施前不承诺跨进程总量（当前单进程部署，成立）。
- `agent_gate_ms` 在 3+ 批量并发时是主要等待来源（设计目标）；单批量时 ≈0。
- 段解析缓存返回共享对象（消费方只读）；写路径一律经 saveLayerSegment 重建，updatedAt 变化即失效。
- 另一会话（#110）在 20:22 发布了 `20261117T202216Z` 并重启后端，打断 4346/4347（已按政策续跑为 4359/4360）；该发布不属于本 Issue。
