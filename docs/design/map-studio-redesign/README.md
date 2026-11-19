# 地图工作室重设计 · 阶段 0 设计文档（Issue #126）

Issue #126 要求先做专项设计再实施：地图工作室整体按人的工作流与注意力重排，点线面编辑器重做，
主题简化，底图模板缓存，图层描述可查看。本目录是阶段 0 的全部设计成果，**不含实现代码**。

- 设计主体：Astra（`gpt-6-astra`）；初稿 7 次调用，r2 修订另 7 次（R6–R12），共 14 次模型调用。
  组织者只核实源码事实、组织 prompt、机械应用 Astra 文本并核对闭合表；留痕见
  [`astra-calls/calls.md`](astra-calls/calls.md)。
- 设计分支基线：`2d9655b112ce4a367061e6cfb4213c5783bc595c`（2026-11-19）；
  后续 #125 集成事实单独钉住 master `cdb2a854`，不代表该变更已在本分支。
- 权威输入：Issue #126 正文、v2（issuecomment-7006443553）、Fabel 初评（issuecomment-7006330863）、
  设计评审 M1–M16（issuecomment-7008848189）及主 agent 三项裁定。r2 核实证据见
  [`astra-calls/facts.md`](astra-calls/facts.md) §6–8（带 `file:line`）；逐条闭合表见 05 §5。

## 文档地图

| 文件 | 内容 | 对应 Issue 阶段 |
|---|---|---|
| [`01-information-architecture.md`](01-information-architecture.md) | 设计原则、注意力预算、四块主界面 + 顶栏 + 停靠条、5 个状态线框、区块规格表、成图快照身份、图层描述查看器、AI 活动抽屉、唯一主动作矩阵、有界运行契约、深链键、组件分解与文案 | 阶段 1、4 |
| [`02-workflow-state-table.md`](02-workflow-state-table.md) | 服务端阶段 × 运行状态 × manual/guided/auto 主表、三个停靠点、完成编辑 vs 确认几何、编辑失效矩阵、保存/CAS、一键检索时序与 V5 订正、刷新与并发 | 阶段 1（工作流闭环） |
| [`03-geo-editor.md`](03-geo-editor.md) | 编辑器容器、三类 TAB（硬显隐）、zoom/pan 与三级坐标换算、删点、点列表弹窗、地点完整编辑、条目完成编辑、平滑偏离警告与建议强度、数据集徽标、键盘与无障碍、组件分解、行为测试 | 阶段 2 |
| [`04-history-cache-integration.md`](04-history-cache-integration.md) | 历史兼容三政策、纸纹残留迁移、底图模板缓存完整键与单飞、主题简化、图层描述契约、范围与写权限、V1–V34 验收映射、实施顺序与风险 | 阶段 3、4 |
| [`05-acceptance-mapping.md`](05-acceptance-mapping.md) | 契约收敛与事实校正、V1–V34 逐条覆盖核对（设计落点 + Astra 出处）、实施期证据清单、设计层遗留 G1–G9、与 v2 原文的差异总表 | 全阶段 |
| [`astra-calls/`](astra-calls/) | 每轮 prompt、原始响应、共享事实底座 `facts.md`、调用日志 | — |

## 用户工作流的落点

