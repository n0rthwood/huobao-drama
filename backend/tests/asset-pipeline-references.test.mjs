import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))
const dir = mkdtempSync(path.join(tmpdir(), 'pipeline-references-'))
const env = { ...process.env, SQLITE_PATH: path.join(dir, 'test.sqlite3'), HUOBAO_DATA_DIR: dir, STORAGE_PATH: path.join(dir, 'static') }
const run = script => {
  const output = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: backendRoot, encoding: 'utf8', env, timeout: 60000,
  })
  return JSON.parse(output.slice(output.lastIndexOf('@@') + 2))
}
let result
try {
  result = run(`
    import fs from 'node:fs'
    import path from 'node:path'
    import http from 'node:http'
    import sharp from 'sharp'
    import { eq } from 'drizzle-orm'
    import { db, schema } from './src/db/index.ts'
    import { ensureRound, patchRound, insertSpec, getRound, listSources } from './src/services/asset-pipeline/store.ts'
    import { referencesFor } from './src/services/asset-pipeline/workflow.ts'
    import { runGenerate, loadAssetTarget } from './src/services/asset-pipeline/steps.ts'
    import { roundReferenceImages } from './src/services/asset-pipeline/references.ts'
    import { buildImagePrompt } from './src/services/asset-pipeline/prompts.ts'
    import api from './src/routes/asset-pipeline.ts'
    const at = '2026-01-01T00:00:00.000Z'
    const root = process.env.STORAGE_PATH
    fs.mkdirSync(path.join(root, 'fixtures'), { recursive: true })
    const png = await sharp({ create: { width: 16, height: 9, channels: 3, background: '#aabbcc' } }).png().toBuffer()
    for (const [name, color] of [['one', '#ff0000'], ['two', '#00ff00'], ['three', '#0000ff'], ['four', '#ffff00'], ['output', '#aabbcc'], ['unknown', '#111111']]) {
      fs.writeFileSync(path.join(root, 'fixtures', name + '.png'), await sharp({ create: { width: 16, height: 9, channels: 3, background: color } }).png().toBuffer())
    }
    const requests = []
    const server = http.createServer(async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': req.headers['content-type'] } }).formData()
      const colors = []
      for (const file of form.getAll('image[]')) {
        const stats = await sharp(Buffer.from(await file.arrayBuffer())).stats()
        colors.push(stats.channels.slice(0, 3).map(channel => Math.round(channel.mean)))
      }
      requests.push({ path: req.url, model: form.get('model'), prompt: form.get('prompt'), size: form.get('size'), colors })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    server.unref()
    const localBase = 'http://127.0.0.1:' + server.address().port
    fs.writeFileSync(path.join(process.env.HUOBAO_DATA_DIR, 'outside.png'), png)
    fs.symlinkSync(path.join(process.env.HUOBAO_DATA_DIR, 'outside.png'), path.join(root, 'fixtures', 'escape.png'))
    await db.insert(schema.dramas).values({ id: 1, title: 'audit', createdAt: at, updatedAt: at })
    await db.insert(schema.episodes).values({ id: 1, dramaId: 1, episodeNumber: 1, title: 'E1', createdAt: at, updatedAt: at })
    await db.insert(schema.props).values({ id: 7, dramaId: 1, name: 'artifact', createdAt: at, updatedAt: at })
    await db.insert(schema.aiServiceConfigs).values({
      id: 200, serviceType: 'image', provider: 'openai', name: 'local HTTP fixture',
      baseUrl: localBase, apiKey: 'fixture', model: JSON.stringify(['fixture-image']), createdAt: at, updatedAt: at,
    })
    for (const [id, name, role] of [[11, 'one', 'generation_reference'], [12, 'two', 'shape_only'], [13, 'three', 'generation_reference'], [14, 'four', 'rejected']]) {
      await db.insert(schema.assetSource).values({ id, assetKind: 'prop', assetId: 7, license: 'CC0', sha256: String(id), localPath: 'static/fixtures/' + name + '.png', role, createdAt: at })
    }
    const sources = await listSources('prop', 7)
    const snapshots = sources.map(source => ({ ...source, source_id: source.id, kind: 'local' }))
    const spec = await insertSpec({ assetKind: 'prop', assetId: 7, summary: 'facts', mustHave: [], forbidden: [], tolerances: [], uncertainties: [], sources: snapshots, createdByStage: 'fixture' })
    await db.insert(schema.sysTask).values([100, 101, 102, 103, 104, 105, 106].map(id => ({
      id, type: 'text', provider: 'mastra', status: 'completed', propId: 7,
      params: JSON.stringify({ kind: 'asset_pipeline', asset_kind: 'prop', asset_id: 7, asset_spec_id: spec.id }), createdAt: at, updatedAt: at,
    })))
    const target = await loadAssetTarget('prop', 7)
    const input = { pipelineTaskId: 100, episodeId: 1, target, spec, roundNo: 0, purpose: 'precision', reviseNotes: [], configId: 200 }
    const state = { input: { pipelineTaskId: 100, assetKind: 'prop', assetId: 7 } }
    const selected = await referencesFor(state, 0, 'precision')
    // Exercise the real worker, multipart image upload, SQLite polling and local completion: no GPU or remote providers.
    let networkCalls = 0
    const realFetch = globalThis.fetch
    globalThis.fetch = (url, options) => {
      if (new URL(String(url)).origin !== localBase) {
        networkCalls++
        throw new Error('external network forbidden in provenance fixture')
      }
      return realFetch(url, options)
    }
    const generated = await runGenerate({ ...input, ...selected })
    const mixed = await runGenerate({ ...input, pipelineTaskId: 101, referenceImages: ['/static/fixtures/two.png', generated.image_path, 'static/fixtures/./one.png'],
      referenceOrigins: [{ type: 'source', source_id: 12 }, { type: 'prev_round', round_id: generated.id }, { type: 'source', source_id: 11 }] })
    const generatedTask = (await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, generated.image_task_id)))[0]
    const initialParams = generatedTask.params
    const mixedTask = (await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, mixed.image_task_id)))[0]
    const initialMixedDetail = await roundReferenceImages(mixed)
    const beforeCount = (await db.select().from(schema.sysTask).where(eq(schema.sysTask.type, 'image'))).length
    // Frozen input must outlive changed source rows and a newer current spec.
    await db.update(schema.assetSource).set({ localPath: 'static/fixtures/unknown.png', role: 'rejected' }).where(eq(schema.assetSource.id, 11))
    const newerSpec = await insertSpec({ assetKind: 'prop', assetId: 7, summary: 'changed current spec', mustHave: [], forbidden: [], tolerances: [], uncertainties: [], sources: [], createdByStage: 'fixture' })
    await db.update(schema.sysTask).set({ params: JSON.stringify({ kind: 'asset_pipeline', asset_kind: 'prop', asset_id: 7, asset_spec_id: newerSpec.id }) }).where(eq(schema.sysTask.id, 100))
    const replay = await runGenerate({ ...input, spec: newerSpec, referenceImages: ['static/fixtures/unknown.png'] })
    // Historic row: actual paths are from task params, identity from this round's original frozen spec only.
    const historical = (await ensureRound({ pipelineTaskId: 102, assetKind: 'prop', assetId: 7, specId: spec.id, roundNo: 0, purpose: 'precision', generator: 'fixture', configId: 200, prompt: 'historic', negativePrompt: '', referenceIds: [] })).round
    await db.insert(schema.sysTask).values({ id: 500, type: 'image', propId: 7, prompt: 'historic', status: 'completed', params: JSON.stringify({ referenceImages: ['static/fixtures/one.png', 'static/fixtures/unknown.png'] }), localPath: 'static/fixtures/output.png', createdAt: at, updatedAt: at })
    await patchRound(historical.id, { imageTaskId: 500, status: 'generated', imagePath: 'static/fixtures/output.png' })
    const historicRow = await getRound(historical.id)
    const historicDetail = await roundReferenceImages(historicRow)
    const beforeHistoric = JSON.stringify(historicRow)
    // Duplicate fallback paths are ambiguous; do not guess or use ID order as a tiebreaker.
    const duplicateSpec = await insertSpec({ assetKind: 'prop', assetId: 7, summary: 'duplicate', mustHave: [], forbidden: [], tolerances: [], uncertainties: [], sources: [...snapshots, { ...snapshots[0], source_id: 99 }], createdByStage: 'fixture' })
    const ambiguous = (await ensureRound({ pipelineTaskId: 103, assetKind: 'prop', assetId: 7, specId: duplicateSpec.id, roundNo: 0, purpose: 'precision', generator: 'fixture', configId: 200, prompt: 'ambiguous', negativePrompt: '', referenceIds: [] })).round
    await db.insert(schema.sysTask).values({ id: 501, type: 'image', params: JSON.stringify({ referenceImages: ['static/fixtures/one.png', generated.image_path, 'static/fixtures/two.png', 'static/fixtures/missing.png', 'static/../outside.png', 'static/fixtures/escape.png', 'https://invalid.example/a.png', '/etc/passwd'] }), status: 'completed', createdAt: at, updatedAt: at })
    await patchRound(ambiguous.id, { imageTaskId: 501 })
    // Orphan adoption must use an existing task's immutable params, never today's selection.
    const orphan = (await ensureRound({ pipelineTaskId: 104, assetKind: 'prop', assetId: 7, specId: spec.id, roundNo: 0, purpose: 'precision', generator: 'fixture', configId: 200, prompt: buildImagePrompt(spec, { name: target.name, purpose: 'precision', reviseNotes: [], stylePrompt: null }), negativePrompt: '', referenceIds: [] })).round
    await patchRound(orphan.id, { status: 'generating' })
    const orphanParams = JSON.stringify({ referenceImages: ['static/fixtures/two.png'] })
    await db.insert(schema.sysTask).values({ id: 502, type: 'image', propId: 7, prompt: orphan.prompt, params: orphanParams, status: 'completed', localPath: 'static/fixtures/output.png', createdAt: new Date(Date.now() + 1000).toISOString(), updatedAt: at })
    const adopted = await runGenerate({ ...input, pipelineTaskId: 104, referenceImages: ['static/fixtures/three.png'] })
    const missing = (await ensureRound({ pipelineTaskId: 105, assetKind: 'prop', assetId: 7, specId: spec.id, roundNo: 0, purpose: 'precision', generator: 'fixture', configId: 200, prompt: 'missing', negativePrompt: '', referenceIds: [] })).round
    const absentDetail = await roundReferenceImages(missing)
    await db.insert(schema.assetSource).values({ id: 99, assetKind: 'prop', assetId: 7, license: 'CC0', sha256: '99', localPath: 'static/fixtures/two.png', role: 'generation_reference', createdAt: at })
    // Ambiguous live-source fallback also crosses the real generation boundary without inventing an ID.
    await runGenerate({ ...input, pipelineTaskId: 106, referenceImages: ['static/fixtures/two.png'] })
    const fallbackRow = (await db.select().from(schema.assetRound).where(eq(schema.assetRound.pipelineTaskId, 106)))[0]
    const detailResponse = await api.request('/runs/100')
    const apiDetail = await detailResponse.json()
    await new Promise(resolve => server.close(resolve))
    console.log('@@' + JSON.stringify({
      selected, generated, mixed, initialMixedDetail,
      generatedParams: JSON.parse(initialParams), mixedParams: JSON.parse(mixedTask.params),
      replay, beforeCount, afterCount: (await db.select().from(schema.sysTask).where(eq(schema.sysTask.type, 'image'))).length,
      unchangedTask: initialParams === (await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, generated.image_task_id)))[0].params,
      historicDetail, historicUnchanged: beforeHistoric === JSON.stringify(await getRound(historical.id)),
      ambiguousDetail: await roundReferenceImages(await getRound(ambiguous.id)), adopted,
      adoptedDetail: await roundReferenceImages(adopted), orphanParamsUnchanged: orphanParams === (await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, 502)))[0].params,
      absentDetail, fallbackIds: JSON.parse(fallbackRow.referenceIds), apiStatus: detailResponse.status, apiRound: apiDetail.data.rounds[0], requests, networkCalls,
    }))
  `)
  // A fresh process reopening the same SQLite DB sees exactly the original submitted paths and IDs.
  result.reopened = run(`
    import { getRound } from './src/services/asset-pipeline/store.ts'
    import { roundReferenceImages } from './src/services/asset-pipeline/references.ts'
    console.log('@@' + JSON.stringify(await roundReferenceImages(await getRound(${result.generated.id}))))
  `)
  result.afterCleanup = run(`
    import fs from 'node:fs'
    import path from 'node:path'
    import { eq, inArray } from 'drizzle-orm'
    import { db, schema } from './src/db/index.ts'
    import { getRound } from './src/services/asset-pipeline/store.ts'
    import { roundReferenceImages } from './src/services/asset-pipeline/references.ts'
    const generated = await getRound(${result.generated.id})
    const mixed = await getRound(${result.mixed.id})
    const taskIds = [generated.image_task_id, mixed.image_task_id]
    const taskParamsBefore = (await db.select().from(schema.sysTask).where(inArray(schema.sysTask.id, taskIds))).map(task => task.params)
    const roundsBefore = JSON.stringify([generated, mixed])
    const sourcePath = path.join(process.env.STORAGE_PATH, 'fixtures', 'one.png')
    const previousPath = path.join(process.env.HUOBAO_DATA_DIR, generated.image_path)
    fs.unlinkSync(sourcePath)
    fs.unlinkSync(previousPath)
    const missingSource = await roundReferenceImages(generated)
    const missingPrevious = await roundReferenceImages(mixed)
    // The same lexical path can now contain unrelated bytes or a symlink; neither changes a recorded historical identity.
    fs.writeFileSync(sourcePath, 'unrelated replacement, not an image')
    fs.symlinkSync(path.join(process.env.HUOBAO_DATA_DIR, 'outside.png'), previousPath)
    const unsafePaths = ['static/../../outside.png', 'https://invalid.example/a.png', '/etc/passwd']
    const at = new Date().toISOString()
    await db.insert(schema.sysTask).values({
      id: 600, type: 'image', status: 'completed', createdAt: at, updatedAt: at,
      params: JSON.stringify({ referenceImages: unsafePaths, pipeline_reference_origins: unsafePaths.map(() => ({ type: 'source', source_id: 11 })) }),
    })
    await db.insert(schema.assetRound).values({
      pipelineTaskId: generated.pipeline_task_id, assetKind: 'prop', assetId: 7, roundNo: 99, purpose: 'precision',
      imageTaskId: 600, status: 'generated', referenceIds: '[]', createdAt: at, updatedAt: at,
    })
    const unsafeRound = (await db.select().from(schema.assetRound).where(eq(schema.assetRound.imageTaskId, 600)))[0]
    const filesystemMethods = ['lstatSync', 'statSync', 'realpathSync', 'readFileSync']
    const originalMethods = new Map(filesystemMethods.map(name => [name, fs[name]]))
    let metadataFilesystemReads = 0
    let replacedSource, replacedPrevious, unsafeDetail
    try {
      for (const name of filesystemMethods) fs[name] = () => {
        metadataFilesystemReads++
        throw new Error('recorded provenance must not inspect present-day files')
      }
      replacedSource = await roundReferenceImages(generated)
      replacedPrevious = await roundReferenceImages(mixed)
      unsafeDetail = await roundReferenceImages(await getRound(unsafeRound.id))
    } finally {
      for (const [name, original] of originalMethods) fs[name] = original
    }
    // Legacy tasks without recorded identity must still require a real, safe unique match.
    const legacyRound = (await db.select().from(schema.assetRound).where(eq(schema.assetRound.imageTaskId, 501)))[0]
    const legacy = await roundReferenceImages(await getRound(legacyRound.id))
    console.log('@@' + JSON.stringify({
      missingSource, missingPrevious, replacedSource, replacedPrevious, legacy, unsafeDetail, unsafePaths, metadataFilesystemReads,
      tasksUnchanged: JSON.stringify(taskParamsBefore) === JSON.stringify((await db.select().from(schema.sysTask).where(inArray(schema.sysTask.id, taskIds))).map(task => task.params)),
      roundsUnchanged: roundsBefore === JSON.stringify([await getRound(generated.id), await getRound(mixed.id)]),
    }))
  `)
} finally { rmSync(dir, { recursive: true, force: true }) }

