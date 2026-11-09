# Issue #84 地图资产工作流 — 生产验收报告（八达岭长城测试 1009）

> 生产入口 `http://172.30.3.164/huobao/`，生产后端 `:5679`，生产库 `data/huobao.sqlite3`（只读查询）。
> 本报告是**技术验收留痕**，不是史实、版权或审美批准。`completed` / HTTP 200 ≠ 内容通过。
> 原始大文件（巨型请求日志、3840×2160 媒体、Earth sidecar）另存外部归档并附 SHA256；仓库只保留本报告、摘要 JSON 与预览图。

- 证据目录：`docs/qa/issue-84-1009-20261109T014309Z/`
- 原始归档：`/home/joysort/huobao-backup/issue84-qa-raw-20261109/issue84-qa-20261109T014309Z.tar.gz`
- 归档 SHA256：`819fbbc25673605975497c9992aafea806cbfa1e4ee7da186402366b5926b2eb`（含 Earth 最终证据的完整重归档）
- 代码：`f149a0e`（`origin/master`），文档提交 `1955ab7`；release `20261109T062625Z`
- 授权原话：「你需要发布后，在生产上进行验收。不要每次都要求批准预算。八达岭长城测试需要用 1009，现在已经 9 号了」

## 1. 测试对象

| 项目 | ID | 用途 |
|---|---|---|
| 八达岭长城测试 1009 | drama 12 / episode 18 | 地图主验收 |
| 八达岭长城测试 1009-2 | drama 13 / episode 19 | 跨项目导入 |

地图资产是**项目级**道具（`props` 只有 `drama_id`，没有 `episode_id`），入口在项目「素材库」页签 → 卡片「打开地图工作台」，**不经过集级步骤**。

资产清单：

| id | 项目 | 类型 | 名称 | 角色 |
|---|---|---|---|---|
| 177 | 12 | map | 八达岭1009程序标定图 | 程序底图路线 |
| 178 | 12 | map | 1009_通州段_信息不足负例 | 缺时代阻断 |
| 179 | 12 | map | 1009_Earth_…关沟防御区位图 | Google Earth 路线 |
| 180 | 12 | prop | 八达岭1009普通道具错误路径 | `not_a_map` 负例 |
| 181 | 12 | map | 八达岭1009外部标定图 | 外部图标定路线 |
| 182 | 12 | map | 1009_殷墟车马坑_隐含信息核验 | 隐含信息推断 |
| 185 | 12 | map | 八达岭1009全自动区位图 | 从 brief 单次全自动 |
| 183 | 13 | map | 导入副本（失败留证） | 导入缺陷现场 |
| 184 | 13 | map | 八达岭1009独立地图副本 | 导入修复后 |

集 18/19 只有 257 字 `content`；`script_content=NULL`、`script_confirmed_at=NULL`、`stories=0`。
因此 `GET /episodes/18/gates` 的 assets/design/production/final/export/poster 全部 `false`，原因均为「旁白稿尚未确认」——这是 #54 门禁的预期行为，**地图资产验收不依赖集级链路**，也没有伪造剧本或确认。

## 2. 预算与真实调用

| 项 | 上限 | 实际 | 说明 |
|---|---|---|---|
| 图片（GPU 提交） | ≤4 | **3**（1295 / 1314 / 1338）+ 1 张为 Earth 保留 | 均为 `qwen-image-2.1`；请求体只含 `mode=text_to_image/prompt/metadata/width/height`，**无参考图**，即底纹而非地图重绘 |
| 业务文本调用 | ≤20 | 观测 **12**（id 66–89 中地图任务相关）+ 旧未观测上限 **7** = **≤19** | 旧任务 1287–1291 未补写、不伪造回填 |
| 视频 / TTS | 0 | 0 | — |
| 确定性渲染 / 导入复制 / 图层渲染 | 不计 GPU | 多轮 | 不占 AI 额度 |

证据：`budget-proof.json`（按 `params.kind='map_workflow'` 与 `params.map_texture.prop_id` 精确取行）。

## 3. 逐路线状态

### 3.1 程序底图（prop 177）— `[R]` 通过

- 阶段全部完成，revision 29；research：9 次查询 / 24 条来源 / 5 个地理要素。
- 底图 `static/map-bases/f9c922818d10f1966ca622e341b4a8c1.png`（3840×2160，task 1293）
- 底纹 `static/images/eeaf8d64-…png`（task 1295，1920×1088）
- 成图 `static/map-drawings/0cc85284d87786fdcaf386ee40581f80.png`（task 1311）
- 真实缺陷：首版成图顶部「岔道城」「八达岭」标注重叠，已改为按共享字号模型避让且不移动点位；中间还出现过「回退后丢底纹」，已修。证据 `04-…png`（失败中间态）与 `05-…png`（修复后）。
- 限制：本图地域尺度下 Natural Earth 50m 近乎无特征，不能声称详细地形。

### 3.2 外部图标定（prop 181）— `[R]` 通过

