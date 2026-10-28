/**
 * 场景时间不变量（Issue #21）：time 非空时最终提示词必须原样包含 time。
 * 纯函数 + 真跑一次 save_scene_final_prompt（临时 SQLite + 仓库自带 tsx 子进程）。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))
const sqlitePath = path.join(mkdtempSync(path.join(tmpdir(), 'scene-time-')), 'test.sqlite3')

function run(script, input) {
  const out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: { ...process.env, SQLITE_PATH: sqlitePath, SCENE_INPUT: JSON.stringify(input ?? null) },
  })
  return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
}

const planScript = `
  import { planSceneTimePatch } from './src/services/scene-time.ts'
  const cases = JSON.parse(process.env.SCENE_INPUT)
  process.stdout.write('@@' + JSON.stringify(cases.map(c => planSceneTimePatch(c))))
`
const plan = (...cases) => run(planScript, cases)

test('changing the time invalidates an old prompt even if it mentions the new period elsewhere', () => {
  const [result] = plan({ currentTime: '午后', currentFinalPrompt: '午后的客厅，避免夜晚冷色调', time: '夜晚' })
  assert.deepEqual(result, { time: '夜晚', finalPrompt: null })
})

test('a manual prompt written together with the new time is kept when it cites the time', () => {
  const [ok, bad] = plan(
    { currentTime: '午后', currentFinalPrompt: '午后的客厅', time: '夜晚', finalPrompt: '夜晚的客厅，台灯暖光' },
    { currentTime: '午后', currentFinalPrompt: '午后的客厅', time: '夜晚', finalPrompt: '客厅，台灯暖光' },
  )
  assert.deepEqual(ok, { time: '夜晚', finalPrompt: '夜晚的客厅，台灯暖光' })
  assert.match(bad.error, /夜晚/)
})

test('any manual prompt lacking the scene time is rejected; resending the stored prompt is not a write', () => {
  const [bad, unchanged, cleared] = plan(
    { currentTime: 'Afternoon', currentFinalPrompt: 'living room, afternoon sun', finalPrompt: 'living room at night' },
    { currentTime: '午后', currentFinalPrompt: '旧提示词', time: '午后', finalPrompt: '旧提示词' },
    { currentTime: '午后', currentFinalPrompt: '午后的客厅', finalPrompt: '' },
  )
  assert.match(bad.error, /Afternoon/)
  assert.deepEqual(unchanged, { time: '午后' })
  assert.deepEqual(cleared, { finalPrompt: null })
})

test('the time cannot be cleared, and an empty time places no requirement on the prompt', () => {
  const [clear, emptyStays] = plan(
    { currentTime: '午后', currentFinalPrompt: null, time: '  ' },
    { currentTime: '', currentFinalPrompt: null, time: '', finalPrompt: '客厅全景' },
  )
  assert.match(clear.error, /不能清空/)
  assert.deepEqual(emptyStays, { time: '', finalPrompt: '客厅全景' })
})

test('save_scene_final_prompt refuses a prompt without the scene time and saves one that cites it (case-insensitive)', () => {
  const result = run(`
    import { db, schema, initDb } from './src/db/index.ts'
    import { eq } from 'drizzle-orm'
    import { buildAgentRequestContext } from './src/agents/context.ts'
    import { imagePromptTools } from './src/agents/tools/image-prompt-tools.ts'
    initDb()
    const ts = new Date().toISOString()
    await db.insert(schema.dramas).values({ id: 71, title: 't', createdAt: ts, updatedAt: ts })
    await db.insert(schema.scenes).values({ id: 72, dramaId: 71, location: 'living room', time: 'Afternoon', prompt: '', createdAt: ts, updatedAt: ts })
    const ctx = { requestContext: buildAgentRequestContext({ episodeId: 1, dramaId: 71 }) }
    const save = imagePromptTools.saveSceneFinalPrompt
    const rejected = await save.execute({ scene_id: 72, prompt: 'cozy living room, warm lamps' }, ctx)
    const afterReject = (await db.select().from(schema.scenes).where(eq(schema.scenes.id, 72)))[0].finalPrompt
    const accepted = await save.execute({ scene_id: 72, prompt: 'cozy living room in the afternoon sun' }, ctx)
    const saved = (await db.select().from(schema.scenes).where(eq(schema.scenes.id, 72)))[0].finalPrompt
    process.stdout.write('@@' + JSON.stringify({ rejected, afterReject, accepted: accepted.saved, saved }))
  `)
  assert.equal(result.rejected.saved, false)
  assert.match(result.rejected.error, /Afternoon/)
  assert.equal(result.afterReject, null)
  assert.equal(result.accepted, true)
  assert.match(result.saved, /afternoon sun$/)
})
