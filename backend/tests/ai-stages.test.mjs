/** resolveStageModel selection, precedence and missing-vision behavior. */
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
    '--experimental-test-module-mocks', '--no-warnings', '--import', 'tsx', '--input-type=module', '--eval', script,
  ], { cwd: backendRoot, encoding: 'utf8', env: { ...process.env, SQLITE_PATH: path.join(mkdtempSync(path.join(tmpdir(), 'ai-stages-')), 'test.sqlite3') } })
  return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
}


test('resolveStageModel: vision stage forces a vision config and fails loudly without one', () => {
  const r = run(`
    import { mock } from 'node:test'
    const AI = new URL('./src/services/ai.ts', 'file://${backendRoot}').href
    const CAP = new URL('./src/services/vision-capability.ts', 'file://${backendRoot}').href
    const GLM = { id: 1, name: 'GLM', provider: 'openai', baseUrl: 'http://x/v1', apiKey: 'k', model: 'glm-5.3', vision: false }
    const DS = { configId: 10, name: 'DeepSeek', provider: 'openai', baseUrl: 'http://y/v1', apiKey: 'k', model: 'deepseek-chat' }
    let visionConfig = DS
    mock.module(AI, { namedExports: {
      getActiveConfig: async () => GLM,
      getConfigById: async (id) => (id === 1 ? GLM : null),
    } })
    mock.module(CAP, { namedExports: { resolveVisionTextConfig: async () => visionConfig } })

    const { resolveStageModel, StageVisionUnavailableError } = await import('./src/services/ai-stages.ts')
    const out = {}
    const text = await resolveStageModel('keyframe_prompts', { configId: 1, model: 'glm-5.3' })
    out.text = { configId: text.configId, model: text.model, vision: text.vision }
    // 顶栏选了 GLM，视觉环节仍然换成 DeepSeek，且丢掉 GLM 的模型名
    const vision = await resolveStageModel('design_card', { configId: 1, model: 'glm-5.3' })
    out.vision = { configId: vision.configId, model: vision.model, vision: vision.vision, name: vision.name }
    visionConfig = null
    try {
      await resolveStageModel('design_card', {})
      out.error = null
    } catch (err) {
      out.error = { name: err.name, isStageError: err instanceof StageVisionUnavailableError, message: err.message }
    }
    process.stdout.write('@@' + JSON.stringify(out))
  `)
  assert.deepEqual(r.text, { configId: 1, model: 'glm-5.3', vision: false })
  assert.deepEqual(r.vision, { configId: 10, model: 'deepseek-chat', vision: true, name: 'DeepSeek' })
  assert.equal(r.error.isStageError, true)
  assert.match(r.error.message, /需要视觉模型/)
})
