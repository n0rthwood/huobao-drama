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
  // 提示词环节按 AI_STAGES 解析模型（#51）：没有启用的文本配置会直接失败
  await db.insert(schema.aiServiceConfigs).values({ id: 1, serviceType: 'text', provider: 'openai', name: 'stub', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: JSON.stringify(['stub-model']), priority: 100, isActive: true, vision: false, createdAt: ts, updatedAt: ts })
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
  // Issue #33：ensure* 返回 { prompt, outcome }。force 重写后读回与运行前逐字相同记
  // unchanged_after_rewrite（批量按 Q12 放行出图），单发入口的 savedPromptOf() 仍判空回退。
  const result = run(`${seed}
    const { mastra } = await import('./src/mastra/index.ts')
    const { ensureCharacterFinalPrompt, savedPromptOf } = await import('./src/services/final-prompt.ts')
    let agentSaves = false
    mastra.getAgent = () => ({
      stream: async () => ({
        getFullOutput: async () => {
          if (agentSaves) await db.update(schema.characters).set({ finalPrompt: '新稿：白羽老公鸡' }).where(eq(schema.characters.id, 3))
          return {
            error: undefined,
            steps: [{}],
            finishReason: 'stop',
            toolCalls: [],
            toolResults: [],
            text: agentSaves ? 'saved' : 'not saved',
            response: { messages: [{ role: 'assistant', content: agentSaves ? 'saved' : 'not saved' }] },
          }
        },
      }),
    })
    await resetChar()
    const load = async () => (await db.select().from(schema.characters).where(eq(schema.characters.id, 3)))[0]
    const notSaved = await ensureCharacterFinalPrompt(await load(), 2, true)
    agentSaves = true
    const saved = await ensureCharacterFinalPrompt(await load(), 2, true)
    process.stdout.write('@@' + JSON.stringify({ notSaved, saved, notSavedPrompt: savedPromptOf(notSaved), savedPrompt: savedPromptOf(saved) }))
  `)
  assert.equal(result.notSaved.outcome, 'unchanged_after_rewrite')
  assert.equal(result.notSavedPrompt, '')
  assert.equal(result.saved.outcome, 'regenerated')
  assert.equal(result.savedPrompt, '新稿：白羽老公鸡')
})


