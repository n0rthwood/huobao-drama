/**
 * 资产流水线的步骤时限与分数归一化（Issue #56）
 *
 * 由来：实测出现过「某一步十几分钟不返回、任务中心既不前进也不失败」。
 * 单次 fetch 的 `AbortSignal.timeout` 管不住一个步骤（可能两次请求 + 读库 + 等图），
 * 所以步骤级时限必须 ① 到点 abort 掉正在飞的请求 ② 抛出能直接写进 error_msg 的人话。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

const script = `
  import { abortableSleep, describeStepError, STEP_DEADLINE_MS, StepTimeoutError, withStepDeadline } from './src/services/asset-pipeline/deadline.ts'
  import { normalizeScore } from './src/services/asset-pipeline/gate.ts'

  // tsx --eval 以 CJS 产出，顶层 await 不可用：整段包进 async IIFE
  const main = async () => {
  const out = {}

  // 正常返回：原值透出，不受时限影响
  out.fast = await withStepDeadline('spec', async () => 'ok', { timeoutMs: 5000 })

  // 超时：拿到 StepTimeoutError，且传进去的 signal 真的被 abort 了
  let seenSignal = null
  try {
    await withStepDeadline('spec', (signal) => {
      seenSignal = signal
      return new Promise(() => {})   // 永不返回，模拟模型连上却不吐字
    }, { timeoutMs: 120 })
    out.timeout = { threw: false }
  } catch (err) {
    out.timeout = {
      threw: true,
      name: err.name,
      step: err.step,
      message: err.message,
      aborted: seenSignal.aborted,
      abortReasonName: seenSignal.reason?.name ?? null,
    }
  }

  // 超时后输给竞速的那个 Promise 稍后拒绝：不能变成 unhandledRejection
  let lateReject
  try {
    await withStepDeadline('qc', () => new Promise((_, reject) => { lateReject = reject }), { timeoutMs: 60 })
  } catch {}
  lateReject(new Error('迟到的失败'))
  await new Promise(resolve => setTimeout(resolve, 120))
  out.survivedLateRejection = true

  // 底层抛 TimeoutError/AbortError（fetch 的中止）→ 翻成人话
  out.mappedTimeout = describeStepError('research', Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }), 1000).message
  out.mappedAbort = describeStepError('research', Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }), 1000).name
  // 业务错误原样透出，不被当成超时吞掉
  out.mappedPlain = describeStepError('spec', new Error('事实表为空：模型没有给出任何 must_have 条目'), 1000).message

  // 步骤默认时限：出图那步必须比等图（20 分钟）更长，否则永远是外层先炸、看不到等图的人话
  out.deadlines = STEP_DEADLINE_MS
  out.isTimeoutError = new StepTimeoutError('spec', 60_000) instanceof Error

  // 可中止 sleep：abort 之后立刻返回，不睡满间隔
  const controller = new AbortController()
  const started = Date.now()
  setTimeout(() => controller.abort(), 40)
  await abortableSleep(5000, controller.signal)
  out.sleepElapsed = Date.now() - started

  // 分数归一化：同一列里 0.95 与 95 必须是同一个意思
  out.scores = {
    ratio: normalizeScore(0.95),
    percent: normalizeScore(95),
    one: normalizeScore(1),
    zero: normalizeScore(0),
    over: normalizeScore(150),
    negative: normalizeScore(-3),
    text: normalizeScore('95'),
    missing: normalizeScore(undefined),
  }

  console.log(JSON.stringify(out))
  }
  main()
`

const results = JSON.parse(
  execFileSync('npx', ['tsx', '--eval', script], { cwd: backendRoot, encoding: 'utf8' }),
)

test('未超时的步骤原样返回', () => {
  assert.equal(results.fast, 'ok')
})

test('步骤超时抛 StepTimeoutError 并 abort 底层请求', () => {
  assert.equal(results.timeout.threw, true)
  assert.equal(results.timeout.name, 'StepTimeoutError')
  assert.equal(results.timeout.step, 'spec')
  assert.equal(results.timeout.aborted, true, '必须真的 abort 传下去的 signal，否则请求还挂在连接池里')
  assert.equal(results.timeout.abortReasonName, 'StepTimeoutError')
})

test('超时消息是能直接写进 error_msg 的人话', () => {
  assert.match(results.timeout.message, /事实表/)
  assert.match(results.timeout.message, /已中止该步的请求/)
  // 120 ms 的时限不能被四舍五入成「0 分钟」，不足一分钟按秒写
  assert.match(results.timeout.message, /1\.2 秒|0\.1 秒/)
})

test('竞速失败方的迟到拒绝不会打爆进程', () => {
  assert.equal(results.survivedLateRejection, true)
})

test('底层 TimeoutError/AbortError 翻成人话，业务错误原样透出', () => {
  assert.match(results.mappedTimeout, /「资料研究」步超过/)
  assert.equal(results.mappedAbort, 'StepTimeoutError')
  assert.equal(results.mappedPlain, '事实表为空：模型没有给出任何 must_have 条目')
  assert.equal(results.isTimeoutError, true)
})

test('出图步的时限长于等图上限，让等图那层先报自己的原因', () => {
  assert.ok(results.deadlines.generate > 20 * 60_000)
  assert.equal(results.deadlines.research, 10 * 60_000)
  assert.equal(results.deadlines.spec, 10 * 60_000)
  assert.equal(results.deadlines.qc, 10 * 60_000)
})

test('abort 后的轮询 sleep 立刻返回', () => {
  assert.ok(results.sleepElapsed < 1000, `实际等了 ${results.sleepElapsed}ms`)
})

test('QC 分数统一归一到 0–100', () => {
  assert.equal(results.scores.ratio, 95)
  assert.equal(results.scores.percent, 95)
  assert.equal(results.scores.one, 100)
  assert.equal(results.scores.zero, 0)
  assert.equal(results.scores.over, 100)
  assert.equal(results.scores.negative, 0)
  assert.equal(results.scores.text, null)
  assert.equal(results.scores.missing, null)
})
