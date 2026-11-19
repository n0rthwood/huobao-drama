Note: plan.defaultOnStartup is ignored in print mode (no interactive surface to review the plan). Use --plan-yolo for a headless plan flow.
Working...
### A. 覆盖判定表

判定针对两份文档**当前文本**；“已覆盖”指设计覆盖，不代表实现或验收已经通过。未提供的 03、05 不作为覆盖证据。

| 条款 | 判定（已覆盖/部分/未覆盖） | 文档小节 | 缺口一句话 |
|---|---|---|---|
| 1. V1 状态表 | 部分 | 01 §9；02 §1–5、§8.1 | 02 主表混用当前 workflow 状态与 step 完成投影，且 guided 范围、运行中动作、交付入口与 01 不一致。 |
| 2. V2 一键检索与模式入口 | 部分 | 01 §8.2–8.3、§10；02 §1.2–1.3、§7 | 默认 manual、抽屉 auto、检索停 base 均明确，但两份 guided 请求契约尚未真正统一。 |
| 3. V3 唯一主动作与 #124 | 部分 | 01 §9.2–9.4；02 §2.2–2.4 | 运行中主按钮分别为禁用进度和取消；`call_error` 分别为重试和切模型重试；交付准备也不一致。 |
| 4. V4 编辑与确认分离 | 部分 | 01 §3.3、§6.4、§10.4；02 §3.1、§4–5 | 语义、文案、失效已写，但 02 允许“保存后全部 confirmed”直接免除整体核对，与 01 相反。 |
| 5. V5 订正验收 | 已覆盖 | 01 §10.4；02 §7 | 已明确限定新版 UI 保障，不声称服务端存在几何确认闸门。 |
| 6. V13 成图身份优先级 | 已覆盖 | 01 §6.1–6.4、§14.2；02 §3.3、§10.3 | 本轮 final/draft、上一版、空态及生成中标签齐全；历史读取不足已列实施前提。 |
| 7. V14 同 revision 与不一致提示 | 已覆盖 | 01 §6.1、§6.4、§7.2–7.3；02 §5、§8.2 | 已禁止拼接最新 spec，并明确同源快照与几何不一致提示。 |
| 8. V15 ≤5s 呈现 | 部分 | 01 §6.5；02 §8.2 | 起算点被改为“可发布／detail 可读取”，且终态后持续同步与只读一次的停止条件冲突。 |
| 9. V16 描述映射与降级 | 已覆盖 | 01 §7.2–7.4、§14.8；02 §3.3 | 锚定、多层共用、无锚定、缺字段及 #125 未合入均有处理。 |
| 10. V17/V18 编辑交接 | 部分 | 01 §4.2、§12、§14.8；02 §6.4 | 已提逆换算和命中，但未明确交接给 03，且缺触摸／笔同口径要求。 |
| 11. V19/V20/V21 保存与验收 | 已覆盖 | 01 §12–13；02 §4.2、§6.1–6.4 | CAS 拒绝不报成功、回滚、预览与重渲区分及三类断言齐全。 |
| 12. V32 深链恢复 | 已覆盖 | 01 §11；02 §6.4、§8.1 | 零业务写入、实体归属、失效反馈、zoom 越界回退均明确。 |
| 13. V33 AI 活动完整回看 | 部分 | 01 §8.2–8.4、§14.3；02 §2.4 | 历史数据不足已识别，但缺“抽查一个失败 run 全部逐轮记录”的明确验收与缺失判定。 |
| 14. V34 验收指向 | 部分 | 01 §10.4、§14.6、§14.8；02 §7 | 已有相关内容，但未明确建立 V1–V5 与 V6–V10 两组独立验收指向。 |
| 15. 结构性张力 1／单一运行契约 | 部分 | 01 §9.3、§10.1–10.3；02 §1.3、§2.2、§7、§10 | `guided` 固定 base、`stop_at` 两边界、manual 串行渲染三种方案并存，文件头“已收敛”不成立。 |

### B. 缺口补写（只给需要补的，可直接粘贴进文档）