| 用户动作 | 设计回答 | 详见 |
|---|---|---|
| 看到资产信息、参考图、描述 | ①显示资产只读摘要与既有 brief；宿主资产描述、参考图当前未透出，新增只读投影前显示“宿主信息未提供 / Host information not provided”，不拿 brief.notes 冒充 | 01 §7.2；04 §6.2 |
| 点一下「检索/调研」，AI 把点线面填上 | 新增有界请求 `mode:'guided', stop_at:'base'`，research 后自动接 base，base 完成即停；不自动进入 drawing | 01 §10；02 §1.3、§7 |
| 看到都被填上、底图已就绪 | 显示“底图已就绪 · 待核对几何 / Base map ready · Review geometry”；默认 UI/guided 停靠等待人工核对，确认与渲染是两个动作，未经显式渲染不进入 drawing；服务端不强制几何确认 | 01 §10.4；02 §2.2、§3 |
| 核对点线面（改、确认） | ③为默认最大区域，TAB 硬显隐；地点行、全部地点与顶点弹窗只改页面草稿，页面一次 CAS 保存后再确认几何 | 01 §2、§3.3；03 §2、§5 |
| 渲染出图 | “确认几何 / Confirm geometry”写既有要素确认状态，不启动阶段；另点“渲染成图 / Render map”执行 guided/drawing，drawing 完成即停；此为默认 UI/guided 保证，服务端不强制，auto 会连续推进到交付 | 01 §9.3、§10；02 §3.1、§3.2 |
| 不知道有没有生成 / 想看图层描述 | ②显示所选图片及身份；成图复核阶段②最大；图层、描述与图片来自同一冻结快照，不用当前语义补历史图 | 01 §6、§7 |
| 过程日志不该铺满界面 | AI 活动抽屉承载历史运行、逐轮调用、失败现场、模型设置及带启动前警告的 auto 命令 | 01 §8 |

服务端事实依据：几何确认不是运行闸门（`accuracy.ts:88-95`、`store.ts:575-595`）；auto 连续推进（`run.ts:291-300`），complete 执行交付（`run.ts:264-275`）。宿主字段缺口见 `map-studio-host.ts:100`、`sqlite-schema.ts:389`。

## 关键设计裁定（详见对应文档）

**确认与渲染（V5/M1）——保证范围：**

| 原要求 | 已核实事实 | 实际保证 | 不保证范围 |
|---|---|---|---|
| 人核对确认后才渲染；一键调研在 base 就绪后停靠。 | 服务端没有“未确认几何禁止 drawing”的闸门；确认复用 `PUT map_spec` 去掉 `proposed`；auto 会连续推进到 complete 并交付（`accuracy.ts:88-95`、`store.ts:575-595`、`run.ts:500-511,291-300,264-275`）。 | 默认 UI + guided：检索止于 base；有待确认要素时先确认，权威 PUT 成功后才允许显式渲染；全已 confirmed 时仍须用户点击“渲染成图”；guided/drawing 完成即停。刷新按服务端要素状态重算，不设整体复核键。 | 直接 API、其他客户端及显式 auto 不受默认 UI 停靠保证约束。auto 仅在 AI 活动抽屉明确启动，启动前警告会越过人工核对直至交付；本 Issue 不改服务端几何闸门。 |

