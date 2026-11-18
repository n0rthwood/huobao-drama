/**
 * 流水线专用的 Mastra 实例（Issue #56）
 *
 * **独立实例、独立存储**：`src/mastra/index.ts` 的 agent 注册表保持 `storage` 为空，
 * 剧情项目的 Agent 链路零影响；工作流快照落在 `data/mastra-workflows.db`，
 * 与业务库 `data/huobao.sqlite3` 物理隔离（同进程内 libSQL 与 better-sqlite3 各开一个
 * 文件，避免共用一个 WAL）。
 *
 * 持久化实测（实施第一步的冒烟，2026-11-05，@mastra/core 1.78.0 + @mastra/libsql 1.29.0）：
 * 进程 A `createRun({runId}).start()` → 命中 `suspend()`；进程 B（全新进程）
 * `getWorkflowRunById(runId)` 读到 `status='suspended'`；进程 C `createRun({runId}).resume()`
 * 返回 `status='success'`。跨进程挂起/续跑可用，因此按 Issue 的首选方案走 Mastra Workflows。
 */
import path from 'path'
import { Mastra } from '@mastra/core'
import { LibSQLStore } from '@mastra/libsql'
import { DATA_ROOT } from '../../utils/paths.js'
import { assetPipelineWorkflow } from './workflow.js'

export const PIPELINE_DB_FILE = path.join(DATA_ROOT, 'mastra-workflows.db')

export const pipelineMastra = new Mastra({
  storage: new LibSQLStore({ id: 'huobao-asset-pipeline', url: `file:${PIPELINE_DB_FILE}` }),
  workflows: { assetPipeline: assetPipelineWorkflow },
  logger: false,
})
