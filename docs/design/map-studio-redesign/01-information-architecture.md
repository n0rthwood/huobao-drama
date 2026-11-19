# 01 信息架构与结果优先主界面

> 设计主体：Astra（模型 `gpt-6-astra`）。
> 初稿留痕：`astra-calls/r1.md`、`r1.response.md`；r2 修订：R6、R10、R12及对应原始响应。
> 事实底座见 [`astra-calls/facts.md`](astra-calls/facts.md) §6–8；后两节覆盖早期 #125 与缓存规范化的旧结论。
>
> 有界运行采用新增 `mode='guided'` 与必填 `stop_at='base'|'drawing'`：检索止于 base，显式渲染止于 drawing。
> 用户另点交付，经 `/advance` 执行 complete；`/deliver` 仅失败补交付。UI 与服务端同批切换，不加能力发现或永久分步兼容流程。
> 路由 JSON 使用 `expected_revision`；内部 TypeScript 才使用 `expectedRevision`。`/deliver` 无 CAS 参数。
> 本文为设计契约，不声称新增执行、快照或宿主回传能力已经实现。

## 1. 设计原则

1. 主界面同时回答地图身份、所选图片身份、当前状态及唯一下一步动作；日志收进 AI 活动抽屉。
2. 默认空间由阶段驱动：核对阶段③点线面最大，成图复核阶段②图片最大；专注模式只是增强，不是满足编辑面积要求的前提。
3. 默认检索采用 guided/base 并停靠；确认几何与渲染成图分开。有待确认要素时先执行确认 PUT，权威成功后才允许显式渲染；全已 confirmed 仍须用户点击渲染。刷新、保存、关闭弹窗及深链恢复均不启动 drawing。高级 auto 单独警告并启动。
4. 图片、图层文档、语义和来源绑定模块 task state 中的 durable pinned 载荷／索引；复用 history snapshot 形状及单调 task revision，history30 仅作滚动审计，不建新 payload 表或平行版本系统。无法证明同源时显示缺失，禁止用当前数据补历史图；新产物缺供给仍阻断 G2/G4。
5. **一次保存**：页面唯一 `specDraft` 与 `layerOptionsDraft`；地点行、全部地点及顶点弹窗合法输入即入页面草稿。“完成编辑 / Finish editing”只结束局部形状；“保存几何 / Save geometry”一次 CAS 提交整份 spec + layer_options，不按行提交，关闭弹窗不二次提交。
6. **深链零写**：恢复 TAB、zoom、选择、点列表及图片仅改变视图；保存、确认、生成、交付必须来自显式命令。
7. **保存 ≠ 渲染 ≠ 交付**：“即时上图 / Live edit preview”仅指 SVG 编辑预览。旧几何保存中已有 layer_doc、仅改选项会重渲并自动交付（`run.ts:444-449,608-639`）；本 Issue 必须拆分该分支，改为仅保存并标图过期。人工图层专用 PUT 保留副作用，按钮明确为“保存图层并重渲交付 / Save layers, re-render and deliver”。
8. 不维护浏览器整体复核标记。所有“待核对”计数统一采用 `geometryUnverified` 口径，含 dataset_missing，并保留既有 manual/verified/confirmed 判定（`accuracy.ts:88-95`），不改变服务端口径。草稿 `proposed===true` 数量可另显示为“AI 候选数 / AI candidate count”，不得名为“待核对”。
9. 主动作全局优先级固定为 running → 写结果未知 → CAS 冲突 → 未保存草稿（含 failed）→ 真实 blocking／失败 → 正常阶段；取消确认后不启动下一阶段，续跑保留真实 mode/stop_at。

## 2. 注意力预算与视觉层级

以 1440×900 面板为参考。顶栏占视口 6%，动作条占 8%，其余 86% 为内容区。下列比例均为**内容区高度**，各表合计 100%；小窗口允许内部滚动，不压缩输入框、焦点目标或按钮。

**核对阶段：base 就绪、几何待核对、等待启动 drawing。**

| 区域 | 内容区比例 | 默认形态 |
|---|---:|---|
| ①资产信息 | 23% | 需求摘要、只读资产信息、参考缩略；brief 表单收起 |
| ②图片身份 | 22% | 底图／上一版身份摘要、缩略图与“展开大图 / Expand image” |
| ③点线面核对 | 55% | 默认最大区；TAB、画布、当前类列表及编辑工具完整可见 |

**成图复核阶段：drawing 完成、complete 待交付、已完成；drawing 运行时也采用此布局保留上一版。**

| 区域 | 内容区比例 | 默认形态 |
|---|---:|---|
| ①资产信息 | 23% | 摘要；运行中只读 |
| ②当前成图 | 52% | 默认最大区；大图、身份、同源图层查看器 |
| ③点线面核对 | 25% | 可展开条带；显示类别、计数、草稿与不一致提示 |

切换条件与限制：

- 依据完成步骤、当前产物及返回状态切换，不单凭 `stage` 名称猜测。base 完成后进入核对布局；drawing 发布本轮 final 后进入成图复核布局。
- 几何／需求编辑造成成图失效并等待重做时恢复核对布局；旧图仍保留身份摘要。运行失败不隐藏可用图片、草稿或问题。
- ③普通布局采用画布约 62%＋列表约 38%。地点行可见名称、经纬度、确认状态、依据及删除；线／面可见名称、点数、依据、平滑偏离、顶点入口和“完成编辑”。长列表内部滚动。
- TAB 是硬显隐：底图保留，只画当前类别。列表编辑即时更新覆盖层，不意味着最终图已更新。
- “放大编辑 / Focus editor”扩大③，②仍保留图片身份；退出恢复原阶段布局和视口。该入口不是正常编辑的必经步骤。
- 用户展开大图不会改变阶段、保存草稿或开始渲染。①表单展开采用局部覆盖面板，不永久挤占③。

## 3. 主界面信息架构

### 3.1 区块与联动

| 区块 | 目的 | 进入条件 | 默认／折叠形态 | 主导航层级 | 联动 |
|---|---|---|---|---|---|
| 顶栏 | 回答“是哪张地图、走到哪” | detail 可用 | 宿主标题＋状态句 | 宿主弹窗内唯一顶层导航 | 状态句打开阶段轨；AI 活动打开抽屉；更多放非主路径动作 |
| ①资产信息 | 展示需求与参考依据 | 始终 | subject、era/location、purpose；当前宿主只读描述与参考图 | 一级工作内容 | 展开既有 brief 表单；保存后按返回 detail 更新阶段；参考图只读放大 |
| ②当前成图 | 回答“有没有图、是哪一版” | 始终 | 图片＋身份角标；无成图时为底图或空态 | 主视觉区 | 放大、同快照图层查看；不出现几何编辑把手 |
| ③核对与编辑 | 核对点线面 | 有 spec；无则占位 | 地点／线／面 TAB，只画当前类 | 一级内容，TAB 为二级 | 条目定位画布；查看器定位须通过同源检查；不自动保存 |
| ④动作条 | 唯一下一步动作 | 始终 | 停靠原因＋一个主色按钮＋更多 | 全面板操作出口 | 按 §9 全局优先级分派 |
| 阶段轨浮层 | 查看阶段与回退事实 | 点状态句 | 紧凑横向步骤 | 辅助导航 | 选阶段仅查看；回退需明确命令及既有并发保护 |
| AI 活动抽屉 | 回看运行和失败现场 | 显式打开 | 当前或指定 run | 辅助观测 | 定位 call、round，不复制主恢复按钮 |
| 图层查看器 | 解释所选图片中的层 | 有匹配快照 | ②右侧只读栏 | 结果二级导航 | 层描述、来源和几何摘要，不进入编辑模式 |

宿主字段统一来自新增 `detail.host.target.description/reference_images`；这是 `contract.describe` target 的只读扩展，不把 brief.notes 当宿主描述，不增加宿主写权限。

### 3.2 阶段轨的最小表达

主界面只显示一个状态句，例如：

> 底图已就绪 · 待复核几何 / Base map ready · Review geometry

服务端可能已经是 `stage=style,status=awaiting_review`；状态句依据完成步骤解释，不伪造服务端阶段。浮层同时显示：

> 当前服务端阶段：质感底纹；该步骤固定跳过，不生成纸纹。  
> Current server stage: texture; this step is skipped and produces no texture.

六个服务端阶段完整保留：**需求 → 资料检索 → 底图 → 质感底纹 → 作图 → 完成**。不再竖排六行，不在每阶段旁常驻回退按钮。

### 3.3 编辑器行为边界

**页面唯一草稿与一次保存**

- 地点行、全部地点弹窗、线／面顶点弹窗共享页面 `specDraft` 和 `layerOptionsDraft`；合法输入只发 `draftChange`。关闭不提交，显示“已加入待保存草稿 / Added to unsaved draft”。
- 页面“保存几何 / Save geometry”是几何草稿唯一服务端保存入口：`PUT /tasks/:id {map_spec, layer_options, expected_revision}`，提交整份页面草稿。仅改选项时提交服务端原样 spec，不存在部分脏行提交。
- 保存前完成或撤销未结束的局部形状；点数不足等问题定位反馈，不悄悄漏交。已有合法数值修改不要求再逐行点“完成编辑”。
- 成功以服务端规范化 spec、layer_options 和 revision 重建基线，再显示“已保存 / Saved”；不以请求副本冒充服务端结果。
- 首次成图前选项持久化和 drawing 消费已有通道（`run.ts:440-467`、`drawing.ts:87-95`、`task.vue:963-972`）。
- **新增设计**：拆除几何区保存借道 `saveMapLayerDoc` 的旧分支。无论是否已有 layer_doc，几何区仅改选项均只保存并标成图过期，不重渲、不交付。旧行为证据为 `run.ts:444-449`；单纯告知副作用不能满足新契约。
- 人工图层高级编辑独立使用 `PUT /layer-doc`，保留既有重渲交付，按钮及确认说明必须完整写出“保存图层并重渲交付 / Save layers, re-render and deliver”（`run.ts:608-639`）。

**完成编辑与 TAB 仲裁**

- “完成编辑 / Finish editing”只结束局部绘制事务并合入页面草稿；不 PUT、不确认几何、不启动渲染。
- 点数不足时禁用完成并提示“点数不足，无法完成编辑 / Not enough points to finish editing”；无局部变更时不写入，提示“没有待完成的编辑 / No edits to finish”。
- 切 TAB 保留页面草稿、各类选择及 zoom/pan。未结束绘制时提供“完成编辑并切换 / Finish editing and switch”“放弃局部改动并切换 / Discard local changes and switch”“留在当前类别 / Stay”。
- TAB 只画当前类别，其他类不画，底图保留。改名本身不转几何 manual，也不清 proposed（`run.ts:500-511`）；这与 #125 描述所有权的 manual 是不同语境。

**冲突、拒绝与结果未知**

