# 设计任务的事实底座（所有轮次共用；只含已核实事实，不含设计结论）

你（Astra）是本次专项设计的唯一设计主体。以下是必须遵守的约束输入与已核实现状。仓库证据已给出 file:line，你不要自行调查仓库；把这里当作唯一事实来源。凡事实不足处，按「假设」显式标注，不要假装已核实。

## 0. 任务性质

huobao-drama 的「地图工作室」（module map-studio）要做 UI/UX 整体重设计，Issue #126，阶段 0 只产出设计文档，不写实现代码。用户原话要点：

1. 整体必须完全重新设计，按实际工作流程与人的注意力组织界面。
2. 人的工作流：看到资产基本信息、参考图、描述 → 点一下「检索/调研」，AI 自动扩展点线面并填入 → 看到都被填上 → 底图已就绪 → 人核对点线面（改、确认）→ 渲染出图。
3. agent 信息/日志/过程不得默认铺满主界面：收进「AI 活动」入口，点开才看。
4. 主界面必须有结果：当前渲染图（用户现在不知道生成了没有）、每个图层的描述可查看。
5. 底图与纸纹不必每次生成，做成模板调用；底图范围按语义与调研结果划定。
6. 制图主题：用户裁定「没有真正使用就别放在这里，都按默认来，主打简单」——移除任务级主题选择，固定默认主题。
7. 点线面编辑器重做，拖拽所见即所得保留：(a) 直接删点、点密时可 zoom in 精调；平滑偏离警告要可理解可操作；(b) 点/线/面做成 TAB，同一时间只显示一类，组件占地更大、放出更多信息；点要素可弹窗列出全部点，逐点改坐标/删除并直接保存、即时上图；线/面每个条目内都有「完成编辑」按钮。

明确不做：不改分镜侧引用机制；不改地图几何校验/精确度闸门的服务端口径；不引入新底图数据源；不做「底图色板随主题变」；不自动替人确认几何；不自动改平滑强度（按钮=人的显式动作）；不新增宿主资产名称/描述写权限。

## 1. Issue #126 修订 v2 的约束条款（编号供验收映射引用；设计必须逐条覆盖）

### 一、工作流闭环
- V1 必须产出「服务端阶段 × 运行状态 × manual/auto」状态表，逐项写清：启动动作、自动推进终点、人工停靠点、确认含义、编辑后的失效关系。
- V2 一键「检索/调研」= 推进到 base 就绪即停靠（research→base 自动衔接，base 完成即停，无论 auto/manual；drawing 必须等人核对几何后显式触发）。auto 模式保留为高级选项（AI 活动抽屉内），默认 manual。
- V3 每个人工停靠点（几何确认、底图就绪、成图待交付）在动作条上是唯一主动作；进行中/失败/回退状态的动作与 #124 分型横幅一致。
- V4 「完成编辑」（结束局部草稿写回 spec）与「确认几何」语义分离并在文案上区分；编辑后失效关系（成图标过期、底图是否重取）按服务端既有口径呈现。
- V5 验收：一键调研实测推进到 base 停靠；「未确认几何不得进入 drawing」——注意：见第 5 节事实校正，当前服务端并不阻塞，设计不得声称服务端闸门存在。

### 二、历史兼容三政策（必须分开写，不可合并成一件事）
- V6 新任务：默认主题 atlas-tint，无纸纹，底图走缓存。
- V7 旧任务再次生成：要素样式按默认主题重建；旧 texture_image 不再参与合成。
- V8 已有历史成图与人工 PUT 的 layer_doc 原样保留，不重渲不改写；只有用户显式重做才按新政策。
- V9 残留识别：outputs.texture_image.provenance.source='diffusion-texture' 且任务 base 为 #107 后 renderer（provenance.renderer 含 relief）或 texture run_id 早于任务最近 base run；迁移脚本逐条列清单、备份原字段到 history snapshot、dry-run 后 apply、在飞任务（status running）跳过。
- V10 历史兼容验收用专用样本任务（新建测试任务复刻旧状态），不重渲真实历史任务。

### 三、编辑器两处需求差异（不是设计自由项）
- V11 地点 TAB = 完整编辑能力：列表逐条名称/经度/纬度输入 + 删除 + 保存即时上图；另提供「全部地点」弹窗批量查看/编辑（与线/面顶点弹窗同构）。验收分别覆盖地点列表写入与线/面顶点写入。
- V12 类别显隐 = 硬规则：当前 TAB 只画当前类要素，其余类**不画**（底图保留）；切换 TAB 即切换显隐。阶段 0 不得弱化。

### 四、成图快照身份
- V13 主成图视图数据源优先级：本轮 render_draft/final_image（带 run_id + revision）> 上一次成功图（明确标「上一版」）> 空态。生成中保留旧图必须标「上一版 · 正在渲染新版」。
- V14 图层查看器读取与所选图片同一 revision 的 layer_doc/语义（成图 provenance 记录来源）；spec 已编辑而图未重渲时标「图与当前几何不一致」。
- V15 「立即显示」定义：产物落盘后前端轮询任务详情（既有 detail 刷新通道）≤5s 内呈现；验收测刷新延迟。
- V16 图层描述对应规则：锚定层 → 其 semantic_id 的要素 description（#125 契约：semantics.points/lines/regions[].description?: string, keywords?: string[]，条目级 manual 标记）；多层共用要素 = 各自显示同一描述；无锚定层显示图层自身 name/类型/几何摘要；缺字段降级为几何摘要，不报错。#125 未合入时查看器先按缺字段降级运行，合入后自动生效。

