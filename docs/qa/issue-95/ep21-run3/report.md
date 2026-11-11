# Issue #95 验收项 3 — drama 15 / 集 21 返工（第三次，run3）

**对象：** drama **15**《历史上的今天纪录片》，集 **21**（《秦亡》，9:16 竖屏，storyboards **573–594**，22 镜）。
**执行：** 2026-11-11 15:50–17:00 UTC，生产 API `http://172.30.3.164/huobao/api/v1`（master `68cbe03f`，Issue #95 release `20261111T154755Z`）。
**结论：** **质量门再次触发 → 未做合成、未导出、没有新 merge。** 22 镜中 **16 镜衔接**（MAE ≤10）、**6 镜不达标**（#3/#7/#9/#12/#13/#19）。本轮在 `compose-batch` 之前停止。4 镜是**画面内容/几何**真不连续（#3/#7/#12/#13），2 镜是**亮度/色调**跳变（#9 严重、#19 轻微且结构连续）。#95 收紧规则只救回 **#8**。

## 0. 授权与范围

用户 2026-11-11：「5，是的，需要返工」；「我需要你继续后续工作，所有的子代理都需要使用 deepseek (local) thinking 模型」。
协调者本轮预算：**视频 ≤7、计费文本调用 ≤10、图片 0、TTS 0**。

范围：只 drama 15 / 集 21（573–594）。业务写入仅生产 HTTP API；DB 只读；未改代码 / 未 git / 未重启；未改旁白、设计卡、组合、关键帧、图层段；未手写任何提示词。授权原话与范围见 `requests.jsonl` 第 1 条（`kind:"authorization"`）。

## 1. 提示词重出（7 镜）

`POST /episodes/21/generate-video-prompts {storyboard_ids:[575,579,580,581,584,585,591]}` → 文本任务 **1985**，15:50:37–16:01:38，`status:done completed 7 failed 0`（`prompts-start.json`、`prompts-status-final.json`）。

- 读回 22 镜比对：**恰好 7 镜** `video_prompt` 变化，#575/579/580/581/584/585/591；其余 15 镜逐字节未变（`storyboards-after-prompts.json` vs `shots-before.json`）。
- 首段结构校验（`check-first.mjs` → `first-segment-check.json`）：7 镜首段全部 **0–1 秒**、**无 @角色**、**无切镜/过渡写法**，保存未被退回。原文见 `prompts-7.tsv`。
- 衔接帧 caption 已是缓存（7 镜 `junction_caption.hash == junction_hash`，生成于 13:02–13:04），本轮 **0 次新视觉调用**；`GET /tasks/1985/observations` 的 `works/calls/messages` **全为 0**（该生成任务的工具消息未持久化，属观测缺口，不是保存失败证据；判据改用读回比对 + 首段校验）。

## 2. 视频批次

- `POST /episodes/21/video-batch/preview {storyboard_ids:[7 个], config_id:8, model:"MiniMax-H3-INT8-ComfyUI"}`：照例返回整集 22 镜；按自己 7 个 id 过滤后全部 `changed`+`checked`（#591 变化项为「提示词 + 参考图」），其余 15 镜 `unchanged`（`video-preview.json`）。
- `POST /episodes/21/video-batch` 只提交这 7 个 id → **batch 27**，`items=7`（`video-batch-start.json`），16:03:55–16:40:09 串行完成，7/7 `completed`，无 `retry-failed`（`video-batch-final.json`、`video-batch-final-reread.json`）。
- 任务：**1986**(575)、**1987**(579)、**1988**(580)、**1989**(581)、**1990**(584)、**1991**(585)、**1992**(591)。
- 产物：544×960、24 fps、6.58–7.29 s（`ffmpeg -i` 元数据，逐条视频文件）。

