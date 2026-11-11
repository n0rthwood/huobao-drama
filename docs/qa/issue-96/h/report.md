# Issue #96 生产验收报告 — 八达岭长城测试 1111-2（16:9 横版）

- 日期：2026-11-11
- 生产入口：`http://172.30.3.164/huobao/`，API `http://172.30.3.164/huobao/api/v1`（生产后端、生产库）
- Release：`20261111T182351Z`（commit `e0130b96`）
- 证据目录：`/home/joysort/huobao-qa-96/h/`（`requests.jsonl` 417 条、截图、渲染帧、视频、只读 JSON 快照）
- 浏览器会话：`huobao-qa-96-h`（agent-browser CLI + dogfood），已 `close`

## 0. 对象与授权

| 项 | 值 |
|---|---|
| drama_id | **18**「八达岭长城测试 1111-2」 |
| project_type / documentary_rules | `documentary` / `on`（`POST /dramas` 返回即 `on`） |
| aspect_ratio / style | `16:9` / `documentary-archival`（「冷峻档案纪实」） |
| episode_id / 显示集数 | **24** / 第 1 集（`episode_number=1`） |
| 文本 / 图片 / 视频 / TTS 配置 | id **10** deepseek-chat（vision=true）/ id **9** qwen-image-2.1 / id **8** MiniMax-H3-INT8-ComfyUI / id **13** VoxCPM Studio |
| 只碰本测试项目 | 是；dramas 1–17 未读写业务字段，DB 未做任何写操作，仅 API |

本轮按用户验收授权（无预算上限）连续执行，人类决定端点（剧本确认、资产审核处置、骨架确认、设计卡确认/编辑、关键帧确认、组合与预算编辑）均由本人以「acceptance operator decision」代行并在 §7 记录，**不代表用户艺术批准**。

## 1. 链路上的任务 ID（逐阶段）

| 阶段 | 调用 | task / 对象 ID |
|---|---|---|
| 建项目 / 建集 | `POST /dramas`、`POST /episodes` | drama 18 / episode 24（`POST /dramas` 返回 **201**） |
| 原始内容 | `PUT /episodes/24 {content}` | 正文 224 字（去空白）+ 1 行刻意保留出处行 |
| AI 改写（#80 流水线） | `POST /episodes/24/script-rewrite` | run **12** / task **1993**（fidelity.v2 → bridge.v1，2/2 完成，`auto_adopt`，final_version 46） |
| 旁白纯度检查 | `POST …/inspect-narration` ×2 | 原稿命中 1 条 `locatable:true` 出处行；定稿 `findings: []` |
| 资产提取 | `POST /episodes/24/extract` ×3 | scenes **1995** / props **1996** / characters **1997**（props 等 scene 锁后完成） |
| 单资产补提取 | `POST /asset-review/items/{id}/extract` | 2001(467)、2002(470)、2003(471)、2004(472)、2007(477) |
| 资产审核清单 | `POST /episodes/24/asset-review/run` | task **1999**，6 段 20 项 → 补提取 5 项、`not_needed` 7 项 → `passed` |
| 资产提示词+出图 | `POST /dramas/18/assets/batch-generate` | batch **2011**：6 提示词 + 6 图（2012/2013/2014/2015/2016/2017/2018 中 6 个 image 任务），地图 2 个 skipped |
| 旁白骨架（#81） | `POST /episodes/24/narration-skeleton/generate` | task **2023**，6 镜 611–616，覆盖 **224/224**，无 gap |
| TTS 配音 | `POST …/narration/voice-batch` | task **2024**，6 镜，实测 9440/6720/7840/9440/10560/8800 ms，`tts.valid=true` |
| 设计卡（#82/#96 项 1） | `POST /episodes/24/design-cards/fill` | task **2025**（填卡端点不返回 task_id，用 tasks/center 前后快照定位：新增 `kind=design_card` 行），6/6 completed、0 failed，42 次模型调用 |
| 图层段草稿 | `POST /layer-segments/storyboards/{611,612,613,614,616}/draft` | 段 **47/48/49/50/51**，时长 5.0/3.2/4.4/5.8/4.0 s，`text_layout` 已写 |
| 图层段渲染 | `POST …/render` | task **2028–2032**（613 重渲 **2065**）；spec 960×544 @25fps |
| 关键帧提示词 | `POST /episodes/24/generate-keyframe-prompts` | task **2046**（6/6） |
| 关键帧出图 | `POST /episodes/24/keyframe-batch` | batch **23**，11 项（mid/last），11 completed / 0 failed |
| 视频提示词 | `POST /episodes/24/generate-video-prompts` | task **2041**（6/6） |
| 视频（H3） | `POST /episodes/24/video-batch` | batch **29**（6 镜）→ 613 失败；`retry-failed` batch **30** 再失败；batch **31**（仅 613）成功。视频任务 2066–2070 + 613 的一次 |
| Poster（#96 项 4） | `POST /poster/concept` / `concept/generate` / `apply-layer-plan` / `versions` | concept task **2047**，底图 task **2049**，版本 **25**（合成）、**26**（恢复后合成）、底图版本 **24** |
| 合成 | `POST /episodes/24/compose-batch` | 5 镜（611/612/613/614/616）→ `unchanged`+`exportable` |
| 导出 | `POST /merge/episodes/24/merge` | merge **37** completed，`static/merged/c59e6686-47d4-4719-bba1-648fbbbf51e3.mp4`，47 s（浏览器实测 **47.12s**） |