test('precision source selection carries real IDs and persists only actually enqueued sources through both round writes', () => {
  assert.deepEqual(result.selected.referenceImages, ['static/fixtures/one.png', 'static/fixtures/three.png'])
  assert.deepEqual(result.selected.referenceOrigins, [{ type: 'source', source_id: 11 }, { type: 'source', source_id: 13 }])
  assert.deepEqual(result.generated.reference_ids, [11, 13])
  assert.deepEqual(result.generatedParams.referenceImages, result.selected.referenceImages)
  assert.equal(result.generated.status, 'generated')
  assert.equal(result.generatedParams.pipeline_round, true)
  assert.equal(result.generatedParams.size, '1344x768')
  assert.equal(result.requests.length, 3)
  assert.deepEqual(result.requests.map(request => request.path), ['/v1/images/edits', '/v1/images/edits', '/v1/images/edits'])
  for (const [index, expected] of [[255, 0, 0], [0, 0, 255]].entries()) {
    assert.ok(result.requests[0].colors[index].every((channel, component) => Math.abs(channel - expected[component]) <= 3))
  }
  assert.equal(result.requests[0].prompt, result.generated.prompt)
  assert.equal(result.requests[0].model, 'fixture-image')
  assert.equal(result.requests[0].size, '1344x768')
  assert.equal(result.networkCalls, 0)
})

