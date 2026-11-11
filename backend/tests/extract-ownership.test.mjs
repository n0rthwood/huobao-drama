/**
 * 纪录片整集提取的地图归属与道具等场景（Issue #93）。
 * 真跑 save_dedup_props / read_existing_props 与等待逻辑（临时 SQLite + 仓库自带 tsx 子进程）。
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
  const sqlitePath = path.join(mkdtempSync(path.join(tmpdir(), 'extract-own-')), 'test.sqlite3')
  const out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: { ...process.env, SQLITE_PATH: sqlitePath },
  })
  return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
}

const SETUP = `
  import { db, schema, initDb } from './src/db/index.ts'
  import { eq } from 'drizzle-orm'
  import { buildAgentRequestContext } from './src/agents/context.ts'
  import { extractTools } from './src/agents/tools/extract-tools.ts'
  initDb()
  const ts = new Date().toISOString()
  await db.insert(schema.dramas).values({ id: 1, title: 'doc', projectType: 'documentary', createdAt: ts, updatedAt: ts })
  await db.insert(schema.dramas).values({ id: 2, title: 'drama', projectType: 'drama', createdAt: ts, updatedAt: ts })
  await db.insert(schema.episodes).values({ id: 11, dramaId: 1, episodeNumber: 1, title: 'e', createdAt: ts, updatedAt: ts })
  await db.insert(schema.episodes).values({ id: 21, dramaId: 2, episodeNumber: 1, title: 'e', createdAt: ts, updatedAt: ts })
  const ctx = (dramaId, episodeId, extra = {}) => ({ requestContext: buildAgentRequestContext({ episodeId, dramaId, ...extra }) })
  const save = (c, props) => extractTools.saveDedupProps.execute({ props }, c)
  const rows = async (dramaId) => (await db.select().from(schema.props).where(eq(schema.props.dramaId, dramaId)))
    .map(p => p.name + ':' + p.assetType).sort()
`

test('documentary scene extraction saves only maps; the prop extraction saves only non-map props', () => {
  const result = run(`
    ${SETUP}
    const scenesRun = await save(ctx(1, 11, { extractTarget: 'scenes' }), [
      { name: '京师北面防线图', asset_type: 'map', description: '明代防线区位' },
      { name: '号炮', description: '信号炮' },
    ])
    const propsRun = await save(ctx(1, 11, { extractTarget: 'props' }), [
      { name: '号炮', description: '信号炮' },
      { name: '另一张地图', asset_type: 'map' },
      { name: '京师北面防线图', description: '改写已有地图' },
    ])
    const read = await extractTools.readExistingProps.execute({}, ctx(1, 11, { extractTarget: 'props' }))
    process.stdout.write('@@' + JSON.stringify({ scenesRun, propsRun, rows: await rows(1), read: read.current_episode_props.map(p => p.name + ':' + p.asset_type).sort() }))
  `)
  assert.equal(result.scenesRun.created, 1)
  assert.deepEqual(result.scenesRun.rejected.map(r => r.name), ['号炮'])
  assert.equal(result.propsRun.created, 1)
  // 道具提取既不能新建地图，也不能借同名改写场景提取保存的地图
  assert.deepEqual(result.propsRun.rejected.map(r => r.name), ['另一张地图', '京师北面防线图'])
  assert.match(result.propsRun.rejected[0].reason, /场景提取/)
  assert.deepEqual(result.rows, ['京师北面防线图:map', '号炮:prop'])
  // 道具提取读到的已有道具带 asset_type，能认出哪张是地图
  assert.deepEqual(result.read, ['京师北面防线图:map', '号炮:prop'])
})

test('the scene extraction cannot turn an existing ordinary prop into a map', () => {
  const result = run(`
    ${SETUP}
    await save(ctx(1, 11), [{ name: '号炮', description: '信号炮' }])
    const scenesRun = await save(ctx(1, 11, { extractTarget: 'scenes' }), [{ name: '号炮', asset_type: 'map' }])
    process.stdout.write('@@' + JSON.stringify({ scenesRun, rows: await rows(1) }))
  `)
  assert.deepEqual(result.scenesRun.rejected.map(r => r.name), ['号炮'])
  assert.deepEqual(result.rows, ['号炮:prop'])
})

test('single-asset re-extraction, character runs and drama projects keep saving any prop type', () => {
  const result = run(`
    ${SETUP}
    const single = await save(ctx(1, 11, { singleAssetName: '防线图' }), [{ name: '防线图', asset_type: 'map' }, { name: '令旗' }])
    const characters = await save(ctx(1, 11, { extractTarget: 'characters' }), [{ name: '团旗' }])
    const drama = await save(ctx(2, 21, { extractTarget: 'scenes' }), [{ name: '遥控器' }, { name: '城区图', asset_type: 'map' }])
    process.stdout.write('@@' + JSON.stringify({ single, characters, drama, doc: await rows(1), dramaRows: await rows(2) }))
  `)
  for (const r of [result.single, result.characters, result.drama]) assert.equal(r.rejected, undefined)
  assert.deepEqual(result.doc, ['令旗:prop', '团旗:prop', '防线图:map'])
  assert.deepEqual(result.dramaRows, ['城区图:map', '遥控器:prop'])
})

test('the prop extraction waits for a running scene extraction, shows it, and starts at once when none runs', () => {
  const result = run(`
    import { db, schema, initDb } from './src/db/index.ts'
    import { eq } from 'drizzle-orm'
    import { withExtractionLock, waitForSceneExtraction } from './src/services/extraction.ts'
    initDb()
    const ts = new Date().toISOString()
    const task = async (kind, status) => (await db.insert(schema.sysTask).values({ type: 'text', episodeId: 11, dramaId: 1, status, params: JSON.stringify({ kind }), createdAt: ts, updatedAt: ts }).returning())[0].id
    const params = async (id) => JSON.parse((await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)))[0].params)
    const order = []

    // 没有场景提取在跑：立即返回，不写等待进度
    const idle = await task('extract_props', 'queued')
    await waitForSceneExtraction(11, idle)
    const idleProgress = (await params(idle)).progress ?? null

    // 场景提取持有锁：道具等它释放（即使场景以失败告终）
    const sceneTask = await task('extract_scenes', 'processing')
    const propsTask = await task('extract_props', 'queued')
    let release
    const scene = withExtractionLock('episode:11:extract_scenes', () => new Promise((_, reject) => { release = () => { order.push('scenes-end'); reject(new Error('scene failed')) } })).catch(() => {})
    const waiting = waitForSceneExtraction(11, propsTask).then(() => order.push('props-start'))
    await new Promise(r => setTimeout(r, 50))
    const during = (await params(propsTask)).progress
    order.push('check')
    release()
    await scene
    await waiting
    const after = (await params(propsTask)).progress ?? null
    process.stdout.write('@@' + JSON.stringify({ idleProgress, during, sceneTask, after, order }))
  `)
  assert.equal(result.idleProgress, null)
  assert.equal(result.during.step, 'waiting_scenes')
  assert.equal(result.during.waiting_task_id, result.sceneTask)
  assert.deepEqual(result.order, ['check', 'scenes-end', 'props-start'])
  // 开始执行时清掉等待进度，任务窗口不再显示「等待场景提取」
  assert.equal(result.after, null)
})
