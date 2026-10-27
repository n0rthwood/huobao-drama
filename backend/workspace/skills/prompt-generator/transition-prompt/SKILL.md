---
name: transition-prompt
description: 转场提示词规范 — 承接分镜的转场审核、32 个手法目录与模板、机械化选择规则、同场景动作衔接专项
---

# 转场提示词（承接分镜 → transition_prompt）

## 0. 总则

**什么是这里的转场**：承接分镜（`inherits_first=true`）的视频第 0 帧 = 上一分镜选定的尾帧图片。「转场」= 视频开头 **0–T 秒**内，把这张尾帧画面**在镜头内连续地**带到本镜开场画面的影像事件。单段生成的视频模型没有剪辑台，因此一切手法必须写成：

1. **可拍摄的连续事件**：运镜（甩/推/拉/跟/转）、物理遮挡、被摄体动作、光线变化、焦点变化、速度变化；或
2. **模型可模拟的光学效果**：叠化、经黑/白淡变、闪白、柔焦涟漪。

纯剪辑语汇（match cut、jump cut、蒙太奇）是**次选**，目录中已全部改写为镜头内可执行的描述。转场内允许的切镜（特写插入、空镜插入、跳切类）必须先保持首帧画面至少 0.5 秒。

**三种审核结论（verdict）**：
- `scene_time`：时间（时段、昼夜、跨天及以上；分钟级标注但光线/环境已有可见变化的，同样算时间变化）、地点、季节、跨年、叙事（回忆/梦境）或情绪基调发生变化 → 必须转场；
- `continuity`：时空视作未变（同一地点，时间标注差 ≤ 约30分钟，且光线与环境描述无可见差异），但上一镜结尾与本镜开场之间存在动作/道具/姿态等状态残留 → 写衔接转场；
- `none`：状态完全一致 → 不写转场（`transition_prompt` 为空字符串）。

**时长规则摘要**：T 为转场秒数（`scene_time` 默认 3.0；`continuity` 按动作量 1.0–3.0）。提交时长 = `min(分镜时长 + T, 15)`；实际加长 E = 提交时长 − 分镜时长；中间帧引导时间 = `mid_frame_time + E`，且必须 ≥ T + 0.5 秒（校验与缩减公式见第 3.5 节）。目录中 `is_fast=true` 的手法可在 1–1.5 秒内完成，供 T 被压缩时使用。

**拼接格式（系统负责，不要写进 transition_prompt）**：最终提示词 = 项目风格词 + `开场转场（0–T 秒）：<transition_prompt>` + `随后（自 T 秒起，下列描述的时间整体后移 E 秒）：<video_prompt>`。因此 `transition_prompt` 本身**不带前缀、只写 0–T 秒的事**，结尾落点必须等于本镜开场画面，不得提前演掉本镜内容，不得与本镜 `video_prompt` 第一段矛盾。

**一致性**：本文件第 2、3 节与同目录 `catalog.json` 逐条一致；代码只认 `catalog.json` 里的 `technique_id`。修订时两处必须同步。

## 1. 槽位定义

模板中的 `{…}` 槽位由运行时 LLM 用上下文填写。中英文模板槽位对应如下（模板内出现而未列出的槽位按字面含义填写；没有合适素材时**换手法**，不要编造）：

| 中文槽位 | 英文槽位 | 填法 |
|---|---|---|
| {上一镜结尾画面} | {PREV_END} | 从上一镜 `last_frame_prompt` 提炼 1–2 句：空间与光线（非本镜绑定资产用普通文字）、{@角色} 的位置姿态、**每只爪/手的持物状态** |
| {本镜开场画面} | {THIS_START} | 从本镜 `video_prompt` 第一段（没有则 description【镜头1】开场）提炼 1–2 句；**必须包含 @场景名 与出场 @角色名**、位置姿态、手部状态；左右未写明时保持「一只/另一只」的原有指代，不得自行指定左右 |
| {@角色} | {@CHARACTER} | 本镜绑定的角色引用，名字与列表完全一致 |
| {T} | {T} | 转场秒数（一位小数） |
| {方向} | {DIRECTION} | 甩/摇/移动方向（左/右/上/下） |
| {遮挡物} | {OCCLUDER} | 可信前景：叶影、身影、门框边、爪掌等 |
| {穿越锚点} | {ANCHOR} | 门窗、灯光、暗部、纹理等可推入的对象 |
| {光源动机} | {LIGHT_SOURCE} | 闪白的光来源（阳光、台灯、车灯…） |
| {光线轨迹} | {LIGHT_PATH} | 延时光线的变化路径 |
| {旧光线}/{新光线} | {OLD_LIGHT}/{NEW_LIGHT} | 两镜的光线描述 |
| {本镜环境声} | {NEXT_AMBIENCE} | 下一场景的环境声（只写声音，不写台词） |
| {节拍音} | {BEAT_SOUND} | 卡点音效（指响、鼓点、清脆一响） |
| {旧道具}/{新道具} | {OLD_PROP}/{NEW_PROP} | 残留道具 / 本镜需要的道具；绑定了才可 @，否则用文字 |
| {放置位置}/{使用位置}/{原位置}/{支撑物}/{目标位置} | {PLACE}/{USE_POS}/{FROM_POS}/{SUPPORT}/{TARGET_POS} | 道具与肢体的空间锚点；{放置位置}优先取本镜开场画面已写明之处，否则须选不与本镜开场画面冲突的位置（出画、画面边缘或遮挡处），确保第 T 秒画面内无本镜开场没有的残留道具 |
| {本镜朝向}/{本镜注视方向}/{注视对象} | {ORIENTATION}/{GAZE_DIR}/{GAZE_TARGET} | 身体朝向、视线目标 |
| {匹配物A}/{匹配物B} | {MATCH_A}/{MATCH_B} | 形状匹配的两个锚点物 |
| {衔接动作}/{收尾动作} | {BRIDGE_ACTION} | 匹配/提速的具体动作（逐爪写明） |
| {计时物}/{旧时刻}/{新时刻} | {TIME_PROP}/{OLD_TIME}/{NEW_TIME} | 时钟/日历手法专用 |
| {片段1..3}/{时间跨度或过程} | {VIGNETTE_1..3}/{SPAN_OR_PROCESS} | 微蒙太奇专用 |
| {环境季节变化描述} | {SEASON_SHIFT} | 季节更替专用 |
| {静物} | {STILL_OBJECT} | 插入空镜的对象（须属于本镜场景） |
| {A物/B物} | {SUBJECT_A}/{SUBJECT_B} | 焦点转移的两个层次 |
| {门口或过道} | {DOORWAY_OR_PASSAGE} | 一镜穿越的路径 |

## 2. 手法目录（32 条，与 catalog.json 逐条一致）

> 每条格式：`technique_id ｜ 中文名 / English ｜ 类别 ｜ 秒数范围 ｜ 快速 ｜ 可执行性(H3/MiniMax)`。「快速」= `is_fast=true`，可在 1–1.5 秒完成。

### 2.1 短视频常用（short_video）

#### whip_pan ｜ 甩镜转场 / Whip Pan ｜ 短视频常用 ｜ 1.0–2.0s ｜ 快速 ｜ 高/高
- 适用：分钟～跨天的时间跨度；任意地点变化（含不变）；节奏明快、情绪昂扬；T 被压缩时的快速首选之一（运动模糊天然掩盖空间切换）。
- 不适用：沉静、哀伤、需要凝视的慢节奏段落；连续多镜已使用（避免晕眩与套路感）。
- 模板（中）：画面从{上一镜结尾画面}开始保持约0.5秒；镜头向{方向}猛然甩动，强烈的方向性运动模糊覆盖整个画面、原有空间信息被完全抹去；甩动减速、模糊散去，画面落定为{本镜开场画面}；第{T}秒镜头完全静止。
- Template (EN): [0-{T}s] Open exactly on <Picture 1>: {PREV_END}. Hold about 0.5s, then the camera whips {DIRECTION} at high speed; heavy directional motion blur floods the frame and erases all spatial detail. The whip decelerates, the blur clears, and the frame settles on {THIS_START}; the camera is fully static by {T} seconds.
- 示例（#2→#3）：画面从明亮的上午阳台开始：@基尼 稳稳站在瑜伽垫中央、一条小爪贴在腿侧保持树式，保持约0.5秒；镜头向右猛然甩动，强烈运动模糊抹去阳台的栏杆与绿植；甩动减速、模糊散去，画面落定为 @书房 夜晚——暖黄台灯光晕笼罩小书桌，@基尼 坐在桌前、两只前爪搭在摊开书本两侧；第2秒镜头完全静止。