#### B1. 明确 01 → 03 的编辑器交接

**插入位置：** `01-information-architecture.md` §3.3「编辑器行为边界」末尾。  
**原文片段：**
> 无 registration 时只允许数值编辑，显示“缺少地理配准，无法在图上拖动”；不猜测坐标。

**新增文本：**

> **交接给 03 的强制契约（V17/V18）：**03 必须展开指针坐标 → viewBox 坐标 → registration 反投影的三级换算；沿用 `eventGeo` 已有的 meet 信箱边距处理，在其外层正确消除新增 zoom/pan 变换，不重复扣除边距。`pointerdown` 命中顶点把手启动顶点拖拽，命中空白底图启动平移；同一手势不得同时改变视口和几何。鼠标、触摸、笔使用同一命中规则。纯 zoom/pan 不触发 `emit('update')`、PUT 或几何 revision 变化。
>
> 03 的验收必须分别覆盖：缩放与平移叠加 meet 边距后的拖点坐标正确；把手拖动只改目标几何；空白拖动只改视口；触摸／笔与鼠标一致；无 registration 时不能通过画布写入地理坐标。提示文案：“拖动把手编辑；拖动空白底图平移。 / Drag a handle to edit; drag the empty base map to pan.”

#### B2. 补齐 V33 的失败 run 抽验

**插入位置：** `01-information-architecture.md` §8.4「请求时序」末尾。  
**原文片段：**
> 关闭抽屉停止观测刷新；主 detail 轮询不受影响。

**新增文本：**

> **V33 验收：**选取一个具有多轮调用的失败 run，随后切换到另一 run，再从历史运行选择器重新打开该失败 run。逐轮核对 observed 所列 rounds、attempts、calls，并逐个展开可用消息；失败原因、problems、steps_used 必须属于该失败 run，不能借用当前任务最新错误。验收记录包含 task/run 标识、逐轮标识及消息读取结果，证明折叠或按需加载没有遗漏记录。
>
> 对应数据未记录时显示“此运行记录不完整，无法完整回看失败现场。 / This run has incomplete records; full failure review is unavailable.” 诚实降级不等于通过完整回看验收；本 Issue 产生的验收样本缺记录时必须补齐读取或记录能力。历史遗留缺失单独登记，不伪造补齐。

#### B3. 显式建立 V34 两组验收指向

**插入位置：** `01-information-architecture.md` §14「本轮遗留与假设」末尾，追加第 9 项。  
**原文片段：**
> 本轮仅为设计，不声称这些行为已经实现或通过验证。

**新增文本：**

> 9. **V34 独立验收指向：**工作流停靠按 V1–V5 验收，依据 01 §9–10 与 02 §1–7 的收敛契约，分别记录检索止于 base、显式几何核对、独立渲染、失败恢复和编辑失效证据。历史兼容另按 V6–V10 验收，不以工作流通过代替：分别验证新任务政策、旧任务显式再生成政策、历史成图及人工 layer_doc 原样保留政策；迁移验证残留识别清单、history snapshot 备份、dry-run/apply 和跳过 running。历史兼容只使用新建专用任务复刻旧状态，不重渲真实历史任务。两组分别给出通过／失败及证据。

### C. 矛盾与收敛

#### C1. 裁定表

下表替换编号对应本节随后给出的**完整替换文本**，不是对未提供的 05 的引用。

