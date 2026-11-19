# 02 工作流停靠状态表与行为契约

> 本文件是「服务端阶段 × 工作流状态 × 执行策略」的唯一权威状态表；01 与 03 的动作条、停靠点、保存和失效呈现必须与本文一致。
>
> 已核实事实以 facts §6 为准；本文标为“新增实现契约”的内容不是现有服务端能力。现有 manual/auto 保留；本 Issue 必须实现 guided 及 `stop_at='base'|'drawing'`，前后端统一单版本切换，不新增能力发现协议或永久分步降级流程。
>
> 默认检索止于 base；人确认待确认要素后，仍须显式点击“渲染成图”。drawing 完成后停在 `complete/awaiting_review`；人点击“交付成图”，由 `POST /advance` 执行 complete：pip 细节渲染 → `buildDeliverable` → `deliverCurrent` → `completed`。`POST /deliver` 只用于补交付/重试，不替代此链路。
>
> 本轮仅修订设计文本；未实现代码、未执行测试或验收。文中的行为断言均为实施验收要求，不是通过记录。

## 1. 术语、状态层次与三个模式

### 1.1 状态不得混用

| 层次 | 字段/取值 | 含义 |
|---|---|---|
| 当前阶段 | `state.stage`：`brief / research / base / style / drawing / complete` | 当前执行指针，不是最后完成的阶段 |
| 工作流状态 | `state.status`：`idle / running / awaiting_review / blocked / failed / completed` | 仅这六种状态参与 workflow 分派 |
| 阶段步骤状态 | `steps[].status`：`pending / running / awaiting_review / completed / failed / skipped` | `pending/skipped` 仅属于 step；step 没有 `blocked` |
| 人工停靠点 | UI 派生状态 | 底图与几何核对、待显式渲染、成图待交付；不新增服务端几何闸门 |
| 本地保存状态 | `clean / dirty / saving / result_unknown / conflict` | 与 workflow status 正交；不得据此改写服务端状态 |
| 待核对数 | `geometryUnverified(spec)` 对应口径 | 包含 `dataset_missing`；软提示，不等于受阻 |
| 草稿候选数 | 草稿中 `proposed===true` 的数量 | 只能标“候选数”，不能替代待核对数 |

阶段完成会前移指针：manual 的 research 完成后是 research step completed、`stage=base/status=awaiting_review`；base 完成后是 `stage=style/status=awaiting_review`；drawing 完成后是 `stage=complete/status=awaiting_review`。complete 成功结束才是 `stage=complete/status=completed`（`run.ts:191-199,264-275`）。

§2 使用三个可组合表覆盖完整笛卡尔积：先匹配 workflow status 与本地覆盖条件，再匹配当前阶段，最后应用执行策略。历史 step completed/skipped 仅作证据，不能替代当前 stage/status。恢复页面、查看历史、切换 TAB、选择模式均不能启动执行。

### 1.2 执行策略

| 策略 | 启动方式 | 执行范围与成功终点 | 人工停靠与边界 |
|---|---|---|---|
| `manual` | 人显式启动当前阶段 | 一个阶段；非 complete 完成后指针前移并待复核，complete 成功后 completed | 保留既有语义；默认任务策略，不等于默认主按钮必须逐阶段调用 |
| `guided/base` | 主界面“检索并准备底图 / Research & prepare base”或“准备底图 / Prepare base” | 从 brief/research/base 当前合法起点连续执行，到 base 成功完成即停 | `stage=style/status=awaiting_review`；不执行 style/drawing/complete，不确认几何 |
| `guided/drawing` | 人显式点击“渲染成图 / Render map” | 从 style/drawing 起点执行；style 跳过纸纹出图后进入 drawing；drawing 成功即停 | `stage=complete/status=awaiting_review`；不执行 complete，不交付 |
| `auto` | 仅 AI 活动抽屉内的明确高级启动命令 | 按既有循环连续执行，至 `proceed=false` 或结束；成功流程执行 complete 并交付 | 可能越过人工核对和成图待交付停靠，不是默认主动作 |

现有循环仅支持 manual/auto，manual 每阶段停、auto 连续推进（`run.ts:291-300`；`routes.ts:84-89`）。guided 和两个边界均为本 Issue 必做能力，不以前端串发 manual 请求实现，不用 auto 模拟。

“默认 manual”与“默认一键检索为 guided/base”不矛盾：前者是普通单阶段策略，后者是明确有界命令。主按钮不继承抽屉上次的 auto 选择。

### 1.3 请求、运行边界与真实交付路径

API 字段统一使用 `expected_revision`；`expectedRevision` 仅是 TypeScript 内部名称，不作为网络参数。

| 请求 | 参数及前置 | 范围与结果 |
|---|---|---|
| `POST /map-studio/tasks/:id/run` | `{mode:'guided', stop_at:'base', expected_revision:r}`；起点仅 brief/research/base | base 成功即停；research 已完成时不重跑 research |
| 同上 | `{mode:'guided', stop_at:'drawing', expected_revision:r}`；起点仅 style/drawing | style 不生成纸纹并继续 drawing；drawing 成功即停 |
| 同上 | `{mode:'manual', expected_revision:r}` 或 `{mode:'auto', expected_revision:r}` | 保留既有单阶段/连续执行语义 |
| `PUT /map-studio/tasks/:id` | `{map_spec, layer_options, expected_revision:r}` | 页面唯一几何保存通道；确认待确认要素也经此通道，不启动 run |
| `POST /map-studio/tasks/:id/advance` | `{expected_revision:r}`；当前 complete、非 running、当前成图有效且满足交付前置 | 执行 complete：按需渲染 pip → 构建 deliverable → 交付 → completed |
| `POST /map-studio/tasks/:id/deliver` | 既有调用；**不携带 `expected_revision` 或虚构 CAS 参数**；有宿主、非 running、stage complete | 仅补交付/重试，直接 `deliverCurrent`，不重渲 pip；不等同于执行 complete |

**新增 guided 契约：**

- guided 必须携带 `stop_at`，仅允许 base/drawing；manual/auto 不接受 `stop_at`。非法组合或非法起点拒绝，不能创建 run。
- guided 不隐式回退。需要重做早期阶段时，先执行服务端允许的回退，再根据返回状态选择动作。
- base/drawing 两种成功终点都结束 run 并进入 awaiting_review。style 的“不生成纸纹”不是 guided 的停点；若 style step 记录为 skipped，同样进入 drawing。
- 失败、真实受阻、取消生效、`proceed=false` 或目标阶段成功，任一先到即停。既有执行器返回的回退/修复状态按 detail 展示，不由前端另发回退或重试。
- 新 run 必须持久记录并可读 `mode/stop_at`。重试保留原策略与边界，并重新校验当前阶段；不合法则重新选择动作。旧 run 缺字段时不猜测边界，不自动续跑。
- 不新增 `capabilities`、`run_stop_at` 或类似探测协议。前后端统一发布；缺任一 guided 边界即不满足上线门禁，不提供永久第二套分步降级流程。既有 manual API 兼容保留，不作为 guided 缺失的验收替代。

**complete 与补交付的已核实区别：**

`run.ts:264-275` 明确执行 pip 细节渲染、`buildDeliverable`、`deliverCurrent`，随后 completed；不存在“只准备不交付”接口。`routes.ts:141-148` 的 `/deliver` 只直接交付，不重渲 pip。complete 构建失败可能回退 drawing；普通异常可令 workflow failed，不能将“请求已接受”当作交付成功（`run.ts:272,305-329`）。

取消请求后显示“正在取消… / Cancelling…”。服务端取消结束活动 run、running step → pending、`run_id=null`、status → idle（completed 保持），且不启动下一阶段（`run.ts:586-604`）。确认取消生效前只允许观测，不恢复写入或补发下一阶段。

---

## 2. 主状态表

### 2.1 全局分派：先状态与覆盖条件，再阶段与策略

以下按行优先匹配；适用于全部六个 stage 和全部执行策略。同一时刻最多一个可执行主动作，不以 failed 掩盖修复草稿。

