# 八达岭长城测试 1008：生产验收记录

- **生产入口**：`http://172.30.3.164/huobao/`
- **项目 / 剧集**：drama **10**「八达岭长城测试 1008」；episode **16**（E01「八达岭长城对明朝防御的作用」）
- **授权边界**：仅本测试项目。记录的用户授权原话：**「走火宝流程把它做出来作为测试，完成后审核」**。本文所有确认均为技术测试默认推进，**不代表用户艺术批准**。
- **项目隔离**：全部业务写入均以 drama 10 / episode 16 为目标；未对 drama 3 或其它既有项目发出业务写入。

## 结果摘要

生产链路已到达 merge/export：merge **27** 完成，媒体 `static/merged/c9bbd119-b086-42a6-8eaf-6ce63ed185fa.mp4`。

浏览器实际打开的最终媒体：**960×544，65.44 s，`readyState=4`**；下载 SHA-256 为 `62cc07d621227d499f6d054b8f01604ac19e11fc7149d0ff14f16fa4a2260fce`。本环境没有 `ffprobe` / `ffmpeg`，因此未伪报 ffprobe 结果；浏览器媒体元数据和实际打开结果是本记录的时长/分辨率依据。

## 预算台账（硬上限 → 实际）

| 类别 | 上限 | 实际 | 任务 |
|---|---:|---:|---|
| 图片 | 16 | **11** | 资产：1226、1230–1233、1245–1246（7）；关键帧：1248–1251（4） |
| 视频 | 2 | **2** | 1254（#01 C）、1255（#04 C） |
| TTS | 8 | **6** | voice batch 1228；#01–#06 各一条 |

所有 GPU 提交前的账本快照都在 `requests.jsonl`（`kind: gpu-ledger`）。没有超预算，也没有失败后追加 GPU 重试。

## 阶段证据与任务

1. **立项 / 原始内容**
   - `POST /dramas` → drama 10；`PUT /dramas/10 {documentary_rules:"on"}`；`POST /episodes` → episode 16。
   - 仅以 `PUT /episodes/16 {content}` 导入固定正文 224 字和故意保留的出处行；读回时 `script_content=null`，证明未夹带 AI 稿。
   - 截图：`01-raw-content.png`。

2. **#80 旁白稿纯净度**
   - 原始草稿 `inspect-narration` 真实返回一项可定位 finding：`资料来源：公有领域历史常识整理；本行为出处说明，不作为朗读稿。`，理由为「不应朗读的出处说明内容」。
   - 生产旧入口 `POST /agent/script_rewriter/chat` 对纪录片返回 400，明确要求分阶段端点；改用 `POST /episodes/16/script-rewrite`，run **3** / task **1212** 完成。
   - `fidelity.v2`：基线 224、输出 224、`adjusted_baseline_chars=224`；prepared-source 报告确实剔除了出处行（raw 256 → prepared 224）。最终当前旁白稿再跑 inspect 的 `findings=[]`，且无「资料来源」。
   - 截图：`02-script-rewrite.png`；精确请求/响应见 `requests.jsonl`。
   - 已按测试授权确认剧本；不是艺术批准。

3. **资产提取 / 审核 / 资产图**
   - 提取任务：1213（角色）、1214（场景）、1215（道具）；资产审核 1216、1224、1225。
   - 初审 22 项中 6 项缺失；逐项补提取 1218–1223 后仍有 302/304 未自动回链。为保留覆盖而非 `ignored`，在本项目创建并映射 scene 90 / prop 166，最终审核 `passed`：22 total、17 have、4 added、1 not_needed、0 missing。
   - 资产图任务：1226、1230–1233、1245–1246；实际打开 scene 85 的 PNG（1920×1088）。
   - 截图：`03-asset-review-blocker.png`（保留失败/门禁证据）、`04-asset-scene85-view.png`。

4. **#81 旁白骨架 / 配音**
   - 骨架 task **1227** 生成 6 镜，覆盖 **241/241**、无 gaps、顺序正确。
   - `validate_only:true` 正常草稿返回 `problems=[]`/`gaps=[]`；故意删去第 2 镜起首「它」的 dry-run 返回精确 gap `{start:42,end:43,chars:1,text:"它",next_index:1}`，未写库。
   - 生产确认后，TTS batch **1228** 6/6 成功。骨架读回 #01–#06 均 `tts.valid=true`，有 `audio_url`、`audio_version` 与真实 `duration_ms`（8800、3840、14400、9920、10240、8800）。6 个 WAV 均已下载；浏览器 UI 显示 6/6 有效与播放入口。
   - 截图：`05-narration-skeleton.png`、`06-design-tts-player.png`；本地 WAV 仅作临时检查，不随 docs 提交。