| 矛盾点 | 两份文档各自说法（引用小节） | 裁定 | 应替换文本（完整） |
|---|---|---|---|
| guided 范围与渲染请求 | 01 §10 支持 base/drawing；02 §1.3 固定 base，§2.2 用 manual 串行渲染 | 保留两个有界终点；新 UI 不串行补发 style/drawing | C2 全文替换 01 §10.1–10.3；C3 全文替换 02 §1.3；相关引用用 C4 |
| 参数组合 | 01 §10.3 允许 manual/auto 携带 stop_at；02 无此组合 | 只允许 guided 携带 stop_at，消除“单步还是跑到终点”的歧义 | C2、C3 |
| 工作流状态与 step 状态 | 01 §9 按当前 stage/status 判断；02 §2.2 的 completed 行实为 step 完成投影 | 当前 workflow 二元组为主键；step 只提供产物和完成证据 | C5 |
| 运行中主动作 | 01 §9.2 禁用进度，取消在更多；02 §2.2、§4.3、§7 取消为主动作 | 采用 01：运行中主槽显示禁用进度，取消为次动作 | C6 |
| 保存后是否还需整体核对 | 01 §3.3、§10.4 保留整体核对；02 §3.1 末段全部 confirmed 即跳过 | 保留独立 UI 核对；不要求空 PUT，不新增服务端签字字段 | C7 |
| TAB 中途切换 | 01 §3.3 暂停隐藏草稿；02 §6.2 要求先完成或取消 | 允许暂停隐藏，切换零写入 | C8 |
| 调用失败的恢复动作 | 01 §9.4 重试，切模型为次动作；02 §2.4 强制切模型并重试 | 不强迫换模型；无效配置先修复，否则重试 | C9 |
| drawing 完成即交付 | 01 §9.3 区分准备交付；02 §2.2、§4.3 直接交付 | 按真实交付前置判断；未知准备／交付边界不得猜测 | C10 |
| ≤5s 与终态轮询 | 01 §6.5 等待快照继续读；02 §8.2 最终读取一次即停 | 从落盘计时；终态不等于产物已呈现 | C11 |
| 文件头声称“已经收敛” | 01、02 文件头均借 05 宣告统一，正文仍不同 | 删除未经正文支持的声明 | C12 |

#### C2. 完整替换 `01` §10.1–10.3

### 10.1 请求字段、用户动作与执行边界

以下为**本 Issue 新增设计契约，不是现有 API 能力**。唯一有界运行字段为 `stop_at`；不使用 `through`。

端点：`POST /map-studio/tasks/:id/run`。

| 字段 | 值域与规则 |
|---|---|
| `mode` | `manual / auto / guided`；前两者为既有模式，guided 为新增有界执行策略 |
| `stop_at` | 仅在 `mode='guided'` 时必填，且只能为 `base / drawing`；其他 mode 携带此字段、缺失值或非法值均拒绝，不忽略 |
| `expectedRevision` | 当前服务端 revision，沿用既有 CAS；请求被拒不创建 run |
| `through` | 不属于本契约；不得代替 stop_at 或与其并用 |

guided 从当前合法阶段执行，不隐式回退，不为了满足终点重跑已完成阶段。中间阶段成功且允许推进时持续执行；到指定阶段成功结束后终止 run。它不是新的任务默认偏好，也不记录几何确认。

| 用户动作 | 请求／调用 | 起点与成功终点 |
|---|---|---|
| 一键检索／继续检索 | `/run {mode:'guided', stop_at:'base', expectedRevision}` | 当前阶段为 brief/research/base；base 完成即停 |
| 准备底图 | 同上 | 当前阶段为 base；不重跑已完成 research |
| 确认几何 | 既有 spec 确认保存通道；无待写确认字段时仅记录本页显式核对 | 不调用 run/advance/deliver |
| 渲染成图 | `/run {mode:'guided', stop_at:'drawing', expectedRevision}` | 当前阶段为 style/drawing；style 不生成纸纹，drawing 完成即停，不执行 complete |
| 交付成图 | 既有 `/deliver` 客户端调用及 CAS 参数 | 仅在交付前置已满足时显式调用；不得以 guided 或 auto 代替交付命令 |
| 高级自动运行 | `/run {mode:'auto', expectedRevision}` | 仅从 AI 活动抽屉明确启动，保留既有连续推进语义及风险提示 |

`stop_at='drawing'` 不接受 brief/research/base 起点，避免渲染命令跨越检索后的人工停靠；`stop_at='base'` 不接受 style/drawing/complete 起点。非法起点返回可读参数／状态错误且不启动 run；需要重新检索时先由用户执行合法回退。

