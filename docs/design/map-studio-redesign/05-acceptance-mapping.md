# 05 v2 约束覆盖核对表与验收映射

> 本轮为 Astra 实施前设计修订 r2（R6–R12），不是新增 Fabel 评审。事实以 `astra-calls/facts.md` §7–8 覆盖更早冲突结论。
>
> 本轮核实的 origin/master 为 `cdb2a8540445eb8bc33d3b6e8e4c29346dfdac94`，已含 #125；本 #126 分支基于 `2d9655b1`，尚未集成。
>
> 01–05 与 README 已按同一契约应用 Astra 修订。组织者逐项核对 M1–M16 的文档落点；全部实施、测试及生产验收尚未执行。“要求已写入”只说明设计修订，不说明功能通过。

## 0. 契约收敛与事实校正（先读）

### 0.1 单版本运行与异步交付

| 动作 | 唯一契约 |
|---|---|
| 检索/底图 | `/run {mode:'guided',stop_at:'base',expected_revision}`；base成功即停。 |
| 渲染 | `/run {mode:'guided',stop_at:'drawing',expected_revision}`；drawing成功即停complete/awaiting_review。 |
| 正常交付 | `/advance {expected_revision}`异步启动complete；pip→构建→交付→completed。启动200不是交付成功，轮询匹配delivery记录与冻结结果，再核实workflow终态。 |
| 补交付 | `/deliver`无CAS、不重渲pip、不负责workflow状态收尾；有宿主、complete、非running才可调用。 |
| auto | 仅AI活动抽屉明确启动，警告可能越过核对连续至交付。 |

现有端点只接受auto/manual（`routes.ts:84-89`）；complete与deliver事实见`run.ts:264-275`、`delivery.ts:69-86`、`routes.ts:141-148`。guided双终点是G1，不建capabilities/run_stop_at发现协议、不串发manual、不保留永久降级流程。

### 0.2 R-A：默认确认保证

| 原要求 | 已核实事实 | 实际保证 | 不保证范围 |
|---|---|---|---|
| 人核对后才渲染 | 服务端几何未确认是软提示，auto可连续推进（`accuracy.ts:88-95`；`store.ts:575-595`；`run.ts:291-300`） | 默认guided止base；既有要素确认经保存持久化，仍须人显式渲染；零待核对也不自动启动 | 不承诺auto或其他合法API被服务端几何闸门拦截 |

不建reviewedInputKey或整体复核正式门槛。确认复用去proposed及现有状态（`run.ts:500-511`）；改名不是几何确认。V5为“设计闭合（主agent裁定）”；G5为“已裁定：保证范围=默认UI/guided；服务端仍不强制”，行为未验。

待核对统一geometryUnverified，含dataset_missing；草稿proposed===true若另显示，只称“AI候选数 / AI candidate count”。

### 0.3 R-B：唯一草稿与保存

地点行、全部地点、顶点弹窗共享唯一specDraft；有效编辑即时SVG预览，关闭零提交。“完成编辑 / Finish editing”仅结束局部事务。

唯一“保存几何 / Save geometry”一次expected_revision CAS提交整份spec+layer_options；几何未变用服务端原样spec。成功基线为规范化spec/options/revision；弹窗显示“已加入待保存草稿 / Added to unsaved draft”。

超时先GET，revision前进且整份内容匹配才认保存；不匹配进5d冲突副本，revision未前进也不能盲重发未知请求。有layer_doc的旧options分支会重渲交付（`run.ts:444-449,608-639`），必须拆开。专用PUT layer-doc如保留副作用，按钮明确“保存图层并重渲交付 / Save layers, render and deliver”。

### 0.4 R-C与坐标深链

核对阶段③约55%、②约22%；成图复核②约52%、③条带。普通布局必须完整可用，专注模式只是增强。TAB仅画当前类别；局部事务完成/取消/留下均不提交。

