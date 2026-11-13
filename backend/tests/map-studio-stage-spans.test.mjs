/**
 * 阶段跨度与调用归属（Issue #99 阶段②）的行为测试。
 *
 * 验收口径：
 * - 两个阶段 → 两条真实观测调用各自归属到包含它 started_at 的跨度；
 * - 跨度之间的空隙与全部跨度之外是 null（不按阶段顺序猜「应该属于哪个阶段」）；
 * - 未结束跨度只在进程活着时覆盖调用；重启恢复链按已冻结的中断时刻收尾成 interrupted，
 *   之后记录的调用不会再被那个跨度吞掉，迟到的执行退出也不会改写已冻结的结论；
 * - 坏条目丢弃或标 unknown，绝不冒充 completed；
 * - /runs/:id/observed 的每条调用带 stage。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { test } from 'node:test'

const backend = fileURLToPath(new URL('..', import.meta.url))

test('Stage spans attribute observed calls by containment only, and a restart freezes open spans at the interruption timestamp', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'map-studio-stage-spans-'))
  const script = `
    import assert from 'node:assert/strict'
    import { initMapStudio, mapStudioRoutes } from './src/modules/map-studio/index.ts'
    import { createStandaloneTask } from './src/modules/map-studio/tasks.ts'
    import { insertRun, patchRunParams, readRunParams, selectRun } from './src/modules/map-studio/db.ts'
    import { beginStageSpan, closeOpenStageSpans, endStageSpan, readStageSpans, stageForCall, stageForCallInSpans } from './src/modules/map-studio/stage-spans.ts'
    import { listObservedCalls, observeTextCall, runObservedWork } from './src/services/task-observability.ts'

    const platform = {
      async submitImage() { throw Error('stage-span test must not submit billed images') },
      async pollImage() { return { status: 'missing', path: null, error: 'missing' } },
      async legacyResearchKeys() { return {} },
    }
    await initMapStudio(platform)

    async function observedCall(runId, label) {
      await runObservedWork({ taskId: runId, scope: 'map_studio', stage: 'map_studio', sourceChars: label.length, sampleKey: 'stage-span' }, async () => {
        const send = observeTextCall({ kind: 'llm', configId: null, model: 'fake' }, async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: label }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } }))
        const response = await send('https://no-network.invalid/chat', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: label }] }) })
        await response.text()
      })
    }
    const task = await createStandaloneTask({ title: '阶段跨度归属' })
    const runId = insertRun({ taskId: task.task_id, mode: 'manual', startStage: 'brief', stage: 'brief', textConfigId: null, imageConfigId: null, imageModel: null, params: { map_texture_ref: 'kept-ref' } })

    await observedCall(runId, 'brief call')
    await new Promise(resolve => setTimeout(resolve, 8))
    await observedCall(runId, 'research call')
    const calls = listObservedCalls(runId, { scope: 'map_studio' })
    assert.equal(calls.length, 2)
    const briefCall = calls[0]
    const researchCall = calls[1]
    assert.ok(researchCall.started_at > briefCall.started_at)

    const briefStart = briefCall.started_at - 40
    const briefEnd = briefCall.started_at + 2
    const researchStart = briefCall.started_at + 5
    assert.ok(researchCall.started_at >= researchStart, 'fixture: the second call must start after the research span opens')
    const researchEnd = researchCall.started_at + 20

    assert.deepEqual(beginStageSpan(runId, 'brief', briefStart), { stage: 'brief', started_at_ms: briefStart, finished_at_ms: null, outcome: 'running' })
    assert.equal(readRunParams(runId).map_texture_ref, 'kept-ref', 'span writes must not drop other run params')
    assert.deepEqual(endStageSpan(runId, 'brief', 'completed', briefEnd), { stage: 'brief', started_at_ms: briefStart, finished_at_ms: briefEnd, outcome: 'completed' })
    beginStageSpan(runId, 'research', researchStart)
    endStageSpan(runId, 'research', 'completed', researchEnd)

    assert.equal(stageForCall(runId, briefCall.started_at), 'brief')
    assert.equal(stageForCall(runId, researchCall.started_at), 'research')
    assert.equal(stageForCall(runId, briefStart - 1), null, 'before every span is null')
    assert.equal(stageForCall(runId, briefCall.started_at + 3), null, 'a gap between spans has no stage instead of the nearest one')
    assert.equal(stageForCall(runId, researchEnd + 1), null, 'after every span is null')

    const nested = [
      { stage: 'brief', started_at_ms: 1000, finished_at_ms: 5000, outcome: 'completed' },
      { stage: 'research', started_at_ms: 2000, finished_at_ms: 3000, outcome: 'completed' },
      { stage: 'base', started_at_ms: 4000, finished_at_ms: null, outcome: 'running' },
    ]
    assert.equal(stageForCallInSpans(nested, 1500), 'brief')
    assert.equal(stageForCallInSpans(nested, 2500), 'research', 'overlapping spans resolve to the innermost (latest start)')
    assert.equal(stageForCallInSpans(nested, 4500), 'base', 'an open span covers calls that already started inside it')
    assert.equal(stageForCallInSpans(nested, 5001), 'base', 'the open base span continues past the closed brief span')
    assert.equal(stageForCallInSpans(nested, 0), null)

    const drawingStart = Date.now()
    beginStageSpan(runId, 'drawing', drawingStart)
    assert.ok(endStageSpan(runId, 'drawing', 'failed', drawingStart + 10))
    assert.equal(endStageSpan(runId, 'drawing', 'failed', drawingStart + 20), null, 'ending twice must not write a second record')
    assert.equal(readStageSpans(runId).filter(span => span.stage === 'drawing').length, 1)
    assert.throws(() => endStageSpan(runId, 'drawing', 'ok'), TypeError, 'an unregistered outcome is a caller error, never recorded')
    assert.throws(() => closeOpenStageSpans(runId, 'running', Date.now()), TypeError)
    assert.equal(beginStageSpan(999999999, 'brief'), null, 'no run row means no fabricated span')
    assert.equal(stageForCall(999999999, drawingStart), null)

    const observed = await mapStudioRoutes.request('/runs/' + runId + '/observed')
    assert.equal(observed.status, 200)
    const body = (await observed.json()).data
    assert.deepEqual(body.calls.map(call => [call.id, call.stage]), [[briefCall.id, 'brief'], [researchCall.id, 'research']])

    // 模拟后端重启：在飞运行标中断，未结束跨度按同一个冻结时刻收尾
    const run2 = insertRun({ taskId: task.task_id, mode: 'auto', startStage: 'research', stage: 'research', textConfigId: null, imageConfigId: null, imageModel: null, params: { map_texture_ref: 'kept-ref-2' } })
    const spanStart = Date.now()
    beginStageSpan(run2, 'research', spanStart)
    await observedCall(run2, 'in-flight call')
    const inFlight = listObservedCalls(run2, { scope: 'map_studio' })[0]
    await initMapStudio(platform)

    const interrupted = selectRun(run2)
    assert.equal(interrupted.status, 'interrupted')
    const frozenMs = Date.parse(interrupted.finished_at)
    const frozenSpans = readStageSpans(run2)
    assert.equal(frozenSpans.length, 1)
    assert.equal(frozenSpans[0].outcome, 'interrupted', 'restart closes the open span with the interruption outcome')
    assert.equal(frozenSpans[0].finished_at_ms, frozenMs, 'the span ends exactly at the persisted interruption timestamp')
    assert.equal(readRunParams(run2).map_texture_ref, 'kept-ref-2', 'restart keeps the other run params')
    assert.equal(stageForCall(run2, inFlight.started_at), 'research', 'the in-flight call stays attributed to the interrupted run stage')

    await new Promise(resolve => setTimeout(resolve, 10))
    await observedCall(run2, 'after restart')
    const afterRestart = listObservedCalls(run2, { scope: 'map_studio' }).pop()
    assert.ok(afterRestart.started_at > frozenMs, 'fixture: the later call starts after the frozen interruption')
    assert.equal(stageForCall(run2, afterRestart.started_at), null, 'a closed span must never swallow calls recorded after the restart')
    assert.equal(endStageSpan(run2, 'research', 'completed', afterRestart.started_at), null, 'a stale execution exit cannot rewrite the frozen outcome')
    assert.deepEqual(readStageSpans(run2), frozenSpans)
    const route2 = await mapStudioRoutes.request('/runs/' + run2 + '/observed')
    assert.equal(route2.status, 200)
    assert.deepEqual((await route2.json()).data.calls.map(call => call.stage), ['research', null])

    // 坏条目：丢弃或标 unknown，绝不冒充完成
    patchRunParams(run2, { stage_spans: [
      { stage: 'brief' },
      { stage: 'nope', started_at_ms: 1 },
      { stage: 'brief', started_at_ms: 'soon' },
      { stage: 'base', started_at_ms: 10, finished_at_ms: 5, outcome: 'running' },
      { stage: 'drawing', started_at_ms: 1, finished_at_ms: 2, outcome: 'ok' },
    ] })
    assert.deepEqual(readStageSpans(run2), [
      { stage: 'base', started_at_ms: 10, finished_at_ms: 10, outcome: 'unknown' },
      { stage: 'drawing', started_at_ms: 1, finished_at_ms: 2, outcome: 'unknown' },
    ])
    patchRunParams(run2, { stage_spans: [{ stage: 'style', started_at_ms: 500, finished_at_ms: null, outcome: 'running' }] })
    assert.equal(closeOpenStageSpans(run2, 'cancelled', 100), 1)
    assert.deepEqual(readStageSpans(run2), [{ stage: 'style', started_at_ms: 500, finished_at_ms: 500, outcome: 'cancelled' }], 'closing never writes an end before the start')
    assert.equal(closeOpenStageSpans(run2, 'cancelled', 200), 0, 'already closed spans are left alone')
    console.log('MAP_STUDIO_STAGE_SPANS_OK')
  `
  try {
    const output = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], { cwd: backend, encoding: 'utf8', timeout: 120000, env: { ...process.env, SQLITE_PATH: path.join(dir, 'test.sqlite3'), HUOBAO_DATA_DIR: dir, STORAGE_PATH: path.join(dir, 'static') } })
    assert.match(output, /MAP_STUDIO_STAGE_SPANS_OK/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
