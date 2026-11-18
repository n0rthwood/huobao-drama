# Issue #117 生产验收报告（2026-11-17 → 11-18 UTC）

主题：纪录片地图底图的图层段必须复用**地图资产自己的图层文档**，不再按语义重画点/线。
生产系统：`http://172.30.3.164/huobao/`，drama **20** / episode **27**（《中俄百年变局（1）》，113 镜）。
数据库一律只读（`file:data/huobao.sqlite3?mode=ro`）。

## 1. 发布

|项|值|
|---|---|
|后端提交|`ddd8c021`（`services/map-asset-layers.ts` + 技能/文档）|
|前端提交|`c9eae165`|
|合并|`debcb224`（已推送 `origin/master`）|
|#117 相关发布|`20261117T120158Z`、`20261117T124449Z`、`20261117T213419Z`|
|smoke|backend/health、backend/index、edge/huobao/、edge/huobao/api、edge/huobao/deeplink、hash 资源 全 200|

启动迁移日志：`🗺️ 地图资产图层段迁移：62 段，换掉 197 个重画层`（幂等，签名不变）。

## 2. 资产重建后的重映射

地图资产在验收期间被重建（257 = 任务 2935 旧流程；258 = 任务 3493；259 = 任务 3509 Map Studio），
旧语义 id 消失使段落 `source_unresolved`。一次性重映射按「资产 + 类型 + 名称」匹配新锚点：

- 76 张设计卡、80 个图层段、654 处引用改写；
- 仅资产 **257（123 处）**无法解析——它没有图层文档，这些段仍按语义重画（无损保留）；
- ep 27 全部 **87 个地图段**重渲：`ok 87 / skipped 26 / failed 0`。

## 3. 图层复用与视觉验收（本 Issue 的核心）

只读 DB：`storyboard_layer_segments`（storyboard 989 = #59）库里只存 3 个模板文本框，
读时 `expandMapAssetLayers` 展开为 **45 层**，其中 28 层为 `map:` 前缀、`locked`、`from_asset`，
底图换成资产文档底图 `static/map-drawings/8dcfc50c…-bg.png`。

人工打开渲染帧核对（`ui/shot59-layer-frame.png`，取自 `static/layer-segments/15441b45….mp4` t=5.0 s）：

- 乌拉尔山脉 = **点状离散山形符号**（不是重画的实线）；
- 叶尔马克远征路线 = **红色虚线、无箭头**；
- 地图内出现资产自带地名标注：`索利卡姆斯克（出发地）`、`塔吉尔河冬营地`、`叶尔马克远征路线`；
- 底图为带纹理的晕渲地形（资产底图），不是段自绘底纹。

**验收中发现并修正的一处遗漏**：重映射时时间线 `visible` 只带了要素的主层 id，
资产里同一语义的标签层（`theme-city-*` / `theme-note-*`）没有随之可见，导致地名文字不出现。
已按「同一 `semantic_id` 的全部资产层一起可见」补齐 **34 个段**并重渲（每段新增 8–33 个可见 id），
补齐后上述地名标注正常显示。

衔接帧（`ui/shot59-junction.png`）：文字层与画中画隐藏，只留几何与底图，符合 #95/#110 契约。

一致性只读核对（全部 113 镜）：

|查询|结果|
|---|---|
|图层段 `duration` 与设计卡 `budget.layer_s` 不一致|0|
|`stale_reasons <> '[]'`|0|
|C 镜 `keyframes_junction_hash` ≠ 段 `junction_hash`|0|
|C 镜 `keyframes_confirmed <> 1`|0|
|C 镜数量|75（全部有视频）|

## 4. 设计卡：AI 重填 → 确认（用户裁定路线）

用户选择「让 AI 重填后再确认」。

- `POST /episodes/27/design-cards/fill` → 任务 **3920**，13:45:36Z 启动、16:41:53Z 完成，**113/113，0 失败**；
- 重填后按 `fitBudgetToNarration`（与 AI 写入同一纯函数）把 22 镜预算补到实测旁白 + 0.5 s；
- 58 镜图层段时长按新预算同步并重渲；9 个残留 `asset_version_changed` 段重渲清零；
- 衔接帧 hash 重新绑定并确认关键帧（两轮共 78 镜）；
- `POST /storyboards/:id/design-card/confirm {acknowledge:true}` 确认 **111/112**；
- 唯一失败 #48：AI 给出 B 组合但库里 combo 仍为 A。按 AI 意图走
  `POST /storyboards/978/combo {combo:"B"}` → 确认成功，随后补关键帧提示词、
  关键帧批量 **77**（3/3 completed）、`confirm-keyframes {confirmed:true}`、视频提示词与视频任务 **4910**。

最终：113 镜设计卡全部 `confirmed`。

