# Issue #106 生产验收：媒体懒加载

- 发布：release `20261115T124941Z`（master `84a283ea`）。升级动作：`backend/scripts/backfill-artwork.ts`，先 dry-run 再正式运行，**只新增旁文件**：
  - 缩略图：images 5、overlays 17、map-drawings 135、map-bases 46、asset-sources/candidates 38、layer-frames 133；
  - 封面：composed 96、layer-segments 310。
  - 3 个 composed 文件失败，它们是 2026-11-03 遗留的 0 字节 mp4（存量坏文件，与本次无关）。
- 页面：`/huobao/drama/20/episode/1?panel=production&tab=final`。生产上只读打开，未写任何业务数据。

| 指标（打开后 20 秒，不含前端代码） | 改前 | 改后 |
|---|---|---|
| 请求总数 | 1436 | 68 |
| mp4 | 376 | 0 |
| 关键帧原图 | 221 张 / 147 MB | 0（缩略图 6 张 41 KB，封面 6 张 26 KB） |
| 配音 audio | 113 | 0 |
| layer-segments 接口 | 339 | 2 |
| tasks?storyboard_id | 226 | 3 |
| narration-fit/preview | 113 | ≤1/已挂载卡 |

- 滚动：一次滚 3 屏、共 12 次，任意时刻只挂载 2–4 张卡（`scroll-mounted.json`）；滚动期间按需加载缩略图 24 张、封面 36 张，没有 mp4（`after-scroll.txt`）。浏览器 errors 为 0，console error 为 0。
- 截图 `01-final-top.png`：首帧、中间帧、尾帧都显示缩略图。

## 隔离副本上验证的写入路径（worktree 库副本，不碰生产）
- 在 #01（sb 931）旁白里输入后不失焦，直接滚出 8 屏：卡**保持挂载**，焦点仍在。
- 失焦后发出 `PUT /storyboards/931`，保存期间卡仍保持挂载；保存返回 200 后才卸载；副本库里 `narration_text` 已带上新增内容。
- deeplink `rehearse=1040`（第 110 镜）：卡被强制挂载并滚入视口，预演弹窗恢复。
- 点击关键帧缩略图打开 1344×768 原图。

## 已知
- 首次挂载时，若任务中心快照晚于卡片到达，`tasks?storyboard_id` 会多请求一次（输入键确实变了）。
- `narration-fit/preview` 冷启动单次约 20 s，会占用浏览器连接；首屏只挂载 2–3 张卡，影响已很小，未在本 Issue 处理。
