/**
 * 视频队列（h3-jobs，Issue #100）进度归一化：队列 remote_state → 进度环属性 / 集级汇总。
 * 前端显示「第几位 · 预计开始 · 预计完成」与「阶段 · 步数 · 剩余」都只读这里的输出。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('../app/composables/useTaskProgress.ts', import.meta.url), 'utf8')
  .replace(/^import .*$/m, "const ref = v => ({ value: v }); const onScopeDispose = () => {}; const getCurrentScope = () => null")
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const { ringPropsFromTask, summarizeTasks } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

const now = Date.parse('2026-11-13T10:00:00.000Z')
const snapshotAt = new Date(now).toISOString()

test('a queued queue job shows its position, start and finish estimates', () => {
  const ring = ringPropsFromTask({
    status: 'queued',
    remote_state: {
      remote_status: 'queued',
      queue: { position: 2, length: 5, estimated_start_seconds: 140 },
      estimate: { run_seconds: 61, basis: 'measured', samples: 12, duration_key: 5 },
      estimated_finish_seconds: 201,
      updated_at: snapshotAt,
    },
  }, now)
  assert.equal(ring.status, 'queued')
  assert.equal(ring.queuePosition, 2)
  assert.equal(ring.queueLength, 5)
  assert.equal(ring.startSeconds, 140)
  assert.equal(ring.etaSeconds, 201)
  assert.equal(ring.phase, '')
})

test('a running queue job exposes phase, step and remaining time, counting down from the snapshot', () => {
  const ring = ringPropsFromTask({
    status: 'processing',
    remote_state: {
      remote_status: 'running',
      progress: { phase: 'sampling', step: 3, total_steps: 8, fraction: 0.42, elapsed_seconds: 25, remaining_seconds: 36 },
      estimated_finish_seconds: 36,
      updated_at: new Date(now - 6000).toISOString(),
    },
  }, now)
  assert.equal(ring.status, 'running')
  assert.equal(ring.phase, 'sampling')
  assert.equal(ring.step, 3)
  assert.equal(ring.totalSteps, 8)
  assert.equal(ring.remainingSeconds, 30, '6 s since the snapshot are taken off')
  assert.ok(ring.fraction > 0.42 && ring.fraction < 1)
  assert.equal(ring.queuePosition, null)
})

test('the episode summary counts a submitting task (no remote id yet) as queued and keeps the latest finish', () => {
  const summary = summarizeTasks([
    { status: 'processing', remote_state: { progress: { phase: 'decoding', fraction: 0.9, elapsed_seconds: 90, remaining_seconds: 10 }, estimate: { run_seconds: 100 }, estimated_finish_seconds: 10, updated_at: snapshotAt } },
    { status: 'queued', remote_state: { queue: { position: 1, length: 1, estimated_start_seconds: 10 }, estimate: { run_seconds: 100 }, estimated_finish_seconds: 110, updated_at: snapshotAt } },
    { status: 'queued', remote_state: null },
  ], now)
  assert.equal(summary.total, 3)
  assert.equal(summary.running, 1)
  assert.equal(summary.queued, 2)
  assert.equal(summary.etaSeconds, 110)
  assert.ok(summary.progress > 0 && summary.progress < 0.5)
})
