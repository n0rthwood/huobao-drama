import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'

function transpile(source, replacements = []) {
  let text = source
  for (const [from, to] of replacements) text = text.replace(from, to)
  return ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
}

const dockSource = transpile(readFileSync(new URL('../app/map-studio/utils/mapDock.ts', import.meta.url), 'utf8'))
const dock = await import(`data:text/javascript;base64,${Buffer.from(dockSource).toString('base64')}`)

const apiSource = readFileSync(new URL('../app/map-studio/api.ts', import.meta.url), 'utf8').replace("import { apiBase } from '~/utils/url'", "const apiBase = () => '/huobao/api/v1'")
const api = await import(`data:text/javascript;base64,${Buffer.from(transpile(apiSource)).toString('base64')}`)

function detail(overrides = {}) {
  return {
    task_id: 7,
    title: '地图',
    host: null,
    stage: 'style',
    status: 'awaiting_review',
    mode: 'manual',
    stop_at: null,
    revision: 12,
    busy: false,
    run_id: null,
    text_config_id: null,
    image_config_id: null,
    image_model: null,
    error: null,
    error_detail: null,
    updated_at: null,
    brief: { subject: '安阳' },
    steps: [],
    issues: [],
    research: null,
    map_spec: null,
    outputs: { base_image: { path: 'b.png', width: 10, height: 10 }, texture_image: null, final_image: null, kmz: null, layer_doc: null, layer_options: {} },
    history: [],
    agent: { run_id: null, rounds: {}, rollbacks: 0, attempts: [] },
    deliveries: [],
    runs_summary: { latest: null, count: 0 },
    ...overrides,
  }
}

const BASE = { briefDirty: false, geometryDirty: false, conflict: false, pendingCount: 0, hostMissing: false }
const action = over => dock.mapDockAction({ detail: detail(over), ...BASE, ...(over.input ?? {}) })

test('唯一主动作优先级：运行 → 未知结果 → 冲突 → 草稿 → 阻塞/失败 → 正常阶段', () => {
  const running = dock.mapDockAction({ detail: detail({ status: 'running' }), ...BASE })
  assert.equal(running.code, 'none')
  assert.equal(running.reason, 'running')
  assert.deepEqual(dock.mapDockSecondary(detail({ status: 'running' })), ['cancel', 'refresh', 'activity'], '运行中禁止回退')

  const unknown = dock.mapDockAction({ detail: detail(), ...BASE, resultUnknown: true })
  assert.equal(unknown.code, 'verifyResult')
  const conflicted = dock.mapDockAction({ detail: detail(), ...BASE, conflict: true })
  assert.equal(conflicted.code, 'resolveConflict')
  const dirty = dock.mapDockAction({ detail: detail({ status: 'failed' }), ...BASE, briefDirty: true })
  assert.equal(dirty.code, 'saveBrief', '失败状态也必须先保存需求草稿')
  const geoDirty = dock.mapDockAction({ detail: detail({ status: 'failed' }), ...BASE, geometryDirty: true })
  assert.equal(geoDirty.code, 'saveGeometry')
  const hostGone = dock.mapDockAction({ detail: detail(), ...BASE, hostMissing: true })
  assert.equal(hostGone.code, 'none')
  assert.equal(hostGone.reason, 'hostMissing')

  const blocked = action({ status: 'blocked', issues: [{ field: 'brief', code: 'missing', message: '缺对象', blocking: true }] })
  assert.equal(blocked.code, 'resolveProblems')
  assert.deepEqual(dock.mapDockSecondary(detail()), ['refresh', 'activity', 'rollback'])
})

test('正常阶段：检索/底图用 guided/base，确认与渲染分开，交付走 advance', () => {
  const brief = action({ stage: 'brief', brief: { subject: '安阳' }, status: 'idle' })
  assert.equal(brief.code, 'search')
  assert.deepEqual(dock.mapDockRequest(brief, detail()), { kind: 'run', mode: 'guided', stopAt: 'base' })

  const noSubject = action({ stage: 'brief', brief: { subject: '' }, status: 'idle' })
  assert.equal(noSubject.code, 'completeBrief')
  assert.deepEqual(dock.mapDockRequest(noSubject, detail()), { kind: 'none' }, '补全需求不发 run')

  const research = action({ stage: 'research', status: 'idle' })
  assert.equal(research.code, 'search')
  const base = action({ stage: 'base', status: 'idle' })
  assert.equal(base.code, 'search')

  const pending = action({ stage: 'drawing', outputs: { base_image: { path: 'b.png', width: 10, height: 10 }, final_image: null }, input: { pendingCount: 2 } })
  assert.equal(pending.code, 'confirm', '有待确认要素先确认')
  assert.deepEqual(dock.mapDockRequest(pending, detail()), { kind: 'confirm' })

  const ready = action({ stage: 'drawing' })
  assert.equal(ready.code, 'render')
  assert.deepEqual(dock.mapDockRequest(ready, detail()), { kind: 'run', mode: 'guided', stopAt: 'drawing' })

  const noBase = action({ stage: 'style', outputs: { base_image: null } })
  assert.equal(noBase.code, 'reviewBase')

  const deliver = action({ stage: 'complete', status: 'awaiting_review', outputs: { base_image: { path: 'b.png', width: 10, height: 10 }, final_image: { path: 'f.png', width: 10, height: 10 } } })
  assert.equal(deliver.code, 'deliver')
  assert.deepEqual(dock.mapDockRequest(deliver, detail()), { kind: 'advance' }, '交付执行 complete，不是 /deliver 补交付')

  const noFinal = action({ stage: 'complete', status: 'idle', outputs: { base_image: { path: 'b.png', width: 10, height: 10 }, final_image: null } })
  assert.equal(noFinal.code, 'render')

  const completedHost = action({ stage: 'complete', status: 'completed', host: { id: 'huobao', ref: 'prop:1', target: null, error: null } })
  assert.equal(completedHost.code, 'viewDelivery')
  const completedSolo = action({ stage: 'complete', status: 'completed' })
  assert.equal(completedSolo.code, 'viewMap')
})