| 返回／情况 | 界面与处理 |
|---|---|
| 成功 | 使用服务端规范化返回及 revision 建基线；共享视图同步“已保存 / Saved” |
| 明确校验拒绝 | 显示错误，恢复已保存画布；可保留副本供修复，不显示成功 |
| 409 CAS 冲突 | 读最新 detail；保留／放弃本地冲突副本。保留不等于覆盖，重应用后以最新 revision 显式保存 |
| 断线／超时 | “保存结果待确认 / Save result pending confirmation”；暂停后续写及盲重发，先 GET detail |
| revision 前进且规范化 spec/options 内容匹配 | 认定保存成功，采用权威返回建基线；几何保存不产生交付 |
| 内容不匹配或 revision 未前进 | 不断言旧请求未落盘；转冲突副本流程，按最新事实处理，不自动重放 |
| detail 仍不可读 | 保留草稿与待确认状态，提供“重新读取 / Read again” |

冲突副本沿用既有 5d 保留口径，不新增草稿管理子系统。失败状态不跳过草稿保存；保存成功后按返回的新 stage 重算动作。

**坐标与输入契约**

无 registration 仅允许数值编辑：“缺少地理配准，无法在图上拖动 / Dragging is unavailable without georeferencing”。03 覆盖指针→viewBox→registration 反投影，复用 meet 信箱边距并正确消除 zoom/pan，不重复扣边距。

把手拖动改几何，空白底图拖动改视口；鼠标、触摸、笔同口径，键盘保留可完成的选边、插点、新建、追加与取消路径。纯 zoom/pan 不发 draftChange、PUT 或几何 revision 变更。

验收分别覆盖地点列表、全部地点弹窗、顶点弹窗进入同一草稿；一次保存包含全部脏条目；关闭零提交；刷新一致；未知结果先读而非重发；已有 layer_doc 时仅改平滑也不重渲、不交付。

## 4. 线框

固定槽位为顶栏、①资产信息、②图片、③点线面、④动作条。`[主]` 为唯一主色按钮。①②③比例指内容区；顶栏与动作条另计。所有线框的按钮都受 §9 全局优先级覆盖，不能据线框绕过运行、未知结果、冲突或草稿。

### 4.1 空态：新任务、无成图、无几何

```text
+--------------------------------------------------------------------------+
| 地图标题                  需求 · 待开始                AI 活动    更多    |
+--------------------------------------------------------------------------+
| ① 地图需求摘要 / 年代 / 地域      只读参考图                 编辑需求     |
+--------------------------------------------------------------------------+
| ②                         尚未生成成图                                   |
|                 一键检索后将准备底图与点线面                              |
|                 参考图仅为参考，不标为当前成图                            |
+--------------------------------------------------------------------------+
| ③ 地点 | 线 | 面                                                        |
|                 暂无几何；检索完成后在这里核对与编辑                      |
+--------------------------------------------------------------------------+
| ④ 下一步：检索资料并准备底图                          [主 一键检索]       |
+--------------------------------------------------------------------------+
```

保留结果区，明确没有生成。subject 缺失时主动作改为“补全需求 / Complete requirements”，聚焦字段，不发送 run。无几何时 TAB 不进入无坐标依据的编辑状态。

### 4.2 核心状态：底图就绪、几何待核对

```text
+--------------------------------------------------------------------------+
| 地图标题             底图已就绪 · 待核对几何           AI 活动    更多    |
+--------------------------------------------------------------------------+
| ① 23% 年代 / 范围 / 用途       资产只读摘要 / 参考图         编辑需求    |
+--------------------------------------------------------------------------+
| ② 22% 底图 · 尚未生成成图       尺寸 / 来源                 展开大图    |
|        若有旧图：上一版 · 图与当前几何不一致                               |
+--------------------------------------------------------------------------+
| ③ 55% 地点 (12) | 线 (4) | 面 (2)       全部地点            放大编辑    |
| +---------------------------------------+------------------------------+ |
| | 底图 + 仅当前类别 SVG                 | 名称 / 经度 / 纬度           | |
| | [+] [-] [适配]                        | 待核对 / 依据 / 删除         | |
| | 拖动把手编辑；空白拖动平移             | 已加入待保存草稿             | |
| |                                       | 顶点入口 / 完成编辑          | |
| +---------------------------------------+------------------------------+ |
+--------------------------------------------------------------------------+
| ④ 停靠原因                                           [唯一主动作]       |
+--------------------------------------------------------------------------+
```

| 已通过全局覆盖后的条件 | 主动作 | 成功后的停靠 |
|---|---|---|
| 有合法未保存草稿 | 保存几何 / Save geometry | 仅持久化，标图过期；不渲染、不交付 |
| 无草稿，有待确认要素 | 确认几何 / Confirm geometry | 权威 PUT 成功后重算计数，不启动阶段 |
| 无草稿／冲突／未知结果，底图有效且无待确认要素 | 渲染成图 / Render map | guided/drawing 完成即停，等待交付 |

三者不能合并成“保存并渲染”。全已 confirmed 时不制造空 PUT 或整体复核键，仍须显式点击渲染。“待核对”徽标统一采用 `geometryUnverified` 口径，含 dataset_missing（`accuracy.ts:88-95`）；草稿 `proposed===true` 数量可另显示为“AI 候选数 / AI candidate count”，不得名为“待核对”。

②只查看图片，③才有把手。地点行没有独立服务端保存按钮，多条编辑由页面一次保存。

### 4.3 运行中：drawing，保留上一版

```text
+--------------------------------------------------------------------------+
| 地图标题                作图 · 进行中  01:42          AI 活动    更多    |
+--------------------------------------------------------------------------+
| ① 23% 当前需求摘要                                        运行中只读    |
+--------------------------------------------------------------------------+
| ② 52% 上一版 · 正在渲染新版      图片发布 revision / 原 run       放大  |
|                           上一版成功图                                   |
|                     当前图片不是本轮最终结果                             |
+--------------------------------------------------------------------------+
| ③ 25% 地点 | 线 | 面       已保存几何，运行中只读                         |
+--------------------------------------------------------------------------+
| ④ 正在渲染新版                                     [正在渲染… 禁用]    |
+--------------------------------------------------------------------------+
```

- 无时间戳时显示“耗时暂不可用 / Elapsed time unavailable”，不推算进度百分比。
- 本轮有可验证 draft 后，默认自动视图可显示“AI 预览，未定稿 / AI preview · Not final”；用户历史选择不被抢占。
- 取消在更多菜单，显示“正在取消… / Cancelling…”直至确认；确认后不启动下一阶段（`run.ts:586-604`）。
- guided/drawing 发布 final 与同源快照后为 `complete/awaiting_review`，run 结束；主动作才变为交付。
- research 运行同样保留可验证旧图，标“上一版 · 正在检索新版 / Previous render · Researching a new version”；无图保留空态。

### 4.4 成图已出、待交付

```text
+--------------------------------------------------------------------------+
| 地图标题                  完成 · 待复核                AI 活动    更多    |
+--------------------------------------------------------------------------+
| ① 23% 地图需求摘要                                          编辑需求    |
+-----------------------------------------------------+--------------------+
| ② 52% 本轮成图 · 发布 rN / drawing run       放大   | 图层查看器         |
|                                                     | 地名 / 路线 / 范围  |
|                     本轮成图                        | 同快照描述与来源   |
+-----------------------------------------------------+--------------------+
| ③ 25% 地点 | 线 | 面       展开核对 / 放大编辑                           |
+--------------------------------------------------------------------------+
| ④ 成图已就绪，请核对后交付                            [主 交付成图]       |
+--------------------------------------------------------------------------+
```

- `complete/awaiting_review` 的交付按钮发送 `/advance {expected_revision}`，异步执行 complete。说明为“将渲染细节图并登记交付版本 / Render detail images and register delivery versions”。
- 启动响应是 detail，不是最终交付凭据。轮询到终态后核对 version_ids、deliveries 及实际宿主交付行；仅 HTTP 成功、图片出现或 status 完成都不替代版本证据。
- standalone 无宿主版本时显示“流程完成，可下载 / Workflow complete · Download available”，不标已交付到资产。
- `/deliver` 只用于失败补交付，不准备 pip、不改 status（`routes.ts:141-148`、`delivery.ts:69-86`）。
- 查看器读取所选快照。高级人工图层编辑按钮为“保存图层并重渲交付 / Save layers, re-render and deliver”，事前说明副作用；几何保存不复用该路径。

### 4.5 失败态：#124 分型与唯一恢复动作

```text
+--------------------------------------------------------------------------+
| 地图标题                    作图 · 失败                AI 活动    更多    |
+--------------------------------------------------------------------------+
| ① 当前需求摘要                                              查看需求    |
+--------------------------------------------------------------------------+
| ② 失败类型、失败阶段及可用结果；查看失败现场 → AI 活动                    |
|    上一版 · 新版渲染失败                                                  |
|                         可验证的上一版成功图                             |
+--------------------------------------------------------------------------+
| ③ 地点 | 线 | 面       草稿与问题仍可见；失败不等于几何被清空             |
+--------------------------------------------------------------------------+
| ④ 当前最高优先级原因                                 [唯一恢复主动作]    |
+--------------------------------------------------------------------------+
```

- 横幅无第二个重试写按钮；“查看失败现场”仅导航。
- 有未知结果先读，有冲突先处理，有草稿先保存；不得因为 failed 抢先显示续跑。
- 无上述状态时，可修复问题先定位；修复保存后按返回 stage 重算，再显式重试。
- 已无修复项且允许续跑时才显示“续跑当前阶段 / Resume current stage”，保留真实 mode/stop_at。unknown kind 明示并进入现场，不猜一种恢复。
- 无上一版时显示“本轮未生成成图 / No final render was produced in this run”；保留的失败 draft 明确标“失败运行的 AI 预览，未定稿 / AI preview from a failed run · Not final”。

## 5. 区块规格表

**〔新增设计〕** 表示尚需实施的读取契约或 UI 状态。API 均以 `/map-studio` 为前缀。

| 区块 | 内容项 | 数据来源 | 空态 | 进行态 | 失败态 | 可编辑性 | 深链键 |
|---|---|---|---|---|---|---|---|
| 顶栏 | 宿主身份、阶段／状态、活动 | MapHostHeader、detail、steps、真实时间戳 | 需求 · 待开始 | 阶段＋耗时 | 失败／受阻 | 只读 | `msstage`、`msactivity` |
| ①资产信息 | 需求、当前宿主描述与参考图、AI 补全依据 | brief；〔新增设计〕`detail.host.target.description/reference_images` | 补全 subject；宿主信息未提供 | 只读 | 保留需求 | 仅既有 brief 写，经 writeBrief | 不新增布局键 |
| ②当前成图 | 图片、快照身份、尺寸、过期状态 | outputs；〔新增设计〕模块持久快照清单与载荷 | 尚未生成成图 | 上一版／本轮预览 | 保留可验证图片 | 只读 | `msview`、`mssnapshot`、`mspreview` |
| ③编辑器 | TAB、画布、条目、点列表 | 页面 spec/options 草稿、research、registration | 暂无几何 | 只读并保留草稿 | 定位问题、修复草稿 | 整页 CAS | `msgtab`、`msgeo`、`msgzoom`、`msgcx`、`msgcy`、`msgpoints`、`msgrow`、`msggeorev` |
| ④动作条 | 唯一动作及前置原因 | §9 全局优先级 | 检索／补全需求 | 禁用进度按钮；更多可取消 | 先核实／冲突／保存，再恢复 | 显式命令 | 不编码待执行动作 |
| 阶段轨 | 六阶段、step 状态、回退事实 | steps、issues、history、回退次数 | 尚未执行 | 标运行阶段 | 标失败阶段 | 查看只读，回退显式 | `msstage` |
| AI 活动抽屉 | runs、rounds、attempts、calls/messages、失败及设置 | detail.agent、observed、messages、所属 run 的错误 | 尚无运行记录 | 当前 run 更新 | 完整失败现场 | 读取只读，配置及高级命令显式写 | `msactivity`、`msrun`、`mscall`、`mscf`、`msround` |
| 图层查看器 | 层、冻结描述、来源、所有权 | 所选快照 layer_doc/semantics/features/sources | 无可查看图层 | 所选图已有快照 | 不拼当前 spec | 只读 | `mslayers`、`mssel`、`mssnapshot` |