msggeorev唯一含义为目标要素**已保存几何坐标canonical hash**，不是task revision。hash变即退要素级，即使行号仍合法；普通状态变化而坐标未变不失效；有坐标草稿不生成行深链。不新增稳定vertex ID。依据现有数组结构`services/layer-doc.ts:91,96,101`，规则见03 §5.3/§11.2/§12.5。

### 0.5 #125、快照与只读宿主字段

| 项目 | 最终契约/事实 |
|---|---|
| 集成状态 | master cdb2a854已含#125，本分支2d9655b1未集成；先集成，逐真实交集文件串行保留契约。 |
| 人工所有权 | manual=description/keywords，name_manual=名称；独立source=cv/vlm/manual（`asset-semantics.ts:42-62,141-146,394-474`）。可标“描述/关键词已人工维护 / Description/keywords manually maintained”，不推断从零作者。 |
| 描述生产 | `map-semantic-annotations.ts:67-97`精确feature_id，basis+coordinate_basis说明+excerpt+最多3个source标题，≤500字；keywords仅category，不调模型。 |
| 现存缺口 | `map-studio-host.ts:65-69`先存原d.semantics，`:78-85`才生成/保护人工字段写props；#125不是图片快照能力。 |
| 唯一快照方案 | 模块自存、复用history形状，在task state保存durable pinned载荷/索引，不建新payload表；snapshot_id=task_id+published_revision+artifact_kind，复用单调任务revision，不建三套输入revision。只读`GET /map-studio/tasks/:id/snapshots/:snapshot_id`；文件先安全持久保留，载荷/pin/引用同一次state CAS发布，清引用同CAS保留旧pin；history30只作滚动审计。 |
| 初始描述 | drawing发布通过平台/契约注入共享纯formatter，对冻结features/sources生成初始语义；模块不import宿主service。 |
| 最终交付 | 宿主事务先得最终manual/name_manual保护语义，再写版本params；最小返回frozen_semantics+sources/关联版本。模块发布同image sha、新published_revision的delivery快照，不改drawing快照。 |
| 重试 | 既有幂等键返回同一最终冻结语义；宿主成功模块失败可补记，不从当前props重算旧交付。 |
| 宿主只读 | describe target新增description/reference_images，仅经detail.host.target.description/reference_images；不并存host_info，不拿notes替代。brief.reference_image是配准图。缺时显示未提供，不加写权限。 |
| 默认样式 | atlas-tint→archival已由styles/families.json精确读取核实（facts-final §8）；复用既有family/theme字段。 |
| 时限 | 原V15 drawing render_draft/final落盘→浏览器显示≤5s；不扩所有pip逐产物硬指标，3秒轮询不证明通过。 |

真实交集包括api.ts、MapPipResults.vue、四语locales、delivery.ts、base.ts、pip/frames.ts、pip/usage.ts、map-studio-host.ts、AGENTS.md、director skill（facts-final §7；完整路径见04 §6.3）。“文件不相交”承诺删除。G4阻断实际集成和同图验收，不是字段未知。

## 1. V1–V34 覆盖核对表

以下34条均有设计落点与待提交证据；“已写入”不代表实现。所有行为验收未执行，不把已知事实写作待核实。

最终验收遵守现行 AGENTS §9，使用生产专用新建测试项目／专用样本，不重渲真实历史任务。隔离 fixture 的单元／行为自测独立记录，不替代最终生产验收；历史条件无法经合法 API 复刻或生产 apply 未获授权时，对应门禁保持阻断、未执行。

