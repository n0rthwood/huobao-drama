/**
 * read_image 工具（Issue #46）：路径白名单、无视觉配置降级、expect_json 解析与回退、计量累加。
 *
 * 在 tsx 子进程里跑并以 @@JSON 回传（与 portrait-appearance.test.mjs 同法）。不连网也不碰真实数据：
 * HUOBAO_DATA_DIR / SQLITE_PATH 指向临时目录，看图配置用 node:test 的模块 mock 顶替，fetch 被替换。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))
const sandbox = mkdtempSync(path.join(tmpdir(), 'huobao-vision-'))
after(() => rmSync(sandbox, { recursive: true, force: true }))

const SANDBOX_ENV = {
  HUOBAO_DATA_DIR: sandbox,
  SQLITE_PATH: path.join(sandbox, 'test.sqlite3'),
}

function run(script) {
  const out = execFileSync('node', [
    '--experimental-test-module-mocks', '--no-warnings', '--import', 'tsx', '--input-type=module', '--eval', script,
  ], { cwd: backendRoot, encoding: 'utf8', env: { ...process.env, ...SANDBOX_ENV } })
  return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
}

/** 子进程公共前导：写一张真实的 1×1 PNG 到沙箱 static/ 下 */
const PREAMBLE = `
import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import { getAbsolutePath } from './src/utils/storage.ts'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const REL = 'static/vision-probe.png'
const ABS = getAbsolutePath(REL)
fs.mkdirSync(path.dirname(ABS), { recursive: true })
fs.writeFileSync(ABS, PNG)
const url = p => pathToFileURL(process.cwd() + p).href
`