默认 UI 在底图有效、无草稿／冲突、本次输入已被显式核对后才发送渲染请求。这是 UI 约束，不新增服务端几何确认闸门。

**交付准备边界：**事实未给出 complete 与 `/deliver` 的完整请求副作用。实施必须核对现有客户端契约：若存在已证实不交付的准备调用，可单独显示“准备交付”；否则不得把可能交付的调用标成仅准备。缺少可证明的准备边界时禁用该操作并显示“交付准备接口尚未确认 / Delivery preparation interface is not yet verified”。不得自行假设 `RUN('manual')` 执行 complete 一定只准备而不交付。

### 10.2 成功、失败与取消状态序列

| 执行段 | 必须呈现的状态与产物 |
|---|---|
| guided/base 开始 | 通过既有 busy、subject、CAS 和执行阶段前置校验后创建 run，显示真实阶段 |
| research 完成 | research step completed，进入 base/running；不因软几何提示停住 |
| base 完成 | 发布 base 产物及 bbox，`steps.base.status=completed`；`state.stage=style`、`state.status=awaiting_review`；run 结束，style 尚未执行 |
| 人工核对 | 保存需要写入的确认结果，或在无待写字段时完成本页核对；不启动任何阶段 |
| guided/drawing 开始 | 从 style 或 drawing 执行；style 跳过出图后自动进入 drawing |
| drawing 完成 | 发布本轮 final 及配套快照；drawing step completed；`state.stage=complete`、`state.status=awaiting_review`；run 结束，complete 尚未执行 |

失败、真实受阻、取消生效、`proceed=false` 或指定终点成功完成，任一先到即停止；不得为了达到 stop_at 绕过提前停止。阶段尚未完成不能标为“底图已就绪”或“本轮成图”。

- 失败不自动重试、回退或清空研究进度。base 失败保留已完成 research；恢复动作按 #124 分型及当前前置执行。
- 重试／续跑必须保留原 `mode='guided'` 与 `stop_at`，从返回的合法阶段继续；若编辑／回退已使原边界不适用，先重新判定动作，不盲目重发。
- 取消为请求，不立即假定 run 已结束；显示“正在取消… / Cancelling…”，等待服务端确认后再恢复写操作。
- 取消被执行器确认后不再启动下一阶段；取消确认前已经完成的产物按返回 detail 呈现，不声称回滚。
- 不新增或猜测取消后的 workflow status；活动 run 结束、阶段、保留产物和错误均以 detail 为准。刷新不补发 run。
- `409 workflow_busy` 只刷新并展示活动 run；CAS 冲突进入冲突处理，二者均不自动降级为 auto。

### 10.3 模式兼容与能力发现

| 客户端请求 | 行为 |
|---|---|
| 旧 `{mode:'manual'}` | 保持既有单阶段执行 |
| 旧 `{mode:'auto'}` | 保持按 proceed 连续推进，可能越过未确认几何 |
| 新 `{mode:'guided', stop_at:'base'}` | 成功完成 base 后结束 run |
| 新 `{mode:'guided', stop_at:'drawing'}` | 成功完成 drawing 后结束 run，不执行 complete |
| guided 缺少合法 stop_at；manual/auto 携带 stop_at | 拒绝，不回退为其他模式 |

新任务偏好默认 manual；auto 只在 AI 活动抽屉。新版一键检索固定 guided/base，渲染固定 guided/drawing，均不读取 auto 偏好决定终点。

新增只读能力字段 `capabilities.runStopAt: ('base'|'drawing')[]`，表示服务端已实现的有界终点；缺失按不支持处理。该字段为设计新增，不声称现有 detail 已提供。

能力缺失时显示“当前服务版本不支持有界运行，请使用分步执行。 / This server does not support bounded runs. Use step-by-step execution.” 提供明确的 manual 单阶段动作；style 与 drawing 分别由用户点击，不自动串发，不静默降级 auto。此兼容路径不算一键检索验收通过；正式验收环境必须具备两个终点能力。