- **有界运行**：G1 必须实现 `mode:'guided', stop_at:'base'|'drawing'` 两个终点及原运行边界读取。UI 与服务端同批切换，不新增能力发现字段，不提供永久分步兼容第二流程；未就绪即阻断实施／验收，不降级宣称完成。既有 manual 单阶段、auto 连续推进语义不变。当前端点仅接受 manual/auto（`routes.ts:84-89`），guided 为新增设计。
- **请求字段**：路由 JSON 使用 `expected_revision`；`expectedRevision` 仅为内部 TypeScript 参数名。run、advance 与草稿 PUT 使用 revision；`POST /deliver` 没有 CAS 参数，不虚构。取消、回退等沿用既有命令契约。
- **唯一主动作优先级**：running → 写结果未知先核实 → CAS 冲突 → 未保存草稿（包括 failed 状态）→ 真实 blocking／失败 → 正常阶段。可修复失败先定位，修复保存后按返回的新 stage 重算；未知 kind 明示，不猜恢复策略。续跑保留真实 mode/stop_at；取消确认后不启动下一阶段。
- **交付**：用户点“交付成图 / Deliver map”→ `POST /tasks/:id/advance` 异步执行 complete：渲染 pip 细节 → 构建并登记交付 → `completed`。启动响应为 detail，不承诺立即返回 version_ids；随后轮询核对 deliveries、version_ids 与实际交付行。`POST /deliver` 仅失败重试／补交付，不渲染 pip、不改变任务 status。宿主重复交付返回相同版本；standalone 无宿主版本时显示“流程完成，可下载 / Workflow complete · Download available”（`run.ts:264-275`、`routes.ts:141-148`、`delivery.ts:69-86`、`map-studio-host.ts:32-46`）。
- **成图身份／快照**：本轮 final > 本轮 AI 预览 > 可验证上一版 > 空态。**选定复用 history snapshot 载荷形状，在 task state 保存 durable pinned 载荷／索引，不新建 payload 表或平行版本系统**。`snapshot_id=task_id+published_revision+artifact_kind`，复用单调任务 revision；同一 run 多次 draft 分别发布、分别取得 revision，不增三套输入 revision。保存图片 sha/path/run/发布 revision、输入内容 hash、layer_doc/options、冻结 semantics、features/sources 与 texture 原对象。文件先安全持久保留，再在同一次 state CAS 中发布产物引用、冻结载荷与 pin；清除、回退、迁移时同 CAS 保留旧载荷／pin。history30 仅为滚动审计，不承担永久保存。detail 提供引用，新增只读 `GET /map-studio/tasks/:id/snapshots/:snapshot_id` 返回同任务授权范围内冻结载荷与安全 URL。方案已定，供给尚未实现，G2 仍阻断（`types.ts:242-258`、`store.ts:51,364-372,400-420`、`db.ts:68-77`）。
- **描述同源供给**：#125 已合入 master `cdb2a854`，本 worktree `2d9655b1` 尚未集成。共享纯 `semanticAnnotationsOf` 必须通过 platform/contract 注入，模块不直接 import 宿主 service，也不复制第二份算法。drawing draft/final 对同次冻结 features/sources 生成初始描述并随图片冻结；delivery 宿主事务先合成并保留 `manual/name_manual` 所有权的最终语义，再写版本 params，当前 props 使用同一最终值；回传 `frozen_semantics`、`sources` 与明确关联的 `version_ids`。模块以新任务发布 revision 保存同 image sha 的 delivery 快照，原 drawing 快照不变。幂等重试取回同次已登记的最终冻结语义，不从当前 props 回补。当前 master 先存 `d.semantics`、后更新 props，尚未解决冻结缺口（`services/map-studio-host.ts:65-69,78-85`）；本设计需要 #125 集成及最小回传契约，不跨模块直读。
- **编辑器**：页面唯一 `specDraft` 与 `layerOptionsDraft`；地点行及弹窗合法输入立即进入页面草稿，关闭不提交。“完成编辑”只结束局部形状；“保存几何 / Save geometry”一次 CAS 提交整份 spec + layer_options，成功以服务端规范化返回和 revision 建基线。保存 ≠ 渲染 ≠ 交付。
- **平滑保存切分**：已有 layer_doc 且仅改选项时，旧分支会重渲并自动交付（`run.ts:444-449,608-639`）。这违反默认新契约，**本 Issue 必须拆分**：几何区选项保存只持久化、标图过期，不渲染、不交付；显式渲染后再显式交付。这是新增设计，不是现有事实。人工图层专用 `PUT /layer-doc` 可保留既有副作用，按钮明确标“保存图层并重渲交付 / Save layers, re-render and deliver”，不能套用到“保存几何”。
- **宿主只读信息**：仅扩展 `contract.describe` 的 target，新增 `description/reference_images`，前端统一读取 `detail.host.target.description/reference_images`；不用 brief.notes 冒充，不新增第二套宿主信息结构或写权限。
- **主题与底图**：底图签名缓存已存在，本轮修正完整键、原子写、sha 校验及进程内单飞，不新建缓存系统。主题不改变底图像素。河流键保留原输入顺序，仅合并已证明等价的表示，指纹包含实际匹配分支／文件，不为缓存改变匹配语义（`geo/base-render.ts:465-643`、`geo/named-rivers.ts:113-171`、`geo/relief-render.ts:30-38`）。
- **历史兼容三政策分开**：新任务默认 atlas-tint、无纸纹；旧任务再次生成采用默认样式且不使用旧 texture；历史成图及人工 layer_doc 原样保留，只有显式重做才采用新政策。历史纸纹按该版本显示“有／无／未记录”，不能用当前 task 的 null 反推（`delivery.ts:59`、`map-studio-host.ts:37-46`）。

