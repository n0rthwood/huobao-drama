# 全应用 deeplink 盘点清单（Issue #86）

统一机制：`frontend/app/composables/useQuerySync.ts`
- 页面/面板/弹窗各自 `useDeeplink(分组名, DEEPLINK_KEYS.<组>)`，只声明并发布自己的键；
  store 合并全部分组后用**一次** `router.replace` 写出（单一所有者，父子互不抹键）。
- 组件卸载 → 分组自动 `release()`，它的键从 URL 移除 = 关闭子层逐层回到父级位置。
- 页面在初始数据就绪 + 各层恢复完成后调用一次 `deeplinkHydrate()`；在此之前只收集不写地址，
  链接里的深层参数不会被父级同步冲掉。
- 失效目标：清自己的键 + `deeplink.missing / missingNamed / locked` 可读提示 + 停在父级，绝不换目标冒充成功。
- 恢复只还原界面：不触发生成 / 保存 / 删除 / 审批 / 付款 / 重试；确认类弹窗可按公开实体 id 重建外壳，仍需人工点击。

键登记表：`DEEPLINK_KEYS`（`useQuerySync.ts`）。键名全局唯一；互斥界面（同一时刻只有一个在场）可共用同名键（如 `shot`），非当前所有者发布空值。

## 1. 路由

| 路由 | 文件 | deeplink 所有者 |
| --- | --- | --- |
| `/` | `pages/index.vue` | `home` |
| `/settings` | `pages/settings.vue` | `settings` + `settingsDialogs` |
| `/tasks` | `pages/tasks.vue`（内嵌 `TaskCenterPanel`） | `taskList` + `taskDetail` |
| `/drama/:id` | `views/drama/detail.vue` | `detail` + `detailDialogs` |
| `/drama/:id/episode/:n` | `views/drama/episode.vue` | `workbench` + `workbenchDialogs` + 各子面板分组 |
| `/dev/layer-canvas` | `pages/dev/layer-canvas.vue` | 生产构建不包含该页（`nuxt.config.ts` 剔除 `/dev/`），不纳入盘点 |

全局常驻：`layouts/default.vue` 的 `TaskCenterButton`（`taskDrawer`，跨路由 persistent）；`app.vue` 的 `MigrateOverlay`（`migrateOverlay` 组，`migrating=1`）；命令式挂载的语言切换确认框（`langSwitch` 组，`lang=<zh|en|ja|ko>`，由 `app.vue` 在挂载时恢复，切换仍需人工点确认；顺带修正了原本「取消也被当成确认」的 resolve 逻辑，恢复的弹窗取消时零后端写入）。

## 2. 清单（入口 / 父状态 / 实体标识 / URL 键 / 恢复结果）

### 2.1 首页 `pages/index.vue`
| 嵌套 UI | 键 | 恢复 | 失效处理 |
| --- | --- | --- | --- |
| 搜索词 | `q` | 输入框内容与过滤结果 | — |
| 状态筛选 | `status` | `all/draft/active/completed`（默认不写键） | 非法值回落默认 |
| 排序 | `sort` | `updated/title` | 非法值回落默认 |
| 新建项目弹窗 | `dlg=create` | 只开外壳，不预填/不提交表单 | — |
| 删除项目确认 | `dlg=delete:<dramaId>` | 按项目 id 重建确认框外壳，仍需人工点确认 | id 不在列表 → `deeplink.missing` + 清键 |
| 行内下拉菜单 `activeMenuId`/`statusMenuId` | 不入 URL | 指针瞬时悬浮菜单，刷新后无锚点元素，不是工作位置 | — |

