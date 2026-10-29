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
    // tsx --eval 走 cjs，不支持顶层 await；失败时必须非 0 退出，否则父进程只拿到空输出
    void (async () => {
      ${body}
    })().catch(err => {
      console.error(err)
      process.exit(1)
    })
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

test('FLUX configs are detected case-insensitively; qwen models are not', () => {
  const result = runInBackend(`
    const { isFluxJobsConfig } = client
    const cfg = model => ({ provider: 'qwen-jobs', baseUrl: 'http://x', apiKey: '', model })
    process.stdout.write(JSON.stringify({
      dev: isFluxJobsConfig(cfg('flux-dev')),
      schnell: isFluxJobsConfig(cfg('flux-schnell')),
      upper: isFluxJobsConfig(cfg('FLUX-dev')),
      qwen: isFluxJobsConfig(cfg('qwen-image-2.1')),
      multi: isFluxJobsConfig(cfg('qwen-image-2.1, flux-dev')),
      empty: isFluxJobsConfig(cfg('')),
      serviceId: isFluxJobsConfig(cfg('flux1-schnell-nf4')),
      qwenPrefixTrap: isFluxJobsConfig(cfg('qwen-image-2.1,fluxish')),
    }))
  `)
  assert.deepEqual(result, { dev: true, schnell: true, upper: true, qwen: false, multi: true, empty: false, serviceId: true, qwenPrefixTrap: true })
})

test('image job body: qwen keeps image_edit semantics, flux maps refs to reference_to_image', () => {
  const result = runInBackend(`
    const { buildImageJobBody, FLUX_DENOISING_STRENGTH } = client
    const base = { prompt: 'P', size: '1344x768' }
    const out = {
      qwenNoRefs: buildImageJobBody({ ...base, fileIds: [], isKeyframe: false, flux: false }),
      qwenKeyframe: buildImageJobBody({ ...base, fileIds: ['f1', 'f2'], isKeyframe: true, flux: false }),
      qwenEdit: buildImageJobBody({ ...base, fileIds: ['f1', 'f2'], isKeyframe: false, flux: false }),
      fluxNoRefs: buildImageJobBody({ ...base, fileIds: [], isKeyframe: false, flux: true }),
      fluxRef: buildImageJobBody({ ...base, fileIds: ['f1', 'f2'], isKeyframe: false, flux: true }),
      fluxKeyframe: buildImageJobBody({ ...base, fileIds: ['f1'], isKeyframe: true, flux: true }),
      strength: FLUX_DENOISING_STRENGTH,
    }
    process.stdout.write(JSON.stringify(out))
  `)
  // Qwen 路径逐字段回归（与旧内联构造一致）
  assert.deepEqual(result.qwenNoRefs, { mode: 'text_to_image', prompt: 'P', metadata: {}, width: 1344, height: 768 })
  assert.deepEqual(result.qwenKeyframe, {
    mode: 'reference_to_image', prompt: '以 <image1>、<image2> 为参考：P', metadata: {},
    width: 1344, height: 768, reference_images: ['f1', 'f2'],
  })
  assert.deepEqual(result.qwenEdit, {
    mode: 'image_edit', prompt: '以 <image1>、<image2> 为参考：P', metadata: {},
    reference_images: ['f1', 'f2'],
  })
  // FLUX 路径：text_to_image 带画幅；参考图一律 reference_to_image + 0.75，只带第 1 张，无 <imageN>
  assert.deepEqual(result.fluxNoRefs, { mode: 'text_to_image', prompt: 'P', metadata: {}, width: 1344, height: 768 })
  assert.deepEqual(result.fluxRef, {
    mode: 'reference_to_image', prompt: 'P', metadata: {}, width: 1344, height: 768,
    reference_images: ['f1'], denoising_strength: 0.75,
  })
  assert.deepEqual(result.fluxKeyframe, {
    mode: 'reference_to_image', prompt: 'P', metadata: {}, width: 1344, height: 768,
    reference_images: ['f1'], denoising_strength: 0.75,
  })
  assert.equal(result.strength, 0.75)
})