| 镜 | id | 新 `video_url`（当前版本） |
|---:|---:|---|
| #3 | 575 | `static/videos/66706584-8e9a-4ccd-85f6-e66114a4cd82.mp4` |
| #7 | 579 | `static/videos/b20b3527-e3db-4b9d-8759-aa47cb68d7f5.mp4` |
| #8 | 580 | `static/videos/18245eb6-f58e-4b04-98c0-703017bc92ea.mp4` |
| #9 | 581 | `static/videos/fb49c581-b287-42ad-b5ce-e11e84d3ec7e.mp4` |
| #12 | 584 | `static/videos/c2ddc49d-3703-4fce-8db2-59e19ff98f6d.mp4` |
| #13 | 585 | `static/videos/9bedb689-35a2-4be7-bf8f-bf5994a395ef.mp4` |
| #19 | 591 | `static/videos/39c0c513-898a-4254-8696-b74e1feaf4e8.mp4` |

其余 15 镜 `video_url` 与 run3 前完全一致（`shots-before.json` vs `storyboards-after-video.json`）。

## 3. 引导帧接线核对（排除输入错误）

外部 ComfyUI 只读（config 8 base_url、Basic 认证）`GET /history/{task_id}` + `/view?type=input`，见 `wiring-run3.json`、`comfy-history-a5557f13-….json`：

| 任务 | guide frame_idx | 上传首帧 sha256 = 衔接帧 PNG | midFrameTime | 参考图数 |
|---|---|---|---|---|
| 1986 | 0 / 72 / −1 | ✅ | 3.0 s | 7 |
| 1987 | 0 / 72 / −1 | ✅ | 3.0 s | 6 |
| 1988 | 0 / 72 / −1 | ✅ | 3.0 s | 6 |
| 1989 | 0 / 72 / −1 | ✅ | 3.0 s | 7 |
| 1990 | 0 / 72 / −1 | ✅ | 3.0 s | 8 |
| 1991 | 0 / 84 / −1 | ✅ | 3.5 s | 9 |
| 1992 | 0 / 84 / −1 | ✅ | 3.5 s | 7 |

7 个任务的 `firstFrameUrl` 均为本镜衔接帧 PNG，`MiniMaxH3AddGuide frame_idx 0` 指向它，上传字节与本地衔接帧 sha256 完全一致。即**接线与字节无误，差异出在 H3 对首帧的重绘**。

## 4. 逐镜衔接测量（灰度 136×240 MAE，衔接帧 vs 视频第 0 帧 / D 取末帧）

阈值：MAE ≤10 **且** 目视连续。原始数据 `all/junction-mae.json`、`run3/junction-mae.json`；拼版 `all/junction-vs-video.png`、`run3/junction-vs-video.png`（均已开图）。

| 镜 | id | 组合 | run2（上一轮） | run3 | 判定 | 差异性质（诊断） |
|---:|---:|---|---:|---:|---|---|
| #1 | 573 | C | 6.9 | 6.9 | PASS | 本轮未重出 |
| #2 | 574 | C | 8.3 | 8.3 | PASS | 未重出 |
| #3 | 575 | C | 24.2 | **22.7** | **FAIL** | 内容：**子婴白袍已出现在门洞内右侧**（衔接帧是空门洞）+ 整体偏暗（均值 116→94） |
| #4 | 576 | C | 7.7 | 7.7 | PASS | 未重出 |
| #5 | 577 | C | 9.8 | 9.8 | PASS | 未重出 |
| #6 | 578 | C | 5.9 | 5.9 | PASS | 未重出 |
| #7 | 579 | C | 14.4 | **12.1** | **FAIL** | 内容（轻微）：**画面右上角已有一只鞋入画**；另偏暗（均值 139→127） |
| #8 | 580 | C | 10.5 | **8.2** | **PASS** | 首帧空门洞，0–2 s 内与衔接帧偏差缓慢增长，无人物 |
| #9 | 581 | C | 40.1 | **35.9** | **FAIL** | 色调：构图一致、**0–2 s 偏差恒定 ~36**，衔接帧均值 54 vs 视频 18（衔接帧亮、视频为深夜） |
| #10 | 582 | C | 5.7 | 5.7 | PASS | 未重出 |
| #11 | 583 | C | 8.9 | 8.9 | PASS | 未重出 |
| #12 | 584 | C | 13.6 | **25.2** | **FAIL** | 几何：均值位移 0，残差 25.2；车辙/石碑/城墙位置偏移，机位不同 |
| #13 | 585 | C | 36.3 | **35.8** | **FAIL** | 内容+几何：衔接帧是车辙特写，视频首帧是**宽景且右侧已出现素车车轮** |
| #14 | 586 | D | 4.6 | 4.6 | PASS | 未重出 |
| #15 | 587 | C | 6.5 | 6.5 | PASS | 未重出 |
| #16 | 588 | C | 6.6 | 6.6 | PASS | 未重出 |
| #17 | 589 | C | 5.2 | 5.2 | PASS | 未重出 |
| #18 | 590 | C | 6.1 | 6.1 | PASS | 未重出 |
| #19 | 591 | C | 20.8 | **22.0** | **FAIL** | 色调：长卷构图一致（SSIM **0.937**、均值位移后残差 2.6），仅纸面偏暗（均值 211→189）；0–0.5 s 稳定，0.75 s 起卷轴滚动 |
| #20 | 592 | C | 5.7 | 5.7 | PASS | 未重出 |
| #21 | 593 | C | 5.7 | 5.7 | PASS | 未重出 |
| #22 | 594 | C | 5.6 | 5.6 | PASS | 未重出 |

