# Issue #122 实施契约（资产工作室模块抽取）

基线 worktree：`/home/joysort/projects/huobao-drama-issue-122`（分支 issue/122-asset-studio，origin/master 0d485867）。
模板：`backend/src/modules/map-studio/`（#99）+ `services/map-studio-host.ts` + `frontend/app/map-studio/`。先读它们再动手。

## 模块边界（硬约束，边界测试强制）
- 新目录 `backend/src/modules/asset-studio/**`，唯一出口 `index.ts` / `contract.ts`。
- 模块**不得 import 火宝业务模块**。允许的外部依赖（相对 src/）：
  `db/index.js`（只取 sqlite/getInsertId）、`utils/{paths,storage,response,task-logger}.js`、
  `services/{ai-stages,ai,vision-chat,task-observability}.js`、`services/semantics-geometry.js`。
  npm：hono/zod/sharp/better-sqlite3/drizzle-orm/@mastra/*。
- 一切火宝业务（资产表读写、生图提交、风格词、画幅、提示词失效、语义标注、审核清单钩子、研究 key）经 **Platform/Host 注入**。
- 边界测试照抄 `tests/map-studio-boundary.test.mjs` 改 root 与 allowed 集合（前后端各一）。

## 契约（contract.ts，唯一允许火宝 import 的面）
```ts
export type AssetStudioHostRef = string // 'character:<id>' | 'scene:<id>' | 'prop:<id>'
export interface AssetStudioTarget { title: string; subtitle: string | null; return_path: string | null }
export interface AssetStudioAssetSnapshot {
  kind: 'character'|'scene'|'prop'; id: number; dramaId: number; episodeId: number | null
  name: string; description: string | null; appearance?: string | null; styling?: string | null
  prompt?: string | null; lighting?: string | null
  imageUrl: string | null; faithful: boolean; isMap: boolean
  referenceImages: { path: string; usage?: string }[]
  // 启动时冻结的输入指纹（描述/图/参考图），历史回看与迟到交付防护用
}
export interface AssetStudioHost {
  id: string // 'huobao'
  describe(ref): Promise<AssetStudioTarget | null>
  readAsset(ref): Promise<AssetStudioAssetSnapshot | null> // 每次读最新
  // original 素材入库后的自动采用（#121 adoptDirectImage）；返回是否采用
  adoptOriginal(ref, imagePath: string): Promise<{ adopted: boolean; reason?: string }>
  // 交付：把选定轮次图设为资产当前图（人选）+ 出处；幂等（同 run 同 sha）；
  // 比对冻结指纹，外部已改动 → 抛错要求人确认（409）
  deliver(ref, d: { runId: number; roundId: number; imagePath: string; sha256: string; setAsCurrent: boolean; sources: unknown[]; frozenFingerprint: string }): Promise<{ versionId: number | null; message: string }>
  // 事实表出新版本 → 最终提示词失效（走火宝 planFinalPromptWrite 出口）
  invalidateFinalPrompt(ref, specVersion: number): Promise<void>
  // 语义核验输入（QC 用）：labels + 期望坐标
  semanticsContext(ref): Promise<{ labels: string[]; expected: { id: string; name: string; at: [number,number] }[] }>
}
export interface AssetStudioPlatform {
  // 轮次生图：宿主实现为火宝图片任务（pipelineRound/studio_round 标记，完成只落版本不回写当前图）
  submitImage(input: { hostRef: AssetStudioHostRef; episodeId: number | null; prompt: string; negativePrompt?: string; size?: string; aspectLocked?: boolean; referenceImages: string[]; referenceOrigins?: unknown[]; configId?: number | null; model?: string | null; roundKey: string }): Promise<{ taskId: number }>
  pollImage(taskId: number): Promise<{ status: 'pending'|'completed'|'failed'|'cancelled'|'missing'; path: string | null; error: string | null }>
  // 认领崩溃窗口已下单任务（owner+prompt+时间窗）
  adoptOrphanImage(hostRef: AssetStudioHostRef, prompt: string, since: string): Promise<number | null>
  stylePrompt(dramaId: number): Promise<string | null>
  sceneSize(dramaId: number): Promise<string>
  researchKeys(): Promise<Record<string,string>> // 模块设置为空时种子
  // 语义保存核验（checkSemanticsPreserved）：返回 gate 用的 semanticsPreserved 结构
  checkSemantics(input: { hostRef: AssetStudioHostRef; absPath: string; labelsReadable?: { text: string; readable: boolean }[] }): Promise<unknown>
}
```
（字段可按实现微调，但 Host/Platform 职责划分不变；contract.ts 不 import 业务模块。）

## 持久化（db.ts，照 map-studio/db.ts 的 stmt() 模式）
四张模块表 + 搬入四张事实表（旧表数据不迁移，新表名加 studio 前缀避免与旧表冲突）：
- `asset_studio_task(id, host_ref UNIQUE WHERE deleted_at IS NULL, title, created_at, updated_at, deleted_at)`
- `asset_studio_run(id, task_id, prev_run_id, mastra_run_id, status['running'|'suspended'|'interrupted'|'completed'|'failed'|'cancelled'], purpose, params JSON[冻结输入/reference_source_ids/image_config_id/image_model/fingerprint/progress/result], error_msg, created_at, updated_at, completed_at)`
- `asset_studio_setting(key, value)`（研究 key、默认模型）
- `asset_studio_delivery(id, run_id, round_id, image_sha256, version_id, set_as_current, created_at, UNIQUE(run_id, image_sha256))`
- 事实表搬入：`asset_studio_source/spec/round/qc_record`（结构同旧 asset_source/asset_spec/asset_round/asset_qc_record，store.ts 改原生 SQL；round 唯一索引 (run_id, round_no)）。
`initAssetStudio(platform)` 幂等建表 + 注入 platform；`registerAssetStudioHost(host)`。

## 引擎迁移（逻辑不重写）
- 搬入：workflow.ts/steps.ts/gate.ts/generator.ts(选择器留宿主?见下)/references.ts/prompts.ts/deadline.ts/contract.ts(轮次去向 planNextRound)/semantics-check.ts(改经 platform.checkSemantics)/mastra.ts。
- run.ts 重写容器：startAssetPipeline → 建 asset_studio_run（不再 createTextTask）；driveRun 终态写 run 表；suspended 保持；approveRound/cancelRun 改读 run 表；resumeAssetPipelines → resumeAssetStudioRuns：suspended 保持等审批；running → 标 interrupted 冻结；再次运行 = 新 run（prev_run_id 关联），generate 幂等按 (task 的 run 链, round_no) 认领已下单任务（platform.adoptOrphanImage）。
- steps.ts：sys_task.params 读写 → run.params（模块 store）；loadAssetTarget → host.readAsset；generateImage → platform.submitImage；waitForImageTask → platform.pollImage；getDramaStylePrompt/assetImageSizeForDrama → platform；invalidateFinalPromptForSpec → host.invalidateFinalPrompt；semanticsLabelsToCheck/checkSemanticsPreserved → host.semanticsContext/platform.checkSemantics；getAssetResearch/performResearch → 模块内 research（见下）。
- generator.ts 的 pickGenerator/resolveImageSelection（读 ai_service_configs）→ 移到宿主 platform？不：模型选择经 platform 新增 `resolveImageSelection({configId,model})` 与 `pickGenerator` 所需配置读取。**简化**：platform 增 `imageSelection(input): Promise<{configId:number|null; model:string|null; generator:string}>`，模块只消费结果。sizeBucketFor 是纯函数留模块。
- research：asset-research/run.ts + sources.ts 搬入模块 research/；sys_task 容器 → asset_studio_run 无关，研究是独立一次性执行：用模块自己的 `asset_studio_research(id, host_ref, status, step, result, created_at...)` 表（或并入 run 表 kind 区分——选独立表更清晰）。performResearch 的 callTextChat/jsonChat 留模块；getResearchApiKey → platform.researchKeys + 模块 setting。
- base-candidates.ts 留火宝（读资产库），经宿主路由暴露（不进模块）。

## 宿主适配（services/asset-studio-host.ts）
实现 AssetStudioHost + AssetStudioPlatform，注册进 index.ts：
- describe/readAsset：读 characters/scenes/props + episodes（episodeId 取资产关联集，多集取第一个）；fingerprint = sha256(描述字段+imageUrl+参考图路径列表)。
- adoptOriginal → #121 adoptDirectImage。
- deliver：事务内登记/复用版本行（provider='asset-studio'，params 带 run/round/sha/sources，**不重复登记**：引用既有轮次版本行——轮次生图任务完成时已落版本行，deliver 只更新 delivery 表 + 可选设当前图）；setAsCurrent=true 时写 image_url/local_path（faithful 资产拒绝设当前图？不：faithful 资产根本不允许跑流水线，启动时阻断）；比对 fingerprint，外部改动 → 抛 AssetStudioDeliveryConflict（路由 409）。出处写 research_citations（照 map-studio-host registerSourceCitations）。
- submitImage → generateImage({...pipelineRound:true})（沿用 #56 候选隔离标记）；pollImage 读 sys_task；adoptOrphanImage 照 steps.ts 现逻辑。
- invalidateFinalPrompt → classifyPromptInvalidation/planFinalPromptWrite（现 steps.ts 逻辑搬来）。
- semanticsContext/checkSemantics → asset-semantics.ts/semantics-check.ts 现逻辑。
- imageSelection → generator.ts 的 resolveImageSelection/pickGenerator 搬来宿主。
- researchKeys → app-settings getResearchApiKey 全量。

## 路由（modules/asset-studio/routes.ts，挂 /api/v1/asset-studio）
照 map-studio/routes.ts 形状：
- GET /tasks、POST /tasks/open {host_ref}（复用或新建，带资产快照）、GET /tasks/:id（详情+当前 run+轮次+审批状态）、GET /tasks/:id/runs（运行历史）
- POST /tasks/:id/run {purpose, source_ids?, config_id?, model?, text_config_id?}（启动新 run；faithful/地图启动前阻断）
- POST /runs/:id/approve（原 approve 契约：round_id/verdict/selected_violations/notes/opened/override_gate/next_purpose）、POST /runs/:id/cancel
- POST /tasks/:id/research、GET /tasks/:id/research（模块研究）
- GET /tasks/:id/sources、POST /sources（入库，original → host.adoptOriginal）、DELETE /sources/:id
- POST /runs/:id/deliver {round_id, set_as_current}（409 冲突）
- GET /runs/:id/observed、GET /calls/:id/messages（runObservedWork scope='asset_studio'，照 map-studio）
- GET /settings、PUT /settings、GET /model-options
- 观测：每阶段 runObservedWork({scope:'asset_studio'})，run.params.stage_spans 归属（照 map-studio run.ts）。

## 火宝侧清理
- index.ts：import 模块、registerAssetStudioHost、initAssetStudio(platform)、api.route('/asset-studio', ...)；删除 asset-pipeline import/route/resumeAssetPipelines 调用 → resumeAssetStudioRuns。
- 删除 routes/asset-pipeline.ts、services/asset-pipeline/**、services/asset-research/**（搬入模块）。
- task-center.ts/task-retry.ts：删除 asset_pipeline 分支与 failInterruptedTextTasks 豁免；**旧 sys_task kind='asset_pipeline' 父行保留只读可见**（通用渲染不删，只删内嵌审批与重试）。
- base-candidates：留 services/asset-pipeline/base-candidates.ts？它被 episodes 路由用——移到 services/asset-studio-base-candidates.ts（火宝侧），更新 import。
- 前端：删除 AssetPipelinePanel.vue/AssetResearchPanel.vue 内嵌（episode.vue 资产弹窗区块、TaskDetailDialog reviewRunId）；资产弹窗加「打开资产工作室」入口（仅 documentary，map 资产仍走地图工作室）→ POST /asset-studio/tasks/open 后跳 /asset-studio/:taskId。
- 新前端 frontend/app/asset-studio/（pages index/task + components）：照 map-studio 结构，面板 = 阶段/检索/逐轮生图+QC+闸门/审批/运行历史/交付/设置。原 AssetPipelinePanel 的审批表单逻辑搬进模块前端组件。deeplink 全套（#86）。
- nuxt.config.ts 注册 /asset-studio 路由；顶栏入口（layouts 里地图工作室旁）。
- locales 四语：assetStudio.* 词条（可复用 episode.documentary.pipeline.* 现有键，迁移到 assetStudio 命名空间或保留引用——选保留现有键引用，减少翻译量，新增键四语同步）。

## 验收（生产留痕，专用测试项目）
见 Issue #122 正文验收 1–8。隔离 QA 先行（5689/3023，DB 副本）。

## 分工（两个子任务，同一 worktree，按文件划分避免冲突）
- **BackendSlice**：模块后端 + 宿主适配 + index.ts + 火宝清理 + 边界测试（后端）。不改 frontend/。
- **FrontendSlice**：模块前端 + episode.vue/detail.vue/TaskDetailDialog 清理 + nuxt.config + locales + 边界测试（前端）。不改 backend/。
- 契约以本文件为准；接口形状如需调整，BackendSlice 定稿后 write agent://FrontendSlice 通知。