#### occlusion_wipe ｜ 遮挡转场 / Occlusion Wipe ｜ 短视频常用 ｜ 1.5–3.0s ｜ — ｜ 高/高
- 适用：分钟～跨天；任意地点变化（含不变）；画面可安排可信前景（叶影、身影、家具边沿）贴镜掠过时；全遮挡瞬间天然掩盖任何状态切换，也是连续性残留的强力退路。
- 不适用：画面中找不到可信的前景遮挡物且角色不移动。
- 模板（中）：画面从{上一镜结尾画面}开始保持约0.5秒；{遮挡物}从{方向}进入并贴着镜头快速掠过，瞬间占满整个画面形成完全遮挡；遮挡物移出画面的同时，露出的画面已是{本镜开场画面}；第{T}秒遮挡物完全出画、镜头稳定。
- Template (EN): [0-{T}s] Open on <Picture 1>: {PREV_END}. After about 0.5s, {OCCLUDER} enters from {DIRECTION} and sweeps right past the lens, filling the frame completely for an instant; as it clears, the revealed frame is already {THIS_START}; the occluder fully exits and the camera steadies by {T} seconds.
- 示例（#2→#3）：画面从明亮的上午阳台开始：@基尼 树式站稳在瑜伽垫上，保持约0.5秒；一片深绿色的盆栽叶影从左侧贴着镜头快速掠过、瞬间占满画面；叶影右移出画时，露出的画面已是 @书房 夜晚——暖黄台灯光晕笼罩小书桌，@基尼 坐在桌前、两只前爪搭在摊开书本两侧；第3秒叶影完全出画、镜头稳定。

#### zoom_through ｜ 推拉穿越 / Zoom Through ｜ 短视频常用 ｜ 2.0–3.0s ｜ — ｜ 中/中
- 适用：小时～跨天；相邻/远距离/室内外地点变化；画面中有门窗、灯光、暗部、纹理等可作穿越锚点。
- 不适用：T < 2 秒；没有任何穿越锚点。
- 模板（中）：画面从{上一镜结尾画面}开始；镜头加速推近{穿越锚点}，其明暗或纹理迅速放大占满整个画面形成全遮蔽；随即镜头从同样的明暗或纹理中拉出，画面已是{本镜开场画面}；第{T}秒拉出完成、机位稳定。
- Template (EN): [0-{T}s] Open on <Picture 1>: {PREV_END}. The camera accelerates and pushes in toward {ANCHOR} until its light or texture fills the whole frame; the camera then pulls back out of that same fill, and the frame is now {THIS_START}; the pull-out completes and the camera locks by {T} seconds.
- 示例（#2→#3）：画面从上午阳台开始：@基尼 树式站稳在瑜伽垫上；镜头加速推近她身后被阳光照亮的白墙亮部，暖白亮光放大占满整个画面；随即镜头从一团暖黄光晕中拉出——那是 @书房 的台灯，夜色中光晕笼罩小书桌，@基尼 坐在桌前、两只前爪搭在摊开书本两侧；第3秒拉出完成、机位稳定。

#### roll_spin ｜ 旋转转场 / Roll Spin ｜ 短视频常用 ｜ 1.5–3.0s ｜ — ｜ 中/中
- 适用：分钟～昼夜；任意地点变化（含不变）；兴奋、眩晕、天旋地转或翻转感的段落。
- 不适用：沉静庄重段落；T < 1.5 秒；对画面稳定要求高的镜头（旋转易产生畸变）。
- 模板（中）：画面从{上一镜结尾画面}开始保持约0.5秒；镜头沿视轴快速旋转，环形运动模糊搅散空间细节；旋转减速回正时，画面已是{本镜开场画面}；第{T}秒画面水平回正、完全稳定。
- Template (EN): [0-{T}s] Open on <Picture 1>: {PREV_END}. Hold about 0.5s, then the camera rolls rapidly around the lens axis; circular motion blur churns away spatial detail. As the roll decelerates back to level, the frame is now {THIS_START}; the horizon settles and locks by {T} seconds.
- 示例（#2→#3）：画面从明亮的上午阳台开始：@基尼 树式站稳，保持约0.5秒；镜头顺时针快速旋转，环形模糊搅散阳台的光影；旋转减速回正时，画面已是 @书房 夜晚——暖黄台灯下 @基尼 坐在桌前、两只前爪搭在摊开书本两侧；第2.5秒画面回正稳定。

#### motion_follow ｜ 跟随动作转场 / Follow-Motion Transition ｜ 短视频常用 ｜ 2.0–3.0s ｜ — ｜ 高/中
- 适用：时间不变～小时级；**相邻空间**且人物可在两镜之间自然走动到达；镜头跟随 + 沿途前景掠过完成换景。
- 不适用：远距离或跨城（走不过去）；跨昼夜且无灯光渐变动机；人物不移动。
- 模板（中）：画面从{上一镜结尾画面}开始；{@角色}转身起步朝{方向}移动（写明先迈哪只爪或脚、身体如何转向），镜头跟随，沿途{遮挡物}贴着镜头短暂掠过并遮挡画面；{@角色}走入新位置停稳时，镜头随之停稳，画面为{本镜开场画面}；第{T}秒动作与镜头同时落定。
- Template (EN): [0-{T}s] Open on <Picture 1>: {PREV_END}. {@CHARACTER} turns and sets off {DIRECTION} (state which paw or foot moves first and how the body turns); the camera tracks the move while a foreground {OCCLUDER} briefly wipes the lens along the way; as {@CHARACTER} arrives and settles, the camera locks onto {THIS_START} by {T} seconds.
- 示例（假设 #2 → 相邻客厅、同为上午的新镜）：画面从明亮的上午阳台开始：@基尼 收起树式、四爪落地，右前爪先迈、身体转向左侧门口小跑，镜头跟随，门框边沿贴着镜头短暂掠过遮挡画面；@基尼 跑进 @客厅 在地毯中央停住坐定；第3秒动作与镜头同时落定。

#### object_to_lens ｜ 贴镜遮挡转场 / Object-to-Lens Wipe ｜ 短视频常用 ｜ 1.5–2.5s ｜ — ｜ 高/高
- 适用：分钟～昼夜；任意地点变化（含不变）；俏皮、角色主动感强的段落；爪掌或物件盖满镜头的一刻完成切换。
- 不适用：严肃沉重戏份；角色距镜头过远且无靠近动机。
- 模板（中）：画面从{上一镜结尾画面}开始；{@角色}抬起一只前爪或手伸向镜头（写明另一只爪或手保持的持物与位置），掌面逐渐贴近直至完全盖住镜头、画面被遮黑；掌面移开的瞬间，画面已是{本镜开场画面}；第{T}秒掌面完全出画、镜头稳定。
- Template (EN): [0-{T}s] Open on <Picture 1>: {PREV_END}. {@CHARACTER} raises one forepaw or hand toward the lens (state what the other paw or hand is holding and where it stays); the pad closes in until it fully covers the lens and the frame goes dark. The instant it withdraws, the frame is {THIS_START}; fully clear and steady by {T} seconds.
- 示例（#2→#3）：画面从上午阳台开始：@基尼 放下贴在腿侧的小爪、四爪站稳后，抬起右前爪伸向镜头（左前爪撑在垫上稳住身体），粉色掌面逐渐盖满镜头、画面全暗；掌面移开的瞬间已是 @书房 夜晚——@基尼 坐在暖黄台灯下的书桌前，两只前爪搭在摊开书本两侧；第2.5秒掌面完全出画、镜头稳定。

#### light_flash ｜ 闪白光效转场 / Light Flash ｜ 短视频常用 ｜ 1.0–1.5s ｜ 快速 ｜ 高/高
- 适用：分钟～跨年的任意时间跨度；任意地点变化（含不变）；万能快速手法——过曝瞬间同时抹掉空间与道具残留；T 被压缩到 1–1.5 秒时的首选。
- 不适用：压抑、恐怖等需要暗化的氛围（改用 fade_black）；连续多镜重复使用（闪烁疲劳）。
- 模板（中）：画面从{上一镜结尾画面}开始；{光源动机}的亮度迅速增强，整个画面在约0.3秒内过曝成纯白；白光立即回落，显现{本镜开场画面}；第{T}秒曝光恢复正常、镜头稳定。
- Template (EN): [0-{T}s] Open on <Picture 1>: {PREV_END}. The brightness of {LIGHT_SOURCE} swells rapidly until the frame overexposes to pure white within about 0.3s; the white immediately falls away to reveal {THIS_START}; exposure normalizes and the camera is steady by {T} seconds.
- 示例（#2→#3，T 被压缩时的快速替代）：画面从明亮的上午阳台开始：@基尼 树式站稳；阳光亮度迅速增强，画面在0.3秒内过曝成纯白；白光回落，显现 @书房 夜晚——暖黄台灯光晕下 @基尼 坐在桌前、两只前爪搭在摊开书本两侧；第1.2秒曝光恢复、镜头稳定。

#### speed_ramp ｜ 变速转场 / Speed Ramp ｜ 短视频常用 ｜ 2.0–3.0s ｜ — ｜ 中/中
- 适用：分钟～小时级；同一或相邻空间；上一镜结尾带动作时的提速衔接；也可把放下、拿起等衔接动作提速完成，兼具动感。
- 不适用：上一镜结尾与本镜开场都完全静止（无速度可变）。
- 模板（中）：画面从{上一镜结尾画面}开始；{@角色}正在进行的{收尾动作}骤然加速（写明双爪或双手分别在做什么），动作带起明显运动模糊；在模糊顶点动作骤停，画面瞬间清晰定格为{本镜开场画面}；第{T}秒速度恢复正常、画面稳定。
- Template (EN): [0-{T}s] Open on <Picture 1>: {PREV_END}. The action {@CHARACTER} is finishing suddenly accelerates (state what each paw or hand does), dragging heavy motion blur; at the blur peak the motion snaps to a stop and the frame locks sharp on {THIS_START}; speed returns to normal and the frame is steady by {T} seconds.
- 示例（#1→#2 的动感替代写法）：画面从清晨的 @阳台 开始：@基尼 双爪各握一只迷你哑铃举在胸前；她放哑铃的动作骤然加速——右爪、左爪先后把哑铃放到垫边，动作带起运动模糊；模糊顶点骤停，画面瞬间清晰：@基尼 已空爪蹲踞在瑜伽垫中央、准备缓缓站起；第3秒速度恢复正常、画面稳定。

