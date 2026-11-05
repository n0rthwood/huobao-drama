/**
 * 纪录片步骤门禁（Issue #54）：
 * - 纯函数 computeGates：剧情全解锁；纪录片逐级解锁，上游回退时下游同步锁回，reasons 写最靠上的原因；
 * - 真跑库：GET /episodes/:id/gates 的结构，以及拆分/补镜/填卡/提取被 GateBlockedError 拦住。
 * 临时 SQLITE_PATH + 仓库自带 tsx 子进程，绝不碰开发库。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

function run(script) {
  const dir = mkdtempSync(path.join(tmpdir(), 'workflow-gates-'))
  try {
    const out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: backendRoot,
      encoding: 'utf8',
      env: { ...process.env, SQLITE_PATH: path.join(dir, 'test.sqlite3') },
    })
    return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

const FACTS = (over = '') => `
  import { computeGates } from './src/services/workflow-gates.ts'
  const base = {
    projectType: 'documentary',
    script: { confirmed: true, confirmed_at: '2026-01-01T00:00:00.000Z' },
    assets: { review_status: 'passed', stale_reasons: [] },
    design: { confirmed: 2, total: 3 },
    production: { ready: 1, total: 3 },
    final: { fresh: 1, total: 3 },
  }
  ${over}
`

test('剧情项目恒全解锁且没有任何原因', () => {
  const result = run(`
    ${FACTS(`
      const gates = computeGates({ ...base, projectType: 'drama', script: { confirmed: false, confirmed_at: null }, assets: { review_status: 'none', stale_reasons: [] } })
      console.log('@@' + JSON.stringify({ unlocked: gates.unlocked, reasons: gates.reasons, goto: gates.goto }))
    `)}
  `)
  assert.deepEqual(result.unlocked, { assets: true, design: true, production: true, final: true, poster: true, export: true })
  assert.deepEqual(result.reasons, {})
  assert.deepEqual(result.goto, {})
})

test('纪录片逐级解锁：全部条件满足时链条打开', () => {
  const result = run(`
    ${FACTS(`
      const gates = computeGates(base)
      console.log('@@' + JSON.stringify({ unlocked: gates.unlocked, reasons: gates.reasons }))
    `)}
  `)
  assert.deepEqual(result.unlocked, { assets: true, design: true, production: true, final: true, poster: true, export: true })
  assert.deepEqual(result.reasons, {})
})

test('剧本未确认：全部步骤锁住，reasons 一律指向剧本，Poster 也跟随资产锁住', () => {
  const result = run(`
    ${FACTS(`
      const gates = computeGates({ ...base, script: { confirmed: false, confirmed_at: null } })
      console.log('@@' + JSON.stringify({ unlocked: gates.unlocked, reasons: gates.reasons, goto: gates.goto }))
    `)}
  `)
  assert.deepEqual(result.unlocked, { assets: false, design: false, production: false, final: false, poster: false, export: false })
  for (const key of ['assets', 'design', 'production', 'final', 'export', 'poster']) {
    assert.match(result.reasons[key], /旁白稿/)
    assert.equal(result.goto[key], 'script')
  }
})

test('上游回退时下游同步锁回：清单未通过但设计/制作有残留进度', () => {
  const result = run(`
    ${FACTS(`
      const gates = computeGates({ ...base, assets: { review_status: 'pending', stale_reasons: [] } })
      console.log('@@' + JSON.stringify({ unlocked: gates.unlocked, reasons: gates.reasons, goto: gates.goto }))
    `)}
  `)
  assert.equal(result.unlocked.assets, true)
  assert.equal(result.unlocked.poster, true)
  assert.deepEqual(
    { design: result.unlocked.design, production: result.unlocked.production, final: result.unlocked.final, export: result.unlocked.export },
    { design: false, production: false, final: false, export: false },
  )
  // 最靠上的未满足原因 = 审核清单，跳转落到资产步
  for (const key of ['design', 'production', 'final', 'export']) {
    assert.match(result.reasons[key], /审核清单/)
    assert.equal(result.goto[key], 'assets')
  }
})

test('每一环自身条件：设计 0 / 制作 0 / 成品 0 各锁住其下游', () => {
  const result = run(`
    ${FACTS(`
      const noDesign = computeGates({ ...base, design: { confirmed: 0, total: 3 } })
      const noProd = computeGates({ ...base, production: { ready: 0, total: 3 } })
      const noFinal = computeGates({ ...base, final: { fresh: 0, total: 3 } })
      console.log('@@' + JSON.stringify({
        noDesign: { unlocked: noDesign.unlocked, reason: noDesign.reasons.production, goto: noDesign.goto.production },
        noProd: { unlocked: noProd.unlocked, reason: noProd.reasons.final, goto: noProd.goto.final },
        noFinal: { unlocked: noFinal.unlocked, reason: noFinal.reasons.export, goto: noFinal.goto.export },
      }))
    `)}
  `)
  assert.equal(result.noDesign.unlocked.design, true)
  assert.equal(result.noDesign.unlocked.production, false)
  assert.ok(result.noDesign.reason.length > 0)
  assert.equal(result.noDesign.goto, 'design')
  assert.equal(result.noProd.unlocked.production, true)
  assert.equal(result.noProd.unlocked.final, false)
  assert.equal(result.noProd.goto, 'production')
  assert.equal(result.noFinal.unlocked.final, true)
  assert.equal(result.noFinal.unlocked.export, false)
  assert.equal(result.noFinal.goto, 'final')
})

const DB_FIXTURE = `
  import { initDb, db, schema } from './src/db/index.ts'
  import { eq } from 'drizzle-orm'
  initDb()
  const at = '2026-01-01T00:00:00.000Z'
  await db.insert(schema.dramas).values([
    { id: 1, title: 'doc', projectType: 'documentary', createdAt: at, updatedAt: at },
    { id: 2, title: 'drama', projectType: 'drama', createdAt: at, updatedAt: at },
  ])
  await db.insert(schema.episodes).values([
    { id: 1, dramaId: 1, episodeNumber: 1, title: 'E1', scriptContent: '旁白稿正文。', narrationEnabled: true, createdAt: at, updatedAt: at },
    { id: 2, dramaId: 2, episodeNumber: 1, title: 'E1', scriptContent: '剧本正文。', createdAt: at, updatedAt: at },
  ])
  await db.insert(schema.storyboards).values([
    { id: 11, episodeId: 1, storyboardNumber: 1, title: 'S1', narrationText: '旁白稿正文。', duration: 8, createdAt: at, updatedAt: at },
    { id: 21, episodeId: 2, storyboardNumber: 1, title: 'S1', duration: 8, createdAt: at, updatedAt: at },
  ])
`

test('GET /episodes/:id/gates：纪录片未确认剧本 → assets 锁且有原因；剧情集全解锁', () => {
  const result = run(`
    ${DB_FIXTURE}
    const app = (await import('./src/routes/episodes.ts')).default
    const doc = await (await app.request('/1/gates')).json()
    const drama = await (await app.request('/2/gates')).json()
    console.log('@@' + JSON.stringify({ doc: doc.data, drama: drama.data }))
  `)
  assert.equal(result.doc.project_type, 'documentary')
  assert.equal(result.doc.script.confirmed, false)
  assert.equal(result.doc.assets.review_status, 'none')
  assert.equal(result.doc.unlocked.assets, false)
  assert.ok(result.doc.reasons.assets.length > 0)
  assert.equal(result.drama.project_type, 'drama')
  assert.deepEqual(result.drama.unlocked, { assets: true, design: true, production: true, final: true, poster: true, export: true })
  assert.deepEqual(result.drama.reasons, {})
})

test('assertGate 在剧本未确认 / 清单未通过时抛 GateBlockedError，且不建任务', () => {
  const result = run(`
    ${DB_FIXTURE}
    import { assertGate, confirmScript, GateBlockedError } from './src/services/workflow-gates.ts'
    async function probe(gate) {
      try { await assertGate(1, gate); return null }
      catch (err) { return err instanceof GateBlockedError ? { gate: err.gate, reason: err.reason } : { other: String(err) } }
    }
    const beforeAssets = await probe('assets')
    const beforeDesign = await probe('design')
    await confirmScript(1)
    const afterAssets = await probe('assets')
    const afterDesign = await probe('design')
    await db.update(schema.episodes).set({ assetReviewStatus: 'passed' }).where(eq(schema.episodes.id, 1))
    const passedDesign = await probe('design')
    const dramaGate = await (async () => { try { await assertGate(2, 'export'); return null } catch (e) { return String(e) } })()
    const tasks = await db.select().from(schema.sysTask)
    console.log('@@' + JSON.stringify({ beforeAssets, beforeDesign, afterAssets, afterDesign, passedDesign, dramaGate, tasks: tasks.length }))
  `)
  assert.equal(result.beforeAssets.gate, 'assets')
  assert.match(result.beforeAssets.reason, /旁白稿/)
  assert.equal(result.beforeDesign.gate, 'design')
  assert.match(result.beforeDesign.reason, /旁白稿/)
  assert.equal(result.afterAssets, null)
  assert.match(result.afterDesign.reason, /审核清单/)
  assert.equal(result.passedDesign, null)
  assert.equal(result.dramaGate, null)
  assert.equal(result.tasks, 0)
})

test('资产步写端点（extract / re-extract）在剧本未确认时 400 且不动数据', () => {
  const result = run(`
    ${DB_FIXTURE}
    await db.insert(schema.props).values({ id: 31, dramaId: 1, name: '殷墟地图', type: '地图', description: '原始说明', createdAt: at, updatedAt: at })
    await db.insert(schema.episodeProps).values({ episodeId: 1, propId: 31, createdAt: at })
    import { Hono } from 'hono'
    import { GateBlockedError } from './src/services/workflow-gates.ts'
    import { errorHandler } from './src/middleware/logger.ts'
    const episodes = (await import('./src/routes/episodes.ts')).default
    const props = (await import('./src/routes/props.ts')).default
    // 与 src/index.ts 相同的装配：门禁出口只有全局 onError
    const app = new Hono()
    app.use('*', errorHandler)
    app.onError((err, c) => err instanceof GateBlockedError
      ? c.json({ code: 400, error: 'gate_blocked', gate: err.gate, reason: err.reason, message: err.reason }, 400)
      : c.json({ code: 500, message: err.message }, 500))
    app.route('/episodes', episodes)
    app.route('/props', props)
    const post = (path, body) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const extractRes = await post('/episodes/1/extract', { target: 'props' })
    const extract = { status: extractRes.status, body: await extractRes.json() }
    const reRes = await post('/props/31/re-extract', { episode_id: 1 })
    const reExtract = { status: reRes.status, body: await reRes.json() }
    const [prop] = await db.select().from(schema.props).where(eq(schema.props.id, 31))
    const tasks = await db.select().from(schema.sysTask)
    console.log('@@' + JSON.stringify({ extract, reExtract, prop: { type: prop.type, description: prop.description }, tasks: tasks.length }))
  `)
  assert.equal(result.extract.status, 400)
  assert.equal(result.extract.body.error, 'gate_blocked')
  assert.equal(result.extract.body.gate, 'assets')
  assert.match(result.extract.body.reason, /旁白稿/)
  assert.equal(result.reExtract.status, 400)
  assert.equal(result.reExtract.body.gate, 'assets')
  // 被拦的重新提取绝不能先把资产字段清空
  assert.deepEqual(result.prop, { type: '地图', description: '原始说明' })
  assert.equal(result.tasks, 0)
})

test('全局 onError 把 GateBlockedError 转成 400 {error, gate, reason}', () => {
  const result = run(`
    import { Hono } from 'hono'
    import { GateBlockedError } from './src/services/workflow-gates.ts'
    import { errorHandler } from './src/middleware/logger.ts'
    const app = new Hono()
    app.use('*', errorHandler)
    app.onError((err, c) => {
      if (err instanceof GateBlockedError) {
        return c.json({ code: 400, error: 'gate_blocked', gate: err.gate, reason: err.reason, message: err.reason }, 400)
      }
      return c.json({ code: 500, message: err.message }, 500)
    })
    app.get('/blocked', () => { throw new GateBlockedError('design', '资产审核清单尚未通过') })
    app.get('/boom', () => { throw new Error('普通错误') })
    const blocked = await app.request('/blocked')
    const boom = await app.request('/boom')
    console.log('@@' + JSON.stringify({ status: blocked.status, body: await blocked.json(), boomStatus: boom.status }))
  `)
  assert.equal(result.status, 400)
  assert.equal(result.body.error, 'gate_blocked')
  assert.equal(result.body.gate, 'design')
  assert.equal(result.body.reason, '资产审核清单尚未通过')
  assert.equal(result.boomStatus, 500)
})

test('index.ts 的全局 onError 是 GateBlockedError 的唯一出口（路由不各自 try/catch）', () => {
  const index = execFileSync('node', ['-e', "process.stdout.write(require('fs').readFileSync('src/index.ts','utf8'))"], { cwd: backendRoot, encoding: 'utf8' })
  assert.match(index, /app\.onError\(/)
  assert.match(index, /GateBlockedError/)
})