### 五、编辑通道约束
- V17 zoom/pan 后指针→viewBox→registration 反投影三级换算（现有 eventGeo 已处理 meet 信箱边距，zoom 在其外层加变换）；行为测试覆盖「缩放后拖点落预期坐标」「纯 zoom/pan 零几何写入」。
- V18 顶点拖拽（pointerdown 命中把手）与空白平移（命中底图）按命中目标区分；触摸/笔同口径。
- V19 数值编辑/删点/拖拽共用 cloneSpec→markManual→emit('update')→页面保存 PUT（CAS）；服务端拒绝/409 时 toast 错误并回滚本地草稿，不得显示保存成功。
- V20 「即时上图」= 编辑预览（SVG 覆盖层）即时更新；服务端成图重渲是显式动作，两者文案区分。
- V21 验收断言：点数下限拒绝有反馈；CAS 冲突不覆盖较新数据；保存后刷新一致。

### 六、建议强度（已核实算法）
- V22 一键降强度直接采用 suggestedStrength = 14 步二分求「偏离 ≤ 容差」的最大强度，向下取 0.05 档，<0.05 归 0（关闭）；suggested=0 时按钮文案为「关闭平滑」；不存在非零可行解时如实显示只能关闭，不造假修复。
- V23 显示：偏离/上限各保留 1 位小数；舍入后相同时追加「（超限）」标记与精确值 tooltip。
- V24 验收：阈值两侧案例、舍入相同案例、点击后 deviationProblems 复算为空（或剩余段如实列出）、刷新恢复。

### 七、底图缓存
- V25 缓存键 = bbox + 像素尺寸（不是画幅）+ 投影 + DEM/NE/OSM manifest 指纹 + renderer 版本 + 叙事河豁免集（exemptRivers/namedRivers 参与键）；只缓存纯底图，不含任务要素。
- V26 原子写入（tmp+rename）+ sha256 完整性校验，损坏即重建；并发同键用进程内单飞。
- V27 验收：完整键一致才命中；manifest/renderer/豁免集任一变化不误复用；命中证据 = 缓存键 + manifest 记录 + 产物 sha 一致；耗时仅参考。

### 八、范围与写权限
- V28 实际范围 = map-studio 前端重设计 + 模块内样式解析固定/底图缓存/texture 迁移脚本 + 技能提示词主题分支简化；不是「仅前端」。
- V29 资产信息区「可编辑」= 仅既有 brief 编辑能力（subject/era/location/purpose/notes/reference_image/detail_level/schematic/base_mode，经 writeBrief）；不新增宿主资产名称/描述写权限，不突破模块边界（前端只用 /map-studio API，不 import 火宝业务模块，#99 边界测试必须继续通过）。
- V30 与 #125 集成契约见 V16；两 Issue 文件不相交；合并顺序 #125 先。

### 九、验收收紧
- V31 新增关键行为测试必须通过（zoom 坐标换算、类别显隐、地点/顶点写入、CAS 冲突、缓存键）；基线失败名单（后端 ~10、前端 ~18）用于识别回归。
- V32 深链验收追加：恢复不触发保存/生成/确认/交付；失效实体与越界 zoom 参数可读回退。
- V33 AI 活动抽屉验收 = 历史运行、多轮调用、失败现场可完整回看（抽查一个失败 run 的逐轮记录）。
- V34 工作流停靠验收见 V1-V5；历史兼容验收见 V6-V10。

## 2. 前端现状（已核实）

单页前端 `frontend/app/map-studio/pages/task.vue`（1203 行），自上而下顺序（行号近似）：
1. 面包屑 + `MapHostHeader`（宿主资产标题/类型）(行 3-6)
2. `header.mw-head`：阶段 chip、状态 chip、revision chip、manual/auto 切换（MODES）、刷新 (行 8-29)
3. hint 文案、CAS conflict 提示（keep/discard 两个按钮）、error、`detail.error_detail` 失败分型横幅（kind = steps_exhausted / ended_without_delivery / call_error / rejected / mixed；#124 提供切换模型重试/续跑/清空等动作）(行 31-75)
4. 阶段轨 `ol.mw-rail`：每阶段一行 + 状态 + 回退按钮（每个可回退目标一个按钮，回退上限 2 次）(行 79-90)
5. `MapStagePanel`：当前阶段输入/输出事实、issues（blocking/soft）、研究要素确认面板 `#map-pending-geometry` (行 91)
6. `MapAgentProcess`：逐轮 agent 过程与调用列表、筛选 (行 92)
7. `MapDeliveries`：交付历史 + 交付按钮 (行 93)
8. 区块 `mw-now`：当前工作、下一步文案、blocking/soft issues、最近一次被拒原因、草稿脏提示，以及动作条：运行（runLabel=自动跑|逐步跑）、推进/批准（advanceLabel）、取消、图层编辑器、文本模型选择、图像模型选择 (行 94-166)
9. `MapAgentRounds`：逐轮 agent 记录，默认展开在主界面（行 168-175）
10. brief 编辑块（`MapBriefForm`，含保存/放弃）(行 177-193)
11. 几何块：标题 + 保存/放弃 + `MapGeoEditor` (行 195-215)
12. 结果块：`MapResults`（outputs.final_image 等卡片、对比、provenance、KMZ 下载）(行 217-228)
13. 历史块：revision/action/actor 列表 (行 230-243)
14. `<Teleport to="body">` 大图预览 overlay（关闭只清 msview）与图层编辑器 `MapLayerEditor`（关闭只清 mslayer）(行 245-290)