不新增来源管理、滚动位置、编辑布局或额外列表筛选深链。

## 6. 当前成图主视图：快照身份模型

### 6.1 最小不可变载荷与保存归属

**实施选择已确定：复用 history snapshot 载荷形状，在模块 task state 保存 durable pinned 载荷／索引，不新建 payload 表或平行版本系统。** detail 提供快照引用；新增只读 `GET /map-studio/tasks/:id/snapshots/:snapshot_id` 返回同任务授权范围内的冻结载荷及安全 URL。这是必须实现的选定接口，不是现有能力声明。

history snapshot 已有 `{stage,brief,map_spec,outputs,research}` 形状（`types.ts:242-258`），仅最近 30 条且需 `snapshot:true` 才捕获（`store.ts:51,364-372,400-420`）。history30 继续作为滚动审计；task state 的 durable pinned 载荷／索引独立于该窗口，不随其淘汰。模块交付日志只有 sha+result（`db.ts:68-77`、`store.ts:551-567`），不能承担永久快照。宿主库不可由模块直读。

| 内容 | 最小契约 |
|---|---|
| 身份 | `snapshot_id=task_id+published_revision+artifact_kind`；复用单调 task revision。同一 run 的多次 draft 独立发布、分别取得 revision；artifact_kind 区分 draft/final/delivery 及已有受保护产物类型，不新增 spec/brief/options 三套计数 |
| 图片 | 实际 sha256、持久 path、尺寸、artifact 种类、真实 run_id（无则不伪造）、发布 revision、provenance |
| 输入 | 复用快照中的 brief/map_spec/research/outputs 形状，保存生产相关内容及内容 hash；hash 对应实际生产输入，不取当前可变值 |
| 图层 | 同源 layer_doc、layer_options；base 无图层时明确不适用，不能拿后来的 doc 补齐 |
| 语义与证据 | 冻结 semantics、features、sources；包含已有 description/keywords/manual/name_manual/source，不只存可变引用 |
| 纹理 | 冻结原 texture 对象及字段是否曾记录的事实，不裁成 path；旧版本只能按证据显示有／无／未记录 |
| 交付关联 | version_ids 与实际交付结果关联该发布快照，明确底图、主成图与实际 pip 版本对应关系，不按数组位置猜测；不是凭版本号从宿主库反查或猜 path |

发布 revision 是实际产物／快照发布时的 task revision；请求 `expected_revision` 是并发前置，用途不同。普通后续 revision 前进不让旧图自动过期。snapshot_id 一旦发布，所指载荷不可变。

**发布与读取边界**

- 图片先完成写入、计算并校验 sha、安全持久保留，再在发布 outputs 的同一次 state CAS 中写入冻结载荷、pin 与快照引用；不得只提交引用、稍后补写 payload。
- 清除、回退、迁移之前先确保旧图文件安全持久保留，并在清旧引用的同一次 state CAS 中保留旧载荷／pin；仅留旧 URL 或滚动 history 不够。
- 文件预写与数据库 CAS 不是跨资源事务。文件前置失败不得发布或清旧引用；CAS 失败不宣称成功，不删除原文件。
- 模块读取只返回本模块 task state 保存的冻结载荷；不选宿主版本投影作为第二套快照路径。
- 新产物缺同源元数据为 G2/G4 未通过；旧产物真实未记录才允许缺失提示，不能从当前 props/spec/research 追补。

**描述冻结供给——新增集成契约**

1. 先集成 #125，将共享纯 `semanticAnnotationsOf` formatter 通过 **platform/contract 注入**模块；宿主与模块复用同一逻辑，不复制第二份描述算法，模块不直接 import 宿主 service。
2. drawing 的 render_draft/final_image 发布方，对本次冻结的 features/sources 运行该纯函数，将结果合入同次冻结 semantics，随图片发布初始描述快照。无事实时省略描述；不调用模型、不读取宿主当前 props。
3. 宿主注册采用唯一选定方案：事务内先检查既有交付幂等结果；首次登记先基于本次冻结输入生成补充、保留对应 `manual/name_manual` 人工所有权，得到最终 semantics，**再写成图版本 params.geometry 及同图 sources／版本关联**。当前 props.semantics 使用同一最终值，保留既有宿主事务边界。
4. 最小扩展 `MapStudioDeliveryResult`：保留 version_ids/message，回传只读 `frozen_semantics`、`sources` 及明确的关联 version_ids。返回值属于同次已登记交付，不是随后另读可变 props。
5. 模块收到注册结果后，以新的任务 published_revision 发布 delivery 快照，关联原 final 快照、同一 image sha/path 及交付身份；不回改 drawing 初始快照或任何旧图。payload、pin 与引用同一次 state CAS 提交。
6. 幂等注册重试必须取得同一次已登记交付的最终冻结语义、sources 与版本关联；不能用此后修改的 props 代替。宿主已提交但模块未持久收到结果时显示同步待确认，重试补记，不把已登记宿主副作用误判为从未发生。模块已登记该幂等结果时返回原结果／快照，不反复增加发布 revision。
7. 当前 master 尚不满足：`services/map-studio-host.ts:65-69` 先写版本 params.geometry=`d.semantics`，`:78-85` 才生成补充写 props。#125 所有权保留不是同图冻结，G2/G4 仍阻断。

**完整快照生命周期**

| 事件 | 保存方 | 发布／清除边界 | 读取入口 | 当前事实与新增工作 |
|---|---|---|---|---|
| base／可发布 draft | 模块产物执行器 | 图片与对应生产输入、已有语义及证据冻结；文件安全保留后，同 CAS 发布载荷、pin 与引用；未具备可读身份不发布为快照 | detail 引用＋`GET /map-studio/tasks/:id/snapshots/:snapshot_id` | 图片引用已有（`types.ts:215-240`）；持久身份和同 CAS 关联新增 |
| drawing 发布 | 模块阶段执行器 | final、sha、layer_doc/options、输入、注入纯函数生成的初始冻结描述同 CAS 发布 | 同上 | final/doc/options 已有（`run.ts:252-261`）；冻结供给新增 |
| 人工图层保存 | saveMapLayerDoc＋宿主注册 | 保留旧快照；重渲产生新快照，注册返回最终语义后另发布交付快照 | 模块快照及交付结果 | 重渲自动交付已有（`run.ts:608-639`）；快照绑定新增 |
| spec／几何区 options 保存 | 模块草稿保存流程 | 先安全保留旧文件，再同 CAS 保留旧载荷／pin、保存草稿并标图过期；不重渲、不交付 | 原 snapshot_id 仍可读 | spec 清除已有（`run.ts:536-548`）；options 旧分支切分与持久保留新增 |
| 回退 | rollback 流程 | 清除受影响 outputs 的同一次 CAS 保留旧载荷／pin；恢复只引用原载荷，不改其身份或语义 | history 引用＋模块持久 payload | 回退已有（`run.ts:140-163`）；窗口外保留新增 |
| texture 迁移 | 模块迁移执行器 | 文件先安全保留，再同 CAS 保留 texture 原对象、相关 outputs 与旧图证据、写迁移有效状态及清字段；关联回滚 | 迁移记录＋模块 payload | 工具及状态新增（`db.ts:68-77,168-186`） |
| 宿主交付／补交付 | complete／deliverCurrent＋宿主注册 | 宿主先合成最终语义、写版本 params，再回传 frozen_semantics/sources 与关联 version_ids；模块以新发布 revision 冻结，不改旧快照；pip 按自身产物身份绑定 | 模块快照与 deliveries | 登记、幂等已有（`delivery.ts:69-86`）；最终语义回传及模块冻结新增 |
| 显式重做 | 用户命令＋回退／执行器 | 保留旧快照，再按新政策生成新快照；旧图和人工文档不变 | 新旧 snapshot_id 分别读取 | 执行基础已有（`run.ts:140-163,330-383`）；完整读取绑定新增 |
| history 超出 30 条 | 模块存储 | 只滚动操作 history，不删除 task state 的 durable pinned 载荷／索引或对应图片 | 模块快照读取 | 不把 `slice(-30)` 当永久保留（`store.ts:400-420`） |

每行都须验证事件后旧图原数据仍可读。无需新增版本管理、来源管理或 GC 子系统。

### 6.2 默认选择规则

| 优先级 | 判定 | 展示 |
|---:|---|---|
| 1 | 本轮成功 final 已发布且快照可验证 | 本轮成图 / Current render |
| 2 | 本轮 drawing 的 render_draft 可读且身份稳定 | AI 预览，未定稿 / AI preview · Not final |
| 3 | 最后一个可验证成功历史 final | 上一版 / Previous render |
| 4 | 无可用 final/draft | 尚未生成成图 / No rendered image yet |

- final 优先于同轮 draft；complete 的 pip 与交付语义快照按各自身份显示，不无版本覆盖旧选择。
- “本轮 drawing run”不是最新 run；启动 complete 不把刚完成的 drawing 图自动降成上一版。人工产物不伪造 run。
- 只有 base 时显示“底图 · 尚未生成成图 / Base map · No final render yet”。
- 用户显式选历史快照后，轮询不抢选择，只提示“新版已就绪 / New version ready”；自动视图才切新图。
- 不从 version_id 猜 path，不拿当前 outputs 补旧输入。身份无法证明时显示“成图版本信息不完整 / Render version information is incomplete”，不能解除 G2。

### 6.3 视觉身份

| 身份 | 中文 | English | 证据 |
|---|---|---|---|
| draft | AI 预览，未定稿 | AI preview · Not final | 预览快照，不能标交付 |
| final | 本轮成图 · rN | Current render · rN | N 为该快照发布 revision |
| previous | 上一版 · rN | Previous render · rN | 历史快照身份 |
| delivered | 已交付 · 版本 N | Delivered · Version N | 实际 version_id，可展开全部 version_ids |
| previous＋running | 上一版 · 正在渲染新版 | Previous render · Rendering a new version | 历史身份与进度分离 |
| previous＋failed | 上一版 · 新版渲染失败 | Previous render · New render failed | 不继续显示进行中 |
| 人工图层产物 | 人工图层成图 | Manually edited layer render | `source='map-drawing-manual'`，不据此推断描述作者 |

