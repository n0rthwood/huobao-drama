/**
 * 旁白稿确认 / 取消确认 / 改稿自动取消（Issue #54）：
 * - POST /episodes/:id/script/{confirm,unconfirm}；空稿不能确认；
 * - PUT /episodes/:id 改 content / script_content → onScriptChanged 自动取消确认（同值重存不取消）；
 * - save_script 工具（Agent 改写路径）走同一个 onScriptChanged；
 * - 存量纪录片集回填：已有分镜 → 已确认；无分镜 → 未确认；剧情集列值保持 NULL。
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
  const dir = mkdtempSync(path.join(tmpdir(), 'script-confirm-'))
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
  import { eq } from 'drizzle-orm'
  initDb()
  const at = '2026-01-01T00:00:00.000Z'
  await db.insert(schema.dramas).values({ id: 1, title: 'doc', projectType: 'documentary', createdAt: at, updatedAt: at })
  await db.insert(schema.episodes).values([
    { id: 1, dramaId: 1, episodeNumber: 1, title: 'E1', scriptContent: '旁白稿正文。', narrationEnabled: true, createdAt: at, updatedAt: at },
    { id: 2, dramaId: 1, episodeNumber: 2, title: 'E2', createdAt: at, updatedAt: at },
  ])
`

test('确认 / 取消确认：空稿不能确认，确认写时间戳', () => {
  const result = run(`
    ${FIXTURE}
    const app = (await import('./src/routes/episodes.ts')).default
    const post = p => app.request(p, { method: 'POST' })
    const emptyRes = await post('/2/script/confirm')
    const okRes = await post('/1/script/confirm')
    const okBody = await okRes.json()
    const [afterConfirm] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, 1))
    await post('/1/script/unconfirm')
    const [afterUnconfirm] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, 1))
    console.log('@@' + JSON.stringify({
      emptyStatus: emptyRes.status,
      okStatus: okRes.status,
      confirmedFlag: okBody.data.script.confirmed,
      assetsUnlocked: okBody.data.unlocked.assets,
      storedAt: !!afterConfirm.scriptConfirmedAt,
      clearedAt: afterUnconfirm.scriptConfirmedAt,
    }))
  `)
  assert.equal(result.emptyStatus, 400)
  assert.equal(result.okStatus, 200)
  assert.equal(result.confirmedFlag, true)
  assert.equal(result.assetsUnlocked, true)
  assert.equal(result.storedAt, true)
  assert.equal(result.clearedAt, null)
})

test('改稿自动取消确认；同值重存不取消', () => {
  const result = run(`
    ${FIXTURE}
    const app = (await import('./src/routes/episodes.ts')).default
    const confirmed = async () => {
      const [row] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, 1))
      return !!row.scriptConfirmedAt
    }
    const put = body => app.request('/1', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    await app.request('/1/script/confirm', { method: 'POST' })
    const start = await confirmed()
    await put({ script_content: '旁白稿正文。' })
    const sameValue = await confirmed()
    await put({ script_content: '旁白稿正文（改了一个字）。' })
    const afterEdit = await confirmed()
    await app.request('/1/script/confirm', { method: 'POST' })
    await put({ title: 'E1 改名' })
    const afterUnrelated = await confirmed()
    await put({ content: '新的剧本原文' })
    const afterRaw = await confirmed()
    console.log('@@' + JSON.stringify({ start, sameValue, afterEdit, afterUnrelated, afterRaw }))
  `)
  assert.deepEqual(result, { start: true, sameValue: true, afterEdit: false, afterUnrelated: true, afterRaw: false })
})

test('Agent 改写路径（save_script 工具）同样触发自动取消', () => {
  const result = run(`
    ${FIXTURE}
    import { scriptTools } from './src/agents/tools/script-tools.ts'
    import { confirmScript } from './src/services/workflow-gates.ts'
    import { RequestContext } from '@mastra/core/di'
    await confirmScript(1)
    const requestContext = new RequestContext()
    requestContext.set('episodeId', 1)
    const confirmed = async () => {
      const [row] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, 1))
      return !!row.scriptConfirmedAt
    }
    const start = await confirmed()
    await scriptTools.saveScript.execute({ content: '旁白稿正文。' }, { requestContext })
    const sameValue = await confirmed()
    await scriptTools.saveScript.execute({ content: 'Agent 改写后的旁白稿。' }, { requestContext })
    const afterRewrite = await confirmed()
    console.log('@@' + JSON.stringify({ start, sameValue, afterRewrite }))
  `)
  assert.deepEqual(result, { start: true, sameValue: true, afterRewrite: false })
})

test('一次性升级迁移：已有分镜 → 已确认；重启重跑不会把用户取消的确认又填回来', () => {
  const result = run(`
    ${FIXTURE}
    await db.insert(schema.dramas).values({ id: 2, title: 'drama', projectType: 'drama', createdAt: at, updatedAt: at })
    await db.insert(schema.episodes).values({ id: 3, dramaId: 2, episodeNumber: 1, title: 'D1', scriptContent: '剧本正文。', createdAt: at, updatedAt: at })
    await db.insert(schema.storyboards).values([
      { id: 11, episodeId: 1, storyboardNumber: 1, title: 'S1', duration: 8, createdAt: at, updatedAt: at },
      { id: 31, episodeId: 3, storyboardNumber: 1, title: 'S1', duration: 8, createdAt: at, updatedAt: at },
    ])
    import { backfillScriptConfirmation } from './src/services/workflow-gates.ts'
    const filled = await backfillScriptConfirmation()
    // 用户随后取消确认 → 再次启动（再跑一次迁移）绝不能把它重新确认
    const { unconfirmScript } = await import('./src/services/workflow-gates.ts')
    await unconfirmScript(1)
    const again = await backfillScriptConfirmation()
    const rows = await db.select().from(schema.episodes)
    console.log('@@' + JSON.stringify({
      filled, again,
      state: rows.map(r => ({ id: r.id, confirmed: !!r.scriptConfirmedAt, review: r.assetReviewStatus })),
    }))
  `)
  assert.equal(result.filled, 1)
  // 幂等：第二次什么都不做
  assert.equal(result.again, 0)
  assert.deepEqual(result.state, [
    { id: 1, confirmed: false, review: 'none' },
    { id: 2, confirmed: false, review: 'none' },
    { id: 3, confirmed: false, review: 'none' },
  ])
})