其他组件（`frontend/app/map-studio/components/`）：`MapBriefForm.vue`(207)、`MapGeoEditor.vue`(912)、`MapResults.vue`(307)、`MapAgentRounds.vue`(186)、`MapAgentProcess.vue`、`MapStagePanel.vue`、`MapStylePicker.vue`、`MapModelPicker.vue`、`MapCalibration.vue`、`MapDeliveries.vue`、`MapPipResults.vue`、`MapLayerEditor.vue`、`ModuleSettings.vue`、`MapHostHeader.vue`、`NewTaskForm.vue`。

`MapBriefForm.vue` 字段：subject/era/location/purpose/notes（TEXT_FIELDS，均为单行 input）、detail_level（select）、schematic（checkbox）、`MapStylePicker`（行 39，任务级主题选择，要移除）、base_mode（program/earth/image 三张卡片）、reference_image（`MapCalibration`）、AI 补全标注（inferredBadge/inferredBasis）。

`MapGeoEditor.vue` 现状（912 行）：
- 顶部工具条 `TOOLS = ['select','place','route','region']`（行 291）+ 草稿的「完成（N 点）」与取消（行 18-22）；
- 画布：`<img>` 底图 + `<svg>` 覆盖层，`viewBox="0 0 W H"` 铺满容器，`preserveAspectRatio="xMidYMid meet"`（行 34-44）；**无 zoom/pan**；
- 顶点把手：`@pointerdown.stop="startDrag(...)"`，`@dblclick.stop="removeVertex(...)"`（行 59/88 等），半径 `unit * 2.4`，`unit = max(W,H)/400`（行 351），随画布缩放而变；移除顶点是双击，无可见删除按钮；线 ≤2 点 / 面 ≤3 点静默拒绝（minPoints 行 352）；
- 拖拽仅 select 模式生效（startDrag 行 675）；画线/画面模式下顶点不响应；
- 中点把手 `insertMidpoint`（行 593）选中即铺满整条边；
- 坐标换算 `eventGeo`（行 623）：像素 → 反投影 → 经纬度，已处理 meet 信箱边距；
- 地点列表：名称 input + 经度/纬度 number input（行 150-155）+ 删除按钮 + 「示意」徽标 + 接受按钮（accept，行 751）；线/面条目：名称、点数文本、平滑开关/滑杆、偏离警告、`datasetBadge` 徽标（行 156/214，静态 span，形似按钮）、接受、继续编辑此形状、删除；
- 偏离警告文案由 `deviationWarning()` 生成，滑杆默认强度：非数据集要素 1；容差口径在后端 `render/smooth.ts:205-209`：`max(6px, 长边×0.4%, 段长×12%)`（SMOOTHING_LIMITS），后端把偏离/上限四舍五入成整数显示 → 出现「偏离 18px 上限 18px」的困惑；
- 无 registration 时只能按数值编辑，不猜像素映射（组件注释）。

深链：`frontend/app/composables/useQuerySync.ts` 有 `DEEPLINK_KEYS`，地图相关键：
- `mapStudioList: ['msq','mshost','mscreate']`
- `mapStudioRun: ['msstage','msrun']`
- `mapStudioCall: ['mscall']`
- `mapStudioCallFilter: ['mscf']`
- `mapStudioAgent: ['mslayer','msround']`
- `mapStudioLayer: ['mssel']`
- `mapStudioGeo: ['msgeo']`（已保存几何要素 kind:id，不含坐标草稿）
- `mapStudioPreview: ['msview']`（base|texture|final|calibration）
#86 全局规则：UI 状态都要可深链；恢复不得触发写操作；失效目标要可读反馈。

前端 API 只经 `/map-studio`（`frontend/app/map-studio/api.ts`），不 import 火宝业务模块；边界测试 `backend/tests/map-studio-boundary.test.mjs`（实际路径见仓库 tests）。

locales：`frontend/app/locales/{zh,en,ja,ko}.json` 四语，`mapStudio.*` 文案树。

## 3. 服务端现状（已核实）

阶段与状态（`backend/src/modules/map-studio/types.ts`）：
- `MAP_WORKFLOW_STAGES = ['brief','research','base','style','drawing','complete']`（行 18）
- `MapWorkflowStatus = 'idle'|'running'|'awaiting_review'|'blocked'|'failed'|'completed'`（行 30）
- `MapStepStatus = 'pending'|'running'|'awaiting_review'|'completed'|'failed'|'skipped'`（行 32）
- 阶段 label 见 `STAGE_LABEL`。