- brief 1297 / research 1300；底图 1303（`static/map-bases/image/5a866bcbf6a3fb1d3ed79b9f.png`），底纹 1314，成图 **1341**（`static/map-drawings/0faced4dbf494930bb0183d79cee13dd.png`）。
- research：10 次查询 / 24 条来源 / 8 个要素；四源实测：Wikipedia zh 5 次各 5 命中，en 5/5/0，Europeana 1 命中，Smithsonian 8 命中，均无 error（`research-source-outcomes.json`）。
- 输入说明：实际使用的「外部图」是本项目程序生成的 Natural Earth 公有领域校准夹具，**不是档案扫描获取**；三控制点拟合 max/RMS 0px 只说明该夹具与自身一致，不是史实精度。
- 覆盖层注册核验：把生产 LayerDoc 中 **21 个点/线/面坐标**与实际仿射配准对照，最大漂移 **0.0px**（`external-overlay-registration-proof.json`）。
- 真实缺陷：编辑画布上文字标签拦截点拖拽（`elementFromPoint(678,506)` 命中 `.geo-text`），已改为文字不参与命中；闭合区域末点被当作第 9 个可拖顶点，拖动会把 8 顶点环变成 10 点，已改为隐藏重复闭合点并同步闭合端点（失败证据 `ui-geometry-save-readback.json`，修复后 `RingEditorQA/03-ui-first-vertex-drag-readback.json`：存 9 点、首尾相同、仅 1 个独立点位移）。
- 恢复：QA 期间造的合成区域已通过生产 API 复原为原始检索几何，revision 36→41，确定性重绘 task 1340/1341，0 次付费请求。

### 3.3 跨项目独立导入（drama 13, prop 183 → 184）— `[R]` 通过

- 183 保留为失败现场：父任务 1321 报「还没有成图，无法完成登记；请先完成底图与标注绘制」。根因：导入清空了 base/final 的 task 版本引用，却保留了共享源路径。
- 修复：复制全部工作流媒体依赖与历史快照路径，把 base/final 版本行与 `faithful_source`、语义 `image.source_task_id` 映射到新导入版本；缺依赖整体补偿回滚。
- 184：底图 1324、导入的首个成图 1325、实际编辑后确定性重绘父 1326 → 采用成图 **1327**（`static/map-drawings/97b9abbfacf66da33bfa1f7a9e660f61.png`），**无任何新模型请求**。
- 证据：`cross-project-import.json`、`cross-project-import-readback.json`、`cross-project-import-fixed.json`、`independent-clone-redraw-complete.json`。

### 3.4 从 brief 单次全自动（prop 185 / root 1335）— `[R]` 通过

- 一次 `POST /props/185/map-workflow/run {mode:"auto", expected_revision:1, text_config_id:14, image_config_id:9, image_model:"qwen-image-2.1"}`。
- 六阶段 brief→research→base→style→drawing→complete **全部 completed**，无人工介入；总墙钟 **292430ms**。
- 文本调用恰好 3 次（call 87/88/89，`deepseek-flash`），公开消息 12 条且完整。
- 底图 1337、底纹 1338（唯一新付费图）、成图 1339 `static/map-drawings/27153cccdb20a669b02fa7792bafa1d5.png`，SHA256 `0564fd7a…25790`，已打开（`12-full-auto-final.png`）。
- 内容：八达岭关、居庸关两点 + 关沟谷道线 + 「关沟防御区（示意，范围近似，非历史疆界）」区域，全部 `proposed:true` 待人工史实审核；几何由程序绘制，底纹不改地理。
- 证据：`full-auto-submission.json`、`full-auto-completed.json`、`full-auto-observations.json`、`backend-log-excerpts.txt`。

### 3.5 Google Earth 路线（prop 179）— `[R]` 通过（含一次断电恢复）

- 底图版本 **1345**：`static/map-bases/earth/pixelgrid-v2-clean-517e91af9e0af7e5c0e201c3-3840.png`（3056×3826，SHA256 `4afce7e8…29ff6`）
- 标定（真实截图实测）：**129×129 网格 / 16384 个独立留出点，max 2.692582px、RMS 0.511282px、相机漂移 0px**，`basemap="clean (no Google labels/borders/roads)"`，KMZ 文件夹解析出 `地点 / 路线 / 区域`。
- 交付 KMZ `static/map-kmz/517e91af…c52d8ca.kmz` 与标定 KMZ 均用官方 OGC/Google XSD 校验 **VALID**。
- 底纹（保留的唯一一张付费图）**1347**：`static/images/c64c833f-2cb4-4df2-a62b-36655ec4eac9.png`；请求体只含 `size` 与 `map_texture`，提示词为「seamless aged paper texture background only…」，**无参考图**。
- 成图 **1349**：`static/map-drawings/31b5c7d7e07497c0f654ea296d13d949.png`（3056×3826，SHA256 `b6c4e350…79093`），已打开：底图为干净卫星影像（无 Google 路名/路牌/POI），叠加 5 个点位（岔道城、八达岭、上关城、居庸关、南口）、1 条关沟路线、1 个「关沟防御走廊近似示意区（非历史边界）」区域，全部 `proposed:true` 待人工史实审核；右下角烧入 Google/Landsat/Copernicus 署名。
- 尺寸说明：Earth 路线按验收口径保留其**可配准真实画布**（3056×3826），不复用 3840×2160 默认规格。