#### beat_snap ｜ 卡点骤变转场 / Beat-Synced Snap ｜ 短视频常用 ｜ 1.0–2.0s ｜ 快速 ｜ 中/中
- 适用：小时～季节跨度；任意地点变化（含不变）；音乐感、爽感段落：主体留在画面同一区域，环境、光线与姿态随一声节拍骤然切换。
- 不适用：更换角色服装或外形（以图片为准，禁止描写）；柔和抒情段落。
- 模板（中）：画面从{上一镜结尾画面}开始，{@角色}保持姿态约0.5秒；随着一声清脆的{节拍音}（音效），画面在两三帧内骤变为{本镜开场画面}——机位与景别尽量不变，{@角色}仍在画面同一区域，但环境、光线与其姿态已切换到位；第{T}秒骤变完成、画面稳定。
- Template (EN): [0-{T}s] Open on <Picture 1>: {PREV_END}; {@CHARACTER} holds the pose for about 0.5s. On a crisp {BEAT_SOUND} (sound effect), the frame snaps within 2-3 frames to {THIS_START} — camera and framing stay as close as possible, {@CHARACTER} remains in the same screen region, while environment, light and pose have switched; the snap completes and holds by {T} seconds.
- 示例（#2→#3）：画面从明亮的上午阳台开始：@基尼 树式站稳保持约0.5秒；随着一声清脆的指响般节拍音，画面在两三帧内骤变——机位景别不变，环境已成 @书房 夜晚：暖黄台灯光晕代替阳光，@基尼 已坐在书桌前、两只前爪搭在摊开书本两侧；第1.5秒骤变完成、画面稳定。

### 2.2 电影艺术（cinematic）

#### dissolve ｜ 叠化 / Cross Dissolve ｜ 电影艺术 ｜ 2.0–3.0s ｜ — ｜ 高/中
- 适用：小时～跨年；任意地点变化（含不变）；抒情、时间流逝、空间更换皆可；最通用的电影转场兜底。
- 不适用：需要强节奏冲击的爽点；T < 2 秒。
- 模板（中）：画面从{上一镜结尾画面}开始并渐渐变得透明，同时{本镜开场画面}在同一画框中逐渐浮现，两层影像在中段短暂重叠相融；旧画面完全隐去、新画面清晰稳定，叠化在第{T}秒完成。
- Template (EN): [0-{T}s] Open on <Picture 1>: {PREV_END}. The image gradually turns translucent while {THIS_START} fades up within the same frame; the two images briefly overlap mid-way, then the old image vanishes and the new one holds sharp and steady; the dissolve completes by {T} seconds.
- 示例（#2→#3）：画面从明亮的上午阳台开始：@基尼 树式站稳在瑜伽垫上；画面渐渐变得透明，@书房 夜晚的影像在同一画框中浮现——暖黄台灯光晕笼罩小书桌，@基尼 坐在桌前、两只前爪搭在摊开书本两侧；两层影像短暂相融后旧画面完全隐去；第3秒叠化完成、画面清晰稳定。

#### fade_black ｜ 经黑渐隐渐显 / Fade Through Black ｜ 电影艺术 ｜ 2.0–3.0s ｜ — ｜ 高/高
- 适用：昼夜～跨年；任意地点变化（含不变）；进入夜晚或较暗场景、较大时间跨度、章节感收束的首选；黑场天然抹除一切残留。
- 不适用：两头都是高调明亮且节奏要快；T < 2 秒。
- 模板（中）：画面从{上一镜结尾画面}开始，整体亮度平滑下落，在转场前半段沉入全黑；黑场中{本镜环境声}先行进入；后半段画面从黑中缓缓亮起，显现{本镜开场画面}；第{T}秒曝光恢复正常并稳定。
- Template (EN): [0-{T}s] Open on <Picture 1>: {PREV_END}. Brightness falls smoothly, sinking to full black in the first half of the transition; in the black, {NEXT_AMBIENCE} enters first; the image then fades up from black into {THIS_START}, reaching normal exposure and locking by {T} seconds.
- 示例（#2→#3，范例答案）：画面从明亮的上午阳台开始：@基尼 树式站稳、眼神亮晶晶；画面整体亮度平滑下落，约1.5秒沉入全黑；黑场中先响起夜晚室内安静的底噪与轻微纸页声；画面从黑中缓缓亮起——@书房 夜晚，暖黄台灯光晕笼罩小书桌，@基尼 坐在桌前、两只前爪搭在摊开书本两侧；第3秒曝光恢复正常并稳定。

#### fade_white ｜ 经白渐隐渐显 / Fade Through White ｜ 电影艺术 ｜ 2.0–3.0s ｜ — ｜ 高/高
- 适用：小时～跨天；任意地点变化（含不变）；柔和抒情、回忆梦境入口、明亮场景之间的时间跳跃。
- 不适用：进入黑暗场景（反差突兀）；惊悚压抑氛围。
- 模板（中）：画面从{上一镜结尾画面}开始，被柔和的白光渐渐充满，在转场前半段完全化为柔白；后半段白色缓缓退去，显现{本镜开场画面}；第{T}秒曝光恢复正常、画面稳定。
- Template (EN): [0-{T}s] Open on <Picture 1>: {PREV_END}. A soft white glow gradually floods the frame, turning it fully white in the first half; the white then recedes to reveal {THIS_START}; exposure normalizes and the frame steadies by {T} seconds.
- 示例（假设 #4 → 次日清晨回到阳台的新镜）：画面从夜晚书房的暖黄灯下开始：@基尼 右爪握笔、左爪按纸写完最后一行；画面被柔白渐渐充满、约1.5秒完全化为柔白；白色退去时已是次日清晨的 @阳台——@基尼 空着双爪站在训练垫旁的晨光里；第3秒曝光恢复、画面稳定。

#### match_cut ｜ 形状匹配转场 / Shape Match Cut ｜ 电影艺术 ｜ 2.0–3.0s ｜ — ｜ 中/低
- 适用：小时～跨年；任意地点变化；两镜存在形状、颜色或构图相近的锚点物（圆形光斑↔台灯光晕等）；剪辑语汇次选，已改写为镜头内形变。
- 不适用：两镜找不到可信的形状或颜色匹配物；节奏急促段落。
- 模板（中）：画面从{上一镜结尾画面}开始；镜头缓缓推近画面中的{匹配物A}，使其形状占据画面中心；该形状保持在画面同一位置，其颜色、质感与周围环境渐变融合，化为{匹配物B}；镜头再缓缓拉开，露出{本镜开场画面}；第{T}秒拉开完成、画面稳定。
- Template (EN): [0-{T}s] Open on <Picture 1>: {PREV_END}. The camera slowly pushes in on {MATCH_A} until its shape holds the center of frame; keeping that shape in place, its color, texture and surroundings gradually morph into {MATCH_B}; the camera then pulls back to reveal {THIS_START}; the pull-back completes and steadies by {T} seconds.
- 示例（#2→#3）：画面从明亮的上午阳台开始：@基尼 树式站稳；镜头缓缓推近她身旁地面上一块圆形的明亮光斑，光斑占据画面中心；圆形保持原位，色温由亮白渐变为暖黄、四周随之暗成夜色——它化为 @书房 的台灯光晕；镜头缓缓拉开，露出 @基尼 坐在书桌前、两只前爪搭在摊开书本两侧的画面；第3秒拉开完成、画面稳定。

#### match_on_action ｜ 动作匹配转场 / Match on Action ｜ 电影艺术 ｜ 1.5–3.0s ｜ — ｜ 中/中
- 适用：时间不变～昼夜；任意地点变化；上一镜结尾动作与本镜开场动作同类或同方向、同一人物；动作不断，环境在动作中途切换；也可用于仅动作变化的连续性衔接。
- 不适用：两头动作方向冲突且无法改写为同向；人物不同。
- 模板（中）：画面从{上一镜结尾画面}开始；{@角色}开始做{衔接动作}（写明发力的爪或手与另一只的位置），动作进行到一半时，周围环境与光线以快速叠化换为本镜环境，而{@角色}的动作不中断地顺势完成，落点即{本镜开场画面}；第{T}秒动作完成、画面稳定。
- Template (EN): [0-{T}s] Open on <Picture 1>: {PREV_END}. {@CHARACTER} begins {BRIDGE_ACTION} (state the acting paw or hand and where the other stays); halfway through the motion, the surrounding environment and light cross-dissolve into the new scene while the motion continues unbroken, landing exactly on {THIS_START}; the action completes and the frame steadies by {T} seconds.
- 示例（#2→#3）：画面从明亮的上午阳台开始：@基尼 树式站稳后放下贴腿的小爪，身体前倾准备坐下（右前爪先撑向身前地面）；下坐动作进行到一半时，周围环境快速叠化为 @书房 夜晚的暖黄灯光与书桌；@基尼 顺势坐定在桌前，两只前爪自然落在摊开书本两侧；第3秒动作完成、画面稳定。