| 优先级 | 条件 | 唯一主动作/主槽：中文 / English | 后续规则 |
|---|---|---|---|
| 1 | 活动 run 或 `status=running` | 真实阶段进度；取消运行 / Cancel run 为唯一运行控制 | 只取消/观测；不保存、确认、回退、启动或交付。取消待确认时不重复取消 |
| 2 | 保存中或请求结果未知；任务状态不可确认 | 保存中为禁用进度；未知时“核实状态 / Verify status” | 先 GET 核实，不盲重发；不能进入失败重试或阶段动作 |
| 3 | CAS 冲突或隔离的待解决冲突副本 | 处理冲突 / Resolve conflict | 不强制覆盖，不仅替换 revision 重发 |
| 4 | 有合法待保存草稿 | 保存几何 / Save geometry；或保存需求 / Save brief | 即使 workflow failed 也先保存修复；两组均脏时先保存需求，再检查几何基线，不夹带提交 |
| 5 | `status=blocked` 或 `failed` | 按 §2.4 修复真实阻塞/失败 | 修复保存返回新 stage/status 后从优先级 1 重算，不沿用旧失败按钮 |
| 6 | `status=idle` 或 `awaiting_review` | 按 §2.2 当前 stage | 再应用 §2.3 执行策略；不因读取到状态自动启动 |
| 7 | `stage=complete/status=completed` | 宿主任务：查看交付 / View delivery；独立任务：查看成图 / View map | 核对结果身份；startRun 拒绝 already_completed |
| 8 | `status=completed` 且 stage 非 complete，或其他无法解释组合 | 核实状态 / Verify status | 只刷新和查看现场，不猜测恢复路径 |

草稿无效时优先定位并修正该草稿，保存按钮禁用且显示原因，不绕过草稿运行。running 与旧失败/冲突同时出现时仍只取消/观测；结束后再处理冲突和草稿。

本表覆盖 workflow 的全部合法状态。`pending/skipped` 不进入本表；它们仅作为 step 事实展示。

### 2.2 idle/awaiting_review 的当前阶段表

本表仅在 §2.1 前五项均不适用时使用。状态 awaiting_review 不证明该阶段已完成，必须结合指针和产物判断。

| 当前 stage | 服务端前置与执行内检查 | 默认主动作：中文 / English | 成功后停靠/确认含义 |
|---|---|---|---|
| brief | 无活动 run、subject 存在；缺 subject 先补需求 | 检索并准备底图 / Research & prepare base | guided/base 执行 brief→research→base；无独立需求审批伪动作 |
| research | 通用启动前置；已有进度可按既有恢复入口继续 | 有可续进度：继续检索并准备底图 / Continue research & prepare base；否则：检索并准备底图 / Research & prepare base | 未确认几何不阻塞 research→base |
| base | mapSpec、可看图文本配置 | 准备底图 / Prepare base | guided/base 成功后停在 style/awaiting_review；产物与 bbox 以返回为准 |
| style | 默认 UI 要求有效底图；style 不生成纸纹 | 待核对数非零：确认几何 / Confirm geometry；为零：渲染成图 / Render map | 确认只保存；显式渲染以 guided/drawing 跨过 style 到 drawing |
| drawing | mapSpec、可看图文本配置；执行内部检查 base_image、画幅和 registration | 有效底图且待核对数非零：确认几何 / Confirm geometry；为零：渲染成图 / Render map | drawing 完成后停在 complete/awaiting_review，不交付 |
| complete | mapSpec、当前 final/base/layer_doc/spec 可用；交付校验无平滑/标签问题 | 宿主任务：交付成图 / Deliver map；独立任务：完成成图 / Complete map | 点击 `/advance` 执行 complete；不是 `/deliver` 替代执行 |

前置证据：`startRun` 检查 busy、completed、spec、vision 与 style skip（`run.ts:330-383`）；drawing 内部缺 spec/base 返回 `missing_base`，画幅不符回 base，registration 不合法抛错（`run.ts:246-262`；`geo/geometry.ts:881-901`）。

缺底图、画幅不符、配置无效等真实问题优先提供对应修复，不把残留 base/final 当作有效输入。默认 UI 的待核对停靠不是服务端硬闸门。若只查看旧成图，主动作仍绑定当前 task，而非旧图的阶段。

### 2.3 阶段 × 执行策略表

本表定义每个合法起点的执行终点，与 §2.1 的所有 status 行组合使用；失败、阻塞、取消或 `proceed=false` 总可提前结束。

| 起点 | manual | guided/base | guided/drawing | auto |
|---|---|---|---|---|
| brief | 执行 brief，停在 research | 执行至 base，停在 style | 拒绝，不创建 run | 连续至 complete 并交付，或提前停止 |
| research | 执行 research，停在 base | 执行 research→base，停在 style | 拒绝，不创建 run | 同上 |
| base | 执行 base，停在 style | 执行 base，停在 style | 拒绝，不创建 run | 同上 |
| style | 执行/合法跳过 style，停在 drawing | 拒绝，不创建 run | style 不生成纸纹，继续 drawing，停在 complete | style 后继续 drawing→complete 并交付 |
| drawing | 执行 drawing，停在 complete | 拒绝，不创建 run | 执行 drawing，停在 complete | drawing 后执行 complete 并交付 |
| complete | 执行 complete，成功 completed | 拒绝，不创建 run | 拒绝，不创建 run | 执行 complete，成功 completed |

表中“停在”除最后一行外均指 awaiting_review。style 当前既有执行设置 `texture_image=null`、`proceed=true`（`run.ts:244`）；step completed 或显式 skip 的记录都不代表 workflow completed/skipped。manual 的兼容入口不能把一个点击悄悄变成多个请求。

回退沿用服务端允许目标与最多 2 次限制：≤base 清 base/kmz/pip；所有回退清 final/layer_doc，受影响 step pending；不宣称清 texture/layer_options（`run.ts:140-163`）。UI 显式回退后重算动作；执行器内部 auto 回退按实际运行事实呈现。

### 2.4 真实阻塞、失败与未知错误

以下恢复表适用于所有阶段，且低于结果未知、冲突、草稿保存的优先级。缺多个前置时按输入 → 模型配置 → 启动选择第一个可执行修复，其余列为原因，不并列多个主色按钮。

| 条件/kind | 唯一主动作：中文 / English | 次动作与限制 |
|---|---|---|
| 真实 blocking 问题 | 修正输入 / Fix input；或配置可看图模型 / Configure vision model | 未确认几何、无纸纹不构成 blocking；缺 spec/base 按真实阶段提供合法修复/回退 |
| `steps_exhausted` | research 有可续进度：继续检索 / Continue research；否则：重试本阶段 / Retry stage | 查看已完成步骤；清空进度须另行确认 |
| `ended_without_delivery` | 有可续 research：继续检索 / Continue research；否则：重试本阶段 / Retry stage | 查看缺少的阶段产物，不将预览当成交付 |
| `call_error` | 配置有效：重试本阶段 / Retry stage；无效：修复模型配置 / Fix model configuration | 切换模型、查看调用错误；配置保存不自动启动 |
| `rejected` | 处理拒绝原因 / Resolve rejection | 先处理 `problems[]`；修复并保存后重算，不盲目重试 |
| `mixed` | 查看并处理问题 / Review & resolve issues | 查看完整运行记录，不猜主要原因 |
| `failed` 且 `error_detail=null`，或 kind 无法识别 | 查看错误详情 / View error details | 展示原 `error`、阶段和 run；确认原因与前置后才允许显式重试，不伪造 #124 分型 |
| complete 失败 | 核对交付结果 / Check delivery result | 先查是否已有成功记录；需执行/重做 pip 时重试 complete；仅补宿主交付且前置齐全时才使用 `/deliver` |

非 `MapStageExhaustedError` 的失败可能只有 `error` 而无 `error_detail`；Stale/Conflict 仅结束 run，不必改任务为 failed（`run.ts:305-329`）。`workflow_busy` 是互斥拒绝，读取活动 run，不将其标为新的执行失败。

#124 恢复复用现有处理，不新增重试端点。清空研究进度使用既有 `/research-progress/clear`，属显式破坏性次动作，不等于回退或清除底图。

重试/续跑保留失败 run 的 mode/stop_at。修复保存若把 stage 从 drawing 改成 base，原 guided/drawing 不能重发；先按新阶段选择 guided/base。无原运行边界的旧 run 必须由用户重新选择合法动作。

---

## 3. 三个人工停靠点

### 3.1 几何确认：复用要素状态，不增整体门槛