推进与停靠（`run.ts`）：
- `runStages` 后台循环：`const outcome = await executeStage(...); if (!outcome.proceed || mode !== 'auto') break`（行 291-300）。即 **manual 只跑一个阶段就停**，auto 连续跑到某阶段 `proceed=false` 或结束。
- `finish()`：阶段完成写 step completed，`ctx.state.stage = next ?? 'complete'`；`ctx.state.status = next ? (mode === 'auto' ? 'running' : 'awaiting_review') : 'completed'`（行 192-199）。blocked 时 `status='blocked'`。
- research 阶段恒 `proceed: true`（行 226）：未核验/示意几何只是 soft issues，不阻塞。
- base 阶段恒 `proceed: true`（行 240），产出 `outputs.base_image`（含 width/height/run_id/provenance/registration）、`outputs.kmz`、`outputs.pip`，并改 `mapSpec.bbox`。
- style 阶段 `outputs.texture_image = null`（行 244，#107 后恒跳过出图）。
- drawing 阶段：`render_draft` 是 agent 预览工具（`drawing.ts:321-322`，"用最终渲染链预览当前草稿，不消耗轮次"），阶段结束 `finish` 写 `outputs.final_image`（含 path/width/height/source='map-drawing'/run_id/provenance{map_style, registration, warnings, region_composition, omitted, base, base_mode, texture, background, attribution}）、`outputs.layer_doc`、`outputs.layer_options`。
- complete 阶段：pip 细节渲染、交付（`MapDeliveries`/`/deliver`），交付版本 = sys_task id；`ctx.state.stage='complete'; status='awaiting_review'`（行 630）。
- 回退：`applyRollback`，上限 `MAP_MAX_ROLLBACKS`（2）；回退到 ≤ base 时清 `base_image/kmz/pip`，总是清 `final_image/layer_doc`，受影响的 step 置 pending（行 137-163）。
- run 启动：`startRun` 拒绝已有活动 run（409 workflow_busy）、已完成任务（already_completed）、缺 brief.subject；base/drawing/complete 需要 mapSpec；base/drawing 需要可看图的文本配置（vision_config_unavailable）；style 可 skip。
- 意图：`/tasks/:id/run` {mode} 与 `/tasks/:id/advance` 两个端点（routes.ts:85/90）。**当前没有「跑到某阶段就停」的参数**——要实现 V2 的一键「检索到 base 停靠」，需要模块 API 形状新增（例如 mode='guided'/through='base'），属于 Issue 允许的「少量模块 API 形状」。

编辑与失效（`saveMapWorkflowDraft`，run.ts:440-520）：
- 只有 layer_doc 存在且 spec/brief 未变时走 `saveMapLayerDoc`（layer_options 变化会清 `final_image`，行 466）。
- brief 变化：只换主题（map_style/style）且 base 已完成时 restart='base'，否则 restart='brief'。
- spec 变化：逐要素比较坐标；`changed` 的要素 → `origin='manual'`、删 `proposed`、`verification=confirmed`、删 `dataset_ref`；坐标未变但 `proposed!==true` 的 → `verification=confirmed`。研究 features 同步。
- extent/bbox 或 brief 变化会回 base（底图重做）；几何变化本身只让成图过期（UI 用「图与当前几何不一致」呈现）。
- CAS：所有写操作带 `expectedRevision`；冲突抛 `MapStudioStaleError`/`MapStudioConflictError`，UI 有 conflict 提示与 keep/discard。

几何核验（`accuracy.ts:88-95`、`store.ts:575-592`）：
- `geometryUnverified(spec)` 返回 `proposed===true` 且未 manual/未 verified/未 confirmed 的要素（含 dataset_missing 的）。
- **#111 已把「仅因 geometry_unverified 而 blocked」的旧闸门读成「准备好进 base」**（store.ts:575-578 注释 "Legacy #99 gate: a research stage blocked only by geometry_unverified is no longer blocked (#111)"）；issues 里的 `geometry_approximate/geometry_missing` 均为 `blocking:false`。所以当前 **未确认几何不阻塞 base/drawing**；它是软提示 + 人工停靠点（UI 层）。

平滑（`render/smooth.ts`）：
- 容差：`segmentLimit = max(max(minPx, frameRatio*max(W,H)), segmentPixels*segmentRatio)`；`SMOOTHING_LIMITS` 值 = 6px / 0.004 / 0.12（行 205-209 与常量）。
- `suggestedStrength`：14 步二分、`Math.floor(low*20)/20`、`<0.05 → 0`（行 227-237）。
- `deviationProblems` 返回每段 `{segment, deviation, limit, suggested}`；strength 必须是 0..1 有限数字，代码从不自动改强度（throw RangeError 文案「不会自动改强度」）。
- 现有 UI 用 `Math.round` 呈现整数 → 18px/18px 困惑。

底图与缓存：
- `renderReliefBase`（geo/relief-render.ts:341），色板固定 `RELIEF_PALETTE`（行 30-38：sea [203,217,225]，hypso 四档暖纸色）。
- DEM 瓦片缓存：`DATA_ROOT/map-data/dem/<z>/<x>/<y>.png` + `manifest.json`（terrain-cache.ts:11/62），`demManifestSha256` 用于指纹；瓦片抓取只在预取脚本里发生，运行期不联网。
- **没有底图成品缓存**：同 bbox/尺寸/数据版本重复渲染。`prepareMapBackground`（geo/geometry.ts:881 附近）仍接收 `texturePath` 合成旧纸纹；`run.ts:252` 传 `state.outputs.texture_image?.path`。
- 叙事河豁免集：`exemptRivers/namedRivers` 影响底图像素（relief-render 内使用，river-region-store.ts 读取 DATA_ROOT/map-data/osm-rivers 或内置 manifest）。