test('mixed source/previous-round inputs retain actual path order without round IDs masquerading as source IDs', () => {
  assert.deepEqual(result.mixed.reference_ids, [12, 11])
  assert.deepEqual(result.initialMixedDetail.map(item => item.type), ['source', 'prev_round', 'source'])
  assert.deepEqual(result.initialMixedDetail.map(item => item.path), result.mixedParams.referenceImages)
  assert.equal(result.initialMixedDetail[1].round_id, result.generated.id)
  assert.equal('source_id' in result.initialMixedDetail[1], false)
  for (const [index, expected] of [[0, 255, 0], [170, 187, 204], [255, 0, 0]].entries()) {
    assert.ok(result.requests[1].colors[index].every((channel, component) => Math.abs(channel - expected[component]) <= 3))
  }
})

test('legacy detail uniquely matches frozen original spec, preserves unknowns and never rewrites the old round', () => {
  assert.deepEqual(result.historicDetail, [{ type: 'source', source_id: 11, path: 'static/fixtures/one.png' }, { type: 'unknown', path: 'static/fixtures/unknown.png' }])
  assert.equal(result.historicUnchanged, true)
  assert.deepEqual(result.absentDetail, [{ type: 'unknown', path: '' }])
})

test('ambiguous duplicate cache paths, unsafe, missing and external paths remain unknown without fetching', () => {
  assert.deepEqual(result.ambiguousDetail.map(item => item.type), ['unknown', 'prev_round', 'source', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown'])
  assert.equal(result.ambiguousDetail[2].source_id, 12)
  assert.deepEqual(result.fallbackIds, [])
  assert.equal(result.networkCalls, 0)
})

test('completed replay and fresh-process reopening ignore changed current source/spec without enqueue or backfill', () => {
  assert.equal(result.replay.image_task_id, result.generated.image_task_id)
  assert.deepEqual(result.replay.reference_ids, [11, 13])
  assert.equal(result.unchangedTask, true)
  assert.deepEqual(result.reopened, [
    { type: 'source', source_id: 11, path: 'static/fixtures/one.png' },
    { type: 'source', source_id: 13, path: 'static/fixtures/three.png' },
  ])
  assert.equal(result.afterCount, result.beforeCount + 4, 'only three explicit historic fixtures and one local HTTP fixture generation were added')
})

test('orphan adoption preserves the original task input and historical empty IDs, without a new generation', () => {
  assert.equal(result.adopted.image_task_id, 502)
  assert.deepEqual(result.adopted.reference_ids, [])
  assert.deepEqual(result.adoptedDetail, [{ type: 'source', source_id: 12, path: 'static/fixtures/two.png' }])
  assert.equal(result.orphanParamsUnchanged, true)
})

test('run detail API exposes ordered task-derived reference_images after current source/spec changes', () => {
  assert.equal(result.apiStatus, 200)
  assert.deepEqual(result.apiRound.reference_ids, [11, 13])
  assert.deepEqual(result.apiRound.reference_images, result.reopened)
})

test('persisted source and previous-round identities survive later file cleanup or replacement without rewriting history', () => {
  assert.deepEqual(result.afterCleanup.missingSource, result.reopened)
  assert.deepEqual(result.afterCleanup.missingPrevious, result.initialMixedDetail)
  assert.deepEqual(result.afterCleanup.replacedSource, result.reopened)
  assert.deepEqual(result.afterCleanup.replacedPrevious, result.initialMixedDetail)
  assert.equal(result.afterCleanup.legacy[1].type, 'unknown', 'legacy path lookup must not follow the replacement symlink')
  assert.equal(result.afterCleanup.metadataFilesystemReads, 0, 'recorded identity assembly must not touch current filesystem state')
  assert.deepEqual(result.afterCleanup.unsafeDetail, result.afterCleanup.unsafePaths.map(path => ({ type: 'unknown', path })))
  assert.equal(result.afterCleanup.tasksUnchanged, true)
  assert.equal(result.afterCleanup.roundsUnchanged, true)
})