| 项目 | 契约 |
|---|---|
| 人看什么 | 点/线/面 TAB、名称与坐标、来源与人工条目标记、范围、平滑警告及参考信息；当前 TAB 只画当前类，另提供三类待核对汇总 |
| 待核对数 | 与 `geometryUnverified` 对齐：`dataset_missing` 一律计入；其余按 proposed 且非 manual/verified/confirmed 的口径统计（`accuracy.ts:88-95`） |
| 草稿计数 | 仅 `proposed===true` 的数量标“候选数 / Candidate count”，不能混称待核对数 |
| 确认动作 | 人明确选择确认范围，清该范围内的 `proposed`，经页面唯一“保存几何”通道提交整份 spec 与 layer_options、`expected_revision` |
| 写入结果 | 坐标未改、proposed 非 true 的要素由服务端设 confirmed；不批量转 manual、不无故删 dataset_ref（`run.ts:500-511`） |
| 保存与推进 | 有普通脏几何先保存，再进行确认；确认写入成功后仍不 run/advance/deliver。纯确认也经过 spec 失效路径，不承诺原图一定保留 |
| 无待核对要素 | 直接提供“渲染成图 / Render map”；不要求空 PUT、浏览器整体核对标记或第二次正式批准，仍必须由人点击 |
| 刷新 | 按服务端 spec 重算待核对数和产物有效性；无浏览器级复核生命周期 |
| 残余待核对 | 如 dataset_missing 仍被计入，显示具体原因；不能把清 proposed 等同于全部通过，也不能伪造来源以归零 |

“确认几何”是显式复核动作；其持久化入口仍是同一个页面几何保存事务，不另设局部或弹窗写接口。按钮可呈现“确认并保存几何 / Confirm & save geometry”，但它不启动渲染。成功后由用户再次点击“渲染成图”。

| 原要求 | 已核实事实 | 实际保证 | 不保证范围 |
|---|---|---|---|
| 人核对确认后才渲染 | 服务端无未确认几何禁止 drawing 的闸门；几何 issues 为软提示（`accuracy.ts:88-95`；`store.ts:575-595`；`run.ts:367-371`） | 默认 UI/guided 在 base 停靠；有待确认时先复用要素确认保存；无待确认时也必须显式点渲染 | auto 和其他合法 API 调用可能越过人工核对；不新增服务器强制闸门 |

旁注：

> 确认记录对所列要素的复核，不代表服务端此前禁止作图。高级自动运行可能越过核对并连续执行到交付。  
> Confirmation records review of the listed features; the server does not otherwise block drawing. Advanced Auto may bypass review and continue through delivery.

不新增独立“整体核对完成”字段、不可恢复的本地核对键或刷新后必须重做的整体批准。辅助检查项可以提示范围、地点、线路、区域，但不是新正式门槛。

### 3.2 底图就绪

| 项目 | 契约 |
|---|---|
| 人看什么 | 有效底图、范围与 registration、当前类几何覆盖层、数据来源及缓存证据 |
| 停靠事实 | guided/base 成功后为 style/awaiting_review；base step completed 且有有效 base 产物 |
| 确认含义 | 没有独立“底图已批准”持久字段；用户检查后显式启动渲染 |
| 有待核对要素 | 先确认并保存；若返回状态要求重做底图，先准备底图，不能沿用旧按钮 |
| 无待核对要素 | “底图已就绪 · 可渲染成图 / Base map ready · Ready to render”；等待人的明确点击 |
| 渲染请求 | `/run {mode:'guided', stop_at:'drawing', expected_revision:r}`，从 style/drawing 执行，止于 drawing |
| 草稿/冲突 | 按 §2.1 优先处理，不渲染旧 spec 却展示新草稿 |

底图与几何核对可以是同一停靠面，不增加第二套同义确认。缓存命中看键、manifest 和产物 sha，不以生成耗时证明。

### 3.3 成图待交付

| 项目 | 契约 |
|---|---|
| 停靠事实 | drawing 成功写 final/layer_doc/layer_options；manual 或 guided/drawing 停在 `stage=complete/status=awaiting_review`。 |
| 人看什么 | 当前成图及 run/published_revision、同图冻结图层与初始描述、来源、警告/遗漏；不能宣称 complete 前全部 pip 细节已完成。 |
| 正常交付请求 | “交付成图 / Deliver map” → `POST /advance {expected_revision:r}`，**异步启动 complete**；启动响应不是交付结果。 |
| 执行顺序 | 按需 `renderPipAssets` → `buildDeliverable` → `deliverCurrent` → `finish(proceed:false)` → completed（`run.ts:264-275`）。 |
| 校验 | 缺 final/base/layer_doc/spec 为 `missing_drawing`；平滑/标签问题为 `drawing_invalid`；按实际文件计算 final sha（`delivery.ts:15-67`）。 |
| 观察成功 | 继续轮询 detail 与 delivery 记录，匹配本次图片 sha、pip 身份及关联快照；宿主交付成功须有实际版本结果，workflow 完成须另观察 complete/completed。 |
| 失败或未知 | 构建失败可回退 drawing；普通异常可 failed；响应丢失先核实活动 run、detail 和 delivery 记录，不自动重复执行。 |
| 不点击 | 默认流程保持停靠，不后台执行 complete。 |
| 补交付 | `/deliver` 要求宿主、非 running、stage complete；无 CAS、不重渲 pip，**不负责 workflow 状态收尾**（`routes.ts:141-148`；`delivery.ts:69-86`）。 |

**宿主副作用与成功判据：**

- 宿主事务插入底图/成图版本、更新资产图片与语义、登记来源和 pip；事务外发资产库通知。既有副作用见 `services/map-studio-host.ts:24-60,131-136`；最终语义写入时序须按 master 的最新事实修正。
- master 已含 #125，但 `map-studio-host.ts:65-69` 先把原始 `d.semantics` 写版本 params.geometry，`:78-85` 才生成/保护人工字段并写当前 props。**当前版本 params 不保证包含最终描述**，不能据此宣称同图冻结已完成。
- 新增契约要求宿主事务内先得到最终语义，再写版本 params；`MapStudioDeliveryResult` 最小扩展回传 `frozen_semantics`、`sources` 及其与成图 `version_ids` 的关联。模块将结果保存为新的 delivery 快照：新 `published_revision`、同 final image sha，不修改原 drawing 快照。详见 04 §5。
- 宿主任务必须有与本次交付身份匹配的实际版本结果；不能凭 final 存在、advance 的启动 200 或 workflow 单个状态值显示“已交付”。文案：“交付处理中 / Delivery in progress”；证据齐全后才显示“已交付 / Delivered”。
- 模块按 final sha及 pip 相关 sha 幂等，宿主按 task+png_sha+pip_key 幂等（`delivery.ts:69-86`；`map-studio-host.ts:32-34`）。重试必须返回同一最终冻结语义及版本结果，不能读取当前 props 重算旧交付。宿主已提交、模块尚未登记时，通过同一幂等结果补记。
- 独立任务执行 complete 后无宿主版本，`version_ids:[]` 合法；观察对应完成记录与 complete/completed，显示“成图已完成（独立任务） / Map completed (standalone task)”。不显示资产库同步成功，不提供 `/deliver`。
- `/deliver` 成功仅证明对应补交付成功；若 workflow 尚未 completed，仍显示真实状态，不由前端改状态或把补交付当作 complete 已完成。

drawing 的初始描述与 delivery 的最终人工保护描述分属两个不可变快照，可对应同一图片字节。AI 预览不能交付。旧快照缺字段可显示几何摘要；新产物缺冻结载荷、最终语义回传或来源关联均不能降级通过 G2/G4。

---

## 4. “完成编辑”与“确认几何”分离

### 4.1 页面只有一个几何草稿

页面保存组为 `specDraft + layerOptionsDraft`，覆盖所有点、线、面和选项。地点行、全部地点弹窗、线/面顶点弹窗共享此草稿；不存在 A 行已保存而同份草稿中的 B 行仍待保存的提交粒度。

| 动作 | 本地结果 | 持久化与阶段影响 |
|---|---|---|
| 地点行/弹窗有效编辑 | 立即更新共享草稿与 SVG；输入尚不合法时只保留输入缓冲并显示错误，不写坏几何 | 不 PUT、不渲染 |
| 拖点、删点、插点 | 通过共同校验更新同一草稿；坐标变化与仅名称变化分开处理 | 不直接持久化；坐标是否转 manual 由服务端比较结果裁定 |
| 完成编辑 | 校验并结束当前条目的局部事务/交互，解除拖拽或绘制状态 | 不保存、不确认全任务、不启动阶段；有效修改此前已进入页面草稿 |
| 关闭弹窗 | 保留已经加入页面草稿的有效修改 | 不提交、不二次保存；不是隐式放弃 |
| 保存几何 | 冻结整份 `specDraft + layerOptionsDraft`，一次 CAS | 唯一几何持久化动作；提交所有脏几何条目，不夹带 brief |
| 确认几何 | 明确确认范围后清 proposed，使用同一页面保存通道 | 记录要素确认；不 run/advance/deliver |
| 放弃几何修改 | 明确放弃整份几何保存组，恢复服务端基线 | 不 PUT；需提示将放弃全部未保存几何与选项 |

弹窗固定反馈：“已加入待保存草稿 / Added to unsaved draft”。仅页面保存成功后显示“已保存 / Saved”。不再提供“保存到草稿”二次确认，避免让地点有效编辑需重复操作才能进入页面草稿。