#### jump_cut_lapse ｜ 跳切时间流逝 / Jump-Cut Time Lapse ｜ 电影艺术 ｜ 2.0–3.0s ｜ — ｜ 中/低
- 适用：小时～跨天；**仅同一空间**；同机位时间流逝（重复劳作、等待）；剪辑语汇次选，以镜头内两次干脆跳变实现。
- 不适用：跨场景；T < 2 秒。
- 模板（中）：画面从{上一镜结尾画面}开始保持约0.5秒；保持机位与构图完全不变，画面连续发生两次干脆的轻微跳切，每次跳切{@角色}的姿态与环境细节（光线角度、道具位置）都明显推进一步，表现时间悄然流逝；第二次跳切后画面即为{本镜开场画面}，保持静止到第{T}秒。
- Template (EN): [0-{T}s] Open on <Picture 1>: {PREV_END}; hold about 0.5s. With camera and framing locked, the frame makes two crisp micro jump cuts; at each jump, the pose of {@CHARACTER} and the environment details (light angle, prop positions) advance a visible step, showing time quietly passing; after the second jump the frame is {THIS_START}, holding still until {T} seconds.
- 示例（#3→#4）：画面从 @书房 夜晚开始：@基尼 两只前爪按在摊开书本两侧低头阅读，保持约0.5秒；机位构图不变，连续两次轻微跳切——第一次跳切后书页已翻过大半、她的头更低；第二次跳切后笔记本已摊到身前，@基尼 右爪握住铅笔、左爪轻按纸页，笔尖落在纸上；保持静止到第2.5秒。

#### timelapse_light ｜ 光影流转 / Timelapse Light Sweep ｜ 电影艺术 ｜ 2.0–3.0s ｜ — ｜ 高/高
- 适用：小时～昼夜；**仅同一空间**；同一空间内时间跳跃的首选：延时速度的光线流转最自然，人物以轻微虚化快动作换位。
- 不适用：跨空间；时间几乎不变。
- 模板（中）：画面从{上一镜结尾画面}开始；机位保持不变，光线以延时摄影的速度流转：{光线轨迹}；{@角色}在光影流转中以轻微虚化的快动作过渡到本镜的位置与姿态（写明双爪或双手的最终状态；两镜道具或垫面、摆设有增减不同时，由{@角色}在这段快动作内完成放下、收走、带出画外或铺设就位——旧道具收至{放置位置}（出画或不与本镜开场画面冲突处），不得写成物体自行变形、凭空出现或消失）；光线定格为{新光线}时，画面即{本镜开场画面}；第{T}秒光线与人物同时稳定。
- Template (EN): [0-{T}s] Open on <Picture 1>: {PREV_END}. With the camera locked, light sweeps at timelapse speed: {LIGHT_PATH}; within the moving light, {@CHARACTER} shifts in softly blurred fast-motion to this shot's position and pose (state the final state of both paws or hands; if props, mats or dressing differ between the two shots, {@CHARACTER} puts down, stows, carries out of frame or lays out those items within this same fast-motion — old props end at {PLACE}, out of frame or somewhere not contradicting this shot's opening; never write objects morphing, appearing or vanishing on their own); as the light settles into {NEW_LIGHT}, the frame is {THIS_START}; light and character lock together by {T} seconds.
- 示例（#1→#2，表现「短时间流逝」的备选答案）：画面从清晨的 @阳台 开始：@基尼 双爪各握一只迷你哑铃举在胸前；机位不变，阳光以延时速度流转——光斑沿地面横移、影子变短、光色由清晨金黄转为上午亮白；光影流转间 @基尼 以轻微虚化的快动作完成收整——先后把两只哑铃提到画面边缘的栏杆绿植脚下放稳、近乎出画，把训练垫卷起带出画外、从画面边缘取回瑜伽垫铺开在中央；光线定格为上午的明亮阳光时，@基尼 已站上瑜伽垫中央、一条小爪抬起贴向腿侧、树式刚摆出一半，另一只前爪自然垂在体侧；第3秒光线与人物同时稳定。

#### clock_calendar ｜ 时钟日历指示 / Clock or Calendar Insert ｜ 电影艺术 ｜ 2.0–3.0s ｜ — ｜ 中/低
- 适用：小时～跨天；**仅同一空间**；场景参考图或绑定道具中确实存在时钟、日历、屏幕等计时物时，用其快速变化明示时间跳跃。
- 不适用：场景参考图与绑定道具中不存在计时物（禁止凭空发明，以图片为准）；跨场景。
- 模板（中）：画面从{上一镜结尾画面}开始保持约0.5秒；镜头切入场景中{计时物}的特写（必须是场景参考图或绑定道具中已存在的物件），其指针、页面或数字以可见的快速变化从{旧时刻}走到{新时刻}，周围光线随之同步改变；切回原景别时画面已是{本镜开场画面}；第{T}秒稳定。
- Template (EN): [0-{T}s] Open on <Picture 1>: {PREV_END}; hold about 0.5s. Cut in to a close-up of {TIME_PROP} in the scene (it must already exist in the scene reference or bound props); its hands, page or digits visibly race from {OLD_TIME} to {NEW_TIME} while the ambient light shifts in sync; cutting back, the frame is {THIS_START}; steady by {T} seconds.
- 示例（#3→#4，假设 @书房 场景图中有一座小闹钟）：画面从 @书房 夜晚开始：@基尼 两爪按着摊开的书本低头阅读，保持约0.5秒；切入桌上小闹钟的特写，指针从21:00快速走到21:20，台灯光晕微微摇曳；切回中景时 @基尼 右爪已握住铅笔、左爪轻按摊开的笔记本，笔尖落向纸页；第3秒稳定。

#### season_change ｜ 季节更替 / Season Change ｜ 电影艺术 ｜ 2.5–3.0s ｜ — ｜ 中/中
- 适用：季节～跨年；同一或相邻空间；室外或有窗、植物可见的空间：机位不动，植物与光质逐项渐变完成换季。
- 不适用：封闭无窗空间；小时级以下时间跨度。
- 模板（中）：画面从{上一镜结尾画面}开始；机位保持不变，环境以匀速渐变完成季节更替：{环境季节变化描述}（植物形态、天色、光质逐项变化），{@角色}的身影可被前景短暂遮挡或轻微虚化以掩盖状态切换；渐变完成时画面为{本镜开场画面}；第{T}秒稳定。
- Template (EN): [0-{T}s] Open on <Picture 1>: {PREV_END}. With the camera locked, the environment morphs steadily through a season change: {SEASON_SHIFT} (plants, sky and light quality shifting item by item); {@CHARACTER} may be briefly occluded by foreground or softly blurred to mask the state switch; when the morph completes the frame is {THIS_START}; steady by {T} seconds.
- 示例（假设 #2 的阳台由春入夏）：画面从 @阳台 开始：@基尼 树式站稳；机位不变，栏杆旁绿植匀速抽高变密、花盆开出小花，阳光由柔和转为盛夏的高亮与清晰硬影，@基尼 的身影被前景掠过的绿叶短暂遮挡；渐变完成时已是盛夏正午的 @阳台，@基尼 空爪立于瑜伽垫中央准备开始新动作；第3秒稳定。

#### montage_flash ｜ 微蒙太奇 / Micro-Montage ｜ 电影艺术 ｜ 2.5–3.0s ｜ — ｜ 低/低
- 适用：跨天～跨年；**仅同一空间**（片段须全部位于本镜或上一镜场景内）；大跨度、过程感叙事（练习了许多天）：在同一画框内快速叠化2-3个极短片段；最后手段。
- 不适用：普通承接（有更简单手法时）；片段需要出现未绑定场景时；T < 2.5 秒。
- 模板（中）：画面从{上一镜结尾画面}开始；在同一画框内以快速叠化连续闪过两到三个极短片段（每个约0.5-0.8秒，全部位于本镜场景或上一镜场景之内）：{片段1}；{片段2}；{片段3（可省）}，表现{时间跨度或过程}；最后一个片段叠化定格为{本镜开场画面}；第{T}秒稳定。
- Template (EN): [0-{T}s] Open on <Picture 1>: {PREV_END}. Within the same frame, two or three very short vignettes flash by in quick dissolves (about 0.5-0.8s each, all inside this shot's scene or the previous shot's scene): {VIGNETTE_1}; {VIGNETTE_2}; {VIGNETTE_3 (optional)}, conveying {SPAN_OR_PROCESS}; the last vignette dissolves and locks into {THIS_START}; steady by {T} seconds.
- 示例（#3→#4）：画面从 @书房 夜晚开始：@基尼 两爪按着书本阅读；同一画框内快速叠化闪过三个极短片段——她右爪翻过一页；她双爪合上书本推向桌角；她把笔记本拉到身前摊开；最后一个片段叠化定格为 @基尼 右爪握铅笔、左爪按住笔记本、笔尖落在纸页上的画面；第3秒稳定。