运行读取信息必须能恢复本次 `mode/stop_at`；现有 run 数据不足时补充只读字段。旧 run 缺字段显示执行边界未知，不据此猜测或自动续跑。旧客户端无 stop_at 的调用不变；迁移技能调用时显式采用对应有界请求。

#### C3. 完整替换 `02` §1.3

### 1.3 有界运行 API 与兼容契约

以下为本 Issue 新增设计，不是现有能力。使用 `POST /map-studio/tasks/:id/run`，唯一边界字段为 `stop_at`，不用 `through`。

| 字段 | 契约 |
|---|---|
| `mode` | `manual / auto / guided`；manual/auto 保留既有语义，guided 为有界连续执行 |
| `stop_at` | guided 必填，只允许 `base / drawing`；manual/auto 不允许携带；缺失或非法组合拒绝且不创建 run |
| `expectedRevision` | 当前服务端 revision，沿用 CAS |
| 能力读取 | 新增 `capabilities.runStopAt: ('base'|'drawing')[]`；缺失视为不支持，不试探性发起运行 |
| 运行读取 | 必须可读取本次 mode/stop_at；旧 run 缺字段不推测、不自动续跑 |

| 用户动作 | 请求及语义 |
|---|---|
| 一键检索／继续检索 | `/run {mode:'guided', stop_at:'base', expectedRevision}`；允许当前阶段 brief/research/base，从当前合法阶段执行，base 成功完成即停 |
| 准备底图 | 同一 guided/base 请求，从 base 执行，不重跑已完成 research |
| 确认几何 | 既有 spec 确认保存通道；无待写字段时仅记录本页显式核对，不发空 PUT；不 run/advance/deliver |
| 渲染成图 | `/run {mode:'guided', stop_at:'drawing', expectedRevision}`；仅允许 style/drawing 起点，跳过 style 出图后运行 drawing；drawing 成功完成即停 |
| 交付成图 | 既有 `/deliver` 客户端调用与 CAS 参数；必须显式点击且满足交付前置，不用 guided 或 auto 代替 |
| 高级自动运行 | 抽屉内显式 `/run {mode:'auto', expectedRevision}`；保持旧连续推进语义，启动前提示可越过未确认几何 |

guided 不隐式回退；base 边界拒绝 style/drawing/complete 起点，drawing 边界拒绝 brief/research/base/complete 起点。需要重做时先由用户执行合法回退。默认 UI 渲染还要求有效底图、无草稿／冲突及对当前输入的显式核对；这不是新增服务端几何闸门。

成功序列：

1. guided/base：需求若需执行则先执行，research 完成后自动进入 base；base 产物与 bbox 写入后，base step completed，`stage=style/status=awaiting_review`，run 结束，style 尚未执行。
2. guided/drawing：从 style 或 drawing 执行；style 不生成纸纹；drawing final 及配套快照发布后，drawing step completed，`stage=complete/status=awaiting_review`，run 结束，complete 尚未执行。
3. 两种成功终点均不调用 `/deliver`，也不自动确认几何。

失败、真实受阻、取消生效、`proceed=false` 或终点成功完成，任一先到即停。失败不自动重试、回退或清空进度；重试／续跑保留原 mode/stop_at，并重新检查当前阶段是否合法。base 失败保留已完成 research。busy 只刷新活动 run，CAS 冲突进入冲突处理，不降级 auto。

取消请求后显示“正在取消… / Cancelling…”，等待服务端确认。取消被执行器确认后不再启动下一阶段；此前已完成产物按 detail 保留事实展示。不猜测取消终态、不宣称回滚、不在刷新后补发请求。

complete 与 `/deliver` 的准确准备／交付副作用尚未被事实底座展开。实施必须核对既有客户端：只有已证实不交付的调用才能标“准备交付”；可能产生交付的调用不得这样命名。边界无法证明时禁用并显示“交付准备接口尚未确认 / Delivery preparation interface is not yet verified”，不得假定 manual complete 只准备、不交付。

兼容规则：

