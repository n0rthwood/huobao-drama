/**
 * 三阶段真实计量与 ETA 的边界口径（Issue #87 §D）。只测容易被悄悄改坏的几条硬规则：
 * - 分组键不混池：骨架整集 / 设计卡逐镜 / TTS 按合成参数各自成池；
 * - 没有同口径样本就是没有估计（null + eta_unknown_reason），不编固定秒数；
 * - 当前项已用要从剩余里扣掉，超过预估时标 overrun 而不是显示 0；
 * - 失败 / 中断样本不进成功样本池；终态任务不再倒计时，时间不随 Date.now() 增长；
 * - 设计卡「显式空选」= 0 镜，绝不扩大成整集默认范围。
 *
 * 运行方式与仓库既有后端用例一致（tsx + 临时 SQLITE_PATH），由主集成者统一执行。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

function run(script) {
  const out = execFileSync('node', [
    '--import', 'tsx', '--input-type=module', '--eval', script,
  ], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: { ...process.env, SQLITE_PATH: path.join(mkdtempSync(path.join(tmpdir(), 'task-estimate-')), 'test.sqlite3') },
  })
  return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
}

test('sample keys never mix stages, endpoints or TTS parameters', () => {
  const result = run(`
    import { buildSampleKey } from './src/services/task-estimate.ts'
    const voice = (over) => buildSampleKey({
      stage: 'voice', configId: 7, model: 'voxcpm',
      voice: { voice: 'a', inference_timesteps: 10, cfg_value: 2, seed: null, instructions: '', normalize: true, ...over },
    })
    console.log('@@' + JSON.stringify({
      skeleton: buildSampleKey({ stage: 'skeleton', configId: 1, model: 'm' }),
      card: buildSampleKey({ stage: 'design_card', configId: 1, model: 'm' }),
      otherConfig: buildSampleKey({ stage: 'design_card', configId: 2, model: 'm' }),
      noConfig: buildSampleKey({ stage: 'design_card', configId: null, model: '' }),
      base: voice(),
      steps: voice({ inference_timesteps: 30 }),
      timbre: voice({ voice: 'b' }),
      normalize: voice({ normalize: false }),
      instructions: voice({ instructions: '慢速、庄重' }),
      otherInstructions: voice({ instructions: '轻快、口语' }),
      seedFixed: voice({ seed: 7 }),
      seedOther: voice({ seed: 8 }),
    }))
  `)
  // 整集一次调用与逐镜一次调用的耗时量级完全不同，必须分池
  assert.notEqual(result.skeleton, result.card)
  assert.notEqual(result.card, result.otherConfig)
  assert.equal(result.noConfig, 'design_card|cfg:none|model:unknown')
  for (const key of ['steps', 'timbre', 'normalize', 'instructions', 'seedFixed']) {
    assert.notEqual(result[key], result.base, `TTS ${key} must not share a pool with the base params`)
  }
  // 明显慢语速与快语速的指令必须分池；不同固定 seed 也不是同一份参数档案
  assert.notEqual(result.instructions, result.otherInstructions)
  assert.notEqual(result.seedFixed, result.seedOther)
})

test('no comparable sample means no estimate, never a fabricated duration', () => {
  const result = run(`
    import { buildWorkPlan, estimateObservedWork, estimateWorkPlan } from './src/services/task-estimate.ts'
    const plan = buildWorkPlan({
      stage: 'design_card', unit: 'shot', sampleKey: 'design_card|cfg:1|model:m',
      items: [{ storyboard_id: 1, storyboard_number: 1, source_chars: 40 }],
    })
    console.log('@@' + JSON.stringify({
      single: estimateObservedWork({ stage: 'design_card', sampleKey: 'design_card|cfg:1|model:m', sourceChars: 40 }),
      batch: estimateWorkPlan(plan),
      plannedChars: plan.planned_source_chars,
    }))
  `)
  assert.equal(result.single, null)
  assert.deepEqual(result.batch, { estimate_ms: null, sample_count: 0, basis: null })
  assert.equal(result.plannedChars, 40)
})

test('serial ETA subtracts the current item, flags overrun, and freezes on terminal tasks', () => {
  const result = run(`
    import { eq } from 'drizzle-orm'
    import { db, schema, sqlite } from './src/db/index.ts'
    import { getTaskWorkSummary } from './src/services/task-estimate.ts'
    import { listObservedWork } from './src/services/task-observability.ts'

    const stamp = '2026-01-01'
    const sampleKey = 'design_card|cfg:1|model:m'
    const plan = {
      stage: 'design_card', unit: 'shot', sample_key: sampleKey, planned_units: 3, planned_source_chars: 300,
      items: [
        { storyboard_id: 11, storyboard_number: 1, source_chars: 100 },
        { storyboard_id: 12, storyboard_number: 2, source_chars: 100 },
        { storyboard_id: 13, storyboard_number: 3, source_chars: 100 },
      ],
    }
    await db.insert(schema.sysTask).values({
      id: 500, type: 'text', status: 'processing', episodeId: 1,
      params: JSON.stringify({ kind: 'design_card', work_plan: plan }),
      createdAt: stamp, updatedAt: stamp,
    })
    // 持久化观测事实直接落库；本用例只验证 ETA 计算，不调用模型。
    const workStmt = sqlite.prepare('INSERT INTO task_observed_work (id, task_id, stage, source_chars, sample_key, storyboard_id, storyboard_number, started_at, finished_at, status, model_ms, queue_ms, work_ms, heartbeat_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    const work = (id, sbId, status, startedAt, finishedAt, modelMs, workMs) =>
      workStmt.run(id, 500, 'design_card', 100, sampleKey, sbId, sbId - 10, startedAt, finishedAt, status, modelMs, 0, workMs, finishedAt ?? startedAt, startedAt)

    const t0 = 1_800_000_000_000
    await work(1, 11, 'completed', t0, t0 + 10_000, 9_000, 10_000)   // 100 字 / 10s → 100ms/字
    await work(2, 12, 'failed', t0 + 10_000, t0 + 12_000, 1_000, 2_000) // 失败样本不进速率池
    await work(3, 13, 'processing', t0 + 12_000, null, 0, 0)

    const running = getTaskWorkSummary(500, t0 + 15_000)
    await db.update(schema.sysTask).set({ status: 'completed' }).where(eq(schema.sysTask.id, 500))
    const frozen = getTaskWorkSummary(500, t0 + 999_000)
    const frozenLater = getTaskWorkSummary(500, t0 + 9_999_000)
    console.log('@@' + JSON.stringify({
      rate: running.rate,
      currentElapsed: running.current.elapsed_ms,
      currentEstimate: running.current.estimate_ms,
      overrun: running.current.overrun,
      remaining: running.eta.remaining_ms,
      failed: running.failed_units,
      frozenEta: frozen.eta,
      frozenReason: frozen.eta_unknown_reason,
      stable: frozen.work_wall_ms === frozenLater.work_wall_ms && frozen.updated_at === frozenLater.updated_at,
      works: listObservedWork(500).length,
    }))
  `)
  // 速率只用 1 个成功样本（失败那条不算）
  assert.equal(result.rate.sample_count, 1)
  assert.equal(result.rate.basis, 'current_batch')
  assert.equal(result.failed, 1)
  // 当前项预计 10s、已用 3s → 剩余只剩 7s（没有未开始项）
  assert.equal(result.currentEstimate, 10_000)
  assert.equal(result.currentElapsed, 3_000)
  assert.equal(result.overrun, false)
  assert.equal(result.remaining, 7_000)
  // 终态：不再倒计时，时间不随 now 增长
  assert.equal(result.frozenEta, null)
  assert.equal(result.frozenReason, 'terminal')
  assert.equal(result.stable, true)
})

test('explicit empty storyboard selection fills nothing instead of the whole episode', () => {
  const result = run(`
    import { db, schema } from './src/db/index.ts'
    import { startDesignCardBatch } from './src/services/design-card-batch.ts'

    const stamp = '2026-01-01'
    await db.insert(schema.dramas).values({ id: 1, title: 'd', createdAt: stamp, updatedAt: stamp })
    await db.insert(schema.episodes).values({ id: 1, dramaId: 1, episodeNumber: 1, title: 'e', createdAt: stamp, updatedAt: stamp })
    for (const id of [1, 2, 3]) {
      await db.insert(schema.storyboards).values({
        id, episodeId: 1, storyboardNumber: id, designCardStatus: 'blank', createdAt: stamp, updatedAt: stamp,
      })
    }
    const empty = await startDesignCardBatch(1, 1, {}, [])
    console.log('@@' + JSON.stringify({ empty }))
  `)
  assert.deepEqual(result.empty, { started: false, total: 0 })
})

test('video prompt summary counts only its planned stage, not junction-caption work in the same task (#104)', () => {
  const result = run(`
    import { db, schema, sqlite } from './src/db/index.ts'
    import { getTaskWorkSummary } from './src/services/task-estimate.ts'

    const stamp = '2026-01-01'
    const sampleKey = 'video_prompts|cfg:1|model:m'
    await db.insert(schema.sysTask).values({
      id: 600, type: 'text', status: 'processing', episodeId: 1,
      params: JSON.stringify({ kind: 'video_prompts', work_plan: {
        stage: 'video_prompts', unit: 'shot', sample_key: sampleKey, planned_units: 2, planned_source_chars: 200,
        items: [{ storyboard_id: 21, storyboard_number: 1, source_chars: 100 }, { storyboard_id: 22, storyboard_number: 2, source_chars: 100 }],
      } }),
      createdAt: stamp, updatedAt: stamp,
    })
    const workStmt = sqlite.prepare('INSERT INTO task_observed_work (id, task_id, stage, source_chars, sample_key, storyboard_id, storyboard_number, started_at, finished_at, status, model_ms, queue_ms, work_ms, heartbeat_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    const t0 = 1_800_000_000_000
    workStmt.run(11, 600, 'junction_caption', 0, 'junction_caption|cfg:10|model:d', 21, 1, t0, t0 + 1_000, 'completed', 900, 0, 1_000, t0 + 1_000, t0)
    workStmt.run(12, 600, 'junction_caption', 0, 'junction_caption|cfg:10|model:d', 22, 2, t0 + 1_000, t0 + 2_000, 'completed', 900, 0, 1_000, t0 + 2_000, t0)
    workStmt.run(13, 600, 'video_prompts', 100, sampleKey, 21, 1, t0 + 2_000, t0 + 32_000, 'completed', 29_000, 0, 30_000, t0 + 32_000, t0)
    const summary = getTaskWorkSummary(600, t0 + 33_000)
    console.log('@@' + JSON.stringify({ stage: summary.stage, completed: summary.completed_units, planned: summary.planned_units, samples: summary.rate?.sample_count }))
  `)
  assert.equal(result.stage, 'video_prompts')
  assert.equal(result.completed, 1)
  assert.equal(result.planned, 2)
  assert.equal(result.samples, 1)
})
