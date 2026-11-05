/**
 * 人工重排 `PUT /episodes/:id/storyboards/order`（Issue #57，契约 §8 行 2）：
 * - ids 必须是本集存活分镜的全集，缺项/多项/重复/跨集一律 400；
 * - 两阶段负号写入：编号按数组顺序重写且不撞唯一约束，重排后编号连续；
 * - 「上一镜」变了的继承镜撤销关键帧确认。
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
  const dir = mkdtempSync(path.join(tmpdir(), 'storyboard-order-'))
  try {
    const out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: backendRoot,
      encoding: 'utf8',
      env: { ...process.env, SQLITE_PATH: path.join(dir, 'test.sqlite3') },
    })
    return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

const FIXTURE = `
  import { initDb, db, schema } from './src/db/index.ts'
  import { sql } from 'drizzle-orm'
  initDb()
  const at = '2026-01-01T00:00:00.000Z'
  await db.insert(schema.dramas).values([
    { id: 1, title: 'doc', projectType: 'documentary', createdAt: at, updatedAt: at },
  ])
  await db.insert(schema.episodes).values([
    { id: 1, dramaId: 1, episodeNumber: 1, title: 'E1', scriptContent: '第一段。第二段。第三段。', createdAt: at, updatedAt: at },
    { id: 2, dramaId: 1, episodeNumber: 2, title: 'E2', createdAt: at, updatedAt: at },
  ])
  await db.insert(schema.storyboards).values([
    // #2 承接 #1 的尾帧（没有自有首帧）并且已确认关键帧：上一镜换人就必须重新确认
    { id: 11, episodeId: 1, storyboardNumber: 1, title: 'S1', narrationText: '第一段。', lastFrameImage: 'static/a.png', keyframesConfirmed: true, continuityBoundary: 'cut', createdAt: at, updatedAt: at },
    { id: 12, episodeId: 1, storyboardNumber: 2, title: 'S2', narrationText: '第二段。', keyframesConfirmed: true, continuityBoundary: 'continue', createdAt: at, updatedAt: at },
    { id: 13, episodeId: 1, storyboardNumber: 3, title: 'S3', narrationText: '第三段。', keyframesConfirmed: true, continuityBoundary: 'cut', createdAt: at, updatedAt: at },
    { id: 14, episodeId: 1, storyboardNumber: 4, title: '回收站', deletedAt: at, createdAt: at, updatedAt: at },
    { id: 21, episodeId: 2, storyboardNumber: 1, title: '他集', createdAt: at, updatedAt: at },
  ])
  const app = (await import('./src/routes/design-cards.ts')).default
  const order = async (ids, episodeId = 1) => {
    const resp = await app.request('/' + episodeId + '/storyboards/order', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }),
    })
    return { status: resp.status, body: await resp.json() }
  }
  const numbers = () => db.all(sql.raw('SELECT id, storyboard_number AS n, keyframes_confirmed AS kf FROM storyboards WHERE episode_id = 1 AND deleted_at IS NULL ORDER BY storyboard_number'))
`

test('按数组顺序重写编号：编号连续无冲突，返回 from→to 明细', () => {
  const result = run(`
    ${FIXTURE}
    const ok = await order([12, 13, 11])
    console.log('@@' + JSON.stringify({ ok, numbers: numbers() }))
  `)
  assert.equal(result.ok.status, 200)
  assert.equal(result.ok.body.data.changed, 3)
  assert.deepEqual(result.numbers.map(r => r.id), [12, 13, 11], '顺序 = 传入的 ids 顺序')
  assert.deepEqual(result.numbers.map(r => r.n), [1, 2, 3], '编号从 1 起连续，两阶段负号没有留下负值')
})

test('重排后「上一镜」变了的继承镜撤销关键帧确认；软删镜与他集镜不参与', () => {
  const result = run(`
    ${FIXTURE}
    const ok = await order([12, 13, 11])
    const deleted = db.all(sql.raw('SELECT storyboard_number AS n FROM storyboards WHERE id = 14'))[0]
    const other = db.all(sql.raw('SELECT storyboard_number AS n FROM storyboards WHERE id = 21'))[0]
    console.log('@@' + JSON.stringify({ reconfirm: ok.body.data.reconfirm, numbers: numbers(), deleted, other }))
  `)
  assert.deepEqual(result.reconfirm, [12], '只有承接首帧的 #12 的上一镜换了人')
  const byId = Object.fromEntries(result.numbers.map(r => [r.id, r]))
  assert.equal(byId[12].kf, 0, '继承镜的关键帧确认被撤销')
  assert.equal(byId[11].kf, 1, '自有首帧的镜不受影响')
  assert.equal(result.deleted.n, 4, '软删镜编号不动')
  assert.equal(result.other.n, 1, '他集分镜编号不动')
})

test('ids 不是本集存活分镜的全集 → 400，库里一行都不改', () => {
  const result = run(`
    ${FIXTURE}
    const before = numbers()
    const missing = await order([13, 11])
    const extra = await order([13, 11, 12, 14])
    const duplicate = await order([13, 13, 11])
    const foreign = await order([13, 11, 21])
    const empty = await order([])
    console.log('@@' + JSON.stringify({
      before, after: numbers(),
      statuses: [missing.status, extra.status, duplicate.status, foreign.status, empty.status],
      messages: [missing.body.message, foreign.body.message],
    }))
  `)
  assert.deepEqual(result.statuses, [400, 400, 400, 400, 400])
  assert.deepEqual(result.after, result.before, '任何一次失败都没有改动编号')
  assert.ok(result.messages.every(message => typeof message === 'string' && message.length > 0))
})

test('顺序没变时幂等：changed = 0，一行都不写', () => {
  const result = run(`
    ${FIXTURE}
    const ok = await order([11, 12, 13])
    console.log('@@' + JSON.stringify({ changed: ok.body.data.changed, numbers: numbers() }))
  `)
  assert.equal(result.changed, 0)
  assert.deepEqual(result.numbers.map(r => r.n), [1, 2, 3])
})
