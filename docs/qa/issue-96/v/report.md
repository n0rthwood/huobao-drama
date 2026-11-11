# Issue #96 生产验收 — 竖版 9:16（八达岭长城测试 1111-3）

- 项目：drama **19**「八达岭长城测试 1111-3」（project_type=documentary，documentary_rules=on，aspect_ratio=9:16，style=documentary-archival，genre=历史纪录片）
- 集：episode **25**（第 1 集「八达岭长城对明朝防御的作用」，resolution 720p，image_config 9 / video_config 8 / tts_config 13，narration_enabled=true）
- 生产入口：`http://172.30.3.164/huobao/`；API `http://localhost:5679/api/v1`（生产后端 + 生产库）
- 授权：用户本轮明确授权 DeepSeek V4.1 local(10)、Qwen Image 2.1(9)、MiniMax H3(8)、VoxCPM TTS(13)，预算无上限；只新建 1 个测试项目；既有项目未触碰；DB 只读。
- 浏览器会话 `huobao-qa-96-v`（agent-browser + dogfood）。
- 证据目录 `/home/joysort/huobao-qa-96/v/`：`requests.jsonl`（109 条逐请求）、`db-fidelity-report.txt`、`tts-durations.txt`、`poster-concept.txt`、`dcc.json`、`screens/`、`media/`。

## 任务 ID 台账

| 阶段 | ID |
|---|---|
| 剧本改写 | run 13 / task 1994；fidelity v49（baseline/output 224，adjusted_baseline 224，prepared 删除出处行 225–256）、bridge v50 |
| 资产提取 | characters 1998 / scenes 2000 / props 2005 |
| 资产审核 | run 2006（22 项，15 缺失）→ create-assets 9 个占位 + 补提取 2008（居庸关关城 scene 130）+ 2 条人工绑定 → `passed`，0 缺失 |
| 资产出图 | scene 127 → 2009（1088×1920）；prop 227 → 2010（1024×1024）；scene 130 → 2020 |
| 旁白骨架 | task 2015（8 镜，覆盖 261/261，无 gap） |
| 配音 | task 2019（8 镜全部 completed，总 60.0s） |
| 设计卡 | task 2021（8/8 completed，failed 0） |
| Poster 构想 | 第 1 次 task 2022 **failed**（窄侧套标题容量）；第 2 次 task 2026 completed |
| Poster 底图 | task 2027（qwen，768×1344） |
| 图层段渲染 | 2033–2040（8 段 ready），2050 为 #01 预算修正后的重渲 |
| 关键帧 | batch 22（603 last 2043、610 first+mid），3/3 completed |
| 视频 | batch 28（H3）：603 task 2051、610 task 2052 |
| 合成 | compose-batch 8/8（`static/composed/*.mp4`） |
| 拼接导出 | merge **36**，`static/merged/8d8c439e-e8c9-4b92-8972-66d337659cb4.mp4`，69s |

## 1. 设计卡（AI 模板文本框）

`POST /episodes/25/design-cards/fill {"model_mode":"pinned","config_id":10}` → 8 镜写入；`design-cards/status` = done，completed 8 / failed 0。
- 8 镜全部 `combo=A`（纯图层段）、`layer_plan.text_layout=v-center-top`；`planned_layers` 只含 `{type:'text', role, fields, at_s}`（#01 另有一个锚定 image 层），**没有 card、没有无锚点 label、没有缺套的 text**。
- 逐镜角色（at_s）：#01 heading 0.5 / statement 2.4 / image 2.4 / keyword 4.8；#02 heading 0.3 / keyword 2；#03 date 0.3 / heading 1.2 / statement 4.6；#04 heading 0.4 / keyword 3.4 / statement 6.2；#05 heading 0.4 / statement 3.2 / metric 6.2 / keyword 8.4；#06 heading 0.3 / keyword 3.4 / keyword 5.2 / statement 7.6；#07 heading / statement / keyword；#08 heading / statement / keyword（后经操作员改为 D 并调整 at_s）。
- 文字实例：#01 heading「八达岭长城 / 北京西北 · 军都山关沟北口」、statement「明代长城中规制最高、保存最完整的段落之一」、keyword「关沟北口」；#06 heading「敌台与烽燧 / 沿线数百米一座」、keyword「烟火 / 昼间以烟为号」「号炮 / 夜间以声传信」、statement「警讯昼夜之间即可传到京城」；#08 heading「不只是阻挡 / 长城的作用」。
- audit：8 镜 `issues=[]`，`tts.duration_ms` 非零（9440/3520/6720/7840/9440/10560/3680/8800）。
- 本轮 AI 写入无拒收（无 `text_plan_invalid`/`text_plan_warning`）；`GET /tasks/2021/observations` 返回空 works/calls（采集缺口，如实记录）。

