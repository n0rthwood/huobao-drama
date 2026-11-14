import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const backend = fileURLToPath(new URL('..', import.meta.url))

function run(code) {
  execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', code],
    { cwd: backend, env: { ...process.env, SQLITE_PATH: ':memory:' }, stdio: 'pipe' })
}

test('design-card window takes target ±3 and truncates at episode edges (#102)', () => {
  run(`
    import assert from 'node:assert/strict'
    import { designCardWindow } from './src/services/design-card-window.ts'
    const ids = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]
    assert.deepEqual(designCardWindow(ids, 15), { ids: [12, 13, 14, 15, 16, 17, 18], before: 3, after: 3 })
    assert.deepEqual(designCardWindow(ids, 11), { ids: [11, 12, 13, 14], before: 0, after: 3 })
    assert.deepEqual(designCardWindow(ids, 19), { ids: [16, 17, 18, 19, 20], before: 3, after: 1 })
    assert.deepEqual(designCardWindow([7], 7), { ids: [7], before: 0, after: 0 })
    assert.equal(designCardWindow(ids, 99), null)
  `)
})

test('read_storyboard_context windows the per-shot batch scopes (#102, #103)', () => {
  run(`
    import assert from 'node:assert/strict'
    import { db, schema } from './src/db/index.ts'
    import { storyboardTools } from './src/agents/tools/storyboard-tools.ts'
    const stamp = '2026-01-01'
    await db.insert(schema.dramas).values({ id: 501, title: 'w', projectType: 'documentary', aspectRatio: '16:9', createdAt: stamp, updatedAt: stamp })
    await db.insert(schema.episodes).values({ id: 601, dramaId: 501, episodeNumber: 1, title: 'e', scriptContent: '全文', createdAt: stamp, updatedAt: stamp })
    for (let n = 1; n <= 10; n++) {
      await db.insert(schema.storyboards).values({ id: 700 + n, episodeId: 601, storyboardNumber: n, narrationText: '旁白' + n, lastFramePrompt: '尾帧' + n, result: '结果' + n, continuityBoundary: 'continue', createdAt: stamp, updatedAt: stamp })
    }
    const read = async (values) => {
      const rc = new Map(Object.entries({ episodeId: 601, dramaId: 501, ...values }))
      return storyboardTools.readStoryboardContext.execute({}, { requestContext: { get: k => rc.get(k), set: () => {} } })
    }
    const windowed = await read({ storyboardPromptScope: 'design_card', storyboardId: 702 })
    assert.deepEqual(windowed.existing_storyboards.map(sb => sb.id), [701, 702, 703, 704, 705])
    assert.deepEqual(windowed.context_window.shot_ids, [701, 702, 703, 704, 705])
    assert.equal(windowed.context_window.before, 1)
    assert.equal(windowed.existing_storyboards[1].narration_text, '旁白2')
    assert.equal(windowed.script, '全文')
    const noTarget = await read({ storyboardPromptScope: 'design_card' })
    assert.equal(noTarget.existing_storyboards.length, 10)
    assert.equal(noTarget.context_window, undefined)
    for (const scope of ['keyframes', 'video']) {
      const shot = await read({ storyboardPromptScope: scope, storyboardId: 709 })
      assert.deepEqual(shot.existing_storyboards.map(sb => sb.id), [706, 707, 708, 709, 710])
      assert.equal(shot.context_window.after, 1)
      // 窗口最左一镜（706）的上一镜（705）不在窗口里，承接字段仍按整集算
      assert.equal(shot.existing_storyboards[0].previous_last_frame_prompt, '尾帧5')
      assert.equal(shot.existing_storyboards[0].previous_result, '结果5')
      assert.equal(shot.existing_storyboards[0].inherits_first, true)
    }
    const full = await read({ storyboardId: 702 })
    assert.equal(full.existing_storyboards.length, 10)
    assert.equal(full.context_window, undefined)
    assert.equal('narration_text' in full.existing_storyboards[0], false)
  `)
})

test('stage-dedicated text config: preferred for its stage, invisible elsewhere, carries reasoning_effort (#102)', () => {
  run(`
    import assert from 'node:assert/strict'
    import { eq } from 'drizzle-orm'
    import { db, schema } from './src/db/index.ts'
    import { assignTextEndpoint } from './src/services/text-scheduler.ts'
    import { resolveVisionTextConfig } from './src/services/vision-capability.ts'
    import { getTextConfig } from './src/services/ai.ts'
    import { callTextChat } from './src/services/vision-chat.ts'
    const stamp = '2026-01-01'
    const base = { serviceType: 'text', provider: 'openai', baseUrl: 'https://example.invalid', apiKey: '', concurrency: 1, isActive: true, vision: true, createdAt: stamp, updatedAt: stamp }
    await db.insert(schema.aiServiceConfigs).values({ ...base, id: 9911, name: 'general', model: '["general"]', priority: 50 })
    await db.insert(schema.aiServiceConfigs).values({ ...base, id: 9912, name: 'dedicated', model: '["flash"]', priority: 100,
      settings: JSON.stringify({ stages: ['design_card'], reasoning_effort: 'low' }) })

    const card = await assignTextEndpoint('design_card')
    assert.equal(card.configId, 9912)
    assert.equal(card.reasoningEffort, 'low')
    assert.equal((await assignTextEndpoint('keyframe_prompts')).configId, 9911)
    assert.equal((await assignTextEndpoint('read_image')).configId, 9911)
    assert.equal((await resolveVisionTextConfig(9912))?.configId, 9911)
    assert.equal((await getTextConfig()).id, 9911)
    // 显式指定不受专用环节限制
    assert.equal((await assignTextEndpoint('keyframe_prompts', { configId: 9912 })).configId, 9912)

    let sent
    globalThis.fetch = async (_url, init) => { sent = JSON.parse(init.body); return Response.json({ choices: [{ message: { content: 'ok' } }] }) }
    await callTextChat(card, 'hello', { temperature: 0, maxTokens: 10, timeoutMs: 1000 })
    assert.equal(sent.reasoning_effort, 'low')
    await callTextChat(await assignTextEndpoint('keyframe_prompts'), 'hello', { temperature: 0, maxTokens: 10, timeoutMs: 1000 })
    assert.equal('reasoning_effort' in sent, false)

    // 专用配置挂起：自动模式回到通用配置
    await db.update(schema.aiServiceConfigs).set({ suspendedAt: stamp }).where(eq(schema.aiServiceConfigs.id, 9912))
    assert.equal((await assignTextEndpoint('design_card')).configId, 9911)
  `)
})
