# Issues #86 / #87：生产验收记录

## 1. 范围、授权与真实环境

- 用户授权原话：「批注按固定案例进行测试。这个没有问题。」按已登记的固定八达岭案例新建专用项目；没有修改 drama 3 或其他既有真实项目。
- 专用项目 **drama 11《八达岭长城测试 1008-2》/ episode 17 / E01**。原始公开素材 224 字；出处只放原始内容。准备阶段改写 run 4 / task **1268**，资产审核 **1278**、补提取 **1279 / 1280**；资产通过产品导入 API 独立复制，没有重新生图。
- 本轮主验收预算：骨架 **1/1**、TTS **6/6**、设计卡 **6/6 次尝试**（含一次有意重启中断）；图片 **0**、模型视频 **0**。没有为补漂亮结果追加生成、重试或导出。此报告不是全片美术/史实或成片验收。
- 功能提交至 **3eec6f7**，生产主分支合并 **c6bf2ab**，release **20261108T204444Z**。发布脚本验证后端 health/index、前缀 API/深链/实际 hash 资源均 200；产物路径为 `~/huobao-releases/20261108T204444Z`，运行父进程 **887795**，实际监听 `:5679` 的 Node **887835**。完整发布输出见 `release-output.txt`。
- 业务写入只经生产 API；SQLite 以 readonly 模式读取，实际生产库为主仓库 `data/huobao.sqlite3`，不是旧文档中的 backend/data 路径。升级前备份为 `~/huobao-backup/huobao.sqlite3.pre-issue87-release-20261108T191425Z`。
- 发布前重新查询活跃任务，仅 **1003 / 1004 / 1203 / 1264** 四个等待人工审批的 asset_pipeline；没有中断其他生成。见 `release-safety.json`。

## 2. 三阶段真实执行、失败及计量

下表来自发布后只读生产查询；调用累计不是供应商纯计算时间，工作累计不是音频时长。并发视觉子调用会使调用累计大于工作累计。

| task | 阶段 / 结果 | 源字数 | 调用数 | 实际调用累计 ms | 工作累计 ms | 公开消息 |
|---|---|---:|---:|---:|---:|---:|
| 1281 | 骨架 failed | 267 | 4 | 9,844 | 9,993 | 51 |
| 1282 | TTS completed，6/6 | 247 | 6 | 28,889 | 29,826 | 12 |
| 1283 | 设计卡 522 写入 pending | 42 | 11 | 97,613 | 65,961 | 143 |
| 1284 | 设计卡 517，在飞重启 failed/interrupted | 42 | 2 | 1,183 | 1,210 | 20 |
| 1285 | 设计卡 518–521，4 项写入 pending | 163 | 42 | 403,636 | 378,543 | 501 |

- **骨架失败不隐瞒**：1281 的四次模型调用都完成，但模型产生空白/重复/顺序不合法的分配，程序验收把整体任务标 failed，并保留现场。随后仅经骨架 dry-run / PUT 删除空白重复分配、保留六段原文字面内容，未重写、未重新调用模型。存活分镜 **517–522**；逐字覆盖 **247/247**，技术测试确认。267 是含节拍标记的工作输入口径；247 是去标记的旁白覆盖/TTS 口径，两者不能混为一次统计归零。
- **TTS**：配置 13、音色「纪录片·沉稳男声」、10 步、cfg=2、固定 seed=1720、normalize=true；6 段实际请求、合成与音频路径均留存于 `production-facts.json`。真实请求累计 28.889 秒不是配音媒体时长，也不是外部排队时间。供应商外部等待未知时界面不假装精确队列。
- **在飞重启**：2026-11-08T19:26:35.483Z 真实 PM2 重启打断 1284；首个调用 completed=1179 ms，第二个 interrupted=4 ms，工作 1210 ms。多次后续重启后仍冻结这些值，已有公开工具步骤/调用记录保留；分镜 517 回 blank，不残留 ai_filling。未重试此镜。
- **设计完成项不等于内容通过**：518 D / 519 C / 520 B / 521 C / 522 C 共五张已保存 pending；均未代替人确认。镜 519 保留的组合为 C，但模型理由按 A 描述，生成预算为 0、尾帧描述缺失，界面及确认门禁仍提示问题；没有擅自切 A 或增加计费生成。517 的 blank 是有意中断证据，不能把「5 写入 + 1 中断」写成六镜全部通过。
- **ETA**：实际轮询捕获到历史样本、转为本批样本 1→4、超过预估时 overrun=true、终态 eta=null；开始前预估与历史终态事实分开显示。以实际 stage/config/model/TTS 参数分组，不用音频长度或固定倒计时冒充耗时。
- **TTS 早期计数字段修正**：本轮六次原始 DB request_chars 曾为 0，但完整请求正文已经保存。只读 API 从原公开消息重建为 **279 / 260 / 302 / 274 / 275 / 279** 字符；未改写历史原始计数，也不拿当前配置名/provider 冒充当时未记录的信息。新调用元数据及计数路径有行为回归；没有追加合成只为补验证。