### 2.2 设置页 `pages/settings.vue`
| 嵌套 UI | 键 | 恢复 | 失效处理 |
| --- | --- | --- | --- |
| 主页签 | `tab`（旧链接兼容） | ai/general/research/styles/agents/storage/about | 非法值静默回落 |
| Agent 子页签 / 选中 Agent | `pane`、`agent`（旧链接兼容） | 仅 `tab=agents` 时写出 | 非法值静默回落 |
| 模型配置新增/编辑弹窗 | `cfg=<id>` / `cfg=new:<service_type>` | 按 DB 行重建编辑态；新增只给空白预设 | 未知 id → `missingNamed` + 清键 |
| 技能编辑 / 新增 | `skill=<id>` / `skill=new` | 切到所属 Agent + `pane=skills` + 展开编辑器（只 GET） | 同上 |
| 风格新增/编辑 | `style=<id>` / `style=new` | 重建编辑态 | 同上 |
| 数据迁移弹窗 | `migrate=1` | 只开外壳；不恢复目标目录/勾选，不启动迁移 | 无目标时不执行 |
| 删除确认、连通性测试结果、TTS 音色列表 | 不入 URL | 未保存草稿 / 一次性测试结果（规则 §5） | — |

### 2.3 任务中心（抽屉 + `/tasks` 页，`TaskCenterButton` / `TaskCenterPanel` / `TaskDetailDialog`）
| 嵌套 UI | 键 | 恢复 | 失效处理 |
| --- | --- | --- | --- |
| 顶栏抽屉开关 | `tasks=1`（persistent，跨路由） | 抽屉打开并带宿主上下文（episodeId/dramaId） | 非 `1` 即摘键 |
| 列表筛选 | `tscope`、`tdrama`、`tep`、`ttype`、`tstatus` | setup 期同步恢复 → 首个请求就匹配链接 | 非法枚举/ id 由白名单丢弃 |
| 分页 | `tpage` | 首个请求即用该页；`total` 就绪后校验 | 越界 → 回第 1 页 + `deeplink.missing` |
| 展开的批量行 | `texp=<id,id>` | 列表加载后映射回父行 | 不在本页的 id 忽略 |
| 任务详情弹窗 | `task=<taskId>` | 先查 store，再按 id 取（跨页/跨筛选也能开） | 未知/已删 → `missingNamed` + 清键 |
| 详情审核模式 | `treview=1` | 恢复审核态，不自动审批 | — |
| 详情内「全屏正文」视图 | `tfull=1` | 任务解析成功后展开全文（只读取） | 非文本任务回落 false 并摘键 |
| `thinkingOpen` | 不入 URL | 由任务状态驱动（活动中展开、终态折叠），不是用户工作位置 | — |
| 重试模型选择 / `overwriteAsk` 覆盖确认 | 不入 URL | 动作载荷（规则 §5） | — |

### 2.4 项目详情页 `views/drama/detail.vue`
| 嵌套 UI | 键 | 恢复 | 失效处理 |
| --- | --- | --- | --- |
| 页签 / 素材类型筛选 | `tab`、`filter`（旧链接兼容） | episodes / assets + all/character/scene/prop | 非法值回落 |
| 素材编辑弹窗 | `asset=<kind>-<id>`（旧链接兼容） | 数据就绪后打开 | 素材已删 → `missingNamed` + 清键 |
| 图片大图 | `view=<kind>-<id>` | 按资产身份取当前图；签名/原始路径不入 URL | 素材缺失或无图 → `missingNamed` + 清键 |
| 资产浏览器弹窗 | `browser=1`（+ 内部 `bkind`/`bq` 由弹窗自身发布） | 外壳 + 内部类别页签/关键词 | 非法 `bkind` 回落全部 |
| 素材库弹窗（换图） | `lib=<kind>-<id>` | 先重绑宿主素材再开弹窗（不会出现无法回填的孤立弹窗） | 宿主 id 未知 → `missingNamed` + 清键 |
| 新增剧集 / 项目设置 | `addep=1` / `proj=1` | 只开外壳，不回填草稿、不自动保存 | — |
| 删除剧集 / 删除素材确认 | `del=episode-<id>` / `del=<kind>-<id>` | 按 id 重建确认框，必须人工点确认，恢复零删除请求 | id 不存在 → `missingNamed` + 清键 |

