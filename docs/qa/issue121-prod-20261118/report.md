# Issue #121 生产验收报告（2026-11-18）

发布：release `20261118T083034Z`（merge `1266f241` → origin/master）。:5679 listener 为新进程（pid 3261771，pm2 huobao-backend 3261731 子进程）；新路由 `PUT /characters/:id/reference-images/usage` 返回 JSON 400（非 SPA fallback）；characters/scenes `faithful`/`faithful_source` 列已由启动迁移补齐。发布前活跃任务仅 5 条 suspended asset_pipeline（重启后仍 processing，符合恢复语义）。发布前 DB 备份：`~/huobao-backup/huobao.sqlite3.pre-121-*.bak`。

## 专用测试项目（不触碰真实项目）
- drama **24**「八达岭长城测试 1118」（drama 类型，16:9，documentary-archival 风格）/ episode **32**。
- character **78**「测试肖像人物」（appearance 含 `@参考图2`）、character **79**「零引用测试」、prop **296**「叶尔马克肖像画」。

## 验收证据（只读 DB + 截图，见 db-evidence.json）

### 1. 真实自动分类 + 自动采用
- prop 296 上传 17 世纪肖像油画 → 视觉判 **direct**（理由：17世纪风格油画原作，笔触/颜料老化/服饰符合历史肖像特征，无现代标注），**自动采用**：image_url=参考图路径，faithful=1，faithful_source=**4945**（upload/direct-adopt 版本）。
- character 78 上传同一幅欧洲肖像（资产名为明代将领戚继光）→ 判 **reference**（理由：人物形象与戚继光服饰画风不符）——分类基于图像与资产主体匹配，不靠名字猜，未误采用。现代标注地图 likewise reference。
- 改判路径：character 78 改名「测试肖像人物」后描述引用保留；prop 296 关保护（confirm_unfaithful）→ 200。

### 2. 保护与闸门
- prop 296 faithful=1 时 generate-image → 400（证据素材不能重绘）。
- PUT final_prompt 漏描述引用（desc 引 @参考图2，稿只引 1）→ 400 点名；补齐 → 200。

### 3. 按引用发送（真实 qwen-central）
- 任务 **4946**（character 78，final_prompt「以@参考图2的五官与甲胄为准」）：请求体 `prompt="以<image1>的五官与甲胄为准，纯白背景"`，reference_images 恰 1 张（肖像 file id），mode=image_edit；params.refNameIndex={"参考图2":1}，asset_citation=true。**completed**，产物 `static/images/6cb81b39-4375-47d8-a526-14b78e8902c4.png`。
- 任务 **4947**（character 79，零引用）：请求体 mode=text_to_image，无 reference_images，无泛化前缀。（提交时 processing，text_to_image 排队中；请求体已证明零发送。）

### 4. UI（生产 /huobao/ 入口，命名 session，0 页面错误）
- prop 296 弹窗：参考图编号徽标 1、用途徽标「可直接用」、保护开关；点「采用为资产图」→ faithful=1，faithful_source=**4948**，当前图更新（截图 01）。
- character 78 弹窗：样貌/妆造为 MentionTextarea（2 个），参考图编号/用途正常（截图 02）。

### 5. 套件与回归
- 后端 tsc 干净；引用契约测试 10/10；全量后端/前端失败名单与 main 逐条相同。
- 隔离 QA 全量证据见 `docs/qa/issue121-20261118/`（含扩写保留描述引用的真实 GLM 运行、删除编号重写、徽标查看器）。

## 已知偏差
- 分类对「图像与资产主体是否同一对象」敏感（欧洲肖像 vs 戚继光判 reference）——符合技能规则「不是同一对象的图仅参考」，非缺陷。
- 任务 4947 提交时仍在队列（text_to_image），请求体证据已足；完成产物略。