- 旧 manual 无 stop_at 仍只执行一个阶段；旧 auto 无 stop_at 仍按 proceed 连续推进。
- 新任务默认 manual；auto 仅在 AI 活动抽屉。一键检索永远 guided/base，渲染永远 guided/drawing，不受 auto 偏好影响。
- 缺能力时显示“当前服务版本不支持有界运行，请使用分步执行。 / This server does not support bounded runs. Use step-by-step execution.” 提供明确 manual 单阶段动作，style/drawing 分别点击，不自动串发、不降级 auto。
- 兼容分步路径不算一键检索验收通过；正式验收必须具备 base/drawing 两个边界。
- 老 run 缺 mode/stop_at 时显示边界未知。新运行必须能恢复边界，不能依赖浏览器内存。

#### C4. 同步删除并存的运行方案

以下文本分别替换相关原段，避免只改 API 小节、主表仍指向旧方案。

**02 §1.2 的 guided 行：**

| 模式 | 谁触发 | 一次执行范围 | 自动推进终点 | 默认与入口 | 风险/边界 |
|---|---|---|---|---|---|
| `guided`，本 Issue 新增 | 人点击一键检索／准备底图／渲染成图 | 按 §1.3 的合法起点与 stop_at 执行 | base 或 drawing 成功完成即停，也可因失败、受阻、取消或 proceed=false 提前停止 | 不是持久模式开关；任务仍默认 manual | 不确认几何、不执行终点之后的阶段 |

**01 §9.3「渲染入口建议」两段、§14 第 1 项；02 §2.2「渲染按钮跨越 style 的约定」、§3.2 调用行、§4.3 第 7 步、§7“人点击渲染”行的对应说明，分别替换为：**

> 渲染成图使用 `/run {mode:'guided', stop_at:'drawing', expectedRevision}`，仅从 style/drawing 启动，成功完成 drawing 后结束 run，不执行 complete。不得串行补发 manual style/drawing 或使用 auto。缺少有界能力时只提供分别点击的 manual 单阶段兼容入口。

**02 §7“点击”请求单元格：**

> `POST /run {mode:'guided', stop_at:'base', expectedRevision}`。

**02 §2.2 的 guided 自动终点说明：**

> brief/research/base 中出现的 guided 均指 guided/base；style/drawing 中出现的 guided 均指 guided/drawing。style 成功后继续 drawing，drawing 完成即停。complete 不属于 guided 执行范围。

**02 §2.4 末段及 §10 第 6 项中的恢复边界说明：**

> 重试／续跑保留原执行策略与边界：guided/base 仍止于 base，guided/drawing 仍止于 drawing；先核对返回阶段合法性，不因失败改用 auto。

**02 §10 第 1、2、4 项分别替换为：**

> 1. 新增有界运行能力按 §1.3 实施；能力字段固定为 `capabilities.runStopAt`，不再另设 `guidedToBase`。
>
> 2. style → drawing 由 guided/drawing 服务端有界执行，不再依赖前端 `/advance` 串行补发。complete 与 `/deliver` 的副作用边界仍需核对；未经证明不得将可能交付的请求称为“准备交付”。
>
> 4. 新 run 必须可读取 mode/stop_at，以便刷新后解释边界；旧 run 字段缺失时显示未知。不依赖浏览器内存决定续跑，不要求新增未经核实的停止原因字段。

#### C5. 明确状态表判定主键

**替换 02 §1.1 末段及 §2.2 表前关于表格含义的说明：**

> 主动作以当前 `state.stage × state.status × mode` 为判定主键。§2.2 中 `brief/research/base/style/drawing · completed` 均为对应 `steps[stage].status=completed` 的完成事实，`style · skipped` 也仅为 step 事实；它们不代表当前 workflow status。
>
> 先匹配当前 workflow 状态：running 显示禁用进度；failed 按 §2.4；blocked 处理真实阻塞；complete/completed 查看交付记录或成图；非 complete/completed 视为异常组合，只提供刷新与查看现场。idle/awaiting_review 再按冲突、草稿、有效成图、底图及显式核对状态决定动作。mode 仅决定明确启动命令的执行策略，不能使静止页面自动推进。
>
> 当前指针已前移时使用当前阶段行，上一阶段 completed 只用于证明产物已完成。不得把“research step completed”显示成当前 research/completed，也不得把 `pending/skipped` 当作 workflow status。

