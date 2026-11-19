# Issue #123 生产验收报告 — 资产工作室双 TAB 草稿引擎 + 资产版本删除

日期：2026-11-19 · release `20261119T060530Z` · master `d505d424`（merge `0519c02a`）
验收对象：prop 273「伊丽莎白一世画像与猞猁」（drama 20 / episode 27，faithful=1，faithful_source=2874）
生产入口：`/huobao/asset-studio/2`（直达 URL，非 popup 跳转）

## 0. 用户原始问题的答案

| 问题 | 答案 |
| --- | --- |
| 两条「问题」提示 | 不是检测结果，是旧 `AssetPipeline.vue:30-31` 的两条固定文案：faithful 拦截（「该资产为受保护原件，不允许提交计费生图」）+ 无条件流程提示（「按事实表生成与核验，逐轮人工审批」）。新引擎删除了 faithful 拦截与固定提示，改为 faithful 徽标「受保护原件」+ 顾问性 QC。 |
| 参考图 0/3 | 根因：精确轮参考只读 `asset_studio_source`，用户上传的参考图存在 `props.reference_images` JSON，工作室只展示从不导入。修复：`syncUserReferences` 在 open/显式 sync/上传/删除时把资产参考图按 sha256 同步进素材池（origin=user_reference）。**直达 URL 验收证据**：打开 `/huobao/asset-studio/2` 即显示「我的参考图 1」（ec6b81d9…png，即用户上传的 555d3fc2 那张的内容寻址副本）。 |
| 素材 0 但检索有货 | 素材计数=已入库行；检索候选须人工选用。新 UI 分开显示「我的参考图 n」「已选图 n/3」「已存素材 n」，检索记录全部可见可展开，候选三按钮（选为参考/存为素材/采用为资产图）。 |
| 事实表空 | 旧 spec 只由 run 的 spec 步写入，task 2 从未启动 run。新模型 draft 展开即写 spec；detail 取最新 draft.spec_id。验收：精确草稿 spec_id=1（7 条 must_have / 5 条 forbidden），事实表面板非空。 |
| 页面不能滚动 | default 布局 `.shell/.content` overflow:hidden + `.as-page` 无滚动面。修复：`.as-page` 自身 `flex:1;min-height:0;overflow-y:auto`。验收：scrollHeight 2231 > clientHeight 1340，scrollTop 846 到底，「当前资产输入/历史轮次/交付记录/工作室设置」全部可达（截图 prod-studio-bottom-final.png）。 |
| 问题 C：只有参考图没有资产图 | 精确流程正常工作（参考图驱动，资产图非必需，0 图+文本/notes 也合法走 t2i）；美化流程禁用并提示「美化需要已有资产图，请先用精确流程生成或上传资产图」（validateDraftInputs 纯函数测试覆盖）。 |

## 1. 精确流程（prop-273，真实生图 1 张）