### 2.5 剧集工作台 `views/drama/episode.vue`
父层键（`workbench`，与旧链接逐字兼容）：`panel`、`step`、`tab`、`sub`、`extract`、`asset`。

| 嵌套 UI | 键 | 恢复 | 失效处理 |
| --- | --- | --- | --- |
| 面板 / 剧本子步骤 / 制作页签 / 资产子页签 / 提取筛选 | `panel`、`step`、`tab`、`sub`、`extract` | 与改动前一致；URL 显式给出即忽略 localStorage 记忆 | 非法值回落默认 |
| 资产详情弹窗 | `asset=<type>-<id>` | 数据就绪后打开；**URL 已显式给出面板/页签时保留原工作位置**（从设计卡复制的链接不再被拽回资产主步骤） | 资产已删 → `missingNamed` + 停在父级 |
| 资产弹窗内：语义条目定位 | `sem=<semanticId>` | 打开后滚动/高亮该条目 | 条目不存在时面板按原逻辑不高亮 |
| 资产弹窗内：地图编辑态 | `mapedit=1` | 重新进入 MapSpec 草稿编辑（道具且链接显式要求时） | 非道具/无资产则忽略 |
| 资产弹窗内：流水线轮次 | `run`、`round` | 优先于「最新一轮」默认定位，不先闪错轮次 | 不在列表 → 回落默认 + `missingNamed` |
| 图片大图 | `view=static/...` | 只接受本站 `static/` 媒体路径；外链 / `data:` / `blob:` 不入 URL | 路径非法 → `deeplink.missing`，不开大图 |
| 视频步选中分镜 | `shot=<storyboardId>` | 仅视频步由工作台发布（其余步骤由各自面板发布同名键） | 分镜不存在 → `missingNamed` |
| 多选上下文（导出勾选 / 视频批量勾选） | `sel=<id,id>` | 过滤到本集存在的分镜后恢复勾选 | 无存活 id 时不进入选择模式 |
| 工作台级弹窗 | `dlg=<身份>` | 见下表 | 未知取值 → `deeplink.missing` |

`dlg` 取值与恢复语义（全部只恢复界面，确认类仍需人工点击）：

| 取值 | 弹窗 | 说明 |
| --- | --- | --- |
| `roster` | 角色名册 | 重新 GET 名册（只读） |
| `create:<type>` | 新增资产 | 空白表单，不预填 |
| `delete:<type>-<id>` | 删除资产确认 | 按 id 重建，零删除请求 |
| `reextract:<type>-<id>` | 重新提取确认 | 需要资产弹窗父链，自动补开父级 |
| `faithful` | 取消原件确认 | 依附已打开的道具详情弹窗，父链不在则不弹 |
| `library:<kind>-<id>` | 素材库换图 | 宿主资产随键恢复 |
| `batch:<scope>` | 批量资产生成弹窗 | 只开壳，不提交 |
| `browser` | 资产浏览器 | 内部筛选由弹窗自身的 `bkind`/`bq` 恢复 |
| `narration-settings` | 旁白设置面板 | — |
| `breakdown` | 拆分分镜确认 | 不自动拆分 |
| `voice-batch` | 批量配音参数 | 范围取 `sel`；不自动提交（计费动作必须人工点） |
| `compose` | 批量融合 | 范围取 `sel`；恢复只读预览与进度 |
| `video-batch` | 批量视频确认 | 范围取 `sel`；只重取服务端**只读预览清单**，不提交生成 |
| `merge-confirm` | 拼接前确认 | 按当前 `sel` 重算纳入/排除 |
| `merge-delete:<mergeId>` | 删除成片确认 | 按成片 id 重建，零删除请求 |
| `subtitle-regen` | 重出全部字幕确认 | 不自动执行 |
| `merge:<mergeId>` | 成片大预览 | 按成片 id |
| `shot-preview:<sbId>` | 镜头素材预览 | 按分镜 id |

