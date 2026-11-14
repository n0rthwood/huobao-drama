# Issue #99 地图工作室 — 生产验收记录（2026-11-13）

生产入口 `http://172.30.3.164/huobao/`（后端 :5679，库 `data/huobao.sqlite3`，DB 只读查询）。专用测试项目：**drama 21「地图工作室测试 1113」/ episode 28**，地图道具 **prop 283**（复刻 prop 239「乌拉尔山东西两麓区位图」的需求原文）与 **prop 284**（复刻 prop 241「东欧平原哥萨克聚落分布图」）。未触碰 drama 3 及其它既有项目。请求时间线：`requests.log`；DB 快照：`03-prod-db-phase1.txt`、`15-prod-db-readonly.json`。

## 发布

| 发布 | 内容 | 合并提交 |
|---|---|---|
| 20261113T141220Z | ① 模块壳 + harness + 火宝接线（旧代码尚在但不接线） | 5c232f36 |
| 20261113T202336Z | ② 精确度 + ③ 平滑/标签/服务端草稿作图 + 删除旧 map-workflow | 8319b2f6 |
| 20261113T203319Z | 研究阶段 extent 闸门去掉内缩留边（生产 run 2 暴露） | 77b10d17 |
| 20261113T222716Z | 工具墙钟上限（生产 run 6 暴露）、底板遮挡闸门（版本 3226 暴露）、编辑器把手、样式参考库草案 | 75ef1b89 |

每次发布前查 `sys_task` / 批次 / `map_studio_run` 无活跃任务；发布后 `ss -ltnp :5679` 与新接口 JSON 自检。

## 运行与版本

| 任务 | run | 起点 | 结果 | 交付版本（底图/成图） |
|---|---|---|---|---|
| studio 1（prop 283） | 1 | brief | completed（① 行为等价） | 3146 / 3147 |
| 〃 | 2 | brief（回退后） | research 三轮失败：数据集河流按 extent 裁剪仍被 2% 内缩留边拒 → 修复发布 | — |
| 〃 | 4 | research | `geometry_unverified` 阻断：AI 提议「喀什里克」(68.9, 58.2) 无可核验证据 | — |
| 〃 | 6 | research | 一个检索工具 34 分钟不返回，人工取消 → 修复发布 | — |
| 〃 | 7 | base（人工改正 + 确认后） | completed | 3218 / 3219 |
| 〃 | 10 | drawing（回退，底板遮挡闸门） | completed | 3238 / **3239** |
| studio 2（prop 284） | 3 | brief | `geometry_unverified` 阻断（3 个聚落代表点）→ UI「全部确认」 | — |
| 〃 | 5 | base | completed | 3192 / 3193 |
| 〃 | 8 | drawing（人工画面后） | completed | 3225 / 3226 |
| 〃 | 9 | drawing（回退，底板遮挡闸门） | completed | 3236 / **3237** |

最终成图：`static/map-drawings/477421463619d9f29543c177bbdebd6e.png`（283，sha256 477421463619d9f2…）、`static/map-drawings/a6baadcde8b2865a4606878161c985b5.png`（284，sha256 a6baadcde8b2865a…）。

## 验收 1–8

