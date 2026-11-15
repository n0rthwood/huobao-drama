import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))
function run(script) {
  const dir = mkdtempSync(path.join(tmpdir(), 'workflow-roadmap-'))
  try {
    const out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: backendRoot, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, SQLITE_PATH: path.join(dir, 'test.sqlite3'), HUOBAO_DATA_DIR: dir },
    })
    return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
const BASE = `
  import { computeRoadmap, deriveDramaStatus } from './src/services/workflow-roadmap.ts'
  const at = '2026-01-01T00:00:00.000Z'
  const base = {
    episode_id: 27, drama_id: 20, project_type: 'documentary', status_override: null, computed_at: at,
    gates: {
      projectType: 'documentary', script: { confirmed: true, confirmed_at: at },
      assets: { review_status: 'passed', stale_reasons: [], missing: 0 },
      design: { confirmed: 2, total: 2 },
      production: { ready: 2, total: 2, layer: { ready: 2, total: 2 }, keyframes: { ready: 1, total: 1 } },
      final: { fresh: 2, total: 2 },
    },
    raw: { chars: 100 },
    rewrite: { owner_run: { id: 16, status: 'completed', prepared_version_id: 57, source_revision: 3 }, active_run: null,
      stages: [{ key: 'fidelity', label: '忠实改写', status: 'skipped', error: null }, { key: 'bridge', label: '桥句润色', status: 'completed', error: null }],
      has_final: true, final_revision: 3, source_revision: 3, confirmed: true, confirmed_at: at },
    assets: { links: 3, images_ready: 3, extract_running: false, review_status: 'passed', review_total: 4, missing: 0, stale_reasons: ['asset_linked', 'version_registered'] },
    poster: { final_image: 'static/poster/current.png', has_concept: true, versions: 1 },
    design: { skeleton: { confirmed: true, was_confirmed: true, confirmed_at: at, blocked_reason: null }, tts: { valid: 2, total: 2 }, cards: { confirmed: 2, pending: 0, ai_filling: 0, stale: 0, blank: 0, total: 2 } },
    final: { fresh: 2, total: 2, stale: 0 },
    export: { latest_merge: { status: 'completed', scenes: ['a.mp4', 'b.mp4'], intro_image: 'static/poster/current.png', completed_at: at }, had_completed_merge: true, current_paths: ['a.mp4', 'b.mp4'] },
    drama: { shots: 2, keyframes_confirmed: 2, videos: 2 },
  }
  const byKey = r => Object.fromEntries(r.steps.map(s => [s.key, s]))
`

test('documentary sequential completion, skipped substep, notices and milestone times', () => {
  const r = run(`${BASE} console.log('@@' + JSON.stringify(computeRoadmap(base)))`)
  assert.deepEqual(r.steps.map(n => n.status), Array(8).fill('done'))
  assert.deepEqual(r.steps[1].substeps.map(n => n.status), ['done', 'skipped', 'done', 'done', 'done'])
  assert.equal(r.steps[2].substeps[1].notices.length, 2)
  assert.equal(r.steps[2].substeps[1].missing.length, 0)
  assert.deepEqual(r.progress, { done: 8, total: 8 })
  assert.deepEqual(r.current, { step: null, substep: null })
  assert.equal(r.status.effective, 'completed')
  assert.deepEqual(r.milestones.map(m => m.status), ['done', 'done', 'done'])
  assert.equal(r.milestones[1].achieved_at, null)
  assert.equal(r.milestones[2].achieved_at, '2026-01-01T00:00:00.000Z')
})

test('downstream own criteria cannot bypass unfinished strict upstream', () => {
  const r = run(`${BASE} base.raw.chars = 0; console.log('@@' + JSON.stringify(computeRoadmap(base)))`)
  assert.equal(r.steps[1].criteria_met, true)
  assert.equal(r.steps[1].status, 'in_progress')
  assert.deepEqual(r.steps[1].blocked_by, ['raw'])
  assert.equal(r.steps[2].criteria_met, true)
  assert.equal(r.steps[2].status, 'in_progress')
  assert.deepEqual(r.steps[2].blocked_by, ['raw', 'rewrite'])
  assert.deepEqual(r.current, { step: 'raw', substep: null })
  assert.equal(r.status.derived, 'active')
})

test('stale cards, cancelled skeleton, changed source and stale compose are explicit', () => {
  const result = run(`${BASE}
    const card = structuredClone(base); card.design.cards.confirmed = 1; card.design.cards.stale = 1
    const skeleton = structuredClone(base); skeleton.design.skeleton.confirmed = false
    const source = structuredClone(base); source.rewrite.source_revision = 4
    const compose = structuredClone(base); compose.final.fresh = 1; compose.final.stale = 1
    console.log('@@' + JSON.stringify([card, skeleton, source, compose].map(f => byKey(computeRoadmap(f)))))
  `)
  assert.equal(result[0].design.status, 'stale')
  assert.equal(result[0].design.substeps[2].status, 'stale')
  assert.equal(result[0].production.status, 'in_progress')
  assert.ok(result[0].production.blocked_by.includes('design'))
  assert.equal(result[1].design.substeps[0].status, 'stale')
  assert.equal(result[2].rewrite.status, 'stale')
  assert.equal(result[3].final.status, 'stale')
})

