import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const backend = fileURLToPath(new URL('..', import.meta.url))

test('text scheduling, endpoint selection and persisted health', () => {
  execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
    import assert from 'node:assert/strict'
    import { eq } from 'drizzle-orm'
    import { db, schema } from './src/db/index.ts'
    import { TextSlotQueue, assignTextEndpoint, isModelError, noteEndpointError, noteEndpointSuccess, resumeTextConfig } from './src/services/text-scheduler.ts'

    const endpoint = { configId: 1, provider: 'openai', name: 'fake', baseUrl: 'https://example.invalid', apiKey: '', model: 'fake', vision: false, concurrency: 2, temperature: null, settings: null, suspended: false, suspendedReason: null }
    const q = new TextSlotQueue(async () => [endpoint, { ...endpoint, configId: 2, vision: true }])
    assert.deepEqual((await q.eligible({ vision: true })).map(e => e.configId), [2])
    assert.deepEqual((await q.eligible({ vision: true, configId: 1 })), [])
    assert.deepEqual((await q.eligible({ vision: false, configId: 1 })).map(e => e.configId), [1])
    const starts = []
    const releases = []
    const job = (n, interactive = false) => q.run({ configId: 1, interactive }, async () => {
      starts.push(n)
      await new Promise(resolve => { releases[n] = resolve })
    })
    const tick = () => new Promise(resolve => setImmediate(resolve))
    const a = job(0), b = job(1)
    await tick()
    assert.deepEqual(starts, [0, 1])
    const c = job(2), d = job(3), e = job(4, true)
    await tick()
    assert.deepEqual(starts, [0, 1])
    releases[0](); await tick()
    assert.deepEqual(starts, [0, 1, 4])
    releases[1](); await tick()
    assert.deepEqual(starts, [0, 1, 4, 2])
    releases[4](); await tick()
    assert.deepEqual(starts, [0, 1, 4, 2, 3])
    releases[2](); releases[3](); await Promise.all([a,b,c,d,e])

    const stamp = '2026-01-01'
    for (const [id, vision, priority] of [[9901, false, 100], [9902, true, 50]]) {
      await db.insert(schema.aiServiceConfigs).values({ id, serviceType: 'text', provider: 'openai', name: 'fake', baseUrl: 'https://example.invalid', apiKey: '', model: '["fake"]', vision, priority, concurrency: 1, isActive: true, createdAt: stamp, updatedAt: stamp })
    }
    assert.equal((await assignTextEndpoint('keyframe_prompts', { configId: 9901 })).configId, 9901)
    await assert.rejects(assignTextEndpoint('design_card', { configId: 9901 }), { name: 'StageVisionUnavailableError' })
    assert.equal((await assignTextEndpoint('design_card', { configId: 9902 })).configId, 9902)
    await assert.rejects(assignTextEndpoint('keyframe_prompts', { configId: 9901, excludeConfigIds: [9901] }))
    const fail = Object.assign(new Error('gateway'), { status: 530 })
    await noteEndpointError(9901, fail); await noteEndpointError(9901, fail)
    await noteEndpointSuccess(9901)
    let row = (await db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, 9901)))[0]
    assert.equal(row.consecutiveErrors, 0)
    for (let i = 0; i < 3; i++) await noteEndpointError(9901, fail)
    row = (await db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, 9901)))[0]
    assert.equal(row.consecutiveErrors, 3); assert.ok(row.suspendedAt)
    await assert.rejects(assignTextEndpoint('keyframe_prompts', { configId: 9901 }))
    await resumeTextConfig(9901)
    row = (await db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, 9901)))[0]
    assert.equal(row.consecutiveErrors, 0); assert.equal(row.suspendedAt, null)
    assert.equal((await assignTextEndpoint('keyframe_prompts', { configId: 9901 })).configId, 9901)
    for (const status of [401, 403, 429, 500, 503, 530]) assert.equal(isModelError({ status }), true)
    for (const status of [400, 404, 422]) assert.equal(isModelError({ status }), false)
    assert.equal(isModelError(new DOMException('timeout', 'TimeoutError')), true)
    assert.equal(isModelError(new DOMException('cancel', 'AbortError')), false)
    assert.equal(isModelError(new TypeError('fetch failed')), true)
    assert.equal(isModelError(new SyntaxError('invalid JSON')), false)
    assert.equal(isModelError(new Error('content policy violation')), false)
    assert.equal(isModelError({ status: 403, message: 'content_filter' }), false)
  `], { cwd: backend, env: { ...process.env, SQLITE_PATH: ':memory:' }, stdio: 'pipe' })
})
