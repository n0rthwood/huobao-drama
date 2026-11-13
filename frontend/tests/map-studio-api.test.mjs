import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('../app/map-studio/api.ts', import.meta.url), 'utf8')
const js = ts.transpileModule(source.replace("import { apiBase } from '~/utils/url'", "const apiBase = () => '/huobao/api/v1'"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const { mapStudioAPI, mapStudioConflictOf } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)

test('Map Studio client preserves standalone host filtering and deployment prefix', async () => {
  const original = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, init) => { requests.push({ url, init }); return Response.json({ code: 200, data: { tasks: [] } }) }
  try {
    assert.deepEqual(await mapStudioAPI.listTasks({ host: '', q: 'river' }), { tasks: [] })
    assert.equal(requests[0].url, '/huobao/api/v1/map-studio/tasks?host=&q=river')
    await mapStudioAPI.observed(8, { work_cursor: 12, call_cursor: 23, limit: 50 })
    assert.match(requests[1].url, /work_cursor=12&call_cursor=23&limit=50$/)
    assert.equal(mapStudioAPI.downloadUrl(8, 'final'), '/huobao/api/v1/map-studio/tasks/8/download/final')
  } finally { globalThis.fetch = original }
})

test('Map Studio calibration upload uses the generic endpoint and file multipart field', async () => {
  const original = globalThis.fetch
  let request
  globalThis.fetch = async (url, init) => { request = { url, init }; return Response.json({ code: 200, data: { path: 'static/upload/map.png', url: '/static/upload/map.png' } }) }
  try {
    const result = await mapStudioAPI.uploadImage(new File(['pixels'], 'map.png', { type: 'image/png' }))
    assert.equal(request.url, '/huobao/api/v1/upload/image')
    assert.equal(request.init.body.get('file').name, 'map.png')
    assert.equal(request.init.body.get('image'), null)
    assert.equal(result.path, 'static/upload/map.png')
  } finally { globalThis.fetch = original }
})

test('Map Studio errors retain revision/run identity for conflict handling', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => Response.json({ code: 409, error: 'workflow_busy', revision: 7, run_id: 18, message: 'Busy' }, { status: 409 })
  try {
    await assert.rejects(mapStudioAPI.save(4, { expected_revision: 6 }), error => {
      assert.equal(error.status, 409)
      assert.equal(error.body.revision, 7)
      assert.deepEqual(mapStudioConflictOf(error), { kind: 'busy', runId: 18, message: 'Busy' })
      return true
    })
  } finally { globalThis.fetch = original }
})
