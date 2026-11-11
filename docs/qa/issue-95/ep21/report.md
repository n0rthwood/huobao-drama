# Issue #95 验收项 3 — drama 15 / 集 21 返工（第二次）

**对象：** drama **15**《历史上的今天纪录片》，集 **21**（《秦亡》，9:16，storyboards **573–594**，22 镜）。
**执行：** 2026-11-11 13:01–15:30 UTC，生产 API `http://172.30.3.164/huobao/api/v1`（master `6c0aee54`，Issue #95 release `20261111T121104Z`）。
**结论：** **仍不达标 → 质量门触发，未做字幕、合成、导出。** 22 镜中 15 镜衔接（MAE ≤10 且目视连续），**7 镜在重出一次后仍不衔接**（#3/#7/#8/#9/#12/#13/#19）。按授权方案的质量门（"不达标镜头只允许重出 + 重跑 1 次，仍不达标则停止、不导出、报告用户"）在 `compose-batch` 之前停止。

## 0. 授权

用户 2026-11-11：「5，是的，需要返工」；「我需要你继续后续工作，所有的子代理都需要使用 deepseek (local) thinking 模型」。采用方案：**改规则后重出**（重出受影响镜头视频提示词 → 重跑视频 → 合成导出 ep 21）。预算：视频 ≤34、计费文本调用 ≤45、图片 0、TTS 0。本轮未重新确认关键帧（没有因本轮写入被自动取消——22 镜 `keyframes_confirmed=true` 全程保持）。
授权原文与范围已写入 `requests.jsonl` 第 1 条（`kind:"authorization"`）。

约束遵守：只写生产 HTTP API；DB 只读（量具脚本 `bun:sqlite` readonly）；未改代码、未 git、未重启、未改旁白/设计卡/组合/关键帧/图层段，未手写任何提示词。

## 1. 逐镜 MAE（灰度 136×240，衔接帧 vs 视频第 0 帧）

阈值：MAE ≤10 **且** 目视连续（阈值依据：已衔接镜头 4.1–7.0，不衔接 ≥18.9；见 Issue #95 评审意见处理）。D 镜取末帧。

| 镜 | id | 组合 | baseline | run1 | run2（重出 1 次） | 判定 | 视频任务 | 重试任务 |
|---:|---:|---|---:|---:|---:|---|---:|---:|
| #1 | 573 | C | 83.5 | **6.9** | – | PASS | 1957 | – |
| #2 | 574 | C | 8.3 | 8.3 | – | PASS（未在目标集，未重出） | – | – |
| #3 | 575 | C | 66.0 | 28.5 | 24.2 | **FAIL** | 1958 | 1978 |
| #4 | 576 | C | 42.6 | **7.7** | – | PASS | 1959 | – |
| #5 | 577 | C | 57.1 | **9.8** | – | PASS | 1960 | – |
| #6 | 578 | C | 45.6 | **5.9** | – | PASS | 1961 | – |
| #7 | 579 | C | 61.0 | 14.7 | 14.4 | **FAIL** | 1962 | 1979 |
| #8 | 580 | C | 23.6 | 13.5 | 10.5 | **FAIL**（临界，>10） | 1963 | 1980 |
| #9 | 581 | C | 34.8 | 37.7 | 40.1 | **FAIL** | 1964 | 1981 |
| #10 | 582 | C | 36.7 | **5.7** | – | PASS | 1965 | – |
| #11 | 583 | C | 43.6 | **8.9** | – | PASS | 1967 | – |
| #12 | 584 | C | 44.3 | 23.5 | 13.6 | **FAIL** | 1970 | 1982 |
| #13 | 585 | C | 45.6 | 30.8 | 36.3 | **FAIL** | 1971 | 1983 |
| #14 | 586 | D | 4.6 | 4.6 | – | PASS（未在目标集，未重出） | – | – |
| #15 | 587 | C | 34.5 | **6.5** | – | PASS | 1972 | – |
| #16 | 588 | C | 58.5 | **6.6** | – | PASS（含 contain 取景，未受影响） | 1973 | – |
| #17 | 589 | C | 5.2 | 5.2 | – | PASS（未在目标集，未重出） | – | – |
| #18 | 590 | C | 20.1 | **6.1** | – | PASS | 1974 | – |
| #19 | 591 | C | 98.9 | 21.4 | 20.8 | **FAIL** | 1975 | 1984 |
| #20 | 592 | C | 46.9 | **5.7** | – | PASS | 1976 | – |
| #21 | 593 | C | 5.7 | 5.7 | – | PASS（未在目标集，未重出） | – | – |
| #22 | 594 | C | 5.6 | 5.6 | – | PASS（未在目标集，未重出） | – | – |

