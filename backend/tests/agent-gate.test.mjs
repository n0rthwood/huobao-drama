/**
 * 全局 agent 并发闸（Issue #118 B）行为测试：
 * - 总量封顶：limit=2 时第 3 个 runAgent 排队，活跃数恒 ≤2；
 * - 交互优先：空槽先给 interactive 等待者（非抢占，运行中的不被打断）；
 * - 排队可取消：abort 即出队、reject，不占槽不泄漏，后续任务照常拿槽；
 * - env HUOBAO_AGENT_GLOBAL_CONCURRENCY 覆盖默认 2；
 * - runAgent 把等待时长记进 task_observed_work.agent_gate_ms（与端点 queue_ms 分列）。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

function run(script, env = {}) {
  const out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: { ...process.env, SQLITE_PATH: path.join(mkdtempSync(path.join(tmpdir(), 'agent-gate-')), 'test.sqlite3'), ...env },
  })
  return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
}

test('AgentGate 封顶、交互优先与取消不泄漏槽', () => {
  const result = run(`
    import { AgentGate } from './src/agents/agent-gate.ts'
    const gate = new AgentGate(2)
    const events = []
    let releaseA, releaseB
    const holdA = new Promise(r => { releaseA = r })
    const holdB = new Promise(r => { releaseB = r })
    const runA = gate.run({}, async () => { events.push('A:start'); await holdA; events.push('A:end') })
    const runB = gate.run({}, async () => { events.push('B:start'); await holdB; events.push('B:end') })
    await new Promise(r => setImmediate(r))
    // 两个槽被占：批量 C 与交互 D 都排队
    const runC = gate.run({}, async () => { events.push('C:start') })
    const controller = new AbortController()
    const runE = gate.run({ signal: controller.signal }, async () => { events.push('E:start') })
    const runD = gate.run({ interactive: true }, async () => { events.push('D:start'); await holdB; events.push('D:end') })
    await new Promise(r => setImmediate(r))
    const queuedStats = gate.stats()
    // 取消排队中的 E：立即 reject，不占槽
    controller.abort(new Error('cancelled'))
    let eError = null
    await runE.catch(err => { eError = err.message })
    const afterAbort = gate.stats()
    // 释放 A：空出的那个槽必须给交互 D（不是先排队的 C）；B 仍占着另一个槽，
    // D 拿到槽后也挂住（holdB），C 只能继续等
    releaseA()
    await runA
    await new Promise(r => setImmediate(r))
    const afterFirstRelease = [...events]
    releaseB()
    await Promise.all([runB, runC, runD])
    process.stdout.write('@@' + JSON.stringify({
      events, queuedStats, afterAbort, eError, afterFirstRelease, final: gate.stats(),
    }))
  `)
  assert.deepEqual(result.queuedStats, { active: 2, queued: 3, limit: 2 })
  assert.equal(result.eError, 'cancelled')
  // E 出队后只剩 C、D 排队；活跃仍是 2（取消不泄漏也不占用槽）
  assert.deepEqual(result.afterAbort, { active: 2, queued: 2, limit: 2 })
  // A 释放后 D（交互）先拿到槽，C 仍在等
  assert.ok(result.afterFirstRelease.includes('D:start'))
  assert.ok(!result.afterFirstRelease.includes('C:start'))
  assert.deepEqual(result.final, { active: 0, queued: 0, limit: 2 })
  assert.ok(result.events.indexOf('D:start') < result.events.indexOf('C:start'))
})

test('env 覆盖并发上限；非法值回退默认 2', () => {
  const custom = run(`
    import { agentGate } from './src/agents/agent-gate.ts'
    process.stdout.write('@@' + JSON.stringify({ limit: agentGate.limit }))
  `, { HUOBAO_AGENT_GLOBAL_CONCURRENCY: '3' })
  assert.equal(custom.limit, 3)
  const fallback = run(`
    import { agentGate } from './src/agents/agent-gate.ts'
    process.stdout.write('@@' + JSON.stringify({ limit: agentGate.limit }))
  `, { HUOBAO_AGENT_GLOBAL_CONCURRENCY: '0' })
  assert.equal(fallback.limit, 2)
})

test('runAgent 经全局闸执行并把等待记入 agent_gate_ms（不混入 queue_ms）', () => {
  const result = run(`
    import { runAgent } from './src/agents/run.ts'
    import { agentGate } from './src/agents/agent-gate.ts'
    import { runObservedWork, listObservedWork } from './src/services/task-observability.ts'
    import { runAsInteractiveAgent } from './src/agents/agent-gate.ts'
    // limit=1：第二个 runAgent 必须等第一个流读完
    const gate1 = agentGate
    const order = []
    let releaseFirst
    const hold = new Promise(r => { releaseFirst = r })
    const slowAgent = { stream: async () => {
      order.push('first:start')
      await hold
      order.push('first:end')
      return { getFullOutput: async () => ({ text: 'ok' }) }
    } }
    const fastAgent = { stream: async () => {
      order.push('second:start')
      return { getFullOutput: async () => ({ text: 'ok' }) }
    } }
    // 用 limit=1 的独立闸不行（runAgent 用模块级 agentGate）：先把唯一槽占住
    let releaseBlocker
    const blocker = gate1.run({}, () => new Promise(r => { releaseBlocker = r }))
    await new Promise(r => setImmediate(r))
    const first = runObservedWork({ taskId: 9101, stage: 'video_prompts', sourceChars: 10, sampleKey: 'gate-test' },
      () => runAgent(slowAgent, [], {}))
    const second = runObservedWork({ taskId: 9102, stage: 'video_prompts', sourceChars: 10, sampleKey: 'gate-test' },
      () => runAsInteractiveAgent(() => runAgent(fastAgent, [], {})))
    await new Promise(r => setTimeout(r, 60))
    releaseBlocker()
    // 槽释放后交互 second 先拿槽并立即跑完，first 才拿到槽开始流
    await second
    releaseFirst()
    await Promise.all([first, blocker])
    const works = [...listObservedWork(9101), ...listObservedWork(9102)]
    process.stdout.write('@@' + JSON.stringify({
      order,
      gateWaits: works.map(w => ({ task: w.task_id, gate: w.agent_gate_ms, queue: w.queue_ms })),
      final: gate1.stats(),
    }))
  `, { HUOBAO_AGENT_GLOBAL_CONCURRENCY: '1' })
  // limit=1：交互 second 先拿槽跑完，first 的流在其后；全程串行不重叠
  assert.deepEqual(result.order, ['second:start', 'first:start', 'first:end'])
  const secondWork = result.gateWaits.find(w => w.task === 9102)
  assert.ok(secondWork.gate > 0, '全局闸等待必须单独落盘')
  assert.equal(secondWork.queue, 0, '全局闸等待不得混入端点 queue_ms')
  assert.deepEqual(result.final, { active: 0, queued: 0, limit: 1 })
})