| 条款 | 设计落点 | 修订结论与剩余门禁 | 证据 |
|---|---|---|---|
| V1 | 02 §1–2、§5、§8 | 状态组合/唯一动作已写入；G1执行待验。 | E01 |
| V2 | 02 §1.3、§7；05 §0.1 | guided双终点同版切换；G1阻断，无永久降级。 | E01 |
| V3 | 02 §2–3；03 §1.1 | 唯一动作、失败恢复、异步交付已写入；G1/G3待验。 | E01、E03、E09 |
| V4 | 02 §4–6；03 §5、§10 | R-B已写入，完成≠保存≠确认；G6分支整改待验。 | E02 |
| V5 | 02 §3.1、§7；05 §0.2 | 设计闭合（主agent裁定）；G5行为未验，非服务端闸门。 | E01、E03 |
| V6 | 04 §1.1、§3–4 | atlas-tint/archival、无纹理、既有缓存强化已写入；未验。 | E04、E13–E14 |
| V7 | 04 §1.2 | 显式重做新默认、不消费旧texture；未验。 | E04 |
| V8 | 04 §1.3、§5 | 历史图/人工文档不变；G2保护与读取阻断。 | E04、E06 |
| V9 | 04 §2 | 候选、同CAS备份、有效幂等、回滚再apply已写入；G8阻断。 | E05 |
| V10 | 04 §2.5 | 迁移逻辑/注入旧状态仅隔离fixture自测；最终生产兼容使用生产专用新建测试项目、合法API创建任务/依法复刻的专用样本，不伪造生产DB/API状态、不重渲真实历史。无法合法复刻或未获生产apply授权时对应门禁阻断、未执行；隔离通过不算生产批准，生产apply独立晚于前置样本通过。 | E05 |
| V11 | 03 §5、§10–11 | 地点行/弹窗/顶点共享草稿、一次页面保存；G6未验。 | E02 |
| V12 | 03 §2 | 当前类硬显隐、局部事务仲裁已写入；未验。 | E09 |
| V13 | 02 §8.2；04 §5 | 本轮draft/final→上一版→空态；G2身份/发布阻断。 | E06 |
| V14 | 04 §5 | 所选快照读冻结文档/语义，不拼当前spec；G2/G4阻断。 | E06、E08 |
| V15 | 01 §6.5；02 §8.2 | drawing阶段render_draft/final_image落盘至浏览器实际可见≤5s，包含detail发布/轮询/加载；三时间戳实测，不从3秒轮询推定，不扩pip逐项指标；G2实测未执行。 | E07 |
| V16 | 04 §5–6 | #125真实formatter初始描述、最终人工保护交付快照已设计；G2/G4阻断。 | E08 |
| V17 | 03 §3、§11.1 | 三级换算、独立oracle、误差界已写入；未验。 | E10 |
| V18 | 03 §3、§9、§11.1 | 指针命中分流、完整设备路径与取消零写；未验。 | E10 |
| V19 | 02 §6；03 §10.2 | expected_revision整页CAS、冲突保护、未知核实；G6未验。 | E02 |
| V20 | 02 §4–5；03 §7.3 | SVG即时、保存不暗渲染；旧分支必须拆开，未验。 | E02 |
| V21 | 03 §4.2、§11；02 §6 | 下限反馈、冲突不覆盖、刷新一致；未验。 | E02、E11 |
| V22 | 03 §7.2 | 既有14步算法，0不证明任意非零无解；未验。 | E12 |
| V23 | 03 §7.1 | 一位小数、同舍入超限与精确tooltip；未验。 | E12 |
| V24 | 03 §7、§10.2.1 | 首次持久化事实已核实，消费/复算/刷新待验。 | E12 |
| V25 | 04 §3.1–3.2 | 实际输入/内容指纹/无损canonical，不改河流语义；G8待验。 | E13 |
| V26 | 04 §3.3–3.5 | 原子发布、完整验证、单飞、失败语义；G8待验。 | E14 |
| V27 | 04 §3.5 | 完整key+manifest+sha证据，不以耗时判命中；未验。 | E13–E14 |
| V28 | 04 §4、§6、§8 | 前端、模块API、缓存、迁移、技能均在范围；未验。 | E04、E15 |
| V29 | 04 §6.2 | 唯一detail.host.target只读投影，不加宿主写权限；G4阻断。 | E08、E15 |
| V30 | 04 §5.5、§6.3 | master已合、本分支未集成；真实文件相交，先集成逐文件保留契约；G4阻断。 | E08、E15 |
| V31 | 03 §11；04 §7–8 | 关键行为与精确基线要求已写入；全部未执行。 | E10、E16 |
| V32 | 03 §5.3、§11.2、§12.5 | 已保存坐标hash行链、失配退要素、恢复零写；G9未验。 | E17 |
| V33 | 02 §2.4、§10；01 §8 | 新多轮失败run完整回看；G7未验，缺失提示不替代通过。 | E18 |
| V34 | 02 §7；04 §1–2、§7 | 停靠和历史兼容分别取证；G1/G3/G8待验。 | E01、E03、E05 |