## 2. 逐镜屏幕文字表（#96 项 1 证据）

全部 6 张设计卡都由 DeepSeek local 写成 `planned_layers[].type = "text"` + `{role, fields, at_s}`，并写 `layer_plan.text_layout`；**零 `card`、零无锚点 `label`**（`storyboards-after-fill.json` 全文可核）。

| 镜 | combo | text_layout | 文字层（role → fields） | at_s |
|---|---|---|---|---|
| #01 611 | C | `h-left-stack` | date → 明代/永乐以后；heading → 八达岭长城/北京西北 · 军都山关沟北口；keyword → 规制最高/明代长城中保存最完整的段落之一 | 0.4 / 0.4 / 2.8 |
| #02 612 | C | `h-bottom-left` | date → 永乐以后/明代 · 十五世纪初起；heading → 京师北面防线/外线宣府大同 · 内线居庸关；keyword → 层层加厚/外有宣府大同，内有居庸关 | 0.3 / 1.2 / 3.2 |
| #03 613 | C | `h-left-stack` | heading → 外有宣府、大同；heading → 内有居庸关；heading → 八达岭为居庸关前哨（同区三次替换） | 0.3 / 2.0 / 3.4（操作员重定时，见 §7） |
| #04 614 | C | `h-left-stack` | heading → 城墙形制/依山脊起伏 · 条石为基 青砖包砌；bullets → 3 条；keyword → 五马并行/马道宽处净宽 · 便于快速调兵 | 0.2 / 2.2 / 4.6 |
| #05 615 | **B** | —（无图层段） | 无文字层（纯生成段） | — |
| #06 616 | C | `h-center-top` | heading → 逼入山道/不只是阻挡 · 更把进攻者逼入狭窄山道；heading → 守住咽喉/以较少兵力 · 守住通往北京的咽喉 | 0.3 / 4.6 |

读时问题码：6 镜 `design_card_issues` 中 **没有任何 `text_plan_invalid` / `text_plan_warning`**；出现的是 `budget_tight`(道 613、616 各 1，warn) 与 `budget_missing`(616 初始，block，操作员补 4+5s 后消除)。

AI 拒绝计数（`GET /tasks/2025/observations` 42 calls / 509 messages，逐 call 取 messages）：**3 次工具输入校验失败，全部在镜 #04 614**，原因均为 `design_card: Invalid input: expected object, received string`（模型把卡片当 JSON 字符串传入），第 4 次调用成功；**没有任何容量/溢出/同区冲突类拒绝**（模型先 `readStoryboardContext` 拿到 `text_spec.capacity` 再写）。

## 3. 图层段渲染判定（#96 项 2）

段 spec：960×544 @ 25fps（`spec.source=default`，本集无既存视频时按 16:9 兜底）；底图 1920×1088 → 比例一致，无裁切/contain，因此 `base_check_required` 为 null。

