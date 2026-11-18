# Issue #121 隔离 QA 报告（2026-11-18）

环境：worktree `huobao-drama-issue-121`，后端 :5689 / 前端 :3023（`HUOBAO_BASE_PATH=/`），DB 为生产库 backup API 副本（活跃任务已中和），static 全量副本。生产库只读。

## 验收项与证据

### 1. 真实自动分类 + 自动采用（不人工指定用途）
- 上传现代标注地图（prop 272 原图）与 17 世纪肖像油画（prop 266 原图）为 character 900 参考图。
- 视觉分类（DeepSeek 视觉配置）：现代图 → `reference`（理由：现代地形底图叠加中文标注、彩色箭头路线与图例）；肖像 → `direct`（理由：古典油画风格历史人物肖像原作）。
- direct 自动采用：`image_url` = 肖像路径，`faithful=1`，`faithful_source=4945`（upload/direct-adopt 版本行）。见 `db-evidence.json`。

### 2. 保护与更正
- faithful=1 时 `POST /characters/900/generate-image` → 400「受保护原件，不进生图」。
- 关保护不带 confirm → 400；带 `confirm_unfaithful=true` → 200 faithful=0。
- `PUT /reference-images/usage` 人工改判 → classification.manual=true。
- `POST /reference-images/adopt` 显式采用 → 版本 4950，faithful_source 更新。

### 3. 引用核验（手动 PUT / 保存闸门 / 自查工具）
- PUT final_prompt 引 `@参考图9`（只有 2 张）→ 400 点名越界。
- 描述引用 `@参考图2` 而 final_prompt 只引 1 → 400「必须保留这些引用」。
- 只引部分（`@参考图2`）→ 200 保存。
- 行为测试 `tests/asset-reference-prompt.test.mjs` 10/10 通过（含自查工具真跑 DB、稀疏映射、删除重写、两位数边界、双 @ 回归）。

### 4. 按引用发送（真实 qwen-central 任务）
- 任务 4948：final_prompt「以@参考图2的五官为准」→ 请求体 `prompt: "以<image1>的五官为准，纯白背景"`，`reference_images` 恰 1 张（肖像 file id），mode=image_edit；`params.refNameIndex={"参考图2":1}`，`asset_citation=true`。任务 completed，产物 `static/images/9b1ec29b-….png`。
- 任务 4949（零引用角色 901）：请求体 mode=text_to_image，无 reference_images，无泛化前缀。completed。
- 修复过程留痕：4946/4947 暴露归一化两位数尾巴/双 @/稀疏映射缺陷，已修复并加回归测试（commit bb81d6e4、9ae2647b）。

### 5. 引用生命周期
- 删除参考图 1（现代图）：appearance「样貌见@参考图2」→「样貌见@参考图1」，final_prompt 同步重写。
- 只读徽标：prop 900 描述「形制见@参考图1」无参考图时渲染失效徽标（is-missing）；上传参考图后点击徽标打开原图查看器（截图 03）。

### 6. 扩写保留描述引用（真实 GLM Agent）
- `POST /characters/900/generate-prompt {force:true}`：58.9 s 完成，新稿含 `@参考图1`（描述引用保留），final_prompt_source=agent。

### 7. 前端 UI
- 资产弹窗：样貌/妆造为 MentionTextarea（@ 下拉候选=参考图编号，选中插入 `@参考图1`）；参考图编号徽标 + 用途按钮（仅参考/可直接用）+ 采用按钮；三类统一保护开关（截图 01/02）。
- 修复留痕：编号徽标 `<span :title=t(...)>` 在该嵌套位置触发 Vue 3.5.44 patch 崩溃（emitsOptions null），改 `<div>` + 静态模板 title 后正常（commit 5b8a5711）。
- 浏览器 errors 为空；drama 3 真实项目资产页 15 卡正常渲染（回归）。

### 8. 套件
- 后端 tsc 干净；全量后端失败名单与 main 逐条相同（10 个既有无关失败）；前端失败名单与 main 逐条相同（17 个）。

## 截图
- `01-dialog.png` 资产弹窗（mention 字段/编号/用途/保护开关）
- `02-mention.png` @ 引用插入后
- `03-badge-viewer.png` 只读徽标点击打开原图

## 待生产验收
本報告为隔离 QA（实现期自测）。按 AGENTS.md §9，最终验收在生产系统用专用测试项目留痕（发布后执行）。