主题（`styles/index.ts:137` `resolveMapStyle`）：
- 只驱动要素默认样式/字体（`drawing.ts:113/117/242/258` 使用 `resolveMapStyle`），底图色板不随主题变；模块设置 `default_style`（`ModuleSettings.vue:46`），任务级 `MapStylePicker`。
- 五个家族 palette 都是暖纸色系；实测主题只影响要素层（新文档 theme=ink、线 #5f7778、朱红路线 #9d473b、楷体），底图不变。

观测（AI 活动数据源，已有）：
- `GET /map-studio/tasks/{id}`（serializeDetail：steps、issues、agent{runs/rounds/attempts}、outputs、history、research、research_progress_summary、error_detail）
- `GET /map-studio/runs/{id}/observed`、`GET /map-studio/calls/{id}/messages`；task_observed_* 表（scope=map_studio）。
- 失败分型（#124）：`error_detail.kind ∈ steps_exhausted|ended_without_delivery|call_error|rejected|mixed`，含 rounds[]、problems[]、steps_used；research 还有 research_progress 续跑/清空（`/research-progress/clear`）。
- 现有 MapAgentProcess 已能按阶段筛选逐轮调用与消息。

前端刷新：执行中每 3 秒轮询 detail（task.vue 注释「执行中每三秒刷新，终态停止服务端轮询」）。

## 4. 待设计者解决的结构性张力（必须显式给出取舍，不能回避）

1. 「一键检索到 base 停靠」现有 API 不支持中途停靠（manual 单阶段、auto 全流程）。需要新增参数；设计文档要给出参数语义与状态序列，并说明 auto 模式仍保留但在抽屉里。
2. v2 说「未确认几何不得进入 drawing（服务端闸门已有）」与 #111 事实不符。设计必须：(a) 在 UI 层把「确认几何」做成显式人工停靠点（默认 manual 流程下 drawing 只能由人点），(b) 明确记录当前服务端不阻塞、auto 模式会越过未确认几何，(c) 不声称有服务端闸门；(d) 对验收 V5 给出订正说明与建议（要么 UI 只保证默认流程，要么另行开 Issue 收紧服务端——本 Issue 明确不改服务端闸门口径）。
3. 主成图身份：drawing 阶段 `render_draft` 的预览图与阶段结束的 `final_image` 不是同一身份；设计要区分「agent 预览」「本轮成图（run_id+revision）」「上一版（历史 final_image / 交付版本）」，并给出前端如何取上一版（提示：detail 不直接给历史 final_image 列表，需从 runs/outputs 或交付记录推导——若数据不足，明确列为实施前提/接口小改动）。
4. 图层描述查看器依赖 #125 semantics（可能未合入）：设计必须给降级路径。
5. 编辑器 TAB 与现有「全部要素同画布」的行为切换：切换 TAB 要保留选中态/草稿、处理「画线时切换到面」等情况。
6. 「完成编辑」按钮在条目内：现有 commitDraft 是全局草稿收尾；要定义条目内按钮对「正在编辑该形状」与「未在编辑」两种状态的语义。

## 5. 输出规范（所有轮次）

- 中文 Markdown，术语沿用仓库现有中文文案（阶段名：需求、资料检索、底图、质感底纹、作图、完成；状态：进行中、待复核、受阻、失败、已完成）。可以给英文内部键名。
- 你只产出设计文本（含 ASCII 线框、表格、规则清单、组件分解建议、文案建议），不写代码实现、不写 Vue 组件代码。
- 一切规则要可实施、可验收：给字段名/键名、状态取值、边界条件、空态/失败态文案（中英文案都给，供四语 locales 落地）。
- 不确定处标「假设」，并给替代方案。
- 不复述背景，直接给设计。

---

## 6. 修订 r2 事实增补（2026-11-19，主 agent 直接读仓库核实；第 6–9 轮使用）

本节为 Fabel 阶段 0 设计评审（issuecomment-7008848189，M1–M16）的「需核实」项核实结果。基线仓库
`origin/master` @ `2d9655b1`。以下每条都以 `file:line` 给出证据；与第 2–3 节冲突时**以本节为准**（第
3 节旧文案「没有底图成品缓存」「complete 状态 awaiting_review」等已被事实推翻）。

### 6.1 阶段引擎、停靠、失效与互斥

- 停靠语义 `run.ts:191-199`（`finish`）：阶段完成写 step completed；`next = nextStage(stage)`；
  `ctx.state.stage = next ?? 'complete'`；`status = next ? (mode==='auto' ? 'running' : 'awaiting_review') : 'completed'`。
  即 **manual 每一阶段后停靠**；最后阶段（complete）结束为 `completed`。
- 循环 `run.ts:291-300`：`executeStage` 后若 `!proceed || mode !== 'auto'` 立即 break。manual 只跑一个阶段；
  auto 连续推进；**新端点只接受 `auto|manual`（`routes.ts:84-89`），没有 guided/stop_at 能力**。
- 入口前置 `startRun` `run.ts:330-383`：已有活动 run → 409 `workflow_busy`（:334-335）；`completed+complete`
  → `already_completed`（:336）；`base/drawing/complete` 起点要求 mapSpec（:340）；`base/drawing`（auto 时更早
  阶段也算）要求可看图的文本配置（:347-353）；`skip` 只允许 style（:354-360）；CAS `expectedRevision`
  在 `mutateTask(requireIdle)`（:365）。