#### cutaway_insert ｜ 插入空镜 / Cutaway Insert ｜ 电影艺术 ｜ 1.5–3.0s ｜ — ｜ 中/中
- 适用：分钟～昼夜；任意地点变化（含不变）；需要喘息或分隔感的承接；插入物必须属于本镜场景（或天空等通用空镜），空镜内完成光线过渡。
- 不适用：插入物在本镜场景中不存在且非天空等通用空镜；高速动作中。
- 模板（中）：画面从{上一镜结尾画面}开始保持约0.5秒；切入{本镜场景中的静物或天色}的空镜特写约1秒，特写中光线由{旧光线}渐变为{新光线}；切回原景别时画面已是{本镜开场画面}；第{T}秒稳定。
- Template (EN): [0-{T}s] Open on <Picture 1>: {PREV_END}; hold about 0.5s. Cut in to an empty close-up of {STILL_OBJECT} belonging to this shot's scene for about 1 second, its light shifting from {OLD_LIGHT} to {NEW_LIGHT}; cutting back, the frame is {THIS_START}; steady by {T} seconds.
- 示例（#2→#3）：画面从明亮的上午阳台开始：@基尼 树式站稳，保持约0.5秒；切入 @书房 台灯的空镜特写——昏暗中暖黄灯光亮起、光晕铺开（约1秒）；切回中景时已是 @书房 夜晚全貌，@基尼 坐在桌前、两只前爪搭在摊开书本两侧；第2.5秒稳定。

#### sound_bridge ｜ 声音先行 / Sound Bridge (J-cut) ｜ 电影艺术 ｜ 1.5–3.0s ｜ — ｜ 中/低
- 适用：分钟～昼夜；任意地点变化（含不变）；H3 等有原生音频的模型优先：下一场景的环境声先入，画面随后以柔和叠化跟上；需与画面手法配合。
- 不适用：MiniMax 等无音频控制的模型单独使用；强节奏卡点段落。
- 模板（中）：画面从{上一镜结尾画面}开始；{本镜环境声}先行进入并渐强，画面仍停留在原状态约1秒；随后画面以柔和叠化换为{本镜开场画面}，声画在第{T}秒完全同步稳定。（需与叠化等画面手法配合；仅支持有音频的视频模型。）
- Template (EN): [0-{T}s] Open on <Picture 1>: {PREV_END}. {NEXT_AMBIENCE} enters first and swells while the image holds for about 1 second; the image then softly dissolves into {THIS_START}, and sound and picture lock in sync by {T} seconds. (Pair with a visual device such as a dissolve; audio-capable models only.)
- 示例（#2→#3）：画面从明亮的上午阳台开始：@基尼 树式站稳；夜晚室内安静的底噪与轻微纸页声先行进入并渐强，画面仍停在阳台约1秒；随后画面柔和叠化为 @书房 夜晚——暖黄台灯下 @基尼 坐在桌前、两爪搭在摊开书本两侧；第3秒声画同步稳定。

#### rack_focus ｜ 焦点转移 / Rack Focus ｜ 电影艺术 ｜ 1.0–2.0s ｜ 快速 ｜ 中/中
- 适用：时间不变～小时级；**仅同一空间**；同空间内注意力转移、小时间差；全虚瞬间掩盖状态切换，是电影感的快速手法；也可用于仅动作变化的连续性衔接。
- 不适用：画面中缺少可供焦点转移的前景或背景层次。
- 模板（中）：画面从{上一镜结尾画面}开始；焦点从{@角色或A物}缓缓移向{前景或背景的B物}，原主体渐渐虚化成柔和色块；在画面全虚的瞬间内容过渡，焦点回拉时清晰呈现的已是{本镜开场画面}；第{T}秒焦点锁定、画面稳定。
- Template (EN): [0-{T}s] Open on <Picture 1>: {PREV_END}. Focus racks slowly from {SUBJECT_A} to {SUBJECT_B} in the foreground or background; the original subject melts into soft bokeh; at the instant of full blur the content transitions, and as focus racks back it resolves on {THIS_START}; focus locks and the frame steadies by {T} seconds.
- 示例（#3→#4 的快速替代）：画面从 @书房 夜晚开始：@基尼 两爪按着书本低头阅读；焦点从她缓缓移向桌面前景的铅笔，书本与她虚化成暖色光斑；画面全虚的瞬间内容过渡，焦点回拉时清晰呈现：@基尼 右爪已握住铅笔、左爪轻按摊开的笔记本，笔尖正落向纸页；第1.5秒焦点锁定、画面稳定。

#### oner_walkthrough ｜ 一镜穿越 / Walkthrough Oner ｜ 电影艺术 ｜ 2.5–3.0s ｜ — ｜ 中/中
- 适用：时间不变～小时级；**相邻空间**（有门、走廊实际连通）；一镜到底跟拍穿越，沿途光线渐变。
- 不适用：无实际连通路径的两个空间；T < 2.5 秒；跨昼夜且过道内无光线渐变动机。
- 模板（中）：画面从{上一镜结尾画面}开始；镜头保持不间断的一镜，跟随{@角色}（或自行移动）向{方向}穿过{门口或过道}，沿途光线由{旧光线}渐变为{新光线}；穿出后镜头停稳，画面为{本镜开场画面}，全程无剪切；第{T}秒落定。
- Template (EN): [0-{T}s] Open on <Picture 1>: {PREV_END}. In one unbroken take, the camera follows {@CHARACTER} (or moves on its own) {DIRECTION} through {DOORWAY_OR_PASSAGE}, the light grading from {OLD_LIGHT} to {NEW_LIGHT} along the way; emerging, the camera settles on {THIS_START} with no cut anywhere; locked by {T} seconds.
- 示例（假设 #2 → 相邻客厅的新镜）：画面从明亮的上午阳台开始：@基尼 收起树式四爪落地，右前爪先迈、小跑向左侧门口，镜头不间断地跟随她穿过门框，光线由户外亮白渐变为室内柔和；穿出门后镜头停稳：@客厅 里 @基尼 在地毯中央坐定；第3秒落定、全程无剪切。

#### pov_shift ｜ 主观视点转场 / POV Shift ｜ 电影艺术 ｜ 2.0–3.0s ｜ — ｜ 中/中
- 适用：分钟～昼夜；同一或相邻空间；普通、情绪与回忆导入段落；有明确视线动机时：推近眼部→切入主观视点→视野中变化→拉回客观机位。
- 不适用：没有合理的视线动机。
- 模板（中）：画面从{上一镜结尾画面}开始；镜头推近{@角色}的眼部特写（只写神态强度与视线方向），随后切换为其主观视点：视野中{注视对象}渐渐变化、亮起或靠近；从主观视点拉回客观机位时，画面已是{本镜开场画面}；第{T}秒稳定。
- Template (EN): [0-{T}s] Open on <Picture 1>: {PREV_END}. The camera pushes in to a close-up of the eyes of {@CHARACTER} (write only gaze direction and intensity), then switches to the character's POV: in the view, {GAZE_TARGET} gradually changes, lights up or draws closer; pulling back from the POV to an objective camera, the frame is {THIS_START}; steady by {T} seconds.
- 示例（#2→#3）：画面从明亮的上午阳台开始：@基尼 树式完成、目光转向室内方向；镜头推近至她的眼部特写，切入她的主观视点——视野尽头昏暗的室内亮起一盏暖黄台灯、光晕渐渐放大；拉回客观机位时已是 @书房 夜晚，@基尼 坐在桌前、两只前爪搭在摊开书本两侧；第3秒稳定。

#### memory_dream ｜ 回忆梦境转场 / Memory-Dream Transition ｜ 电影艺术 ｜ 2.0–3.0s ｜ — ｜ 中/中
- 适用：任意时间跨度（不变～跨年）；任意地点变化（含不变）；**仅回忆、梦境、幻想的进入或走出**：柔焦光晕、色调漂移、轻微涟漪。
- 不适用：普通线性时间承接（非回忆或梦境）。
- 模板（中）：画面从{上一镜结尾画面}开始；画面边缘泛起柔焦光晕、色调向{偏暖泛白或偏冷低饱和}漂移，轻微的波纹感掠过画面，现实细节渐渐模糊；朦胧顶点后画面重新聚实，带着回忆或梦境的色调质感，呈现{本镜开场画面}；第{T}秒聚实稳定。
- Template (EN): [0-{T}s] Open on <Picture 1>: {PREV_END}. A soft-focus glow blooms at the frame edges, the palette drifts {warm-white or cool-desaturated}, a faint ripple passes across the frame, and present-day detail blurs away; past the haze peak, the image resolves again with a memory-or-dream tonal quality, revealing {THIS_START}; resolved and steady by {T} seconds.
- 示例（假设 #4 后接「回忆清晨举铁」的新镜，该镜绑定 @阳台）：画面从夜晚书房的暖黄灯下开始：@基尼 右爪握笔停在纸页上方、目光放远；画面边缘泛起柔焦光晕、色调偏暖泛白、轻微波纹掠过；朦胧顶点后画面聚实——带着泛白回忆色调的清晨 @阳台，@基尼 双爪各握一只迷你哑铃举到胸前；第3秒聚实稳定。

### 2.3 同场景动作衔接（action_bridge）

同时间、同地点、同人物，仅动作/道具/姿态/位置变化时优先使用本类手法；选择细则与退路见第 4 节专项。