test('失败分型：续跑保留真实 mode/stop_at；边界缺失不猜；complete 失败走完整交付', () => {
  const resume = action({
    stage: 'research', status: 'failed', mode: 'guided', stop_at: 'base',
    error_detail: { kind: 'steps_exhausted', rounds: [], at: '' },
    input: { researchResumable: true },
  })
  assert.equal(resume.code, 'continueResearch')
  assert.deepEqual(dock.mapDockRequest(resume, detail({ mode: 'guided', stop_at: 'base' })), { kind: 'run', mode: 'guided', stopAt: 'base' })

  const retryDrawing = action({ stage: 'drawing', status: 'failed', mode: 'guided', stop_at: 'drawing', error_detail: { kind: 'ended_without_delivery', rounds: [], at: '' } })
  assert.equal(retryDrawing.code, 'retryStage')
  assert.deepEqual(dock.mapDockRequest(retryDrawing, detail({ mode: 'guided', stop_at: 'drawing' })), { kind: 'run', mode: 'guided', stopAt: 'drawing' })

  const boundaryGone = action({ stage: 'drawing', status: 'failed', mode: 'guided', stop_at: null, error_detail: { kind: 'steps_exhausted', rounds: [], at: '' } })
  assert.equal(boundaryGone.code, 'chooseRun', '旧 run 缺边界时由人明确选择，不自动续跑')

  const model = action({ stage: 'research', status: 'failed', error_detail: { kind: 'call_error', rounds: [], at: '' } })
  assert.equal(model.code, 'fixModel')
  const rejected = action({ stage: 'drawing', status: 'failed', error_detail: { kind: 'rejected', rounds: [{ round: 1, outcome: 'rejected', problems: ['x'], steps_used: 3 }], at: '' } })
  assert.equal(rejected.code, 'resolveProblems')
  const unclassified = action({ stage: 'base', status: 'failed', error_detail: null })
  assert.equal(unclassified.code, 'viewError')
  const unknown = action({ stage: 'base', status: 'failed', error_detail: { kind: 'brand_new', rounds: [], at: '' } })
  assert.equal(unknown.code, 'viewError')
  assert.equal(unknown.detail, 'brand_new', '保留原始 kind，不猜恢复策略')

  const deliveryFailed = action({ stage: 'complete', status: 'failed', error_detail: { kind: 'rejected', rounds: [], at: '' }, outputs: { base_image: { path: 'b.png', width: 10, height: 10 }, final_image: { path: 'f.png', width: 10, height: 10 } } })
  assert.equal(deliveryFailed.code, 'deliver')
  assert.equal(deliveryFailed.label, 'retryDeliver')
})

test('客户端请求形态：guided 带 stop_at；advance 不带运行边界', async () => {
  const original = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, init) => { requests.push({ url, body: init?.body ? JSON.parse(init.body) : null }); return Response.json({ code: 200, data: {} }) }
  try {
    await api.mapStudioAPI.run(9, { mode: 'guided', stop_at: 'base', expected_revision: 4 })
    assert.deepEqual(requests[0].body, { mode: 'guided', stop_at: 'base', expected_revision: 4 })
    await api.mapStudioAPI.run(9, { mode: 'guided', stop_at: 'drawing', expected_revision: 5 })
    assert.deepEqual(requests[1].body, { mode: 'guided', stop_at: 'drawing', expected_revision: 5 })
    await api.mapStudioAPI.advance(9, { expected_revision: 6 })
    assert.equal(requests[2].body.stop_at, undefined, 'advance 不带 stop_at')
    await api.mapStudioAPI.run(9, { mode: 'auto', expected_revision: 7 })
    assert.equal(requests[3].body.stop_at, undefined, 'auto 只在抽屉里作为高级命令，不带边界')
  } finally { globalThis.fetch = original }
})
