# Issue #95 发布后试点验收 — drama 17 / episode 23（八达岭长城测试 1111）

- 执行：2026-11-11 12:13–12:52 UTC；API `http://172.30.3.164/huobao/api/v1`
- 代码：master `6c0aee54`（Merge issue/95-c-junction, `a070483a`），release `20261111T121104Z`
- 结论：**FAIL**。595（C）、598（D）通过（MAE 4.2 / 4.6）；596（C）、597（C）不通过（MAE 25.2 / 20.7），且衔接处可见跳变。
- 授权原话（写入 `requests.jsonl` 第一条）：用户 2026-11-11「我需要你继续后续工作，所有的子代理都需要使用 deepseek (local) thinking 模型」；采用方案「改规则后重出」。协调者授权范围：本测试项目 drama 17 / 集 23 的设计卡改写+确认、图层段草稿/渲染、关键帧生成+确认（开图后）、视频提示词生成、视频 ≤4、图片 ≤10、计费文本调用 ≤15。
- 限定：只写生产 API（业务写入），DB 只读；未改代码、未 git、未重启、未合成/导出。

## 1. 预算台账（上限 → 实际）

| 项 | 上限 | 实际 | 任务/调用 |
|---|---|---|---|
| 图片 | 10 | **2** | 1949（598 首帧）、1950（598 中间帧） |
| 视频 | 4 | **4** | 1952 (595)、1953 (596)、1954 (597)、1955 (598) |
| 计费文本 LLM | 15 | **9** | 1948 关键帧提示词 1 次请求；1951 视频提示词批次 = 4 次 agent + 4 次衔接帧描述（`junction_caption`，config 10） |
| TTS / 合成 / 导出 | — | 0 / 0 / 0 | 未调用 |

无失败重试：4 镜视频提示词首轮全部落库（1951 completed 4/4）。

## 2. 步骤与任务 ID

1. **读现状**（12:13–12:20）：gates `design confirmed 7/8, production unlocked, assets missing=0`；595/596/597 均已确认设计卡 + 渲染图层段 + 关键帧（junction 分别为 43/44/45）；598–602 为 B、无图层段。四镜在视频提交前的状态与图层段快照见 `shots-before-video.json`、`layer-segments.json`（含本轮生成的 junction caption）。
2. **造一条 D 镜（598）**：
   - `PUT /storyboards/598/design-card`：combo B→**D**；`budget {layer_s:3, gen_s:6}`（旁白实测 7.84s，总 9s，余 1.16s，无 over/tight）；`layer_plan.base = scene #124 八达岭长城 (version_task_id 1817)`，`planned_layers: []`（本集无可用语义，按规则不写空锚点）；`gen_plan.first/mid/last` 沿用原卡文本，`reference_assets=[@八达岭长城]`。返回 `issues: []`。
   - `POST /storyboards/598/design-card/confirm {acknowledge:true}` → confirmed（0 阻断 0 警告）。
   - `POST /episodes/23/generate-keyframe-prompts {storyboard_ids:[598]}` → task **1948**：`completed:0 failed:1`，但业务已落库（首帧/中间帧提示词 + `mid_frame_time=3`，末帧按 D 规则留空）。**缺陷 1 见 §7。**
   - `POST /layer-segments/storyboards/598/draft` → 段 id 46，`duration 3`，`base{a6abb40d…, 544×960, source 1088×1920}`，`layers:0`；
   - `POST /layer-segments/storyboards/598/render` → task **1947**（12:24:11.8–12:24:12.4），junction `static/layer-frames/46-da1966b2…png`（source `layer_first`, t=0, stale=false, `base_check_required=false`）。
   - `POST /episodes/23/keyframe-batch/preview {storyboard_ids:[598]}`：first/mid `missing`，last `skipped`（锁定槽）。`POST /episodes/23/keyframe-batch {items:[first,mid]}` → batch 21 → 1949/1950 completed；开图（`78a90ee3…` 首帧、`9ea3616f…` 中间帧，均为竖构图长城远景，与 junction 同一城线）；`POST /storyboards/598/confirm-keyframes {confirmed:true}` → confirmed，junction hash 快照 `da1966b2…`。
3. **视频提示词**：`POST /episodes/23/generate-video-prompts {storyboard_ids:[595,596,597,598]}` → task **1951**（12:31:13–12:35:42，completed 4/4，`deepseek-chat` config 10 vision）。
   - 衔接帧描述（视觉模型 config 10，写入 `storyboard_layer_segments.junction_caption`，hash 匹配当前 junction）：
     - 595：`远景俯拍。画面主体为蜿蜒于山脊的长城石墙与砖砌敌楼，敌楼位于画面中下部偏左…画面右侧山谷留白。`
     - 596：`中景平视，画面中央偏左为一门深灰黑色老式火炮模型，炮管朝向左前方，架在带四个圆轮的木质炮架上…背景为纯白…留白主要在右侧与上方。`
     - 597：`全景平视。画面为夜间营地：左侧一排浅色帐篷沿草地排开，帐篷前插有燃烧的火把；右侧有石阶通向木制门架与栅栏…上方天空大面积留白。`
     - 598：`远景俯拍。画面主体为蜿蜒于山脊的长城石墙与砖砌敌楼…城墙自前景向右下延伸再折向左上、沿山脊通向远处峰顶的烽火台…留白在右上天空与远山处。`
   - `GET /tasks/1951/observations`：works 150–153 均为 `stage=junction_caption`、`status=completed`、`call_count=1`（595/596/597/598 各一次视觉调用）；`has_more=false`。**观测窗口包含衔接帧视觉调用 ✔**
   - 保存校验：4 镜均一次通过（C 首段/D 末段无切镜写法）。