汇总：**16 PASS / 6 FAIL**。通过镜头的 MAE 区间 4.6–9.8（未变），失败镜头 12.1–35.9。

### 4.1 诊断（辅助，不替代阈值判定）

- `all/junction-ssim.json`：通过镜 SSIM 0.66–0.94；#9 0.371、#13 0.338、#12 0.457（结构性差），#19 **0.937**（结构一致）。
- `all/junction-tone.json`：各镜视频普遍比衔接帧暗 5–9 灰度（通过镜残差 1.2–3.8）；#19 亮度差 −22 但残差 2.6；#9 亮度差 −35.9、残差 4.9（近乎整体曝光差）；#12 亮度差 0、残差 25.2（纯几何）。
- `run3/breach.json`（首 2 s 每 0.25 s 与衔接帧 MAE）：#9 全程恒定 ≈36（亮度差）；#3 从 22.7 缓慢上升（人物提前在场、且呈连续推近）；#8 无越界；#19 至 0.5 s 稳定 22–23，0.75 s 起骤升（卷轴在提示词所写 1 s 之前就开始滚动）。
- 开图结论（`run3/detail/sb*-n*.png`、`run3/crops/*.png`）：#3 门内白袍人影、#7 右上角鞋、#13 右侧车轮 + 宽景、#12 车辙与城墙错位均可直接看见；#9、#19 只有整体亮度差。

### 4.2 可以证明 / 不能证明

- 能证明：7 镜的提示词按新规则生成并保存（首段 0–1 s 空镜、无 @角色、无切镜）；引导帧接线、上传字节、帧序（0 / mid / −1）、画面尺寸（544×960）全部正确；7 镜视频确实是新版本（`video_url` 全部更换）。
- 不能证明：H3 为何仍把人物/道具提前到第 0 帧。`[推断]` 分段文本与中间帧引导在时间上互相拉扯：提示词 1 s 起就让人物入场，而 3.0 / 3.5 s 的中间帧已有人物站定，模型把入场前压到第 0 帧；#9/#19 的偏差则来自**衔接帧亮度与生成段曝光不一致**（衔接帧按底图原亮度渲染，生成段是"深夜/白纸"的光照），与提示词结构无关。
- 对照事实：这 7 镜在 baseline、run1、run2（旧规则）与本轮 run3（新规则）**连续四轮不通过**，只有 #8 在本轮首次通过。同一衔接帧底图下成败混杂：`9e20168` 底图的 #5(9.8)/#11(8.9) 通过而 #7(12.1)/#12(25.2)/#13(35.8) 不通过；`7b8408d` 底图的 #4(7.7)/#6(5.9)/#8(8.2) 通过而 #3(22.7) 不通过。说明失败不是接线、字节或某一底图的问题，而是**逐镜的 H3 首帧重绘行为 + 衔接帧/生成段曝光不一致**，仅改提示词文本的期望收益很低。

## 5. 停止点

