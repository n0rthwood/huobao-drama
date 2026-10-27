/**
 * qwen-jobs 客户端的行为测试：参考图 file id 缓存失效、错误分类。
 * 跑在 tsx 子进程里（替换 global fetch，不碰网络也不碰数据库），结果用 JSON 回传。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

function runInBackend(body) {
  const script = `
    import * as client from './src/services/adapters/qwen-jobs-client.ts'
    const uploads = []
    globalThis.fetch = async url => {
      uploads.push(String(url))
      return new Response(JSON.stringify({ id: 'file_' + uploads.length }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      })
    }
    const config = { id: 1, provider: 'qwen-jobs', baseUrl: 'http://qwen-jobs.invalid/image', apiKey: 'huobao:secret' }
    const png = 'data:image/png;base64,' + Buffer.from('fake-png-bytes').toString('base64')
    void (async () => {
      ${body}
    })()
  `
  const out = execFileSync('npx', ['tsx', '--eval', script], { cwd: backendRoot, encoding: 'utf8' })
  return JSON.parse(out)
}

test('reference uploads are cached per content and re-uploaded after the id is evicted', () => {
  const result = runInBackend(`
    const first = await client.uploadReferenceImage(config, png)
    const cached = await client.uploadReferenceImage(config, png)
    const uploadsBeforeEvict = uploads.length
    const evicted = client.evictQwenFileIds([first])
    const afterEvict = await client.uploadReferenceImage(config, png)
    process.stdout.write(JSON.stringify({
      first, cached, evicted, afterEvict, uploadsBeforeEvict, uploadsAfterEvict: uploads.length,
    }))
  `)

  // 同一张图第二次命中缓存，不再上传
  assert.equal(result.cached, result.first)
  assert.equal(result.uploadsBeforeEvict, 1)
  // 服务端回收文件后按 file id 清缓存 → 重新上传，拿到新的 id
  assert.equal(result.evicted, 1)
  assert.equal(result.uploadsAfterEvict, 2)
  assert.notEqual(result.afterEvict, result.first)
})

test('evicting an unknown file id keeps the cache intact', () => {
  const result = runInBackend(`
    const first = await client.uploadReferenceImage(config, png)
    const evicted = client.evictQwenFileIds(['file_not_in_cache'])
    const again = await client.uploadReferenceImage(config, png)
    process.stdout.write(JSON.stringify({ first, evicted, again, uploads: uploads.length }))
  `)

  assert.equal(result.evicted, 0)
  assert.equal(result.again, result.first)
  assert.equal(result.uploads, 1)
})

test('queue_full, gateway and network errors are transient; request errors are terminal', () => {
  const result = runInBackend(`
    const { QwenJobsError } = client
    const of = (status, code) => new QwenJobsError(status, code, 'x').transient
    process.stdout.write(JSON.stringify({
      network: of(0, 'network_error'),
      queueFull: of(429, 'queue_full'),
      gateway: of(530, 'http_error'),
      serverError: of(500, 'internal'),
      invalid: of(422, 'invalid_request'),
      conflict: of(409, 'idempotency_conflict'),
      notFound: of(404, 'not_found'),
      gone: of(410, 'output_gone'),
    }))
  `)

  // 队列满 = 服务端还没受理这次请求，原样重发即可，不该让任务失败
  assert.deepEqual(result, {
    network: true, queueFull: true, gateway: true, serverError: true,
    invalid: false, conflict: false, notFound: false, gone: false,
  })
})