可查看 snapshot_id、发布 revision、真实 run_id 及 sha；未知显示“未记录 / Not recorded”。

历史纸纹显示“纸纹：有／无／未记录 / Texture: present / absent / not recorded”，仅依据该版本证据。“再次生成不使用纸纹 / Regeneration will not use texture”是政策，不是历史事实（`delivery.ts:59`）。

### 6.4 失效规则

| 变化 | 图片呈现 | 工作流与快照处理 |
|---|---|---|
| 页面草稿变更未保存 | 编辑预览更新；图与草稿不同 | 不清服务端图、不运行 |
| spec 几何保存 | 图与当前几何不一致 / Image does not match the current geometry | 保留旧快照；按服务端清 final/doc、恢复 drawing，不自动启动（`run.ts:536-548`） |
| bbox/extent 等有效 reframed 输入变化 | 旧底图不代表新范围就绪 | 按返回回 base，清 base/kmz/pip；旧图仍可读（`run.ts:526-533`） |
| brief 变化 | 需求已变更，请重新准备地图 / Requirements changed. Prepare the map again. | 按返回 restart，不由 UI 猜测（`run.ts:476-478`） |
| 几何区 layer_options 保存，无论有无 layer_doc | 图层设置已变更，请重新渲染 / Layer settings changed. Render again. | 新设计：仅持久化并标图过期；不重渲、不交付；首次消费复用既有通道（`drawing.ts:87-95`） |
| 人工 `PUT /layer-doc` | 新人工成图及交付结果 | 明确命令后重渲、自动交付；保留旧快照，核对结果（`run.ts:608-639`） |
| 仅无关 task revision 前进 | 不自动标图过期 | 比较实际生产输入 hash，不以 revision 不等一刀切 |
| 回退／迁移／显式重做 | 保留历史图和纸纹事实 | 按生命周期先保留，再变更当前状态 |

名称变化不等于几何确认（`run.ts:500-511`）；不维护整体核对键。任务级主题入口移除，遗留字段处理见 04。

### 6.5 立即显示与收尾

**V15 统一为 drawing 阶段 render_draft/final_image 落盘至浏览器实际可见 ≤5s，保持原 v2 要求，不扩大为所有 pip 产物逐项 ≤5s。** detail 发布、轮询等待及图片加载均计入，不能从 detail 可读重新计时。本文其他位置的 drawing/final 时限简称均按此范围理解，不排除 render_draft。

| 场景 | 记录与判定 |
|---|---|
| drawing 的 render_draft 自动视图 | 记录对应预览落盘、detail 首次读到对应快照、浏览器实际显示三个时间戳；验证落盘→实际可见 ≤5s；保留“AI 预览，未定稿”标识 |
| drawing 的 final_image 自动视图 | 记录对应成图落盘、detail 首次读到对应快照、浏览器实际显示三个时间戳；验证落盘→实际可见 ≤5s，包括阶段结束后的发布与加载 |
| complete 的 pip 细节／合成图 | 验证各自产物身份、可读性与交付归属；不新增逐项 ≤5s 硬指标 |
| 用户停留历史图 | 不抢选择，出现新版入口；另用自动视图执行 render_draft 与 final_image 的 V15 实测 |

三个时间戳须对应同一产物／快照，计算浏览器实际显示时间减落盘时间。每 3s 轮询不等于通过。status 离开 running 也不足以停止读取：已知仍有待发布引用时继续只读同步，显示“正在同步成图 / Syncing the rendered image”；读取失败显示连接错误。明确失败／取消且无待发布产物后结束等待。

图片、sha、发布 revision 和同源引用齐全才切换；新产物缺引用不能靠降级通过 G2。draft 不因画面完整升级为 final。本节不声称已有实现达标。

### 6.6 大图与查看器

点击②进入全屏只读查看，保留身份、快照选择和图层入口。缩略图与全屏共用所选快照；关闭只清显示层状态，不清图片选择或其他深链状态。

## 7. 图层描述查看器

### 7.1 入口和布局

- ②右上“图层 / Layers”中性按钮打开右侧栏；成图待交付时默认展示。
- 左侧所选图片，右侧上部层列表、下部选中层描述；全屏保留右栏，窄屏改下方面板。
- 查看器只读，不复用图层编辑器写按钮，不提供“保存描述”。

### 7.2 层 → 要素映射与 #125 字段

锚定层通过所选快照的 `semantic_id` 和明确类别匹配 `semantics.points/lines/regions[].id`；禁止名称模糊关联、跨类别猜测。多层共用要素时显示同一冻结描述。描述生成阶段用 `feature_id` 精确关联研究 feature，不用名称或数组位置代替。

| 展示项 | 来源／字段 | 规则与缺失处理 |
|---|---|---|
| 层名／类型／几何摘要 | 同快照 layer_doc | 无 doc 显示此版本未保存图层数据；无锚定层仅显示自身摘要 |
| 要素名称 | 同快照类别＋id 的 name | 缺失保留层名，提示名称未记录 |
| description | 同快照 `description?:string` | ≤500 字；缺失显示暂无描述，不拿 keywords 或当前 brief 替代 |
| keywords | 同快照 `keywords?:string[]` | ≤12 项、每项≤20 字；缺失省略关键词组 |
| 描述／关键词所有权 | `manual?:boolean` | true 标“人工维护条目 / Manually maintained entry”，说明描述／关键词已人工维护；不等于从零人工撰写 |
| 名称所有权 | `name_manual?:boolean` | 独立标“名称已人工维护 / Name manually maintained”，不推断描述所有权 |
| 条目来源 | `source='cv'|'vlm'|'manual'` | 与上述两个所有权字段独立；不凭 source 推断人工描述 |
| 研究出处 | 冻结 features/sources 的 basis、coordinate_basis、excerpt、source_ids | 仅解释性 tooltip；不加来源管理；缺失不从当前 research 回填 |
| 宿主资产描述 | 新增 `detail.host.target.description` | 来自 contract.describe target，只读；缺失为宿主信息未提供 |
| 宿主参考图 | 新增 `detail.host.target.reference_images` | 同上，不混称任务配准参考图 |
| 任务备注／配准图 | 当前 `brief.notes/reference_image` | 另列需求语境；不冒充宿主字段或历史输入 |

最新事实：

- #125 已合入 master `cdb2a854`，本 worktree `2d9655b1` 尚未集成；不能再写 manual 未知或 master 未合入。
- 字段限制与独立所有权见 master `asset-semantics.ts:42-62,141-146`；`markManualSupplements` 比较上一版本，描述／关键词变化设 manual，名称变化设 name_manual；`withGeneratedSupplements` 保留对应人工字段（`:394-474`）。
- 唯一描述代码生产者为 `services/map-semantic-annotations.ts:67-97` 的 `semanticAnnotationsOf`：精确 feature_id 关联，组合 basis、coordinate_basis 说明、excerpt 及最多 3 个来源标题，截到 500 字；keywords 只取 category，不是别名或分词。无事实省略，不调模型。
- 共享纯生产者对 drawing 同次冻结 features/sources 生成初始描述；交付时宿主最终所有权合成结果回模块，另发不可变快照。当前 master 的版本 params 尚无这一保证（`services/map-studio-host.ts:65-69,78-85`），具体生命周期见 §6。
- 宿主 description 原先仅作 notes 默认值，reference_images 未透出（`map-studio-host.ts:100`、`sqlite-schema.ts:389`）；新增字段仅走 describe target，不增加写权限。brief.reference_image 含配准控制点（`types.ts:58-64`），不是宿主图库。

### 7.3 版本与不一致规则

- 查看器按 `mssnapshot` 读取模块不可变 payload 中的 layer_doc、semantics、features/sources，标题“对应图片 rN / For image rN”，N 为快照发布 revision。
- 当前 spec 编辑不改变历史描述。类别＋ID或要素几何 hash 不匹配时，禁用“定位到当前编辑器 / Locate in current editor”，说明几何已变更。
- drawing 初始描述和交付最终人工所有权语义可以形成不同发布快照；即使图片 sha 相同也不覆盖旧 snapshot_id。
- 不用当前 props.semantics 回补旧图，不因 #125 已合入而宣称旧 params 含最终描述。
- ①当前宿主描述与参考图不是历史图片输入；解释历史图只能读该快照已冻结内容。
- G4 用真实产物验证类别＋ID、feature_id、description、keywords、manual/name_manual/source 独立性及来源保留；后续编辑和交付后重选旧图，必须不漂移。
- history 窗口外仍由模块持久 payload 读取；新产物缺同源字段、回传未实现或宿主只读字段未供给，均不能以诚实缺失态代替 G2/G4 验收。

### 7.4 空态与缺字段文案

| 场景 | 中文 | English |
|---|---|---|
| 无成图 | 成图生成后可查看图层 | Layers will be available after rendering. |
| 无同源 layer_doc | 此版本未保存图层数据 | No layer data was saved for this version. |
| 无 description | 暂无要素描述 | No feature description is available. |
| manual=true | 人工维护条目 | Manually maintained entry |
| manual=true 且无描述 | 人工维护条目 · 暂无描述 | Manually maintained entry · No description |
| 所有权说明 | 描述／关键词已人工维护 | Description/keywords manually maintained |
| name_manual=true | 名称已人工维护 | Name manually maintained |
| 无来源出处 | 来源未记录 | Sources were not recorded. |
| 宿主字段未供给 | 宿主信息未提供 | Host information not provided. |
| 无任务配准图 | 任务配准参考图未提供 | Task georeferencing image not provided. |
| 无锚定 | 此图层未关联语义要素 | This layer is not linked to a semantic feature. |
| 锚定失效 | 该快照中找不到关联要素 | The linked feature is missing from this snapshot. |
| 几何不一致 | 当前几何已变更，无法保证对应位置一致 | Geometry has changed; matching positions cannot be guaranteed. |
| 快照不可读 | 此版本的同源数据不可用 | Matching snapshot data is unavailable for this version. |

缺失态不自动生成、保存或重渲；“人工维护条目”不是“人工描述作者”声明。

## 8. AI 活动抽屉

### 8.1 入口与尺寸

顶栏固定“活动轨迹图标＋AI 活动”，运行时附动态标记，失败时附警示点；不显示日志计数堆叠 chip。

桌面宽 560px，可全屏，不关闭宿主地图面板。默认活动 run，无活动则最近 run；深链指定 run 优先。

### 8.2 内部结构

| 分区 | 数据源 | 默认形态 | 空态 |
|---|---|---|---|
| 运行列表 | detail.agent.runs | 当前 run 选择器，可展开历史 | 尚无运行记录 |
| 逐轮记录 | rounds/attempts＋所选 run observed | 当前轮展开、历史轮折叠 | 此运行暂无逐轮记录 |
| 调用与消息 | `/runs/:id/observed`、`/calls/:id/messages` | 点 call 才加载消息 | 此调用暂无消息 |
| 失败现场 | 所选 run 的错误、rounds、problems、steps_used | 失败 run 默认展开 | 此运行未记录失败现场 |
| 模型与运行设置 | 既有模型配置、真实 mode/stop_at | 折叠 | 配置不可用时说明 |
| 任务变更／交付历史 | history、deliveries | 折叠只读 | 暂无历史记录 |