条目“完成编辑”仅在存在活动局部事务时可用；没有活动编辑时禁用，文案“没有正在进行的局部编辑 / No local edit in progress”。新建线面不足顶点下限时不能完成；取消该局部新建不生成无效要素。取消局部事务只撤销本次事务，不丢弃页面其他有效修改。

### 4.2 动作文案

| 场景 | 中文 / English |
|---|---|
| 完成编辑按钮 | 完成编辑 / Finish editing |
| 完成编辑说明 | 结束局部编辑，不保存到服务端、不确认几何、不生成成图。 / Finish this local edit without saving to the server, confirming geometry, or rendering a map. |
| 行/弹窗有效编辑 | 已加入待保存草稿 / Added to unsaved draft |
| 页面主保存 | 保存几何 / Save geometry |
| 保存中 | 正在保存全部几何修改… / Saving all geometry changes… |
| 保存成功 | 几何已保存；编辑预览已更新，成图尚未重渲。 / Geometry saved. Edit preview updated; the map has not been re-rendered. |
| 确认成功 | 要素确认已保存；尚未开始作图。 / Feature confirmation saved. Drawing has not started. |
| 明确拒绝 | 本次保存被拒绝，已恢复服务端版本；修改保留为副本。 / This save was rejected. The server version is restored; your changes are retained as a copy. |
| 结果未知 | 保存结果待确认，请先核实状态。 / Save result pending. Verify status first. |

“保存不重渲”的成功文案以 §5 所列分支拆分完成为实施前提；不得在现有会重渲并交付的 options 分支上直接使用该文案。

### 4.3 用户流程示例

1. AI 填入要素，guided/base 仍运行：仅展示进度、要素与待核对数；只允许取消/观测。
2. base 成功停靠：显示“底图已就绪”，按服务端待核对数显示“确认几何”或“渲染成图”。
3. 人修改地点 A、地点 B 和一条线路：每次有效修改都更新同一页面草稿与 SVG；弹窗显示“已加入待保存草稿”。
4. 点击线路“完成编辑”、关闭地点弹窗：均不发请求。点击页面“保存几何”才一次提交 A、B、线路与全部选项。
5. 成功响应建立规范化新基线；坐标变化的要素按服务端呈现 manual/confirmed，其余按事实保留来源与状态。不能由“编辑了三个地点”推算精确剩余数，必须重算 `geometryUnverified`。
6. 对仍待核对的要素显式确认并保存。纯确认也按返回 outputs/stage 重算失效关系；无待核对时不发空 PUT。
7. 人点击“渲染成图”，guided/drawing 从 style/drawing 执行；旧图标“上一版 · 正在渲染新版 / Previous version · Rendering a new version”。
8. 新 final 与冻结元数据就绪后停在 complete/awaiting_review；人点击“交付成图”，`/advance` 执行完整交付链。无“准备交付”中间按钮。

---

## 5. 编辑失效矩阵

保存、回退、重渲、交付是不同动作。既有事实见 `run.ts:427-583`；本 Issue 新增的保存分支拆分单独标明，不冒充既有行为。

| 编辑/动作 | 既有失效与状态事实 | 确认与来源 | 本 Issue UI/下一步契约 |
|---|---|---|---|
| 新增整个要素 | 改变 spec；未改变底图相关字段时走 spec 失效，清 final/layer_doc，恢复 drawing；同时改范围则回 base（`run.ts:526-548`） | 用户绘制的新坐标按人工几何处理；不能因数组新增就批量改其他要素来源 | 保存整份草稿后按返回状态准备底图或显式渲染 |
| 删除整个要素 | 改变 spec，同上；整要素删除不是“删顶点下限”限制 | 被删除项不再计数，不将其余项设 confirmed | 明示图与当前几何不一致；重新统计待核对数 |
| 只改要素名称 | 坐标未变，不触发坐标 changed；但 spec 改变仍可清 final/layer_doc、恢复 drawing（`run.ts:500-511,536-548`） | **不因此转 manual、不因此清 proposed** | 名称编辑不是几何确认；保存后仍可能需要确认 |
| 改地点坐标或线面 points | 未改底图输入时清 final/layer_doc、恢复 drawing，不要求重取底图 | changed 要素转 manual、清 proposed/dataset_ref、设 confirmed，同步研究 features（`run.ts:500-511`） | 按返回状态呈现“已转为人工几何”，再显式渲染 |
| 纯确认 | 清 proposed 仍是 spec 变化，走 spec 失效路径；**不承诺原成图一定保留** | 坐标未变不转 manual、不无故删除数据集来源；dataset_missing 仍按计数规则处理 | 保存后重算阶段、产物和待核对数，不自动渲染 |
| extent/bbox、layers、projection 等底图输入变化 | 按 reframed 路径回 base、清 base/kmz/pip，并使成图失效；遗留 spec.style 也参与比较（`run.ts:526-548`） | 只有实际坐标变化才决定已有要素转 manual | “底图需要重做 / Base map must be rebuilt”；从新状态准备底图 |
| brief 非主题字段变化 | restart brief，随后重建所需产物（`run.ts:476-478`） | 不批量确认几何 | 需求单独保存；从返回阶段重新推进，不能沿用旧 drawing 重试 |
| 遗留主题变化 | 既有 presentation-only 分支在 base 已完成时回 base，否则 brief；spec.style 也能触发 reframed（`run.ts:476-478,526-533`） | 不确认几何 | 任务 UI 移除主题；新请求规范化按主题政策实施，不因无效主题差异单独重建；历史图和人工文档只读保留 |
| 首次成图前改 layer_options | 既有 PUT 校验 knownIds 并持久化 options，drawing 消费且支持 semantic_id 回落（`run.ts:440-467,258`；`drawing.ts:87-95`） | 不改变几何确认 | 同次“保存几何”CAS 提交，不需新端点；随后由人显式渲染 |
| 有 layer_doc、spec/brief 未变，仅改 layer_options | **现有分支转 saveMapLayerDoc，重渲并自动交付**（`run.ts:444-449,608-639`） | 不改变几何确认 | **新增实现契约：本 Issue 必须拆分为只保存选项与显式重渲/交付两个分支**；默认保存只持久化并标当前图过期，不能继续调用旧自动交付分支 |
| 人工 `PUT /tasks/:id/layer-doc` | 既有行为为重渲、deliverCurrent、drawing/complete step 完成、status completed（`run.ts:608-639`） | 人工图层不等于所有语义描述由人撰写 | 保留为明确“重渲并交付 / Re-render & deliver”操作，预告宿主副作用；不伪装普通保存，不自动改写既有人工文档 |
| 显式回退 | ≤base 清 base/kmz/pip；所有回退清 final/layer_doc，step pending；最多 2 次（`run.ts:140-163`） | 不推测恢复/清除哪些确认字段 | 以返回状态重算；不是通用编辑保存操作 |
| 重跑检索 | 较晚阶段需合法回退；不能用 run 绕过回退上限 | 新研究可能改变已有要素，不能承诺保留全部人工修改 | 先提示风险，区分继续进度与显式清空 |
| 取消 run | 结束活动 run，running step→pending，run_id=null，status idle（completed 保持），不启动下一阶段（`run.ts:586-604`） | 不据此清 proposed 或恢复 origin | 以返回产物为准；保留原运行 mode/stop_at 供合法恢复，取消不是回滚 |

**保存选项分支拆分的验收边界：**

- 复用 `PUT /tasks/:id {map_spec, layer_options, expected_revision}`，不新增平滑保存端点。
- 有 layer_doc 且 spec 未变时，“保存几何”也不得渲染、执行 complete 或交付；保留可读的上一版冻结图，当前图标为过期，后续显式渲染入口须能消费已保存 options。
- 若输入仍适合从 drawing 恢复，返回状态须允许 guided/drawing；否则按真实新阶段修复。不能保留 completed 状态却只给一个必然被 already_completed 拒绝的按钮。
- 人工 layer-doc 的既有显式重渲/交付路径与默认只保存选项路径必须分开。此为本 Issue 实现门禁；在拆分前不得宣称默认保存零渲染、零交付。

**平滑数值与证据：**建议值采用 14 步二分所得满足容差的最大强度，向下取 0.05 档，低于 0.05 归零（`render/smooth.ts:227-237`）。`suggested=0` 按钮为“关闭平滑 / Disable smoothing”；它证明当前算法和档位下建议关闭，不证明不存在任意实数非零解。点击为人显式动作，不自动改强度；复算 `deviationProblems`，剩余问题必须列出。偏离与上限各保留一位小数，舍入相同但超限时加“超限 / Over limit”和精确值 tooltip。