test('resolveStaticImagePath only accepts existing image files under static/', () => {
  const r = run(`${PREAMBLE}
    const { resolveStaticImagePath } = await import('./src/agents/tools/vision-tools.ts')
    const out = {
      escape: resolveStaticImagePath('static/../../etc/passwd'),
      absolute: resolveStaticImagePath('/etc/passwd'),
      outside: resolveStaticImagePath('data/huobao.sqlite3'),
      missing: resolveStaticImagePath('static/uploads/does-not-exist.png'),
      badExt: resolveStaticImagePath('static/uploads/x.txt'),
      dir: resolveStaticImagePath('static/'),
      empty: resolveStaticImagePath(''),
      ok: resolveStaticImagePath(REL),
      okLeadingSlash: resolveStaticImagePath('/' + REL),
    }
    process.stdout.write('@@' + JSON.stringify(out))
  `)
  assert.match(r.escape.error, /\.\./)
  assert.match(r.absolute.error, /static\//)
  assert.match(r.outside.error, /static\//)
  assert.match(r.missing.error, /不存在/)
  assert.match(r.badExt.error, /jpg/)
  assert.ok(r.dir.error)
  assert.ok(r.empty.error)
  assert.equal(r.ok.relative, 'static/vision-probe.png')
  assert.equal(r.okLeadingSlash.relative, 'static/vision-probe.png')
})

test('extractFirstJson pulls the first object/array out of fenced or prose output', () => {
  const r = run(`${PREAMBLE}
    const { extractFirstJson } = await import('./src/agents/tools/vision-tools.ts')
    process.stdout.write('@@' + JSON.stringify({
      fenced: extractFirstJson('\\u0060\\u0060\\u0060json\\n{"labels":[{"text":"拉萨"}]}\\n\\u0060\\u0060\\u0060'),
      prose: extractFirstJson('识别结果如下：\\n{"a":1}\\n以上。'),
      array: extractFirstJson('[{"text":"北京"}]'),
      none: extractFirstJson('这张图看起来是一张地图。'),
      broken: extractFirstJson('{"a": 这不是 JSON}'),
    }))
  `)
  assert.deepEqual(r.fenced.json, { labels: [{ text: '拉萨' }] })
  assert.deepEqual(r.prose.json, { a: 1 })
  assert.deepEqual(r.array.json, [{ text: '北京' }])
  assert.ok(r.none.error)
  assert.ok(r.broken.error)
})

test('accumulateVisionCalls sums counts and tokens across calls', () => {
  const r = run(`${PREAMBLE}
    const { accumulateVisionCalls } = await import('./src/agents/tools/vision-tools.ts')
    const first = accumulateVisionCalls(null, { prompt_tokens: 1300, completion_tokens: 200, model: 'deepseek-chat' })
    const second = accumulateVisionCalls(first, { prompt_tokens: 700, completion_tokens: 100, model: 'deepseek-chat' })
    process.stdout.write('@@' + JSON.stringify({ first, second }))
  `)
  assert.deepEqual(r.first, { count: 1, prompt_tokens: 1300, completion_tokens: 200, model: 'deepseek-chat' })
  assert.deepEqual(r.second, { count: 2, prompt_tokens: 2000, completion_tokens: 300, model: 'deepseek-chat' })
})

test('read_image execute: path guard, unsupported fallback, json parse and json_error', () => {
  const r = run(`${PREAMBLE}
    import { db, schema } from './src/db/index.ts'
    const CONFIG = { configId: 1, name: 'stub', provider: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'deepseek-chat' }

    let reply = ''
    let lastBody = null
    globalThis.fetch = async (_u, init) => {
      lastBody = JSON.parse(init.body)
      return new Response(JSON.stringify({
        choices: [{ message: { content: reply } }],
        usage: { prompt_tokens: 1300, completion_tokens: 42 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    const { readImage } = await import('./src/agents/tools/vision-tools.ts')
    const out = {}
    out.unsupported = await readImage.execute({ path: REL, question: 'q' }, undefined)
    out.outOfScope = await readImage.execute({ path: '../../etc/passwd', question: 'q' }, undefined)

    // 视觉配置来自 ai_service_configs（调度器按 DB 端点分配，不再 mock 解析函数）
    const stamp = '2026-01-01'
    await db.insert(schema.aiServiceConfigs).values({
      id: CONFIG.configId, serviceType: 'text', provider: CONFIG.provider, name: CONFIG.name,
      baseUrl: CONFIG.baseUrl, apiKey: CONFIG.apiKey, model: JSON.stringify([CONFIG.model]),
      vision: 1, priority: 100, concurrency: 2, isActive: true, createdAt: stamp, updatedAt: stamp,
    })
    reply = '图上可读地名：拉萨、西宁。'
    out.text = await readImage.execute({ path: REL, question: '列出地名' }, undefined)
    out.request = { temperature: lastBody.temperature, parts: lastBody.messages[0].content.map(p => p.type), model: lastBody.model }
    reply = '结果：\\n{"labels":[{"text":"拉萨","bbox":[10,20,80,40]}]}'
    out.json = await readImage.execute({ path: REL, question: '列出地名', expect_json: true }, undefined)
    reply = '抱歉，我看不清这张图。'
    out.jsonError = await readImage.execute({ path: REL, question: '列出地名', expect_json: true }, undefined)
    process.stdout.write('@@' + JSON.stringify(out))
  `)
  assert.equal(r.unsupported.unsupported, true)
  assert.ok(r.unsupported.reason)
  assert.ok(r.outOfScope.error)
  assert.equal(r.outOfScope.unsupported, undefined)
  assert.match(r.text.text, /拉萨/)
  assert.equal(r.text.model, 'deepseek-chat')
  // 不走 Agent 主模型：请求打到探测出来的视觉配置，且是 text+image_url 的多模态消息
  assert.equal(r.request.model, 'deepseek-chat')
  assert.deepEqual(r.request.parts, ['text', 'image_url'])
  assert.equal(r.request.temperature, 0.1)
  assert.deepEqual(r.json.json, { labels: [{ text: '拉萨', bbox: [10, 20, 80, 40] }] })
  assert.ok(r.jsonError.json_error)
  assert.match(r.jsonError.text, /看不清/)
})