| 证据 | 结论 |
|---|---|
| `frames/611-last.png` | date 左上 / heading 左中 / keyword 左下，**无重叠**，全部在 16:9 安全区（y≤0.86）；底图上可读（有底板） |
| `frames/612-last.png` | `h-bottom-left`：heading 底左块底边约 0.80，**未进底部 14% 字幕带**；keyword 左上，无重叠 |
| `frames/613-f20.png` → `frames/613-last.png` | 同区替换成立：#03 三个 heading 逐个替换，末帧只剩「八达岭为居庸关前哨」 |
| `frames/616-f140.png` | 两个 heading 同区替换成立：末帧只剩「守住咽喉」 |
| `frames/614-f30.png` / `-f90.png` | 1.2s 只有 heading；3.6s 只有 bullets（同区替换成立） |
| `frames/614-f60.png` | **缺陷 1**：2.4s（替换淡入窗内）heading 与 bullets **同时可见并叠字** |
| `frames/{611..616}-junction.png` | 衔接帧**不含文字**（C 镜末精确帧 = 干净底图，与 base 字节同尺寸 1048338/1036076） |
| `frames/*-segment.mp4` | 5 段 mp4 均 200 `video/mp4`；mvhd 时长 5.0/3.2/4.4/5.8/4.0 s 与段时长一致（本机无 ffmpeg/ffprobe，用 MP4 容器 mvhd 解析；尺寸以浏览器实测 960×544 为准） |

## 4. 编辑器 UI 判定（#96 项 3）

`ui-01-production.png` → `ui-13-design-layerlist.png`（agent-browser 会话 `huobao-qa-96-h`，全部截图已开图确认）：

- `ui-03-tpl-menu.png`：「添加模板文本框」下拉按类别列出 6 个视频类型（标识类 时间锚 / 叙事类 主题标题·事实说明 / 强调类 关键词 / 引语类 引文 / 数据类 数据结论 / 结构类 要点列表）+「添加」按钮。
- `ui-05-layer-style-bottom.png`：选中「主题标题」后 LayerStyle 逐字段输入 + 实时容量「每行 13 字 × 2 行，已用 5 字」「每行 26 字 × 1 行，已用 14 字」。
- `ui-06-overflow.png`、`ui-07-overflow-problem.png`：把标题改成 30 字 → 「△「主题标题」的「标题」放不下（已缩到 90%）：3 行，超过 2 行，请改短」，画布同步出现 3 行并缩小；随后把原文写回，问题区消失（`ui-08-restored.png`）。
- `ui-09-layout-switched.png`：版式套 4 个选项切到「上中语境／中部主叙事／下中关键词」，画布文字整体移到中上（层保留、文字不动）。
- `ui-10-after-reload.png`：reload 丢弃本地改动；`GET /layer-segments/storyboards/611` 读回 `text_layout=h-left-stack`、`render_signature=6aca1fa4…` 与渲染前一致、`junction.stale=false` → **镜头未被弄坏**。
- `ui-12-design-layers.png` / `ui-13-design-layerlist.png`：设计卡面板把 planned_layers 显示为「模板文本框」行 + 类型下拉 + at_s + 每字段容量提示（时间锚 0.4s / 主题标题 0.4s / 关键词 2.8s），页头显示「有问题 2」（= 613/616 的 `budget_tight` 警告）。

## 5. Poster（#96 项 4）

- `POST /poster/concept`（task 2047）→ 3 个构图，每个 `layer_plan = {text_layout, items[{role,fields}]}`，role 仅 `poster_project / poster_title / poster_details`，**无坐标无字号**：c1 `p-landscape-left`、c2 `p-landscape-right`、c3 `p-landscape-bottom`；c1 `recommended:true`、`selected_composition_id=c1`。
- `concept/generate`（qwen cfg9，task 2049）出 16:9 底图（1344×768，无字）；`apply-layer-plan {composition_id:c1}` → `layer_doc.text_layout=p-landscape-left`，3 个 `ai:` 文字层，`provenance` 全 `ai`。
- `POST /poster/versions` → 版本 **25**（`static/overlays/b37e34bc…png`）。
- 开图判定（`h/poster-v25.png`）：主标题「关沟最窄处的／咽喉」为画面最大文字；字幕/信息卡无溢出、无裁切；文字全部在 16:9 poster 安全区（x0.05–0.95、y0.06–0.94），信息卡在左下、不撞右下「时长角标」避让区。
- **拒绝路径**：`PUT /poster {layer_doc}` 把 `poster_title.main` 改 45 字 → `POST /poster/versions` 返回 **400 `text_layer_invalid`**，`problems[]` = `text_overflow`（「已缩到 90%：5 行，超过 2 行，请改短」）+ `text_duplicate_same_beat`（与信息卡条目重复）；恢复原 `layer_doc` 后 `versions` 200 → 版本 **26**（`poster-v26.png`，与 v25 同字节数 2131290，逐像素目视一致）。

