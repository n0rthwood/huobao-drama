/** resolveStageModel 的环节视觉标定与硬指定语义（Issue #77 起由 text-scheduler 按 DB 端点分配）。 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

function run(script) {
  const out = execFileSync('node', [
    '--import', 'tsx', '--input-type=module', '--eval', script,
  ], { cwd: backendRoot, encoding: 'utf8', env: { ...process.env, SQLITE_PATH: path.join(mkdtempSync(path.join(tmpdir(), 'ai-stages-')), 'test.sqlite3') } })
  return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
}

test('resolveStageModel: vision stage only accepts vision endpoints; pinned non-vision is a hard error', () => {
  const r = run(`
    import { db, schema } from './src/db/index.ts'
    import { resolveStageModel, StageVisionUnavailableError, agentChatStage, stageModelUsed } from './src/services/ai-stages.ts'

    const stamp = '2026-01-01'
    for (const [id, vision, priority] of [[9901, false, 100], [9902, true, 50]]) {
      await db.insert(schema.aiServiceConfigs).values({ id, serviceType: 'text', provider: 'openai', name: 'fake' + id, baseUrl: 'https://example.invalid', apiKey: 'k', model: '["fake-' + id + '"]', vision, priority, concurrency: 2, isActive: true, createdAt: stamp, updatedAt: stamp })
    }

    const out = {}
    const text = await resolveStageModel('keyframe_prompts', { configId: 9901, model: 'glm-5.3' })
    out.text = { configId: text.configId, model: text.model, vision: text.vision }

    // 硬指定非视觉配置跑视觉环节：直接报错，不再静默换成视觉配置
    try {
      await resolveStageModel('design_card', { configId: 9901, model: 'glm-5.3' })
      out.pinnedVision = null
    } catch (err) {
      out.pinnedVision = { name: err.name, isStageError: err instanceof StageVisionUnavailableError, message: err.message }
    }

    const vision = await resolveStageModel('design_card', { configId: 9902, model: 'ds-vision' })
    out.vision = { configId: vision.configId, model: vision.model, vision: vision.vision, name: vision.name, used: stageModelUsed(vision) }

    // 未指定配置的视觉环节只落到 vision=1 的端点
    const picked = await resolveStageModel('read_image', {})
    out.auto = { configId: picked.configId, vision: picked.vision }

    out.agentStage = { documentary: agentChatStage('storyboard_breaker', 'documentary'), drama: agentChatStage('storyboard_breaker', 'drama') }
    process.stdout.write('@@' + JSON.stringify(out))
  `)
  assert.deepEqual(r.text, { configId: 9901, model: 'glm-5.3', vision: false })
  assert.equal(r.pinnedVision?.isStageError, true)
  assert.match(r.pinnedVision?.message || '', /需要视觉模型/)
  assert.deepEqual(r.vision, {
    configId: 9902, model: 'ds-vision', vision: true, name: 'fake9902',
    used: { config_id: 9902, name: 'fake9902', provider: 'openai', model: 'ds-vision', vision: true },
  })
  assert.deepEqual(r.auto, { configId: 9902, vision: true })
  assert.deepEqual(r.agentStage, { documentary: 'storyboard_breaker_documentary', drama: 'storyboard_breaker' })
})