跨文档按同一契约收敛；表中落点是设计文档索引，不是实现验收。本次纯设计不执行任何 API。

## 2. 实施期的证据清单（当前状态：全部未执行）

与04 §7同号同范围；该节给完整断言，本表列证据载体。没有通过数量或伪造结果。

每份证据区分实现期隔离自测、最终生产专用样本验收与生产 apply。最终验收遵守现行 AGENTS §9，使用生产专用新建测试项目／专用样本；任务通过合法 API 创建，历史条件仅依法复刻，不重渲真实历史任务。旧状态注入仅限隔离 fixture，不伪造生产 DB/API 状态。无法合法复刻或未取得生产 apply 授权时，对应门禁阻断、未执行，不用隔离通过替代生产批准。

| 证据号 | 对应条款 | 必须提交的证据 |
|---|---|---|
| E01 | V1–V3、V5、V34 | 状态/动作实跑；guided两个边界、style/pending、失败修复、取消/原边界续跑；默认确认与显式渲染、auto警告及到交付；无manual串发。 |
| E02 | V4、V11、V19–V21 | 地点行/全部地点/线面顶点独立记录；共享草稿、完成关闭零写；整spec+options一次expected_revision CAS；规范化基线、拒绝/409、未知匹配/冲突、刷新；已有图层保存零暗渲染交付。 |
| E03 | V3、V5、V34 | advance启动、宿主交付、模块delivery登记、workflow完成分时记录；pip副作用、失败、重复版本；deliver无CAS、不重渲pip、不收尾workflow；独立任务空版本结果。 |
| E04 | V6–V8、V28 | 三历史政策样本；atlas-tint/archival既有字段、新无纹理；旧图/人工文档hash；纹理三态；创建/更新/settings兼容校验及主题不伪失效。最终生产样本附专用项目、合法API创建/依法复刻记录，真实历史零重渲。 |
| E05 | V9–V10、V34 | 隔离fixture自测报告：迁移逻辑/注入旧状态、dry-run零写、run竞争、同CAS备份pin/清引用、有效幂等、重复rollback、rollback后新报告再apply、超30条可回滚。最终生产兼容另附专用新建测试项目、合法API创建任务/依法复刻样本及实际证据，不伪造生产DB/API状态、真实历史零重渲。无法合法复刻或未获生产apply授权时，逐项列门禁阻断、未执行；隔离通过不算生产批准。生产apply独立记录授权与执行状态，晚于快照/新合成链/回滚样本通过。 |
| E06 | V8、V13–V14 | draft/final/上一版/空态身份；task+published_revision+artifact_kind定位；task state durable pinned载荷/索引、`GET /map-studio/tasks/:id/snapshots/:snapshot_id`、文件先独立保留、载荷/pin/引用同state CAS；全部清引用生命周期及history30淘汰后可读；delivery新revision同sha、原drawing不变；不建新payload表。 |
| E07 | V15 | drawing阶段render_draft/final_image落盘/detail首次读到对应快照/浏览器实际显示三时间戳及落盘→实际可见≤5s差值；包含detail发布、轮询、加载及终态；不以3秒轮询代证，不扩pip逐产物指标。 |
| E08 | V16、V29–V30 | 真#125 formatter注入生产初始描述；宿主事务先合成最终人工保护语义，再写版本params，回传frozen_semantics、sources及关联version_ids，模块发布delivery新快照；幂等故障恢复同最终语义；改当前spec/研究/props后旧图描述来源不漂；三类ID/异常锚点/缺字段/人工所有权组合；唯一宿主字段投影与配准图区分。 |
| E09 | V3、V12 | 核对③最大/成图②最大普通布局截图及操作；TAB硬显隐/命中，切换三分支零写。 |
| E10 | V17–V18、V31 | 独立fixture oracle、viewport/meet/zoom/pan/指针记录；viewBox≤1e−6px、经纬度≤1e−7°、回投影≤0.5 CSS px；鼠标/触摸/笔/键盘完整路径；取消/无变化/视图零提交。 |
| E11 | V21 | 最少点拒绝反馈与焦点；双客户端不覆盖；保存刷新一致。 |
| E12 | V22–V24 | 算法阈值/舍入、0的证据边界、全曲线复算/残余；首次保存消费与刷新、已有图层保存无暗交付；geometryUnverified计数含dataset_missing。 |
| E13 | V25、V27 | 完整键逐分量、实际fallback指纹、binary64 oracle、河流顺序/重复/匹配；theme不伪失效；hit的key/manifest/sha/registration。 |
| E14 | V26–V27 | 全部缓存失败类、发布中断/竞争验证、单飞取消与失败清理；bypass独立产物，坏文件不成功复用。 |
| E15 | V28–V30 | #99、brief白名单、只读零写；先集成#125并逐真实交集保留契约；formatter无宿主import；技能/API/四语一致。 |
| E16 | V31 | 同commit/环境精确测试名与错误签名基线、差集、新关键行为结果。 |
| E17 | V32 | 已保存坐标hash行链：hash变退要素、task revision变但hash不变仍定位、有坐标草稿不生成；刷新/新标签/关闭/失效/越界zoom分别零update、markManual、保存、生成、确认、交付。 |
| E18 | V33 | 新多轮失败run切走重开；逐轮runs/rounds/attempts/calls/messages/problems/steps_used身份及数量完整对照；旧缺失另记，新缺失阻断。 |