## 3. Cloud 选择、现有资产依据与公开调用

- auto 明确忽略残留 config 10 和 `STALE_TOP_BAR_MODEL`；真实设计调用用 Cloud **config 14 / deepseek-flash**，**19 次 vision_chat** 全部同归任务并使用 config 14。没有捕获到 config 10 请求，没有恢复 local 或更改 vision 标记。
- 显式 pin 10 在生产返回 **400 model_pin_unavailable / reason=suspended**，列出健康候选 14，不再伪称全局没有视觉配置，也没有静默改用另一个计费服务。
- AI-only 写入检查与四语技能统一了真实资产、实际引用版本、语义类型/归属/几何的依赖规则。合法背景、无位置依赖标题/说明卡不被强迫加语义；人工 PUT 保持可编辑。拒绝边界、版本不匹配、缺几何等来自行为自测，未把所有错误分支冒充生产实测。
- 65 次实际调用 = **40 LLM + 19 视觉 + 6 TTS**，13 个工作项、**727 条公开消息**。按调用 limit=3、消息 limit=5 强制翻完：**25 个调用页 / 184 个消息页**，逐条记录长度和 SHA-256，没有重复游标或截断。见 `conversation-pagination.json`。
- 请求保留实际 system/user、注入 Prompt/SKILL、工具定义；响应及工具步骤保留公开正文、参数和结果，失败前收到的公开内容也可回看。图片/二进制占位，凭据在落盘前脱敏；没有新建隐藏思维采集。跨 task 查调用返回 400；默认轻量列表与 with_messages=1 均实测。
- 实际打开任务窗口全文、展开长工具定义并刷新恢复；图 `03-public-conversation.png` / `04-conversation-restored.png` / `06-voice-corrected.png` 已打开检查。采集持久化失败不回滚既有业务效果的异常分支属于自测，不声称生产注入过存储故障。

## 4. 全应用 deeplink 与真实语义修复交互