4. **视频批次**：`POST /episodes/23/video-batch/preview`（返回整集 8 镜）→ 自己过滤：595 `changed`（原因「提示词」）、596/597/598 `missing`，599–601 `blocked 关键帧尚未确认`、602 `blocked 设计卡未确认`。`POST /episodes/23/video-batch {storyboard_ids:[595,596,597,598], config_id:8, model:"MiniMax-H3-INT8-ComfyUI"}` → batch **24**，逐镜任务 1952–1955 全部 completed（12:36:26→12:45:57）。
5. **测量**（只读）：`junction-mae.mjs` + `sample-frames.mjs` + ffmpeg 抽帧；拼版 `run1/junction-vs-video.png`、`run1/timeline-samples.png` 均已打开查看。

## 3. 逐镜 MAE（junction PNG vs 视频第 0 帧 (C) / 末帧 (D)，136×240 灰度）

| 镜 | combo | junction 取景 | base_check | 视频 | MAE | 阈值 | 结果 |
|---|---|---|---|---|---|---|---|
| #1 (595) | C | full（1088×1920 → 544×960） | 不需要 | `1658fbe8…mp4`（7.29s） | **4.2** | ≤10 | PASS |
| #2 (596) | C | **contain**（1024² 号炮 + 模糊垫底） | required/passed | `413bf7bd…mp4`（4.46s） | **25.2** | ≤10 | **FAIL** |
| #3 (597) | C | **contain**（1920×1088 夜营 + 模糊垫底） | required/passed | `12b7bc38…mp4`（5.17s） | **20.7** | ≤10 | **FAIL** |
| #4 (598) | D | full（1088×1920 → 544×960） | 不需要 | `35762787…mp4`（6.58s） | **4.6**（末帧） | ≤10 | PASS |

另：各 C 镜视频**末帧 vs 末关键帧** MAE 4.9 / 4.1 / 4.3 → H3 对齐了末帧引导（frame_idx -1）。

### 失败镜的分解（`run1/diagnosis.json`）
- **596**：full 25.2；正文区（y 208–752）**34.8**、上垫底 2.2、下垫底 23.3；最优平移 dx=-12/136px（≈9% 画宽）后仍 16.3 → 炮身在画面里被放大/左移，是重新构图，不是纯色调差。
- **597**：full 20.7；正文区（y≈326–634）21.5、上垫底 17.1、下垫底 23.5；平移无改善（内区最优 21.2）；灰度均值 junction 53.7 vs 视频首帧 **33.0** → 明显变暗并重新构图。

## 4. 输入核对（排除误判）

- 提交参数正确：596/597 `firstFrameUrl` = 各自 junction PNG，598 `lastFrameUrl` = 46-da1966b2…；`junction_slot/hash` 一并落库（1953/1954/1955 params）。
- ComfyUI 工作流（`GET {config8}/history/<task>`，只读）：`guideimg0 (huobao_1953_first.png) → guide0 MiniMaxH3AddGuide frame_idx 0`，`guideimg1 → frame_idx 48`（2s），`guideimg2 → frame_idx -1`；597 同构；598 的 `guideimg2 (huobao_1955_last.png) → frame_idx -1`。
- 上传输入字节：`/view?filename=huobao_1953_first.png&type=input` sha256 = junction sha256（7372e72b…）；597 `009eeac5…`、598 `da1966b2…` 同样逐字节一致。
- 送 H3 的提示词（node 1）确实以衔接帧开场：596「The scene begins exactly at <Picture 1> (the 0.00-second guide frame): a medium eye-level static shot, the old cannon … pure white background…」；597「At 0.00 seconds, the frame exactly matches <Picture 1>: a night camp scene…」。
→ **输入、引导帧接线、上传字节、提示词都正确**，差异来自 H3 实际渲染的首帧。

## 5. 视频提示词首/末段（`prompts-after-1951.txt`）