#### C6. 运行中唯一主槽

**替换 02 §2.2 各 running 行主按钮、§4.3 第 1/7 步及 §7 中“主动作改取消”的对应文字：**

> 运行中动作条主槽显示禁用的真实阶段进度：“正在检索… / Researching…”、“正在准备底图… / Preparing base map…”或“正在渲染… / Rendering…”。“取消运行 / Cancel run”放次级菜单，不与进度主槽并列主色按钮。取消请求未获确认前不恢复保存、确认、渲染或交付。

#### C7. 整体核对不能由保存副作用代替

**替换 02 §3.1 末段：**

> 服务端全部要素 confirmed 不等于本页已经完成整体核对。UI 使用本地 `reviewedInputKey` 记录一次显式“确认几何”对应的 spec、brief 及有效底图输入身份；该字段不写服务端、不进入 URL、不构成服务端闸门。输入身份无法稳定取得时使用本页已保存输入快照比较，不能证明一致即失效。
>
> 点击确认时，有未确认要素则走既有 CAS 保存，成功后记录返回输入身份；没有待写字段则不发空 PUT，只记录本次用户核对。两种情况都不启动渲染。普通编辑保存即使使所有要素 confirmed，也不能自行设置此记录。
>
> spec、brief、范围或有效底图身份变化清除此记录；确认动作自身的成功响应可建立新的记录。刷新后不能证明仍有效时重新要求核对。文案：“要素均已确认，请完成整体核对。 / All features are confirmed. Complete the overall review.”
>
> 全文动作表中的“几何已确认、可渲染”必须同时满足有效整体核对；服务端未确认数为零只表示要素字段状态。

#### C8. TAB 切换保留未完成形状

**替换 02 §6.2 的 TAB 切换条目：**

> 切换地点／线／面 TAB 立即切换硬显隐：只画当前类别，底图保留。各类选中态和草稿分别保留；未完成线／面草稿暂停并隐藏，返回该 TAB 后继续，不要求先完成或取消，不隐式提交。暂停草稿仍计入未保存修改，阻止全局确认、渲染及交付，直至用户明确保存或放弃。

#### C9. `call_error` 不强制换模型

**替换 02 §2.4 的 `call_error` 行：**

| kind | 唯一主动作 | 次动作 | 禁止行为 |
|---|---|---|---|
| `call_error` | 配置有效：重试当前阶段 / Retry stage；配置无效：修复模型配置 / Fix model configuration | 切换模型 / Switch model；查看调用错误 / View call error | 打开或保存模型配置不自动重试；不强制换模型，不自动清空进度 |

#### C10. 成图完成与可交付分开

**替换 01 §9.3 中准备交付的调用说明，以及 02 §2.2 drawing completed、complete awaiting_review 的主动作说明、§4.3 第 8 步：**

> drawing 完成只证明本轮成图存在，不证明交付准备已完成。动作必须按真实产物与既有交付前置判定：前置全部满足时显示“交付成图 / Deliver map”，点击才调用既有 `/deliver`；仍需准备且存在已证实不交付的准备调用时显示“准备交付 / Prepare delivery”。准备／交付副作用尚无法证明时禁用操作并说明接口前提，不自动执行 complete，不把 `complete/awaiting_review` 单独当作可交付证据。交付成功以返回交付记录为准。

#### C11. ≤5s 的起算点与停止条件

**替换 01 §6.5 全部条目及 02 §8.2 前三条：**