#### put_down_prop ｜ 放下道具 / Put Down Prop ｜ 动作衔接 ｜ 1.5–3.0s ｜ — ｜ 高/高
- 适用：时间不变～分钟级；**仅同一空间**；仅动作衔接；上一镜手持物在本镜不再需要时的首选；可并入小幅移步与朝向调整。
- 不适用：手持物在本镜仍需使用（无需放下）。
- 模板（中）：画面从{上一镜结尾画面}开始；{@角色}俯身，持着{旧道具}的那只爪或手把它轻放到{放置位置}，另一只爪或手同步放下另一件、撑稳身体或自然垂下（写明左右分工）；随后直起身，必要时小步移到{目标位置}，双爪或双手空出，身体转向{本镜朝向}；到第{T}秒，{@角色}已处于{本镜开场画面}的位置与姿态。
- Template (EN): [0-{T}s] Open on <Picture 1>: {PREV_END}. {@CHARACTER} bends down; the paw or hand holding {OLD_PROP} sets it gently at {PLACE}, while the other paw or hand sets down its own item, braces the body or hangs free (state left-right roles); the character then straightens up, steps to {TARGET_POS} if needed, both paws or hands now empty, body turning toward {ORIENTATION}; by {T} seconds {@CHARACTER} is in the position and pose of {THIS_START}.
- 示例（#1→#2，范例答案）：画面从清晨的 @阳台 开始：@基尼 站在训练垫上、两只前爪各握一只迷你哑铃举在胸前；她俯下身，右爪先把哑铃轻放到垫边，左爪随即把另一只哑铃并排放下，双爪空出撑在垫面上；随后她直起身、小步挪到瑜伽垫中央蹲踞站稳，身体转向正面；到第3秒，@基尼 已空爪蹲踞在瑜伽垫中央、准备缓缓站起——即本镜开场画面。

#### pick_up_prop ｜ 拿起道具 / Pick Up Prop ｜ 动作衔接 ｜ 1.5–3.0s ｜ — ｜ 高/高
- 适用：时间不变～分钟级；**仅同一空间**；仅动作衔接；本镜开场需要手持新道具而上一镜双手为空或按在他处；也可写「操作开关」类动作。
- 不适用：上一镜手中还有旧物未交代去向（先用 swap_prop）。
- 模板（中）：画面从{上一镜结尾画面}开始；{@角色}的一只爪或手离开{原位置}伸向{新道具}（写明是哪只，另一只爪或手保持按住或扶稳{支撑物}），稳稳握住{新道具}后移到{使用位置}；到第{T}秒，{@角色}呈{本镜开场画面}的姿态，{新道具}已就位。
- Template (EN): [0-{T}s] Open on <Picture 1>: {PREV_END}. One paw or hand of {@CHARACTER} leaves {FROM_POS} and reaches for {NEW_PROP} (state which one, while the other keeps pressing or steadying {SUPPORT}); it grips {NEW_PROP} firmly and brings it to {USE_POS}; by {T} seconds {@CHARACTER} is in the pose of {THIS_START} with {NEW_PROP} in place.
- 示例（#3→#4，范例答案）：画面从 @书房 夜晚开始：@基尼 两只前爪分别按在摊开书本的两侧低头阅读；她的左爪把身前的笔记本轻轻拉正并按住，右爪离开书页、伸向桌面上的铅笔并稳稳握住，移到笔记本纸页上方落下笔尖；到第2秒，@基尼 右爪握笔、左爪按住笔记本——即本镜开场画面。

#### swap_prop ｜ 道具交接 / Prop Swap ｜ 动作衔接 ｜ 2.0–3.0s ｜ — ｜ 高/中
- 适用：时间不变～分钟级；**仅同一空间**；仅动作衔接；旧物需放下且新物需拿起的完整交接；两步动作各约1-1.5秒。
- 不适用：只需单向放下或拿起（用 put_down_prop 或 pick_up_prop）；T < 2 秒。
- 模板（中）：画面从{上一镜结尾画面}开始；{@角色}先用一只爪或手把{旧道具}放到{放置位置}（写明左右，另一只爪或手的状态），随即伸向{新道具}并握稳、移到{使用位置}；到第{T}秒，{@角色}已是{本镜开场画面}的姿态——旧物离手、{新道具}就位。
- Template (EN): [0-{T}s] Open on <Picture 1>: {PREV_END}. {@CHARACTER} first sets {OLD_PROP} down at {PLACE} with one paw or hand (state which, and what the other is doing), then reaches to {NEW_PROP}, grips it and brings it to {USE_POS}; by {T} seconds {@CHARACTER} is in the pose of {THIS_START} — old prop released, {NEW_PROP} in place.
- 示例（#3→#4 备选）：画面从 @书房 夜晚开始：@基尼 两爪按着摊开的书本；她先用右爪把书本轻轻合拢推到桌面左上角（左爪扶住桌沿），再把笔记本拉到身前摊开，右爪伸向铅笔握稳、笔尖移到纸页上方，左爪改为轻按笔记本；到第3秒，@基尼 右爪握笔、左爪按纸——即本镜开场画面。

#### rise_relocate ｜ 起身走位 / Rise and Relocate ｜ 动作衔接 ｜ 2.0–3.0s ｜ — ｜ 高/高
- 适用：时间不变～分钟级；**仅同一空间**；仅动作衔接；同一空间内的姿态与位置变化（坐↔站↔移步）；可把放下或拿起道具并入步骤。
- 不适用：需要跨场景移动（用 motion_follow 或 oner_walkthrough）；T < 2 秒且动作幅度大。
- 模板（中）：画面从{上一镜结尾画面}开始；{@角色}按步骤收起当前姿势（写明先动哪只爪或脚、重心如何转移，可在步骤中并入放下或拿起道具），起身、坐下或移步到{目标位置}，身体转向{本镜朝向}并稳定为本镜开场姿态；镜头可随动作轻微跟移后停稳；到第{T}秒，画面即{本镜开场画面}。
- Template (EN): [0-{T}s] Open on <Picture 1>: {PREV_END}. {@CHARACTER} unwinds the current pose step by step (state which paw or foot moves first and how the weight shifts; prop put-downs or pick-ups may be folded into the steps), then rises, sits or steps to {TARGET_POS}, turning toward {ORIENTATION} and settling into this shot's opening pose; the camera may track slightly and then lock; by {T} seconds the frame is {THIS_START}.
- 示例（#1→#2 备选）：画面从清晨的 @阳台 开始：@基尼 双爪举着哑铃；她先放低双爪、右爪先左爪后把两只哑铃搁到垫边，随后重心后移、后腿发力撑起身体，小步挪到瑜伽垫中央蹲踞站稳、身体转向正面；到第3秒，@基尼 空爪蹲踞在瑜伽垫中央、准备缓缓站起——即本镜开场画面。

#### breath_beat ｜ 呼吸停顿 / Breath Beat ｜ 动作衔接 ｜ 1.0–1.5s ｜ 快速 ｜ 高/高
- 适用：时间不变；**仅同一空间**；仅动作衔接；状态几乎一致、只剩视线/表情/微姿态差时的最小衔接；也是 T 压到 1 秒时的连续性保底。
- 不适用：存在手持物、位置、姿态等硬残留（停顿解决不了）。
- 模板（中）：画面从{上一镜结尾画面}开始；{@角色}完成当前动作的最后一拍后静止，轻轻呼出一口气、肩背略微松沉，视线转向{本镜注视方向}，姿态微调为本镜开场状态（写明双爪或双手位置不变或如何微调）；第{T}秒画面即{本镜开场画面}，机位不变。
- Template (EN): [0-{T}s] Open on <Picture 1>: {PREV_END}. {@CHARACTER} finishes the last beat of the current action and stills, exhaling softly, shoulders easing; the gaze turns toward {GAZE_DIR} and the pose micro-adjusts into this shot's opening state (state that both paws or hands stay put, or how they adjust); by {T} seconds the frame is {THIS_START} with the camera unchanged.
- 示例（构造的同动作承接：#4 → 继续写字的下一镜）：画面从 @书房 夜晚开始：@基尼 右爪握笔、左爪按纸写完一行；她笔尖离纸停住，轻呼一口气、肩背微松，视线移回页首，笔尖重新落到下一行起点（左爪保持按住纸页）；第1秒画面即本镜开场的书写姿态，机位不变。

#### insert_hands_closeup ｜ 特写遮挡交接 / Close-up Insert Handoff ｜ 动作衔接 ｜ 1.5–3.0s ｜ — ｜ 中/中
- 适用：时间不变～分钟级；**仅同一空间**；仅动作衔接；道具交接较复杂、全景里做显得拖沓时：切入爪/手部特写，在特写里完成交接再切回。
- 不适用：角色爪或手部无法合理入画（距离过远）；T < 1.5 秒。
- 模板（中）：画面从{上一镜结尾画面}开始保持约0.5秒；切入{@角色}爪或手部特写：特写中完成道具交接——写明哪只爪或手放下{旧道具}到{放置位置}、哪只握起{新道具}（无新道具则双爪空出）；切回原景别时，{@角色}整体已是{本镜开场画面}的姿态；第{T}秒稳定。
- Template (EN): [0-{T}s] Open on <Picture 1>: {PREV_END}; hold about 0.5s. Cut in to a close-up of the paws or hands of {@CHARACTER}: the handoff happens inside the close-up — state which paw or hand sets {OLD_PROP} down at {PLACE} and which grips {NEW_PROP} (or both end empty); cutting back to the original framing, {@CHARACTER} is already in the pose of {THIS_START}; steady by {T} seconds.
- 示例（#1→#2）：画面从清晨的 @阳台 开始：@基尼 双爪各握哑铃举在胸前，保持约0.5秒；切入爪部特写——右爪把哑铃轻放到垫边，左爪的哑铃随即并排放下，双爪在垫面上撑稳；切回中景时 @基尼 已空爪蹲踞在瑜伽垫中央、准备缓缓站起；第2.5秒稳定。