5. **#82 设计卡**
   - `POST /design-cards/fill` 在 6 个空 combo 的镜头上真实写入 AI 初选：#01 C、#02 D、#03–#06 C；随后因两条视频硬预算，将 #02/#03/#05/#06 切为 A，并因 keyframe-prompt 恢复将 #04 调整为 C。所有变更均先查 combo impact，且在请求日志标注测试授权；AI 首次自动写 combo 的证据仍完整保留。
   - audit 真实返回每镜 `tts.duration_ms`，UI 显示「实测 8.8s」而非 0.0；`unresolved_layers` 给出资产 ID/名称/语义列表（例如 asset 161「八达岭区位示意图」、`available_semantics=[]`），并且 `issues[].message` 直接给出「没有指定……上的语义项」。未虚构语义名。
   - 截图：`07-design-card-combo-duration-errors.png`。

6. **图层、关键帧、视频**
   - 首次图层 draft 均返回 `missing_base`，保留为真实失败证据；为不伪造地图语义，按设计卡先生成实际 base 图，再重 draft/render。图层渲染 1234–1239，重渲时长对齐 1256–1259。
   - 关键帧 prompt 初次任务 1240 在 #01 成功、#02 失败；仅重试失败 #02（1241 及一次 cloud fallback）仍失败，未耗 GPU。将 #02 回退 A 并以 #04 C 保留第二生成段；#04 prompt 随后成功。关键帧 1248–1251 均完成，#01 / #04 关键帧已在确认之后才提交视频。
   - 视频 preview 只选 #01 / #04；视频 1254/1255 完成。浏览器实际打开 raw 结果：#01 **960×544 / 6.583333 s**，#04 **960×544 / 7.291688 s**。
   - 截图：`08-video-511.png`、`08-video-514.png`、`10-keyframes-production.png`。

7. **合成 / 导出**
   - 6 镜 compose preview 全部 `missing → checked`，compose batch 6 completed / 0 failed / 0 skipped；读回均 `status=unchanged` 且 `exportable=true`。
   - 生产部署的 merge router 实际挂载为 `/api/v1/merge/episodes/:id/merge`（而非目录所写的 `/episodes/:id/merge`）；使用显式 IDs `[511,512,513,514,515,516]` 创建 merge **27**，`status=completed`、`skipped=[]`。
   - 截图：`09-final-export.png`；真实文件路径和 SHA-256 见上。

## 失败 / 偏差（未隐瞒）

- API 目录中纪录片改写入口与生产不符：旧 agent 路径被生产明确拒绝，分阶段 rewrite 路径成功完成；该错误响应保留在请求日志。
- API 目录的 merge 路径也与生产 router mount 不符：文档路径得到 200 + HTML SPA，实际 `/merge/episodes/:id/merge(s)` 成功。该非 JSON 响应与后续正确调用均已留痕。
- #02 的 keyframe prompt 在 GLM、DeepSeek local、DeepSeek cloud 三种已配置模型下失败；未重复跑已成功镜或消耗额外 GPU。通过授权的 combo impact 将 #02 改为确定性 A，并由 #04 C 维持第二条生成视频。
- `ffprobe` 和 `ffmpeg` 在本运行环境中不存在（命令返回 127/1）；媒体没有声称通过 ffprobe。浏览器已实际解码打开每个 raw 和最终 MP4。
- 本仓库无本地生产 SQLite 文件；为避免违反生产 DB/SSH 边界，没有直接连接生产数据库。生产 API 的 drama/episode/storyboard/task/merge 读回状态及媒体路径已完整记录。

## 主 agent 复核（2026-11-08）

本节更正第 72 行：**「本仓库无本地生产 SQLite 文件」不准确**，`backend/data/huobao.sqlite3` 存在且可只读访问。主 agent 已完成以下只读复核：

- 只读 DB（`backend/data/huobao.sqlite3`，仅 SELECT）：`video_merges` id **27** → `episode_id` 16 / `drama_id` 10 / `status` completed / `merged_url` `static/merged/c9bbd119-b086-42a6-8eaf-6ce63ed185fa.mp4` / `duration` 65；episode 16 存活 `storyboards` **6**。
- `GET /episodes/16/narration-skeleton`：`confirmed=true`、6 镜、TTS 6/6，前两镜含 `audio_url`/`audio_version`/`duration_ms` 8800、3840。
- 最终媒体 HTTP 复核：**200**，`Content-Type: video/mp4`，`Content-Length: 4900463`。
- 配音页实测 **6 个 `<audio>` 元素**（截图 `11-voice-player-verify.png`）。

## 审核所需

请用户审核最终成片的史实、画面和声音审美；技术验收只证明链路、预算、可读取媒体和签名/状态就绪，不构成艺术批准。

- 审核链接：`http://172.30.3.164/huobao/drama/10/episode/1?panel=export`
- 最终媒体：`http://172.30.3.164/huobao/static/merged/c9bbd119-b086-42a6-8eaf-6ce63ed185fa.mp4`
- 完整 API 审计：`requests.jsonl`
