# Issue #86/#87 文档评审处置

这是完成实现后的两供应商封闭文档评审，不重复已经完成的一次性 Issue 方案评审。原始输出见同目录 `20261108-issue87-gpt6.1-sol.md`、`20261108-issue87-fabel.md`。初始配置角色的 completion 等待超时且没有拿到结论，改为显式 GPT6.1-sol 与 Anthropic Fabel 的无工具 CLI 调用；没有把角色名冒充已核实的型号。

## 采用

- 补实际代码版本、生产证据边界、任务 ID 获取路径、消息 id/游标、轻量列表/全文分页、预估/进展字段与失败处置。
- 公开记录采集失败时保留已发生业务副作用；先读回再决定是否重提，不静默吞错，不回滚保存成功的卡片。
- 文本 LLM 也要计费授权；预估 POST 不生成、不计费，与会调用 LLM 的稿件检查区分。URL 恢复不能触发检查。
- 修正已过时的 Poster 本地画布流程、纪录片 v4/剧情 v2 签名、FPS 继承、纪录片骨架→配音→设计卡顺序，以及“所有批量必有 preview”“镜数必等于段数”的绝对化表述。
- 历史案例保留原始失败与授权边界，移到必读 references，明确不是当前操作配方；主 SKILL 控制在 managed skill 64KB 限制内。
- 保留并行 #84 已评审分支 `1eb48cb` 的待发布地图文档和评审，不合并其代码，不把任何新增地图 API 升为 `[R]`。

## 按源码纠正评审推测

- observations 的 `messages/message_limit/messages_complete` 在轻量模式也存在，值为 `[]/0/false`；不能按评审推测写成字段缺失。
- 设计卡 fill/status 当前没有 task_id。通过本集 tasks/center 的新 ID、kind 和不可变范围核对身份，不凭空添加响应字段，也不能因缺少该字段中止观察后再重复提交。
- “force 后相同也成功”不能笼统成立。`final-prompt.ts:savedPromptOf` 及单发 generate-prompt 只接受 reused/regenerated，unchanged 返回 400；批量 `asset-batch-select.ts:shouldSubmitImage` 则允许 unchanged_after_rewrite。文档分别说明，不改业务代码，不为制造文本差异盲目重跑。
- 不按评审扩展新接口、静态模型能力矩阵、重试系统或全局 #88 实现。#87 的生产实测只提升确实发过的请求/观察过的行为；未触发的分支继续 `[S]` 或 `[S/R]`。

## 生产观察

本轮专用 drama11 / episode17：骨架1281失败留痕，修正重复/空分配后保留6段原文；配音1282六镜完成；设计1283完成、1284真实重启中断、1285四镜完成。65条调用、727条公开消息分页读全；其中19次视觉子调用均为Cloud配置14。没有新图片或视频生成，也没有为了补证据重跑已用完的生成额度。具体运行证据见 `docs/qa/issue-87-20261108/`。