#### micro_jump ｜ 轻微跳切 / Micro Jump Cut ｜ 动作衔接 ｜ 1.0–2.0s ｜ 快速 ｜ 中/低
- 适用：时间不变～小时级；**仅同一空间**；仅动作衔接；连续性退路：平稳动作在 T 内装不下或状态矛盾过大时，同机位一次干脆跳变完成状态重置。
- 不适用：有充足时间做平稳动作衔接时（优先动作桥）；连续多镜重复使用（频闪感）。
- 模板（中）：画面从{上一镜结尾画面}开始保持约一半转场时长；随后画面发生一次干脆的轻微跳切：机位与景别不变，{@角色}仍在画面同一区域，但{旧道具}已离手归位、姿态直接变为{本镜开场画面}的状态；跳切后保持静止到第{T}秒。
- Template (EN): [0-{T}s] Open on <Picture 1>: {PREV_END}; hold for about half the transition. Then one crisp micro jump cut: camera and framing unchanged, {@CHARACTER} stays in the same screen region, but {OLD_PROP} is already out of hand and in place, the pose switching directly to {THIS_START}; hold still after the jump until {T} seconds.
- 示例（#1→#2 退路）：画面从清晨的 @阳台 开始：@基尼 双爪各握哑铃举在胸前，保持约0.5秒；画面一次干脆的轻微跳切：机位景别不变，两只哑铃已并排躺在垫边，@基尼 空爪蹲踞在瑜伽垫中央、准备缓缓站起；跳切后保持静止到第1秒。

## 3. 选择规则（b）：三步决策、速查表与硬规则

### 3.1 三步决策

**第 1 步｜判定（verdict）**：读取上一镜结尾画面（PREV_END）与本镜开场画面（THIS_START），按 4.2 的状态快照法逐项比较，产出 changes（差异清单）与 hazards（硬残留清单）。
- 两镜状态完全一致或差异不可察觉 → `none`：不做转场（technique_id=null、seconds=0、transition_prompt=""）。
- 时间跨度或地点发生变化、进出回忆/梦境、情绪基调骤变 → `scene_time`。
- 同时间、同地点、同人物，仅道具/姿态/位置/视线等状态差异 → `continuity`（按第 4 节专项执行）。

**第 2 步｜定时长（seconds = T）**：
- 预算：scene_time 默认 3.0 秒；continuity 在 1.0–3.0 秒内取「装得下衔接动作的最小值」（估算见 4.3 动作时长预算表）。T 恒为 0.5 的倍数，绝对下限 1.0 秒。
- 中间帧约束：E = min(T, max(0, 15 − duration))；存在 mid_frame_time 时必须满足 **mid_frame_time + E ≥ T + 0.5**（转场把中间帧引导整体后移 E 秒，须保证引导点落在转场结束至少 0.5 秒之后；总时长上限 15 秒）。
- 收缩规则：不满足时把 T 降为 mid_frame_time + E − 0.5（向下取 0.5 的倍数，最低 1.0），并改从快速手法选（scene_time：light_flash / whip_pan / beat_snap / rack_focus；continuity：breath_beat / micro_jump / rack_focus）；降到 1.0 仍不满足 → 由系统放弃转场，agent 照常输出并在 reason 注明「时长约束过紧」。

**第 3 步｜查表选手法（technique_id）**：在 3.2 速查表自上而下取**第一条命中的行**；行内候选**从左到右**依次尝试，跳过：① 该手法任一「不适用」条件命中；② 其秒数范围装不下当前 T，且无法把 T 重定进范围再通过第 2 步复核；③ 其对当前视频模型执行性为「低」且行内后面仍有非低候选（当前视频模型未告知时按 H3 评估）。选定后把 seconds 定稿在该手法秒数范围内，回第 2 步复核约束，然后按模板写 transition_prompt。时间标注差 ≤ 约30分钟且光线/环境无可见差异的，不走本表，按第 4 节连续性专项处理。

### 3.2 速查表

**场景/时间变化（scene_time）**

| # | 情形 | 候选（从左到右依次尝试） |
|---|------|--------------------------|
| 1 | 跨昼夜且地点变化 | fade_black → zoom_through → dissolve → whip_pan |
| 2 | 白天时段内的地点变化（两头都明亮） | occlusion_wipe → whip_pan → motion_follow → dissolve |
| 3 | 相邻空间且人物可自然走动、时间差小 | motion_follow → oner_walkthrough → occlusion_wipe |
| 4 | 同一空间内的时段或昼夜变化 | timelapse_light → dissolve → jump_cut_lapse → clock_calendar |
| 5 | 跨天（翌日、数日后） | fade_black → timelapse_light → jump_cut_lapse → clock_calendar |
| 6 | 季节变化 | season_change → dissolve → fade_black |
| 7 | 跨年或数年 | fade_black → season_change → montage_flash |
| 8 | 进入回忆或梦境 | memory_dream → fade_white → dissolve |
| 9 | 走出回忆或梦境 | memory_dream → dissolve → fade_black |
| 10 | 仅情绪基调骤变（时空不变） | rack_focus → speed_ramp → sound_bridge → light_flash |
| 11 | 其他未覆盖组合（兜底） | dissolve → fade_black |

**连续性（continuity）**

| # | 情形 | 候选（从左到右依次尝试） |
|---|------|--------------------------|
| 1 | 仅需放下旧道具 | put_down_prop → insert_hands_closeup → micro_jump |
| 2 | 仅需拿起新道具 | pick_up_prop → insert_hands_closeup → micro_jump |
| 3 | 需放下旧物并拿起新物 | swap_prop → insert_hands_closeup → micro_jump |
| 4 | 姿态或位置变化（无道具冲突） | rise_relocate → match_on_action → micro_jump |
| 5 | 道具与姿态/位置复合变化：先按上面三行确定道具基底手法，把位移与姿态并入其模板步骤；装不下再顺延 | put_down_prop → pick_up_prop → swap_prop → insert_hands_closeup → occlusion_wipe |
| 6 | hazards 仅剩轻量项（视线、表情、朝向微调）且不匹配其他行 | breath_beat |
| 7 | 灯光等环境状态需由角色动作改变（按开关等） | pick_up_prop → timelapse_light → micro_jump |
| 8 | 平稳衔接不可行或 T ≤ 1.5 秒 | micro_jump → breath_beat → whip_pan → light_flash |

**快速退化（fast_fallback，T 被压缩时改选）**：scene_time → light_flash / whip_pan / beat_snap / rack_focus；continuity → breath_beat / micro_jump / rack_focus。

### 3.3 硬规则

1. technique_id 只能取第 5 节全集中的 32 个合法 id，一字不差；历史错误 id 一律禁用：zoom_punch → 改用 **zoom_through**，defocus_blur → 改用 **rack_focus**，light_lapse → 改用 **timelapse_light**。
2. 转场固定占视频开头 0–T 秒；transition_prompt 本身不带「开场转场（0–T秒）：」前缀（由系统拼接）；**第 T 秒必须完全落定为本镜开场画面**（位置、姿态、每只爪/手的持物与落点、朝向、视线、光线逐项到位），并按模板收尾句明确写出。
3. 转场从上一镜结尾画面写起；模板要求的「保持约 0.5 秒」开场节拍必须保留。
4. 只能 @ 本镜已绑定资产；上一镜画面涉及、但本镜未绑定的场景或道具以普通文字描述，不加 @。
5. 以图片为准：禁止描写角色外形、服装、毛色、体型（由参考图决定）；只写动作、位置、朝向、视线、神态强度、镜头与光线。动作必须写明每只爪/手的动作与落点；持物不得凭空出现或消失。
6. 单段生成没有剪辑台：禁止「切至」「切换到」「转场到」「cut to」等剪辑台语汇；仅当所选手法模板本身含「切入特写/切回/跳切」（cutaway_insert、insert_hands_closeup、clock_calendar、jump_cut_lapse、micro_jump、beat_snap）时按模板原样书写。
7. seconds 为 0.5 的倍数，1.0 ≤ seconds ≤ 3.0，且必须落在所选手法的秒数范围内。
8. transition_prompt 用中文书写（英文扩写由下游 H3 规则处理）。

### 3.4 运行时输出 JSON schema

逐字段说明：
- **verdict**（string，必填）：`"scene_time"` | `"continuity"` | `"none"`。转场判定类别。
- **changes**（string[]，必填）：两镜差异清单，每条格式「维度：旧 → 新」；verdict=none 时为 `[]`。
- **hazards**（string[]，必填）：硬残留风险清单（持物、道具位置/形态、姿态、站位、朝向、光线、环境状态等）；无则 `[]`。
- **technique_id**（string | null，必填）：32 个合法 id 之一；verdict=none 时为 `null`。
- **seconds**（number，必填）：转场时长 T，0.5 的倍数且在所选手法秒数范围内；verdict=none 时为 `0`。
- **transition_prompt**（string，必填）：中文转场提示词全文（不带前缀，遵守 3.3 全部硬规则）；verdict=none 时为 `""`。
- **reason**（string，必填）：判定依据＋命中表行＋候选取舍（含被跳过项与原因）＋T 的计算与中间帧约束核验。