按授权里的质量门（任一镜 MAE >10 或目视不连续 → 停止、不导出、报告，不再重试）：

- **未生成字幕**：`POST /episodes/21/compose-batch/preview`（只读、无副作用，本轮 16:58 读，`compose-preview-after-run3.json`）显示 22 镜 `inputs.subtitle/video/audio` 均为 `true`、状态 `changed`、`exportable:false`；本轮未改旁白/配音，故 SRT 无需新建（该 preview 只为取证，未提交合成）。
- **未合成、未导出、无 merge id、无最终 mp4**（本轮没有 duration/resolution 可报量）。
- 关键帧状态未受影响：`GET /episodes/21/gates` 仍为 design `confirmed 22/22`、production `ready 22/22`、export `false`（`gates-after-run3.json`）。

## 6. 预算台账

| 类别 | 上限 | 实际 | 说明 |
|---|---:|---:|---|
| 视频 | 7 | **7** | batch 27，任务 1986–1992；无失败重跑 |
| 计费文本调用 | 10 | **7** | 任务 1985 逐镜改写 7 次；衔接帧 caption 命中缓存，0 次视觉调用 |
| 图片 | 0 | **0** | – |
| TTS | 0 | **0** | – |

## 7. 需要用户裁决的选项（均未执行）

1. **接受 #19 并只处理其余 5 镜**：#19 结构 SSIM 0.937、残差 2.6，只是纸面亮 22 灰度；若允许，仍需另外解决 #3/#7/#9/#12/#13。
2. **补"衔接帧亮度对齐"**：衔接帧按底图原亮度渲染、生成段按夜景/曝光的提示词重新打光，建议在图层段末帧/首帧做一次与生成段首帧的曝光匹配（或让 H3 首帧条件带亮度锁定）。#9 属于此类，重出提示词无效。
3. **改 C/D 视频的中间帧策略**：把 `midFrameTime` 推到人物入场之后（如 ≥ 入场时间 + 1 s），减少"入场被前压到第 0 帧"。#3/#7/#13 属于此类。
4. **保持现状不导出**。
5. **允许再花预算重跑**（本轮上限已用完：视频 7/7、文本 7/10）。#12 属于机位/几何漂移，重跑不一定改善。

> 本报告是技术验收记录，不代表人工艺术或史实确认；未对成片做任何合成或导出。

## 8. 证据清单（`docs/qa/issue-95/ep21-run3/`）

- `requests.jsonl`（43 行：授权 + 全部生产 API 读/写 + 本地量具记录）
- `shots-before.json`、`storyboards-after-prompts.json`、`storyboards-after-video.json`、`gates-after-run3.json`
- `layer-seg-{573..594}-postprompt.json`（22 镜图层段 ready、`base_check_satisfied=true`、无 stale）、`layer-seg-{575,579,580,581,584,585,591}-before.json`
- `prompts-start.json`、`prompts-status-final.json`、`observations-prompts-1985.json`、`prompts-7.json`、`prompts-7.tsv`、`first-segment-check.json`（`check-first.mjs`）
- `video-preview.json`、`video-batch-start.json`、`video-batch-final.json`、`video-batch-final-reread.json`
- `compose-preview-after-run3.json`（只读 preview：22 镜 SRT/视频/音频齐备、`exportable:false`）
- `wiring-run3.json`（`wiring.mjs`）、`comfy-history-a5557f13-….json`、`first-1986.png`
- `run3/`：`junction-mae.json`、`junction-vs-video.png`、逐镜帧 PNG、`detail/sb*-n*.png`（衔接帧 + t=0/0.5/1.2/2.5 s）、`crops/*.png`（原生分辨率局部）、`breach.json`
- `all/`：`junction-mae.json`、`junction-ssim.json`、`junction-tone.json`、`junction-vs-video.png`、逐镜帧 PNG
- 脚本（只读量具）：`api.mjs`（带留痕的生产 API 封装）、`detail.mjs`、`crop.mjs`、`ssim.mjs`、`tonestat.mjs`、`breach.mjs`、`wiring.mjs`、`check-first.mjs`；共享量具 `../junction-mae.mjs`