- 作图阶段内部校验 `run.ts:246-262`：缺 `mapSpec` 或 `base_image` → `missing_base`（:247-248）；
  `canvasMismatch(brief, base)` → 回退 base（:249-250）；`prepareMapBackground` 缺合法 registration 直接抛错
  （`geo/geometry.ts:881-901`）；阶段结束写 `outputs.final_image`（含 run_id/provenance 的 map_style、
  registration、warnings、region_composition、base、base_mode、texture、background）、`layer_doc`、
  `layer_options`（:252-261）。
- research 恒 `proceed: true`（:226）；base 恒 `proceed: true`（:240）；style 恒 `proceed: true` 且
  `texture_image=null`（:244）。几何未确认只进 `issues[].blocking=false`（:367-371），**不阻塞**。
- 人工保存分支 `saveMapWorkflowDraft` `run.ts:427-583`：
  - `layer_options` 先 `validateLayerOptions`（:440-442），键必须在 `knownIds`（现有要素 id ∪ layer id，:450-451）；
  - **若已有 `layer_doc` 且 spec/brief 未变**：转 `saveMapLayerDoc`（:444-449）→ 重渲 + **自动交付**；
  - 否则写入 `outputs.layer_options`（:467），变化时清 `final_image`；
  - brief 仅换主题（`presentationOnly` 只剔除 map_style/style）：base 已完成后 `restart='base'`（:476-478）；
  - spec 比较 `reframed` 包含 `style` 的 JSON（:526-533）→ 回 base 并清 `base_image/kmz/pip`；
    仅几何变化时清 `final_image/layer_doc` 并 `resumeFrom='drawing'`（:536-548）。
- 回退 `applyRollback` `run.ts:140-163`：上限 2 次（`MAP_MAX_ROLLBACKS`）；≤base 清 base/kmz/pip；总是清
  final_image/layer_doc；style/texture 不清；受影响 step 置 pending；auto 继续、manual 停。
- 并发/互斥 `store.ts:334-453`：`expectedRevision`、`requireIdle`、`expectedRunId`、`expectedBriefHash` 四道
  校验；`updateTask` 以**整份 state/map_spec/brief 字符串**做 CAS（`db.ts:168-186`），0 行即冲突重读。
  历史 `MAX_HISTORY=30`（`store.ts:51`）。

### 6.2 drawing 之后的交付闭环（M4 直接依据）

- **complete 阶段就是交付动作**：`run.ts:264-275` 先（有 frames 且 base+final 时）`renderPipAssets` 并写
  `outputs.pip`（:267-270），再 `buildDeliverable`（失败 → 回退 drawing，:272），再 `deliverCurrent`
  （:273-275）→ `finish(proceed:false)` ⇒ 阶段 `complete`、`status='completed'`。**不存在「只准备不交付」
  的独立请求**。
- `buildDeliverable` `delivery.ts:15-67`：缺 final/base/layer_doc/spec → `missing_drawing`；`smoothingProblems`
  或 `labelProblems` 非空 → `drawing_invalid`；现读文件算 `final_image.sha256`；pip 细节语义按取景投影
  （:51-58）；`editable_source` = `{version, map_style, map_spec, layer_doc, layer_options}`；
  `texture_image` **只有 path**（:59）。
- `deliverCurrent` `delivery.ts:69-86`：校验 expected run/brief（stale）；`stage !== 'complete'` →
  `delivery_not_ready`（:76）；幂等键 = final sha（有 pip 时叠加细节/合成 sha，:79-81）；命中
  `selectDeliveryBySha` 直接返回旧结果；无宿主返回 `version_ids: []`（独立任务，:80）。
- 宿主副作用 `services/map-studio-host.ts:24-60`（单事务）：插 2 行 `sys_task`（底图 `map-render`/`map-studio-base`；
  成图 `map-workflow`/`map-layer-doc(-manual)`），成图 params 含 `png_sha256,pip_key,base_task_id,geometry,
  features,sources,kmz,editable_source,texture_image,manual_edit,provenance`；更新 `props.image_url/local_path/
  faithful/faithful_source/semantics`；`registerSourceCitations`；`registerPipAssets`。事务外
  `onAssetLibraryChanged ×2`（:131-136）。同 task+png_sha+pip_key 幂等不插行（:32-34）。
- 手动 `POST /tasks/:id/deliver` `routes.ts:141-148`：要求宿主、非 running，直接 `deliverCurrent`（**不重渲
  pip**）。用途 = 失败重试/补交付；不能替代 complete 阶段的 pip 渲染。
- 交付成功判据：`MapStudioDeliveryResult { version_ids: number[]; message }`（`contract.ts`）；版本号即
  `sys_task` id（底图、成图）；重复交付返回同一组 id。
- 失败处理 `run.ts:305-329`：Stale/Conflict 只结束 run（不改任务状态）；其它错误写
  `status='failed'`、`error`、`step failed`、`agent.feedback`，`#124` 的 `error_detail` 只在
  `MapStageExhaustedError` 时写（:317-321）。
- 取消 `run.ts:586-604`：结束活动 run，step running→pending，`run_id=null`，`status= idle`（completed 保持）；
  **不会启动下一阶段**。

### 6.3 快照与历史（M3/M14 依据）

- 历史条目类型 `types.ts:242-258`：`snapshot?: {stage, brief, map_spec, outputs, research}`；`outputs` 即
  `MapWorkflowOutputs`（`types.ts:229-240`：base/texture/final/kmz/layer_doc/layer_options/pip）；`MapImageRef`
  = `{path,width,height,source,run_id,provenance}`（`types.ts:215-226`）。