填好的 #2→#3 示例（上一镜：上午阳台、@基尼 树式站立双爪空；本镜：@书房 夜晚、@基尼 坐桌前两爪搭书；本镜 duration=12、无中间帧、模型 h3）：

```json
{
  "verdict": "scene_time",
  "changes": ["时间：上午 → 夜晚（跨昼夜）", "地点：阳台 → @书房", "姿态：树式站立 → 坐于书桌前", "持物：双爪空 → 两只前爪搭在摊开书本两侧", "光线：明亮自然光 → 暖黄台灯光"],
  "hazards": ["跨昼夜明→暗反差大，直接衔接会光线跳变", "站→坐姿态需彻底重置", "书本须在第 T 秒已摊开就位，不能凭空出现在爪下"],
  "technique_id": "fade_black",
  "seconds": 3.0,
  "transition_prompt": "画面从明亮的上午阳台开始：@基尼 树式站稳、眼神亮晶晶；画面整体亮度平滑下落，约1.5秒沉入全黑；黑场中先响起夜晚室内安静的底噪与轻微纸页声；画面从黑中缓缓亮起——@书房 夜晚，暖黄台灯光晕笼罩小书桌，@基尼 坐在桌前、两只前爪搭在摊开书本两侧；第3秒曝光恢复正常并稳定。",
  "reason": "跨昼夜且地点变化，命中 scene_time 表第 1 行；行内首选 fade_black 无不适用命中（目标为较暗夜景、T=3.0 ≥ 2.0），h3 执行性高，黑场天然抹除姿态与道具残留，无需后移候选；E = min(3, 15−12) = 3，无中间帧故无约束，无需收缩；seconds=3.0 在 fade_black 的 2.0–3.0 范围内。"
}
```

## 4. 同时间同地点同人物、仅动作变化专项（c）

适用前提：verdict = continuity——时间与地点不变、人物相同，仅上一镜结尾与本镜开场的「状态」不同。目标：用镜头内的自然动作把差异全部消解，第 T 秒精确落到本镜开场画面；做不到时按 4.5 退路。

### 4.1 残留风险清单（hazards checklist）

逐条核对，命中即记入 hazards：
1. **手持物残留**：上一镜结尾爪/手中握着 X，本镜开场为空爪/空手或改握 Y（最高危：道具凭空消失、凭空出现或无动作换手）。
2. **道具位置残留**：关键道具应从 A 处到 B 处（或在画面中出现/退场），缺少搬动动作。
3. **道具形态残留**：书摊开↔合上、门窗开合、容器盖揭等形态差。
4. **姿态残留**：站↔坐↔蹲↔卧、体式变化、躯干与头部角度差。
5. **位置残留**：站位移动、与参照物（垫、桌、门）的相对关系变化。
6. **朝向残留**：身体或面部朝向变化。
7. **视线/表情残留**：注视对象、神态强度不同（轻量项）。
8. **环境状态残留**：灯具开关、光线角度等需要动机的环境差（极轻微光线漂移可由画面自然过渡，不计）。
9. **左右与落点核验**：this_start 未写明左右的肢体，转场文本不得自行指定左右（用「一只前爪／另一只前爪」等稳定指代）；被放下的旧道具必须落在 this_start 写明之处或出画/画面边缘，第 T 秒画面内不得残留本镜开场没有的道具。

### 4.2 逐项比较方法（状态快照法）

第 1 步：分别从上一镜视频提示词的结尾句与本镜开场描述抽取两份快照，字段固定为：左爪/左手持物｜右爪/右手持物｜双爪（手）搭放点与支撑点｜姿态｜站位｜朝向｜视线｜关键道具位置与形态｜环境状态（灯、门窗）｜神态强度。
第 2 步：逐行对比，写成「维度：旧 → 新」；无差异的行丢弃，有差异的行记入 changes。
第 3 步：changes 中需要动作或手法才能消解的硬矛盾（4.1 的第 1–6、8 项）记入 hazards；仅第 7 项轻量差不算硬矛盾。
第 4 步：changes 与 hazards 均为空 → verdict=none；hazards 只剩轻量项 → 直接走速查表 continuity 第 6 行（breath_beat）；否则进入 4.3 判定。

### 4.3 「是否存在平稳转场」判断标准

动作时长预算（估算值）：放下单件道具 ≈ 1.0–1.5 秒；拿起单件道具 ≈ 1.0–1.5 秒；放下＋拿起完整交接 ≈ 2.0–3.0 秒；起身/坐下/蹲起 ≈ 1.0–1.5 秒；小步移位（两三步内）≈ 1.0 秒；转向调整 ≈ 0.5 秒；视线/表情/呼吸微调 ≈ 0.5 秒。

同时满足以下 4 条即「存在平稳转场」：
1. **可消解**：每条 hazard 都能由本镜绑定角色在镜头内用自然动作消解（放下、拿起、合上、起身、移步、转向、按开关），且不要求物件凭空出现或消失——新物必须在画面内有合理来源位置、旧物必须有明确去处（放置点以场景参考图为准，禁止发明不存在的家具台面）。
2. **装得下**：按预算表累加所需动作时长 ≤ T，且 T ≤ 3.0（可把移步、转向并入道具动作同步完成以压缩总时长）。
3. **不跨景、机位稳**：全程同一空间；机位保持不动或仅轻微跟移即可覆盖动作。
4. **残留全清**：动作链走完后逐项复核快照，第 T 秒每只爪/手的持物与落点、姿态、站位、朝向、视线与 THIS_START 完全一致，无任何残留。

满足全部 4 条 → 按 4.4 模板库执行；任一条不满足 → 不存在平稳转场，走 4.5。

### 4.4 平稳衔接模板库（映射到合法 technique_id）

| 情形 | technique_id | 写法要点 |
|---|---|---|
| 仅放下旧物（可并入小幅移步、转向） | put_down_prop | 写明左右爪分工与先后、放置位置、随后移步与最终朝向 |
| 仅拿起新物 / 操作开关 | pick_up_prop | 写明哪只爪伸出及来源位置，另一只的支撑或按压点，新物的最终使用位置 |
| 放下旧物＋拿起新物 | swap_prop | 两步各约 1–1.5 秒，先后与左右明确，旧物去处与新物来源都写明 |
| 姿态/位置变化（无道具冲突） | rise_relocate | 先动哪只爪/脚、重心如何转移、目标位置与朝向；可把放下/拿起并入步骤 |
| 上一镜收尾动作可顺势接入本镜开场动作（同类同向、同一人物） | match_on_action | 动作不中断、落点即开场姿态；同场景使用时环境叠化幅度趋近于零 |
| 交接复杂、全景里做显得拖沓 | insert_hands_closeup | 切入爪/手特写、特写内完成交接再切回，切回即开场姿态 |
| 仅剩视线/表情/微姿态轻量差 | breath_beat | 呼气、肩背松沉、视线转向，写明双爪位置不变或如何微调 |
| 灯光等环境状态需角色动作改变 | pick_up_prop（按开关写法）或 timelapse_light | 前者写明伸爪按开关与另一爪状态；后者机位不动、光线延时流转＋人物轻微虚化换位 |
| 道具＋姿态/位置复合变化 | put_down_prop / pick_up_prop / swap_prop 为基底 | 把移步与转向并入模板「随后直起身、小步移到{目标位置}、身体转向{本镜朝向}」槽位；装不下 → insert_hands_closeup → occlusion_wipe |

### 4.5 无法平稳衔接时的退路

按速查表 continuity 第 8 行从左到右依次尝试：
1. **micro_jump**（首选退路）：同机位一次干脆跳变完成状态重置；注意连续多镜重复使用会产生频闪感。
2. **breath_beat**：复核后发现 hazards 其实只剩轻量项（视线/表情/微姿态）时改用。
3. **whip_pan**：需要用运动模糊同时掩盖较大状态重置、且段落节奏明快时（沉静哀伤段不用）。
4. **light_flash**：用过曝一瞬抹掉全部残留（压抑恐怖氛围不用；需暗化氛围改走 fade_black，但其要求 T ≥ 2.0）。

补充退路：画面存在可信前景遮挡物时，occlusion_wipe 可作强力全遮挡退路（复合行末位候选）；画面有前后景层次时，rack_focus 以全虚一瞬完成电影感重置（fast_fallback.continuity 候选之一）。T 被压到 1.0 秒仍无法满足约束时，由系统放弃转场，agent 照常输出并在 reason 注明「时长约束过紧」。

## 5. technique_id 全集（32）

technique_id 全集（32）：whip_pan、occlusion_wipe、zoom_through、roll_spin、motion_follow、object_to_lens、light_flash、speed_ramp、beat_snap、dissolve、fade_black、fade_white、match_cut、match_on_action、jump_cut_lapse、timelapse_light、clock_calendar、season_change、montage_flash、cutaway_insert、sound_bridge、rack_focus、oner_walkthrough、pov_shift、memory_dream、put_down_prop、pick_up_prop、swap_prop、rise_relocate、breath_beat、insert_hands_closeup、micro_jump
