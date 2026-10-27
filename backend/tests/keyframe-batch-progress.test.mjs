/**
 * 关键帧批次聚合的行为测试：整批进度/剩余时间/计数。
 * 纯函数在 TS 里，用仓库自带的 tsx 子进程跑并以 JSON 回传结果（不碰数据库）。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

function aggregate(items, remoteByTask) {
  const script = `
    import { aggregateBatchItems } from './src/services/keyframe-batch-progress.ts'
    const [items, remote] = JSON.parse(process.env.BATCH_INPUT)
    process.stdout.write(JSON.stringify(aggregateBatchItems(items, remote)))
  `
  const out = execFileSync('npx', ['tsx', '--eval', script], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: { ...process.env, BATCH_INPUT: JSON.stringify([items, remoteByTask]) },
  })
  return JSON.parse(out)
}
const item = (id, state, taskId) => ({
  storyboard_id: id, storyboard_number: id, slot: 'first', state, task_id: taskId ?? null, error: null,
})

test('batch progress weights items by measured run_seconds and reports counts', () => {
  const result = aggregate(
    [item(1, 'completed', 11), item(2, 'running', 12), item(3, 'queued', 13), item(4, 'skipped')],
    {
      11: { estimate: { run_seconds: 100, basis: 'measured', samples: 5 } },
      12: { estimate: { run_seconds: 100, basis: 'measured', samples: 5 }, progress: { fraction: 0.5, remaining_seconds: 50 } },
      13: { estimate: { run_seconds: 100, basis: 'measured', samples: 5 }, queue: { position: 4, length: 9 } },
    },
  )

  // 完成 1 + 运行中 0.5 + 排队 0，权重相同 → 1.5 / 3
  assert.equal(result.progress, 0.5)
  assert.deepEqual(result.counts, {
    pending: 0, queued: 1, running: 1, completed: 1, failed: 0, cancelled: 0, skipped: 1,
  })
  assert.equal(result.items[2].queue_position, 4)
  assert.equal(result.items[1].remaining_seconds, 50)
  // 跳过项不参与进度，也没有远端字段
  assert.equal(result.items[3].progress, 0)
  assert.equal(result.items[3].estimated_finish_seconds, null)
})

test('batch eta is the max estimated_finish_seconds over unfinished items', () => {
  const result = aggregate(
    [item(1, 'running', 11), item(2, 'queued', 12), item(3, 'completed', 13)],
    {
      11: { estimated_finish_seconds: 40 },
      12: { estimated_finish_seconds: 300 },
      13: { estimated_finish_seconds: 9999 },
    },
  )
  // 两张卡并发出图：整批剩余是最大值而非求和；已完成项不计入
  assert.equal(result.eta_seconds, 300)
})

test('batch without any remote estimate still reports a finite progress and no eta', () => {
  const result = aggregate([item(1, 'completed', 11), item(2, 'pending')], {})
  assert.equal(result.progress, 0.5)
  assert.equal(result.eta_seconds, null)
})