1. **独立模块与 harness**：`/map-studio` 列表/独立任务/模块设置、`/map-studio/:id` 六阶段面板；每阶段 Agent 过程按 `stage_spans` 归属，可展开逐条公开消息，墙钟/模型调用/排队分列（`19-prod-task2-drawing-agent-process.png`、`05-prod-phase1-studio-full.png`）。代码边界：前后端 `map-studio-boundary.test.mjs` 通过（Q1=c 口径）。重启：隔离副本实测 run 被标 `interrupted`、步骤失败原因可读、计时冻结在观测表最后心跳（修复 c7aaf02e）。
2. **火宝打开 → 交付 → 版本**：`POST /props/{283,284}/map-studio/open` 复用同一任务（重复打开返回 task 1）；交付在一个事务里登记底图 `map-render` + 成图 `map-workflow`（`params.source='map-studio'`），写当前图、`faithful_source`、语义；出处写入 `research_citations`（tool `map-studio`，283/284 各 10 条，`20-prod-host-284-after-delivery.png`）。下游 `GET /episodes/28/design-card-context` 列出两张地图的语义条目与底图候选（`18-prod-design-card-context-maps.txt`）。旧 `services/map-workflow` 已删除；旧 deeplink `mfocus/mlayer` 清键并提示「链接指向的目标不存在…」（`01-prod-host-entry.png` 流程中的 toast）。
3. **精确度回归（prop 239 需求）**：AI 在 run 4 提出的「喀什里克」(68.9, 58.2) 没有可核验证据，被 `geometry_unverified` 拦在研究阶段，未进入成图；人工按来源（es.wikipedia Qashliq 58°08′58″N 68°31′14″E）改为 (68.52048, 58.14942)，origin=manual/confirmed，距数据集托博尔斯克约 16 km、位于乌拉尔山以东；最终图 3239 中喀什里克标在托博尔斯克旁。经纬度互换：生产代码上的行为测试 `硬闸：Tobolsk 经纬度互换…整批拒收`、`喀什里克错误经度与 20km 证据冲突，改正后 verified` 通过（`09-prod-code-accuracy-tests.txt`）。
4. **prop 241 需求**：第聂伯河、顿河、伏尔加河、卡马河、奥卡河取自 Natural Earth 10m（`ne-group:` 同名河流组拼接），与底图河道重合；标题在底板内（3193/3237）。
5. **区域平滑**：人工画的 7 顶点面（含一次中点插入）平滑开/关对比 `13-…smooth-on.png` / `14-…smooth-off.png`；存储控制点不变（`15-prod-db-readonly.json` 中 regions），曲线过全部控制点、偏离超限即拒收（`map-studio-smoothing.test.mjs`）。
6. **人工几何**：在生产 UI 画面（`12-…drawn-6pts.png`）、插中点、开关平滑、改经纬度（喀什里克），保存走 CAS；随后 drawing 运行（run 8/9）保留人工面（origin manual），未被覆盖。
7. **标签**：重叠/越界/远离锚点/溢出/底板遮挡均为硬拒收；版本 3226 的文档被新闸门查出 12 处问题（`16-prod-plate-check-version3226.txt`），重画后两张最终图检查 0 处（`17-prod-final-label-check.txt`）。
8. **留痕**：本目录截图 01–20、`requests.log`、DB 只读快照。

## 已知问题 / 未完成

- **Q4 专业样式规范尚未固化**：参考库草案（20 张开放许可参考、5 组候选风格与可执行参数）在 `docs/design/map-studio-99-style-refs/`，等待用户选择后再写入模块样式规范；当前成图仍用既有 archival/clean/ink 主题。
- 模型检索质量：维基检索命中里混有无关条目（游戏、动画相关页面），已原样登记为来源；模型提议的坐标仍可能错误，但未经核验或人工确认不能进入成图（run 4 即实例）。
- 地图构图（取景范围、图例排版）仍由模型决定，283 的取景偏大；属样式/构图层面，随 Q4 样式规范一起处理。
- 成图的史实、版权与审美仍需人工审核；`completed` 只代表技术交付。

## 2026-11-14 追加：制图主题（Q4）与作图提速

用户决定（2026-11-14）：五个参考风格全部保留为可选主题，由 AI/人选择，默认主题可设置。用户随后要求压缩上下文以提速。

| 发布 | 内容 |
|---|---|
| 20261114T044927Z | 五主题 + 默认主题设置；工具循环上下文压缩 |
| 20261114T045217Z | 只换主题时退回底图阶段（不再整条重跑）；需求主题是唯一来源 |
| 20261114T055046Z | 草稿修改工具只回报变化的图层；选中河流用主题主河样式 |
| 20261114T062658Z | 底图阶段提示只给要素经纬度范围 |

- 主题：task 1（prop 283）在生产 UI 选「旧图墨色／手绘」（`21-prod-style-picker-ink.png`），成图版本 3380/3381（`23-…`）；task 2（prop 284）在 UI 换「专题图解／历史分区」，流程退回底图、研究保留（`22-prod-task2-style-changed.png`），成图 3352/3353 → 3373/3374（`24-…`）。
- task 1 run 13 研究阶段又被 `geometry_unverified` 拦下：AI 把「卡里索姆斯」放在 (62.1, 57.9)（需求写明在乌拉尔山西侧），另有重复的「莫斯科（公国核心）」。人工审查删除这两项、确认「塔夫达河（示意）」后继续（`requests.log`）。

作图阶段调用量（`GET /map-studio/runs/{id}/observed`）：

| run | 调用数 | 单次最大输入（字） | 模型耗时 | 排队 |
|---|---|---|---|---|
| 7（旧） | 37 | 562,372 | 536 s | 103 s |
| 8（旧） | 93 | 702,019 | 1802 s | 743 s |
| 9（旧） | 33 | 445,416 | 602 s | 480 s |
| 10（旧） | 34 | 244,717 | 816 s | 421 s |
| 11（仅压缩） | 16 | 240,106 | 908 s | 0 |
| 12（压缩 + 紧凑结果） | 12 | 56,254 | 755 s* | 0 |
| 14（同上，ink-chinese） | 15 | 50,334 | 382 s | 0 |

\* run 12 有两次调用各约 256 s（≈600 token 输出），同期其它调用 6–58 s；属共享 DeepSeek 引擎的偶发慢速。研究阶段 run 13：10 次调用、最大 5.1 万字、177 s。