当前 detail.error_detail 不能冒充历史 run 的错误。若 observed 供给不足，补齐同一读取／记录链路，不凭当前错误猜测；未完成仍阻断 G7。

auto 是高级启动命令，不是默认制图偏好；主路径不暴露 manual/auto 开关。

### 8.3 只读与操作边界

| 操作 | 放置 | 规则 |
|---|---|---|
| 查看 run／round／call／消息 | 抽屉 | 纯 GET，选择不启动任务 |
| 切换模型 | 模型设置 | 显式保存，不自动重试；运行中不改当前 run |
| 续跑／重试 | ④唯一主动作 | 抽屉仅“返回主界面处理 / Return to workspace”；保留真实 mode/stop_at |
| 清空 research progress | 抽屉危险操作 | 非运行、无未知结果／冲突、二次确认；沿用 clear，不自动再跑；破坏旧产物前遵守快照保留 |
| cancel | ④更多菜单 | 抽屉只显示取消状态；确认后不启动下一阶段 |
| 回退 | 顶栏更多／阶段轨确认 | 同一命令；运行中禁止，上限 2 次（`run.ts:140-163`） |
| 高级 auto | 抽屉明确命令 | 通过全局写前置后，确认警告才发 `/run {mode:'auto', expected_revision}` |

完整警告：

> 自动运行可能越过人工几何核对，并连续执行到交付。是否启动？  
> Automatic execution may bypass manual geometry review and continue through delivery. Start now?

按钮为“启动自动运行 / Start automatic run”“取消 / Cancel”。打开抽屉、保存模型、深链恢复及刷新均不启动 auto；不得持久化为影响默认检索／渲染的隐含偏好。

默认检索固定 guided/base、显式渲染固定 guided/drawing。UI 与服务端同批切换，不新增能力发现字段，不提供永久 manual 分步兼容路径；任一终点未就绪即 G1 阻断。既有 manual/auto 执行语义仍保留，不等于新增第二条默认 UI 流程。

auto 按 proceed 连续推进，complete 会交付（`run.ts:291-300,264-275`），不是“只推进不交付”。

### 8.4 请求时序

1. 打开时复用 detail 的 runs/rounds/attempts，不重复请求整任务。
2. 确定所选 run 后 GET observed。
3. 展开轮次筛选已取内容；仅接口已有分页支持时分页，不假定字段。
4. 校验 call 属于所选 run 后 GET messages。
5. 切 run 保留读取缓存，取消或忽略旧响应；消息不能落到新 call。
6. 抽屉打开且当前 run 进行中时更新观测；历史终态不持续轮询。
7. 关闭仅停止观测刷新，不影响主 detail 同步。

深链保留 `msactivity/msrun/mscall/mscf/msround`。

**V33 验收**：选择真实多轮失败 run，切到另一 run，再从历史重开。逐轮核对 rounds、attempts、calls/messages、失败原因、problems、steps_used 的归属，记录 task/run、轮次和消息读取证据。

缺失时显示“此运行记录不完整，无法完整回看失败现场。 / This run has incomplete records; full failure review is unavailable.” 降级不等于通过；本 Issue 验收样本缺记录必须补齐，历史遗留缺失单独登记。

## 9. 动作条：唯一主动作矩阵

### 9.1 API 记法与约束

| 记法 | 路由请求／语义 |
|---|---|
| SEARCH | `POST /tasks/:id/run {mode:'guided', stop_at:'base', expected_revision}` |
| RENDER | `POST /tasks/:id/run {mode:'guided', stop_at:'drawing', expected_revision}` |
| RUN | `POST /tasks/:id/run {mode:'manual'|'auto', expected_revision}`，保持原语义；不得携带 stop_at |
| ADVANCE | `POST /tasks/:id/advance {expected_revision}`；stage=complete 时异步执行 complete |
| SAVE | `PUT /tasks/:id {map_spec, layer_options, expected_revision}`；页面整份几何／选项草稿，仅持久化并失效成图 |
| CONFIRM | 同一既有 spec PUT 通道，显式清 proposed，携带最新 expected_revision；不附带 run |
| SAVE BRIEF | 沿用 writeBrief 及既有请求契约；成功按返回 stage 重算 |
| SAVE LAYERS | 人工图层专用 `PUT /layer-doc`，沿用既有 CAS；按钮明确“保存图层并重渲交付” |
| DELIVER | `POST /tasks/:id/deliver`，**无 CAS 参数**；仅失败重试／补交付，不渲染 pip、不改变 task status |
| 取消／回退／清空／续跑 | 复用既有页面／#124 命令，不猜新路由；续跑携带原合法 mode/stop_at |

路由字段为 `expected_revision`；内部 TypeScript 才是 `expectedRevision`。不得给所有写端点统一虚构 CAS。run/advance 启动响应为 detail，终态与交付结果随后读取。

### 9.2 全局覆盖规则

按表从上到下匹配；`*` 覆盖六阶段、六状态和 manual/guided/auto。前一规则未解除不得执行后一规则，非主入口同样不能绕过写前置。

| 优先级 | 条件 | 唯一主动作 | 限制 |
|---:|---|---|---|
| 1 | `status=running` | 禁用进度按钮 | 只读；更多可取消，不能另起写操作 |
| 2 | 任意非 running，写结果未知 | 核实结果 / Verify result → GET detail／deliveries | 不盲重发，不断言未落盘；核实前不保存、确认、渲染或交付 |
| 3 | 任意非 running，CAS 冲突 | 查看并处理冲突 / Resolve conflict | 保留副本不是覆盖；重应用用最新 revision |
| 4 | 任意非 running，有未保存草稿，**包括 failed** | 保存需求／保存几何；非法局部形状则先定位修复 | 所有更低优先级恢复、确认、运行、交付暂停；成功后按返回 stage 重算 |
| 5 | 真实 blocking 或 failed | 可修复先定位；修复保存后重算；无修复项才按 §9.4 恢复 | soft geometry 不伪装 blocking；unknown kind 明示，不猜模式 |
| 6 | 无上述条件 | 正常阶段动作 | 按 §9.3，不从 step pending 推断 workflow 状态 |

人工 layer_doc 未保存时，必须先明确选择其“保存图层并重渲交付”命令或放弃，不能伪装为几何保存；页面不并行提交两种文档。涉及多类草稿先解决当前明确编辑事务，不自动跨通道连发。

### 9.3 正常阶段动作

以下仅在 §9.2 前五项均不适用时进入。旧 run 的 mode 不把默认按钮变成 auto；旧 run 恢复另按真实执行边界处理。

| 当前事实 | 默认主动作 | 终点／成功后状态 | 限制 |
|---|---|---|---|
| brief，subject 缺失 | 补全需求 / Complete requirements | 保存后重算 | 不发 run |
| brief/research，输入有效 | 一键检索／继续检索 → SEARCH | base 完成即 `style/awaiting_review` | 不自动 drawing；保留既有 research 进度 |
| base，尚未完成 | 准备底图 / Prepare base map → SEARCH | base 完成即停 | 不重跑已完成 research |
| style/drawing，底图无效 | 定位底图／配准问题 / Review base map issues | 修复后按返回 stage 重算 | 不跳过 missing_base、画幅或 registration 前置 |
| style/drawing，底图有效，有待确认要素 | 确认几何 / Confirm geometry → CONFIRM | 权威 PUT 成功后重算 | 不自动渲染；请求未知回到全局核实 |
| style/drawing，底图有效、无待确认要素 | 渲染成图 / Render map → RENDER | `complete/awaiting_review` | 全已 confirmed 也必须显式点击 |
| complete，idle/awaiting_review，产物有效 | 交付成图 / Deliver map → ADVANCE | complete：pip → 构建 → 交付 → completed | 启动 HTTP 不等于交付完成 |
| complete，取消后 idle | 交付成图 → ADVANCE | 重新校验后执行 complete | 不因取消前有请求就报成功 |
| complete，completed，宿主结果已核对 | 查看交付 / View delivery | 只读 version_ids 与实际结果 | startRun 拒绝直接再跑；可下载或显式重做 |
| complete，completed，standalone | 查看成图／下载 / View render / Download | 无宿主版本 | 不标已交付到资产 |
| 非 complete，workflow completed，或状态组合矛盾 | 刷新状态 / Refresh state → GET | 核对真实状态 | 不猜写操作 |
| steps[].status=pending | 不单独分派 | 依真实 stage/status | pending 是 step 状态，不是 workflow status |

drawing step completed 通常意味着 detail 已进入 complete（`run.ts:191-199`）；不能把 `stage=drawing,status=completed` 当合法交付停靠。

style 在 guided/drawing 中自动跳过出图并写 texture_image=null，再进入 drawing；guided/base 到 base 即结束，不执行 style（既有 style 行为 `run.ts:244`，有界循环为新增设计）。

### 9.4 失败分型与恢复边界

本表仅在未知结果、冲突和草稿均已处理后使用。所有 kind 都先处理真实可修复前置；修复保存改变 stage 后，旧错误不得继续主导动作。

| kind／事实 | 横幅文案 | 唯一主动作 | 次要动作与限制 |
|---|---|---|---|
| steps_exhausted | 轮次已用尽，本轮未完成 / Step limit reached; this run is incomplete | 支持续跑则续跑当前阶段，否则明确重试 | 查看轮次、显式切模型；research 可另行清进度 |
| ended_without_delivery | AI 已结束，但未提交有效产物 / AI ended without a valid result | 继续完成当前阶段；不支持则重试 | 查看最后消息；预览不是最终产物 |
| call_error | 模型调用失败，已有结果已保留 / Model call failed; existing results are preserved | 配置无效先修复；有效才重试 | 保存配置不自动重试，不强制换模型或清进度 |
| rejected | 产物未通过校验 / Result validation failed | 定位并处理问题 | 修复→保存→按新 stage 重算；切模型不能跳过校验 |
| mixed | 本轮存在多类失败 / Multiple failure types occurred | 查看并处理问题 | 根据现场确定恢复，不擅选一种原因 |
| error_detail=null | 当前阶段失败，未提供分型 / Stage failed without classified details | 查看 error 与失败现场，处理前置后重试 | null 不等于没有失败（`run.ts:305-329`） |
| unknown kind | 未识别的失败类型：{kind} / Unrecognized failure type: {kind} | 查看失败详情 / Review failure details | 保留原始 kind；不猜自动续跑或清空 |
| 已证实 complete 宿主交付失败，现有产物及 pip 齐全有效 | 交付失败，成图已保留 / Delivery failed; render preserved | 重试交付 / Retry delivery → DELIVER | 不重渲 pip、不改 status；读取并核对实际版本 |
| complete 需要补渲／重渲 pip | 交付产物未就绪 / Delivery artifacts are not ready | 修复后 ADVANCE 执行 complete | 不用 DELIVER 准备 pip |

续跑必须保留该失败 run 的真实 mode/stop_at：manual 仍单阶段，auto 仍连续至 proceed 停止，guided 保留原终点；不能仅凭失败 stage 推断成 guided。auto 恢复须再次明确其越过核对直至交付的风险。