## 3. G1–G9 状态与阻断条件

与04 §9同结论。没有任何门禁因本轮文字修订而被宣称验收关闭。

| 编号 | 状态 | 剩余阻断 |
|---|---|---|
| G1 | 实施阻断 | guided双终点、合法起点、取消续跑、唯一主动作与同版切换须E01；不建能力发现或永久manual替代。 |
| G2 | 供给与实施阻断 | history形状+state durable pin、同CAS保护、独立文件、GET、任务发布revision身份及初始/最终快照须E06；drawing/final≤5s须E07；最终语义供给与G4共同阻断。 |
| G3 | 事实已核实，行为未验 | complete与deliver边界已知（`run.ts:264-275`；`delivery.ts:69-86`；`routes.ts:141-148`）；advance异步、delivery成功判据、workflow收尾须E03。 |
| G4 | 实际集成与同图验收阻断 | #125已进master但未进本分支；字段/生产者已知。真实交集整合、共享formatter注入、最终语义先params后回传、幂等冻结恢复及宿主只读投影须E08/E15。 |
| G5 | 已裁定，行为未验 | 默认UI/guided保证，服务端仍不强制；既有要素确认+显式渲染，无整体键；E01未执行。 |
| G6 | 事实已核实，整改未验 | 首次options通道已知（`run.ts:440-467,258`；`drawing.ts:87-95`）；旧自动重渲交付拆分、整页CAS/未知核实须E02/E12。 |
| G7 | 观测验收阻断 | E18新失败run完整回看；新记录缺失不能以降级提示通过。 |
| G8 | 缓存/迁移实施阻断 | E13/E14缓存完整键与安全性；E05迁移durable journal、CAS、有效幂等、rollback再apply、超30条保留。生产apply未执行，须晚于前置样本通过。 |
| G9 | 规则已写入，行为阻断 | 已保存坐标hash定位、失配回退、普通状态变化不失效、草稿不产行链；E17全部恢复零写未验。 |