> 运行中沿用每 3 秒 detail 轮询。V15 的计时起点是对应产物落盘时刻，终点是浏览器实际加载并显示该产物；要求间隔 ≤5 秒。detail 发布延迟、轮询等待和图片加载均包含在内，不能从“可发布”或“detail 已可读”重新计时。记录落盘、detail 首次读到、图片加载完成三个时间戳；超时如实判为未达标。
>
> status 离开 running 不足以停止同步。已知产物应存在但尚未取得对应快照时，继续只读轮询并显示“正在同步成图 / Syncing the rendered image”；读取失败显示连接错误，不把旧图当作本轮成功。明确失败／取消且无待发布产物时才按真实终态结束等待。
>
> final 与 run/revision 及同源图层引用应原子发布，消除终态已到而快照不可读的窗口；这是设计要求，不声称现有接口已经保证。draft 始终标 AI 预览，不能因画面完整升级为 final。用户显式停留历史快照时不抢走选择，但须在相同时间要求内显示“新版已就绪 / New version ready”；自动视图验收以新图实际显示为准。

#### C12. 文件头注记

**分别替换 01、02 文件头有关“已收敛／并非冲突／见 05”的注记：**

> 注：有界运行采用 `mode='guided'` 与必填 `stop_at='base'|'drawing'`。一键检索止于 base，显式渲染止于 drawing；交付另走既有 `/deliver`。01 §10 与 02 §1.3 使用同一契约，动作表不得保留固定 base 的 guided 定义或前端串行渲染方案。此为新增设计，不是现有服务端能力。

### D. 事实错误（与 facts.md 冲突）

| 文档说法 | facts 中的事实 | 证据 file:line | 修正文本 |
|---|---|---|---|
| 01 §6.5 从“产物可发布时点”计 ≤5s；02 §8.2 增加“detail 可读取”条件 | V15 从产物落盘开始计算，不允许排除发布延迟 | `facts.md:42` | “从产物落盘至浏览器实际显示 ≤5s，包含 detail 发布、轮询与加载延迟。”完整规则用 C11。 |
| 02 文件头：“complete 阶段内含交付，auto 会连交付一起跑” | facts 列出 complete、pip、交付与 `/deliver`，但没有展开足以证明 auto 必定创建交付的调用序列 | `facts.md:130–136` | “auto 可继续进入 complete；complete 与 `/deliver` 的准确副作用边界尚未给出，不据此断言自动交付。”删除确定性推断，按 C2/C3 核对实施前提。 |
| 01 §9.3 将 `RUN('manual')` 执行 complete 当作准备步骤；02 §2.2 将 complete running 解释为可能准备 | facts 未证明 manual complete 是无交付副作用的准备调用 | `facts.md:136、139` | “只有已证实不交付的调用才能标为准备交付；未证明时不得发送。”用 C10。 |
| 02 §3.1 在保存后全部 confirmed 时直接显示已确认并允许渲染 | confirmed 可由坐标保存副作用产生；V2 要求人核对后显式渲染，V4 要求编辑与确认分离 | `facts.md:23–25、144、179` | “字段 confirmed 与整体核对分开；没有待写字段可免空 PUT，但不能免显式 UI 核对。”用 C7。 |

其中 complete／auto 两项属于**把事实未证明的调用副作用写成确定行为**，不是已经证实服务端行为相反。其余跨文档设计冲突列在 C，不冒充仓库事实错误。

### E. 无需修改的确认（≤6 条）

1. **V5 服务端边界正确：**01 §10.4、02 §7 已明确 #111 后不存在未确认几何阻止 drawing 的闸门，不需要再增加一套事实校正。
2. **成图身份设计足够：**01 §6 区分 draft、final、previous、delivered，并明确 revision 不等于当前 task revision；历史读取不足也没有伪装成现成能力。
3. **图层描述降级完整：**01 §7 已覆盖同源、锚定失效、多层共用及 #125 未合入，不应为了描述缺失自动改写历史 layer_doc。
4. **保存失败契约完整：**02 §6 已覆盖 CAS 冲突、明确拒绝、超时结果未知、草稿副本与刷新一致，不需要另建保存通道。
5. **深链零写入完整：**01 §11 已覆盖实体归属、失效回退、zoom 钳制及 hydration 禁写；不应把恢复动作改成自动保存或续跑。
6. **基本失效口径正确：**02 §5 已区分普通几何编辑、范围／brief 变化与显式回退，不把回退清理列表套给所有保存路径。