旧 run 边界未记录时显示“原执行边界未记录 / Original execution boundary was not recorded”，不能标“续跑原流程”；先读取现有记录，仍未知则由用户明确选择新的合法命令。编辑／回退改变起点导致原边界非法时，按新 stage 重新分派，不偷偷改 stop_at。

失败横幅不复制写按钮。取消确认后只呈现真实 idle/pending，不启动下一阶段（`run.ts:586-604`）。

## 10. 「一键检索／调研」停靠契约

### 10.1 请求字段、用户动作与执行边界

以下为新增设计，不是当前已实现能力。端点为 `POST /map-studio/tasks/:id/run`。

| 字段 | 值域与规则 |
|---|---|
| mode | manual / auto / guided；前两者保持原语义 |
| stop_at | 仅 guided 必填，base / drawing；manual/auto 携带、guided 缺失或非法值均拒绝，不静默降级 |
| expected_revision | 当前服务端 revision；CAS 拒绝不创建 run。内部 TS 名为 expectedRevision |
| 其他推进别名 | 不引入 through 或另一套有界字段 |

guided 从当前合法阶段执行，不隐式回退，不为满足终点重跑已完成阶段；中间成功且允许推进时继续，到目标成功结束即停。它不是默认偏好，不记录几何确认。

| 用户动作 | 请求 | 合法起点与边界 |
|---|---|---|
| 一键检索／继续检索／准备底图 | `/run {mode:'guided', stop_at:'base', expected_revision}` | brief/research/base → base 完成即停 |
| 确认几何 | 既有 spec PUT，清 proposed，携带 expected_revision | 无待确认字段不空写；不 run/advance/deliver |
| 渲染成图 | `/run {mode:'guided', stop_at:'drawing', expected_revision}` | style/drawing → drawing 完成即停 |
| 交付成图 | `/advance {expected_revision}` | complete → 异步执行 pip、构建、交付、completed |
| 失败补交付 | `POST /deliver`，无 CAS 参数 | complete、非 running、产物齐全有效；不渲染 pip、不改 status |
| 高级自动运行 | `/run {mode:'auto', expected_revision}` | 明确警告后启动，保持既有连续推进 |

guided/drawing 不接受 brief/research/base 起点，避免跨越 base 停靠；guided/base 不接受 style/drawing/complete 起点。非法起点拒绝且不启动 run；重新检索须先显式合法回退。

默认 UI 渲染前必须无草稿／冲突／未知结果、底图有效。若有待确认要素，先确认且等待权威 PUT 成功；若已经全 confirmed，不需要额外整体核对键，但仍须独立点击渲染。此为 UI/guided 保证，不新增服务端几何闸门。

### 10.2 成功、失败与取消状态序列

| 执行段 | 请求与必须呈现的事实 |
|---|---|
| guided/base 启动 | 校验 busy、subject、expected_revision 及执行前置后创建 run；启动响应 detail 不是终态 |
| research 完成 | research step completed，base/running；软几何提示不阻塞 |
| base 完成 | 发布 base 与 bbox；`style/awaiting_review`，run 结束，不执行 style |
| 保存与确认 | 整份 spec/options CAS 保存；需要时独立确认 PUT；不附带运行、不建整体核对标记 |
| guided/drawing 启动 | 用户点击；style 固定跳过出图，texture_image=null，再进入 drawing |
| drawing 完成 | final 与初始描述快照同 CAS 发布；`complete/awaiting_review`；run 结束 |
| 交付启动 | 用户点交付，`POST /advance {expected_revision}`；返回 detail，随后继续轮询 |
| complete 执行 | renderPipAssets → buildDeliverable → deliverCurrent → finish(proceed:false) → completed（`run.ts:264-275`） |
| 终态核实 | 读取 deliveries/version_ids，与实际宿主交付行对应；最终语义回传并由模块冻结；不能把启动响应当此结果 |

**交付前置、输出与副作用**

| 项目 | 契约 |
|---|---|
| 前置 | stage=complete、非 running、无草稿／冲突／未知写结果；advance 使用最新 revision；spec/base/final/layer_doc 齐全、图与输入一致、平滑与标注有效 |
| 构建 | 缺产物为 missing_drawing，平滑／标注问题为 drawing_invalid；读取实际文件算 final sha（`delivery.ts:15-67`） |
| 宿主登记 | 插入／幂等取得底图、成图 sys_task；更新资产图片、faithful、semantics，登记来源及 pip（`map-studio-host.ts:24-60`） |
| 新增回传 | 注册结果将 version_ids 与该次最终语义一并回模块，模块按 §6 冻结；不查询可变 props 补历史 |
| 事务外 | 保留既有资产库变更钩子（`map-studio-host.ts:131-136`） |
| 成功判据 | version_ids、模块 deliveries、实际交付行对应同 task/png sha/pip key；不是仅 HTTP、图片或 status 成功 |
| standalone | 无宿主版本可为 []（`delivery.ts:80`）；显示流程完成与下载，不说已交付宿主 |
| 幂等 | 同 task+png sha+pip key 不重复插行；重复补交付返回相同版本（`map-studio-host.ts:32-34`） |
| deliver 特性 | 无 CAS 参数，不准备／重渲 pip，不改 task status；补交付成功与任务状态分别展示（`routes.ts:141-148`、`delivery.ts:69-86`） |

**失败、取消与重试**

- buildDeliverable 失败可回 drawing（`run.ts:272`）；先定位修复，保存后按返回新 stage 重算，不继续套旧 complete 动作。
- 宿主登记失败且产物／pip 完整有效时可显式 deliver；需要准备或重渲 pip 时必须走 advance 执行 complete。
- 客户端超时先读 detail/deliveries，核对版本；无法确认时显示“交付结果待确认 / Delivery result pending confirmation”。幂等不是盲重发理由。
- 普通错误写 failed，error_detail 可为 null；Stale/Conflict 只结束 run，不改状态，需重读（`run.ts:305-329`）。
- 失败、真实阻塞、取消确认、proceed=false 或到终点，任一先发生即停止。续跑保留真实 mode/stop_at，不按 stage 擅改边界。
- 取消期间显示“正在取消… / Cancelling…”，确认后 running step→pending、run_id=null、status=idle（completed 保持）；不启动下一阶段，不声称撤销已发生的外部交付（`run.ts:586-604`）。
- workflow_busy 只刷新活动 run；revision 冲突进入冲突流程。刷新、返回页面、深链恢复不补发写请求。

### 10.3 执行策略兼容

| 请求形态 | 行为 |
|---|---|
| 旧 manual | 保持一次一个阶段 |
| 旧 auto | 保持按 proceed 连续推进，可能越过核对直至交付 |
| guided + base | 合法起点连续到 base 完成，必停 |
| guided + drawing | 合法起点连续到 drawing 完成，必停，不执行 complete |
| 非法 mode/stop_at 组合 | 拒绝，不降级或忽略 |

**UI 与服务端同批切换。** 不新增能力发现协议，不增加永久分步兼容第二流程。两个 guided 终点及原边界读取是 G1 必须实现的能力，未就绪显示“有界运行尚未就绪 / Bounded execution is not ready”，阻断实现／验收，不以 manual 或 auto 替代一键检索宣称完成。

既有客户端 manual/auto 语义不改；技能调用迁移到明确的 guided 请求时一并更新契约测试。运行读取保存本次实际 mode 和 stop_at；这是 run 执行事实，不是能力列表。旧 run 缺边界时按 §9.4 处理，不猜测自动续跑。

### 10.4 V5 订正与结论

| 原要求 | 已核实事实 | 实际保证 | 不保证范围 |
|---|---|---|---|
| 人核对确认后才渲染；调研在 base 停靠 | 无服务端几何确认闸门；确认用 PUT 清 proposed；auto 可到交付（`accuracy.ts:88-95`、`store.ts:575-595`、`run.ts:500-511,291-300,264-275`） | 默认 UI/guided：base 停靠；待确认先确认并等权威成功；全已 confirmed 仍显式点击渲染；drawing 完成即停 | 直接 API、其他客户端、显式 auto 不受默认 UI 保证；本 Issue 不改服务端闸门 |

**V5：设计闭合（主 agent 裁定）。G5：已裁定，保证范围 = 默认 UI/guided；服务端仍不强制。** G1 仍待实现与实测。

确认生命周期：

- 坐标变化的 manual/confirmed 行为及仅改名称不确认按 `run.ts:500-511`；不自动替人确认其他要素。
- 刷新按权威要素状态重建计数，不要求整体复核键。“待核对”统一采用 geometryUnverified 口径，含 dataset_missing（`accuracy.ts:88-95`）；草稿 proposed 数量可另显示为“AI 候选数 / AI candidate count”，不得名为“待核对”，不改变服务端判定。
- 草稿、冲突、未知结果先按全局优先级处理；确认不捎带渲染。
- 无待确认字段不空写；有待确认字段但 PUT 未确认成功时不渲染。

| 验收场景 | 请求与结果证据 |
|---|---|
| 默认检索 | guided/base；research 自动接 base，base 后无 style/drawing/complete |
| 待确认 | 确认 PUT 权威成功前无渲染；确认本身不附带 run |
| 全已 confirmed | 不要求整体核对键；无显式点击仍不渲染 |
| 显式渲染 | guided/drawing；停在 complete/awaiting_review |
| 刷新／弹窗／深链 | 零运行、保存、确认、交付；计数恢复一致 |
| auto | 显示越过核对直至交付警告；取消零请求，确认才运行 |
| 非保证范围 | 记录直接 API/auto 的服务端事实，不要求被不存在的几何闸门拒绝 |

录像、请求轨迹、状态及产物记录必须一致；设计文本不能替代证据。

## 11. 深链键清单

所有键只控制视图，恢复零写。新增必要键加入既有 DEEPLINK_KEYS；不新增布局、滚动、额外列表筛选或来源管理键。

### 几何编辑必要键

| 键 | 值域与含义 | 恢复与失效处理 |
|---|---|---|
| msgtab | points/lines/regions | 恢复 TAB 硬显隐；非法回地点 |
| msgeo | 既有 kind:id | 验证任务内实体，合法选择类别优先于冲突 TAB；无实体取消选择 |
| msgzoom | 有限数，1..16 | 越界钳制，非数值回 1 |
| msgcx、msgcy | 成对的归一化中心 0..1 | 按可见边界钳制；非法居中 |
| msgpoints | 03 定义的全部地点／指定线面点列表目标 | 用已保存数据打开，不恢复坐标草稿；目标失效关闭弹窗 |
| msgrow | 点列表行号 | 仅在目标存在、行号合法且 msggeorev 匹配时定位行 |
| msggeorev | **目标要素已保存几何内容 hash** | 不是任意 task revision；hash 不匹配即退要素级，不选行，即使行号仍合法 |

顶点无稳定 ID（`services/layer-doc.ts:91,96,101`），因此 msgrow 不能脱离目标几何 hash 使用。行号的基准与序列化沿用 03，01 不另设一套；hash 覆盖该目标几何的实际坐标内容与顺序，名称或无关 task revision 变化不使行定位失效。