## 4. 与 v2 原文的差异总表

旧事实以facts-final §7/8纠正；主agent裁定不重新列为待批准。

| 原文/旧设计 | 最终修订 | 依据 |
|---|---|---|
| 服务端已有未确认几何闸门 | 默认UI/guided停靠保证；auto可越过至交付；不增整体复核键 | R-A；`accuracy.ts:88-95`、`store.ts:575-595` |
| capabilities发现与永久manual降级 | guided双终点同版实施，未实现=G1 | r11裁定；`routes.ts:84-89` |
| 弹窗独立保存/关闭提交 | 唯一页面草稿、一次整页CAS，关闭零提交 | R-B |
| 普通编辑器小、专注才可用 | 核对③最大，成图②最大 | R-C |
| 准备交付或启动200即成功 | advance异步启动complete；轮询delivery结果；deliver不重渲pip、不收尾workflow | `run.ts:264-275`、`delivery.ts:69-86`、`routes.ts:141-148` |
| 普通options保存无副作用 | 现有layer_doc分支会重渲交付，必须拆开；专用人工图层明确按钮 | `run.ts:444-449,608-639` |
| history或多套revision足以构成历史 | history30只审计；模块自存pinned载荷/索引，task发布revision定位，文件独立保留 | `store.ts:51,364-420`；04 §5 |
| #125未进master/manual未知 | master cdb2a854已含，本分支2d9655b1未集成；manual/name_manual字段所有权已知 | facts-final §7；`asset-semantics.ts:42-62,394-474` |
| source=manual证明人工描述 | source独立；manual维护描述/关键词，name_manual维护名称，不表示从零作者 | `asset-semantics.ts:42-62,141-146` |
| #125已有最终图片快照 | 原d.semantics先params、最终补充后props仍有缺口；须先最终语义后params并回传 | `map-studio-host.ts:65-69,78-85` |
| 描述来源不明或需要模型 | 真实纯formatter精确feature_id、事实与≤3标题组合，keywords仅category，无模型 | `map-semantic-annotations.ts:67-97` |
| 从当前props回补旧交付 | drawing初始冻结、delivery同sha新revision冻结；幂等返回同最终语义，不重算旧图 | r11；04 §5 |
| host_info与notes替代宿主字段 | 唯一detail.host.target.description/reference_images；notes/配准图独立，缺时未提供 | `map-studio-host.ts:100`、`sqlite-schema.ts:389`、`types.ts:58-64`；r11 |
| 两Issue文件不相交 | 已有真实交集，先集成#125再逐文件串行保留契约 | facts-final §7；04 §6.3 |
| 内部默认theme未知 | atlas-tint→archival，复用既有family/theme | `styles/families.json`精确JSON证据，facts-final §8 |
| 当前texture=null证明旧图无纹理 | 同图记录有/无/未记录三态，与再次生成政策分开 | `delivery.ts:59` |
| 新建缓存、任意NFC/排序归并 | 强化既有缓存；有限binary64无损；保留实际河流匹配、顺序及fallback指纹 | `geo/base-render.ts:465-643`、`geo/named-rivers.ts:113-171` |
| 同hash迁移永久跳过、预检running即可 | 有效applied+当前after匹配才幂等；rollback后新报告再apply；整state CAS决胜 | `db.ts:168-186`、`store.ts:334-453` |
| proposed徽标就是待核对 | 待核对统一geometryUnverified含dataset_missing；proposed数只能叫AI候选数 | `accuracy.ts:88-95` |
| suggested=0证明任意非零无解 | 只证明当前有限算法/档位的建议，不能外推 | `render/smooth.ts:227-237` |
| 顶点行绑定任意task revision | 绑定目标已保存坐标canonical hash；hash变退要素，普通状态变化不失效 | r11；`services/layer-doc.ts:91,96,101` |
| 3秒轮询证明≤5s或扩大所有pip指标 | 原drawing/final落盘到浏览器实测≤5s，不扩pip逐产物硬指标 | V15；r11 |
| 失败记录缺失可提示后通过 | 新失败run必须完整回看；旧缺失仅兼容提示 | V33、M16 |