历史成图只能配自己的冻结图层/语义/来源；当前 spec 已保存不意味着旧图被更新。保存后的最终 stage、revision 与输出以服务端权威响应为准，不补造未核实的清空字段。

---

## 6. 编辑通道与 CAS

### 6.1 一次页面保存的完整时序

| 步骤 | 数据动作 | 界面与判定 |
|---|---|---|
| 1. 建立基线 | GET detail，保存 revision `r`、服务端原样 spec、layer_options；建立同一几何保存组 | clean；服务端原样对象与编辑展示模型分开保留 |
| 2. 编辑 | 地点行、弹窗、顶点操作立即更新统一 `specDraft`；平滑更新 `layerOptionsDraft` | SVG 预览即时更新，标 dirty；不是 final 重渲 |
| 3. 校验/结束交互 | 校验坐标、线≥2 点、面≥3 点；完成活动局部事务 | 无效输入先修正，不提交半成品；完成编辑本身不 PUT |
| 4. 唯一保存 | `PUT /tasks/:id {map_spec:specDraft, layer_options:layerOptionsDraft, expected_revision:r}`；冻结本次整份提交 | saving，禁止重复写入/推进；所有脏几何条目和选项一起保存 |
| 4a. spec 未变 | 使用基线中的服务端原样 spec 对象，不用展示模型重建、重排或舍入 | 保持原字节语义，避免无意触发 spec 变化和来源改写 |
| 5a. 成功 | 服务端权威响应中的规范化 spec、options、revision 成为新基线；响应不完整则 GET 核实 | 基线完整建立后才显示已保存；重算 stage/status、产物有效性与主动作 |
| 5b. CAS 409 | GET 最新 detail；不覆盖较新版本 | 活动画布回到服务端事实，本地提交隔离为冲突副本；不显示成功 |
| 5c. 明确拒绝 | 校验、requireIdle 等明确拒绝，读取/恢复权威状态 | 显示原因并保留副本；不把拒绝当作超时，也不泛化为成功 |
| 5d. 断线/超时 | 写入结果未知，先 GET 核实 revision 与提交内容 | “保存结果待确认 / Save result pending”；禁止盲重发和“未写入”断言 |

5d 判定步骤：

1. 保留提交基线 revision、冻结的整份提交内容及请求对象，不启动第二次写入。
2. 读取最新 detail；无法读取则保持 result_unknown，只提供“核实状态 / Verify status”。
3. revision 已前进，且服务端规范化后的本次保存组与提交预期匹配：视为已保存，以该权威响应建立新基线。比较必须包含整个 spec 与 layer_options，不能只比较用户改的一行。
4. revision 已前进但内容不匹配：进入冲突副本处理，不能断言本次从未写入；可能写入后又被别人改变。
5. revision 未前进不能证明原请求永远不会落盘；继续核实请求/任务状态，不盲目重发。只有确认请求已结束且未应用后，才允许用户明确再次提交。
6. 已保存判定后也不自动运行；按新的 stage/status 从 §2.1 重新分派。

服务端互斥和 CAS 已存在：`mutateTask` 校验 revision、requireIdle、expectedRunId、expectedBriefHash，数据库以整份 state/map_spec/brief 字符串做 CAS（`store.ts:334-453`；`db.ts:168-186`）。网络参数仍使用 `expected_revision`。

### 6.2 保存组与多草稿隔离

| 保存组 | 唯一动作 | 防覆盖规则 |
|---|---|---|
| `briefDraft` | 保存需求 / Save brief | 只提交 brief；不夹带 spec/options，不借需求保存提交几何 |
| `specDraft + layerOptionsDraft` | 保存几何 / Save geometry | 一次提交整份页面几何和全部选项；没有行级、弹窗级或独立 options 保存事务 |
| 冲突副本 | 保留副本或放弃副本 | 不属于活动可提交草稿；重新应用前必须比较最新基线，不自动覆盖 |

共同规则：

- 所有写请求串行。两组都脏时先保存需求，再比较几何原基线与最新服务端内容；不能仅换成新 revision 后原样重发旧草稿。
- 轮询更新服务端事实，不直接覆盖脏草稿。发现实体冲突时进入冲突处理；活动预览与副本不得混称已保存。
- 切点/线/面 TAB 只改变可见类别，其他类别不画、底图保留；共享草稿和各类选中态保留。
- 有活动绘制事务时，切类提供“完成编辑并切换 / Finish editing and switch”“取消本次编辑并切换 / Cancel this edit and switch”“留在当前类别 / Stay”；点数不足禁用完成。三种选择都不提交服务端。
- 地点/顶点弹窗关闭保留有效草稿，不再提示二次保存。显式取消局部事务只撤销该事务，不替代页面“放弃几何修改”。
- 跨要素选择使用 `kind:id`；不按数组索引在删除后选中邻居。顶点行身份需绑定几何版本，不能假定顶点有稳定 ID（`services/layer-doc.ts:91,96,101`）。

### 6.3 拒绝、互斥与主动作

| 场景 | 行为与文案 |
|---|---|
| 删除后线少于 2 点 | 保持原线：“线至少需要 2 个点，无法删除。 / A line needs at least 2 points. This point cannot be deleted.” |
| 删除后面少于 3 点 | 保持原面：“面至少需要 3 个点，无法删除。 / A region needs at least 3 points. This point cannot be deleted.” |
| 无 registration | 仅数值编辑，不猜地理映射；不开放拖拽写入 |
| 本页有草稿且 workflow failed | 先保存修复；成功后按新状态重算，不能继续旧阶段重试 |
| 本页有草稿时启动 run | 必须先保存或放弃；保存成功不自动启动 |
| 其他窗口启动 run | 只取消/观测，保留草稿副本；“运行已在其他窗口启动，暂不能保存。 / A run started in another window. Saving is unavailable.” |
| PUT 返回 busy/requireIdle | 读取最新事实，活动预览恢复权威状态，隔离副本；不报成功 |
| 对方改变/删除选中要素 | 取消失效选中，说明具体目标变化；不重新定向到邻项 |

优先级始终是：**运行中只取消/观测 → 结果未知先核实 → 冲突先解决 → 草稿先保存 → 真实阻塞/失败 → 阶段动作**。

### 6.4 行为验收断言

1. 纯 zoom/pan、深链/TAB/选中恢复零几何写入，不发 PUT/run/advance/deliver。
2. 缩放、平移及 meet 信箱边距后拖点，写回坐标符合预期；无 registration 不猜坐标。
3. 地点行、全部地点弹窗、线/面顶点弹窗有效编辑即时进入同一草稿并更新 SVG；关闭弹窗零请求。
4. A、B 两个要素及 options 同时修改后，“保存几何”只发一次整份 CAS，成功后全部建立新基线；不存在 A 已保存、B 仍脏。
5. 仅 options 改变时发送服务端原样 spec；首次成图前保存后刷新可恢复，drawing 实际消费该值。
6. 有 layer_doc 时默认保存 options 零渲染、零交付；必须通过本 Issue 分支拆分实现，不能只测无 layer_doc 样本。
7. 坐标变化、仅改名、纯确认分别验证 manual/proposed/dataset_ref 与失效结果，不能共用错误断言。
8. CAS 409 不覆盖较新数据、不显示成功；冲突副本可查看。超时先 GET，匹配则成功、不匹配则冲突，未核实前不重发。
9. failed 状态下修复保存优先；保存改变 stage 后下一动作匹配新阶段，原非法 guided 边界不重发。
10. 线面顶点下限拒绝有反馈且零写入；完成编辑不 PUT；SVG 更新不宣传为 final 重渲。
11. 保存成功后刷新，规范化坐标、options、来源、确认状态与服务端一致。
12. 运行中仅取消/观测，取消生效后不执行下一阶段；恢复保留原合法 mode/stop_at。

以上为待执行验收要求，本轮未执行。

---

## 7. 一键检索完整时序与 V5 订正