跨步骤出路（门禁提示、选择器空态）改为**应用内导航**：`DesignCardPanel` 的 `goto-step`、`AssetPicker` 的 `goto-assets` 冒泡到工作台切换 `panel`/`tab`，不再 `window.location.assign` 整页跳；被卸载的子面板自动释放自己的键。

### 2.6 分镜设计（`DesignCardPanel` + `AssetPicker`）
| 嵌套 UI | 键 | 恢复 | 失效处理 |
| --- | --- | --- | --- |
| 子阶段 | `phase=skeleton\|voice\|cards` | URL 为唯一来源；**已删除全局 `huobao:designPhase` localStorage 双轨**并在挂载时清理旧键（跨集污染修复） | 非法值回落 `cards` |
| 选中设计卡 | `shot=<storyboardId>`（稳定 id，不用镜号） | 分镜到位后恢复；恢复期间用户点镜优先 | 不在本集 → 保留默认首镜 + `missingNamed` |
| 资产/语义选择器 | `dpick=asset:reference_assets` / `semantic:must_mark` | 带宿主字段恢复（知道回填给哪张卡的哪个字段），只种入已保存值 | 门禁锁定 → `deeplink.locked` 并放弃恢复 |
| 选择器内部 | `pktype`、`pkq`、`drill=<kind>-<id>` | 类型栏 / 关键词 / 下钻到的素材（只在宿主传入清单里查） | 查不到 → 停在列表层 + `missingNamed` |
| 切换组合弹窗 | `dcombo=<storyboardId>` | 以存量 combo 重开，目标组合恒为空，绝不自动切换 | id 无效或该镜无 combo → `missingNamed` |
| 批量范围面板 | `dscope=fill\|confirm` | 重新现算「将处理/被排除」清单（纯计算） | 非法值忽略 |
| 卡片未保存草稿 | 不入 URL | 未保存数据（规则 §5） | — |

### 2.7 关键帧 / 分镜制作 / 成片
| 组件 | 键 | 恢复 | 失效处理 |
| --- | --- | --- | --- |
| `StoryboardKeyframes` | `shot`、`sel`、`pool=1` | 选中分镜、批量多选、资产池弹窗（镜稳定后再开，父链完整） | 未知 shot → 默认首镜 + `deeplink.missing`，且不恢复 `pool` |
| `StoryboardPoolDialog` | `poolkind`、`poolq` | 弹窗内部类别/关键词，仅挂载期间发布 | 非法枚举回落「全部」 |
| `ShotProductionPanel` | `shot`、`seg=layer\|gen`、`spdlg=combo\|rehearse\|scope` | 选中分镜 + 片段页签（按该镜 combo 校验）+ 弹窗外壳 | 缺失 id → `missing`；设计卡未确认 → `locked`；两者都回落默认并摘子键 |
| `DocumentaryFinalPanel` / `DocumentaryFinalShot` | `shot`、`sel`、`rehearse=<sbId>` | 选中/多选分镜、预演弹窗外壳（不自动起渲染） | 无效 id → 提示并摘键 |
| `VideoShotPanel` / `ExportPanel` | 复用工作台 `shot` / `sel` / `dlg` | 自身无独立嵌套状态 | — |

### 2.8 纪录片资产面板
| 组件 | 键 | 恢复 | 失效处理 |
| --- | --- | --- | --- |
| `AssetReviewPanel` | `arfilter`、`ardlg=ignore:<id>\|bind:<id>\|batch:<mode>` | 清单筛选 + 两个自持弹窗 + 批量弹窗（按当前筛选实时重算条目，不恢复快照与勾选） | 条目不存在 → `missingNamed` + 清键 |
| `AssetPipelinePanel` | `run`、`round` | 轮次定位优先于默认值，不先闪错轮次 | 不在列表 → 回落默认 + `missingNamed` |
| 审批意见 / 违规勾选 / 覆盖闸门 | 不入 URL | 未保存审批草稿；审批按钮仍需人工点 | — |
| `AssetBrowserDialog` | `bkind`、`bq` | 弹窗内部类别/关键词 | 非法枚举回落全部 |
| `MediaLibraryDialog` | `libnode`、`libpage`、`libview` | 左树下钻节点 → 分页 → 大图（按素材稳定身份，不用临时 URL） | 节点/页码/预览失效 → 回落宿主默认节点或第 1 页 + `missingNamed` |
| 素材库多选 | 不入 URL | 未保存挑选载荷，恢复也不会自动 confirm | — |