## 2. 图层段（竖版 544×960 / 25fps）

- 8 段 draft + render 全部 ready；`text_layout=v-center-top`；底图 scene 127（1088×1920，比例 0.5667 与成片一致 → cover，不拉伸）。
- 打开渲染帧（`/layer-segments/storyboards/{id}/thumbnail/frame-N`）：
  - #01 帧 20（0.8s）眉题 + 标题居中，y≈0.30–0.37，在安全区（x 0.111–0.889、y 0.15–0.65）内；
  - #01 帧 62（2.4s）：heading 与 statement 在 400ms 淡入淡出期间同时可见、文字重叠（缺陷 D1）；帧 70（2.8s）heading 消失，只剩 statement；
  - #01 帧 145（5.8s）keyword「关沟北口」+ 释义可读；image 层 x 0.62–0.92、y 0.10–0.54 越出安全右边界并压右侧按钮栏（缺陷 D2）；
  - #06 帧 95（3.8s）「烟火」→ 帧 140（5.6s）同区替换为「号炮」；帧 200（8s）statement 替换 heading —— 同区替换与不重叠成立；
  - C 衔接帧（#01 t=6.5，`j603.png`）与 D 衔接帧（#08 t=0，`j610.png`）**均无 text 层**（D 衔接帧保留 image 层）。
- 竖版文字均未进入底部 35%（y≥0.65）、未进右侧按钮栏。

## 3. 编辑器 UI（`?panel=production&tab=production&shot=608&seg=layer`）

- 版式套下拉 4 个竖版套，当前「上中语境／中部主叙事／下中关键词」；切到「左上语境／左中主叙事／左下关键词」后画布文字立即移动并显示「有未保存改动」，服务端 `text_layout` 仍 `v-center-top`（未落库）；重开页面恢复（截图 02/05/07）。
- 添加模板文本框：类型下拉按 标识类（时间锚）／叙事类（主题标题、事实说明）／强调类（关键词）／引语类（引文）／数据类（数据结论）／结构类（要点列表）分组 +「添加」按钮。
- 选中「事实说明」：显示「每行 13 字 × 2 行，已用 12 字」「出处或限定 可选 每行 18 字 × 1 行，已用 0 字」。
- 输入 51 字超长说明后实时显示「每行 13 字 × 2 行，已用 51 字」与「文本框问题：『事实说明』的『说明』放不下（已缩到 90%）：4 行，超过 2 行 …」（截图 06）；未保存，重开页面服务端文字与版式未变（截图 07）。

## 4. Poster

- 竖版 768×1344；竖版套容量（引擎现算，`design-card-context.text_spec.capacity` 与 `textCapacity`）：侧栏套 `p-vertical-left/right` 的 `poster_title.main` = **3 字 × 2 行（共 6 字）**；`p-vertical-top/bottom` = 6 字 × 2 行；`poster_details` 副标题 11 字×2、年代 14、地点 15、要点 3 条×14 字；`poster_project` main 13 / sub 14。
- 构想第 1 次（2022）失败：c1/c2 侧栏套标题 4 行超 2 行，错误带容量「3 字×2 行（共 6 字）」；同任务内唯一一次纠正仍未改正 → 任务失败并保留原文（期望的阻断行为，同时暴露 D3）。
- 构想第 2 次（2026）通过：c1「窄口锁关」、c2「垛口传警」、c3「一炮扼关」，均为 p-vertical-left/right，`layer_plan={text_layout, items:[poster_project, poster_title, poster_details]}`，copy 与 layer_plan 文字一致。
- `concept/generate` c1 → 2027；`apply-layer-plan` c1 → 3 个 text 层（`ai:poster_project/title/details`）；`POST /poster/versions` → 版本 22、23（provider=local、model=layer-doc），打开成图：标题「窄口／锁关」为最大字，项目行「八达岭长城测试 1111-3／第1集」在左上一个板，信息卡在左下，无溢出（`media/poster-v22.png`）。
- 引擎矩形：title y 0.25–0.389、details 0.668–0.84、project 0.17–0.203，均在 9:16 Poster 安全区（x 0.06–0.94、y 0.15–0.85）；details 底板向上渐隐延展到 0.86，低于安全下限 1%（D4）。
- 拒绝路径：把 `poster_title.main` 写成 19 字 → `POST /poster/versions` 返回 **400 `text_layer_invalid`**，`problems[0] = {code:"text_overflow", level:"error", layer_id:"ai:poster_title", field:"main", message:"「海报主标题」的「主标题」放不下（已缩到 90%）：7 行，超过 2 行，请改短"}`；恢复原 doc 后重渲成功（版本 23 为最终版）。

