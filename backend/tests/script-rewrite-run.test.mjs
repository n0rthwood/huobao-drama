/**
 * 分阶段改写的运行 / 任务中心重试 / 显式采用的对外行为回归（Issue #70）：
 * - 跳过全部阶段 = 按字节复制过滤后的正文并一次性采用，行政材料不得进入最终稿；
 * - 只跑桥句的运行失败后，任务中心重试要继承运行记录里的前驱继续跑；
 * - 重试不替用户确认「新原文配旧前驱」，也不把用户关掉的自动采用救活；
 * - 重启把运行标失败后，迟到的阶段结果既不落版本也不采用；
 * - 显式采用历史版本：修订号不对拿 409，原始资料快照不可采用。
 *
 * 每个用例一个子进程：独立的临时 SQLite + 临时数据目录 + 本地桩文本服务（OpenAI 兼容），
 * 既不碰仓库默认库 / 联调库，也不发真实模型请求。断言全部针对服务与路由的返回值。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

const P1 = '一七二〇年，清、准、俄三方都在这片草原上押下重注。'
const P2 = '额尔齐斯河是唯一一条能把军队送进腹地的水道。'
const P3 = '这一年冬天，布赫霍尔茨奉命率领近三千人溯流而上。'
const RAW = [
  '原作者：该条目贡献者；贡献历史：https://example.org/w/index.php?title=Irtysh&action=history',
  '许可协议：CC BY-SA 4.0',
  '',
  P1,
  '',
  P2,
  '',
  P3,
].join('\n')
const OLD_FINAL = '这是运行开始之前就在库里的最终稿。'
const BRIDGE_SENTENCE = '水路因此成了唯一的指望。'

const SETUP = `
import http from 'node:http'
import { eq } from 'drizzle-orm'
import { db, schema, initDb } from './src/db/index.ts'

const RAW = ${JSON.stringify(RAW)}
const OLD_FINAL = ${JSON.stringify(OLD_FINAL)}
const BRIDGE_SENTENCE = ${JSON.stringify(BRIDGE_SENTENCE)}

// 桩文本服务：忠实改写阶段原样回抄输入正文（满足 ±5% 与每段 80 字），
// 桥句阶段按提示词里列出的边界逐条回报告；mode='bad' 用来制造一次阶段失败。
let mode = 'good'
let delayMs = 0
const setMode = (next, delay) => { mode = next; delayMs = delay || 0 }

const replyFor = (user) => {
  if (user.indexOf('【原始内容】') === 0) return JSON.stringify({ content: user.slice('【原始内容】'.length).replace(/^\\n/, ''), exclusions: [] })
  if (mode === 'bad') return '这不是 JSON，模型跑题了'
  const boundaries = [...user.matchAll(/^(B\\d+)：(P\\d+) → (P\\d+)$/gm)].map((m, index) => ({
    boundary_id: m[1], left_paragraph: m[2], right_paragraph: m[3],
    relation: '承接',
    decision: index === 0 ? 'inserted' : 'no_bridge',
    reason: index === 0 ? '左右两段之间缺一句承接' : '时间推进自然，不需要桥句',
    bridge_text: index === 0 ? BRIDGE_SENTENCE : null,
    placement: index === 0 ? 'start_of_right' : null,
    shot_attribution: index === 0 ? 'next_head' : null,
  }))
  return JSON.stringify({ boundaries })
}

const stub = http.createServer((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    const payload = JSON.parse(body)
    const messages = payload.messages || []
    const user = String((messages[messages.length - 1] || {}).content || '')
    const send = () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: replyFor(user) } }] }))
    }
    if (delayMs) setTimeout(send, delayMs)
    else send()
  })
})
await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve))
stub.unref()

initDb()
const ts = new Date().toISOString()
await db.insert(schema.aiServiceConfigs).values({
  id: 1, name: 'stub-text', serviceType: 'text', provider: 'openai',
  baseUrl: 'http://127.0.0.1:' + stub.address().port, apiKey: 'k',
  model: JSON.stringify(['stub-model']),
  isActive: true, priority: 1, createdAt: ts, updatedAt: ts,
})
await db.insert(schema.dramas).values({ id: 1, title: 'doc', projectType: 'documentary', createdAt: ts, updatedAt: ts })
await db.insert(schema.episodes).values({
  id: 1, dramaId: 1, episodeNumber: 1, title: 'E1',
  content: RAW, scriptContent: OLD_FINAL, narrationEnabled: true,
  createdAt: ts, updatedAt: ts,
})

const runSvc = await import('./src/services/script-rewrite/run.ts')
const store = await import('./src/services/script-rewrite/store.ts')
const { retryTask } = await import('./src/services/task-retry.ts')
const { default: rewriteApp } = await import('./src/routes/script-rewrite.ts')
const { default: episodesApp } = await import('./src/routes/episodes.ts')

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
const settle = async (runId, ms) => {
  const deadline = Date.now() + (ms || 20000)
  for (;;) {
    const row = await store.getRun(runId)
    if (row && (row.status === 'completed' || row.status === 'failed')) return row
    if (Date.now() > deadline) throw new Error('运行没有在时限内结束：' + (row ? row.status : 'missing'))
    await sleep(25)
  }
}
const episode = async () => (await db.select().from(schema.episodes).where(eq(schema.episodes.id, 1)))[0]
const versions = () => store.listVersions(1)
const runs = () => store.listRuns(1)
const runIdOfTask = async (taskId) => {
  const [row] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, taskId))
  return JSON.parse(row.params || '{}').rewrite.run_id
}
const post = (url, body) => rewriteApp.request(url, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
})
const emit = (payload) => console.log('@@' + JSON.stringify(payload))
const caught = async (fn) => {
  try {
    await fn()
    return null
  } catch (err) {
    return { code: err.code || null, status: err.status || null, message: String(err.message || err) }
  }
}
`

function run(body) {
  const dir = mkdtempSync(path.join(tmpdir(), 'huobao-rewrite-run-'))
  try {
    const out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', `${SETUP}\n${body}`], {
      cwd: backendRoot,
      encoding: 'utf8',
      env: { ...process.env, SQLITE_PATH: path.join(dir, 'test.sqlite3'), HUOBAO_DATA_DIR: dir },
    })
    return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

/** 先跑一轮「忠实改写 + 跳过桥句」，拿到可以当前驱的正式 fidelity 版本 */
const FIDELITY_FIRST = `
  const first = await runSvc.startRewriteRun(1, { skipStages: ['bridge'] })
  await settle(first.run_id)
  const fidelity = (await versions()).find(v => v.stageKey === 'fidelity' && v.source === 'agent')
`