### 2.9 Poster / 剧本改写 / 旁白 / 图层
| 组件 | 键 | 恢复 | 失效处理 |
| --- | --- | --- | --- |
| `PosterPanel` / `PosterReferencePicker` | `posterpick=1`、`posterver=<id>` | 参考图选择器外壳 + 选中合成版本 | 版本不存在 → `missingNamed` + 回落默认 |
| `ScriptRewritePanel` | `rwstage`、`rwdlg=inspect` | 阶段选择 + 核查浮层 | 非法阶段回落 |
| `NarrationBlock` | `voice=<storyboardId>` | 单镜配音弹窗外壳（不自动生成配音 = 不触发计费） | 分镜不存在 → 提示并摘键 |
| `NarrationEditor` | `nedlg=check:<sbId>` / `pron:<sbId>:<start>-<end>:<源文字>` / `tone:<sbId>:<位置或区间>` / `pause:<sbId>:<位置或区间>` | 多音字检查浮层（纯本地词表计算）；注音/语气/停顿浮层带宿主分镜 + 正文区间 +（注音还带）源文字，恢复前用当前已保存正文逐字校验 | 校验不过（正文已改动）→ 浮层仍按链接上下文打开，但进入**只读态**：显示 `deeplink.staleRange` 说明、插入/自然停顿/确认全部禁用，绝不插到错位置 |
| `LayerImagePicker` / `LayerRail` / `LayerStyle` | `lpick=1`、`lpmode=source\|asset\|library` | 图层图片选择器开关 + 内部三态来源页签，绑定到选中图层 | 无选中图层 → 不开 |
| `ReferenceImageManager` | `reflib=<type>-<id>` | 参考图素材库弹窗 + 宿主资产（多实例只有宿主匹配的那个打开） | 宿主不匹配则不开 |
| `ArchivalImagePanel` | `arch=<characterId>`、`archq` | 史料检索浮层 + 关键词；**不自动发起外部检索**，由用户点一次 | 宿主不匹配则不开 |

## 3. 明确不入 URL（逐项理由）

| 项 | 理由 |
| --- | --- |
| `AppMenu` / `BaseSelect` / `ModelSelect` / `LocaleSwitcher` / `MentionTextarea` 下拉 | 指针瞬时菜单，随失焦关闭，没有可定位的工作位置，也没有内容状态 |
| `MigrateOverlay` 的「伪造进度」 | 遮罩本身已入 URL（`migrating=1`），但恢复只认真实迁移状态：刷新后没有在跑的迁移就摘键 + 提示，不凭链接假装有迁移 |
| 各类未保存草稿：设计卡草稿、图层/Poster 编辑器草稿、`MapSpecPanel`/`PropSemanticsPanel` 编辑、`NarrationFitPanel` 草稿、审批意见、导入勾选、选择器未确认多选 | 规则 §5：只恢复界面，不恢复未保存表单与敏感载荷 |
| 列表滚动位置（像素） | 只在需要定位实体时滚入视图，不把滚动写进 URL |
| `/dev/layer-canvas` | 生产构建不包含该路由 |

## 4. 迁移与兼容

- 既有链接键值不变：`panel/step/tab/sub/extract/asset`（工作台）、`tab/filter/asset`（项目详情）、`tab/pane/agent`（设置）。旧链接继续有效。
- `huobao:designPhase`（全局 localStorage）已删除：设计卡子阶段只认 URL，组件挂载时清理旧键，跨集污染消失。
- 工作台面板记忆 `huobao:workbench:panel:<drama>:<episode>` 保留（仅 reload 场景），URL 显式值优先。