## 5. 全链路 / 导出（实测）

- 设计卡 → 图层段 8 段 ready → 关键帧 batch 22（603 last、610 first/mid）→ 视频 batch 28（603 2051、610 2052，MiniMax H3，均 completed）→ compose-batch 8/8 → merge **36** completed（`static/merged/8d8c439e-e8c9-4b92-8972-66d337659cb4.mp4`，duration 69s）。
- 浏览器实开成片：**69.04s / 544×960**（video.duration、videoWidth/Height，readyState=4；本机无 ffprobe/ffmpeg，时长依据为浏览器媒体元数据，按固定案例同样标注）；画面为竖版图层段 + C 生成段，底部烧录字幕「保存最完整的段落之一。」（#91 竖版 12 字/行）。截图 `screens/08-final-video.png`。
- D5 传承链：AI 设计卡把 #02–#08 的 `layer_plan.base` 写成 `inherit_prev`，但前序镜都是 A（纯图层），A 镜没有 `lastFrameImage`（只有关键帧出图写这一列）→ 7 镜 draft 全部 `missing_base`；操作员改为 `base={asset:scene 127}` 后通过。建议 `resolveDraftBase` 对前序 A 镜回退到该镜图层段末帧。
- D6 D 组合 + 承接：#08 卡是 D 且 `continuity=continue`，D+承接的首帧锁取上一镜尾帧（#07 是 A，无尾帧）→ 确认无法就绪、视频预览 blocked；操作员把 #08 `continuity_boundary` 改为 `cut`（改为自有首帧）后通过。建议设计卡批次选 D 时检查前序尾帧并在 UI 明示。
- D7 video_prompt 复制图层内嵌图：#01（C）的 video_prompt 写「右侧叠放一张竖幅圆角内嵌图重复呈现城墙与敌楼」，因为它读的是带内嵌图的 C 衔接帧。建议视频提示词改用去内嵌图的衔接帧或显式排除面板式构图。
- D8 文档缺口：`api-catalog.md` 未写 `POST /storyboards/{id}/confirm-keyframes` 的 Body；实际必须 `{confirmed:true}`（`confirmed = body.confirmed === true`），空 body 会**取消**确认；本轮首次 `{}` 调用被当作取消，视频预览报「关键帧尚未确认」。
- D9 生成段最短 4s：`video-batch/preview` 对 `budget.gen_s=3` 返回 blocked「生成段时长必须在 4–15 秒内」；#01 改为 layer 5.0s + gen 4.4s（合计 9.4s ≤ 配音 9.44s）后通过；建议卡片结构校验阶段就拦住。

## 验收结论（逐项）