- 全局代码盘点见 `docs/deeplink-inventory.md`；统一 useDeeplink store，没有第二套 router query 同步。批量弹窗独立 `bsel`，`on` 明确空选，不扩大为整集；锁定步骤清孤立 seg/spdlg。
- 生产复测 **16 个场景**：改写检查壳、资产选择器、配音参数及选择范围、Poster 参考选择、设置新增/删除确认、首页新建壳、填卡范围、配音/合成/视频显式空选、锁定步骤、语义选择器类型/关键词/下钻、审核筛选、参考素材库、问题改绑弹窗。多次 reload 保留合法 pktype/pkq/drill、arfilter、bsel、danchor；资产模式不适用的 drill 被正确清除。
- `deeplink-restoration-latest.json` 保存每场景 URL、截图、浏览器 errors、console 警告/错误及关键请求。**16 场景 errors/console 警告错误均空**，未提交计费生成；业务状态前后 SHA-256 一致。只读 work-estimate/preview 以及骨架 validate_only 请求不算业务保存；不能错误声称只有 GET。
- 发现并修复真实恢复缺陷：AssetPicker 与 AssetReviewPanel 首次发布 watcher 非 immediate；批量范围被父 sel 吞掉；锁定步骤遗留孤立键；问题改绑缺宿主身份。用户 click/keydown 后不再把初始快照用于后来挂载的宿主，防止旧弹窗复活；新路由重新开启恢复窗口。状态机回归 17/17 与真实恢复矩阵均通过。
- **非计费人工 UI fixture**：只对本专用项目镜 519 经 API 临时追加一个明确标记「QA 引用修复测试（非史实标注）」的缺失锚点，用于真实显示逐层问题、打开语义弹窗、改绑入口及其刷新恢复。第一次 fixture 把 anchor 误放为顶层字段，未形成问题组；按实际 schema 改为嵌套 anchor 后完成验收，此失败不冒称产品缺陷。已通过 API **完整还原原设计卡**，`semantic-repair-fixture.json` 保存原稿、两次 fixture 响应、审计及还原结果。该人工 fixture 不是 AI 生成成功证据，没有改动真实用户项目或资产语义。
- 真实点击「打开该资产语义」→ prop 169 现有语义弹窗；关闭回到同一镜，再点击「改绑引用」打开选择器，取消后只摘子层参数、保留 phase=cards / shot=519。没有点击自动标注、确定改绑或保存资产。图 `08-semantic-repair-navigation.png` / `09-manual-rebind.png` 已打开检查。
- 图像布局在 **1280 / 1440 / 1920** 下实测卡宽 180px、图像 contain 且加载成功；实际主题按钮切换并等待 data-theme=dark 后检查暗色。见 `viewport-proof.json`、`design-1280.png` / `design-1440.png` / `design-1920.png` / `design-dark-verified.png`。早期 `design-dark.png` 实为 light，不作为暗色证据。`07-design-reference.png` 的实际长城原图亦已打开核对。
- 这是代表性运行矩阵 + 全量源码清单，不宣称生产逐一触发所有受门禁保护的制作/导出组合或未授权计费分支。

## 5. 回归、文档、升级与边界

- 后端完整：**594 / 584 pass / 10 fail**；清洁基线 **556 / 546 pass / 10 fail**，失败名字集合完全相同。
- 前端最终完整：**68 / 50 pass / 18 fail**；基线 **67 / 49 pass / 18 fail**，失败名字集合完全相同。新增一项用户操作优先/路由恢复状态机行为回归通过，没有删除历史测试。
- 完整失败名单与 added/removed 差异在 `regression-results.json`。后端 typecheck、聚焦 38/38、捕获 10/10、最终挂载/状态机 17/17、Nuxt generate 均通过。不是全套测试全绿；历史失败不扩删、不以删测试冒充修复。
- 新增从属观测表按既有启动幂等升级；不改供应商凭据、vision 标记或外部配置。公开对话按需分页，旧任务不捏造原来没记录的历史正文。
- director 权威技能、API 目录、三份历史/反模式/固定案例引用已更新。文档 GPT `openai-codex/gpt-6.1-sol` 与 Anthropic `claude-fable-5:max` 两家闭合上下文评审原文及采纳说明位于 `docs/skills/huobao-director/reviews/`；Issue one-shot review 未重复。
- 保留并行 **#84** 分支 `1eb48cb` 的文档与评审，地图新 API 仍未发布、保持 [S]，没有合并其实现或挪用生成预算。managed skill 为显式同步快照，正文、六份 references、五份 reviews 逐文件校验；fresh-process `omp read skill://...` 验证发现及嵌套引用，无需额外模型生成。
- **#88 保持开放**：其他 LLM 调用的全局补齐是独立已评审后续事项。全局 AGENTS 规范不冒充全局迁移完成。

## 6. 证据索引

- `requests.jsonl`：生产准备、生成、预估、查询与授权台账；不相关活跃任务参数已改为明确注明的维护安全白名单投影。
- `production-facts.json`：最终只读 task/work/call/role/分镜/音频路径及零图像视频生成记录。
- `conversation-pagination.json`：65/727 全量游标与消息长度/hash。
- `backend-log.txt`：本专用 episode 17 的后端日志与失败片段。
- `deeplink-restoration-latest.json`、`restore-latest-*`：最终生产恢复矩阵；旧 ready/final/初次加载失败证据保留，不冒充最终通过记录。
- `semantic-repair-fixture.json`：非计费临时测试数据的创建、真实交互和完整还原。
- `regression-results.json`、`release-output.txt`、`release-safety.json`、`viewport-proof.json`：回归差异、发布、安全与视觉证据。