| 时点 | 请求/服务端行为 | UI 停靠与主动作 | 异常处理 |
|---|---|---|---|
| 点击前 | 按 §2.1 排除运行、未知结果、冲突、草稿和真实阻塞；subject 已保存 | 检索并准备底图 / Research & prepare base | 缺输入先修正，不发 run |
| 点击 | `/run {mode:'guided', stop_at:'base', expected_revision:r}` | 显示真实阶段进度，仅取消/观测 | busy 读取活动 run；CAS 进入冲突；不改用 auto |
| brief | 从当前 brief 执行，不新增审批 | 需求处理中 / Processing brief | 失败停在真实状态 |
| research | 扩展点线面，完成后继续 base | 展示已填内容与 `geometryUnverified` 对应待核对数；草稿 proposed 数只能叫候选数 | #124 分型恢复；已有进度不自动清空 |
| base | 写 base/kmz/pip 与 bbox | 准备底图中 / Preparing base | 前置或产物失败按事实处理 |
| base 成功 | 结束 guided run，style/awaiting_review | 有待核对：确认几何；无待核对：渲染成图 | 不执行 style/drawing，不后台确认 |
| 修改几何/选项 | 页面草稿后一次“保存几何”CAS | 保存成功重算待核对数、stage 和产物 | 失败修复也先保存；未知先 GET，不沿用旧失败动作 |
| 修改范围或需求 | 分别经几何/需求通道保存 | 根据返回状态重新检索/准备底图 | 不以旧底图渲染新范围 |
| 确认要素 | 有待确认时清 proposed，经同一保存通道持久化 | 要素确认已保存；等待人点渲染 | 纯确认可能使图失效；dataset_missing 等残余原因如实显示 |
| 人点击渲染 | `/run {mode:'guided', stop_at:'drawing', expected_revision:r}` | style 跳过纸纹后 drawing；成功停在 complete/awaiting_review | 不执行 complete、不自动交付 |
| 人点击交付 | `/advance {expected_revision:r}` 执行 complete | pip→构建 deliverable→交付，成功 completed | 核对返回/记录；未知先核实，补交付才使用 `/deliver` |

**高级 auto 完整警告：**

> **自动运行可能越过人工核对并连续执行到交付。** 服务端不会因几何未确认而停止；此模式可能直接作图、执行 complete 的细节渲染并交付。宿主任务交付会创建版本并更新资产图片和语义。需要先看底图、核对几何、再决定作图和交付，请使用“检索并准备底图”。  
> **Auto may bypass human review and continue through delivery.** The server does not stop for unconfirmed geometry. Auto may start drawing, render detail assets during complete, and deliver the result. For hosted tasks, delivery creates versions and updates the asset image and semantics. Use “Research & prepare base” to inspect the base and geometry before deciding to render and deliver.

确认按钮：“仍然自动运行 / Run Auto anyway”。打开抽屉、选择 auto、关闭警告均不启动；只有明确确认命令发起请求。风险确认不清 proposed、不写 confirmed，也不构成几何复核。

### V5 订正与验收口径

| 原要求 | 已核实事实 | 实际保证 | 不保证范围 |
|---|---|---|---|
| 未经人核对确认不进入 drawing | `accuracy.ts:88-95` 定义识别口径；`store.ts:575-595` 改写 legacy 几何阻塞；`run.ts:367-371` 写软 issues，服务端不强制拦 drawing | 默认 UI/guided 检索止于 base；有待确认先保存确认；无待确认也等待人显式渲染；保存、确认、刷新均不自动启动 | auto/其他合法客户端调用可能越过核对直至交付；本 Issue 不改变服务端精度与几何闸门 |

V5 状态为“设计闭合（主 agent 裁定）”，不是实施验收通过。验收须保留：

- guided/base 的 run/step/status 证据，证明 base 完成后 run 结束、drawing 未开始。
- 有待核对与无待核对两种停靠截图；无待核对场景刷新/轮询后也不后台启动。
- 确认保存及普通保存均零 run/advance/deliver；纯确认后的失效状态按服务端事实呈现。
- guided/drawing 从 style 与 drawing 两个起点成功、止于 complete/awaiting_review，未交付。
- auto 入口、完整风险警告及明确启动证据；不得以“只会到作图”弱化其交付副作用。
- 取消与修复保存后的动作重算、原 mode/stop_at 恢复证据。

---

## 8. 状态持久化、刷新与并发

### 8.1 刷新恢复与动作重算

1. GET detail，取得 stage/status、steps、outputs、issues、revision、活动 run 与可读 mode/stop_at。
2. 按服务端 spec 重算 `geometryUnverified` 对应待核对数，不恢复浏览器整体批准状态。
3. `msstage/msrun` 只选择查看对象，不覆盖当前任务状态；历史 run 明示“历史运行 / Historical run”。
4. 全局动作绑定最新 task revision，不绑定所选历史图或历史 run。
5. 失效目标可读回退，不触发 PUT/run/advance/确认/deliver。
6. 恢复本地草稿必须绑定 task 与基线 revision；不自动提交，不只替换 revision。
7. 每次保存、取消、回退、运行结束后，从完整优先级重新分派，不保留旧按钮闭包中的失败阶段或运行边界。

统一优先级：

**运行中只取消/观测 → 结果未知先核实 → 冲突先解决 → 草稿先保存 → 真实阻塞/失败 → 当前阶段动作。**

workflow failed 不覆盖草稿优先级。保存把 stage 改为 base 后，原 drawing 重试失效；必须选择合法 base 动作。stage complete/status completed 时根据宿主或独立结果展示成功，不重启。

### 8.2 图片冻结快照与 ≤5s 显示

**唯一方案：模块自存，复用 history snapshot 载荷形状，在 task state 保存 durable pinned 载荷/索引。** history 仍是最近 30 条审计窗口，不是唯一备份；不增加版本系统或并行 spec/brief/options revision。现有缺口见 `types.ts:242-258`、`store.ts:51,364-372,400-420,551-567`、`db.ts:68-77`。

| 项目 | 契约 |
|---|---|
| 身份 | `snapshot_id` 由 `task_id + published_revision + artifact_kind` 唯一定位；published_revision 复用任务发布 CAS 的 revision。每次独立 draft 发布使用其实际发布 revision，不只靠 run_id。 |
| 冻结载荷 | 保存实际 spec、brief、layer_options、layer_doc、semantics、features/sources、图像 sha/尺寸/安全引用、base/registration、实际样式与纹理事实。复用既有载荷形状补足缺项，内容 hash 不构成新 revision。 |
| drawing 描述 | 发布 draft/final 时，模块经平台/契约注入的共享纯 formatter，针对该次冻结 features/sources 生成同图初始描述；模块不 import 宿主 service，不调模型。 |
| 描述算法 | 复用 #125 `map-semantic-annotations.ts:67-97`：feature_id 精确匹配；basis、coordinate_basis 说明、excerpt 与最多 3 个 source 标题组合，≤500 字；keywords 仅 category，无事实则省略。 |
| 发布原子边界 | 先持久保留并校验不可变文件，再一次 state CAS 发布图片引用、冻结载荷和 pin。清除/覆盖旧引用的同次 CAS 保留旧 pin；不假称文件系统与数据库共享事务。 |
| delivery 快照 | 宿主先合成 `manual/name_manual` 保护后的最终语义，再在事务内写版本 params，并回传冻结语义、sources/关联版本；模块发布新 delivery 快照，新 published_revision、同 final sha，原 drawing 快照不变。 |
| 幂等恢复 | 宿主成功而模块登记失败时，按既有幂等键取回同一版本及最终冻结语义后补记；不从当前 props 回算。模块已登记则返回原快照，不额外发布重复版本。 |
| 读取 | detail 给身份与引用；只读 `GET /map-studio/tasks/:id/snapshots/:id` 返回同任务授权范围内冻结载荷及安全 URL。只读展示不得重算描述。 |
| 保留 | 当前/上一版/历史入口/交付/迁移引用的 pinned 载荷独立于 history30 保留；引用文件独立保留，不依赖缓存文件存活。不增 GC。 |
| 历史缺失 | 只使用已持有、可证明同图的记录；缺失显示“此历史版本图层信息未记录 / Layer information was not recorded for this historical version”。不另设宿主历史投影作为第二套快照方案。 |
| 可选描述缺失 | 快照完整但无可用描述事实时显示冻结几何摘要；与整份元数据未发布严格区分。 |
| 人工字段 | `manual` 是描述/关键词人工所有权，`name_manual` 是名称所有权，独立于 source。可标“描述/关键词已人工维护 / Description/keywords manually maintained”，不推断从零撰写作者。 |

master `cdb2a854` 已含 #125，本 #126 分支仍基于 `2d9655b1` 未集成。`map-studio-host.ts:65-69,78-85` 的最终语义冻结缺口仍阻断 G2/G4；人工字段保护不等于历史快照。

**V15 显示时限：**