真实缺陷与修复（均保留失败证据）：

1. **Clean 底图静默回退**：1336/底图 1342 的标定已合格（max 2.69px、drift 0），但 sidecar 记录 `basemap="default"`，成图肉眼可见现代路名、G6 路牌与 POI（`MapEarthFinalQA/14-cleanbase-defect-crop.png`），因此**判失败、不提交底纹**。原件保全于 `/home/joysort/huobao-backup/issue84-prop179-base1342-20261109T050000Z/`。修复：Clean 改为硬性条件（超时不再回退），服务端拒绝非 Clean sidecar，且不复用旧 default 缓存，新缓存命名空间 `pixelgrid-v2-clean-…` 不改写已拒绝原件。
2. **语义点击 ≠ 导入**：1343/1344 中 `Open local KML file` 节点可见，但 `window.__huobaoPicker` `requested=0`、`file_reads=0`，Earth 未真正读取 KMZ。修复：导入改为后置条件驱动（必须观察到 picker 读取），遮挡先清 blocker 再重开菜单，最多 120s，首轮失败后改用真实键盘加速键 `Ctrl+I`；回归测试覆盖「晚到的引导气泡吃掉第一次点击」。
3. **计划外断电**：底图与底纹（1347）已产出后整机重启，工作流在 style 阶段被标 `failed`（错误「服务重启，地图工作流在执行中被中断」）。恢复时按 `params.map_texture_task_id=1347` **认领已完成底纹**，根任务 1348 直接复用，未重复提交任何图片；随后 drawing/complete 确定性完成（revision 58）。付费图片总数保持 **4**。

历史失败全部保留（不删、不伪装）：1290 缺时代、1291/1298 超时、1299「古代」歧义、1305 无 File 控件、1306 编辑器路径、1309 全局 Escape 退出、1320 5.408px、1323 关联失败、1328 5.701px、1333 4.962px、1334 `NameError`、1336 非 Clean、1343/1344 未导入、1346 被断电中断。清单：`failed-map-task-ledger.json`（1346 补充于 `earth-resume.json`）。

### 3.6 负例与边界

- prop 178「京杭运河通州段」：brief 阶段 `blocked`，明确列出候选时代并要求补充（`01-negative-brief-blocked.png`，task 1290）。
- 178 时代写「古代」：`blocked`，指出无法唯一确定河道（task 1299，call 68；重启后耗时仍为 88597ms、queue 0、4 条消息完整）。
- prop 182「殷墟车马坑」：AI 推断时代/位置/用途并停在 research 待审，**零图片**（task 1301，call 72）。
- prop 180 普通道具：`GET map-workflow` 返回 400 `not_a_map`，UI 不渲染地图工作台（`MapProgramImageQA/ordinary-prop-no-map-ui.png`）。
- 地图大图预览：实测发现宿主弹窗遮挡且无深链，已改为工作台自持 `mview=base|texture|final|calibration`、Teleport 覆盖层 z-index 240、Esc 只关预览层；生产实测刷新/新标签恢复到逐字节相同的路径，失效值给可读提示并只清自己的键，0 写入（`RingEditorQA/mview-preview-qa.json`，截图 20–23）。

## 4. 调用观测

- 接入后的地图任务均有 `task_observed_call` 记录（实际 system/user/assistant、耗时、排队分开持久化）。
- 旧任务 1287–1291 无记录，**未回填**；预算按"观测 12 + 旧上限 7"保守计。
- 观测持久性：重启后 call 68 仍为 88597ms、queue 0、4 条消息完整（`negative-observation-final-restart.json`）。

## 5. 未覆盖 / 不得声称

- Earth 的 Clean + 导入双条件生产通过（进行中）。
- `cancel`、`advance {skip:true}`（仅 style）、map→prop 类型降级、其他 rollback 分支：未实测，仍 `[S]`。
- 导入"删源后仍可重绘""缺依赖补偿回滚"：有独立执行测试，未在生产删过源文件。
- 地图的史实、许可、发布合规、审美：待人工审核。
- 集级纪录片链路（AI 改写→骨架→配音→设计卡→制作→导出）：本轮**未执行**，不属 #84 范围。

## 6. 复现要点

```bash
# 状态
curl -s $BASE/props/185/map-workflow
curl -s $BASE/tasks/1335/observations?with_messages=1&message_limit=200
# 门禁（说明集级链路为何锁定）
curl -s $BASE/episodes/18/gates
```

只读 SQLite：`sqlite3.connect('file:data/huobao.sqlite3?mode=ro', uri=True)`。
`/ai-configs` 含密钥，未落盘；`requests.jsonl` 记录结构化请求，URL 凭据已在归档前脱敏。
