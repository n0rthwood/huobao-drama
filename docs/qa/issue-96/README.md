# Issue #96 生产验收（2026-11-11，release 20261111T182351Z → 修正 20261111T214239Z）

| 画幅 | 项目 / 集 | 报告 | 结论 |
|---|---|---|---|
| 16:9 | drama 18「八达岭长城测试 1111-2」/ episode 24，merge 37 | `h/report.md` + `h/requests.jsonl` | 1–4 通过；5：6 镜中 5 镜成片（#05 H3 输出 15.083 s 超 15 s 被合成排除，非 #96） |
| 9:16 | drama 19「八达岭长城测试 1111-3」/ episode 25，merge 36 | `v/report.md` + `v/requests.jsonl` | 1–5 通过 |

- 设计卡 6/6、8/8 只产模板文本框（`{type:'text', role, fields, at_s}` + `text_layout`），零 card、零无锚点 label。
- 验收发现并已修正（commit 7476f741，`fix/`）：同区替换交叉淡化叠字 → 先出后进（`h/614-f60.png` 修正前，`fix/614-fade.jpg` 修正后 t=2.24/2.40/2.56 s）；Poster 集号行「第1集 · 第1集」→「第1集」（`h/poster-v25.png` → `fix/poster-h-fixed.png`）；Poster 构想溢出纠正提示补「容量更大的套」；`confirm-keyframes` 必须显式 `{confirmed:true}` 写入 api-catalog。
- 非 #96 遗留（报告内有证据，待另开 Issue）：H3 输出略超 15 s 被合成排除；生成段 ≥4 s 未在设计卡阶段拦截；AI `inherit_prev` 遇前序 A 镜必然 `missing_base`；D+承接取前镜尾帧不可用；视频提示词把图层内嵌图写进生成段；组合 B 关键帧提示词漏 @ 引用资产；转场评审 DeepSeek 确定性失败；9:16 图层段 image 层默认位置压右侧按钮栏；9:16 Poster 信息卡渐变底板下沿超安全区 1%。
- 原始媒体（渲染帧、H3 视频、成片、配音）保留在 `.164:/home/joysort/huobao-qa-96/{h,v}/`，不入库。