汇总：17 个目标镜头全部重出并已写入；其中 **10 镜一次通过**（#1/#4/#5/#6/#10/#11/#15/#16/#18/#20），**7 镜不通过**并经**一次**重出（重出提示词 + 重跑视频）后仍不通过。未做第二次重试（质量门上限 1 次）。

原始数据：`baseline/junction-mae.json`、`run1/junction-mae.json`、`run2/junction-mae.json`、`mae-table.json`；拼版 `baseline|run1|run2/junction-vs-video.png`（三张均已开图核对）。

## 2. 目视核对（开图结论）

- `run1/junction-vs-video.png`：10 个通过的镜头左右两帧构图、光照一致（仅轻微色调差）；7 个失败镜头的视频第 0 帧里已经出现**衔接帧里没有的人物**：子婴（#3/#7/#8/#9/#12）、刘邦 + 劝进者（#13）、@函谷关外至武关道 山脊与项羽（#19，衔接帧是空白长卷）。
- `run2/junction-vs-video.png`：重出后的第 0 帧仍是同类"人物提前出现 / 长卷提前过渡"，MAE 未实质改善（#8 13.5→10.5、#12 23.5→13.6 略有下降；#9 37.7→40.1、#13 30.8→36.3 反而上升）。

## 3. 输入核对（排除误判）

| 核对项 | 结果 |
|---|---|
| 提示词生成任务 | 1956（`storyboard_ids` = 17 个目标 id）→ `completed 17/17 failed 0`；实际改写 **恰好 17 镜**，其余 5 镜 `video_prompt` 与 13:01 前逐字节相同（未越界）。 |
| 重出提示词任务 | 1977（7 个失败 id）→ `completed 7/7`，7 镜提示词全部改写。 |
| 衔接帧 caption | 17 镜 `junction_caption` 均已按当前 junction hash 生成（`junction-captions.json`），观测 work 17 条、`call_count=1`、`stage=junction_caption`、config 10 `deepseek-chat`（local）；重出任务 1977 命中 hash 缓存，0 次新视觉调用。 |
| 首段是否复述 caption、无切镜 | 17 镜首段（C）均复述 caption，且不含 `切到/切回/硬切/cut to/カット/컷` 等切镜写法（`prompt-first-segments.json`）；保存校验未被退回。 |
| 引导帧接线（抽样 #1 任务 1957、#19 任务 1975） | ComfyUI `history`：`guideimg0 → guide0 MiniMaxH3AddGuide frame_idx 0`（`guide1` 为中间帧 72/84 帧、`guide2` 为 `-1`）。**上传输入字节 sha256 与衔接帧 PNG 完全一致**（`31beb09…` / `6d16e890…`）。任务 params `firstFrameUrl` = 各自 junction、`junction_slot:"first"`。 |

即：引导帧选择、上传字节、提示词与接线都正确，差异出在 H3 对首帧的重绘。**可定位的直接原因是提示词首段在 0–3s（#7/#19 为 0–1s）内就写了"人物从…走向画外 / 画面由长卷缓缓过渡为山脊"，H3 把这段入场/过渡放在第 0 帧**，于是首帧不再是空镜衔接帧。重出时生成器仍写出同样的结构（7 镜重出首段原文见 `retry-first-segments.txt`），因此同一缺陷复现。

## 4. 生产 ID