- 快照捕获 `store.ts:364-372`；写入历史 `store.ts:400-420`，`slice(-30)`（`MAX_HISTORY=30`，`store.ts:51`）。
  只有 `snapshot:true` 的动作才有快照（stage_done、edit_map_spec/edit_brief、edit_layer_doc、rollback、
  agent_rollback、migration 之类人工迁移需自行补）。`restoreSnapshot` `store.ts:459-...` 以此恢复。
  ⇒ 历史是**最近 30 次修订的滚动窗口**，不是永久档案；30 条各自含完整 layer_doc，体积需控制。
- 模块交付日志 `map_studio_delivery`（`db.ts:68-77`）只存 `final_sha256 + result`，**不含 deliverable 载荷**；
  `deliveryView` 只回 `version_ids/message`（`store.ts:551-567`）。完整成图 input 只存在于宿主版本行 params
  （`map-studio-host.ts:37-46`），模块按 #99 边界不能直读宿主库 ⇒ 同源快照读取需要**模块自存**或**宿主只读投影**。
- 纹理来源追溯缺口：`deliverable.texture_image` 只有 path（`delivery.ts:59`），宿主版本 params 同样只存
  `{path}`；base 版本 params 有 `provenance`（含 renderer/sources/attribution）。⇒「所选历史图是否叠过纸纹」
  只能由「该版本 params.texture_image 非空 / 为空 / 该版本早于字段引入（未记录）」三态回答，**不能据当前
  task 的 texture_image=null 反推历史图未叠纸纹**。

### 6.4 底图缓存：**已经存在**（M12/M13 依据；推翻第 3 节「没有底图成品缓存」）

- `renderMapBase` `geo/base-render.ts:520-643`：
  - 签名 `mapBaseSignature` `:483-513`：`v: spec.version`、`renderer: 3`（字面量）、`rv`（10m 河流源）、
    `ru`（`canonicalReliefOptions(relief)`）、`p` 投影、`b` bbox、`l` 图层开关、（程序底图恒为空的）
    `pl/rt/rg` 要素、`s: spec.style.theme`、`family: spec.style.map_style`、`w/h`；`sha256(...).slice(0,32)`。
  - 读写目录 `STORAGE_ROOT/map-bases/<sig>.png` + `<sig>.json`（`:539-554`）；图片与 sidecar 都缺或 sidecar
    JSON 解析失败 → 视为 miss 重渲（`:547-553`）；命中 `reused=true` 进 provenance（`:558-562`，`geometry.ts:560`）。
  - 写入为直接 `fs.writeFileSync(png)` / `(json)`（`:592-594`）——**非原子**；读取**不校验 sha**；**无单飞**，
    同键并发两次渲染都会跑；**无数据内容指纹**：NE 数据集 sha（`geo/datasets.ts:155-159 datasetFileInfo`）、
    DEM manifest sha（`geo/terrain-cache.ts` manifest_sha256，只在渲染后写进 sidecar `:586-590`）、OSM 命名河
    包内容 sha 都不在键里；`renderer` 是手写字面量而非内容指纹。
  - 键里的 `style.theme/family` **不改变底图像素**（`RELIEF_PALETTE` 固定，`geo/relief-render.ts:30-38`），
    只造成伪 miss；`spec.style` 变化还会经 `reframed` 触发 base 重做（`run.ts:526-533`）。
- 实际像素输入（`geo/relief-render.ts:341-380`、`452-461` 与 `geo/base-render.ts:527-539`）：bbox、投影、
  宽高、`role`、`params`、`maxRank/lakeRank/lineScale`、`anchors`、`exemptRivers`、`namedRivers`（OSM 包）、
  DEM 瓦片内容/manifest、NE `10m_land`/`10m_lakes`/`10m_rivers_lake_centerlines` 数据内容、`layers` 开关、
  固定色板。
- `createProgramBase` `geo/geometry.ts:496-566`：以**去掉要素**的 renderSpec 渲染；登记 sources（NE 三份
  sha 前 12 位、DEM zoom/瓦片数/manifest sha、OSM 包 sha 前 12 位）与 `provenance.renderer=
  'd3-geo+natural-earth-10m-relief+aws-terrain'`、`reused`。
- earth/image 底图各自有文件复用逻辑（`geometry.ts:567-763`），不参与 relief 键；缓存结论只针对 program。
- 缓存无 TTL/无自动淘汰；缩略图 `generateImageThumb`（`base-render.ts:595-597`）。

### 6.5 遗留主题字段的真实副作用（M15 依据）

- `resolveMapStyle` `styles/index.ts:137-143`：brief **缺** `map_style`（旧任务）→ 返回 `null`（保留旧行为）；
  显式 `null` → 模块默认 `atlas-tint`；非法值 → 抛错。
- 作图使用 `resolveMapStyle`，为空时回落到旧 `brief.style` theme（`drawing.ts:113-117`）；`/layer-doc/restyle`
  回落到 `THEME_PRESETS[brief.style]`（`routes.ts:118-121`）。
- 只改主题会让 base 重做（`run.ts:476-478`）；`spec.style` 差异也进入 `reframed`（`:526-533`）；底图缓存键含
  theme/family（`base-render.ts:507-508`）。