| 项 | 结论 | 证据 |
|---|---|---|
| 1 设计卡只产 text 模板文本框 | **PASS** | 8/8 卡 `text_layout=v-center-top`，planned_layers 仅 `{type:'text',role,fields,at_s}`（+1 锚定 image）；无 card / 无锚点 label；audit `issues=[]`；task 2021 failed 0。observations 空（采集缺口） |
| 2 图层段 text + 渲染 + 竖版安全区 + 同区替换 + C/D 衔接帧无字 | **PASS（含 D1/D2）** | 8 段 ready；帧 20/62/70/95/140/145/200 打开核对；文字均在安全区、未进底部 35% 与按钮栏；heading→statement、烟火→号炮 同区替换成立；`j603.png`/`j610.png` 无 text。D1 替换交叉淡化 400ms 重叠；D2 image 层越界压按钮栏 |
| 3 编辑器 UI | **PASS** | 版式套 4 套可切换且不落库；模板文本框 6 类分组；容量提示「每行 13 字 × 2 行，已用 12 字」；51 字超长实时报「放不下（已缩到 90%）：4 行，超过 2 行」；未保存重开恢复（截图 02–07） |
| 4 Poster 构想/底图/成套文字/版本/拒绝路径 | **PASS（含 D3/D4）** | 2026 构想三套 `{text_layout,items}`；2027 底图；apply-layer-plan；versions 22/23 打开成图（标题最大、无溢出、安全区内）；19 字标题 → 400 `text_layer_invalid` + `text_overflow`，恢复后重渲成功。2022 首次构想因窄侧套 6 字上限失败（D3）；details 底板超安全区 1%（D4） |
| 5 全链到导出 | **PASS** | 8 图层段 → 3 关键帧 → 2 条 H3 视频 → compose 8/8 → merge 36（69s / 544×960，浏览器实开）。过程中 D5–D9 均为真实缺陷，用操作员决定绕过并留证 |

## 截图/媒体清单

- `screens/01-design-tab.png`：设计卡页 8 镜、#01 实测 9.4s。
- `screens/02-layer-editor-608.png`：分镜制作图层编辑器，图层段 12.0s 就绪、画布 544×960、底图 1088×1920。
- `screens/03-layer-style-capacity.png` / `04-layer-style-bottom.png`：选中「事实说明」的样式面板与容量提示。
- `screens/05-layout-switched-v-left-column.png`：切到左侧套，画布文字移动 +「有未保存改动」。
- `screens/06-overlong-text.png`：51 字超长说明的实时容量与「文本框问题」。
- `screens/07-restored-after-undo.png`：未保存重开后恢复原样。
- `screens/08-final-video.png`：成片播放（544×960、烧录字幕）。
- `media/poster-v22.png` / `poster-v23.png`：竖版海报成图；`media/kf-603-last.png`：C 生成段尾帧；`media/seg/*`：图层段渲染帧与 C/D 衔接帧；`media/shot1.wav`：第 1 镜配音（48kHz 单声道 9.44s）。

## 消耗台账（实际）

- 文字 LLM（计费）：rewrite run 13（fidelity+bridge）、骨架 2015、提取 1998/2000/2005 + 补提取 2008、资产审核 2006、资产提示词 3 次、设计卡 2021（8 镜）、Poster 构想 2022（失败）+ 2026、关键帧提示词（2 镜）、视频提示词（2 镜）。
- 图片（qwen config 9）：资产 3（2009/2010/2020）、Poster 底图 1（2027）、关键帧 3（2043+）= **7 张**。
- 视频（H3 config 8）：**2 条**（2051 #01 C 生成段 4.4s；2052 #08 D 生成段 4.8s）。
- TTS（VoxCPM config 13）：**8 条**（2019，总 60.0s）。
- 合成/拼接/图层渲染/Poster LayerDoc 渲染不计 AI 额度。

## 操作员决定记录（仅本测试项目）

1. 剧本确认（AI 改写稿 224 字，出处行在 prepared 阶段被剔除）。
2. 资产审核：9 项 create-assets 占位 + 5 项绑定已有地图 224（并把 224 标为忠实原件）+ 3 项 `not_needed`（说明性情境由旁白承担）+ 1 项绑定补提取 scene 130。
3. 旁白骨架确认（8 镜，261/261）。
4. TTS 音色沿用固定案例（纪录片·沉稳男声，seed 1720）。
5. 设计卡 8 张确认。
6. #01 改 C、#08 改 D（含预算与 at_s），#08 continuity=cut；#02–#08 base 改 scene 127。
7. 关键帧确认（603、610）。
8. Poster 构想重试、底图、apply-layer-plan、版本、拒绝路径与恢复。
9. 合成、拼接导出。