### 大图、图层与 AI 活动必要键

| 键 | 恢复规则 |
|---|---|
| msstage | 六阶段事实选择，只读，不推进 |
| msactivity | AI 抽屉开关／full；非法回默认 |
| msrun | 校验属于当前 task；失效回最近 run |
| mscall | 校验属于所选 run 后读取消息；失效回运行概览 |
| mscf | 保留既有 AI 活动阶段筛选 all/stage；不扩展为几何列表筛选 |
| msround | 当前 run 轮次；失效回概览 |
| msview | base/final/previous；兼容历史 texture/calibration，沿用既有解释 |
| mssnapshot | 精确快照，禁止跨任务；失效回可用快照并提示 |
| mspreview | 全屏只读大图开关 |
| mslayers | 所选快照只读图层栏开关 |
| mssel | 所选快照 layer id；失效回列表 |
| mslayer | 保留既有图层编辑器值域与解析器，只打开不保存 |

旧 texture 只查看可读历史纸纹，不进入新渲染；calibration 是任务配准视图，不标成图。未在事实底座展开的旧值域沿用原解析器，不重新解释。

### 恢复顺序与反馈

1. 解析 URL → GET detail → 验证实体归属 → 验证目标几何 hash → 恢复视图。
2. hydration 仅更新 view state，不 emit update，不触发保存 watcher。
3. 草稿从权威已保存 spec 克隆，URL 不接收坐标草稿、确认标记或执行命令。
4. GET 只填读取缓存；只有显式命令可进入写服务。
5. zoom/pan 仅改视图，地址规范化使用 replace，不写业务数据。
6. 关闭点列表只清其 msgpoints/msgrow/msggeorev，不清 TAB、要素和视口；关闭大图或活动也只清自身显示层状态。

| 失效场景 | 中文 | English |
|---|---|---|
| 要素缺失 | 要素已不存在，已取消选择 | Feature no longer exists; selection cleared. |
| 几何 hash 不匹配 | 要素几何已变更，已返回要素，不定位顶点行 | Feature geometry changed; showing the feature without selecting a vertex row. |
| 行号越界 | 顶点行不可用，已返回要素 | Vertex row is unavailable; showing the feature. |
| 点列表目标缺失 | 点列表目标不可用，已关闭弹窗 | Point-list target is unavailable; dialog closed. |
| zoom／中心非法 | 视图参数无效，已恢复可用视图 | Invalid view parameters; a usable view has been restored. |
| 快照缺失 | 此成图版本不可用，已显示可用版本 | Render version unavailable; showing an available version. |

G9 验收覆盖刷新、新标签、关闭子层、实体失效、行号合法但 hash 不匹配、越界 zoom；均断言零保存／生成／确认／交付。

## 12. 组件分解建议

页面 controller 统一写 API；子组件只发事件，不维护独立保存路径。

| 组件 | 职责 | props | emits | 既有组件处理 |
|---|---|---|---|---|
| MapWorkspaceHeader | 身份、阶段、活动入口 | host、phase、activity | openActivity、openStage、command | 保留 MapHostHeader，去重复标题 |
| MapAssetSummary | 当前宿主只读信息、brief | hostTarget、brief、readonly | saveBrief、discard | 改造 MapBriefForm，移除主题选择；hostTarget 来自 detail.host.target |
| MapCurrentImage | 快照选择、身份、新版提示 | snapshots、selectedId、staleness | select、openPreview、openLayers | 提取 MapResults 呈现 |
| MapImagePreview | 全屏只读查看 | snapshot、layersOpen | close、selectLayer | 迁移 Teleport |
| MapGeometryWorkspace | TAB、画布、列表 | specDraft、layerOptionsDraft、base、readonly | draftChange、finishEdit、selectionChange、viewportChange | 拆分 MapGeoEditor，不另持业务草稿 |
| MapGeometryCanvas | SVG、命中、换算 | specDraft、activeKind、viewport、registration | draftChange、viewportChange、select | 保留 meet，补 zoom/pan 逆变换 |
| MapGeometryList | 地点／线面条目、局部收尾 | specDraft、activeKind、activeId、editTransaction | draftChange、finishEdit、openPoints、select | 无行保存；删除进入页面草稿 |
| MapPointListDialog | 全部地点／顶点 | target、specDraft、readonly | draftChange、finishEdit、close | 合法输入即入草稿，无 save，关闭不提交 |
| MapDockBar | 唯一主动作 | action、secondary、reason | command | 只使用 §9 分派结果 |
| MapStagePopover | 阶段事实、回退入口 | steps、selectedStage、rollbackCount | select、requestRollback | 改造 MapStagePanel |
| MapAIActivityDrawer | 观测、配置、明确 auto | detail、selection、open | selectionChange、saveConfig、requestAuto、clearProgress、close | 改造 Process/Rounds/ModelPicker |
| MapLayerDescriptionViewer | 同源层、描述、证据 | snapshot、layerDoc、semantics、features、sources | selectLayer、locateFeature、close | 只读，无描述保存 |
| MapAdvancedLayerEditor | 人工 layer_doc 编辑 | layerDoc、revision、readonly | saveLayerDoc、close | 保留既有专用 PUT；按钮“保存图层并重渲交付” |
| MapDeliveryHistory | 版本读取 | deliveries | view | 主交付由动作条 advance，历史不复制写按钮 |

### 状态归属

| 状态／职责 | 唯一归属 | 规则 |
|---|---|---|
| detail、task revision、保存基线 | 页面 workflow controller | GET／权威写响应更新；JSON 发 expected_revision，内部可用 expectedRevision；子组件不自增 |
| specDraft | 页面 controller | 唯一几何草稿；行、弹窗、画布共享 |
| layerOptionsDraft | 同一 controller | 与整份 spec 一次 CAS；无几何变化发原样服务端 spec；有 layer_doc 也不借道重渲交付 |
| 局部形状事务 | 页面编辑事务状态 | 未完成顶点及撤销基线不是第二份可提交 spec；finishEdit 收尾，不 PUT |
| TAB、选择、视口、点列表行 | 页面 view state | 八个必要几何键；msggeorev 为目标几何 hash；恢复零写 |
| 图片选择／读取缓存 | 页面快照状态 | 按 snapshot_id，不以当前 task revision 拼接载荷 |
| 持久快照 | 模块存储 | 最小不可变 payload，复用 history 形状；不是浏览器缓存或滚动 history |
| run/call 观测缓存 | 活动读取层 | 历史错误归属所选 run，不借当前 error_detail |
| 未知结果／CAS 冲突 | 页面 controller | 优先于草稿、失败恢复及正常阶段；保留既有 5d 副本，不盲重发 |
| mode/stop_at | 服务端 run 事实＋页面读取 | 用于恢复真实边界，不作为能力列表或默认偏好 |
| 路由、轮询、编排 | task.vue | 一套主动作判断、一套写服务 |

保存链路：数值编辑／删除／拖拽 → 既有 cloneSpec/markManual 更新逻辑 → draftChange → 页面唯一草稿 → 用户“保存几何”→ 整份 spec/options CAS。预览立即更新，不立即 PUT；仅改名称不误标几何确认。

成功采用规范化返回与 revision。拒绝／409 恢复已保存画布并可留副本；未知结果先读，revision 前进且内容匹配才认定成功，否则冲突处理。

确认是独立显式命令，不附带运行。advance 异步执行 complete；deliver 无 CAS 参数、仅补交付、不改 status。所有写命令不能从挂载、watcher、弹窗关闭或 URL 恢复触发。

## 13. 文案与本地化

完整插值句，不拼接不同语言片段；zh/en 为源文案，实施同步 ja/ko。删除“准备交付”虚拟步骤文案。

| 键名建议 | zh | en |
|---|---|---|
| mapStudio.image.draft | AI 预览，未定稿 | AI preview · Not final |
| mapStudio.image.final | 本轮成图 | Current render |
| mapStudio.image.previous | 上一版 | Previous render |
| mapStudio.image.delivered | 已交付 | Delivered |
| mapStudio.image.previousRendering | 上一版 · 正在渲染新版 | Previous render · Rendering a new version |
| mapStudio.image.previousFailed | 上一版 · 新版渲染失败 | Previous render · New render failed |
| mapStudio.image.baseOnly | 底图 · 尚未生成成图 | Base map · No final render yet |
| mapStudio.image.geometryMismatch | 图与当前几何不一致 | Image does not match the current geometry |
| mapStudio.image.briefChanged | 需求已变更，请重新准备地图 | Requirements changed. Prepare the map again. |
| mapStudio.image.optionsChanged | 图层设置已变更，请重新渲染 | Layer settings changed. Render again. |
| mapStudio.image.syncing | 正在同步成图 | Syncing the rendered image |
| mapStudio.image.identityIncomplete | 成图版本信息不完整 | Render version information is incomplete |
| mapStudio.activity.open | AI 活动 | AI activity |
| mapStudio.activity.runs | 历史运行 | Run history |
| mapStudio.activity.rounds | 逐轮记录 | Round records |
| mapStudio.activity.calls | 调用与消息 | Calls and messages |
| mapStudio.activity.failure | 失败现场 | Failure details |
| mapStudio.activity.settings | 模型与运行设置 | Models and run settings |
| mapStudio.activity.progress | 研究进度 | Research progress |
| mapStudio.activity.history | 任务变更与交付历史 | Task changes and delivery history |
| mapStudio.activity.empty | 尚无运行记录 | No runs yet |
| mapStudio.activity.failureMissing | 此运行未记录失败现场 | No failure details were recorded for this run |
| mapStudio.action.completeBrief | 补全需求 | Complete requirements |
| mapStudio.action.search | 一键检索 | Research and prepare base map |
| mapStudio.action.prepareBase | 准备底图 | Prepare base map |
| mapStudio.action.saveBrief | 保存需求 | Save requirements |
| mapStudio.action.saveGeometry | 保存几何 | Save geometry |
| mapStudio.action.finishEditing | 完成编辑 | Finish editing |
| mapStudio.action.confirmGeometry | 确认几何 | Confirm geometry |
| mapStudio.action.render | 渲染成图 | Render map |
| mapStudio.action.deliver | 交付成图 | Deliver map |
| mapStudio.action.retryDelivery | 重试交付 | Retry delivery |
| mapStudio.action.viewDelivery | 查看交付 | View delivery |
| mapStudio.action.saveLayersAndDeliver | 保存图层并重渲交付 | Save layers, re-render and deliver |
| mapStudio.action.resumeStage | 续跑{stage} | Resume {stage} |
| mapStudio.action.retryStage | 重试{stage} | Retry {stage} |
| mapStudio.action.resolveProblems | 查看并处理问题 | Review and resolve issues |
| mapStudio.action.fixModel | 修复模型配置 | Fix model configuration |
| mapStudio.action.clearProgress | 清空研究进度 | Clear research progress |
| mapStudio.action.cancel | 取消运行 | Cancel run |
| mapStudio.action.verifyResult | 核实结果 | Verify result |
| mapStudio.workflow.boundedNotReady | 有界运行尚未就绪 | Bounded execution is not ready |
| mapStudio.workflow.boundaryUnknown | 原执行边界未记录 | Original execution boundary was not recorded |
| mapStudio.workflow.unknownFailure | 未识别的失败类型：{kind} | Unrecognized failure type: {kind} |
| mapStudio.workflow.autoWarning | 自动运行可能越过人工几何核对，并连续执行到交付。是否启动？ | Automatic execution may bypass manual geometry review and continue through delivery. Start now? |
| mapStudio.geometry.addedToDraft | 已加入待保存草稿 | Added to unsaved draft |
| mapStudio.geometry.saved | 已保存 | Saved |
| mapStudio.geometry.saveUnknown | 保存结果待确认 | Save result pending confirmation |
| mapStudio.geometry.noPendingEdits | 没有待保存的编辑 | No pending edits |
| mapStudio.geometry.previewOnly | 编辑预览已更新；成图尚未重渲 | Edit preview updated; the map has not been re-rendered |
| mapStudio.geometry.noRegistration | 缺少地理配准，无法在图上拖动 | Dragging is unavailable without georeferencing |
| mapStudio.geometry.minimumPoints | 点数不足，无法完成编辑 | Not enough points to finish editing |
| mapStudio.geometry.smoothingOff | 关闭平滑 | Turn off smoothing |
| mapStudio.geometry.overLimit | 超限 | Over limit |
| mapStudio.geometry.rowGeometryChanged | 要素几何已变更，已返回要素，不定位顶点行 | Feature geometry changed; showing the feature without selecting a vertex row |
| mapStudio.empty.image | 尚未生成成图 | No rendered image yet |
| mapStudio.empty.geometry | 暂无几何；检索完成后可核对与编辑 | No geometry yet. Review and edit it after research. |
| mapStudio.layers.title | 图层查看器 | Layer viewer |
| mapStudio.layers.noDescription | 暂无要素描述 | No feature description is available |
| mapStudio.layers.noSnapshotData | 此版本未保存图层数据 | No layer data was saved for this version |
| mapStudio.layers.manuallyMaintained | 人工维护条目 | Manually maintained entry |
| mapStudio.layers.supplementsManual | 描述／关键词已人工维护 | Description/keywords manually maintained |
| mapStudio.layers.nameManual | 名称已人工维护 | Name manually maintained |
| mapStudio.host.notProvided | 宿主信息未提供 | Host information not provided |
| mapStudio.delivery.pending | 交付结果待确认 | Delivery result pending confirmation |
| mapStudio.delivery.standaloneComplete | 流程完成，可下载 | Workflow complete · Download available |
| mapStudio.dock.baseReady | 底图已就绪，请核对点线面 | Base map ready. Review points, lines, and regions. |
| mapStudio.dock.confirmed | 几何已确认，点击渲染成图 | Geometry confirmed. Render the map when ready. |

