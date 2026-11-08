/**
 * resolveStageModel 的环节视觉标定与**选择口径**（Issue #77 起由 text-scheduler 按 DB 端点分配；
 * Issue #87 起区分「自动模式」与「用户显式指定」）：
 * - 自动模式：只落到健康的合格端点，顶栏残留的模型名不会被套到别的端点上；
 * - 显式指定：不可用时抛 `StagePinUnavailableError`，指名配置与原因并给出可用候选，绝不静默换服务；
 * - 真的一条视觉配置都没有时才抛 `StageVisionUnavailableError`（不能用它冒充「指定的那条不可用」）。
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
  const out = execFileSync('node', [
    '--import', 'tsx', '--input-type=module', '--eval', script,
  ], { cwd: backendRoot, encoding: 'utf8', env: { ...process.env, SQLITE_PATH: path.join(mkdtempSync(path.join(tmpdir(), 'ai-stages-')), 'test.sqlite3') } })
  return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
}

/** 9901 纯文本 / 9902 视觉健康（= cloud）/ 9903 视觉但已暂停（= 暂停的 local） */
const SEED = `
    import { eq } from 'drizzle-orm'
    import { db, schema } from './src/db/index.ts'
    import {
      resolveStageModel, stageSelectionErrorPayload, stageModelUsed, agentChatStage,
      StagePinUnavailableError, StageVisionUnavailableError,
    } from './src/services/ai-stages.ts'

    const stamp = '2026-01-01'
    const seed = async (id, vision, priority, extra = {}) => db.insert(schema.aiServiceConfigs).values({
      id, serviceType: 'text', provider: 'openai', name: 'fake' + id, baseUrl: 'https://example.invalid',
      apiKey: 'k', model: '["fake-' + id + '"]', vision, priority, concurrency: 2, isActive: true,
      createdAt: stamp, updatedAt: stamp, ...extra,
    })
    const caught = async (fn) => {
      try {
        const value = await fn()
        return { ok: true, config_id: value.configId, model: value.model, vision: value.vision }
      } catch (err) {
        return {
          ok: false, name: err.name, message: err.message,
          reason: err instanceof StagePinUnavailableError ? err.facts.reason : null,
          config_id: err instanceof StagePinUnavailableError ? err.facts.configId : null,
          alternatives: err instanceof StagePinUnavailableError ? err.alternatives.map(a => a.config_id) : null,
          isLegacyVisionError: err instanceof StageVisionUnavailableError,
          payload: stageSelectionErrorPayload(err),
        }
      }
    }
`

test('显式指定与自动模式：暂停的视觉配置不影响自动选健康 cloud', () => {
  const r = run(`${SEED}
    await seed(9901, false, 100)
    await seed(9902, true, 50)
    await seed(9903, true, 90, { suspendedAt: stamp, suspendedReason: '连续失败' })

    const out = {}
    // 指定纯文本配置跑纯文本环节：模型名属于该配置时生效
    out.text = await caught(() => resolveStageModel('keyframe_prompts', { configId: 9901, model: 'fake-9901' }))
    // 指定的模型名不属于这条配置：拒绝，不拿别的模型名去调
    out.wrongModel = await caught(() => resolveStageModel('keyframe_prompts', { configId: 9901, model: 'glm-5.3' }))
    // 显式指定非视觉配置跑视觉环节：指名原因，不静默换成视觉配置
    out.pinnedNonVision = await caught(() => resolveStageModel('design_card', { configId: 9901 }))
    // 显式指定已暂停的视觉配置：暂停原因单列，候选里给出健康的那条
    out.pinnedSuspended = await caught(() => resolveStageModel('design_card', { configId: 9903 }))
    // 显式指定不存在的配置
    out.pinnedMissing = await caught(() => resolveStageModel('design_card', { configId: 9999 }))
    // 显式指定健康视觉配置：用它
    const vision = await resolveStageModel('design_card', { configId: 9902, model: 'fake-9902' })
    out.vision = { configId: vision.configId, model: vision.model, pinned: vision.pinned, used: stageModelUsed(vision) }
    // 自动模式：暂停的 9903 被跳过，落到健康的 9902，且不套用调用方给的模型名
    const auto = await resolveStageModel('design_card', { model: 'glm-5.3' })
    out.auto = { configId: auto.configId, model: auto.model, pinned: auto.pinned }

    out.agentStage = { documentary: agentChatStage('storyboard_breaker', 'documentary'), drama: agentChatStage('storyboard_breaker', 'drama') }
    process.stdout.write('@@' + JSON.stringify(out))
  `)

  assert.deepEqual(r.text, { ok: true, config_id: 9901, model: 'fake-9901', vision: false })

  assert.equal(r.wrongModel.ok, false)
  assert.equal(r.wrongModel.reason, 'model_mismatch')
  assert.equal(r.wrongModel.payload.error, 'model_pin_unavailable')

  assert.equal(r.pinnedNonVision.reason, 'not_vision')
  assert.equal(r.pinnedNonVision.config_id, 9901)
  assert.deepEqual(r.pinnedNonVision.alternatives, [9902])
  assert.equal(r.pinnedNonVision.payload.error, 'model_pin_unavailable')
  assert.equal(r.pinnedNonVision.payload.vision_required, true)
  assert.equal(r.pinnedNonVision.payload.config_name, 'fake9901')

  assert.equal(r.pinnedSuspended.reason, 'suspended')
  assert.deepEqual(r.pinnedSuspended.alternatives, [9902])
  // 暂停的那一条被指名，不能谎称全局没有视觉配置
  assert.ok(r.pinnedSuspended.message.includes('fake9903'))
  assert.ok(!r.pinnedSuspended.message.includes('没有任何启用并标定'))

  assert.equal(r.pinnedMissing.reason, 'missing')

  assert.deepEqual(r.vision, {
    configId: 9902, model: 'fake-9902', pinned: true,
    used: { config_id: 9902, name: 'fake9902', provider: 'openai', model: 'fake-9902', vision: true },
  })
  assert.deepEqual(r.auto, { configId: 9902, model: 'fake-9902', pinned: false })
  assert.deepEqual(r.agentStage, { documentary: 'storyboard_breaker_documentary', drama: 'storyboard_breaker' })
})

test('真的一条视觉配置都没有：才报全局视觉缺失；纯文本环节报文本缺失', () => {
  const r = run(`${SEED}
    await seed(9901, false, 100)
    const out = {}
    out.vision = await caught(() => resolveStageModel('design_card', {}))
    await db.update(schema.aiServiceConfigs).set({ isActive: false }).where(eq(schema.aiServiceConfigs.id, 9901))
    out.text = await caught(() => resolveStageModel('keyframe_prompts', {}))
    process.stdout.write('@@' + JSON.stringify(out))
  `)
  assert.equal(r.vision.ok, false)
  assert.equal(r.vision.isLegacyVisionError, true)
  assert.equal(r.vision.payload.error, 'vision_config_unavailable')
  assert.deepEqual(r.vision.payload.alternatives, [])
  assert.equal(r.text.payload.error, 'text_config_unavailable')
})