test('final-prompt recovery appends one corrective turn, preserves one step budget, and covers all asset kinds', () => {
  const result = run(`${seed}
    const { mastra } = await import('./src/mastra/index.ts')
    const {
      ensureCharacterFinalPrompt,
      ensureSceneFinalPrompt,
      ensurePropFinalPrompt,
    } = await import('./src/services/final-prompt.ts')

    const full = (text, steps = 1, error = undefined) => ({
      error,
      steps: Array.from({ length: steps }, () => ({})),
      finishReason: 'stop',
      toolCalls: [],
      toolResults: [],
      text,
      response: { messages: [{ role: 'assistant', content: text }] },
    })
    const loadCharacter = async () => (await db.select().from(schema.characters).where(eq(schema.characters.id, 3)))[0]

    async function characterCase(mode, firstSteps = 1) {
      await resetChar()
      await db.update(schema.characters).set({ finalPrompt: null }).where(eq(schema.characters.id, 3))
      const calls = []
      let turn = 0
      mastra.getAgent = () => ({
        stream: async (messages, options) => {
          calls.push({ messages, maxSteps: options.maxSteps })
          const current = turn++
          return {
            getFullOutput: async () => {
              if (mode === 'upstream-error') return full('', firstSteps, new Error('upstream failed'))
              if (mode === 'initial-save' && current === 0) {
                await db.update(schema.characters).set({ finalPrompt: '初轮保存' }).where(eq(schema.characters.id, 3))
              }
              if (mode === 'correction-save' && current === 1) {
                await db.update(schema.characters).set({ finalPrompt: '纠正保存' }).where(eq(schema.characters.id, 3))
              }
              return full(current === 0 ? '<DSML>not a tool call</DSML>' : 'still not saved', current === 0 ? firstSteps : 1)
            },
          }
        },
      })
      const outcome = await ensureCharacterFinalPrompt(await loadCharacter(), 2)
      return {
        outcome,
        calls: calls.length,
        budgets: calls.map(call => call.maxSteps),
        roles: calls[1]?.messages.map(message => message.role) || [],
        correction: calls[1]?.messages.at(-1)?.content || '',
      }
    }

    const initialSuccess = await characterCase('initial-save')
    const correctionSuccess = await characterCase('correction-save')
    const correctionFailure = await characterCase('never-save')
    const upstreamError = await characterCase('upstream-error')
    const exhaustedBudget = await characterCase('never-save', 11)

    await db.insert(schema.scenes).values({
      id: 4,
      dramaId: 1,
      location: '客厅',
      time: '午后',
      prompt: '',
      lighting: '',
      finalPrompt: null,
      createdAt: ts,
      updatedAt: ts,
    })
    let sceneTurns = 0
    mastra.getAgent = () => ({
      stream: async () => ({
        getFullOutput: async () => {
          sceneTurns += 1
          await db.update(schema.scenes)
            .set({ finalPrompt: sceneTurns === 1 ? '客厅空镜' : '午后客厅空镜' })
            .where(eq(schema.scenes.id, 4))
          return full(sceneTurns === 1 ? 'saved without time' : 'saved with time')
        },
      }),
    })
    const [scene] = await db.select().from(schema.scenes).where(eq(schema.scenes.id, 4))
    const sceneResult = await ensureSceneFinalPrompt(scene, 2)

    await db.insert(schema.props).values({
      id: 5,
      dramaId: 1,
      name: '遥控器',
      type: '电器',
      description: '黑色',
      faithful: 0,
      finalPrompt: null,
      createdAt: ts,
      updatedAt: ts,
    })
    let propTurns = 0
    mastra.getAgent = () => ({
      stream: async () => ({
        getFullOutput: async () => {
          propTurns += 1
          if (propTurns === 2) {
            await db.update(schema.props).set({ finalPrompt: '白底黑色遥控器' }).where(eq(schema.props.id, 5))
          }
          return full(propTurns === 1 ? 'not saved' : 'saved')
        },
      }),
    })
    const [prop] = await db.select().from(schema.props).where(eq(schema.props.id, 5))
    const propResult = await ensurePropFinalPrompt(prop, 2)

    process.stdout.write('@@' + JSON.stringify({
      initialSuccess,
      correctionSuccess,
      correctionFailure,
      upstreamError,
      exhaustedBudget,
      scene: { result: sceneResult, turns: sceneTurns },
      prop: { result: propResult, turns: propTurns },
    }))
  `)

  assert.equal(result.initialSuccess.outcome.outcome, 'regenerated')
  assert.equal(result.initialSuccess.calls, 1)

  assert.equal(result.correctionSuccess.outcome.outcome, 'regenerated')
  assert.equal(result.correctionSuccess.outcome.prompt, '纠正保存')
  assert.equal(result.correctionSuccess.calls, 2)
  assert.deepEqual(result.correctionSuccess.budgets, [12, 11])
  assert.deepEqual(result.correctionSuccess.roles, ['user', 'assistant', 'user'])
  assert.match(result.correctionSuccess.correction, /HTTP 400/)
  assert.match(result.correctionSuccess.correction, /readCharacters/)
  assert.match(result.correctionSuccess.correction, /saveCharacterFinalPrompt/)
  assert.match(result.correctionSuccess.correction, /唯一一次纠正 user turn/)
  assert.match(result.correctionSuccess.correction, /characters\.final_prompt/)
  assert.match(result.correctionSuccess.correction, /可识别工具结果=\[none\]/)
  assert.match(result.correctionSuccess.correction, /postcondition=empty/)
  assert.match(result.correctionSuccess.correction, /DSML\/XML\/JSON/)

  assert.equal(result.correctionFailure.outcome.outcome, 'failed')
  assert.equal(result.correctionFailure.calls, 2)
  assert.equal(result.upstreamError.outcome.outcome, 'failed')
  assert.equal(result.upstreamError.calls, 1)
  assert.equal(result.exhaustedBudget.outcome.outcome, 'failed')
  assert.deepEqual(result.exhaustedBudget.budgets, [12])

  assert.deepEqual(result.scene, {
    result: { prompt: '午后客厅空镜', outcome: 'regenerated' },
    turns: 2,
  })
  assert.deepEqual(result.prop, {
    result: { prompt: '白底黑色遥控器', outcome: 'regenerated' },
    turns: 2,
  })
})
/**
 * 事实表版本也是失效来源（Issue #56 验收 14）。
 * 纯函数用例：字段没动、只有 `asset_spec` 出了新版本时，来源必须被判为 `spec_version`。
 */
test('事实表出新版本 → 失效来源为 spec_version（纯函数）', () => {
  const out = execFileSync('npx', ['tsx', '--eval', `
    import { classifyPromptInvalidation } from './src/services/asset-prompt-invalidation.ts'
    const current = { name: '商代车马坑', type: '器物', description: '双轮单辕' }
    process.stdout.write(JSON.stringify({
      nothing: classifyPromptInvalidation({ kind: 'prop', current, updates: {} }),
      specOnly: classifyPromptInvalidation({ kind: 'prop', current, updates: {}, specVersionChanged: true }),
      fieldsWin: classifyPromptInvalidation({ kind: 'prop', current, updates: { description: '四轮' }, specVersionChanged: true }),
    }))
  `], { cwd: backendRoot, encoding: 'utf8' })
  const r = JSON.parse(out)
  assert.deepEqual(r.nothing, { changed: false, source: null })
  assert.deepEqual(r.specOnly, { changed: true, source: 'spec_version' })
  // 字段也改了时按字段来源记录（两者都会清空，但来源要如实）
  assert.deepEqual(r.fieldsWin, { changed: true, source: 'fields' })
})