## 6. 全链到导出（#96 项 5）

- 关键帧：11/11（6 镜 first 由衔接帧继承，612 无 mid）→ 6 镜 `confirm-keyframes` 成功。
- 视频（H3 cfg8）：611/612/614/615/616 一次成功，613 三次（详见缺陷 3），最终 6 段 mp4 均下载（2.1–6.2 MB，200 `video/mp4`）。
- 合成：`compose-batch/preview` → 611/612/613/614/616 `unchanged`+`exportable:true`；615 `excluded`：**「分镜 #5 的生成段实测超过 15 秒」**（H3 实际输出 15.08 s）。
- 导出：`POST /merge/episodes/24/merge {storyboard_ids:[611,612,613,614,616]}` → merge **37** completed（47 s），`skipped: []`。
- **实际打开**：`export/episode-24-merge37.mp4` 下载 6,624,377 字节，sha256 `d0dc5d141777690e188061bee160f0c37bbf0e3ff1a60d9204cc3cfa9b7b7980`；浏览器播放元数据 **960×544 / 47.12 s**；`ui-15-export-t30.png` 为 0:30 实帧（镜 #04：bullets 文本框在画面上部、旁白烧录字幕在下部，二区不重叠）。
- 未覆盖：615 未进成片（缺陷 2）。

## 7. 验收结论（逐项）

| 项 | 结论 | 依据 |
|---|---|---|
| 1. 设计卡只产模板文本框 + text_layout | **通过** | §2；6/6 卡、0 `card`/0 无锚点 `label`/0 `text_plan_*`；AI 拒绝 3 次（工具 schema，非容量） |
| 2. 图层段草稿/渲染/视觉 | **通过（含 1 个警告级缺陷）** | §3；5 段渲染成功、同区替换成立、衔接帧无文字、安全区合规；缺陷 1：替换淡入 400 ms 窗口内新旧框叠字 |
| 3. 编辑器 UI | **通过** | §4；版式套切换/添加菜单分类/容量提示/溢出提示/撤销回原/设计卡面板 |
| 4. Poster | **通过** | §5；构想 layer_plan、apply、渲染判定、400 拒绝路径 + 恢复 |
| 5. 全链到导出 | **部分通过（6 镜中 5 镜成片）** | §6；615 因 H3 输出 15.08 s 超 15 s 上限被合成排除（缺陷 2）；613 需绕过转场评审（缺陷 3） |

## 8. 缺陷（含证据与建议修法）

1. **同区文字替换的 400 ms 淡入窗内新旧框叠字**（警告级）
   证据：`frames/614-f60.png`（t=2.4s，heading「城墙形制」与其眉题仍半透明可见，与 bullets 三行重叠；`frames/614-f30.png`、`-f90.png` 两端干净）；段 timeline `0.2→L1, 2.2→L2`，`fade_ms=400`。
   影响：单镜内约 0.4 s 出现不可读叠字，出现在所有同区替换的段。
   建议：同区替换改为「先淡出（≤fade_ms/2）再淡入」，或在替换窗内把旧框 alpha 归零后立即切新框；只在同区替换时缩短 fade。

2. **H3 输出时长超过 15 s 上限，导致该镜不能合成**
   证据：`compose-batch/preview` 对 615 返回 `excluded` /「分镜 #5 的生成段实测超过 15 秒」；`videos/615.mp4` mvhd 时长 15.083 s；本镜旁白实测 10.56 s、budget gen_s=5。
   影响：一镜被排除在成片之外（本次导出 5 镜）。
   建议：视频提交时把 `duration` 上限钳到段的 gen_s（或 ≤15 s）并记录实际档位；或在 H3 返回超长时自动截断到目标时长并标注；合成侧文案也建议给出「实际 15.08s / 上限 15s」的具体数字。

3. **转场评审（transition review）文本步骤对镜 #03 确定性失败，阻断 H3 视频**
   证据：video-batch **29** 与 `retry-failed` **30** 两次返回同一错误「分镜 #3 转场生成失败：模型没有提交有效的转场决策（update_storyboard 未成功调用或 technique_id 非法）」；镜 #03 的 `transition_review.verdict="none"`、`reason` 说明上一镜尾帧与本镜首段均为空（早先快照），即模型在面对差异极大的输入时未调用工具。
   影响：无法用唯一可用文本模型（cfg 10）重试通过；本次以 `PUT /storyboards/613 {transition_enabled:false}` 绕过（操作员决定，已记录），镜 #3 随后一次生成成功。
   建议：评审失败时给出模型原始回复摘要（现在只显示模板错误）；把「无需转场」作为可提交的显式决策（模型可 `technique_id:"none"`），避免必须编出一个技法；或在无可比输入时直接判 `none` 而不调用模型。

