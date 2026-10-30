/**
 * 视频时间估计选数规则（Issue #28）：纯函数在 TS 里，
 * 用仓库自带的 tsx 子进程跑并以 JSON 回传结果（不碰数据库）。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

function estimate(samples, provider, model, duration) {
  const script = `
    import { selectVideoEstimate } from './src/services/video-estimate.ts'
    const [samples, provider, model, duration] = JSON.parse(process.env.VE_INPUT)
    process.stdout.write(JSON.stringify(selectVideoEstimate(samples, provider, model, duration)))
  `
  const out = execFileSync('npx', ['tsx', '--eval', script], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: { ...process.env, VE_INPUT: JSON.stringify([samples, provider, model, duration]) },
  })
  return JSON.parse(out)
}

const s = (model, durationSeconds, elapsedSeconds, provider = 'comfyui') =>
  ({ provider, model, durationSeconds, elapsedSeconds })

test('same-model same-duration bucket uses median elapsed (basis=model-duration)', () => {
  const result = estimate(
    [
      s('m1', 10, 300), s('m1', 10.4, 500), s('m1', 9.6, 100), // 桶内 |d-10|≤0.5 → 中位数 300
      s('m1', 30, 9000),
    ],
    'comfyui', 'm1', 10,
  )
  assert.equal(result.supported, true)
  assert.equal(result.basis, 'model-duration')
  assert.equal(result.run_seconds, 300)
  assert.equal(result.samples, 3)
  assert.equal(result.source_model, null)
  assert.equal(result.provider, 'comfyui')
  assert.equal(result.requested_model, 'm1')
  assert.equal(result.duration, 10)
})

test('duration bucket boundary is inclusive at exactly 0.5s', () => {
  for (const [d, inBucket] of [[10.5, true], [9.5, true], [10.51, false], [9.49, false]]) {
    const result = estimate([s('m1', d, 777)], 'comfyui', 'm1', 10)
    if (inBucket) {
      assert.equal(result.basis, 'model-duration', `d=${d} 应在桶内`)
      assert.equal(result.run_seconds, 777)
    } else {
      // 只剩 1 条非桶内样本，不满足缩放的 ≥3 条 → 不支持
      assert.equal(result.supported, false, `d=${d} 应在桶外`)
    }
  }
})

test('no bucket but >=3 samples scales by median elapsed/duration ratio (basis=model-scaled)', () => {
  const result = estimate(
    [s('m1', 6, 600), s('m1', 8, 800), s('m1', 10, 1200)], // 比值 100/100/120 → 中位数 100
    'comfyui', 'm1', 12,
  )
  assert.equal(result.supported, true)
  assert.equal(result.basis, 'model-scaled')
  assert.equal(result.run_seconds, 1200)
  assert.equal(result.samples, 3)
  // 请求 12s 恰好无同时长样本 → 走缩放
  const near = estimate([s('m1', 6, 600), s('m1', 8, 900), s('m1', 12.6, 1200)], 'comfyui', 'm1', 12)
  assert.equal(near.basis, 'model-scaled')
  assert.equal(near.run_seconds, 1200)
})

test('falls back to another model of the same provider with source_model', () => {
  // 先同时长中位数
  const byBucket = estimate([s('m2', 10, 480)], 'comfyui', 'm1', 10)
  assert.equal(byBucket.basis, 'fallback-model')
  assert.equal(byBucket.source_model, 'm2')
  assert.equal(byBucket.run_seconds, 480)
  assert.equal(byBucket.samples, 1)
  // 再比值缩放
  const byScale = estimate(
    [s('m2', 4, 400), s('m2', 6, 620), s('m2', 8, 800)], // 比值中位数 ~100（620/6≈103.3 → 中位 100? 排序 100,100,103.33 → 100）
    'comfyui', 'm1', 20,
  )
  assert.equal(byScale.basis, 'fallback-model')
  assert.equal(byScale.source_model, 'm2')
  assert.equal(byScale.run_seconds, 2000)
})

test('does not fall back across providers', () => {
  const result = estimate([s('other', 10, 480, 'minimax')], 'comfyui', 'm1', 10)
  assert.equal(result.supported, false)
  assert.equal(result.basis, 'none')
  assert.equal(result.source_model, null)
  assert.equal(result.run_seconds, null)
  assert.equal(result.samples, 0)
})

test('no samples → supported=false', () => {
  const result = estimate([], 'comfyui', 'm1', 10)
  assert.equal(result.supported, false)
  assert.equal(result.basis, 'none')
})

test('bad samples (elapsed<=0 or duration<=0) are excluded', () => {
  const result = estimate(
    [
      s('m1', 10, 0), s('m1', 10, -5), s('m1', 0, 300), s('m1', 10, null), s('m1', null, 300),
      s('m1', 10, 260), // 唯一有效样本，落入 10s 桶
    ],
    'comfyui', 'm1', 10,
  )
  assert.equal(result.supported, true)
  assert.equal(result.basis, 'model-duration')
  assert.equal(result.run_seconds, 260)
  assert.equal(result.samples, 1)
  // 全部无效 → 不支持
  const none = estimate([s('m1', 10, 0), s('m1', -1, 300)], 'comfyui', 'm1', 10)
  assert.equal(none.supported, false)
})

test('configModelList parses JSON array model column and single legacy value', () => {
  const script = `
    import { configModelList } from './src/services/video-estimate.ts'
    const input = JSON.parse(process.env.MODEL_INPUT)
    process.stdout.write(JSON.stringify(input.map(configModelList)))
  `
  const out = execFileSync('npx', ['tsx', '--eval', script], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      MODEL_INPUT: JSON.stringify([
        { model: '["MiniMax-H3-INT8-ComfyUI","MiniMax-H3-FastH3-Omni-INT8"]' },
        { model: 'MiniMax-H3-ComfyUI' },
        { model: 'a, b ' },
        { model: '' },
        null,
        { model: '[1,"ok",2]' },
      ]),
    },
  })
  assert.deepEqual(JSON.parse(out), [
    ['MiniMax-H3-INT8-ComfyUI', 'MiniMax-H3-FastH3-Omni-INT8'],
    ['MiniMax-H3-ComfyUI'],
    ['a', 'b'],
    [],
    [],
    ['ok'],
  ])
})
