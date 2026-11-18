# ep 30（drama 20 第 2集「逻辑组验收 1116」）全流程验收 + 画中画整合报告

日期：2026-11-17 · Issue [#110](https://github.com/n0rthwood/huobao-drama/issues/110) · 生产入口 `http://172.30.3.164/huobao/drama/20/episode/2`

## 1. 范围与授权

用户要求：(a) 整合分析地图工作室任务 3（prop 258）的画中画如何进设计/制作链路并修复缺口；(b) 把整部纪录片测试第二集（112 镜）从设计→制作→视频与成品→Poster→导出做完，**每阶段 ≥3 镜由真实浏览器 UI 点击驱动**，其余走 API；记录 UX 问题并请 Fabel 评审 UI 可理解性。设计规则：图层段无时长上限，只有扩散视频 ≤15 s；「时长装不下」是设计问题，靠加长图层段解决。

授权：用户 2026-11-17 明确「完成整个纪录片测试第二集」，范围内持续执行，不逐任务索要预算。生产写入经 hbwf（exception/rework/approval 决定 + 证据）。

## 2. 项目与集

- drama 20「中俄百年变局 纪录片测试 1113」，project_type=documentary，aspect_ratio=16:9。
- episode 30（第 2 集「逻辑组验收 1116」），112 镜：A=10 / B=33 / C=46 / D=23。
- 剧本已确认；资产 61 关联、审核 passed；旁白骨架 112 镜 5602/5602 字确认；配音 112/112。

## 3. 画中画整合分析与修复

### 3.1 生产链路（map-studio 任务 3 = prop 258）

- base 阶段 `set_frames` 提 3 个细节框 → `pip/render.ts` 渲 3 张细节全屏地图 + 组合图（版式 L3b-B）→ `services/map-pip-assets.ts registerPipAssets()` 把细节登记为独立地图道具（286/287/288，asset_type=map、faithful=1、props.map_pip）。
- prop 259（任务 4）同机制产 4 张细节（289/290/291/292）。
- 细节资产语义由全览 map_spec 按取景投影（`modules/map-studio/pip/semantics.ts projectDetailSemantics`，semantic_id 与全览一致），启动幂等回填 `backfillPipDetailSemantics()`。
- 读路径（`read_storyboard_context` / 组规划资产清单）给细节 label + bbox/focus_bbox + 所属全览 overview_bbox，并剔除别集 storyboard_numbers。

### 3.2 引用分布

- ep 27：33 镜用 258 全览满幅，无画中画（用户真实项目，不改）。
- ep 30：258 全览底图 15 镜；细节作底图 4 镜（#35→286、#41/#47→287、#91→288 原）；image 画中画层 4 镜。

### 3.3 本 Issue 代码修复（已合并 origin/master）

| 修复 | commit |
|---|---|
| 读路径 PiP 元数据（pipSummary/pipAssetLine/pipGenericUsage） | 见 #110 主分支 |
| 细节语义投影 + 启动回填 | 同上 |
| `pip_invalid` 阻断 + AI 拒收（image_anchor_missing/on_base）；草稿不回落底图；imageBoxForLayout 放文字对侧 | 同上 |
| 衔接帧隐藏 image 层；签名仅对含 image 层的段升档（seg-v3-C/D、seg-v2），ep 27 零波及 | 同上 |
| `faithful_in_diffusion` 阻断（卡 gen refs + 关键帧/视频绑定），图不发扩散 | 同上 |
| 补镜只补骨架；纪录片 breaker 非 design_card 范围无 update_storyboard；fill-gaps 包 runObservedWork | 同上 |
| 图层段无上限（MAX_LAYER_SEGMENT_SECONDS 删除，shotMaxSeconds A/C/D=Infinity）；fitBudgetToNarration 自动补时；UI 一键延长 | 同上 |
| mid_frame_time 按生成段校验 + generated_segment_s；阻断 mid_time_out_of_range | 同上 |
| 视频提示词时间轴覆盖生成段（video-prompt-timeline.ts，阻断 video_timeline_mismatch） | 同上 |
| 锁定槽提示词拒收（C 首 / D 尾）；承接取上一镜生效尾帧（effectiveLastOf） | 同上 |
| 转场 Agent 正文纠正一次；isModelError 计 402/欠费；keepAliveTimeout 130s；技能 mtime 热加载 | 同上 |
| **PiP 锚点带 asset_kind**（角色/道具撞号精确解析；草稿 src/anchor 带 kind；collect 按 kind 收集） | 06775c42 |
| **计划图层稳定 id**（规范化按 at_s 重排后前端按 id 认行，修编辑点击写串） | b53e90dc |

### 3.4 数据修复（仅 ep 30）

并发会话重绘 prop 259 后重填设计卡，#66/#91 的库楚肖像 image 层被丢，旧图层段仍渲染该插图且因锚点无 kind 把角色 75（库楚）误标成道具 75（洛色林扎仓，drama 7）——图正确、名错误。

- **#66**：移除越界喀什里克 marker（p_93804782 不在细节1取景框，在细节4），恢复库楚肖像画中画（char 75）；重新草稿/渲染/确认设计卡/确认关键帧；冻结旧衔接帧的排队视频任务 4748 取消重提。
- **#91**：额尔齐斯河旧 id r_d21b8a8d 改锚当前河道 r_66f405aa（含 __2），恢复库楚肖像画中画；重新草稿/渲染/确认。
- **#47**：底图细节2，无同镜画中画——相邻 #46/#49 已是全览建立镜头，符合技能配套规则，不需插图。
- 验证：#66/#91 中段帧画中画与文字不重叠（pip08/pip10），衔接帧画中画与文字均消失（pip09/pip11）。
- **#73**：原 B 整镜生成段 13s + 开场转场 3s，可用 12s 装不下实测旁白 12.4s（compose 阻断）。按用户规则「时长装不下靠加长图层段」B→C：新增 2s 图层段（底图喀什里克场景 + 标题/说明文字框）承载余量，生成段保留 13s；视频提示词首段改 0–1s 空镜复述衔接帧、人物从第二段入画；重新确认设计卡/关键帧、重出视频、合成。
- **#35**：B 预算 14.5s 视频实测 15.083s（模型帧取整多 2 帧），严格 >15001ms 闸门误判超限；生成段/B 总时长闸门给 0.2s 帧取整容差后合成（b467bd4e）。

## 4. 各阶段 UI 配额（≥3 镜真实点击）

| 阶段 | UI 点击镜 | 证据 |
|---|---|---|
| 分镜设计 | #02/#03/#12 确认；#35 组合切换+重填；#66 修复（添加图层/改类型/选画中画） | d01–d26 |
| 分镜制作 | #01/#02/#12 图层草稿+渲染；#01/#02/#03/#12 关键帧确认 | p01–p18 |
| 视频与成品 | #01/#02/#03/#12 提示词+提交视频 | v01–v18 |
| Poster | 构想+3 底图、套用、渲染合成 | po01–po07 |
| 导出 | 全选 112 镜、勾选 Poster 片头、拼接所选、确认弹窗（4 步真实点击） | ex04–ex10 |

## 5. UX 问题与 Fabel 评审

走查记录 `ux-log.md`（D1–D7、P1–P13、V1–V11、画中画回归）。Fabel one-shot 评审（封闭上下文）见 [#issuecomment-6963631060](https://github.com/n0rthwood/huobao-drama/issues/110#issuecomment-6963631060)。

- 五项结论：需改进=是；over-engineering=否；遗漏需求=部分（材料覆盖不足）；擅自决定=否；调查不足=部分。
- 最高优先级「点击写错对象」已修（计划图层稳定 id，b53e90dc）。
- D2 警告/硬阻断语义冲突、P7/P13 前端 502 反馈、V2 运行态、V11 批次恢复可见性、P6 镜/槽位计数、V1 同名按钮、V5 深链定位、V8/V9 登记为后续 UX Issue，本 Issue 不扩范围。
- **生成段帧取整容差**（b467bd4e）：模型按整数帧出片，请求 15 s 可能多 1–2 帧（ep 30 #35 实测 15.083 s），严格 >15001ms 闸门把帧取整伪影当设计超限阻断合成。生成段闸门与 B 整镜总时长闸门同口径给 0.2 s（≥4 帧 @24fps）容差；真正超 15 s 仍阻断，图层段无上限不变。#35 修复后合成成功。

## 6. 视频 / 合成 / 导出

- 视频：批 66（96 镜）→ retry-failed 批 67（59 镜）→ 单镜补提（#7/#11/#13/#82/#66/#91/#73）。h3-central 单 worker .102 4090D，与 ep 27 共用 FIFO。文本配置暂停/超时窗口致 61 镜失败，watcher 自动 retry-failed + resume。**102 个 B/C/D 镜全部有视频**（A=10 镜只图层段无需视频）。
- 视频审片：每镜抽 3 帧联系表（`ui/video-review/shot-NNN.png`），按批写 video_approval（证据=联系表）。
- 合成：compose-batch 显式 ids（A 镜只图层段，B/C/D 需已审视频）；hbwf compose 闸门补 A 镜豁免。**112/112 镜合成，全部 exportable=true**（compose preview 全 unchanged）。#01 实测 960×544、25fps、13.16s、video+audio、烧录字幕清晰（compose01-shot1.png）。
- **导出（UI 点击）**：导出页全选 112 镜 → 勾选「加入 Poster 片头」（3s）→「拼接所选 (112)」→ 确认弹窗「拼接 112 个镜头」（ex05/ex06）。**merge 41 completed**：`static/merged/46fb4f2a-82ed-4718-acae-273922a382d9.mp4`，ffmpeg 实测 **24:25.28（1465s）/ 960×544 / 25fps / h264+aac / 177 MB**，SHA-256 `5604d8750c6c0b7b280110bc3d514c02c28598aa4e0b10ff4c3682b7d47eba1a`。只读 DB 复核：`video_merges.scenes`（112 条）与当前全部存活镜的可导出成品路径**逐条相等**，`intro_image` = 当前选定 Poster，`intro_duration`=3。导出完成 UI 见 ex10。
- 抽帧：ex07（片头 Poster）/ex08（60s）/ex09（700s）已落盘；视觉读图因账户级 vision 限流（retry-after ≈62h）本轮未复核，Poster 本身已在 po07 视觉验证（无裁切/溢出），成片解码与规格由 ffmpeg 证实。

## 7. 偏差与遗留

- 并发会话干扰：prop 259 重绘语义 id 全换 → ep 30 21 镜图层段 source_unresolved，按新语义重填；两次发布重启打断在飞文本批，用显式 ids 重启。
- 共享 h3-central 队列单 worker（.102 仅 4090D，3090 已移除），ep 27 与 ep 30 共用 FIFO，ep 27 在前；ep 30 视频排队等待较长。
- 文本配置 10/16 曾因超时/配额暂停，探测恢复后 resume；402 已计入健康。
- ep 7/15/27 为用户真实项目，不改。