test('跳过全部阶段：候选稿是过滤后的正文，自动采用后最终稿里没有行政材料', () => {
  const result = run(`
    const started = await runSvc.startRewriteRun(1, { skipStages: ['fidelity', 'bridge'] })
    const row = await settle(started.run_id)
    const all = await versions()
    emit({
      status: row.status,
      adoption: row.adoptionStatus,
      copied: all.filter(v => v.source === 'skip_copy').map(v => v.stageKey),
      prepared: all.find(v => v.stageKey === 'prepared_source').content,
      candidate: all.find(v => v.id === row.candidateVersionId).content,
      final: (await episode()).scriptContent,
    })
  `)
  assert.equal(result.status, 'completed')
  assert.equal(result.adoption, 'adopted')
  assert.deepEqual(new Set(result.copied), new Set(['fidelity', 'bridge']), '每个跳过阶段都有可追溯版本，不依赖历史列表的展示顺序')
  assert.equal(result.candidate, result.prepared, '跳过 = 逐字节复制前驱，不调用模型')
  assert.equal(result.final, result.prepared, '自动采用把候选稿写进最终稿')
  assert.ok(result.final.includes(P1), '正文段落必须保留')
  assert.ok(!result.final.includes('CC BY-SA'), '许可协议不得进入最终稿')
  assert.ok(!result.final.includes('原作者'), '署名著录不得进入最终稿')
  assert.ok(!/https?:\/\//.test(result.final), '链接不得进入最终稿')
})

test('只跑桥句的运行失败后：任务中心重试继承运行里的前驱继续跑', () => {
  const result = run(`
    ${FIDELITY_FIRST}

    // 只从桥句阶段重跑：这一轮只有 bridge 一个阶段行，前驱记在运行行上
    setMode('bad')
    const bridgeOnly = await runSvc.startRewriteRun(1, { startStage: 'bridge', predecessorVersionId: fidelity.id })
    const failed = await settle(bridgeOnly.run_id)

    setMode('good')
    let newTaskId = null
    const retryError = await caught(async () => { newTaskId = await retryTask(failed.taskId, {}) })
    const newRun = newTaskId ? await store.getRun(await runIdOfTask(newTaskId)) : null
    const done = newRun ? await settle(newRun.id) : null
    emit({
      failedStatus: failed.status,
      retryError,
      inheritedPredecessor: newRun ? newRun.predecessorVersionId === fidelity.id : null,
      plan: newRun ? JSON.parse(newRun.stagePlan).map(entry => entry.key) : null,
      status: done ? done.status : null,
      adoption: done ? done.adoptionStatus : null,
      final: (await episode()).scriptContent,
    })
  `)
  assert.equal(result.failedStatus, 'failed')
  assert.equal(result.retryError, null, `重试不得因为缺前驱被拒：${JSON.stringify(result.retryError)}`)
  assert.equal(result.inheritedPredecessor, true, '重试要复用运行记录里的 fidelity 前驱')
  assert.deepEqual(result.plan, ['bridge'], '重试只续跑失败的阶段')
  assert.equal(result.status, 'completed')
  assert.equal(result.adoption, 'adopted')
  assert.ok(result.final.includes(BRIDGE_SENTENCE), '重试成功后桥句要进入最终稿')
})

test('重试不替用户确认「新原文配旧前驱」：原文改过就拒绝，也不新建运行', () => {
  const result = run(`
    ${FIDELITY_FIRST}

    setMode('bad')
    const bridgeOnly = await runSvc.startRewriteRun(1, { startStage: 'bridge', predecessorVersionId: fidelity.id })
    const failed = await settle(bridgeOnly.run_id)

    // 用户在失败之后改了原始资料：旧前驱属于更早的快照
    await episodesApp.request('/1', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: RAW + '\\n\\n又一段新的原始资料。' }),
    })
    const beforeRuns = (await runs()).length
    const beforeFinal = (await episode()).scriptContent

    setMode('good')
    const error = await caught(() => retryTask(failed.taskId, {}))
    emit({
      error,
      newRuns: (await runs()).length - beforeRuns,
      finalUnchanged: (await episode()).scriptContent === beforeFinal,
    })
  `)
  assert.ok(result.error, '原文变了必须拒绝重试，不能静默混用旧前驱')
  assert.equal(result.error.code, 'source_changed')
  assert.equal(result.error.status, 409)
  assert.equal(result.newRuns, 0, '被拒的重试不得新建运行')
  assert.equal(result.finalUnchanged, true, '被拒的重试不得动最终稿')
})

test('运行期间手改过的集：重试保留手动模式，完成后只留候选稿不覆盖最终稿', () => {
  const result = run(`
    ${FIDELITY_FIRST}

    // 桥句阶段故意跑失败；趁它还在等模型，按下「我要手改」（持久化不自动采用）
    setMode('bad', 300)
    const bridgeOnly = await runSvc.startRewriteRun(1, { startStage: 'bridge', predecessorVersionId: fidelity.id })
    const manual = await post('/1/script-rewrite/runs/' + bridgeOnly.run_id + '/manual')
    const manualBody = await manual.json()
    const failed = await settle(bridgeOnly.run_id)

    setMode('good', 0)
    const finalBefore = (await episode()).scriptContent
    const newTaskId = await retryTask(failed.taskId, {})
    const newRun = await store.getRun(await runIdOfTask(newTaskId))
    const done = await settle(newRun.id)
    const candidate = (await versions()).find(v => v.id === done.candidateVersionId)
    emit({
      manualStatus: manual.status,
      manualFlag: manualBody.data.auto_adopt,
      retryAutoAdopt: newRun.autoAdopt,
      status: done.status,
      adoption: done.adoptionStatus,
      finalUnchanged: (await episode()).scriptContent === finalBefore,
      candidateHasBridge: candidate.content.includes(BRIDGE_SENTENCE),
    })
  `)
  assert.equal(result.manualStatus, 200)
  assert.equal(result.manualFlag, false)
  assert.equal(result.retryAutoAdopt, 0, '重试不得把用户关掉的自动采用救活')
  assert.equal(result.status, 'completed')
  assert.equal(result.adoption, 'manual')
  assert.equal(result.finalUnchanged, true, '手动模式下运行结束不得覆盖最终稿')
  assert.equal(result.candidateHasBridge, true, '候选稿照常产出，等用户显式采用')
})

test('重启把运行标为失败：迟到的阶段结果既不落版本也不采用', () => {
  const result = run(`
    setMode('good', 900)
    const started = await runSvc.startRewriteRun(1)
    await sleep(200)
    await runSvc.failInterruptedRewriteRuns()
    await sleep(1600)
    const row = await store.getRun(started.run_id)
    const all = await versions()
    emit({
      status: row.status,
      adoption: row.adoptionStatus,
      candidate: row.candidateVersionId,
      stageVersions: all.filter(v => v.source === 'agent').map(v => v.stageKey),
      final: (await episode()).scriptContent,
    })
  `)
  assert.equal(result.status, 'failed', '重启标失败后不得被迟到的结果改回完成')
  assert.notEqual(result.adoption, 'adopted')
  assert.equal(result.candidate, null, '迟到的结果不得成为候选稿')
  assert.deepEqual(result.stageVersions, [], '迟到的阶段结果不得落正式版本')
  assert.equal(result.final, OLD_FINAL, '最终稿必须原样保留')
})

test('显式采用历史版本：修订号不对拿 409，原始资料快照不可采用', () => {
  const result = run(`
    const started = await runSvc.startRewriteRun(1)
    const done = await settle(started.run_id)
    const all = await versions()
    const fidelity = all.find(v => v.stageKey === 'fidelity' && v.source === 'agent')
    const snapshot = all.find(v => v.stageKey === 'source_snapshot')
    const state = (await (await rewriteApp.request('/1/script-rewrite')).json()).data

    const stale = await post('/1/script-rewrite/versions/' + fidelity.id + '/adopt', {
      source_revision: state.source_revision, final_revision: state.final_revision - 1,
    })
    const staleBody = await stale.json()
    const afterStale = (await episode()).scriptContent

    const ok = await post('/1/script-rewrite/versions/' + fidelity.id + '/adopt', {
      source_revision: state.source_revision, final_revision: state.final_revision,
    })
    const afterOk = (await episode()).scriptContent

    const snapshotRes = await post('/1/script-rewrite/versions/' + snapshot.id + '/adopt', {
      source_revision: state.source_revision, final_revision: state.final_revision + 1,
    })
    const snapshotBody = await snapshotRes.json()
    emit({
      runStatus: done.status,
      autoAdopted: done.adoptionStatus,
      bridgedFinal: afterStale.includes(BRIDGE_SENTENCE),
      staleStatus: stale.status,
      staleError: staleBody.error,
      okStatus: ok.status,
      adoptedContent: afterOk,
      fidelityContent: fidelity.content,
      snapshotStatus: snapshotRes.status,
      snapshotError: snapshotBody.error,
      finalAfterSnapshot: (await episode()).scriptContent,
    })
  `)
  assert.equal(result.runStatus, 'completed')
  assert.equal(result.autoAdopted, 'adopted')
  assert.equal(result.bridgedFinal, true, '两阶段跑完后最终稿里应有桥句，且冲突的采用没动它')
  assert.equal(result.staleStatus, 409)
  assert.equal(result.staleError, 'revision_conflict')
  assert.equal(result.okStatus, 200)
  assert.equal(result.adoptedContent, result.fidelityContent, '显式采用历史版本 = 把那一版写回最终稿')
  assert.equal(result.snapshotStatus, 400)
  assert.equal(result.snapshotError, 'not_adoptable')
  assert.equal(result.finalAfterSnapshot, result.fidelityContent, '原始资料快照不得成为最终稿')
})