1. 直达 `/huobao/asset-studio/2` → onMounted `POST /tasks/2/sync` → 我的参考图出现 ec6b81d9…（0/3 修复证据）。
2. 勾选参考图 + 检索记录 1 的 Luchs187 候选（cbb1c411…，CC BY-SA 4.0）+ 1 条文本（Portraiture of Elizabeth I）→ 徽章「自己 + 检索」，已选图 2/3。
3. notes「伊丽莎白一世画像与猞猁的组合，三视图参考表」→「生成提示词草稿」→ draft 1 drafting→ready（~50s，真实文本配置）。
4. 事实表非空（spec v1，7 must_have / 5 forbidden）；prompt 含三视图模板词（`Object turnaround reference sheet: front view, side view, back view, plus close-up detail insets…`，1915 字符）；negative=forbidden 拼接。
5. 「确认并生图」→ ConfirmDialog 摘要：「参考图 2 张：ec6b81d9….png、cbb1c411….jpg；检索文本 1 条；模型：gpt-image-2。生图产物只落版本，不会自动改当前图。」（截图 prod-confirm-dialog.png）
6. 确认 → run 2（precision）→ ~60s completed → **round 2 / image_task 4952**，1659×948，sha 31a1ea09…，reference_images=[{source #2, ec6b81d9}, {source #3, cbb1c411}]（候选自动入库 origin=research 拿 source id）。
7. 顾问性 QC：gate PASS，coverage 100%（不阻断）。
8. 「仅存为版本」→ deliver(set_as_current=false) → versionId 4952，fidelity=verified reason「程序闸门通过（第 0 轮，清单覆盖率 100%，顾问性），采用即人工确认」。
9. **负向断言（DB 只读）**：prop 273 image_url 仍为 cc7d2fa9…（4944），faithful=1，faithful_source=2874 不变。popup 版本列表出现 4952。

## 2. 美化流程（prop-273，真实生图 1 张）

1. 美化 TAB → 版本选择器 3 个版本，默认选中当前图 4944（openai · gpt-image-2 · 当前采用）。
2. notes「提升光影与质感，保持人物、猞猁与构图不变」→「生成美化提示词」→ draft 2 drafting→ready（~8s，asset_beautify 视觉环节看 4944 图）。
3. prompt 展示（1503 字符）：`Refine this existing 1600×914 landscape evidence-comparison asset in place, preserving its exact two-panel layout, scale, placement and camera framing…`（保持构图约束 + notes 融合）。
4. 确认摘要：「参考图 1 张：cc7d2fa9….png；检索文本 0 条；模型：gpt-image-2」→ run 3（beautify）→ ~45s completed → **round 3 / image_task 4953**，1659×948（按所选版本图宽高取 bucket，保持画幅），reference_images=[{unknown, cc7d2fa9}]，QC 跳过（美化无 spec）。
5. 「仅存为版本」→ versionId 4953。当前图/faithful/faithful_source 仍不变。

## 3. 版本删除（生产探针 + 真删）

| 探针 | 结果 |
| --- | --- |
| `DELETE /props/273/image-versions/4944`（当前生效图） | 400「当前生效版本不能删除，请先切换到其他版本」 |
| `DELETE /props/273/image-versions/2874`（faithful_source） | 400「该版本是受保护原件的来源，不能删除」 |
| `DELETE /characters/2/image-versions/999999` | 404「版本不存在或不属于该资产」（端点挂载证明） |
| `DELETE /scenes/2/image-versions/999999` | 404「版本不存在或不属于该资产」（端点挂载证明） |
| `DELETE /props/273/image-versions/4953`（美化测试版本，真删） | 200 `{deleted:true, id:4953, files_removed:true}` |

**DB 只读核对**：sys_task 4953 行 GONE；delivery(run 3).version_id=NULL（交付历史保留、指针置空）；文件 7adaed1f….png 不存在；4952 行与文件保留；prop 273 版本列表=[2874, 4944, 4952]。
**UI 核对**：刷新后美化 round 3 卡显示「版本已删除」徽标、无图、无交付按钮；精确 round 2 卡正常（图+仅存为版本/采用为当前图）。
三类资产参数化成功删除+四守卫测试：`backend/tests/asset-image-version.test.mjs`（4/4 pass）。

## 4. 滚动与截图

- `.as-page` overflow-y:auto，scrollHeight 2231 / clientHeight 1340，scrollTop 846 到底（atBottom=true）。
- 截图（本目录）：`prod-studio-top-final.png`（顶部：资产全量信息+双 TAB+参考图+检索记录）、`prod-studio-bottom-final.png`（底部：历史轮次+交付记录+工作室设置）、`prod-confirm-dialog.png`（精确生图确认摘要）、`studio-bottom.png`/`studio-precision-top.png`（隔离 QA）。

## 5. 预算台账

| 项 | 数量 | 明细 |
| --- | --- | --- |
| 生产生图 | 2 张 | 4952（精确，gpt-image-2）、4953（美化，gpt-image-2，已删除） |
| 生产文本调用 | 3 次 | draft 1 展开（asset_spec + asset_studio_prompt）、draft 2 展开（asset_beautify 视觉） |
| 生产 QC 视觉 | 1 次 | round 2 顾问性 QC（asset_qc） |
| 隔离 QA 文本 | 3 次 | worktree 副本 draft 1/2 展开（同配置，不计生产预算） |
| 失败重试 | 0 | 无超额，未触发 4 张上限 |

## 6. 测试与发布

- backend 全量 838 tests / 828 pass / 10 fail — 失败集合与 master **完全一致**（预存结构测试）。
- frontend 全量 165 tests / 146 pass / 19 fail — 失败集合与 master **完全一致**。
- 新增测试：asset-image-version（4）、asset-studio-draft 状态机（8）、asset-studio-draft-ui（3）、contract validateDraftInputs（5）、references draftReferenceImages 改写、gate 删 decideRound。
- 发布前 SQLite backup API 备份：`~/huobao-backup/huobao.sqlite3.pre-123-<ts>`；release.sh smoke 全 200；`ss -ltnp 'sport = :5679'` 确认 PM2 新进程监听；新路由 `/huobao/api/v1/asset-studio/tasks/2/versions|drafts|research` 返回 JSON 非 SPA。
- 幂等补列（source.origin、research.instruction/keywords）+ 新表 asset_studio_draft 启动自动应用。

## 7. 已知展示瑕疵（不阻断，记录待后续）

- 「已选图 n/3」计数在连续快速勾选时有一拍渲染延迟（Vue 响应式批处理 + 轮询重渲染竞态），静置后正确；最终确认摘要与后端 validate 的图数始终一致（2 张）。生产验收以确认摘要与 round.reference_images 为准。