- 保留原 drawing 的 `render_draft/final_image` 落盘到浏览器实际显示 **≤5s** 要求；不额外扩成所有 pip 产物逐个 ≤5s 的硬指标。
- 同一产物记录实际落盘、detail 首次读到、浏览器加载并可见三个时间戳；包括元数据发布和图片加载，不从 detail 可读时重新计时。
- 既有每 3 秒轮询仅是实现通道，不是通过证明。离开 running 而已知 drawing 产物/冻结元数据尚未齐全时继续只读同步，显示“正在同步成图 / Syncing the rendered image”；明确失败/取消且无待发布产物才结束。
- 自动视图优先本轮 draft/final，其次上一成功图，再空态；draft 标“AI 预览 / AI preview”。固定历史图时不抢选择，提示“新版已就绪 / New version ready”，但提示不能替代自动视图的实际显示验收。
- G2 验证发布、读取、保留全生命周期；G4 验证真实 #125 formatter 生产、最终人工保护语义回传与当前语义变更后旧图不漂移。全部尚未执行。

### 8.3 冲突与多人编辑

冲突入口在编辑区顶部，动作条显示摘要，不藏在 AI 活动抽屉。

| 动作 | 文案：中文 / English | 真实含义 |
|---|---|---|
| keep | 保留我的草稿副本 / Keep my draft copy | 保留隔离副本，不强制覆盖；查看最新事实后显式重新应用 |
| discard | 放弃草稿并使用最新版本 / Discard draft & use latest | 放弃副本，以服务端建立基线 |
| review | 查看冲突内容 / Review conflicts | 对照原基线、本地提交和最新服务端，不自动合并坐标 |

明确 CAS 拒绝时：

> 本次保存因版本冲突被拒绝。画布已恢复服务端版本，修改保留为副本。  
> This save was rejected due to a revision conflict. The canvas shows the server version, and your changes are retained as a copy.

超时后发现内容不匹配时：

> 保存结果与当前服务端内容不一致，可能已被后续修改。请核对冲突副本。  
> The submitted changes do not match the current server content and may have been changed afterward. Review the conflict copy.

后一种情况不得宣称“你的修改未写入”。busy 时只提示活动运行及只读限制；待 run 结束再处理副本。

### 8.4 断线、超时与未知失败

| 观测 | 呈现与动作 |
|---|---|
| 单次轮询失败 | 保留最后已知状态和时间：“连接中断，正在重新获取状态 / Connection lost; retrieving status” |
| 连续约 15 秒读不到 detail | “状态暂不可确认 / Status cannot be confirmed”；只核实，不改 failed |
| 有可靠活动时间且约 90 秒未更新 | “长时间未观察到更新，任务仍报告运行中 / No recent activity observed; the task still reports running”；不是死亡判定 |
| 无可靠心跳字段 | 仅展示最后可见活动，不编造心跳；GET 成功不证明 agent 存活 |
| 保存请求超时 | 按 §6.1 的 revision+整份内容核实；禁止盲重发 |
| run/advance/deliver 响应丢失 | 先查 detail、活动 run 与交付记录；不能只因有幂等键就跳过结果核实 |
| 服务端 failed 且 error_detail=null | 显示 unknown 错误行及原 error/run/阶段，不猜 #124 kind |
| 明确取消生效 | 按 idle/pending 等返回事实恢复；不自动继续下一阶段 |
| 确认失败或阻塞 | 仍先解决结果未知、冲突、草稿，再进入恢复动作 |

15/90 秒是 UI 提示阈值的设计假设，不是服务端失败判据。任何网络恢复、焦点刷新、深链恢复均零写操作。

---

## 9. 配套文案表

以下为 `mapStudio.*` 建议键，不声称已存在；实现时四语同步，本文提供中英文对照。删除旧“准备交付”及独立“整体核对完成/待整体核对”相关键和引用，不保留兼容文案。

### 9.1 阶段、workflow 状态与 step 状态

| key | zh | en |
|---|---|---|
| `mapStudio.stage.brief` | 需求 | Brief |
| `mapStudio.stage.research` | 资料检索 | Research |
| `mapStudio.stage.base` | 底图 | Base map |
| `mapStudio.stage.style` | 质感底纹 | Texture |
| `mapStudio.stage.drawing` | 作图 | Drawing |
| `mapStudio.stage.complete` | 完成 | Complete |
| `mapStudio.status.idle` | 未运行 | Idle |
| `mapStudio.status.running` | 进行中 | Running |
| `mapStudio.status.awaiting_review` | 待复核 | Awaiting review |
| `mapStudio.status.blocked` | 受阻 | Blocked |
| `mapStudio.status.failed` | 失败 | Failed |
| `mapStudio.status.completed` | 已完成 | Completed |
| `mapStudio.stepStatus.pending` | 待执行 | Pending |
| `mapStudio.stepStatus.running` | 进行中 | Running |
| `mapStudio.stepStatus.awaiting_review` | 待复核 | Awaiting review |
| `mapStudio.stepStatus.completed` | 已完成 | Completed |
| `mapStudio.stepStatus.failed` | 失败 | Failed |
| `mapStudio.stepStatus.skipped` | 已跳过 | Skipped |

workflow 与 step 使用不同键空间；pending/skipped 不得出现在 workflow 状态判断中。idle 不译为“从未开始”，因为取消后的任务也可能 idle。

### 9.2 停靠、结果与编辑

| key | zh | en |
|---|---|---|
| `mapStudio.checkpoint.geometryPending` | 还有 {count} 个要素待核对 | {count} features remain to be reviewed |
| `mapStudio.checkpoint.geometryConfirmed` | 当前无待核对要素 | No features currently require review |
| `mapStudio.edit.candidateCount` | AI 候选数：{count} | AI candidates: {count} |
| `mapStudio.checkpoint.baseReady` | 底图已就绪 | Base map ready |
| `mapStudio.checkpoint.readyToRender` | 底图已就绪 · 等待你启动渲染 | Base map ready · Waiting for you to start rendering |
| `mapStudio.checkpoint.deliveryPending` | 成图已生成 · 尚未交付 | Map generated · Not yet delivered |
| `mapStudio.checkpoint.noTexture` | 本次生成不使用纸纹 | No paper texture for this generation |
| `mapStudio.action.researchToBase` | 检索并准备底图 | Research & prepare base |
| `mapStudio.action.confirmGeometry` | 确认几何 | Confirm geometry |
| `mapStudio.action.confirmAndSaveGeometry` | 确认并保存几何 | Confirm & save geometry |
| `mapStudio.action.finishEditing` | 完成编辑 | Finish editing |
| `mapStudio.action.saveGeometry` | 保存几何 | Save geometry |
| `mapStudio.action.saveBrief` | 保存需求 | Save brief |
| `mapStudio.action.renderMap` | 渲染成图 | Render map |
| `mapStudio.action.deliver` | 交付成图 | Deliver map |
| `mapStudio.action.completeStandalone` | 完成成图 | Complete map |
| `mapStudio.action.retryDelivery` | 补交付/重试交付 | Deliver again / Retry delivery |
| `mapStudio.action.renderAndDeliverLayerDoc` | 保存图层并重渲交付 | Save layers, render and deliver |
| `mapStudio.action.verifyStatus` | 核实状态 | Verify status |
| `mapStudio.action.cancelRun` | 取消运行 | Cancel run |
| `mapStudio.action.cancelling` | 正在取消… | Cancelling… |
| `mapStudio.result.agentPreview` | AI 预览 · 非最终成图 | AI preview · Not a final map |
| `mapStudio.result.current` | 本轮成图 · {runId} · 发布 revision {revision} | Current map · {runId} · Published revision {revision} |
| `mapStudio.result.previousRendering` | 上一版 · 正在渲染新版 | Previous version · Rendering a new version |
| `mapStudio.result.geometryMismatch` | 图与当前几何不一致 | Image does not match current geometry |
| `mapStudio.result.optionsMismatch` | 图与当前图层选项不一致 | Image does not match current layer options |
| `mapStudio.result.baseStale` | 底图需要重做 | Base map must be rebuilt |
| `mapStudio.result.empty` | 尚未生成成图 | No map has been generated |
| `mapStudio.result.deliveryRunning` | 交付处理中 | Delivery in progress |
| `mapStudio.result.delivered` | 已交付 | Delivered |
| `mapStudio.result.standaloneCompleted` | 成图已完成（独立任务） | Map completed (standalone task) |
| `mapStudio.result.metadataIncomplete` | 成图元数据未完整发布 | Render metadata is incomplete |
| `mapStudio.result.historyMetadataMissing` | 此历史版本图层信息未记录 | Layer information was not recorded for this historical version |
| `mapStudio.result.syncing` | 正在同步成图 | Syncing the rendered image |
| `mapStudio.result.newReady` | 新版已就绪 | New version ready |
| `mapStudio.semantic.supplementsManual` | 描述/关键词已人工维护 | Description/keywords manually maintained |
| `mapStudio.semantic.nameManual` | 名称已人工维护 | Name manually maintained |
| `mapStudio.edit.manualGeometry` | 已转为人工几何 | Converted to manual geometry |
| `mapStudio.edit.addedToDraft` | 已加入待保存草稿 | Added to unsaved draft |
| `mapStudio.edit.saved` | 已保存 | Saved |
| `mapStudio.edit.previewOnly` | 编辑预览已更新，成图尚未重渲 | Edit preview updated; map not re-rendered |
| `mapStudio.edit.saveUnknown` | 保存结果待确认，请先核实状态 | Save result pending. Verify status first |
| `mapStudio.edit.unsaved` | 有未保存的修改 | Unsaved changes |
| `mapStudio.smoothing.disable` | 关闭平滑 | Disable smoothing |
| `mapStudio.smoothing.overLimit` | 超限 | Over limit |