## v2 约束覆盖

按工作分组列出 V 编号，不制造互斥计数；设计闭合不等于实现完成或验收通过。逐条设计落点及实施证据归入 05。

| 分组 | V 编号 | 当前结论 |
|---|---|---|
| 工作流与停靠 | V1–V5、V34 的工作流部分 | V5 设计闭合（主 agent 裁定）；G1 两个终点及完整状态恢复仍待实现与实测 |
| 历史兼容 | V6–V10、V34 的历史部分 | 三政策明确；快照保留、迁移、并发与回滚验收仍受 G2/G8 阻断 |
| 编辑器与保存 | V11–V12、V17–V24 | 唯一草稿、整页 CAS、硬显隐及显式平滑规则明确；保存分支切分与行为验收未完成 |
| 图片、描述与显示 | V13–V16 | 模块自存方案及描述回传契约已定；G2/G4 供给和原 V15 drawing/final ≤5s 实测未完成 |
| 缓存 | V25–V27 | 修正既有缓存；完整键、发布安全性及命中证据待实施验证 |
| 范围与集成 | V28–V30 | 不增宿主写权限；#125 已合入 master、尚未集成本 worktree，实际文件有交集 |
| 回归、深链与观测 | V31–V33 | 行为测试、几何 hash 深链及真实失败 run 完整回看待实施验收 |

V5 保证范围为默认 UI/guided，服务端仍不强制；没有尚待批准的 V5 政策问题。

保留并明确以下订正：

1. V5“服务端闸门已有”订正为默认 UI/guided 停靠保证（`accuracy.ts:88-95`、`store.ts:575-595`）。
2. V25/V27 的 bbox 键采用实际渲染数值的无损序列化，不量化或截断；河名及其他集合不凭猜测规范化（`geo/relief-render.ts:341-380,452-461`、`geo/named-rivers.ts:113-171`）。
3. V22 算法返回 0 不直接证明 0.05 也超限；保留向下取档与小值归零事实（`render/smooth.ts:227-237`）。
4. V16 的缺字段展示只处理真实历史缺失，不能替代新产物同源描述的 G2/G4 验收；#125 人工所有权不等于图片快照（master `asset-semantics.ts:394-474`、`services/map-studio-host.ts:65-85`）。
5. V30“文件不相交”已被最新集成清单推翻；先集成 #125，再逐文件串行整合和契约测试。
6. V15 保留原 drawing/final 落盘到实际显示 ≤5s 实测，不新增所有 pip 产物逐项 ≤5s 指标；每 3s 轮询不是通过证据。

## 实施前置与阻断条件