## 5. M1–M16 闭合核对表

16项修订要求逐条落点如下。跨文档按同一契约收敛；表中落点是设计文档索引，不是实现验收。“M闭合／要求已写入”只表示本轮文档要求有落点，功能未执行；剩余阻断须真实实施及E证据关闭。全部测试与生产验收尚未执行。

| M | 修订落点 | 事实/裁定证据 | 剩余阻断 | 状态 |
|---|---|---|---|---|
| M1 | 02 §3.1、§7、§8.1、§10；05 §0.1–0.2；01 §10.4；README“关键设计裁定” | R-A；`run.ts:291-300`、`accuracy.ts:88-95`、`store.ts:575-595` | G1双终点、G5默认确认保证E01 | 要求已写入；行为未验 |
| M2 | 01 §1第5条、§3.3；02 §4、§6；03 §5、§10.2；04 §6.1；05 §0.3 | R-B；`task.vue:963-972`、`run.ts:444-449` | E02整页CAS、关闭零写、规范化基线与未知核实；旧副作用拆分 | 要求已写入；G6整改未验 |
| M3 | 01 §6.1、§6.5；02 §3.3、§8.2；04 §1.3、§5；05 §3 G2/G4 | `types.ts:215-258`、`store.ts:364-420`、`db.ts:68-77`；master `map-studio-host.ts:65-69,78-85` | task state durable pinned载荷/索引、GET、文件先安全保留、载荷/引用同CAS、注入初始formatter、最终语义回传与delivery新快照；E06–E08 | 要求已写入；G2/G4阻断 |
| M4 | 01 §10.2、§14中交付条；02 §1.3、§3.3、§10.2；04 §6.1；05 §0.1、§2 E03 | `run.ts:264-275`、`delivery.ts:15-86`、`routes.ts:141-148` | advance异步接受不算成功、delivery轮询、workflow收尾、补交付边界E03 | 事实已核实；行为未验 |
| M5 | 01 §9–10；02 §1–2、§6–8、§10；04 §6、§8–9；05 §3 G1 | `run.ts:191-199,330-383,586-604`；r11单版双终点 | 全状态唯一动作、style/pending、failed+dirty、取消/原边界恢复E01/E02 | 要求已写入；G1阻断 |
| M6 | 01 §2、§4.2–4.4；03 §1.1；04 §7 E09；05 §0.4 | R-C | 普通布局字段操作与两阶段面积E09 | 裁定已写入；行为未验 |
| M7 | 01 §1第8条、§10.4；02 §3.1、§5、§9.2；03 §2.1、§7、§10.2.1；05 §0.2 | `run.ts:440-467,500-511`、`drawing.ts:87-95`、`accuracy.ts:88-95`、`render/smooth.ts:227-237` | 首次消费/刷新、有图层保存拆分、统一待核对与AI候选计数E12 | 事实已核实；G6整改未验 |
| M8 | 04 §2.3、§2.5、§8–9；05 §3 G8、§2 E05 | `store.ts:334-453`、`db.ts:168-186`；有效迁移状态设计；现行AGENTS §9验收边界 | pin+journal+清引用同CAS、竞争、重复/回滚再apply、超30条；隔离fixture自测不替代生产专用样本验收；无法合法复刻或未获apply授权则阻断、未执行；生产apply晚于快照/新合成链/回滚样本通过 | 要求已写入；G8阻断，生产未执行 |
| M9 | 01 §11；03 §5.3、§11.2、§12.5；04 §7 E17、§9 G9；05 §0.4 | `services/layer-doc.ts:91,96,101`；r11已保存坐标hash裁定 | hash变但行合法回退、普通task变化不失效、有草稿不生成、全恢复零写E17 | 规则已写入；G9行为阻断 |
| M10 | 03 §3、§5.3、§9、§11.1；04 §7 E10；05 §2 E10 | M10输入路径要求；03独立fixture oracle | 鼠标/触摸/笔/键盘新建追加、插点消歧、焦点、取消/无变化零提交 | 要求已写入；行为未验 |
| M11 | 01 §6.1、§7.2–7.3；03 §8、§12.3；04 §5–6；05 §0.5、§3 G4 | `asset-semantics.ts:42-62,394-474`、`map-semantic-annotations.ts:67-97`、`map-studio-host.ts:65-69,78-85,100`、`sqlite-schema.ts:389` | 真#125集成、platform/contract注入共享formatter、初始/最终冻结、最终人工保护语义先于版本params、frozen_semantics/sources/关联version_ids回传、唯一detail.host.target投影、来源不漂E08/E15 | 字段/生产者已核实；G4实施阻断 |
| M12 | 04 §3.1–3.2、§3.5；05 §2 E13 | `geo/base-render.ts:465-513,527-539`、`geo/named-rivers.ts:113-171`、`geo/relief-render.ts:341-380,452-461` | 实际像素输入、fallback内容指纹、无损canonical与河流语义E13 | 要求已写入；行为未验 |
| M13 | 04 §3.3–3.5；05 §2 E14 | 现状非原子/无sha/无单飞：`geo/base-render.ts:547-594`；04发布失败契约 | 全失败类、原子提交点、竞争赢家验证、单飞取消/失败清理与独立产物E14 | 要求已写入；行为未验 |
| M14 | 04 §1–2、§5；05 §2 E04/E06 | `delivery.ts:59`、`types.ts:215-258`、`run.ts:140-163` | 安全保留先于重做、纹理三态、旧图与人工文档hash不变 | 要求已写入；G2保护阻断 |
| M15 | 04 §1.1、§4.1、§6.2；05 §0.5、§4 | `styles/index.ts:137-143`、`drawing.ts:113-117`、`run.ts:476-478,526-533`、`routes.ts:192-223`；families.json精确JSON证据 | 创建/更新/settings、有效输入hash/失效链、atlas-tint/archival既有字段消费E04/E15 | 默认token已核实；行为未验 |
| M16 | 01 §6.5、§8、§14；02 §10.2；04 §7–9；05 §1–5；README“实施前置与阻断条件” | facts-final §7/8最终纠错；r11及r12文本对齐要求；E01–E18与G1–G9 | 全部尚未执行证据、#125实际集成、新失败run完整回看；drawing阶段render_draft/final_image落盘至浏览器实际可见≤5s三时间戳实测；生产专用样本验收与独立apply授权门禁 | 修订要求已写入；不宣称门禁关闭 |

**M7最终计数口径：** 待核对徽标必须与geometryUnverified一致，含dataset_missing；若单独保留草稿proposed===true统计，仅称“AI候选数 / AI candidate count”，不能继续用它冒充待核对。只改名不转人工、不清proposed；实际坐标改变才按既有规则处理（`run.ts:500-511`）。

**最终状态：** 34条覆盖映射与16项修订要求已列明；M闭合只表示本轮文档要求有落点，不是34条或16项功能通过的计数。没有执行代码、API、测试、真实生产验收或生产apply，没有新增人类批准。最终验收须使用生产专用新建测试项目／合法API创建或依法复刻的专用样本；隔离fixture自测不能代替生产批准。无法合法复刻历史条件或尚未取得生产apply授权时，对应门禁仍阻断、未执行。G1–G9按各自剩余阻断保留。