- **595 (C)** 首段 `0-3秒`：复述 caption（远景俯拍、城墙顺脊线、敌楼中下部偏左、右侧山谷留白、无人、镜头不动），无切镜 ✔。第二段起出现 `3-3秒：切到…`（零长度时间段，见 §7 缺陷 2）。
- **596 (C)** 首段 `0-1.5秒`：复述 caption（中景平视、中央偏左火炮、四轮炮架、纯白背景、留白在右上、无人、镜头不动），无切镜 ✔；`1.5-4秒：切到…墙顶`。
- **597 (C)** 首段 `0-2秒`：复述 caption（夜间营地、左侧帐篷与火把、右侧石阶木门架、暗蓝灰调、上方天空留白、无人），无切镜 ✔；`2-5秒：切到…城墙`。
- **598 (D)** 末段 `6-9秒`：收束到 caption（远景俯拍长城石墙与敌楼、敌楼中下部偏左、右侧山谷、土黄灰蓝、右上留白、无人、镜头停住），无切镜 ✔；首段 `0-3秒` 亦无切镜。总 9s = 生成段 6s + 图层段 3s，与预算一致。

## 6. 判定

抽帧目视（`run1/timeline-samples.png`，0/0.5/1/2s + D 末 0.6/0.3/0.05s）：595 前 2 秒无跳切，只有轻微推进与色调变化；596 在 0.5–1s 之间切到墙顶（提示词第二段写的是 `1.5-4秒：切到…`，实际略早）；597 在 1–2s 之间切到白昼城墙（提示词第二段 `2-5秒：切到…`，实际略早）——这两处段间切镜是设计内动作，问题只在 0s 与衔接帧不接；598 末 0.6s 稳定停在衔接帧构图。

- 逐镜 MAE 与拼版目视：595、598 的衔接处连续（同一构图的城线远景，仅有轻微色调差）；**596、597 的衔接处有明显跳变**——596 的炮在视频首帧被放大并左移约 9% 画宽（白底垫底也随之变化），597 的夜营被重新取景且整体约 21 灰度变暗。
- 因此按试点口径（MAE ≤ 10 且目视连续）：**PASS 2 / FAIL 2 → 试点 FAIL**。
- 观察规律（供裁决，不作已证事实）：两条通过的 C/D 镜，其图层底图本来就是项目画幅（1088×1920 → 544×960，`framing=full`）；两条失败的 C 镜，衔接帧是 #94 的 contain 渲染（1024² 道具、1920×1088 横版场景 + 同图模糊垫底，`framing=contain`）。H3 会把“模糊垫底”当成真实天空/地面并重新构图，首帧不再等于衔接帧；提示词规则能约束文字，但不能约束 H3 对垫底帧的重绘。【推断】
  - 旁证：H3 对末帧引导（frame_idx -1）保持很好（末帧 vs 末关键帧 4.1–4.9），对 full 首帧同样好（595 4.2、598 末帧 4.6），只有 contain 首帧失败。
- 建议（待用户裁决，未执行）：(a) C 镜的图层底图改为项目画幅版本（`POST /scenes|props/{id}/aspect-version`）再重渲，让衔接帧 `framing=full`，用同两镜复测；(b) 或规定 C/D 的图层底图必须是项目画幅，contain 底图只能用在 A/B 或 D 的尾段（D 的末帧引导被 H3 保住）；(c) 若维持现状，合成前必须逐镜核对首帧衔接，不达标不导出。

## 7. 本轮发现的缺陷（未修，属 Issue #95 之后的新问题）

1. **D 镜关键帧提示词批次误判失败**：task 1948 因「`last_frame_prompt` 非空」作为成功判据，而 D 的末帧槽位按锁规则必须留空 → `completed:0 failed:1`，但画面提示词其实已落库（首帧/中间帧 + `mid_frame_time=3`）。失败的 `progress` 会误导“重跑”并可能重复计费。判据应像 `keyframe-batch/preview` 一样识别锁定槽位。
2. **视频提示词保存校验未拦零长度/超时段时间段**：595 的 `3-3秒：切到…` 被接受，且段落总时长（10s）超过生成段 7s；这只是文本质量缺陷，不影响切镜规则，但会让 H3 收到自相矛盾的时间轴。
3. 备注（非缺陷）：597 的视频提示词只有 `0-2秒`、`2-5秒` 两段（623 字），末尾完整；其首个切镜发生在第 2 秒，与分镜设计一致。

## 8. 证据清单（本目录）

- `requests.jsonl`（55 行：授权 + 41 次 API + 13 条只读/外部只读留痕）
- `shots-before-video.json`、`layer-segments.json`（595–598 现状与 junction caption/base_check）
- `prompts-after-1951.txt`（4 镜完整 video_prompt）
- `run1/junction-mae.json`、`run1/junction-vs-video.png`（拼版已开）
- `run1/timeline-samples.png` + `shot-*-C-t*.png`、`shot-4-D-sseof*.png`（0/0.5/1/2s 抽帧，已开）
- `run1/cmp-596.png`、`run1/cmp-597.png`（junction vs 视频首帧原生尺寸并排，已开）
- `run1/diagnosis.json`（分区 MAE、色调、平移估计、引导帧接线与 sha256 核对）
- `run1/shot-1-first.png`、`shot-2-first.png`、`shot-3-first.png`、`shot-4-last.png`
- `sample-frames.mjs`（本轮新增的只读抽帧量具）
- `baseline/`（595 旧视频，MAE 4.2，仅作对照）

未执行：compose / merge / 导出；599–602 未改动（599–601 关键帧仍未确认，602 设计卡仍待确认）。