4. **关键帧提示词未覆盖设计卡的 `gen_plan.reference_assets`（组合 B）**
   证据：`keyframe-batch/preview` 对 615（B）返回 blocked：「分镜设计卡要求本镜生成段参考「八达岭长城」，但中间帧提示词没有 @八达岭长城；…尾帧没有 @城墙上士兵…、@号炮」；模型实际把 @ 写在描述里但漏了必需的 @ 名。
   影响：组合 B 的镜头必须先人工补 @ 才能出图（本次操作员手动补齐 mid/last 提示词后 unblock）。
   建议：keyframe-prompt 工具在保存时用 `gen_plan.reference_assets` 做名字级校验并把缺失的 @ 名单回给模型补写（现在只在批量预览阶段才暴露）。

5. **Poster `poster_project.sub` 写成「第1集 · 第1集」**
   证据：`poster-concept.json` c1/c2/c3 三个构想的 `poster_project.fields.sub` 均为「第1集 · 第1集」；根因是集标题恰好等于「第1集」。
   影响：难看但不越界（未被 #96 规则拦截）。
   建议：`sub` 拼接去重（当 `episode.title` 与「第N集」相同则只写「第N集」）。

6. **设计卡 AI 的 `budget.gen_s` 与「生成段必须 ≥4 s」约束不一致**
   证据：613 原卡 `budget {layer_s:4.4, gen_s:3.6}` 被 `video-batch/preview` 判 blocked「生成段时长必须在 4–15 秒内」（实测 gen = 7.84 − 4.4 = 3.44 s）；操作员把 text 拍子改到 0.3/2.0/3.4、layer 3.6 s 后才通过。
   影响：一张「合法」的卡可能整镜无法出视频，需人工返工。
   建议：`design_card-context` 把「gen ≥ 4 s」的硬约束与推导公式（gen = 实测旁白 − layer）写进话术与容量表，并在填卡保存时校验。

## 9. 消耗台账（本轮实际）

- **图片（GPU）18 张**：资产 6（batch 2011，任务 2012–2018 中的 6 个）、关键帧 11（batch 23）、Poster 底图 1（task 2049）。地图 2 个资产被 batch 跳过（`skipped.map=2`）。
- **视频（GPU）6 条**：H3 611/612/613/614/615/616（batch 29 起 5 条 + batch 31 补 613；batch 30 的 `retry-failed` 在转场评审处失败，未提交视频作业，无计费）。
- **TTS 6 条**：task 2024。
- **计费文本 LLM 调用（DeepSeek local cfg10）**：script-rewrite 2 次阶段调用（fidelity.v2、bridge.v1）+ inspect-narration 2 次 + 提取 8 次工作项（3 类 + 5 单资产）+ 资产审核 6 次 + 资产提示词 6 次 + 旁白骨架 1 次 + 设计卡 6 次工作项/42 次调用 + 关键帧提示词 6 次 + 视频提示词 6 次 + Poster 构想 1 次 + 转场评审 3 次（615/616/613 等，613 两次失败）+ 关键词域外的无。
- **不计费**：图层段渲染 6 次、合成的 5 镜、merge 37、Poster 版本渲染 2 次（服务端 LayerDoc 渲染）。
- 无超预算、无失败后追加重跑同一成功项（只有 613 视频按 `retry-failed` 语义重试）。

## 10. 环境说明

- 本机 **无 ffprobe/ffmpeg**：视频时长/尺寸用 MP4 容器（`mvhd`）解析 + 浏览器 `video` 元素实测（960×544 / 47.12 s），未伪报 ffprobe 结论。
- 静态媒体不在 `/api/v1` 下：直接取 `/api/v1/static/...` 会得到 200 + HTML（2841 字节 SPA）；正确路径是 `http://172.30.3.164/huobao/static/...`，每次下载都校验了 `Content-Type`。
- `GET /episodes/{e}/keyframe-prompts/scope` 是 GET（我用 POST 试探得到 404，已记录，不影响流程）。
- 只读：所有产物路径、签名、状态均来自 API 读回；未直连生产库写、未重启服务、未改仓库文件。
