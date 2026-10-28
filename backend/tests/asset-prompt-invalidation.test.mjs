/**
 * 资产最终提示词失效（Issue #24）：改了影响画面的信息 → 旧提示词置空；
 * 重写时 Agent 没保存新稿 → 失败，绝不把旧稿当新稿返回。
 * 真跑 PUT 路由与 ensure*（临时 SQLite + 仓库自带 tsx 子进程）。
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
  const sqlitePath = path.join(mkdtempSync(path.join(tmpdir(), 'asset-prompt-')), 'test.sqlite3')
  const out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: { ...process.env, SQLITE_PATH: sqlitePath },
  })
  return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
}

const seed = `
  import { db, schema, initDb } from './src/db/index.ts'
  import { eq } from 'drizzle-orm'
  initDb()
  const ts = new Date().toISOString()
  await db.insert(schema.dramas).values({ id: 1, title: 't', createdAt: ts, updatedAt: ts })
  await db.insert(schema.episodes).values({ id: 2, dramaId: 1, episodeNumber: 1, title: 'e', createdAt: ts, updatedAt: ts })
  const resetChar = () => db.insert(schema.characters).values({ id: 3, dramaId: 1, name: '公鸡爷爷', role: '配角', appearance: '红冠公鸡', styling: '', description: '', finalPrompt: '旧稿：红冠公鸡', createdAt: ts, updatedAt: ts })
    .onConflictDoUpdate({ target: schema.characters.id, set: { name: '公鸡爷爷', role: '配角', appearance: '红冠公鸡', finalPrompt: '旧稿：红冠公鸡' } })
`

test('PUT /characters/:id drops the stale prompt only when a visual field changes value', () => {
  const result = run(`${seed}
    const { default: app } = await import('./src/routes/characters.ts')
    const put = async (body) => {
      await resetChar()
      const res = await app.request('/3', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const json = await res.json()
      const [row] = await db.select().from(schema.characters).where(eq(schema.characters.id, 3))
      return { returned: json.data?.final_prompt ?? null, stored: row.finalPrompt }
    }
    process.stdout.write('@@' + JSON.stringify({
      appearance: await put({ appearance: '白羽老公鸡' }),
      sameValue: await put({ appearance: '红冠公鸡' }),
      nameOnly: await put({ name: '鸡爷爷', role: '主角' }),
      manual: await put({ appearance: '白羽老公鸡', final_prompt: '手写新稿' }),
      resentOld: await put({ appearance: '白羽老公鸡', finalPrompt: '旧稿：红冠公鸡' }),
    }))
  `)
  assert.deepEqual(result.appearance, { returned: null, stored: null })
  assert.deepEqual(result.sameValue, { returned: '旧稿：红冠公鸡', stored: '旧稿：红冠公鸡' })
  assert.deepEqual(result.nameOnly, { returned: '旧稿：红冠公鸡', stored: '旧稿：红冠公鸡' })
  assert.deepEqual(result.manual, { returned: '手写新稿', stored: '手写新稿' })
  // 项目素材页会把旧稿原样带回：与已存值相同不算手写，样貌变了照样失效
  assert.deepEqual(result.resentOld, { returned: null, stored: null })
})

test('scene and prop visual fields invalidate their prompts; the scene time rule still applies', () => {
  const result = run(`${seed}
    const { default: scenes } = await import('./src/routes/scenes.ts')
    const { default: props } = await import('./src/routes/props.ts')
    const put = async (app, id, body) => {
      const res = await app.request('/' + id, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return { status: res.status, prompt: (await res.json()).data?.final_prompt ?? null }
    }
    await db.insert(schema.scenes).values({ id: 4, dramaId: 1, location: '客厅', time: '午后', prompt: '沙发', lighting: '', finalPrompt: '午后的客厅', createdAt: ts, updatedAt: ts })
    await db.insert(schema.props).values({ id: 5, dramaId: 1, name: '遥控器', type: '电器', description: '黑色', finalPrompt: '黑色遥控器', createdAt: ts, updatedAt: ts })
    const sceneLighting = await put(scenes, 4, { lighting: '暖光' })
    await db.update(schema.scenes).set({ finalPrompt: '午后的客厅' }).where(eq(schema.scenes.id, 4))
    const sceneManualNoTime = await put(scenes, 4, { prompt: '地毯', final_prompt: '客厅地毯' })
    const sceneTimeOnly = await put(scenes, 4, { time: '午后' })
    const propDesc = await put(props, 5, { description: '银色' })
    process.stdout.write('@@' + JSON.stringify({ sceneLighting, sceneManualNoTime, sceneTimeOnly, propDesc }))
  `)
  assert.deepEqual(result.sceneLighting, { status: 200, prompt: null })
  assert.equal(result.sceneManualNoTime.status, 400)
  assert.deepEqual(result.sceneTimeOnly, { status: 200, prompt: '午后的客厅' })
  assert.deepEqual(result.propDesc, { status: 200, prompt: null })
})

test('a forced rewrite fails when the agent does not save a new prompt, and succeeds when it does', () => {
  const result = run(`${seed}
    const { mastra } = await import('./src/mastra/index.ts')
    const { ensureCharacterFinalPrompt } = await import('./src/services/final-prompt.ts')
    let agentSaves = false
    mastra.getAgent = () => ({
      stream: async () => ({
        getFullOutput: async () => {
          if (agentSaves) await db.update(schema.characters).set({ finalPrompt: '新稿：白羽老公鸡' }).where(eq(schema.characters.id, 3))
          return {}
        },
      }),
    })
    await resetChar()
    const load = async () => (await db.select().from(schema.characters).where(eq(schema.characters.id, 3)))[0]
    const notSaved = await ensureCharacterFinalPrompt(await load(), 2, true)
    agentSaves = true
    const saved = await ensureCharacterFinalPrompt(await load(), 2, true)
    process.stdout.write('@@' + JSON.stringify({ notSaved, saved }))
  `)
  assert.equal(result.notSaved, '')
  assert.equal(result.saved, '新稿：白羽老公鸡')
})
