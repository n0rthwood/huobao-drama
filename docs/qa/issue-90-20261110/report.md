# Issue #90 生产验收记录（2026-11-10）

## 版本

- 代码：`origin/master` `3ff84f0`（合并提交 `dd989fb`、`3ff84f0`；功能提交 `bf9eaf4`、`1518bf4`、`09ce998`，前端 `936e179`、`7cddb6c`、`d56990e`）。
- release：`20261110T030550Z`（首发），`20261110T032127Z`（追加「不透明填充遮盖底图」校验后重发）。
- 生产监听：`:5679` 由 PM2 `huobao-backend` 的子进程持有。经 Caddy 访问 `GET /huobao/api/v1/props/103/map-workflow`，返回结果带 `agent` 字段；`PUT /huobao/api/v1/props/103/map-workflow/layer-doc` 返回 JSON `missing_drawing`（重跑前的状态），证明新路由已生效。

## 对象

- 项目 drama 9，地图道具 prop 103「邗沟走向示意图」。用户已授权：新机制上线后从 research 重跑（Issue #90 的 Q4）。
- 触发事故：任务 #1350/#1353 在 drawing 失败。根因是古射阳湖的坐标被写成 `0,0`；底图 bbox `[100,20,130,45]`，即整个东亚。

## 生产运行与证据（只读 DB 查询，2026-11-10）

| 任务 | 类型 | 结果 |
|---|---|---|
| 1361 | map_workflow（auto，从 research 开始，DeepSeek V4.1 Flash local，config 10） | completed。research 第 1 轮通过；base 第 1 轮被拒（模型把图片路径当成 `artifact_id` 交付，拒收原因「没有底图 … 已生成：B1、B2、B3」回给了模型），第 2 轮通过；style 出底纹；drawing 第 1 轮通过；complete 采用 |
| 1362 | 底图版本（`map-render`，d3-geo+natural-earth-50m） | 模型取景 bbox `[118.95,32.2,119.85,33.7]`，聚焦江淮之间 |
| 1363 | 底纹（qwen-jobs，qwen-image-2.1） | 只生成背景纸纹（计费图片 1 张） |
| 1364 | 成图版本（`map-workflow`，map-layer-doc） | 技术上完成，但模型把画框画成了**实心全幅 polygon**（`frame`，fill_opacity 1，经采样覆盖画面约 97%），把底图整片盖住了。因此追加了交付校验：有效不透明度 ≥0.5 的填充面合计覆盖画面不得超过 30% |
| 1365 | map_workflow（人工回退到 drawing 后 auto 重跑；新校验已上线） | completed。drawing 第 1 轮通过（这次画框用了 polyline），complete 采用 |
| 1366 | 成图版本（`map-workflow`，map-layer-doc） | 当前图 |

- 公开调用（`task_observed_call`）：1361 共 32 次 llm 调用、11 次 vision_chat 调用，全部 completed；1365 共 8 次 llm 调用、4 次 vision_chat 调用，全部 completed。
- 采用结果：`props.image_url = static/map-drawings/2dc6a6ddc80be00f07cf42ac566ea752.png`，`faithful=1`，`faithful_source=1362`；语义 `image.source_task_id=1366`，5 个点（`p_3947a942 / p_04e0c54d / p_9ed96990 / p_27a046fe / p_e68fb625`）、1 条线（`r_8c6c2788`），id 与 `map_spec` 的要素 id 一致。
- 坐标：射阳湖 `p_9ed96990` 为 (119.55, 33.30)；`map_spec` 中已没有 (0,0) 地点。
- 同一渲染链：用同一 `renderLayerDoc` 重渲染 `outputs.layer_doc`，结果的 SHA-256 为 `2dc6a6ddc80be00f07cf42ac566ea752beba44a5db372eb8cffdf4ad5d858a11`，与成图文件逐字节一致；该文档严格校验 0 处问题，共 22 个图层。

## 截图（已逐张打开查看）

- 工作树后端 :5689 + 生产库副本（`/tmp/qa90`），真实 DeepSeek：research、base 都是第 1 轮通过；drawing 第 1 轮因为没预览就交付被拒，第 2 轮通过；complete 采用。
- `02-base-rejection-round.png`：「底图生成」展开后，第 1 轮被拒原因与第 2 轮采纳。
- `03-layer-editor-same-render.png`：「编辑图层」打开后，LayerCanvas 画面与服务端成图一致，裁切工具已禁用（只打开查看，没有在生产保存）。
- 浏览器检查：`errors` 与 console error 为 0。

## 隔离环境自测（不作为验收依据，只用于实现期）

- 工作树后端 :5689 + 生产库副本（`/tmp/qa90`），真实 DeepSeek：research、base、drawing 第 1 轮都在未预览就交付时被拒，第 2 轮通过，complete 采用。
- 在隔离环境的前端里保存「编辑图层」两次（改不透明度、改偏色），均以 `map-drawing-manual` 版本采用成功。字段级拒收由单测覆盖。

## 已知问题（交人审美判断，未用代码修补）

- 1366 中「淮安」「邗城」两个 marker 的文字，模型配了深色描边，加粗后发糊。技能文档已写明描边应使用浅色，但模型这次没有照做，`read_image` 自检也没有发现。可以在「编辑图层」里调整，或者另立规则把文字与描边的对比度纳入交付校验，由用户决定。
- 史实与审美仍需人工审核：「completed」只代表技术链路完成。