- `PUT /settings` 仍写 `default_style`（`routes.ts:204,223`）；`GET /styles` 与预览仍在（`:192-198`）；任务级
  `MapStylePicker`（`MapBriefForm.vue:39`）、模块设置入口（`ModuleSettings.vue:46`）仍在。
- 新建宿主任务会显式写 `map_style=null`（`tasks.ts:74-77 openHostTask`）；独立任务 `normalizeBrief`
  （`tasks.ts:52-56`）；`openHostTask` 只为**新任务**补字段，旧任务保持缺失（延续旧主题）。

### 6.6 宿主资产信息与 #125（M11 依据）

- `contract.ts` 的 `describe` 只返回 `{title, subtitle, return_path}`；`readBrief` 返回 `MapBrief`
  （`types.ts:74-90`：subject/era/location/purpose/detail_level/schematic/base_mode/style/map_style?/
  aspect_ratio?/notes/reference_image/inferred）。宿主实现用 `props.description` 仅作 `notes` 默认值
  （`map-studio-host.ts:100`）；`props.reference_images` 列存在（`sqlite-schema.ts:389`）但**未透出**。
  ⇒ 「资产描述、宿主参考图」读取需要宿主只读投影扩展（新增字段不改写权限），当前前端拿不到。
- `brief.reference_image` 是**任务配准参考图**（含控制点，`types.ts:58-64`），不是宿主资产参考图，不能混称。
- #125 仍 OPEN（未合入）：计划 `description?: string(≤500)`、`keywords?: string[](≤12)`，`PUT /props/:id/semantics`
  人工编辑；`asset-semantics.ts:27-30,232-272` 的 `source='manual'` 是**条目级**（整条被人工改过），不是
  字段级「描述由人写」；地图工作室交付把语义统一标 `source='cv'`（`map-studio-host.ts:48`）；当前 deliverable
  semantics 无 description（`delivery.ts:47-58`）。⇒ 未新增字段级来源前，查看器只能标「人工条目」，不能标
  「人工描述」。
- 研究阶段已有 `basis/supporting_excerpt/source_ids`（`types.ts` 的 MapResearch features；`delivery.ts:31-41`
  透出为 `coordinate_basis/excerpt/source_ids`），可作描述来源，但**不写入语义条目**（#125 的生产职责）。

### 6.7 建议强度与首次成图前的平滑保存（M7 依据）

- `suggestedStrength` `render/smooth.ts:227-237`：14 步二分「偏离 ≤ 上限」的最大强度，`floor(low*20)/20`，
  `<0.05 → 0`；`deviationProblems` `:239-264`；交付门禁用 `smoothingProblems`（`delivery.ts:22-24`）。
- 首次成图前**可以**持久化平滑参数：`PUT /tasks/:id {map_spec, layer_options}` → `validateLayerOptions`
  （`run.ts:440-442`）→ 键为要素 id 时通过 `knownIds`（`:450-451`）→ 写 `outputs.layer_options`（:467）；
  作图阶段把它传进 agent（`run.ts:258`）→ `optionsForDrawing` 支持 `semantic_id` 回落映射到图层 id
  （`drawing.ts:87-95`）。前端已在几何保存里同一次 CAS 提交 `layer_options`（`task.vue:963-972`；
  `MapGeoEditor.vue:182-211` 产生 `layer-options` 草稿）。⇒ 不需要新端点；但注意：**有 layer_doc 时同样请求
  会走 `saveMapLayerDoc` → 重渲 + 自动交付**（`run.ts:444-449`、`:632`）。
- 顶点无稳定 ID：`layer_doc` 的线/面是坐标数组 `[x,y]`，点要素是 `at`（`services/layer-doc.ts:91,96,101`）。

### 6.8 迁移与并发（M8 依据）

- 启动 schema：`initMapStudio` 执行 `MAP_STUDIO_SCHEMA`（`tasks.ts:14-17`；`db.ts:60-79`）；仓库既有迁移惯例是
  幂等 `PRAGMA table_info` + `ALTER TABLE ADD COLUMN`（`db/sqlite-schema.ts:958-980`）。
- `map_studio_delivery` 无迁移/载荷列（`db.ts:68-77`），迁移状态需新列/新表。
- 迁移写路径必须用 `mutateTask`（整份 state CAS，`db.ts:168-186`）+ `requireIdle` + `expectedRevision`；
  `startRun` 与迁移共享的互斥**只有这套 CAS**（`run.ts:334-335` 读活动 run、`:365` requireIdle），**没有**
  共享锁/队列。因此「跳过 running」必须落到 CAS 失败重读，而不是事前一次判断。
- 现有 texture 结构 `{path,width?,height?,source?,run_id?,provenance?}`（`types.ts:215-231`；`run.ts:244` 置 null）；
  无任何既有 texture 迁移工具或 migration 记录字段。

### 6.9 复核状态与 V5（M1 依据）

- 服务端无「未确认几何禁止 drawing」闸门（第 0.2/0.3 节的结论仍然成立：`accuracy.ts:88-95`、
  `store.ts:575-595` 的 legacy gate 改写）。`geometryUnverified` 仅在 UI issues 与 `confirmGeometry` 使用。
- 「确认几何」= `PUT map_spec` 去掉 `proposed`（`run.ts:500-511` 逐要素比较；坐标未变且 `proposed!==true` →
  `verification=confirmed`）。没有任何持久化「整体复核」字段。