待核对数统一为 `geometryUnverified`，含 dataset_missing；单独显示草稿 `proposed===true` 时只称 AI 候选数。人工所有权徽标按对应字段显示，不按 source 推断作者。“已交付”须有匹配的 delivery 记录，启动 200 不够。

“本次生成不使用纸纹”只描述新生成政策；所选历史图另按其版本记录显示有/无/未记录。

### 9.3 失败与风险文案

| key | zh | en |
|---|---|---|
| `mapStudio.failure.steps_exhausted` | 本次运行已用完步骤，阶段尚未完成。已有进度可在 AI 活动中查看。 | This run exhausted its steps before completing the stage. Review progress in AI activity. |
| `mapStudio.failure.ended_without_delivery` | 运行已结束，但未提供本阶段要求的产物。 | The run ended without the output required for this stage. |
| `mapStudio.failure.call_error` | 模型调用失败，本阶段未完成。请查看错误后选择重试或切换模型。 | A model call failed and the stage is incomplete. Review the error before retrying or switching models. |
| `mapStudio.failure.rejected` | 操作被拒绝，请先处理列出的问题。 | The operation was rejected. Resolve the listed problems first. |
| `mapStudio.failure.mixed` | 本次运行存在多类问题，请查看详情后选择处理方式。 | This run encountered multiple issue types. Review details before choosing a recovery action. |
| `mapStudio.failure.unknown` | 运行失败，未提供可识别的失败分型。请查看原始错误与运行记录。 | The run failed without a recognized failure category. Review the original error and run history. |
| `mapStudio.connection.possibleInterruption` | 长时间未观察到更新；任务仍报告运行中。 | No updates have been observed for some time; the task still reports running. |
| `mapStudio.connection.lastObserved` | 最后观察到活动：{time} | Last observed activity: {time} |
| `mapStudio.auto.warningTitle` | 自动运行可能越过人工核对并连续执行到交付 | Auto may bypass human review and continue through delivery |
| `mapStudio.auto.confirm` | 仍然自动运行 | Run Auto anyway |

auto 警告正文使用 §7 完整中英文，不能只保留标题。失败横幅同时显示阶段、原 error 或可读 problems 摘要；完整 rounds、调用与失败现场在 AI 活动抽屉。

---

## 10. 假设与遗留

### 10.1 G1–G9 门禁登记

事实已核实、政策已裁定、修订要求已写入均不等于功能通过。本轮未实施、未执行测试或生产验收。

| 编号 | 已知事实/裁定 | 剩余阻断 |
|---|---|---|
| G1｜有界运行 | 当前只有 manual/auto（`routes.ts:84-89`；`run.ts:291-300`） | guided/base 与 guided/drawing、合法起点、持久 mode/stop_at、取消续跑、唯一主动作及同版切换须实测；不建 capabilities/run_stop_at 发现协议或永久 manual 降级。 |
| G2｜图片快照 | history30、日志只有 sha/result，不能保证永久同图输入（`store.ts:51,364-420,551-567`；`db.ts:68-77`） | 按 §8.2 模块 pinned 载荷/索引、同 CAS 保护、独立文件保留、只读 GET 和最终 delivery 新快照实施；drawing/final ≤5s 待实测。 |
| G3｜交付 | complete 执行 pip→构建→交付→completed；deliver 无 CAS、不重渲 pip、不收尾 workflow（`run.ts:264-275`；`routes.ts:141-148`） | advance 异步启动、轮询 delivery 判成功、workflow 独立终态、幂等、失败恢复与独立任务须 E03。 |
| G4｜#125 与宿主投影 | master cdb2a854 已含 #125，#126 仍为2d9655b1；manual/name_manual 契约已知；最终描述未先写版本 params（`asset-semantics.ts:42-62,394-474`；`map-studio-host.ts:65-69,78-85`） | 先集成 #125、逐交集文件保留契约；共享 formatter 注入、宿主最终语义先落版本再回传、真实同图验收；只读 `detail.host.target.description/reference_images` 尚需实现。不是字段未知。 |
| G5｜V5 | 已裁定：默认 UI/guided 保证，服务端仍不强制（`accuracy.ts:88-95`；`store.ts:575-595`） | 证明 base 停靠、要素确认保存不启动、零待核对仍需显式渲染、auto 交付风险警告；不建整体复核键。 |
| G6｜保存 | 首次 options 保存/消费已存在；有 layer_doc 的旧分支会重渲交付（`run.ts:440-467,608-639`；`drawing.ts:87-95`） | 唯一整页 CAS、弹窗零提交、规范化基线与超时核实；默认几何保存拆开旧副作用，专用人工图层按钮明确重渲交付。 |
| G7｜恢复与观测 | 普通异常可能无 error_detail，取消不推进（`run.ts:305-329,586-604`） | 新 run 边界恢复、失败修复后重算动作、历史多轮及新失败 run 完整回看须 E18。 |
| G8｜缓存与迁移 | 缓存已存在但安全性不足；迁移依赖整 state CAS+requireIdle，无共享锁（`geo/base-render.ts:483-643`；`db.ts:168-186`） | 完整键/manifest/sha、失败语义、durable journal、有效状态幂等及回滚再 apply；生产 apply 晚于保护、并发、回滚样本通过。 |
| G9｜深链与编辑 | 顶点无稳定 ID（`services/layer-doc.ts:91,96,101`） | msggeorev 绑定要素已保存坐标 canonical hash，不绑定 task revision；hash 变化即退要素级。全部输入路径、恢复与零写入须实测。 |

### 10.2 已确定的实施边界

- **交付不是同步启动响应。** advance 只启动 complete；轮询对应 delivery 记录核实交付，再观察 workflow 收尾。deliver 成功不等于 workflow completed，不能由前端补写状态。
- **保存副作用必须拆分。** 默认“保存几何”只持久化 spec+options并标失效；专用 `PUT layer-doc` 如保留既有副作用，按钮统一“保存图层并重渲交付 / Save layers, render and deliver”。
- **快照只选模块自存方案。** 复用 history 形状、state durable pin、任务发布 revision；不另设宿主历史快照投影、三套输入 revision 或版本平台。旧数据缺失如实说明。
- **#125 已核实但未在本分支集成。** formatter 真实生产描述且不调模型；manual/name_manual 是字段所有权，不是冻结能力。必须修正宿主事务时序和结果回传，不能读当前 props 补旧图。
- **宿主只读映射唯一。** contract.describe target 扩展 description/reference_images，经 `detail.host.target.*` 返回；不并存 host_info，不拿 notes 或配准 reference_image 替代。
- **默认样式已知。** `styles/families.json` 中 atlas-tint 的 theme_mapping 为 archival（facts-final §8，按 id 精确 JSON 核实）；新样式复用既有 family/theme 字段。旧图与人工文档不自动改写。
- **计数只有一套待核对语义。** 待核对=geometryUnverified，含 dataset_missing；若显示 proposed 数，仅称 AI 候选数。

### 10.3 保留假设与证据要求

15/90 秒连接/活动提示阈值仍为 UI 假设，不是服务端失败判据；无可靠心跳只展示最后活动。草稿恢复绑定 task、基线 revision 和整份提交，恢复零写。

实施证据区分：请求接受、阶段完成、图片落盘、浏览器显示、宿主版本提交、模块 delivery 快照登记及 workflow 完成。统一使用 04 §7、05 §2 的 E01–E18：

- E01–E03：guided 双边界、状态与保存、异步交付。
- E04–E08：历史三政策、迁移、全生命周期快照、drawing/final ≤5s、真实 #125 初始/最终语义冻结。
- E09–E12：阶段布局、完整输入路径、下限/冲突、平滑保存与消费。
- E13–E18：缓存、模块边界及交集、精确基线、坐标 hash 深链、新失败 run 完整回看。

未执行项继续阻断对应门禁；设计文本、调用留痕和缺字段降级均不能代替实测。