| 项 | ID / 值 |
|---|---|
| 视频提示词任务（17 镜） | **1956**（13:02–13:25 UTC，completed 17/17） |
| 视频批次（17 镜，config 8 + `MiniMax-H3-INT8-ComfyUI`） | **batch 25**，任务 **1957–1965, 1967, 1970–1976**，全部 completed（13:27:48–14:37:54，串行，单镜 3.5–5.4 分钟） |
| 重出提示词任务（7 镜） | **1977**（14:39–14:50，completed 7/7） |
| 重试视频批次（7 镜，同一 config/model） | **batch 26**，任务 **1978–1984**，全部 completed（14:51–15:25） |
| `retry-failed` | 未调用：两批都没有引擎失败（batch 25 17/17、batch 26 7/7） |
| 关键帧 | 未重出、未重新确认；22 镜 `keyframes_confirmed=true` 未变 |
| 字幕 | 未调用 `narration/subtitle`：`compose-batch/preview` 显示 22 镜 `inputs.subtitle` 均已有 SRT（`compose-preview-pre.json`），本轮未改旁白/配音，故不 stale |
| 合成 / 导出 / merge | **未提交**（质量门）；本轮没有新 merge id、没有最终 mp4 |

`GET /episodes/21/video-batch/preview` 对两次提交都返回整集 22 镜，提交前已按自己的 id 过滤：batch 25 只含 17 个目标 id、batch 26 只含 7 个失败 id；未把整集 `checked` 原样提交。

## 5. 预算台账

| 类别 | 上限 | 实际 | 说明 |
|---|---:|---:|---|
| 视频 | 34 | **24** | batch 25：17；batch 26：7；无引擎失败重跑 |
| 计费文本调用 | 45 | **≈41** | 1956：17 次改写 agent + 17 次衔接帧描述（`junction_caption`，config 10 vision，已持久化 17 条 work）；1977：7 次改写 agent + 0 次描述（hash 缓存命中）。改写 agent 的分项计数在 `GET /tasks/{id}/observations` 里不落 `task_observed_call`（只有 `junction_caption` 持久化），17/7 由任务逐镜 `progress.completed` 推定。 |
| 图片 | 0 | **0** | – |
| TTS | 0 | **0** | – |

## 6. 停止点与后续选择（未执行，需用户裁决）

质量门要求："不达标镜头只允许重出 1 次；仍不达标则停止、不导出、报告用户"。因此本轮停在 `compose-batch` 之前，未烧字幕、未合成、未导出，ep 21 目前的状态是：视频已全部更新到新版本（17 镜新视频；5 镜沿用旧版），但 7 镜首帧衔接仍然断裂。

可选项（都未执行）：
1. **改提示词规则**：C 首段禁止在 0–N 秒内写人物入场/场景过渡（把入场推到第二段起），再对本轮失败 7 镜重出提示词 + 重跑；这需要 Issue/代码/技能层面的改动，不在本轮授权范围。
2. **让 H3 首帧锁更硬**：把首帧引导强度或零帧强制约束做成工作流参数。
3. **接受 #8/#12 的临界结果并人工裁决**（MAE 10.5 / 13.6，目视仍有明显差别，建议不采用）。
4. 保持现状不导出。

## 7. 证据清单（本目录）

- `requests.jsonl`（117 行：授权 + 全部生产 API 读/写 + 外部 ComfyUI 只读留痕）
- `shots-before.json`、`layer-segments-before.json`、`budgets.json`、`junction-captions.json`
- `video-preview.json`、`video-batch-start.json`、`video-batch-retry-start.json`、`video-tasks-run1.json`、`final-video-urls.json`
- `prompts-after-1956.json` / `.txt`、`prompts-retry-1977.json`、`prompt-first-segments.json`、`fail-first-segments.txt`、`retry-first-segments.txt`
- `observations-prompts.json`（junction_caption 计费证据）
- `mae-table.json`；`baseline/`、`run1/`、`run2/`（各含 `junction-mae.json`、逐帧 PNG、`junction-vs-video.png`，三张拼版已开）
- `compose-preview-pre.json`（22 镜 SRT 就绪、全部 `changed`）
- `sample-final.mjs`（最终成片边界抽帧量具，本轮未用到）

本报告为技术验收记录，不代表人工艺术或史实确认。