平滑偏离与上限各一位小数；舍入相同但超限时追加“（超限）”，tooltip 给精确值。suggested=0 显示“关闭平滑”，不凭算法返回 0 断言所有非零档均不可行（`render/smooth.ts:227-237`）；调整只由人点击。

“已保存”只表示持久化成功，不表示渲染或交付；“人工维护”表示字段所有权，不表示从零撰写。deliver 补交付后的版本结果与 task status 分开呈现。

## 14. 本轮遗留与假设

本轮仅修订设计，不声称已实现或通过行为验收。最新事实以 facts-latest §7/8 覆盖旧基线；明确方案不等于解除供给门禁。

### 已核实／已裁定，仍需实施验收

| G 编号 | 结论 | 实施要求 |
|---|---|---|
| G3 | complete 就是交付；deliver 仅补交付，不渲染 pip、不改 status（`run.ts:264-275`、`routes.ts:141-148`、`delivery.ts:69-86`） | 首次 advance 异步执行；区分启动 detail 和终态；核对实际 version_ids／交付行；standalone 完成＋下载 |
| G5 | 已裁定：默认 UI/guided 保证；服务端仍不强制 | base 停靠、要素确认成功、显式渲染；不设整体核对键；auto 警告越过核对至交付 |
| G6 | 首次平滑整页 CAS 与 drawing 消费已有（`run.ts:440-467`、`drawing.ts:87-95`、`task.vue:963-972`） | **必须切分**已有 layer_doc 时几何区 options 保存借道重渲交付的旧分支；几何保存只持久化并标图过期，专用人工 layer-doc 命令保留明确副作用 |

底图签名成品缓存已存在（`geo/base-render.ts:483-643`），工作是补完整键、原子发布、sha 校验、进程内单飞，不新建缓存系统。固定色板不随主题变（`geo/relief-render.ts:30-38`）。

facts-latest §8 进一步限定：既有 canonicalReliefOptions 的 lowerCase/sort/String 不能证明所有输入顺序或重复等价（`geo/base-render.ts:465-479`）。指纹覆盖实际 osm:ID、v2 别名、legacy、v1 回退所选分支／文件（`geo/named-rivers.ts:113-171`）；不为缓存引入 NFC、去重或新河名匹配语义。遗留主题字段请求处理及无效重建消除见 04。

### 仍阻断事项

| G 编号 | 阻断事项 | 解除条件 |
|---|---|---|
| G1 | 当前引擎无 guided/stop_at（`routes.ts:84-89`、`run.ts:291-300`） | UI＋服务端同批实现两个终点、真实 run 边界读取与恢复；不加能力发现、不用永久分步兼容替代 |
| G2 | 30 条 history 与 sha+result 交付日志不满足持久同源读取（`store.ts:51,400-420`、`db.ts:68-77`） | 已选模块自存最小不可变 payload；同 CAS 发布引用；完整生命周期及窗口外旧图读取通过 |
| G4 | #125 已在 master、本 worktree 未集成；最终语义冻结与宿主信息供给仍缺 | 集成 #125，共享纯描述生产者；drawing 初始冻结、宿主最终语义随 version_ids 回传、模块新快照发布；describe target 新字段与真实产物验证通过 |
| G7 | observed 入口不足以证明历史失败详情完整 | 真实多轮失败 run 切换后重开，逐轮核对 rounds/attempts/calls/messages/error/problems/steps_used |
| G8 | 无现成迁移工具／有效状态，只有整份 state CAS 互斥（`db.ts:68-77,168-186`、`run.ts:365`） | 定义有效迁移、回滚后再 apply；持久快照、重复转换、并发启动和回滚样本通过后才生产 apply |
| G9 | 顶点为坐标数组无稳定 ID（`services/layer-doc.ts:91,96,101`） | msgrow 绑定 msggeorev 要素几何 hash；不匹配退要素，刷新／新标签／关闭／失效恢复零写 |

### #125 集成顺序与真实交集

master 已为 `cdb2a8540445eb8bc33d3b6e8e4c29346dfdac94`；本 worktree 仍为 `2d9655b1`，不能用文档假装已集成。

先集成 #125，再逐文件串行整合并做契约测试；真实交集为：

- `frontend/app/map-studio/api.ts`、`components/MapPipResults.vue`、四语 locales；
- `modules/map-studio/delivery.ts`、`base.ts`、`pip/frames.ts`、`pip/usage.ts`；
- `services/map-studio-host.ts`、`AGENTS.md`、director skill。

manual 是 description/keywords 人工所有权，name_manual 是名称所有权，source 独立（master `asset-semantics.ts:42-62,141-146,394-474`）。描述唯一生产者 semanticAnnotationsOf 依 feature_id 精确关联，组合 basis/coordinate_basis/excerpt/最多三个来源标题，keywords 只 category（`services/map-semantic-annotations.ts:67-97`）。

master 先存原始 d.semantics 到版本 params，随后才生成并保留人工补充写当前 props（`services/map-studio-host.ts:65-69,78-85`）。因此 #125 没有解决图片冻结；§6 的共享纯函数与注册回传是必须新增的集成契约，不做跨模块直读。

### 实施断言

| G 编号 | 必须记录的证据 |
|---|---|
| G1 | 检索止于 base，显式渲染止于 drawing；style 在前者不执行、后者跳过；续跑保留真实 mode/stop_at；取消确认后不启动下一阶段 |
| G2 | base/draft、drawing、人工保存、几何／选项保存、回退、迁移、交付、重做、history 淘汰后均保持原快照可读；不新增三套输入 revision，不用当前语义补旧图 |
| G3 | advance 启动响应与 complete 终态分开；pip、版本及宿主副作用齐全；重复交付幂等；deliver 无 CAS 参数且不改 status；失败／未知不报成功 |
| G4 | drawing 未交付即有同源可读描述；最终人工所有权语义另发快照、不改旧图；类别＋ID、feature_id、manual/name_manual/source 及历史出处均验证 |
| G5 | 待确认 PUT 权威成功后才允许显式渲染；全 confirmed 刷新不要求整体键；auto 警告取消零请求 |
| G6 | 行和弹窗合法输入共享唯一 spec/options 草稿；整页保存包含全部脏条目；已有 layer_doc 仅改平滑不渲染、不交付；高级按钮完整标注副作用；未知结果先读 |
| G7 | 真实失败 run 完整回看，不借当前错误，不以缺失降级宣称通过 |
| G8 | running 跳过落实到 requireIdle＋CAS 失败重读；dry-run 零写；apply 前持久备份；重复 apply 与回滚后再 apply 按有效状态判断；无共享锁平台 |
| G9 | 八个必要几何键恢复；行号仍合法但 hash 变化时退要素；恢复、zoom/pan、关闭弹窗零保存／生成／确认／交付；鼠标、触摸、笔、键盘均可完成编辑 |

全局动作另做组合验证：running → 未知写结果 → CAS 冲突 → 草稿（含 failed）→ blocking／失败 → 正常阶段；修复保存后按新 stage 重算，unknown kind 明示。

原 V15 保留 drawing 阶段 render_draft/final_image 落盘至浏览器实际可见 ≤5s 实测，包含 detail 发布、轮询与加载，以落盘／detail 首次可读／浏览器实际显示三个时间戳取证；不扩大到所有 pip 逐产物硬指标，每 3s 轮询不是证据。pip 仍须验证身份、读取及交付归属。

历史兼容三政策分别验收：新任务默认无纸纹；旧任务显式再生成采用新政策；已有历史成图及人工 layer_doc 原样保留。历史纸纹三态与再生成政策分开。遵守现行 AGENTS §9：最终验收使用生产专用新建测试项目／专用样本，通过合法 API 创建任务或依法复刻样本，不重渲真实历史任务。迁移逻辑与注入旧状态仅在隔离 fixture 中自测，不伪造生产 DB/API 状态，也不替代最终生产验收。无法经合法 API 复刻历史条件，或尚未取得生产 apply 授权时，对应门禁明确阻断、未执行；隔离通过不构成生产批准。生产 apply 独立于工具交付，晚于快照保留、新无纹理合成链与回滚样本通过；本次纯设计不执行任何 API。

V34 的工作流停靠与历史兼容证据分别出具；缓存命中靠完整键、manifest、sha，不靠耗时。前端只用 `/map-studio` API，不直读宿主库、不增加宿主写权限。本轮没有实现测试或生产验收结论。