| 编号 | 名称 | 阻断条件 | 当前状态 | 判定依据 |
|---|---|---|---|---|
| G1 | 两个有界终点 | guided/base、guided/drawing 任一未实现，或无法读取和恢复原 mode/stop_at；不以分步兼容代替 | 阻断，UI 与服务端同批实施验收 | 当前端点仅 manual/auto（`routes.ts:84-89`、`run.ts:291-300`） |
| G2 | 同源快照保存与读取 | 模块最小不可变 payload、同 CAS 发布或清除前保留未实现；窗口淘汰后不可读 | 方案已定，供给与验收仍阻断 | history 仅 30 条、交付日志无载荷（`store.ts:51,364-372,400-420`、`db.ts:68-77`） |
| G3 | complete 与交付副作用 | 首次交付误用 deliver；启动响应误当终态；未核对实际交付版本即报成功 | 事实闭合，待实施验收 | complete 渲染 pip 并交付；deliver 不渲染 pip、不改变 status（`run.ts:264-275`、`routes.ts:141-148`、`delivery.ts:69-86`） |
| G4 | #125 与宿主只读映射 | 本分支未集成 #125；drawing 初始描述或交付最终语义未冻结；describe target 字段未供给 | 阻断，待集成、契约实现和实测 | master 已合入但先存原语义再写当前 props（`services/map-studio-host.ts:65-69,78-85`）；manual/name_manual 契约见 `asset-semantics.ts:42-62,141-146,394-474` |
| G5 | V5 保证范围 | 无待裁定政策；必须符合默认 UI/guided 保证，不得宣称服务端闸门 | 已裁定：保证范围 = 默认 UI/guided；服务端仍不强制 | R-A；`accuracy.ts:88-95`、`store.ts:575-595`、`run.ts:500-511` |
| G6 | 平滑与整页保存 | 首次持久化通道事实已闭合；几何区旧自动交付分支未切开，或保存未保持整页 CAS，均不通过 | 事实闭合，新增切分待实施验收 | `run.ts:440-467,608-639`、`drawing.ts:87-95`、`task.vue:963-972` |
| G7 | 历史失败 run 完整回看 | 未用真实失败 run 证明 rounds、attempts、calls/messages、失败原因均完整且归属正确 | 阻断，待读取核实和实测 | 已有 observed 入口不等于历史失败字段完整性证据 |
| G8 | texture 迁移及回滚 | 有效迁移状态、持久快照、回滚后再 apply 或并发 CAS 样本未通过 | 阻断；通过前禁止生产 apply | 无既有迁移工具；互斥只有整份 state CAS + requireIdle（`db.ts:68-77,168-186`、`run.ts:365`） |
| G9 | 顶点深链几何绑定 | msgrow 未绑定 msggeorev 要素几何 hash，或恢复不能证明零写入 | 阻断，待实施和实测 | 顶点为坐标数组、无稳定 ID（`services/layer-doc.ts:91,96,101`） |

#125 集成基线以 facts-latest §7 为准：master 为 `cdb2a8540445eb8bc33d3b6e8e4c29346dfdac94`，本 worktree 仍为 `2d9655b1`，不是“尚未合入 master”。先集成 #125，再对真实交集逐文件串行整合和契约测试：

- `frontend/app/map-studio/api.ts`、`components/MapPipResults.vue`、四语 locales；
- `modules/map-studio/delivery.ts`、`base.ts`、`pip/frames.ts`、`pip/usage.ts`；
- `services/map-studio-host.ts`、`AGENTS.md`、director skill。

保留 #125 的类别／feature_id 精确关联、description/keywords 限制、manual/name_manual 独立所有权及来源契约，不做第二份描述生产实现。共享纯 `semanticAnnotationsOf` 与宿主最终语义回传均是本 Issue 的集成工作，不是 master 已有的图片冻结保证。

G3、G6 的事实闭合与 G5 的政策裁定不能解除其他门禁。设计文本、调用留痕、缺失降级和轮询频率均不是实施验收结果。

## 不做什么

不改分镜侧引用机制；不改服务端几何校验／精确度闸门；不引入新底图数据源；不做主题驱动的底图色板；
不新增来源管理、版本管理或 GC 子系统；不新增宿主写权限，尤其不增加资产名称／描述写权限；
不自动替人确认几何，不自动改变平滑强度，不自动重渲历史成图或人工 layer_doc。

快照读取与宿主信息扩展限于既有模块边界内的保存契约或宿主只读投影，不允许模块直读宿主库。
本阶段只产出设计文本，不写实现代码、不建 Issue。