test('outdated merge, reordered paths, changed Poster and partial export never complete', () => {
  const results = run(`${BASE}
    const old = structuredClone(base); old.export.latest_merge.scenes[0] = 'old.mp4'
    const reorder = structuredClone(base); reorder.export.latest_merge.scenes.reverse()
    const poster = structuredClone(base); poster.poster.final_image = 'new.png'
    const partial = structuredClone(base); partial.export.latest_merge.scenes = ['a.mp4']
    console.log('@@' + JSON.stringify([old, reorder, poster, partial].map(computeRoadmap)))
  `)
  for (const r of results) {
    const node = r.steps.find(s => s.key === 'export')
    assert.equal(node.criteria_met, false)
    assert.equal(node.status, 'stale')
    assert.equal(r.status.derived, 'active')
  }
  assert.ok(results[2].steps.at(-1).missing.some(m => m.code === 'poster_changed'))
})

test('Poster only blocks export, and unused segment kinds complete vacuously for a nonempty episode', () => {
  const results = run(`${BASE}
    const poster = structuredClone(base); poster.poster = { final_image: null, has_concept: false, versions: 0 }
    const allA = structuredClone(base); allA.gates.production.keyframes = { ready: 0, total: 0 }
    console.log('@@' + JSON.stringify([poster, allA].map(computeRoadmap)))
  `)
  assert.equal(results[0].steps.find(n => n.key === 'design').status, 'done')
  assert.equal(results[0].steps.at(-1).status, 'in_progress')
  assert.ok(results[0].steps.at(-1).blocked_by.includes('poster'))
  assert.equal(results[0].current.step, 'poster')
  assert.equal(results[1].steps.find(n => n.key === 'production').status, 'done')
})

test('drama is free, never locked, current is first non-done; overrides win and empty projects are draft', () => {
  const result = run(`${BASE}
    const free = structuredClone(base); free.project_type = 'drama'; free.gates.projectType = 'drama'
    free.assets.images_ready = 1; free.poster.final_image = null
    const r = computeRoadmap(free)
    const override = computeRoadmap({ ...base, status_override: 'draft' })
    console.log('@@' + JSON.stringify({ r, override, projects: [deriveDramaStatus([]), deriveDramaStatus(['completed']), deriveDramaStatus(['draft', 'completed']), deriveDramaStatus(['draft'])] }))
  `)
  assert.ok(result.r.steps.every(n => n.ordering === 'free' && n.unlocked && n.status !== 'locked' && !n.blocked_by.length))
  assert.equal(result.r.current.step, 'assets')
  assert.equal(result.r.steps.at(-1).status, 'done')
  assert.deepEqual(result.override.status, { effective: 'draft', derived: 'completed', override: 'draft' })
  assert.deepEqual(result.projects, ['draft', 'completed', 'active', 'draft'])
})

test('new documentary remains draft; manual final skips AI phases only with a real final', () => {
  const result = run(`${BASE}
    base.raw.chars = 0; base.rewrite.owner_run = null; base.rewrite.has_final = false; base.rewrite.confirmed = false
    base.rewrite.stages.forEach(s => { s.status = 'pending' }); base.gates.script.confirmed = false
    base.assets = { ...base.assets, links: 0, images_ready: 0, review_status: 'none', review_total: 0, missing: 0, stale_reasons: [] }
    base.poster = { final_image: null, has_concept: false, versions: 0 }
    base.design = { skeleton: { confirmed: false, was_confirmed: false, confirmed_at: null, blocked_reason: null }, tts: { valid: 0, total: 0 }, cards: { confirmed: 0, pending: 0, ai_filling: 0, stale: 0, blank: 0, total: 0 } }
    base.gates.design = { confirmed: 0, total: 0 }; base.gates.production = { ready: 0, total: 0, layer: { ready: 0, total: 0 }, keyframes: { ready: 0, total: 0 } }
    base.final = { fresh: 0, total: 0, stale: 0 }; base.export = { latest_merge: null, had_completed_merge: false, current_paths: [] }
    const empty = computeRoadmap(base)
    base.rewrite.has_final = true; const manual = computeRoadmap(base)
    console.log('@@' + JSON.stringify({ empty, manual }))
  `)
  assert.equal(result.empty.status.derived, 'draft')
  assert.equal(result.empty.steps[1].substeps[0].status, 'available')
  assert.deepEqual(result.manual.steps[1].substeps.slice(0, 3).map(n => n.status), ['skipped', 'skipped', 'skipped'])
})

