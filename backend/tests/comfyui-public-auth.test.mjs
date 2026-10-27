import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('comfyui authHeaders sends Basic for user:pass api_key and Bearer otherwise', () => {
  const client = read('src/services/adapters/comfyui-client.ts')
  assert.match(client, /authHeaders\(config: AIConfig\)/)
  assert.match(client, /config\.apiKey\.includes\(':'\)/)
  assert.match(client, /Buffer\.from\(config\.apiKey, 'utf8'\)\.toString\('base64'\)/)
  assert.match(client, /Authorization: `Basic \$\{basic\}`/)
  assert.match(client, /Authorization: `Bearer \$\{config\.apiKey\}`/)
  // no key -> no header (LAN entry stays unauthenticated)
  assert.match(client, /if \(!config\.apiKey\) return \{\}/)
})

test('authHeaders is attached to every comfyui request path (queue/upload/prompt/history)', () => {
  const client = read('src/services/adapters/comfyui-client.ts')
  const uses = [...client.matchAll(/authHeaders\(config\)/g)].length
  assert.ok(uses >= 4, `expected >=4 authHeaders(config) call sites, found ${uses}`)
})

test('generation passes gateway auth headers when downloading comfyui outputs', () => {
  const generation = read('src/services/generation.ts')
  assert.match(generation, /import \{ authHeaders \} from '\.\/adapters\/comfyui-client'/)
  assert.match(generation, /provider\.toLowerCase\(\) === 'comfyui' \? authHeaders\(config\) : undefined/)
  const threaded = [...generation.matchAll(/downloadHeaders\(config\)/g)].length
  assert.ok(threaded >= 4, `expected >=4 downloadHeaders(config) call sites, found ${threaded}`)
  assert.match(generation, /handleImageComplete\(record: SysTaskRecord, imageUrl: string, headers\?: Record<string, string>\)/)
  assert.match(generation, /handleVideoComplete\(record: SysTaskRecord, videoUrl: string, duration: number \| null \| undefined, headers\?: Record<string, string>\)/)
})

test('storage downloadFile forwards headers to fetch', () => {
  const storage = read('src/utils/storage.ts')
  assert.match(storage, /downloadFile\(url: string, subDir: string, headers\?: Record<string, string>\)/)
  assert.match(storage, /fetch\(url, \{ headers \}\)/)
})

test('task logger redacts Authorization headers before logging', () => {
  const logger = read('src/utils/task-logger.ts')
  assert.match(logger, /'authorization'/)
})