## 5. 视频提示词与视频

- 提示词时间轴/中间帧按生成段口径修正：`generate-video-prompts` 任务 **4280/4283/4309/4312/4347**
  （多次被并行会话的发布重启打断，逐次续跑），最后一轮 **60/60，0 失败**（20:23:11Z → 21:01:55Z）；
- 16 镜 `mid_frame_time` 越界（等于 `gen_s−0.5` 或超出）按生成段内部值经 `PUT /storyboards/:id` 修正；
- #17/#94 生成段 3.5 s / 2.5 s 低于 4 s 下限 → 预算提到 4 s；
- 视频批次 **64**（21:34:42Z）真实创建 73 条 h3-jobs 任务；随后对失败镜逐轮重提，
  最终 **76 个生成段镜头全部有视频**（75 C + 1 B）。

失败原因均为外部依赖，非本 Issue：`h3-jobs 网络错误 timeout`、`文本模型已暂停`（H3 扩写端点熔断，
用 `resumeTextConfig(10/16)` 恢复）、队列单卡在线导致排队约 2 h。

## 6. 途中发现并修复的产品缺陷 → Issue #119（已关闭）

批量视频 runner 在提交前复查时不传绑定快照，`videoBlockReason` 回落成空绑定，
把每镜判成 `unbound_mention`，**整批 73 项 skipped、0 任务**（批次 63）。
修复 `81c1b24f`（合并 `6696af53`）：无快照时 `loadTargetBindings(sb.id)` 现读真实绑定。
发布 `20261117T213419Z` 后批次 64 真实建 73 条任务。详见 Issue #119 的验收评论。

## 7. 合成与导出（最终产物）

- `POST /episodes/27/compose-batch`（113 镜，预览 `changed 112 / missing 1`，`blocked 0`）
  → **113/113 completed，0 failed，0 skipped**；
- `POST /merge/episodes/27/merge {poster_version_id:30, poster_duration:3}`
  → **merge 40**，`completed`，04:00:26Z → 04:01:21Z，`skipped []`；
- 成片：`static/merged/99bd2b94-366b-46da-ab2c-2be7e5208127.mp4`
  - ffprobe：**960×544 / 25 fps / 1543.88 s**（video + audio 双流）
  - 浏览器实测（`<video>` loadedmetadata）：`{w:960,h:544,d:1543.88}`
  - SHA-256：`20677ec4354e2c502fb88ab5bb0ac21917af8cd8f0ef1f8b5bedd09328cac348`
  - `scenes` 113 条，与当前 113 镜 `composed_video_url` **逐条同序相等**，文件全部存在；
  - Poster 片头 = 选定第 30 版 `static/overlays/7424d78c….png`，3 s；
- 113 镜 `narration_meta.composed.signature` 齐全、`burned=true`（字幕全部烧录）。

`GET /episodes/27/roadmap`：8 步全 `done`，`criteria_met` 全 true，
milestones **M1/M2/M3 全 done**，`current.step=null`。

UI 证据：`ui/export-panel.png`（成片列表显示新成片 1544 s、可拼接 113/113、已选 113）。

## 8. 验收过程中的一次误操作与完整恢复（如实记录）

诊断页面取数时我用 `PUT /episodes/27 {content:"test"}` 做过一次探针写，
覆盖了原始内容并把 `source_revision` 从 2 抬到 3。发现后：

1. 从 `data/huobao.sqlite3.bak-20261117T1200Z-pre-117` 取回原文（5788 字），
   与 `script_version` id 56（run 16 的 `source_snapshot`）**逐字相同且 sha256 一致**；
2. `PUT /episodes/27 {content:<原文>}` 恢复（`source_revision` 因这次写变成 4）；
3. 因内容确未变化，把 `source_revision` 复位为真实值 **2**（与 run 16 一致）；
4. 恢复写触发的 `script_changed` 使 113 张卡置 stale → 重新 `script/confirm` 与
   113 张卡 `design-card/confirm`（113/113 成功）；
5. 复核：`compose-batch/preview` 仍 **113 unchanged**，成片与成品逐条一致，roadmap 全 done。

最终库里 `content` 长度 5788、`script_content` 5825、`source_revision` 2、`final_revision` 3，
与误操作前的真实状态一致；成片未受影响。

## 9. 证据文件

- `ui/shot59-layer-frame.png`：#59 图层段渲染帧（资产图层 + 地名标注）
- `ui/shot59-junction.png`：#59 衔接帧（无文字/画中画）
- `ui/merged-frame-700s.png`、`ui/merged-decoded-700s.png`：成片第 700 s 帧（ffmpeg 抽帧 / 浏览器解码帧）
- `ui/merged-poster-intro.png`：成片 Poster 片头帧
- `ui/export-panel.png`：生产导出页