test('explicit skeleton cancellation preserves prior confirmation and becomes stale', () => {
  const result = run(`
    import { db, schema } from './src/db/index.ts'
    import { eq } from 'drizzle-orm'
    import { narrationSkeletonState, unconfirmNarrationSkeleton } from './src/services/narration-skeleton.ts'
    import { episodeRoadmap } from './src/services/workflow-roadmap.ts'
    const at = '2026-01-01T00:00:00.000Z'
    await db.insert(schema.dramas).values({ id: 1, title: 'doc', projectType: 'documentary', createdAt: at, updatedAt: at })
    await db.insert(schema.episodes).values({ id: 1, dramaId: 1, episodeNumber: 1, title: 'E1', scriptContent: '这是一段旁白。', scriptConfirmedAt: at, narrationEnabled: true, createdAt: at, updatedAt: at })
    await db.insert(schema.storyboards).values({ id: 1, episodeId: 1, storyboardNumber: 1, narrationText: '这是一段旁白。', createdAt: at, updatedAt: at })
    const initial = await narrationSkeletonState(1)
    await db.update(schema.episodes).set({ narrationSkeletonRevision: initial.revision, narrationSkeletonConfirmedAt: at }).where(eq(schema.episodes.id, 1))
    const confirmed = await narrationSkeletonState(1)
    const cancelled = await unconfirmNarrationSkeleton(1)
    const roadmap = await episodeRoadmap(1)
    console.log('@@' + JSON.stringify({ confirmed: confirmed.confirmed, cancelled: cancelled.confirmed, prior: cancelled.confirmed_revision, revision: initial.revision, node: roadmap.steps.find(n => n.key === 'design').substeps[0] }))
  `)
  assert.equal(result.confirmed, true)
  assert.equal(result.cancelled, false)
  assert.equal(result.prior, result.revision)
  assert.equal(result.node.status, 'stale')
})

test('real roadmap route, confirmation responses, removed endpoints and snapshot override writes', () => {
  const result = run(`
    import { db, schema, initDb, sqlite } from './src/db/index.ts'
    import { eq } from 'drizzle-orm'
    import { refreshRoadmapSnapshots } from './src/services/workflow-roadmap.ts'
    const at = '2026-01-01T00:00:00.000Z'
    initDb(); initDb()
    await db.insert(schema.dramas).values({ id: 1, title: 'doc', projectType: 'documentary', createdAt: at, updatedAt: at })
    await db.insert(schema.episodes).values({ id: 1, dramaId: 1, episodeNumber: 1, title: 'E1', content: '资料', scriptContent: '旁白正文', createdAt: at, updatedAt: at })
    const app = (await import('./src/routes/episodes.ts')).default
    const dramas = (await import('./src/routes/dramas.ts')).default
    const req = (a, url, data) => a.request(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })
    const initial = await (await app.request('/1/roadmap')).json()
    const confirmed = await (await app.request('/1/script/confirm', { method: 'POST' })).json()
    const unconfirmed = await (await app.request('/1/script/unconfirm', { method: 'POST' })).json()
    const removed = [ (await app.request('/1/gates')).status, (await app.request('/1/pipeline-status')).status ]
    const missing = (await app.request('/999/roadmap')).status
    const epBad = (await req(app, '/1', { status: 'nonsense' })).status
    const dramaBad = (await req(dramas, '/1', { status: false })).status
    await req(app, '/1', { status: 'completed' }); await req(dramas, '/1', { status: 'completed' })
    await refreshRoadmapSnapshots()
    const detail = (await (await dramas.request('/1')).json()).data
    const filtered = (await (await dramas.request('/?status=completed')).json()).data.items
    const stats = (await (await dramas.request('/stats')).json()).data
    await req(app, '/1', { status: null }); await req(dramas, '/1', { status: 'auto' })
    const cleared = (await (await dramas.request('/1')).json()).data
    console.log('@@' + JSON.stringify({ initial: initial.data, confirmed: confirmed.data, unconfirmed: unconfirmed.data, removed, missing, epBad, dramaBad, detail, filtered: filtered.length, stats, cleared,
      columns: ['dramas', 'episodes'].map(t => sqlite.prepare('PRAGMA table_info(' + t + ')').all().map(c => c.name)) }))
  `)
  assert.equal(result.initial.project_type, 'documentary')
  assert.equal(result.initial.status.derived, 'active')
  assert.equal(result.confirmed.steps.find(s => s.key === 'rewrite').substeps.at(-1).status, 'done')
  assert.equal(result.unconfirmed.steps.find(s => s.key === 'rewrite').substeps.at(-1).status, 'available')
  assert.deepEqual(result.removed, [404, 404])
  assert.equal(result.missing, 404)
  assert.equal(result.epBad, 400)
  assert.equal(result.dramaBad, 400)
  assert.equal(result.detail.status, 'completed')
  assert.equal(result.detail.status_override, 'completed')
  assert.equal(result.detail.status_derived, 'active')
  assert.equal(result.detail.episodes[0].status, 'completed')
  assert.equal(result.filtered, 1)
  assert.deepEqual(result.stats.by_status, [{ status: 'completed', count: 1 }])
  assert.equal(result.cleared.status, 'active')
  assert.equal(result.cleared.status_override, null)
  assert.equal(result.cleared.episodes[0].status_override, null)
  for (const columns of result.columns) {
    assert.ok(!columns.includes('status'))
    for (const name of ['status_override', 'status_derived', 'status_derived_at']) assert.ok(columns.includes(name))
  }
})
